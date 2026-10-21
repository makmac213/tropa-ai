#!/usr/bin/env python3
"""TropaAI room watcher: the hands of the team on this machine.

TropaAI decides who to wake (mentions, lead, @all, pause, cooldown, hourly limit; set per
room in settings.json or the monitor's Team view). This watcher:
  - long-polls TropaAI (/api/watch/poll) for wake and command events and types the wake
    prompt into the agent's tmux window;
  - never types into an agent sitting on an approval prompt: it posts the prompt to the room
    once, holds the wake, and delivers it when the prompt clears;
  - clears known CLI pop-ups (feedback surveys and the like) by pressing their keys
    (settings: dismiss_prompts), so wakes aren't typed into them;
  - runs `@watcher approve|always|deny NAME` (from the room or the Team view) by pressing the
    CLI's keys (settings: approval_keys);
  - streams each agent's screen to TropaAI so the monitor can show the whole team working;
  - keeps the routing keys in settings.json and TropaAI in sync (edit either one);
  - copies files shared in the room into the project (docs/attachments/...) and uploads
    files that agents share with the share_file tool;
  - lists the project's docs folder (settings: docs_dir) for the monitor's Docs view, sends a
    file when someone opens it there, and changes the folder when asked from the Docs view.

Manual trigger: touch .agent_sync/chatroom/broadcast.txt, or run wake_all.sh.

  room_watcher.py               run the watcher
  room_watcher.py wake [NAME..] wake the named agents (or all) once and exit
"""
import hashlib, json, os, re, stat, subprocess, sys, time, urllib.parse, urllib.request
sys.dont_write_bytecode = True
import config
import reap

HERE = config.HERE
CHATROOM = os.path.join(HERE, "chatroom")
BROADCAST = os.path.join(CHATROOM, "broadcast.txt")
SYNC = os.path.join(CHATROOM, ".wake_sync.json")
SKIP_WINDOWS = {"ControlCenter", "watcher"}
ROUTING = ["lead", "wake", "wake_rules", "max_wakes_per_agent_per_hour", "auto_approve",
           "cooldown_seconds", "debounce_seconds", "history_limit", "attention"]
PANE_EVERY = 2.0          # seconds between screen captures
PANE_LINES = 60
WORKING_FOR = 6.0         # screen changed within this many seconds -> "working"
SILENT_AFTER = 45.0       # idle this long after working, with an unanswered assignment -> nudge
MAX_NUDGES = 2            # per assignment; then tell the human
BOX = re.compile(r"[│┃║╭╮╰╯─━═┌┐└┘]+")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------- TropaAI ----------
def http(cfg, path, body=None, timeout=10, method=None):
    req = urllib.request.Request(cfg["server"] + "/api" + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"},
                                 method=method or ("POST" if body is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error")
        except Exception:
            msg = None
        raise RuntimeError(msg or f"HTTP {e.code}") from None


def room_q(cfg):
    return urllib.parse.quote(cfg["room"], safe="")


def say(cfg, content):
    try:
        http(cfg, "/watch/say", {"room": cfg["room"], "content": content})
    except Exception as e:
        log(f"could not post to room: {e}")


# ---------- tmux ----------
def agent_windows(cfg):
    try:
        out = subprocess.run(["tmux", "list-windows", "-t", cfg["tmux_session"], "-F", "#{window_name}"],
                             capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    # only the team's agents: a window whose agent was removed (agents/<name>/ archived) or a stray shell
    # window doesn't count, so it never shows in the Team view or graph and is never woken
    return [w for w in out.split() if w and w not in SKIP_WINDOWS
            and os.path.isfile(os.path.join(cfg["root"], "agents", w, "agent.json"))]


def pane_rows(cfg, window):
    out = subprocess.run(["tmux", "capture-pane", "-p", "-J", "-t", f"{cfg['tmux_session']}:{window}"],
                         capture_output=True, text=True).stdout
    return [r.rstrip() for r in out.splitlines()]


OPTION = re.compile(r"^[\s│┃║]*[❯>›▶●○◯◉]?\s*(\d+[.)]|\[[ xX]\])\s+\S")   # "❯ 1. Yes", "2) No", "[ ] Allow"
INPUT_BOX = re.compile(r"^\s*[─━]{20,}")                                           # Claude's idle input box border
PROMPT_TAIL = 5                                                                    # rows allowed after the last option (footers, borders)


def real_prompt(rows, i):
    """A pattern hit only counts if the CLI is waiting on it right now. Rejects:
      - an agent merely writing the words ("push to origin (y/n)?" in its own reply),
      - a prompt that was already answered and is still visible higher up the screen (Qwen/Codex leave it there).
    Accepts: answer options at (or just under) the hit, ending near the bottom of the screen with only a
    footer/box border after them ("Esc to cancel", "╰───╯"), or a bare question on the very last line."""
    below = rows[i + 1:]
    if any(INPUT_BOX.match(r) for r in below):        # Claude draws its idle input box again once a prompt is answered
        return False
    opts = [j for j in range(i, min(len(rows), i + 12)) if OPTION.match(rows[j])]
    if not opts:
        return not below                              # "Overwrite? (y/n)" with nothing after it
    return len(rows) - 1 - opts[-1] <= PROMPT_TAIL     # anything more after the options = output that came later


def approval_in(cfg, rows):
    """(signature, snippet) if these screen rows show an approval prompt, else None."""
    rows = [r for r in rows if r.strip()][-30:]
    pats = [re.compile(p, re.I) for p in cfg.get("approval_patterns", [])]
    for i in range(len(rows) - 1, -1, -1):
        if any(p.search(rows[i]) for p in pats) and real_prompt(rows, i):
            clean = [BOX.sub(" ", r).strip() for r in rows[max(0, i - 8): i + 6]]
            sig = re.sub(r"\s+", " ", re.sub(r"[│┃║╭╮╰╯─━═┌┐└┘❯>]+", " ", rows[i])).strip()
            return sig, "\n".join(r for r in clean if r)[:900]
    return None


def approval_prompt(cfg, window):
    return approval_in(cfg, pane_rows(cfg, window))


DISMISS_ROWS = 12   # pop-ups sit just above the input box, so only the bottom of the screen counts


def dismiss_in(cfg, tool, rows):
    """The dismiss_prompts entry showing at the bottom of this screen (a CLI pop-up to clear), else None."""
    tail = [r for r in rows if r.strip()][-DISMISS_ROWS:]
    for d in cfg.get("dismiss_prompts") or []:
        if not isinstance(d, dict) or d.get("enabled") is False or not d.get("pattern") or not d.get("keys"):
            continue
        if d.get("tool") and str(d["tool"]).lower() != tool:
            continue
        try:
            pat = re.compile(d["pattern"], re.I)
        except re.error:
            continue
        if any(pat.search(r) for r in tail):
            return d
    return None


def type_into(cfg, window, text):
    target = f"{cfg['tmux_session']}:{window}"
    subprocess.run(["tmux", "send-keys", "-t", target, "-l", text], check=False)
    time.sleep(0.4)   # so the TUI doesn't treat Enter as part of a paste
    subprocess.run(["tmux", "send-keys", "-t", target, "Enter"], check=False)


def press(cfg, window, keys):
    for k in keys:
        subprocess.run(["tmux", "send-keys", "-t", f"{cfg['tmux_session']}:{window}", k], check=False)
        time.sleep(0.3)


def agent_tool(cfg, name):
    try:
        with open(os.path.join(cfg["root"], "agents", name, "agent.json")) as f:
            return json.load(f).get("tool", "claude")
    except Exception:
        return "claude"


def approval_alert(cfg, a, snippet):
    return (f"@{cfg['human']} `{a}` is waiting for your approval (tmux window `{a}`, session `{cfg['tmux_session']}`):\n"
            f"```\n{snippet}\n```\n"
            f"Reply `@watcher approve {a}` (yes once), `@watcher always {a}` (yes, don't ask again this session) "
            f"or `@watcher deny {a}` — or use the buttons in the monitor's Team view.")


AUTH_ERR = re.compile(r"Please run /login|OAuth (access )?token (has )?expired|401 .*(authenticat|OAuth)|Invalid API key|Not logged in", re.I)


# Out of credits, a usage limit or a rate limit: the agent sits idle until it resets, someone tops up, or its model
# changes. Every CLI words it differently. Bottom of the screen only, so it clears by itself once the agent works again;
# generic words ("rate limit", "429") only count next to error wording, so an agent *writing about* rate limits doesn't trip it.
LIMIT_KINDS = [
    ("credits", re.compile(r"credit balance is too low|insufficient (credits|balance|funds|quota)|out of credits|requires more credits|"
                           r"\b402\b.{0,40}payment|payment required|exceeded your current quota|check your plan and billing", re.I)),
    ("limit", re.compile(r"usage limit (reached|exceeded|hit)|(claude|codex|gemini|5-hour|weekly|daily|session|opus|sonnet) (usage )?limit (reached|hit|exceeded)|"
                         r"hit your (usage |weekly |daily |session )?limit|limit reached\W.{0,30}reset|quota (exceeded|exhausted)|"
                         r"exhausted your .{0,20}quota|RESOURCE_EXHAUSTED", re.I)),
    ("rate", re.compile(r"rate.?limit|too many requests|\b429\b|overloaded|\b529\b", re.I)),
]
LIMIT_CONTEXT = re.compile(r"error|status|retry|retrying|failed|exceeded|reached|try again|rejected", re.I)
RESETS = re.compile(r"(?:resets?|reset|available again|try again)\s*((?:at|in|on)\s+)?((?:[0-9]|tomorrow|(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)[^.·∙|│\]]{0,40})", re.I)


def resets_text(m):
    """ "in 2 hours 13 minutes", "at 3pm (Asia/Manila)", "Mon 9:00 AM" from a RESETS match."""
    when = re.split(r"\s*\((?:attempt|retry)", m.group(2), maxsplit=1)[0].strip().rstrip(",;:")
    if when.count("(") > when.count(")"):
        when += ")"
    return ((m.group(1) or "").strip() + " " + when).strip()


def limit_in(rows):
    """(kind, line, resets) when the bottom of the screen shows a usage, rate or credit limit, else None.
    kind: "credits" (top up), "limit" (usage limit, waits for its reset) or "rate" (provider throttling, retries by itself)."""
    tail = [BOX.sub(" ", r).strip() for r in rows if r.strip()][-12:]
    for r in reversed(tail):
        for kind, rx in LIMIT_KINDS:
            if rx.search(r) and (kind != "rate" or LIMIT_CONTEXT.search(r)):
                m = RESETS.search(r) or next((x for x in (RESETS.search(t) for t in tail) if x), None)
                return kind, r[:200], (resets_text(m) if m else "")[:60]
    return None


def limit_alert(cfg, a, kind, line, resets):
    h = cfg["human"]
    if kind == "credits":
        return (f"@{h} 💳 `{a}` is out of credits with its AI provider, so it has stopped working. Top up that account, or switch "
                f"`{a}` to another model (**Model** on its card in ▦ Team) or **Clone** it on another model.\n> {line}")
    if kind == "limit":
        return (f"@{h} ⏳ `{a}` reached its usage limit{f', which resets {resets}' if resets else ''}, so it's paused until then. "
                f"To keep going now, switch its model (**Model** on its card in ▦ Team) or **Clone** it on another model.\n> {line}")
    return (f"🐢 `{a}` has been rate-limited by its AI provider for over a minute. It keeps retrying by itself; "
            f"if this keeps happening, switch it to another model.\n> {line}")


def auth_error(rows):
    """The last auth-error line on screen (only if it's still among the bottom rows), else ''."""
    rows = [r for r in rows if r.strip()][-12:]
    for r in reversed(rows):
        if AUTH_ERR.search(r):
            return BOX.sub(" ", r).strip()[:200]
    return ""


# The agent lost its connection to the tropa tool (the chat server restarted or was down for a moment, or the CLI was
# updated underneath it). Claude Code doesn't reconnect by itself; a restart that resumes the conversation does.
MCP_LOST = re.compile(r"\bMCP servers? failed\b|\btropa\b[^\n]{0,80}\b(dropped|disconnected|not connected|failed to connect|unavailable|isn't connected|is down)\b"
                      r"|\b(reconnect|run /mcp)\b[^\n]{0,60}\btropa\b", re.I)


# Claude Code's first-run questions for a folder. Unanswered, they block the agent; Enter alone picks "No", and then it
# runs without the tropa tool. tropa wrote these folders itself, so it answers "Yes" (the 2nd option) unless
# settings.trust_agent_folders is off.
FOLDER_DLG = re.compile(r"Yes, I trust this folder|Yes, allow external imports", re.I)


def folder_dialog(rows):
    tail = [r for r in rows if r.strip()][-14:]
    return any(FOLDER_DLG.search(r) for r in tail) and any(re.search(r"Enter to confirm", r) for r in tail)


# Any other question a CLI waits on in its terminal (a new first-run screen after an update, a menu we don't know):
# never type a wake into it (Enter would pick an answer), and tell the human once.
MENU = re.compile(r"Enter to (confirm|select|continue)|Press Enter to continue|\((y/n|Y/n|y/N)\)\s*\??\s*$|\[(y/N|Y/n)\]", re.I)


# A CLI on its first-run screens (theme, login): it isn't signed in on this computer, or it's a different install
# of the CLI than the one you signed in with.
FIRST_RUN = re.compile(r"Select login method|Choose the text style that looks best|Welcome to Claude Code.*\n.*Let's get started|"
                       r"Sign in with ChatGPT|How would you like to authenticate|Get started with Gemini", re.I)


def first_run(rows):
    return bool(FIRST_RUN.search("\n".join(r.strip() for r in rows[-40:])))


def stuck_menu(rows):
    """The question at the bottom of the screen, if the CLI is waiting on one, else ''."""
    tail = [r for r in rows if r.strip()][-10:]
    if not any(MENU.search(r) for r in tail[-4:]):
        return ""
    return "\n".join(BOX.sub(" ", r).strip() for r in tail)[-700:]


def mcp_lost(rows):
    """True when the bottom of the screen says the tropa connection is gone."""
    text = " ".join(BOX.sub(" ", r).strip() for r in [r for r in rows if r.strip()][-25:])
    return bool(MCP_LOST.search(text))


def auth_alert(cfg, a, line):
    return (f"@{cfg['human']} 🔑 `{a}` can't reach Claude: its login expired or was rejected.\n```\n{line}\n```\n"
            f"Fix now: run `claude` in a normal terminal and type `/login` (one login covers every agent), then wake `{a}`.\n"
            f"Stop it happening again: run `claude setup-token`, then `tropa claude-token set` and restart the Claude agents. "
            f"Agents then use a year-long token instead of a login that expires when several sessions refresh it at once.")


def auto_on(cfg):
    return cfg.get("auto_approve") in (True, "true", 1, "1")


def wake_text(cfg, name, reason):
    return (f"[tropa] {reason} Read your unread messages in {cfg['room']} "
            f"(tropa read_messages, agent \"{name}\", limit {cfg['history_limit']}). "
            f"If it assigns you work: post a one-line plan, do it, and finish with a message that @mentions who is next (result, blocker or done). If it doesn't concern you, stay silent.")


# ---------- files ----------
MAX_FILE = 25 * 1024 * 1024
BLOCKED = re.compile(r"(^|/)(\.git|\.ssh|\.env[^/]*|id_rsa[^/]*|\.npmrc|\.netrc)(/|$)")


def project_file(cfg, rel):
    """Absolute path for a project-relative path; refuses anything outside the project."""
    root = os.path.realpath(cfg["root"])
    p = rel if os.path.isabs(rel) else os.path.join(root, rel)
    p = os.path.realpath(p)
    if p != root and not p.startswith(root + os.sep):
        raise ValueError("path is outside the project folder")
    if BLOCKED.search(os.path.relpath(p, root).replace(os.sep, "/")):
        raise ValueError("that file can't be shared")
    return p


def sync_files(cfg, resp):
    for a in resp.get("files") or []:          # room -> project
        try:
            dest = project_file(cfg, a["path"])
            req = urllib.request.Request(cfg["server"] + a["url"])
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            http(cfg, f"/watch/files/{a['id']}/synced", {})
            log(f"saved {a['path']} ({len(data)} bytes)")
        except Exception as e:
            log(f"could not save {a.get('path')}: {e}")
            try:
                http(cfg, f"/watch/files/{a['id']}/failed", {"error": f"could not save into the project: {e}"})
            except Exception:
                pass
    for a in resp.get("uploads") or []:        # project -> room (agent share_file)
        try:
            src = project_file(cfg, a["path"])
            if not os.path.isfile(src):
                raise ValueError(f"no such file in the project: {a['path']}")
            if os.path.getsize(src) > MAX_FILE:
                raise ValueError("file is larger than 25 MB")
            with open(src, "rb") as f:
                data = f.read()
            req = urllib.request.Request(cfg["server"] + f"/api/watch/files/{a['id']}", data=data, method="PUT",
                                         headers={"Content-Type": "application/octet-stream"})
            urllib.request.urlopen(req, timeout=60).read()
            log(f"uploaded {a['path']} for {a.get('uploader')}")
        except Exception as e:
            log(f"could not upload {a.get('path')}: {e}")
            try:
                http(cfg, f"/watch/files/{a['id']}/failed", {"error": str(e)})
            except Exception:
                pass


# ---------- docs viewer ----------
DOCS_EVERY = 5.0          # seconds between scans of the docs folder
DOCS_REPOST = 30.0        # re-send the list at least this often (e.g. after a server restart)
DOC_LIMIT = 3000
DOC_SKIP = {"node_modules", "__pycache__"}


def docs_rel(cfg):
    return os.path.relpath(cfg["docs_path"], cfg["root"]).replace(os.sep, "/")


def docs_base(cfg):
    """The docs folder's real path; refuses one outside the project (or the project itself)."""
    root = os.path.realpath(cfg["root"])
    base = os.path.realpath(cfg["docs_path"])
    if base == root or not base.startswith(root + os.sep):
        raise ValueError(f"docs_dir ({cfg.get('docs_dir')}) must be a folder inside the project")
    return base


def scan_docs(cfg):
    """(folder, [{path, size, mtime}], error, truncated) for the docs folder. Hidden files and folders,
    node_modules and secrets are left out; paths are relative to the docs folder."""
    rel_dir = docs_rel(cfg)
    try:
        base = docs_base(cfg)
    except ValueError as e:
        return rel_dir, [], str(e), False
    if not os.path.isdir(base):
        return rel_dir, [], f"{rel_dir}/ doesn't exist yet", False
    tree = []
    for cur, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in DOC_SKIP)
        for n in sorted(files):
            if n.startswith("."):
                continue
            p = os.path.join(cur, n)
            rel = os.path.relpath(p, base).replace(os.sep, "/")
            if BLOCKED.search(rel) or not os.path.realpath(p).startswith(base + os.sep):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            tree.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
            if len(tree) >= DOC_LIMIT:
                return rel_dir, tree, "", True
    return rel_dir, tree, "", False


def doc_file(cfg, rel):
    """Absolute path of a file in the docs folder; refuses anything else."""
    base = docs_base(cfg)
    p = os.path.realpath(os.path.join(base, rel))
    if not p.startswith(base + os.sep) or BLOCKED.search(rel) or any(x.startswith(".") for x in rel.split("/")):
        raise ValueError("that file isn't in the docs folder")
    if not os.path.isfile(p):
        raise ValueError(f"no such file: {rel}")
    if os.path.getsize(p) > MAX_FILE:
        raise ValueError("file is larger than 25 MB")
    return p


def clean_docs_dir(d):
    d = str(d or "").strip().replace("\\", "/").rstrip("/")
    if d.startswith("./"):
        d = d[2:]
    parts = d.split("/")
    if not d or d == "." or os.path.isabs(d) or any(x in ("", "..") or x.startswith(".") for x in parts):
        raise ValueError("use a folder inside the project (no .., no hidden folders)")
    return d


# ---------- settings sync (settings.json <-> TropaAI room settings) ----------
def routing(d):
    return {k: d.get(k) for k in ROUTING if k in d}


def read_sync():
    try:
        with open(SYNC) as f:
            return json.load(f)
    except Exception:
        return None


def write_sync(d):
    with open(SYNC, "w") as f:
        json.dump(d, f)


class Watcher:
    def __init__(self):
        self.cfg = config.load()
        self.held = {}          # agent -> wake text waiting for an approval prompt to clear
        self.alerted = {}       # agent -> signature of the prompt we already posted
        self.panes = {}         # agent -> {text, state, prompt, changed_at}
        self.worked = {}        # agent -> time it was last seen working (cleared once checked)
        self.nudges = {}        # agent -> (assignment message id, nudges sent)
        self.auto_pressed = {}  # agent -> prompt signature we already auto-approved once
        self.auth_alerted = {}  # agent -> auth-error line we already posted
        self.limit_alerted = {}  # agent -> the credit/usage/rate limit we already posted ("kind:resets")
        self.limit_since = {}    # agent -> (that limit, when we first saw it)
        self.reconnected = {}   # agent -> time we last restarted it because its tropa connection was lost
        self.dismissed = {}     # agent -> (pop-up pattern, last press time, presses)
        self.model_switch = {}  # agent -> new model, applied once the agent is idle
        self.renames = {}       # agent -> new name, applied once the agent is idle
        self.sent_panes = {}    # agent -> (text, state) last sent
        self.last_pane_post = 0
        self.last_capture = 0
        self.docs_sig = None    # last docs list sent to TropaAI
        self.last_docs = 0      # last scan
        self.last_docs_post = 0
        self.bmtime = self.mtime(BROADCAST)

    @staticmethod
    def mtime(p):
        try:
            return os.stat(p).st_mtime
        except FileNotFoundError:
            return 0

    # -- events from TropaAI --
    def poll(self, agents, timeout):
        local = routing(self.cfg)
        snap = read_sync()
        changed = snap is not None and local != snap
        r = http(self.cfg, "/watch/poll", {"room": self.cfg["room"], "agents": agents,
                                           "tmux_session": self.cfg["tmux_session"],
                                           "settings": local, "settings_changed": changed,
                                           "timeout": timeout, "caps": ["rename_agent", "keys"]}, timeout=timeout + 10)
        server = routing(r.get("settings") or {})
        if changed:
            log(f"pushed settings to TropaAI: {local}")
        elif server != (snap or local) and server != local:
            for k, v in server.items():
                if self.cfg.get(k) != v:
                    config.save_key(k, json.dumps(v))
            log(f"pulled settings from TropaAI: {server}")
            if server.get("lead") != local.get("lead"):
                subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "refresh"], capture_output=True)
            self.cfg = config.load()
        write_sync(server)
        self.last_resp = r
        if r.get("human") and r["human"] != self.cfg["human"] and getattr(self, "human_noted", None) != r["human"]:
            self.human_noted = r["human"]   # once per name, not on every poll
            self.adopt_human(r["human"])
        return r.get("events") or []

    def handle(self, ev, agents):
        by_lower = {a.lower(): a for a in agents}
        a = by_lower.get(str(ev.get("agent", "")).lower())
        if ev.get("type") == "stop":
            log(f"stopping the team: {ev.get('reason', 'asked by TropaAI')} (tmux session {self.cfg['tmux_session']})")
            reap.reap(self.cfg)   # the agents' dev servers and shells, which outlive their tmux windows
            subprocess.run(["tmux", "kill-session", "-t", self.cfg["tmux_session"]], check=False)   # ends this watcher too
            sys.exit(0)
        if ev.get("type") == "set_model":
            if not a:
                say(self.cfg, f"@{self.cfg['human']} no running agent named `{ev.get('agent')}`."); return
            self.model_switch[a] = ev.get("model") or ""
            st = (self.panes.get(a) or {}).get("state")
            if ev.get("when") == "now" or st == "idle":
                self.switch_model(a)
            else:
                say(self.cfg, f"🔁 `{a}` will switch to `{self.model_switch[a] or 'its CLI default'}` as soon as it's idle (so its current step isn't cut off).")
            return
        if ev.get("type") == "rename_agent":
            old, new = str(ev.get("agent", "")), str(ev.get("new_name", ""))
            if not all(re.fullmatch(r"[A-Za-z0-9._-]{1,40}", x) and not x.startswith(".") for x in (old, new)):
                return
            st = (self.panes.get(a or old) or {}).get("state")
            if ev.get("when") == "now" or not a or st in (None, "idle"):
                self.rename(old, new)
            else:
                self.renames[a] = new
                log(f"{a} will become {new} once it's idle")
            return
        if ev.get("type") == "remove_agent":
            name = str(ev.get("agent", ""))
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", name) or name.startswith("."):
                return
            r = subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "remove", name], capture_output=True, text=True)
            for d in (self.held, self.alerted, self.auto_pressed, self.model_switch, self.worked, self.nudges, self.panes,
                      getattr(self, "auth_alerted", {})):
                d.pop(name, None)
            self.cfg = config.load()
            out = r.stdout.strip() or r.stderr.strip()[-300:] or "done"
            log(f"removed {name}: {out}")
            say(self.cfg, f"🗑 Removed @{name}: {out}. TEAM.md is updated." if r.returncode == 0 else f"@{self.cfg['human']} couldn't fully remove `{name}`: {out}")
            return
        if ev.get("type") == "doc_read":
            self.send_doc(ev); return
        if ev.get("type") == "set_docs_dir":
            self.set_docs_dir(ev.get("dir")); return
        if ev.get("type") == "write_plan":
            self.write_plan(ev); return
        if ev.get("type") == "restart":
            self.restart(a or str(ev.get("agent", ""))); return
        if ev.get("type") == "keys":   # the human typing into the agent's terminal from the Team view
            if not a:
                say(self.cfg, f"@{self.cfg['human']} no running agent named `{ev.get('agent')}`; nothing typed."); return
            keys = [k for k in ev.get("keys") or [] if re.fullmatch(r"Enter|Escape|Up|Down|Left|Right|Tab|BTab|Space|BSpace|C-c|[0-9yn]", str(k))]
            text = re.sub(r"[\x00-\x1f\x7f]", "", str(ev.get("text") or ""))[:4000]
            if keys:
                press(self.cfg, a, keys)
            if text:
                if ev.get("enter", True):
                    type_into(self.cfg, a, text)
                else:
                    subprocess.run(["tmux", "send-keys", "-t", f"{self.cfg['tmux_session']}:{a}", "-l", text], check=False)
            log(f"typed into {a}: {' '.join(keys + ([repr(text[:60])] if text else []))}")
            self.alerted.pop(a, None)   # a question it was stuck on may be answered now
            self.last_capture = 0       # show the new screen right away
            return
        if ev.get("type") == "wake":
            if not a:
                return
            self.deliver(a, ev.get("text") or wake_text(self.cfg, a, ev.get("reason", "")), ev.get("reason", ""))
        elif ev.get("type") == "command":
            act = ev.get("action")
            if not a:
                say(self.cfg, f"@{self.cfg['human']} no running agent named `{ev.get('agent')}`.")
                return
            if not approval_prompt(self.cfg, a):
                say(self.cfg, f"@{self.cfg['human']} `{a}` isn't on an approval prompt right now; nothing sent.")
                return
            keys = self.cfg["approval_keys"].get(agent_tool(self.cfg, a), {}).get(act)
            if not keys:
                say(self.cfg, f"@{self.cfg['human']} no `{act}` key mapping for `{a}`'s CLI (settings: approval_keys).")
                return
            press(self.cfg, a, keys)
            log(f"{act} {a}: sent {keys}")
            say(self.cfg, f"{'✅' if act != 'no' else '🚫'} `{a}`: {act} (sent {' '.join(keys)})")
            self.last_capture = 0   # refresh screens soon

    def deliver(self, a, text, reason=""):
        if self.dismiss(a):
            time.sleep(0.8)   # let the CLI redraw
        if dismiss_in(self.cfg, agent_tool(self.cfg, a), pane_rows(self.cfg, a)):
            self.held[a] = text   # still up: deliver once it clears (capture() retries)
            if self.dismissed.get(a, ("", 0, 0))[2] < 4:   # quiet once the human has been told
                log(f"{a} has a pop-up that didn't clear yet; wake held")
            return
        if folder_dialog(pane_rows(self.cfg, a)):   # Claude's "trust this folder?": typing + Enter would answer No
            self.held[a] = text
            log(f"{a} is on Claude's folder question; wake held")
            return
        if first_run(pane_rows(self.cfg, a)) or (not approval_prompt(self.cfg, a) and stuck_menu(pane_rows(self.cfg, a))):   # some other question: don't answer it by accident
            self.held[a] = text
            log(f"{a} is waiting on a question in its terminal; wake held")
            return
        prompt = approval_prompt(self.cfg, a)
        if prompt:
            self.held[a] = text
            if self.alerted.get(a) != prompt[0] and not auto_on(self.cfg):
                say(self.cfg, approval_alert(self.cfg, a, prompt[1]))
                self.alerted[a] = prompt[0]
            log(f"{a} is on an approval prompt; wake held")
            return
        self.held.pop(a, None)
        type_into(self.cfg, a, text)
        log(f"woke {a}: {reason}")

    def dismiss(self, a, rows=None):
        """Clear a known CLI pop-up (settings: dismiss_prompts) by pressing its keys. True if pressed.
        Presses at most every 3 s and 3 times per pop-up; after that it tells the human once."""
        rows = pane_rows(self.cfg, a) if rows is None else rows
        d = dismiss_in(self.cfg, agent_tool(self.cfg, a), rows)
        if not d:
            self.dismissed.pop(a, None)
            return False
        sig, at, n = self.dismissed.get(a, ("", 0, 0))
        same, now = sig == d["pattern"], time.time()
        if same and now - at < 3:
            return False
        if same and n >= 3:
            if n == 3:
                say(self.cfg, f"@{self.cfg['human']} `{a}` is stuck on a pop-up the watcher couldn't clear "
                              f"({d.get('label') or d['pattern']}; settings: dismiss_prompts). Check tmux window `{a}`.")
                self.dismissed[a] = (sig, now, n + 1)
            return False
        keys = [str(k) for k in d["keys"]]
        press(self.cfg, a, keys)
        self.dismissed[a] = (d["pattern"], now, (n if same else 0) + 1)
        log(f"cleared {d.get('label') or d['pattern']} in {a}: sent {' '.join(keys)}")
        return True

    # -- docs viewer --
    def post_docs(self, force=False):
        now = time.time()
        self.last_docs = now
        rel_dir, tree, error, truncated = scan_docs(self.cfg)
        sig = json.dumps([rel_dir, tree, error, truncated])
        if not force and sig == self.docs_sig and now - self.last_docs_post < DOCS_REPOST:
            return
        http(self.cfg, "/watch/docs", {"room": self.cfg["room"], "dir": rel_dir, "tree": tree, "error": error, "truncated": truncated})
        self.docs_sig, self.last_docs_post = sig, now

    def send_doc(self, ev):
        rid, rel = str(ev.get("id", "")), str(ev.get("path", ""))
        try:
            with open(doc_file(self.cfg, rel), "rb") as f:
                data = f.read()
            req = urllib.request.Request(self.cfg["server"] + f"/api/watch/docs/{urllib.parse.quote(rid)}", data=data, method="PUT",
                                         headers={"Content-Type": "application/octet-stream"})
            urllib.request.urlopen(req, timeout=60).read()
        except Exception as e:
            log(f"could not send doc {rel}: {e}")
            try:
                http(self.cfg, f"/watch/docs/{urllib.parse.quote(rid)}/failed", {"error": str(e)})
            except Exception:
                pass

    def write_plan(self, ev):
        """Keep <docs>/PLAN.md in step with the task board (settings: auto_plan). A PLAN.md without
        tropa's marker line is the team's own and is left alone."""
        if self.cfg.get("auto_plan", True) in (False, "false", 0):
            return
        content, mark = str(ev.get("content") or ""), str(ev.get("mark") or "")
        try:
            base = docs_base(self.cfg)
        except ValueError:
            return
        p = os.path.join(base, "PLAN.md")
        try:
            with open(p, encoding="utf-8") as f:
                cur = f.read()
            if mark and mark not in cur:
                return                       # written by someone else: theirs
            if cur == content:
                return
        except FileNotFoundError:
            pass
        except OSError as e:
            log(f"could not read PLAN.md: {e}"); return
        try:
            os.makedirs(base, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)
            log(f"updated {docs_rel(self.cfg)}/PLAN.md from the task board")
        except OSError as e:
            log(f"could not write PLAN.md: {e}")

    def set_docs_dir(self, d):
        try:
            d = clean_docs_dir(d)
            root = os.path.realpath(self.cfg["root"])
            full = os.path.realpath(os.path.join(root, d))
            if full == root or not full.startswith(root + os.sep):
                raise ValueError("that folder is outside the project")
            if os.path.exists(full) and not os.path.isdir(full):
                raise ValueError(f"{d} is a file, not a folder")
        except ValueError as e:
            say(self.cfg, f"@{self.cfg['human']} couldn't change the docs folder to `{d}`: {e}")
            return
        os.makedirs(full, exist_ok=True)
        config.save_key("docs_dir", json.dumps(d))
        self.cfg = config.load()
        subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "refresh"], capture_output=True)
        log(f"docs folder is now {d}/")
        say(self.cfg, f"📄 The docs folder is now `{d}/`. Agents started from now on look there; running agents pick it up when they restart.")
        try:
            self.post_docs(force=True)
        except Exception as e:
            log(f"could not send the docs list: {e}")

    def adopt_human(self, name):
        """The human chose what the team calls them in the chat: use it here too (settings, TEAM.md, every AGENT.md)."""
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,29}", name):
            return
        old = self.cfg["human"]
        config.save_key("human", json.dumps(name))
        self.cfg = config.load()
        # roles and jobs written with the old name ("reports to DESKTOP-7Q2X"): @old always, the bare word unless it's
        # the generic "human" (that appears in ordinary sentences)
        pat = re.compile(r"(?<![\w@-])" + (r"@" if old.lower() == "human" else r"@?") + rf"{re.escape(old)}(?![\w-])")
        adir = os.path.join(config.ROOT, "agents")
        for a in os.listdir(adir) if os.path.isdir(adir) else []:
            path = os.path.join(adir, a, "agent.json")
            try:
                with open(path) as f:
                    agent = json.load(f)
            except (OSError, ValueError):
                continue
            new_agent = {k: pat.sub(lambda m: ("@" if m.group(0).startswith("@") else "") + name, v) if k in ("role", "instruction", "prompt") and isinstance(v, str) else v
                         for k, v in agent.items()}
            if new_agent != agent:
                with open(path, "w") as f:
                    json.dump(new_agent, f, indent=2)
        r = subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "refresh"], capture_output=True, text=True)
        log(f"the human is now @{name} (was @{old})" + ("" if r.returncode == 0 else f"; refresh failed: {r.stderr.strip()[-200:]}"))
        say(self.cfg, f"📛 From now on, call the human **@{name}** (not @{old}). Your instructions are updated; mention @{name} for questions and hand-offs.")

    # -- screens --
    def capture(self, agents):
        now = time.time()
        for a in agents:
            rows = pane_rows(self.cfg, a)
            if folder_dialog(rows) and agent_tool(self.cfg, a) == "claude":
                if self.cfg.get("trust_agent_folders", True) not in (False, "false", 0, "0"):
                    press(self.cfg, a, ["Down"]); time.sleep(0.3); press(self.cfg, a, ["Enter"])
                    log(f"{a}: answered Claude's folder question with Yes")
                    self.last_capture = 0
                    continue
                if self.alerted.get(a) != "folder":
                    self.alerted[a] = "folder"
                    say(self.cfg, f"@{self.cfg['human']} `{a}` is waiting on Claude's \"trust this folder\" question in its terminal "
                                  f"(`tmux attach -t {self.cfg['tmux_session']}`). Choose Yes, or it runs without the tropa tool.")
                continue
            if self.dismiss(a, rows):
                self.last_capture = 0   # look again right after it redraws
                continue
            popup = dismiss_in(self.cfg, agent_tool(self.cfg, a), rows) is not None   # one that won't clear: type nothing
            while rows and not rows[-1].strip():
                rows.pop()
            text = "\n".join(rows[-PANE_LINES:])
            prompt = approval_in(self.cfg, rows)
            prev = self.panes.get(a)
            changed_at = now if not prev or prev["text"] != text else prev["changed_at"]
            state = "approval" if prompt else ("working" if now - changed_at < WORKING_FOR and prev else "idle")
            lim = None if prompt else limit_in(rows)
            self.panes[a] = {"text": text, "state": state, "prompt": prompt[0] if prompt else "", "changed_at": changed_at,
                             "limit": {"kind": lim[0], "text": lim[1], "resets": lim[2]} if lim else None}
            # auto-approve: press the CLI's "yes" once per prompt; if the prompt stays, fall back to asking
            sig, at, n = self.auto_pressed.get(a, ("", 0, 0))
            same = prompt and sig == prompt[0]
            # same prompt again after a few seconds = the same command asked twice; give up after 3 tries
            if prompt and auto_on(self.cfg) and (not same or (now - at > 4 and n < 3)):
                keys = self.cfg["approval_keys"].get(agent_tool(self.cfg, a), {}).get("yes")
                if keys:
                    press(self.cfg, a, keys)
                    self.auto_pressed[a] = (prompt[0], now, (n if same else 0) + 1)
                    log(f"auto-approved {a}: {prompt[0][:80]}")
                    what = " · ".join(l.strip() for l in prompt[1].splitlines() if l.strip() and not re.match(r"^[❯>]?\s*\d\.", l.strip()))
                    say(self.cfg, f"⚡ auto-approved `{a}`: {what[:200]}")
                    self.last_capture = 0
                    continue
            if not prompt:
                self.auto_pressed.pop(a, None)
            # out of credits / usage limit / rate-limited: tell the room once (a rate limit only after a minute: CLIs retry those)
            if lim:
                sig = f"{lim[0]}:{lim[2]}"
                first = self.limit_since.setdefault(a, (sig, now))
                if first[0] != sig:
                    self.limit_since[a] = first = (sig, now)
                if self.limit_alerted.get(a) != sig and (lim[0] != "rate" or now - first[1] >= 60):
                    self.limit_alerted[a] = sig
                    say(self.cfg, limit_alert(self.cfg, a, *lim))
                    log(f"{a}: {lim[0]} limit on screen; posted to room")
            else:
                self.limit_since.pop(a, None); self.limit_alerted.pop(a, None)
            bad = auth_error(rows)
            if bad and self.auth_alerted.get(a) != bad:
                say(self.cfg, auth_alert(self.cfg, a, bad))
                self.auth_alerted[a] = bad
                log(f"{a}: auth error on screen; posted to room")
            elif not bad:
                self.auth_alerted.pop(a, None)
            # approvals: alert once per prompt, deliver held wakes once it clears
            if first_run(rows):
                if self.alerted.get(a) != "first_run":
                    self.alerted[a] = "first_run"
                    tool = agent_tool(self.cfg, a)
                    binl = next((r.strip() for r in rows if r.strip().startswith(f"▶ {tool}:")), "")
                    log(f"{a}: {tool} is on its first-run/login screen; posted to room")
                    say(self.cfg, f"@{self.cfg['human']} 🔑 `{a}`'s {tool} isn't signed in on this computer: it's showing its first-run setup "
                                  f"(theme / login){f' — `{binl[2:]}`' if binl else ''}. Run `{tool}` once in a terminal and sign in, then press "
                                  f"Restart on its card. Already signed in? Then the agent runs a different install: check `which -a {tool}` "
                                  f"and remove the old one, then run `tropa start` once from your terminal (agents use its PATH).")
                continue
            menu = "" if prompt or popup else stuck_menu(rows)
            if menu and state == "idle" and self.alerted.get(a) != "menu:" + menu[-120:]:
                self.alerted[a] = "menu:" + menu[-120:]
                log(f"{a} is waiting on a question in its terminal; posted to room")
                say(self.cfg, f"@{self.cfg['human']} `{a}` is waiting on a question in its terminal (often a new screen after a CLI update), "
                              f"so it can't work or read the room:\n```\n{menu}\n```\nAnswer it with `tmux attach -t {self.cfg['tmux_session']}` "
                              f"(window `{a}`), or press Restart on its card.")
            if prompt and self.alerted.get(a) != prompt[0]:
                say(self.cfg, approval_alert(self.cfg, a, prompt[1]))
                self.alerted[a] = prompt[0]
                log(f"{a} is on an approval prompt; posted to room")
            elif not prompt and not menu:
                self.alerted.pop(a, None)
                if a in self.held:
                    self.deliver(a, self.held.pop(a), "held wake")
            if state == "idle" and not prompt and not popup and not menu and mcp_lost(rows) and time.time() - self.reconnected.get(a, 0) > 600:
                self.reconnected[a] = time.time()
                log(f"{a} lost its tropa connection; restarting it (it resumes its conversation)")
                say(self.cfg, f"🔌 `{a}` lost its connection to the chat; restarting it.")
                self.restart(a)
                continue
            if state == "idle" and a in self.model_switch and not popup:
                self.switch_model(a)
            if state == "idle" and a in self.renames and not popup:
                self.rename(a, self.renames.pop(a))
                continue
            if state == "working":
                self.worked[a] = now
            elif state == "idle" and a in self.worked and now - changed_at >= SILENT_AFTER and not popup:
                self.worked.pop(a, None)
                self.check_silent(a)
        for a in list(self.panes):
            if a not in agents:
                self.panes.pop(a); self.held.pop(a, None)
        out = {a: {**p, "changed_at": int(p["changed_at"] * 1000)} for a, p in self.panes.items()
               if self.sent_panes.get(a) != (p["text"], p["state"])}
        if out or now - self.last_pane_post > 10:
            try:
                http(self.cfg, "/watch/panes", {"room": self.cfg["room"],
                                                "panes": out or {a: {**p, "changed_at": int(p["changed_at"] * 1000)} for a, p in self.panes.items()}})
                for a, p in self.panes.items():
                    self.sent_panes[a] = (p["text"], p["state"])
                self.last_pane_post = now
            except Exception as e:
                log(f"could not send screens: {e}")

    # -- model switch: live for Claude (/model), otherwise a restart that resumes the conversation --
    def restart(self, a):
        """Relaunch an agent's CLI in its tmux window (start_agent.sh replaces a running or dead window)."""
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", a or "") or not os.path.isfile(os.path.join(self.cfg["root"], "agents", a, "agent.json")):
            say(self.cfg, f"@{self.cfg['human']} there's no agent named `{a}` in this project."); return
        for d in (self.held, self.alerted, self.auto_pressed, self.model_switch, self.worked, self.nudges, getattr(self, "auth_alerted", {})):
            d.pop(a, None)
        r = subprocess.run([os.path.join(HERE, "start_agent.sh"), a], capture_output=True, text=True)
        if r.returncode != 0:
            err = (r.stdout + r.stderr).strip()[-400:]
            say(self.cfg, f"@{self.cfg['human']} couldn't restart `{a}`:\n```\n{err or 'start_agent.sh failed'}\n```"); return
        how = "it picks up its conversation where it left off" if self.cfg.get("resume_sessions", True) not in (False, "false", 0) else "with a fresh session"
        log(f"restarted {a}")
        say(self.cfg, f"↻ Restarted `{a}`: {how}.")
        self.last_capture = 0

    def rename(self, old, new):
        """Rename the agent's folder and configs and restart it under its new name (setup_agent.py rename)."""
        r = subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "rename", old, new], capture_output=True, text=True)
        for d in (self.held, self.alerted, self.auto_pressed, self.model_switch, self.worked, self.nudges, self.panes,
                  self.sent_panes, self.renames, getattr(self, "auth_alerted", {}), self.dismissed):
            if old in d:
                v = d.pop(old)
                if d is self.model_switch:
                    d[new] = v
        self.cfg = config.load()
        out = (r.stdout.strip() or r.stderr.strip()[-300:] or "done")
        log(f"renamed {old} → {new}: {out}")
        if r.returncode != 0:
            say(self.cfg, f"@{self.cfg['human']} `{old}` is now `{new}` in the chat, but its folder couldn't be renamed: {out}")
        else:
            say(self.cfg, f"✏️ `{old}` → `{new}` on this machine: {out}.")
        self.last_capture = 0

    def switch_model(self, a):
        new = self.model_switch.pop(a, None)
        if new is None:
            return
        path = os.path.join(self.cfg["root"], "agents", a, "agent.json")
        try:
            with open(path) as f:
                agent = json.load(f)
        except (OSError, ValueError) as e:
            say(self.cfg, f"@{self.cfg['human']} couldn't switch `{a}`'s model: {e}"); return
        old, tool = agent.get("model") or "", agent.get("tool", "claude")
        agent["model"] = new
        with open(path, "w") as f:
            json.dump(agent, f, indent=2)
        subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "refresh", a], capture_output=True)
        local = lambda m: m.startswith(("ollama/", "openrouter/"))   # these need a different endpoint: restart, not /model
        if tool == "claude" and new and not local(new) and not local(old):
            type_into(self.cfg, a, f"/model {new}")
            how = "live, same conversation"
        else:
            session = self.cfg["tmux_session"]
            reap.reap(self.cfg, a)
            subprocess.run(["tmux", "kill-window", "-t", f"{session}:{a}"], capture_output=True)
            time.sleep(1)
            subprocess.run([os.path.join(HERE, "start_agent.sh"), a], capture_output=True)
            how = "restarted; it picks up its conversation where it left off" if self.cfg.get("resume_sessions", True) not in (False, "false", 0) else "restarted with a fresh session"
        log(f"{a}: model {old or 'default'} → {new or 'default'} ({how})")
        say(self.cfg, f"🔁 `{a}` now runs on `{new or 'its CLI default'}` (was `{old or 'default'}`): {how}.")

    # -- silent stops: an agent finished a turn on assigned work without reporting in the room --
    def owed(self, a, msgs):
        """Id of the latest message that assigned work to `a` and that `a` hasn't answered with a handoff
        (a post that @mentions someone). Status posts without a mention don't count as an answer."""
        me, lead = a.lower(), str(self.cfg.get("lead") or "").lower()
        agents = {x.lower() for x in agent_windows(self.cfg)}
        assigned = answered = 0
        for m in msgs:
            kind, who, ments = m.get("sender_kind"), str(m.get("sender", "")).lower(), m.get("mentions") or []
            if kind == "system":
                continue
            if who == me:
                if any(x != me for x in ments):
                    answered = m["id"]
                continue
            if me in ments or (me == lead and kind == "human" and not any(x in agents for x in ments)):
                assigned = m["id"]
        return assigned if assigned > answered else 0

    def check_silent(self, a):
        if self.cfg.get("wake") == "paused" or a in self.held:
            return
        try:
            msgs = sorted(http(self.cfg, f"/rooms/{room_q(self.cfg)}/messages?limit=60") or [], key=lambda m: m["id"])
        except Exception as e:
            log(f"silent check for {a}: {e}"); return
        mid = self.owed(a, msgs)
        if not mid:
            return
        last_id, n = self.nudges.get(a, (0, 0))
        n = n if last_id == mid else 0
        if n >= MAX_NUDGES:
            if n == MAX_NUDGES:
                say(self.cfg, f"@{self.cfg['human']} `{a}` stopped without reporting on #{mid} (nudged {n}×). "
                              f"Check its screen in the ▦ Team view, or give it a nudge yourself.")
                self.nudges[a] = (mid, n + 1)
            return
        src = next((m for m in msgs if m["id"] == mid), {})
        type_into(self.cfg, a, (
            f"[tropa] You stopped without reporting in {self.cfg['room']}: message #{mid} from {src.get('sender', '?')} "
            f"assigned you work and you haven't handed off yet. Do it now with tropa send_message: done (result, "
            f"and @mention who's next), blocked (what you need, and from whom), or still running (what you're "
            f"waiting for and when you'll report). If you started a server you still need, leave it running "
            f"and carry on with the task; stop the ones you're done with."))
        self.nudges[a] = (mid, n + 1)
        log(f"nudged {a}: stopped without reporting on #{mid} ({n + 1}/{MAX_NUDGES})")

    CODE = ("room_watcher.py", "config.py")

    @staticmethod
    def code_stamp():
        """Content hashes of the watcher's own scripts (not mtimes: those can change on network drives without an edit)."""
        out = []
        for f in Watcher.CODE:
            try:
                with open(os.path.join(HERE, f), "rb") as fh:
                    out.append(hashlib.sha1(fh.read()).hexdigest())
            except OSError:
                out.append("")
        return tuple(out)

    def code_changed(self, stamp):
        """True when the scripts were updated (tropa update) to code that compiles and has stopped changing."""
        now = time.time()
        if now - getattr(self, "_code_checked", 0) < 10:   # check every 10 s, not every loop
            return False
        self._code_checked = now
        if self.code_stamp() == stamp:
            return False
        time.sleep(2)                                      # let a copy in progress finish
        new = self.code_stamp()
        if new != self.code_stamp() or "" in new:
            return False
        for f in Watcher.CODE:
            try:
                with open(os.path.join(HERE, f), encoding="utf-8") as fh:
                    compile(fh.read(), f, "exec")
            except (OSError, SyntaxError, ValueError) as e:
                if getattr(self, "_bad_code", None) != new:
                    self._bad_code = new
                    log(f"the updated {f} doesn't compile ({e}); keeping the running watcher")
                return False
        # restarted 3 times in the last 2 minutes? something is off: stop auto-restarting and say so
        hist = [float(t) for t in os.environ.get("TROPA_WATCHER_RESTARTS", "").split(",") if t]
        hist = [t for t in hist if now - t < 120]
        if len(hist) >= 3:
            if not getattr(self, "_restart_off", False):
                self._restart_off = True
                log("watcher scripts keep changing; not restarting automatically any more (restart it with tropa panel → 3)")
            return False
        os.environ["TROPA_WATCHER_RESTARTS"] = ",".join(str(t) for t in hist + [now])
        return True

    def run(self):
        stamp = self.code_stamp()
        os.makedirs(CHATROOM, exist_ok=True)
        open(BROADCAST, "a").close()
        log(f"watching {self.cfg['room']} on {self.cfg['server']}; tmux '{self.cfg['tmux_session']}'")
        ok = None
        while True:
            if self.code_changed(stamp):   # updated on disk (tropa update): restart on the new code
                log("watcher scripts changed; restarting")
                os.execv(sys.executable, [sys.executable] + sys.argv)
            self.cfg = config.load()
            agents = agent_windows(self.cfg)
            try:
                events = self.poll(agents, timeout=PANE_EVERY)
                if ok is not True:
                    log(f"connected; agents: {', '.join(agents) or 'none yet'}"); ok = True
                    self.docs_sig = None   # (re)connected: send the docs list again
                for ev in events:
                    self.handle(ev, agents)
                sync_files(self.cfg, getattr(self, "last_resp", {}) or {})
            except Exception as e:
                if ok is not False:
                    if "404" in str(e) or "Not Found" in str(e):
                        log(f"{self.cfg['server']} is an older AI-IRC without wake routing. "
                            f"Replace it: docker rm -f ai-irc && tropa server up  (retrying)")
                    else:
                        log(f"TropaAI not reachable at {self.cfg['server']} ({e}); retrying")
                    ok = False
                time.sleep(5)
                continue
            m = self.mtime(BROADCAST)
            if m != self.bmtime:
                self.bmtime = m
                log("broadcast.txt touched -> waking all")
                wake_all(self.cfg, [])
            if time.time() - self.last_capture >= PANE_EVERY:
                self.last_capture = time.time()
                self.capture(agents)
            if time.time() - self.last_docs >= DOCS_EVERY:
                try:
                    self.post_docs()
                except Exception as e:
                    log(f"could not send the docs list: {e}")


def wake_all(cfg, names):
    """Ask TropaAI to wake agents now (bypasses pause/cooldown). Falls back to typing directly."""
    reason = f"{cfg['human']} asked everyone to check the room."
    try:
        r = http(cfg, f"/rooms/{room_q(cfg)}/wake", {"agents": names, "reason": reason})
        return r.get("woke", [])
    except Exception as e:
        log(f"TropaAI wake failed ({e}); typing directly")
    agents = agent_windows(cfg)
    woke = []
    for a in (names or agents):
        if a not in agents:
            print(f"no tmux window named {a} in session {cfg['tmux_session']}")
        elif approval_prompt(cfg, a):
            print(f"{a} is on an approval prompt — not typing into it")
        else:
            type_into(cfg, a, wake_text(cfg, a, reason)); woke.append(a)
    return woke


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "wake":
        for a in wake_all(config.load(), sys.argv[2:]):
            print(f"woke {a}")
    else:
        try:
            Watcher().run()
        except KeyboardInterrupt:
            pass
