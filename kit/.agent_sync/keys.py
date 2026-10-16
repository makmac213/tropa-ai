#!/usr/bin/env python3
"""API keys for model providers, global or per project. Keys never go in a project folder or git.

Where a key comes from, first match wins:
  1. the project's own key   ~/.config/tropa/keys/<project>/<provider>.key
  2. the environment         $GEMINI_API_KEY / $OPENROUTER_API_KEY
  3. your global key         ~/.config/tropa/<provider>.key
Files are written with mode 600 in folders with mode 700.

  keys.py get PROVIDER [--project SLUG]         print the key that applies (exit 1 if none)
  keys.py status PROVIDER [--project SLUG]      {"ready", "source": project|env|file|"", "masked"} as JSON
  keys.py set PROVIDER [--project SLUG]         read a key from stdin, check it with the provider, save it
  keys.py clear PROVIDER [--project SLUG]       remove the saved key (global, or the project's)
  keys.py where PROVIDER [--project SLUG]       which key applies, in words (never the key)
  keys.py projects PROVIDER                     project slugs that have their own key
PROVIDER: openrouter | gemini
"""
import json, os, re, sys, urllib.error, urllib.request

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("TROPA_KEYS_DIR") or os.path.expanduser("~/.config/tropa")

PROVIDERS = {
    "openrouter": {"name": "OpenRouter", "env": "OPENROUTER_API_KEY", "file": "openrouter.key"},
    "gemini": {"name": "Gemini", "env": "GEMINI_API_KEY", "file": "gemini.key"},
}
GEMINI_API = os.environ.get("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")


def _provider(p):
    if p not in PROVIDERS:
        raise ValueError(f"unknown provider {p!r} (use {', '.join(PROVIDERS)})")
    return PROVIDERS[p]


def _slug(s):
    s = re.sub(r"[^a-z0-9._-]+", "-", str(s or "").lower()).strip("-")[:60]
    if s and (s.startswith(".") or not re.fullmatch(r"[a-z0-9._-]{1,60}", s)):
        raise ValueError(f"invalid project name {s!r}")
    return s


def path(p, project=None):
    f = _provider(p)["file"]
    proj = _slug(project) if project else ""
    return os.path.join(BASE, "keys", proj, f) if proj else os.path.join(BASE, f)


def _read(fp):
    try:
        with open(fp) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def get(p, project=None):
    """(key, source) for this provider: source is 'project', 'env', 'file' or '' (no key)."""
    if project:
        k = _read(path(p, project))
        if k:
            return k, "project"
    k = os.environ.get(_provider(p)["env"], "").strip()
    if k:
        return k, "env"
    k = _read(path(p))
    return (k, "file") if k else ("", "")


def masked(k):
    return f"{k[:8]}…{k[-4:]}" if len(k) > 16 else ("set" if k else "")


def status(p, project=None):
    k, src = get(p, project)
    return {"ready": bool(k), "source": src, "masked": masked(k)}


def set_key(p, k, project=None):
    fp = path(p, project)
    os.makedirs(os.path.dirname(fp), mode=0o700, exist_ok=True)
    for d in {BASE, os.path.join(BASE, "keys"), os.path.dirname(fp)}:
        if not os.path.isdir(d):
            continue
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    fd = os.open(fp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k.strip() + "\n")
    os.chmod(fp, 0o600)


def clear(p, project=None):
    fp = path(p, project)
    try:
        os.remove(fp)
    except FileNotFoundError:
        pass
    if project:
        try:
            os.rmdir(os.path.dirname(fp))   # only when no other provider's key is left there
        except OSError:
            pass


def projects(p):
    f, base = _provider(p)["file"], os.path.join(BASE, "keys")
    try:
        return sorted(d for d in os.listdir(base) if not d.startswith(".") and _read(os.path.join(base, d, f)))
    except OSError:
        return []


# ---------- Gemini (Google AI Studio / Gemini API) ----------
def _gemini(k, url, timeout=15):
    req = urllib.request.Request(url, headers={"x-goog-api-key": k, "User-Agent": "tropa"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        if e.code in (400, 401, 403):
            raise ValueError("Google rejected this key" + (f": {msg.rstrip('.')}" if msg else "") + ". Check it at https://aistudio.google.com/apikey")
        raise ValueError(f"Gemini API error {e.code}" + (f": {msg}" if msg else ""))
    except urllib.error.URLError as e:
        raise ValueError(f"couldn't reach the Gemini API ({e.reason})")


SKIP = re.compile(r"embedding|image|imagen|tts|audio|live|native|robotics|computer-use|aqa|veo|learnlm|gemma", re.I)


def gemini_models(k, timeout=15):
    """Text models this key can use with Gemini CLI: [{id, label}] (ids without the 'models/' prefix)."""
    out, token = [], ""
    for _ in range(5):
        d = _gemini(k, f"{GEMINI_API}/models?pageSize=1000" + (f"&pageToken={token}" if token else ""), timeout)
        for m in d.get("models") or []:
            mid = str(m.get("name", "")).split("/", 1)[-1]
            if (mid.startswith("gemini-") and "generateContent" in (m.get("supportedGenerationMethods") or [])
                    and not SKIP.search(mid)):
                out.append({"id": mid, "label": f"{m.get('displayName') or mid} · your API key"})
        token = d.get("nextPageToken") or ""
        if not token:
            break
    return sorted(out, key=lambda m: m["id"], reverse=True)


def check(p, k):
    """Ask the provider about this key; returns a short note. Raises ValueError with a readable reason."""
    k = (k or "").strip()
    if not re.fullmatch(r"[\x21-\x7e]{16,300}", k):
        raise ValueError(f"that doesn't look like {'a Gemini' if p == 'gemini' else 'an OpenRouter'} API key")
    if p == "gemini":
        n = len(gemini_models(k))
        if not n:
            raise ValueError("this key works but can't use any Gemini text models")
        return f"{n} models"
    sys.path.insert(0, HERE)
    import openrouter
    openrouter.check_key(k)
    return "ok"


def main():
    args = sys.argv[1:]
    project = ""
    if "--project" in args:
        i = args.index("--project")
        project = args[i + 1] if i + 1 < len(args) else ""
        del args[i:i + 2]
    if len(args) < 2:
        sys.exit(__doc__)
    cmd, p = args[0], args[1]
    try:
        _provider(p)
        if cmd == "get":
            k, _ = get(p, project)
            if not k:
                sys.exit(1)
            print(k)
        elif cmd == "status":
            print(json.dumps(status(p, project)))
        elif cmd == "set":
            k = sys.stdin.readline().strip()
            note = check(p, k)
            set_key(p, k, project)
            print(f"✅ {PROVIDERS[p]['name']} key saved{' for project ' + _slug(project) if project else ''} ({masked(k)}, {note})")
        elif cmd == "clear":
            clear(p, project)
            print(f"removed the {PROVIDERS[p]['name']} key{' of project ' + _slug(project) if project else ''}")
        elif cmd == "where":
            k, src = get(p, project)
            print({"project": "this project's own key", "env": f"${PROVIDERS[p]['env']}", "file": "your global key", "": "none"}[src]
                  + (f" ({masked(k)})" if k else ""))
        elif cmd == "projects":
            print("\n".join(projects(p)))
        else:
            sys.exit(__doc__)
    except ValueError as e:
        sys.exit(f"❌ {e}")


if __name__ == "__main__":
    main()
