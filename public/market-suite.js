'use strict';

const PAGE = window.MARKET_PAGE_CONFIG || { page: 'btc', title: 'Market Strategy Bot', namespace: 'btcpage', label: 'BTC', accent: '#58a6ff', symbolOptions: ['BTCUSDT'] };
const $ = id => document.getElementById(id);
const socket = io();

let strategies = [];
let selectedKey = null;
let aggregateState = { running:false, runningCount:0, warmedUp:false, paused:false };
let baseCandles = [];
let currentPrice = null;
let latestStats = {};
let priceChart = null;
let candleSeries = null;
let markerData = [];
let positionLines = {};
let positionsTimer = null;

const TF_MS = { '5m':300000, '15m':900000, '30m':1800000, '1h':3600000, '4h':14400000 };

function esc (value) { return String(value ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m])); }
function fmtUSD (n) { const v = Number(n || 0); return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function fmtPct (n) { const v = Number(n || 0); return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fmtLots (n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:6 }) : '--'; }
function fmtPrice (n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 }) : '--'; }
function fmtTime (v) { return v ? new Date(v).toLocaleString([], { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '--'; }
function pnlCls (n) { return Number(n) > 0 ? 'pos' : (Number(n) < 0 ? 'neg' : ''); }
function badge (txt, kind) { return `<span class="badge ${esc(kind || '')}">${esc(txt || '--')}</span>`; }

async function api (path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function selectedStrategy () { return strategies.find(s => s.key === selectedKey) || null; }
function chartTimeframe () { return selectedStrategy()?.timeframe || $('timeframe')?.value || '5m'; }

function validCandle (c) {
  return c && Number.isFinite(Number(c.openTime)) && Number.isFinite(Number(c.open)) &&
    Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low)) && Number.isFinite(Number(c.close));
}

function sortedCandles (candles = []) {
  const byTime = new Map();
  for (const c of candles || []) {
    if (!validCandle(c)) continue;
    byTime.set(Number(c.openTime), {
      ...c,
      openTime:Number(c.openTime),
      open:Number(c.open),
      high:Number(c.high),
      low:Number(c.low),
      close:Number(c.close),
      volume:Number(c.volume) || 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

function aggregateForChart (candles = []) {
  const clean = sortedCandles(candles);
  const tfMs = TF_MS[chartTimeframe()] || TF_MS['5m'];
  if (tfMs === TF_MS['5m']) return clean;
  const buckets = new Map();
  for (const c of clean) {
    const openTime = Math.floor(c.openTime / tfMs) * tfMs;
    let bucket = buckets.get(openTime);
    if (!bucket) {
      bucket = { openTime, open:c.open, high:c.high, low:c.low, close:c.close, volume:0, closeTime:c.closeTime, isClosed:c.isClosed };
      buckets.set(openTime, bucket);
    }
    bucket.high = Math.max(bucket.high, c.high);
    bucket.low = Math.min(bucket.low, c.low);
    bucket.close = c.close;
    bucket.volume += Number(c.volume) || 0;
    bucket.closeTime = c.closeTime || bucket.closeTime;
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

function upsertBaseCandle (c) {
  if (!validCandle(c)) return;
  baseCandles = sortedCandles([...baseCandles, c]).slice(-1200);
  renderCandles(baseCandles, false);
}

function options () {
  return {
    symbol: $('symbol').value,
    timeframe: $('timeframe').value,
    capital: Number($('capital').value) || 1000,
    leverage: Math.max(1, Number($('leverage').value) || 1),
    buyFeePct: Math.max(0, Number($('buy-fee-pct').value) || 0),
    sellFeePct: Math.max(0, Number($('sell-fee-pct').value) || 0),
  };
}

function setOptions (s = {}) {
  const symbol = s.symbol || PAGE.symbolOptions?.[0] || PAGE.symbol || 'BTCUSDT';
  $('symbol').innerHTML = (s.symbolOptions || PAGE.symbolOptions || [symbol]).map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  $('symbol').value = symbol;
  $('timeframe').value = s.timeframe || '5m';
  $('capital').value = s.capital || 1000;
  $('leverage').value = s.leverage || 1;
  $('buy-fee-pct').value = s.buyFeePct || 0;
  $('sell-fee-pct').value = s.sellFeePct || 0;
  if (baseCandles.length) renderCandles(baseCandles, false);
}

function addLog (level, msg) {
  const log = $('log');
  if (!log) return;
  const row = document.createElement('div');
  row.className = 'log-line';
  const cls = level === 'error' ? 'neg' : level === 'success' ? 'pos' : level === 'warn' ? 'warn' : '';
  row.innerHTML = `<div class="log-time">${fmtTime(Date.now())}</div><div class="${cls}">${esc(msg)}</div>`;
  log.prepend(row);
  while (log.children.length > 150) log.lastChild.remove();
}

function clearLog () { const log = $('log'); if (log) log.innerHTML = ''; }

function updateHeaderStatus (status = aggregateState) {
  aggregateState = { ...aggregateState, ...status };
  const dot = $('run-dot');
  const label = $('run-label');
  if (aggregateState.running) {
    dot.className = aggregateState.warmedUp ? 'dot live' : 'dot warm';
    label.textContent = `${aggregateState.runningCount || 1} LIVE`;
  } else {
    dot.className = 'dot';
    label.textContent = 'STOPPED';
  }
}

function renderStrategies (rows = []) {
  strategies = rows || [];
  if (!selectedKey || !strategies.find(s => s.key === selectedKey)) selectedKey = strategies[0]?.key || null;
  const list = $('strategy-list');
  if (!strategies.length) {
    list.innerHTML = '<div class="empty">No strategies found.</div>';
    return;
  }
  list.innerHTML = strategies.map(row => {
    const running = Boolean(row.status?.running);
    const active = row.key === selectedKey;
    const pnl = Number(row.stats?.totalPnl || 0);
    return `<div class="script-row ${active ? 'active' : ''}" onclick="selectStrategy('${esc(row.key)}')">
      <div>
        <div class="script-name">${esc(row.name)}</div>
        <div class="script-meta">${esc(row.symbol || PAGE.symbol)} / ${esc(row.timeframe)} / Capital ${fmtUSD(row.capital)} / ${Number(row.leverage || 1).toFixed(0)}x / P&L <span class="${pnlCls(pnl)}">${fmtUSD(pnl)}</span></div>
      </div>
      <div class="row-actions">
        ${running ? badge('RUN', 'active') : badge('IDLE', 'saved')}
        <button class="toggle-btn ${running ? 'stop' : 'start'}" type="button" onclick="toggleStrategy(event,'${esc(row.key)}',${running})">${running ? 'Stop' : 'Start'}</button>
      </div>
    </div>`;
  }).join('');
  renderSelected();
}

function renderSelected () {
  const s = selectedStrategy();
  if (!s) return;
  latestStats = s.stats || {};
  setOptions({ ...s, symbolOptions: PAGE.symbolOptions });
  $('status-card').innerHTML = `<b>${esc(s.name)}</b><br><span class="muted">${esc(s.symbol || PAGE.symbol)} / ${esc(s.timeframe)} / Capital ${fmtUSD(s.capital)} / Leverage ${Number(s.leverage || 1).toFixed(0)}x / Buy fee ${Number(s.buyFeePct || 0).toFixed(2)}% / Sell fee ${Number(s.sellFeePct || 0).toFixed(2)}%</span>`;
  $('session-badge').textContent = s.session?.shortId ? `Session ${s.session.shortId}` : 'No session';
  $('chart-strategy').textContent = `${s.name} • ${s.symbol || PAGE.symbol}`;
  $('chart-run-state').textContent = s.status?.running ? (s.status?.paused ? 'Paused' : 'Running') : 'Stopped';
  const pos = s.stats?.position;
  $('chart-pos-state').textContent = pos ? `${String(pos.type).toUpperCase()} @ ${fmtPrice(pos.entry)}` : 'Flat';
  $('chart-pnl-state').textContent = `P&L ${fmtUSD(s.stats?.totalPnl || 0)}`;
  renderCandles(baseCandles, false);
  loadPositions(false).catch(() => {});
}

function selectStrategy (key) {
  selectedKey = key;
  renderStrategies(strategies);
}

async function loadStrategies () {
  renderStrategies(await api(`/api/markets/${PAGE.page}/strategies`));
}

async function saveSettings () {
  await api(`/api/markets/${PAGE.page}/settings`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(options()) });
}

async function startSelected () {
  if (!selectedKey) return;
  await api(`/api/markets/${PAGE.page}/strategies/${selectedKey}/start`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(options()) });
  await loadStrategies();
  addLog('success', 'Strategy started.');
}

async function stopSelected () {
  if (!selectedKey) return;
  await api(`/api/markets/${PAGE.page}/strategies/${selectedKey}/stop`, { method:'POST' });
  await loadStrategies();
  addLog('warn', 'Strategy stopped.');
}

async function pauseSelected () {
  if (!selectedKey) return;
  await api(`/api/markets/${PAGE.page}/strategies/${selectedKey}/pause`, { method:'POST' });
  await loadStrategies();
  addLog('warn', 'Strategy paused.');
}

async function resumeSelected () {
  if (!selectedKey) return;
  await api(`/api/markets/${PAGE.page}/strategies/${selectedKey}/resume`, { method:'POST' });
  await loadStrategies();
  addLog('success', 'Strategy resumed.');
}

async function resetSelected () {
  if (!selectedKey) return;
  await api(`/api/markets/${PAGE.page}/strategies/${selectedKey}/reset`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(options()) });
  await loadStrategies();
  addLog('warn', 'Strategy reset.');
}

async function toggleStrategy (event, key, running) {
  event.stopPropagation();
  if (running) {
    await api(`/api/markets/${PAGE.page}/strategies/${key}/stop`, { method:'POST' });
    addLog('warn', `${key} stopped.`);
  } else {
    await api(`/api/markets/${PAGE.page}/strategies/${key}/start`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(options()) });
    addLog('success', `${key} started.`);
  }
  await loadStrategies();
}

async function loadPositions (flash = false) {
  const data = await api(`/api/positions?runnerPrefix=${encodeURIComponent(`market:${PAGE.page}:`)}`);
  $('positions-updated-at').textContent = `Updated ${fmtTime(Date.now())}`;
  $('positions-bot-pill').textContent = `BOTS ${data.summary?.openCount || 0} OPEN`;
  $('pos-open-count').textContent = data.summary?.openCount || 0;
  $('pos-closed-count').textContent = data.summary?.closedCount || 0;
  $('pos-open-pnl').textContent = fmtUSD(data.summary?.openPnl || 0);
  $('pos-closed-pnl').textContent = fmtUSD(data.summary?.closedPnl || 0);
  $('pos-net-pnl').textContent = fmtUSD(data.summary?.netPnl || 0);
  renderOpenPositions(data.open || []);
  renderClosedPositions(data.closed || []);
  if (flash) addLog('info', 'Positions refreshed.');
}

function renderOpenPositions (rows = []) {
  const body = $('positions-open-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="15" class="muted">No open positions.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `<tr>
    <td>${badge('OPEN', 'open')}</td>
    <td>${esc(row.strategyName)}</td>
    <td>${badge(String(row.type || '').toUpperCase(), row.type)}</td>
    <td>${fmtPrice(row.entry)}</td>
    <td>${fmtPrice(row.markPrice)}</td>
    <td>${fmtPrice(row.sl)}</td>
    <td>${fmtPrice(row.trailSl)}</td>
    <td>${fmtPrice(row.tp)}</td>
    <td>${fmtUSD(row.marginUsed)}</td>
    <td>${fmtLots(row.lots)}</td>
    <td class="${pnlCls(row.pnl)}">${fmtUSD(row.pnl)}</td>
    <td class="${pnlCls(row.pnlPct)}">${fmtPct(row.pnlPct)}</td>
    <td>${Number(row.leverage || 1).toFixed(0)}x</td>
    <td>${fmtTime(row.entryTime)}</td>
    <td><button class="danger-btn" type="button" onclick="forceClose('${esc(row.runnerId)}')">Force Close</button></td>
  </tr>`).join('');
}

function renderClosedPositions (rows = []) {
  const body = $('positions-closed-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="15" class="muted">No closed positions.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `<tr>
    <td>${badge('CLOSED', 'closed')}</td>
    <td>${esc(row.strategyName)}</td>
    <td>${badge(String(row.type || '').toUpperCase(), row.type)}</td>
    <td>${fmtPrice(row.entry)}</td>
    <td>${fmtPrice(row.exit)}</td>
    <td>${fmtPrice(row.sl)}</td>
    <td>${fmtPrice(row.trailSl)}</td>
    <td>${fmtPrice(row.tp)}</td>
    <td>${fmtUSD(row.marginUsed)}</td>
    <td>${fmtLots(row.lots)}</td>
    <td class="${pnlCls(row.pnl)}">${fmtUSD(row.pnl)}</td>
    <td class="${pnlCls(row.pnlPct)}">${fmtPct(row.pnlPct)}</td>
    <td>${Number(row.leverage || 1).toFixed(0)}x</td>
    <td>${esc(row.reason || '--')}</td>
    <td>${fmtTime(row.exitTime)}</td>
  </tr>`).join('');
}

async function forceClose (runnerId) {
  await api('/api/positions/force-close', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ runnerId }) });
  addLog('warn', 'Position force-closed.');
  await loadPositions(false);
  await loadStrategies();
}

async function resetAllPaperData () {
  if (!confirm(`Delete ${PAGE.label} page positions, trades, and PNL history only? This will stop ${PAGE.label} bots on this page and reset their sessions.`)) return;
  await api('/api/positions/reset-scoped', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ runnerPrefix:`market:${PAGE.page}:` }) });
  addLog('warn', `${PAGE.label} page positions and PNL reset.`);
  await loadStrategies();
  await loadPositions(false);
}

function ensureChart () {
  if (priceChart) return;
  priceChart = LightweightCharts.createChart($('price-chart'), {
    layout:{ background:{ color:'#0b1220' }, textColor:'#93a4bb' },
    grid:{ vertLines:{ color:'#1f2937' }, horzLines:{ color:'#1f2937' } },
    rightPriceScale:{ borderColor:'#253045' },
    timeScale:{ borderColor:'#253045', timeVisible:true, secondsVisible:false },
    crosshair:{ mode:0 },
  });
  candleSeries = priceChart.addCandlestickSeries({
    upColor:'#00e676', downColor:'#ff5c74', wickUpColor:'#00e676', wickDownColor:'#ff5c74', borderVisible:false,
  });
  window.addEventListener('resize', () => priceChart?.applyOptions({ width:$('price-chart').clientWidth }));
}

function renderCandles (candles = [], fit = true) {
  ensureChart();
  const rows = aggregateForChart(candles).map(c => ({ time:Math.floor(Number(c.openTime) / 1000), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close) }));
  candleSeries.setData(rows);
  renderMarkers();
  renderPositionLines();
  if (fit) priceChart.timeScale().fitContent();
  $('chart-last').textContent = rows.length ? `Last candle ${fmtTime(rows[rows.length - 1].time * 1000)}` : 'Waiting for candles';
}

function renderMarkers () {
  const s = selectedStrategy();
  if (!s || !candleSeries) return;
  const trades = s.stats?.recentTrades || [];
  markerData = trades.slice(0, 80).map(trade => ({
    time: Math.floor(Number(trade.exitTime || trade.entryTime) / 1000),
    position: trade.type === 'long' ? 'belowBar' : 'aboveBar',
    color: trade.type === 'long' ? '#00e676' : '#ff5c74',
    shape: trade.type === 'long' ? 'arrowUp' : 'arrowDown',
    text: trade.reason || trade.type,
  })).filter(m => Number.isFinite(m.time));
  candleSeries.setMarkers(markerData);
}

function clearPositionLines () {
  Object.values(positionLines).forEach(line => { try { priceChart.removePriceLine(line); } catch {} });
  positionLines = {};
}

function renderPositionLines () {
  clearPositionLines();
  const pos = selectedStrategy()?.stats?.position;
  if (!pos || !candleSeries) return;
  if (Number.isFinite(Number(pos.entry))) positionLines.entry = candleSeries.createPriceLine({ price:Number(pos.entry), color:'#58a6ff', lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'Entry' });
  if (Number.isFinite(Number(pos.sl))) positionLines.sl = candleSeries.createPriceLine({ price:Number(pos.sl), color:'#ff5c74', lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'SL' });
  if (Number.isFinite(Number(pos.trailSl))) positionLines.trail = candleSeries.createPriceLine({ price:Number(pos.trailSl), color:'#ffd740', lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'Trail' });
  if (Number.isFinite(Number(pos.tp))) positionLines.tp = candleSeries.createPriceLine({ price:Number(pos.tp), color:'#00e676', lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'TP' });
}

socket.on(`${PAGE.namespace}:ws_status`, status => {
  $('ws-feed').textContent = status?.feed ? 'ON' : 'OFF';
  $('ws-feed').className = status?.feed ? 'pos' : 'neg';
  if (status?.error) addLog('warn', `Feed: ${status.error}`);
});
socket.on(`${PAGE.namespace}:candles`, candles => {
  baseCandles = sortedCandles(candles || []).slice(-1200);
  renderCandles(baseCandles, false);
});
socket.on(`${PAGE.namespace}:ticker`, ticker => {
  currentPrice = Number(ticker?.price || 0) || null;
  $('header-price').textContent = currentPrice ? fmtPrice(currentPrice) : '--';
});
socket.on(`${PAGE.namespace}:status`, updateHeaderStatus);
socket.on(`${PAGE.namespace}:runners`, renderStrategies);
socket.on(`${PAGE.namespace}:runner_event`, payload => {
  if (!payload) return;
  if (payload.status) updateHeaderStatus(payload.status);
  if (payload.key && payload.key === selectedKey && payload.stats) latestStats = payload.stats;
  if (payload.event === 'position_opened' || payload.event === 'trade_closed' || payload.event === 'status') loadPositions(false).catch(() => {});
  loadStrategies().catch(() => {});
});
socket.on('log', row => {
  const id = String(row.strategyId || row.strategy || '');
  if (!id || id.startsWith(`market:${PAGE.page}:`)) addLog(row.level || 'info', row.msg || '');
});

async function boot () {
  $('brand-label').textContent = PAGE.title;
  $('chart-title').textContent = `${PAGE.label} Candles / Selected State`;
  $('page-label').textContent = PAGE.label.toUpperCase();
  const settings = await api(`/api/markets/${PAGE.page}/settings`);
  setOptions({ ...settings, symbolOptions: settings.symbolOptions || PAGE.symbolOptions || [] });
  await loadStrategies();
  await loadPositions(false);
  ensureChart();
  if (positionsTimer) clearInterval(positionsTimer);
  positionsTimer = setInterval(() => loadPositions(false).catch(() => {}), 10000);
}

window.selectStrategy = selectStrategy;
window.toggleStrategy = toggleStrategy;
window.saveSettings = async () => { try { await saveSettings(); await loadStrategies(); addLog('success', 'Settings saved.'); } catch (e) { addLog('error', e.message); } };
window.startSelected = async () => { try { await startSelected(); } catch (e) { addLog('error', e.message); } };
window.stopSelected = async () => { try { await stopSelected(); } catch (e) { addLog('error', e.message); } };
window.pauseSelected = async () => { try { await pauseSelected(); } catch (e) { addLog('error', e.message); } };
window.resumeSelected = async () => { try { await resumeSelected(); } catch (e) { addLog('error', e.message); } };
window.resetSelected = async () => { try { await resetSelected(); } catch (e) { addLog('error', e.message); } };
window.forceClose = runnerId => forceClose(runnerId).catch(e => addLog('error', e.message));
window.loadPositions = flash => loadPositions(flash).catch(e => addLog('error', e.message));
window.resetAllPaperData = () => resetAllPaperData().catch(e => addLog('error', e.message));
window.clearLog = clearLog;

boot().catch(error => addLog('error', error.message));
