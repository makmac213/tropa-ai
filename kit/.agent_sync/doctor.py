#!/usr/bin/env python3
"""Check that this project's agent team can run.

  doctor.py            run all checks (exit 1 if anything is broken)

Checks: required tools, AI-IRC health and human-name match, each agent's CLI,
config files, MCP reachability (using the exact URL in its config), first-run
sign-in / folder-trust hints, and what is running in tmux.
"""
import glob, json, os, shutil, subprocess, sys, urllib.request
sys.dont_write_bytecode = True
import config

OK, WARN, FAIL = "✅", "⚠️ ", "❌"
problems = {"fail": 0, "warn": 0}


def install_hint(pkg):
    if sys.platform == "darwin":
        return f"brew install {pkg}"
    for pm, cmd in (("apt-get", "sudo apt-get install -y"), ("dnf", "sudo dnf install -y"), ("pacman", "sudo pacman -S")):
        if shutil.which(pm):
            return f"{cmd} {pkg}"
    return f"install {pkg} with your package manager"


def say(level, msg, fix=None):
    if level == FAIL: problems["fail"] += 1
    if level == WARN: problems["warn"] += 1
    print(f"  {level} {msg}")
    if fix:
        print(f"       → {fix}")


def http(url, body=None, timeout=5):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json, text/event-stream"},
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "null")


def version(cmd):
    try:
        flag = "-V" if cmd == "tmux" else "--version"
        out = subprocess.run([cmd, flag], capture_output=True, text=True, timeout=8, stdin=subprocess.DEVNULL)
        return (out.stdout or out.stderr).strip().splitlines()[0][:60]
    except Exception:
        return "?"


def load_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def mcp_url_for(a, ws):
    t = a["tool"]
    try:
        if t == "claude":
            return load_json(os.path.join(ws, ".mcp.json"))["mcpServers"]["ai-irc"]["url"]
        if t == "opencode":
            return load_json(os.path.join(ws, "opencode.json"))["mcp"]["ai-irc"]["url"]
        if t == "qwen":
            return load_json(os.path.join(ws, ".qwen", "settings.json"))["mcpServers"]["ai-irc"]["httpUrl"]
        if t == "codex":   # passed at launch with -c; nothing on disk to go stale
            return None
    except Exception:
        return None


CONFIG_FILES = {
    "claude": ["AGENT.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json"],
    "opencode": ["AGENT.md", "opencode.json"],
    "qwen": ["AGENT.md", "QWEN.md", ".qwen/settings.json"],
    "codex": ["AGENT.md"],
}
HOME = os.path.expanduser("~")


def signin_hint(tool, ws):
    if tool == "claude":
        cj = load_json(os.path.join(HOME, ".claude.json")) or {}
        if not cj and not os.environ.get("ANTHROPIC_API_KEY"):
            say(WARN, "Claude Code: no ~/.claude.json found (not signed in yet?)", "run `claude` once and sign in")
            return
        proj = (cj.get("projects") or {}).get(ws) or {}
        if not proj.get("hasTrustDialogAccepted"):
            say(WARN, f"Claude Code has not trusted {ws} yet; the first launch will show a trust dialog",
                f"attach to tmux and accept it once (window for this agent), or run `cd {ws} && claude` once")
    elif tool == "opencode":
        if not glob.glob(os.path.join(HOME, ".local/share/opencode/auth.json")):
            say(WARN, "OpenCode: no saved credentials found (~/.local/share/opencode/auth.json)",
                "run `opencode auth login` (skip if you use env-var API keys)")
    elif tool == "codex":
        if not (os.path.exists(os.path.join(HOME, ".codex", "auth.json")) or os.environ.get("OPENAI_API_KEY")):
            say(WARN, "Codex: not signed in (~/.codex/auth.json) and no OPENAI_API_KEY", "run `codex login`")
    elif tool == "qwen":
        has = (glob.glob(os.path.join(HOME, ".qwen/oauth_creds.json"))
               or any(os.environ.get(k) for k in ("DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY")))
        if not has:
            say(WARN, "Qwen Code: no OAuth creds (~/.qwen/oauth_creds.json) or API-key env var found",
                "run `qwen` once and sign in")


def main():
    cfg = config.load()
    root = cfg["root"]
    print(f"\n🩺 Doctor — {cfg['room']}  ({root})\n")

    print("Tools")
    for b in ("tmux", "python3", "curl"):
        say(OK, f"{b}: {version(b)}") if shutil.which(b) else say(FAIL, f"{b} not installed", install_hint(b))
    for b, why in (("docker", "runs AI-IRC in a container"), ("node", "runs AI-IRC without Docker (needs ≥ 22.13)")):
        say(OK, f"{b}: {version(b)}") if shutil.which(b) else say(WARN, f"{b} not installed ({why})")

    print("\nAI-IRC")
    server_ok = False
    try:
        h = http(cfg["server"] + "/health") or {}
        server_ok = True
        if "wake-routing" in (h.get("features") or []):
            say(OK, f"up at {cfg['server']} (AI-IRC {h.get('version', '?')})")
        else:
            say(FAIL, f"{cfg['server']} is an older AI-IRC without wake routing / Team view — agents won't be woken",
                "docker rm -f ai-irc && tropa server up   (or point this project at another port: tropa init -p 8080)")
        st = http(cfg["server"] + "/api/state")
        human = (st or {}).get("human", "")
        if human and human.lower() != cfg["human"].lower():
            say(FAIL, f"settings.human is '{cfg['human']}' but AI-IRC HUMAN_NAME is '{human}'",
                f"python3 .agent_sync/config.py set human '\"{human}\"'  (or restart AI-IRC with HUMAN_NAME={cfg['human']})")
        else:
            say(OK, f"human name matches (@{cfg['human']})")
        rooms = [r.get("id") for r in (st or {}).get("rooms", [])]
        say(OK, f"room {cfg['room']} exists") if cfg["room"] in rooms else \
            say(WARN, f"room {cfg['room']} not created yet (the watcher or first agent will create it)")
    except Exception as e:
        tropa = cfg.get("tropa_home") or "<tropa-ai>"
        say(FAIL, f"not reachable at {cfg['server']} ({e.__class__.__name__})", f"{tropa}/tropa server up")

    print("\nProject")
    docs = cfg["docs_path"]
    say(OK, f"docs folder: {docs}") if os.path.isdir(docs) else say(WARN, f"docs folder missing: {docs}", f"mkdir -p {docs}")
    say(OK, "AGENTS.md present") if os.path.isfile(os.path.join(root, "AGENTS.md")) else \
        say(FAIL, "AGENTS.md missing", "re-run tropa bootstrap on this folder")
    say(OK, f"auto-wake: {cfg['wake']} (rules {cfg['wake_rules']}, history {cfg['history_limit']})")

    agents = []
    for f in sorted(glob.glob(os.path.join(root, "agents", "*", "agent.json"))):
        a = load_json(f)
        if a: agents.append(a)
    names = [a["name"] for a in agents]
    if cfg["lead"] and cfg["lead"] not in names:
        say(FAIL, f"lead '@{cfg['lead']}' has no agent folder", "set a new lead in the panel (8 → 2)")

    windows = []
    try:
        out = subprocess.run(["tmux", "list-windows", "-t", cfg["tmux_session"], "-F", "#{window_name}"],
                             capture_output=True, text=True)
        windows = out.stdout.split() if out.returncode == 0 else []
    except FileNotFoundError:
        pass

    print(f"\nAgents ({len(agents)})")
    if not agents:
        say(WARN, "no agents yet", "run .agent_sync/manage_agents.sh and create one")
    for a in agents:
        name, tool = a["name"], a["tool"]
        ws = os.path.join(root, "agents", name)
        star = " ★lead" if name == cfg["lead"] else ""
        print(f"  @{name}{star}  [{a.get('provider', tool)} · {a.get('model') or 'CLI default'}]")
        if shutil.which(tool):
            say(OK, f"{tool}: {version(tool)}")
        else:
            say(FAIL, f"'{tool}' is not on PATH", f"install {a.get('provider', tool)}")
        missing = [p for p in CONFIG_FILES.get(tool, []) if not os.path.exists(os.path.join(ws, p))]
        if missing:
            say(WARN, f"config files not generated yet: {', '.join(missing)}", f"python3 .agent_sync/setup_agent.py refresh {name}")
            subprocess.run([sys.executable, os.path.join(config.HERE, "setup_agent.py"), "refresh", name],
                           capture_output=True)
        url = mcp_url_for(a, ws)
        expect = f"{cfg['server']}/mcp?agent={name}&project={cfg['project']}"
        if not url and tool == "codex":
            url = f"{cfg['server']}/mcp?agent={name}&project={cfg['project']}"   # what start_agent.sh passes
        if not url:
            say(FAIL, "no ai-irc MCP entry in its config")
        else:
            if url != expect:
                say(WARN, f"MCP URL is stale ({url})", "it is rebuilt on next launch, or run setup_agent.py refresh")
            if server_ok:
                try:
                    r = http(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                   "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                              "clientInfo": {"name": "tropa-doctor", "version": "1"}}})
                    srv = (r or {}).get("result", {}).get("serverInfo", {}).get("name", "?")
                    say(OK, f"MCP reachable ({srv})")
                except Exception as e:
                    say(FAIL, f"MCP initialize failed at {url} ({e})")
        signin_hint(tool, ws)
        say(OK, f"running in tmux window '{name}'") if name in windows else say(WARN, "not running", f".agent_sync/start_agent.sh {name}")

    print("\ntmux")
    if not windows:
        say(WARN, f"session '{cfg['tmux_session']}' is not running", "start agents from the panel (option 3)")
    else:
        say(OK, f"session '{cfg['tmux_session']}': {', '.join(windows)}")
        say(OK, "watcher running") if "watcher" in windows else \
            say(WARN, "watcher not running (agents won't be woken)", "panel option 3 starts it")
        extra = [w for w in windows if w not in names and w not in ("ControlCenter", "watcher")]
        if extra:
            say(WARN, f"windows with no agent folder (the watcher will treat them as agents): {', '.join(extra)}")

    print(f"\n{problems['fail']} problem(s), {problems['warn']} warning(s).\n")
    return 1 if problems["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
