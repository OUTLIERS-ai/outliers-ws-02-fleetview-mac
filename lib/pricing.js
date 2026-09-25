// Price table and context-window rules for FleetView.
//
// Every dollar figure FleetView shows is what the tokens WOULD cost on the paid
// Claude API at standard rates. On a Claude subscription (Pro / Max) you do not
// pay these amounts; treat them as a size gauge, not a bill.
//
// Rates live in prices.json (checked 2026-09-22 against
// https://platform.claude.com/docs/en/about-claude/pricing). A model with no
// row returns null here and the page shows "price unknown" — never a guess.
'use strict';
const fs = require('fs');
const path = require('path');

const PRICE_FILE = path.join(__dirname, 'prices.json');
const TABLE = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8'));
const PRICES_CHECKED = TABLE.checked;
const PRICES_SOURCE = TABLE.source;

const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

// "claude-opus-5[1m]" -> "claude-opus-5"; "claude-haiku-4-5-20251001" -> "claude-haiku-4-5";
// "anthropic.claude-opus-5" / "claude-haiku-4-5@20251001" -> base id.
function normaliseModel(model) {
  if (!model || typeof model !== 'string') return '';
  let m = model.trim().toLowerCase();
  m = m.replace(/\[1m\]$/, '');
  m = m.replace(/^(us\.|eu\.|global\.)?anthropic\./, '');
  m = m.replace(/@.*$/, '');
  m = m.replace(/-v\d+(:\d+)?$/, '');
  m = m.replace(/-\d{8}$/, '');
  return m;
}

// Claude Code also takes a bare word as a model name (claude --model opus).
// aliases says what each word meant on the day the table was checked.
const ALIASES = TABLE.aliases || {};
const RETIRED = TABLE.retired || {};

function aliasTarget(word) {
  return ALIASES[normaliseModel(word)] || null;
}

function getPricing(model) {
  const key = normaliseModel(model);
  if (!key) return null;
  return TABLE.models[key] || TABLE.models[ALIASES[key]] || null;
}

// Retired from Anthropic's own API (still sold on Amazon Bedrock and Google Cloud).
function isRetired(model) {
  const key = normaliseModel(model);
  return !!RETIRED[key] || !!RETIRED[ALIASES[key]];
}
function retiredOn(model) { return RETIRED[normaliseModel(model)] || null; }
function retiredModels() { return Object.keys(RETIRED); }

// Cost of one API reply. usage = the `usage` object Claude Code logs.
// Returns null when the model has no price row.
function costOfUsage(model, usage) {
  const p = getPricing(model);
  if (!p) return null;
  const u = usage || {};
  let scale = 1;
  if (u.speed === 'fast' && p.fast) scale = p.fast.input / p.input; // fast mode: premium base, cache multipliers on top
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const writeTotal = u.cache_creation_input_tokens || 0;
  let w1h = 0, w5m = writeTotal;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    w1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
    w5m = Math.max(0, writeTotal - w1h);
  }
  const outRate = (u.speed === 'fast' && p.fast) ? p.fast.output : p.output;
  return (
    input * p.input * scale +
    output * outRate +
    w5m * p.cacheWrite5m * scale +
    w1h * p.cacheWrite1h * scale +
    read * p.cacheRead * scale
  ) / 1_000_000;
}

// Which context window a session is on.
//  - model id ends in [1m]              -> 1,000,000 ("model id")
//  - any main-thread turn above 200,000 -> 1,000,000 ("seen above 200k")
//  - otherwise                           -> 200,000 ("assumed")
function contextWindowFor(model, maxTurnInput) {
  if (typeof model === 'string' && /\[1m\]$/i.test(model.trim())) {
    return { size: LARGE_WINDOW, source: 'model id' };
  }
  if ((maxTurnInput || 0) > STANDARD_WINDOW) {
    return { size: LARGE_WINDOW, source: 'seen above 200k' };
  }
  return { size: STANDARD_WINDOW, source: 'assumed' };
}

module.exports = {
  normaliseModel, getPricing, costOfUsage, contextWindowFor,
  aliasTarget, isRetired, retiredOn, retiredModels,
  PRICES_CHECKED, PRICES_SOURCE, STANDARD_WINDOW, LARGE_WINDOW,
  knownModels: () => Object.keys(TABLE.models),
};
