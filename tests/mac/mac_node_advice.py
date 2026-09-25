"""Mac only (fault row 21, build plan V3): with no Node.js, the Mac advice must work without Homebrew.

The installer used to print `brew install node` first on every Mac. On a Mac without Homebrew that
line fails with "command not found". nodejs.org's installer works on every Mac, so it comes first,
and `brew install node` is offered only when Homebrew is there.

Run by name only:  python3 -m pytest -q tests/mac/mac_node_advice.py
"""
import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Mac advice")


def load_install():
    spec = importlib.util.spec_from_file_location("fv_install_node", str(HERE / "install.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def advice(monkeypatch, capsys, brew):
    m = load_install()
    real = m.shutil.which
    monkeypatch.setattr(m.shutil, "which", lambda name, *a, **k: brew if name == "brew" else real(name, *a, **k))
    m.how_to_get_node()
    return capsys.readouterr().out


def test_without_homebrew_there_is_no_brew_line(monkeypatch, capsys):
    out = advice(monkeypatch, capsys, None)
    assert "nodejs.org" in out
    assert "brew install" not in out, out


def test_with_homebrew_nodejs_org_still_comes_first(monkeypatch, capsys):
    out = advice(monkeypatch, capsys, "/opt/homebrew/bin/brew")
    assert "brew install node" in out
    assert out.index("nodejs.org") < out.index("brew install node"), out
