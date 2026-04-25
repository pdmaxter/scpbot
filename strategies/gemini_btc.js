'use strict';
const EventEmitter = require('events');

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

class GeminiBtcStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'geminibtc';
    this.strategyName = 'Gemini BTC Heikin-Ashi Scalper';
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Number(cfg.capital || 1000);
    this.capital = this.initialCapital;
    this.leverage = Math.max(1, Number(cfg.leverage || 1));
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.lookback = Math.max(1, Math.round(Number(cfg.lookback) || 3));
    this.minBars = Math.max(this.lookback + 2, 10);
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.timeframe) this.timeframe = normalizeTimeframe(cfg.timeframe);
    if (cfg.capital !== undefined) {
      this.capital = Number(cfg.capital) || this.initialCapital;
      this.initialCapital = this.capital;
    }
    if (cfg.leverage !== undefined) this.leverage = Math.max(1, Number(cfg.leverage) || 1);
    if (cfg.buyFeePct !== undefined) this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    if (cfg.sellFeePct !== undefined) this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    if (cfg.lookback !== undefined) this.lookback = Math.max(1, Math.round(Number(cfg.lookback) || 3));
    this.minBars = Math.max(this.lookback + 2, 10);
    this.resetState();
  }

  resetState () {
    this.rawBucket = null;
    this.candles = [];
    this.position = null;
    this.trades = [];
    this.equityHistory = [{ time: Date.now(), equity: this.capital }];
    this.indicatorSnaps = [];
    this.dailyPnl = {};
    this.dailyStartCap = this.capital;
    this.currentDate = null;
    this.warmedUp = false;
    this.lastSignal = 'flat';
    this.lastIndicators = {};
  }

  restoreFromHistory (candles = []) {
    const aggregated = aggregateCandles(candles, this.timeframe);
    if (aggregated.length < this.minBars) return false;
    this.candles = aggregated.slice(-1000);
    this.currentDate = this._utcDate(this.candles[this.candles.length - 1].openTime);
    this.warmedUp = true;
    return true;
  }

  processCandle (candle) {
    const completed = this._ingestTimeframe(candle);
    if (!completed) return this._state();
    return this._processStrategyCandle(completed);
  }

  getFullState () {
    return {
      ...this._state(),
      equityHistory: this.equityHistory.slice(-500),
      indicatorSnaps: this.indicatorSnaps.slice(-500),
    };
  }

  scriptMeta () {
    return {
      name: this.strategyName,
      timeframe: this.timeframe,
      lookback: this.lookback,
      source: 'Gemini BTC',
      candleStyle: 'heikin-ashi',
    };
  }

  setDailyContext (date, dailyStartCapital) {
    this.currentDate = date;
    this.dailyStartCap = dailyStartCapital;
  }

  _ingestTimeframe (candle) {
    if (this.timeframe === '5m') return candle;
    const tfMs = TIMEFRAME_MS[this.timeframe];
    const bucketStart = Math.floor(candle.openTime / tfMs) * tfMs;
    if (!this.rawBucket) {
      this.rawBucket = bucketFrom(candle, bucketStart);
      return null;
    }
    if (this.rawBucket.openTime === bucketStart) {
      this.rawBucket.high = Math.max(this.rawBucket.high, candle.high);
      this.rawBucket.low = Math.min(this.rawBucket.low, candle.low);
      this.rawBucket.close = candle.close;
      this.rawBucket.volume = (this.rawBucket.volume || 0) + (candle.volume || 0);
      this.rawBucket.closeTime = candle.closeTime;
      return null;
    }
    const completed = this.rawBucket;
    this.rawBucket = bucketFrom(candle, bucketStart);
    return completed;
  }

  _processStrategyCandle (candle) {
    const dateStr = this._utcDate(candle.openTime);
    if (dateStr !== this.currentDate) {
      if (this.currentDate) {
        const pnl = this.capital - this.dailyStartCap;
        this.dailyPnl[this.currentDate] = {
          pnl,
          pnlPct: this.dailyStartCap ? pnl / this.dailyStartCap * 100 : 0,
          startCapital: this.dailyStartCap,
          endCapital: this.capital,
        };
        this.emit('day_summary', { date: this.currentDate, ...this.dailyPnl[this.currentDate] });
      }
      this.currentDate = dateStr;
      this.dailyStartCap = this.capital;
    }

    this.candles.push(candle);
    if (this.candles.length > 1500) this.candles.shift();

    if (!this.warmedUp) {
      if (this.candles.length >= this.minBars) {
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    const signal = this._signals();
    this.lastSignal = signal.signal;
    this.lastIndicators = signal.indicators;
    this.indicatorSnaps.push({
      time: candle.openTime,
      close: candle.close,
      signal: signal.signal,
      haOpen: signal.indicators.haOpen,
      haHigh: signal.indicators.haHigh,
      haLow: signal.indicators.haLow,
      haClose: signal.indicators.haClose,
      bullish: signal.indicators.isBullish ? 1 : 0,
      bearish: signal.indicators.isBearish ? 1 : 0,
      lookback: this.lookback,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();

    if (this.position) {
      const p = this.position;
      if ((p.type === 'long' && signal.signal === 'short') || (p.type === 'short' && signal.signal === 'long')) {
        const nextType = p.type === 'long' ? 'short' : 'long';
        this._closePos(candle.close, candle.openTime, 'signal_flip');
        this._openPos(nextType, candle.close, candle.openTime, signal.indicators);
        this._pushEquityPoint(candle.openTime);
        return this._state();
      }
      if (p.liquidationPrice) {
        if (p.type === 'long' && candle.low <= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
        if (p.type === 'short' && candle.high >= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
      }
      this._pushEquityPoint(candle.openTime);
      return this._state();
    }

    if (signal.signal === 'long' || signal.signal === 'short') {
      this._openPos(signal.signal, candle.close, candle.openTime, signal.indicators);
    }
    this._pushEquityPoint(candle.openTime);
    return this._state();
  }

  _signals () {
    const haCandles = heikinAshiSeries(this.candles);
    const last = haCandles[haCandles.length - 1];
    const recent = haCandles.slice(-this.lookback);
    const epsilon = Math.max(Number(last.close || 0) * 1e-6, 1e-8);
    const bullishCandle = c => c.close > c.open && c.low >= Math.min(c.open, c.close) - epsilon;
    const bearishCandle = c => c.close < c.open && c.high <= Math.max(c.open, c.close) + epsilon;
    const isBullish = bullishCandle(last);
    const isBearish = bearishCandle(last);
    const bullishSignal = isBullish && recent.length >= this.lookback && recent.every(bullishCandle);
    const bearishSignal = isBearish && recent.length >= this.lookback && recent.every(bearishCandle);
    return {
      signal: bullishSignal ? 'long' : bearishSignal ? 'short' : 'flat',
      indicators: {
        haOpen: last.open,
        haHigh: last.high,
        haLow: last.low,
        haClose: last.close,
        isBullish,
        isBearish,
        bullishSignal,
        bearishSignal,
      },
    };
  }

  _openPos (type, entry, time, indicators = {}) {
    const marginUsed = Math.max(0, this.capital);
    const qty = Math.max(0.000001, (marginUsed * this.leverage) / entry);
    const entryFeePct = type === 'long' ? this.buyFeePct : this.sellFeePct;
    const entryFee = entry * qty * entryFeePct;
    const liquidationPrice = type === 'short'
      ? entry * (1 + 1 / this.leverage)
      : entry * Math.max(0, 1 - 1 / this.leverage);
    this.position = {
      type,
      entry,
      sl: null,
      tp: null,
      trailSl: null,
      qty,
      lotSize: qty,
      marginUsed,
      leverage: this.leverage,
      liquidationPrice,
      entryFee,
      entryTime: time,
      timeframe: this.timeframe,
      strategyKey: 'geminibtc',
      decisionReason: type === 'long' ? 'HA Buy' : 'HA Sell',
      model: 'Gemini BTC',
      indicators,
    };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, leverage, entryTime, sl, tp, entryFee } = this.position;
    const safeExit = normalizePrice(exitPrice, entry);
    const exitFeePct = type === 'long' ? this.sellFeePct : this.buyFeePct;
    const exitFee = safeExit * qty * exitFeePct;
    const gross = type === 'long' ? (safeExit - entry) * qty : (entry - safeExit) * qty;
    const pnl = gross - (entryFee || 0) - exitFee;
    const capitalBefore = this.capital;
    this.capital = Math.max(0, this.capital + pnl);
    if (this.equityHistory.length) this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1,
      type,
      entry,
      exit: safeExit,
      qty,
      lotSize,
      marginUsed,
      leverage,
      pnl,
      pnlPct: capitalBefore ? pnl / capitalBefore * 100 : 0,
      entryTime,
      exitTime,
      reason,
      sl,
      tp,
      fees: (entryFee || 0) + exitFee,
      timeframe: this.timeframe,
      strategyKey: 'geminibtc',
      model: 'Gemini BTC',
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _pushEquityPoint (time) {
    this.equityHistory.push({ time, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();
  }

  _state () {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
    const totalPnl = this.capital - this.initialCapital;
    const dayPnl = this.capital - this.dailyStartCap;
    return {
      strategyKey: 'geminibtc',
      strategyName: this.strategyName,
      timeframe: this.timeframe,
      capital: this.capital,
      initialCapital: this.initialCapital,
      settings: {
        timeframe: this.timeframe,
        leverage: this.leverage,
        buyFeePct: this.buyFeePct * 100,
        sellFeePct: this.sellFeePct * 100,
        lookback: this.lookback,
        candleStyle: 'heikin-ashi',
      },
      totalPnl,
      totalReturn: this.initialCapital ? totalPnl / this.initialCapital * 100 : 0,
      dayPnl,
      dayPnlPct: this.dailyStartCap ? dayPnl / this.dailyStartCap * 100 : 0,
      position: this.position,
      indicators: this.lastIndicators,
      signals: {
        long: this.lastSignal === 'long',
        short: this.lastSignal === 'short',
      },
      lastSignal: this.lastSignal,
      totalTrades: this.trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: this.trades.length ? wins.length / this.trades.length * 100 : 0,
      profitFactor: grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0),
      recentTrades: this.trades.slice(-80).reverse(),
      dailyPnl: this.dailyPnl,
      warmedUp: this.warmedUp,
      currentDate: this.currentDate,
      scriptMeta: this.scriptMeta(),
    };
  }

  _utcDate (tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }
}

function normalizeTimeframe (tf) {
  return TIMEFRAME_MS[tf] ? tf : '5m';
}

function bucketFrom (candle, bucketStart) {
  return {
    openTime: bucketStart,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
    closeTime: candle.closeTime,
  };
}

function aggregateCandles (candles, timeframe) {
  if (timeframe === '5m') return candles.slice();
  const tfMs = TIMEFRAME_MS[timeframe] || TIMEFRAME_MS['5m'];
  const out = [];
  let bucket = null;
  for (const c of candles) {
    const start = Math.floor(c.openTime / tfMs) * tfMs;
    if (!bucket || bucket.openTime !== start) {
      if (bucket) out.push(bucket);
      bucket = bucketFrom(c, start);
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume = (bucket.volume || 0) + (c.volume || 0);
      bucket.closeTime = c.closeTime;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function heikinAshiSeries (candles = []) {
  const out = [];
  let prevOpen = null;
  let prevClose = null;
  for (const candle of candles) {
    const haClose = (Number(candle.open) + Number(candle.high) + Number(candle.low) + Number(candle.close)) / 4;
    const haOpen = prevOpen == null || prevClose == null
      ? (Number(candle.open) + Number(candle.close)) / 2
      : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(Number(candle.high), haOpen, haClose);
    const haLow = Math.min(Number(candle.low), haOpen, haClose);
    out.push({
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: candle.volume || 0,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

function normalizePrice (value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const f = Number(fallback);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

module.exports = {
  GeminiBtcStrategy,
  GEMINI_BTC_DEFAULTS: {
    key: 'geminibtc',
    name: 'Gemini BTC Heikin-Ashi Scalper',
    timeframe: '5m',
    capital: 1000,
    leverage: 1,
    lookback: 3,
    buyFeePct: 0,
    sellFeePct: 0,
    isActive: false,
  },
  TIMEFRAME_MS,
};
