// The token panel's link to ccusage, a free open-source tool (MIT) that reads the
// same log files and knows Claude's 5-hour usage windows.
//
// Always "ccusage claude ...": without the word "claude", ccusage 20 adds up every
// AI coding tool it finds on the computer (Codex, Gemini CLI, Copilot CLI, Grok ...)
// and FleetView would show their usage as Claude's. Checked live with ccusage
// 20.0.24 on 2026-09-22 (`ccusage claude --help` lists daily and blocks).
//
// The version is pinned, so a new ccusage release never runs on a member's
// computer without them choosing it. Change "usage.package" in config.json to move.
'use strict';

const DEFAULT_PACKAGE = 'ccusage@20.0.24';

// Old installs wrote the floating "ccusage@20"; move those to the pinned version.
function packageFrom(configured) {
  if (!configured || configured === 'ccusage@20' || configured === 'ccusage') return DEFAULT_PACKAGE;
  return String(configured);
}

function command(pkg, args) {
  if (!/^[@a-z0-9._/-]+$/i.test(pkg)) throw new Error('usage.package in config.json is not a package name: ' + pkg);
  return `npx -y ${pkg} claude ${args} --json`;
}

// Sum the last 7 calendar days (today and the 6 before it) of `ccusage claude daily --json`.
function weekFromDaily(answer, now = new Date()) {
  const days = (answer && answer.daily) || [];
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0, 0, 0, 0);
  let tokens = 0, cost = 0, n = 0;
  for (const d of days) {
    const day = d.period || d.date;
    if (!day || new Date(day + 'T00:00:00') < cutoff) continue;
    tokens += d.totalTokens || 0; cost += d.totalCost || 0; n++;
  }
  return { tokens, cost: Math.round(cost * 100) / 100, days: n };
}

module.exports = { DEFAULT_PACKAGE, packageFrom, command, weekFromDaily };
