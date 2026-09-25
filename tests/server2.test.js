'use strict';
// Server faults found in the 2026-09-22 review, each with a test written before the fix.
// Every run uses a temp folder with made-up sessions. Never the real ~/.claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const WATCHER = path.join(__dirname, '..', 'watcher.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start: ' + url);
}
function getWithHost(port, urlPath, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (res) => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}
// Never push a made-up session back past the start of today: FleetView draws
// today's sessions, so a suite run at 00:30 would otherwise build a day with
// nothing in it.
const DAY_START = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const ago = (sec) => new Date(Math.max(Date.now() - sec * 1000, DAY_START + 60 * 1000)).toISOString();
function writeSession(projects, folder, id, events) {
  const dir = path.join(projects, folder.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}
function idleSession(sid, cwd, sec, title) {
  return [
    { type: 'user', sessionId: sid, cwd, timestamp: ago(sec + 10), message: { role: 'user', content: 'Do the task' } },
    { type: 'assistant', sessionId: sid, cwd, timestamp: ago(sec + 5), message: { id: 'm' + sid, model: 'claude-sonnet-5', role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't' + sid, name: 'Read', input: {} }], usage: { input_tokens: 100, output_tokens: 1000 } } },
    { type: 'user', sessionId: sid, cwd, timestamp: ago(sec), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'ai-title', aiTitle: title, sessionId: sid },
  ];
}

async function startServer(t, cfgObj, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-srv-'));
  const port = await freePort();
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ port, usage: { enabled: false }, ...cfgObj(root) }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, ...extraEnv };
  delete env.PORT;
  const child = spawn(process.execPath, [WATCHER], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + '/api/meta');
  return { root, port, base, child, cfgFile };
}

test('1 shared count: totals cover every session today, and trimmed sessions are counted and said', async (t) => {
  const s = await startServer(t, (root) => ({
    projects_dir: fs.mkdirSync(path.join(root, '.claude', 'projects'), { recursive: true }) && path.join(root, '.claude', 'projects'), idle_per_folder: 3,
    folders: [{ name: 'CRM', path: 'C:\\Demo\\CRM' }],
  }));
  const projects = path.join(s.root, '.claude', 'projects');
  for (let i = 1; i <= 5; i++) writeSession(projects, 'C:\\Demo\\CRM', 'idle' + i, idleSession('idle' + i, 'C:\\Demo\\CRM', 600 + i * 60, 'Idle job ' + i));
  await sleep(2500);
  const g = await (await fetch(s.base + '/api/graph')).json();
  assert.ok(Array.isArray(g.sessions), '/api/graph returns { sessions, totals }');
  assert.equal(g.sessions.length, 3, '3 idle drawn');
  assert.equal(g.totals.sessions, 5, 'but all 5 counted');
  assert.equal(g.hidden, 2, 'and the page is told 2 were left out');
  assert.deepEqual(g.hiddenByGroup, { CRM: 2 });
  assert.equal(g.totals.outputTokens, 5000);
  const all = await (await fetch(s.base + '/api/graph?all=1')).json();
  assert.equal(all.sessions.length, 5);
  assert.deepEqual(all.totals, g.totals, 'the totals never depend on what is drawn');
});

test('a request naming another site in its Host header is refused (DNS rebinding)', async (t) => {
  const s = await startServer(t, (root) => ({ projects_dir: path.join(root, '.claude', 'projects') }));
  const bad = await getWithHost(s.port, '/api/graph', 'attacker.example:' + s.port);
  assert.equal(bad.status, 403);
  const bad2 = await getWithHost(s.port, '/api/sessions', 'attacker.example');
  assert.equal(bad2.status, 403);
  const ok = await getWithHost(s.port, '/api/graph', 'localhost:' + s.port);
  assert.equal(ok.status, 200);
  const ok2 = await getWithHost(s.port, '/api/graph', '127.0.0.1:' + s.port);
  assert.equal(ok2.status, 200);
});

test('a log folder created after FleetView started is picked up without a restart', async (t) => {
  const s = await startServer(t, (root) => ({ projects_dir: path.join(root, '.claude', 'projects') }));
  const meta0 = await (await fetch(s.base + '/api/meta')).json();
  assert.equal(meta0.logsFolderFound, false);
  const projects = path.join(s.root, '.claude', 'projects');
  writeSession(projects, 'C:\\Demo\\Late', 'late1', idleSession('late1', 'C:\\Demo\\Late', 60, 'Late session'));
  let n = 0;
  for (let i = 0; i < 40 && n === 0; i++) { await sleep(500); n = (await (await fetch(s.base + '/api/graph')).json()).totals.sessions; }
  assert.equal(n, 1, 'session seen within 20 seconds');
  const meta = await (await fetch(s.base + '/api/meta')).json();
  assert.equal(meta.logsFolderFound, true);
});

test('the server records its own process number, so --stop can find a copy started at logon', async (t) => {
  const s = await startServer(t, (root) => ({ projects_dir: path.join(root, '.claude', 'projects') }));
  const pidFile = path.join(s.root, 'fleetview.pid');
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(rec.pid, s.child.pid);
  assert.equal(rec.port, s.port);
  const meta = await (await fetch(s.base + '/api/meta')).json();
  assert.equal(meta.pid, s.child.pid);
});

test('the graph is the front page; the cards live at /cards.html and load nothing from the internet', async (t) => {
  const s = await startServer(t, (root) => ({ projects_dir: path.join(root, '.claude', 'projects') }));
  const r = await fetch(s.base + '/', { redirect: 'manual' });
  assert.ok([301, 302].includes(r.status));
  assert.match(r.headers.get('location'), /graph\.html/);
  const cards = await (await fetch(s.base + '/cards.html')).text();
  assert.doesNotMatch(cards, /https?:\/\/(unpkg|cdn|fonts)/, 'cards page must not load outside scripts or fonts');
  for (const f of ['/vendor/react.production.min.js', '/vendor/react-dom.production.min.js']) {
    assert.equal((await fetch(s.base + f)).status, 200, f);
  }
});
