'use strict';
// Starts the real server against a temp home full of made-up sessions and asks it
// for every page and route. Never reads the real ~/.claude.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeDemoHome } = require('./helpers');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start: ' + url);
}

test('server answers every page and route from made-up sessions', async (t) => {
  const demo = makeDemoHome();
  const port = await freePort();
  const env = { ...process.env, HOME: demo.root, USERPROFILE: demo.root, CLAUDE_CONFIG_DIR: path.join(demo.root, '.claude'),
    FLEETVIEW_CONFIG: demo.config, PORT: String(port) };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'watcher.js')], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + '/api/meta');
  await new Promise(r => setTimeout(r, 1500)); // let the watcher read the files

  for (const p of ['/', '/graph.html', '/cards.html']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  const html = await (await fetch(base + '/graph.html')).text();
  assert.match(html, /not money taken from your subscription/);
  assert.doesNotMatch(html, /API-equivalent/);

  const graph = (await (await fetch(base + '/api/graph')).json()).sessions;
  const groups = new Set(graph.map(s => s.group));
  for (const g of ['Second Brain', 'CRM', 'Content Engine', 'Other']) assert.ok(groups.has(g), 'missing group ' + g);
  assert.equal(graph.length, 8, 'yesterday is hidden');
  assert.ok(graph.some(s => s.subagents.length === 1 && s.subagents[0].agentType === 'note-finder'));
  assert.ok(graph.some(s => s.contextWindow === 1_000_000));
  assert.ok(graph.some(s => s.priceKnown === false && s.unpricedTokens > 0));

  const all = (await (await fetch(base + '/api/graph?all=1')).json()).sessions;
  assert.equal(all.length, 8, '?all=1 draws every session today, none trimmed; yesterday stays off');

  const sessions = await (await fetch(base + '/api/sessions')).json();
  assert.ok(sessions.length >= 4);

  const usage = await (await fetch(base + '/api/usage')).json();
  assert.equal(usage.enabled, false);           // the demo config switches ccusage off
  assert.match(usage.error, /switched off/);

  const meta = await (await fetch(base + '/api/meta')).json();
  assert.equal(meta.pricesChecked, '2026-09-22');
  assert.deepEqual(meta.folders, ['Second Brain', 'CRM', 'Content Engine']);
});
