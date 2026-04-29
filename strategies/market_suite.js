'use strict';
const EventEmitter = require('events');

const MARKET_SUITE_DEFINITIONS = [
  { key: 'rsi-indicator', name: '1. RSI Indicator', source: '01_RSI.pine', slMult: 1.5, tpMult: 3.0, trailMult: 1.2 },
  { key: 'macd-indicator', name: '2. MACD Indicator', source: '02_MACD.pine', slMult: 1.7, tpMult: 3.4, trailMult: 1.3 },
  { key: 'bollinger-indicator', name: '3. Bollinger Bands Indicator', source: '03_BollingerBands.pine', slMult: 1.8, tpMult: 3.2, trailMult: 1.2 },
  { key: 'supertrend-indicator', name: '4. Supertrend Indicator', source: '04_Supertrend.pine', slMult: 1.6, tpMult: 3.4, trailMult: 1.1 },
  { key: 'ema-crossover-indicator', name: '5. EMA Crossover Indicator', source: '05_EMA_Crossover.pine', slMult: 1.7, tpMult: 3.3, trailMult: 1.2 },
  { key: 'stochrsi-indicator', name: '6. Stochastic RSI Indicator', source: '06_StochasticRSI.pine', slMult: 1.4, tpMult: 2.8, trailMult: 1.0 },
  { key: 'atr-volatility', name: '7. ATR Volatility Strategy', source: '07_ATR.pine', slMult: 2.0, tpMult: 4.0, trailMult: 1.5 },
  { key: 'ichimoku-cloud', name: '8. Ichimoku Cloud', source: '08_IchimokuCloud.pine', slMult: 2.0, tpMult: 4.2, trailMult: 1.5 },
  { key: 'vwap-bands', name: '9. VWAP Bands', source: '09_VWAP_Bands.pine', slMult: 1.6, tpMult: 3.0, trailMult: 1.1 },
  { key: 'williams-r', name: '10. Williams %R', source: '10_WilliamsR.pine', slMult: 1.4, tpMult: 2.8, trailMult: 1.0 },
  { key: 'trendline-breakout', name: '11. Breakout / Breakdown Trendlines', source: '11_Breakout_Breakdown_Trendlines.pine', slMult: 2.0, tpMult: 4.5, trailMult: 1.6 },
  { key: 'rsi-mean-reversion', name: '12. RSI Mean Reversion Strategy', source: '01_RSI_MeanReversion.pine', slMult: 1.3, tpMult: 2.6, trailMult: 0.9 },
  { key: 'macd-crossover-strategy', name: '13. MACD Crossover Strategy', source: '02_MACD_Crossover.pine', slMult: 1.8, tpMult: 3.6, trailMult: 1.3 },
  { key: 'bollinger-breakout-strategy', name: '14. Bollinger Bands Breakout Strategy', source: '03_BollingerBands_Breakout.pine', slMult: 1.9, tpMult: 3.8, trailMult: 1.4 },
  { key: 'ema-golden-cross', name: '15. EMA Golden / Death Cross Strategy', source: '04_EMA_GoldenCross.pine', slMult: 2.1, tpMult: 4.5, trailMult: 1.7 },
  { key: 'supertrend-strategy', name: '16. Supertrend Strategy', source: '05_Supertrend_Strategy.pine', slMult: 1.8, tpMult: 3.6, trailMult: 1.2 },
];

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

class MarketSuiteStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'market-suite';
    this.marketPage = cfg.marketPage || 'btc';
    this.marketLabel = cfg.marketLabel || this.marketPage.toUpperCase();
    this.symbol = String(cfg.symbol || defaultSymbolForMarket(this.marketPage)).trim();
    this.strategyKey = cfg.strategyKey || MARKET_SUITE_DEFINITIONS[0].key;
    this.strategyName = strategyName(this.strategyKey);
    this.sourceName = strategySource(this.strategyKey);
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Math.max(100, Number(cfg.capital || 1000));
    this.capital = this.initialCapital;
    this.leverage = Math.max(1, Number(cfg.leverage || 1));
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.minBars = 260;
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.marketPage) this.marketPage = cfg.marketPage;
    if (cfg.marketLabel) this.marketLabel = cfg.marketLabel;
    if (cfg.symbol !== undefined) this.symbol = String(cfg.symbol || defaultSymbolForMarket(this.marketPage)).trim();
    if (cfg.strategyKey) {
      this.strategyKey = cfg.strategyKey;
      this.strategyName = strategyName(this.strategyKey);
      this.sourceName = strategySource(this.strategyKey);
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
    if (aggregated.length < Math.min(this.minBars, 120)) return false;
    this.candles = aggregated.slice(-1600);
    this.currentDate = this._utcDate(this.candles[this.candles.length - 1].openTime);
    this.warmedUp = this.candles.length >= Math.min(this.minBars, 180);
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
      source: this.sourceName,
      marketPage: this.marketPage,
      marketLabel: this.marketLabel,
      symbol: this.symbol,
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
      if (this.candles.length >= Math.min(this.minBars, 180)) {
        this.warmedUp = true;
        this.emit('warmed_up');
      }
      return this._state();
    }

    const signal = this._signals();
    const atrNow = signal.atr || Math.max(candle.high - candle.low, Math.abs(candle.close - candle.open), 1);
    this.lastSignals = { long: signal.long, short: signal.short };
    this.lastIndicators = signal.indicators;
    this.indicatorSnaps.push({
      time: candle.openTime,
      strategyKey: this.strategyKey,
      timeframe: this.timeframe,
      symbol: this.symbol,
      atr: atrNow,
      longSignal: signal.long ? 1 : 0,
      shortSignal: signal.short ? 1 : 0,
      close: candle.close,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();

    if (this.position) {
      const p = this.position;
      if ((p.type === 'long' && signal.short) || (p.type === 'short' && signal.long)) {
        const nextType = p.type === 'long' ? 'short' : 'long';
        this._closePos(candle.close, candle.openTime, 'signal_flip');
        this._openPos(nextType, candle.close, atrNow, candle.openTime);
        this._recordEquity(candle.openTime);
        return this._state();
      }
      if (p.type === 'long') {
        if (p.liquidationPrice && candle.low <= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
        if (candle.low <= p.trailSl) {
          this._closePos(Math.max(p.trailSl, candle.open), candle.openTime, 'trailing_sl');
          return this._state();
        }
        if (candle.low <= p.sl) {
          this._closePos(Math.max(p.sl, candle.open), candle.openTime, 'stop_loss');
          return this._state();
        }
        if (candle.high >= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
        p.trailSl = Math.max(p.trailSl, candle.close - atrNow * p.trailMult);
      } else {
        if (p.liquidationPrice && candle.high >= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
        if (candle.high >= p.trailSl) {
          this._closePos(Math.min(p.trailSl, candle.open), candle.openTime, 'trailing_sl');
          return this._state();
        }
        if (candle.high >= p.sl) {
          this._closePos(Math.min(p.sl, candle.open), candle.openTime, 'stop_loss');
          return this._state();
        }
        if (candle.low <= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
        p.trailSl = Math.min(p.trailSl, candle.close + atrNow * p.trailMult);
      }
      this._recordEquity(candle.openTime);
      return this._state();
    }

    if (signal.long) this._openPos('long', candle.close, atrNow, candle.openTime);
    else if (signal.short) this._openPos('short', candle.close, atrNow, candle.openTime);
    this._recordEquity(candle.openTime);
    return this._state();
  }

  _recordEquity (time) {
    this.equityHistory.push({ time, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();
  }

  _signals () {
    const c = this.candles;
    const closes = c.map(x => x.close);
    const highs = c.map(x => x.high);
    const lows = c.map(x => x.low);
    const volumes = c.map(x => Number(x.volume) || 0);
    const atrSeries = atr(c, 14);
    const atrNow = last(atrSeries) || Math.max(last(highs) - last(lows), 1);
    const atrSma = sma(atrSeries.map(v => v ?? 0), 14).map((v, i) => atrSeries[i] == null ? null : v);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema50 = ema(closes, 50);
    const ema200 = ema(closes, 200);
    const rsi14 = rsi(closes, 14);
    const macdData = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const vw = vwap(c);
    const stoch = stochRsi(closes, 14, 3, 3);
    const st = supertrend(c, 10, 3);
    const ich = ichimoku(c);
    const wpr = williamsR(highs, lows, closes, 14);
    const breakouts = breakoutLevels(highs, lows, atrNow);
    const i = closes.length - 1;
    const prev = i - 1;
    const indicators = {
      atr: atrNow,
      atrSma: last(atrSma),
      ema9: last(ema9),
      ema21: last(ema21),
      ema50: last(ema50),
      ema200: last(ema200),
      rsi: last(rsi14),
      macd: last(macdData.line),
      macdSignal: last(macdData.signal),
      upperBB: last(bb.upper),
      lowerBB: last(bb.lower),
      bbBasis: last(bb.mid),
      vwap: last(vw),
      stochK: last(stoch.k),
      stochD: last(stoch.d),
      supertrendDirection: last(st.direction),
      supertrend: last(st.trend),
      ichimokuConversion: last(ich.conversion),
      ichimokuBase: last(ich.base),
      ichimokuSpanA: last(ich.spanA),
      ichimokuSpanB: last(ich.spanB),
      williamsR: last(wpr),
      breakoutResistance: breakouts.resistance,
      breakoutSupport: breakouts.support,
    };

    let long = false;
    let short = false;

    switch (this.strategyKey) {
      case 'rsi-indicator':
      case 'rsi-mean-reversion':
        long = crossoverValue(rsi14, 30);
        short = crossunderValue(rsi14, 70);
        break;
      case 'macd-indicator':
        long = crossover(macdData.line, macdData.signal);
        short = crossunder(macdData.line, macdData.signal);
        break;
      case 'bollinger-indicator':
        long = crossover(closes, bb.upper);
        short = crossunder(closes, bb.lower);
        break;
      case 'supertrend-indicator':
      case 'supertrend-strategy':
        long = prev >= 0 && st.direction[i] < st.direction[prev] && (this.strategyKey !== 'supertrend-strategy' || rsi14[i] > 30);
        short = prev >= 0 && st.direction[i] > st.direction[prev] && (this.strategyKey !== 'supertrend-strategy' || rsi14[i] < 70);
        break;
      case 'ema-crossover-indicator':
        long = crossover(ema9, ema21);
        short = crossunder(ema9, ema21);
        break;
      case 'stochrsi-indicator':
        long = crossover(stoch.k, stoch.d) && stoch.k[i] < 20;
        short = crossunder(stoch.k, stoch.d) && stoch.k[i] > 80;
        break;
      case 'atr-volatility':
        long = prev >= 0 && atrSeries[i] > (atrSma[i] || 0) && closes[i] > highs[prev] && (closes[i] - closes[prev]) >= atrNow * 0.25;
        short = prev >= 0 && atrSeries[i] > (atrSma[i] || 0) && closes[i] < lows[prev] && (closes[prev] - closes[i]) >= atrNow * 0.25;
        break;
      case 'ichimoku-cloud': {
        const cloudTop = Math.max(ich.spanA[i] || -Infinity, ich.spanB[i] || -Infinity);
        const cloudBot = Math.min(ich.spanA[i] || Infinity, ich.spanB[i] || Infinity);
        long = crossover(ich.conversion, ich.base) && closes[i] > cloudTop;
        short = crossunder(ich.conversion, ich.base) && closes[i] < cloudBot;
        break;
      }
      case 'vwap-bands':
        long = crossover(closes, vw) && closes[i] > (ema50[i] || closes[i]);
        short = crossunder(closes, vw) && closes[i] < (ema50[i] || closes[i]);
        break;
      case 'williams-r':
        long = crossoverValue(wpr, -80);
        short = crossunderValue(wpr, -20);
        break;
      case 'trendline-breakout':
        long = breakouts.resistance != null && closes[i] > breakouts.resistance + atrNow * 0.2;
        short = breakouts.support != null && closes[i] < breakouts.support - atrNow * 0.2;
        break;
      case 'macd-crossover-strategy':
        long = crossover(macdData.line, macdData.signal) && closes[i] > (ema200[i] || closes[i]);
        short = crossunder(macdData.line, macdData.signal) && closes[i] < (ema200[i] || closes[i]);
        break;
      case 'bollinger-breakout-strategy':
        long = closes[i] > (bb.upper[i] || Infinity) && (rsi14[i] || 0) > 40;
        short = closes[i] < (bb.lower[i] || -Infinity) && (rsi14[i] || 100) < 60;
        break;
      case 'ema-golden-cross':
        long = crossover(ema50, ema200);
        short = crossunder(ema50, ema200);
        break;
      default:
        break;
    }

    return { long: Boolean(long), short: Boolean(short), atr: atrNow, indicators };
  }

  _openPos (type, entry, atrValue, time) {
    const def = strategyDefinition(this.strategyKey);
    const slDistance = Math.max(atrValue * def.slMult, entry * 0.001);
    const marginUsed = Math.max(0, this.capital);
    const qty = Math.max(0.000001, (marginUsed * this.leverage) / entry);
    const sl = type === 'long' ? entry - slDistance : entry + slDistance;
    const tp = type === 'long' ? entry + atrValue * def.tpMult : entry - atrValue * def.tpMult;
    const entryFeePct = type === 'long' ? this.buyFeePct : this.sellFeePct;
    const entryFee = entry * qty * entryFeePct;
    const liquidationPrice = type === 'short'
      ? entry * (1 + 1 / this.leverage)
      : entry * Math.max(0, 1 - 1 / this.leverage);
    const trailMult = def.trailMult;
    const trailSl = type === 'long' ? entry - atrValue * trailMult : entry + atrValue * trailMult;
    this.position = {
      type, entry, sl, tp, trailSl, trailMult, qty, lotSize: qty, marginUsed,
      leverage: this.leverage, liquidationPrice, entryFee, entryTime: time,
      timeframe: this.timeframe, strategyKey: this.strategyKey, symbol: this.symbol,
      marketPage: this.marketPage,
    };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, leverage, entryTime, sl, tp, trailSl, entryFee } = this.position;
    const exitFeePct = type === 'long' ? this.sellFeePct : this.buyFeePct;
    const exitFee = exitPrice * qty * exitFeePct;
    const gross = type === 'long' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
    const pnl = gross - (entryFee || 0) - exitFee;
    const capitalBefore = this.capital;
    this.capital = Math.max(0, this.capital + pnl);
    if (this.equityHistory.length) this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1,
      type,
      entry,
      exit: exitPrice,
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
  return MARKET_SUITE_DEFINITIONS.find(item => item.key === key) || MARKET_SUITE_DEFINITIONS[0];
}

function strategyName (key) { return strategyDefinition(key).name; }
function strategySource (key) { return strategyDefinition(key).source; }

function defaultSymbolForMarket (marketPage) {
  if (marketPage === 'gold') return 'XAUUSD=X';
  if (marketPage === 'forex') return 'EURUSD=X';
  return 'BTCUSDT';
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

function williamsR (highs, lows, closes, period) {
  return closes.map((close, i) => {
    if (i + 1 < period) return null;
    const upper = Math.max(...highs.slice(i + 1 - period, i + 1));
    const lower = Math.min(...lows.slice(i + 1 - period, i + 1));
    const range = upper - lower;
    if (!range) return 0;
    return 100 * (close - upper) / range;
  });
}

function ichimoku (candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const conversion = midRange(highs, lows, 9);
  const base = midRange(highs, lows, 26);
  const spanA = conversion.map((v, i) => (v == null || base[i] == null) ? null : (v + base[i]) / 2);
  const spanB = midRange(highs, lows, 52);
  return { conversion, base, spanA, spanB };
}

function midRange (highs, lows, period) {
  return highs.map((_, i) => {
    if (i + 1 < period) return null;
    const hi = Math.max(...highs.slice(i + 1 - period, i + 1));
    const lo = Math.min(...lows.slice(i + 1 - period, i + 1));
    return (hi + lo) / 2;
  });
}

function breakoutLevels (highs, lows, atrNow) {
  if (highs.length < 25 || lows.length < 25) return { resistance: null, support: null };
  const end = highs.length - 1;
  const resistance = Math.max(...highs.slice(Math.max(0, end - 20), end));
  const support = Math.min(...lows.slice(Math.max(0, end - 20), end));
  const guard = Math.max(atrNow * 0.1, 0);
  return { resistance: Number.isFinite(resistance) ? resistance + guard : null, support: Number.isFinite(support) ? support - guard : null };
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

module.exports = {
  MarketSuiteStrategy,
  MARKET_SUITE_DEFINITIONS,
  TIMEFRAME_MS,
  defaultSymbolForMarket,
};
