#!/usr/bin/env python3
"""tropa host helper — lets the chat create projects and start teams on this machine.

The chat server can't touch your disk (it runs in Docker). This helper long-polls it for
jobs and does the machine-side work with tropa's own scripts:

  create_project: make <projects_dir>/<folder>, run `tropa init`, write docs/SPEC.md from the
  brief, copy the attached files into docs/attachments/, create the agents, start them and
  the watcher in tmux, then post the kickoff message. Progress is posted to the room.

It only ever creates folders directly under --projects-dir (default ~/projects) and only
runs tropa's scripts; it never runs commands sent by the server.

  tropa_host.py --server http://localhost:8181 [--projects-dir ~/projects]
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

TROPA_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TROPA = os.path.join(TROPA_HOME, "tropa")
VERSION = open(os.path.join(TROPA_HOME, "VERSION")).read().strip() if os.path.exists(os.path.join(TROPA_HOME, "VERSION")) else "dev"
CLIS = ["claude", "opencode", "qwen", "codex"]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def slugify(s):
    return re.sub(r"[^a-z0-9._-]+", "-", str(s).lower()).strip("-")[:60] or "project"


def _get_json(url, headers, timeout=8):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "null")


def discover_models():
    out = {c: [] for c in CLIS}
    seen = {c: set() for c in CLIS}

    def add(tool, mid, label=""):
        mid = str(mid or "").strip()
        if mid and re.fullmatch(r"[A-Za-z0-9._:/@-]{1,100}", mid) and mid not in seen[tool]:
            seen[tool].add(mid)
            out[tool].append({"id": mid, "label": label})

    # 1) the kit's models.conf (aliases + pinned ids you chose)
    try:
        with open(os.path.join(TROPA_HOME, "kit", ".agent_sync", "models.conf")) as f:
            for line in f:
                parts = line.strip().split("|")
                if len(parts) >= 2 and parts[0] in out and not line.startswith("#"):
                    add(parts[0], parts[1], parts[2].strip() if len(parts) > 2 else "")
    except OSError:
        pass

    # 2) Claude: the Anthropic models API lists the exact, versioned ids your key can use
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        try:
            for m in (_get_json("https://api.anthropic.com/v1/models?limit=100",
                                {"x-api-key": key, "anthropic-version": "2023-06-01"}) or {}).get("data", []):
                add("claude", m.get("id"), f"{m.get('display_name') or m.get('id')} · your account")
        except Exception as e:
            log(f"Anthropic models API: {e}")

    # 3) Codex: your configured default, then the OpenAI models API
    try:
        with open(os.path.expanduser("~/.codex/config.toml")) as f:
            top = f.read().split("\n[", 1)[0]
        m = re.search(r'^\s*model\s*=\s*"([^"]+)"', top, re.M)
        if m:
            add("codex", m.group(1), "your Codex default (~/.codex/config.toml)")
    except OSError:
        pass
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        try:
            ids = [m.get("id", "") for m in (_get_json("https://api.openai.com/v1/models",
                                                      {"Authorization": f"Bearer {key}"}) or {}).get("data", [])]
            skip = re.compile(r"audio|realtime|tts|transcribe|image|embedding|search|moderation|dall|whisper|instruct|babbage|davinci")
            for mid in sorted((i for i in ids if re.match(r"^(gpt-|o\d|codex)", i) and not skip.search(i)), reverse=True):
                add("codex", mid, "your OpenAI account")
        except Exception as e:
            log(f"OpenAI models API: {e}")

    # 4) Qwen Code: configured model, then an OpenAI-compatible endpoint's /models
    try:
        with open(os.path.expanduser("~/.qwen/settings.json")) as f:
            qs = json.load(f)
        qm = qs.get("model")
        add("qwen", qm.get("name") if isinstance(qm, dict) else qm, "your Qwen Code default (~/.qwen/settings.json)")
    except Exception:
        pass
    add("qwen", os.environ.get("OPENAI_MODEL", "") if os.environ.get("OPENAI_BASE_URL") else "", "OPENAI_MODEL")
    base, key = os.environ.get("OPENAI_BASE_URL"), os.environ.get("OPENAI_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
    if base and key:
        try:
            for m in (_get_json(base.rstrip("/") + "/models", {"Authorization": f"Bearer {key}"}) or {}).get("data", []):
                if "qwen" in str(m.get("id", "")).lower():
                    add("qwen", m.get("id"), "your endpoint")
        except Exception as e:
            log(f"{base}/models: {e}")

    # 5) OpenCode: its own live list (provider/model, already versioned)
    if shutil.which("opencode"):
        try:
            r = subprocess.run(["opencode", "models"], capture_output=True, text=True, timeout=25, stdin=subprocess.DEVNULL)
            for l in sorted(set(r.stdout.splitlines())):
                if "/" in l and " " not in l.strip():
                    add("opencode", l.strip())
        except Exception as e:
            log(f"opencode models: {e}")
    return out


class Host:
    # ---------- model discovery ----------
    def models(self):
        """{tool: [{id, label}]}: models.conf, plus what each CLI/account can tell us (cached 10 min).

        Versioned ids come from your own accounts where possible, so nothing here goes stale:
          claude   Anthropic models API (ANTHROPIC_API_KEY)            e.g. claude-sonnet-5-5
          codex    ~/.codex/config.toml `model`, OpenAI models API (OPENAI_API_KEY)
          qwen     ~/.qwen/settings.json model, OPENAI_BASE_URL /models (OPENAI_API_KEY / DASHSCOPE_API_KEY)
          opencode `opencode models` (provider/model ids)
        """
        now = time.time()
        if getattr(self, "_models_at", 0) > now - 600:
            return self._models
        self._models, self._models_at = discover_models(), now
        return self._models

    def folders(self):
        """Top-level folders in projects_dir that the chat may adopt as existing projects."""
        now = time.time()
        if getattr(self, "_folders_at", 0) > now - 20:
            return self._folders
        out = []
        try:
            names = sorted(os.listdir(self.projects_dir), key=str.lower)
        except OSError:
            names = []
        for n in names[:500]:
            p = os.path.join(self.projects_dir, n)
            if n.startswith(".") or not os.path.isdir(p) or not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", n):
                continue
            kit = os.path.exists(os.path.join(p, ".agent_sync", "config.py"))
            slug = ""
            if kit:
                try:
                    with open(os.path.join(p, ".agent_sync", "settings.json")) as f:
                        slug = json.load(f).get("project") or ""
                except Exception:
                    pass
            out.append({"name": n, "kit": kit, "git": os.path.isdir(os.path.join(p, ".git")), "slug": slugify(slug or n)})
        self._folders, self._folders_at = out, now
        return out

    def __init__(self, server, projects_dir):
        self.server = server.rstrip("/")
        self.projects_dir = os.path.realpath(os.path.expanduser(projects_dir))
        self.port = urllib.parse.urlparse(self.server).port or 80

    def http(self, path, body=None, timeout=15, method=None):
        req = urllib.request.Request(self.server + "/api" + path,
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

    # ---------- job helpers ----------
    def report(self, job, message=None, status=None, folder=None):
        body = {k: v for k, v in (("message", message), ("status", status), ("folder", folder)) if v}
        try:
            self.http(f"/host/jobs/{job['id']}", body)
        except Exception as e:
            log(f"could not report to the room: {e}")
        if message:
            log(f"[{job['slug']}] {message}")

    def run(self, args, cwd=None, check=True):
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        if check and r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or f"{args[0]} failed").strip()[-600:])
        return r

    def cfg(self, root, key):
        return self.run([sys.executable, os.path.join(root, ".agent_sync", "config.py"), "get", key]).stdout.strip()

    def setc(self, root, key, value):
        self.run([sys.executable, os.path.join(root, ".agent_sync", "config.py"), "set", key, json.dumps(value)])

    # ---------- create_project ----------
    def create_project(self, job):
        folder = job["folder"]
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", folder) or set(folder) == {"."}:
            raise RuntimeError("invalid folder name")
        root = os.path.join(self.projects_dir, folder)
        existing = bool(job.get("existing"))
        if existing:
            if not os.path.isdir(root):
                raise RuntimeError(f"{root} doesn't exist")
        elif os.path.exists(root) and os.listdir(root) and not os.path.exists(os.path.join(root, ".agent_sync")):
            raise RuntimeError(f"{root} already exists and isn't empty — pick another folder name, or choose it as an existing folder")
        os.makedirs(self.projects_dir, exist_ok=True)
        self._folders_at = 0
        self.report(job, f"📁 {'Adding the team kit to' if existing else 'Setting up'} `{root}` …", status="running", folder=root)

        r = self.run([TROPA, "init", "-p", str(self.port), "-n", job["slug"], root])
        room = self.cfg(root, "room")
        if room != job["room_id"]:
            raise RuntimeError(f"room mismatch: {room} vs {job['room_id']}")

        brief_file = ""
        if job.get("brief"):
            docs = os.path.join(root, "docs")
            os.makedirs(docs, exist_ok=True)
            for name in ("SPEC.md", "BRIEF.md", time.strftime("BRIEF-%Y%m%d-%H%M%S.md")):
                if not os.path.exists(os.path.join(docs, name)):     # never overwrite an existing spec
                    brief_file = f"docs/{name}"
                    with open(os.path.join(docs, name), "w") as f:
                        f.write(f"# {job['name']}\n\n{job['brief'].strip()}\n")
                    break

        # copy files attached in the room (the watcher does this later too; doing it now
        # means they're on disk before the agents start)
        saved = []
        for a in self.http(f"/rooms/{urllib.parse.quote(job['room_id'], safe='')}/files?pending=1") or []:
            dest = os.path.realpath(os.path.join(root, a["path"]))
            if not dest.startswith(os.path.realpath(root) + os.sep):
                continue
            with urllib.request.urlopen(self.server + a["url"], timeout=60) as resp:
                data = resp.read()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            self.http(f"/watch/files/{a['id']}/synced", {})
            saved.append(a["path"])
        parts = ([f"wrote `{brief_file}`"] if brief_file else []) + ([f"saved {len(saved)} file(s) in `docs/attachments/`"] if saved else [])
        if parts:
            msg = " and ".join(parts)
            self.report(job, "📝 " + msg[:1].upper() + msg[1:] + ".")

        agents = job.get("agents") or []
        if not agents:
            self.report(job, f"✅ Project ready at `{root}`. No agents yet — add them with `tropa panel {root}`.", status="done")
            return

        tools = {a["tool"] for a in agents}
        missing = [t for t in tools if not shutil.which(t)]
        if missing:
            self.report(job, f"⚠️ Not installed on this machine: {', '.join(missing)}. Those agents won't start until it is.")
        if "claude" in tools and shutil.which("claude"):
            helptext = self.run(["claude", "--help"], check=False).stdout
            self.setc(root, "tool_flags.claude", "--permission-mode auto" if '"auto"' in helptext else "--permission-mode acceptEdits")

        setup = os.path.join(root, ".agent_sync", "setup_agent.py")
        for a in agents:
            role = a.get("role") or f"{a['name']} on {job['name']}"
            instr = a.get("instruction") or ((f"Read {brief_file or 'docs/SPEC.md'} and the files in docs/attachments/. "
                                              + ("This is an existing codebase: explore it and follow its conventions. " if existing else ""))
                                             + ("Plan the work, split it into tasks and assign them with @mentions. "
                                                if a["name"] == job.get("lead") else
                                                "Wait for your assignment from the lead (or from the human), then do it and hand off with an @mention."))
            args = [sys.executable, setup, "create", a["name"], a["tool"], role, instr, a.get("model") or ""]
            if a["name"] == job.get("lead"):
                args.append("--lead")
            self.run(args)
        if job.get("lead"):
            self.setc(root, "lead", job["lead"])
        self.run([sys.executable, setup, "refresh"])
        lead = f" — lead: @{job['lead']}" if job.get("lead") else ""
        self.report(job, "🤖 Created agents: " + ", ".join(f"@{a['name']} ({a['tool']}{' · ' + a['model'] if a.get('model') else ''})" for a in agents) + lead + ".")

        if job.get("trust") and "claude" in tools:
            self.trust_claude(root, [a["name"] for a in agents if a["tool"] == "claude"])
        if job.get("trust") and "codex" in tools:
            self.trust_codex(root)

        if not job.get("start"):
            self.report(job, f"✅ Project ready at `{root}`. Start the team with `tropa panel {root}` (option 3).", status="done")
            return

        session = self.cfg(root, "tmux_session")
        self.run([os.path.join(root, ".agent_sync", "start_agent.sh"), "--all"])
        have = self.run(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"], check=False).stdout.split()
        if "watcher" not in have:
            self.run(["tmux", "new-window", "-d", "-t", session, "-n", "watcher", "-c", root,
                      f"python3 {os.path.join(root, '.agent_sync', 'room_watcher.py')}; read -p 'watcher stopped — Enter to close'"])
        self.report(job, f"🚀 Team started in tmux session `{session}` — open **▦ Team** to watch them.")

        # wait for the watcher, give the CLIs time to boot and register, then kick off
        q = urllib.parse.quote(job["room_id"], safe="")
        for _ in range(30):
            try:
                if self.http(f"/rooms/{q}/team").get("watching"):
                    break
            except Exception:
                pass
            time.sleep(2)
        kickoff = (job.get("kickoff") or "").strip()
        if kickoff:
            time.sleep(25)
            self.http(f"/rooms/{q}/messages", {"sender": job.get("human") or "human", "sender_kind": "human", "content": kickoff})
        self.report(job, f"✅ Project ready at `{root}`." + (" Kickoff sent." if kickoff else " Say hi to the team when you're ready."), status="done")

    def trust_claude(self, root, names):
        p = os.path.expanduser("~/.claude.json")
        if not os.path.exists(p):
            return
        try:
            shutil.copy(p, p + ".bak-tropa")
            with open(p) as f:
                d = json.load(f)
            for n in names:
                d.setdefault("projects", {}).setdefault(os.path.realpath(os.path.join(root, "agents", n)), {})["hasTrustDialogAccepted"] = True
            tmp = p + ".tmp-tropa"
            with open(tmp, "w") as f:
                json.dump(d, f, indent=2)
            os.replace(tmp, p)
        except Exception as e:
            log(f"could not pre-trust Claude folders: {e}")

    def trust_codex(self, root):
        """Mark the project trusted in ~/.codex/config.toml so Codex doesn't ask on first run."""
        p = os.path.expanduser("~/.codex/config.toml")
        key = f'[projects."{os.path.realpath(root)}"]'
        try:
            cur = open(p).read() if os.path.exists(p) else ""
            if key in cur:
                return
            os.makedirs(os.path.dirname(p), exist_ok=True)
            if cur:
                shutil.copy(p, p + ".bak-tropa")
            with open(p, "a") as f:
                f.write(f'\n{key}\ntrust_level = "trusted"\n')
        except Exception as e:
            log(f"could not pre-trust the Codex project: {e}")

    # ---------- loop ----------
    def loop(self):
        log(f"tropa host helper {VERSION} → {self.server}; projects in {self.projects_dir}")
        ok = None
        while True:
            try:
                r = self.http("/host/poll", {"projects_dir": self.projects_dir, "home": os.path.expanduser("~"),
                                              "version": VERSION, "clis": [c for c in CLIS if shutil.which(c)],
                                              "models": self.models(), "folders": self.folders(),
                                              "timeout": 20}, timeout=35)
                if ok is not True:
                    log("connected"); ok = True
            except Exception as e:
                if ok is not False:
                    log(f"server not reachable ({e}); retrying"); ok = False
                time.sleep(5)
                continue
            for job in r.get("jobs") or []:
                if job.get("type") != "create_project":
                    continue
                try:
                    self.create_project(job)
                except Exception as e:
                    self.report(job, f"❌ Couldn't set up the project: {e}", status="failed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://localhost:8888")
    ap.add_argument("--projects-dir", default=os.environ.get("TROPA_PROJECTS_DIR", "~/projects"))
    ap.add_argument("--list-models", nargs="?", const="all", metavar="TOOL", help="print tool|model-id|label lines and exit")
    a = ap.parse_args()
    if a.list_models:
        for tool, ms in discover_models().items():
            if a.list_models in ("all", tool):
                for m in ms:
                    print(f"{tool}|{m['id']}|{m['label']}")
        sys.exit(0)
    try:
        Host(a.server, a.projects_dir).loop()
    except KeyboardInterrupt:
        pass
