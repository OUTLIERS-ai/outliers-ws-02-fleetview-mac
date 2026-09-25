// FleetView server.
// Reads the log files Claude Code already writes and serves two pages:
//   /graph.html  FleetView: folder hubs -> sessions -> helper-agent satellites, plus the token panel
//                (the address / goes here too)
//   /cards.html  the same sessions as cards (from Stargx/claude-code-dashboard, MIT, (c) 2025 Cold Beam Games)
// It changes nothing in Claude Code: no hooks, no settings, no database.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const express = require('express');
const chokidar = require('chokidar');
const { createStore, DEFAULT_WAIT_CAP_H, DEFAULT_FRESH_MIN } = require('./lib/sessions');
const { makeGrouper, lastPart } = require('./lib/groups');
const { PRICES_CHECKED, PRICES_SOURCE } = require('./lib/pricing');
const { PY, readConfigFile, lastGoodPort, refusalLines, damagedLines } = require('./lib/config');
const usageLib = require('./lib/usage');

// ---------- config ----------
// A config.json that cannot be read is never swallowed: the fault travels in
// CFG.configError, /api/meta carries it, and both pages put a red line at the
// top saying which line is wrong and that the folder names are gone. Before
// 2026-09-22 this was 1 line in a log file nobody opens.
//
// The port is not allowed to go back to the default on a damaged file. That put
// a member who had chosen another port on a dead browser tab, and put a second
// copy of FleetView on the port another piece in this set expects. FleetView
// keeps the port it last ran on, and when it has no record of one it does not
// start at all and says so in the words install.py --start uses.
const DEFAULT_PORT = 3010;
function loadConfig() {
  const file = process.env.FLEETVIEW_CONFIG || path.join(__dirname, 'config.json');
  const read = readConfigFile(file);
  const cfg = read.config || {};
  let port = parseInt(process.env.PORT || cfg.port || DEFAULT_PORT, 10);
  if (read.error) {
    const known = process.env.PORT ? parseInt(process.env.PORT, 10) : lastGoodPort(file);
    if (!known) {
      for (const line of refusalLines(read.error, file)) console.error(line);
      process.exit(1);
    }
    port = known;
    for (const line of damagedLines(read.error, file, port)) console.error(line);
  }
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    file,
    configError: read.error ? { ...read.error, file, usingDefaults: true, port } : null,
    port,
    host: cfg.host || '127.0.0.1',
    projectsDir: cfg.projects_dir || path.join(claudeDir, 'projects'),
    folders: Array.isArray(cfg.folders) ? cfg.folders : [],
    idlePerFolder: Number.isInteger(cfg.idle_per_folder) ? cfg.idle_per_folder : 3,
    waitingHours: typeof cfg.waiting_hours === 'number' && cfg.waiting_hours > 0 ? cfg.waiting_hours : DEFAULT_WAIT_CAP_H,
    freshMinutes: typeof cfg.fresh_minutes === 'number' && cfg.fresh_minutes > 0 ? cfg.fresh_minutes : DEFAULT_FRESH_MIN,
    hidePaths: !!cfg.hide_paths,
    usageEnabled: process.env.FLEETVIEW_NO_CCUSAGE === '1' ? false : (cfg.usage ? cfg.usage.enabled !== false : true),
    ccusagePackage: usageLib.packageFrom(cfg.usage && cfg.usage.package),
  };
}
const CFG = loadConfig();
const PID_FILE = path.join(path.dirname(path.resolve(CFG.file)), 'fleetview.pid');
// Which folder this FleetView keeps its fleetview.pid in, as a short fingerprint rather than the path
// itself. install.py compares it with its own folder, so --stop in a COPY of the folder (which carries
// a copy of fleetview.pid) never stops the FleetView in the original folder. Added 2026-09-24.
const FOLDER_ID = crypto.createHash('sha256')
  .update(process.platform === 'win32' ? path.dirname(PID_FILE).toLowerCase() : path.dirname(PID_FILE))
  .digest('hex').slice(0, 16);
const groupOf = makeGrouper(CFG.folders);
const store = createStore({ waitingHours: CFG.waitingHours, freshMinutes: CFG.freshMinutes });

function publicView(s) {
  const v = store.view(s);
  v.group = groupOf(v.cwd);
  if (CFG.hidePaths) {
    // Screen-sharing mode: no folder paths, no file names, none of the words typed.
    v.cwd = v.group + ' / ' + lastPart(v.cwd);
    v.activeFiles = [];
    v.recentLog = v.recentLog.map(l => ({ time: l.time, type: l.type, msg: '(hidden)' }));
    v.subagents = v.subagents.map(x => ({ ...x, task: '' }));
    v.gitBranch = '';
  }
  return v;
}

// Every session with activity today. The totals always cover all of them, so the
// graph page and the card page show the same numbers, whatever is drawn.
function graphData(showAll) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const now = Date.now();
  const today = [];
  for (const s of store.sessions.values()) {
    if (!s.lastEventAt || new Date(s.lastEventAt) < todayStart) continue;
    const v = publicView(s);
    v.subagents = v.subagents.filter(x => x.lastEventAt && now - new Date(x.lastEventAt).getTime() < 30 * 60 * 1000);
    today.push(v);
  }
  const totals = {
    sessions: today.length, working: 0, waiting: 0, approval: 0, finished: 0, idle: 0, helpers: 0,
    tokens: 0, outputTokens: 0, cacheRead: 0, costUSD: 0, unpricedTokens: 0, unpricedModels: [],
  };
  for (const v of today) {
    if (v.status === 'thinking') totals.working++;
    else if (v.status === 'waiting') totals.waiting++;
    else if (v.status === 'approval') totals.approval++;
    else if (v.status === 'finished') totals.finished++;
    else totals.idle++;
    totals.helpers += v.subagents.filter(x => x.status === 'thinking').length;
    totals.tokens += (v.tokensIn || 0) + (v.tokensOut || 0) + (v.cacheCreate || 0) + (v.cacheRead || 0);
    totals.outputTokens += v.tokensOut || 0;
    totals.cacheRead += v.cacheRead || 0;
    totals.costUSD += v.costUSD || 0;
    totals.unpricedTokens += v.unpricedTokens || 0;
    for (const m of v.unpricedModels || []) if (!totals.unpricedModels.includes(m)) totals.unpricedModels.push(m);
  }
  totals.costUSD = Math.round(totals.costUSD * 100) / 100;

  // Draw every working or waiting session; idle ones trimmed to the N most recent per folder.
  const kept = today.filter(v => v.status !== 'idle');
  const idleBy = new Map();
  for (const v of today) {
    if (v.status !== 'idle') continue;
    if (!idleBy.has(v.group)) idleBy.set(v.group, []);
    idleBy.get(v.group).push(v);
  }
  const hiddenByGroup = {};
  let hidden = 0;
  for (const [g, list] of idleBy) {
    list.sort((a, b) => (b.lastEventAt || '').localeCompare(a.lastEventAt || ''));
    const show = showAll ? list : list.slice(0, CFG.idlePerFolder);
    kept.push(...show);
    if (list.length > show.length) { hiddenByGroup[g] = list.length - show.length; hidden += list.length - show.length; }
  }
  // Asked you something first, newest question first — the freshest question is
  // the one still live in a terminal; a 5-hour-old one is dead or already dealt
  // with. Then the tool calls that may need a yes, then working, then the rest.
  const rank = { waiting: 0, approval: 1, thinking: 2, finished: 3, idle: 4 };
  kept.sort((a, b) => (rank[a.status] - rank[b.status]) ||
    (a.waitingSince ? (b.waitingSince || '').localeCompare(a.waitingSince || '') : (b.lastEventAt || '').localeCompare(a.lastEventAt || '')));
  return { sessions: kept, totals, hidden, hiddenByGroup, showAll: !!showAll, generatedAt: new Date(now).toISOString() };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');

// Only answer requests addressed to this computer by name. A web page that
// re-points its own address to 127.0.0.1 (DNS rebinding) still sends its own
// site name in the Host header, so it is refused here.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
if (CFG.host && !['127.0.0.1', '0.0.0.0', '::'].includes(CFG.host)) ALLOWED_HOSTS.add(CFG.host.toLowerCase());
app.use((req, res, next) => {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(h)) return res.status(403).type('text').send('FleetView only answers on this computer (localhost).');
  next();
});

app.get('/', (req, res) => res.redirect(302, '/graph.html'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/api/meta', (req, res) => {
  res.json({
    pricesChecked: PRICES_CHECKED, pricesSource: PRICES_SOURCE,
    costNote: 'What these tokens would cost if you paid per token. Not money taken from your subscription.',
    folders: CFG.folders.map(f => f.name), hidePaths: CFG.hidePaths, usageEnabled: CFG.usageEnabled,
    idlePerFolder: CFG.idlePerFolder, waitingHours: CFG.waitingHours, freshMinutes: CFG.freshMinutes,
    configError: CFG.configError,
    logsFolderFound: fs.existsSync(CFG.projectsDir),
    logsFolder: CFG.hidePaths ? '(hidden)' : CFG.projectsDir,
    pid: process.pid, port: CFG.port, folderId: FOLDER_ID,
    // The command a member types to run Python, for the stopped banner: python3 on a Mac.
    python: PY,
  });
});

// FleetView feed: { sessions, totals, hiddenByGroup }. ?all=1 draws every session today.
app.get('/api/graph', (req, res) => res.json(graphData(req.query.all === '1')));

// Upstream route shape (a plain list), kept for anything built on it: every session today.
app.get('/api/sessions', (req, res) => res.json(graphData(true).sessions));

// Upstream route (with its 2026-03-09 command-injection fix): click a card title to open its folder.
app.post('/api/open-folder', express.json(), (req, res) => {
  const folder = req.body && req.body.path;
  if (CFG.hidePaths) return res.status(403).json({ error: 'Paths are hidden in config' });
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'No path' });
  const known = [...store.sessions.values()].some(s => s.cwd === folder);
  if (!known) return res.status(404).json({ error: 'Not a session folder' });
  if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Folder not found' });
  const opts = { windowsHide: true };
  if (process.platform === 'win32') execFile('explorer', [folder.replace(/\//g, '\\')], opts, () => {});
  else if (process.platform === 'darwin') execFile('open', [folder], opts, () => {});
  else execFile('xdg-open', [folder], opts, () => {});
  res.json({ ok: true });
});

// ---------- token panel (ccusage, Claude Code only) ----------
// Runs only while a FleetView page is open (the page asks every 15 seconds; the
// 5-hour window is re-read at most once a minute, the 7-day total every 5 minutes).
const usage = { block: null, week: null, error: null, weekError: null, blockAt: 0, weekAt: 0, busyBlock: false, busyWeek: false };
function runCcusage(args, cb) {
  // No Claude Code session has run on this computer yet, so there is no log folder. ccusage
  // then stops with an error, and the panel said "ccusage could not run" on every new computer
  // (found on GitHub's test Macs 2026-09-24). Nothing has been used yet: say that instead.
  if (!fs.existsSync(CFG.projectsDir)) {
    return cb(null, JSON.stringify(args.startsWith('blocks') ? { blocks: [] } : { daily: [] }));
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.dirname(CFG.projectsDir) };
  let cmd;
  try { cmd = usageLib.command(CFG.ccusagePackage, args); } catch (e) { return cb(e); }
  exec(cmd, { timeout: 180000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env }, cb);
}
function firstLine(err) { return String(err.message || err).split('\n')[0].slice(0, 160); }
function refreshBlock() {
  if (usage.busyBlock) return; usage.busyBlock = true;
  runCcusage('blocks --active', (err, stdout) => {
    usage.busyBlock = false; usage.blockAt = Date.now();
    if (err) { usage.error = 'ccusage could not run: ' + firstLine(err); return; }
    try {
      const j = JSON.parse(stdout);
      usage.block = (j.blocks || []).find(b => b.isActive) || null;
      usage.error = null;
    } catch (e) { usage.error = 'ccusage answer not understood: ' + String(e.message).slice(0, 120); }
  });
}
function refreshWeek() {
  if (usage.busyWeek) return; usage.busyWeek = true;
  runCcusage('daily', (err, stdout) => {
    usage.busyWeek = false; usage.weekAt = Date.now();
    if (err) { usage.weekError = 'ccusage could not run: ' + firstLine(err); return; }
    try { usage.week = usageLib.weekFromDaily(JSON.parse(stdout)); usage.weekError = null; }
    catch (e) { usage.weekError = 'ccusage answer not understood: ' + String(e.message).slice(0, 120); }
  });
}
app.get('/api/usage', (req, res) => {
  // Demo only: serve a made-up usage answer from a file (npm run demo and the guide's screenshots).
  if (process.env.FLEETVIEW_USAGE_FIXTURE) {
    try { return res.json({ enabled: true, demo: true, ...JSON.parse(fs.readFileSync(process.env.FLEETVIEW_USAGE_FIXTURE, 'utf8')) }); }
    catch (e) { return res.json({ enabled: true, demo: true, block: null, week: null, error: 'demo file unreadable' }); }
  }
  if (!CFG.usageEnabled) {
    return res.json({ enabled: false, block: null, week: null, error: 'The token panel is switched off in config.json ("usage": {"enabled": false}).', fetchedAt: 0 });
  }
  const t = Date.now();
  if (t - usage.blockAt > 60_000) refreshBlock();
  if (t - usage.weekAt > 300_000) refreshWeek();
  res.json({
    enabled: true, block: usage.block, week: usage.week, error: usage.error, weekError: usage.weekError,
    pending: usage.busyBlock && !usage.blockAt, fetchedAt: usage.blockAt, package: CFG.ccusagePackage,
  });
});

// ---------- reading the logs ----------
console.log(`FleetView reading: ${CFG.projectsDir}`);
const want = (f) => f.endsWith('.jsonl') && !path.basename(f).includes('compact');
// One piece per turn of the event loop, so a huge log never keeps the thread
// to itself and the page carries on answering while it is read.
//
// Files wait in 1 line and are read 1 at a time. When 300 logs arrived together,
// each queued its first piece for the same turn of the event loop, so a page request
// waited for all 300: up to 4.5 seconds on GitHub's Intel test Mac (5 of 10 runs of
// `npm test` failed there, 2026-09-24), close to the 5 seconds after which the page
// shows "FleetView stopped".
const readLine = [];
const inLine = new Set();
let reading = false;
function readNext() {
  if (reading) return;
  const f = readLine.shift();
  if (f === undefined) return;
  inLine.delete(f);
  reading = true;
  const next = () => { reading = false; setImmediate(readNext); };
  try {
    store.processFileAsync(f, (err) => {
      if (err) console.error(`Skipped ${path.basename(f)}: ${err.message}`);
      next();
    });
  } catch (e) { console.error(`Skipped ${path.basename(f)}: ${e.message}`); next(); }
}
const told = new Set(); // every log FleetView has been told about, by chokidar or by the sweep
function readSafely(f) {
  told.add(f);
  if (!inLine.has(f)) { inLine.add(f); readLine.push(f); }
  readNext();
}
// A sweep, beside chokidar. On GitHub's Windows machine chokidar sometimes reported nothing at
// all after it was ready: a new project folder and the 53 MB log in it were never reported, so
// never read (2 of 20 runs of npm test, 2026-09-24; its record showed "ready" and then no event
// for 25 seconds). Claude Code makes a new folder for every new project, so a member could meet
// the same. Every SWEEP_MS FleetView lists the log folder itself, 4 levels deep as chokidar
// watches it, and reads any log it was never told about. Only folder listings, no file contents,
// and the listing runs off the main thread (fs.promises), so the page keeps answering.
const SWEEP_MS = 5000;
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const walk = async (dir, depth) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 4) await walk(full, depth + 1); }
        else if (want(full) && !told.has(full)) readSafely(full);
      }
    };
    await walk(CFG.projectsDir, 0);
  } finally { sweeping = false; }
}
let watcher = null;
function attachWatcher() {
  watcher = chokidar.watch(CFG.projectsDir, {
    persistent: true, ignoreInitial: false, depth: 4,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher.on('add', f => { if (want(f)) readSafely(f); });
  watcher.on('change', f => { if (want(f)) readSafely(f); });
  watcher.on('error', e => console.error('watch error:', e.message));
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS);
}
let sweepTimer = null;
let folderCheck = null;
if (fs.existsSync(CFG.projectsDir)) attachWatcher();
else {
  // First run before any Claude Code session: look again every 3 seconds and
  // start reading as soon as Claude Code creates the folder. No restart needed.
  console.log('That folder does not exist yet. FleetView will start reading it as soon as Claude Code creates it.');
  folderCheck = setInterval(() => {
    if (fs.existsSync(CFG.projectsDir)) { clearInterval(folderCheck); folderCheck = null; console.log('Log folder found.'); attachWatcher(); }
  }, 3000);
}

// ---------- start ----------
function writePidFile() {
  const tmp = PID_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: CFG.port, startedAt: new Date().toISOString() }));
    fs.renameSync(tmp, PID_FILE);
  } catch (e) { console.error('Could not write ' + PID_FILE + ': ' + e.message); }
}
function removePidFile() {
  try {
    const rec = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (rec.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch { /* not ours, or already gone */ }
}

const server = app.listen(CFG.port, CFG.host, () => {
  writePidFile();
  console.log(`FleetView running on http://localhost:${CFG.port}/graph.html  (cards: http://localhost:${CFG.port}/cards.html)`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${CFG.port} is already in use. If FleetView is already running, open http://localhost:${CFG.port}/graph.html. Otherwise run  ${PY} install.py  again and choose another port.`);
    process.exit(1);
  }
  throw err;
});
function stop() {
  removePidFile();
  if (folderCheck) clearInterval(folderCheck);
  if (sweepTimer) clearInterval(sweepTimer);
  Promise.resolve(watcher && watcher.close()).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', removePidFile);

module.exports = { app, store, CFG, graphData };
