'use strict';
// Fault row 5, build plan V3: "1 of 60 JavaScript tests failed once on Intel". Measured
// 2026-09-24 (npm test 10 times on each test Mac): on the Intel Mac, "a log folder full of files
// does not stop the page answering" failed 5 of 10 times, the slowest page answer while 300 logs
// were read taking 2,029 to 4,527 ms (the check allows 1,000; the page shows "FleetView stopped"
// after about 5,000). The Apple Silicon Mac: 0 of 10. Cause: the 300 logs each queued their first
// piece for the same turn of the event loop, so a page request waited for all 300.
//
// The same scene as tests/server3.test.js, 5 times in a row, so a slow machine shows the fault
// every run rather than half the time. Kept in tests/mac/ and named mac_*.js, so the plain
// `npm test` never runs it and the 60 checks the guides print stay 60. Run it by name, on
// either system:  node --test tests/mac/mac_page_answers_while_reading.js  (after npm install)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const WATCHER = path.join(__dirname, '..', '..', 'watcher.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function onceWith300Logs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-many-'));
  const dir = path.join(root, '.claude', 'projects', 'Demo-Many');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const FILES = 300, LINES = 400;
  for (let i = 0; i < FILES; i++) {
    const lines = [];
    for (let j = 0; j < LINES; j++) lines.push(JSON.stringify({ type: 'assistant', sessionId: 'many-' + i, cwd: '/Users/demo/Many',
      timestamp: now, message: { id: 'm' + i + '-' + j, model: 'claude-opus-5', role: 'assistant', stop_reason: null,
        content: [{ type: 'text', text: 'w'.repeat(300) }], usage: { output_tokens: 1 } } }));
    fs.writeFileSync(path.join(dir, 'many-' + i + '.jsonl'), lines.join('\n') + '\n');
  }
  const port = await freePort();
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ folders: [], usage: { enabled: false } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, PORT: String(port), FLEETVIEW_NO_CCUSAGE: '1' };
  const child = spawn(process.execPath, [WATCHER], { env, windowsHide: true, stdio: 'ignore' });
  let answered = 0, worst = 0, sessions = 0;
  try {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const t0 = Date.now();
      try {
        const body = await (await fetch(`http://127.0.0.1:${port}/api/graph`, { cache: 'no-store' })).json();
        if (answered++) worst = Math.max(worst, Date.now() - t0);
        sessions = body.totals.sessions;
        if (sessions >= FILES) break;
      } catch { /* not listening yet */ }
      await sleep(50);
    }
  } finally { child.kill(); }
  return { sessions, worst, answered };
}

test('the page keeps answering while 300 logs are read, 5 times in a row', { timeout: 400000 }, async () => {
  for (let run = 1; run <= 5; run++) {
    const r = await onceWith300Logs();
    console.log('run ' + run + ': ' + r.sessions + ' sessions, ' + r.answered + ' answers, slowest ' + r.worst + ' ms');
    assert.equal(r.sessions, 300, 'every log was read');
    assert.ok(r.worst < 1000, 'run ' + run + ': the slowest answer while reading 300 logs was ' + r.worst + ' ms');
    assert.ok(r.answered >= 3, 'run ' + run + ': the page answered only ' + r.answered + ' time(s) while 300 logs were read');
  }
});
