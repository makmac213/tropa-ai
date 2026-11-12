#!/usr/bin/env python3
"""A Claude agent that works in Claude's cloud (Claude Code on the web) instead of on this computer.

  cloud_agent.py run NAME      (in the agent's tmux window) keep NAME's cloud session in touch with the room
  cloud_agent.py send NAME     message NAME's cloud session (the text comes on stdin; starts the session if needed)
  cloud_agent.py check         is this project ready for cloud agents? (JSON: Claude Code, GitHub remote, branch pushed)

How it works (Claude Code's documented cloud commands, run under your claude.ai login):
  - the first message starts a session on the project's GitHub repo:  claude --cloud "<intro + message>"
  - later messages are queued to it:                                   claude -p --cloud <session> --output-format json
  - a cloud session can't reach this computer, so it can't read the room. It reports back through GitHub instead:
    it pushes to branches named  tropa/<NAME>/<topic>,  and anything it appends to  .tropa/outbox/<NAME>.md  in its
    branch is posted in the room as its message. This script fetches those branches and posts the news.
Its state is kept in agents/NAME/cloud.json; its log in agents/NAME/cloud.log.
"""
import fcntl, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

POLL = 45   # seconds between looks at the agent's branches


def tropa_key(server):
    if os.environ.get("TROPA_SECRET"):
        return os.environ["TROPA_SECRET"].strip()
    port = urllib.parse.urlparse(server).port or 80
    base = os.environ.get("TROPA_STATE") or os.path.join(os.path.expanduser("~"), ".tropa")
    try:
        with open(os.path.join(base, "secret-%d.key" % port)) as f:
            return f.read().strip()
    except OSError:
        return ""


def http(cfg, path, body=None):
    req = urllib.request.Request(cfg["server"] + "/api" + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Tropa-Key": tropa_key(cfg["server"])},
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode() or "null")


def code_root(cfg):
    return cfg.get("code_dir") or cfg["root"]


def ws(cfg, name):
    return os.path.join(cfg["root"], "agents", name)


def load_state(cfg, name):
    try:
        with open(os.path.join(ws(cfg, name), "cloud.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"branches": {}, "outbox": {}}


def save_state(cfg, name, st):
    p = os.path.join(ws(cfg, name), "cloud.json")
    with open(p + ".tmp", "w") as f:
        json.dump(st, f, indent=2)
    os.replace(p + ".tmp", p)


def log(cfg, name, line):
    stamp = time.strftime("%H:%M:%S")
    print(f"{stamp}  {line}", flush=True)
    try:
        with open(os.path.join(ws(cfg, name), "cloud.log"), "a") as f:
            f.write(f"{time.strftime('%F %T')}  {line}\n")
    except OSError:
        pass


def git(cfg, *args, timeout=60):
    r = subprocess.run(["git", "-C", code_root(cfg), *args], capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip() if r.returncode == 0 else ""


def github_slug(cfg):
    url = git(cfg, "remote", "get-url", "origin")
    m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url)
    return f"{m.group(1)}/{m.group(2)}" if m else ""


def agent_json(cfg, name):
    try:
        with open(os.path.join(ws(cfg, name), "agent.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def post(cfg, name, content):
    try:
        http(cfg, f"/rooms/{urllib.parse.quote(cfg['room'], safe='')}/messages", {"agent": name, "content": content[:19000]})
    except Exception as e:
        log(cfg, name, f"couldn't post to the room: {e}")


def say(cfg, content):   # a note from TropaAI's watcher
    try:
        http(cfg, "/watch/say", {"room": cfg["room"], "content": content})
    except Exception:
        pass


def intro(cfg, name):
    a = agent_json(cfg, name)
    base = (git(cfg, "symbolic-ref", "--short", "HEAD") or "main")
    human = cfg.get("human") or "the human"
    job = (a.get("prompt") or a.get("instruction") or "").strip()
    return "\n".join([
        f"You are {name}, a member of the {cfg.get('project')} team on TropaAI. Your role: {a.get('role') or name}.",
        *([f"Your job:\n{job}"] if job else []),
        "",
        "You work in Claude's cloud, so you cannot read the team's chat room. Every message you get here was posted in "
        f"the room for you; it includes everything you need. The lead and {human} are in that room.",
        "",
        "How to report back (the team only sees what you push):",
        f"- Work on a branch named tropa/{name}/<short-topic>, branched from {base}. Commit often and push it.",
        f"- To say something to the team (a plan, a question, \"done\"), append it to the file .tropa/outbox/{name}.md "
        "in your branch, separate messages with a line containing only ---, then commit and push. TropaAI posts each new "
        "message in the room under your name. Mention people with @name as usual.",
        "- When a task is done, open a pull request from your branch and put the PR link in your last outbox message.",
        "- Don't push to other branches, and never force-push.",
    ])


def run_claude(cfg, args, stdin=None, timeout=240):
    try:
        kw = {"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}   # never wait on the terminal
        r = subprocess.run(["claude", *args], cwd=code_root(cfg), capture_output=True, text=True, timeout=timeout, **kw)
    except FileNotFoundError:
        return 127, "Claude Code (the `claude` command) isn't installed on this computer."
    except subprocess.TimeoutExpired:
        return 124, "Claude Code didn't answer in time."
    return r.returncode, (r.stdout or "") + (r.stderr or "")


SESSION = re.compile(r"\b((?:session|cse)_[A-Za-z0-9]{6,})\b")
URL = re.compile(r"https://claude\.ai/code/[^\s\"')]+")


def send(cfg, name, text):
    lock = open(os.path.join(ws(cfg, name), "cloud.lock"), "a")
    fcntl.flock(lock, fcntl.LOCK_EX)   # two messages at once must not start two sessions
    try:
        st = load_state(cfg, name)
        if not st.get("session"):
            code, out = run_claude(cfg, ["--cloud", intro(cfg, name) + "\n\n---\nYour first message:\n\n" + text])
            m_sid, m_url = SESSION.search(out), URL.search(out)
            sid = m_sid.group(1) if m_sid else ""
            url = m_url.group(0) if m_url else ""
            if code != 0 or not (sid or url):
                log(cfg, name, f"couldn't start a cloud session: {out.strip()[-400:]}")
                say(cfg, f"@{cfg.get('human')} `{name}` couldn't start its session in Claude's cloud: {out.strip()[-300:] or 'no answer from Claude Code'}. "
                         "Cloud agents need Claude Code signed in with your claude.ai account (`claude auth login`), the project on GitHub, "
                         "and GitHub connected at claude.ai/code.")
                return False
            st.update({"session": sid or url, "url": url or (f"https://claude.ai/code/{sid}" if sid else ""), "started_at": int(time.time())})
            save_state(cfg, name, st)
            log(cfg, name, f"cloud session started: {st['url']}")
            post(cfg, name, f"I'm working in Claude's cloud: {st['url']}\nI'll report back by pushing to `tropa/{name}/…` branches.")
            return True
        code, out = run_claude(cfg, ["-p", "--cloud", st["session"], "--output-format", "json"], stdin=text, timeout=90)
        ok = code == 0
        try:
            ok = ok and json.loads(out.strip().splitlines()[-1]).get("ok", True)
        except (ValueError, IndexError):
            pass
        if not ok:
            log(cfg, name, f"couldn't message the cloud session: {out.strip()[-400:]}")
            say(cfg, f"@{cfg.get('human')} couldn't reach `{name}`'s cloud session ({out.strip()[-200:] or 'no answer'}). Open it at {st.get('url')}.")
            return False
        log(cfg, name, f"message sent ({len(text)} chars)")
        return True
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def poll(cfg, name, st):
    """Fetch the agent's branches; post new commits and new outbox messages in the room."""
    prefix = f"tropa/{name}/"
    git(cfg, "fetch", "--quiet", "origin", f"+refs/heads/{prefix}*:refs/remotes/origin/{prefix}*", timeout=120)
    refs = git(cfg, "for-each-ref", "--format=%(refname:short) %(objectname)", f"refs/remotes/origin/{prefix}")
    slug = github_slug(cfg)
    base = git(cfg, "symbolic-ref", "--short", "HEAD") or "main"
    changed = False
    for line in refs.splitlines():
        try:
            ref, sha = line.split()
        except ValueError:
            continue
        branch = ref[len("origin/"):]
        last = st["branches"].get(branch)
        if last == sha:
            continue
        # a new branch: only its own commits, not the ones it shares with the base branch
        since = last or (f"origin/{base}" if git(cfg, "rev-parse", "--verify", "--quiet", f"origin/{base}") else "")
        rng = [f"{since}..{sha}"] if since else ["-n5", sha]
        subjects = git(cfg, "log", "--format=%s", *rng).splitlines()
        if subjects:
            link = f"\nCompare: https://github.com/{slug}/compare/{base}...{urllib.parse.quote(branch, safe='/')}" if slug else ""
            post(cfg, name, f"Pushed {len(subjects)} commit{'s' if len(subjects) != 1 else ''} to `{branch}`:\n" +
                 "\n".join(f"- {s}" for s in subjects[:8]) + ("\n- …" if len(subjects) > 8 else "") + link)
        box = git(cfg, "show", f"{sha}:.tropa/outbox/{name}.md")
        seen = st["outbox"].get(branch, 0)
        if box and len(box) > seen:
            for chunk in re.split(r"(?m)^---\s*$", box[seen:]):
                if chunk.strip():
                    post(cfg, name, chunk.strip())
            st["outbox"][branch] = len(box)
        st["branches"][branch] = sha
        changed = True
    if changed:
        save_state(cfg, name, st)
        log(cfg, name, "posted new work from GitHub")


def run(cfg, name):
    a = agent_json(cfg, name)
    try:
        http(cfg, "/agents/register", {"agent": name, "project": cfg.get("project"), "provider": "Claude Code (cloud)",
                                       "model": a.get("model") or "", "description": a.get("role") or ""})
    except Exception as e:
        log(cfg, name, f"couldn't register with the chat server: {e}")
    print(f"{name} works in Claude's cloud.\n   Messages for it go to its cloud session; its pushes to tropa/{name}/… are posted in the room.\n", flush=True)
    while True:
        st = load_state(cfg, name)
        if st.get("url"):
            print(f"   session: {st['url']}", flush=True)
        else:
            print("   no session yet: it starts with the first message for this agent", flush=True)
        try:
            if st.get("session"):
                poll(cfg, name, st)
        except Exception as e:
            log(cfg, name, f"check failed: {e}")
        time.sleep(POLL)


def check(cfg):
    out = {"claude": bool(subprocess.run(["sh", "-c", "command -v claude"], capture_output=True).returncode == 0),
           "repo": git(cfg, "rev-parse", "--is-inside-work-tree") == "true", "github": github_slug(cfg), "pushed": False, "branch": ""}
    if out["repo"]:
        out["branch"] = git(cfg, "symbolic-ref", "--short", "HEAD")
        out["pushed"] = bool(git(cfg, "rev-parse", "--abbrev-ref", "@{u}")) and git(cfg, "rev-list", "--count", "@{u}..HEAD") == "0"
    print(json.dumps(out))


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cfg = config.load()
    cmd = argv[0]
    if cmd == "check":
        return check(cfg)
    if len(argv) < 2 or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", argv[1]):
        sys.exit(__doc__)
    name = argv[1]
    if cmd == "run":
        return run(cfg, name)
    if cmd == "send":
        sys.exit(0 if send(cfg, name, sys.stdin.read()) else 1)
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
