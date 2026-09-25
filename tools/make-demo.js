#!/usr/bin/env node
// Writes MADE-UP Claude Code session logs into <root>/.claude/projects so you can
// see FleetView working without touching your real history. Used by the tests
// and for the guide's screenshots.
//
//   npm run demo                               the whole demo in 1 command: made-up sessions in a
//                                              temp folder, FleetView on port 3011, 2 sessions kept
//                                              "working". Open http://localhost:3011/graph.html.
//                                              Ctrl+C stops it. Works the same in PowerShell, cmd and bash.
//   node tools/make-demo.js <root>             only write the made-up sessions (used by the tests)
//   node tools/make-demo.js <root> --live      write them and keep 2 sessions "working"
//   node tools/make-demo.js <root> --sessions 30   a busy day: 30 made-up sessions in 5 folders,
//                                              mixed the way a real day is mixed (most answered and
//                                              asked nothing, a few really did ask you something)
//
// It also writes <root>/fleetview-demo-config.json (port 3011, so it never clashes
// with your own FleetView on 3010).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const serve = process.argv.includes('--serve');
const argRoot = process.argv.slice(2).find(a => !a.startsWith('--'));
const root = argRoot || (serve ? path.join(os.tmpdir(), 'fleetview-demo') : '');
if (!root) { console.error('usage: npm run demo   (or: node tools/make-demo.js <empty-folder> [--live])'); process.exit(2); }
const live = serve || process.argv.includes('--live');
const wantIdx = process.argv.indexOf('--sessions');
const WANT = wantIdx > 0 ? Math.max(1, parseInt(process.argv[wantIdx + 1], 10) || 0) : 0;
const DEMO_PORT = 3011;
const projects = path.join(root, '.claude', 'projects');

const FOLDERS = [
  { name: 'Second Brain', path: 'C:\\Demo\\Second Brain' },
  { name: 'CRM', path: 'C:\\Demo\\CRM' },
  { name: 'Content Engine', path: 'C:\\Demo\\Content Engine' },
];

// FleetView draws today's sessions. Run the demo at 00:20 and a "45 minutes
// ago" session would fall on yesterday and never be drawn, so times are never
// pushed back past the start of today. agoRaw is for the 1 session that really
// is meant to be yesterday.
const DAY_START = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const agoRaw = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const ago = (sec) => new Date(Math.max(Date.now() - sec * 1000, DAY_START + 60 * 1000)).toISOString();
const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
let seq = 0;
const id = (p) => `${p}_${(++seq).toString(36).padStart(6, '0')}`;
// npm run demo reuses its own temp folder: clear the old made-up sessions there
// first. Never deletes anything in a folder you name yourself.
if (!argRoot && serve && fs.existsSync(projects)) fs.rmSync(projects, { recursive: true, force: true });

function user(sessionId, cwd, ts, text, extra = {}) {
  return { type: 'user', sessionId, cwd, gitBranch: extra.branch || 'main', version: '2.3.0', timestamp: ts,
    uuid: id('u'), isSidechain: !!extra.agentId, agentId: extra.agentId, message: { role: 'user', content: text } };
}
function assistant(sessionId, cwd, ts, model, usage, content, extra = {}) {
  return { type: 'assistant', sessionId, cwd, gitBranch: extra.branch || 'main', version: '2.3.0', timestamp: ts,
    uuid: id('a'), isSidechain: !!extra.agentId, agentId: extra.agentId,
    message: { id: extra.msgId || id('msg'), model, role: 'assistant', type: 'message', stop_reason: extra.stop === false ? null : (extra.stopReason || 'end_turn'), content,
      usage: { input_tokens: 6, output_tokens: 900, cache_creation_input_tokens: 4000, cache_read_input_tokens: 60000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 }, service_tier: 'standard', ...usage } } };
}
const text = (t) => [{ type: 'text', text: t }];
const tool = (name, file) => [{ type: 'tool_use', id: id('toolu'), name, input: file ? { file_path: file } : { command: 'ls' } }];

function write(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

const S = {
  brainActive: '11111111-aaaa-4aaa-8aaa-000000000001',
  brainIdle: '11111111-aaaa-4aaa-8aaa-000000000002',
  crmWaiting: '11111111-aaaa-4aaa-8aaa-000000000003',
  crmLarge: '11111111-aaaa-4aaa-8aaa-000000000004',
  contentWorking: '11111111-aaaa-4aaa-8aaa-000000000005',
  otherUnknown: '11111111-aaaa-4aaa-8aaa-000000000006',
  yesterday: '11111111-aaaa-4aaa-8aaa-000000000007',
  toolPending: '11111111-aaaa-4aaa-8aaa-000000000008',
  brainAskedEarlier: '11111111-aaaa-4aaa-8aaa-000000000009',
};
const SUB_ID = 'a1b2c3d4e5f60718';

function build() {
  const brain = FOLDERS[0].path, crm = FOLDERS[1].path, content = FOLDERS[2].path;
  const other = 'C:\\Demo\\Scratch\\invoice-tool';
  const files = {};

  // 1. Second Brain, working now, with one subagent (Haiku) running.
  files[path.join(projects, encode(brain), S.brainActive + '.jsonl')] = [
    user(S.brainActive, brain, ago(600), 'Tidy this week\'s meeting notes into the Projects folder'),
    assistant(S.brainActive, brain, ago(590), 'claude-opus-5', {}, text('I will read the notes first.')),
    assistant(S.brainActive, brain, ago(400), 'claude-opus-5', { output_tokens: 2400, cache_read_input_tokens: 95000 }, tool('Read', 'C:\\Demo\\Second Brain\\Inbox\\2026-09-21 call with Priya Shah Design.md')),
    assistant(S.brainActive, brain, ago(3), 'claude-opus-5', { output_tokens: 1800, cache_read_input_tokens: 118000 }, tool('Agent'), { stop: true }),
  ];
  files[path.join(projects, encode(brain), S.brainActive, 'subagents', `agent-${SUB_ID}.jsonl`)] = [
    user(S.brainActive, brain, ago(120), 'Find every note that mentions the bookkeeping review', { agentId: SUB_ID }),
    assistant(S.brainActive, brain, ago(4), 'claude-haiku-4-5-20251001', { output_tokens: 3200, cache_read_input_tokens: 40000 }, tool('Grep'), { agentId: SUB_ID }),
  ];
  fs.mkdirSync(path.join(projects, encode(brain), S.brainActive, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projects, encode(brain), S.brainActive, 'subagents', `agent-${SUB_ID}.meta.json`),
    JSON.stringify({ agentType: 'note-finder', description: 'Find bookkeeping review notes' }));

  // 2. Second Brain, idle: the member pressed Esc 40 minutes ago (Sonnet 5).
  files[path.join(projects, encode(brain), S.brainIdle + '.jsonl')] = [
    user(S.brainIdle, brain, ago(2400), 'Write today\'s daily note'),
    assistant(S.brainIdle, brain, ago(2380), 'claude-sonnet-5', { output_tokens: 5200 }, tool('Write', 'C:\\Demo\\Second Brain\\Daily\\today.md'), { stopReason: 'tool_use' }),
    user(S.brainIdle, brain, ago(2370), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  ];

  // 3. CRM, finished a reply 4 minutes ago and waiting for you ever since.
  //    The bookkeeping lines Claude Code writes after a reply follow it, as in a real log.
  files[path.join(projects, encode(crm), S.crmWaiting + '.jsonl')] = [
    user(S.crmWaiting, crm, ago(300), 'Who should I follow up with today?', { branch: 'follow-ups' }),
    assistant(S.crmWaiting, crm, ago(280), 'claude-opus-5', { output_tokens: 3100, cache_read_input_tokens: 70000 }, tool('Read', 'C:\\Demo\\CRM\\Today.md'), { branch: 'follow-ups', stopReason: 'tool_use' }),
    assistant(S.crmWaiting, crm, ago(240), 'claude-opus-5', { output_tokens: 1400, cache_read_input_tokens: 76000 }, text('Three people to follow up: Sam the bookkeeper, Priya Shah Design, and Leo at Northside Joinery. Want me to draft the 3 messages?'), { branch: 'follow-ups' }),
    { type: 'system', subtype: 'turn_duration', sessionId: S.crmWaiting, timestamp: ago(239), durationMs: 61000 },
  ];

  // 4. CRM, a long 1M-context session (model id ends in [1m]; last turn 420,000 tokens).
  files[path.join(projects, encode(crm), S.crmLarge + '.jsonl')] = [
    user(S.crmLarge, crm, ago(5400), 'Read every contact note and rebuild the pipeline summary'),
    assistant(S.crmLarge, crm, ago(5000), 'claude-opus-5[1m]', { output_tokens: 12000, cache_read_input_tokens: 250000, cache_creation_input_tokens: 80000, cache_creation: { ephemeral_5m_input_tokens: 80000, ephemeral_1h_input_tokens: 0 } }, text('Reading contact notes.')),
    assistant(S.crmLarge, crm, ago(1800), 'claude-opus-5[1m]', { output_tokens: 9000, cache_read_input_tokens: 400000, cache_creation_input_tokens: 20000 }, text('Pipeline summary rebuilt.')),
  ];

  // 5. Content Engine, working now on Fable 5.1.
  files[path.join(projects, encode(content), S.contentWorking + '.jsonl')] = [
    user(S.contentWorking, content, ago(300), 'Draft three post ideas from last week\'s client wins', { branch: 'drafts' }),
    assistant(S.contentWorking, content, ago(2), 'claude-fable-5-1', { output_tokens: 4200, cache_read_input_tokens: 52000 }, tool('Write', 'C:\\Demo\\Content Engine\\drafts\\idea-1.md'), { branch: 'drafts', stop: true }),
  ];

  // 5b. Content Engine: asked to run a command 4 minutes ago and nothing has come
  //     back. Not "waiting for you": it may be waiting for a yes, or npm is slow.
  files[path.join(projects, encode(content), S.toolPending + '.jsonl')] = [
    user(S.toolPending, content, ago(600), 'Run the tests on the posts folder', { branch: 'drafts' }),
    assistant(S.toolPending, content, ago(240), 'claude-opus-5-5', { output_tokens: 800, cache_read_input_tokens: 44000 },
      tool('Bash'), { branch: 'drafts', stopReason: 'tool_use' }),
  ];

  // 5c. Second Brain: asked a question 45 minutes ago. Still waiting, but the
  //     quieter amber, because it is not the live conversation.
  files[path.join(projects, encode(brain), S.brainAskedEarlier + '.jsonl')] = [
    user(S.brainAskedEarlier, brain, ago(3000), 'Sort the reading list'),
    assistant(S.brainAskedEarlier, brain, ago(2700), 'claude-sonnet-5', { output_tokens: 2200, cache_read_input_tokens: 31000 },
      text('There are 2 lists with the same name. Which one do you want me to keep?')),
  ];

  // 6. A folder not in the config -> "Other", on a model with no price row.
  files[path.join(projects, encode(other), S.otherUnknown + '.jsonl')] = [
    user(S.otherUnknown, other, ago(2400), 'Fix the rounding on the invoice totals'),
    assistant(S.otherUnknown, other, ago(2300), 'claude-nova-7', { output_tokens: 700 }, text('Fixed.')),
  ];

  // 7. Yesterday: hidden on the graph unless ?all=1.
  files[path.join(projects, encode(brain), S.yesterday + '.jsonl')] = [
    user(S.yesterday, brain, agoRaw(30 * 3600), 'Weekly review'),
    assistant(S.yesterday, brain, agoRaw(30 * 3600 - 20), 'claude-opus-4-8', {}, text('Review done.')),
  ];

  const titles = {
    brainActive: 'Tidy meeting notes', brainIdle: 'Daily note', crmWaiting: 'Who to follow up today',
    crmLarge: 'Rebuild pipeline summary', contentWorking: 'Post ideas from client wins',
    otherUnknown: 'Invoice rounding fix', yesterday: 'Weekly review',
    toolPending: 'Run the post tests', brainAskedEarlier: 'Sort the reading list',
  };
  // A busy day, on demand: node tools/make-demo.js <root> --sessions 30.
  // The mix is the point. Most sessions have answered and asked nothing; only a
  // few really did ask you something, which is what amber is for.
  if (WANT) {
    const order = [S.crmWaiting, S.brainActive, S.crmLarge, S.contentWorking, S.toolPending,
      S.brainAskedEarlier, S.otherUnknown, S.brainIdle];
    const keep = new Set(order.slice(0, WANT));
    for (const f of Object.keys(files)) {
      const sid = files[f][0].sessionId;
      if (sid === S.yesterday) continue;                       // not today, never counted
      if (!keep.has(sid)) delete files[f];
    }
    const extras = Math.max(0, WANT - order.length);
    const MIX = ['finished', 'finished', 'working', 'finished', 'idle', 'approval', 'waiting',
      'finished', 'finished', 'idle', 'working', 'finished', 'finished', 'idle', 'waiting'];
    const WORK = ['Rewrite the About page', 'Weekly review of open deals', 'Chase the 3 unpaid invoices',
      'Clean up the tag list', 'Draft Tuesday post', 'Summarise the Priya call', 'Find duplicate contacts',
      'Rename the old exports', 'Check the booking form', 'Write the welcome email', 'Sort last month receipts',
      'Update the price table', 'Trim the reading list', 'Plan next week', 'Fix the broken links',
      'Read the quarterly figures', 'Draft the case study', 'Tidy the downloads folder', 'Answer the 4 new leads',
      'Rework the offer page', 'Check last night backup', 'List the stale drafts'];
    const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
    for (let i = 0; i < extras; i++) {
      const folder = FOLDERS[i % FOLDERS.length].path;
      const sid = '22222222-bbbb-4bbb-8bbb-' + String(i + 1).padStart(12, '0');
      const model = MODELS[i % MODELS.length];
      const kind = MIX[i % MIX.length];
      const title = WORK[i % WORK.length] + (i >= WORK.length ? ' (' + (1 + Math.floor(i / WORK.length)) + ')' : '');
      const askedAt = 120 + (i % 7) * 260;              // 2 to 28 minutes ago
      const events = [user(sid, folder, ago(askedAt + 600), 'Start on: ' + title.toLowerCase())];
      if (kind === 'working') {
        events.push(assistant(sid, folder, ago(4 + (i % 5)), model, { output_tokens: 900 + i * 7, cache_read_input_tokens: 40000 + i * 900 },
          tool('Read', 'C:\\Demo\\notes-' + i + '.md'), { stop: false }));
      } else if (kind === 'approval') {
        events.push(assistant(sid, folder, ago(150 + i * 5), model, { output_tokens: 700, cache_read_input_tokens: 22000 },
          tool('Bash'), { stopReason: 'tool_use' }));
      } else if (kind === 'waiting') {
        events.push(assistant(sid, folder, ago(askedAt), model, { output_tokens: 1500 + i * 11, cache_read_input_tokens: 51000 + i * 700 },
          text('I can do that 2 ways: keep the old wording, or rewrite it from the notes.\n\nWhich would you rather?')));
      } else if (kind === 'idle') {
        events.push(assistant(sid, folder, ago(2000 + i * 120), model, { output_tokens: 1100, cache_read_input_tokens: 33000 },
          tool('Write', 'C:\\Demo\\out-' + i + '.md'), { stopReason: 'tool_use' }));
        events.push(user(sid, folder, ago(1990 + i * 120), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
      } else {
        events.push(assistant(sid, folder, ago(askedAt), model, { output_tokens: 1200 + i * 9, cache_read_input_tokens: 47000 + i * 800 },
          text('Done. ' + title + ': finished and saved.')));
      }
      events.push({ type: 'ai-title', aiTitle: title, sessionId: sid });
      files[path.join(projects, encode(folder), sid + '.jsonl')] = events;
    }
  }
  for (const [f, ev] of Object.entries(files)) {
    const sid = ev[0].sessionId;
    const key = Object.keys(S).find(k => S[k] === sid);
    if (!f.includes('subagents') && titles[key]) ev.push({ type: 'ai-title', aiTitle: titles[key], sessionId: sid });
    write(f, ev);
  }
  // Made-up token-panel answer, in the shape ccusage gives, for screenshots only.
  const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() - 2);
  const usageDemo = {
    block: { id: start.toISOString(), isActive: true, startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 5 * 3600e3).toISOString(), totalTokens: 41_250_000, costUSD: 38.4,
      tokenCounts: { inputTokens: 5200, outputTokens: 310_000, cacheCreationInputTokens: 1_900_000, cacheReadInputTokens: 39_034_800 },
      burnRate: { tokensPerMinute: 290_000 }, projection: { totalTokens: 78_900_000, remainingMinutes: 168 } },
    week: { tokens: 612_000_000, cost: 540.2, days: 7 },
    error: null, fetchedAt: Date.now(),
  };
  const usageFile = path.join(root, 'fleetview-demo-usage.json');
  fs.writeFileSync(usageFile, JSON.stringify(usageDemo, null, 2));
  const cfg = { port: DEMO_PORT, folders: FOLDERS, projects_dir: projects, usage: { enabled: false } };
  const cfgFile = path.join(root, 'fleetview-demo-config.json');
  fs.writeFileSync(cfgFile + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(cfgFile + '.tmp', cfgFile);
  return { projects, config: cfgFile, usageDemo: usageFile, sessions: S, subagentId: SUB_ID };
}

const result = build();
if (require.main === module) {
  if (!serve) console.log(JSON.stringify(result));
  if (serve) {
    // Start FleetView in this same process on the demo settings.
    process.env.FLEETVIEW_CONFIG = result.config;
    process.env.FLEETVIEW_USAGE_FIXTURE = result.usageDemo;
    delete process.env.PORT;
    console.log('Made-up sessions written to ' + result.projects);
    console.log('Starting the FleetView demo. Open http://localhost:' + DEMO_PORT + '/graph.html   (Ctrl+C to stop)');
    require('../watcher.js');
  }
  if (live) {
    // Keep the two "working" sessions and the subagent fresh so they stay green.
    // Steps are written with no stop reason (a reply still in progress), so turn
    // counts do not climb. The waiting session is NOT touched: it stays amber by itself.
    const brain = FOLDERS[0].path, crm = FOLDERS[1].path, content = FOLDERS[2].path;
    const steps = [['Read', 'Inbox\\2026-09-19 notes.md'], ['Edit', 'Projects\\Bookkeeping review.md'], ['Grep', ''], ['Write', 'Projects\\Website refresh.md']];
    let step = 0;
    setInterval(() => {
      const [toolName, rel] = steps[step++ % steps.length];
      const add = (file, ev) => fs.appendFileSync(file, JSON.stringify(ev) + '\n');
      add(path.join(projects, encode(brain), S.brainActive + '.jsonl'),
        assistant(S.brainActive, brain, ago(0), 'claude-opus-5', { output_tokens: 600, cache_read_input_tokens: 121000 }, tool(toolName, rel ? 'C:\\Demo\\Second Brain\\' + rel : ''), { stop: false }));
      add(path.join(projects, encode(brain), S.brainActive, 'subagents', `agent-${SUB_ID}.jsonl`),
        assistant(S.brainActive, brain, ago(0), 'claude-haiku-4-5-20251001', { output_tokens: 300, cache_read_input_tokens: 41000 }, tool('Grep'), { agentId: SUB_ID, stop: false }));
      add(path.join(projects, encode(content), S.contentWorking + '.jsonl'),
        assistant(S.contentWorking, content, ago(0), 'claude-fable-5-1', { output_tokens: 500, cache_read_input_tokens: 53000 }, tool('Write', 'C:\\Demo\\Content Engine\\drafts\\idea-2.md'), { branch: 'drafts', stop: false }));
    }, 6000);
  }
}
