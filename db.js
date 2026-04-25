'use strict';
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/btc_scalping_bot';

async function connect () {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] Connected →', MONGO_URI);
}

// ─────────────────────────────────────────────────────────────────────────────
//  BotSession  —  one document per trading session
// ─────────────────────────────────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  isRunning:          { type: Boolean,  default: false   },
  strategyType:       { type: String,   default: 'scalping' },
  pineScriptId:       { type: mongoose.Schema.Types.ObjectId, ref: 'PineScriptConfig', index: true },
  executionMode:      { type: String,   enum: ['paper'], default: 'paper', index: true },
  initialCapital:     { type: Number,   required: true   },
  currentCapital:     { type: Number,   required: true   },
  dailyStartCapital:  { type: Number                     },
  currentDate:        { type: String                     },  // 'YYYY-MM-DD'
  riskPerTradePct:    { type: Number,   default: 2       },
  startedAt:          { type: Date,     default: Date.now },
  stoppedAt:          { type: Date                       },
  // Aggregate counters (denormalised for fast read)
  tradeCount:         { type: Number,   default: 0       },
  winCount:           { type: Number,   default: 0       },
  lossCount:          { type: Number,   default: 0       },
  grossProfit:        { type: Number,   default: 0       },
  grossLoss:          { type: Number,   default: 0       },
  llmCostUsd:         { type: Number,   default: 0       },
  llmPromptTokens:    { type: Number,   default: 0       },
  llmOutputTokens:    { type: Number,   default: 0       },
  llmThoughtTokens:   { type: Number,   default: 0       },
  llmCallCount:       { type: Number,   default: 0       },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  BotTrade  —  one document per closed trade
// ─────────────────────────────────────────────────────────────────────────────
const tradeSchema = new mongoose.Schema({
  sessionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'BotSession', index: true, required: true },
  tradeNum:   { type: Number },
  type:       { type: String, enum: ['long', 'short'] },
  entry:      Number,
  exit:       Number,
  qty:        Number,
  lotSize:    Number,
  marginUsed: Number,
  leverage:   Number,
  pnl:        Number,
  pnlPct:     Number,
  entryTime:  Number,   // Unix ms
  exitTime:   Number,   // Unix ms
  reason:     String,
  sl:         Number,
  tp:         Number,
}, { timestamps: true });

tradeSchema.index({ sessionId: 1, exitTime: 1 });

// ─────────────────────────────────────────────────────────────────────────────
//  BotDailyPnl  —  one document per (session, date)
// ─────────────────────────────────────────────────────────────────────────────
const dailyPnlSchema = new mongoose.Schema({
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'BotSession', index: true, required: true },
  date:         { type: String, index: true },
  pnl:          Number,
  pnlPct:       Number,
  startCapital: Number,
  endCapital:   Number,
}, { timestamps: true });

dailyPnlSchema.index({ sessionId: 1, date: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
//  BotEquity  —  sampled equity curve (every N candles)
// ─────────────────────────────────────────────────────────────────────────────
const equitySchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotSession', index: true, required: true },
  time:      { type: Number, index: true },   // candle openTime ms
  equity:    Number,
}, { timestamps: true });

equitySchema.index({ sessionId: 1, time: 1 });

// ─────────────────────────────────────────────────────────────────────────────
//  BotPosition  —  current open position snapshot (1 doc, upserted)
// ─────────────────────────────────────────────────────────────────────────────
const positionSchema = new mongoose.Schema({
  sessionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'BotSession', unique: true },
  type:       String,
  entry:      Number,
  sl:         Number,
  tp:         Number,
  trailSl:    Number,
  qty:        Number,
  lotSize:    Number,
  marginUsed: Number,
  leverage:   Number,
  liquidationPrice: Number,
  entryFee:   Number,
  timeframe:  String,
  strategyKey: String,
  decisionReason: String,
  model:      String,
  entryTime:  Number,
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  PineScriptConfig — latest uploaded Pine adapter script
// ─────────────────────────────────────────────────────────────────────────────
const pineScriptSchema = new mongoose.Schema({
  key:      { type: String, default: () => new mongoose.Types.ObjectId().toString(), unique: true },
  name:     { type: String, default: 'Uploaded Pine' },
  code:     { type: String, default: '' },
  meta:     { type: Object, default: {} },
  capital:  { type: Number, default: 10000 },
  riskPerTradePct: { type: Number, default: 2 },
  lotSize: { type: Number, default: 1 },
  positionSizePct: { type: Number, default: 100 },
  leverage: { type: Number, default: 1 },
  minProfitBookingPct: { type: Number, default: 0.5 },
  profitRatioBooking: { type: Number, default: 1.67 },
  isActive: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  AllInOneStrategyConfig — persisted settings for each 10-in-1 strategy
// ─────────────────────────────────────────────────────────────────────────────
const allInOneStrategySchema = new mongoose.Schema({
  key:      { type: String, required: true, unique: true, index: true },
  name:     { type: String, required: true },
  timeframe:{ type: String, default: '5m' },
  capital:  { type: Number, default: 1000 },
  leverage: { type: Number, default: 1 },
  buyFeePct: { type: Number, default: 0 },
  sellFeePct: { type: Number, default: 0 },
  riskPerTradePct: { type: Number, default: 1 },
  atrLength: { type: Number, default: 14 },
  slMultiplier: { type: Number, default: 2 },
  tpMultiplier: { type: Number, default: 4 },
  trailOffset: { type: Number, default: 1.5 },
  isActive: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  LLMStrategyConfig — persisted Gemini-backed strategy settings
// ─────────────────────────────────────────────────────────────────────────────
const llmStrategyConfigSchema = new mongoose.Schema({
  key:      { type: String, required: true, unique: true, index: true },
  name:     { type: String, required: true },
  provider: { type: String, default: 'google-gemini' },
  model:    { type: String, default: 'gemini-2.5-flash' },
  apiKeyEnc:{ type: String, default: '' },
  maxOutputTokens: { type: Number, default: 700 },
  timeframe:{ type: String, default: '5m' },
  capital:  { type: Number, default: 1000 },
  leverage: { type: Number, default: 1 },
  buyFeePct: { type: Number, default: 0 },
  sellFeePct: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  GeminiBTCConfig — settings for Gemini BTC Heikin-Ashi strategy page
// ─────────────────────────────────────────────────────────────────────────────
const geminiBtcConfigSchema = new mongoose.Schema({
  key:      { type: String, default: 'geminibtc', unique: true, index: true },
  name:     { type: String, default: 'Gemini BTC Heikin-Ashi Scalper' },
  timeframe:{ type: String, default: '5m' },
  capital:  { type: Number, default: 1000 },
  leverage: { type: Number, default: 1 },
  lookback: { type: Number, default: 3 },
  buyFeePct: { type: Number, default: 0 },
  sellFeePct: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  UTBotConfig — settings for the dedicated UT Bot Alerts strategy page
// ─────────────────────────────────────────────────────────────────────────────
const utBotConfigSchema = new mongoose.Schema({
  key:      { type: String, default: 'utbot', unique: true, index: true },
  name:     { type: String, default: 'UT Bot Alerts' },
  timeframe:{ type: String, default: '5m' },
  capital:  { type: Number, default: 1000 },
  leverage: { type: Number, default: 1 },
  keyValue: { type: Number, default: 1 },
  atrPeriod:{ type: Number, default: 10 },
  useHeikinAshi: { type: Boolean, default: false },
  buyFeePct: { type: Number, default: 0 },
  sellFeePct: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
//  MT5ConnectionConfig — persisted MetaTrader 5 / Exness connection settings
// ─────────────────────────────────────────────────────────────────────────────
const mt5ConnectionConfigSchema = new mongoose.Schema({
  key:             { type: String, default: 'exness-mt5', unique: true, index: true },
  name:            { type: String, default: 'Exness MT5 Demo' },
  provider:        { type: String, default: 'exness-mt5', index: true },
  enabled:         { type: Boolean, default: false },
  server:          { type: String, default: '' },
  accountLogin:    { type: String, default: '' },
  passwordEnc:     { type: String, default: '' },
  symbol:          { type: String, default: 'BTCUSDm' },
  fixedVolume:     { type: Number, default: 0.01 },
  deviationPoints: { type: Number, default: 200 },
  appPath:         { type: String, default: '/Applications/MetaTrader 5.app' },
  bottlePath:      { type: String, default: '' },
  configPathMac:   { type: String, default: '' },
  configPathWin:   { type: String, default: '' },
  bridgeSourcePath:{ type: String, default: '' },
  bridgeCompiledPath:{ type: String, default: '' },
  configured:      { type: Boolean, default: false },
  lastLaunchAt:    { type: Date, default: null },
  lastError:       { type: String, default: '' },
}, { timestamps: true });

module.exports = {
  connect,
  Session:   mongoose.model('BotSession',   sessionSchema),
  Trade:     mongoose.model('BotTrade',     tradeSchema),
  DailyPnl:  mongoose.model('BotDailyPnl',  dailyPnlSchema),
  Equity:    mongoose.model('BotEquity',    equitySchema),
  Position:  mongoose.model('BotPosition',  positionSchema),
  PineScriptConfig: mongoose.model('PineScriptConfig', pineScriptSchema),
  AllInOneStrategyConfig: mongoose.model('AllInOneStrategyConfig', allInOneStrategySchema),
  LLMStrategyConfig: mongoose.model('LLMStrategyConfig', llmStrategyConfigSchema),
  GeminiBTCConfig: mongoose.model('GeminiBTCConfig', geminiBtcConfigSchema),
  UTBotConfig: mongoose.model('UTBotConfig', utBotConfigSchema),
  MT5ConnectionConfig: mongoose.model('MT5ConnectionConfig', mt5ConnectionConfigSchema),
};
