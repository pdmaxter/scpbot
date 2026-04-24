'use strict';
const EventEmitter = require('events');

class PineScriptStrategy extends EventEmitter {
  constructor (cfg = {}) {
    super();
    this.strategyType = 'pine';
    this.initialCapital = cfg.capital || 10000;
    this.capital = this.initialCapital;
    this.riskPerTrade = (cfg.riskPerTradePct || 2) / 100;
    this.lotSize = Math.max(1, Math.round(Number(cfg.lotSize ?? 1) || 1));
    this.positionSizePct = Number(cfg.positionSizePct ?? 100) / 100;
    this.minProfitBookingPct = Number(cfg.minProfitBookingPct ?? 0.5) / 100;
    this.profitRatioBooking = Number(cfg.profitRatioBooking ?? 1.67);
    this.dailyProfitTarget = (cfg.dailyProfitPct || 20) / 100;
    this.dailyProfitHardCap = (cfg.dailyHardCapPct || 30) / 100;
    this.maxDailyLoss = (cfg.maxDailyLossPct || 10) / 100;
    this.atrPeriod = 14;
    this.atrSlMult = 1.5;
    this.atrTpMult = 2.5;
    this.trailMult = 0.6;
    this.code = cfg.code || '';
    this.scriptName = cfg.name || 'Uploaded Pine';
    this.compiled = compilePine(this.code);
    this.minBars = Math.max(60, this.compiled.minBars);
    this.resetState();
  }

  setScript ({ name, code }) {
    this.scriptName = name || 'Uploaded Pine';
    this.code = code || '';
    this.compiled = compilePine(this.code);
    this.minBars = Math.max(60, this.compiled.minBars);
    this.resetState();
  }

  scriptMeta () {
    return {
      name: this.scriptName,
      hasScript: Boolean(this.code.trim()),
      longCondition: this.compiled.longExpr || '',
      shortCondition: this.compiled.shortExpr || '',
      variables: Object.keys(this.compiled.vars),
      warnings: this.compiled.warnings,
    };
  }

  processCandle (candle) {
    const { openTime, open, high, low, close } = candle;
    const dateStr = this._utcDate(openTime);

    if (dateStr !== this.currentDate) {
      if (this.currentDate) {
        const pnl = this.capital - this.dailyStartCap;
        const rec = { pnl, pnlPct: pnl / this.dailyStartCap * 100,
          startCapital: this.dailyStartCap, endCapital: this.capital };
        this.dailyPnl[this.currentDate] = rec;
        this.emit('day_summary', { date: this.currentDate, ...rec });
      }
      this.currentDate = dateStr;
      this.dailyStartCap = this.capital;
      this.dayTradeStopped = false;
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

    const ctx = buildContext(this.candles, this.compiled);
    const atr = ctx.atr14 ?? Math.max(high - low, Math.abs(close - open));
    this.lastSignals = {
      long: evalCondition(this.compiled.longExpr, ctx, this.compiled),
      short: evalCondition(this.compiled.shortExpr, ctx, this.compiled),
    };
    this.lastAtr = atr;

    this.indicatorSnaps.push({
      time: openTime,
      atr,
      longSignal: this.lastSignals.long ? 1 : 0,
      shortSignal: this.lastSignals.short ? 1 : 0,
    });
    if (this.indicatorSnaps.length > 1000) this.indicatorSnaps.shift();
    this.equityHistory.push({ time: openTime, equity: this.capital });
    if (this.equityHistory.length > 5000) this.equityHistory.shift();

    const dayPct = (this.capital - this.dailyStartCap) / this.dailyStartCap;
    if (dayPct >= this.dailyProfitHardCap) {
      this.dayTradeStopped = true;
      if (this.position) this._closePos(close, openTime, 'daily_hard_cap');
      return this._state();
    }

    let adjLoss = this.maxDailyLoss;
    if (dayPct > 0.10) adjLoss = Math.max(0.03, dayPct - (dayPct - 0.10) * 0.5);
    else if (dayPct > 0) adjLoss = Math.max(0.03, this.maxDailyLoss - dayPct * 0.3);
    if (dayPct <= -adjLoss) {
      this.dayTradeStopped = true;
      if (this.position) this._closePos(close, openTime, 'daily_loss');
      return this._state();
    }
    if (this.dayTradeStopped) return this._state();

    const inProfit = dayPct >= this.dailyProfitTarget;
    const trailMult = inProfit ? this.trailMult * 0.4 : this.trailMult;
    const effRisk = inProfit ? this.riskPerTrade * 0.5 : this.riskPerTrade;

    if (this.position) {
      const p = this.position;
      if ((p.type === 'long' && this.lastSignals.short) || (p.type === 'short' && this.lastSignals.long)) {
        return this._closePos(close, openTime, 'signal_flip'), this._state();
      }
      if (p.type === 'long') {
        if (low <= p.trailSl) return this._closePos(Math.max(p.trailSl, open), openTime, 'stop_loss'), this._state();
        if (high >= p.tp) return this._closePos(p.tp, openTime, 'take_profit'), this._state();
        const nt = close - atr * trailMult;
        if (nt > p.trailSl) p.trailSl = nt;
      } else {
        if (high >= p.trailSl) return this._closePos(Math.min(p.trailSl, open), openTime, 'stop_loss'), this._state();
        if (low <= p.tp) return this._closePos(p.tp, openTime, 'take_profit'), this._state();
        const nt = close + atr * trailMult;
        if (nt < p.trailSl) p.trailSl = nt;
      }
      return this._state();
    }

    if (!this.code.trim()) return this._state();
    if (this.lastSignals.long) {
      const sl = close - atr * this.atrSlMult;
      const rpu = close - sl;
      const tp = Math.max(close + rpu * this.profitRatioBooking, close * (1 + this.minProfitBookingPct));
      if (rpu > 0) this._openPos('long', close, sl, tp, this._positionQty(close, rpu, effRisk), openTime);
    } else if (this.lastSignals.short) {
      const sl = close + atr * this.atrSlMult;
      const rpu = sl - close;
      const tp = Math.min(close - rpu * this.profitRatioBooking, close * (1 - this.minProfitBookingPct));
      if (rpu > 0) this._openPos('short', close, sl, tp, this._positionQty(close, rpu, effRisk), openTime);
    }
    return this._state();
  }

  getFullState () {
    return {
      ...this._state(),
      equityHistory: this.equityHistory.slice(-500),
      indicatorSnaps: this.indicatorSnaps.slice(-300),
    };
  }

  restoreFromHistory (candles) {
    if (!candles || candles.length < this.minBars) return false;
    this.candles = candles.slice(-1000);
    this.currentDate = this._utcDate(candles[candles.length - 1].openTime);
    this.warmedUp = true;
    return true;
  }

  setDailyContext (date, dailyStartCapital) {
    this.currentDate = date;
    this.dailyStartCap = dailyStartCapital;
  }

  reset (cfg = {}) {
    this.capital = cfg.capital || this.initialCapital;
    this.initialCapital = this.capital;
    if (cfg.riskPerTradePct) this.riskPerTrade = cfg.riskPerTradePct / 100;
    if (cfg.lotSize !== undefined) this.lotSize = Math.max(1, Math.round(Number(cfg.lotSize) || 1));
    if (cfg.positionSizePct !== undefined) this.positionSizePct = Math.max(0, Number(cfg.positionSizePct) || 0) / 100;
    if (cfg.minProfitBookingPct !== undefined) this.minProfitBookingPct = Math.max(0, Number(cfg.minProfitBookingPct) || 0) / 100;
    if (cfg.profitRatioBooking !== undefined) this.profitRatioBooking = Math.max(0.1, Number(cfg.profitRatioBooking) || 1.67);
    this.resetState();
  }

  resetState () {
    this.candles = [];
    this.position = null;
    this.trades = [];
    this.equityHistory = [{ time: Date.now(), equity: this.capital }];
    this.dailyPnl = {};
    this.dailyStartCap = this.capital;
    this.currentDate = null;
    this.dayTradeStopped = false;
    this.indicatorSnaps = [];
    this.warmedUp = false;
    this.lastSignals = { long: false, short: false };
    this.lastAtr = null;
  }

  _utcDate (tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

  _marginUsed () {
    const pct = this.positionSizePct > 0 ? this.positionSizePct : 1;
    return Math.max(0, this.capital * pct);
  }

  _positionQty (entry, _riskPerUnit, _effRisk) {
    const marginUsed = this._marginUsed();
    return Math.max(0.000001, marginUsed / entry);
  }

  _openPos (type, entry, sl, tp, qty, time) {
    const marginUsed = this._marginUsed();
    this.position = { type, entry, sl, tp, trailSl: sl, qty, lotSize: qty, marginUsed, entryTime: time };
    this.emit('position_opened', { ...this.position });
  }

  _closePos (exitPrice, exitTime, reason) {
    if (!this.position) return;
    const { type, entry, qty, lotSize, marginUsed, entryTime, sl, tp } = this.position;
    const pnl = type === 'long' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
    const capitalBefore = this.capital;
    this.capital += pnl;
    if (this.equityHistory.length > 0) this.equityHistory[this.equityHistory.length - 1].equity = this.capital;
    const trade = {
      id: this.trades.length + 1, type, entry, exit: exitPrice, qty, lotSize, marginUsed,
      pnl, pnlPct: pnl / capitalBefore * 100,
      entryTime, exitTime, reason, sl, tp,
    };
    this.trades.push(trade);
    this.position = null;
    this.emit('trade_closed', trade);
  }

  _state () {
    const wins = this.trades.filter(t => t.pnl > 0);
    const loses = this.trades.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = loses.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = this.capital - this.initialCapital;
    const dayPnl = this.capital - this.dailyStartCap;
    return {
      capital: this.capital,
      initialCapital: this.initialCapital,
      totalPnl,
      totalReturn: totalPnl / this.initialCapital * 100,
      dayPnl,
      dayPnlPct: dayPnl / this.dailyStartCap * 100,
      position: this.position,
      indicators: {
        atr: this.lastAtr,
        longSignal: this.lastSignals.long,
        shortSignal: this.lastSignals.short,
        scriptName: this.scriptName,
        hasScript: Boolean(this.code.trim()),
      },
      settings: {
        lotSize: this.lotSize,
        positionSizePct: this.positionSizePct * 100,
        minProfitBookingPct: this.minProfitBookingPct * 100,
        profitRatioBooking: this.profitRatioBooking,
      },
      totalTrades: this.trades.length,
      winCount: wins.length,
      lossCount: loses.length,
      winRate: this.trades.length ? wins.length / this.trades.length * 100 : 0,
      profitFactor: gl !== 0 ? Math.abs(gw / gl) : (gw > 0 ? Infinity : 0),
      avgWin: wins.length ? gw / wins.length : 0,
      avgLoss: loses.length ? gl / loses.length : 0,
      recentTrades: this.trades.slice(-50).reverse(),
      dailyPnl: this.dailyPnl,
      dayTradeStopped: this.dayTradeStopped,
      warmedUp: this.warmedUp,
      currentDate: this.currentDate,
      scriptMeta: this.scriptMeta(),
    };
  }
}

function compilePine (code = '') {
  const src = stripComments(code);
  const lines = src.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const vars = {};
  const warnings = [];
  let longExpr = '';
  let shortExpr = '';

  for (const line of lines) {
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (m && !/^(if|for|while|switch)\b/.test(line)) vars[m[1]] = cleanupExpr(m[2]);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entry = line.match(/strategy\.entry\s*\((.+)\)/);
    if (entry) {
      const args = entry[1];
      const cond = extractWhen(args) || extractIfCondition(lines, i);
      if (/strategy\.long/.test(args)) longExpr = cleanupExpr(cond || longExpr);
      if (/strategy\.short/.test(args)) shortExpr = cleanupExpr(cond || shortExpr);
    }
    const signal = line.match(/(?:alertcondition|plotshape)\s*\((.+)\)/);
    if (signal) {
      const args = signal[1];
      const cond = splitArgs(args)[0];
      if (!longExpr && /\b(long|buy|bull)\b/i.test(args)) longExpr = cleanupExpr(cond);
      if (!shortExpr && /\b(short|sell|bear)\b/i.test(args)) shortExpr = cleanupExpr(cond);
    }
  }

  if (!longExpr) longExpr = findNamedVar(vars, /\b(long|buy|bull)/i);
  if (!shortExpr) shortExpr = findNamedVar(vars, /\b(short|sell|bear)/i);
  if (!longExpr) longExpr = findFirst(/ta\.crossover\s*\([^)]+\)/, src);
  if (!shortExpr) shortExpr = findFirst(/ta\.crossunder\s*\([^)]+\)/, src);
  if (!longExpr) warnings.push('No long entry condition found. Add strategy.entry(... strategy.long, when=condition).');
  if (!shortExpr) warnings.push('No short entry condition found. Add strategy.entry(... strategy.short, when=condition).');

  const maxLen = Math.max(60, ...Object.values(vars).map(indicatorLength), indicatorLength(longExpr), indicatorLength(shortExpr));
  return { vars, longExpr, shortExpr, warnings, minBars: maxLen + 10 };
}

function stripComments (code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

function cleanupExpr (expr = '') {
  return expr.replace(/\bmath\./g, '').replace(/\bta\./g, 'ta.').trim();
}

function extractWhen (args) {
  const m = args.match(/\bwhen\s*=\s*([^,\)]+)/);
  return m ? m[1].trim() : '';
}

function extractIfCondition (lines, idx) {
  for (let i = idx - 1; i >= Math.max(0, idx - 3); i--) {
    const m = lines[i].match(/^if\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return '';
}

function findFirst (regex, src) {
  const m = src.match(regex);
  return m ? m[0] : '';
}

function findNamedVar (vars, regex) {
  const key = Object.keys(vars).find(k => regex.test(k));
  return key || '';
}

function indicatorLength (expr = '') {
  const nums = [...String(expr).matchAll(/ta\.(?:ema|sma|rsi|atr)\s*\([^,)]*,?\s*(\d+)/g)].map(m => +m[1]);
  return nums.length ? Math.max(...nums) : 0;
}

function buildContext (candles, compiled) {
  const idx = candles.length - 1;
  const series = {
    open: candles.map(c => c.open),
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    volume: candles.map(c => c.volume),
  };
  const cache = {};
  const ctx = { idx, series, cache, vars: {}, atr14: atr(series.high, series.low, series.close, 14)[idx] };
  for (const [name, expr] of Object.entries(compiled.vars)) {
    ctx.vars[name] = evalValue(expr, ctx, compiled);
  }
  return ctx;
}

function evalCondition (expr, ctx, compiled, depth = 0) {
  expr = unwrap(cleanupExpr(expr || ''));
  if (!expr || depth > 8) return false;
  const varExpr = compiled.vars[expr];
  if (varExpr) return evalCondition(varExpr, ctx, compiled, depth + 1);

  const orParts = splitTop(expr, 'or');
  if (orParts.length > 1) return orParts.some(p => evalCondition(p, ctx, compiled, depth + 1));
  const andParts = splitTop(expr, 'and');
  if (andParts.length > 1) return andParts.every(p => evalCondition(p, ctx, compiled, depth + 1));

  const cross = expr.match(/^ta\.cross(over|under)\s*\((.+),(.+)\)$/);
  if (cross) {
    const a = evalValue(cross[2], ctx, compiled, 0);
    const b = evalValue(cross[3], ctx, compiled, 0);
    const ap = evalValue(cross[2], ctx, compiled, 1);
    const bp = evalValue(cross[3], ctx, compiled, 1);
    return cross[1] === 'over' ? a > b && ap <= bp : a < b && ap >= bp;
  }

  const cmp = expr.match(/^(.+?)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
  if (cmp) {
    const a = evalValue(cmp[1], ctx, compiled);
    const b = evalValue(cmp[3], ctx, compiled);
    switch (cmp[2]) {
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      case '==': return a === b;
      case '!=': return a !== b;
      default: return false;
    }
  }

  if (/^not\s+/.test(expr)) return !evalCondition(expr.replace(/^not\s+/, ''), ctx, compiled, depth + 1);
  const v = evalValue(expr, ctx, compiled);
  return Boolean(v);
}

function evalValue (expr, ctx, compiled, offset = 0) {
  expr = unwrap(cleanupExpr(String(expr || '').trim()));
  const idx = Math.max(0, ctx.idx - offset);
  if (/^-?\d+(\.\d+)?$/.test(expr)) return +expr;
  if (compiled.vars[expr]) return evalValue(compiled.vars[expr], ctx, compiled, offset);
  if (ctx.series[expr]) return ctx.series[expr][idx];
  if (Object.prototype.hasOwnProperty.call(ctx.vars, expr)) return valueAt(ctx.vars[expr], ctx, offset);

  const ind = expr.match(/^ta\.(ema|sma|rsi|atr)\s*\((.*)\)$/);
  if (ind) {
    const args = splitArgs(ind[2]);
    const len = +(args[ind[1] === 'atr' ? 0 : 1] || 14);
    const key = `${ind[1]}:${args[0] || 'hlc'}:${len}`;
    if (!ctx.cache[key]) {
      if (ind[1] === 'ema') ctx.cache[key] = ema(resolveSeries(args[0], ctx), len);
      if (ind[1] === 'sma') ctx.cache[key] = sma(resolveSeries(args[0], ctx), len);
      if (ind[1] === 'rsi') ctx.cache[key] = rsi(resolveSeries(args[0], ctx), len);
      if (ind[1] === 'atr') ctx.cache[key] = atr(ctx.series.high, ctx.series.low, ctx.series.close, len);
    }
    return ctx.cache[key][idx];
  }

  const arith = expr.match(/^(.+?)\s*([+\-*/])\s*(.+)$/);
  if (arith) {
    const a = evalValue(arith[1], ctx, compiled, offset);
    const b = evalValue(arith[3], ctx, compiled, offset);
    if (arith[2] === '+') return a + b;
    if (arith[2] === '-') return a - b;
    if (arith[2] === '*') return a * b;
    if (arith[2] === '/') return b ? a / b : 0;
  }
  return 0;
}

function valueAt (value, ctx, offset) {
  if (Array.isArray(value)) return value[Math.max(0, ctx.idx - offset)];
  return value;
}

function resolveSeries (name, ctx) {
  name = unwrap(name || 'close');
  if (ctx.series[name]) return ctx.series[name];
  if (Array.isArray(ctx.vars[name])) return ctx.vars[name];
  return ctx.series.close;
}

function splitArgs (s) {
  return splitTopLevel(s, ',').map(x => x.trim());
}

function splitTop (s, word) {
  const parts = splitTopLevel(s, ` ${word} `);
  return parts.length > 1 ? parts : [s];
}

function splitTopLevel (s, sep) {
  const out = [];
  let level = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') level++;
    else if (s[i] === ')') level--;
    else if (level === 0 && s.slice(i, i + sep.length) === sep) {
      out.push(s.slice(start, i));
      start = i + sep.length;
    }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(Boolean);
}

function unwrap (s) {
  s = s.trim();
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
  return s;
}

function ema (arr, len) {
  const out = new Array(arr.length).fill(null);
  if (arr.length < len) return out;
  let v = arr.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = v;
  const k = 2 / (len + 1);
  for (let i = len; i < arr.length; i++) {
    v = arr[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function sma (arr, len) {
  return arr.map((_, i) => i + 1 < len ? null : arr.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0) / len);
}

function rsi (arr, len) {
  const out = new Array(arr.length).fill(null);
  if (arr.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const ch = arr[i] - arr[i - 1];
    gain += Math.max(0, ch);
    loss += Math.max(0, -ch);
  }
  let avgGain = gain / len, avgLoss = loss / len;
  out[len] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = len + 1; i < arr.length; i++) {
    const ch = arr[i] - arr[i - 1];
    avgGain = (avgGain * (len - 1) + Math.max(0, ch)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(0, -ch)) / len;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr (high, low, close, len) {
  const tr = high.map((h, i) => i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  return ema(tr, len);
}

module.exports = { PineScriptStrategy, compilePine };
