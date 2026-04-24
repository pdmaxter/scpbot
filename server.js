'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const https      = require('https');
const crypto     = require('crypto');
const fs         = require('fs');
const os         = require('os');
const { Server } = require('socket.io');
const path       = require('path');
const { execFile, spawn } = require('child_process');

const db                                      = require('./db');
const { Session, PineScriptConfig, AllInOneStrategyConfig, UTBotConfig, MT5ConnectionConfig, Trade, Position, DailyPnl, Equity } = db;
const { BotManager, StrategyRunner }         = require('./bot-manager');
const { ScalpingStrategy }                   = require('./strategies/scalping');
const { RangeBreakoutStrategy }              = require('./strategies/breakout');
const { HeikenAshiSupertrendStrategy }       = require('./strategies/heikenashi_supertrend');
const { PineScriptStrategy }                 = require('./strategies/pine_adapter');
const { AllInOneStrategy, ALL_IN_ONE_DEFINITIONS, TIMEFRAME_MS } = require('./strategies/all_in_one');
const { UTBotStrategy }                      = require('./strategies/ut_bot');

const SYMBOL_REST = 'BTCUSDT';
const INTERVAL_REST = '5m';
const CANDLE_MS = 5 * 60 * 1000;
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

const MT5_DEFAULT_APP_PATH = '/Applications/MetaTrader 5.app';
const MT5_DEFAULT_BOTTLE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'MetaTrader 5', 'Bottles', 'metatrader5');
const MT5_DEFAULT_PROGRAM_DIR = path.join(MT5_DEFAULT_BOTTLE_PATH, 'drive_c', 'Program Files', 'MetaTrader 5');
const MT5_DEFAULT_CONFIG_PATH_MAC = path.join(MT5_DEFAULT_PROGRAM_DIR, 'Config', 'exness-bridge.ini');
const MT5_DEFAULT_CONFIG_PATH_WIN = 'c:\\Program Files\\MetaTrader 5\\Config\\exness-bridge.ini';
const MT5_BRIDGE_FOLDER = 'ScpBotBridge';
const MT5_BRIDGE_SOURCE_NAME = 'ScpBotBridgeEA.mq5';
const MT5_BRIDGE_COMPILED_NAME = 'ScpBotBridgeEA.ex5';
const MT5_BRIDGE_REPO_SOURCE = path.join(__dirname, 'mt5', MT5_BRIDGE_SOURCE_NAME);

function mt5CipherKey () {
  return crypto
    .createHash('sha256')
    .update(String(process.env.MT5_CONFIG_SECRET || DASHBOARD_PWD || 'mt5-local-secret'))
    .digest();
}

function encryptMt5Password (plain = '') {
  const value = String(plain || '');
  if (!value) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', mt5CipherKey(), iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

function decryptMt5Password (packed = '') {
  const value = String(packed || '');
  if (!value || !value.includes(':')) return '';
  const [ivHex, encHex] = value.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', mt5CipherKey(), iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function maskAccountLogin (value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 2)}${'*'.repeat(Math.max(0, raw.length - 4))}${raw.slice(-2)}`;
}

function execFileAsync (file, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function mt5Paths (doc = {}) {
  const bottlePath = doc.bottlePath || MT5_DEFAULT_BOTTLE_PATH;
  const programDir = path.join(bottlePath, 'drive_c', 'Program Files', 'MetaTrader 5');
  const expertsDir = path.join(programDir, 'MQL5', 'Experts');
  const filesDir = path.join(programDir, 'MQL5', 'Files', MT5_BRIDGE_FOLDER);
  return {
    appPath: doc.appPath || MT5_DEFAULT_APP_PATH,
    bottlePath,
    programDir,
    expertsDir,
    filesDir,
    inboxDir: path.join(filesDir, 'inbox'),
    ackDir: path.join(filesDir, 'ack'),
    statusDir: path.join(filesDir, 'status'),
    configPathMac: path.join(programDir, 'Config', 'exness-bridge.ini'),
    configPathWin: MT5_DEFAULT_CONFIG_PATH_WIN,
    bridgeSourcePathMac: path.join(expertsDir, MT5_BRIDGE_SOURCE_NAME),
    bridgeCompiledPathMac: path.join(expertsDir, MT5_BRIDGE_COMPILED_NAME),
    bridgeSourcePathWin: `c:\\Program Files\\MetaTrader 5\\MQL5\\Experts\\${MT5_BRIDGE_SOURCE_NAME}`,
  };
}

async function ensureMt5ConfigDoc () {
  await MT5ConnectionConfig.updateOne(
    { key: 'exness-mt5' },
    {
      $setOnInsert: {
        name: 'Exness MT5 Demo',
        provider: 'exness-mt5',
        appPath: MT5_DEFAULT_APP_PATH,
        bottlePath: MT5_DEFAULT_BOTTLE_PATH,
        configPathMac: MT5_DEFAULT_CONFIG_PATH_MAC,
        configPathWin: MT5_DEFAULT_CONFIG_PATH_WIN,
        symbol: 'BTCUSDm',
        fixedVolume: 0.01,
        deviationPoints: 200,
      },
    },
    { upsert: true }
  );
  return MT5ConnectionConfig.findOne({ key: 'exness-mt5' });
}

function mt5ConfigText (doc, password) {
  return [
    '[Common]',
    `Login=${String(doc.accountLogin || '').trim()}`,
    `Password=${String(password || '').trim()}`,
    `Server=${String(doc.server || '').trim()}`,
    'KeepPrivate=1',
    'NewsEnable=0',
    '',
  ].join('\n');
}

async function writeMt5ConfigFile (doc) {
  const secret = decryptMt5Password(doc.passwordEnc);
  if (!secret) throw new Error('MT5 password is not configured');
  const paths = mt5Paths(doc);
  await fs.promises.mkdir(path.dirname(paths.configPathMac), { recursive: true });
  await fs.promises.writeFile(paths.configPathMac, mt5ConfigText(doc, secret), 'utf8');
  return paths;
}

async function detectMt5Running () {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-fal', 'MetaTrader 5']);
    const lines = String(stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
    return { running: lines.length > 0, processes: lines };
  } catch (error) {
    return { running: false, processes: [] };
  }
}

function mt5CommandText (payload = {}) {
  return Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n') + '\n';
}

function parseMt5KvText (text = '') {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function mt5MagicForRunner (runnerId = '') {
  const hash = crypto.createHash('md5').update(String(runnerId || '')).digest('hex').slice(0, 7);
  return 1000000 + parseInt(hash, 16);
}

async function ensureMt5BridgeFiles (doc) {
  const paths = mt5Paths(doc);
  await Promise.all([
    fs.promises.mkdir(paths.expertsDir, { recursive: true }),
    fs.promises.mkdir(paths.inboxDir, { recursive: true }),
    fs.promises.mkdir(paths.ackDir, { recursive: true }),
    fs.promises.mkdir(paths.statusDir, { recursive: true }),
  ]);
  await fs.promises.copyFile(MT5_BRIDGE_REPO_SOURCE, paths.bridgeSourcePathMac);
  doc.bridgeSourcePath = paths.bridgeSourcePathMac;
  doc.bridgeCompiledPath = paths.bridgeCompiledPathMac;
  return paths;
}

async function compileMt5Bridge (doc) {
  const paths = await ensureMt5BridgeFiles(doc);
  const wineScript = path.join(paths.appPath, 'Contents', 'SharedSupport', 'metatrader5', 'MetaTrader 5', 'wine');
  if (!fs.existsSync(wineScript)) {
    return { ok: false, error: `Wine launcher not found at ${wineScript}` };
  }
  try {
    const { stdout, stderr } = await execFileAsync(wineScript, [
      '--enable-alt-loader', 'macdrv',
      '--bottle', 'default',
      '--wait-children',
      '--workdir', 'c:/Program Files/MetaTrader 5',
      'metaeditor64.exe',
      `/compile:${paths.bridgeSourcePathWin}`,
    ], { timeout: 120000 });
    const compiled = fs.existsSync(paths.bridgeCompiledPathMac);
    return { ok: compiled, stdout, stderr, error: compiled ? '' : 'MetaEditor compile did not produce EX5 output' };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error: error.message,
    };
  }
}

async function readMt5BridgeStatus (doc) {
  const paths = mt5Paths(doc);
  const statusPath = path.join(paths.statusDir, 'terminal.status');
  const status = { exists: false };
  try {
    const raw = await fs.promises.readFile(statusPath, 'utf8');
    const parsed = parseMt5KvText(raw);
    return { exists: true, path: statusPath, ...parsed };
  } catch (_err) {
    return { ...status, path: statusPath };
  }
}

async function enqueueMt5Command (doc, command) {
  if (!doc.enabled) return { queued: false, skipped: 'MT5 live execution is disabled' };
  if (!doc.configured || !doc.server || !doc.accountLogin || !doc.passwordEnc) {
    return { queued: false, skipped: 'MT5 credentials are incomplete' };
  }
  const paths = await ensureMt5BridgeFiles(doc);
  const id = command.id || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fileName = `${id}.cmd`;
  const filePath = path.join(paths.inboxDir, fileName);
  await fs.promises.writeFile(filePath, mt5CommandText({ ...command, id }), 'utf8');
  return { queued: true, id, fileName, filePath };
}

async function launchMt5 (doc) {
  const paths = await writeMt5ConfigFile(doc);
  await ensureMt5BridgeFiles(doc);
  const compile = await compileMt5Bridge(doc);
  const appPath = paths.appPath;
  if (!fs.existsSync(appPath)) throw new Error(`MetaTrader 5 app not found at ${appPath}`);
  const child = spawn('/usr/bin/open', ['-a', appPath, '--args', `/config:${paths.configPathWin}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  doc.appPath = appPath;
  doc.bottlePath = paths.bottlePath;
  doc.configPathMac = paths.configPathMac;
  doc.configPathWin = paths.configPathWin;
  doc.bridgeSourcePath = paths.bridgeSourcePathMac;
  doc.bridgeCompiledPath = paths.bridgeCompiledPathMac;
  doc.lastLaunchAt = new Date();
  doc.lastError = compile.ok ? '' : (compile.error || compile.stderr || compile.stdout || '');
  await doc.save();
  return { paths, compile };
}

async function queueMt5PositionOpen (position, runner) {
  const doc = await ensureMt5ConfigDoc();
  if (!doc.enabled) return;
  const volume = Math.max(0.01, Number(doc.fixedVolume) || 0.01);
  const side = String(position?.type || '').toLowerCase() === 'short' ? 'SELL' : 'BUY';
  const sl = Number(position?.sl);
  const tp = Number(position?.tp);
  const response = await enqueueMt5Command(doc, {
    action: 'OPEN',
    runnerId: runner.id,
    strategy: runner.displayName || runner.id,
    symbol: doc.symbol || 'BTCUSDm',
    side,
    volume: volume.toFixed(2),
    deviation: Math.max(0, Math.round(Number(doc.deviationPoints) || 0)),
    magic: mt5MagicForRunner(runner.id),
    comment: `${runner.id}`.slice(0, 24),
    sl: Number.isFinite(sl) ? sl : '',
    tp: Number.isFinite(tp) ? tp : '',
  });
  if (!response.queued && response.skipped) return;
}

async function queueMt5TradeClose (_trade, runner) {
  const doc = await ensureMt5ConfigDoc();
  if (!doc.enabled) return;
  const response = await enqueueMt5Command(doc, {
    action: 'CLOSE',
    runnerId: runner.id,
    strategy: runner.displayName || runner.id,
    symbol: doc.symbol || 'BTCUSDm',
    deviation: Math.max(0, Math.round(Number(doc.deviationPoints) || 0)),
    magic: mt5MagicForRunner(runner.id),
    comment: `${runner.id}`.slice(0, 24),
  });
  if (!response.queued && response.skipped) return;
}

async function mt5ConfigView () {
  const doc = await ensureMt5ConfigDoc();
  const paths = mt5Paths(doc);
  const proc = await detectMt5Running();
  const bridgeStatus = await readMt5BridgeStatus(doc);
  return {
    key: doc.key,
    name: doc.name || 'Exness MT5 Demo',
    provider: doc.provider || 'exness-mt5',
    enabled: Boolean(doc.enabled),
    server: doc.server || '',
    accountLogin: doc.accountLogin || '',
    maskedAccountLogin: maskAccountLogin(doc.accountLogin || ''),
    symbol: doc.symbol || 'BTCUSDm',
    fixedVolume: Number(doc.fixedVolume || 0.01),
    deviationPoints: Number(doc.deviationPoints || 200),
    configured: Boolean(doc.configured && doc.server && doc.accountLogin && doc.passwordEnc),
    running: proc.running,
    processes: proc.processes,
    appPath: paths.appPath,
    bottlePath: paths.bottlePath,
    configPathMac: paths.configPathMac,
    configPathWin: paths.configPathWin,
    bridgeSourcePath: paths.bridgeSourcePathMac,
    bridgeCompiledPath: paths.bridgeCompiledPathMac,
    bridgeCompiled: fs.existsSync(paths.bridgeCompiledPathMac),
    bridgeStatus,
    lastLaunchAt: doc.lastLaunchAt,
    lastError: doc.lastError || '',
  };
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
app.get('/positions.html', (_req, res) => res.redirect('/pnl.html'));
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
const scalpRunner    = new StrategyRunner('scalping',    new ScalpingStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { displayName: 'EMA Scalping', onPositionOpened: queueMt5PositionOpen, onTradeClosed: queueMt5TradeClose });
const breakoutRunner = new StrategyRunner('breakout',    new RangeBreakoutStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { displayName: 'Range Breakout', onPositionOpened: queueMt5PositionOpen, onTradeClosed: queueMt5TradeClose });
const haRunner       = new StrategyRunner('heikenashi',  new HeikenAshiSupertrendStrategy({ capital: 10000, riskPerTradePct: 2 }), io, { displayName: 'Heikin-Ashi SuperTrend', onPositionOpened: queueMt5PositionOpen, onTradeClosed: queueMt5TradeClose });
const pineRunners    = new Map(); // scriptId -> StrategyRunner
const allInOneRunners = new Map(); // strategyKey -> StrategyRunner
let utBotRunner = null;
const STRATEGY_WATCHDOG_INTERVAL_MS = 30 * 1000;
let strategyWatchdogTimer = null;

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
    capital: doc.capital || 10000,
    riskPerTradePct: doc.riskPerTradePct || 2,
    lotSize: doc.lotSize || 1,
    positionSizePct: doc.positionSizePct ?? 100,
    leverage: doc.leverage || 1,
    minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
    profitRatioBooking: doc.profitRatioBooking ?? 1.67,
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
        positionSizePct: doc.positionSizePct ?? 100,
        leverage: doc.leverage || 1,
        minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
        profitRatioBooking: doc.profitRatioBooking ?? 1.67,
      }),
      io,
      { sessionStrategyType: 'pine', pineScriptId: scriptId, displayName: doc.name, lotSize: doc.lotSize || 1, onPositionOpened: queueMt5PositionOpen, onTradeClosed: queueMt5TradeClose }
    );
    pineRunners.set(scriptId, runner);
    manager.addRunner(runner);
    hookPineRunnerEvents(runner, scriptId);
    runner.wire();
  } else {
    runner.displayName = doc.name;
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
    positionSizePct: doc.positionSizePct ?? 100,
    leverage: doc.leverage || 1,
    minProfitBookingPct: doc.minProfitBookingPct ?? 0.5,
    profitRatioBooking: doc.profitRatioBooking ?? 1.67,
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
  else if (body.lotSize !== undefined) doc.positionSizePct = Math.max(0, +body.lotSize || 0);
  if (body.leverage !== undefined) doc.leverage = Math.max(1, Number(body.leverage) || 1);
  if (body.minProfitBookingPct !== undefined) doc.minProfitBookingPct = Math.max(0, +body.minProfitBookingPct || 0);
  if (body.profitRatioBooking !== undefined) doc.profitRatioBooking = Math.max(0.1, +body.profitRatioBooking || 1.67);
}

function pineStrategyOptions (doc) {
  return {
    capital: doc.capital || 10000,
    riskPerTradePct: doc.riskPerTradePct || 2,
    lotSize: doc.lotSize || 1,
    positionSizePct: doc.positionSizePct ?? 100,
    leverage: doc.leverage || 1,
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
    leverage: 1,
    buyFeePct: 0,
    sellFeePct: 0,
    ...ALL_IN_ONE_AUTO_RISK,
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
    leverage: doc.leverage || 1,
    buyFeePct: doc.buyFeePct || 0,
    sellFeePct: doc.sellFeePct || 0,
    riskPerTradePct: doc.riskPerTradePct || 1,
    atrLength: doc.atrLength || 14,
    slMultiplier: doc.slMultiplier || 2,
    tpMultiplier: doc.tpMultiplier || 4,
    trailOffset: doc.trailOffset || 1.5,
    isActive: Boolean(doc.isActive),
    updatedAt: doc.updatedAt,
  };
}

function allInOneStrategyOptions (doc) {
  return {
    strategyKey: doc.key,
    timeframe: TIMEFRAME_MS[doc.timeframe] ? doc.timeframe : '5m',
    capital: doc.capital || 1000,
    leverage: doc.leverage || 1,
    buyFeePct: doc.buyFeePct || 0,
    sellFeePct: doc.sellFeePct || 0,
    ...ALL_IN_ONE_AUTO_RISK,
  };
}

function applyAllInOneRuntimeOptions (doc, body = {}) {
  if (body.timeframe !== undefined && TIMEFRAME_MS[String(body.timeframe)]) doc.timeframe = String(body.timeframe);
  if (body.capital !== undefined) doc.capital = Math.max(100, Number(body.capital) || doc.capital || 1000);
  if (body.leverage !== undefined) doc.leverage = Math.max(1, Number(body.leverage) || 1);
  if (body.buyFeePct !== undefined) doc.buyFeePct = Math.max(0, Number(body.buyFeePct) || 0);
  if (body.sellFeePct !== undefined) doc.sellFeePct = Math.max(0, Number(body.sellFeePct) || 0);
  Object.assign(doc, ALL_IN_ONE_AUTO_RISK);
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
    leverage: doc?.leverage || 1,
    buyFeePct: doc?.buyFeePct || 0,
    sellFeePct: doc?.sellFeePct || 0,
    autoRisk: ALL_IN_ONE_AUTO_RISK,
  };
}

async function saveCommonAllInOneSettings (body = {}) {
  await ensureAllInOneConfigs();
  const patch = {
    timeframe: TIMEFRAME_MS[String(body.timeframe)] ? String(body.timeframe) : '5m',
    capital: Math.max(100, Number(body.capital) || 1000),
    leverage: Math.max(1, Number(body.leverage) || 1),
    buyFeePct: Math.max(0, Number(body.buyFeePct) || 0),
    sellFeePct: Math.max(0, Number(body.sellFeePct) || 0),
    ...ALL_IN_ONE_AUTO_RISK,
  };
  await AllInOneStrategyConfig.updateMany({}, { $set: patch });
  for (const runner of allInOneRunners.values()) {
    runner.strategy.buyFeePct = patch.buyFeePct / 100;
    runner.strategy.sellFeePct = patch.sellFeePct / 100;
    runner.strategy.leverage = patch.leverage;
    if (!runner.running) {
      runner.strategy.reset({
        strategyKey: runner.strategy.strategyKey,
        timeframe: patch.timeframe,
        capital: patch.capital,
        leverage: patch.leverage,
        buyFeePct: patch.buyFeePct,
        sellFeePct: patch.sellFeePct,
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
    leverage: 1,
    keyValue: 1,
    atrPeriod: 10,
    useHeikinAshi: false,
    buyFeePct: 0,
    sellFeePct: 0,
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
  if (body.leverage !== undefined) doc.leverage = Math.max(1, Number(body.leverage) || 1);
  if (body.keyValue !== undefined) doc.keyValue = Math.max(0.1, Number(body.keyValue) || 1);
  if (body.atrPeriod !== undefined) doc.atrPeriod = Math.max(2, Math.round(Number(body.atrPeriod) || 10));
  if (body.useHeikinAshi !== undefined) doc.useHeikinAshi = Boolean(body.useHeikinAshi);
  if (body.buyFeePct !== undefined) doc.buyFeePct = Math.max(0, Number(body.buyFeePct) || 0);
  if (body.sellFeePct !== undefined) doc.sellFeePct = Math.max(0, Number(body.sellFeePct) || 0);
}

function utBotStrategyOptions (doc) {
  return {
    timeframe: doc.timeframe || '5m',
    capital: doc.capital || 1000,
    leverage: doc.leverage || 1,
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
    leverage: doc.leverage || 1,
    keyValue: doc.keyValue || 1,
    atrPeriod: doc.atrPeriod || 10,
    useHeikinAshi: Boolean(doc.useHeikinAshi),
    buyFeePct: doc.buyFeePct || 0,
    sellFeePct: doc.sellFeePct || 0,
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

async function resetRunnerToConfiguredState (runner) {
  if (!runner) return;
  if (runner.id === 'scalping' || runner.id === 'breakout' || runner.id === 'heikenashi') {
    await runner.reset({
      capital: runner.strategy.initialCapital || 10000,
      riskPerTradePct: Math.max(0.1, Number(runner.strategy.riskPerTrade || 0.02) * 100),
    });
    return;
  }
  if (runner.id.startsWith('pine:')) {
    const doc = runner.pineScriptId ? await PineScriptConfig.findById(runner.pineScriptId) : null;
    await runner.reset(doc ? pineStrategyOptions(doc) : {
      capital: runner.strategy.initialCapital || 10000,
      riskPerTradePct: Math.max(0.1, Number(runner.strategy.riskPerTrade || 0.02) * 100),
      lotSize: runner.strategy.lotSize || 1,
      positionSizePct: Number(runner.strategy.positionSizePct || 0) * 100,
      leverage: Number(runner.strategy.leverage || 1),
      minProfitBookingPct: Number(runner.strategy.minProfitBookingPct || 0.005) * 100,
      profitRatioBooking: runner.strategy.profitRatioBooking || 1.67,
    });
    return;
  }
  if (runner.id.startsWith('allinone:')) {
    const key = String(runner.id).split(':')[1];
    const doc = key ? await AllInOneStrategyConfig.findOne({ key }) : null;
    await runner.reset(doc ? allInOneStrategyOptions(doc) : {
      strategyKey: key,
      timeframe: runner.strategy.timeframe || '5m',
      capital: runner.strategy.initialCapital || 1000,
    });
    return;
  }
  if (runner.id === 'utbot') {
    const doc = await ensureUTBotConfig();
    await runner.reset(utBotStrategyOptions(doc));
  }
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
        onPositionOpened: queueMt5PositionOpen,
        onTradeClosed: queueMt5TradeClose,
      }
    );
    manager.addRunner(utBotRunner);
    hookUTBotRunnerEvents(utBotRunner);
    utBotRunner.wire();
  } else {
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
        onPositionOpened: queueMt5PositionOpen,
        onTradeClosed: queueMt5TradeClose,
      }
    );
    allInOneRunners.set(key, runner);
    manager.addRunner(runner);
    hookAllInOneRunnerEvents(runner, key);
    runner.wire();
  } else {
    runner.displayName = doc.name;
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

function utcDayKey (value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return new Date(time).toISOString().slice(0, 10);
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

function normalizedLots (row) {
  const explicit = Number(row?.lotSize);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const qty = Number(row?.qty);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

function normalizedMarginUsed (row, session = null) {
  const explicit = Number(row?.marginUsed);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const capital = Number(session?.initialCapital ?? session?.currentCapital);
  if (Number.isFinite(capital) && capital >= 0) return capital;
  const entry = Number(row?.entry);
  const qty = Number(row?.qty);
  return Number.isFinite(entry) && Number.isFinite(qty) ? Math.abs(entry * qty) : null;
}

function startStrategyWatchdog () {
  if (strategyWatchdogTimer) return;
  strategyWatchdogTimer = setInterval(() => {
    const runningCount = Object.values(manager.runners).filter(r => r.running).length;
    if (!runningCount) return;
    manager.ensureWs();
    io.emit('all_status', manager.allStatus());
  }, STRATEGY_WATCHDOG_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/mt5/config', async (_req, res) => {
  try {
    res.json(await mt5ConfigView());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mt5/config', async (req, res) => {
  try {
    const doc = await ensureMt5ConfigDoc();
    const body = req.body || {};
    if (body.enabled !== undefined) doc.enabled = Boolean(body.enabled);
    if (body.server !== undefined) doc.server = String(body.server || '').trim();
    if (body.accountLogin !== undefined) doc.accountLogin = String(body.accountLogin || '').trim();
    if (body.password !== undefined && String(body.password || '').trim()) {
      doc.passwordEnc = encryptMt5Password(String(body.password || '').trim());
    }
    if (body.symbol !== undefined) doc.symbol = String(body.symbol || '').trim() || 'BTCUSDm';
    if (body.fixedVolume !== undefined) doc.fixedVolume = Math.max(0.01, Number(body.fixedVolume) || 0.01);
    if (body.deviationPoints !== undefined) doc.deviationPoints = Math.max(0, Math.round(Number(body.deviationPoints) || 0));
    if (body.appPath !== undefined && String(body.appPath || '').trim()) doc.appPath = String(body.appPath || '').trim();
    if (body.bottlePath !== undefined && String(body.bottlePath || '').trim()) doc.bottlePath = String(body.bottlePath || '').trim();
    const paths = mt5Paths(doc);
    doc.configPathMac = paths.configPathMac;
    doc.configPathWin = paths.configPathWin;
    doc.bridgeSourcePath = paths.bridgeSourcePathMac;
    doc.bridgeCompiledPath = paths.bridgeCompiledPathMac;
    doc.configured = Boolean(doc.server && doc.accountLogin && doc.passwordEnc);
    doc.lastError = '';
    await doc.save();
    res.json({ ok: true, config: await mt5ConfigView() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mt5/connect', async (_req, res) => {
  try {
    const doc = await ensureMt5ConfigDoc();
    if (!doc.configured || !doc.server || !doc.accountLogin || !doc.passwordEnc) {
      return res.status(400).json({ error: 'MT5 server, account number, and password are required' });
    }
    await launchMt5(doc);
    res.json({ ok: true, config: await mt5ConfigView() });
  } catch (e) {
    const doc = await ensureMt5ConfigDoc().catch(() => null);
    if (doc) {
      doc.lastError = e.message;
      await doc.save().catch(() => {});
    }
    res.status(500).json({ error: e.message });
  }
});

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
        lots: normalizedLots(p),
        marginUsed: normalizedMarginUsed(p, session),
        leverage: Number(p.leverage) || 1,
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
        lots: normalizedLots(t),
        marginUsed: normalizedMarginUsed(t, session),
        leverage: Number(t.leverage) || 1,
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
      open: visibleOpen,
      closed: visibleClosed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pnl/overview', async (req, res) => {
  try {
    const fromMs = req.query.fromDate ? Date.parse(req.query.fromDate) : null;
    const toMs = req.query.toDate ? Date.parse(req.query.toDate) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 400, 1), 1000);
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
    const runningIds = new Set(
      Object.values(manager.runners || {})
        .filter(r => r.running)
        .map(r => r.id)
    );

    const open = openDocs.map(p => {
      const session = sessionMap.get(idString(p.sessionId));
      const pnl = calcUnrealizedPnl(p, markPrice);
      const runnerId = sessionRunnerId(session);
      return {
        id: idString(p._id),
        sessionId: idString(p.sessionId),
        shortId: idString(p.sessionId)?.slice(-6).toUpperCase() || null,
        strategyType: session?.strategyType || null,
        strategyName: strategyNameForSession(session, pineMap),
        runnerId,
        running: runningIds.has(runnerId),
        type: p.type,
        entry: p.entry,
        markPrice,
        qty: p.qty,
        lots: normalizedLots(p),
        marginUsed: normalizedMarginUsed(p, session),
        leverage: Number(p.leverage) || 1,
        pnl: pnl.pnl,
        pnlPct: pnl.pnlPct,
        liquidationPrice: p.liquidationPrice ?? null,
        entryTime: p.entryTime,
      };
    });

    const closed = tradeDocs.map(t => {
      const session = sessionMap.get(idString(t.sessionId));
      const runnerId = sessionRunnerId(session);
      return {
        id: idString(t._id),
        sessionId: idString(t.sessionId),
        shortId: idString(t.sessionId)?.slice(-6).toUpperCase() || null,
        strategyType: session?.strategyType || null,
        strategyName: strategyNameForSession(session, pineMap),
        runnerId,
        running: runningIds.has(runnerId),
        type: t.type,
        entry: t.entry,
        exit: t.exit,
        qty: t.qty,
        lots: normalizedLots(t),
        marginUsed: normalizedMarginUsed(t, session),
        leverage: Number(t.leverage) || 1,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        reason: t.reason,
        exitTime: t.exitTime,
        entryTime: t.entryTime,
      };
    });

    const strategyMap = new Map();
    const ensureStrategy = (row) => {
      const key = row.runnerId || row.strategyName || 'unknown';
      if (!strategyMap.has(key)) {
        strategyMap.set(key, {
          runnerId: row.runnerId || null,
          strategyName: row.strategyName || 'Unknown Strategy',
          running: Boolean(row.running),
          openCount: 0,
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
          openPnl: 0,
          realizedPnl: 0,
          netPnl: 0,
          marginUsed: 0,
          lastTradeTime: null,
        });
      }
      const item = strategyMap.get(key);
      item.running = item.running || Boolean(row.running);
      return item;
    };

    for (const row of open) {
      const item = ensureStrategy(row);
      item.openCount += 1;
      item.openPnl += Number.isFinite(row.pnl) ? row.pnl : 0;
      item.marginUsed += Number(row.marginUsed) || 0;
    }

    for (const row of closed) {
      const item = ensureStrategy(row);
      item.tradeCount += 1;
      item.realizedPnl += Number(row.pnl) || 0;
      item.winCount += row.pnl > 0 ? 1 : 0;
      item.lossCount += row.pnl <= 0 ? 1 : 0;
      item.lastTradeTime = Math.max(item.lastTradeTime || 0, Number(row.exitTime) || 0) || item.lastTradeTime;
    }

    const strategyRows = [...strategyMap.values()]
      .map(item => ({
        ...item,
        winRate: item.tradeCount ? item.winCount / item.tradeCount * 100 : 0,
        netPnl: item.realizedPnl + item.openPnl,
      }))
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return (b.netPnl || 0) - (a.netPnl || 0);
      });

    const dailyMap = new Map();
    for (const row of closed) {
      const key = utcDayKey(row.exitTime);
      if (!key) continue;
      if (!dailyMap.has(key)) {
        dailyMap.set(key, {
          date: key,
          realizedPnl: 0,
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
          strategies: new Set(),
        });
      }
      const day = dailyMap.get(key);
      day.realizedPnl += Number(row.pnl) || 0;
      day.tradeCount += 1;
      day.winCount += row.pnl > 0 ? 1 : 0;
      day.lossCount += row.pnl <= 0 ? 1 : 0;
      if (row.strategyName) day.strategies.add(row.strategyName);
    }

    const dailyRows = [...dailyMap.values()]
      .map(day => ({
        date: day.date,
        realizedPnl: day.realizedPnl,
        tradeCount: day.tradeCount,
        winCount: day.winCount,
        lossCount: day.lossCount,
        strategyCount: day.strategies.size,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const openPnl = open.reduce((sum, row) => sum + (Number.isFinite(row.pnl) ? row.pnl : 0), 0);
    const realizedPnl = closed.reduce((sum, row) => sum + (Number(row.pnl) || 0), 0);

    res.json({
      markPrice,
      dateRange: {
        fromDate: Number.isFinite(fromMs) ? new Date(fromMs).toISOString().slice(0, 10) : null,
        toDate: Number.isFinite(toMs) ? new Date(toMs).toISOString().slice(0, 10) : null,
      },
      summary: {
        runningStrategies: strategyRows.filter(row => row.running).length,
        openCount: open.length,
        closedCount: closed.length,
        openPnl,
        realizedPnl,
        netPnl: openPnl + realizedPnl,
        winningDays: dailyRows.filter(day => day.realizedPnl > 0).length,
        losingDays: dailyRows.filter(day => day.realizedPnl < 0).length,
      },
      strategyRows,
      dailyRows,
      open,
      closed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/positions/reset-all', async (_req, res) => {
  try {
    const runners = Object.values(manager.runners || {});
    for (const runner of runners) await resetRunnerToConfiguredState(runner);

    await Promise.all([
      Position.deleteMany({}),
      Trade.deleteMany({}),
      DailyPnl.deleteMany({}),
      Equity.deleteMany({}),
      Session.deleteMany({}),
    ]);

    manager.maybeStopWs();
    await Promise.all([
      emitPineState(),
      emitAllInOneState(),
      emitUTBotState(),
      manager.sendSessionsList(io),
    ]);
    io.emit('all_status', manager.allStatus());

    res.json({ ok: true });
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
      positionSizePct: cfg?.positionSizePct ?? 100,
      leverage: cfg?.leverage || 1,
      minProfitBookingPct: cfg?.minProfitBookingPct ?? 0.5,
      profitRatioBooking: cfg?.profitRatioBooking ?? 1.67,
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
      positionSizePct = 100,
      leverage = 1,
      minProfitBookingPct = 0.5,
      profitRatioBooking = 1.67,
      autoStart = false,
      setActive = false,
    } = req.body || {};
    if (!code.trim()) return res.status(400).json({ error: 'Pine code is required' });
    if (code.length > 500000) return res.status(400).json({ error: 'Pine code is too large' });

    const safeCapital = +capital || 10000;
    const safeRisk = +risk || 2;
    const safeLotSize = Math.max(1, Math.round(+lotSize || 1));
    const safePositionSizePct = Math.max(0, +positionSizePct || 100);
    const safeLeverage = Math.max(1, Number(leverage) || 1);
    const safeMinProfitBookingPct = Math.max(0, +minProfitBookingPct || 0);
    const safeProfitRatioBooking = Math.max(0.1, +profitRatioBooking || 1.67);
    const temp = new PineScriptStrategy({
      name: String(name).slice(0, 80),
      code,
      capital: safeCapital,
      riskPerTradePct: safeRisk,
      lotSize: safeLotSize,
      positionSizePct: safePositionSizePct,
      leverage: safeLeverage,
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
      leverage: safeLeverage,
      minProfitBookingPct: safeMinProfitBookingPct,
      profitRatioBooking: safeProfitRatioBooking,
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
        leverage: safeLeverage,
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
      leverage: safeLeverage,
      minProfitBookingPct: safeMinProfitBookingPct,
      profitRatioBooking: safeProfitRatioBooking,
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
    runner.strategy.reset(pineStrategyOptions(doc));
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
    applyPineRuntimeOptions(doc, req.body || {});
    await doc.save();
    const runner = await setActivePineScript(doc);
    if (
      req.body?.capital || req.body?.risk ||
      req.body?.lotSize !== undefined || req.body?.positionSizePct !== undefined || req.body?.leverage !== undefined || req.body?.minProfitBookingPct !== undefined ||
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
      positionSizePct = 100,
      leverage = 1,
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
      leverage: +leverage,
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

  startStrategyWatchdog();

  server.listen(PORT, () => {
    console.log('\n' + '═'.repeat(62));
    console.log('  🚀  BTC Multi-Strategy Bot  |  Server-Side Persistent Engine');
    console.log(`  📡  http://localhost:${PORT}`);
    console.log(`  🔐  Auth: ${DASHBOARD_EMAIL}`);
    console.log(`  🗄️   MongoDB: ${process.env.MONGO_URI || 'mongodb://localhost:27017/btc_scalping_bot'}`);
    console.log('  🧾  Position source: local MongoDB only');
    console.log('  📝  Mode: PAPER TRADING  |  Strategies run 24/7 on server');
    console.log('═'.repeat(62) + '\n');
  });
}

bootstrap();
