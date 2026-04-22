'use strict';
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────────────
//  Heikin-Ashi + SuperTrend Strategy
//  Port of PineScript by RingsCherrY. HA candles + ATR SuperTrend.
//  Entries on direction flip; TP% + ATR trailing SL for exits.
// ─────────────────────────────────────────────────────────────────────────────
class HeikenAshiSupertrendStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType       = 'heikenashi';
    this.initialCapital     = cfg.capital          || 10000;
    this.capital            = this.initialCapital;
    this.riskPerTrade       = (cfg.riskPerTradePct  || 2)  / 100;
    this.dailyProfitTarget  = (cfg.dailyProfitPct   || 20) / 100;
    this.dailyProfitHardCap = (cfg.dailyHardCapPct  || 30) / 100;
    this.maxDailyLoss       = (cfg.maxDailyLossPct  || 10) / 100;

    // SuperTrend params (matches Pine defaults)
    this.atrPeriod  = cfg.atrPeriod || 10;
    this.factor     = cfg.factor    || 3.0;
    this.tpPct      = (cfg.tpPct   || 1.1) / 100;   // TP %
    this.trailMult  = 0.5;                            // ATR trail multiplier
    this.atrSlMult  = 1.5;                            // Initial SL multiplier

    this.minBars   = this.atrPeriod + 5;
    this.warmupBuf = [];
    this.warmedUp  = false;

    // ── Heikin-Ashi state ─────────────────────────────────────────────────────
    this.haOpen  = null;
    this.haClose = null;
    this.haHigh  = null;
    this.haLow   = null;

    // ── SuperTrend state ──────────────────────────────────────────────────────
    this.rmaAtr        = null;
    this.atrVal        = null;
    this.prevHaClose   = null;
    this.superTrend    = null;
    this.direction     = null;    // -1 = bullish, 1 = bearish
    this.prevDirection = null;
    this.prevSuperTrend = null;
    this.prevUpperBand  = null;
    this.prevLowerBand  = null;

    // ── Position / P&L ────────────────────────────────────────────────────────
    this.position        = null;
    this.trades          = [];
    this.equityHistory   = [{ time: Date.now(), equity: this.capital }];
    this.dailyPnl        = {};
    this.dailyStartCap   = this.capital;
    this.currentDate     = null;
    this.dayTradeStopped = false;
    this.indicatorSnaps  = [];
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  processCandle (candle) {
    const { openTime, open, high, low, close, volume } = candle;
    const dateStr = this._utcDate(openTime);

    // Day boundary
    if (dateStr !== this.currentDate) {
      if (this.currentDate) {
        const pnl = this.capital - this.dailyStartCap;
        const rec = { pnl, pnlPct: pnl / this.dailyStartCap * 100,
                      startCapital: this.dailyStartCap, endCapital: this.capital };
        this.dailyPnl[this.currentDate] = rec;
        this.emit('day_summary', { date: this.currentDate, ...rec });
      }
      this.currentDate     = dateStr;
      this.dailyStartCap   = this.capital;
      this.dayTradeStopped = false;
    }

    // Warmup
    if (!this.warmedUp) {
      this.warmupBuf.push(candle);
      if (this.warmupBuf.length >= this.minBars) {
        this._initIndicators(this.warmupBuf);
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    // ── Compute Heikin-Ashi candle ────────────────────────────────────────────
    const prevHaOpen  = this.haOpen;
    const prevHaClose = this.haClose;
    this.haOpen  = (prevHaOpen + prevHaClose) / 2;
    this.haClose = (open + high + low + close) / 4;
    this.haHigh  = Math.max(high, this.haOpen, this.haClose);
    this.haLow   = Math.min(low,  this.haOpen, this.haClose);

    // ── RMA-based ATR on HA candles ───────────────────────────────────────────
    const trueRange = this.prevHaClose === null
      ? this.haHigh - this.haLow
      : Math.max(
          this.haHigh - this.haLow,
          Math.abs(this.haHigh - this.prevHaClose),
          Math.abs(this.haLow  - this.prevHaClose)
        );
    const alpha    = 1 / this.atrPeriod;
    this.rmaAtr    = alpha * trueRange + (1 - alpha) * this.rmaAtr;
    this.atrVal    = this.rmaAtr;
    this.prevHaClose = this.haClose;

    // ── SuperTrend ────────────────────────────────────────────────────────────
    const src    = (this.haHigh + this.haLow) / 2;
    let newUpper = src + this.factor * this.atrVal;
    let newLower = src - this.factor * this.atrVal;

    // Band adjustment (identical to Pine logic)
    if (this.prevLowerBand !== null)
      newLower = (newLower > this.prevLowerBand || prevHaClose < this.prevLowerBand)
        ? newLower : this.prevLowerBand;
    if (this.prevUpperBand !== null)
      newUpper = (newUpper < this.prevUpperBand || prevHaClose > this.prevUpperBand)
        ? newUpper : this.prevUpperBand;

    this.prevDirection  = this.direction;
    this.prevSuperTrend = this.superTrend;

    if (this.prevSuperTrend === null) {
      this.direction = 1;
    } else if (this.prevSuperTrend === this.prevUpperBand) {
      this.direction = this.haClose > newUpper ? -1 : 1;
    } else {
      this.direction = this.haClose < newLower ?  1 : -1;
    }

    this.superTrend    = this.direction === -1 ? newLower : newUpper;
    this.prevUpperBand = newUpper;
    this.prevLowerBand = newLower;

    // Snapshot
    this.indicatorSnaps.push({
      time:       openTime,
      supertrend: this.superTrend,
      direction:  this.direction,
      upperBand:  newUpper,
      lowerBand:  newLower,
      atr:        this.atrVal,
      haOpen:     this.haOpen,
      haHigh:     this.haHigh,
      haLow:      this.haLow,
      haClose:    this.haClose,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();
    this.equityHistory.push({ time: openTime, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();

    // ── Daily limits ──────────────────────────────────────────────────────────
    const dayPct = (this.capital - this.dailyStartCap) / this.dailyStartCap;

    if (dayPct >= this.dailyProfitHardCap) {
      this.dayTradeStopped = true;
      if (this.position) this._closePos(close, openTime, 'daily_hard_cap');
      return this._state();
    }
    let adjLoss = this.maxDailyLoss;
    if      (dayPct > 0.10) adjLoss = Math.max(0.03, dayPct - (dayPct - 0.10) * 0.5);
    else if (dayPct > 0)    adjLoss = Math.max(0.03, this.maxDailyLoss - dayPct * 0.3);
    if (dayPct <= -adjLoss) {
      this.dayTradeStopped = true;
      if (this.position) this._closePos(close, openTime, 'daily_loss');
      return this._state();
    }
    if (this.dayTradeStopped) return this._state();

    const inProfit  = dayPct >= this.dailyProfitTarget;
    const trailMult = inProfit ? this.trailMult * 0.4 : this.trailMult;
    const effRisk   = inProfit ? this.riskPerTrade * 0.5 : this.riskPerTrade;

    // ── Manage open position ──────────────────────────────────────────────────
    if (this.position) {
      const p = this.position;
      // SuperTrend direction flip → exit immediately
      if (this.prevDirection !== null && this.direction !== this.prevDirection) {
        return this._closePos(close, openTime, 'signal_flip'), this._state();
      }
      if (p.type === 'long') {
        if (low  <= p.trailSl) return this._closePos(Math.max(p.trailSl, open), openTime, 'stop_loss'),  this._state();
        if (high >= p.tp)      return this._closePos(p.tp, openTime, 'take_profit'), this._state();
        const nt = close - this.atrVal * trailMult;
        if (nt > p.trailSl) p.trailSl = nt;
      } else {
        if (high >= p.trailSl) return this._closePos(Math.min(p.trailSl, open), openTime, 'stop_loss'),  this._state();
        if (low  <= p.tp)      return this._closePos(p.tp, openTime, 'take_profit'), this._state();
        const nt = close + this.atrVal * trailMult;
        if (nt < p.trailSl) p.trailSl = nt;
      }
      return this._state();
    }

    // ── Entry signals ─────────────────────────────────────────────────────────
    if (this.prevDirection === null || !this.atrVal) return this._state();
    const longSignal  = this.direction === -1 && this.prevDirection === 1;
    const shortSignal = this.direction ===  1 && this.prevDirection === -1;

    if (longSignal) {
      const sl  = close - this.atrVal * this.atrSlMult;
      const tp  = close * (1 + this.tpPct);
      const rpu = close - sl;
      if (rpu > 0) this._openPos('long',  close, sl, tp, this.capital * effRisk / rpu, openTime);
    } else if (shortSignal) {
      const sl  = close + this.atrVal * this.atrSlMult;
      const tp  = close * (1 - this.tpPct);
      const rpu = sl - close;
      if (rpu > 0) this._openPos('short', close, sl, tp, this.capital * effRisk / rpu, openTime);
    }

    return this._state();
  }

  getFullState () {
    return {
      ...this._state(),
      equityHistory:  this.equityHistory.slice(-500),
      indicatorSnaps: this.indicatorSnaps.slice(-300),
    };
  }

  restoreFromHistory (candles, todayOverride) {
    if (!candles || candles.length < this.minBars) {
      console.warn(`[HeikenAshi] restoreFromHistory: only ${candles?.length} candles, need ${this.minBars}`);
      return false;
    }
    this._initIndicators(candles);
    this.currentDate = todayOverride || this._utcDate(candles[candles.length - 1].openTime);
    this.warmedUp    = true;
    console.log(`[HeikenAshi] Restored. Direction=${this.direction} ST=${this.superTrend?.toFixed(2)} ATR=${this.atrVal?.toFixed(2)}`);
    return true;
  }

  setDailyContext (date, dailyStartCapital) {
    this.currentDate   = date;
    this.dailyStartCap = dailyStartCapital;
  }

  reset (cfg = {}) {
    this.capital        = cfg.capital || this.initialCapital;
    this.initialCapital = this.capital;
    if (cfg.riskPerTradePct) this.riskPerTrade = cfg.riskPerTradePct / 100;
    this.haOpen = this.haHigh = this.haLow = this.haClose = null;
    this.rmaAtr = this.atrVal = this.prevHaClose = null;
    this.superTrend = this.direction = this.prevDirection = this.prevSuperTrend = null;
    this.prevUpperBand = this.prevLowerBand = null;
    this.warmupBuf = []; this.warmedUp = false;
    this.position  = null; this.trades = [];
    this.equityHistory   = [{ time: Date.now(), equity: this.capital }];
    this.indicatorSnaps  = [];
    this.dailyPnl        = {};
    this.dailyStartCap   = this.capital;
    this.currentDate     = null;
    this.dayTradeStopped = false;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _utcDate (tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

  _initIndicators (buf) {
    const alpha = 1 / this.atrPeriod;

    // Seed first HA candle
    let haOpen  = (buf[0].open + buf[0].close) / 2;
    let haClose = (buf[0].open + buf[0].high + buf[0].low + buf[0].close) / 4;
    let haHigh  = Math.max(buf[0].high, haOpen, haClose);
    let haLow   = Math.min(buf[0].low,  haOpen, haClose);
    let rmaAtr  = haHigh - haLow;

    let prevHaClose   = haClose;
    let upperBand = null, lowerBand = null;
    let superTrend = null, direction = 1;
    let prevUpperBand = null, prevLowerBand = null, prevSuperTrend = null;

    for (let i = 1; i < buf.length; i++) {
      const c = buf[i];
      const newHaOpen  = (haOpen + haClose) / 2;
      const newHaClose = (c.open + c.high + c.low + c.close) / 4;
      const newHaHigh  = Math.max(c.high, newHaOpen, newHaClose);
      const newHaLow   = Math.min(c.low,  newHaOpen, newHaClose);

      const tr = Math.max(
        newHaHigh - newHaLow,
        Math.abs(newHaHigh - prevHaClose),
        Math.abs(newHaLow  - prevHaClose)
      );
      rmaAtr = alpha * tr + (1 - alpha) * rmaAtr;

      const src    = (newHaHigh + newHaLow) / 2;
      let newUpper = src + this.factor * rmaAtr;
      let newLower = src - this.factor * rmaAtr;

      if (prevLowerBand !== null)
        newLower = (newLower > prevLowerBand || prevHaClose < prevLowerBand) ? newLower : prevLowerBand;
      if (prevUpperBand !== null)
        newUpper = (newUpper < prevUpperBand || prevHaClose > prevUpperBand) ? newUpper : prevUpperBand;

      const prevDir = direction;
      if (prevSuperTrend === null) {
        direction = 1;
      } else if (prevSuperTrend === prevUpperBand) {
        direction = newHaClose > newUpper ? -1 : 1;
      } else {
        direction = newHaClose < newLower ? 1 : -1;
      }

      prevSuperTrend = superTrend;
      superTrend     = direction === -1 ? newLower : newUpper;
      prevUpperBand  = newUpper;
      prevLowerBand  = newLower;
      prevHaClose    = newHaClose;
      haOpen = newHaOpen; haClose = newHaClose;
      haHigh = newHaHigh; haLow   = newHaLow;
    }

    this.haOpen  = haOpen;  this.haClose = haClose;
    this.haHigh  = haHigh;  this.haLow   = haLow;
    this.prevHaClose   = prevHaClose;
    this.rmaAtr        = rmaAtr;
    this.atrVal        = rmaAtr;
    this.superTrend    = superTrend;
    this.direction     = direction;
    this.prevDirection = direction;
    this.prevSuperTrend = prevSuperTrend;
    this.prevUpperBand  = prevUpperBand;
    this.prevLowerBand  = prevLowerBand;
  }

  _openPos (type, entry, sl, tp, qty, time) {
    this.position = { type, entry, sl, tp, trailSl: sl, qty, entryTime: time };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, entryTime, sl, tp } = this.position;
    const pnl = type === 'long'
      ? (exitPrice - entry) * qty
      : (entry - exitPrice) * qty;
    const capitalBefore = this.capital;
    this.capital += pnl;
    if (this.equityHistory.length > 0)
      this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1, type, entry, exit: exitPrice, qty,
      pnl, pnlPct: pnl / capitalBefore * 100,
      entryTime, exitTime, reason, sl, tp,
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _state () {
    const wins   = this.trades.filter(t => t.pnl > 0);
    const loses  = this.trades.filter(t => t.pnl <= 0);
    const gw     = wins.reduce((s, t)  => s + t.pnl, 0);
    const gl     = loses.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = this.capital - this.initialCapital;
    const dayPnl   = this.capital - this.dailyStartCap;
    return {
      capital:          this.capital,
      initialCapital:   this.initialCapital,
      totalPnl,
      totalReturn:      totalPnl / this.initialCapital * 100,
      dayPnl,
      dayPnlPct:        dayPnl / this.dailyStartCap * 100,
      position:         this.position,
      indicators: {
        supertrend:  this.superTrend,
        direction:   this.direction,
        atr:         this.atrVal,
        haOpen:      this.haOpen,
        haClose:     this.haClose,
      },
      totalTrades:      this.trades.length,
      winCount:         wins.length,
      lossCount:        loses.length,
      winRate:          this.trades.length ? wins.length / this.trades.length * 100 : 0,
      profitFactor:     gl !== 0 ? Math.abs(gw / gl) : (gw > 0 ? Infinity : 0),
      avgWin:           wins.length  ? gw / wins.length  : 0,
      avgLoss:          loses.length ? gl / loses.length : 0,
      recentTrades:     this.trades.slice(-50).reverse(),
      dailyPnl:         this.dailyPnl,
      dayTradeStopped:  this.dayTradeStopped,
      warmedUp:         this.warmedUp,
      currentDate:      this.currentDate,
    };
  }
}

module.exports = { HeikenAshiSupertrendStrategy };
