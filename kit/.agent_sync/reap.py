#!/usr/bin/env python3
"""Stop the processes an agent left behind: dev servers, watchers and the shells around them.

An agent's CLI runs each command in a shell that exits when the command returns, so anything it
starts in the background (`npm run dev &`) is handed to launchd/init and keeps running after the
agent is done, restarted or removed. start_agent.sh tags every agent with TROPA_AGENT=<session>/<name>,
which all its child processes inherit; this finds them by that tag (and by the agent's tmux pane),
plus, for kits from before the tag, orphans whose working folder is inside the agent's (or project's) folder.

CLI:  reap.py agent NAME        stop what agent NAME started (before its window is closed or restarted)
      reap.py session           stop what every agent of this project started (before the team stops)
      reap.py list [--all]      show leftovers: orphans of this project (--all: also ones still owned by a running agent)
      reap.py kill [-y]         stop the leftovers `list` shows (asks first unless -y)
"""
import os, re, signal, subprocess, sys, time
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "TROPA_AGENT"
DARWIN = sys.platform == "darwin"


def processes():
    """{pid: {ppid, cmd, tag}} for this user's processes."""
    out = {}
    uid = os.getuid()
    if os.path.isdir("/proc/self"):
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            pid = int(d)
            try:
                if os.stat(f"/proc/{d}").st_uid != uid:
                    continue
                with open(f"/proc/{d}/stat", "rb") as f:
                    ppid = int(f.read().rsplit(b")", 1)[1].split()[1])
                with open(f"/proc/{d}/cmdline", "rb") as f:
                    cmd = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
                tag = ""
                with open(f"/proc/{d}/environ", "rb") as f:
                    for kv in f.read().split(b"\0"):
                        if kv.startswith(TAG.encode() + b"="):
                            tag = kv.split(b"=", 1)[1].decode(errors="replace")
            except (OSError, ValueError, IndexError):
                continue
            out[pid] = {"ppid": ppid, "cmd": cmd, "tag": tag}
        return out
    # macOS: -E appends each process's starting environment to its command line (own processes only)
    r = subprocess.run(["ps", "-axEww", "-o", "pid=,ppid=,uid=,command="], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not parts[0].isdigit() or parts[2] != str(uid):
            continue
        m = re.search(r"(?:^|\s)" + TAG + r"=(\S+)", parts[3])
        cmd = parts[3][:m.start()].strip() if m else parts[3]
        out[int(parts[0])] = {"ppid": int(parts[1]), "cmd": cmd, "tag": m.group(1) if m else ""}
    return out


def cwds(pids):
    """{pid: working folder} (best effort)."""
    out = {}
    if not pids:
        return out
    if os.path.isdir("/proc/self"):
        for p in pids:
            try:
                out[p] = os.readlink(f"/proc/{p}/cwd")
            except OSError:
                pass
        return out
    r = subprocess.run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", ",".join(map(str, pids))], capture_output=True, text=True)
    pid = None
    for line in r.stdout.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid:
            out[pid] = line[1:]
    return out


def protected(procs):
    """This process and its ancestors (a watcher reaping its own session must survive until it exits)."""
    keep, p = set(), os.getpid()
    while p and p not in keep:
        keep.add(p)
        p = procs.get(p, {}).get("ppid", 0)
    return keep


def descendants(procs, roots):
    kids = {}
    for pid, p in procs.items():
        kids.setdefault(p["ppid"], []).append(pid)
    seen, todo = set(), list(roots)
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        todo.extend(kids.get(p, []))
    return seen


def pane_pids(session, window=None):
    """The processes running in the agents' tmux panes (start_agent.sh); the watcher and your ControlCenter shell are left out."""
    args = ["-t", f"={session}:={window}"] if window else ["-s", "-t", f"={session}"]
    r = subprocess.run(["tmux", "list-panes", *args, "-F", "#{window_name} #{pane_pid}"], capture_output=True, text=True)
    out = []
    for line in r.stdout.splitlines():
        name, _, pid = line.rpartition(" ")
        if pid.isdigit() and name not in ("watcher", "ControlCenter"):
            out.append(int(pid))
    return out


def inside(path, folder):
    path, folder = os.path.realpath(path), os.path.realpath(folder)
    return path == folder or path.startswith(folder + os.sep)


def is_app(cmd):
    """GUI apps (VS Code, browsers…) launched from a project folder are never ours to stop."""
    return ".app/" in cmd or cmd.startswith("/System/")


def find(cfg, agent=None, orphans_only=False):
    """Processes that belong to `agent` (or to any agent of the project), as {pid: proc}."""
    session = cfg["tmux_session"]
    procs = processes()
    keep = protected(procs)
    prefix = f"{session}/{agent}" if agent else f"{session}/"
    hit = set()
    for pid, p in procs.items():
        if p["tag"] and (p["tag"] == prefix if agent else p["tag"].startswith(prefix)):
            hit.add(pid)
    if not orphans_only:
        hit |= descendants(procs, pane_pids(session, agent))
    # kits from before the tag: orphans working inside the agent's folder (or anywhere in the project)
    folder = os.path.join(cfg["root"], "agents", agent) if agent else cfg["root"]
    loose = [pid for pid, p in procs.items() if p["ppid"] == 1 and not p["tag"] and not is_app(p["cmd"])
             and not p["cmd"].split(" ")[0].endswith("tmux")]
    for pid, cwd in cwds(loose).items():
        if inside(cwd, folder):
            hit |= descendants(procs, [pid])
    if orphans_only:   # leftovers only: drop anything still under a live agent's pane
        hit -= descendants(procs, pane_pids(session, agent))
    return {pid: procs[pid] for pid in hit - keep if pid in procs and not procs[pid]["cmd"].split(" ")[0].endswith("tmux")}


def stop(pids, grace=3.0):
    """SIGTERM, then SIGKILL whatever is still there after `grace` seconds. Returns how many were stopped."""
    pids = [p for p in pids if p > 1]
    for p in pids:
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass
    end = time.time() + grace
    alive = pids
    while alive and time.time() < end:
        time.sleep(0.2)
        alive = [p for p in alive if exists(p)]
    for p in alive:
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    return len(pids)


def exists(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:   # a zombie waiting for its parent counts as gone
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return True


def reap(cfg, agent=None, grace=3.0):
    """Stop everything `agent` (or every agent of the project) started; the CLI itself included.
    Never raises: a failed cleanup must not keep a restart or a stop from going ahead."""
    try:
        return _reap(cfg, agent, grace)
    except Exception as e:
        print(f"could not stop {agent or 'the team'}'s leftover processes: {e}", file=sys.stderr)
        return 0


def _reap(cfg, agent, grace):
    found = find(cfg, agent)
    procs = processes()
    def depth(pid, n=0):
        while pid in found and n < 64:
            pid, n = procs.get(pid, {}).get("ppid", 0), n + 1
        return n
    # parents first: start_agent.sh goes before its CLI, so it doesn't report the CLI's exit as a crash
    return stop(sorted(found, key=depth), grace) if found else 0


def main(argv):
    sys.path.insert(0, HERE)
    import config
    cfg = config.load()
    cmd = argv[0] if argv else "list"
    if cmd == "agent" and len(argv) > 1:
        n = reap(cfg, argv[1])
        if n:
            print(f"🧹 stopped {n} process{'es' if n != 1 else ''} left by {argv[1]}")
    elif cmd == "session":
        n = reap(cfg)
        if n:
            print(f"🧹 stopped {n} process{'es' if n != 1 else ''} left by the team")
    elif cmd in ("list", "kill"):
        found = find(cfg, orphans_only="--all" not in argv)
        if not found:
            print("No leftover processes from this project's agents."); return 0
        print(f"{len(found)} leftover process{'es' if len(found) != 1 else ''} from this project's agents:")
        for pid, p in sorted(found.items()):
            print(f"  {pid:>7}  {p['tag'] or '(untagged)':<28} {p['cmd'][:110]}")
        if cmd == "list":
            print("Stop them with: tropa reap --kill"); return 0
        if "-y" not in argv:
            if not sys.stdin.isatty() or input("Stop them? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Left running."); return 0
        print(f"🧹 stopped {stop(list(found))}")
    else:
        print(__doc__.strip()); return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
