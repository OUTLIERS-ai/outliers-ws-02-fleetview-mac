# -*- coding: utf-8 -*-
"""Wave 6 (2026-09-25): on a Mac the installer says when its start-up file runs in the words Ashley
ruled on 2026-09-24, "when you switch on your Mac and sign in". "Log in" alone reads as needing an
account, and "with the computer" / "when the computer starts" is the other system's wording.
Windows keeps its words.

Run by name only:  python3 -m pytest -q tests/mac/mac_signin_wording.py
(pytest never collects tests/mac/ in a plain run, so the counts the guides print stay true.)
"""
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MAC_WORDS = "switch on your Mac and sign in"


def said_lines(text):
    """The say()/help= strings of install.py, joined per call (comments left out)."""
    return [l for l in text.splitlines() if not l.lstrip().startswith("#") and ("say(" in l or "help=" in l or "ask_yes(" in l)]


def test_every_start_up_message_takes_its_words_from_1_setting():
    text = (ROOT / "install.py").read_text(encoding="utf-8")
    for l in said_lines(text):
        assert "with the computer" not in l and "when the computer starts" not in l, l
        assert "when you log in" not in l and "logging out" not in l, l
    assert re.search(r'^WHEN_STARTS = "when you switch on your Mac and sign in" if _MAC', text, re.M)


@pytest.mark.skipif(sys.platform != "darwin", reason="the Mac wording is printed on a Mac only")
def test_on_a_mac_the_help_says_switch_on_your_mac_and_sign_in():
    r = subprocess.run([sys.executable, "install.py", "--help"], cwd=str(ROOT), capture_output=True, text=True,
                       timeout=60, creationflags=NO_WINDOW)
    out = " ".join(r.stdout.split())
    assert r.returncode == 0, r.stderr
    assert "when the computer starts" not in out and "this computer" not in out
    assert "each time you " + MAC_WORDS in out and "when you " + MAC_WORDS in out, out


def test_on_a_mac_the_key_is_called_return():
    """The Mac key is labelled Return. Every prompt takes the key's name from 1 setting, KEY."""
    text = (ROOT / "install.py").read_text(encoding="utf-8")
    assert re.search(r'^KEY = "Return" if _MAC else "Enter"', text, re.M)
    for l in text.splitlines():
        if l.lstrip().startswith("#"):
            continue
        assert not re.search(r"\b[Pp]ress Enter\b|\bEnter on its own\b|\(Enter to finish\)", l), l
