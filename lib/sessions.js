// Session state built from Claude Code's own log files
// (<projects>/<folder>/<session>.jsonl and <session>/subagents/agent-*.jsonl).
//
// The parsing and status rules come from Stargx/claude-code-dashboard
// (MIT, Copyright (c) 2025 Cold Beam Games). Changes made here:
//  - cost is worked out per reply with THAT reply's model (a Haiku subagent
//    inside an Opus session is priced as Haiku), split into 5-minute and 1-hour
//    cache writes; a model with no price row is counted as "unpriced", never guessed
//  - the context ring uses main-thread turns only (subagent turns used to
//    overwrite it) and a 200k or 1M window per pricing.contextWindowFor
//  - a half-written last line is kept for the next read instead of being lost
//  - status is worked out when asked, not frozen at read time
//  - "waiting for you" means Claude ASKED YOU SOMETHING and is still waiting
//    (upstream: 15 seconds after any reply; our own first try: every finished
//    reply, which turned 18 of 30 circles amber and said nothing). A reply that
//    answers and asks nothing is "finished". A tool call nobody has answered is
//    its own state, "may need approval", outside the needs-you count.
//    Only the member's messages and Claude's replies decide the status; the
//    bookkeeping lines Claude Code writes after a reply (system, cost-state,
//    attachment ...) no longer reset it
//  - a big log file is read in pieces, and processFileAsync hands the thread
//    back between pieces so the page keeps answering while a 3 GB folder loads
'use strict';
const fs = require('fs');
const path = require('path');
const { costOfUsage, getPricing, contextWindowFor } = require('./pricing');

const SKIP_TYPES = new Set(['file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt', 'mode', 'permission-mode', 'atis-latch']);

function lastPart(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

// Reasons a reply ends the turn (the member's move next).
const FINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
const TOOL_GRACE_MS = 30_000;          // a tool call with no result after this may need the member's approval
const USER_THINK_MS = 10 * 60_000;     // after the member's message (or a tool result) Claude is working, up to this
const DEFAULT_WAIT_CAP_H = 1;          // a wait older than this shows as idle and leaves the Needs you strip
const DEFAULT_FRESH_MIN = 30;          // under this many minutes a wait is "fresh" and gets the full amber

function isInterrupt(text) { return /^\[Request interrupted by user/.test(String(text || '')); }

// Did Claude's last message ask the member something?
// Only the end of the reply counts: a question mark quoted in the middle of a
// long answer ("you asked where the cost comes from?") is not a question to you.
function asksSomething(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t) return false;
  const lines = t.split('\n').map(l => l.replace(/[*_`"'’)\]]+$/, '').trim()).filter(Boolean);
  return lines.slice(-3).some(l => l.endsWith('?'));
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text' && c.text).map(c => c.text).join('\n');
}

function createStore(opts = {}) {
  const now = opts.now || (() => Date.now());
  const chunkBytes = opts.chunkBytes || 2 * 1024 * 1024;
  const waitCapMs = (opts.waitingHours || DEFAULT_WAIT_CAP_H) * 3600_000;
  const freshMs = (opts.freshMinutes || DEFAULT_FRESH_MIN) * 60_000;
  let maxReadBytes = 0;
  const sessions = new Map();
  const seen = new Map();       // sessionId -> Map(messageId -> usage so far)
  const offsets = new Map();    // file -> bytes consumed
  const busy = new Set();       // files being read right now
  const again = new Set();      // files that changed while being read

  function getSession(id) {
    let s = sessions.get(id);
    if (!s) {
      s = {
        sessionId: id, cwd: '', label: '', title: '', model: '', gitBranch: '',
        tokensIn: 0, tokensOut: 0, cacheCreationIn: 0, cacheReadIn: 0,
        costUSD: 0, unpricedTokens: 0, unpricedModels: [],
        turnCount: 0, activeFiles: [], recentLog: [],
        startedAt: null, lastEventAt: null, lastEventType: '', lastContentTypes: [],
        mainAt: null, mainType: '', mainStop: null, mainTypes: [], mainInterrupt: false, mainAsks: false,
        lastTurnInputTotal: 0, maxTurnInput: 0,
        permissionMode: '', version: '', subagents: {},
      };
      sessions.set(id, s);
      seen.set(id, new Map());
    }
    return s;
  }

  function log(s, entry) {
    s.recentLog.push(entry);
    if (s.recentLog.length > 30) s.recentLog = s.recentLog.slice(-30);
  }

  function getSub(s, agentId) {
    if (!s.subagents[agentId]) {
      s.subagents[agentId] = { agentId, agentType: '', task: '', model: '', tokensOut: 0, costUSD: 0, lastEventAt: null, startedAt: null };
    }
    return s.subagents[agentId];
  }

  function processEvent(event, meta = {}) {
    if (!event || !event.sessionId) return;
    // Claude Code writes a short title for each session (no timestamp on that line).
    if (event.type === 'ai-title' && event.aiTitle) { getSession(event.sessionId).title = String(event.aiTitle).slice(0, 80); return; }
    if (!event.timestamp) return;
    if (SKIP_TYPES.has(event.type)) return;
    const s = getSession(event.sessionId);
    const ts = event.timestamp;
    const isSub = !!(event.agentId && (event.isSidechain || meta.agentId));
    if (event.agentId && String(event.agentId).startsWith('acompact')) return; // context-compaction helper, not a real subagent

    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (!s.lastEventAt || ts >= s.lastEventAt) {
      s.lastEventAt = ts;
      if (!isSub) s.lastEventType = event.type;
    }
    if (event.cwd && !s.cwd) { s.cwd = event.cwd; s.label = lastPart(event.cwd); }
    if (event.gitBranch && !s.gitBranch) s.gitBranch = event.gitBranch;
    if (event.version) s.version = event.version;
    if (event.permissionMode) s.permissionMode = event.permissionMode;

    const msg = event.message || {};
    const content = msg.content;
    const types = Array.isArray(content) ? content.map(c => c && c.type) : (typeof content === 'string' ? ['text'] : []);
    if (!isSub) s.lastContentTypes = types;

    // Status comes from the main thread's conversation only: the member's
    // messages and Claude's replies. Later bookkeeping lines are ignored here.
    if (!isSub && (event.type === 'assistant' || (event.type === 'user' && !event.isMeta)) && (!s.mainAt || ts >= s.mainAt)) {
      s.mainAt = ts; s.mainType = event.type; s.mainTypes = types;
      s.mainStop = event.type === 'assistant' ? (msg.stop_reason || null) : null;
      const said = textOf(content);
      s.mainInterrupt = event.type === 'user' && isInterrupt(said);
      s.mainAsks = event.type === 'assistant' && asksSomething(said);
    }

    let sub = null;
    if (isSub) {
      sub = getSub(s, event.agentId);
      if (!sub.startedAt) sub.startedAt = ts;
      if (!sub.lastEventAt || ts > sub.lastEventAt) sub.lastEventAt = ts;
      if (meta.agentType && !sub.agentType) sub.agentType = meta.agentType;
      if (meta.description && !sub.task) sub.task = String(meta.description).slice(0, 120);
      if (!sub.task && event.type === 'user') {
        const t = typeof content === 'string' ? content : (Array.isArray(content) ? (content.find(c => c && c.type === 'text') || {}).text : '');
        if (t) sub.task = t.slice(0, 120);
      }
    }

    if (event.type === 'assistant' && msg.usage) {
      const model = msg.model && msg.model !== '<synthetic>' ? msg.model : '';
      if (model && !isSub) s.model = model;
      if (model && sub) sub.model = model;
      const u = msg.usage;
      const key = (msg.id || event.uuid || ts) + (isSub ? '@' + event.agentId : '');
      const seenMap = seen.get(event.sessionId);
      const prev = seenMap.get(key) || { in: 0, out: 0, cw: 0, cr: 0, cost: 0, turned: false };
      const cur = {
        in: u.input_tokens || 0, out: u.output_tokens || 0,
        cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
      };
      // The same reply can be logged on several lines with the usage so far; count only the growth.
      const dIn = Math.max(0, cur.in - prev.in), dOut = Math.max(0, cur.out - prev.out);
      const dCw = Math.max(0, cur.cw - prev.cw), dCr = Math.max(0, cur.cr - prev.cr);
      s.tokensIn += dIn; s.tokensOut += dOut; s.cacheCreationIn += dCw; s.cacheReadIn += dCr;
      const priceModel = model || (isSub ? sub.model : s.model);
      const total = costOfUsage(priceModel, u);
      let costDelta = 0;
      if (total === null) {
        s.unpricedTokens += dIn + dOut + dCw + dCr;
        const nm = priceModel || '(no model name)';
        if (!s.unpricedModels.includes(nm)) s.unpricedModels.push(nm);
      } else {
        costDelta = Math.max(0, total - prev.cost);
        s.costUSD += costDelta;
      }
      if (sub) { sub.tokensOut += dOut; sub.costUSD += costDelta; }
      const turned = prev.turned || !!msg.stop_reason;
      if (!isSub && msg.stop_reason && !prev.turned) s.turnCount++;
      seenMap.set(key, { ...cur, cost: total === null ? prev.cost : Math.max(prev.cost, total), turned });

      if (!isSub) {
        const turnInput = cur.in + cur.cw + cur.cr;
        s.lastTurnInputTotal = turnInput;
        if (turnInput > s.maxTurnInput) s.maxTurnInput = turnInput;
      }

      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_use') {
            const fp = b.input && (b.input.file_path || b.input.path);
            if (!isSub) log(s, { time: ts, type: 'tool', msg: b.name + (fp ? ': ' + lastPart(fp) : '') });
            if (fp && typeof fp === 'string') {
              const set = new Set([lastPart(fp), ...s.activeFiles]);
              s.activeFiles = [...set].slice(0, 10);
            }
          } else if (b.type === 'text' && b.text && !isSub) {
            log(s, { time: ts, type: 'think', msg: b.text.slice(0, 120) });
          }
        }
      }
    }

    if (event.type === 'user' && !isSub && msg.role === 'user') {
      const t = typeof content === 'string' ? content : (Array.isArray(content) ? (content.find(c => c && c.type === 'text') || {}).text : '');
      if (t) log(s, { time: ts, type: 'user', msg: String(t).slice(0, 120) });
    }
  }

  // Subagent files carry a small .meta.json next to them (agent type + description).
  function readMeta(filePath) {
    const m = /agent-([^\\/]+)\.jsonl$/.exec(filePath);
    if (!m) return {};
    try {
      const j = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      return { agentId: m[1], agentType: j.agentType || '', description: j.description || '' };
    } catch { return { agentId: m[1] }; }
  }

  // Reads whatever has been added to a log file since last time, in pieces of at
  // most chunkBytes, so a log of any size never has to fit in 1 string (Node
  // refuses strings above about 512 MB).
  function startRead(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    return { stat, meta: readMeta(filePath) };
  }
  // One piece. true when there may be more of this file to read.
  function readPiece(filePath, ctx) {
    const start = offsets.get(filePath) || 0;
    if (ctx.stat.size <= start) return false;
    const len = Math.min(ctx.stat.size - start, chunkBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    if (len > maxReadBytes) maxReadBytes = len;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      if (start + len >= ctx.stat.size) return false; // no complete line yet; try again next change
      // 1 line longer than a whole piece: skip past it rather than grow without limit
      const nl = findNextNewline(filePath, start + len, ctx.stat.size);
      offsets.set(filePath, nl < 0 ? ctx.stat.size : nl + 1);
      return true;
    }
    offsets.set(filePath, start + lastNl + 1);
    const text = buf.subarray(0, lastNl).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      processEvent(ev, ctx.meta);
    }
    return true;
  }

  // Synchronous: used by the tests and by anything that wants the answer now.
  function processFile(filePath) {
    if (!filePath.endsWith('.jsonl')) return;
    if (busy.has(filePath)) { again.add(filePath); return; }
    busy.add(filePath);
    try {
      const ctx = startRead(filePath);
      if (!ctx) return;
      while (readPiece(filePath, ctx)) { /* next piece */ }
    } finally {
      busy.delete(filePath);
      if (again.delete(filePath)) processFile(filePath);
    }
  }

  // The same read, one piece per turn of the event loop. The server uses this:
  // Node has 1 thread, so a synchronous read of a 114 MB log answered no page
  // request until it finished (7 seconds measured on 2026-09-22, which put a
  // red "FleetView stopped" banner on a page whose server was running fine).
  function processFileAsync(filePath, done) {
    const end = (err) => {
      busy.delete(filePath);
      if (again.delete(filePath)) return processFileAsync(filePath, done);
      if (done) done(err || null);
    };
    if (!filePath.endsWith('.jsonl')) return done && done(null);
    if (busy.has(filePath)) { again.add(filePath); return done && done(null); }
    busy.add(filePath);
    const ctx = startRead(filePath);
    if (!ctx) return end();
    const step = () => {
      let more = false;
      try { more = readPiece(filePath, ctx); }
      catch (e) { return end(e); }
      if (more) setImmediate(step); else end();
    };
    setImmediate(step);
  }

  function findNextNewline(filePath, from, size) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const b = Buffer.alloc(64 * 1024);
      for (let pos = from; pos < size; pos += b.length) {
        const n = fs.readSync(fd, b, 0, Math.min(b.length, size - pos), pos);
        const i = b.subarray(0, n).indexOf(0x0a);
        if (i >= 0) return pos + i;
      }
      return -1;
    } finally { fs.closeSync(fd); }
  }

  // The 5 states, and what puts a session in each:
  //  thinking  working now — the member's message or a tool result was the last
  //            word (up to 10 minutes), or a helper agent moved in the last 15 seconds
  //  waiting   Claude's last message ASKED THE MEMBER SOMETHING and nobody has
  //            answered (up to waiting_hours, 1 by default). waitBand says
  //            whether that question is fresh (under fresh_minutes, 30) or older
  //  approval  Claude asked to run a tool and nothing came back for 30 seconds:
  //            it may be waiting for a yes, or a long command is running. Its own
  //            state, kept out of the needs-you count, because most of these are
  //            just a slow npm install
  //  finished  Claude answered and asked nothing. Nothing for the member to do
  //  idle      the member pressed Esc, or everything above has gone stale
  function statusOf(s) {
    const t = now();
    for (const sub of Object.values(s.subagents)) {
      if (sub.lastEventAt && t - new Date(sub.lastEventAt).getTime() < 15_000) return { status: 'thinking' };
    }
    if (!s.mainAt) return { status: 'idle' };
    const age = t - new Date(s.mainAt).getTime();
    if (s.mainType === 'user') {
      if (s.mainInterrupt) return { status: 'idle' };
      return { status: age < USER_THINK_MS ? 'thinking' : 'idle' };
    }
    const tool = s.mainStop === 'tool_use' || s.mainTypes.includes('tool_use');
    if (tool) {
      if (age < TOOL_GRACE_MS) return { status: 'thinking' };
      return age < waitCapMs ? { status: 'approval', waitReason: 'tool', waitingSince: s.mainAt } : { status: 'idle' };
    }
    const finished = FINAL_STOPS.has(s.mainStop) || (s.mainStop === null && s.mainTypes.includes('text'));
    if (finished) {
      if (age >= waitCapMs) return { status: 'idle' };
      if (s.mainAsks) return { status: 'waiting', waitReason: 'question', waitingSince: s.mainAt, waitBand: age < freshMs ? 'fresh' : 'older' };
      return { status: 'finished', finishedSince: s.mainAt };
    }
    return { status: age < 60_000 ? 'thinking' : 'idle' }; // a thinking block, or a reply still being written
  }
  function deriveStatus(s) { return statusOf(s).status; }

  function contextOf(s) {
    const w = contextWindowFor(s.model, s.maxTurnInput);
    return { contextWindow: w.size, contextWindowSource: w.source, contextPct: Math.min(100, Math.round((s.lastTurnInputTotal / w.size) * 100)) };
  }

  function view(s) {
    const t = now();
    const subs = Object.values(s.subagents).map(x => ({
      agentId: x.agentId, agentType: x.agentType, task: x.task, model: x.model,
      tokensOut: x.tokensOut, costUSD: Math.round(x.costUSD * 100) / 100,
      lastEventAt: x.lastEventAt,
      status: x.lastEventAt && t - new Date(x.lastEventAt).getTime() < 15_000 ? 'thinking' : 'idle',
    }));
    return {
      sessionId: s.sessionId, cwd: s.cwd, label: s.label, title: s.title, gitBranch: s.gitBranch, model: s.model,
      priceKnown: !!getPricing(s.model), waitReason: null, waitingSince: null, waitBand: null, finishedSince: null, ...statusOf(s),
      costUSD: Math.round(s.costUSD * 100) / 100, unpricedTokens: s.unpricedTokens, unpricedModels: s.unpricedModels.slice(),
      tokensIn: s.tokensIn, tokensOut: s.tokensOut, cacheRead: s.cacheReadIn, cacheCreate: s.cacheCreationIn,
      turnCount: s.turnCount, lastTurnInputTotal: s.lastTurnInputTotal, ...contextOf(s),
      activeFiles: s.activeFiles.slice(0, 6), recentLog: s.recentLog.slice(-10),
      lastEventAt: s.lastEventAt, startedAt: s.startedAt, permissionMode: s.permissionMode,
      subagents: subs,
    };
  }

  return { processEvent, processFile, processFileAsync, deriveStatus, view, sessions, _offsets: offsets,
    get maxReadBytes() { return maxReadBytes; } };
}

module.exports = { createStore, lastPart, asksSomething, DEFAULT_WAIT_CAP_H, DEFAULT_FRESH_MIN, TOOL_GRACE_MS };
