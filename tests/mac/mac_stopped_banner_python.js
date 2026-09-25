'use strict';
// Wave 6 fault (build plan V3, fault row 18 kind): when FleetView stops, both pages show a banner
// that tells the member how to start it again. The banner was written into public/graph.html and
// public/cards.html as `python install.py --start`, so on a Mac it named a command a Mac does not
// have (a Mac has python3 and no plain python). Found by the FleetView Mac-guide writer, 2026-09-25.
//
// The server now tells the page its Python word in /api/meta (`python`), the way ProjectForge's
// board does (its fault row 7): python3 on a Mac, python everywhere else, so the Windows banner
// reads word for word as before.
//
// Named mac_*.js so the plain `npm test` never runs it (the 60 checks the guides print stay 60).
// Runs on every system, by name:  node --test tests/mac/mac_stopped_banner_python.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const HERE = path.join(__dirname, '..', '..');
const WANT = process.platform === 'darwin' ? 'python3' : 'python';

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

test('the server tells the pages the Python word for this computer', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-banner-'));
  const port = await freePort();
  const cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port, host: '127.0.0.1', folders: [], usage: { enabled: false } }));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const child = spawn(process.execPath, [path.join(HERE, 'watcher.js')], {
    cwd: HERE, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HOME: root, USERPROFILE: root, FLEETVIEW_CONFIG: cfg, CLAUDE_CONFIG_DIR: claudeDir, PORT: String(port) },
  });
  try {
    let meta = null;
    const end = Date.now() + 20000;
    while (Date.now() < end && !meta) {
      try { meta = await getJson(port, '/api/meta'); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(meta, 'FleetView did not start');
    assert.strictEqual(meta.python, WANT, '/api/meta says ' + JSON.stringify(meta.python) + ', not ' + WANT);
  } finally { child.kill(); }
});

test('neither page writes the Python word into its stopped banner itself', () => {
  for (const page of ['graph.html', 'cards.html']) {
    const src = fs.readFileSync(path.join(HERE, 'public', page), 'utf8');
    assert.ok(!/python install\.py --start/.test(src),
      page + ' writes "python install.py --start" into its banner, which a Mac cannot run');
    assert.ok(/meta\.python|m\.python/.test(src) || /\.python\b/.test(src),
      page + ' does not take the Python word from /api/meta');
  }
});
