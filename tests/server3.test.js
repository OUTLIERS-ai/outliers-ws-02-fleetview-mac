'use strict';
// Faults found in the second review, 2026-09-22. Each test was written before its fix.
//  - a damaged config.json was swallowed: folder names gone, port back to 3010, nothing said
//  - reading a big log file kept the only thread, so the page stopped answering (7 seconds seen)
// Every run uses a temp folder. Never the real ~/.claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const WATCHER = path.join(__dirname, '..', 'watcher.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start: ' + url);
}
// Starts FleetView on a config file whose exact bytes the test chooses.
async function startWithConfigBytes(t, bytes, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-cfg-'));
  const projects = path.join(root, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const port = await freePort();
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, bytes);
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, PORT: String(port), FLEETVIEW_NO_CCUSAGE: '1', ...extra };
  const child = spawn(process.execPath, [WATCHER], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + '/api/meta');
  return { root, projects, port, base, cfgFile };
}

const GOOD = { port: 3010, folders: [{ name: 'CRM', path: 'C:\\Demo\\CRM' }], usage: { enabled: false } };
const DAMAGED = {
  'byte-order mark (saved from Notepad)': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(GOOD, null, 2))]),
  'a comma after the last item': Buffer.from('{\n  "port": 3010,\n  "folders": [],\n}\n'),
  'a // comment': Buffer.from('{\n  // my folders\n  "port": 3010,\n  "folders": []\n}\n'),
  'half written': Buffer.from('{\n  "port": 3010,\n  "folders": [{ "name": "CRM",\n'),
  'not UTF-8': Buffer.concat([Buffer.from('{ "port": 3010, "folders": [{ "name": "CR'), Buffer.from([0xff, 0xfe, 0x9d]), Buffer.from('M" }] }')]),
};

test('a damaged config.json is reported, never swallowed', async (t) => {
  for (const [what, bytes] of Object.entries(DAMAGED)) {
    const s = await startWithConfigBytes(t, bytes);
    const meta = await (await fetch(s.base + '/api/meta')).json();
    assert.ok(meta.configError, what + ': /api/meta must carry configError');
    assert.ok(typeof meta.configError.line === 'number' && meta.configError.line >= 1,
      what + ': the fault must name a line, got ' + JSON.stringify(meta.configError));
    assert.match(meta.configError.message, /config\.json/i, what + ': the message must name the file');
    assert.ok(meta.configError.usingDefaults === true, what + ': the page must be told the settings are the defaults');
    assert.deepEqual(meta.folders, [], what + ': the folder names really are lost, so say so');
  }
});

test('a good config.json reports no fault', async (t) => {
  const s = await startWithConfigBytes(t, Buffer.from(JSON.stringify(GOOD, null, 2)));
  const meta = await (await fetch(s.base + '/api/meta')).json();
  assert.equal(meta.configError, null);
  assert.deepEqual(meta.folders, ['CRM']);
});

test('both pages carry the words that show a config fault', () => {
  for (const f of ['graph.html', 'cards.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.match(src, /configError/, f + ' must read meta.configError');
    assert.match(src, /could not be read/i, f + ' must be able to say the settings file could not be read');
  }
});

// The real shape of the fault: a member's log folder holds hundreds of files
// (Ashley's holds 2,440, 3.1 GB). They all arrive at once when FleetView starts,
// and a synchronous read of each one, back to back, kept the only thread long
// enough for the page to put up a red "FleetView stopped" banner while the
// server was running perfectly.
test('a log folder full of files does not stop the page answering', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-many-'));
  const projects = path.join(root, '.claude', 'projects');
  const dir = path.join(projects, 'C--Demo--Many');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const FILES = 300, LINES = 400;
  for (let i = 0; i < FILES; i++) {
    const lines = [];
    for (let j = 0; j < LINES; j++) lines.push(JSON.stringify({ type: 'assistant', sessionId: 'many-' + i, cwd: 'C:\\Demo\\Many',
      timestamp: now, message: { id: 'm' + i + '-' + j, model: 'claude-opus-5', role: 'assistant', stop_reason: null,
        content: [{ type: 'text', text: 'w'.repeat(300) }], usage: { output_tokens: 1 } } }));
    fs.writeFileSync(path.join(dir, 'many-' + i + '.jsonl'), lines.join('\n') + '\n');
  }
  const port = await freePort();
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ folders: [], usage: { enabled: false } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, PORT: String(port), FLEETVIEW_NO_CCUSAGE: '1' };
  const started = Date.now();
  const child = spawn(process.execPath, [WATCHER], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  let firstAnswer = 0, worst = 0, sessions = 0, calls = 0;
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + '/api/graph', { cache: 'no-store' });
      const body = await r.json();
      const took = Date.now() - t0;
      if (!firstAnswer) firstAnswer = Date.now() - started;
      else worst = Math.max(worst, took);
      calls++;
      sessions = body.totals.sessions;
      if (sessions >= FILES) break;
    } catch { /* not listening yet */ }
    await sleep(50);
  }
  assert.equal(sessions, FILES, 'every one of the ' + FILES + ' made-up sessions was read');
  assert.ok(firstAnswer < 4000, 'the page got its first answer after ' + firstAnswer + ' ms; it must not wait for the whole folder');
  assert.ok(worst < 1000, 'the slowest answer while reading ' + FILES + ' log files was ' + worst +
    ' ms over ' + calls + ' calls; the page gives up and shows "FleetView stopped" after about 5 seconds');
  console.log('300 files read; first answer ' + firstAnswer + ' ms, slowest answer ' + worst + ' ms over ' + calls + ' calls');
});

test('the page keeps answering while 1 big log file is read', async (t) => {
  const s = await startWithConfigBytes(t, Buffer.from(JSON.stringify({ folders: [], usage: { enabled: false } })));
  // ~40 MB in one session log, the shape Claude Code writes.
  const dir = path.join(s.projects, 'C--Demo--Big');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const lineFor = (n) => JSON.stringify({ type: 'assistant', sessionId: 'big-one', cwd: 'C:\\Demo\\Big', timestamp: now,
    message: { id: 'm' + n, model: 'claude-opus-5', role: 'assistant', stop_reason: null,
      content: [{ type: 'text', text: 'w'.repeat(300) }], usage: { output_tokens: 1 } } });
  const f = path.join(dir, 'big-one.jsonl');
  const fd = fs.openSync(f, 'w');
  try {
    for (let i = 0; i < 50; i++) {
      const chunk = [];
      for (let j = 0; j < 2000; j++) chunk.push(lineFor(i * 2000 + j));
      fs.writeSync(fd, chunk.join('\n') + '\n');
    }
  } finally { fs.closeSync(fd); }
  const size = fs.statSync(f).size;

  let worst = 0, calls = 0, tokens = 0;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const t0 = Date.now();
    const r = await fetch(s.base + '/api/graph', { cache: 'no-store' });
    const took = Date.now() - t0;
    const body = await r.json();
    calls++;
    worst = Math.max(worst, took);
    tokens = body.totals.outputTokens;
    if (tokens >= 100000) break;
    await sleep(50);
  }
  assert.equal(tokens, 100000, 'the whole file was read (' + (size / 1048576).toFixed(1) + ' MB)');
  assert.ok(worst < 1000, 'the slowest answer while reading ' + (size / 1048576).toFixed(1) +
    ' MB was ' + worst + ' ms over ' + calls + ' calls; it must stay under 1000 ms');
});
