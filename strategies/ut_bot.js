'use strict';
const EventEmitter = require('events');

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

class UTBotStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'utbot';
    this.strategyName = 'UT Bot Alerts';
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Number(cfg.capital || 1000);
    this.capital = this.initialCapital;
    this.keyValue = Number(cfg.keyValue || 1);
    this.atrPeriod = Math.max(2, Math.round(Number(cfg.atrPeriod || 10)));
    this.useHeikinAshi = Boolean(cfg.useHeikinAshi);
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.minBars = Math.max(60, this.atrPeriod + 20);
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.timeframe) this.timeframe = normalizeTimeframe(cfg.timeframe);
    if (cfg.capital !== undefined) {
      this.capital = Number(cfg.capital) || this.initialCapital;
      this.initialCapital = this.capital;
    }
    if (cfg.keyValue !== undefined) this.keyValue = Math.max(0.1, Number(cfg.keyValue) || 1);
    if (cfg.atrPeriod !== undefined) this.atrPeriod = Math.max(2, Math.round(Number(cfg.atrPeriod) || 10));
    if (cfg.useHeikinAshi !== undefined) this.useHeikinAshi = Boolean(cfg.useHeikinAshi);
    if (cfg.buyFeePct !== undefined) this.buyFeePct = Math.max(0, Number(cfg.buyFeePct) || 0) / 100;
    if (cfg.sellFeePct !== undefined) this.sellFeePct = Math.max(0, Number(cfg.sellFeePct) || 0) / 100;
    this.minBars = Math.max(60, this.atrPeriod + 20);
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
    this.lastSignals = { long: false, short: false };
    this.lastIndicators = {};
    this.prevStop = 0;
    this.prevPos = 0;
  }

  restoreFromHistory (candles = []) {
    const aggregated = aggregateCandles(candles, this.timeframe);
    if (aggregated.length < Math.min(this.minBars, 60)) return false;
    this.candles = [];
    this.prevStop = 0;
    this.prevPos = 0;
    for (const candle of aggregated.slice(-1000)) this._processStrategyCandle(candle, { warmupOnly: true });
    this.currentDate = this._utcDate(aggregated[aggregated.length - 1].openTime);
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
      source: 'UT BOT Alerts.pine',
      exits: 'Opposite signal books profit; trailing ATR stop protects running trade.',
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

  _processStrategyCandle (candle, opts = {}) {
    const dateStr = this._utcDate(candle.openTime);
    if (!opts.warmupOnly && dateStr !== this.currentDate) {
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

    if (!this.warmedUp && !opts.warmupOnly) {
      if (this.candles.length >= this.minBars) {
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    const signal = this._signals();
    this.lastSignals = { long: signal.buy, short: signal.sell };
    this.lastIndicators = signal.indicators;

    if (!opts.warmupOnly) {
      this.indicatorSnaps.push({
        time: candle.openTime,
        atr: signal.atr,
        trailingStop: signal.stop,
        longSignal: signal.buy ? 1 : 0,
        shortSignal: signal.sell ? 1 : 0,
        close: candle.close,
      });
      if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();
    }

    if (opts.warmupOnly) return this._state();

    if (this.position) {
      const p = this.position;
      if (p.type === 'long') {
        p.trailSl = Math.max(p.trailSl, signal.stop);
        if (signal.sell) {
          this._closePos(candle.close, candle.openTime, 'opposite_sell_signal');
          this._openPos('short', candle.close, signal.stop, candle.openTime);
          return this._state();
        }
        if (candle.low <= p.trailSl) {
          this._closePos(Math.max(p.trailSl, candle.open), candle.openTime, 'trailing_stop');
          return this._state();
        }
      } else {
        p.trailSl = Math.min(p.trailSl, signal.stop);
        if (signal.buy) {
          this._closePos(candle.close, candle.openTime, 'opposite_buy_signal');
          this._openPos('long', candle.close, signal.stop, candle.openTime);
          return this._state();
        }
        if (candle.high >= p.trailSl) {
          this._closePos(Math.min(p.trailSl, candle.open), candle.openTime, 'trailing_stop');
          return this._state();
        }
      }
      return this._state();
    }

    if (signal.buy) this._openPos('long', candle.close, signal.stop, candle.openTime);
    else if (signal.sell) this._openPos('short', candle.close, signal.stop, candle.openTime);
    this.equityHistory.push({ time: candle.openTime, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();
    return this._state();
  }

  _signals () {
    const sourceCandles = this.useHeikinAshi ? heikinAshi(this.candles) : this.candles;
    const src = sourceCandles.map(c => c.close);
    const candle = sourceCandles[sourceCandles.length - 1];
    const prevSrc = src[src.length - 2] ?? src[src.length - 1];
    const atrSeries = atr(sourceCandles, this.atrPeriod);
    const atrNow = last(atrSeries) || Math.max(candle.high - candle.low, 1);
    const nLoss = this.keyValue * atrNow;
    const prevStop = this.prevStop || 0;
    let stop;
    if (candle.close > prevStop && prevSrc > prevStop) stop = Math.max(prevStop, candle.close - nLoss);
    else if (candle.close < prevStop && prevSrc < prevStop) stop = Math.min(prevStop, candle.close + nLoss);
    else stop = candle.close > prevStop ? candle.close - nLoss : candle.close + nLoss;

    let pos = this.prevPos;
    if (prevSrc < prevStop && candle.close > prevStop) pos = 1;
    else if (prevSrc > prevStop && candle.close < prevStop) pos = -1;

    const buy = candle.close > stop && prevSrc <= prevStop && candle.close > prevStop;
    const sell = candle.close < stop && prevSrc >= prevStop && candle.close < prevStop;
    this.prevStop = stop;
    this.prevPos = pos;
    return {
      buy,
      sell,
      atr: atrNow,
      stop,
      indicators: {
        atr: atrNow,
        trailingStop: stop,
        sourceClose: candle.close,
        positionState: pos,
        useHeikinAshi: this.useHeikinAshi,
      },
    };
  }

  _openPos (type, entry, trailSl, time) {
    const qty = Math.max(0.000001, this.capital / entry);
    const entryFeePct = type === 'long' ? this.buyFeePct : this.sellFeePct;
    const entryFee = entry * qty * entryFeePct;
    this.position = {
      type,
      entry,
      sl: trailSl,
      tp: null,
      trailSl,
      qty,
      entryFee,
      entryTime: time,
      timeframe: this.timeframe,
    };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, entryTime, sl, entryFee } = this.position;
    const exitFeePct = type === 'long' ? this.sellFeePct : this.buyFeePct;
    const exitFee = exitPrice * qty * exitFeePct;
    const gross = type === 'long' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
    const pnl = gross - (entryFee || 0) - exitFee;
    const capitalBefore = this.capital;
    this.capital += pnl;
    if (this.equityHistory.length) this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1,
      type,
      entry,
      exit: exitPrice,
      qty,
      pnl,
      pnlPct: capitalBefore ? pnl / capitalBefore * 100 : 0,
      entryTime,
      exitTime,
      reason,
      sl,
      tp: null,
      fees: (entryFee || 0) + exitFee,
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _state () {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
    const totalPnl = this.capital - this.initialCapital;
    const dayPnl = this.capital - this.dailyStartCap;
    return {
      strategyName: this.strategyName,
      timeframe: this.timeframe,
      capital: this.capital,
      initialCapital: this.initialCapital,
      totalPnl,
      totalReturn: this.initialCapital ? totalPnl / this.initialCapital * 100 : 0,
      dayPnl,
      dayPnlPct: this.dailyStartCap ? dayPnl / this.dailyStartCap * 100 : 0,
      position: this.position,
      indicators: this.lastIndicators,
      signals: this.lastSignals,
      settings: {
        keyValue: this.keyValue,
        atrPeriod: this.atrPeriod,
        useHeikinAshi: this.useHeikinAshi,
        buyFeePct: this.buyFeePct * 100,
        sellFeePct: this.sellFeePct * 100,
      },
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

function heikinAshi (candles) {
  let prevOpen = null;
  let prevClose = null;
  return candles.map(c => {
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = prevOpen == null ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(c.high, open, close);
    const low = Math.min(c.low, open, close);
    prevOpen = open;
    prevClose = close;
    return { ...c, open, high, low, close };
  });
}

function atr (candles, period) {
  const tr = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return sma(tr, period);
}

function sma (values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    return slice.reduce((sum, v) => sum + v, 0) / period;
  });
}

function last (arr) { return arr?.[arr.length - 1]; }

module.exports = { UTBotStrategy, TIMEFRAME_MS };
