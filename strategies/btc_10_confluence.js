'use strict';
const EventEmitter = require('events');

const BTC_10_CONFLUENCE_DEFINITIONS = [
  { key: 'btc-10-confluence', name: 'BTC 10 Strategies Confluence', source: 'BTC 10 Strategies Confluence' },
];

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

class Btc10ConfluenceStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'btc10-confluence';
    this.marketPage = cfg.marketPage || 'btc10';
    this.marketLabel = cfg.marketLabel || 'BTC 10';
    this.symbol = String(cfg.symbol || 'BTCUSDT').trim();
    this.strategyKey = cfg.strategyKey || BTC_10_CONFLUENCE_DEFINITIONS[0].key;
    this.strategyName = strategyName(this.strategyKey);
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Math.max(100, Number(cfg.capital || 1000));
    this.capital = this.initialCapital;
    this.leverage = Math.max(1, Number(cfg.leverage || 1));
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.threshold = 6;
    this.tpPct = 0.03;
    this.slPct = 0.015;
    this.tslPct = 0.005;
    this.minBars = 60;
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.marketPage) this.marketPage = cfg.marketPage;
    if (cfg.marketLabel) this.marketLabel = cfg.marketLabel;
    if (cfg.symbol !== undefined) this.symbol = String(cfg.symbol || 'BTCUSDT').trim() || 'BTCUSDT';
    if (cfg.strategyKey) {
      this.strategyKey = cfg.strategyKey;
      this.strategyName = strategyName(this.strategyKey);
    }
    if (cfg.timeframe) this.timeframe = normalizeTimeframe(cfg.timeframe);
    if (cfg.capital !== undefined) {
      this.capital = Math.max(100, Number(cfg.capital) || this.initialCapital);
      this.initialCapital = this.capital;
    }
    if (cfg.leverage !== undefined) this.leverage = Math.max(1, Number(cfg.leverage) || 1);
    if (cfg.buyFeePct !== undefined) this.buyFeePct = Math.max(0, Number(cfg.buyFeePct) || 0) / 100;
    if (cfg.sellFeePct !== undefined) this.sellFeePct = Math.max(0, Number(cfg.sellFeePct) || 0) / 100;
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
    if (aggregated.length < this.minBars) return false;
    this.candles = aggregated.slice(-1500);
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
      strategyKey: this.strategyKey,
      timeframe: this.timeframe,
      source: 'BTC 10 Strategies Confluence',
      marketPage: this.marketPage,
      marketLabel: this.marketLabel,
      symbol: this.symbol,
      threshold: this.threshold,
      takeProfitPct: this.tpPct * 100,
      stopLossPct: this.slPct * 100,
      trailingStopPct: this.tslPct * 100,
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
    if (this.candles.length > 1800) this.candles.shift();

    if (!this.warmedUp) {
      if (this.candles.length >= this.minBars) {
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    const signal = this._signals();
    this.lastSignals = { long: signal.long, short: signal.short };
    this.lastIndicators = signal.indicators;
    this.indicatorSnaps.push({
      time: candle.openTime,
      close: candle.close,
      totalScore: signal.indicators.totalScore,
      threshold: this.threshold,
      longSignal: signal.long ? 1 : 0,
      shortSignal: signal.short ? 1 : 0,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();

    let exited = false;
    if (this.position) {
      exited = this._handleOpenPosition(candle);
    }

    if (this.position && ((this.position.type === 'long' && signal.short) || (this.position.type === 'short' && signal.long))) {
      const nextType = this.position.type === 'long' ? 'short' : 'long';
      this._closePos(candle.close, candle.openTime, 'signal_flip');
      this._openPos(nextType, candle.close, candle.openTime, signal.indicators);
      this._recordEquity(candle.openTime);
      return this._state();
    }

    if (!this.position && (signal.long || signal.short)) {
      this._openPos(signal.long ? 'long' : 'short', candle.close, candle.openTime, signal.indicators);
    } else if (exited) {
      this._recordEquity(candle.openTime);
      return this._state();
    }

    this._recordEquity(candle.openTime);
    return this._state();
  }

  _handleOpenPosition (candle) {
    const p = this.position;
    if (!p) return false;

    if (p.type === 'long') {
      p.bestHigh = Math.max(Number(p.bestHigh || p.entry), Number(candle.high));
      p.trailSl = Math.max(p.sl, p.bestHigh * (1 - this.tslPct));
      if (p.liquidationPrice && candle.low <= p.liquidationPrice) {
        this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
        return true;
      }
      if (candle.low <= p.trailSl) {
        const reason = p.trailSl > p.sl + Math.max(p.entry * 1e-8, 1e-8) ? 'trailing_sl' : 'stop_loss';
        this._closePos(Math.max(p.trailSl, candle.open), candle.openTime, reason);
        return true;
      }
      if (candle.high >= p.tp) {
        this._closePos(p.tp, candle.openTime, 'take_profit');
        return true;
      }
      return false;
    }

    p.bestLow = Math.min(Number(p.bestLow || p.entry), Number(candle.low));
    p.trailSl = Math.min(p.sl, p.bestLow * (1 + this.tslPct));
    if (p.liquidationPrice && candle.high >= p.liquidationPrice) {
      this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
      return true;
    }
    if (candle.high >= p.trailSl) {
      const reason = p.trailSl < p.sl - Math.max(p.entry * 1e-8, 1e-8) ? 'trailing_sl' : 'stop_loss';
      this._closePos(Math.min(p.trailSl, candle.open), candle.openTime, reason);
      return true;
    }
    if (candle.low <= p.tp) {
      this._closePos(p.tp, candle.openTime, 'take_profit');
      return true;
    }
    return false;
  }

  _signals () {
    const candles = this.candles;
    const closes = candles.map(x => Number(x.close));
    const highs = candles.map(x => Number(x.high));
    const lows = candles.map(x => Number(x.low));
    const volumes = candles.map(x => Number(x.volume) || 0);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const vwapClose = vwapFromSource(closes, volumes, candles);
    const rsi14 = rsi(closes, 14);
    const macdData = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const dmiData = dmi(candles, 14, 14);
    const rawStoch = stochastic(highs, lows, closes, 14);
    const stochK = sma(rawStoch.map(v => v ?? 0), 3).map((v, idx) => rawStoch[idx] == null ? null : v);
    const mfi14 = mfi(closes, volumes, 14);
    const st = supertrend(candles, 10, 3);
    const atr14 = atr(candles, 14);
    const sma20 = sma(closes, 20);
    const i = closes.length - 1;
    const close = closes[i];
    const s1 = ema9[i] != null && ema21[i] != null ? (ema9[i] > ema21[i] ? 1 : -1) : 0;
    const s2 = vwapClose[i] != null ? (close > vwapClose[i] ? 1 : -1) : 0;
    const s3 = rsi14[i] == null ? 0 : (rsi14[i] < 40 ? 1 : (rsi14[i] > 60 ? -1 : 0));
    const s4 = macdData.line[i] != null && macdData.signal[i] != null ? (macdData.line[i] > macdData.signal[i] ? 1 : -1) : 0;
    const s5 = bb.lower[i] == null || bb.upper[i] == null ? 0 : (close < bb.lower[i] ? 1 : (close > bb.upper[i] ? -1 : 0));
    const s6 = dmiData.adx[i] == null || dmiData.plus[i] == null || dmiData.minus[i] == null
      ? 0
      : (dmiData.adx[i] > 25 && dmiData.plus[i] > dmiData.minus[i] ? 1 : (dmiData.adx[i] > 25 && dmiData.minus[i] > dmiData.plus[i] ? -1 : 0));
    const s7 = stochK[i] == null ? 0 : (stochK[i] < 20 ? 1 : (stochK[i] > 80 ? -1 : 0));
    const s8 = mfi14[i] == null ? 0 : (mfi14[i] < 20 ? 1 : (mfi14[i] > 80 ? -1 : 0));
    const s9 = st.direction[i] == null ? 0 : (st.direction[i] < 0 ? 1 : -1);
    const s10 = atr14[i] == null || sma20[i] == null ? 0 : (close > sma20[i] + atr14[i] * 0.5 ? 1 : -1);
    const totalScore = s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8 + s9 + s10;

    return {
      long: totalScore >= this.threshold,
      short: totalScore <= -this.threshold,
      indicators: {
        totalScore,
        threshold: this.threshold,
        ema9: ema9[i],
        ema21: ema21[i],
        vwap: vwapClose[i],
        rsi: rsi14[i],
        macd: macdData.line[i],
        macdSignal: macdData.signal[i],
        bbUpper: bb.upper[i],
        bbLower: bb.lower[i],
        adx: dmiData.adx[i],
        diPlus: dmiData.plus[i],
        diMinus: dmiData.minus[i],
        stochK: stochK[i],
        mfi: mfi14[i],
        supertrend: st.trend[i],
        supertrendDirection: st.direction[i],
        atr: atr14[i],
        sma20: sma20[i],
        s1, s2, s3, s4, s5, s6, s7, s8, s9, s10,
      },
    };
  }

  _openPos (type, entry, time, indicators = {}) {
    const marginUsed = Math.max(0, this.capital);
    const qty = Math.max(0.000001, (marginUsed * this.leverage) / entry);
    const entryFeePct = type === 'long' ? this.buyFeePct : this.sellFeePct;
    const entryFee = entry * qty * entryFeePct;
    const sl = type === 'long' ? entry * (1 - this.slPct) : entry * (1 + this.slPct);
    const tp = type === 'long' ? entry * (1 + this.tpPct) : entry * (1 - this.tpPct);
    const liquidationPrice = type === 'short'
      ? entry * (1 + 1 / this.leverage)
      : entry * Math.max(0, 1 - 1 / this.leverage);
    this.position = {
      type,
      entry,
      sl,
      tp,
      trailSl: sl,
      qty,
      lotSize: qty,
      marginUsed,
      leverage: this.leverage,
      liquidationPrice,
      entryFee,
      entryTime: time,
      timeframe: this.timeframe,
      strategyKey: this.strategyKey,
      decisionReason: type === 'long' ? 'BUY signal' : 'SELL signal',
      model: 'BTC 10 Strategies Confluence',
      indicators,
      bestHigh: type === 'long' ? entry : null,
      bestLow: type === 'short' ? entry : null,
    };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, leverage, entryTime, sl, tp, trailSl, entryFee } = this.position;
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
      trailSl,
      fees: (entryFee || 0) + exitFee,
      timeframe: this.timeframe,
      strategyKey: this.strategyKey,
      symbol: this.symbol,
      marketPage: this.marketPage,
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _recordEquity (time) {
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
      marketPage: this.marketPage,
      marketLabel: this.marketLabel,
      symbol: this.symbol,
      strategyKey: this.strategyKey,
      strategyName: this.strategyName,
      timeframe: this.timeframe,
      capital: this.capital,
      initialCapital: this.initialCapital,
      settings: {
        leverage: this.leverage,
        buyFeePct: this.buyFeePct * 100,
        sellFeePct: this.sellFeePct * 100,
        threshold: this.threshold,
        takeProfitPct: this.tpPct * 100,
        stopLossPct: this.slPct * 100,
        trailingStopPct: this.tslPct * 100,
      },
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

function strategyDefinition (key) {
  return BTC_10_CONFLUENCE_DEFINITIONS.find(item => item.key === key) || BTC_10_CONFLUENCE_DEFINITIONS[0];
}

function strategyName (key) { return strategyDefinition(key).name; }

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

function normalizePrice (value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const f = Number(fallback);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

function sma (values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1).filter(v => v != null);
    if (!slice.length) return null;
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
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
  const signalRaw = ema(line.map(v => v ?? 0), 9);
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

function stochastic (highs, lows, closes, period) {
  return closes.map((close, i) => {
    if (i + 1 < period) return null;
    const upper = Math.max(...highs.slice(i + 1 - period, i + 1));
    const lower = Math.min(...lows.slice(i + 1 - period, i + 1));
    const range = upper - lower;
    return range ? (close - lower) / range * 100 : 0;
  });
}

function mfi (values, volumes, period) {
  const out = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let positive = 0;
    let negative = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = (Number(values[j]) || 0) * (Number(volumes[j]) || 0);
      const prev = Number(values[j - 1]) || 0;
      if (values[j] > prev) positive += flow;
      else if (values[j] < prev) negative += flow;
    }
    if (!negative) out[i] = 100;
    else {
      const ratio = positive / negative;
      out[i] = 100 - 100 / (1 + ratio);
    }
  }
  return out;
}

function dmi (candles, diPeriod, adxSmoothing) {
  const plusDm = Array(candles.length).fill(0);
  const minusDm = Array(candles.length).fill(0);
  const tr = Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }
  tr[0] = candles[0] ? candles[0].high - candles[0].low : 0;
  const atrSeries = sma(tr, diPeriod);
  const plusDmAvg = sma(plusDm, diPeriod);
  const minusDmAvg = sma(minusDm, diPeriod);
  const plus = plusDm.map((_, i) => {
    const avgTr = atrSeries[i];
    const avgDm = plusDmAvg[i];
    return avgTr ? (avgDm / avgTr) * 100 : null;
  });
  const minus = minusDm.map((_, i) => {
    const avgTr = atrSeries[i];
    const avgDm = minusDmAvg[i];
    return avgTr ? (avgDm / avgTr) * 100 : null;
  });
  const dx = plus.map((value, i) => {
    if (value == null || minus[i] == null) return null;
    const denom = value + minus[i];
    return denom ? Math.abs(value - minus[i]) / denom * 100 : 0;
  });
  return {
    plus,
    minus,
    adx: sma(dx.map(v => v ?? 0), adxSmoothing).map((v, i) => dx[i] == null ? null : v),
  };
}

function vwapFromSource(values, volumes, candles) {
  let date = '';
  let pv = 0;
  let vol = 0;
  return values.map((value, i) => {
    const candle = candles[i];
    const nextDate = new Date(candle.openTime).toISOString().slice(0, 10);
    if (nextDate !== date) {
      date = nextDate;
      pv = 0;
      vol = 0;
    }
    const flow = (Number(value) || 0) * (Number(volumes[i]) || 0);
    pv += flow;
    vol += Number(volumes[i]) || 0;
    return vol ? pv / vol : Number(value) || 0;
  });
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

module.exports = {
  Btc10ConfluenceStrategy,
  BTC_10_CONFLUENCE_DEFINITIONS,
  TIMEFRAME_MS,
};
