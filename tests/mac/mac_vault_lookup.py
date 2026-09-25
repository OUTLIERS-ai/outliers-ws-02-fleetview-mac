"""Mac only (fault row 23, build plan V3): on a Mac, FleetView suggests ~/Second Brain first.

macOS may refuse a program that starts by itself access to ~/Documents, so the Mac guides put the
Second Brain at ~/Second Brain. The installer must suggest it there first, then at
~/Documents/Second Brain. Windows keeps its own order, unchanged.

Run by name only:  python3 -m pytest -q tests/mac/mac_vault_lookup.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Mac look-up order")


def install_and_read_second_brain(tmp_path, home):
    (home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home), CLAUDE_CONFIG_DIR=str(home / ".claude"),
               FLEETVIEW_CONFIG=str(tmp_path / "config.json"))
    r = subprocess.run([sys.executable, str(HERE / "install.py"), "--yes", "--skip-npm", "--crm", "-",
                        "--port", "3014", "--no-launcher", "--no-start"], env=env, capture_output=True,
                       text=True, cwd=str(HERE), timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    return {f["name"]: f["path"] for f in cfg["folders"]}.get("Second Brain")


def test_second_brain_outside_documents_comes_first(tmp_path):
    home = tmp_path / "home"
    for p in (home / "Second Brain", home / "Documents" / "Second Brain"):
        (p / ".obsidian").mkdir(parents=True)
    assert install_and_read_second_brain(tmp_path, home) == str(home / "Second Brain")


def test_a_plain_second_brain_folder_outside_documents_is_suggested(tmp_path):
    home = tmp_path / "home"
    (home / "Second Brain").mkdir(parents=True)
    assert install_and_read_second_brain(tmp_path, home) == str(home / "Second Brain")


def test_documents_is_still_found_when_it_is_the_only_one(tmp_path):
    home = tmp_path / "home"
    (home / "Documents" / "Second Brain" / ".obsidian").mkdir(parents=True)
    assert install_and_read_second_brain(tmp_path, home) == str(home / "Documents" / "Second Brain")
