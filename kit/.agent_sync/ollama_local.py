#!/usr/bin/env python3
"""Local models through Ollama (https://ollama.com). Agents pick them as model "ollama/<name>".

  ollama_local.py url               the Ollama URL tropa uses
  ollama_local.py check NAME        exit 0 if Ollama is up and NAME is pulled and can call tools
  ollama_local.py list              tool-capable local models
"""
import json, os, re, sys, urllib.request

def url(cfg=None):
    u = (cfg or {}).get("ollama_url") or os.environ.get("OLLAMA_HOST") or "http://localhost:11434"
    u = u.strip().rstrip("/")
    if not re.match(r"^https?://", u):
        u = "http://" + u
    return u.replace("://0.0.0.0", "://127.0.0.1")


def _get(path, body=None, base=None, timeout=4):
    req = urllib.request.Request((base or url()) + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def version(base=None):
    return _get("/api/version", base=base).get("version", "")


def at_least(v, want=(0, 14, 0)):
    nums = [int(x) for x in re.findall(r"\d+", v or "")[:3]] + [0, 0, 0]
    return tuple(nums[:3]) >= want


def models(base=None):
    """{'version', 'claude_ok', 'models': [{name, size, tools}]}. Raises if Ollama isn't running."""
    v = version(base)
    out = []
    for m in _get("/api/tags", base=base).get("models", []):
        name = m.get("name") or m.get("model")
        try:
            caps = _get("/api/show", {"model": name}, base=base).get("capabilities") or []
        except Exception:
            caps = []
        size = (m.get("details") or {}).get("parameter_size") or ""
        out.append({"name": name, "size": size, "tools": "tools" in caps})
    return {"version": v, "claude_ok": at_least(v), "models": out}


def check(name, base=None):
    """None if usable, else a one-line problem with the fix."""
    try:
        info = models(base)
    except Exception:
        return f"Ollama isn't running at {base or url()}: start the Ollama app (or `ollama serve`)"
    names = {m["name"]: m for m in info["models"]}
    m = names.get(name) or names.get(name + ":latest")
    if not m:
        return f"model {name} isn't pulled: ollama pull {name}"
    if not m["tools"]:
        return f"{name} can't call tools, which agents need for the chat; pick a model with tool support (e.g. qwen3-coder, gpt-oss)"
    return None


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["url"]:
        print(url())
    elif a[:1] == ["check"] and len(a) > 1:
        problem = check(a[1])
        if problem:
            print(problem); sys.exit(1)
    elif a[:1] == ["list"]:
        for m in models()["models"]:
            print(f"ollama/{m['name']:<28} {m['size']:<8} {'tools' if m['tools'] else 'no tools'}")
    else:
        print(__doc__)
