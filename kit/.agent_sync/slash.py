"""Slash commands an agent's CLI understands, so the human can run them from the chat (/btw, /compact, a skill...).

Each CLI has its own: a few built-ins (curated: ones that print something useful and don't open a menu), plus
the skills and custom commands found in the usual folders for that CLI (the user's own and the project's).
discover(cfg, agent, tool) -> [{"name", "desc", "kind": "builtin" | "skill" | "command"}]
"""
import glob, os, re

BUILTINS = {
    "claude": [("btw", "Ask a quick side question without stopping its work"),
               ("compact", "Summarize the conversation so far to free up memory"),
               ("context", "Show how full its memory (context window) is"),
               ("cost", "Show what this session has cost"),
               ("usage", "Show the plan's usage limits"),
               ("status", "Show its version, model and account"),
               ("review", "Review a pull request"),
               ("init", "Write a CLAUDE.md about the project")],
    "codex": [("compact", "Summarize the conversation so far to free up memory"),
              ("status", "Show its model, limits and token use"),
              ("diff", "Show the git diff, including new files"),
              ("review", "Review the current changes"),
              ("init", "Write an AGENTS.md about the project")],
    "gemini": [("compress", "Summarize the conversation so far to free up memory"),
               ("stats", "Show token use and session stats"),
               ("tools", "List the tools it can use"),
               ("mcp", "List its MCP servers"),
               ("memory", "Show or refresh its memory (/memory show)"),
               ("init", "Write a GEMINI.md about the project")],
    "opencode": [("compact", "Summarize the conversation so far to free up memory"),
                 ("init", "Write an AGENTS.md about the project")],
}
BUILTINS["qwen"] = [(n, d.replace("GEMINI.md", "QWEN.md")) for n, d in BUILTINS["gemini"]]

# never typed in from the chat: they end or reset the session, log out, or open a screen nobody can see
BLOCKED = {"exit", "quit", "q", "logout", "login", "auth", "clear", "new", "reset", "resume", "rewind", "restore",
           "chat", "continue", "model", "models", "config", "settings", "permissions", "theme", "vim", "editor",
           "terminal-setup", "upgrade", "privacy", "ide", "sessions", "export"}

NAME = re.compile(r"^[A-Za-z0-9_.-][A-Za-z0-9_.:-]{0,79}$")


def front(text):
    """(frontmatter fields, body) of a markdown file."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    fields = {}
    for line in (m.group(1) if m else "").splitlines():
        kv = re.match(r"^\s*([A-Za-z0-9_-]+):\s*(.*)$", line)
        if kv:
            fields[kv.group(1).lower()] = kv.group(2).strip().strip("\"'")
    return fields, text[m.end():] if m else text


def first_line(body):
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line
    return ""


def read(path, n=8000):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(n)
    except OSError:
        return ""


def skills_in(d):
    out = []
    for p in sorted(glob.glob(os.path.join(d, "*", "SKILL.md"))):
        fm, body = front(read(p))
        if fm.get("user-invocable", "").lower() == "false":
            continue
        out.append((fm.get("name") or os.path.basename(os.path.dirname(p)), fm.get("description") or first_line(body), "skill"))
    return out


def md_commands_in(d, prefix=""):
    """<d>/**/*.md -> name with subfolders joined by ':' (Claude Code and OpenCode's custom commands)."""
    out = []
    for p in sorted(glob.glob(os.path.join(d, "**", "*.md"), recursive=True)):
        fm, body = front(read(p))
        name = os.path.relpath(p, d)[:-3].replace(os.sep, ":")
        out.append((prefix + name, fm.get("description") or first_line(body), "command"))
    return out


def toml_commands_in(d):
    """<d>/**/*.toml -> Gemini CLI / Qwen Code custom commands."""
    out = []
    for p in sorted(glob.glob(os.path.join(d, "**", "*.toml"), recursive=True)):
        m = re.search(r'^\s*description\s*=\s*(?:"""(.*?)"""|"((?:[^"\\]|\\.)*)"|\'([^\']*)\')', read(p), re.M | re.S)
        desc = next((g for g in (m.groups() if m else ()) if g), "")
        out.append((os.path.relpath(p, d)[:-5].replace(os.sep, ":"), desc.strip(), "command"))
    return out


def discover(cfg, agent, tool):
    home = os.path.expanduser("~")
    root = cfg["root"]
    ws = os.path.join(root, "agents", agent)
    found = [(n, d, "builtin") for n, d in BUILTINS.get(tool, [])]
    if tool == "claude":
        user = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
        for base in (ws, root):
            found += skills_in(os.path.join(base, ".claude", "skills")) + md_commands_in(os.path.join(base, ".claude", "commands"))
        found += skills_in(os.path.join(user, "skills")) + md_commands_in(os.path.join(user, "commands"))
    elif tool in ("gemini", "Qwen"):
        for base in (ws, root, home):
            found += toml_commands_in(os.path.join(base, f".{tool}", "commands"))
    elif tool == "opencode":
        user = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "opencode")
        for d in (os.path.join(root, ".opencode"), user):
            found += md_commands_in(os.path.join(d, "command")) + md_commands_in(os.path.join(d, "commands"))
    elif tool == "codex":
        found += md_commands_in(os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "prompts"), "prompts:")
    out, seen = [], set()
    for name, desc, kind in found:   # the first one wins: the agent's own folder, then the project, then the user's
        if NAME.match(name) and name.lower() not in seen and name.lower() not in BLOCKED:
            seen.add(name.lower())
            out.append({"name": name, "desc": re.sub(r"\s+", " ", desc)[:160], "kind": kind})
        if len(out) >= 200:
            break
    return out
