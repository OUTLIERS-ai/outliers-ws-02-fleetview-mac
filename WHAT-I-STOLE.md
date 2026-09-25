# What I stole

FleetView is mostly someone else's work. This page says whose, under what licence, and what we changed.

## Stargx/claude-code-dashboard

- **Where:** https://github.com/Stargx/claude-code-dashboard
- **Licence:** MIT, "Copyright (c) 2025 Cold Beam Games". The original licence file is kept, unchanged, as `UPSTREAM-LICENSE`, and the copyright line is repeated in `LICENSE`.
- **Version taken:** commit `e7c7eda`, 2026-03-09, "Fix command injection vulnerability in open-folder endpoint".
- **What we kept:** the idea of reading Claude Code's own log files instead of adding hooks; the file-watching and line-by-line reading; the first version of the session status rules (working / waiting / idle, since rewritten, see below); the card page layout, now `public/cards.html` (rebuilt on FleetView's data, see below); the open-folder route with its 2026-03-09 security fix.
- **What MIT lets us do:** use, copy, change, merge, publish, share, sub-license and sell, free, as long as the copyright line and permission text travel with every copy. No warranty.

## What we added or changed

| Change | Why |
|---|---|
| `public/graph.html` (FleetView) and the `/api/graph` route | Upstream shows cards. The graph shows every session hanging off its folder, with subagents as satellites. Drawn by hand on a canvas, no libraries. |
| `/api/usage` token panel using ccusage | Subscription users care about the 5-hour usage window, not dollars. ccusage already works that out. |
| Grouping by the member's own folders (`lib/groups.js`, `config.json`) | Ashley's copy grouped by the folder name after `\Documents\`, which only fits his habits. |
| Price table moved to `lib/prices.json`, checked 2026-09-22 | Upstream charged Opus 4.6 at $15/$75 (the real rate is $5/$25) and cache writes at 0.25 times the input rate. Ashley's June copy had no row for Opus 5 and fell back to Sonnet 4.6 rates. Now a model with no row shows "no price". |
| Cost worked out per reply, with that reply's model | A Haiku subagent inside an Opus session used to be priced as Opus. 1-hour cache writes (2 times input) are now priced apart from 5-minute writes (1.25 times). |
| Context window of 200,000 or 1,000,000 | Upstream always assumed 200,000, so a 1M session read 100% for most of its life. |
| Subagent turns no longer overwrite the session's model and context ring | Upstream mixed them in. |
| A half-written last line is kept for the next read | Upstream moved its bookmark to the end of the file and lost that line for good. |
| Server listens on 127.0.0.1 only | Upstream listened on every network card, so anyone on the same wifi could read your session log. |
| ccusage runs only while a FleetView page is open | Ashley's copy ran it every 60 seconds all day, whether anyone looked or not. |
| "Waiting for you" lasts until the member answers | Upstream showed waiting for 15 seconds, and bookkeeping lines Claude Code writes after a reply reset it sooner. |
| Token panel asks ccusage for Claude Code only, pinned to 20.0.24 | `ccusage daily` adds every AI coding tool it finds (Codex, Gemini, Grok ...). |
| 1 set of totals for both pages, plus a "stopped" banner, a key and hover labels | The pages disagreed and froze silently when the server stopped. |
| Host-header check; big logs read in 16 MB pieces | A DNS-rebinding web page could read the session list; a log over about 512 MB crashed the server. |
| `install.py`, tests, made-up demo sessions | So a stranger can install it, and so we can prove it works without anyone's real history. |

## What we left out of Ashley's copy

FleetMap (his 73 agents as a map), Comms Mesh (agents talking across his apps), Fleet Cinema (3D video), the ProjectForge poll to port 3020, the `/api/emit` route, and every file containing his data. None of it is in this download.

## Tools it uses, not copied

- **ccusage** — https://github.com/ccusage/ccusage, MIT. Run with `npx -y ccusage@20.0.24 claude ...`; 20.0.24 was the latest on npm on 2026-09-22.
- **Express** 5.2.1 and **chokidar** 5.0.0 — both MIT, installed by `npm install`.
- **React 18.3.1** — MIT, Copyright (c) Facebook, Inc. and its affiliates. The 2 production files are copied unchanged into `public/vendor/` with the licence text (`LICENSE-react.txt`), so the card page works offline.

## The free ready-made alternative

**hoangsonww/Claude-Code-Agent-Monitor** — MIT, "Copyright (c) 2026 Son Nguyen". Bigger and more polished. It adds hooks to `~/.claude/settings.json` and imports your full history on first start. See the guide's section on it before trying it.
