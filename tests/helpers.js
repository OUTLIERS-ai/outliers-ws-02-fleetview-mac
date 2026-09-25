'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// A fresh temp "home" with made-up Claude Code logs. Never the real ~/.claude.
function makeDemoHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-test-'));
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'make-demo.js'), root],
    { encoding: 'utf8', windowsHide: true });
  return { root, ...JSON.parse(out) };
}
module.exports = { makeDemoHome };
