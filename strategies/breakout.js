'use strict';
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────────────
//  BTC 5-min Range Breakout Strategy
//  Rolling N-candle range high/low + RSI + Volume + EMA50 trend filter + ATR
//  Paper-trading engine. Same event interface as ScalpingStrategy.
// ─────────────────────────────────────────────────────────────────────────────
class RangeBreakoutStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType       = 'breakout';
    this.initialCapital     = cfg.capital          || 10000;
    this.capital            = this.initialCapital;
    this.riskPerTrade       = (cfg.riskPerTradePct  || 2)  / 100;
    this.dailyProfitTarget  = (cfg.dailyProfitPct   || 20) / 100;
    this.dailyProfitHardCap = (cfg.dailyHardCapPct  || 30) / 100;
    this.maxDailyLoss       = (cfg.maxDailyLossPct  || 10) / 100;

    // ── Strategy params ──────────────────────────────────────────────────────
    this.rangePeriod     = cfg.rangePeriod    || 12;   // 12 × 5m = 1h range
    this.breakThreshold  = 0.0003;                      // 0.03% beyond range
    this.rsiPeriod       = 14;
    this.rsiOB           = 72;   // slightly wider than scalping
    this.rsiOS           = 28;
    this.atrPeriod       = 14;
    this.atrSlMult       = 1.2;  // tighter SL — breakout trades have clear invalidation
    this.trailMult       = 0.5;
    this.emaTrendPeriod  = 50;   // trend filter
    this.volMaPeriod     = 20;
    this.volBreakMult    = 1.2;  // volume must be 20% above average on breakout

    this.kTrend = 2 / (this.emaTrendPeriod + 1);

    // warmup: need emaTrendPeriod + rangePeriod to be ready
    this.minBars   = Math.max(this.emaTrendPeriod, this.rangePeriod + 1,
                              this.rsiPeriod + 1, this.atrPeriod + 1,
                              this.volMaPeriod) + 3;
    this.warmupBuf = [];
    this.warmedUp  = false;

    // ── Indicator state ───────────────────────────────────────────────────────
    this.emaTrend       = null;
    this.avgGain        = null;
    this.avgLoss        = null;
    this.prevClose      = null;
    this.rsiVal         = null;
    this.atrVal         = null;
    this.prevCloseAtr   = null;
    this.volWin         = [];

    // Rolling range window — stores the last N candles (excluding current)
    this.rangeWindow    = [];
    this.rangeHigh      = null;
    this.rangeLow       = null;

    // ── VWAP ──────────────────────────────────────────────────────────────────
    this.cumVP  = 0;
    this.cumVol = 0;
    this.vwap   = null;

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
      this.cumVP = 0; this.cumVol = 0;
    }

    // VWAP
    this.cumVP  += close * volume;
    this.cumVol += volume;
    this.vwap    = this.cumVP / this.cumVol;

    // Volume MA
    this.volWin.push(volume);
    if (this.volWin.length > this.volMaPeriod) this.volWin.shift();
    const volMa = this.volWin.length >= this.volMaPeriod
      ? this.volWin.reduce((s, v) => s + v, 0) / this.volMaPeriod : null;

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

    // ── Incremental EMA50 (trend) ─────────────────────────────────────────────
    this.emaTrend = close * this.kTrend + this.emaTrend * (1 - this.kTrend);

    // ── Incremental RSI ───────────────────────────────────────────────────────
    if (this.prevClose !== null) {
      const ch = close - this.prevClose;
      const g  = Math.max(0, ch), l = Math.max(0, -ch);
      this.avgGain = (this.avgGain * (this.rsiPeriod - 1) + g) / this.rsiPeriod;
      this.avgLoss = (this.avgLoss * (this.rsiPeriod - 1) + l) / this.rsiPeriod;
      this.rsiVal  = this.avgLoss === 0 ? 100
        : 100 - 100 / (1 + this.avgGain / this.avgLoss);
    }
    this.prevClose = close;

    // ── Incremental ATR ───────────────────────────────────────────────────────
    if (this.prevCloseAtr !== null) {
      const tr = Math.max(high - low,
        Math.abs(high - this.prevCloseAtr),
        Math.abs(low  - this.prevCloseAtr));
      this.atrVal = (this.atrVal * (this.atrPeriod - 1) + tr) / this.atrPeriod;
    }
    this.prevCloseAtr = close;

    // ── Rolling range ─────────────────────────────────────────────────────────
    // push this candle into range window AFTER computing breakout signal for this bar
    // (we look at the range BEFORE the current close breaks it)
    if (this.rangeWindow.length >= this.rangePeriod) this.rangeWindow.shift();
    this.rangeHigh = Math.max(...this.rangeWindow.map(c => c.high));
    this.rangeLow  = Math.min(...this.rangeWindow.map(c => c.low));
    this.rangeWindow.push(candle);   // add current after computing range

    // Snapshot
    this.indicatorSnaps.push({
      time: openTime, emaTrend: this.emaTrend, vwap: this.vwap,
      rsi: this.rsiVal, atr: this.atrVal,
      rangeHigh: this.rangeHigh, rangeLow: this.rangeLow,
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
      if (p.type === 'long') {
        if (low <= p.trailSl)  return this._closePos(Math.max(p.trailSl, open), openTime, 'stop_loss'),  this._state();
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
    if (!this.rsiVal || !this.atrVal || !volMa || this.rangeHigh === null) return this._state();
    if (this.rangeWindow.length < this.rangePeriod) return this._state();

    const rangeSize  = this.rangeHigh - this.rangeLow;
    const volOk      = volume > volMa * this.volBreakMult;
    const bullTrend  = close > this.emaTrend;
    const bearTrend  = close < this.emaTrend;

    // LONG breakout: close above rangeHigh + trend up + RSI not OB + volume spike
    if (close > this.rangeHigh * (1 + this.breakThreshold) &&
        bullTrend && this.rsiVal < this.rsiOB && volOk) {
      const sl  = close - this.atrVal * this.atrSlMult;
      const tp  = close + Math.max(rangeSize * 1.5, this.atrVal * 2.0);
      const rpu = close - sl;
      if (rpu > 0) this._openPos('long', close, sl, tp, this.capital * effRisk / rpu, openTime);

    // SHORT breakout: close below rangeLow + trend down + RSI not OS + volume spike
    } else if (close < this.rangeLow * (1 - this.breakThreshold) &&
               bearTrend && this.rsiVal > this.rsiOS && volOk) {
      const sl  = close + this.atrVal * this.atrSlMult;
      const tp  = close - Math.max(rangeSize * 1.5, this.atrVal * 2.0);
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
      console.warn(`[Breakout] restoreFromHistory: only ${candles?.length} candles, need ${this.minBars}`);
      return false;
    }
    this._initIndicators(candles);

    const today = todayOverride || this._utcDate(candles[candles.length - 1].openTime);
    this.cumVP = 0; this.cumVol = 0;
    for (const c of candles) {
      if (this._utcDate(c.openTime) === today) {
        this.cumVP  += c.close * c.volume;
        this.cumVol += c.volume;
      }
    }
    this.vwap        = this.cumVol > 0 ? this.cumVP / this.cumVol : null;
    this.currentDate = today;
    this.volWin      = candles.slice(-this.volMaPeriod).map(c => c.volume);
    this.rangeWindow = candles.slice(-this.rangePeriod);
    this.rangeHigh   = Math.max(...this.rangeWindow.map(c => c.high));
    this.rangeLow    = Math.min(...this.rangeWindow.map(c => c.low));
    this.warmedUp    = true;
    console.log(`[Breakout] Restored. EMA50=${this.emaTrend?.toFixed(2)} RSI=${this.rsiVal?.toFixed(1)} ATR=${this.atrVal?.toFixed(2)} Range=${this.rangeLow?.toFixed(0)}-${this.rangeHigh?.toFixed(0)}`);
    return true;
  }

  setDailyContext (date, dailyStartCapital) {
    this.currentDate   = date;
    this.dailyStartCap = dailyStartCapital;
  }

  reset (cfg = {}) {
    this.capital = cfg.capital || this.initialCapital;
    this.initialCapital = this.capital;
    if (cfg.riskPerTradePct) this.riskPerTrade = cfg.riskPerTradePct / 100;
    this.emaTrend = null;
    this.avgGain = this.avgLoss = this.prevClose = this.rsiVal = null;
    this.atrVal  = this.prevCloseAtr = null;
    this.cumVP   = 0; this.cumVol = 0; this.vwap = null;
    this.volWin  = []; this.rangeWindow = []; this.rangeHigh = null; this.rangeLow = null;
    this.warmupBuf = []; this.warmedUp = false;
    this.position = null; this.trades = [];
    this.equityHistory   = [{ time: Date.now(), equity: this.capital }];
    this.indicatorSnaps  = [];
    this.dailyPnl        = {};
    this.dailyStartCap   = this.capital;
    this.currentDate     = null;
    this.dayTradeStopped = false;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _utcDate (tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }
  _sma (arr)      { return arr.reduce((s, v) => s + v, 0) / arr.length; }

  _initIndicators (buf) {
    const n       = buf.length;
    const closes  = buf.map(c => c.close);
    const highs   = buf.map(c => c.high);
    const lows    = buf.map(c => c.low);
    const volumes = buf.map(c => c.volume);

    // EMA50 trend
    let et = this._sma(closes.slice(0, this.emaTrendPeriod));
    for (let i = this.emaTrendPeriod; i < n; i++) et = closes[i] * this.kTrend + et * (1 - this.kTrend);
    this.emaTrend = et;

    // RSI
    let sg = 0, sl = 0;
    for (let i = 1; i <= this.rsiPeriod; i++) {
      const ch = closes[i] - closes[i - 1];
      sg += Math.max(0, ch); sl += Math.max(0, -ch);
    }
    this.avgGain = sg / this.rsiPeriod;
    this.avgLoss = sl / this.rsiPeriod;
    for (let i = this.rsiPeriod + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      this.avgGain = (this.avgGain * (this.rsiPeriod - 1) + Math.max(0, ch))  / this.rsiPeriod;
      this.avgLoss = (this.avgLoss * (this.rsiPeriod - 1) + Math.max(0, -ch)) / this.rsiPeriod;
    }
    this.rsiVal    = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
    this.prevClose = closes[n - 1];

    // ATR
    let sumTR = 0;
    for (let i = 1; i <= this.atrPeriod; i++)
      sumTR += Math.max(highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    this.atrVal = sumTR / this.atrPeriod;
    for (let i = this.atrPeriod + 1; i < n; i++) {
      const tr = Math.max(highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      this.atrVal = (this.atrVal * (this.atrPeriod - 1) + tr) / this.atrPeriod;
    }
    this.prevCloseAtr = closes[n - 1];

    // Volume window
    this.volWin = volumes.slice(-this.volMaPeriod);

    // Range window
    this.rangeWindow = buf.slice(-this.rangePeriod);
    this.rangeHigh   = Math.max(...this.rangeWindow.map(c => c.high));
    this.rangeLow    = Math.min(...this.rangeWindow.map(c => c.low));
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
    this.capital += pnl;
    const trade = {
      id: this.trades.length + 1, type, entry, exit: exitPrice, qty,
      pnl, pnlPct: pnl / (entry * qty) * 100,
      entryTime, exitTime, reason, sl, tp,
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _state () {
    const wins  = this.trades.filter(t => t.pnl > 0);
    const loses = this.trades.filter(t => t.pnl <= 0);
    const gw    = wins.reduce((s, t)  => s + t.pnl, 0);
    const gl    = loses.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = this.capital - this.initialCapital;
    const dayPnl   = this.capital - this.dailyStartCap;
    return {
      capital:         this.capital,
      initialCapital:  this.initialCapital,
      totalPnl,
      totalReturn:     totalPnl / this.initialCapital * 100,
      dayPnl,
      dayPnlPct:       dayPnl / this.dailyStartCap * 100,
      position:        this.position,
      indicators: {
        emaTrend: this.emaTrend, rsi: this.rsiVal,
        atr:      this.atrVal,   vwap: this.vwap,
        rangeHigh: this.rangeHigh, rangeLow: this.rangeLow,
      },
      totalTrades:    this.trades.length,
      winCount:       wins.length,
      lossCount:      loses.length,
      winRate:        this.trades.length ? wins.length / this.trades.length * 100 : 0,
      profitFactor:   gl !== 0 ? Math.abs(gw / gl) : (gw > 0 ? Infinity : 0),
      avgWin:         wins.length  ? gw / wins.length  : 0,
      avgLoss:        loses.length ? gl / loses.length : 0,
      recentTrades:   this.trades.slice(-50).reverse(),
      dailyPnl:       this.dailyPnl,
      dayTradeStopped: this.dayTradeStopped,
      warmedUp:       this.warmedUp,
      currentDate:    this.currentDate,
    };
  }
}

module.exports = { RangeBreakoutStrategy };
