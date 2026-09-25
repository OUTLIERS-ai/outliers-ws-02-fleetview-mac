'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../lib/sessions');
const { makeDemoHome } = require('./helpers');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

test('reads the made-up sessions: models, costs, subagent, 1M window, unknown price', () => {
  const demo = makeDemoHome();
  const store = createStore();
  for (const f of walk(demo.projects)) store.processFile(f);
  const S = demo.sessions;
  const v = (id) => store.view(store.sessions.get(id));

  const brain = v(S.brainActive);
  assert.equal(brain.model, 'claude-opus-5');            // the subagent's Haiku must not overwrite it
  assert.equal(brain.status, 'thinking');
  assert.equal(brain.subagents.length, 1);
  assert.equal(brain.subagents[0].agentType, 'note-finder');
  assert.equal(brain.subagents[0].model, 'claude-haiku-4-5-20251001');
  assert.ok(brain.subagents[0].costUSD > 0);
  assert.equal(brain.turnCount, 3);                        // subagent turns are not the session's turns

  const big = v(S.crmLarge);
  assert.equal(big.contextWindow, 1_000_000);
  assert.equal(big.contextWindowSource, 'model id');
  assert.equal(big.contextPct, 42);                        // 420,006 of 1,000,000

  const waiting = v(S.crmWaiting);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.contextWindow, 200_000);

  const other = v(S.otherUnknown);
  assert.equal(other.priceKnown, false);
  assert.equal(other.costUSD, 0);
  assert.ok(other.unpricedTokens > 0);
  assert.deepEqual(other.unpricedModels, ['claude-nova-7']);
});

test('a turn above 200k without [1m] switches the ring to a 1M window', () => {
  const store = createStore();
  const base = { type: 'assistant', sessionId: 's1', cwd: 'C:\\Demo\\CRM', timestamp: new Date().toISOString() };
  store.processEvent({ ...base, message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'end_turn', content: [],
    usage: { input_tokens: 10, cache_read_input_tokens: 300_000, output_tokens: 5 } } });
  const view = store.view(store.sessions.get('s1'));
  assert.equal(view.contextWindow, 1_000_000);
  assert.equal(view.contextWindowSource, 'seen above 200k');
  assert.equal(view.contextPct, 30);
});

test('the same reply logged twice is counted once', () => {
  const store = createStore();
  const ev = { type: 'assistant', sessionId: 's2', timestamp: new Date().toISOString(),
    message: { id: 'same', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 0, output_tokens: 1_000_000 } } };
  store.processEvent(ev); store.processEvent(ev);
  const view = store.view(store.sessions.get('s2'));
  assert.equal(view.tokensOut, 1_000_000);
  assert.equal(view.costUSD, 10);
  assert.equal(view.turnCount, 1);
});

test('a half-written last line is kept for the next read, not lost', () => {
  const demo = makeDemoHome();
  const f = path.join(demo.projects, 'half', 'half.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const line = JSON.stringify({ type: 'assistant', sessionId: 'half', timestamp: new Date().toISOString(),
    message: { id: 'h1', model: 'claude-opus-5', stop_reason: 'end_turn', content: [], usage: { output_tokens: 100 } } });
  fs.writeFileSync(f, line.slice(0, 40));
  const store = createStore();
  store.processFile(f);
  assert.equal(store.sessions.has('half'), false);
  fs.appendFileSync(f, line.slice(40) + '\n');
  store.processFile(f);
  assert.equal(store.view(store.sessions.get('half')).tokensOut, 100);
});

// ---------- "waiting for you" must last until the member answers ----------
function mkStore(nowMs) { return createStore({ now: () => nowMs }); }
const T0 = Date.parse('2026-09-22T12:00:00Z');
const at = (sec) => new Date(T0 - sec * 1000).toISOString();
function reply(sid, sec, stop, content, id) {
  return { type: 'assistant', sessionId: sid, cwd: 'C:\Demo\CRM', timestamp: at(sec),
    message: { id: id || 'm-' + sec, model: 'claude-opus-5', role: 'assistant', stop_reason: stop, content, usage: { output_tokens: 10 } } };
}
const said = (t) => [{ type: 'text', text: t }];

test('a question asked 4 minutes ago is still waiting for you', () => {
  const store = mkStore(T0);
  store.processEvent({ type: 'user', sessionId: 'w1', timestamp: at(300), message: { role: 'user', content: 'Which drafts?' } });
  store.processEvent(reply('w1', 240, 'end_turn', said('Here are 3 drafts. Which one should I send?')));
  assert.equal(store.view(store.sessions.get('w1')).status, 'waiting');
});

test('bookkeeping lines Claude Code writes after the reply do not end the wait', () => {
  const store = mkStore(T0);
  store.processEvent(reply('w2', 240, 'end_turn', said('Done. Want me to carry on?')));
  store.processEvent({ type: 'system', subtype: 'turn_duration', sessionId: 'w2', timestamp: at(239) });
  store.processEvent({ type: 'system', subtype: 'away_summary', sessionId: 'w2', timestamp: at(60) });
  store.processEvent({ type: 'cost-state', sessionId: 'w2', timestamp: at(59) });
  const v = store.view(store.sessions.get('w2'));
  assert.equal(v.status, 'waiting');
  assert.equal(v.waitingSince, at(240));
});

test('the member answering ends the wait', () => {
  const store = mkStore(T0);
  store.processEvent(reply('w3', 240, 'end_turn', said('Which one?')));
  store.processEvent({ type: 'user', sessionId: 'w3', timestamp: at(5), message: { role: 'user', content: 'The second' } });
  assert.equal(store.view(store.sessions.get('w3')).status, 'thinking');
});

test('a tool call with no result after 30 seconds is its own state, not "waiting for you"', () => {
  // Changed 2026-09-23: a 45-second npm install is not the member being asked
  // anything, so it no longer counts in "N need you". See tests/status.test.js.
  const store = mkStore(T0);
  store.processEvent(reply('w4', 45, 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]));
  const v = store.view(store.sessions.get('w4'));
  assert.equal(v.status, 'approval');
  assert.equal(v.waitReason, 'tool');
  const fresh = mkStore(T0);
  fresh.processEvent(reply('w5', 5, 'tool_use', [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }]));
  assert.equal(fresh.view(fresh.sessions.get('w5')).status, 'thinking');
});

test('a wait older than the cap turns idle', () => {
  const store = mkStore(T0);
  store.processEvent(reply('w6', 9 * 3600, 'end_turn', said('All done.')));
  assert.equal(store.view(store.sessions.get('w6')).status, 'idle');
});

test('the member pressing Esc (interrupted) is idle, not waiting', () => {
  const store = mkStore(T0);
  store.processEvent(reply('w7', 300, 'tool_use', [{ type: 'tool_use', id: 't3', name: 'Read', input: {} }]));
  store.processEvent({ type: 'user', sessionId: 'w7', timestamp: at(290), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  assert.equal(store.view(store.sessions.get('w7')).status, 'idle');
});

test('reading a big log hands control back between pieces, so the page keeps answering', async () => {
  const demo = makeDemoHome();
  const f = path.join(demo.projects, 'chunky', 'chunky.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(JSON.stringify({ type: 'assistant', sessionId: 'chunky', timestamp: new Date().toISOString(),
    message: { id: 'c' + i, model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(200) }], usage: { output_tokens: 1 } } }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const chunk = 256 * 1024;
  const store = createStore({ chunkBytes: chunk });
  // Other work, standing in for a page request: after every turn it gets, it asks for the next.
  // A reader that hands the thread back after each piece lets it run between every 2 pieces;
  // a reader that kept the thread would let it run once at most. Counted in turns, not in
  // milliseconds: a test machine busy with the other test files stretches every piece's time
  // (about 10 ms of work was measured taking up to 619 ms on a shared Intel Mac), but it cannot
  // change the order the turns come in.
  // How long 1 piece keeps the thread is measured in processor time, not clock time: the
  // processor time Node itself used between 2 turns of the other work. A busy machine that
  // pauses Node stretches clock time only (1.4 ms of processor time was measured inside
  // 23.5 ms of clock time on that Intel Mac), so this limit cannot be stretched by the
  // machine, while a piece that does too much work fails it. 250 ms is about 5 times the most
  // measured on this kit's Windows PC (47 ms, in the 15.6 ms steps Windows counts in), and
  // under half of a piece that freezes the page for 600 ms, which must fail.
  const PIECE_CPU_MS = 250;
  let turns = 0, reading = true, worstCpuMs = 0, lastCpu = process.cpuUsage();
  const cpuSinceLastTurn = () => {
    const used = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    return (used.user + used.system) / 1000;
  };
  const other = () => {
    if (!reading) return;
    worstCpuMs = Math.max(worstCpuMs, cpuSinceLastTurn());
    turns++;
    setImmediate(other);
  };
  setImmediate(other);
  await new Promise((resolve) => store.processFileAsync(f, resolve));
  worstCpuMs = Math.max(worstCpuMs, cpuSinceLastTurn());
  reading = false;
  const pieces = Math.ceil(fs.statSync(f).size / chunk);
  assert.equal(store.view(store.sessions.get('chunky')).tokensOut, 20000, 'the whole file was read');
  assert.ok(store.maxReadBytes <= chunk, 'no piece is bigger than ' + chunk + ' bytes (read ' + store.maxReadBytes + ' at once)');
  assert.ok(turns >= pieces - 1, 'other work ran ' + turns + ' times while at least ' + pieces +
    ' pieces were read; it must get a turn between every 2 pieces');
  assert.ok(worstCpuMs < PIECE_CPU_MS, '1 piece kept the thread for ' + worstCpuMs.toFixed(1) +
    ' ms of processor time; the limit is ' + PIECE_CPU_MS + ' ms per ' + chunk + '-byte piece');
  console.log('big log: ' + pieces + ' pieces, other work ran ' + turns + ' times, most processor time between 2 turns ' +
    worstCpuMs.toFixed(1) + ' ms');
});

test('a very large log file is read in pieces, not in 1 string', () => {
  const store = createStore({ chunkBytes: 1024 });
  const demo = makeDemoHome();
  const f = path.join(demo.projects, 'big', 'big.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ type: 'assistant', sessionId: 'big', timestamp: new Date().toISOString(),
    message: { id: 'b' + i, model: 'claude-opus-5', stop_reason: 'end_turn', content: [], usage: { output_tokens: 1 } } }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  store.processFile(f);
  assert.equal(store.view(store.sessions.get('big')).tokensOut, 200);
  assert.equal(store.maxReadBytes <= 1024, true, 'read ' + store.maxReadBytes + ' bytes at once');
});
