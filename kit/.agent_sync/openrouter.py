#!/usr/bin/env python3
"""Models through OpenRouter (https://openrouter.ai). Agents pick them as model "openrouter/<author>/<slug>".

The API key comes from the project's own key (~/.config/tropa/keys/<project>/openrouter.key), else $OPENROUTER_API_KEY,
else ~/.config/tropa/openrouter.key (⚙ Settings → API keys, or `tropa openrouter key`). See keys.py.

  openrouter.py key                 print the key (exit 1 if none)
  openrouter.py set-key             read a key from stdin, check it with OpenRouter, save it (chmod 600)
  openrouter.py clear-key           remove the saved key
  openrouter.py status              where the key comes from (env/file/none), masked
  openrouter.py check SLUG          exit 0 if a key is set and SLUG exists and can call tools
  openrouter.py list                tool-capable models: id<TAB>label
"""
import json, os, sys, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True

API = os.environ.get("OPENROUTER_API_BASE", "https://openrouter.ai/api/v1").rstrip("/")   # override for a proxy or tests
KEY_FILE = os.path.join(os.environ.get("TROPA_KEYS_DIR") or os.path.expanduser("~/.config/tropa"), "openrouter.key")


import keys as _keys   # the key store (global or per project): keys.py

PROJECT = os.environ.get("TROPA_PROJECT", "")   # set by start_agent.sh, so a project's own key wins


def key(project=None):
    return _keys.get("openrouter", PROJECT if project is None else project)[0]


def set_key(k, project=None):
    _keys.set_key("openrouter", k, project)


def clear_key(project=None):
    _keys.clear("openrouter", project)


def source(project=None):
    """'project', 'env' ($OPENROUTER_API_KEY), 'file' (global saved key) or '' for none."""
    return _keys.get("openrouter", PROJECT if project is None else project)[1]


def masked(k=None):
    k = key() if k is None else k
    return f"{k[:8]}…{k[-4:]}" if len(k) > 16 else ("set" if k else "")


def check_key(k, timeout=15):
    """Ask OpenRouter about this key (GET /key). Returns its info; raises ValueError with a readable reason."""
    req = urllib.request.Request(API + "/key", headers={"Authorization": f"Bearer {k}", "User-Agent": "tropa"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}").get("data") or {}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise ValueError("OpenRouter didn't accept this key: check you copied all of it, or make a new one at https://openrouter.ai/settings/keys") from None
        raise ValueError(f"OpenRouter answered HTTP {e.code}; try again in a moment") from None
    except (urllib.error.URLError, OSError) as e:
        raise ValueError(f"couldn't reach openrouter.ai ({getattr(e, 'reason', e)}); check the internet connection") from None


def _price(p):
    try:
        prompt, completion = float(p.get("prompt") or 0), float(p.get("completion") or 0)
    except (TypeError, ValueError):
        return ""
    if prompt == 0 and completion == 0:
        return "free"
    return f"${prompt * 1e6:.2f}/${completion * 1e6:.2f} per M tok"


def models(timeout=15):
    """[{id, label}] for models that can call tools (agents need tools to use the room). Ids have no 'openrouter/' prefix."""
    req = urllib.request.Request(API + "/models?supported_parameters=tools", headers={"User-Agent": "tropa"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode() or "{}").get("data", [])
    out = []
    for m in data:
        mid = m.get("id") or ""
        if not mid or "tools" not in (m.get("supported_parameters") or []):
            continue
        ctx = m.get("context_length")
        bits = ["OpenRouter", _price(m.get("pricing") or {})] + ([f"{int(ctx) // 1000}k ctx"] if ctx else [])
        out.append({"id": mid, "label": " · ".join(b for b in bits if b)})
    return sorted(out, key=lambda x: x["id"])


def check(slug):
    """None if usable, else a one-line problem with the fix."""
    if not key():
        return "no OpenRouter API key: add it in the TropaAI monitor (⚙ Settings → API keys) or run `tropa openrouter key`"
    try:
        ids = {m["id"] for m in models()}
    except Exception:
        return None   # can't reach OpenRouter to verify; let the CLI report any problem
    if slug not in ids:
        return f"OpenRouter has no tool-capable model {slug!r}: pick one from https://openrouter.ai/models?supported_parameters=tools"
    return None


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "key":
        k = key()
        print(k) if k else sys.exit(1)
    elif cmd == "set-key":
        k = sys.stdin.readline().strip()
        if not k:
            sys.exit("no key given")
        try:
            check_key(k)
        except ValueError as e:
            sys.exit(f"not saved: {e}")
        set_key(k)
        print(f"saved to {KEY_FILE}")
    elif cmd == "clear-key":
        clear_key()
        print("removed" + (" (OPENROUTER_API_KEY is still set in this environment)" if source() == "env" else ""))
    elif cmd == "status":
        s = source()
        print({"project": f"the project's own key ({PROJECT})", "env": "from $OPENROUTER_API_KEY", "file": f"saved in {KEY_FILE}", "": "no key"}[s] + (f" ({masked()})" if s else ""))
    elif cmd == "check":
        problem = check(sys.argv[2] if len(sys.argv) > 2 else "")
        if problem:
            print(problem)
            sys.exit(1)
    elif cmd == "list":
        for m in models():
            print(f"{m['id']}\t{m['label']}")
    else:
        print(__doc__.strip())
        sys.exit(2)
