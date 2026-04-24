'use strict';
const WebSocket = require('ws');
const https     = require('https');

const db                                              = require('./db');
const { Session, Trade, DailyPnl, Equity, Position } = db;

const SYMBOL       = 'btcusdt';
const INTERVAL     = '5m';
const WS_KLINE     = `wss://stream.binance.com:9443/ws/${SYMBOL}@kline_${INTERVAL}`;
const WS_TICKER    = `wss://stream.binance.com:9443/ws/${SYMBOL}@ticker`;
const REST_HISTORY = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${INTERVAL}&limit=200`;

const EQUITY_SNAP_EVERY = 5;

const utcDate = ts => new Date(ts).toISOString().slice(0, 10);
const today   = ()  => new Date().toISOString().slice(0, 10);
const strategyRiskPct = strategy => {
  const pct = Number(strategy?.riskPerTrade) * 100;
  return Number.isFinite(pct) ? pct : 0;
};
const moneyLabel = value => {
  if (value === null || value === undefined || value === '') return '--';
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '--';
};
const qtyLabel = value => {
  if (value === null || value === undefined || value === '') return '0.000000';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6) : '0.000000';
};
const lotSizeValue = payload => {
  const explicit = Number(payload?.lotSize);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const qty = Number(payload?.qty);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
};
const marginUsedValue = payload => {
  const explicit = Number(payload?.marginUsed);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const entry = Number(payload?.entry);
  const qty = Number(payload?.qty);
  return Number.isFinite(entry) && Number.isFinite(qty) ? Math.abs(entry * qty) : null;
};

// ─────────────────────────────────────────────────────────────────────────────
//  StrategyRunner — wraps one strategy instance with independent lifecycle
// ─────────────────────────────────────────────────────────────────────────────
class StrategyRunner {
  constructor (id, strategy, io, opts = {}) {
    this.id       = id;    // 'scalping' | 'breakout' | 'heikenashi' | 'pine:<scriptId>'
    this.strategy = strategy;
    this.io       = io;
    this.sessionStrategyType = opts.sessionStrategyType || id;
    this.pineScriptId        = opts.pineScriptId || null;
    this.displayName         = opts.displayName || id;
    this.lotSize             = opts.lotSize || null;
    this.onPositionOpened    = typeof opts.onPositionOpened === 'function' ? opts.onPositionOpened : null;
    this.onTradeClosed       = typeof opts.onTradeClosed === 'function' ? opts.onTradeClosed : null;
    this.sessionId        = null;
    this.running          = false;
    this.paused           = false;
    this.candlesSinceSave = 0;
  }

  // ── Emit namespaced socket events ──────────────────────────────────────────
  emit (event, data) { this.io.emit(`${this.id}:${event}`, data); }

  log (level, msg) {
    console.log(`[${this.id.toUpperCase()}][${level.toUpperCase()}] ${msg}`);
    const tag = this.id === 'scalping' ? '📈 EMA'
      : this.id === 'breakout' ? '🚀 BRK'
        : this.id === 'heikenashi' ? '🕯️ HA' : `📜 ${this.displayName || 'PINE'}`;
    this.io.emit('log', { level, msg: `[${tag}] ${msg}`, time: Date.now(), strategyId: this.id });
  }

  // ── Wire strategy events → DB persistence + socket broadcast ──────────────
  wire () {
    const s  = this.strategy;
    const id = this.id;
    s.removeAllListeners();

    s.on('position_opened', async pos => {
      this.log('info',
        `🟢 OPENED ${String(pos.type || '').toUpperCase()} @ ${moneyLabel(pos.entry)} ` +
        `| SL ${moneyLabel(pos.sl)} | TP ${moneyLabel(pos.tp)} | ${qtyLabel(pos.qty)} BTC`);
      if (this.sessionId) {
        await Position.findOneAndUpdate(
          { sessionId: this.sessionId },
          {
            ...pos,
            lotSize: lotSizeValue(pos),
            marginUsed: marginUsedValue(pos),
            sessionId: this.sessionId,
          },
          { upsert: true, new: true }
        ).catch(() => {});
      }
      if (this.onPositionOpened) {
        await this.onPositionOpened(pos, this).catch(e => console.error(`[${id}] External open handler failed:`, e.message));
      }
      this.emit('position_opened', pos);
    });

    s.on('trade_closed', async trade => {
      this.emit('trade_closed', trade);
      const win = trade.pnl > 0;
      this.log(win ? 'success' : 'warn',
        `${win ? '✅' : '❌'} CLOSED ${trade.type.toUpperCase()} @ $${trade.exit.toFixed(2)} ` +
        `| P&L $${trade.pnl.toFixed(2)} (${trade.pnlPct.toFixed(2)}%) [${trade.reason}]`);

      if (!this.sessionId) return;
      await Trade.create({
        sessionId: this.sessionId,
        tradeNum: trade.id, type: trade.type, entry: trade.entry,
        exit: trade.exit, qty: trade.qty, lotSize: lotSizeValue(trade), marginUsed: marginUsedValue(trade),
        pnl: trade.pnl, pnlPct: trade.pnlPct,
        entryTime: trade.entryTime, exitTime: trade.exitTime,
        reason: trade.reason, sl: trade.sl, tp: trade.tp,
      }).catch(e => console.error(`[${id}] Trade save failed:`, e.message));

      const wins  = s.trades.filter(t => t.pnl > 0);
      const loses = s.trades.filter(t => t.pnl <= 0);
      await Session.findByIdAndUpdate(this.sessionId, {
        currentCapital:    s.capital,
        tradeCount:        s.trades.length,
        winCount:          wins.length,
        lossCount:         loses.length,
        grossProfit:       wins.reduce((a, t)  => a + t.pnl, 0),
        grossLoss:         loses.reduce((a, t) => a + t.pnl, 0),
        currentDate:       s.currentDate,
        dailyStartCapital: s.dailyStartCap,
      }).catch(e => console.error(`[${id}] Session update failed:`, e.message));

      await Position.deleteOne({ sessionId: this.sessionId }).catch(() => {});
      if (this.onTradeClosed) {
        await this.onTradeClosed(trade, this).catch(e => console.error(`[${id}] External close handler failed:`, e.message));
      }

      const sessInfo = await this.buildSessionInfo().catch(() => null);
      if (sessInfo) this.emit('session_info', sessInfo);
    });

    s.on('day_summary', async d => {
      this.log(d.pnl >= 0 ? 'info' : 'error',
        `📅 Day closed: ${d.date} | P&L $${d.pnl.toFixed(2)} (${d.pnlPct.toFixed(2)}%)`);
      if (!this.sessionId) return;
      await DailyPnl.findOneAndUpdate(
        { sessionId: this.sessionId, date: d.date },
        { $set: { pnl: d.pnl, pnlPct: d.pnlPct, startCapital: d.startCapital, endCapital: d.endCapital, sessionId: this.sessionId } },
        { upsert: true }
      ).catch(e => console.error(`[${id}] DailyPnl save failed:`, e.message));
      await Session.findByIdAndUpdate(this.sessionId, {
        currentDate: s.currentDate, dailyStartCapital: s.dailyStartCap,
      }).catch(() => {});
    });

    s.on('warmed_up', () => {
      this.log('success', '✅ Strategy warmed up — live trading active');
      this.emit('warmed_up', {});
      this.emit('status', this._status());
    });
  }

  // ── Start / resume ─────────────────────────────────────────────────────────
  async start (opts = {}) {
    if (this.running) return;
    const { createNew = false } = opts;
    const s = this.strategy;

    if (createNew || !this.sessionId) {
      if (this.sessionId)
        await Session.findByIdAndUpdate(this.sessionId, { isRunning: false, stoppedAt: new Date() }).catch(() => {});
      const sess = await Session.create({
        isRunning:         true,
        strategyType:      this.sessionStrategyType,
        ...(this.pineScriptId && { pineScriptId: this.pineScriptId }),
        executionMode:     'paper',
        initialCapital:    s.initialCapital,
        currentCapital:    s.capital,
        riskPerTradePct:   strategyRiskPct(s),
        dailyStartCapital: s.capital,
        currentDate:       today(),
      });
      this.sessionId = sess._id;
      this.log('info', `📋 New session created: ${sess._id}`);
    } else {
      await Session.findByIdAndUpdate(this.sessionId, { isRunning: true, stoppedAt: null }).catch(() => {});
      await Session.findByIdAndUpdate(this.sessionId, { executionMode: 'paper' }).catch(() => {});
    }

    this.running = true;
    this.paused  = false;
    this.emit('status', this._status());
    return this.sessionId;
  }

  // ── Stop ───────────────────────────────────────────────────────────────────
  async stop () {
    if (!this.running) return;
    this.running = false;
    this.paused  = false;
    if (this.sessionId) {
      await Session.findByIdAndUpdate(this.sessionId, {
        isRunning:         false,
        stoppedAt:         new Date(),
        currentCapital:    this.strategy.capital,
        currentDate:       this.strategy.currentDate,
        dailyStartCapital: this.strategy.dailyStartCap,
      }).catch(() => {});
    }
    this.emit('status', this._status());
    this.log('warn', '⏹ Strategy stopped — session preserved in MongoDB');
  }

  // ── Pause (keeps session alive, skips candle processing) ──────────────────
  pause () {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emit('status', this._status());
    this.log('warn', '⏸ Strategy paused');
  }

  // ── Resume from pause ──────────────────────────────────────────────────────
  resume () {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.emit('status', this._status());
    this.log('info', '▶ Strategy resumed');
  }

  // ── Reset — full wipe of strategy state, new DB session on next start ──────
  async reset (cfg = {}) {
    const wasRunning = this.running;
    if (wasRunning) await this.stop();
    if (this.sessionId)
      await Session.findByIdAndUpdate(this.sessionId, { isRunning: false, stoppedAt: new Date() }).catch(() => {});
    this.sessionId = null;
    this.strategy.reset(cfg);
    this.wire();
    this.emit('status', this._status());
    this.emit('stats', this.strategy.getFullState());
    this.log('info', '🔄 Strategy reset — ready for fresh session');
  }

  // ── Process one closed candle ──────────────────────────────────────────────
  async processCandle (candle) {
    if (!this.running || this.paused) return;
    const state = this.strategy.processCandle(candle);
    if (state) this.emit('stats', state);

    this.candlesSinceSave++;
    if (this.candlesSinceSave >= EQUITY_SNAP_EVERY && this.sessionId) {
      this.candlesSinceSave = 0;
      await Equity.create({ sessionId: this.sessionId, time: candle.openTime, equity: this.strategy.capital })
        .catch(() => {});
      await Session.findByIdAndUpdate(this.sessionId, {
        currentCapital:    this.strategy.capital,
        currentDate:       this.strategy.currentDate,
        dailyStartCapital: this.strategy.dailyStartCap,
      }).catch(() => {});
      this.emit('equity_point', { time: Math.floor(candle.openTime / 1000), equity: this.strategy.capital });
    }
  }

  // ── Restore from MongoDB + Binance history ─────────────────────────────────
  async restoreFromDB () {
    const query = { strategyType: this.sessionStrategyType };
    if (this.pineScriptId) query.pineScriptId = this.pineScriptId;
    const sess = await Session.findOne(query).sort({ createdAt: -1 }).lean();
    if (!sess) return null;

    this.sessionId = sess._id;
    const s = this.strategy;
    s.capital         = sess.currentCapital;
    s.initialCapital  = sess.initialCapital;
    if (sess.riskPerTradePct && s.riskPerTrade !== undefined) s.riskPerTrade = sess.riskPerTradePct / 100;

    const dbTrades = await Trade.find({ sessionId: sess._id }).sort({ entryTime: 1 }).lean();
    s.trades = dbTrades.map(t => ({
      id: t.tradeNum, type: t.type, entry: t.entry, exit: t.exit,
      qty: t.qty, pnl: t.pnl, pnlPct: t.pnlPct,
      entryTime: t.entryTime, exitTime: t.exitTime,
      reason: t.reason, sl: t.sl, tp: t.tp,
    }));

    const dbDailyPnl = await DailyPnl.find({ sessionId: sess._id }).lean();
    dbDailyPnl.forEach(d => {
      s.dailyPnl[d.date] = { pnl: d.pnl, pnlPct: d.pnlPct, startCapital: d.startCapital, endCapital: d.endCapital };
    });

    const todayStr    = today();
    const todayTrades = s.trades.filter(t => utcDate(t.exitTime) === todayStr);
    const todayPnl    = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const todayStart  = sess.dailyStartCapital ?? (s.capital - todayPnl);
    s.setDailyContext(todayStr, todayStart);

    this.wire();
    this.log('info', `📂 Session restored (${this.id}): ${dbTrades.length} trades, capital $${s.capital.toFixed(2)}`);
    return sess;
  }

  // ── Warm up indicators from Binance history ────────────────────────────────
  async warmUp (history) {
    const restored = this.strategy.restoreFromHistory(history.slice(0, -1));
    if (restored) {
      this.log('success', `📊 Indicators warmed from ${history.length} Binance candles`);
      this.emit('warmed_up', {});
    }
    this.emit('stats', this.strategy.getFullState());
  }

  // ── Build session info object for API / socket ─────────────────────────────
  async buildSessionInfo () {
    if (!this.sessionId) return null;
    const sess = await Session.findById(this.sessionId).lean();
    if (!sess) return null;
    return {
      id:             sess._id.toString(),
      shortId:        sess._id.toString().slice(-6).toUpperCase(),
      strategyType:   this.sessionStrategyType,
      runnerId:       this.id,
      pineScriptId:   this.pineScriptId,
      executionMode:  'paper',
      isRunning:      sess.isRunning,
      paused:         this.paused,
      initialCapital: sess.initialCapital,
      currentCapital: sess.currentCapital,
      riskPerTradePct: sess.riskPerTradePct,
      startedAt:      sess.startedAt,
      stoppedAt:      sess.stoppedAt,
      tradeCount:     sess.tradeCount,
      winCount:       sess.winCount,
      lossCount:      sess.lossCount,
      profitFactor:   sess.grossLoss !== 0 ? +(Math.abs(sess.grossProfit / sess.grossLoss)).toFixed(2) : null,
    };
  }

  // ── Equity history from DB ─────────────────────────────────────────────────
  async equityHistory () {
    if (!this.sessionId) return [];
    const pts = await Equity.find({ sessionId: this.sessionId }).sort({ time: 1 }).limit(500).lean();
    return pts.map(p => ({ time: Math.floor(p.time / 1000), equity: p.equity }));
  }

  // ── Trades from DB ─────────────────────────────────────────────────────────
  async recentTrades () {
    if (!this.sessionId) return [];
    return Trade.find({ sessionId: this.sessionId }).sort({ entryTime: -1 }).limit(200).lean();
  }

  // ── Status snapshot ────────────────────────────────────────────────────────
  _status () {
    return {
      id:       this.id,
      running:  this.running,
      paused:   this.paused,
      warmedUp: this.strategy.warmedUp,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BotManager — shared Binance WS + fan-out to all runners
// ─────────────────────────────────────────────────────────────────────────────
class BotManager {
  constructor (io) {
    this.io           = io;
    this.runners      = {};          // id -> StrategyRunner
    this.klineWs      = null;
    this.tickerWs     = null;
    this.wsKlineUp    = false;
    this.wsTickerUp   = false;
    this.latestCandles = [];
    this.currentTicker = null;
  }

  addRunner (runner) {
    this.runners[runner.id] = runner;
  }

  getRunner (id) { return this.runners[id]; }

  removeRunner (id) { delete this.runners[id]; }

  // ── Fetch historical candles ───────────────────────────────────────────────
  fetchHistory () {
    return new Promise((resolve, reject) => {
      https.get(REST_HISTORY, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf).map(c => ({
              openTime: c[0], open: +c[1], high: +c[2],
              low: +c[3], close: +c[4], volume: +c[5], closeTime: c[6],
            })));
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  // ── Start kline WS (starts once, fans out to all active runners) ───────────
  connectKlineWs () {
    if (this.klineWs) { this.klineWs.terminate(); this.klineWs = null; }
    this.klineWs = new WebSocket(WS_KLINE);

    this.klineWs.on('open', () => {
      this.wsKlineUp = true;
      this.io.emit('ws_status', { kline: true, ticker: this.wsTickerUp });
      console.log(`[WS] Binance kline connected (${SYMBOL} ${INTERVAL})`);
    });

    this.klineWs.on('ping', d => this.klineWs.pong(d));

    this.klineWs.on('message', async raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.e !== 'kline') return;
      const k = msg.k;
      const candle = {
        openTime: k.t, open: +k.o, high: +k.h,
        low: +k.l, close: +k.c, volume: +k.v,
        closeTime: k.T, isClosed: k.x,
      };

      this.io.emit('candle_tick', candle);

      if (k.x) {
        this.latestCandles.push(candle);
        if (this.latestCandles.length > 1000) this.latestCandles.shift();
        // Fan-out to all active runners
        for (const runner of Object.values(this.runners)) {
          await runner.processCandle(candle);
        }
      }
    });

    this.klineWs.on('close', () => {
      this.wsKlineUp = false;
      this.io.emit('ws_status', { kline: false, ticker: this.wsTickerUp });
      const anyRunning = Object.values(this.runners).some(r => r.running);
      if (anyRunning) {
        console.log('[WS] Kline WS disconnected — reconnecting in 3s...');
        setTimeout(() => this.connectKlineWs(), 3000);
      }
    });

    this.klineWs.on('error', err => console.error('[WS] Kline error:', err.message));
  }

  // ── Start ticker WS ────────────────────────────────────────────────────────
  connectTickerWs () {
    if (this.tickerWs) { this.tickerWs.terminate(); this.tickerWs = null; }
    this.tickerWs = new WebSocket(WS_TICKER);

    this.tickerWs.on('open', () => {
      this.wsTickerUp = true;
      this.io.emit('ws_status', { kline: this.wsKlineUp, ticker: true });
    });
    this.tickerWs.on('ping', d => this.tickerWs.pong(d));
    this.tickerWs.on('message', raw => {
      const t = JSON.parse(raw.toString());
      this.currentTicker = { price: +t.c, change24h: +t.P, high24h: +t.h, low24h: +t.l, volume24h: +t.v, quoteVol: +t.q };
      this.io.emit('ticker', this.currentTicker);
    });
    this.tickerWs.on('close', () => {
      this.wsTickerUp = false;
      this.io.emit('ws_status', { kline: this.wsKlineUp, ticker: false });
      const anyRunning = Object.values(this.runners).some(r => r.running);
      if (anyRunning) setTimeout(() => this.connectTickerWs(), 3000);
    });
    this.tickerWs.on('error', () => {});
  }

  // ── Ensure WS connections are live (starts if not already up) ─────────────
  ensureWs () {
    if (!this.klineWs  || this.klineWs.readyState  > WebSocket.OPEN) this.connectKlineWs();
    if (!this.tickerWs || this.tickerWs.readyState  > WebSocket.OPEN) this.connectTickerWs();
  }

  // ── Tear down WS if no runners are active ──────────────────────────────────
  maybeStopWs () {
    const anyRunning = Object.values(this.runners).some(r => r.running);
    if (!anyRunning) {
      if (this.klineWs)  { this.klineWs.terminate();  this.klineWs  = null; this.wsKlineUp  = false; }
      if (this.tickerWs) { this.tickerWs.terminate(); this.tickerWs = null; this.wsTickerUp = false; }
      this.io.emit('ws_status', { kline: false, ticker: false });
    }
  }

  // ── Full status snapshot (both runners) ────────────────────────────────────
  allStatus () {
    const status = Object.fromEntries(
      Object.values(this.runners).map(r => [r.id, r._status()])
    );
    const pineRunners = Object.values(this.runners).filter(r => r.id.startsWith('pine:'));
    if (pineRunners.length) {
      const running = pineRunners.some(r => r.running);
      status.pine = {
        id: 'pine',
        running,
        paused: running && pineRunners.filter(r => r.running).every(r => r.paused),
        warmedUp: running && pineRunners.filter(r => r.running).every(r => r.strategy.warmedUp),
        count: pineRunners.length,
        runningCount: pineRunners.filter(r => r.running).length,
      };
    }
    return status;
  }

  // ── Send full state to a newly connected socket ────────────────────────────
  async sendInitialState (socket) {
    socket.emit('ws_status', { kline: this.wsKlineUp, ticker: this.wsTickerUp });
    socket.emit('candles',    this.latestCandles);
    if (this.currentTicker) socket.emit('ticker', this.currentTicker);
    socket.emit('all_status', this.allStatus());

    for (const runner of Object.values(this.runners)) {
      socket.emit(`${runner.id}:status`,  runner._status());
      socket.emit(`${runner.id}:stats`,   runner.strategy.getFullState());

      const sessInfo = await runner.buildSessionInfo().catch(() => null);
      if (sessInfo) socket.emit(`${runner.id}:session_info`, sessInfo);

      const equity = await runner.equityHistory().catch(() => []);
      if (equity.length) socket.emit(`${runner.id}:equity_history`, equity);
    }

    // Sessions list (all strategies combined)
    await this.sendSessionsList(socket);
  }

  async sendSessionsList (target) {
    const sessions = await Session.find().sort({ createdAt: -1 }).limit(40).lean();
    target.emit('sessions_list', sessions.map(s => ({
      id:             s._id.toString(),
      shortId:        s._id.toString().slice(-6).toUpperCase(),
      strategyType:   s.strategyType || 'scalping',
      pineScriptId:   s.pineScriptId?.toString?.() || s.pineScriptId || null,
      executionMode:  s.executionMode || 'paper',
      isRunning:      s.isRunning,
      initialCapital: s.initialCapital,
      currentCapital: s.currentCapital,
      riskPerTradePct: s.riskPerTradePct,
      tradeCount:     s.tradeCount,
      winCount:       s.winCount,
      startedAt:      s.startedAt,
      stoppedAt:      s.stoppedAt,
      pnl:            s.currentCapital - s.initialCapital,
      pnlPct:         (s.currentCapital - s.initialCapital) / s.initialCapital * 100,
    })));
  }
}

module.exports = { BotManager, StrategyRunner };
