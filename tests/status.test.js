'use strict';
// The "waiting for you" rule, rewritten on 2026-09-22 after the second review.
// Cycle 1 made amber die after 15 seconds. Cycle 2 made every finished reply amber,
// so 18 of 30 circles were amber and the colour said nothing. The rule now:
//   a session needs you ONLY when Claude's last message asks you something,
//   or a tool call is sitting there waiting for your approval.
// Every test here was written before the fix and seen failing.
const test = require('node:test');
const assert = require('node:assert');
const { createStore, DEFAULT_WAIT_CAP_H, DEFAULT_FRESH_MIN, asksSomething } = require('../lib/sessions');

const T0 = Date.parse('2026-09-22T12:00:00Z');
const at = (sec) => new Date(T0 - sec * 1000).toISOString();
const mk = (opts = {}) => createStore({ now: () => T0, ...opts });
const said = (t) => [{ type: 'text', text: t }];
function reply(sid, sec, stop, content, id) {
  return { type: 'assistant', sessionId: sid, cwd: 'C:\\Demo\\CRM', timestamp: at(sec),
    message: { id: id || 'm-' + sid + '-' + sec, model: 'claude-opus-5', role: 'assistant', stop_reason: stop, content, usage: { output_tokens: 10 } } };
}
const view = (store, id) => store.view(store.sessions.get(id));

test('a reply that answers and asks nothing is finished, not waiting', () => {
  const s = mk();
  s.processEvent({ type: 'user', sessionId: 'f1', timestamp: at(400), message: { role: 'user', content: 'Tidy the notes' } });
  s.processEvent(reply('f1', 300, 'end_turn', said('Done. I tidied 4 notes and filed them under Projects.')));
  const v = view(s, 'f1');
  assert.equal(v.status, 'finished');
  assert.equal(v.waitingSince, null, 'a finished session is not in the Needs you list');
});

test('a reply that asks you something is waiting for you', () => {
  const s = mk();
  s.processEvent(reply('q1', 300, 'end_turn', said('I found 3 drafts.\n\nWhich one should I send?')));
  const v = view(s, 'q1');
  assert.equal(v.status, 'waiting');
  assert.equal(v.waitReason, 'question');
  assert.equal(v.waitingSince, at(300));
});

test('a question mark buried in the middle of a long answer is not a question to you', () => {
  const s = mk();
  s.processEvent(reply('q2', 300, 'end_turn', said(
    'You asked "where does the cost come from?" earlier.\n' +
    'It comes from the reply tokens.\n' +
    'I have written that into the guide and saved it.')));
  assert.equal(view(s, 'q2').status, 'finished');
  assert.equal(asksSomething('All done.'), false);
  assert.equal(asksSomething('Shall I carry on?'), true);
  assert.equal(asksSomething('**Which folder should I use?**'), true);
});

test('waiting is banded by age: 5 minutes reads differently from 45 minutes', () => {
  const s = mk({ waitingHours: 8 });
  s.processEvent(reply('b1', 5 * 60, 'end_turn', said('Which one?')));
  s.processEvent(reply('b2', 45 * 60, 'end_turn', said('Which one?')));
  assert.equal(view(s, 'b1').waitBand, 'fresh');
  assert.equal(view(s, 'b2').waitBand, 'older');
  assert.equal(DEFAULT_FRESH_MIN, 30);
});

test('waiting_hours is 1 hour out of the box, so old questions leave the list', () => {
  assert.equal(DEFAULT_WAIT_CAP_H, 1);
  const s = mk();
  s.processEvent(reply('c1', 70 * 60, 'end_turn', said('Which one?')));
  assert.equal(view(s, 'c1').status, 'idle');
  const longer = mk({ waitingHours: 8 });
  longer.processEvent(reply('c2', 70 * 60, 'end_turn', said('Which one?')));
  assert.equal(view(longer, 'c2').status, 'waiting');
});

test('a tool call with no answer has its own state, not "waiting for you"', () => {
  const s = mk();
  s.processEvent(reply('t1', 300, 'tool_use', [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'npm install' } }]));
  const v = view(s, 't1');
  assert.equal(v.status, 'approval', 'a pending tool is its own state, outside the needs-you count');
  assert.equal(v.waitReason, 'tool');
  const fresh = mk();
  fresh.processEvent(reply('t2', 5, 'tool_use', [{ type: 'tool_use', id: 'x2', name: 'Bash', input: {} }]));
  assert.equal(view(fresh, 't2').status, 'thinking', 'under 30 seconds it is still working');
});

test('the member answering ends both the wait and the finished state', () => {
  const s = mk();
  s.processEvent(reply('a1', 300, 'end_turn', said('Which one?')));
  s.processEvent({ type: 'user', sessionId: 'a1', timestamp: at(5), message: { role: 'user', content: 'The second' } });
  assert.equal(view(s, 'a1').status, 'thinking');
});

test('bookkeeping lines after the reply still do not change the state', () => {
  const s = mk();
  s.processEvent(reply('k1', 240, 'end_turn', said('Shall I send it?')));
  s.processEvent({ type: 'system', subtype: 'turn_duration', sessionId: 'k1', timestamp: at(239) });
  s.processEvent({ type: 'attachment', sessionId: 'k1', timestamp: at(60) });
  const v = view(s, 'k1');
  assert.equal(v.status, 'waiting');
  assert.equal(v.waitingSince, at(240));
});
