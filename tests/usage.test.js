'use strict';
// The token panel must count Claude Code only. `ccusage daily` (no "claude")
// adds every AI coding tool it finds (Codex, Gemini, Grok ...), checked live
// with ccusage 20.0.24 on 2026-09-22.
const test = require('node:test');
const assert = require('node:assert');
const U = require('../lib/usage');

test('ccusage is asked for Claude Code only, at a pinned version', () => {
  assert.equal(U.command('ccusage@20.0.24', 'blocks --active'), 'npx -y ccusage@20.0.24 claude blocks --active --json');
  assert.equal(U.command('ccusage@20.0.24', 'daily'), 'npx -y ccusage@20.0.24 claude daily --json');
  assert.equal(U.DEFAULT_PACKAGE, 'ccusage@20.0.24');
});

test('an old config that says ccusage@20 is moved to the pinned version', () => {
  assert.equal(U.packageFrom('ccusage@20'), U.DEFAULT_PACKAGE);
  assert.equal(U.packageFrom(undefined), U.DEFAULT_PACKAGE);
  assert.equal(U.packageFrom('ccusage@21.0.0'), 'ccusage@21.0.0');
});

test('the 7-day figure adds up the last 7 days of the Claude-only answer', () => {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const day = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const answer = { daily: [
    { date: day(0), totalTokens: 100, totalCost: 1 },
    { date: day(6), totalTokens: 10, totalCost: 0.5 },
    { date: day(7), totalTokens: 1000, totalCost: 9 },
  ] };
  assert.deepEqual(U.weekFromDaily(answer, today), { tokens: 110, cost: 1.5, days: 2 });
});
