"""Mac only (wave 6, fault row 18 kind): the installer's own check of config.json must not name Notepad
or PowerShell on a Mac.

When config.json starts with an invisible byte-order mark, `install.py` (config_problem) said the mark
is what "Notepad and PowerShell add when they save a file". A Mac has neither. lib/config.js already
says it the Mac way (wave 1); install.py was missed. Found by the FleetView Mac-guide writer, 2026-09-25.
Windows keeps its words, word for word.

Run by name only:  python3 -m pytest -q tests/mac/mac_config_bom_words.py
"""
import importlib.util
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Mac wording")


def load_install():
    spec = importlib.util.spec_from_file_location("fleetview_install", HERE / "install.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_a_byte_order_mark_is_explained_without_naming_pc_programs():
    install = load_install()
    problem = install.config_problem(b"\xef\xbb\xbf{\"port\": 3010}")
    assert problem is not None and problem["line"] == 1
    msg = problem["message"]
    assert not re.search(r"(?i)notepad|powershell|windows", msg), msg
    assert "UTF-8" in msg and "mark" in msg, msg
