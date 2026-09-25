"""Mac only (wave 6, round 3): after `python3 install.py --uninstall`, installing FleetView again must
leave a LaunchAgent the Mac will start.

Found in the recorded Mac run 36157335920 (2026-09-25): the uninstall switched the job off with
`launchctl unload -w <file>`. The `-w` writes a lasting "disabled" mark for the label, so after an
uninstall and a new install `launchctl bootstrap` failed with "Bootstrap failed: 5: Input/output
error", and the job would not start when the member signed in. A member who ran that uninstall
already carries the mark, so a new install must also clear it.

2 checks, each in a throwaway home folder, each removing the job at the end:
  1. install, uninstall, install again: the LaunchAgent can be switched on (bootstrap succeeds and
     launchd knows the label);
  2. the label already marked disabled (as the old uninstall left it), then install: the same.

Run by name only:  python3 -m pytest -q tests/mac/mac_reinstall_after_uninstall.py
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
LABEL = "com.outliers.fleetview"
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="LaunchAgents are a Mac feature")


def launchctl(*args):
    return subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=60)


def domain():
    return "gui/%d" % os.getuid()


def install(args, home):
    env = dict(os.environ, HOME=str(home), CLAUDE_CONFIG_DIR=str(home / ".claude"),
               FLEETVIEW_CONFIG=str(home / "config.json"))
    return subprocess.run([sys.executable, str(HERE / "install.py")] + args, env=env, capture_output=True,
                          text=True, cwd=str(HERE), timeout=300)


def install_launcher(home, sb):
    r = install(["--yes", "--skip-npm", "--second-brain", str(sb), "--crm", "-", "--port", "3017",
                 "--launcher", "--no-start"], home)
    assert r.returncode == 0, r.stdout + r.stderr
    return r


def switch_on(plist):
    """What the Mac does at sign-in: bootstrap the file. Returns (ok, detail)."""
    b = launchctl("bootstrap", domain(), str(plist))
    p = launchctl("print", "%s/%s" % (domain(), LABEL))
    return b.returncode == 0 and p.returncode == 0, "bootstrap exit %s: %s%s | print exit %s" % (
        b.returncode, b.stdout, b.stderr, p.returncode)


def clean_up(plist):
    launchctl("bootout", "%s/%s" % (domain(), LABEL))
    launchctl("enable", "%s/%s" % (domain(), LABEL))


def setup(tmp_path):
    home = tmp_path / "home"
    (home / ".claude" / "projects").mkdir(parents=True)
    sb = tmp_path / "Second Brain"
    sb.mkdir()
    return home, sb, home / "Library" / "LaunchAgents" / (LABEL + ".plist")


def test_install_uninstall_install_leaves_a_launchagent_the_mac_can_start(tmp_path):
    home, sb, plist = setup(tmp_path)
    try:
        clean_up(plist)
        install_launcher(home, sb)
        ok, detail = switch_on(plist)
        assert ok, "the first install's LaunchAgent could not be switched on: " + detail
        u = install(["--uninstall"], home)
        assert u.returncode == 0, u.stdout + u.stderr
        assert not plist.exists()
        install_launcher(home, sb)
        ok, detail = switch_on(plist)
        assert ok, "after an uninstall and a new install the LaunchAgent could not be switched on: " + detail
    finally:
        clean_up(plist)


def test_a_label_left_disabled_by_an_earlier_uninstall_is_cleared_by_install(tmp_path):
    home, sb, plist = setup(tmp_path)
    try:
        clean_up(plist)
        launchctl("disable", "%s/%s" % (domain(), LABEL))   # what `launchctl unload -w` left behind
        install_launcher(home, sb)
        ok, detail = switch_on(plist)
        assert ok, "a label an earlier uninstall disabled stays disabled after a new install: " + detail
    finally:
        clean_up(plist)
