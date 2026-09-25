'use strict';
// Fault row 6, build plan V3: the token panel was never seen working on a test Mac.
//
// Measured 2026-09-24: with a made-up Claude Code history, ccusage (the tool behind the panel)
// answers with the tokens used; with no history at all (a computer where Claude Code has not run
// a session yet, as on GitHub's test Macs) ccusage stops with "No valid Claude data directories
// found", and the panel said "ccusage could not run". Nothing is broken on such a computer:
// nothing has been used yet, and the panel must say that.
//
// Not a Mac-only fault, but kept in tests/mac/ and named mac_*.js so the plain `npm test`
// never runs it and the 60 checks the guides print stay 60. Run it by name, on either system:
//   node --test tests/mac/mac_token_panel.js
// It needs `npm install` first, and the internet for the first npx download of ccusage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const HERE = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function startFleetView(claudeDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-panel-'));
  const port = await freePort();
  const cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port, host: '127.0.0.1', folders: [] }));
  const child = spawn(process.execPath, [path.join(HERE, 'watcher.js')], {
    cwd: HERE, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HOME: root, USERPROFILE: root, FLEETVIEW_CONFIG: cfg, CLAUDE_CONFIG_DIR: claudeDir, PORT: String(port) },
  });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await getJson(port, '/api/meta'); return { child, port }; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  child.kill();
  throw new Error('FleetView did not start');
}

// Ask /api/usage until the panel has an answer (the first ccusage run downloads it).
async function panelAnswer(port, ms) {
  const end = Date.now() + ms;
  let u;
  while (Date.now() < end) {
    u = await getJson(port, '/api/usage');
    if (u.fetchedAt && !u.pending) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return u;
}

test('with no Claude Code history yet, the panel says nothing is used, not "could not run"', { timeout: 240000 }, async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-no-history-'));
  const { child, port } = await startFleetView(claudeDir);
  try {
    const u = await panelAnswer(port, 200000);
    assert.ok(u && u.fetchedAt, 'the panel never answered: ' + JSON.stringify(u));
    assert.strictEqual(u.error, null, 'panel error: ' + u.error);
    assert.strictEqual(u.block, null);
  } finally { child.kill(); }
});

test('with a made-up Claude Code history, the panel shows the tokens used', { timeout: 240000 }, async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-history-'));
  const proj = path.join(claudeDir, 'projects', '-Users-member-Second-Brain');
  fs.mkdirSync(proj, { recursive: true });
  const line = {
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's1', requestId: 'r1',
    cwd: '/Users/member/Second Brain',
    message: { id: 'm1', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  };
  fs.writeFileSync(path.join(proj, 's1.jsonl'), JSON.stringify(line) + '\n');
  const { child, port } = await startFleetView(claudeDir);
  try {
    const u = await panelAnswer(port, 200000);
    assert.ok(u && u.fetchedAt, 'the panel never answered: ' + JSON.stringify(u));
    assert.strictEqual(u.error, null, 'panel error: ' + u.error);
    assert.ok(u.block, 'no current 5-hour window: ' + JSON.stringify(u));
    assert.strictEqual(u.block.totalTokens, 1500);
  } finally { child.kill(); }
});
