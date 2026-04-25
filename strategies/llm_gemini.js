'use strict';
const https = require('https');
const EventEmitter = require('events');

const LLM_STRATEGY_DEFINITIONS = [
  { key: 'gemini-scalper', name: '1. Gemini Scalper', template: 'scalper' },
  { key: 'gemini-daytrader', name: '2. Gemini Day Trader', template: 'daytrader' },
];

const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_TEXT_PRICING = [
  { prefix: 'gemini-2.5-pro', inputPrice: 1.25, inputPriceLarge: 2.50, outputPrice: 10.00, outputPriceLarge: 15.00, thresholdPromptTokens: 200000, label: 'Gemini 2.5 Pro' },
  { prefix: 'gemini-2.5-flash-lite', inputPrice: 0.10, outputPrice: 0.40, label: 'Gemini 2.5 Flash-Lite' },
  { prefix: 'gemini-2.5-flash', inputPrice: 0.30, outputPrice: 2.50, label: 'Gemini 2.5 Flash' },
  { prefix: 'gemini-2.0-flash-lite', inputPrice: 0.075, outputPrice: 0.30, label: 'Gemini 2.0 Flash-Lite' },
  { prefix: 'gemini-2.0-flash', inputPrice: 0.10, outputPrice: 0.40, label: 'Gemini 2.0 Flash' },
];

class GeminiLlmStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'llm';
    this.strategyKey = cfg.strategyKey || 'gemini-scalper';
    this.strategyName = strategyName(this.strategyKey);
    this.template = strategyTemplate(this.strategyKey);
    this.provider = 'google-gemini';
    this.timeframe = normalizeTimeframe(cfg.timeframe);
    this.initialCapital = Number(cfg.capital || 1000);
    this.capital = this.initialCapital;
    this.leverage = Math.max(1, Number(cfg.leverage || 1));
    this.buyFeePct = Math.max(0, Number(cfg.buyFeePct || 0)) / 100;
    this.sellFeePct = Math.max(0, Number(cfg.sellFeePct || 0)) / 100;
    this.model = normalizeModel(cfg.model || DEFAULT_MODEL);
    this.apiKey = String(cfg.apiKey || '').trim();
    this.maxOutputTokens = Math.max(128, Math.round(Number(cfg.maxOutputTokens) || 700));
    this.symbol = String(cfg.symbol || 'BTCUSDT').trim().toUpperCase();
    this.minBars = this.template === 'scalper' ? 60 : 80;
    this.resetState();
  }

  reset (cfg = {}) {
    if (cfg.strategyKey) {
      this.strategyKey = cfg.strategyKey;
      this.strategyName = strategyName(this.strategyKey);
      this.template = strategyTemplate(this.strategyKey);
    }
    if (cfg.timeframe) this.timeframe = normalizeTimeframe(cfg.timeframe);
    if (cfg.capital !== undefined) {
      this.capital = Number(cfg.capital) || this.initialCapital;
      this.initialCapital = this.capital;
    }
    if (cfg.leverage !== undefined) this.leverage = Math.max(1, Number(cfg.leverage) || 1);
    if (cfg.buyFeePct !== undefined) this.buyFeePct = Math.max(0, Number(cfg.buyFeePct) || 0) / 100;
    if (cfg.sellFeePct !== undefined) this.sellFeePct = Math.max(0, Number(cfg.sellFeePct) || 0) / 100;
    if (cfg.model !== undefined) this.model = normalizeModel(cfg.model || DEFAULT_MODEL);
    if (cfg.apiKey !== undefined) this.apiKey = String(cfg.apiKey || '').trim();
    if (cfg.maxOutputTokens !== undefined) this.maxOutputTokens = Math.max(128, Math.round(Number(cfg.maxOutputTokens) || 700));
    this.symbol = String(cfg.symbol || this.symbol || 'BTCUSDT').trim().toUpperCase();
    this.minBars = this.template === 'scalper' ? 60 : 80;
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
    this.lastDecision = null;
    this.lastAnalysisAt = null;
    this.lastError = '';
    this.totalLlmCostUsd = 0;
    this.totalPromptTokens = 0;
    this.totalOutputTokens = 0;
    this.totalThoughtTokens = 0;
    this.totalLlmCalls = 0;
    this.lastLlmUsage = null;
  }

  restoreFromHistory (candles = []) {
    const aggregated = aggregateCandles(candles, this.timeframe);
    if (aggregated.length < this.minBars) return false;
    this.candles = aggregated.slice(-1000);
    this.currentDate = this._utcDate(this.candles[this.candles.length - 1].openTime);
    this.warmedUp = true;
    return true;
  }

  async processCandle (candle) {
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
      provider: this.provider,
      model: this.model,
      timeframe: this.timeframe,
      source: this.template === 'scalper' ? 'Claudescalper.js -> Gemini' : 'Ctrader.js -> Gemini',
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

  async _processStrategyCandle (candle) {
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

    let analysis;
    try {
      analysis = await this._analyseMarket();
      this.lastError = '';
    } catch (error) {
      this.lastError = error.message;
      this.emit('analysis_error', { message: error.message, time: candle.openTime });
      return this._state();
    }

    const { indicators, decision, usage } = analysis;
    if (usage) {
      this.totalLlmCalls += 1;
      this.totalPromptTokens += Number(usage.promptTokens || 0);
      this.totalOutputTokens += Number(usage.outputTokens || 0);
      this.totalThoughtTokens += Number(usage.thoughtsTokens || 0);
      this.totalLlmCostUsd += Number(usage.estimatedCostUsd || 0);
      this.lastLlmUsage = usage;
    }
    this.lastIndicators = indicators;
    this.lastDecision = decision;
    this.lastAnalysisAt = candle.openTime;
    this.lastSignals = {
      long: decision.signal === 'long',
      short: decision.signal === 'short',
    };
    this.indicatorSnaps.push({
      time: candle.openTime,
      close: candle.close,
      signal: decision.signal,
      confidence: decision.confidence,
      entry: decision.entry,
      stopLoss: decision.sl,
      takeProfit: decision.tp,
      rsi: indicators.rsi ?? indicators.rsiVal ?? null,
      atr: indicators.atr ?? indicators.atrV ?? null,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();

    if (this.position) {
      const p = this.position;
      const suggestedSl = normalizedProtectivePrice(p.type, decision.sl, p.entry, 'sl');
      const suggestedTp = normalizedProtectivePrice(p.type, decision.tp, p.entry, 'tp');
      if (p.type === 'long') {
        if (suggestedSl != null) p.trailSl = Math.max(p.trailSl, suggestedSl);
        if (suggestedTp != null) p.tp = Math.max(p.tp, suggestedTp);
        if (p.liquidationPrice && candle.low <= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
        if (candle.low <= p.trailSl) {
          this._closePos(Math.max(p.trailSl, candle.open), candle.openTime, stopExitReason(p));
          return this._state();
        }
        if (candle.high >= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
      } else {
        if (suggestedSl != null) p.trailSl = Math.min(p.trailSl, suggestedSl);
        if (suggestedTp != null) p.tp = Math.min(p.tp, suggestedTp);
        if (p.liquidationPrice && candle.high >= p.liquidationPrice) {
          this._closePos(p.liquidationPrice, candle.openTime, 'liquidation');
          return this._state();
        }
        if (candle.high >= p.trailSl) {
          this._closePos(Math.min(p.trailSl, candle.open), candle.openTime, stopExitReason(p));
          return this._state();
        }
        if (candle.low <= p.tp) {
          this._closePos(p.tp, candle.openTime, 'take_profit');
          return this._state();
        }
      }

      if ((p.type === 'long' && decision.signal === 'short') || (p.type === 'short' && decision.signal === 'long')) {
        const nextType = p.type === 'long' ? 'short' : 'long';
        this._closePos(candle.close, candle.openTime, 'signal_flip');
        this._openPos(nextType, decision, candle, indicators);
        this._pushEquityPoint(candle.openTime);
        return this._state();
      }

      this._pushEquityPoint(candle.openTime);
      return this._state();
    }

    if ((decision.signal === 'long' || decision.signal === 'short') && decision.confidence !== 'LOW') {
      this._openPos(decision.signal, decision, candle, indicators);
    }
    this._pushEquityPoint(candle.openTime);
    return this._state();
  }

  async _analyseMarket () {
    if (!this.apiKey) throw new Error('Gemini API key not configured');
    const candles = this.candles.slice(-Math.max(this.minBars, 120));
    const indicators = this.template === 'scalper'
      ? buildScalperIndicators(candles)
      : buildDayTraderIndicators(candles);
    const result = await geminiGenerateDecision({
      apiKey: this.apiKey,
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      template: this.template,
      symbol: this.symbol,
      timeframe: this.timeframe,
      candles,
      indicators,
    });
    return {
      indicators,
      decision: normalizeDecision(this.template, result, candles[candles.length - 1], indicators),
      usage: result.usage || null,
    };
  }

  _openPos (type, decision, candle, indicators) {
    const entry = finiteOr(decision.entry, candle.close);
    const atrValue = Math.max(finiteOr(indicators.atr, indicators.atrV, Math.abs(candle.high - candle.low), entry * 0.002), entry * 0.001);
    const fallbackDistance = Math.max(atrValue, entry * 0.003);
    let sl = normalizedProtectivePrice(type, finiteOr(decision.sl), entry, 'sl');
    if (sl == null) sl = type === 'long' ? entry - fallbackDistance : entry + fallbackDistance;
    let tp = normalizedProtectivePrice(type, finiteOr(decision.tp, decision.tp2, decision.tp1), entry, 'tp');
    if (tp == null) tp = type === 'long' ? entry + fallbackDistance * 2 : entry - fallbackDistance * 2;
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
      sl,
      tp,
      trailSl: sl,
      qty,
      lotSize: qty,
      marginUsed,
      leverage: this.leverage,
      liquidationPrice,
      entryFee,
      entryTime: candle.openTime,
      timeframe: this.timeframe,
      strategyKey: this.strategyKey,
      decisionReason: decision.reason || '',
      model: this.model,
    };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, leverage, entryTime, sl, tp, entryFee } = this.position;
    const normalizedExit = normalizeTradePrice(exitPrice, entry);
    const exitFeePct = type === 'long' ? this.sellFeePct : this.buyFeePct;
    const exitFee = normalizedExit * qty * exitFeePct;
    const gross = type === 'long' ? (normalizedExit - entry) * qty : (entry - normalizedExit) * qty;
    const pnl = gross - (entryFee || 0) - exitFee;
    const capitalBefore = this.capital;
    this.capital = Math.max(0, this.capital + pnl);
    if (this.equityHistory.length) this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1,
      type,
      entry,
      exit: normalizedExit,
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
      timeframe: this.timeframe,
      strategyKey: this.strategyKey,
      model: this.model,
      fees: (entryFee || 0) + exitFee,
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
      strategyKey: this.strategyKey,
      strategyName: this.strategyName,
      timeframe: this.timeframe,
      capital: this.capital,
      initialCapital: this.initialCapital,
      settings: {
        provider: this.provider,
        model: this.model,
        maxOutputTokens: this.maxOutputTokens,
        leverage: this.leverage,
        buyFeePct: this.buyFeePct * 100,
        sellFeePct: this.sellFeePct * 100,
        hasApiKey: Boolean(this.apiKey),
      },
      totalPnl,
      totalReturn: this.initialCapital ? totalPnl / this.initialCapital * 100 : 0,
      dayPnl,
      dayPnlPct: this.dailyStartCap ? dayPnl / this.dailyStartCap * 100 : 0,
      position: this.position,
      indicators: this.lastIndicators,
      signals: this.lastSignals,
      lastDecision: this.lastDecision,
      lastAnalysisAt: this.lastAnalysisAt,
      lastError: this.lastError,
      llmCost: {
        totalUsd: roundUsd(this.totalLlmCostUsd),
        promptTokens: this.totalPromptTokens,
        outputTokens: this.totalOutputTokens,
        thoughtsTokens: this.totalThoughtTokens,
        totalCalls: this.totalLlmCalls,
        last: this.lastLlmUsage,
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

function strategyName (key) {
  return LLM_STRATEGY_DEFINITIONS.find(s => s.key === key)?.name || key;
}

function strategyTemplate (key) {
  return LLM_STRATEGY_DEFINITIONS.find(s => s.key === key)?.template || 'scalper';
}

function normalizeTimeframe (tf) {
  return TIMEFRAME_MS[tf] ? tf : '5m';
}

function normalizeModel (model) {
  const value = String(model || DEFAULT_MODEL).trim();
  return value.replace(/^models\//, '') || DEFAULT_MODEL;
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

function buildScalperIndicators (candles) {
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume || 0);
  const price = closes[closes.length - 1];
  const e5 = ema(closes.slice(-15), 5);
  const e10 = ema(closes.slice(-20), 10);
  const e20 = ema(closes.slice(-30), 20);
  const rsiVal = rsi(closes.slice(-20), 7);
  const vwapV = vwap(candles.slice(-30));
  const atrV = atr(candles, 10);
  const bb = bollinger(closes, 20, 2);
  const avgVol = average(vols.slice(-20));
  const lastVol = vols[vols.length - 1] || 0;
  const volRat = avgVol ? lastVol / avgVol : 1;
  return {
    price,
    e5,
    e10,
    e20,
    rsiVal,
    vwapV,
    atrV,
    bbUpper: bb.upper[bb.upper.length - 1],
    bbMid: bb.mid[bb.mid.length - 1],
    bbLower: bb.lower[bb.lower.length - 1],
    volumeRatio: round(volRat, 2),
    emaCross: recentEmaCross(closes),
    pattern: candlePattern(candles.slice(-3)),
    recentCloses: closes.slice(-5),
    spreadEstimatePct: price ? round((atrV * 0.1) / price * 100, 4) : 0,
    rsi: rsiVal,
    atr: atrV,
  };
}

function buildDayTraderIndicators (candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 0);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiVal = rsi(closes, 14);
  const atrV = atr(candles, 14);
  const macdData = macd(closes);
  const avgVol = average(volumes.slice(-20));
  const lastVol = volumes[volumes.length - 1] || 0;
  const currentPrice = closes[closes.length - 1];
  return {
    price: currentPrice,
    ema20,
    ema50,
    rsi: rsiVal,
    atr: atrV,
    macdLine: last(macdData.line),
    macdSignal: last(macdData.signal),
    macdHistogram: last(macdData.histogram),
    volumeRatio: avgVol ? round(lastVol / avgVol, 2) : 1,
    recentHigh: Math.max(...closes.slice(-20)),
    recentLow: Math.min(...closes.slice(-20)),
    recentCloses: closes.slice(-5),
    spreadEstimatePct: currentPrice ? round((atrV * 0.08) / currentPrice * 100, 4) : 0,
  };
}

function normalizeDecision (template, payload, lastCandle, indicators) {
  const rawSignal = String(payload?.signal || '').trim().toUpperCase();
  const signal = rawSignal === 'LONG' ? 'long'
    : rawSignal === 'SHORT' ? 'short'
      : 'flat';
  const confidence = String(payload?.confidence || 'LOW').trim().toUpperCase();
  const entry = template === 'daytrader'
    ? finiteOr(payload?.entry_zone?.low, payload?.entry_zone?.high, payload?.entry, lastCandle.close)
    : finiteOr(payload?.entry, lastCandle.close);
  const sl = finiteOr(payload?.sl, payload?.stop_loss, payload?.invalidation);
  const tp1 = finiteOr(payload?.tp1, payload?.take_profit_1);
  const tp2 = finiteOr(payload?.tp2, payload?.take_profit_2);
  return {
    signal,
    confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(confidence) ? confidence : 'LOW',
    entry,
    sl,
    tp1,
    tp2,
    tp: finiteOr(tp2, tp1),
    reason: String(payload?.trigger || payload?.reasoning || '').trim(),
    invalidation: finiteOr(payload?.invalidation, sl),
    raw: payload,
    price: indicators.price || lastCandle.close,
  };
}

function normalizeTradePrice (value, fallback) {
  const price = Number(value);
  if (Number.isFinite(price) && price > 0) return price;
  const safeFallback = Number(fallback);
  return Number.isFinite(safeFallback) && safeFallback > 0 ? safeFallback : 0;
}

function normalizedProtectivePrice (type, value, entry, role) {
  const price = Number(value);
  const ref = Number(entry);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ref) || ref <= 0) return null;
  if (role === 'sl') {
    if (type === 'long') return price < ref ? price : null;
    return price > ref ? price : null;
  }
  if (role === 'tp') {
    if (type === 'long') return price > ref ? price : null;
    return price < ref ? price : null;
  }
  return null;
}

function stopExitReason (position) {
  if (!position) return 'stop_loss';
  const trail = Number(position.trailSl);
  const initial = Number(position.sl);
  if (!Number.isFinite(trail) || !Number.isFinite(initial)) return 'stop_loss';
  if (position.type === 'long' && trail > initial) return 'trail_sl';
  if (position.type === 'short' && trail < initial) return 'trail_sl';
  return 'stop_loss';
}

async function geminiGenerateDecision ({ apiKey, model, maxOutputTokens, template, symbol, timeframe, candles, indicators }) {
  const systemInstruction = template === 'scalper'
    ? `You are an ultra-precise crypto scalping analyst. Use the provided ${timeframe} chart context for fast micro-trade decisions. Reply with JSON only.

SCALPING RULES:
- Favor entries with EMA5/10 alignment, VWAP position, RSI momentum, candle structure, and volume confirmation.
- LONG when trend and momentum align upward.
- SHORT when trend and momentum align downward.
- FLAT when signals conflict or confidence is weak.
- Keep stops tight and realistic for a short-duration trade.

Return exact JSON:
{"signal":"LONG | SHORT | FLAT","confidence":"HIGH | MEDIUM | LOW","entry":number,"sl":number,"tp1":number,"tp2":number,"trigger":"short reason","invalidation":number,"valid_for_candles":number}`
    : `You are an expert crypto day-trading analyst. Use the provided ${timeframe} chart context and respond with JSON only.

ANALYSIS FRAMEWORK:
- Trend from EMA alignment and recent structure
- Momentum from RSI and MACD
- Volume confirmation
- ATR-aware stop placement

Return exact JSON:
{"signal":"LONG | SHORT | NEUTRAL","confidence":"HIGH | MEDIUM | LOW","entry_zone":{"low":number,"high":number},"stop_loss":number,"take_profit_1":number,"take_profit_2":number,"reasoning":"short reason","warnings":["optional"],"invalidation":number}`;

  const prompt = template === 'scalper'
    ? buildScalperPrompt(symbol, timeframe, candles, indicators)
    : buildDayTraderPrompt(symbol, timeframe, candles, indicators);

  const response = await geminiRequest({
    apiKey,
    model,
    body: {
      system_instruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: prompt }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: geminiResponseSchema(template),
      },
    },
  });
  return {
    ...parseGeminiJsonResponse(response),
    usage: parseGeminiUsage(response, model),
  };
}

function buildScalperPrompt (symbol, timeframe, candles, ind) {
  const last = candles[candles.length - 1];
  return `SCALP SCAN — ${symbol}
TIMEFRAME: ${timeframe}
PRICE: ${ind.price}

PRICE ACTION:
- VWAP: ${round(ind.vwapV, 4)} (${pctVs(ind.price, ind.vwapV)} vs VWAP)
- Bollinger: L ${round(ind.bbLower, 2)} | M ${round(ind.bbMid, 2)} | U ${round(ind.bbUpper, 2)}
- Last candle: O ${last.open} H ${last.high} L ${last.low} C ${last.close}
- Pattern: ${ind.pattern}

FAST INDICATORS:
- EMA5 ${round(ind.e5, 4)} | EMA10 ${round(ind.e10, 4)} | EMA20 ${round(ind.e20, 4)}
- RSI7 ${ind.rsiVal}
- ATR10 ${round(ind.atrV, 4)}
- Volume ratio ${ind.volumeRatio}x
- EMA cross ${ind.emaCross}
- Spread estimate ${ind.spreadEstimatePct}%

RECENT CLOSES: ${ind.recentCloses.join(' -> ')}`;
}

function buildDayTraderPrompt (symbol, timeframe, candles, ind) {
  const last = candles[candles.length - 1];
  return `DAY TRADE SCAN — ${symbol}
TIMEFRAME: ${timeframe}
CURRENT PRICE: ${ind.price}

TECHNICALS:
- EMA20 ${round(ind.ema20, 4)} | EMA50 ${round(ind.ema50, 4)}
- RSI14 ${ind.rsi}
- MACD ${round(ind.macdLine, 4)} | Signal ${round(ind.macdSignal, 4)} | Histogram ${round(ind.macdHistogram, 4)}
- ATR14 ${round(ind.atr, 4)} (${pct(ind.atr, ind.price)} of price)
- Volume ratio ${ind.volumeRatio}x
- Recent 20 high ${ind.recentHigh} | Recent 20 low ${ind.recentLow}
- Spread estimate ${ind.spreadEstimatePct}%

LAST CANDLE:
- O ${last.open} H ${last.high} L ${last.low} C ${last.close}
- Volume ${last.volume || 0}

RECENT CLOSES: ${ind.recentCloses.join(', ')}`;
}

function geminiRequest ({ apiKey, model, body }) {
  const normalizedModel = normalizeModel(model);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': apiKey,
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          reject(new Error(`Gemini response parse failed: ${error.message}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed?.error?.message || `Gemini request failed (${res.statusCode})`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchGeminiModels (apiKey) {
  if (!apiKey) throw new Error('Gemini API key is required');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          reject(new Error(`Gemini model list parse failed: ${error.message}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed?.error?.message || `Gemini models request failed (${res.statusCode})`));
          return;
        }
        const rows = Array.isArray(parsed.models) ? parsed.models : [];
        resolve(rows
          .filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
          .map(model => ({
            name: model.name,
            code: String(model.name || '').replace(/^models\//, ''),
            displayName: model.displayName || String(model.name || '').replace(/^models\//, ''),
            description: model.description || '',
            inputTokenLimit: model.inputTokenLimit || null,
            outputTokenLimit: model.outputTokenLimit || null,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseGeminiJsonResponse (response) {
  const text = (response?.candidates || [])
    .flatMap(candidate => candidate?.content?.parts || [])
    .map(part => part?.text || '')
    .join('\n')
    .trim();
  if (!text) throw new Error('Gemini returned no text content');
  const candidates = jsonCandidateTexts(text);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
    try {
      return JSON.parse(repairJsonText(candidate));
    } catch (error) {
      lastError = error;
    }
    try {
      const partial = parsePartialGeminiDecision(candidate);
      if (partial) return partial;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Gemini JSON parse failed');
}

function jsonCandidateTexts (text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json|```/gi, '')
    .trim();
  const items = [cleaned];
  const firstObject = cleaned.indexOf('{');
  const lastObject = cleaned.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) items.push(cleaned.slice(firstObject, lastObject + 1).trim());
  const firstArray = cleaned.indexOf('[');
  const lastArray = cleaned.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) items.push(cleaned.slice(firstArray, lastArray + 1).trim());
  return [...new Set(items.filter(Boolean))];
}

function repairJsonText (text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json|```/gi, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, '\'')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function parsePartialGeminiDecision (text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json|```/gi, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, '\'')
    .trim();
  if (!cleaned) return null;

  const signal = matchStringField(cleaned, 'signal');
  const confidence = matchStringField(cleaned, 'confidence');
  const trigger = matchStringField(cleaned, 'trigger');
  const reasoning = matchStringField(cleaned, 'reasoning');
  const entry = matchNumberField(cleaned, 'entry');
  const sl = matchNumberField(cleaned, 'sl');
  const tp1 = matchNumberField(cleaned, 'tp1') ?? matchNumberField(cleaned, 'take_profit_1');
  const tp2 = matchNumberField(cleaned, 'tp2') ?? matchNumberField(cleaned, 'take_profit_2');
  const invalidation = matchNumberField(cleaned, 'invalidation') ?? matchNumberField(cleaned, 'stop_loss') ?? sl;
  const stopLoss = matchNumberField(cleaned, 'stop_loss');
  const entryZoneLow = matchNumberField(cleaned, 'low');
  const entryZoneHigh = matchNumberField(cleaned, 'high');

  if (!signal && !confidence && entry == null && stopLoss == null && tp1 == null && tp2 == null) return null;

  const out = {};
  if (signal) out.signal = signal;
  if (confidence) out.confidence = confidence;
  if (entry != null) out.entry = entry;
  if (sl != null) out.sl = sl;
  if (tp1 != null) out.tp1 = tp1;
  if (tp2 != null) out.tp2 = tp2;
  if (trigger) out.trigger = trigger;
  if (reasoning) out.reasoning = reasoning;
  if (invalidation != null) out.invalidation = invalidation;
  if (stopLoss != null) out.stop_loss = stopLoss;
  if (entryZoneLow != null || entryZoneHigh != null) {
    out.entry_zone = {};
    if (entryZoneLow != null) out.entry_zone.low = entryZoneLow;
    if (entryZoneHigh != null) out.entry_zone.high = entryZoneHigh;
  }
  return out;
}

function matchStringField (text, key) {
  const pattern = new RegExp(`["']?${escapeRegex(key)}["']?\\s*:\\s*["']([^"',}\\n\\r]*)`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function matchNumberField (text, key) {
  const pattern = new RegExp(`["']?${escapeRegex(key)}["']?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
  const match = String(text || '').match(pattern);
  return match ? Number(match[1]) : null;
}

function escapeRegex (text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function geminiResponseSchema (template) {
  return template === 'scalper'
    ? {
        type: 'object',
        properties: {
          signal: { type: 'string' },
          confidence: { type: 'string' },
          entry: { type: 'number' },
          sl: { type: 'number' },
          tp1: { type: 'number' },
          tp2: { type: 'number' },
          trigger: { type: 'string' },
          invalidation: { type: 'number' },
          valid_for_candles: { type: 'integer' },
        },
        required: ['signal', 'confidence'],
      }
    : {
        type: 'object',
        properties: {
          signal: { type: 'string' },
          confidence: { type: 'string' },
          entry_zone: {
            type: 'object',
            properties: {
              low: { type: 'number' },
              high: { type: 'number' },
            },
          },
          stop_loss: { type: 'number' },
          take_profit_1: { type: 'number' },
          take_profit_2: { type: 'number' },
          reasoning: { type: 'string' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
          invalidation: { type: 'number' },
        },
        required: ['signal', 'confidence'],
      };
}

function parseGeminiUsage (response, model) {
  const meta = response?.usageMetadata;
  if (!meta || typeof meta !== 'object') return null;
  const promptTokens = Math.max(0, Number(meta.promptTokenCount) || 0);
  const candidatesTokens = Math.max(0, Number(meta.candidatesTokenCount) || 0);
  const thoughtsTokens = Math.max(0, Number(meta.thoughtsTokenCount) || 0);
  const outputTokens = candidatesTokens + thoughtsTokens;
  const totalTokens = Math.max(0, Number(meta.totalTokenCount) || (promptTokens + candidatesTokens));
  const pricing = geminiPricingForModel(model, promptTokens);
  const estimatedCostUsd = pricing
    ? roundUsd(((promptTokens * pricing.inputPricePer1M) + (outputTokens * pricing.outputPricePer1M)) / 1000000)
    : null;
  return {
    promptTokens,
    candidatesTokens,
    thoughtsTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd,
    pricing,
  };
}

function geminiPricingForModel (model, promptTokens = 0) {
  const normalized = normalizeModel(model);
  const row = GEMINI_TEXT_PRICING.find(item => normalized === item.prefix || normalized.startsWith(`${item.prefix}-`));
  if (!row) return null;
  const usesLargePromptTier = Number(promptTokens) > Number(row.thresholdPromptTokens || Infinity);
  return {
    model: normalized,
    modelLabel: row.label,
    inputPricePer1M: usesLargePromptTier ? Number(row.inputPriceLarge || row.inputPrice) : Number(row.inputPrice),
    outputPricePer1M: usesLargePromptTier ? Number(row.outputPriceLarge || row.outputPrice) : Number(row.outputPrice),
    thresholdPromptTokens: Number(row.thresholdPromptTokens || 0),
    usesLargePromptTier,
  };
}

function roundUsd (value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(8)) : 0;
}

function average (values = []) {
  const list = values.filter(v => Number.isFinite(Number(v))).map(Number);
  return list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : 0;
}

function finiteOr (...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round (value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function pct (numerator, denominator) {
  const a = Number(numerator);
  const b = Number(denominator);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? `${((a / b) * 100).toFixed(2)}%` : '--';
}

function pctVs (price, ref) {
  const p = Number(price);
  const r = Number(ref);
  if (!Number.isFinite(p) || !Number.isFinite(r) || r === 0) return '--';
  const delta = ((p / r) - 1) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}%`;
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
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function rsi (values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const prev = values[i - 1];
    const current = values[i];
    const diff = current - prev;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function macd (values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const line = values.map((_, i) => fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null);
  const clean = line.map(v => v ?? 0);
  const signalRaw = emaSeries(clean, 9);
  const signal = signalRaw.map((v, i) => line[i] == null ? null : v);
  const histogram = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
  return { line, signal, histogram };
}

function emaSeries (values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    if (prev === null) prev = values.slice(i + 1 - period, i + 1).reduce((sum, v) => sum + v, 0) / period;
    else prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
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

function atr (candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const recent = tr.slice(-period);
  return recent.length ? recent.reduce((sum, v) => sum + v, 0) / recent.length : 0;
}

function vwap (candles) {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const candleVol = c.volume || 1;
    pv += typical * candleVol;
    vol += candleVol;
  }
  return vol ? pv / vol : candles[candles.length - 1]?.close || 0;
}

function recentEmaCross (closes) {
  if (closes.length < 8) return 'none';
  for (let i = closes.length - 3; i < closes.length; i++) {
    const series = closes.slice(0, i + 1);
    const prevSeries = closes.slice(0, i);
    if (prevSeries.length < 10) continue;
    const prevE5 = ema(prevSeries.slice(-15), 5);
    const prevE10 = ema(prevSeries.slice(-20), 10);
    const curE5 = ema(series.slice(-15), 5);
    const curE10 = ema(series.slice(-20), 10);
    if (prevE5 <= prevE10 && curE5 > curE10) return 'bullish';
    if (prevE5 >= prevE10 && curE5 < curE10) return 'bearish';
  }
  return 'none';
}

function candlePattern (candles) {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return 'unknown';
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const range = Math.max(0.000001, lastCandle.high - lastCandle.low);
  if (body / range > 0.7) return lastCandle.close > lastCandle.open ? 'bullish_engulf' : 'bearish_engulf';
  if (body / range < 0.3) return lastCandle.close > lastCandle.open ? 'hammer' : 'shooting_star';
  return 'doji';
}

module.exports = {
  GeminiLlmStrategy,
  LLM_STRATEGY_DEFINITIONS,
  TIMEFRAME_MS,
  DEFAULT_MODEL,
  fetchGeminiModels,
};
