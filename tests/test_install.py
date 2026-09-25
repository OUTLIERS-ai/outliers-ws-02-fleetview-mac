"""Installer tests. Every run uses a temp home, temp APPDATA and temp config file,
so nothing touches the real ~/.claude, Startup folder or this folder's config.json."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
INSTALL = HERE / "install.py"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def env_for(tmp_path, **extra):
    home = tmp_path / "home"
    (home / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(tmp_path / "appdata"),
        "CLAUDE_CONFIG_DIR": str(home / ".claude"),
        "FLEETVIEW_CONFIG": str(tmp_path / "config.json"),
    })
    env.update(extra)
    return env


def run(args, env):
    return subprocess.run([sys.executable, str(INSTALL)] + args, env=env, capture_output=True, text=True,
                          creationflags=NO_WINDOW, cwd=str(HERE))


def base_args(tmp_path):
    sb = tmp_path / "vaults" / "Second Brain"
    crm = tmp_path / "vaults" / "CRM"
    ce = tmp_path / "vaults" / "Content Engine"
    for p in (sb, crm, ce):
        p.mkdir(parents=True, exist_ok=True)
    return ["--yes", "--skip-npm", "--second-brain", str(sb), "--crm", str(crm),
            "--folder", "Content Engine=%s" % ce, "--port", "3011"]


def test_writes_config_with_member_folders(tmp_path):
    env = env_for(tmp_path)
    r = run(base_args(tmp_path) + ["--no-launcher"], env)
    assert r.returncode == 0, r.stdout + r.stderr
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert cfg["port"] == 3011
    assert cfg["host"] == "127.0.0.1"
    assert [f["name"] for f in cfg["folders"]] == ["Second Brain", "CRM", "Content Engine"]
    assert cfg["usage"]["enabled"] is True
    assert "config.json created" in r.stdout


def test_second_run_changes_nothing(tmp_path):
    env = env_for(tmp_path)
    args = base_args(tmp_path) + (["--launcher"] if sys.platform in ("win32", "darwin") else ["--no-launcher"])
    assert run(args, env).returncode == 0
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    r = run(args, env)
    assert r.returncode == 0
    assert "config.json unchanged" in r.stdout
    after = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert before == after, "second run changed files"
    assert not list(tmp_path.glob("config.json.bak-*"))


def test_changed_answer_backs_up_old_config(tmp_path):
    env = env_for(tmp_path)
    assert run(base_args(tmp_path) + ["--no-launcher"], env).returncode == 0
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = "3012"
    r = run(args + ["--no-launcher"], env)
    assert "config.json updated" in r.stdout
    assert len(list(tmp_path.glob("config.json.bak-*"))) == 1
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))["port"] == 3012


def test_no_ccusage_flag(tmp_path):
    env = env_for(tmp_path)
    assert run(base_args(tmp_path) + ["--no-launcher", "--no-ccusage"], env).returncode == 0
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))["usage"]["enabled"] is False


def test_refuses_politely_without_node(tmp_path):
    env = env_for(tmp_path, PATH=str(tmp_path / "empty-path"))
    r = run(base_args(tmp_path) + ["--no-launcher"], env)
    assert r.returncode == 1
    assert "Node.js" in r.stdout and "Nothing was changed" in r.stdout
    assert not (tmp_path / "config.json").exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Startup-folder launcher")
def test_windows_launcher_is_hidden_and_uninstalls(tmp_path):
    env = env_for(tmp_path)
    assert run(base_args(tmp_path) + ["--launcher"], env).returncode == 0
    vbs = tmp_path / "appdata" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "FleetView.vbs"
    text = vbs.read_bytes().decode("utf-16")
    assert ", 0, False" in text          # 0 = no window, False = do not wait
    assert "watcher.js" in text
    r = run(["--uninstall"], env)
    assert r.returncode == 0
    assert not vbs.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Startup-folder launcher")
def test_uninstall_leaves_a_launcher_it_did_not_make(tmp_path):
    env = env_for(tmp_path)
    startup = tmp_path / "appdata" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    startup.mkdir(parents=True)
    other = startup / "FleetView.vbs"
    other.write_bytes("' somebody else's file\r\n".encode("utf-16"))
    run(["--uninstall"], env)
    assert other.exists()


@pytest.mark.skipif(not (HERE / "node_modules" / "express").is_dir(), reason="run npm install (or install.py) first")
def test_start_hidden_then_stop(tmp_path):
    import socket, time, urllib.request
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = env_for(tmp_path)
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = str(port)
    r = run(args + ["--no-launcher", "--no-ccusage", "--start"], env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "started in the background" in r.stdout
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % port, timeout=5) as resp:
            assert json.loads(resp.read())["folders"] == ["Second Brain", "CRM", "Content Engine"]
    finally:
        r = run(["--stop"], env)
    assert "Stopped FleetView" in r.stdout
    time.sleep(1)
    with pytest.raises(OSError):
        urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % port, timeout=2)


# ---------- faults found in the 2026-09-22 review; each test was written before its fix ----------
import importlib.util
import shutil
import socket
import time
import urllib.request

HAS_LIBS = (HERE / "node_modules" / "express").is_dir()


def load_install():
    spec = importlib.util.spec_from_file_location("fv_install", str(INSTALL))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def answers(port, timeout=1.0):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % port, timeout=timeout) as r:
            return json.loads(r.read())
    except OSError:
        return None


def wait_until(fn, secs=15):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.25)
    return fn()


def alive(pid):
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"], capture_output=True, text=True,
                             creationflags=NO_WINDOW).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_node_minimum_is_22():
    """Node 18 died 2025-04-30 and Node 20 died 2026-04-30 (endoflife.date, read 2026-09-22)."""
    m = load_install()
    assert m.node_version_ok("v18.20.4") is False
    assert m.node_version_ok("v20.19.0") is False
    assert m.node_version_ok("v21.7.3") is False
    assert m.node_version_ok("v22.0.0") is True
    assert m.node_version_ok("v24.21.0") is True
    assert m.node_version_ok("v26.3.0") is True
    assert m.node_version_ok("garbage") is False


def test_python_floor_is_3_11_and_the_installer_checks_it():
    """Python 3.8 died 2024-10-07, 3.9 died 2025-10-31, 3.10 dies 2026-10-31."""
    m = load_install()
    assert m.MIN_PY == (3, 11)
    assert m.python_version_ok((3, 8, 10)) is False
    assert m.python_version_ok((3, 10, 14)) is False
    assert m.python_version_ok((3, 11, 0)) is True
    assert m.python_version_ok((3, 13, 14)) is True


def test_config_example_is_valid_json():
    cfg = json.loads((HERE / "config.example.json").read_text(encoding="utf-8"))
    assert cfg["port"] == 3010 and cfg["folders"]
    assert cfg["waiting_hours"] == 1, "a wait older than an hour is not a wait any more"
    assert cfg["fresh_minutes"] == 30


DAMAGED_CONFIGS = {
    "byte-order mark": b"\xef\xbb\xbf" + b'{\n  "port": 3011,\n  "folders": []\n}\n',
    "a comma after the last item": b'{\n  "port": 3011,\n  "folders": [],\n}\n',
    "a // comment": b'{\n  // my folders\n  "port": 3011,\n  "folders": []\n}\n',
    "half written": b'{\n  "port": 3011,\n  "folders": [{ "name": "CRM",\n',
    "not UTF-8": b'{\n  "port": 3011,\n  "folders": [{ "name": "CR\xff\xfe\x9dM" }]\n}\n',
    "empty": b"",
}


@pytest.mark.parametrize("what", list(DAMAGED_CONFIGS))
def test_start_refuses_a_damaged_config_and_names_the_line(tmp_path, what):
    """It used to start anyway: every folder name gone, the port back to 3010, nothing said."""
    env = env_for(tmp_path)
    cfg = tmp_path / "config.json"
    cfg.write_bytes(DAMAGED_CONFIGS[what])
    before = cfg.read_bytes()
    r = run(["--start"], env)
    assert r.returncode == 1, what + ": it must refuse\n" + r.stdout
    assert "config.json" in r.stdout, what
    assert "line" in r.stdout.lower(), what + ": the refusal must name the line\n" + r.stdout
    assert "was NOT started" in r.stdout or "not started" in r.stdout.lower(), r.stdout
    assert cfg.read_bytes() == before, what + ": your file must not be touched"


def test_json_fault_is_said_in_plain_words():
    m = load_install()
    problem = m.config_problem(b'{\n  "port": 3011,\n  "folders": [],\n}\n')
    assert problem is not None
    assert problem["line"] == 3, "the line named is the one carrying the comma"
    assert "comma after the last item" in problem["message"]
    half = m.config_problem(b'{\n  "port": 3011,\n  "folders": [{ "name": "CRM",\n')
    assert "stops in the middle" in half["message"]
    bom = m.config_problem(b"\xef\xbb\xbf{}")
    assert bom is not None and "byte-order mark" in bom["message"].lower()
    assert m.config_problem(b'{"port": 3010}') is None


def test_the_server_refuses_a_damaged_config_in_the_same_words(tmp_path):
    """Found on 2026-09-23: install.py --start refused a damaged config.json, and the
    logon launcher, npm start and node watcher.js all started anyway on the default port.
    The server refuses too now, and a member must read the same sentences either way."""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed here")
    cfg = tmp_path / "config.json"
    cfg.write_bytes(DAMAGED_CONFIGS["a comma after the last item"])
    env = env_for(tmp_path, FLEETVIEW_NO_CCUSAGE="1")
    env.pop("PORT", None)
    r = subprocess.run([node, str(HERE / "watcher.js")], env=env, capture_output=True, text=True,
                       creationflags=NO_WINDOW, cwd=str(HERE), timeout=30)
    assert r.returncode != 0, "the server must refuse as well:\n" + r.stdout + r.stderr
    said = r.stdout + r.stderr
    assert "localhost:3010" not in said, "it must never fall back to the default port:\n" + said
    m = load_install()
    problem = m.config_problem(DAMAGED_CONFIGS["a comma after the last item"])
    assert problem["message"] in said, "the server says what install.py --start says:\n" + said
    assert "was NOT started" in said, said


def test_stop_never_kills_an_unrelated_process(tmp_path):
    env = env_for(tmp_path)
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=NO_WINDOW)
    try:
        # A stale record: FleetView ended long ago and Windows gave its number to another program.
        (tmp_path / "fleetview.pid").write_text(json.dumps({"pid": other.pid, "port": free_port()}), encoding="utf-8")
        run(["--stop"], env)
        assert alive(other.pid), "--stop killed a program that is not FleetView"
        (tmp_path / "fleetview.pid").write_text(str(other.pid), encoding="utf-8")  # the old plain-number format
        run(["--uninstall"], env)
        assert alive(other.pid), "--uninstall killed a program that is not FleetView"
    finally:
        other.kill()


def start_like_logon(tmp_path, port):
    """Start FleetView the way the logon file does: node watcher.js, not through the installer."""
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"port": port, "usage": {"enabled": False},
                               "projects_dir": str(tmp_path / "home" / ".claude" / "projects")}), encoding="utf-8")
    env = env_for(tmp_path)
    env.pop("PORT", None)
    node = shutil_which("node")
    proc = subprocess.Popen([node, str(HERE / "watcher.js")], env=env, cwd=str(HERE), creationflags=NO_WINDOW,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    assert wait_until(lambda: answers(port)), "FleetView did not start"
    return proc, env


def shutil_which(name):
    import shutil
    return shutil.which(name)


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
def test_stop_finds_a_copy_started_at_logon(tmp_path):
    port = free_port()
    proc, env = start_like_logon(tmp_path, port)
    try:
        r = run(["--stop"], env)
        assert "Stopped FleetView" in r.stdout, r.stdout
        assert wait_until(lambda: answers(port) is None, 10)
    finally:
        proc.kill()


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
def test_uninstall_stops_a_copy_started_at_logon(tmp_path):
    port = free_port()
    proc, env = start_like_logon(tmp_path, port)
    try:
        r = run(["--uninstall"], env)
        assert "Stopped FleetView" in r.stdout, r.stdout
        assert wait_until(lambda: answers(port) is None, 10)
    finally:
        proc.kill()


def test_start_without_an_install_says_what_to_do(tmp_path):
    r = run(["--start"], env_for(tmp_path))
    assert r.returncode == 1
    assert ("python3 install.py" if sys.platform == "darwin" else "python install.py") in r.stdout
    assert not (tmp_path / "config.json").exists()


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
def test_start_only_starts_and_asks_nothing(tmp_path):
    port = free_port()
    env = env_for(tmp_path)
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = str(port)
    assert run(args + ["--no-launcher", "--no-ccusage", "--no-start"], env).returncode == 0
    before = (tmp_path / "config.json").read_bytes()
    r = subprocess.run([sys.executable, str(INSTALL), "--start"], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, cwd=str(HERE))
    try:
        assert "Where is your" not in r.stdout, "--start asked the install questions again"
        assert "started" in r.stdout.lower(), r.stdout
        assert answers(port)
        assert (tmp_path / "config.json").read_bytes() == before
        r2 = run(["--start"], env)
        assert "already running" in r2.stdout
    finally:
        run(["--stop"], env)


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
def test_changing_the_port_stops_the_old_copy(tmp_path):
    p1, p2 = free_port(), free_port()
    env = env_for(tmp_path)
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = str(p1)
    assert run(args + ["--no-launcher", "--no-ccusage", "--start"], env).returncode == 0
    try:
        assert answers(p1)
        args[args.index("--port") + 1] = str(p2)
        r = run(args + ["--no-launcher", "--no-ccusage", "--start"], env)
        assert r.returncode == 0, r.stdout
        assert wait_until(lambda: answers(p1) is None, 10), "the old copy on the old port is still running"
        assert answers(p2)
    finally:
        run(["--stop"], env)
        time.sleep(0.5)
    assert answers(p1) is None and answers(p2) is None


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
def test_rerun_while_running_says_it_is_running(tmp_path):
    port = free_port()
    env = env_for(tmp_path)
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = str(port)
    assert run(args + ["--no-launcher", "--no-ccusage", "--start"], env).returncode == 0
    try:
        r = run(args + ["--no-launcher", "--no-ccusage"], env)
        assert "already running" in r.stdout
        assert "node watcher.js" not in r.stdout
    finally:
        run(["--stop"], env)


# ---------- faults found in the 2026-09-24 final check; each test was written before its fix ----------

def _old_python_module(monkeypatch, tmp_path):
    monkeypatch.setenv("FLEETVIEW_CONFIG", str(tmp_path / "config.json"))
    m = load_install()

    class OldPython:                      # the real sys module, except that it says 3.10.14
        version_info = (3, 10, 14, "final", 0)
        def __getattr__(self, name):
            return getattr(sys, name)
    monkeypatch.setattr(m, "sys", OldPython())
    def must_not_run():
        raise AssertionError("the installer went on past an old Python")
    monkeypatch.setattr(m, "check_node", must_not_run)
    return m


def test_install_refuses_python_3_10(tmp_path, monkeypatch, capsys):
    """The guide, README and before-you-start.png say the installer refuses Python older than 3.11.
    Until 2026-09-24 check_python() existed but nothing called it."""
    m = _old_python_module(monkeypatch, tmp_path)
    assert m.main(["--yes", "--skip-npm", "--no-launcher", "--no-start"]) == 1
    out = capsys.readouterr().out
    assert "Python 3.10" in out and "3.11 or newer" in out
    assert "2026-10-31" in out
    assert not (tmp_path / "config.json").exists(), "an old Python must change nothing"


def test_start_refuses_python_3_10(tmp_path, monkeypatch, capsys):
    m = _old_python_module(monkeypatch, tmp_path)
    (tmp_path / "config.json").write_text('{"port": 3999}', encoding="utf-8")
    assert m.main(["--start"]) == 1
    assert "3.11 or newer" in capsys.readouterr().out


def test_stop_and_uninstall_still_work_on_an_old_python(tmp_path, monkeypatch, capsys):
    """Someone on an old Python must still be able to stop and remove FleetView."""
    m = _old_python_module(monkeypatch, tmp_path)
    assert m.main(["--stop"]) == 0
    assert "3.11 or newer" not in capsys.readouterr().out


def _copy_of_the_folder(dst):
    shutil.copytree(HERE, dst, ignore=shutil.ignore_patterns(
        ".git", "guide", "_superseded", "__pycache__", ".pytest_cache", "config.json", "fleetview.pid",
        "fleetview.log", "config.json.bak-*"))
    return dst


def _run_in(folder, args, env):
    return subprocess.run([sys.executable, str(folder / "install.py")] + args, env=env, capture_output=True,
                          text=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, cwd=str(folder), timeout=120)


@pytest.mark.skipif(not HAS_LIBS, reason="run npm install (or install.py) first")
@pytest.mark.skipif(sys.platform != "win32", reason="Windows Startup-folder file")
def test_the_safe_way_never_touches_the_everyday_fleetview(tmp_path):
    """GUIDE.md "The safe way": copy the folder, change the copy. Until 2026-09-24 the copy carried the
    everyday FleetView's fleetview.pid, so  python install.py --stop  in the copy stopped the everyday
    one, and  --launcher / --uninstall  in the copy replaced or removed its Startup file."""
    real_port, copy_port = free_port(), free_port()
    # the everyday FleetView: installed with the Startup file, running on its own port
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    real_env = env_for(tmp_path, FLEETVIEW_CONFIG=str(real_dir / "config.json"))
    args = base_args(tmp_path)
    args[args.index("--port") + 1] = str(real_port)
    r = run(args + ["--launcher", "--no-ccusage", "--start"], real_env)
    assert r.returncode == 0 and answers(real_port), r.stdout
    real_pid = answers(real_port)["pid"]
    vbs = tmp_path / "appdata" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "FleetView.vbs"
    vbs_before = vbs.read_bytes()
    try:
        # the member copies the whole folder, with its config.json and fleetview.pid
        copy = _copy_of_the_folder(tmp_path / "fleetview-test")
        shutil.copy2(real_dir / "config.json", copy / "config.json")
        shutil.copy2(real_dir / "fleetview.pid", copy / "fleetview.pid")
        copy_env = env_for(tmp_path)
        copy_env.pop("FLEETVIEW_CONFIG")

        # a slip: --stop in the copy before anything else
        _run_in(copy, ["--stop"], copy_env)
        assert answers(real_port) and answers(real_port)["pid"] == real_pid, "--stop in the copy stopped the everyday FleetView"

        # --start in the copy while it still has the everyday port: refused, and says why
        r = _run_in(copy, ["--start"], copy_env)
        assert r.returncode == 1 and "config.json" in r.stdout, r.stdout
        assert answers(real_port)["pid"] == real_pid

        # the steps as typed in the guide: change the port, start, stop
        cfg = json.loads((copy / "config.json").read_text(encoding="utf-8"))
        cfg["port"] = copy_port
        (copy / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        r = _run_in(copy, ["--start"], copy_env)
        assert r.returncode == 0 and wait_until(lambda: answers(copy_port)), r.stdout
        assert answers(real_port)["pid"] == real_pid
        r = _run_in(copy, ["--stop"], copy_env)
        assert "Stopped FleetView" in r.stdout, r.stdout
        assert wait_until(lambda: answers(copy_port) is None, 10)
        assert answers(real_port)["pid"] == real_pid, "stopping the copy stopped the everyday FleetView"

        # the installer and --uninstall in the copy leave the everyday Startup file alone
        cargs = base_args(tmp_path)
        cargs[cargs.index("--port") + 1] = str(copy_port)
        r = _run_in(copy, cargs + ["--launcher", "--no-ccusage", "--no-start"], copy_env)
        assert r.returncode == 0, r.stdout
        assert vbs.read_bytes() == vbs_before, "the installer in the copy replaced the everyday Startup file"
        r = _run_in(copy, ["--uninstall"], copy_env)
        assert vbs.exists() and vbs.read_bytes() == vbs_before, "--uninstall in the copy removed the everyday Startup file"
        assert answers(real_port)["pid"] == real_pid
    finally:
        run(["--stop"], real_env)
        wait_until(lambda: answers(real_port) is None, 10)
        _run_in(tmp_path / "fleetview-test", ["--stop"], env_for(tmp_path, FLEETVIEW_CONFIG=str(tmp_path / "fleetview-test" / "config.json"))) if (tmp_path / "fleetview-test").exists() else None
