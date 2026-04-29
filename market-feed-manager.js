'use strict';
const https = require('https');

const BASE_INTERVAL_MS = 5 * 60 * 1000;

class MarketFeedManager {
  constructor (io, cfg = {}) {
    this.io = io;
    this.namespace = cfg.namespace || 'market';
    this.label = cfg.label || this.namespace.toUpperCase();
    this.provider = cfg.provider || 'binance';
    this.symbol = cfg.symbol || 'BTCUSDT';
    this.range = cfg.range || '5d';
    this.pollMs = Math.max(5000, Number(cfg.pollMs || 15000));
    this.runners = {};
    this.timer = null;
    this.latestCandles = [];
    this.currentTicker = null;
    this.feedUp = false;
    this.lastError = '';
  }

  addRunner (runner) { this.runners[runner.id] = runner; }
  removeRunner (id) { delete this.runners[id]; }
  getRunner (id) { return this.runners[id]; }

  setSymbol (symbol) {
    const next = String(symbol || '').trim() || this.symbol;
    if (next === this.symbol) return;
    this.symbol = next;
    this.latestCandles = [];
    this.currentTicker = null;
    this.lastError = '';
    this.emitState();
    if (this.anyRunning()) this.ensureRunning();
  }

  anyRunning () {
    return Object.values(this.runners).some(runner => runner.running);
  }

  async fetchHistory () {
    const snapshot = await this.fetchSnapshot();
    this.latestCandles = snapshot.candles.slice(-1500);
    this.currentTicker = snapshot.ticker;
    this.feedUp = true;
    this.emitState();
    return this.latestCandles.slice();
  }

  async pollNow () {
    try {
      const snapshot = await this.fetchSnapshot();
      this.feedUp = true;
      this.lastError = '';
      if (snapshot.ticker) this.currentTicker = snapshot.ticker;
      const previousTimes = new Set(this.latestCandles.map(c => c.openTime));
      const merged = dedupeCandles([...this.latestCandles, ...snapshot.candles]).slice(-1500);
      const newClosed = merged.filter(c => !previousTimes.has(c.openTime));
      this.latestCandles = merged;
      for (const candle of newClosed) {
        for (const runner of Object.values(this.runners)) {
          await runner.processCandle(candle);
        }
      }
      this.emitState();
    } catch (error) {
      this.feedUp = false;
      this.lastError = error.message;
      this.emitState();
      console.error(`[${this.namespace}] feed poll failed:`, error.message);
    }
  }

  ensureRunning () {
    if (!this.anyRunning()) return;
    if (!this.timer) {
      this.pollNow().catch(() => {});
      this.timer = setInterval(() => this.pollNow().catch(() => {}), this.pollMs);
    }
  }

  maybeStop () {
    if (this.anyRunning()) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.feedUp = false;
    this.emitState();
  }

  async sendInitialState (socket) {
    socket.emit(`${this.namespace}:ws_status`, { feed: this.feedUp, error: this.lastError || null });
    socket.emit(`${this.namespace}:candles`, this.latestCandles);
    if (this.currentTicker) socket.emit(`${this.namespace}:ticker`, this.currentTicker);
  }

  emitState () {
    this.io.emit(`${this.namespace}:ws_status`, { feed: this.feedUp, error: this.lastError || null });
    this.io.emit(`${this.namespace}:candles`, this.latestCandles);
    if (this.currentTicker) this.io.emit(`${this.namespace}:ticker`, this.currentTicker);
  }

  async fetchSnapshot () {
    if (this.provider === 'yahoo') return fetchYahooSnapshot(this.symbol, this.range);
    return fetchBinanceSnapshot(this.symbol);
  }
}

function getJson (url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'scpbot/1.0' } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function fetchBinanceSnapshot (symbol) {
  const [klines, ticker] = await Promise.all([
    getJson(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=1000`),
    getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`),
  ]);
  const now = Date.now();
  const candles = Array.isArray(klines) ? klines
    .map(row => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]) || 0,
      closeTime: Number(row[6]),
    }))
    .filter(c => validCandle(c) && now >= c.closeTime)
    : [];
  return {
    candles: dedupeCandles(candles),
    ticker: ticker && Number.isFinite(Number(ticker.lastPrice || ticker.c))
      ? {
          symbol,
          price: Number(ticker.lastPrice || ticker.c),
          change24h: Number(ticker.priceChangePercent || ticker.P) || 0,
          high24h: Number(ticker.highPrice || ticker.h) || null,
          low24h: Number(ticker.lowPrice || ticker.l) || null,
          volume24h: Number(ticker.volume || ticker.v) || null,
        }
      : null,
  };
}

async function fetchYahooSnapshot (symbol, range) {
  const json = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=${encodeURIComponent(range || '5d')}&includePrePost=false&events=div%2Csplits`);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('No Yahoo Finance chart result');
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const now = Date.now();
  const candles = timestamps.map((ts, index) => ({
    openTime: Number(ts) * 1000,
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index]) || 0,
    closeTime: Number(ts) * 1000 + BASE_INTERVAL_MS - 1,
  })).filter(c => validCandle(c) && now >= c.closeTime);
  const closes = candles.map(c => c.close).filter(Number.isFinite);
  const latest = closes[closes.length - 1] ?? Number(result.meta?.regularMarketPrice);
  const prevClose = Number(result.meta?.chartPreviousClose || result.meta?.previousClose);
  return {
    candles: dedupeCandles(candles),
    ticker: Number.isFinite(latest)
      ? {
          symbol,
          price: latest,
          change24h: Number.isFinite(prevClose) && prevClose ? ((latest - prevClose) / prevClose) * 100 : 0,
          high24h: Number(result.meta?.regularMarketDayHigh) || null,
          low24h: Number(result.meta?.regularMarketDayLow) || null,
          volume24h: Number(result.meta?.regularMarketVolume) || null,
        }
      : null,
  };
}

function validCandle (candle) {
  return candle &&
    Number.isFinite(Number(candle.openTime)) &&
    Number.isFinite(Number(candle.open)) &&
    Number.isFinite(Number(candle.high)) &&
    Number.isFinite(Number(candle.low)) &&
    Number.isFinite(Number(candle.close));
}

function dedupeCandles (candles = []) {
  const map = new Map();
  for (const candle of candles) {
    if (!validCandle(candle)) continue;
    map.set(Number(candle.openTime), {
      openTime: Number(candle.openTime),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume) || 0,
      closeTime: Number(candle.closeTime) || (Number(candle.openTime) + BASE_INTERVAL_MS - 1),
    });
  }
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

module.exports = { MarketFeedManager };
