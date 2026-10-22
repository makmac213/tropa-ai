#!/usr/bin/env python3
"""tropa host helper — lets the chat create projects and start teams on this machine.

The chat server can't touch your disk (it runs in Docker). This helper long-polls it for
jobs and does the machine-side work with tropa's own scripts:

  share / unshare: run or stop `ngrok http PORT` for a public link (optional; needs ngrok).

  create_project: make <projects_dir>/<folder>, run `tropa init`, write docs/SPEC.md from the
  brief, copy the attached files into docs/attachments/, create the agents, start them and
  the watcher in tmux, then post the kickoff message. Progress is posted to the room.

It only ever creates folders directly under --projects-dir (default ~/projects) and only
runs tropa's scripts; it never runs commands sent by the server.

  tropa_host.py --server http://localhost:8181 [--projects-dir ~/projects]
"""
import argparse, glob, json, os, re, shutil, signal, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

TROPA_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TROPA = os.path.join(TROPA_HOME, "tropa")
VERSION = open(os.path.join(TROPA_HOME, "VERSION")).read().strip() if os.path.exists(os.path.join(TROPA_HOME, "VERSION")) else "dev"
CLIS = ["claude", "opencode", "qwen", "codex", "gemini"]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def git_version():
    """'git version 2.x' if git is installed and works (macOS ships a stub that only opens an installer), else ''."""
    try:
        r = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def git_hint():
    if sys.platform == "darwin":
        return "xcode-select --install, or brew install git"
    for pm, cmd in (("apt-get", "sudo apt-get install -y git"), ("dnf", "sudo dnf install -y git"), ("pacman", "sudo pacman -S git"),
                    ("zypper", "sudo zypper install -y git"), ("apk", "sudo apk add git")):
        if shutil.which(pm):
            return cmd
    return "https://git-scm.com/downloads"


def design_catalog():
    """Design systems from <tropa>/design-systems/*.md (front matter drives the chat's preview)."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import design_systems
        return [{k: v for k, v in d.items() if k != "file"} for d in design_systems.catalog()]
    except Exception as e:
        log(f"design systems: {e}")
        return []


def teams_catalog():
    """Ready-made teams from <tropa>/teams/ and ~/.tropa/teams/ (one folder of prompts each)."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import teams
        return teams.catalog()
    except Exception as e:
        log(f"teams: {e}")
        return []


def tools_catalog():
    """The optional tools (hosted MCP servers) a project can enable, from the kit's tools.json."""
    try:
        with open(os.path.join(TROPA_HOME, "kit", ".agent_sync", "tools.json")) as f:
            tools = json.load(f).get("tools", [])
    except (OSError, ValueError):
        return []
    return [{"id": t["id"], "name": t.get("name", t["id"]), "summary": t.get("summary", ""), "docs": t.get("docs", ""),
             "params": t.get("params", []), "token_env": t.get("token_env", ""),
             "token_set": bool(t.get("token_env") and os.environ.get(t["token_env"]))} for t in tools]


def slugify(s):
    return re.sub(r"[^a-z0-9._-]+", "-", str(s).lower()).strip("-")[:60] or "project"


def _get_json(url, headers, timeout=8):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "null")


def opencode_bin():
    """the opencode binary: PATH first, then where its installers put it (often not on a service's PATH)."""
    found = shutil.which("opencode")
    if found:
        return found
    home = os.path.expanduser("~")
    for c in (f"{home}/.opencode/bin/opencode", f"{home}/.local/bin/opencode", f"{home}/.bun/bin/opencode",
              "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"):
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _openrouter():
    sys.path.insert(0, os.path.join(TROPA_HOME, "kit", ".agent_sync"))
    import openrouter
    return openrouter


def openrouter_ready():
    try:
        return bool(_openrouter().key())
    except Exception:
        return False


OR_ERROR = ""   # why the last OpenRouter model lookup failed (shown in the monitor)


def openrouter_status():
    """What the monitor shows in ⚙ Settings → OpenRouter (never the key itself)."""
    try:
        o = _openrouter()
        return {"ready": bool(o.key()), "source": o.source(), "masked": o.masked(), "error": OR_ERROR if o.key() else ""}
    except Exception as e:
        return {"ready": False, "source": "", "masked": "", "error": str(e)}


def _keys():
    sys.path.insert(0, os.path.join(TROPA_HOME, "kit", ".agent_sync"))
    import keys
    return keys


def keys_status():
    """API keys for the monitor (never the keys themselves): global status per provider, and projects with their own key."""
    try:
        k = _keys()
        out = {p: k.status(p) for p in k.PROVIDERS}
        if "openrouter" in out:
            out["openrouter"]["error"] = OR_ERROR if out["openrouter"]["ready"] else ""
        projects = {}
        for p in k.PROVIDERS:
            for slug in k.projects(p):
                projects.setdefault(slug, {})[p] = k.masked(k.get(p, slug)[0])
        out["projects"] = projects
        return out
    except Exception as e:
        log(f"keys: {e}")
        return {}


_CLAUDE = {"at": 0, "info": {}}


def claude_status():
    """Is Claude Code installed here (it runs the "New project" setup chat)? Cached for a minute."""
    if time.time() - _CLAUDE["at"] < 60:
        return _CLAUDE["info"]
    exe, ver = shutil.which("claude"), ""
    if exe:
        try:
            ver = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL).stdout.strip().split("\n")[0][:60]
        except Exception:
            pass
    _CLAUDE.update(at=time.time(), info={"installed": bool(exe), "version": ver, "chat": True, "signed_in": claude_signed_in() if exe else False})
    return _CLAUDE["info"]


def claude_signed_in():
    """Best guess whether Claude Code has a login (never reads the secret itself)."""
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"):
        return True
    home = os.path.expanduser("~")
    if os.path.isfile(os.path.join(home, ".config", "tropa", "claude.token")) or os.path.isfile(os.path.join(home, ".claude", ".credentials.json")):
        return True
    if sys.platform == "darwin" and shutil.which("security"):   # macOS keeps it in the login keychain
        try:
            return subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials"], capture_output=True,
                                  timeout=10, stdin=subprocess.DEVNULL).returncode == 0
        except Exception:
            return False
    return False


CHAT_SYSTEM = """You are the project-setup assistant of TropaAI, a tool that runs a team of AI coding/research agents
(each one a CLI in its own tmux window) that talk in a shared chat room with their human, {human}.
Your job: turn the human's description into a project plan. Ask at most one or two short questions when something
important is missing (what to build or research, a new folder or an existing one), otherwise propose a plan right away.
Revise the plan whenever the human asks for changes. Keep replies short and friendly. Never invent facts about the
human's work.

What you can choose from on this computer (use ONLY these):
{context}

Team guidance:
- Default to Claude Code agents (tool "claude"; models "sonnet", "opus", "haiku" or a listed id) unless the human asks
  for another CLI or model. Use another CLI only if it is in "clis".
- One lead (plans, assigns, reviews, merges or writes the final result) plus 1-4 others with clear, different jobs.
  Software: e.g. lead, backend, frontend, qa. Research: e.g. lead, researchers split by topic or region, a fact-checker.
- Agent names: short, lowercase, letters/digits/hyphens, unique (e.g. "lead", "researcher-eu", "qa"). Names are unique
  across all of TropaAI: never use one listed in "taken_agent_names" (add the project's short name instead, e.g. "lead-shop").
- Free models (ending in -free, big-pickle) are rate-limited: spread agents across different ones.
- design_system only for apps with a UI, and only an id from the list (else ""). tools only ids from the list.
- folder: a short lowercase slug for a new folder in {projects_dir}. For an existing folder set "path" (e.g.
  "~/work/app" or a name from "folders" as "{projects_dir}/<name>") and leave folder "".
- brief: a complete markdown brief for the team, written from the conversation (goal, scope, deliverables,
  constraints, definition of done). kickoff: one short message to the lead to start.

Answer with ONE JSON object and nothing else:
{{"reply": "what you say to the human (markdown ok)",
  "plan": null or {{"name": "Project name", "folder": "slug", "path": "", "brief": "markdown",
    "lead": "lead", "agents": [{{"name": "lead", "tool": "claude", "model": "sonnet", "role": "one line"}}],
    "design_system": "", "tools": [], "auto_approve": false, "kickoff": "message to the lead",
    "settings": {{"team_growth": "ask", "auto_agents_per_hour": 2, "team_shrink": "auto"}}}}}}
Put a plan in every answer once you have one (the latest plan wins), with "reply" summarising it in 1-3 sentences."""


def opencode_model_ids():
    """provider/model ids from `opencode models`, whatever its output looks like: one id per line (1.x),
    a table or JSON (2.x). Tries --json first, then plain output; strips colours."""
    ids = set()
    exe = opencode_bin()
    if not exe:
        return ids
    for args in ([exe, "models", "--json"], [exe, "models"]):
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=40, stdin=subprocess.DEVNULL)
        except Exception:
            continue
        out = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", (r.stdout or "") + "\n" + (r.stderr or ""))
        try:   # JSON: a list of ids, of {"id"/"providerID"/"modelID"} objects, or {provider: [models]}
            data = json.loads(r.stdout)
            def walk(x, prov=None):
                if isinstance(x, str) and re.fullmatch(r"[\w.-]+/[\w.:@/-]+", x):
                    ids.add(x)
                elif isinstance(x, dict):
                    p, m = x.get("providerID") or x.get("provider"), x.get("modelID") or x.get("id")
                    if isinstance(p, str) and isinstance(m, str):
                        ids.add(m if "/" in m else f"{p}/{m}")
                    for k, v in x.items():
                        walk(v, k if isinstance(v, (list, dict)) else prov)
                elif isinstance(x, list):
                    for v in x:
                        walk(v, prov)
            walk(data)
        except ValueError:
            for line in out.splitlines():
                m = re.search(r"(?<![\w/.-])([a-z0-9][\w.-]*/[\w.:@-]*[\w])(?![\w/])", line.strip())
                if m and not re.match(r"^(https?|www)", m.group(1)) and "/" in m.group(1):
                    ids.add(m.group(1))
        if ids:
            break
    return {i for i in ids if not i.startswith(("usr/", "home/", "users/", "tmp/"))}


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

    # 4b) Gemini CLI: the models your Gemini API key can use (aliases come from models.conf)
    try:
        k = _keys()
        gk = k.get("gemini")[0] or next((k.get("gemini", p)[0] for p in k.projects("gemini")), "")   # global key, else a project's
        if gk:
            for m in _keys().gemini_models(gk):
                add("gemini", m["id"], m["label"])
    except Exception as e:
        log(f"Gemini models API: {e}")

    # 6) Ollama: local models that can call tools (agents need tools to use the room), as "ollama/<name>"
    try:
        sys.path.insert(0, os.path.join(TROPA_HOME, "kit", ".agent_sync"))
        import ollama_local
        info = ollama_local.models()
        for m in info["models"]:
            label = f"local Ollama · {m['size']}" + ("" if m["tools"] else " · no tool calling, won't work")
            if not m["tools"]:
                continue
            for tool in ("codex", "opencode", "qwen") + (("claude",) if info["claude_ok"] else ()):
                add(tool, "ollama/" + m["name"], label)
    except Exception as e:
        log(f"Ollama: {e}")

    # 7) OpenRouter: tool-capable models for every CLI, as "openrouter/<author>/<slug>" (only once a key is set)
    global OR_ERROR
    try:
        openrouter = _openrouter()
        if openrouter.key("") or _keys().projects("openrouter"):   # the list itself is public; show it once any key is set
            for m in openrouter.models():
                for tool in (c for c in CLIS if c != "gemini"):   # Gemini CLI only talks to Google's API
                    add(tool, "openrouter/" + m["id"], m["label"])
        OR_ERROR = ""
    except Exception as e:
        OR_ERROR = f"couldn't load OpenRouter's model list: {getattr(e, 'reason', e)}"
        log(f"OpenRouter: {e}")

    # 5) OpenCode: its own live list (provider/model, already versioned)
    if opencode_bin():
        try:
            for l in sorted(opencode_model_ids()):
                add("opencode", l)
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
          gemini   Gemini API models list (a global Gemini API key), plus the aliases in models.conf
        """
        now = time.time()
        k = _keys()
        fp = hash((k.get("openrouter")[0], k.get("gemini")[0], tuple(k.projects("openrouter")), tuple(k.projects("gemini"))))   # a new or removed key refreshes the list now
        fresh = 60 if OR_ERROR else 600                              # retry a failed OpenRouter lookup sooner
        if getattr(self, "_models_at", 0) > now - fresh and getattr(self, "_or_fp", None) == fp:
            return self._models
        self._models, self._models_at, self._or_fp = discover_models(), now, fp
        return self._models

    def openrouter_job(self, job):
        """Save (after checking it with OpenRouter) or remove the OpenRouter key sent from the monitor."""
        o = _openrouter()
        res = {"ok": True}
        try:
            if job.get("clear"):
                o.clear_key()
                log("OpenRouter key removed (from the chat)")
            else:
                k = str(job.get("key") or "").strip()
                o.check_key(k)
                o.set_key(k)
                log(f"OpenRouter key saved (from the chat): {o.masked(k)}")
            self._models_at = 0
            self.models()
            res["models"] = sum(1 for m in self._models.get("claude", []) if m["id"].startswith("openrouter/"))
        except ValueError as e:
            res = {"ok": False, "error": str(e)}
        except Exception as e:
            res = {"ok": False, "error": f"couldn't save the key: {e}"}
        res.update({k: v for k, v in openrouter_status().items() if k != "error" or not res.get("error")})
        try:
            self.http(f"/host/secret/{job['id']}", res)
        except Exception as e:
            log(f"could not answer the chat: {e}")

    def key_job(self, job):
        """Save (after checking it with the provider) or remove an API key sent from the monitor: global or for one project."""
        k = _keys()
        prov, proj = job.get("provider") or "openrouter", job.get("project") or None
        res = {"ok": True}
        try:
            if prov not in k.PROVIDERS:
                raise ValueError(f"unknown provider {prov}")
            where = f" for project {slugify(proj)}" if proj else ""
            if job.get("clear"):
                k.clear(prov, slugify(proj) if proj else None)
                log(f"{k.PROVIDERS[prov]['name']} key removed{where} (from the chat)")
            else:
                key = str(job.get("key") or "").strip()
                res["note"] = k.check(prov, key)
                k.set_key(prov, key, slugify(proj) if proj else None)
                log(f"{k.PROVIDERS[prov]['name']} key saved{where} (from the chat): {k.masked(key)}")
                if proj:
                    root = self.project_root(slugify(proj))
                    if root:   # .gemini/settings.json switches to API-key auth on the next start
                        self.run([sys.executable, os.path.join(root, ".agent_sync", "setup_agent.py"), "refresh"], check=False)
            self._models_at = 0
            self.models()
            if prov == "openrouter":
                res["models"] = sum(1 for m in self._models.get("claude", []) if m["id"].startswith("openrouter/"))
            else:
                res["models"] = sum(1 for m in self._models.get("gemini", []) if "your API key" in m.get("label", ""))
        except ValueError as e:
            res = {"ok": False, "error": str(e)}
        except Exception as e:
            res = {"ok": False, "error": f"couldn't save the key: {e}"}
        st = k.status(prov, slugify(proj) if proj else None)
        res.update({"ready": st["ready"], "source": st["source"], "masked": st["masked"]})
        try:
            self.http(f"/host/secret/{job['id']}", res)
        except Exception as e:
            log(f"could not answer the chat: {e}")

    def trust_gemini(self, root):
        """Trust the project in ~/.gemini/trustedFolders.json, so Gemini CLI uses each agent's .gemini/settings.json
        (in an untrusted folder it ignores them, and the tropa tool with them)."""
        p = os.path.expanduser("~/.gemini/trustedFolders.json")
        try:
            d = json.load(open(p)) if os.path.exists(p) else {}
            real = os.path.realpath(root)
            if d.get(real) == "TRUST_FOLDER":
                return
            os.makedirs(os.path.dirname(p), exist_ok=True)
            if os.path.exists(p):
                shutil.copy(p, p + ".bak-tropa")
            d[real] = "TRUST_FOLDER"
            tmp = p + ".tmp-tropa"
            with open(tmp, "w") as f:
                json.dump(d, f, indent=2)
            os.replace(tmp, p)
        except Exception as e:
            log(f"could not pre-trust the Gemini folder: {e}")

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

    # ---------- projects outside the projects folder ----------
    SKIP_HOME = {"Library", "Applications", "Pictures", "Music", "Movies", "Public", "node_modules", "snap", "go", "flutter", "VirtualBox VMs"}

    def scan_roots(self):
        """Folders searched for existing projects: your home (and TROPA_PROJECT_ROOTS, ':'-separated)."""
        roots = [os.path.realpath(os.path.expanduser("~"))]
        for r in os.environ.get("TROPA_PROJECT_ROOTS", "").split(os.pathsep):
            if r.strip():
                roots.append(os.path.realpath(os.path.expanduser(r.strip())))
        return roots

    # external drives (and, in WSL, the Windows drives): allowed, but not searched (they can be slow)
    DRIVES = ["/Volumes"] if sys.platform == "darwin" else ["/media", "/run/media", "/mnt"]
    WINDOWS_SYSTEM = {"windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information"}

    def allowed_roots(self):
        """Folders the chat may adopt projects from: the scanned ones plus external drives."""
        return self.scan_roots() + [os.path.realpath(d) for d in self.DRIVES if os.path.isdir(d)]

    @staticmethod
    def denied(p):
        if sys.platform == "darwin":
            return (f"macOS isn't letting TropaAI open {p}. Open System Settings → Privacy & Security → Files & Folders "
                    f"(or Full Disk Access) and allow the app you started TropaAI from (usually Terminal), "
                    f"then restart TropaAI: tropa stop && tropa start")
        return f"you don't have permission to open {p}"

    def check_path(self, path):
        """Resolve a folder the human typed or picked, and refuse anything that isn't a normal project folder."""
        p = os.path.realpath(os.path.expanduser(str(path or "").strip()))
        home = os.path.realpath(os.path.expanduser("~"))
        if not str(path or "").strip() or not os.path.isabs(os.path.expanduser(str(path).strip())):
            raise RuntimeError("give the folder's full path, e.g. ~/work/my-app")
        try:
            os.listdir(p)   # macOS privacy protection (Documents, Desktop, Downloads…) shows up here, not as "missing"
        except PermissionError:
            raise RuntimeError(self.denied(p))
        except OSError:
            raise RuntimeError(f"{p} isn't a folder on this machine")
        root = next((r for r in self.allowed_roots() if p == r or p.startswith(r + os.sep)), None)
        if not root:
            raise RuntimeError(f"{p} is outside your home folder and external drives; to allow it, add its parent to TROPA_PROJECT_ROOTS and restart the host helper")
        rel = os.path.relpath(p, root).split(os.sep)
        drive = root in [os.path.realpath(d) for d in self.DRIVES]
        if p in (home, root, self.projects_dir) or p == "/" or (drive and (os.path.ismount(p) or (os.path.basename(root) != "Volumes" and len(rel) < 2))):
            raise RuntimeError(f"{p} is a whole drive or folder of folders, not a project; pick the project folder inside it")
        if any(x.startswith(".") for x in rel) or (root == home and rel[0] in self.SKIP_HOME) \
                or (drive and os.path.basename(root) == "mnt" and len(rel) > 1 and rel[1].lower() in self.WINDOWS_SYSTEM):
            raise RuntimeError(f"{p} is a hidden or system folder; tropa won't set up a team there")
        return p

    def check_parent(self, path):
        """Where a new project folder is created, when not in projects_dir: a folder in your home or on an
        external drive (created if missing), never a hidden or system folder."""
        raw = str(path or "").strip()
        if not raw or not os.path.isabs(os.path.expanduser(raw)):
            raise RuntimeError("give the full path of where to create it, e.g. ~/Documents")
        p = os.path.realpath(os.path.expanduser(raw))
        home = os.path.realpath(os.path.expanduser("~"))
        root = next((r for r in self.allowed_roots() if p == r or p.startswith(r + os.sep)), None)
        if not root:
            raise RuntimeError(f"{p} is outside your home folder and external drives; to allow it, add it to TROPA_PROJECT_ROOTS and restart the host helper")
        rel = [] if p == root else os.path.relpath(p, root).split(os.sep)
        drive = root in [os.path.realpath(d) for d in self.DRIVES]
        if any(x.startswith(".") for x in rel) or (root == home and rel and rel[0] in self.SKIP_HOME) \
                or (drive and os.path.basename(root) == "mnt" and len(rel) > 1 and rel[1].lower() in self.WINDOWS_SYSTEM):
            raise RuntimeError(f"{p} is a hidden or system folder; pick another place for the project")
        if drive and p == root:
            raise RuntimeError(f"{p} holds the drives themselves; pick a drive or a folder on one")
        if os.path.exists(p) and not os.path.isdir(p):
            raise RuntimeError(f"{p} is a file, not a folder")
        try:
            os.makedirs(p, exist_ok=True)
            os.listdir(p)
        except PermissionError:
            raise RuntimeError(self.denied(p))
        except OSError as e:
            raise RuntimeError(f"can't use {p}: {e.strerror or e}")
        return p

    # ---------- the computer's own folder picker: a web page can't learn a folder's path, the host can ----------
    def pick_folder(self, job):
        try:
            parent = job.get("purpose") == "parent"
            path = self.folder_dialog("Choose where to create the project folder" if parent else "Choose your project folder", new=parent)
            res = {"ok": False, "cancelled": True} if not path else {"ok": True, "path": (self.check_parent if parent else self.check_path)(path)}
        except Exception as e:
            res = {"ok": False, "error": str(e)[:400]}
        try:
            self.http(f"/host/picked/{job['id']}", res)
        except Exception as e:
            log(f"could not send the picked folder: {e}")

    def folder_dialog(self, title="Choose your project folder", new=False):
        """Show the system's folder chooser on this machine; the chosen folder, or None if cancelled.
        new: offer a New Folder button where the system's dialog has one (choosing where to create a project)."""
        home = os.path.expanduser("~")
        if sys.platform == "darwin":
            loc = home.replace("\\", "\\\\").replace('"', '\\"')
            r = subprocess.run(["osascript", "-e", "activate", "-e",
                                f'POSIX path of (choose folder with prompt "{title}" default location (POSIX file "{loc}"))'],
                               capture_output=True, text=True, timeout=900)
            if r.returncode != 0:
                if "-128" in r.stderr:   # Cancel
                    return None
                raise RuntimeError(r.stderr.strip()[-200:] or "the folder picker didn't open")
            return r.stdout.strip().rstrip("/") or None
        if os.environ.get("WSL_DISTRO_NAME") and shutil.which("powershell.exe"):   # Windows' own dialog, starting in your Linux home
            start = subprocess.run(["wslpath", "-w", home], capture_output=True, text=True).stdout.strip().replace("'", "''")
            ps = ("Add-Type -AssemblyName System.Windows.Forms;"
                  "$f=New-Object System.Windows.Forms.Form -Property @{TopMost=$true};"
                  "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
                  f"$d.Description='{title}';$d.ShowNewFolderButton=${'true' if new else 'false'};$d.SelectedPath='{start}';"
                  "if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}")
            r = subprocess.run(["powershell.exe", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True, timeout=900)
            win = r.stdout.strip()
            return subprocess.run(["wslpath", "-u", win], capture_output=True, text=True).stdout.strip() or None if win else None
        if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            for cmd in (["zenity", "--file-selection", "--directory", f"--title={title}", f"--filename={home}/"],
                        ["kdialog", "--getexistingdirectory", home, "--title", title]):
                if shutil.which(cmd[0]):
                    return subprocess.run(cmd, capture_output=True, text=True, timeout=900).stdout.strip() or None   # Cancel: no output
        raise RuntimeError("this machine has no folder picker the host helper can open (it needs a desktop with zenity or kdialog); type the folder's path instead")

    @staticmethod
    def has_picker():
        """Can folder_dialog show a chooser here (so the chat offers Browse…)?"""
        if sys.platform == "darwin":
            return True
        if os.environ.get("WSL_DISTRO_NAME"):
            return bool(shutil.which("powershell.exe"))
        return bool((os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and (shutil.which("zenity") or shutil.which("kdialog")))

    def elsewhere(self):
        """Git repos (and tropa projects) under your home, outside the projects folder: offered as existing projects."""
        now = time.time()
        if getattr(self, "_elsewhere_at", 0) > now - 300:
            return self._elsewhere
        out, seen, deadline = [], set(), now + 2.5
        home = os.path.realpath(os.path.expanduser("~"))
        blocked = set()
        reg = self.registry()
        for path in reg.values():
            if os.path.isdir(path):
                seen.add(path)
        def walk(d, depth):
            if time.time() > deadline or len(seen) > 200:
                return
            try:
                entries = sorted(os.scandir(d), key=lambda e: e.name.lower())
            except PermissionError:
                if sys.platform == "darwin" and os.path.dirname(d) == home:
                    blocked.add(os.path.basename(d))   # Documents, Desktop…: macOS privacy protection
                return
            except OSError:
                return
            for e in entries:
                if not e.is_dir(follow_symlinks=False) or e.name.startswith(".") or e.name in self.SKIP_HOME:
                    continue
                p = os.path.realpath(e.path)
                if p == self.projects_dir:
                    continue
                if os.path.isdir(os.path.join(p, ".git")) or os.path.isdir(os.path.join(p, ".agent_sync")):
                    seen.add(p)
                elif depth < 3:
                    walk(p, depth + 1)
        for r in self.scan_roots():
            walk(r, 1)
        self.blocked = sorted(blocked)
        for p in sorted(seen, key=str.lower)[:200]:
            if os.path.dirname(p) == self.projects_dir:
                continue
            kit = os.path.exists(os.path.join(p, ".agent_sync", "config.py"))
            slug = ""
            if kit:
                try:
                    slug = json.load(open(os.path.join(p, ".agent_sync", "settings.json"))).get("project") or ""
                except Exception:
                    pass
            out.append({"name": os.path.basename(p), "path": p, "display": "~" + p[len(home):] if p.startswith(home + os.sep) else p,
                        "kit": kit, "git": os.path.isdir(os.path.join(p, ".git")), "slug": slugify(slug or os.path.basename(p))})
        self._elsewhere, self._elsewhere_at = out, now
        return out

    def registry(self):
        """slug -> folder of projects this helper set up (so add-agent / delete find them wherever they are)."""
        try:
            return json.load(open(os.path.expanduser(f"~/.tropa/projects-{self.port}.json")))
        except (OSError, ValueError):
            return {}

    def remember(self, slug, root):
        reg = self.registry(); reg[slug] = root
        try:
            os.makedirs(os.path.expanduser("~/.tropa"), exist_ok=True)
            json.dump(reg, open(os.path.expanduser(f"~/.tropa/projects-{self.port}.json"), "w"), indent=1)
        except OSError as e:
            log(f"could not save the project list: {e}")

    def __init__(self, server, projects_dir):
        self.server = server.rstrip("/")
        self.projects_dir = os.path.realpath(os.path.expanduser(projects_dir))
        self.port = urllib.parse.urlparse(self.server).port or 80
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import shares
        self.ngrok_info = shares.ngrok_info
        self.shares = shares.Shares(self.port, self.report_share, log)
        self.usage_on = os.environ.get("TROPA_USAGE", "1") != "0"
        self.usage_at, self.usage_sent, self.usage_busy = 0, None, False

    def usage_tick(self, every=int(os.environ.get("TROPA_USAGE_INTERVAL", "60"))):
        """Every minute, read new lines from the CLIs' logs in the background and send changed totals."""
        if not self.usage_on or self.usage_busy or time.time() - self.usage_at < every:
            return
        self.usage_busy, self.usage_at = True, time.time()
        def work():
            try:
                import usage
                c = usage.Collector(os.path.expanduser(f"~/.tropa/usage-{self.port}.json"))
                c.scan()
                rows = c.rows()
                sig = json.dumps(rows, sort_keys=True)
                if sig != self.usage_sent:
                    as_of = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "prices.json"))).get("_as_of", "")
                    self.http("/host/usage", {"rows": rows, "prices_as_of": as_of}, timeout=60)
                    self.usage_sent = sig
            except Exception as e:
                log(f"usage: {e}")
            finally:
                self.usage_busy = False
        threading.Thread(target=work, daemon=True).start()

    def report_share(self, sid, status, **extra):
        try:
            self.http(f"/host/shares/{sid}", {"status": status, **{k: v for k, v in extra.items() if v}})
        except Exception as e:
            log(f"could not report share #{sid}: {e}")

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

    def reap(self, root, agent=None):
        """Stop the dev servers and shells an agent (or the whole team) started: they outlive the tmux window.
        Uses the project's own reap.py; a kit from before it has none (tropa update adds it)."""
        script = os.path.join(root, ".agent_sync", "reap.py")
        if os.path.isfile(script):
            r = self.run([sys.executable, script, *(["agent", agent] if agent else ["session"])], check=False)
            if r.stdout.strip():
                log(r.stdout.strip())

    def cfg(self, root, key):
        return self.run([sys.executable, os.path.join(root, ".agent_sync", "config.py"), "get", key]).stdout.strip()

    def setc(self, root, key, value):
        self.run([sys.executable, os.path.join(root, ".agent_sync", "config.py"), "set", key, json.dumps(value)])

    # ---------- create_project ----------
    def create_project(self, job):
        folder = job["folder"]
        existing = bool(job.get("existing"))
        if job.get("path"):            # an existing project anywhere in your home folder
            root, existing = self.check_path(job["path"]), True
        else:
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", folder) or set(folder) == {"."}:
                raise RuntimeError("invalid folder name")
            root = os.path.join(self.check_parent(job["parent"]) if job.get("parent") else self.projects_dir, folder)
        if existing:
            if not os.path.isdir(root):
                raise RuntimeError(f"{root} doesn't exist")
        elif os.path.exists(root) and os.listdir(root) and not os.path.exists(os.path.join(root, ".agent_sync")):
            raise RuntimeError(f"{root} already exists and isn't empty — pick another folder name, or choose it as an existing folder")
        os.makedirs(self.projects_dir, exist_ok=True)
        os.makedirs(root, exist_ok=True)
        self._folders_at = 0; self._elsewhere_at = 0
        self.remember(job["slug"], root)
        self.report(job, f"📁 {'Adding the team kit to' if existing else 'Setting up'} `{root}` …", status="running", folder=root)

        # new projects start as a git repo on `main`, so developers can work on branches/worktrees
        if job.get("git", True) and not existing and not os.path.isdir(os.path.join(root, ".git")):
            if git_version():
                os.makedirs(root, exist_ok=True)
                if self.run(["git", "init", "-q", "-b", "main", root], check=False).returncode != 0:
                    self.run(["git", "init", "-q", root], check=False)
                    self.run(["git", "-C", root, "symbolic-ref", "HEAD", "refs/heads/main"], check=False)
            else:
                self.report(job, f"⚠️ git isn't installed on this machine, so the project isn't a git repo and the team can't use branches/worktrees. "
                                 f"Install it ({git_hint()}), then run `git -C {root} init -b main`, commit, and `tropa update {root}`.")
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
            self.initial_commit(job, root, existing)
            self.report(job, f"✅ Project ready at `{root}`. No agents yet — add them with `tropa panel {root}`.", status="done")
            return

        tools = {a["tool"] for a in agents}
        missing = [t for t in tools if not shutil.which(t)]
        if missing:
            self.report(job, f"⚠️ Not installed on this machine: {', '.join(missing)}. Those agents won't start until it is.")
        if "claude" in tools and shutil.which("claude"):
            helptext = self.run(["claude", "--help"], check=False).stdout
            self.setc(root, "tool_flags.claude", "--permission-mode auto" if '"auto"' in helptext else "--permission-mode acceptEdits")

        if job.get("auto_approve"):
            self.setc(root, "auto_approve", True)
            self.report(job, "⚡ Auto-approve is on: agents run without permission prompts.")
        if job.get("design_system"):
            import design_systems
            self.report(job, "🎨 Design system: " + design_systems.use(job["design_system"], root) + ".")
        if job.get("tools"):
            self.setc(root, "tools", job["tools"])
            names = {t["id"]: t["name"] for t in tools_catalog()}
            self.report(job, "🧰 Tools: " + ", ".join(f"{names.get(t['id'], t['id'])} → {'everyone' if t['agents'] == '*' else ', '.join('@' + n for n in t['agents'])}"
                                                     for t in job["tools"]) + ". Each needs a one-time sign-in in the agent's terminal unless its token is set — see the agent's instructions.")
        setup = os.path.join(root, ".agent_sync", "setup_agent.py")
        self.setc(root, "trust_agent_folders", job.get("trust") is not False)   # the kit keeps the CLIs' folder trust on every start
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
            if a.get("prompt"):   # the job from a ready-made team (teams/<id>/<name>.md), kept in AGENT.md
                args += ["--prompt", a["prompt"]]
            self.run(args)
        if job.get("lead"):
            self.setc(root, "lead", job["lead"])
        for prov, key in (job.get("keys") or {}).items():   # this project's own API keys (saved outside the folder)
            try:
                k = _keys()
                k.check(prov, key)
                k.set_key(prov, key, job["slug"])
                self.report(job, f"🔑 Saved this project's own {k.PROVIDERS[prov]['name']} key ({k.masked(key)}) in `~/.config/tropa/keys/{job['slug']}/`, outside the project folder.")
            except Exception as e:
                self.report(job, f"⚠️ Didn't save the {prov} key: {e}. Agents use your global key or sign-in instead; set it later in 🔑 Keys.")
        self.run([sys.executable, setup, "refresh"])
        lead = f" — lead: @{job['lead']}" if job.get("lead") else ""
        self.report(job, "🤖 Created agents: " + ", ".join(f"@{a['name']} ({a['tool']}{' · ' + a['model'] if a.get('model') else ''})" for a in agents) + lead + ".")

        self.initial_commit(job, root, existing)
        if job.get("trust") and "claude" in tools:
            self.trust_claude(root, [a["name"] for a in agents if a["tool"] == "claude"])
        if job.get("trust") and "codex" in tools:
            self.trust_codex(root)
        if job.get("trust") and "gemini" in tools:
            self.trust_gemini(root)

        if not job.get("start"):
            self.report(job, f"✅ Project ready at `{root}`. Start the team with `tropa panel {root}` (option 3).", status="done")
            return

        session = self.cfg(root, "tmux_session")
        self.run([os.path.join(root, ".agent_sync", "start_agent.sh"), "--all"])
        self.ensure_watcher(root, session)
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

    def initial_commit(self, job, root, existing):
        if existing or not os.path.isdir(os.path.join(root, ".git")):
            return
        human = job.get("human") or "human"
        self.run(["git", "-C", root, "add", "-A"], check=False)
        c = self.run(["git", "-C", root, "-c", f"user.name={human}", "-c", f"user.email={human.lower()}@tropa.local",
                      "commit", "-q", "-m", f"Start {job['name']}: brief, attachments and team kit"], check=False)
        if c.returncode == 0:
            self.report(job, "🌿 Git repo on `main` with a first commit — developers work on branches (worktrees when several work at once); the lead reviews, QA tests, the lead merges.")

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

    # ---------- add_agent: a new teammate for a running project ----------
    def project_root(self, slug):
        """The folder of the project whose room is project:<slug> (projects this helper set up, then the projects folder)."""
        r = self.registry().get(slug)
        if r and os.path.isfile(os.path.join(r, ".agent_sync", "settings.json")):
            return r
        for d in sorted(glob.glob(os.path.join(self.projects_dir, "*", ".agent_sync", "settings.json"))):
            root = os.path.dirname(os.path.dirname(d))
            try:
                st = json.load(open(d))
            except (OSError, ValueError):
                continue
            if slugify(st.get("project") or os.path.basename(root)) == slug:
                return root
        return None

    def add_agent(self, job):
        slug, a = job["slug"], job["agent"]
        root = self.project_root(slug)
        if not root:
            raise RuntimeError(f"no project folder for `{slug}` in {self.projects_dir} (projects started elsewhere: use `tropa panel` there)")
        if os.path.exists(os.path.join(root, "agents", a["name"], "agent.json")):
            raise RuntimeError(f"`{a['name']}` already exists in this project")
        src = a.get("clone_of") or ""
        if src:   # a copy of a teammate: anything not given comes from its agent.json
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", src) or src.startswith("."):
                raise RuntimeError(f"invalid agent name `{src}`")
            try:
                with open(os.path.join(root, "agents", src, "agent.json")) as f:
                    orig = json.load(f)
            except (OSError, ValueError):
                raise RuntimeError(f"can't read agents/{src}/agent.json to copy @{src}")
            a = {**a, "tool": a.get("tool") or orig.get("tool", "claude"), "model": a.get("model") or orig.get("model", ""),
                 "role": a.get("role") or orig.get("role", ""), "instruction": a.get("instruction") or orig.get("instruction", "")}
        lead = self.cfg(root, "lead")
        role = a.get("role") or f"{a['name']} on {slug}"
        instr = a.get("instruction") or (f"You joined the team after it started. Read .agent_sync/TEAM.md, docs/ and the recent room history, "
                                         f"then ask {'@' + lead if lead else 'the human'} for your first task (one message) and wait for it.")
        setup = os.path.join(root, ".agent_sync", "setup_agent.py")
        self.run([sys.executable, setup, "create", a["name"], a["tool"], role, instr, a.get("model") or ""])
        self.run([sys.executable, setup, "refresh"])            # TEAM.md and everyone's roster now list the newcomer
        if a["tool"] == "claude" and job.get("trust"):
            self.trust_claude(root, [a["name"]])
        if a["tool"] == "codex" and job.get("trust"):
            self.trust_codex(root)
        if a["tool"] == "gemini" and job.get("trust"):
            self.trust_gemini(root)
        desc = f"@{a['name']} ({a['tool']}{' · ' + a['model'] if a.get('model') else ''}), {role}" + (f" (a copy of @{src})" if src else "")
        if not job.get("start", True):
            self.report(job, f"➕ Added {desc}. Start it with `tropa panel {root}` (option 4).", status="done")
            return
        if not shutil.which(a["tool"]):
            self.report(job, f"⚠️ `{a['tool']}` isn't installed on this machine, so @{a['name']} can't start yet.")
        session = self.cfg(root, "tmux_session")
        self.run([os.path.join(root, ".agent_sync", "start_agent.sh"), a["name"]])
        self.ensure_watcher(root, session)
        self.report(job, f"➕ Added {desc} and started it in `{session}`." + (f" @{lead} has been told." if lead else ""), status="done")
        if lead:
            time.sleep(3)   # let the watcher see the new window first
            try:
                self.http(f"/rooms/{urllib.parse.quote(job['room_id'], safe='')}/wake",
                          {"agents": [lead], "reason": f"New teammate @{a['name']} ({role}) joined the team; .agent_sync/TEAM.md is updated. Give them work with an @mention when there is some."})
            except Exception as e:
                log(f"could not wake @{lead}: {e}")

    # ---------- project_chat: the "New project" setup chat, answered by Claude Code (no tools, no saved session) ----------
    def project_chat(self, job):
        def answer(**res):
            try:
                self.http(f"/host/chat/{job['id']}", res, timeout=30)
            except Exception as e:
                log(f"could not answer the setup chat: {e}")
        exe = shutil.which("claude")
        if not exe:
            return answer(ok=False, error="Claude Code is not installed on this computer")
        ctx = job.get("context") or {}
        system = CHAT_SYSTEM.format(human=ctx.get("human") or "the human", projects_dir=ctx.get("projects_dir") or "~/projects",
                                    context=json.dumps({k: v for k, v in ctx.items() if k not in ("human",)}, indent=1)[:30000])
        convo = "\n\n".join(f"{'HUMAN' if m.get('role') != 'assistant' else 'YOU (earlier answer)'}: {m.get('content', '')}"
                             for m in (job.get("messages") or [])[-40:])
        prompt = f"The conversation so far:\n\n{convo}\n\nAnswer the human's last message with the JSON object."
        env = dict(os.environ)
        tok = os.path.expanduser("~/.config/tropa/claude.token")   # the long-lived login from `tropa claude-token set`
        if not env.get("CLAUDE_CODE_OAUTH_TOKEN") and os.path.isfile(tok):
            env["CLAUDE_CODE_OAUTH_TOKEN"] = open(tok).read().strip()
        import tempfile
        with tempfile.TemporaryDirectory(prefix="tropa-chat-") as cwd:   # an empty folder: nothing of yours to read
            base = [exe, "-p", prompt, "--output-format", "json", "--system-prompt", system]
            for extra in (["--tools", "", "--no-session-persistence"], ["--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task"]):
                try:
                    r = subprocess.run(base + extra, cwd=cwd, env=env, capture_output=True, text=True, timeout=200, stdin=subprocess.DEVNULL)
                except subprocess.TimeoutExpired:
                    return answer(ok=False, error="Claude didn't answer within 200 seconds")
                out = (r.stdout or "").strip()
                if r.returncode != 0 and re.search(r"unknown option|unrecognized", (r.stderr or "") + out, re.I):
                    continue   # an older Claude Code without --tools: try the other way
                break
        try:
            d = json.loads(out)
        except ValueError:
            d = {"result": out, "is_error": r.returncode != 0}
        text = str(d.get("result") or "")
        if d.get("is_error") or r.returncode != 0:
            err = (text or r.stderr or "Claude Code failed").strip()[-500:]
            auth = bool(re.search(r"login|log in|authenticat|api key|oauth|credit balance", err, re.I))
            return answer(ok=False, error=err, auth=auth)
        answer(ok=True, text=text)

    # ---------- remove_agent: the human removed an agent in the chat, so end it here too ----------
    def remove_agent(self, job):
        slug, a = job["slug"], str(job.get("agent") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", a) or a.startswith("."):
            raise RuntimeError(f"invalid agent name `{a}`")
        root = self.project_root(slug)
        if not root:
            raise RuntimeError(f"I can't find the folder for `{slug}`, so @{a}'s tmux window and files are untouched")
        session = job.get("tmux_session") or self.cfg(root, "tmux_session") or f"ai-{slug}"
        done = []
        have = self.run(["tmux", "list-windows", "-t", f"={session}", "-F", "#{window_name}"], check=False).stdout.split()
        if a in have:
            self.reap(root, a)
            self.run(["tmux", "kill-window", "-t", f"={session}:={a}"], check=False)
            done.append(f"stopped its window in `{session}`")
        src = os.path.join(root, "agents", a)
        if os.path.isdir(src):
            dst = os.path.join(root, "agents", ".removed", f"{a}-{time.strftime('%Y%m%d-%H%M%S')}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            done.append(f"moved its folder to `agents/.removed/{os.path.basename(dst)}/` (delete it whenever you like)")
        sync = os.path.join(root, ".agent_sync")
        if str(self.cfg(root, "lead") or "").lower() == a.lower():
            self.setc(root, "lead", "")
            done.append("cleared it as lead")
        self.run([sys.executable, os.path.join(sync, "setup_agent.py"), "refresh"], check=False)   # TEAM.md + rosters without it
        self.report(job, f"🗑 Removed @{a}: " + ("; ".join(done) if done else "it wasn't running and had no folder here") + ". TEAM.md is updated.", status="done")

    def rename_agent(self, job):
        """Rename an agent's folder, configs and tmux window (the project kit's `setup_agent.py rename`)."""
        slug, old, new = job["slug"], str(job.get("agent") or ""), str(job.get("new_name") or "")
        for x in (old, new):
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", x) or x.startswith("."):
                raise RuntimeError(f"invalid agent name `{x}`")
        root = self.project_root(slug)
        if not root:
            raise RuntimeError(f"I can't find the folder for `{slug}`, so agents/{old}/ keeps its old name")
        tool = os.path.join(root, ".agent_sync", "setup_agent.py")
        try:
            kit_ok = "rename_agent" in open(tool).read()
        except OSError:
            kit_ok = False
        if not kit_ok:
            raise RuntimeError(f"this project's kit is older than renaming; run `tropa update` in {root}, then rename @{new} again")
        r = self.run([sys.executable, tool, "rename", old, new], check=False)
        out = (r.stdout.strip() or r.stderr.strip()[-300:] or "done")
        if r.returncode != 0:
            raise RuntimeError(out)
        self.report(job, f"✏️ `{old}` → `{new}` on this machine: {out}.", status="done")

    def ensure_watcher(self, root, session):
        """Start the room watcher in the team's tmux session, or restart it if its window is there but it stopped."""
        cmd = f"python3 {os.path.join(root, '.agent_sync', 'room_watcher.py')}; read -p 'watcher stopped — Enter to close'"
        if self.run(["tmux", "has-session", "-t", f"={session}"], check=False).returncode != 0:
            self.run(["tmux", "new-session", "-d", "-s", session, "-n", "ControlCenter", "-c", root])
        have = self.run(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"], check=False).stdout.split()
        if "watcher" not in have:
            self.run(["tmux", "new-window", "-d", "-t", session, "-n", "watcher", "-c", root, cmd])
            return "started"
        if not self.watcher_alive(session):
            self.run(["tmux", "respawn-window", "-k", "-t", f"{session}:watcher", "-c", root, cmd])
            return "restarted"
        return "running"

    # ---------- self-healing: keep running teams running (and the chat's "Fix the team" button) ----------
    HEAL_EVERY = 30       # seconds between automatic checks
    HEAL_QUIET = 90       # after any team job (create, add, remove, rename…): leave the team alone this long
    HEAL_LIMIT = {"watcher": 3, "agent": 2}   # automatic restarts per hour; after that, say so once and stop trying

    def team_roots(self):
        """slug -> folder for every project on this machine that has a team kit."""
        roots = {}
        for d in glob.glob(os.path.join(self.projects_dir, "*", ".agent_sync", "settings.json")):
            root = os.path.dirname(os.path.dirname(d))
            try:
                roots[slugify(json.load(open(d)).get("project") or os.path.basename(root))] = root
            except (OSError, ValueError):
                pass
        for slug, root in self.registry().items():
            if os.path.isfile(os.path.join(root, ".agent_sync", "settings.json")):
                roots[slugify(slug)] = root
        return roots

    def watcher_alive(self, session):
        """Is room_watcher.py running in the team's watcher window? The window runs it through a shell
        (`python3 room_watcher.py; read -p …`) that outlives it, so look for the python process itself."""
        pid = (self.run(["tmux", "list-panes", "-t", f"={session}:=watcher", "-F", "#{pane_pid}"], check=False).stdout.split() or [""])[0]
        if not pid.isdigit():
            return False
        for line in self.run(["ps", "-ax", "-o", "pid=,ppid=,args="], check=False).stdout.splitlines():
            f = line.split(None, 2)
            if len(f) == 3 and pid in (f[0], f[1]) and "room_watcher.py" in f[2] and "python" in f[2].split()[0] and "read -p" not in f[2]:
                return True
        return False

    def heal(self, slug, root, force=False):
        """Restart what died in a running team: the room watcher, agents whose CLI crashed (stopped on its error screen)
        or whose window is gone. Returns (fixed, stuck) lists, or None when the team isn't running (tmux session gone:
        it was stopped, or the machine restarted). Starting a stopped team costs money, so that's the human's call."""
        session = self.cfg(root, "tmux_session")
        if not session or self.run(["tmux", "has-session", "-t", f"={session}"], check=False).returncode != 0:
            return None
        now, hist = time.time(), self._heals.setdefault(slug, {})
        def allowed(key, kind):
            hist[key] = [t for t in hist.get(key, []) if now - t < 3600]
            if force or len(hist[key]) < self.HEAL_LIMIT[kind]:
                hist[key].append(now)
                return True
            return False
        fixed, stuck = [], []
        wins = {}
        for line in self.run(["tmux", "list-windows", "-t", f"={session}", "-F", "#{window_name}\t#{pane_dead}"], check=False).stdout.splitlines():
            name, _, dead = line.partition("\t")
            wins[name] = dead == "1"
        adir = os.path.join(root, "agents")
        for a in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
            if a.startswith(".") or not os.path.isfile(os.path.join(adir, a, "agent.json")):
                continue
            if a in wins:
                screen = self.run(["tmux", "capture-pane", "-p", "-t", f"={session}:={a}", "-S", "-15"], check=False).stdout
                if not wins[a] and "Press Enter to close this window" not in screen:
                    continue   # running (busy, idle or waiting for someone: the watcher handles those)
                why = "it had crashed"
            else:
                why = "it had stopped"
            if allowed(a, "agent"):
                r = self.run([os.path.join(root, ".agent_sync", "start_agent.sh"), a], check=False)
                (fixed if r.returncode == 0 else stuck).append((a, why))
            else:
                stuck.append((a, why))
        if not self.watcher_alive(session):
            if allowed("watcher", "watcher"):
                self.ensure_watcher(root, session)
                fixed.append(("watcher", "it had stopped"))
            else:
                stuck.append(("watcher", "it keeps stopping"))
        return fixed, stuck

    def heal_say(self, slug, fixed, stuck, force=False):
        human = getattr(self, "human", "") or "human"
        who = lambda n: "the room watcher" if n == "watcher" else f"@{n}"
        lines = []
        if fixed:
            lines.append("🩺 Fixed the team: restarted " + ", ".join(f"{who(n)} ({why})" for n, why in fixed)
                         + ". Restarted agents pick up their conversation where they left off.")
        hist = self._heals.setdefault(slug, {})
        new_stuck = [(n, why) for n, why in stuck if force or time.time() - hist.get("warned:" + n, 0) > 3600]
        for n, _ in new_stuck:
            hist["warned:" + n] = time.time()
        if new_stuck:
            many = len(new_stuck) > 1
            lines.append(f"@{human} ⚠️ " + ", ".join(who(n) for n, _ in new_stuck) + (" keep" if many else " keeps") + " stopping, so I've stopped "
                         + ("restarting them" if many else "restarting it") + " for now. "
                         "In Advanced mode, ▦ Team shows its screen with the error; or press **Fix the team** to try again.")
        if force and not lines:
            lines.append("🩺 Checked the team: everyone is running.")
        if lines:
            try:
                self.http("/watch/say", {"room": f"project:{slug}", "content": "\n".join(lines)})
            except Exception as e:
                log(f"[{slug}] could not post the team check: {e}")

    def heal_lock(self):
        """Only one host helper per port heals (two would double every restart and message): hold a lock file."""
        if getattr(self, "_heal_lock", None) is None:
            import fcntl
            path = os.path.expanduser(f"~/.tropa/heal-{self.port}.lock")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            f = open(path, "w")
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._heal_lock = f
            except OSError:
                f.close()
                self._heal_lock = False
                log("another host helper for this port is already keeping teams running; this one won't")
        return bool(self._heal_lock)

    def heal_all(self):
        """The automatic check, every HEAL_EVERY seconds in the background."""
        try:
            if time.time() - self._last_job_at < self.HEAL_QUIET or not self.heal_lock():
                return
            for slug, root in self.team_roots().items():
                res = self.heal(slug, root)
                if res and (res[0] or res[1]):
                    log(f"[{slug}] healed: {res[0]} stuck: {res[1]}")
                    self.heal_say(slug, *res)
        except Exception as e:
            log(f"team check failed: {e}")
        finally:
            self._healing = False

    def fix_team(self, job):
        """The chat's "Fix the team": check now (no hourly limits), or start the team if it isn't running."""
        slug = job["slug"]
        root = self.project_root(slug)
        if not root:
            raise RuntimeError(f"I can't find the folder for `{slug}`. Run `tropa update` in that folder once (it registers it), then try again.")
        res = self.heal(slug, root, force=True)
        if res is None:
            self.report(job, "🩺 The team wasn't running, so I'm starting it.", status="running")
            return self.start_team(job)
        self.heal_say(slug, *res, force=True)
        self.report(job, status="done")

    # ---------- start_team: the chat's "Start the team" button ----------
    def start_team(self, job):
        slug = job["slug"]
        root = self.project_root(slug)
        if not root:
            raise RuntimeError(f"I can't find the folder for `{slug}`. Run `tropa update` in that folder once (it registers it), then try again.")
        session = self.cfg(root, "tmux_session")
        self.report(job, f"▶ Starting the team in `{root}`…")
        self.run([os.path.join(root, ".agent_sync", "start_agent.sh"), "--all"])
        w = self.ensure_watcher(root, session)
        self.report(job, f"🚀 Team {'started' if w != 'running' else 'is running'} in tmux session `{session}`{' (the room watcher had stopped; restarted it)' if w == 'restarted' else ''}. The screens appear in **▦ Team** in a few seconds.", status="done")

    # ---------- stop_project: the chat deleted a project, so end its team (files are never touched) ----------
    def stop_project(self, job):
        slug = slugify(job.get("slug") or "")
        names = {s for s in [job.get("tmux_session"), f"ai-{slug}"] if s and re.match(r"^[A-Za-z0-9._-]{1,80}$", s)}
        extra = self.registry().get(slug)
        roots = {}
        for d in glob.glob(os.path.join(self.projects_dir, "*", ".agent_sync", "settings.json")) + ([os.path.join(extra, ".agent_sync", "settings.json")] if extra else []):
            try:
                st = json.load(open(d))
            except (OSError, ValueError):
                continue
            if slugify(st.get("project") or os.path.basename(os.path.dirname(os.path.dirname(d)))) == slug and st.get("tmux_session"):
                names.add(st["tmux_session"]); roots[st["tmux_session"]] = os.path.dirname(os.path.dirname(d))
        for n in sorted(names):
            if subprocess.run(["tmux", "has-session", "-t", f"={n}"], capture_output=True).returncode == 0:
                if n in roots:
                    self.reap(roots[n])
                subprocess.run(["tmux", "kill-session", "-t", f"={n}"], capture_output=True)
                log(f"[{slug}] project deleted in the chat: stopped tmux session {n}")

    # ---------- loop ----------
    def loop(self):
        log(f"tropa host helper {VERSION} → {self.server}; projects in {self.projects_dir}")
        self._heals, self._heal_at, self._healing, self._last_job_at = {}, time.time(), False, 0.0
        ok = None
        while True:
            try:
                r = self.http("/host/poll", {"projects_dir": self.projects_dir, "home": os.path.expanduser("~"),
                                              "version": VERSION, "clis": [c for c in CLIS if (opencode_bin() if c == "opencode" else shutil.which(c))],
                                              "openrouter": openrouter_ready(), "openrouter_info": openrouter_status(), "keys": keys_status(), "claude": claude_status(),
                                              "models": self.models(), "folders": self.folders(), "elsewhere": self.elsewhere(),
                                              "blocked": getattr(self, "blocked", []), "picker": self.has_picker(),
                                              "git": git_version(), "git_hint": git_hint(), "tools": tools_catalog(),
                                              "design_systems": design_catalog(), "teams": teams_catalog(),
                                              "ngrok": self.ngrok_info(), "shares": self.shares.ids(), "usage": self.usage_on,
                                              "timeout": 20}, timeout=35)
                if ok is not True:
                    log("connected"); ok = True
                    self.usage_sent, self.usage_at = None, 0     # (re)send usage to a server that may have restarted
            except Exception as e:
                if ok is not False:
                    log(f"server not reachable ({e}); retrying"); ok = False
                time.sleep(5)
                continue
            for sid in r.get("stop_shares") or []:
                self.shares.stop(sid, "the chat server doesn't know this link")
            self.shares.tick()
            self.usage_tick()
            if r.get("jobs"):
                self._last_job_at = time.time()
            self.human = r.get("human") or getattr(self, "human", "")
            if time.time() - self._heal_at > self.HEAL_EVERY and not self._healing:
                self._heal_at, self._healing = time.time(), True
                threading.Thread(target=self.heal_all, daemon=True).start()
            for job in r.get("jobs") or []:
                if job.get("type") == "fix_team":
                    try:
                        self.fix_team(job)
                    except Exception as e:
                        self.report(job, f"❌ Couldn't fix the team: {e}", status="failed")
                    continue
                if job.get("type") == "openrouter_key":
                    self.openrouter_job(job); continue
                if job.get("type") == "api_key":
                    self.key_job(job); continue
                if job.get("type") == "pick_folder":   # waits for you in the dialog: don't hold up other jobs
                    threading.Thread(target=self.pick_folder, args=(job,), daemon=True).start(); continue
                if job.get("type") == "project_chat":   # can take a while: don't hold up other jobs
                    threading.Thread(target=self.project_chat, args=(job,), daemon=True).start(); continue
                if job.get("type") == "share":
                    self.shares.start(job); continue
                if job.get("type") == "unshare":
                    self.shares.stop(job["share_id"]); continue
                if job.get("type") == "stop_project":
                    self.stop_project(job); continue
                if job.get("type") == "remove_agent":
                    try:
                        self.remove_agent(job)
                    except Exception as e:
                        self.report(job, f"⚠️ @{job.get('agent', '?')} is removed from the chat, but: {e}", status="failed")
                    continue
                if job.get("type") == "rename_agent":
                    try:
                        self.rename_agent(job)
                    except Exception as e:
                        self.report(job, f"⚠️ @{job.get('new_name', '?')} is renamed in the chat, but: {e}", status="failed")
                    continue
                if job.get("type") == "start_team":
                    try:
                        self.start_team(job)
                    except Exception as e:
                        self.report(job, f"❌ Couldn't start the team: {e}", status="failed")
                    continue
                if job.get("type") == "add_agent":
                    try:
                        self.add_agent(job)
                    except Exception as e:
                        self.report(job, f"❌ Couldn't add @{job.get('agent', {}).get('name', '?')}: {e}", status="failed")
                    continue
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
    h = Host(a.server, a.projects_dir)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    try:
        h.loop()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        h.shares.stop_all()
