#!/usr/bin/env python3
"""Ready-made teams: one folder of prompts each, in <tropa>/teams/ and ~/.tropa/teams/ (see teams/README.md).

  teams.py list        id · name · members
  teams.py json        catalog as JSON (used by the host helper / chat)
"""
import json, os, re, sys

TROPA_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from design_systems import parse   # the same front matter + body format

ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
TOOLS = {"claude", "codex", "opencode", "qwen", "gemini"}
MAX_MEMBERS, MAX_PROMPT = 12, 6000


def dirs():
    """Where teams come from, later ones replacing earlier ones with the same folder name."""
    state = os.environ.get("TROPA_STATE") or os.path.expanduser("~/.tropa")
    return [os.path.join(TROPA_HOME, "teams"), os.path.join(state, "teams")]


def load(folder):
    """One team folder → dict, or None if it isn't a valid team."""
    meta = parse(os.path.join(folder, "team.md")) if os.path.isfile(os.path.join(folder, "team.md")) else None
    if meta is None:
        return None
    members = {}
    for f in sorted(os.listdir(folder)):
        name = f[:-3]
        if not f.endswith(".md") or f in ("team.md", "README.md") or not NAME_RE.match(name):
            continue
        m = parse(os.path.join(folder, f)) or {"body": open(os.path.join(folder, f), encoding="utf-8").read().strip()}
        tool = (m.get("tool") or "claude").strip().lower()
        members[name] = {"name": name, "role": (m.get("role") or "").strip()[:200], "model": (m.get("model") or "").strip()[:80],
                         "tool": tool if tool in TOOLS else "claude", "prompt": m.get("body", "")[:MAX_PROMPT]}
    if not members:
        return None
    order = [n.strip() for n in (meta.get("members") or "").split(",") if n.strip() in members]
    lead = (meta.get("lead") or "").strip()
    lead = lead if lead in members else (order[0] if order else "")
    rest = sorted((n for n in members if n not in order), key=lambda n: (n != lead, n.lower()))
    names = (order + rest)[:MAX_MEMBERS]
    return {"id": os.path.basename(folder.rstrip(os.sep)), "name": (meta.get("name") or os.path.basename(folder))[:60],
            "summary": (meta.get("summary") or "")[:300], "lead": lead if lead in names else names[0],
            "git": (meta.get("git") or "yes").strip().lower() not in ("no", "false", "off"),   # branches/worktrees: for teams that write code
            "how": meta.get("body", "")[:MAX_PROMPT], "members": [members[n] for n in names]}


def catalog():
    found = {}
    for d in dirs():
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if ID_RE.match(f) and os.path.isdir(p):
                try:
                    t = load(p)
                except (OSError, UnicodeDecodeError):
                    t = None
                if t:
                    found[f] = t   # ~/.tropa/teams/<same name> replaces the built-in one
    return sorted(found.values(), key=lambda t: t["name"].lower())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "json":
        print(json.dumps(catalog(), indent=2))
    elif cmd == "list":
        for t in catalog():
            print(f"{t['id']:22} {t['name']:28} " + ", ".join(("★" if m["name"] == t["lead"] else "") + m["name"] for m in t["members"]))
    else:
        sys.exit(__doc__)
