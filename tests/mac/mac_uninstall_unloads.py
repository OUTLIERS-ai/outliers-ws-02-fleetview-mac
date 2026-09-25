"""Mac only (wave 6): `python3 install.py --uninstall` must switch the LaunchAgent off itself.

Before: it printed "First run:  launchctl unload -w <file>" and then deleted <file>, so the printed
line could never be run, and the job stayed loaded in launchd until the member logged out. Found by
the FleetView Mac-guide writer, 2026-09-25. Now the installer unloads the job, then removes the file,
and says it did both.

The test writes the real LaunchAgent (in a throwaway home folder), loads it with launchctl, runs
the uninstall, and requires launchd to have forgotten the job. It always removes the job at the end.

Run by name only:  python3 -m pytest -q tests/mac/mac_uninstall_unloads.py
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


def install(args, home):
    env = dict(os.environ, HOME=str(home), CLAUDE_CONFIG_DIR=str(home / ".claude"),
               FLEETVIEW_CONFIG=str(home / "config.json"))
    return subprocess.run([sys.executable, str(HERE / "install.py")] + args, env=env, capture_output=True,
                          text=True, cwd=str(HERE), timeout=300)


def test_uninstall_switches_the_launchagent_off_before_removing_it(tmp_path):
    home = tmp_path / "home"
    (home / ".claude" / "projects").mkdir(parents=True)
    sb = tmp_path / "Second Brain"
    sb.mkdir()
    plist = home / "Library" / "LaunchAgents" / (LABEL + ".plist")
    try:
        r = install(["--yes", "--skip-npm", "--second-brain", str(sb), "--crm", "-", "--port", "3016",
                     "--launcher", "--no-start"], home)
        assert r.returncode == 0, r.stdout + r.stderr
        assert plist.exists(), r.stdout
        load = launchctl("load", "-w", str(plist))
        assert launchctl("list", LABEL).returncode == 0, "the LaunchAgent did not load: " + load.stdout + load.stderr
        u = install(["--uninstall"], home)
        assert u.returncode == 0, u.stdout + u.stderr
        assert not plist.exists(), u.stdout
        assert "First run:" not in u.stdout, "it still tells the member to type a line whose file it then deletes:\n" + u.stdout
        assert launchctl("list", LABEL).returncode != 0, "the job is still loaded in launchd after the uninstall:\n" + u.stdout
    finally:
        launchctl("remove", LABEL)
