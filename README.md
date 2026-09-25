**This is the Mac version.** On Windows, use [outliers-ws-02-fleetview](https://github.com/OUTLIERS-ai/outliers-ws-02-fleetview).

# FleetView: every Claude Code session on a single screen

```
git clone https://github.com/OUTLIERS-ai/outliers-ws-02-fleetview-mac; cd outliers-ws-02-fleetview-mac; python3 install.py
```

Say yes when it offers to start FleetView, then open **http://localhost:3010/graph.html**. Later, start it with `python3 install.py --start` and stop it with `python3 install.py --stop`.

![FleetView with made-up sessions](guide/img/fleetview-graph.png)

Want to see it before your own sessions exist? `npm install` then `npm run demo`, and open http://localhost:3011/graph.html (made-up sessions, port 3011, Ctrl+C stops it).

## What it shows

- **Who needs you.** "2 need you" at the top, and a **Needs you** strip naming every session where **Claude's last message asked you something** (a question mark at the end of any of its last 3 lines), newest question first. It stays amber until you answer, up to `waiting_hours` (1 hour out of the box; after that it goes blue-grey). A reply that answers and asks nothing is not counted: it reads "answered 12 min ago". Dealt with one another way? Open it and press **Mark as done**.
- A dot (a hub) for each of your folders: your second brain, your CRM, your content engine, anything else you name. Sessions from any other folder hang off a hub called **Other**. A folder appears once it has a session today.
- A circle for each Claude Code session today. The fill says what it is doing: green working, amber it asked you something (darker amber over 30 minutes old), violet it may need your approval (a tool call with no answer for 30 seconds — counted on its own, not as "need you"), blue-grey idle or answered-and-asked-nothing, grey with a tick for the ones you marked as done.
- The letter inside is the model: **O** Opus, **S** Sonnet, **F** Fable, **M** Mythos, **H** Haiku, **?** any other model.
- The ring round each circle is how full its context window is, always light grey. Over 85% full a small red **!** appears beside the circle, so the alarm never sits on top of the status colour. **1M** means a 1,000,000-token window.
- Small dots are helper agents (subagents) started in the last 30 minutes.
- The top bar adds up **every** session today, drawn or not, and says when idle sessions were left off the drawing (with a **show all** link, or add `?all=1` to the address). Then your **5-hour window** and **7-day total**, Claude Code only (from `ccusage claude`). Click either gauge to set a token budget.
- Hover any circle for a label in words; click it for the detail and its last 10 steps. Escape closes the panel.
- If FleetView stops, the page shows a red **FleetView stopped** banner within 5 seconds, and the top bar and every age on the page go quiet with it ("2 needed you at 16:20" instead of a live-looking count).
- If `config.json` cannot be read, both pages show an amber banner naming the line, and `python3 install.py --start` refuses to start rather than throwing your folder names and port away in silence.
- As soon as 1 folder has more than 4 sessions, or there are more than 12 in total, the graph switches to 1 column per folder: 30 sessions on a 1366x768 screen, 58 labels, none touching.
- `http://localhost:3010/cards.html` shows the same sessions and totals as cards. `/` goes to the graph.

**About the dollar figures.** `$` is what these tokens would cost if you paid per token, at the rates read off Anthropic's pricing page on 2026-09-22, Claude Opus 5.5 included. It is not money taken from your subscription. A model with no price row shows "no price" instead of a guess, and `npm test` fails if a model in your own recent logs has no row.

## What it needs

- **Node.js 22 or newer** (24 is the current long-term support version). Check with `node --version`. Node 18 stopped getting security fixes on 2025-04-30, and Node 20 on 2026-04-30. Get it from https://nodejs.org.
- **Python 3.11 or newer** for the installer. Check with `python3 --version`. Python 3.10 gets security fixes only until 2026-10-31, and the installer refuses 3.10 and older.
- **Claude Code.** If you have not used it yet, FleetView starts reading its log folder as soon as it appears.
- Internet for `npm install` and the first run of the token panel (it downloads ccusage). The pages need nothing from the internet: React is stored in `public/vendor/`.

## What it does not do

It adds no hooks, changes no settings and starts no agents. It only reads the log files Claude Code already writes in `~/.claude/projects`. The page answers only on this computer (127.0.0.1) and refuses requests that name another website.

## Commands

| Command | What it does |
|---|---|
| `python3 install.py` | Checks Node.js, downloads 2 code packages, asks for your folders, writes `config.json`, offers to start FleetView by itself, with no window, each time you switch on your Mac and log in (no account needed), starts FleetView. Changed answers restart it on the new settings |
| `python3 install.py --start` | Only starts FleetView, with your saved answers. No questions |
| `python3 install.py --stop` | Stops FleetView however it was started (by the installer, by itself with the computer, or by hand). Checks it really is FleetView before stopping it |
| `python3 install.py --uninstall` | Stops it and removes the start-up file (a LaunchAgent) that started it with the computer. Leaves everything else |
| `python3 install.py --yes --second-brain PATH --crm PATH --folder "NAME=PATH" --port N --no-ccusage --no-launcher --no-start` | Install with no questions |
| `node watcher.js` / `npm start` | Start FleetView in this terminal, showing any error |
| `npm run demo` | 8 made-up sessions in 4 folders on port 3011 |
| `npm test` | 60 JavaScript checks against made-up sessions |
| `source ~/outliers-checks/bin/activate && python -m pytest -q` | 30 installer checks in a temp folder, run in the private Python folder the guide's "The safe way to change it" makes first (then install pytest once with `source ~/outliers-checks/bin/activate && python -m pip install pytest`). On a Mac 27 pass and 3 are skipped. 90 checks in total with `npm test`; on GitHub's test Macs on 2026-09-25 none failed |

## Settings (`config.json`)

| Key | Meaning |
|---|---|
| `port` | Page port, 3010 by default |
| `host` | `127.0.0.1`: only this computer. Leave it |
| `folders` | Your folders: `[{ "name": "CRM", "path": "..." }]`. The most specific match wins |
| `idle_per_folder` | Idle sessions drawn per folder (3). Totals always count every session |
| `waiting_hours` | How many hours an unanswered question stays amber (1). After that it goes blue-grey and leaves the Needs you strip |
| `fresh_minutes` | Under this many minutes a question is bright amber; older ones get the darker amber (30) |
| `hide_paths` | `true` hides folder paths, file names and the text of recent steps, for screen-sharing |
| `usage.enabled` | `false` switches the 5-hour and 7-day panel off |
| `usage.package` | The ccusage version run (`ccusage@20.0.24`) |
| `projects_dir` | Only if Claude Code keeps its logs somewhere unusual |

After changing `config.json`: `python3 install.py --stop`, then `python3 install.py --start`. `config.example.json` shows every setting. FleetView writes `fleetview.pid` (process number and port, for `--stop`) and, when started in the background, `fleetview.log` (read the end of it if it will not start). Terminal settings: `PORT`, `FLEETVIEW_CONFIG`, `CLAUDE_CONFIG_DIR`, `FLEETVIEW_NO_CCUSAGE=1`.

Prices live in `lib/prices.json`, read off Anthropic's pricing page on 2026-09-22 (Claude Opus 5.5 included, plus the bare words `opus`, `sonnet` and `haiku` that Claude Code also accepts as model names). Add a row when a new model appears, then restart. `npm test` reads your own logs from the last 7 days and fails if a model in them has no row.

## Credit

Built on [Stargx/claude-code-dashboard](https://github.com/Stargx/claude-code-dashboard), MIT, Copyright (c) 2025 Cold Beam Games. Token counts for each 5-hour period come from [ccusage](https://github.com/ccusage/ccusage), MIT. React 18.3.1 (MIT, Copyright (c) Facebook, Inc. and its affiliates) is in `public/vendor/` with its licence. See `WHAT-I-STOLE.md` and `LICENSE`.

The full guide, including how it was built and 8 ways to fit it to your own setup, is in `guide/GUIDE.md`.

This repo is made automatically from outliers-ws-02-fleetview@ce6e278. To report a problem or suggest a change, use that repo, not this one.
