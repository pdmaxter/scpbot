'use strict';

const crypto = require('crypto');
const https  = require('https');

const { ExchangeOrder } = require('./db');

const DEFAULT_BASE_URL = 'https://cdn-ind.testnet.deltaex.org';
const DEFAULT_SYMBOL   = 'BTCUSD';

function envValue (env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function envBool (env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt (value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n));
}

function objectIdOrNull (value) {
  if (!value) return null;
  const str = String(value);
  return /^[0-9a-f]{24}$/i.test(str) ? str : null;
}

function compactObject (obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function queryString (params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  });
  const raw = qs.toString();
  return raw ? `?${raw}` : '';
}

function tsValue (value) {
  if (!value) return 0;
  if (typeof value === 'number') return value > 1e15 ? Math.floor(value / 1000) : value;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return asNum > 1e15 ? Math.floor(asNum / 1000) : asNum;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull (value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class DeltaDemoClient {
  constructor (env = process.env) {
    this.apiKey = envValue(env, ['DELTA_API_KEY', 'DeltaAPIKey', 'DELTA_DEMO_API_KEY']);
    this.apiSecret = envValue(env, ['DELTA_API_SECRET', 'DeltaAPISecret', 'DELTA_DEMO_API_SECRET']);
    this.baseUrl = (envValue(env, ['DELTA_DEMO_BASE_URL', 'DELTA_BASE_URL']) || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.productSymbol = (envValue(env, ['DELTA_PRODUCT_SYMBOL', 'DELTA_DEMO_PRODUCT_SYMBOL']) || DEFAULT_SYMBOL).toUpperCase();
    this.productId = positiveInt(envValue(env, ['DELTA_PRODUCT_ID', 'DELTA_DEMO_PRODUCT_ID']));
    this.fixedOrderSize = positiveInt(envValue(env, ['DELTA_ORDER_SIZE', 'DELTA_DEMO_ORDER_SIZE']));
    this.useBotSize = envBool(env, 'DELTA_USE_BOT_SIZE', true);
    this.maxOrderSize = positiveInt(envValue(env, ['DELTA_MAX_ORDER_SIZE', 'DELTA_DEMO_MAX_ORDER_SIZE']));
    this.enabled = envBool(env, 'DELTA_DEMO_ENABLED', true) && Boolean(this.apiKey && this.apiSecret);
    this.userAgent = envValue(env, ['DELTA_USER_AGENT']) || 'scpbot-node';
    this.credentialSource = this.apiKey && this.apiSecret ? 'env' : 'none';
    this.product = null;
    this.lastError = null;
  }

  configure (cfg = {}) {
    const nextBaseUrl = (cfg.baseUrl || this.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const nextSymbol = (cfg.productSymbol || this.productSymbol || DEFAULT_SYMBOL).toUpperCase();
    const nextProductId = positiveInt(cfg.productId);
    if (nextBaseUrl !== this.baseUrl || nextSymbol !== this.productSymbol || nextProductId !== this.productId) {
      this.product = null;
    }
    if (cfg.apiKey !== undefined) this.apiKey = String(cfg.apiKey || '').trim();
    if (cfg.apiSecret !== undefined) this.apiSecret = String(cfg.apiSecret || '').trim();
    this.baseUrl = nextBaseUrl;
    this.productSymbol = nextSymbol;
    this.productId = nextProductId;
    this.enabled = Boolean(cfg.enabled) && Boolean(this.apiKey && this.apiSecret);
    this.credentialSource = cfg.credentialSource || (this.apiKey && this.apiSecret ? 'database' : 'none');
    this.lastError = null;
  }

  status () {
    return {
      provider: 'delta-demo',
      enabled: this.enabled,
      configured: Boolean(this.apiKey && this.apiSecret),
      baseUrl: this.baseUrl,
      productSymbol: this.productSymbol,
      productId: this.product?.id || this.productId || null,
      credentialSource: this.credentialSource,
      sizing: 'bot_lot_size',
      fixedOrderSize: this.fixedOrderSize || 1,
      maxOrderSize: this.maxOrderSize,
      lastError: this.lastError,
    };
  }

  async placeOpen ({ runner, position }) {
    const side = position.type === 'short' ? 'sell' : 'buy';
    return this.placeOrder({
      action: 'open',
      runner,
      positionType: position.type,
      requestedQty: position.qty,
      lotSize: runner?.lotSize || position.lotSize || position.qty,
      side,
      reduceOnly: false,
      tradeId: null,
    });
  }

  async placeClose ({ runner, trade }) {
    const side = trade.type === 'short' ? 'buy' : 'sell';
    return this.placeOrder({
      action: 'close',
      runner,
      positionType: trade.type,
      requestedQty: trade.qty,
      lotSize: runner?.lotSize || trade.lotSize || trade.qty,
      side,
      reduceOnly: true,
      tradeId: trade.id,
    });
  }

  async placeOrder (input) {
    if (!this.enabled) {
      return { skipped: true, reason: 'Delta demo is not configured or disabled' };
    }

    const product = await this.resolveProduct();
    const size = this.orderSize(input, product);
    const clientOrderId = this.clientOrderId(input);
    const request = {
      product_id: product.id,
      size,
      side: input.side,
      order_type: 'market_order',
      reduce_only: Boolean(input.reduceOnly),
      client_order_id: clientOrderId,
    };

    const audit = await this.createAudit(input, product, request);
    try {
      const response = await this.signedRequest('POST', '/v2/orders', request);
      await this.updateAudit(audit, { status: 'sent', response });
      this.lastError = null;
      return { ok: true, request, response };
    } catch (error) {
      this.lastError = error.message;
      await this.updateAudit(audit, {
        status: 'failed',
        error: error.message,
        response: error.payload || null,
      });
      throw error;
    }
  }

  async syncAccount (opts = {}) {
    if (!this.enabled) throw new Error('Delta demo is not configured or disabled');
    const product = await this.resolveProduct();
    const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 1), 50);
    const fromMs = Number(opts.fromMs) || 0;
    const endMs = Number(opts.toMs) || 0;
    const timeQuery = {
      ...(fromMs ? { start_time: fromMs * 1000 } : {}),
      ...(endMs ? { end_time: endMs * 1000 } : {}),
    };
    const [positionsRes, marginedRes, ordersRes, fillsRes] = await Promise.all([
      this.signedRequest('GET', `/v2/positions${queryString({ product_id: product.id })}`).catch(e => ({ error: e.message, result: [] })),
      this.signedRequest('GET', `/v2/positions/margined${queryString({ product_ids: product.id })}`).catch(e => ({ error: e.message, result: [] })),
      this.signedRequest('GET', `/v2/orders/history${queryString({ product_ids: product.id, page_size: pageSize, ...timeQuery })}`).catch(e => ({ error: e.message, result: [] })),
      this.signedRequest('GET', `/v2/fills${queryString({ product_ids: product.id, page_size: pageSize, ...timeQuery })}`).catch(e => ({ error: e.message, result: [] })),
    ]);
    const positions = this.normalizePositions(positionsRes.result, marginedRes.result, product);
    const orders = Array.isArray(ordersRes.result) ? ordersRes.result : [];
    const fills = Array.isArray(fillsRes.result) ? fillsRes.result : [];
    const trades = this.closedTradesFromFills(fills, product);
    const realizedPnl = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const openPnl = positions.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
    this.lastError = positionsRes.error || marginedRes.error || ordersRes.error || fillsRes.error || null;
    return {
      provider: 'delta-demo',
      product,
      positions,
      orders,
      fills,
      trades,
      summary: {
        openCount: positions.length,
        closedCount: trades.length,
        openPnl,
        closedPnl: realizedPnl,
        netPnl: openPnl + realizedPnl,
      },
      errors: [positionsRes.error, marginedRes.error, ordersRes.error, fillsRes.error].filter(Boolean),
      syncedAt: new Date().toISOString(),
    };
  }

  async resolveProduct () {
    if (this.product) return this.product;
    if (this.productId) {
      this.product = { id: this.productId, symbol: this.productSymbol };
      return this.product;
    }
    const response = await this.publicRequest('GET', `/v2/products/${encodeURIComponent(this.productSymbol)}`);
    const product = response.result || response;
    if (!product?.id) throw new Error(`Delta product not found for ${this.productSymbol}`);
    this.product = product;
    return product;
  }

  orderSize (input) {
    let size = positiveInt(input.lotSize) || this.fixedOrderSize || 1;
    if (!positiveInt(input.lotSize) && !this.fixedOrderSize && this.useBotSize) {
      size = positiveInt(input.requestedQty) || 1;
    }
    if (this.maxOrderSize) size = Math.min(size, this.maxOrderSize);
    return Math.max(1, Math.round(size));
  }

  normalizePositions (positionsResult, marginedResult, product) {
    const raw = Array.isArray(positionsResult) ? positionsResult : (positionsResult ? [positionsResult] : []);
    const margined = Array.isArray(marginedResult) ? marginedResult : (marginedResult ? [marginedResult] : []);
    const marginMap = new Map(margined.map(p => [String(p.product_id || p.product?.id || product.id), p]));
    return raw
      .map(p => ({ ...p, ...(marginMap.get(String(p.product_id || p.product?.id || product.id)) || {}) }))
      .map(p => {
        const size = Number(p.size || p.position_size || 0);
        if (!size) return null;
        const entry = numberOrNull(p.entry_price || p.entry || p.average_entry_price);
        const mark = numberOrNull(p.mark_price || p.liquidation_price || p.last_price);
        const side = size < 0 ? 'short' : 'long';
        const absSize = Math.abs(size);
        const qty = absSize * Number(product.contract_value || 1);
        const pnl = numberOrNull(p.unrealized_pnl || p.pnl) ?? (
          entry && mark
            ? (side === 'long' ? (mark - entry) : (entry - mark)) * qty
            : null
        );
        return {
          id: `delta-${product.id}`,
          state: 'open',
          source: 'delta',
          strategyName: 'Delta Exchange',
          strategyType: 'exchange',
          runnerId: null,
          type: side,
          entry,
          markPrice: mark,
          qty,
          size: absSize,
          productId: product.id,
          productSymbol: product.symbol || this.productSymbol,
          pnl,
          pnlPct: entry && qty && pnl !== null ? pnl / (entry * qty) * 100 : null,
          entryTime: tsValue(p.created_at || p.updated_at),
          exchange: p,
        };
      })
      .filter(Boolean);
  }

  closedTradesFromFills (fills, product) {
    const rows = Array.isArray(fills) ? fills.slice() : [];
    const ordered = rows
      .filter(f => f.side && Number(f.size) > 0 && Number(f.price) > 0)
      .sort((a, b) => tsValue(a.created_at || a.timestamp) - tsValue(b.created_at || b.timestamp));
    const openLots = [];
    const trades = [];
    const contractValue = Number(product.contract_value || 1);

    for (const fill of ordered) {
      let remaining = Number(fill.size);
      const side = String(fill.side).toLowerCase();
      const price = Number(fill.price);
      const fillTime = tsValue(fill.created_at || fill.timestamp);
      const commission = Number(fill.commission || fill.meta_data?.total_commission_in_settling_asset || 0);
      const opposite = side === 'buy' ? 'short' : 'long';

      while (remaining > 0 && openLots.length && openLots[0].type === opposite) {
        const lot = openLots[0];
        const closeSize = Math.min(remaining, lot.size);
        const qty = closeSize * contractValue;
        const gross = lot.type === 'long' ? (price - lot.entry) * qty : (lot.entry - price) * qty;
        const commissionShare = commission * (closeSize / Number(fill.size));
        const entryCommissionShare = lot.commission * (closeSize / lot.sizeOriginal);
        const pnl = gross - commissionShare - entryCommissionShare;
        trades.push({
          id: `${lot.orderId || 'fill'}-${fill.id || fillTime}`,
          state: 'closed',
          source: 'delta',
          strategyName: 'Delta Exchange',
          strategyType: 'exchange',
          type: lot.type,
          entry: lot.entry,
          exit: price,
          qty,
          size: closeSize,
          pnl,
          pnlPct: lot.entry && qty ? pnl / (lot.entry * qty) * 100 : null,
          reason: 'exchange_fill',
          entryTime: lot.time,
          exitTime: fillTime,
          productId: product.id,
          productSymbol: product.symbol || this.productSymbol,
          exchange: { openFill: lot.raw, closeFill: fill },
        });
        lot.size -= closeSize;
        remaining -= closeSize;
        if (lot.size <= 0) openLots.shift();
      }

      if (remaining > 0) {
        openLots.push({
          type: side === 'buy' ? 'long' : 'short',
          entry: price,
          size: remaining,
          sizeOriginal: remaining,
          commission: commission * (remaining / Number(fill.size)),
          time: fillTime,
          orderId: fill.order_id,
          raw: fill,
        });
      }
    }
    return trades.reverse();
  }

  clientOrderId ({ action, runner, tradeId }) {
    const runnerId = String(runner?.id || 'bot').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'bot';
    const suffix = crypto.randomBytes(3).toString('hex');
    const raw = `scp${action[0]}${runnerId}${tradeId || Date.now().toString(36)}${suffix}`;
    return raw.slice(0, 32);
  }

  async createAudit (input, product, request) {
    const runner = input.runner || {};
    return ExchangeOrder.create(compactObject({
      provider: 'delta-demo',
      action: input.action,
      status: 'pending',
      runnerId: runner.id,
      sessionId: objectIdOrNull(runner.sessionId),
      strategyType: runner.sessionStrategyType,
      pineScriptId: objectIdOrNull(runner.pineScriptId),
      strategyName: runner.displayName,
      tradeId: input.tradeId,
      positionType: input.positionType,
      side: input.side,
      productId: product.id,
      productSymbol: product.symbol || this.productSymbol,
      requestedQty: input.requestedQty,
      size: request.size,
      reduceOnly: request.reduce_only,
      clientOrderId: request.client_order_id,
      request,
    })).catch(() => null);
  }

  async updateAudit (audit, patch) {
    if (!audit?._id) return;
    await ExchangeOrder.findByIdAndUpdate(audit._id, patch).catch(() => {});
  }

  signedRequest (method, pathWithQuery, body = null) {
    const payload = body ? JSON.stringify(body) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(method.toUpperCase() + timestamp + pathWithQuery + payload)
      .digest('hex');

    return this.request(method, pathWithQuery, payload, {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': this.apiKey,
      signature,
      timestamp,
      'User-Agent': this.userAgent,
    });
  }

  publicRequest (method, pathWithQuery) {
    return this.request(method, pathWithQuery, '', {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    });
  }

  request (method, pathWithQuery, payload, headers) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathWithQuery, this.baseUrl);
      const req = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: compactObject({
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        }),
      }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : {}; } catch (e) {
            const err = new Error(`Delta returned non-JSON response (${res.statusCode})`);
            err.payload = raw;
            reject(err);
            return;
          }
          if (res.statusCode >= 400 || json?.success === false) {
            const code = json?.error?.code || json?.error || res.statusCode;
            const err = new Error(`Delta request failed: ${code}`);
            err.payload = json;
            reject(err);
            return;
          }
          resolve(json);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Delta request timed out')));
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { DeltaDemoClient };
