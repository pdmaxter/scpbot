'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const db                             = require('./db');
const { Session, PineScriptConfig }          = db;
const { BotManager, StrategyRunner }         = require('./bot-manager');
const { ScalpingStrategy }                   = require('./strategies/scalping');
const { RangeBreakoutStrategy }              = require('./strategies/breakout');
const { HeikenAshiSupertrendStrategy }       = require('./strategies/heikenashi_supertrend');
const { PineScriptStrategy }                 = require('./strategies/pine_adapter');

const SYMBOL_REST = 'BTCUSDT';
const INTERVAL_REST = '5m';
const CANDLE_MS = 5 * 60 * 1000;

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
    return res.redirect('/');
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

const scalpRunner    = new StrategyRunner('scalping',    new ScalpingStrategy({ capital: 10000, riskPerTradePct: 2 }), io);
const breakoutRunner = new StrategyRunner('breakout',    new RangeBreakoutStrategy({ capital: 10000, riskPerTradePct: 2 }), io);
const haRunner       = new StrategyRunner('heikenashi',  new HeikenAshiSupertrendStrategy({ capital: 10000, riskPerTradePct: 2 }), io);
const pineRunners    = new Map(); // scriptId -> StrategyRunner

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
      new PineScriptStrategy({ name: doc.name, code: doc.code, capital: 10000, riskPerTradePct: 2 }),
      io,
      { sessionStrategyType: 'pine', pineScriptId: scriptId, displayName: doc.name }
    );
    pineRunners.set(scriptId, runner);
    manager.addRunner(runner);
    hookPineRunnerEvents(runner, scriptId);
    runner.wire();
  } else {
    runner.displayName = doc.name;
    if (!runner.running) runner.strategy.setScript({ name: doc.name, code: doc.code });
    runner.wire();
  }
  return runner;
}

async function setActivePineScript (doc) {
  doc.isActive = true;
  await doc.save();
  const runner = ensurePineRunner(doc);
  io.emit('pine:config', { id: doc._id.toString(), name: doc.name, code: doc.code, meta: runner.strategy.scriptMeta() });
  await emitPineState();
  return runner;
}

async function listPineScripts () {
  const docs = await PineScriptConfig.find().sort({ isActive: -1, updatedAt: -1 }).lean();
  return docs.map(pineListItem);
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
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pine/upload', async (req, res) => {
  try {
    const { name = 'Uploaded Pine', code = '', capital, risk, autoStart = false, setActive = false } = req.body || {};
    if (!code.trim()) return res.status(400).json({ error: 'Pine code is required' });
    if (code.length > 500000) return res.status(400).json({ error: 'Pine code is too large' });

    const temp = new PineScriptStrategy({ name: String(name).slice(0, 80), code, capital: +capital || 10000, riskPerTradePct: +risk || 2 });
    const meta = temp.scriptMeta();
    const doc = await PineScriptConfig.create({
      name: temp.scriptName,
      code,
      meta,
      isActive: Boolean(setActive || autoStart),
    });

    let runner = null;
    if (setActive || autoStart) {
      runner = await setActivePineScript(doc);
      await runner.reset({
        ...(capital && { capital: +capital }),
        ...(risk && { riskPerTradePct: +risk }),
      });
      if (autoStart) await startRunner(runner, { createNew: true });
    } else {
      await emitPineState();
    }

    await manager.sendSessionsList(io);
    res.json({ ok: true, id: doc._id.toString(), runnerId: pineRunnerId(doc._id.toString()), meta, autoStarted: Boolean(autoStart), sessionId: runner?.sessionId || null });
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
    const runner = await setActivePineScript(doc);
    runner.strategy.reset(req.body || {});
    await emitPineState();
    res.json({ ok: true, id: doc._id.toString(), runnerId: runner.id, meta: runner.strategy.scriptMeta() });
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
    const runner = await setActivePineScript(doc);
    if (req.body?.capital || req.body?.risk) {
      await runner.reset({ ...(req.body.capital && { capital: +req.body.capital }), ...(req.body.risk && { riskPerTradePct: +req.body.risk }) });
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
    const runner = await setActivePineScript(doc);
    const { capital = 10000, risk = 2 } = req.body || {};
    await runner.reset({ capital: +capital, riskPerTradePct: +risk });
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
    const runner = ensurePineRunner(doc);
    const { capital, risk } = req.body || {};
    await runner.reset({ ...(capital && { capital: +capital }), ...(risk && { riskPerTradePct: +risk }) });
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
    const { scriptId, code, name = 'Backtest Pine', fromDate, toDate, capital = 10000, risk = 2 } = req.body || {};
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
    const strategy = new PineScriptStrategy({ name: scriptName, code: scriptCode, capital: +capital, riskPerTradePct: +risk });
    if (warmupCandles.length >= strategy.minBars) strategy.restoreFromHistory(warmupCandles);
    const report = summarizeBacktest(strategy, testCandles, fromMs, toMs);
    report.warmupCandles = warmupCandles.length;
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', async (_req, res) => {
  try {
    const list = await Session.find().sort({ createdAt: -1 }).limit(40).lean();
    res.json(list.map(s => ({
      id: s._id.toString(), shortId: s._id.toString().slice(-6).toUpperCase(),
      strategyType: s.strategyType || 'scalping', isRunning: s.isRunning,
      pineScriptId: s.pineScriptId?.toString?.() || s.pineScriptId || null,
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
  socket.emit('log', {
    level: 'info',
    msg: `👋 Dashboard connected — EMA: ${scalpRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | Breakout: ${breakoutRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | HA: ${haRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | Pine bots: ${pineAggregateStatus().runningCount} running`,
    time: Date.now(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrap () {
  try { await db.connect(); }
  catch (e) { console.error('[FATAL] MongoDB:', e.message); process.exit(1); }

  const activePineDocs = await PineScriptConfig.find({ isActive: true }).lean().catch(() => []);
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

  server.listen(PORT, () => {
    console.log('\n' + '═'.repeat(62));
    console.log('  🚀  BTC Multi-Strategy Bot  |  Server-Side Persistent Engine');
    console.log(`  📡  http://localhost:${PORT}`);
    console.log(`  🔐  Auth: ${DASHBOARD_EMAIL}`);
    console.log(`  🗄️   MongoDB: ${process.env.MONGO_URI || 'mongodb://localhost:27017/btc_scalping_bot'}`);
    console.log('  📝  Mode: PAPER TRADING  |  Strategies run 24/7 on server');
    console.log('═'.repeat(62) + '\n');
  });
}

bootstrap();
