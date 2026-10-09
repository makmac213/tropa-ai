#!/usr/bin/env python3
"""Shared settings for the agent team. Edit settings.json; this fills in defaults.

CLI:  config.py get KEY            print a value (tool_flags.claude style dotted keys work)
      config.py set KEY VALUE      update settings.json (VALUE parsed as JSON if possible)
"""
import json, os, re, sys
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # the project folder this kit lives in
PATH = os.path.join(HERE, "settings.json")

DEFAULTS = {
    "project": "", "human": "", "lead": "", "server": "http://localhost:8888",
    "tmux_session": "ai-team", "tropa_home": "", "wake": "auto", "wake_rules": "smart",
    "max_wakes_per_agent_per_hour": 0, "history_limit": 20,
    "debounce_seconds": 2, "cooldown_seconds": 20, "docs_dir": "docs",
    "tool_flags": {"claude": "--permission-mode auto", "opencode": "", "qwen": "--approval-mode auto-edit",
                   "codex": "--sandbox workspace-write --ask-for-approval on-request"},
    "approval_patterns": [],
    "claude_allow": [],
    "approval_keys": {"claude": {"yes": ["1"], "always": ["2"], "no": ["Escape"]},
                      "qwen": {"yes": ["1"], "always": ["2"], "no": ["Escape"]},
                      "opencode": {"yes": ["Enter"], "always": ["Right", "Enter"], "no": ["Escape"]},
                      "codex": {"yes": ["Enter"], "always": ["Down", "Enter"], "no": ["Escape"]}},
}


def slug(s):
    return re.sub(r"[^a-z0-9._-]+", "-", s.lower()).strip("-") or "project"


def default_human():
    import getpass
    n = os.environ.get("TROPA_HUMAN") or os.environ.get("USER") or getpass.getuser() or "human"
    n = re.sub(r"[^A-Za-z0-9._-]", "", n.split()[0] if n.split() else n)
    return (n[:1].upper() + n[1:]) if n else "human"


def load():
    data = dict(DEFAULTS)
    try:
        with open(PATH) as f:
            data.update(json.load(f))
    except FileNotFoundError:
        pass
    data["tool_flags"] = {**DEFAULTS["tool_flags"], **data.get("tool_flags", {})}
    data["approval_keys"] = {**DEFAULTS["approval_keys"], **data.get("approval_keys", {})}
    if not data["human"]:
        data["human"] = default_human()
    data["project"] = slug(data["project"]) if data["project"] else slug(os.path.basename(ROOT))
    data["room"] = f"project:{data['project']}"
    data["root"] = ROOT
    data["docs_path"] = os.path.join(ROOT, data["docs_dir"])
    data["server"] = data["server"].rstrip("/")
    return data


def save_key(key, value):
    try:
        with open(PATH) as f:
            raw = json.load(f)
    except FileNotFoundError:
        raw = {}
    try:
        value = json.loads(value)
    except (ValueError, TypeError):
        pass
    node = raw
    parts = key.split(".")
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = value
    with open(PATH, "w") as f:
        json.dump(raw, f, indent=2)
        f.write("\n")


def get(key, data=None):
    node = data or load()
    for p in key.split("."):
        node = node.get(p, "") if isinstance(node, dict) else ""
    return node


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "get":
        v = get(sys.argv[2])
        print(json.dumps(v) if isinstance(v, (dict, list)) else v)
    elif len(sys.argv) >= 4 and sys.argv[1] == "set":
        save_key(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
