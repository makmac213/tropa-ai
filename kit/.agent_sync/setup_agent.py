#!/usr/bin/env python3
"""Create or refresh agent workspaces (agents/<name>/) and the shared team roster.

  setup_agent.py create NAME TOOL ROLE INSTRUCTION [MODEL] [--lead]
  setup_agent.py refresh [NAME]     rebuild config files from agent.json (all agents if no name)
  setup_agent.py team               regenerate .agent_sync/TEAM.md
  setup_agent.py remove NAME        stop NAME's tmux window, move agents/NAME/ to agents/.removed/, update TEAM.md
TOOL: claude | opencode | qwen | codex | gemini
"""
import glob, json, os, re, subprocess, sys
import config
import ollama_local

PROVIDERS = {"claude": "Claude Code", "opencode": "OpenCode", "qwen": "Qwen Code", "codex": "Codex", "gemini": "Gemini CLI"}


def dump(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        if isinstance(data, str):
            f.write(data)
        else:
            json.dump(data, f, indent=2); f.write("\n")


def claude_bypass_consent(ws, on):
    """Auto-approve launches Claude with --dangerously-skip-permissions, which shows a one-time
    "Bypass Permissions mode" warning that nobody answers in tmux (Claude exits with code 1).
    Claude skips that warning when skipDangerousModePermissionPrompt is set in local settings,
    so record the consent per agent folder while auto-approve is on, and take it back when it's off."""
    path = os.path.join(ws, ".claude", "settings.local.json")
    try:
        cur = json.load(open(path)) if os.path.exists(path) else {}
    except (OSError, ValueError):
        cur = {}
    if on:
        if cur.get("skipDangerousModePermissionPrompt") is True:
            return
        cur["skipDangerousModePermissionPrompt"] = True
    elif "skipDangerousModePermissionPrompt" in cur:
        del cur["skipDangerousModePermissionPrompt"]
    else:
        return
    dump(path, cur)


def agents_dir(cfg):
    return os.path.join(cfg["root"], "agents")


def all_agents(cfg):
    out = []
    for f in sorted(glob.glob(os.path.join(agents_dir(cfg), "*", "agent.json"))):
        with open(f) as fh:
            out.append(json.load(fh))
    return out


# git commands Claude agents may run without asking (no push / reset / clean)
GIT_ALLOW = [f"Bash(git {c}:*)" for c in ("status", "diff", "log", "show", "add", "commit", "worktree", "branch",
                                          "switch", "checkout", "merge", "rebase", "stash", "fetch", "rev-parse",
                                          "-C", "-c", "init", "mv", "rm --cached", "restore")]


# guardrails: commands Claude agents may never run themselves (the human runs them if needed)
GUARD_DENY = ["Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
              "Bash(git reset --hard:*)", "Bash(git clean:*)", "Bash(git commit --no-verify:*)", "Bash(git commit -n:*)",
              "Bash(sudo:*)", "Bash(rm -rf /:*)", "Bash(rm -rf ~:*)", "Bash(rm -rf $HOME:*)",
              "Bash(ngrok:*)", "Bash(cloudflared:*)", "Bash(lt --port:*)", "Bash(npx localtunnel:*)",
              "Read(**/.env)", "Read(**/.env.local)", "Read(**/.env.production)", "Read(**/.env.*.local)",
              "Read(**/*.pem)", "Read(**/id_rsa)", "Read(**/id_ed25519)"]


def claude_env(cfg):
    """Environment for Claude agents (their .claude/settings.json "env"): settings.claude_env, plus
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 unless claude_feedback_survey is on (nobody is there to answer it)."""
    env = {}
    if cfg.get("claude_feedback_survey") not in (True, "true", 1, "1"):
        env["CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"] = "1"
    extra = cfg.get("claude_env") or {}
    if isinstance(extra, dict):
        env.update({str(k): str(v) for k, v in extra.items() if v is not None})
    return env


def opencode_model(model):
    """OpenCode needs 'provider/model'. A bare id ('nemotron-3-ultra-free') is not an error there: OpenCode
    silently falls back to its last-used or default model. So resolve a bare id against `opencode models`
    (unique suffix match), else assume OpenCode Zen ('opencode/<id>')."""
    m = str(model or "").strip()
    if not m or "/" in m:
        return m
    try:
        exe = next((c for c in [__import__("shutil").which("opencode"), os.path.expanduser("~/.opencode/bin/opencode")]
                    if c and os.path.isfile(c)), None)
        if exe:
            out = subprocess.run([exe, "models"], capture_output=True, text=True, timeout=40, stdin=subprocess.DEVNULL).stdout
            ids = set(re.findall(r"(?<![\w/.-])([a-z0-9][\w.-]*/[\w.:@/-]*[\w])", re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out or "")))
            hits = sorted(i for i in ids if i.split("/")[-1] == m)
            if hits:
                return next((h for h in hits if h.startswith("opencode/")), hits[0])
    except Exception:
        pass
    return "opencode/" + m


def local_model(a):
    """'qwen3-coder:30b' for an agent whose model is 'ollama/qwen3-coder:30b', else ''."""
    m = str(a.get("model") or "")
    return m[len("ollama/"):] if m.startswith("ollama/") else ""


def gemini_key(cfg):
    """True when a Gemini API key applies to this project (its own, $GEMINI_API_KEY or the global one)."""
    try:
        import keys
        return bool(keys.get("gemini", cfg.get("project"))[0])
    except Exception:
        return False


def openrouter_model(a):
    """'qwen/qwen3-coder' for an agent whose model is 'openrouter/qwen/qwen3-coder', else ''."""
    m = str(a.get("model") or "")
    return m[len("openrouter/"):] if m.startswith("openrouter/") else ""


def guardrails_on(cfg):
    return cfg.get("guardrails", True) not in (False, "false", 0, "0")


def git_info(cfg):
    """{'repo': bool, 'base': branch the lead merges into}. Re-read on every launch."""
    root = cfg["root"]
    def git(*args):
        r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else ""
    try:
        if subprocess.run(["git", "--version"], capture_output=True, text=True).returncode != 0:   # e.g. the macOS stub
            return {"repo": False, "base": "main", "commits": False, "nogit": True}
        repo = git("rev-parse", "--is-inside-work-tree") == "true" and os.path.realpath(git("rev-parse", "--show-toplevel")) == os.path.realpath(root)
    except FileNotFoundError:
        return {"repo": False, "base": "main", "commits": False, "nogit": True}
    base = git("symbolic-ref", "--short", "HEAD") or "main" if repo else "main"
    commits = bool(repo and git("rev-parse", "--verify", "-q", "HEAD"))
    return {"repo": repo, "base": base, "commits": commits}


def duty(cfg, a):
    """lead (reviews + merges) · qa (tests) · dev (writes code)."""
    if a["name"] == cfg["lead"]:
        return "lead"
    if re.search(r"\b(qa|test|tests|tester|testing|quality)\b", f"{a['name']} {a.get('role', '')}", re.I):
        return "qa"
    return "dev"


def git_rules(cfg, a, team):
    if cfg.get("git_workflow", "worktrees") == "off":
        return ""
    g = git_info(cfg)
    root, wt, name, human = cfg["root"], cfg.get("worktrees_dir") or ".worktrees", a["name"], cfg["human"]
    devs = [x["name"] for x in team if duty(cfg, x) == "dev"]
    lead = cfg["lead"] or human
    me = duty(cfg, a)
    if g.get("nogit"):
        return f"""
# Git workflow
git isn't installed on this machine, so there are no branches or worktrees. Coordinate who edits which files{" and tell @" + human + " that installing git enables the review → QA → merge workflow" if me == "lead" else " through the lead"}.
"""
    if not g["repo"]:
        return f"""
# Git workflow
This project is not a git repository yet, so there are no branches or worktrees.{f" Several developers ({', '.join('@' + d for d in devs)}) will be editing the same folder: ask @{human} whether to run `git init` first, and coordinate who edits which files." if me == 'lead' and len(devs) > 1 else " Coordinate with the lead about who edits which files."}
"""
    base = g["base"]
    parallel = len(devs) > 1
    commit = f'git -C {"<worktree>" if parallel else root} -c user.name="{name}" -c user.email="{name}@tropa.local" commit -m "..."' 
    where = (f"`{root}/{wt}/{name}-<task>` on branch `{name}/<task>`" if parallel else f"branch `{name}/<task>` in the project root")
    if me == "dev":
        start = (f"`git -C {root} worktree add {wt}/{name}-<task> -b {name}/<task> {base}` — then work only inside `{root}/{wt}/{name}-<task>`"
                 if parallel else f"`git -C {root} switch -c {name}/<task> {base}`")
        return f"""
# Git workflow — you are a developer ({'worktrees: ' + str(len(devs)) + ' developers work in parallel' if parallel else 'single developer: feature branch'})
1. For each task, start a branch from `{base}`: {start}. `<task>` is a short slug like `login-form`.
2. Write, test and commit there, as yourself: `{commit}`. Never commit to `{base}` and never merge it yourself.
3. When it's done and committed, hand off: `@{lead} ready for review: branch {name}/<task>{f" ({wt}/{name}-<task>)" if parallel else ""} — what changed, how to test`.
4. Fix review or QA findings on the same branch, commit, and tell @{lead}.
5. Don't push, force-push, reset or delete branches; the lead merges and cleans up.
"""
    if me == "qa":
        return f"""
# Git workflow — you are QA
- The lead hands you a branch to test{f" with its worktree `{root}/{wt}/<dir>`" if parallel else ""}. Test it there{"" if parallel else f" (`git -C {root} switch <branch>`, then switch back to `{base}` when done)"}; don't change application code.
- Report to @{lead}: `PASS: branch <x>` or `FAIL: branch <x>` with steps to reproduce, and @mention the developer on a FAIL.
- New or updated tests are code too: write them on your own branch (`qa/<task>`{f", worktree `{wt}/{name}-<task>`" if parallel else ""}) and hand them to @{lead} for review like a developer.
- Commit as yourself: `{commit}`. Don't merge or push.
"""
    # lead
    first = "" if g.get("commits") else f"""
**The repository has no commits yet**, and worktrees need one. Before assigning parallel work, ask @{human} to make the first commit, or, with their OK, check `.gitignore` (no secrets, no `node_modules`) and run `git -C {root} add -A && git -C {root} -c user.name="{name}" -c user.email="{name}@tropa.local" commit -m "Initial commit"`.
"""
    return first + f"""
# Git workflow — you review and merge ({'worktrees: ' + str(len(devs)) + ' developers in parallel' if parallel else 'single developer: feature branch'})
The project root `{root}` is the `{base}` checkout; only you change `{base}`.
1. **Assign** each task with a branch name: `@dev task <slug> → branch <dev>/<slug>`.{f" Developers create their own worktrees in `{wt}/`." if parallel else ""}
2. **Review** when a developer says it's ready: `git -C {root} diff {base}...<branch>` (and run it if useful). Ask for changes with an @mention, or approve.
3. **QA**: send approved branches to QA: `@QA please test branch <branch>{f" in {wt}/<dir>" if parallel else ""}`. Wait for PASS.
4. **Merge** after PASS, from the project root on `{base}`: `git -C {root} merge --no-ff <branch>`, then run the tests. On conflicts, resolve small ones yourself or ask the developer to rebase their branch onto `{base}`.
5. **Clean up**: {f"`git -C {root} worktree remove {wt}/<dir>` and " if parallel else ""}`git -C {root} branch -d <branch>`, then post `merged <branch> into {base}`.
- Don't push unless @{human} asks.
"""


# ---------- optional tools (hosted MCP servers: Vercel, Supabase, Render, …) ----------
def tool_catalog():
    try:
        with open(os.path.join(config.HERE, "tools.json")) as f:
            return {t["id"]: t for t in json.load(f).get("tools", [])}
    except (OSError, ValueError):
        return {}


def tools_for(cfg, a):
    """[(catalog entry, url, token_env or '')] for the tools this agent was given."""
    import urllib.parse
    cat, out = tool_catalog(), []
    for t in cfg.get("tools") or []:
        c = cat.get(t.get("id"))
        who = t.get("agents") or "*"
        if not c or not (who == "*" or a["name"] in who):
            continue
        params = {p["key"]: p.get("default", "") for p in c.get("params", [])}
        params.update(t.get("params") or {})
        def fill(m):
            v = params.get(m.group(1), "")
            return "true" if v is True else "false" if v is False else str(v).strip()
        q = {}
        for k, tmpl in (c.get("query") or {}).items():
            val = re.sub(r"\{(\w+)\}", fill, tmpl)
            if val and not (val == "false"):          # drop empty params and false flags
                q[k] = val
        url = c["url"] + ("?" + urllib.parse.urlencode(q, safe=",") if q else "")
        env = c.get("token_env") or ""
        out.append((c, url, env if env and os.environ.get(env) else ""))
    return out


def tool_rules(cfg, a):
    ts = tools_for(cfg, a)
    if not ts:
        return ""
    login = {"claude": "type `/mcp`, pick {id}, then Authenticate", "codex": "run `codex mcp login {id}`",
             "opencode": "run `opencode mcp auth {id}`", "qwen": "type `/mcp` and follow the sign-in for {id}",
             "gemini": "type `/mcp auth {id}`"}[a["tool"]]
    lines = ["", "# Tools you can use",
             "These are optional services this project gave you, as MCP servers (named below). Their calls may ask for approval; that's expected."]
    for c, url, env in ts:
        auth = (f"signed in with the `{env}` token" if env else
                f"sign-in needed once: if a call says it isn't authenticated, ask @{cfg['human']} to {login.format(id=c['id'])} in your tmux window `{a['name']}`")
        lines.append(f"- **{c['name']}** (`{c['id']}`, {auth}): {c.get('summary', '')} {c.get('rules', '').replace('{human}', cfg['human'])}")
    lines.append("- Don't build deploy pipelines or CI/CD unless asked; use these tools to inspect, debug and do what the task needs.")
    return "\n".join(lines) + "\n"


# ---------- skills (.agents/skills is the single source) ----------
def read_skills(cfg):
    """[{name, dir, description, roles}] from <root>/.agents/skills/*/SKILL.md (tiny front-matter parser)."""
    base, out = os.path.join(cfg["root"], ".agents", "skills"), []
    if not os.path.isdir(base):
        return out
    for name in sorted(os.listdir(base)):
        try:
            text = open(os.path.join(base, name, "SKILL.md"), encoding="utf-8").read()
        except OSError:
            continue
        m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
        fm = m.group(1) if m else ""
        def field(key):
            mm = re.search(rf"^\s*{key}:\s*(.+)$", fm, re.M)
            return mm.group(1).strip().strip('"\'') if mm else ""
        roles = [r.strip() for r in field("tropa-roles").split(",") if r.strip()]
        out.append({"name": field("name") or name, "dir": name, "description": field("description"), "roles": roles or ["all"]})
    return out


def skills_for(cfg, a):
    me = duty(cfg, a)
    return [s for s in read_skills(cfg) if "all" in s["roles"] or me in s["roles"]]


def link_skills(cfg, a, ws):
    """Claude Code, Qwen Code and Gemini CLI read skills from their own folders: link this agent's skills there."""
    target = {"claude": os.path.join(ws, ".claude", "skills"), "qwen": os.path.join(ws, ".qwen", "skills"),
              "gemini": os.path.join(ws, ".gemini", "skills")}.get(a["tool"])
    if not target:
        return                                   # Codex and OpenCode read <root>/.agents/skills themselves
    base = os.path.join(cfg["root"], ".agents", "skills")
    os.makedirs(target, exist_ok=True)
    for entry in os.listdir(target):             # drop links we made earlier (keep anything else)
        p = os.path.join(target, entry)
        if os.path.islink(p) and os.path.realpath(p).startswith(os.path.realpath(base) + os.sep):
            os.unlink(p)
    for s in skills_for(cfg, a):
        src, dst = os.path.join(base, s["dir"]), os.path.join(target, s["dir"])
        if os.path.exists(dst):
            continue
        try:
            os.symlink(os.path.relpath(src, target), dst)
        except OSError:
            import shutil
            shutil.copytree(src, dst)


def skill_rules(cfg, a):
    ss = skills_for(cfg, a)
    if not ss:
        return ""
    lines = ["", "# Skills", "Load the matching skill when a task fits it; they hold the team's how-tos:"]
    for s in ss:
        lines.append(f"- `{s['name']}`: {s['description'][:220]}")
    lines.append("Project skills live in `.agents/skills/`; add one there to give it to the team.")
    return "\n".join(lines) + "\n"


def write_team(cfg):
    lead = cfg["lead"]
    rows = all_agents(cfg)
    lead_ = lead
    lines = [
        "# Team roster",
        "_Generated by .agent_sync/setup_agent.py — do not edit by hand._",
        "",
        f"- **Human:** `@{cfg['human']}` (final say on everything)",
        f"- **Lead:** " + (f"`@{lead}`" if lead else f"none — {cfg['human']} assigns work directly"),
        f"- **Room:** `{cfg['room']}` on the TropaAI chat at {cfg['server']} (monitor: open it in a browser)",
        f"- **Project docs/specs:** `{cfg['docs_path']}`",
        f"- **Git:** " + (("off" if cfg.get("git_workflow") == "off" else
                           (lambda g, n: (f"branches off `{g['base']}`; " + (f"each developer works in a worktree in `{cfg.get('worktrees_dir') or '.worktrees'}/`; " if n > 1 else "feature branches; ")
                                          + f"@{lead_ or cfg['human']} reviews, QA tests, @{lead_ or cfg['human']} merges")
                                         if g["repo"] else "not a git repo")(git_info(cfg), sum(1 for x in rows if duty(cfg, x) == "dev")))),
        f"- **Guardrails:** " + ("on: follow the `guardrails` skill (secrets, input/auth, risky commands, dependencies); commits with secrets are blocked" if guardrails_on(cfg) else "off"),
        *([f"- **Design system:** `{cfg['design_system']}`: follow `docs/DESIGN_SYSTEM.md` (skill `design-system`) for all UI work"] if cfg.get("design_system") else []),
        *([f"- **Skills:** " + ", ".join(f"`{s['name']}`" + ("" if "all" in s["roles"] else f" ({'/'.join(s['roles'])})") for s in read_skills(cfg))] if read_skills(cfg) else []),
        *([f"- **Tools:** " + ", ".join(f"{tool_catalog().get(t['id'], {}).get('name', t['id'])} ({'everyone' if (t.get('agents') or '*') == '*' else ', '.join('@' + n for n in t['agents'])})" for t in (cfg.get("tools") or []))] if cfg.get("tools") else []),
        "",
        "| Agent | Lead | Runs in | Model | Role |",
        "|---|---|---|---|---|",
    ]
    for a in rows:
        lines.append(f"| `@{a['name']}` | {'★' if a['name'] == lead else ('QA' if duty(cfg, a) == 'qa' else '')} | {a['provider']} | "
                     f"{a.get('model') or 'CLI default'} | {a.get('role', '')} |")
    if not rows:
        lines.append("| — | | | | |")
    dump(os.path.join(config.HERE, "TEAM.md"), "\n".join(lines) + "\n")


def write_agent(cfg, a):
    name, tool = a["name"], a["tool"]
    ws = os.path.join(agents_dir(cfg), name)
    rules = os.path.join(cfg["root"], "AGENTS.md")
    team = os.path.join(config.HERE, "TEAM.md")
    mcp_url = f"{cfg['server']}/mcp?agent={name}&project={cfg['project']}"
    is_lead = cfg["lead"] == name
    lead_block = f"""
# You are the team lead
- When `@{cfg['human']}` posts without naming an agent, the message comes to you.
- Break the work down and assign each piece by mentioning the agent who owns it (`@name ...`). A mention is an assignment.
- Track progress in the room, unblock agents, and report results or decisions needed back to `@{cfg['human']}`.
""" if is_lead else ""

    dump(os.path.join(ws, "AGENT.md"), f"""# Your identity
- **Agent name:** `{name}` — always pass `agent: "{name}"` to the tropa tools.
- **Role:** {a.get('role', '')}
- **Runs in:** {PROVIDERS[tool]}{f" · model {a['model']}" if a.get('model') else ""}
- **Project room:** `{cfg['room']}`
- **Project folder:** `{cfg['root']}` (docs and specs in `{cfg['docs_path']}`)
- **Where to write:** all project files go under `{cfg['root']}` — use absolute paths. Your own folder `{ws}` only holds your config; never put project code there.
{lead_block}{git_rules(cfg, a, all_agents(cfg))}{tool_rules(cfg, a)}{skill_rules(cfg, a)}
# Initial instruction
{a.get('instruction', '')}

# Team rules
Follow `{rules}` (AGENTS.md) and see the roster in `{team}` (TEAM.md). Read them at startup if they are not already in your context.

# Questions go to the room, never the terminal
Nobody watches your terminal. For a decision or input from `@{cfg['human']}`, use the `ask_human` tool (question, numbered options, your recommendation, what you'll do if there's no answer, and how long to wait). For a teammate, post in the room with `send_message` and @mention them. Then carry on with other work or end your turn; the reply reaches you as a `[tropa]` prompt. Never use your CLI's built-in question/ask-user tool or wait for terminal input.

# When a prompt starting with `[tropa]` arrives
It was typed by the room watcher, not by {cfg['human']}. Read the room. If a message assigns you work, post a one-line plan, keep `set_status` current while you work, and finish with a message that @mentions who is next (result, blocker or done); never end a task silently. If nothing concerns you, stay silent.
""")

    if tool == "claude":
        dump(os.path.join(ws, "CLAUDE.md"), f"@{rules}\n@{team}\n@AGENT.md\n")
        servers = {"tropa": {"type": "http", "url": mcp_url}}
        for c, url, env in tools_for(cfg, a):
            servers[c["id"]] = {"type": "http", "url": url, **({"headers": {"Authorization": f"Bearer ${{{env}}}"}} if env else {})}
        dump(os.path.join(ws, ".mcp.json"), {"mcpServers": servers})
        dump(os.path.join(ws, ".claude", "settings.json"),
             {"enableAllProjectMcpServers": True,
              "permissions": {"allow": ["mcp__tropa", f"Edit(/{cfg['root']}/**)"] + list(cfg.get("claude_allow", []))
                              + (GIT_ALLOW if cfg.get("git_workflow", "worktrees") != "off" else []),
                              "additionalDirectories": [cfg["root"]],
                              "deny": ["AskUserQuestion"] + (GUARD_DENY if guardrails_on(cfg) else [])},   # questions go to the room
              **({"env": claude_env(cfg)} if claude_env(cfg) else {})})
        claude_bypass_consent(ws, cfg.get("auto_approve") in (True, "true", 1, "1"))
    elif tool == "opencode":
        # OpenCode runs from the project folder with OPENCODE_CONFIG pointing here,
        # so it picks up the root AGENTS.md itself and can edit project files.
        dump(os.path.join(ws, "opencode.json"),
             {"$schema": "https://opencode.ai/config.json",
              **({"model": opencode_model(a["model"])} if a.get("model") else {}),   # OpenCode 2.x has no -m flag; the config works in every version
              **({"provider": {"ollama": {"npm": "@ai-sdk/openai-compatible", "name": "Ollama (local)",
                                          "options": {"baseURL": ollama_local.url(cfg) + "/v1"},
                                          "models": {local_model(a): {"name": local_model(a)}}}}} if local_model(a) else {}),
              "instructions": [team, os.path.join(ws, "AGENT.md")],
              "permission": {**({"edit": "allow", "bash": "allow", "webfetch": "allow"} if cfg.get("auto_approve") in (True, "true", 1) else {}),
                             "question": "deny"},   # its ask-the-user dialog only shows in the terminal; questions go to the room
              "mcp": {"tropa": {"type": "remote", "url": mcp_url, "enabled": True},
                      **{c["id"]: {"type": "remote", "url": url, "enabled": True,
                                   **({"headers": {"Authorization": f"Bearer {{env:{env}}}"}} if env else {})}
                         for c, url, env in tools_for(cfg, a)}}})
    elif tool == "qwen":
        dump(os.path.join(ws, "QWEN.md"), f"@{rules}\n@{team}\n@AGENT.md\n")
        dump(os.path.join(ws, ".qwen", "settings.json"),
             {**({"security": {"auth": {"selectedType": "openai"}}, "model": {"name": local_model(a) or openrouter_model(a)}}
                 if local_model(a) or openrouter_model(a) else {}),
              "mcpServers": {"tropa": {"httpUrl": mcp_url, "trust": True},
                             **{c["id"]: {"httpUrl": url, **({"headers": {"Authorization": f"Bearer ${env}"}} if env else {})}
                                for c, url, env in tools_for(cfg, a)}}})
    elif tool == "gemini":
        # Gemini CLI: same layout as Qwen Code (it's where Qwen Code came from). The API key is never written here:
        # start_agent.sh passes it as $GEMINI_API_KEY; with no key, Gemini uses your Google sign-in.
        dump(os.path.join(ws, "GEMINI.md"), f"@{rules}\n@{team}\n@AGENT.md\n")
        dump(os.path.join(ws, ".gemini", "settings.json"),
             {**({"security": {"auth": {"selectedType": "gemini-api-key"}}} if gemini_key(cfg) else {}),
              "mcpServers": {"tropa": {"httpUrl": mcp_url, "trust": True},
                             **{c["id"]: {"httpUrl": url, **({"headers": {"Authorization": f"Bearer ${env}"}} if env else {})}
                                for c, url, env in tools_for(cfg, a)}}})
    link_skills(cfg, a, ws)
    if tool == "codex":
        args = []
        for c, url, env in tools_for(cfg, a):
            args += ["-c", f'mcp_servers.{c["id"]}.url="{url}"']
            if env:
                args += ["-c", f'mcp_servers.{c["id"]}.bearer_token_env_var="{env}"']
        dump(os.path.join(ws, "codex-tools.args"), "".join(x + "\n" for x in args))
    return ws


def remove_agent(cfg, name):
    """End an agent for good: close its tmux window, archive its folder (so restarts don't bring it back), drop it as lead."""
    import shutil, time
    done = []
    session = cfg.get("tmux_session") or ""
    if session:
        have = subprocess.run(["tmux", "list-windows", "-t", f"={session}", "-F", "#{window_name}"],
                              capture_output=True, text=True).stdout.split()
        if name in have:
            subprocess.run(["tmux", "kill-window", "-t", f"={session}:={name}"], capture_output=True)
            done.append(f"stopped its window in `{session}`")
    src = os.path.join(agents_dir(cfg), name)
    if os.path.isdir(src):
        dst = os.path.join(agents_dir(cfg), ".removed", f"{name}-{time.strftime('%Y%m%d-%H%M%S')}")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        done.append(f"moved its folder to `agents/.removed/{os.path.basename(dst)}/`")
    if str(cfg.get("lead") or "").lower() == name.lower():
        config.save_key("lead", '""')
        cfg = config.load()
        done.append("cleared it as lead")
    write_team(cfg)
    for a in all_agents(cfg):
        write_agent(cfg, a)
    return "; ".join(done) if done else "it wasn't running and had no folder here"


def main():
    cfg = config.load()
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args.pop(0)
    if cmd == "create":
        lead = "--lead" in args
        args = [x for x in args if x != "--lead"]
        if len(args) < 4 or args[1] not in PROVIDERS:
            sys.exit(__doc__)
        name, tool, role, instruction = args[:4]
        model = args[4] if len(args) > 4 else ""
        a = {"name": name, "tool": tool, "provider": PROVIDERS[tool], "model": model,
             "role": role, "instruction": instruction}
        dump(os.path.join(agents_dir(cfg), name, "agent.json"), a)
        if lead:
            config.save_key("lead", name)
            cfg = config.load()
        write_team(cfg)
        print(write_agent(cfg, a))
    elif cmd == "refresh":
        write_team(cfg)
        for a in all_agents(cfg):
            if not args or a["name"] in args:
                write_agent(cfg, a)
    elif cmd == "team":
        write_team(cfg)
    elif cmd == "remove":
        if len(args) != 1 or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", args[0]) or args[0].startswith("."):
            sys.exit(__doc__)
        print(remove_agent(cfg, args[0]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
