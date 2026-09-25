'use strict';
// Your own logs decide whether the price table is complete.
//
// The hand-written check in pricing.test.js only knows the names somebody
// thought of. This one reads the Claude Code logs on THIS computer from the
// last 7 days, collects every model name in them, and fails when one has no
// row in lib/prices.json. That is how claude-opus-5-5 slipped through on
// 2026-09-22: it was in 6 real logs and in no test.
//
// It only reads. It writes nothing, and it is skipped when there are no logs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPricing } = require('../lib/pricing');

const DAYS = 7;
const MAX_FILES = 400;          // newest first, so a huge history does not slow the suite
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;

function logsFolder() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}
function recentLogs(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recentLogs(p, out);
    else if (e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); if (Date.now() - st.mtimeMs < DAYS * 86400e3) out.push({ p, at: st.mtimeMs }); } catch { /* gone */ }
    }
  }
  return out;
}
// The names FleetView prices (a reply's own model) plus the ones Claude Code
// writes when a session asks for a model by name ("opus", "sonnet").
function modelsIn(file) {
  const found = new Map();
  let text;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - MAX_BYTES_PER_FILE);
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return found; }
  for (const line of text.split('\n')) {
    if (!line.includes('"model"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const add = (m, where) => { if (m && typeof m === 'string' && m !== '<synthetic>' && !found.has(m)) found.set(m, where); };
    if (ev.message && ev.message.model) add(ev.message.model, path.basename(file) + ' (a reply)');
    const content = ev.message && ev.message.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.input && typeof b.input.model === 'string') add(b.input.model, path.basename(file) + ' (a helper agent asked for it)');
    }
  }
  return found;
}

test('every model name in your own recent logs has a price row', () => {
  const dir = logsFolder();
  if (!fs.existsSync(dir)) { console.log('skipped: no Claude Code log folder at ' + dir); return; }
  const files = recentLogs(dir).sort((a, b) => b.at - a.at).slice(0, MAX_FILES);
  if (!files.length) { console.log('skipped: no Claude Code logs written in the last ' + DAYS + ' days'); return; }
  const seen = new Map();
  for (const f of files) for (const [m, where] of modelsIn(f.p)) if (!seen.has(m)) seen.set(m, where);
  const missing = [...seen].filter(([m]) => !getPricing(m));
  assert.deepEqual(missing.map(([m, where]) => m + ' — ' + where), [],
    'these model names are in your logs with no row in lib/prices.json, so their tokens are left out of the $ figure');
  assert.ok(seen.size > 0, 'found ' + seen.size + ' model names in ' + files.length + ' recent logs');
  console.log('checked ' + seen.size + ' model names across ' + files.length + ' recent log files: ' + [...seen.keys()].join(', '));
});
