#!/usr/bin/env python3
"""AI-IRC room watcher: the single trigger that tells agents to read the room.

Polls the project room and types a short "read the room" prompt into each target
agent's tmux window. Works for any TUI agent (Claude Code, OpenCode, Qwen Code).
Settings come from settings.json and are re-read every loop, so edits apply live.

Who gets woken (wake_rules = "smart"):
  - @name                        -> that agent (a mention is an assignment)
  - @all / @here (/ @team / @everyone) -> every agent except the sender
  - the human, no agent mention  -> the lead if one is set and running, else everyone
  - an agent, no agent mention   -> nobody (informational)
wake_rules = "all" wakes every agent except the sender on any message.
wake = "paused" stops automatic wakes (manual wake still works).

If an agent is sitting on an approval prompt, the watcher does not type into it.
It posts the prompt to the room for the human and delivers the wake once it clears.

Manual trigger: touch .agent_sync/chatroom/broadcast.txt, or run wake_all.sh.

  room_watcher.py               run the watcher loop
  room_watcher.py wake [NAME..] wake the named agents (or all) once and exit
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
import config

HERE = config.HERE
CHATROOM = os.path.join(HERE, "chatroom")
BROADCAST = os.path.join(CHATROOM, "broadcast.txt")
STATE = os.path.join(CHATROOM, ".last_id")
WATCHER = "watcher"
SKIP_WINDOWS = {"ControlCenter", WATCHER}
EVERYONE = {"all", "here", "team", "everyone"}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------- AI-IRC ----------
def http(cfg, path, body=None):
    req = urllib.request.Request(cfg["server"] + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode() or "null")


def room_path(cfg):
    return "/api/rooms/" + urllib.parse.quote(cfg["room"], safe="") + "/messages"


def fetch_after(cfg, last_id):
    return http(cfg, f"{room_path(cfg)}?after={last_id}&limit=200")


def latest_id(cfg):
    msgs = http(cfg, room_path(cfg) + "?limit=1")
    return msgs[-1]["id"] if msgs else 0


def ensure_room(cfg):
    http(cfg, "/api/rooms", {"project": cfg["project"]})


def post(cfg, content):
    try:
        http(cfg, room_path(cfg), {"agent": WATCHER, "content": content})
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


def pane_tail(cfg, window, lines=30):
    out = subprocess.run(["tmux", "capture-pane", "-p", "-t", f"{cfg['tmux_session']}:{window}"],
                         capture_output=True, text=True).stdout
    rows = [r.rstrip() for r in out.splitlines() if r.strip()]
    return rows[-lines:]


def approval_prompt(cfg, window):
    """Return a cleaned snippet if the pane shows an approval prompt, else None."""
    rows = pane_tail(cfg, window)
    pats = [re.compile(p, re.I) for p in cfg.get("approval_patterns", [])]
    for i in range(len(rows) - 1, -1, -1):
        if any(p.search(rows[i]) for p in pats):
            snippet = rows[max(0, i - 8): i + 6]
            clean = [re.sub(r"[│┃║╭╮╰╯─━═┌┐└┘]+", " ", r).strip() for r in snippet]
            return "\n".join(r for r in clean if r)[:900]
    return None


def type_into(cfg, window, text):
    target = f"{cfg['tmux_session']}:{window}"
    subprocess.run(["tmux", "send-keys", "-t", target, "-l", text], check=False)
    time.sleep(0.4)   # so the TUI doesn't treat Enter as part of a paste
    subprocess.run(["tmux", "send-keys", "-t", target, "Enter"], check=False)


def wake_text(cfg, name, reason):
    return (f"[ai-irc] {reason} Read your unread messages in {cfg['room']} "
            f"(ai-irc read_messages, agent \"{name}\", limit {cfg['history_limit']}). "
            f"Follow AGENTS.md: act if you are mentioned or needed, otherwise stay silent.")


# ---------- routing ----------
def pick_targets(cfg, msgs, agents):
    by_lower = {a.lower(): a for a in agents}
    lead = cfg.get("lead") or ""
    targets = {}
    for m in msgs:
        sender = m.get("sender", "")
        if m.get("sender_kind") == "system" or sender == WATCHER:
            continue
        mentions = {x.lower() for x in m.get("mentions", [])}
        named = [by_lower[x] for x in mentions if x in by_lower and x != sender.lower()]
        others = [a for a in agents if a.lower() != sender.lower()]
        if cfg["wake_rules"] == "all" or mentions & EVERYONE:
            hit = others
        elif named:
            hit = named
        elif m.get("sender_kind") == "human":
            hit = [lead] if lead in agents else others
        else:
            hit = []
        for a in hit:
            targets.setdefault(a, []).append(m)
    return targets


# ---------- state ----------
def read_state():
    try:
        return int(open(STATE).read().strip())
    except Exception:
        return None


def write_state(i):
    with open(STATE, "w") as f:
        f.write(str(i))


def mtime(p):
    try:
        return os.stat(p).st_mtime
    except FileNotFoundError:
        return 0


def run():
    os.makedirs(CHATROOM, exist_ok=True)
    open(BROADCAST, "a").close()
    cfg = config.load()
    last = read_state()
    while True:
        try:
            ensure_room(cfg)
            if last is None:
                last = latest_id(cfg)        # start from now; don't replay history
                write_state(last)
            break
        except Exception as e:
            log(f"AI-IRC not reachable at {cfg['server']} ({e}); retrying in 10s")
            time.sleep(10)
            cfg = config.load()
    log(f"watching {cfg['room']} on {cfg['server']} from #{last}; tmux '{cfg['tmux_session']}'")
    bmtime = mtime(BROADCAST)
    last_wake, pending, history, alerted = {}, {}, {}, {}
    paused_logged = None

    while True:
        cfg = config.load()
        agents = agent_windows(cfg)
        paused = cfg["wake"] == "paused"
        if paused != paused_logged:
            log("auto-wake PAUSED" if paused else f"auto-wake on (rules: {cfg['wake_rules']}, lead: {cfg['lead'] or 'none'})")
            paused_logged = paused

        m = mtime(BROADCAST)
        if m != bmtime:
            bmtime = m
            for a in agents:
                pending.setdefault(a, [])
            log("broadcast.txt touched -> waking all")

        try:
            msgs = fetch_after(cfg, last)
            if msgs:
                time.sleep(float(cfg["debounce_seconds"]))
                msgs += fetch_after(cfg, msgs[-1]["id"])
                last = msgs[-1]["id"]
                write_state(last)
                if not paused:
                    for a, ms in pick_targets(cfg, msgs, agents).items():
                        pending.setdefault(a, []).extend(ms)
        except Exception as e:
            log(f"poll failed: {e}")
            time.sleep(10)

        now = time.time()
        cap = int(cfg.get("max_wakes_per_agent_per_hour") or 0)
        for a in list(pending):
            if a not in agents:
                pending.pop(a); continue
            if now - last_wake.get(a, 0) < float(cfg["cooldown_seconds"]):
                continue
            history[a] = [t for t in history.get(a, []) if now - t < 3600]
            if cap and len(history[a]) >= cap:
                if alerted.get(a) != "cap":
                    post(cfg, f"@{cfg['human']} `{a}` hit the wake limit ({cap}/hour); holding its wake-ups.")
                    alerted[a] = "cap"
                continue
            prompt = approval_prompt(cfg, a)
            if prompt:
                if alerted.get(a) != prompt:
                    post(cfg, f"@{cfg['human']} `{a}` is waiting for your approval in tmux "
                              f"(window `{a}`, session `{cfg['tmux_session']}`):\n```\n{prompt}\n```")
                    alerted[a] = prompt
                    log(f"{a} is on an approval prompt; posted to room, wake held")
                continue
            alerted.pop(a, None)
            ms = pending.pop(a)
            if ms:
                ids = sorted({x["id"] for x in ms})
                who = ", ".join(sorted({x["sender"] for x in ms}))
                reason = f"New message(s) #{ids[0]}" + (f"-#{ids[-1]}" if len(ids) > 1 else "") + f" from {who}."
            else:
                reason = f"{cfg['human']} asked everyone to check the room."
            type_into(cfg, a, wake_text(cfg, a, reason))
            last_wake[a] = now
            history[a].append(now)
            log(f"woke {a}: {reason}")

        # Surface approval prompts even when no wake is pending.
        for a in agents:
            if a in pending:
                continue
            prompt = approval_prompt(cfg, a)
            if prompt and alerted.get(a) != prompt:
                post(cfg, f"@{cfg['human']} `{a}` is waiting for your approval in tmux "
                          f"(window `{a}`, session `{cfg['tmux_session']}`):\n```\n{prompt}\n```")
                alerted[a] = prompt
                log(f"{a} is on an approval prompt; posted to room")
            elif not prompt and alerted.get(a) not in (None, "cap"):
                alerted.pop(a, None)
        time.sleep(float(cfg["poll_seconds"]))


def wake_once(names):
    cfg = config.load()
    agents = agent_windows(cfg)
    for a in (names or agents):
        if a not in agents:
            print(f"no tmux window named {a} in session {cfg['tmux_session']}")
        elif approval_prompt(cfg, a):
            print(f"{a} is on an approval prompt — not typing into it")
        else:
            type_into(cfg, a, wake_text(cfg, a, f"{cfg['human']} asked everyone to check the room."))
            print(f"woke {a}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "wake":
        wake_once(sys.argv[2:])
    else:
        try:
            run()
        except KeyboardInterrupt:
            pass
