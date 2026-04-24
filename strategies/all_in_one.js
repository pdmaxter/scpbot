'use strict';
const EventEmitter = require('events');

const ALL_IN_ONE_DEFINITIONS = [
  { key: 'ema-crossover', name: '1. EMA Crossover' },
  { key: 'rsi-mean-reversion', name: '2. RSI Mean Reversion' },
  { key: 'macd-momentum', name: '3. MACD Momentum' },
  { key: 'bollinger-breakout', name: '4. Bollinger Breakout' },
  { key: 'supertrend-flip', name: '5. Supertrend Flip' },
  { key: 'vwap-pullback', name: '6. VWAP Pullback' },
  { key: 'stoch-rsi', name: '7. Stochastic RSI' },
  { key: 'donchian-breakout', name: '8. Donchian Breakout' },
  { key: 'hybrid-rsi-ema', name: '9. Hybrid: RSI + EMA' },
  { key: 'inside-bar-breakout', name: '10. Inside Bar Breakout' },
];

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

const AUTO_RISK = {
  riskPerTradePct: 1,
  atrLength: 14,
  slMultiplier: 2,
  tpMultiplier: 4,
  trailOffset: 1.5,
};

class AllInOneStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'allinone';
    this.strategyKey = cfg.strategyKey || 'ema-crossover';
    this.strategyName = strategyName(this.strategyKey);
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Number(cfg.capital || 1000);
    this.capital = this.initialCapital;
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.riskPerTrade = AUTO_RISK.riskPerTradePct / 100;
    this.atrLength = AUTO_RISK.atrLength;
    this.slMultiplier = AUTO_RISK.slMultiplier;
    this.tpMultiplier = AUTO_RISK.tpMultiplier;
    this.trailOffset = AUTO_RISK.trailOffset;
    this.minBars = 220;
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.strategyKey) {
      this.strategyKey = cfg.strategyKey;
      this.strategyName = strategyName(this.strategyKey);
    }
    if (cfg.timeframe) this.timeframe = normalizeTimeframe(cfg.timeframe);
    if (cfg.capital !== undefined) {
      this.capital = Number(cfg.capital) || this.initialCapital;
      this.initialCapital = this.capital;
    }
    if (cfg.buyFeePct !== undefined) this.buyFeePct = Math.max(0, Number(cfg.buyFeePct) || 0) / 100;
    if (cfg.sellFeePct !== undefined) this.sellFeePct = Math.max(0, Number(cfg.sellFeePct) || 0) / 100;
    this.riskPerTrade = AUTO_RISK.riskPerTradePct / 100;
    this.atrLength = AUTO_RISK.atrLength;
    this.slMultiplier = AUTO_RISK.slMultiplier;
    this.tpMultiplier = AUTO_RISK.tpMultiplier;
    this.trailOffset = AUTO_RISK.trailOffset;
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
  }

  restoreFromHistory (candles = []) {
    const aggregated = aggregateCandles(candles, this.timeframe);
    if (aggregated.length < Math.min(this.minBars, 60)) return false;
    this.candles = aggregated.slice(-1000);
    this.currentDate = this._utcDate(this.candles[this.candles.length - 1].openTime);
    this.warmedUp = this.candles.length >= Math.min(this.minBars, 120);
    return this.warmedUp;
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
      strategyKey: this.strategyKey,
      timeframe: this.timeframe,
      source: 'AllInOne.pine',
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
      if (this.candles.length >= Math.min(this.minBars, 120)) {
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    const signal = this._signals();
    const atr = signal.atr || Math.max(candle.high - candle.low, Math.abs(candle.close - candle.open));
    this.lastSignals = { long: signal.long, short: signal.short };
    this.lastIndicators = signal.indicators;
    this.indicatorSnaps.push({
      time: candle.openTime,
      strategyKey: this.strategyKey,
      timeframe: this.timeframe,
      atr,
      longSignal: signal.long ? 1 : 0,
      shortSignal: signal.short ? 1 : 0,
      close: candle.close,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();

    if (this.position) {
      const p = this.position;
      if ((p.type === 'long' && signal.short) || (p.type === 'short' && signal.long)) {
        this._closePos(candle.close, candle.openTime, 'signal_flip');
        return this._state();
      }
      if (p.type === 'long') {
        if (candle.low <= p.trailSl) {
          this._closePos(Math.max(p.trailSl, candle.open), candle.openTime, 'stop_loss');
          return this._state();
        }
        if (candle.high >= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
        p.trailSl = Math.max(p.trailSl, candle.close - atr * this.trailOffset);
      } else {
        if (candle.high >= p.trailSl) {
          this._closePos(Math.min(p.trailSl, candle.open), candle.openTime, 'stop_loss');
          return this._state();
        }
        if (candle.low <= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
        p.trailSl = Math.min(p.trailSl, candle.close + atr * this.trailOffset);
      }
      return this._state();
    }

    if (signal.long) this._openPos('long', candle.close, atr, candle.openTime);
    else if (signal.short) this._openPos('short', candle.close, atr, candle.openTime);
    this.equityHistory.push({ time: candle.openTime, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();
    return this._state();
  }

  _signals () {
    const c = this.candles;
    const closes = c.map(x => x.close);
    const highs = c.map(x => x.high);
    const lows = c.map(x => x.low);
    const atrSeries = atr(c, this.atrLength);
    const atrNow = last(atrSeries) || Math.max(last(highs) - last(lows), 1);
    const ema50 = ema(closes, 50);
    const ema200 = ema(closes, 200);
    const rsi14 = rsi(closes, 14);
    const macdData = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const vw = vwap(c);
    const stoch = stochRsi(closes, 14, 3, 3);
    const donHigh = highest(highs, 20);
    const donLow = lowest(lows, 20);
    const st = supertrend(c, 10, 3);
    const i = closes.length - 1;
    const prev = i - 1;
    const indicators = {
      atr: atrNow,
      ema50: last(ema50),
      ema200: last(ema200),
      rsi: last(rsi14),
      macd: last(macdData.line),
      macdSignal: last(macdData.signal),
      upperBB: last(bb.upper),
      lowerBB: last(bb.lower),
      vwap: last(vw),
      stochK: last(stoch.k),
      stochD: last(stoch.d),
      upperDonchian: last(donHigh),
      lowerDonchian: last(donLow),
      supertrendDirection: last(st.direction),
    };
    let long = false;
    let short = false;

    switch (this.strategyKey) {
      case 'ema-crossover':
        long = crossover(ema50, ema200);
        short = crossunder(ema50, ema200);
        break;
      case 'rsi-mean-reversion':
        long = crossoverValue(rsi14, 30);
        short = crossunderValue(rsi14, 70);
        break;
      case 'macd-momentum':
        long = crossover(macdData.line, macdData.signal);
        short = crossunder(macdData.line, macdData.signal);
        break;
      case 'bollinger-breakout':
        long = closes[i] > bb.upper[i];
        short = closes[i] < bb.lower[i];
        break;
      case 'supertrend-flip':
        long = prev >= 0 && st.direction[i] < st.direction[prev];
        short = prev >= 0 && st.direction[i] > st.direction[prev];
        break;
      case 'vwap-pullback':
        long = crossover(closes, vw) && closes[i] > ema200[i];
        short = crossunder(closes, vw) && closes[i] < ema200[i];
        break;
      case 'stoch-rsi':
        long = crossover(stoch.k, stoch.d) && stoch.k[i] < 20;
        short = crossunder(stoch.k, stoch.d) && stoch.k[i] > 80;
        break;
      case 'donchian-breakout':
        long = closes[i] >= donHigh[i];
        short = closes[i] <= donLow[i];
        break;
      case 'hybrid-rsi-ema':
        long = crossoverValue(rsi14, 30) && closes[i] > ema200[i];
        short = crossunderValue(rsi14, 70) && closes[i] < ema200[i];
        break;
      case 'inside-bar-breakout': {
        const insidePrev = prev >= 1 && highs[prev] < highs[prev - 1] && lows[prev] > lows[prev - 1];
        long = insidePrev && closes[i] > highs[prev];
        short = insidePrev && closes[i] < lows[prev];
        break;
      }
      default:
        break;
    }
    return { long: Boolean(long), short: Boolean(short), atr: atrNow, indicators };
  }

  _openPos (type, entry, atrValue, time) {
    const slDistance = Math.max(atrValue * this.slMultiplier, entry * 0.001);
    const marginUsed = Math.max(0, this.capital);
    const qty = Math.max(0.000001, marginUsed / entry);
    const sl = type === 'long' ? entry - slDistance : entry + slDistance;
    const tp = type === 'long' ? entry + atrValue * this.tpMultiplier : entry - atrValue * this.tpMultiplier;
    const entryFeePct = type === 'long' ? this.buyFeePct : this.sellFeePct;
    const entryFee = entry * qty * entryFeePct;
    this.position = { type, entry, sl, tp, trailSl: sl, qty, lotSize: qty, marginUsed, entryFee, entryTime: time, timeframe: this.timeframe, strategyKey: this.strategyKey };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, entryTime, sl, tp, entryFee } = this.position;
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
      lotSize,
      marginUsed,
      pnl,
      pnlPct: capitalBefore ? pnl / capitalBefore * 100 : 0,
      entryTime,
      exitTime,
      reason,
      sl,
      tp,
      fees: (entryFee || 0) + exitFee,
      timeframe: this.timeframe,
      strategyKey: this.strategyKey,
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
      strategyKey: this.strategyKey,
      strategyName: this.strategyName,
      timeframe: this.timeframe,
      capital: this.capital,
      initialCapital: this.initialCapital,
      settings: {
        buyFeePct: this.buyFeePct * 100,
        sellFeePct: this.sellFeePct * 100,
      },
      riskPerTradePct: this.riskPerTrade * 100,
      totalPnl,
      totalReturn: this.initialCapital ? totalPnl / this.initialCapital * 100 : 0,
      dayPnl,
      dayPnlPct: this.dailyStartCap ? dayPnl / this.dailyStartCap * 100 : 0,
      position: this.position,
      indicators: this.lastIndicators,
      signals: this.lastSignals,
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

function strategyName (key) {
  return ALL_IN_ONE_DEFINITIONS.find(s => s.key === key)?.name || key;
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

function last (arr) { return arr?.[arr.length - 1]; }

function sma (values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    return slice.reduce((sum, v) => sum + v, 0) / period;
  });
}

function ema (values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      prev = values.slice(i + 1 - period, i + 1).reduce((sum, v) => sum + v, 0) / period;
    } else {
      prev = value * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

function rsi (values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - values[j - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    if (!losses) out[i] = 100;
    else {
      const rs = gains / losses;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function macd (values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null);
  const lineClean = line.map(v => v ?? 0);
  const signalRaw = ema(lineClean, 9);
  const signal = signalRaw.map((v, i) => line[i] == null ? null : v);
  return { line, signal };
}

function bollinger (values, period, mult) {
  const mid = sma(values, period);
  const upper = values.map((_, i) => {
    if (mid[i] == null) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid[i], 2), 0) / period;
    return mid[i] + Math.sqrt(variance) * mult;
  });
  const lower = values.map((_, i) => {
    if (mid[i] == null) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid[i], 2), 0) / period;
    return mid[i] - Math.sqrt(variance) * mult;
  });
  return { mid, upper, lower };
}

function atr (candles, period) {
  const tr = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return sma(tr, period);
}

function vwap (candles) {
  let date = '';
  let pv = 0;
  let vol = 0;
  return candles.map(c => {
    const d = new Date(c.openTime).toISOString().slice(0, 10);
    if (d !== date) {
      date = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 1;
    pv += typical * v;
    vol += v;
    return vol ? pv / vol : c.close;
  });
}

function stochRsi (values, period, kPeriod, dPeriod) {
  const r = rsi(values, period);
  const rawK = r.map((value, i) => {
    if (value == null || i + 1 < period) return null;
    const slice = r.slice(Math.max(0, i + 1 - period), i + 1).filter(v => v != null);
    const hi = Math.max(...slice);
    const lo = Math.min(...slice);
    return hi === lo ? 0 : (value - lo) / (hi - lo) * 100;
  });
  const k = sma(rawK.map(v => v ?? 0), kPeriod).map((v, i) => rawK[i] == null ? null : v);
  const d = sma(k.map(v => v ?? 0), dPeriod).map((v, i) => k[i] == null ? null : v);
  return { k, d };
}

function highest (values, period) {
  return values.map((_, i) => i + 1 < period ? null : Math.max(...values.slice(i + 1 - period, i + 1)));
}

function lowest (values, period) {
  return values.map((_, i) => i + 1 < period ? null : Math.min(...values.slice(i + 1 - period, i + 1)));
}

function supertrend (candles, period, mult) {
  const a = atr(candles, period);
  const direction = Array(candles.length).fill(1);
  const trend = Array(candles.length).fill(null);
  let finalUpper = null;
  let finalLower = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (a[i] == null) continue;
    const hl2 = (c.high + c.low) / 2;
    const upper = hl2 + mult * a[i];
    const lower = hl2 - mult * a[i];
    finalUpper = finalUpper == null || upper < finalUpper || candles[i - 1]?.close > finalUpper ? upper : finalUpper;
    finalLower = finalLower == null || lower > finalLower || candles[i - 1]?.close < finalLower ? lower : finalLower;
    if (i > 0) {
      direction[i] = direction[i - 1];
      if (c.close > finalUpper) direction[i] = -1;
      else if (c.close < finalLower) direction[i] = 1;
    }
    trend[i] = direction[i] < 0 ? finalLower : finalUpper;
  }
  return { trend, direction };
}

function crossover (a, b) {
  const i = a.length - 1;
  if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return false;
  return a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossunder (a, b) {
  const i = a.length - 1;
  if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return false;
  return a[i - 1] >= b[i - 1] && a[i] < b[i];
}

function crossoverValue (series, value) {
  const i = series.length - 1;
  if (i < 1 || series[i] == null || series[i - 1] == null || value == null) return false;
  return series[i - 1] <= value && series[i] > value;
}

function crossunderValue (series, value) {
  const i = series.length - 1;
  if (i < 1 || series[i] == null || series[i - 1] == null || value == null) return false;
  return series[i - 1] >= value && series[i] < value;
}

module.exports = { AllInOneStrategy, ALL_IN_ONE_DEFINITIONS, TIMEFRAME_MS, AUTO_RISK };
