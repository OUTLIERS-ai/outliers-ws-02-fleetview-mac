'use strict';
// Found in the acceptance test on 2026-09-23. A damaged config.json was refused
// by  python install.py --start  and ignored by every other way of starting:
// the logon launcher, npm start and node watcher.js all started anyway, on the
// DEFAULT port, with every folder name gone. A member whose FleetView sits on
// another port found their pinned browser tab dead and a second copy on the
// default port, which is the port another piece in this set expects.
//
// The rule now: the port is the one FleetView last really ran on (its
// fleetview.pid record), and when there is no such record it does not start at
// all and says so in the same words install.py --start uses.
//
// Every run uses a temp folder. Never the real ~/.claude.
//
// FLEETVIEW_TEST_WATCHER and FLEETVIEW_TEST_DEFAULT_PORT point these checks at
// a copy of watcher.js with a different default port. That is how the failing
// run was proved before the fix: the default port is in use on this computer by
// the member's own FleetView, and no test may ever take it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const WATCHER = process.env.FLEETVIEW_TEST_WATCHER || path.join(__dirname, '..', 'watcher.js');
const DEFAULT_PORT = Number(process.env.FLEETVIEW_TEST_DEFAULT_PORT || 3010);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A port nothing is listening on, counting up from 3961.
function freePortFrom(start) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', () => freePortFrom(start + 1).then(resolve, reject));
    s.listen(start, '127.0.0.1', () => s.close(() => resolve(start)));
  });
}

const TRAILING_COMMA = Buffer.from('{\n  "port": 3961,\n  "folders": [],\n}\n');
const BYTE_ORDER_MARK = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('{\n  "port": 3961,\n  "folders": []\n}\n')]);

// Starts watcher.js the way npm start and the logon launcher do: no PORT set.
function start(t, bytes, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-refuse-'));
  fs.mkdirSync(path.join(root, '.claude', 'projects'), { recursive: true });
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, bytes);
  if (opts.pidRecord) fs.writeFileSync(path.join(root, 'fleetview.pid'), JSON.stringify(opts.pidRecord));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    FLEETVIEW_CONFIG: cfgFile, FLEETVIEW_NO_CCUSAGE: '1' };
  delete env.PORT;
  const child = spawn(process.execPath, [WATCHER], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ended = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  return { root, cfgFile, child, ended, said: () => out };
}

for (const [what, bytes] of [['a comma after the last item', TRAILING_COMMA], ['a byte-order mark', BYTE_ORDER_MARK]]) {
  test('node watcher.js refuses a damaged config.json (' + what + ') rather than taking the default port', async (t) => {
    const s = start(t, bytes);
    const code = await Promise.race([s.ended, sleep(15000).then(() => 'still running')]);
    assert.notEqual(code, 'still running', what + ': it started anyway. It said: ' + s.said());
    assert.notEqual(code, 0, what + ': it must stop with a fault, not quietly. It said: ' + s.said());
    assert.doesNotMatch(s.said(), new RegExp('localhost:' + DEFAULT_PORT),
      what + ': it must never serve on the default port after damage. It said: ' + s.said());
    assert.match(s.said(), /was NOT started/, what + ': the same words install.py --start uses');
    assert.match(s.said(), /config\.json/, what + ': the message must name the file');
    assert.match(s.said(), /line \d+/, what + ': the message must name the line');
  });
}

test('a damaged config.json keeps the port FleetView last ran on, not the default', async (t) => {
  const port = await freePortFrom(3961);
  const s = start(t, TRAILING_COMMA, { pidRecord: { pid: 999999, port, startedAt: '2026-09-23T09:00:00.000Z' } });
  const base = 'http://127.0.0.1:' + port;
  let meta = null;
  const end = Date.now() + 15000;
  while (Date.now() < end && !meta) {
    try { const r = await fetch(base + '/api/meta'); if (r.ok) meta = await r.json(); } catch { /* not up yet */ }
    await sleep(200);
  }
  assert.ok(meta, 'it did not answer on port ' + port + '. It said: ' + s.said());
  assert.equal(meta.port, port, 'it kept the port it last ran on');
  assert.ok(meta.configError, 'the page is still told the settings file is damaged');
  assert.doesNotMatch(s.said(), new RegExp('localhost:' + DEFAULT_PORT), 'it must never fall back to the default port');
});

test('the message about a damaged config.json is written once, in lib/config.js', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.js'), 'utf8');
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');
  assert.match(lib, /was NOT started/, 'the refusal words live in lib/config.js');
  assert.match(watcher, /refusalLines/, 'watcher.js uses them rather than writing its own');
  assert.doesNotMatch(watcher, /Folder names and port are the defaults/,
    'the old line claimed the defaults were used, which is what this fault was');
});
