#!/usr/bin/env python3
"""AI-IRC room watcher: the hands of the team on this machine.

AI-IRC decides who to wake (mentions, lead, @all, pause, cooldown, hourly limit; set per
room in settings.json or the monitor's Team view). This watcher:
  - long-polls AI-IRC (/api/watch/poll) for wake and command events and types the wake
    prompt into the agent's tmux window;
  - never types into an agent sitting on an approval prompt: it posts the prompt to the room
    once, holds the wake, and delivers it when the prompt clears;
  - runs `@watcher approve|always|deny NAME` (from the room or the Team view) by pressing the
    CLI's keys (settings: approval_keys);
  - streams each agent's screen to AI-IRC so the monitor can show the whole team working;
  - keeps the routing keys in settings.json and AI-IRC in sync (edit either one);
  - copies files shared in the room into the project (docs/attachments/...) and uploads
    files that agents share with the share_file tool.

Manual trigger: touch .agent_sync/chatroom/broadcast.txt, or run wake_all.sh.

  room_watcher.py               run the watcher
  room_watcher.py wake [NAME..] wake the named agents (or all) once and exit
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
sys.dont_write_bytecode = True
import config

HERE = config.HERE
CHATROOM = os.path.join(HERE, "chatroom")
BROADCAST = os.path.join(CHATROOM, "broadcast.txt")
SYNC = os.path.join(CHATROOM, ".wake_sync.json")
SKIP_WINDOWS = {"ControlCenter", "watcher"}
ROUTING = ["lead", "wake", "wake_rules", "max_wakes_per_agent_per_hour",
           "cooldown_seconds", "debounce_seconds", "history_limit"]
PANE_EVERY = 2.0          # seconds between screen captures
PANE_LINES = 60
WORKING_FOR = 6.0         # screen changed within this many seconds -> "working"
BOX = re.compile(r"[│┃║╭╮╰╯─━═┌┐└┘]+")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------- AI-IRC ----------
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
    return [w for w in out.split() if w and w not in SKIP_WINDOWS]


def pane_rows(cfg, window):
    out = subprocess.run(["tmux", "capture-pane", "-p", "-J", "-t", f"{cfg['tmux_session']}:{window}"],
                         capture_output=True, text=True).stdout
    return [r.rstrip() for r in out.splitlines()]


def approval_in(cfg, rows):
    """(signature, snippet) if these screen rows show an approval prompt, else None."""
    rows = [r for r in rows if r.strip()][-30:]
    pats = [re.compile(p, re.I) for p in cfg.get("approval_patterns", [])]
    for i in range(len(rows) - 1, -1, -1):
        if any(p.search(rows[i]) for p in pats):
            clean = [BOX.sub(" ", r).strip() for r in rows[max(0, i - 8): i + 6]]
            sig = re.sub(r"\s+", " ", re.sub(r"[│┃║╭╮╰╯─━═┌┐└┘❯>]+", " ", rows[i])).strip()
            return sig, "\n".join(r for r in clean if r)[:900]
    return None


def approval_prompt(cfg, window):
    return approval_in(cfg, pane_rows(cfg, window))


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


def wake_text(cfg, name, reason):
    return (f"[ai-irc] {reason} Read your unread messages in {cfg['room']} "
            f"(ai-irc read_messages, agent \"{name}\", limit {cfg['history_limit']}). "
            f"Follow AGENTS.md: act if you are mentioned or needed, otherwise stay silent.")


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


# ---------- settings sync (settings.json <-> AI-IRC room settings) ----------
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
        self.sent_panes = {}    # agent -> (text, state) last sent
        self.last_pane_post = 0
        self.last_capture = 0
        self.bmtime = self.mtime(BROADCAST)

    @staticmethod
    def mtime(p):
        try:
            return os.stat(p).st_mtime
        except FileNotFoundError:
            return 0

    # -- events from AI-IRC --
    def poll(self, agents, timeout):
        local = routing(self.cfg)
        snap = read_sync()
        changed = snap is not None and local != snap
        r = http(self.cfg, "/watch/poll", {"room": self.cfg["room"], "agents": agents,
                                           "tmux_session": self.cfg["tmux_session"],
                                           "settings": local, "settings_changed": changed,
                                           "timeout": timeout}, timeout=timeout + 10)
        server = routing(r.get("settings") or {})
        if changed:
            log(f"pushed settings to AI-IRC: {local}")
        elif server != (snap or local) and server != local:
            for k, v in server.items():
                if self.cfg.get(k) != v:
                    config.save_key(k, json.dumps(v))
            log(f"pulled settings from AI-IRC: {server}")
            if server.get("lead") != local.get("lead"):
                subprocess.run([sys.executable, os.path.join(HERE, "setup_agent.py"), "refresh"], capture_output=True)
            self.cfg = config.load()
        write_sync(server)
        self.last_resp = r
        if r.get("human") and r["human"] != self.cfg["human"]:
            log(f"note: AI-IRC human is @{r['human']} but settings.human is @{self.cfg['human']}")
        return r.get("events") or []

    def handle(self, ev, agents):
        by_lower = {a.lower(): a for a in agents}
        a = by_lower.get(str(ev.get("agent", "")).lower())
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
        prompt = approval_prompt(self.cfg, a)
        if prompt:
            self.held[a] = text
            if self.alerted.get(a) != prompt[0]:
                say(self.cfg, approval_alert(self.cfg, a, prompt[1]))
                self.alerted[a] = prompt[0]
            log(f"{a} is on an approval prompt; wake held")
            return
        self.held.pop(a, None)
        type_into(self.cfg, a, text)
        log(f"woke {a}: {reason}")

    # -- screens --
    def capture(self, agents):
        now = time.time()
        for a in agents:
            rows = pane_rows(self.cfg, a)
            while rows and not rows[-1].strip():
                rows.pop()
            text = "\n".join(rows[-PANE_LINES:])
            prompt = approval_in(self.cfg, rows)
            prev = self.panes.get(a)
            changed_at = now if not prev or prev["text"] != text else prev["changed_at"]
            state = "approval" if prompt else ("working" if now - changed_at < WORKING_FOR and prev else "idle")
            self.panes[a] = {"text": text, "state": state, "prompt": prompt[0] if prompt else "", "changed_at": changed_at}
            # approvals: alert once per prompt, deliver held wakes once it clears
            if prompt and self.alerted.get(a) != prompt[0]:
                say(self.cfg, approval_alert(self.cfg, a, prompt[1]))
                self.alerted[a] = prompt[0]
                log(f"{a} is on an approval prompt; posted to room")
            elif not prompt:
                self.alerted.pop(a, None)
                if a in self.held:
                    self.deliver(a, self.held.pop(a), "held wake")
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

    def run(self):
        os.makedirs(CHATROOM, exist_ok=True)
        open(BROADCAST, "a").close()
        log(f"watching {self.cfg['room']} on {self.cfg['server']}; tmux '{self.cfg['tmux_session']}'")
        ok = None
        while True:
            self.cfg = config.load()
            agents = agent_windows(self.cfg)
            try:
                events = self.poll(agents, timeout=PANE_EVERY)
                if ok is not True:
                    log(f"connected; agents: {', '.join(agents) or 'none yet'}"); ok = True
                for ev in events:
                    self.handle(ev, agents)
                sync_files(self.cfg, getattr(self, "last_resp", {}) or {})
            except Exception as e:
                if ok is not False:
                    if "404" in str(e) or "Not Found" in str(e):
                        log(f"{self.cfg['server']} is an older AI-IRC without wake routing. "
                            f"Replace it: docker rm -f ai-irc && tropa server up  (retrying)")
                    else:
                        log(f"AI-IRC not reachable at {self.cfg['server']} ({e}); retrying")
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


def wake_all(cfg, names):
    """Ask AI-IRC to wake agents now (bypasses pause/cooldown). Falls back to typing directly."""
    reason = f"{cfg['human']} asked everyone to check the room."
    try:
        r = http(cfg, f"/rooms/{room_q(cfg)}/wake", {"agents": names, "reason": reason})
        return r.get("woke", [])
    except Exception as e:
        log(f"AI-IRC wake failed ({e}); typing directly")
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
