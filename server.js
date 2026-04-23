'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const db                                      = require('./db');
const { Session, PineScriptConfig, AllInOneStrategyConfig, UTBotConfig, Trade, Position, ExchangeOrder, ExchangeCredential } = db;
const { BotManager, StrategyRunner }         = require('./bot-manager');
const { ScalpingStrategy }                   = require('./strategies/scalping');
const { RangeBreakoutStrategy }              = require('./strategies/breakout');
const { HeikenAshiSupertrendStrategy }       = require('./strategies/heikenashi_supertrend');
const { PineScriptStrategy }                 = require('./strategies/pine_adapter');
const { AllInOneStrategy, ALL_IN_ONE_DEFINITIONS, TIMEFRAME_MS } = require('./strategies/all_in_one');
const { UTBotStrategy }                      = require('./strategies/ut_bot');
const { DeltaDemoClient }                    = require('./delta-exchange');

const SYMBOL_REST = 'BTCUSDT';
const INTERVAL_REST = '5m';
const CANDLE_MS = 5 * 60 * 1000;
const EXCHANGE_PROVIDERS = [
  { provider: 'delta-demo', name: 'Delta Exchange Demo' },
];
const ALL_IN_ONE_AUTO_RISK = {
  riskPerTradePct: 1,
  atrLength: 14,
  slMultiplier: 2,
  tpMultiplier: 4,
  trailOffset: 1.5,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Auth config  (set via .env)
// ─────────────────────────────────────────────────────────────────────────────
const DASHBOARD_EMAIL = (process.env.DASHBOARD_EMAIL    || '').trim();
const DASHBOARD_PWD   = (process.env.DASHBOARD_PASSWORD || '').trim();

if (!DASHBOARD_EMAIL || !DASHBOARD_PWD) {
  console.error('[AUTH] DASHBOARD_EMAIL / DASHBOARD_PASSWORD not set in .env — aborting');
  process.exit(1);
}

// In-memory session store  { token -> { email, expiresAt } }
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24 h

function createSession () {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { email: DASHBOARD_EMAIL, expiresAt });
  return token;
}

function isValidSession (token) {
  if (!token) return false;
  const sess = sessions.get(token);
  if (!sess) return false;
  if (Date.now() > sess.expiresAt) { sessions.delete(token); return false; }
  return true;
}

function parseCookies (header = '') {
  return Object.fromEntries(
    header.split(';').map(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return ['', ''];
      return [p.slice(0, eq).trim(), decodeURIComponent(p.slice(eq + 1).trim())];
    }).filter(([k]) => k)
  );
}

function sessionCookie (token, clear = false) {
  if (clear) return 'btcbot_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict';
  return `btcbot_session=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Strict`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP + Socket.IO
// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  Login page HTML  (served as a string — not in /public so it's always accessible)
// ─────────────────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTC Bot — Sign In</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0b0d14;color:#c9cde0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#12141f;border:1px solid #252840;border-radius:10px;padding:40px 36px;width:340px;}
.logo{font-size:22px;font-weight:800;text-align:center;margin-bottom:28px;letter-spacing:-.01em;}
.logo span{color:#ff9100;}
label{display:block;font-size:11px;color:#5a6080;margin-bottom:4px;margin-top:14px;text-transform:uppercase;letter-spacing:.07em;}
input{width:100%;background:#181a28;border:1px solid #252840;color:#c9cde0;padding:9px 12px;border-radius:5px;font-size:13px;outline:none;transition:.15s;}
input:focus{border-color:#2979ff;}
.btn{margin-top:22px;width:100%;padding:10px;background:#2979ff;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:.03em;transition:.15s;}
.btn:hover{background:#1565c0;}
.error{margin-top:14px;padding:8px 12px;background:#ff3d5718;border:1px solid #ff3d5730;border-radius:4px;color:#ff3d57;font-size:12px;text-align:center;}
.note{margin-top:16px;font-size:10px;color:#5a6080;text-align:center;}
</style>
</head>
<body>
<div class="box">
  <div class="logo">⚡<span>BTC</span>Multi Bot</div>
  <form method="POST" action="/login">
    <label>Email</label>
    <input type="email" name="email" autocomplete="username" required autofocus placeholder="you@example.com">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required placeholder="••••••••">
    <!--ERROR-->
    <button class="btn" type="submit">Sign In</button>
  </form>
  <div class="note">Access restricted — credentials set in .env</div>
</div>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
//  Public auth routes  (no auth required)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const token = parseCookies(req.headers.cookie || '')['btcbot_session'];
  if (isValidSession(token)) return res.redirect('/');
  res.setHeader('Content-Type', 'text/html');
  res.send(LOGIN_HTML);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { email = '', password = '' } = req.body;
  const emailOk = email.toLowerCase().trim() === DASHBOARD_EMAIL.toLowerCase();
  const pwdOk   = password === DASHBOARD_PWD;

  if (emailOk && pwdOk) {
    const token = createSession();
    res.setHeader('Set-Cookie', sessionCookie(token));
    console.log(`[AUTH] Login OK — ${email}`);
    return res.redirect('/pine.html');
  }

  console.warn(`[AUTH] Failed login attempt — email: ${email}`);
  res.setHeader('Content-Type', 'text/html');
  res.send(LOGIN_HTML.replace('<!--ERROR-->', '<div class="error">Invalid email or password</div>'));
});

app.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie || '')['btcbot_session'];
  if (token) { sessions.delete(token); }
  res.setHeader('Set-Cookie', sessionCookie('', true));
  res.redirect('/login');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Auth middleware — protects all routes below this point
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth (req, res, next) {
  const token = parseCookies(req.headers.cookie || '')['btcbot_session'];
  if (isValidSession(token)) return next();
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized — please log in at /login' });
  }
  res.redirect('/login');
}

app.use(requireAuth);
app.get(['/', '/index.html'], (_req, res) => res.redirect('/pine.html'));
app.get('/positions.html', (_req, res) => res.redirect('/pine.html'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO auth middleware
// ─────────────────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie || '')['btcbot_session'];
  if (isValidSession(token)) return next();
  next(new Error('Unauthorized'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  BotManager + runners
// ─────────────────────────────────────────────────────────────────────────────
const manager = new BotManager(io);
const deltaClient = new DeltaDemoClient(process.env);

const scalpRunner    = new StrategyRunner('scalping',    new ScalpingStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { executionAdapter: deltaClient, displayName: 'EMA Scalping', onExchangeOrder: queueExchangeOrderSync });
const breakoutRunner = new StrategyRunner('breakout',    new RangeBreakoutStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { executionAdapter: deltaClient, displayName: 'Range Breakout', onExchangeOrder: queueExchangeOrderSync });
const haRunner       = new StrategyRunner('heikenashi',  new HeikenAshiSupertrendStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { executionAdapter: deltaClient, displayName: 'Heikin-Ashi SuperTrend', onExchangeOrder: queueExchangeOrderSync });
const pineRunners    = new Map(); // scriptId -> StrategyRunner
const allInOneRunners = new Map(); // strategyKey -> StrategyRunner
let utBotRunner = null;
const EXCHANGE_SYNC_INTERVAL_MS = 30 * 1000;
const STRATEGY_WATCHDOG_INTERVAL_MS = 30 * 1000;
let exchangeSyncTimer = null;
let exchangeSyncInFlight = false;
let latestExchangeSync = null;
let strategyWatchdogTimer = null;
let exchangeOrderSyncTimer = null;

manager.addRunner(scalpRunner);
manager.addRunner(breakoutRunner);
manager.addRunner(haRunner);

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: start a runner
// ─────────────────────────────────────────────────────────────────────────────
async function startRunner (runner, opts = {}) {
  await runner.start(opts);
  try {
    const hist = await manager.fetchHistory();
    if (!manager.latestCandles.length) manager.latestCandles = hist.slice();
    await runner.warmUp(hist);
    io.emit('candles', manager.latestCandles);
  } catch (e) {
    runner.log('warn', `⚠️ Binance history unavailable (${e.message}) — warming on live data`);
  }
  manager.ensureWs();
  io.emit('all_status', manager.allStatus());
  const sessInfo = await runner.buildSessionInfo().catch(() => null);
  if (sessInfo) io.emit(`${runner.id}:session_info`, sessInfo);
  await manager.sendSessionsList(io);
  startBackendExchangeSync();
}

function fetchJson (url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchKlinesRange (fromMs, toMs) {
  const candles = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL_REST}&interval=${INTERVAL_REST}&limit=1000&startTime=${cursor}&endTime=${toMs}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) {
      candles.push({
        openTime: c[0], open: +c[1], high: +c[2],
        low: +c[3], close: +c[4], volume: +c[5], closeTime: c[6],
      });
    }
    const lastOpen = rows[rows.length - 1][0];
    const next = lastOpen + CANDLE_MS;
    if (next <= cursor) break;
    cursor = next;
    if (candles.length > 50000) break;
  }
  return candles;
}

function summarizeBacktest (strategy, candles, fromMs, toMs) {
  for (const candle of candles) strategy.processCandle(candle);
  if (strategy.position && candles.length) {
    const last = candles[candles.length - 1];
    strategy._closePos(last.close, last.openTime, 'range_end');
  }
  const state = strategy.getFullState();
  const trades = strategy.trades.slice();
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const maxDrawdownPct = calcMaxDrawdown(strategy.equityHistory);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    candles: candles.length,
    script: strategy.scriptMeta(),
    summary: {
      initialCapital: state.initialCapital,
      finalCapital: state.capital,
      netPnl: state.totalPnl,
      returnPct: state.totalReturn,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: state.winRate,
      profitFactor: state.profitFactor,
      avgWin: state.avgWin,
      avgLoss: state.avgLoss,
      maxDrawdownPct,
    },
    equity: strategy.equityHistory.slice(-1000),
    trades: trades.slice(-250).reverse(),
  };
}

function calcMaxDrawdown (equityHistory) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equityHistory) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak * 100);
  }
  return maxDd;
}

function pineListItem (doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    isActive: Boolean(doc.isActive || doc.key === 'active'),
    meta: doc.meta || {},
    capital: doc.capital || 10000,
    riskPerTradePct: doc.riskPerTradePct || 2,
    lotSize: doc.lotSize || 1,
    positionSizePct: doc.positionSizePct ?? 10,
    minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
    profitRatioBooking: doc.profitRatioBooking ?? 1.67,
    exchangeEnabled: Boolean(doc.exchangeEnabled),
    exchangeProvider: doc.exchangeProvider || 'delta-demo',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function pineRunnerId (scriptId) {
  return `pine:${scriptId}`;
}

function pineAggregateStatus () {
  const runners = [...pineRunners.values()];
  const runningRunners = runners.filter(r => r.running);
  return {
    id: 'pine',
    running: runningRunners.length > 0,
    paused: runningRunners.length > 0 && runningRunners.every(r => r.paused),
    warmedUp: runningRunners.length > 0 && runningRunners.every(r => r.strategy.warmedUp),
    count: runners.length,
    runningCount: runningRunners.length,
  };
}

async function pineRunnerSnapshot (doc) {
  const item = pineListItem(doc);
  const runner = pineRunners.get(item.id);
  const status = runner?._status() || { id: pineRunnerId(item.id), running: false, paused: false, warmedUp: false };
  const session = runner ? await runner.buildSessionInfo().catch(() => null) : null;
  return {
    ...item,
    runnerId: pineRunnerId(item.id),
    status,
    session,
    stats: runner ? runner.strategy.getFullState() : null,
  };
}

async function listPineScriptsDetailed () {
  const docs = await PineScriptConfig.find().sort({ isActive: -1, updatedAt: -1 }).lean();
  return Promise.all(docs.map(pineRunnerSnapshot));
}

async function emitPineState () {
  io.emit('pine:status', pineAggregateStatus());
  io.emit('pine:runners', await listPineScriptsDetailed());
  io.emit('pine:scripts', await listPineScriptsDetailed());
  io.emit('all_status', manager.allStatus());
}

function hookPineRunnerEvents (runner, scriptId) {
  if (runner._pineHooked) return;
  runner._pineHooked = true;
  const rawEmit = runner.emit.bind(runner);
  runner.emit = (event, data) => {
    rawEmit(event, data);
    io.emit('pine:runner_event', {
      scriptId,
      runnerId: runner.id,
      event,
      data,
      status: runner._status(),
      stats: runner.strategy.getFullState(),
    });
    if (['status', 'stats', 'session_info', 'position_opened', 'trade_closed', 'warmed_up'].includes(event)) {
      emitPineState().catch(e => console.error('[PINE] emit state failed:', e.message));
    }
  };
}

function ensurePineRunner (doc) {
  const scriptId = doc._id.toString();
  let runner = pineRunners.get(scriptId);
  if (!runner) {
    runner = new StrategyRunner(
      pineRunnerId(scriptId),
      new PineScriptStrategy({
        name: doc.name,
        code: doc.code,
        capital: doc.capital || 10000,
        riskPerTradePct: doc.riskPerTradePct || 2,
        lotSize: doc.lotSize || 1,
        positionSizePct: doc.positionSizePct ?? 10,
        minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
        profitRatioBooking: doc.profitRatioBooking ?? 1.67,
      }),
      io,
      { sessionStrategyType: 'pine', pineScriptId: scriptId, displayName: doc.name, executionAdapter: deltaClient, executionEnabled: Boolean(doc.exchangeEnabled), lotSize: doc.lotSize || 1, onExchangeOrder: queueExchangeOrderSync }
    );
    pineRunners.set(scriptId, runner);
    manager.addRunner(runner);
    hookPineRunnerEvents(runner, scriptId);
    runner.wire();
  } else {
    runner.displayName = doc.name;
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    runner.lotSize = doc.lotSize || 1;
    if (!runner.running) runner.strategy.setScript({ name: doc.name, code: doc.code });
    runner.wire();
  }
  return runner;
}

async function setActivePineScript (doc) {
  doc.isActive = true;
  await doc.save();
  const runner = ensurePineRunner(doc);
  io.emit('pine:config', {
    id: doc._id.toString(),
    name: doc.name,
    code: doc.code,
    meta: runner.strategy.scriptMeta(),
    capital: doc.capital || 10000,
    riskPerTradePct: doc.riskPerTradePct || 2,
    lotSize: doc.lotSize || 1,
    positionSizePct: doc.positionSizePct ?? 10,
    minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
    profitRatioBooking: doc.profitRatioBooking ?? 1.67,
    exchangeEnabled: Boolean(doc.exchangeEnabled),
    exchangeProvider: doc.exchangeProvider || 'delta-demo',
  });
  await emitPineState();
  return runner;
}

async function listPineScripts () {
  const docs = await PineScriptConfig.find().sort({ isActive: -1, updatedAt: -1 }).lean();
  return docs.map(pineListItem);
}

function applyPineRuntimeOptions (doc, body = {}) {
  if (body.capital !== undefined) doc.capital = +body.capital || doc.capital || 10000;
  if (body.risk !== undefined) doc.riskPerTradePct = +body.risk || doc.riskPerTradePct || 2;
  if (body.riskPerTradePct !== undefined) doc.riskPerTradePct = +body.riskPerTradePct || doc.riskPerTradePct || 2;
  if (body.lotSize !== undefined) doc.lotSize = Math.max(1, Math.round(+body.lotSize || 1));
  if (body.positionSizePct !== undefined) doc.positionSizePct = Math.max(0, +body.positionSizePct || 0);
  if (body.minProfitBookingPct !== undefined) doc.minProfitBookingPct = Math.max(0, +body.minProfitBookingPct || 0);
  if (body.profitRatioBooking !== undefined) doc.profitRatioBooking = Math.max(0.1, +body.profitRatioBooking || 1.67);
  if (body.exchangeEnabled !== undefined) doc.exchangeEnabled = Boolean(body.exchangeEnabled);
  if (body.exchangeProvider !== undefined && providerMeta(String(body.exchangeProvider))) {
    doc.exchangeProvider = String(body.exchangeProvider);
  } else if (!doc.exchangeProvider) {
    doc.exchangeProvider = 'delta-demo';
  }
}

function pineStrategyOptions (doc) {
  return {
    capital: doc.capital || 10000,
    riskPerTradePct: doc.riskPerTradePct || 2,
    lotSize: doc.lotSize || 1,
    positionSizePct: doc.positionSizePct ?? 10,
    minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
    profitRatioBooking: doc.profitRatioBooking ?? 1.67,
  };
}

function allInOneRunnerId (key) {
  return `allinone:${key}`;
}

function allInOneDefaultConfig (def) {
  return {
    key: def.key,
    name: def.name,
    timeframe: '5m',
    capital: 1000,
    ...ALL_IN_ONE_AUTO_RISK,
    exchangeEnabled: false,
    exchangeProvider: 'delta-demo',
    isActive: false,
  };
}

async function ensureAllInOneConfigs () {
  await Promise.all(ALL_IN_ONE_DEFINITIONS.map(def => {
    const insertDefaults = allInOneDefaultConfig(def);
    delete insertDefaults.name;
    return AllInOneStrategyConfig.updateOne(
      { key: def.key },
      { $setOnInsert: insertDefaults, $set: { name: def.name } },
      { upsert: true }
    );
  }));
}

function allInOneListItem (doc) {
  return {
    key: doc.key,
    name: doc.name,
    timeframe: doc.timeframe || '5m',
    capital: doc.capital || 1000,
    riskPerTradePct: doc.riskPerTradePct || 1,
    atrLength: doc.atrLength || 14,
    slMultiplier: doc.slMultiplier || 2,
    tpMultiplier: doc.tpMultiplier || 4,
    trailOffset: doc.trailOffset || 1.5,
    exchangeEnabled: Boolean(doc.exchangeEnabled),
    exchangeProvider: doc.exchangeProvider || 'delta-demo',
    isActive: Boolean(doc.isActive),
    updatedAt: doc.updatedAt,
  };
}

function allInOneStrategyOptions (doc) {
  return {
    strategyKey: doc.key,
    timeframe: TIMEFRAME_MS[doc.timeframe] ? doc.timeframe : '5m',
    capital: doc.capital || 1000,
    ...ALL_IN_ONE_AUTO_RISK,
  };
}

function applyAllInOneRuntimeOptions (doc, body = {}) {
  if (body.timeframe !== undefined && TIMEFRAME_MS[String(body.timeframe)]) doc.timeframe = String(body.timeframe);
  if (body.capital !== undefined) doc.capital = Math.max(100, Number(body.capital) || doc.capital || 1000);
  Object.assign(doc, ALL_IN_ONE_AUTO_RISK);
  if (body.exchangeEnabled !== undefined) doc.exchangeEnabled = Boolean(body.exchangeEnabled);
  if (body.exchangeProvider !== undefined && providerMeta(String(body.exchangeProvider))) doc.exchangeProvider = String(body.exchangeProvider);
  if (!doc.exchangeProvider) doc.exchangeProvider = 'delta-demo';
}

function allInOneAggregateStatus () {
  const runners = [...allInOneRunners.values()];
  const runningRunners = runners.filter(r => r.running);
  return {
    id: 'allinone',
    running: runningRunners.length > 0,
    paused: runningRunners.length > 0 && runningRunners.every(r => r.paused),
    warmedUp: runningRunners.length > 0 && runningRunners.every(r => r.strategy.warmedUp),
    count: runners.length,
    runningCount: runningRunners.length,
  };
}

async function allInOneRunnerSnapshot (doc) {
  const item = allInOneListItem(doc);
  const runner = allInOneRunners.get(item.key);
  const status = runner?._status() || { id: allInOneRunnerId(item.key), running: false, paused: false, warmedUp: false };
  const session = runner ? await runner.buildSessionInfo().catch(() => null) : null;
  return {
    ...item,
    runnerId: allInOneRunnerId(item.key),
    status,
    session,
    stats: runner ? runner.strategy.getFullState() : null,
  };
}

async function listAllInOneDetailed () {
  await ensureAllInOneConfigs();
  const docs = await AllInOneStrategyConfig.find().sort({ key: 1 }).lean();
  const order = new Map(ALL_IN_ONE_DEFINITIONS.map((def, index) => [def.key, index]));
  docs.sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
  return Promise.all(docs.map(allInOneRunnerSnapshot));
}

function commonAllInOneSettings (doc) {
  return {
    timeframe: doc?.timeframe || '5m',
    capital: doc?.capital || 1000,
    exchangeEnabled: Boolean(doc?.exchangeEnabled),
    exchangeProvider: doc?.exchangeProvider || 'delta-demo',
    autoRisk: ALL_IN_ONE_AUTO_RISK,
  };
}

async function saveCommonAllInOneSettings (body = {}) {
  await ensureAllInOneConfigs();
  const patch = {
    timeframe: TIMEFRAME_MS[String(body.timeframe)] ? String(body.timeframe) : '5m',
    capital: Math.max(100, Number(body.capital) || 1000),
    exchangeEnabled: Boolean(body.exchangeEnabled),
    exchangeProvider: providerMeta(String(body.exchangeProvider)) ? String(body.exchangeProvider) : 'delta-demo',
    ...ALL_IN_ONE_AUTO_RISK,
  };
  await AllInOneStrategyConfig.updateMany({}, { $set: patch });
  for (const runner of allInOneRunners.values()) {
    runner.executionEnabled = Boolean(patch.exchangeEnabled);
    if (!runner.running) {
      runner.strategy.reset({
        strategyKey: runner.strategy.strategyKey,
        timeframe: patch.timeframe,
        capital: patch.capital,
        ...ALL_IN_ONE_AUTO_RISK,
      });
    }
  }
  return patch;
}

async function emitAllInOneState () {
  io.emit('allinone:status', allInOneAggregateStatus());
  io.emit('allinone:runners', await listAllInOneDetailed());
  io.emit('all_status', manager.allStatus());
}

function utBotDefaultConfig () {
  return {
    key: 'utbot',
    name: 'UT Bot Alerts',
    timeframe: '5m',
    capital: 1000,
    keyValue: 1,
    atrPeriod: 10,
    useHeikinAshi: false,
    buyFeePct: 0,
    sellFeePct: 0,
    exchangeEnabled: false,
    exchangeProvider: 'delta-demo',
    isActive: false,
  };
}

async function ensureUTBotConfig () {
  const defaults = utBotDefaultConfig();
  delete defaults.name;
  await UTBotConfig.updateOne(
    { key: 'utbot' },
    { $setOnInsert: defaults, $set: { name: 'UT Bot Alerts' } },
    { upsert: true }
  );
  return UTBotConfig.findOne({ key: 'utbot' });
}

function applyUTBotRuntimeOptions (doc, body = {}) {
  if (body.timeframe !== undefined && TIMEFRAME_MS[String(body.timeframe)]) doc.timeframe = String(body.timeframe);
  if (body.capital !== undefined) doc.capital = Math.max(100, Number(body.capital) || doc.capital || 1000);
  if (body.keyValue !== undefined) doc.keyValue = Math.max(0.1, Number(body.keyValue) || 1);
  if (body.atrPeriod !== undefined) doc.atrPeriod = Math.max(2, Math.round(Number(body.atrPeriod) || 10));
  if (body.useHeikinAshi !== undefined) doc.useHeikinAshi = Boolean(body.useHeikinAshi);
  if (body.buyFeePct !== undefined) doc.buyFeePct = Math.max(0, Number(body.buyFeePct) || 0);
  if (body.sellFeePct !== undefined) doc.sellFeePct = Math.max(0, Number(body.sellFeePct) || 0);
  if (body.exchangeEnabled !== undefined) doc.exchangeEnabled = Boolean(body.exchangeEnabled);
  if (body.exchangeProvider !== undefined && providerMeta(String(body.exchangeProvider))) doc.exchangeProvider = String(body.exchangeProvider);
  if (!doc.exchangeProvider) doc.exchangeProvider = 'delta-demo';
}

function utBotStrategyOptions (doc) {
  return {
    timeframe: doc.timeframe || '5m',
    capital: doc.capital || 1000,
    keyValue: doc.keyValue || 1,
    atrPeriod: doc.atrPeriod || 10,
    useHeikinAshi: Boolean(doc.useHeikinAshi),
    buyFeePct: doc.buyFeePct || 0,
    sellFeePct: doc.sellFeePct || 0,
  };
}

function utBotConfigView (doc) {
  return {
    key: 'utbot',
    name: doc.name || 'UT Bot Alerts',
    timeframe: doc.timeframe || '5m',
    capital: doc.capital || 1000,
    keyValue: doc.keyValue || 1,
    atrPeriod: doc.atrPeriod || 10,
    useHeikinAshi: Boolean(doc.useHeikinAshi),
    buyFeePct: doc.buyFeePct || 0,
    sellFeePct: doc.sellFeePct || 0,
    exchangeEnabled: Boolean(doc.exchangeEnabled),
    exchangeProvider: doc.exchangeProvider || 'delta-demo',
    isActive: Boolean(doc.isActive),
    updatedAt: doc.updatedAt,
  };
}

function utBotAggregateStatus () {
  const running = Boolean(utBotRunner?.running);
  return {
    id: 'utbot',
    running,
    paused: Boolean(utBotRunner?.paused),
    warmedUp: Boolean(utBotRunner?.strategy?.warmedUp),
    runningCount: running ? 1 : 0,
  };
}

async function utBotSnapshot (doc) {
  const runner = utBotRunner;
  return {
    ...utBotConfigView(doc),
    runnerId: 'utbot',
    status: runner?._status() || { id: 'utbot', running: false, paused: false, warmedUp: false },
    session: runner ? await runner.buildSessionInfo().catch(() => null) : null,
    stats: runner ? runner.strategy.getFullState() : null,
  };
}

async function emitUTBotState () {
  const doc = await ensureUTBotConfig();
  io.emit('utbot:status', utBotAggregateStatus());
  io.emit('utbot:state', await utBotSnapshot(doc));
  io.emit('all_status', manager.allStatus());
}

function hookUTBotRunnerEvents (runner) {
  if (runner._utBotHooked) return;
  runner._utBotHooked = true;
  const rawEmit = runner.emit.bind(runner);
  runner.emit = (event, data) => {
    rawEmit(event, data);
    io.emit('utbot:runner_event', {
      runnerId: runner.id,
      event,
      data,
      status: runner._status(),
      stats: runner.strategy.getFullState(),
    });
    if (['status', 'stats', 'session_info', 'position_opened', 'trade_closed', 'warmed_up'].includes(event)) {
      emitUTBotState().catch(e => console.error('[UTBOT] emit state failed:', e.message));
    }
  };
}

function ensureUTBotRunner (doc) {
  if (!utBotRunner) {
    utBotRunner = new StrategyRunner(
      'utbot',
      new UTBotStrategy(utBotStrategyOptions(doc)),
      io,
      {
        sessionStrategyType: 'utbot',
        displayName: 'UT Bot Alerts',
        executionAdapter: deltaClient,
        executionEnabled: Boolean(doc.exchangeEnabled),
        onExchangeOrder: queueExchangeOrderSync,
      }
    );
    manager.addRunner(utBotRunner);
    hookUTBotRunnerEvents(utBotRunner);
    utBotRunner.wire();
  } else {
    utBotRunner.executionEnabled = Boolean(doc.exchangeEnabled);
    utBotRunner.displayName = 'UT Bot Alerts';
    if (!utBotRunner.running) utBotRunner.strategy.reset(utBotStrategyOptions(doc));
    utBotRunner.wire();
  }
  return utBotRunner;
}

function hookAllInOneRunnerEvents (runner, key) {
  if (runner._allInOneHooked) return;
  runner._allInOneHooked = true;
  const rawEmit = runner.emit.bind(runner);
  runner.emit = (event, data) => {
    rawEmit(event, data);
    io.emit('allinone:runner_event', {
      key,
      runnerId: runner.id,
      event,
      data,
      status: runner._status(),
      stats: runner.strategy.getFullState(),
    });
    if (['status', 'stats', 'session_info', 'position_opened', 'trade_closed', 'warmed_up'].includes(event)) {
      emitAllInOneState().catch(e => console.error('[ALLINONE] emit state failed:', e.message));
    }
  };
}

function ensureAllInOneRunner (doc) {
  const key = doc.key;
  let runner = allInOneRunners.get(key);
  if (!runner) {
    runner = new StrategyRunner(
      allInOneRunnerId(key),
      new AllInOneStrategy(allInOneStrategyOptions(doc)),
      io,
      {
        sessionStrategyType: allInOneRunnerId(key),
        displayName: doc.name,
        executionAdapter: deltaClient,
        executionEnabled: Boolean(doc.exchangeEnabled),
        onExchangeOrder: queueExchangeOrderSync,
      }
    );
    allInOneRunners.set(key, runner);
    manager.addRunner(runner);
    hookAllInOneRunnerEvents(runner, key);
    runner.wire();
  } else {
    runner.displayName = doc.name;
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (!runner.running) runner.strategy.reset(allInOneStrategyOptions(doc));
    runner.wire();
  }
  return runner;
}

const STRATEGY_LABELS = {
  scalping: 'EMA Scalping',
  breakout: 'Range Breakout',
  heikenashi: 'Heikin-Ashi SuperTrend',
  pine: 'Pine Strategy',
  utbot: 'UT Bot Alerts',
};

function idString (value) {
  return value?.toString?.() || (value ? String(value) : null);
}

function exchangeSecretKey () {
  return crypto
    .createHash('sha256')
    .update(process.env.EXCHANGE_KEY_SECRET || DASHBOARD_PWD || process.env.MONGO_URI || 'scpbot-local-key')
    .digest();
}

function encryptExchangeSecret (value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', exchangeSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptExchangeSecret (payload) {
  if (!payload) return '';
  try {
    const [ivRaw, tagRaw, encryptedRaw] = String(payload).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', exchangeSecretKey(), Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function maskSecret (value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}****${text.slice(-2)}`;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function providerMeta (provider) {
  return EXCHANGE_PROVIDERS.find(p => p.provider === provider) || null;
}

function exchangeCredentialView (doc, status) {
  const apiKey = decryptExchangeSecret(doc?.apiKeyEncrypted);
  return {
    provider: doc?.provider || status?.provider || 'delta-demo',
    name: providerMeta(doc?.provider || status?.provider)?.name || 'Delta Exchange Demo',
    enabled: Boolean(doc?.enabled ?? status?.enabled),
    configured: Boolean(apiKey && doc?.apiSecretEncrypted) || Boolean(status?.configured),
    credentialSource: doc ? 'database' : (status?.credentialSource || 'env'),
    maskedApiKey: apiKey ? maskSecret(apiKey) : '',
    baseUrl: doc?.baseUrl || status?.baseUrl || '',
    productSymbol: doc?.productSymbol || status?.productSymbol || 'BTCUSD',
    productId: doc?.productId || status?.productId || null,
    lastError: status?.lastError || null,
    configuredAt: doc?.configuredAt || doc?.updatedAt || null,
  };
}

async function applySavedExchangeCredentials () {
  const doc = await ExchangeCredential.findOne({ provider: 'delta-demo' }).lean().catch(() => null);
  if (!doc) return;
  deltaClient.configure({
    apiKey: decryptExchangeSecret(doc.apiKeyEncrypted),
    apiSecret: decryptExchangeSecret(doc.apiSecretEncrypted),
    baseUrl: doc.baseUrl,
    productSymbol: doc.productSymbol,
    productId: doc.productId,
    enabled: doc.enabled,
    credentialSource: 'database',
  });
}

function strategyNameForSession (session, pineMap) {
  if (!session) return 'Unknown Strategy';
  const type = session.strategyType || 'scalping';
  if (type === 'pine') {
    const pine = pineMap.get(idString(session.pineScriptId));
    return pine ? `Pine: ${pine.name}` : 'Pine Strategy';
  }
  if (type.startsWith?.('allinone:')) {
    const key = type.slice('allinone:'.length);
    return ALL_IN_ONE_DEFINITIONS.find(def => def.key === key)?.name || type;
  }
  return STRATEGY_LABELS[type] || type;
}

function sessionRunnerId (session) {
  if (!session) return null;
  if (session.strategyType === 'pine' && session.pineScriptId) return pineRunnerId(idString(session.pineScriptId));
  return session.strategyType || 'scalping';
}

function calcUnrealizedPnl (position, markPrice) {
  if (!position || !Number.isFinite(markPrice)) return { pnl: null, pnlPct: null };
  const pnl = position.type === 'short'
    ? (position.entry - markPrice) * position.qty
    : (markPrice - position.entry) * position.qty;
  return {
    pnl,
    pnlPct: position.entry && position.qty ? pnl / (position.entry * position.qty) * 100 : null,
  };
}

async function runBackendExchangeSync (reason = 'timer') {
  if (!deltaClient.status().enabled || exchangeSyncInFlight) return latestExchangeSync;
  exchangeSyncInFlight = true;
  try {
    const sync = await deltaClient.syncAccount({ pageSize: 50 });
    latestExchangeSync = {
      ...sync,
      reason,
      runningBots: Object.values(manager.runners).filter(r => r.running).length,
    };
    io.emit('exchange:sync', {
      provider: latestExchangeSync.provider,
      productSymbol: latestExchangeSync.product?.symbol || deltaClient.status().productSymbol,
      syncedAt: latestExchangeSync.syncedAt,
      openCount: latestExchangeSync.summary?.openCount || 0,
      closedCount: latestExchangeSync.summary?.closedCount || 0,
      openPnl: latestExchangeSync.summary?.openPnl || 0,
      closedPnl: latestExchangeSync.summary?.closedPnl || 0,
      netPnl: latestExchangeSync.summary?.netPnl || 0,
      errors: latestExchangeSync.errors || [],
      reason,
    });
    return latestExchangeSync;
  } catch (err) {
    deltaClient.lastError = err.message;
    latestExchangeSync = {
      provider: 'delta-demo',
      syncedAt: new Date().toISOString(),
      reason,
      errors: [err.message],
      summary: { openCount: 0, closedCount: 0, openPnl: 0, closedPnl: 0, netPnl: 0 },
    };
    io.emit('exchange:sync', latestExchangeSync);
    console.error('[DELTA] Background sync failed:', err.message);
    return latestExchangeSync;
  } finally {
    exchangeSyncInFlight = false;
  }
}

function startBackendExchangeSync () {
  if (exchangeSyncTimer || !deltaClient.status().enabled) return;
  runBackendExchangeSync('boot').catch(() => {});
  exchangeSyncTimer = setInterval(() => {
    runBackendExchangeSync('timer').catch(() => {});
  }, EXCHANGE_SYNC_INTERVAL_MS);
}

function queueExchangeOrderSync () {
  if (!deltaClient.status().enabled) return;
  if (exchangeOrderSyncTimer) clearTimeout(exchangeOrderSyncTimer);
  exchangeOrderSyncTimer = setTimeout(() => {
    exchangeOrderSyncTimer = null;
    runBackendExchangeSync('order').catch(() => {});
  }, 1500);
}

function startStrategyWatchdog () {
  if (strategyWatchdogTimer) return;
  strategyWatchdogTimer = setInterval(() => {
    const runningCount = Object.values(manager.runners).filter(r => r.running).length;
    if (!runningCount) return;
    manager.ensureWs();
    startBackendExchangeSync();
    io.emit('all_status', manager.allStatus());
  }, STRATEGY_WATCHDOG_INTERVAL_MS);
}

function backendExchangeSyncStatus () {
  return {
    enabled: Boolean(exchangeSyncTimer && deltaClient.status().enabled),
    inFlight: exchangeSyncInFlight,
    intervalMs: EXCHANGE_SYNC_INTERVAL_MS,
    latest: latestExchangeSync
      ? {
          syncedAt: latestExchangeSync.syncedAt,
          reason: latestExchangeSync.reason,
          runningBots: latestExchangeSync.runningBots || 0,
          summary: latestExchangeSync.summary || null,
          errors: latestExchangeSync.errors || [],
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/strategy/:id/status', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try { res.json({ ...runner._status(), session: await runner.buildSessionInfo() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/strategy/:id/start', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try { await startRunner(runner, { createNew: false }); res.json({ ok: true, sessionId: runner.sessionId }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/strategy/:id/stop', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try {
    await runner.stop(); manager.maybeStopWs(); io.emit('all_status', manager.allStatus());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/strategy/:id/pause', (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  runner.pause(); io.emit('all_status', manager.allStatus()); res.json({ ok: true });
});

app.post('/api/strategy/:id/resume', (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  runner.resume(); io.emit('all_status', manager.allStatus()); res.json({ ok: true });
});

app.post('/api/strategy/:id/reset', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try {
    const { capital, risk } = req.body;
    await runner.reset({ ...(capital && { capital: +capital }), ...(risk && { riskPerTradePct: +risk }) });
    manager.maybeStopWs(); io.emit('all_status', manager.allStatus());
    await manager.sendSessionsList(io); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/strategy/:id/new', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try {
    const { capital = 10000, risk = 2 } = req.body;
    await runner.reset({ capital: +capital, riskPerTradePct: +risk });
    await startRunner(runner, { createNew: true });
    res.json({ ok: true, sessionId: runner.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/strategy/:id/trades', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try { res.json(await runner.recentTrades()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/strategy/:id/equity', async (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  try { res.json(await runner.equityHistory()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/strategy/:id/stats', (req, res) => {
  const runner = manager.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: 'Unknown strategy' });
  res.json(runner.strategy.getFullState());
});

app.get('/api/delta/status', (_req, res) => {
  res.json({ ...deltaClient.status(), backendSync: backendExchangeSyncStatus() });
});

app.get('/api/exchanges', async (_req, res) => {
  try {
    const docs = await ExchangeCredential.find().lean();
    const docMap = new Map(docs.map(doc => [doc.provider, doc]));
    res.json({
      exchanges: EXCHANGE_PROVIDERS.map(meta => exchangeCredentialView(
        docMap.get(meta.provider),
        meta.provider === 'delta-demo' ? deltaClient.status() : { provider: meta.provider, enabled: false, configured: false }
      )),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchanges/:provider', async (req, res) => {
  try {
    const provider = String(req.params.provider || '').trim();
    const meta = providerMeta(provider);
    if (!meta) return res.status(400).json({ error: 'Unsupported exchange provider' });

    const existing = await ExchangeCredential.findOne({ provider }).lean();
    const body = req.body || {};
    const apiKeyInput = String(body.apiKey || '').trim();
    const apiSecretInput = String(body.apiSecret || '').trim();
    const apiKey = apiKeyInput || decryptExchangeSecret(existing?.apiKeyEncrypted);
    const apiSecret = apiSecretInput || decryptExchangeSecret(existing?.apiSecretEncrypted);
    const enabled = Boolean(body.enabled);
    if (enabled && (!apiKey || !apiSecret)) {
      return res.status(400).json({ error: 'API key and API secret are required before enabling this exchange' });
    }

    let baseUrl = String(body.baseUrl || existing?.baseUrl || deltaClient.status().baseUrl || '').trim();
    if (baseUrl) {
      try { baseUrl = new URL(baseUrl).toString().replace(/\/$/, ''); }
      catch (e) { return res.status(400).json({ error: 'Exchange base URL is invalid' }); }
    }
    const productSymbol = String(body.productSymbol || existing?.productSymbol || deltaClient.status().productSymbol || 'BTCUSD').trim().toUpperCase();
    const rawProductId = body.productId !== undefined
      ? String(body.productId).trim()
      : (existing?.productId || deltaClient.status().productId || '');
    const productIdValue = rawProductId ? Number(rawProductId) : null;
    if (rawProductId && (!Number.isFinite(productIdValue) || productIdValue <= 0)) {
      return res.status(400).json({ error: 'Product ID must be a positive number' });
    }
    const productId = productIdValue ? Math.round(productIdValue) : null;

    const doc = await ExchangeCredential.findOneAndUpdate(
      { provider },
      {
        provider,
        name: meta.name,
        enabled,
        apiKeyEncrypted: encryptExchangeSecret(apiKey),
        apiSecretEncrypted: encryptExchangeSecret(apiSecret),
        baseUrl,
        productSymbol,
        productId,
        credentialSource: 'database',
        configuredAt: new Date(),
      },
      { upsert: true, new: true }
    ).lean();

    await applySavedExchangeCredentials();
    startBackendExchangeSync();
    res.json({ ok: true, exchange: exchangeCredentialView(doc, deltaClient.status()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/positions', async (req, res) => {
  try {
    const requestedPineId = req.query.pineScriptId ? String(req.query.pineScriptId) : null;
    const directRunnerId = req.query.runnerId ? String(req.query.runnerId) : null;
    const requestedRunnerId = directRunnerId || (requestedPineId ? pineRunnerId(requestedPineId) : null);
    const scopeTopLevelToRunner = Boolean(directRunnerId);
    const fromMs = req.query.fromDate ? Date.parse(req.query.fromDate) : null;
    const toMs = req.query.toDate ? Date.parse(req.query.toDate) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const tradeQuery = {};
    if (Number.isFinite(fromMs) || Number.isFinite(toMs)) {
      tradeQuery.exitTime = {};
      if (Number.isFinite(fromMs)) tradeQuery.exitTime.$gte = fromMs;
      if (Number.isFinite(toMs)) tradeQuery.exitTime.$lte = toMs;
    }

    const [openDocs, tradeDocs] = await Promise.all([
      Position.find().sort({ updatedAt: -1 }).lean(),
      Trade.find(tradeQuery).sort({ exitTime: -1 }).limit(limit).lean(),
    ]);

    const sessionIds = [...new Set(
      [...openDocs, ...tradeDocs]
        .map(item => idString(item.sessionId))
        .filter(Boolean)
    )];
    const sessions = sessionIds.length
      ? await Session.find({ _id: { $in: sessionIds } }).lean()
      : [];
    const sessionMap = new Map(sessions.map(s => [idString(s._id), s]));
    const pineIds = [...new Set(sessions.map(s => idString(s.pineScriptId)).filter(Boolean))];
    const pineDocs = pineIds.length
      ? await PineScriptConfig.find({ _id: { $in: pineIds } }).lean()
      : [];
    const pineMap = new Map(pineDocs.map(p => [idString(p._id), p]));
    const lastCandle = manager.latestCandles[manager.latestCandles.length - 1];
    const markPrice = manager.currentTicker?.price || lastCandle?.close || null;
    const botStatus = {
      all: manager.allStatus(),
      pine: pineAggregateStatus(),
      runningCount: Object.values(manager.runners).filter(r => r.running).length,
    };
    const exchangeOrders = await ExchangeOrder.find().sort({ createdAt: -1 }).limit(100).lean();

    if (deltaClient.status().enabled) {
      try {
        const deltaSync = await deltaClient.syncAccount({ fromMs: Number.isFinite(fromMs) ? fromMs : 0, toMs: Number.isFinite(toMs) ? toMs : 0, pageSize: 50 });
        latestExchangeSync = {
          ...deltaSync,
          reason: req.query.force === '1' ? 'force' : 'api',
          runningBots: botStatus.runningCount,
        };
        const auditByOrder = new Map();
        const auditByClient = new Map();
        for (const order of exchangeOrders) {
          const orderId = order.response?.result?.id || order.response?.id;
          if (orderId) auditByOrder.set(String(orderId), order);
          if (order.clientOrderId) auditByClient.set(String(order.clientOrderId), order);
        }
        const auditForFill = fill => auditByOrder.get(String(fill?.order_id || '')) || auditByClient.get(String(fill?.client_order_id || '')) || null;
        const lastOpenAudit = exchangeOrders.find(o => o.action === 'open' && o.status === 'sent');
        const selectedOpenAudit = requestedRunnerId
          ? exchangeOrders.find(o => o.action === 'open' && o.status === 'sent' && o.runnerId === requestedRunnerId)
          : null;
        const defaultOpenAudit = requestedRunnerId ? selectedOpenAudit : lastOpenAudit;
        const enrichTrade = trade => {
          const audit = auditForFill(trade.exchange?.openFill) || auditForFill(trade.exchange?.closeFill);
          return {
            ...trade,
            strategyName: audit?.strategyName || trade.strategyName,
            strategyType: audit?.strategyType || trade.strategyType,
            runnerId: audit?.runnerId || trade.runnerId,
            shortId: idString(audit?.sessionId)?.slice(-6).toUpperCase() || null,
          };
        };
        const open = deltaSync.positions.map(p => ({
          ...p,
          strategyName: defaultOpenAudit?.strategyName || p.strategyName,
          strategyType: defaultOpenAudit?.strategyType || p.strategyType,
          runnerId: defaultOpenAudit?.runnerId || p.runnerId,
          pineScriptId: idString(defaultOpenAudit?.pineScriptId) || null,
          shortId: idString(defaultOpenAudit?.sessionId)?.slice(-6).toUpperCase() || null,
          markPrice: p.markPrice || markPrice,
        }));
        const closed = deltaSync.trades.map(enrichTrade);
        const selectedClosed = requestedRunnerId ? closed.filter(t => t.runnerId === requestedRunnerId) : closed;
        const selectedOpen = requestedRunnerId ? open.filter(p => p.runnerId === requestedRunnerId) : open;
        const visibleOpen = scopeTopLevelToRunner ? selectedOpen : open;
        const visibleClosed = scopeTopLevelToRunner ? selectedClosed : closed;
        const visibleExchangeOrders = scopeTopLevelToRunner ? exchangeOrders.filter(o => o.runnerId === requestedRunnerId) : exchangeOrders;
        const selectedOpenPnl = selectedOpen.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
        const selectedClosedPnl = selectedClosed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
        const visibleOpenPnl = visibleOpen.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
        const visibleClosedPnl = visibleClosed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
        return res.json({
          markPrice,
          summary: {
            openCount: visibleOpen.length,
            closedCount: visibleClosed.length,
            openPnl: visibleOpenPnl,
            closedPnl: visibleClosedPnl,
            netPnl: visibleOpenPnl + visibleClosedPnl,
          },
          source: 'delta',
          selected: requestedRunnerId ? {
            runnerId: requestedRunnerId,
            pineScriptId: requestedPineId,
            open: selectedOpen,
            closed: selectedClosed,
            summary: {
              openCount: selectedOpen.length,
              closedCount: selectedClosed.length,
              openPnl: selectedOpenPnl,
              closedPnl: selectedClosedPnl,
              netPnl: selectedOpenPnl + selectedClosedPnl,
            },
          } : null,
          botStatus,
          delta: { ...deltaClient.status(), lastSyncAt: deltaSync.syncedAt, syncErrors: deltaSync.errors, backendSync: backendExchangeSyncStatus() },
          open: visibleOpen,
          closed: visibleClosed,
          exchangeOrders: visibleExchangeOrders.map(o => ({
            id: idString(o._id),
            provider: o.provider,
            action: o.action,
            status: o.status,
            runnerId: o.runnerId,
            strategyType: o.strategyType,
            strategyName: o.strategyName,
            positionType: o.positionType,
            side: o.side,
            productSymbol: o.productSymbol,
            size: o.size,
            requestedQty: o.requestedQty,
            error: o.error,
            createdAt: o.createdAt,
          })),
        });
      } catch (syncError) {
        deltaClient.lastError = syncError.message;
      }
    }

    const open = openDocs.map(p => {
      const session = sessionMap.get(idString(p.sessionId));
      const pnl = calcUnrealizedPnl(p, markPrice);
      return {
        id: idString(p._id),
        state: 'open',
        sessionId: idString(p.sessionId),
        shortId: idString(p.sessionId)?.slice(-6).toUpperCase() || null,
        strategyType: session?.strategyType || null,
        strategyName: strategyNameForSession(session, pineMap),
        runnerId: sessionRunnerId(session),
        pineScriptId: idString(session?.pineScriptId),
        type: p.type,
        entry: p.entry,
        markPrice,
        qty: p.qty,
        sl: p.sl,
        tp: p.tp,
        trailSl: p.trailSl,
        pnl: pnl.pnl,
        pnlPct: pnl.pnlPct,
        entryTime: p.entryTime,
        updatedAt: p.updatedAt,
      };
    });

    const closed = tradeDocs.map(t => {
      const session = sessionMap.get(idString(t.sessionId));
      return {
        id: idString(t._id),
        state: 'closed',
        sessionId: idString(t.sessionId),
        shortId: idString(t.sessionId)?.slice(-6).toUpperCase() || null,
        strategyType: session?.strategyType || null,
        strategyName: strategyNameForSession(session, pineMap),
        runnerId: sessionRunnerId(session),
        pineScriptId: idString(session?.pineScriptId),
        tradeNum: t.tradeNum,
        type: t.type,
        entry: t.entry,
        exit: t.exit,
        qty: t.qty,
        sl: t.sl,
        tp: t.tp,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        reason: t.reason,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
      };
    });

    const selectedOpen = requestedRunnerId ? open.filter(p => p.runnerId === requestedRunnerId) : open;
    const selectedClosed = requestedRunnerId ? closed.filter(t => t.runnerId === requestedRunnerId) : closed;
    const visibleOpen = scopeTopLevelToRunner ? selectedOpen : open;
    const visibleClosed = scopeTopLevelToRunner ? selectedClosed : closed;
    const visibleExchangeOrders = scopeTopLevelToRunner ? exchangeOrders.filter(o => o.runnerId === requestedRunnerId) : exchangeOrders;
    const openPnl = visibleOpen.reduce((sum, p) => sum + (Number.isFinite(p.pnl) ? p.pnl : 0), 0);
    const closedPnl = visibleClosed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const selectedOpenPnl = selectedOpen.reduce((sum, p) => sum + (Number.isFinite(p.pnl) ? p.pnl : 0), 0);
    const selectedClosedPnl = selectedClosed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);

    res.json({
      markPrice,
      summary: {
        openCount: visibleOpen.length,
        closedCount: visibleClosed.length,
        openPnl,
        closedPnl,
        netPnl: openPnl + closedPnl,
      },
      source: 'local',
      selected: requestedRunnerId ? {
        runnerId: requestedRunnerId,
        pineScriptId: requestedPineId,
        open: selectedOpen,
        closed: selectedClosed,
        summary: {
          openCount: selectedOpen.length,
          closedCount: selectedClosed.length,
          openPnl: selectedOpenPnl,
          closedPnl: selectedClosedPnl,
          netPnl: selectedOpenPnl + selectedClosedPnl,
        },
      } : null,
      botStatus,
      delta: { ...deltaClient.status(), backendSync: backendExchangeSyncStatus() },
      open: visibleOpen,
      closed: visibleClosed,
      exchangeOrders: visibleExchangeOrders.map(o => ({
        id: idString(o._id),
        provider: o.provider,
        action: o.action,
        status: o.status,
        runnerId: o.runnerId,
        strategyType: o.strategyType,
        strategyName: o.strategyName,
        positionType: o.positionType,
        side: o.side,
        productSymbol: o.productSymbol,
        size: o.size,
        requestedQty: o.requestedQty,
        error: o.error,
        createdAt: o.createdAt,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/candles',  (_req, res) => res.json(manager.latestCandles));

app.get('/api/pine/config', async (_req, res) => {
  try {
    const cfg = await PineScriptConfig.findOne().sort({ isActive: -1, updatedAt: -1 }).lean();
    const runner = cfg ? pineRunners.get(cfg._id.toString()) : null;
    res.json({
      id: cfg?._id?.toString() || null,
      name: cfg?.name || 'Uploaded Pine',
      code: cfg?.code || '',
      meta: cfg?.meta || runner?.strategy.scriptMeta() || { hasScript: false },
      capital: cfg?.capital || 10000,
      riskPerTradePct: cfg?.riskPerTradePct || 2,
      lotSize: cfg?.lotSize || 1,
      positionSizePct: cfg?.positionSizePct ?? 10,
      minProfitBookingPct: cfg?.minProfitBookingPct ?? 0.5,
      profitRatioBooking: cfg?.profitRatioBooking ?? 1.67,
      exchangeEnabled: Boolean(cfg?.exchangeEnabled),
      exchangeProvider: cfg?.exchangeProvider || 'delta-demo',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/upload', async (req, res) => {
  try {
    const {
      name = 'Uploaded Pine',
      code = '',
      capital,
      risk,
      lotSize = 1,
      positionSizePct = 0,
      minProfitBookingPct = 0.5,
      profitRatioBooking = 1.67,
      exchangeEnabled = false,
      exchangeProvider = 'delta-demo',
      autoStart = false,
      setActive = false,
    } = req.body || {};
    if (!code.trim()) return res.status(400).json({ error: 'Pine code is required' });
    if (code.length > 500000) return res.status(400).json({ error: 'Pine code is too large' });
    if (!providerMeta(String(exchangeProvider))) return res.status(400).json({ error: 'Unsupported exchange provider' });

    const safeCapital = +capital || 10000;
    const safeRisk = +risk || 2;
    const safeLotSize = Math.max(1, Math.round(+lotSize || 1));
    const safePositionSizePct = Math.max(0, +positionSizePct || 0);
    const safeMinProfitBookingPct = Math.max(0, +minProfitBookingPct || 0);
    const safeProfitRatioBooking = Math.max(0.1, +profitRatioBooking || 1.67);
    const temp = new PineScriptStrategy({
      name: String(name).slice(0, 80),
      code,
      capital: safeCapital,
      riskPerTradePct: safeRisk,
      lotSize: safeLotSize,
      positionSizePct: safePositionSizePct,
      minProfitBookingPct: safeMinProfitBookingPct,
      profitRatioBooking: safeProfitRatioBooking,
    });
    const meta = temp.scriptMeta();
    const doc = await PineScriptConfig.create({
      name: temp.scriptName,
      code,
      meta,
      capital: safeCapital,
      riskPerTradePct: safeRisk,
      lotSize: safeLotSize,
      positionSizePct: safePositionSizePct,
      minProfitBookingPct: safeMinProfitBookingPct,
      profitRatioBooking: safeProfitRatioBooking,
      exchangeEnabled: Boolean(exchangeEnabled),
      exchangeProvider: String(exchangeProvider),
      isActive: Boolean(setActive || autoStart),
    });

    let runner = null;
    if (setActive || autoStart) {
      runner = await setActivePineScript(doc);
      await runner.reset({
        capital: safeCapital,
        riskPerTradePct: safeRisk,
        lotSize: safeLotSize,
        positionSizePct: safePositionSizePct,
        minProfitBookingPct: safeMinProfitBookingPct,
        profitRatioBooking: safeProfitRatioBooking,
      });
      if (autoStart) await startRunner(runner, { createNew: true });
    } else {
      await emitPineState();
    }

    await manager.sendSessionsList(io);
    res.json({
      ok: true,
      id: doc._id.toString(),
      runnerId: pineRunnerId(doc._id.toString()),
      meta,
      capital: safeCapital,
      riskPerTradePct: safeRisk,
      lotSize: safeLotSize,
      positionSizePct: safePositionSizePct,
      minProfitBookingPct: safeMinProfitBookingPct,
      profitRatioBooking: safeProfitRatioBooking,
      exchangeEnabled: Boolean(exchangeEnabled),
      exchangeProvider: String(exchangeProvider),
      autoStarted: Boolean(autoStart),
      sessionId: runner?.sessionId || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts', async (_req, res) => {
  try { res.json(await listPineScriptsDetailed()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/runners', async (_req, res) => {
  try { res.json(await listPineScriptsDetailed()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts/:id', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    res.json({ ...(await pineRunnerSnapshot(doc)), code: doc.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/activate', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    applyPineRuntimeOptions(doc, req.body || {});
    const runner = await setActivePineScript(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    runner.strategy.reset(pineStrategyOptions(doc));
    await emitPineState();
    res.json({ ok: true, id: doc._id.toString(), runnerId: runner.id, meta: runner.strategy.scriptMeta(), exchangeEnabled: Boolean(doc.exchangeEnabled) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts/:id/status', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    const runner = pineRunners.get(req.params.id);
    res.json({
      ...(runner?._status() || { id: pineRunnerId(req.params.id), running: false, paused: false, warmedUp: false }),
      session: runner ? await runner.buildSessionInfo().catch(() => null) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/start', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    applyPineRuntimeOptions(doc, req.body || {});
    await doc.save();
    const runner = await setActivePineScript(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (
      req.body?.capital || req.body?.risk || req.body?.exchangeEnabled !== undefined ||
      req.body?.lotSize !== undefined || req.body?.positionSizePct !== undefined || req.body?.minProfitBookingPct !== undefined ||
      req.body?.profitRatioBooking !== undefined
    ) {
      await runner.reset(pineStrategyOptions(doc));
    }
    await startRunner(runner, { createNew: false });
    await emitPineState();
    res.json({ ok: true, id: doc._id.toString(), runnerId: runner.id, sessionId: runner.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/new', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    const { capital = 10000, risk = 2 } = req.body || {};
    applyPineRuntimeOptions(doc, { ...req.body, capital, risk });
    await doc.save();
    const runner = await setActivePineScript(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    await runner.reset(pineStrategyOptions(doc));
    await startRunner(runner, { createNew: true });
    await emitPineState();
    res.json({ ok: true, id: doc._id.toString(), runnerId: runner.id, sessionId: runner.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/stop', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.status(404).json({ error: 'Pine runner not found' });
    await runner.stop();
    manager.maybeStopWs();
    await emitPineState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/pause', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.status(404).json({ error: 'Pine runner not found' });
    runner.pause();
    await emitPineState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/resume', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.status(404).json({ error: 'Pine runner not found' });
    runner.resume();
    await emitPineState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/scripts/:id/reset', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });
    applyPineRuntimeOptions(doc, req.body || {});
    await doc.save();
    const runner = ensurePineRunner(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    await runner.reset(pineStrategyOptions(doc));
    manager.maybeStopWs();
    await emitPineState();
    await manager.sendSessionsList(io);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts/:id/stats', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.json({ scriptMeta: { hasScript: false }, totalTrades: 0, recentTrades: [] });
    res.json(runner.strategy.getFullState());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts/:id/trades', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.json([]);
    res.json(await runner.recentTrades());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pine/scripts/:id/equity', async (req, res) => {
  try {
    const runner = pineRunners.get(req.params.id);
    if (!runner) return res.json([]);
    res.json(await runner.equityHistory());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pine/scripts/:id', async (req, res) => {
  try {
    const doc = await PineScriptConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Pine script not found' });

    const runner = pineRunners.get(req.params.id);
    const deletedActive = Boolean(doc.isActive || runner?.running);
    if (runner?.running) {
      await runner.stop();
      manager.maybeStopWs();
    }
    if (runner) {
      pineRunners.delete(req.params.id);
      manager.removeRunner(runner.id);
    }

    await doc.deleteOne();

    await emitPineState();
    await manager.sendSessionsList(io);
    res.json({ ok: true, deletedActive, scripts: await listPineScriptsDetailed() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/backtest', async (req, res) => {
  try {
    const {
      scriptId,
      code,
      name = 'Backtest Pine',
      fromDate,
      toDate,
      capital = 10000,
      risk = 2,
      lotSize = 1,
      positionSizePct = 0,
      minProfitBookingPct = 0.5,
      profitRatioBooking = 1.67,
    } = req.body || {};
    let scriptCode = code;
    let scriptName = name;
    if (scriptId) {
      const doc = await PineScriptConfig.findById(scriptId).lean();
      if (!doc) return res.status(404).json({ error: 'Pine script not found' });
      scriptCode = doc.code;
      scriptName = doc.name;
    }
    if (!scriptCode?.trim()) return res.status(400).json({ error: 'Pine code or scriptId is required' });

    const fromMs = Date.parse(fromDate);
    const toMs = Date.parse(toDate);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return res.status(400).json({ error: 'Valid fromDate and toDate are required' });
    }
    const maxRangeMs = 120 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > maxRangeMs) return res.status(400).json({ error: 'Backtest range is limited to 120 days' });

    const warmupFrom = Math.max(0, fromMs - 3 * 24 * 60 * 60 * 1000);
    const candles = await fetchKlinesRange(warmupFrom, toMs);
    const warmupCandles = candles.filter(c => c.openTime < fromMs);
    const testCandles = candles.filter(c => c.openTime >= fromMs && c.openTime <= toMs);
    const strategy = new PineScriptStrategy({
      name: scriptName,
      code: scriptCode,
      capital: +capital,
      riskPerTradePct: +risk,
      lotSize: +lotSize,
      positionSizePct: +positionSizePct,
      minProfitBookingPct: +minProfitBookingPct,
      profitRatioBooking: +profitRatioBooking,
    });
    if (warmupCandles.length >= strategy.minBars) strategy.restoreFromHistory(warmupCandles);
    const report = summarizeBacktest(strategy, testCandles, fromMs, toMs);
    report.warmupCandles = warmupCandles.length;
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/allinone/strategies', async (_req, res) => {
  try { res.json(await listAllInOneDetailed()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/allinone/settings', async (_req, res) => {
  try {
    await ensureAllInOneConfigs();
    const doc = await AllInOneStrategyConfig.findOne().sort({ updatedAt: -1 }).lean();
    res.json(commonAllInOneSettings(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/settings', async (req, res) => {
  try {
    const settings = await saveCommonAllInOneSettings(req.body || {});
    await emitAllInOneState();
    res.json({ ok: true, settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/allinone/strategies/:key', async (req, res) => {
  try {
    await ensureAllInOneConfigs();
    const doc = await AllInOneStrategyConfig.findOne({ key: req.params.key }).lean();
    if (!doc) return res.status(404).json({ error: 'All-in-one strategy not found' });
    res.json(await allInOneRunnerSnapshot(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/settings', async (req, res) => {
  try {
    await saveCommonAllInOneSettings(req.body || {});
    const doc = await AllInOneStrategyConfig.findOne({ key: req.params.key });
    if (!doc) return res.status(404).json({ error: 'All-in-one strategy not found' });
    const runner = ensureAllInOneRunner(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (!runner.running) await runner.reset(allInOneStrategyOptions(doc));
    await emitAllInOneState();
    res.json({ ok: true, strategy: await allInOneRunnerSnapshot(doc.toObject()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/start', async (req, res) => {
  try {
    await ensureAllInOneConfigs();
    if (req.body && Object.keys(req.body).length) await saveCommonAllInOneSettings(req.body);
    const doc = await AllInOneStrategyConfig.findOne({ key: req.params.key });
    if (!doc) return res.status(404).json({ error: 'All-in-one strategy not found' });
    doc.isActive = true;
    await doc.save();
    const runner = ensureAllInOneRunner(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (req.body && Object.keys(req.body).length) await runner.reset(allInOneStrategyOptions(doc));
    await startRunner(runner, { createNew: false });
    await emitAllInOneState();
    res.json({ ok: true, key: doc.key, runnerId: runner.id, sessionId: runner.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/stop', async (req, res) => {
  try {
    const runner = allInOneRunners.get(req.params.key);
    if (!runner) return res.status(404).json({ error: 'All-in-one runner not found' });
    await runner.stop();
    manager.maybeStopWs();
    await emitAllInOneState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/pause', async (req, res) => {
  try {
    const runner = allInOneRunners.get(req.params.key);
    if (!runner) return res.status(404).json({ error: 'All-in-one runner not found' });
    runner.pause();
    await emitAllInOneState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/resume', async (req, res) => {
  try {
    const runner = allInOneRunners.get(req.params.key);
    if (!runner) return res.status(404).json({ error: 'All-in-one runner not found' });
    runner.resume();
    await emitAllInOneState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/allinone/strategies/:key/reset', async (req, res) => {
  try {
    await ensureAllInOneConfigs();
    if (req.body && Object.keys(req.body).length) await saveCommonAllInOneSettings(req.body);
    const doc = await AllInOneStrategyConfig.findOne({ key: req.params.key });
    if (!doc) return res.status(404).json({ error: 'All-in-one strategy not found' });
    const runner = ensureAllInOneRunner(doc);
    await runner.reset(allInOneStrategyOptions(doc));
    manager.maybeStopWs();
    await emitAllInOneState();
    await manager.sendSessionsList(io);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/utbot/state', async (_req, res) => {
  try {
    const doc = await ensureUTBotConfig();
    ensureUTBotRunner(doc);
    res.json(await utBotSnapshot(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/utbot/settings', async (req, res) => {
  try {
    const doc = await ensureUTBotConfig();
    applyUTBotRuntimeOptions(doc, req.body || {});
    await doc.save();
    const runner = ensureUTBotRunner(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (!runner.running) await runner.reset(utBotStrategyOptions(doc));
    await emitUTBotState();
    res.json({ ok: true, state: await utBotSnapshot(doc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/utbot/start', async (req, res) => {
  try {
    const doc = await ensureUTBotConfig();
    applyUTBotRuntimeOptions(doc, req.body || {});
    doc.isActive = true;
    await doc.save();
    const runner = ensureUTBotRunner(doc);
    runner.executionEnabled = Boolean(doc.exchangeEnabled);
    if (req.body && Object.keys(req.body).length) await runner.reset(utBotStrategyOptions(doc));
    await startRunner(runner, { createNew: false });
    await emitUTBotState();
    res.json({ ok: true, runnerId: runner.id, sessionId: runner.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/utbot/stop', async (_req, res) => {
  try {
    if (!utBotRunner) return res.status(404).json({ error: 'UT Bot runner not found' });
    await utBotRunner.stop();
    manager.maybeStopWs();
    await emitUTBotState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/utbot/reset', async (req, res) => {
  try {
    const doc = await ensureUTBotConfig();
    applyUTBotRuntimeOptions(doc, req.body || {});
    await doc.save();
    const runner = ensureUTBotRunner(doc);
    await runner.reset(utBotStrategyOptions(doc));
    manager.maybeStopWs();
    await emitUTBotState();
    await manager.sendSessionsList(io);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', async (_req, res) => {
  try {
    const list = await Session.find().sort({ createdAt: -1 }).limit(40).lean();
    res.json(list.map(s => ({
      id: s._id.toString(), shortId: s._id.toString().slice(-6).toUpperCase(),
      strategyType: s.strategyType || 'scalping', isRunning: s.isRunning,
      pineScriptId: s.pineScriptId?.toString?.() || s.pineScriptId || null,
      executionMode: s.executionMode || 'paper',
      initialCapital: s.initialCapital, currentCapital: s.currentCapital,
      riskPerTradePct: s.riskPerTradePct, tradeCount: s.tradeCount, winCount: s.winCount,
      startedAt: s.startedAt, stoppedAt: s.stoppedAt,
      pnl: s.currentCapital - s.initialCapital,
      pnlPct: (s.currentCapital - s.initialCapital) / s.initialCapital * 100,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO — send full state on (re)connect
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', async socket => {
  console.log(`[WS] Client connected: ${socket.id}`);
  await manager.sendInitialState(socket);
  socket.emit('pine:status', pineAggregateStatus());
  socket.emit('pine:runners', await listPineScriptsDetailed());
  socket.emit('pine:scripts', await listPineScriptsDetailed());
  socket.emit('allinone:status', allInOneAggregateStatus());
  socket.emit('allinone:runners', await listAllInOneDetailed());
  socket.emit('utbot:status', utBotAggregateStatus());
  socket.emit('utbot:state', await utBotSnapshot(await ensureUTBotConfig()));
  socket.emit('log', {
    level: 'info',
    msg: `👋 Dashboard connected — EMA: ${scalpRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | Breakout: ${breakoutRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | HA: ${haRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | Pine bots: ${pineAggregateStatus().runningCount} running | All-in-One: ${allInOneAggregateStatus().runningCount} running | UT Bot: ${utBotAggregateStatus().running ? 'RUNNING' : 'STOPPED'}`,
    time: Date.now(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrap () {
  try { await db.connect(); }
  catch (e) { console.error('[FATAL] MongoDB:', e.message); process.exit(1); }
  await applySavedExchangeCredentials();
  await ensureAllInOneConfigs();
  const utDoc = await ensureUTBotConfig();
  const restoredUTRunner = ensureUTBotRunner(utDoc);
  const savedUT = await restoredUTRunner.restoreFromDB();
  if (savedUT && savedUT.isRunning) {
    console.log('[Boot] Auto-resuming utbot (UT Bot Alerts)...');
    await startRunner(restoredUTRunner, { createNew: false });
  }

  const allInOneDocs = await AllInOneStrategyConfig.find().lean().catch(() => []);
  for (const doc of allInOneDocs) {
    const runner = ensureAllInOneRunner(doc);
    const saved = await runner.restoreFromDB();
    if (saved && saved.isRunning) {
      console.log(`[Boot] Auto-resuming ${runner.id} (${doc.name})...`);
      await startRunner(runner, { createNew: false });
    }
  }

  const runningPineSessions = await Session.find({ strategyType: 'pine', isRunning: true, pineScriptId: { $ne: null } })
    .select('pineScriptId')
    .lean()
    .catch(() => []);
  const runningPineIds = [...new Set(runningPineSessions.map(s => idString(s.pineScriptId)).filter(Boolean))];
  const pineBootQuery = runningPineIds.length
    ? { $or: [{ isActive: true }, { _id: { $in: runningPineIds } }] }
    : { isActive: true };
  const activePineDocs = await PineScriptConfig.find(pineBootQuery).lean().catch(() => []);
  for (const doc of activePineDocs) {
    const runner = ensurePineRunner(doc);
    const saved = await runner.restoreFromDB();
    if (saved && saved.isRunning) {
      console.log(`[Boot] Auto-resuming ${runner.id} (${doc.name})...`);
      await startRunner(runner, { createNew: false });
    }
  }

  for (const runner of [scalpRunner, breakoutRunner, haRunner]) {
    runner.wire();
    const saved = await runner.restoreFromDB();
    if (saved && saved.isRunning) {
      console.log(`[Boot] Auto-resuming ${runner.id}...`);
      await startRunner(runner, { createNew: false });
    }
  }

  startBackendExchangeSync();
  startStrategyWatchdog();

  server.listen(PORT, () => {
    console.log('\n' + '═'.repeat(62));
    console.log('  🚀  BTC Multi-Strategy Bot  |  Server-Side Persistent Engine');
    console.log(`  📡  http://localhost:${PORT}`);
    console.log(`  🔐  Auth: ${DASHBOARD_EMAIL}`);
    console.log(`  🗄️   MongoDB: ${process.env.MONGO_URI || 'mongodb://localhost:27017/btc_scalping_bot'}`);
    console.log(`  🧾  Delta demo mirror: ${deltaClient.status().enabled ? 'ENABLED' : 'DISABLED'} (${deltaClient.status().productSymbol})`);
    console.log('  📝  Mode: PAPER TRADING  |  Strategies run 24/7 on server');
    console.log('═'.repeat(62) + '\n');
  });
}

bootstrap();
