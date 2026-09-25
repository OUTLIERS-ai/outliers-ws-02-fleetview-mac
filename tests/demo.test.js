'use strict';
// The demo has to be able to make a busy day, because a busy day is where the
// second review found the fault: 18 of 30 circles amber said nothing.
//   node tools/make-demo.js <folder> --sessions 30
// Every run writes to a temp folder. Never the real ~/.claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createStore } = require('../lib/sessions');

const DEMO = path.join(__dirname, '..', 'tools', 'make-demo.js');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function countStates(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetview-demo-' + n + '-'));
  const out = execFileSync(process.execPath, [DEMO, root, '--sessions', String(n)], { encoding: 'utf8', windowsHide: true });
  const info = JSON.parse(out);
  const store = createStore();
  for (const f of walk(info.projects)) store.processFile(f);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const counts = { total: 0, waiting: 0, approval: 0, thinking: 0, finished: 0, idle: 0 };
  for (const s of store.sessions.values()) {
    if (!s.lastEventAt || new Date(s.lastEventAt) < today) continue;
    counts.total++;
    counts[store.view(s).status]++;
  }
  return counts;
}

test('at 3, 10 and 30 made-up sessions the "needs you" count stays small and means something', () => {
  const lines = [];
  for (const n of [3, 10, 30]) {
    const c = countStates(n);
    lines.push(n + ' sessions -> ' + JSON.stringify(c));
    assert.equal(c.total, n, 'the demo made ' + n + ' sessions today');
    assert.ok(c.waiting >= 1, n + ' sessions: at least 1 session really is waiting for an answer');
    assert.ok(c.waiting <= Math.max(2, Math.ceil(n * 0.25)),
      n + ' sessions: ' + c.waiting + ' amber is too many — amber must mean "this one asked you something"');
  }
  console.log(lines.join('\n'));
});
