'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const db                             = require('./db');
const { Session }                    = db;
const { BotManager, StrategyRunner } = require('./bot-manager');
const { ScalpingStrategy }           = require('./strategies/scalping');
const { RangeBreakoutStrategy }      = require('./strategies/breakout');

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
  <div class="logo">⚡<span>BTC</span>Dual Bot</div>
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
app.use(express.json());

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

const scalpRunner    = new StrategyRunner('scalping', new ScalpingStrategy({ capital: 10000, riskPerTradePct: 2 }), io);
const breakoutRunner = new StrategyRunner('breakout', new RangeBreakoutStrategy({ capital: 10000, riskPerTradePct: 2 }), io);

manager.addRunner(scalpRunner);
manager.addRunner(breakoutRunner);

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

app.get('/api/sessions', async (_req, res) => {
  try {
    const list = await Session.find().sort({ createdAt: -1 }).limit(40).lean();
    res.json(list.map(s => ({
      id: s._id.toString(), shortId: s._id.toString().slice(-6).toUpperCase(),
      strategyType: s.strategyType || 'scalping', isRunning: s.isRunning,
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
  socket.emit('log', {
    level: 'info',
    msg: `👋 Dashboard connected — EMA: ${scalpRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'} | Breakout: ${breakoutRunner.running ? '🟢 RUNNING' : '🔴 STOPPED'}`,
    time: Date.now(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrap () {
  try { await db.connect(); }
  catch (e) { console.error('[FATAL] MongoDB:', e.message); process.exit(1); }

  for (const runner of [scalpRunner, breakoutRunner]) {
    runner.wire();
    const saved = await runner.restoreFromDB();
    if (saved && saved.isRunning) {
      console.log(`[Boot] Auto-resuming ${runner.id}...`);
      await startRunner(runner, { createNew: false });
    }
  }

  server.listen(PORT, () => {
    console.log('\n' + '═'.repeat(62));
    console.log('  🚀  BTC Dual-Strategy Bot  |  Server-Side Persistent Engine');
    console.log(`  📡  http://localhost:${PORT}`);
    console.log(`  🔐  Auth: ${DASHBOARD_EMAIL}`);
    console.log(`  🗄️   MongoDB: ${process.env.MONGO_URI || 'mongodb://localhost:27017/btc_scalping_bot'}`);
    console.log('  📝  Mode: PAPER TRADING  |  Strategies run 24/7 on server');
    console.log('═'.repeat(62) + '\n');
  });
}

bootstrap();
