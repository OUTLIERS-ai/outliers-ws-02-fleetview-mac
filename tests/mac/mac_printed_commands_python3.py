"""Mac only (fault row 18, build plan V3): what FleetView prints must never tell a Mac member to type `python`.

A Mac has `python3` and no plain `python`; "To stop it:  python install.py --stop" fails there with
"command not found" (wave 0a M7, 2026-09-24). Windows keeps printing `python`.

Run by name only:  python3 -m pytest -q tests/mac/mac_printed_commands_python3.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Mac wording")
COMMAND = re.compile(r"(?<![\w/.\-])(python|pip)(?![\w.\-])")
WINDOWS_WORDS = re.compile(r"(?i)\b(windows|notepad|powershell)\b")


def env_for(tmp_path, **extra):
    home = tmp_path / "home"
    (home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home), CLAUDE_CONFIG_DIR=str(home / ".claude"),
               FLEETVIEW_CONFIG=str(tmp_path / "config.json"))
    env.update(extra)
    return env


def run(args, env):
    return subprocess.run([sys.executable, str(HERE / "install.py")] + args, env=env, capture_output=True,
                          text=True, cwd=str(HERE), timeout=300)


def bad(text):
    return [ln for ln in text.splitlines() if COMMAND.search(ln) or WINDOWS_WORDS.search(ln)]


def test_install_says_python3(tmp_path):
    sb = tmp_path / "Second Brain"
    sb.mkdir()
    r = run(["--yes", "--skip-npm", "--second-brain", str(sb), "--crm", "-", "--port", "3013",
             "--no-launcher", "--no-start"], env_for(tmp_path))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "python3 install.py --start" in r.stdout
    assert bad(r.stdout) == [], r.stdout


def test_start_without_an_install_says_python3(tmp_path):
    r = run(["--start"], env_for(tmp_path))
    assert "python3 install.py" in r.stdout
    assert bad(r.stdout) == [], r.stdout


def test_no_node_says_python3(tmp_path):
    empty = tmp_path / "empty-path"
    empty.mkdir()
    r = run(["--yes", "--skip-npm", "--no-launcher"], env_for(tmp_path, PATH=str(empty)))
    assert r.returncode == 1
    assert bad(r.stdout) == [], r.stdout


@pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")
@pytest.mark.parametrize("raw", [b"", b"\xef\xbb\xbf{}", b'{"port": 3011, "folders": [\xff]}', b'{"port": 3011,}'])
def test_the_servers_config_messages_say_python3(tmp_path, raw):
    cfg = tmp_path / "config.json"
    cfg.write_bytes(raw)
    js = ("const c = require(%s); const r = c.readConfigFile(%s);"
          "console.log(JSON.stringify([r.error && r.error.message].concat(r.error ? c.refusalLines(r.error, 'config.json') : [])))"
          % (json.dumps(str(HERE / "lib" / "config.js")), json.dumps(str(cfg))))
    r = subprocess.run([shutil.which("node"), "-e", js], capture_output=True, text=True, timeout=60)
    lines = [ln for ln in json.loads(r.stdout) if ln]
    assert lines, r.stdout + r.stderr
    assert bad("\n".join(lines)) == [], lines
