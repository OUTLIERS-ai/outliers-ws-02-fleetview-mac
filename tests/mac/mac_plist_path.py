"""Mac only (fault row 4, build plan V3): FleetView's Mac login job must let the token panel find npx.

launchd starts a login job with only /usr/bin:/bin:/usr/sbin:/sbin as its program folders. The
token panel runs `npx ccusage`, and npx lives beside Node.js (in /usr/local/bin for nodejs.org's
installer, /opt/homebrew/bin for Homebrew), so under launchd it answered "npx: command not found"
(measured on GitHub's test Macs 2026-09-24). The login job must carry a PATH with Node.js's folder.

Run by name only:  python3 -m pytest -q tests/mac/mac_plist_path.py
"""
import importlib.util
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Mac login job (LaunchAgent)")
NODE = shutil.which("node")


def load_install():
    spec = importlib.util.spec_from_file_location("fv_install_mac", str(HERE / "install.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.skipif(not NODE, reason="needs Node.js")
def test_login_job_names_the_folders_npx_is_in():
    text = load_install().launcher_text(NODE)
    job = plistlib.loads(re.sub(r"<!--.*?-->\n", "", text).encode("utf-8"))
    path = (job.get("EnvironmentVariables") or {}).get("PATH")
    assert path, "the login job sets no PATH, so launchd's /usr/bin:/bin:/usr/sbin:/sbin is all it gets"
    assert str(Path(NODE).parent) == path.split(":")[0], "Node.js's own folder must come first"


@pytest.mark.skipif(not NODE, reason="needs Node.js")
def test_npx_is_found_with_exactly_that_path():
    """The token panel's command runs through /bin/sh with the login job's PATH and nothing else."""
    text = load_install().launcher_text(NODE)
    job = plistlib.loads(re.sub(r"<!--.*?-->\n", "", text).encode("utf-8"))
    path = (job.get("EnvironmentVariables") or {}).get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
    r = subprocess.run(["/usr/bin/env", "-i", "HOME=" + str(Path.home()), "PATH=" + path, "/bin/sh", "-c",
                        "command -v npx && npx --version"], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, "npx not found with the login job's PATH %r: %s" % (path, r.stdout + r.stderr)
