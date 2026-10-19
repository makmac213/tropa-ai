#!/usr/bin/env python3
"""Find an agent's own most recent CLI session, so a restart can resume it.

  last_session.py codex AGENT PROJECT     prints the session id (or nothing)

Sessions are recognised by tropa's startup prompt ("you are '<agent>' … project "<project>""),
which every agent's first message carries.
"""
import glob, json, os, re, sys

def boot_match(text, agent, project):
    a, p = re.escape(agent), re.escape(project)
    return re.search(rf"you are \\?'{a}\\?' on [^.]{{1,40}}\. Call the [\w-]+ register tool with agent \\?\"{a}\\?\", project \\?\"{p}\\?\"", text) is not None


def names_of(agent):
    """The agent's name plus the names it had before a rename (its old sessions carry those)."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(os.path.dirname(here), "agents", agent, "agent.json")) as f:
            return [agent] + [n for n in (json.load(f).get("former_names") or []) if isinstance(n, str)][::-1]
    except (OSError, ValueError):
        return [agent]


def codex(agent, project):
    names = names_of(agent)
    base = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    files = sorted(glob.glob(os.path.join(base, "sessions", "**", "rollout-*.jsonl"), recursive=True),
                   key=lambda f: os.path.getmtime(f), reverse=True)[:400]
    for f in files:
        try:
            with open(f, "rb") as fh:
                head = fh.read(256 * 1024).decode("utf-8", "replace")
        except OSError:
            continue
        if not any(boot_match(head, n, project) for n in names):
            continue
        for line in head.splitlines()[:5]:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            sid = (o.get("payload") or {}).get("id") if o.get("type") == "session_meta" else None
            if sid:
                return sid
        m = re.search(r"rollout-[\dT:-]+-([0-9a-f-]{36})\.jsonl$", f)   # the id is also in the file name
        if m:
            return m.group(1)
    return ""


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "codex":
        print(codex(sys.argv[2], sys.argv[3]))
    else:
        sys.exit(__doc__)
