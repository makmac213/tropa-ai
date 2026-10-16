#!/usr/bin/env python3
"""Check that this project's agent team can run.

  doctor.py            run all checks (exit 1 if anything is broken)

Checks: required tools, TropaAI health and human-name match, each agent's CLI,
config files, MCP reachability (using the exact URL in its config), first-run
sign-in / folder-trust hints, and what is running in tmux.
"""
import glob, json, os, re, shutil, subprocess, sys, urllib.request
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


def git_hint():
    if sys.platform == "darwin":
        return "xcode-select --install   (or: brew install git)"
    return install_hint("git")


def check_git(cfg):
    on = cfg.get("git_workflow", "worktrees") != "off"
    lvl = WARN if on else OK
    try:
        v = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        works = v.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        works = False
    if not works:
        say(lvl, "git isn't installed or isn't working" + (" — the branch/worktree workflow is off until it is" if on else ""), git_hint())
        return
    say(OK, v.stdout.strip())
    root = cfg["root"]
    g = lambda *a: subprocess.run(["git", "-C", root, *a], capture_output=True, text=True)
    if g("rev-parse", "--is-inside-work-tree").returncode != 0:
        say(lvl, "this project isn't a git repository" + (" — agents share one folder instead of branches/worktrees" if on else ""),
            f"git -C {root} init -b main   (then commit your files)")
        return
    if g("rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        say(lvl, "the repository has no commits yet — developer worktrees need one", f"git -C {root} add -A && git -C {root} commit -m 'Initial commit'")
        return
    branch = g("symbolic-ref", "--short", "HEAD").stdout.strip() or "(detached)"
    wts = [l for l in g("worktree", "list", "--porcelain").stdout.splitlines() if l.startswith("worktree ")]
    say(OK, f"repo on `{branch}` · workflow: {cfg.get('git_workflow')} · {max(len(wts) - 1, 0)} developer worktree(s)")


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


def mcp_entry(servers):
    return servers.get("tropa") or servers["ai-irc"]   # "ai-irc" = configs written before the rename


def mcp_url_for(a, ws):
    t = a["tool"]
    try:
        if t == "claude":
            return mcp_entry(load_json(os.path.join(ws, ".mcp.json"))["mcpServers"])["url"]
        if t == "opencode":
            return mcp_entry(load_json(os.path.join(ws, "opencode.json"))["mcp"])["url"]
        if t == "qwen":
            return mcp_entry(load_json(os.path.join(ws, ".qwen", "settings.json"))["mcpServers"])["httpUrl"]
        if t == "gemini":
            return mcp_entry(load_json(os.path.join(ws, ".gemini", "settings.json"))["mcpServers"])["httpUrl"]
        if t == "codex":   # passed at launch with -c; nothing on disk to go stale
            return None
    except Exception:
        return None


CONFIG_FILES = {
    "claude": ["AGENT.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json"],
    "opencode": ["AGENT.md", "opencode.json"],
    "qwen": ["AGENT.md", "QWEN.md", ".qwen/settings.json"],
    "codex": ["AGENT.md"],
    "gemini": ["AGENT.md", "GEMINI.md", ".gemini/settings.json"],
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
    elif tool == "gemini":
        import keys
        cfg = config.load()
        where = keys.get("gemini", cfg["project"])[1]
        if where:
            say(OK, "Gemini: API key from " + {"project": "this project's own key", "env": "$GEMINI_API_KEY", "file": "your global key"}[where])
        elif glob.glob(os.path.join(HOME, ".gemini", "oauth_creds.json")) or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"):
            say(OK, "Gemini: signed in with Google (no API key set)")
        else:
            say(WARN, "Gemini CLI: no API key and no Google sign-in found (~/.gemini/oauth_creds.json)",
                "add a key in the chat (⚙ Settings → API keys, or this project's 🔑 Keys), or run `gemini` once and sign in with Google")


def main():
    cfg = config.load()
    root = cfg["root"]
    print(f"\n🩺 Doctor — {cfg['room']}  ({root})\n")

    print("Tools")
    for b in ("tmux", "python3", "curl"):
        say(OK, f"{b}: {version(b)}") if shutil.which(b) else say(FAIL, f"{b} not installed", install_hint(b))
    for b, why in (("docker", "runs TropaAI in a container"), ("node", "runs TropaAI without Docker (needs ≥ 22.13)")):
        say(OK, f"{b}: {version(b)}") if shutil.which(b) else say(WARN, f"{b} not installed ({why})")

    print("\nGit")
    check_git(cfg)

    print("\nTropaAI")
    server_ok = False
    try:
        h = http(cfg["server"] + "/health") or {}
        server_ok = True
        if "wake-routing" in (h.get("features") or []):
            say(OK, f"up at {cfg['server']} (TropaAI {h.get('version', '?')})")
        else:
            say(FAIL, f"{cfg['server']} is an older AI-IRC without wake routing / Team view — agents won't be woken",
                "docker rm -f ai-irc && tropa server up   (or point this project at another port: tropa init -p 8080)")
        st = http(cfg["server"] + "/api/state")
        human = (st or {}).get("human", "")
        if human and human.lower() != cfg["human"].lower():
            say(FAIL, f"settings.human is '{cfg['human']}' but TropaAI HUMAN_NAME is '{human}'",
                f"python3 .agent_sync/config.py set human '\"{human}\"'  (or restart TropaAI with HUMAN_NAME={cfg['human']})")
        else:
            say(OK, f"human name matches (@{cfg['human']})")
        try:
            tts = http(cfg["server"] + "/api/tts/status", timeout=8) or {}
            if tts.get("available") or tts.get("ok") or tts.get("up"):
                say(OK, f"read aloud: Kokoro voices ready")
            else:
                say(WARN, "read aloud: Kokoro isn't reachable, so the monitor uses your system's voices",
                    f"{cfg.get('tropa_home') or '<tropa-ai>'}/tropa tts start   (then 'tropa tts status'; needs Docker)")
        except Exception:
            pass
        rooms = [r.get("id") for r in (st or {}).get("rooms", [])]
        say(OK, f"room {cfg['room']} exists") if cfg["room"] in rooms else \
            say(WARN, f"room {cfg['room']} not created yet (the watcher or first agent will create it)")
    except Exception as e:
        tropa = cfg.get("tropa_home") or "<tropa-ai>"
        say(FAIL, f"not reachable at {cfg['server']} ({e.__class__.__name__})", f"{tropa}/tropa server up")

    print("\nProject")
    wsl = bool(os.environ.get("WSL_DISTRO_NAME")) or (os.path.exists("/proc/version") and "microsoft" in open("/proc/version").read().lower())
    if wsl:
        if re.match(r"^/mnt/[a-zA-Z]/", root):
            say(WARN, f"WSL: this project is on a Windows drive ({root}); it's slow and file watching is unreliable",
                "move it into your Linux home, e.g. ~/projects")
        else:
            say(OK, f"WSL ({os.environ.get('WSL_DISTRO_NAME', 'Linux')}): project is on the Linux filesystem")
    docs = cfg["docs_path"]
    say(OK, f"docs folder: {docs}") if os.path.isdir(docs) else say(WARN, f"docs folder missing: {docs}", f"mkdir -p {docs}")
    say(OK, "AGENTS.md present") if os.path.isfile(os.path.join(root, "AGENTS.md")) else \
        say(FAIL, "AGENTS.md missing", "re-run tropa bootstrap on this folder")
    say(OK, f"auto-wake: {cfg['wake']} (rules {cfg['wake_rules']}, history {cfg['history_limit']})")
    sk = os.path.join(root, ".agents", "skills")
    names = sorted(d for d in os.listdir(sk) if os.path.isfile(os.path.join(sk, d, "SKILL.md"))) if os.path.isdir(sk) else []
    if names:
        say(OK, f"skills ({len(names)}) in .agents/skills: {', '.join(names)}")
    else:
        say(WARN, "no skills in .agents/skills", "re-run tropa init to add the default skills (or add your own)")
    if cfg.get("guardrails", True) in (False, "false", 0, "0"):
        say(WARN, "guardrails are off", "tropa guardrails on")
    elif os.path.exists(os.path.join(root, ".git")):
        gd = subprocess.run(["git", "-C", root, "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()
        hook = os.path.join(gd if os.path.isabs(gd) else os.path.join(root, gd), "hooks", "pre-commit")
        if os.path.exists(hook) and "tropa:guardrails" in open(hook, errors="replace").read():
            say(OK, "guardrails on: pre-commit secret scan installed")
        else:
            say(WARN, "guardrails on, but the pre-commit secret scan isn't installed (another hook manager?)", "tropa guardrails on")

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
        if str(a.get("model") or "").startswith("ollama/"):
            import ollama_local
            lm, ou = a["model"][len("ollama/"):], ollama_local.url(cfg)
            problem = ollama_local.check(lm, ou)
            if problem:
                say(FAIL, f"local model: {problem}")
            else:
                v = ollama_local.version(ou)
                if tool == "claude" and not ollama_local.at_least(v):
                    say(FAIL, f"Ollama {v} is too old for Claude Code (needs 0.14+ for the Anthropic API)", "update Ollama")
                else:
                    say(OK, f"local model {lm} via Ollama {v} at {ou} (set its context length to 32K+, 64K+ for OpenCode)")
        if str(a.get("model") or "").startswith("openrouter/"):
            import openrouter
            openrouter.PROJECT = cfg["project"]
            problem = openrouter.check(a["model"][len("openrouter/"):])
            if problem:
                say(FAIL, f"OpenRouter: {problem}")
            else:
                src = openrouter.source(cfg["project"])
                say(OK, f"{a['model'][len('openrouter/'):]} via OpenRouter (key: " +
                    {"project": "this project's own key", "env": "$OPENROUTER_API_KEY", "file": "your global key"}.get(src, "?") + ")")
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
            say(FAIL, "no tropa MCP entry in its config", f"python3 .agent_sync/setup_agent.py refresh {name}")
        else:
            if url != expect or "ai-irc" in json.dumps(load_json(os.path.join(ws, ".mcp.json")) or {}):
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
