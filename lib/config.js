// Reading config.json, and saying in plain words when it cannot be read.
//
// Before 2026-09-22 a damaged config.json was swallowed: FleetView started,
// every folder name disappeared, the port went back to 3010, and the only
// trace was 1 line in fleetview.log. Now the fault travels with the settings,
// so /api/meta can carry it and the page can put a banner at the top.
//
// 2026-09-23: the port went back to 3010 even then. FleetView now keeps the
// port it last ran on, and refuses to start when it cannot tell what that was.
'use strict';
const fs = require('fs');
const path = require('path');

// Where in the text a character offset falls, counting from 1.
function lineAndColumn(text, offset) {
  const upto = text.slice(0, Math.max(0, offset));
  const line = upto.split('\n').length;
  const column = offset - upto.lastIndexOf('\n');
  return { line, column };
}

function plainReason(message, snippet, atEnd) {
  const m = String(message || '');
  if ((snippet || '').startsWith('//') || /Unexpected token\s*'?\//.test(m)) return 'settings files cannot hold // comments';
  if (atEnd || /Unexpected end of (JSON|input)/i.test(m)) return 'the file stops in the middle: a bracket or a quote was never closed';
  if (/double-quoted property name/i.test(m) || /Unexpected token\s*'?[\}\]]/.test(m) ||
      (snippet || '').startsWith('}') || (snippet || '').startsWith(']')) return 'there is a comma after the last item';
  if (/Unexpected non-whitespace/i.test(m)) return 'there is something after the final }';
  if (/Bad control character|Unterminated string/i.test(m)) return 'a piece of text was never closed with a quote';
  if (/Expected ',' or/i.test(m)) return 'a comma or a bracket is missing';
  return 'a value is missing or mistyped';
}

// Reads the file's bytes. Returns { text, config, error }.
// error is null, or { message, line, column, kind } with message already in plain words.
// The command a member types to run Python: a Mac has python3 and no plain python.
const PY = process.platform === 'darwin' ? 'python3' : 'python';
// A Mac has no Notepad or PowerShell, so it is not told about them.
const MARK_ADDED_BY = process.platform === 'darwin'
  ? 'config.json starts with an invisible mark some editors add when they save. Save it again as UTF-8 without that mark'
  : 'config.json starts with an invisible mark that Notepad and PowerShell add when they save. In Notepad choose Save as and pick UTF-8 without that mark';

function readConfigFile(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') return { text: '', config: {}, error: null, missing: true };
    return { text: '', config: {}, error: { message: 'config.json could not be opened: ' + e.message, line: 1, column: 1, kind: 'unreadable' } };
  }
  if (bytes.length === 0) {
    return { text: '', config: {}, error: { message: 'config.json is empty. Run  ' + PY + ' install.py  to write it again.', line: 1, column: 1, kind: 'empty' } };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: '', config: {}, error: { kind: 'bom', line: 1, column: 1,
      message: MARK_ADDED_BY + ', or run  ' + PY + ' install.py  to write it fresh.' } };
  }
  const text = bytes.toString('utf8');
  if (text.includes('�')) {
    const at = text.indexOf('�');
    const { line, column } = lineAndColumn(text, at);
    return { text, config: {}, error: { kind: 'encoding', line, column,
      message: 'config.json is not saved as UTF-8: line ' + line + ' has a character FleetView cannot read. Save it as UTF-8, or run  ' + PY + ' install.py  to write it fresh.' } };
  }
  try {
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { text, config: {}, error: { kind: 'shape', line: 1, column: 1, message: 'config.json must be a set of settings inside { }.' } };
    }
    return { text, config, error: null };
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const pos = m ? parseInt(m[1], 10) : -1;
    const { line, column } = pos >= 0 ? lineAndColumn(text, pos) : { line: 1, column: 1 };
    const snippet = (text.split('\n')[line - 1] || '').trim();
    const atEnd = pos >= 0 && pos >= text.replace(/\s+$/, '').length;
    const why = plainReason(e.message, snippet, atEnd);
    // A comma after the last item: Node stops at the bracket on the NEXT line,
    // so the member was sent to a line with nothing wrong on it. Point at the
    // comma itself, which is the line install.py names too.
    let at = { line, column };
    if (why === 'there is a comma after the last item' && pos > 0) {
      const comma = text.lastIndexOf(',', pos);
      if (comma > 0) at = lineAndColumn(text, comma);
    }
    return { text, config: {}, error: { kind: 'json', line: at.line, column: at.column,
      message: 'config.json could not be read (line ' + at.line + ', column ' + at.column + '): ' + why + '.' } };
  }
}

// The port FleetView last really ran on, read from the fleetview.pid record it
// writes every time it starts, however it was started. A port that really
// worked, not a guess. Returns null when there is no record.
function lastGoodPort(configFile) {
  const record = path.join(path.dirname(path.resolve(configFile)), 'fleetview.pid');
  try {
    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (rec && Number.isInteger(rec.port) && rec.port > 0 && rec.port < 65536) return rec.port;
  } catch { /* no record, or not readable */ }
  return null;
}

// What FleetView says when config.json is damaged and it cannot tell which port
// to use, so it does not start. These are the words  python install.py --start
// already uses, kept here as the one place they are written, so a member reads
// the same sentences whichever way they started FleetView.
function refusalLines(error, file) {
  return [
    'FleetView was NOT started, so your settings are not quietly thrown away.',
    error.message,
    'The fault is on line ' + error.line + ' of ' + file + '.',
    'Fix that line, or run  ' + PY + ' install.py  to write the file again. Your file was not touched.',
  ];
}

// What it says when config.json is damaged but the port it last ran on is known,
// so it can start on that port and put the fault on the page.
function damagedLines(error, file, port) {
  return [
    error.message,
    'FleetView has started on port ' + port + ', the port it last ran on, so a browser tab you already have open still works.',
    'None of your folder names are in use until the file is fixed.',
    'Fix that line, or run  ' + PY + ' install.py  to write the file again. Your file was not touched.',
  ];
}

module.exports = { PY, readConfigFile, lineAndColumn, plainReason, lastGoodPort, refusalLines, damagedLines };
