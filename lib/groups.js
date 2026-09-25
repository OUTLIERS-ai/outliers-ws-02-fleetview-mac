// Groups sessions by the folder they ran in, using the member's own folder list
// from config.json ("folders": [{ "name": "Second Brain", "path": "..." }, ...]).
// A session belongs to the folder whose path is the longest match for the
// session's working folder. Anything that matches none goes to "Other".
'use strict';

const OTHER = 'Other';

function normPath(p) {
  if (!p || typeof p !== 'string') return '';
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths are not case-sensitive: compare them in lower case.
  if (/^[a-zA-Z]:\//.test(s) || /^\/\//.test(s)) s = s.toLowerCase();
  return s;
}

function makeGrouper(folders) {
  const list = (Array.isArray(folders) ? folders : [])
    .filter(f => f && typeof f.path === 'string' && f.path.trim())
    .map(f => ({ name: String(f.name || '').trim() || lastPart(f.path), key: normPath(f.path) }))
    .sort((a, b) => b.key.length - a.key.length); // longest (most specific) first
  return function groupOf(cwd) {
    const c = normPath(cwd);
    if (!c) return OTHER;
    for (const f of list) {
      if (c === f.key || c.startsWith(f.key + '/')) return f.name;
    }
    return OTHER;
  };
}

function lastPart(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

module.exports = { makeGrouper, normPath, lastPart, OTHER };
