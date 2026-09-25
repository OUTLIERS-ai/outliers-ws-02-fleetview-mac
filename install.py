#!/usr/bin/env python3
"""FleetView installer.

    python install.py              ask a few questions, install, write config.json
    python install.py --start      only start FleetView (no questions), with no window
    python install.py --stop       stop the running FleetView, however it was started
    python install.py --uninstall  stop it, and remove the file that starts it by itself
                                   when the computer starts (only if this installer made it)

What it does, in order:
  1. Checks Python 3.11 or newer, and Node.js 22 or newer with npm. Node 18
     stopped getting security fixes on 2025-04-30 and Node 20 on 2026-04-30;
     Python 3.10 gets security fixes only until 2026-10-31. If one is missing
     or old, it says how to get it and stops without changing anything.
  2. Runs `npm install` in this folder (downloads 2 small code packages).
  3. Asks where your second brain vault, your CRM vault and any other project
     folders are, and which port to use (3010 unless you say otherwise).
  4. Writes config.json. An existing config.json is backed up first.
  5. Offers to make FleetView start by itself, with no window, each time you
     switch on your computer and sign in to Windows (Windows: a .vbs file in
     your Startup folder; Mac: a launchd file, run when you log in to your Mac).

It never touches Claude Code's settings, hooks or agents. It only reads the log
files Claude Code already writes.

Running it twice with the same answers changes nothing the second time.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = Path(os.environ["FLEETVIEW_CONFIG"]) if os.environ.get("FLEETVIEW_CONFIG") else HERE / "config.json"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
NODE_MIN = (22, 0)
MIN_PY = (3, 11)
CCUSAGE_PACKAGE = "ccusage@20.0.24"
PID_FILE = CONFIG.with_name("fleetview.pid")
LAUNCHER_MARK = "FleetView logon launcher (made by install.py)"
MAC_LABEL = "com.outliers.fleetview"
# The command a member types to run Python: a Mac has python3 and no plain python.
PY = "python3" if sys.platform == "darwin" else "python"

# When the start-up file runs, in the words each system's member reads. On a Mac "log in" alone
# reads as needing an account (Ashley, 2026-09-24), so the Mac says "switch on your Mac and sign
# in". The other systems keep exactly the words this installer printed before (wave 6, 2026-09-25).
_MAC = sys.platform == "darwin"
WHEN_STARTS = "when you switch on your Mac and sign in" if _MAC else "when the computer starts"
EACH_TIME = ("each time you switch on your Mac and sign in" if _MAC
             else "each time you switch on this computer and sign in")
WITH_COMPUTER = "when you switch on your Mac and sign in" if _MAC else "with the computer"
# The key a member presses to accept a suggestion: labelled Return on a Mac.
KEY = "Return" if _MAC else "Enter"


def say(msg=""):
    print(msg, flush=True)


def ask(question, default=None, interactive=True):
    if not interactive:
        return default or ""
    say("")
    say("  " + question)
    prompt = "  > " if not default else "  [%s] > " % default
    try:
        answer = input(prompt).strip()
    except EOFError:
        answer = ""
    return answer or (default or "")


def ask_yes(question, default=True, interactive=True):
    if not interactive:
        return default
    a = ask(question + (" (Y/n)" if default else " (y/N)"), interactive=True).strip().lower()
    if not a:
        return default
    return a.startswith("y")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, creationflags=NO_WINDOW, **kw)


# ---------- 1. prerequisites ----------
def python_version_ok(info=None):
    """True for Python 3.11 or newer. Security fixes ended for 3.8 on 2024-10-07 and 3.9 on 2025-10-31;
    3.10 gets them until 2026-10-31."""
    v = tuple((info or sys.version_info)[:2])
    return v >= MIN_PY


def check_python():
    if python_version_ok(sys.version_info):
        return True
    say("")
    say("  Stopping: this is Python %d.%d. FleetView needs Python 3.11 or newer." % tuple(sys.version_info[:2]))
    say("  Python 3.10 gets security fixes only until 2026-10-31, and older versions get none.")
    if sys.platform == "darwin":
        say("  Get it from https://python.org, then run  python3 install.py  again.")
    else:
        say("  Get it from https://python.org (tick \"Add python.exe to PATH\"), then run  python install.py  again.")
    say("  Nothing was changed.")
    return False


def node_version_ok(text):
    """True for v22.0.0 or newer. Security fixes ended for Node 18 on 2025-04-30 and Node 20 on 2026-04-30."""
    m = re.match(r"v?(\d+)\.(\d+)", (text or "").strip())
    return bool(m) and (int(m.group(1)), int(m.group(2))) >= NODE_MIN


def check_node():
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node:
        return None, None, "Node.js is not installed (or not on your PATH)."
    try:
        out = run([node, "--version"]).stdout.strip()
    except OSError as e:
        return None, None, "Node.js would not start: %s" % e
    if not node_version_ok(out):
        return None, None, ("Node.js %s is too old. FleetView needs version 22 or newer "
                            "(24 is the current long-term support version)." % (out or "(unknown)"))
    if not npm:
        return None, None, "npm (it comes with Node.js) is not on your PATH."
    return node, npm, out


def how_to_get_node():
    say("")
    say("  How to get Node.js 22 or newer (free, about 2 minutes):")
    if sys.platform == "win32":
        say("    Windows:  winget install OpenJS.NodeJS.LTS")
        say("              or download the LTS installer from https://nodejs.org")
    elif sys.platform == "darwin":
        # nodejs.org first: `brew install node` fails on a Mac without Homebrew, so it is
        # only offered when brew is there.
        say("    Mac:      download the LTS installer from https://nodejs.org")
        if shutil.which("brew"):
            say("              or, as you have Homebrew:  brew install node")
    else:
        say("    Linux:    use your package manager, or https://nodejs.org")
    say("  Then close this terminal, open a new one, and run  %s install.py  again." % PY)


# ---------- 3. finding folders ----------
def find_vaults():
    """Obsidian vaults (folders with a .obsidian folder) in the usual places, 2 levels deep."""
    found = []
    home = Path.home()
    # A Mac looks outside Documents first: macOS may refuse a program that starts by itself
    # access to ~/Documents, so the Mac guides put the Second Brain at ~/Second Brain.
    for base in ((home, home / "Documents") if sys.platform == "darwin" else (home / "Documents", home)):
        if not base.is_dir():
            continue
        try:
            level1 = [p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")]
        except OSError:
            continue
        for p in level1:
            if (p / ".obsidian").is_dir() and p not in found:
                found.append(p)
    return found


def guess(vaults, words, fallback):
    for v in vaults:
        if any(w in v.name.lower() for w in words):
            return str(v)
    return str(fallback) if Path(fallback).is_dir() else ""


def projects_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    return Path(base) / "projects"


# ---------- 4. config ----------
def _line_and_column(text, offset):
    upto = text[:max(0, offset)]
    return upto.count("\n") + 1, offset - upto.rfind("\n")


def config_problem(raw):
    """What is wrong with these config.json bytes, in plain words, or None.

    Before 2026-09-23 a damaged config.json was simply ignored: FleetView
    started, every folder name vanished, the port went back to 3010, and
    nothing said so. Now --start refuses and names the line."""
    if raw is None:
        return None
    if raw == b"":
        return {"line": 1, "column": 1, "message": "config.json is empty."}
    if raw[:3] == b"\xef\xbb\xbf":
        if sys.platform == "darwin":   # a Mac has no Notepad or PowerShell (as lib/config.js says it)
            return {"line": 1, "column": 1,
                    "message": "config.json starts with an invisible byte-order mark, which some editors add "
                               "when they save a file. Save it again as UTF-8 without that mark."}
        return {"line": 1, "column": 1,
                "message": "config.json starts with an invisible byte-order mark, which Notepad and "
                           "PowerShell add when they save a file. Save it again as UTF-8 without that mark."}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        line, column = _line_and_column(raw.decode("utf-8", errors="replace"), e.start)
        return {"line": line, "column": column,
                "message": "config.json is not saved as UTF-8: line %d has a character FleetView cannot read. "
                           "Save it as UTF-8." % line}
    try:
        value = json.loads(text)
    except ValueError as e:
        line = getattr(e, "lineno", 1)
        column = getattr(e, "colno", 1)
        lines = text.split("\n")
        snippet = lines[line - 1].strip() if 0 < line <= len(lines) else ""
        msg = str(e)
        if snippet.startswith("//"):
            why = "settings files cannot hold // comments"
        elif getattr(e, "pos", 0) >= len(text.rstrip()):
            why = "the file stops in the middle: a bracket or a quote was never closed"
        elif "trailing comma" in msg or "Expecting property name" in msg or snippet.startswith("}") or snippet.startswith("]"):
            why = "there is a comma after the last item"
        elif "Unterminated" in msg or "control character" in msg:
            why = "a piece of text was never closed with a quote"
        elif "delimiter" in msg:
            why = "a comma or a bracket is missing"
        else:
            why = "a value is missing or mistyped"
        return {"line": line, "column": column, "message":
                "config.json could not be read (line %d, column %d): %s." % (line, column, why)}
    if not isinstance(value, dict):
        return {"line": 1, "column": 1, "message": "config.json must be a set of settings inside { }."}
    return None


def read_config():
    """(settings, problem). A damaged file gives ({}, problem) and is never overwritten in silence."""
    try:
        raw = CONFIG.read_bytes()
    except OSError:
        return {}, None
    problem = config_problem(raw)
    if problem:
        return {}, problem
    return json.loads(raw.decode("utf-8")), None


def load_existing():
    cfg, _problem = read_config()
    return cfg


def write_config(cfg):
    """Returns 'unchanged', 'created' or 'updated'. Never a truncating write."""
    text = json.dumps(cfg, indent=2) + "\n"
    if CONFIG.exists():
        if CONFIG.read_bytes().decode("utf-8", errors="replace") == text:
            return "unchanged"
        backup = CONFIG.with_name("config.json.bak-" + time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(CONFIG, backup)
        state = "updated"
    else:
        state = "created"
    tmp = CONFIG.with_name("config.json.tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, CONFIG)
    return state


def pinned_ccusage(configured):
    """Old installs wrote the floating "ccusage@20"; move them to the checked version."""
    if not configured or configured in ("ccusage", "ccusage@20"):
        return CCUSAGE_PACKAGE
    return str(configured)


# ---------- 5. launcher ----------
def startup_dir():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def launcher_path():
    if sys.platform == "win32":
        d = startup_dir()
        return d / "FleetView.vbs" if d else None
    if sys.platform == "darwin":
        return Path.home() / "Library" / "LaunchAgents" / (MAC_LABEL + ".plist")
    return None


def mac_login_path(node):
    """The folders a Mac login job searches for programs. launchd gives a login job only
    /usr/bin:/bin:/usr/sbin:/sbin, where npx is never found, so the token panel's
    `npx ccusage` failed when FleetView started with the Mac (measured 2026-09-24).
    Node.js's own folder comes first, so npx finds the same node that runs FleetView."""
    dirs = [str(Path(node).parent), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    seen = []
    for d in dirs:
        if d not in seen:
            seen.append(d)
    return ":".join(seen)


def launcher_text(node):
    watcher = HERE / "watcher.js"
    if sys.platform == "win32":
        # 0 = no window, False = do not wait. Windows runs it once, when you sign in after switching on.
        cmd = '"""%s"" ""%s"""' % (node, watcher)
        return (
            "' %s\r\n"
            "' Starts FleetView with no window. Remove with: python install.py --uninstall\r\n"
            "Set sh = CreateObject(\"WScript.Shell\")\r\n"
            "sh.CurrentDirectory = \"%s\"\r\n"
            "sh.Run %s, 0, False\r\n" % (LAUNCHER_MARK, HERE, cmd)
        )
    if sys.platform == "darwin":
        log = HERE / "fleetview.log"
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!-- %s -->\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            '  <key>Label</key><string>%s</string>\n'
            '  <key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>\n'
            '  <key>WorkingDirectory</key><string>%s</string>\n'
            '  <key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string></dict>\n'
            '  <key>RunAtLoad</key><true/>\n'
            '  <key>StandardOutPath</key><string>%s</string>\n'
            '  <key>StandardErrorPath</key><string>%s</string>\n'
            '</dict></plist>\n' % (LAUNCHER_MARK, MAC_LABEL, node, watcher, HERE, mac_login_path(node), log, log)
        )
    return None


def launcher_encoding():
    # Windows Script Host reads UTF-16 files with a byte-order mark, so folder
    # names with accents still work. "utf-16" writes and strips that mark.
    return "utf-16" if sys.platform == "win32" else "utf-8"


def launcher_folder(text):
    """The FleetView folder a start-with-the-computer file made by this installer points at, or None."""
    m = (re.search(r'sh\.CurrentDirectory = "([^"]*)"', text or "")
         or re.search(r"<key>WorkingDirectory</key><string>([^<]*)</string>", text or ""))
    return m.group(1) if m else None


def points_elsewhere(text):
    """True when the file starts the FleetView in ANOTHER folder that still exists (for example the
    everyday folder, when this one is a copy made to try a change). A file pointing at a folder that
    is gone is not protected: the member moved FleetView, and the file should follow."""
    folder = launcher_folder(text)
    if not folder:
        return False
    same = os.path.normcase(os.path.abspath(folder)) == os.path.normcase(os.path.abspath(str(HERE)))
    return not same and (Path(folder) / "watcher.js").is_file()


def install_launcher(node):
    path = launcher_path()
    text = launcher_text(node)
    if not path or text is None:
        say("  This system has no way for the installer to start FleetView %s." % WITH_COMPUTER)
        say("  Start it yourself with:  node \"%s\"" % (HERE / "watcher.js"))
        return "skipped"
    if path.exists():
        old = path.read_bytes().decode(launcher_encoding(), errors="replace")
        if old == text:
            return "unchanged"
        if LAUNCHER_MARK not in old:
            say("  %s already exists and was not made by this installer. Leaving it alone." % path)
            return "skipped"
        if points_elsewhere(old):
            say("  %s already starts the FleetView in %s %s." % (path.name, launcher_folder(old), WITH_COMPUTER))
            say("  Left alone, so that FleetView still starts by itself. Only 1 FleetView can start %s." % WITH_COMPUTER)
            return "elsewhere"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode(launcher_encoding()))  # bytes: keep the exact line endings
    os.replace(tmp, path)
    if sys.platform == "darwin":
        say("  To start it now, without signing out and in again, run:  launchctl load -w \"%s\"" % path)
    return "written"


def port_in_use(port):
    import socket
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def config_port():
    cfg = load_existing()
    try:
        return int(os.environ.get("PORT") or cfg.get("port") or 3010)
    except ValueError:
        return 3010


def read_record():
    """The running FleetView's own record: {"pid": ..., "port": ...}. FleetView writes it
    itself when it starts, however it was started (by the installer, by itself with the computer,
    or by hand)."""
    try:
        text = PID_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        rec = json.loads(text)
    except ValueError:
        return None
    if isinstance(rec, int):  # the old plain-number format: no port, so it cannot be checked
        return {"pid": rec, "port": None}
    if isinstance(rec, dict) and isinstance(rec.get("pid"), int):
        return rec
    return None


def ask_fleetview(port, timeout=1.5):
    """FleetView's own answer on this port (its /api/meta), or None."""
    if not port:
        return None
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % int(port), timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None


def folder_ids():
    """Fingerprints of the folder this installer keeps fleetview.pid in, worked out the same way
    watcher.js works out the folderId it reports on /api/meta. Both spellings of the folder are
    tried (as written, and with shortcuts followed), so a folder reached through a shortcut still
    matches."""
    ids = set()
    for p in (os.path.abspath(str(PID_FILE.parent)), os.path.realpath(str(PID_FILE.parent))):
        if sys.platform == "win32":
            p = p.lower()
        ids.add(hashlib.sha256(p.encode("utf-8")).hexdigest()[:16])
    return ids


def is_this_folder(meta):
    """True when the FleetView that answered keeps its record in this folder. A FleetView from
    before 2026-09-24 reports no folderId; it is taken on its process number alone, as before."""
    fid = (meta or {}).get("folderId")
    return fid is None or fid in folder_ids()


def running():
    """(pid, port) of a FleetView that is running, confirms its own process number, and keeps its
    record in THIS folder, else None. A copy of the folder carries a copy of fleetview.pid; without
    the folder check, --stop in the copy would stop the FleetView in the original folder."""
    rec = read_record()
    if not rec:
        return None
    meta = ask_fleetview(rec.get("port"))
    if meta and meta.get("pid") == rec["pid"] and is_this_folder(meta):
        return rec["pid"], rec["port"]
    return None


def start_hidden(node):
    """Start the server in the background with no window, then wait up to 10 seconds for it."""
    flags = NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    kw = {"creationflags": flags} if sys.platform == "win32" else {"start_new_session": True}
    env = dict(os.environ)
    if CONFIG != HERE / "config.json":
        env["FLEETVIEW_CONFIG"] = str(CONFIG)
    log = open(CONFIG.with_name("fleetview.log"), "ab")
    try:
        proc = subprocess.Popen([node, str(HERE / "watcher.js")], cwd=str(HERE), stdout=log, stderr=log,
                                stdin=subprocess.DEVNULL, env=env, **kw)
    finally:
        log.close()
    port = config_port()
    for _ in range(40):
        meta = ask_fleetview(port, 0.5)
        if meta and meta.get("pid") == proc.pid:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.25)
    return False


def stop():
    """Stop the running FleetView. It is only stopped after it answers on its port with the
    same process number that is on record, so a stale number never ends another program."""
    rec = read_record()
    if not rec:
        say("  FleetView is not running (no record of it in %s)." % PID_FILE.name)
        return 0
    live = running()
    if not live:
        meta = ask_fleetview(rec.get("port"))
        if meta and meta.get("pid") == rec["pid"]:
            say("  The %s in this folder belongs to the FleetView in another folder (port %d)." % (PID_FILE.name, rec["port"]))
            say("  That FleetView was not stopped. This folder was probably copied from it, so the copied")
            say("  %s was removed. Nothing from this folder is running." % PID_FILE.name)
        else:
            say("  The FleetView on record (process %d) is not running any more. Nothing was stopped." % rec["pid"])
            say("  (The record is out of date, so no other program with that number was touched.)")
        try:
            PID_FILE.unlink()
        except OSError:
            pass
        return 0
    pid, port = live
    try:
        os.kill(pid, 15)
    except OSError as e:
        say("  Could not stop FleetView (process %d): %s" % (pid, e))
        return 1
    for _ in range(20):
        if ask_fleetview(port, 0.3) is None:
            break
        time.sleep(0.25)
    say("  Stopped FleetView (process %d, port %d)." % (pid, port))
    try:
        rec2 = read_record()
        if rec2 and rec2.get("pid") == pid:
            PID_FILE.unlink()
    except OSError:
        pass
    return 0


def start_only():
    """python install.py --start: start with the saved answers. No questions."""
    say("FleetView start")
    if not check_python():
        return 1
    if not CONFIG.exists():
        say("  FleetView is not installed yet (no %s). Run  %s install.py  first." % (CONFIG.name, PY))
        return 1
    _cfg, problem = read_config()
    if problem:
        say("  FleetView was NOT started, so your settings are not quietly thrown away.")
        say("  %s" % problem["message"])
        say("  The fault is on line %d of %s." % (problem["line"], CONFIG))
        say("  Fix that line, or run  %s install.py  to write the file again. Your file was not touched." % PY)
        return 1
    node, _npm, info = check_node()
    if not node:
        say("  Stopping: " + info)
        how_to_get_node()
        return 1
    if not (HERE / "node_modules" / "express").is_dir():
        say("  The code packages FleetView needs are missing. Run  %s install.py  first." % PY)
        return 1
    port = config_port()
    live = running()
    if live:
        say("  FleetView is already running. Open  http://localhost:%d/graph.html" % live[1])
        return 0
    if port_in_use(port):
        if ask_fleetview(port):
            say("  Port %d is already used by the FleetView in another folder, so this one was not started." % port)
            say("  To run this folder as well, change \"port\" in this folder's config.json, for example to 3012,")
            say("  then run  %s install.py --start  again." % PY)
        else:
            say("  Port %d is used by another program. Run  %s install.py  again and choose another port." % (port, PY))
        return 1
    if start_hidden(node):
        say("  FleetView started in the background. Open  http://localhost:%d/graph.html" % port)
        return 0
    say("  FleetView could not be started. The reason is at the end of %s" % CONFIG.with_name("fleetview.log"))
    return 1


def uninstall():
    path = launcher_path()
    say("FleetView uninstall")
    if path and path.exists():
        text = path.read_bytes().decode(launcher_encoding(), errors="replace")
        if LAUNCHER_MARK in text and points_elsewhere(text):
            say("  %s starts the FleetView in %s, not this folder, so it was left alone." % (path.name, launcher_folder(text)))
        elif LAUNCHER_MARK in text:
            if sys.platform == "darwin":
                # Switch the job off first, while its file still exists: printing a launchctl line and
                # then deleting the file it names left a line nobody could run (wave 6, 2026-09-25).
                r = subprocess.run(["launchctl", "unload", "-w", str(path)], capture_output=True, text=True,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if r.returncode == 0:
                    say("  Switched off the LaunchAgent that started FleetView when you switched on your Mac and signed in.")
                else:
                    say("  The LaunchAgent was not loaded, so there was nothing to switch off.")
            path.unlink()
            say("  Removed the file that started FleetView %s: %s" % (WITH_COMPUTER, path))
        else:
            say("  %s was not made by this installer; left alone." % path)
    else:
        say("  FleetView was not set to start %s. Nothing to remove." % WITH_COMPUTER)
    say("  If you started FleetView by hand with node watcher.js in a terminal you can see, close that terminal.")
    say("  Your config.json and this folder are left as they are. Delete the folder yourself if you want it gone.")
    return 0


# ---------- main ----------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Install FleetView.")
    ap.add_argument("--uninstall", action="store_true", help="stop FleetView and remove the file that starts it by itself %s" % WHEN_STARTS)
    ap.add_argument("--stop", action="store_true", help="stop a FleetView this installer started")
    ap.add_argument("--yes", action="store_true", help="no questions; use the flags and the defaults found")
    ap.add_argument("--second-brain", help="path to your second brain vault")
    ap.add_argument("--crm", help="path to your CRM vault")
    ap.add_argument("--folder", action="append", default=[], metavar="NAME=PATH", help="another project folder (repeatable)")
    ap.add_argument("--port", type=int, help="web page port (default 3010)")
    ap.add_argument("--projects-dir", help="where Claude Code keeps its logs (default ~/.claude/projects)")
    ap.add_argument("--no-ccusage", action="store_true", help="switch off the 5-hour and 7-day token panel")
    ap.add_argument("--launcher", dest="launcher", action="store_true", default=None, help="make FleetView start by itself, with no window, %s" % EACH_TIME)
    ap.add_argument("--no-launcher", dest="launcher", action="store_false", help="do not make FleetView start by itself %s" % WHEN_STARTS)
    ap.add_argument("--start", dest="start", action="store_true", default=None,
                    help="on its own: only start FleetView, no questions. With other flags: start it after installing")
    ap.add_argument("--no-start", dest="start", action="store_false", help="do not start it now")
    ap.add_argument("--skip-npm", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    if a.stop:
        return stop()
    if a.uninstall:
        stop()
        return uninstall()
    install_flags = [x for x in (argv if argv is not None else sys.argv[1:]) if x not in ("--start",)]
    if a.start and not install_flags:
        return start_only()
    if not check_python():
        return 1

    interactive = not a.yes
    say("FleetView installer")
    say("  FleetView shows every Claude Code session on this computer on 1 page.")
    say("  It only reads the log files Claude Code already writes. It changes nothing in Claude Code.")

    # 1
    node, npm, info = check_node()
    if not node:
        say("")
        say("  Stopping: " + info)
        how_to_get_node()
        say("  Nothing was changed.")
        return 1
    say("  Node.js %s found." % info)

    logs = Path(a.projects_dir) if a.projects_dir else projects_dir()
    if not logs.is_dir():
        say("  Note: %s does not exist yet. That is normal if you have not used Claude Code on this" % logs)
        say("  computer. FleetView starts reading it by itself as soon as your first session creates it.")

    # 2
    if not a.skip_npm:
        if (HERE / "node_modules" / "express").is_dir() and (HERE / "node_modules" / "chokidar").is_dir():
            say("  Code packages already downloaded.")
        else:
            say("  Downloading 2 code packages with npm (needs internet, about 20 seconds)...")
            r = run([npm, "install", "--no-audit", "--no-fund"], cwd=str(HERE))
            if r.returncode != 0:
                say("  npm install failed:")
                say("  " + (r.stderr or r.stdout).strip()[-800:])
                say("  Check your internet connection and run  %s install.py  again. config.json was not changed." % PY)
                return 1
            say("  Code packages downloaded.")

    # 3
    old = load_existing()
    old_folders = {f.get("name"): f.get("path") for f in old.get("folders", []) if isinstance(f, dict)}
    vaults = find_vaults()
    home = Path.home()
    sb_fallback = home / "Documents" / "Second Brain"
    if sys.platform == "darwin" and (home / "Second Brain").is_dir():
        sb_fallback = home / "Second Brain"
    sb_default = a.second_brain or old_folders.get("Second Brain") or guess(vaults, ["brain", "second"], sb_fallback)
    crm_default = a.crm or old_folders.get("CRM") or guess(vaults, ["crm"], home / "CRM")

    say("")
    say("  FleetView groups your sessions by the folder they ran in. Tell it your folders.")
    say("  Press %s to accept the suggestion in brackets, or type '-' to skip one." % KEY)
    sb = ask("Where is your second brain vault?", sb_default, interactive)
    crm = ask("Where is your CRM vault?", crm_default, interactive)

    folders = []
    for name, p in (("Second Brain", sb), ("CRM", crm)):
        if p and p != "-":
            if not Path(p).is_dir():
                say("  Note: %s does not exist on this computer. Kept anyway; fix it in config.json if it is wrong." % p)
            folders.append({"name": name, "path": str(Path(p))})

    extra = []
    for item in a.folder:
        if "=" in item:
            n, p = item.split("=", 1)
            extra.append((n.strip(), p.strip()))
    if interactive and not a.folder:
        for n, p in old_folders.items():
            if n not in ("Second Brain", "CRM"):
                extra.append((n, p))
        if extra:
            say("  Keeping your other folders from last time: " + ", ".join(n for n, _ in extra))
        say("")
        say("  Any other project folders? For example the folder where you write your posts. One at a time; %s on its own to finish." % KEY)
        while True:
            p = ask("Folder path (%s to finish):" % KEY, None, True)
            if not p:
                break
            n = ask("Short name for it:", Path(p).name, True)
            extra.append((n, p))
    elif not interactive and not a.folder:
        for n, p in old_folders.items():
            if n not in ("Second Brain", "CRM"):
                extra.append((n, p))
    seen = {f["name"] for f in folders}
    for n, p in extra:
        if n and p and n not in seen:
            folders.append({"name": n, "path": str(Path(p))})
            seen.add(n)

    port_default = a.port or old.get("port") or 3010
    port_s = ask("Which port should the page use?", str(port_default), interactive)
    try:
        port = int(port_s)
        assert 1024 <= port <= 65535
    except (ValueError, AssertionError):
        say("  '%s' is not a usable port; using 3010." % port_s)
        port = 3010

    usage_on = not a.no_ccusage
    if interactive and not a.no_ccusage:
        say("")
        say("  The token panel uses ccusage, a free open-source tool, run through npx. The first run")
        say("  downloads it (needs internet). It runs only while a FleetView page is open.")
        usage_on = ask_yes("Switch on the 5-hour and 7-day token panel?", old.get("usage", {}).get("enabled", True), True)

    cfg = {
        "port": port,
        "host": "127.0.0.1",
        "folders": folders,
        "idle_per_folder": old.get("idle_per_folder", 3),
        "hide_paths": old.get("hide_paths", False),
        "usage": {"enabled": bool(usage_on), "package": pinned_ccusage(old.get("usage", {}).get("package"))},
    }
    if isinstance(old.get("waiting_hours"), (int, float)):
        cfg["waiting_hours"] = old["waiting_hours"]
    if a.projects_dir or old.get("projects_dir"):
        cfg["projects_dir"] = str(a.projects_dir or old.get("projects_dir"))

    # 4
    state = write_config(cfg)
    say("")
    say("  config.json %s." % state)

    # 5
    want = a.launcher
    if want is None:
        want = ask_yes("Start FleetView by itself, with no window, %s?" % EACH_TIME,
                       True, interactive) if interactive else False
    if want:
        res = install_launcher(node)
        p = launcher_path()
        if res == "elsewhere":
            say("  Starts %s: the FleetView in the other folder, as before." % WITH_COMPUTER)
        elif res == "skipped" or p is None:
            say("  Starts %s: not set up." % WITH_COMPUTER)
        else:
            where = "your Startup folder" if sys.platform == "win32" else "your LaunchAgents folder (Mac)"
            verb = "was written into" if res == "written" else "is already in"
            say("  Starts %s: a small file called %s %s %s (%s)." % (WITH_COMPUTER, p.name, verb, where, p))

    started = False
    already = False
    live = running()
    if live and state == "unchanged" and live[1] == port:
        already = True
        say("  FleetView is already running with these settings.")
    else:
        restart = False
        if live:
            # The settings changed (maybe the port): stop the old copy so only 1 runs, on the new settings.
            say("  Your settings changed, so the running FleetView (port %d) is stopped first." % live[1])
            stop()
            restart = True
        if port_in_use(port):
            say("  Port %d is used by another program. Run  %s install.py  again and choose another port." % (port, PY))
        else:
            if restart and a.start is None:
                start_now = True
            else:
                start_now = a.start if a.start is not None else (ask_yes("Start FleetView now, with no window?", True, interactive) if interactive else False)
            if start_now:
                started = start_hidden(node)
                if started:
                    say("  FleetView started in the background.")
                else:
                    say("  FleetView could not be started. The reason is at the end of %s" % CONFIG.with_name("fleetview.log"))

    say("")
    if already:
        say("  Done. FleetView is already running. Open  http://localhost:%d/graph.html" % port)
        say("  To stop it:  %s install.py --stop" % PY)
    elif started:
        say("  Done. Open  http://localhost:%d/graph.html  in your browser." % port)
        say("  To stop it:  %s install.py --stop" % PY)
    else:
        say("  Done. Start it with:  %s install.py --start" % PY)
        say("  then open  http://localhost:%d/graph.html" % port)
    say("  Dollar figures on the page are what the tokens would cost if you paid per token.")
    say("  They are not money taken from your subscription.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
