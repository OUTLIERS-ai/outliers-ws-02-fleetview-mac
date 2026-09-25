'use strict';
// Wave 1 second read, run 36039773042: on GitHub's Windows machine "the page keeps answering while
// 1 big log file is read" (tests/server3.test.js) read nothing in 25 seconds, 1 run in 3 to 10.
// Measured 2026-09-24 (runs 36062980178 and 36064033510): the test's own FleetView was running and
// answering, and its record showed chokidar "ready" and then no event at all: the new project folder
// and its log were never reported, so never read. Claude Code makes a new folder for every new
// project, so a member could meet the same.
//
// This check loses chokidar's report on purpose (a preload drops every event for 1 folder), so it
// shows the fault on any computer, every time. FleetView must still read that folder's log.
// Kept in tests/mac/ and named mac_*.js, so the plain `npm test` never runs it and the 60 checks the
// guides print stay 60. Run it by name, on either system (after npm install):
//   node --test tests/mac/mac_missed_folder_is_read.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const WATCHER = path.join(REPO, 'watcher.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test('a log whose folder chokidar never reports is still read', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-lost-'));
  const projects = path.join(root, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  // The preload: chokidar reports nothing at all about C--Demo--Lost, as on the Windows machine.
  const hook = path.join(root, 'lose-one-folder.js');
  fs.writeFileSync(hook, `
const { FSWatcher } = require(require.resolve('chokidar', { paths: [${JSON.stringify(REPO)}] }));
const emit = FSWatcher.prototype.emit;
FSWatcher.prototype.emit = function (ev, ...rest) {
  if (rest.some((a) => typeof a === 'string' && a.includes('C--Demo--Lost'))) return false;
  return emit.call(this, ev, ...rest);
};
`);
  const port = await freePort();
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ folders: [], usage: { enabled: false } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, PORT: String(port), FLEETVIEW_NO_CCUSAGE: '1' };
  const child = spawn(process.execPath, ['--require', hook, WATCHER], { env, windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  const up = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + '/api/meta')).ok) break; } catch { /* not up yet */ }
    if (Date.now() > up) throw new Error('FleetView did not start');
    await sleep(200);
  }
  const dir = path.join(projects, 'C--Demo--Lost');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(JSON.stringify({ type: 'assistant', sessionId: 'lost-one', cwd: 'C:\\Demo\\Lost',
    timestamp: now, message: { id: 'l' + i, model: 'claude-opus-5', role: 'assistant', stop_reason: null,
      content: [{ type: 'text', text: 'hello' }], usage: { output_tokens: 1 } } }));
  fs.writeFileSync(path.join(dir, 'lost-one.jsonl'), lines.join('\n') + '\n');
  let tokens = 0;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { tokens = (await (await fetch(base + '/api/graph', { cache: 'no-store' })).json()).totals.outputTokens; } catch { /* busy */ }
    if (tokens >= 50) break;
    await sleep(250);
  }
  assert.equal(tokens, 50, 'the log in a folder chokidar never reported was not read within 20 seconds');
});
