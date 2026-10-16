#!/usr/bin/env python3
"""tropa guardrails: find secrets before they reach git.

  secret_scan.py                    scan what is staged (the pre-commit hook runs this)
  secret_scan.py --diff BASE...BR   scan what a branch adds (for review)
  secret_scan.py --all              scan every tracked file
  secret_scan.py install [ROOT]     install the pre-commit hook   ·   uninstall [ROOT]

Exit 1 when it finds a likely real secret (a known key format, a private key, a committed .env).
Weaker signals (e.g. password = "...") are printed as warnings and don't block.
Add `tropa:allow-secret` on a line to mark a known-safe test value.
"""
import os, re, shutil, subprocess, sys

HOOK_TAG = "tropa:guardrails"
BLOCK = [
    ("private key", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY"),
    ("AWS access key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})"),
    ("GitLab token", r"\bglpat-[A-Za-z0-9_-]{20,}"),
    ("Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    ("Stripe live key", r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}"),
    ("Anthropic key", r"\bsk-ant-[A-Za-z0-9_-]{32,}"),
    ("OpenAI key", r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("SendGrid key", r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b"),
    ("npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
    ("Hugging Face token", r"\bhf_[A-Za-z0-9]{34,}\b"),
    ("Supabase secret key", r"\bsb_secret_[A-Za-z0-9_-]{20,}"),
]
WARN = [
    ("database URL with a password", r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp)://[^:\s/@]+:([^@\s/]{3,})@([^/\s:]+)"),
    ("hard-coded credential", r"(?i)\b[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)[\w.-]*\s*[:=]\s*['\"]([^'\"\s]{12,})['\"]"),
    ("JSON Web Token", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
]
PLACEHOLDER = re.compile(r"(?i)^(?:x+|\*+|\.+|changeme|change_me|password|pass|secret|example|your[_-].*|<.*>|\$\{.*\}|\{\{.*\}\}|process\.env.*|os\.environ.*|test.*|dummy.*|fake.*|placeholder.*)$")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "db", "postgres", "mysql", "redis", "mongo", "host.docker.internal"}
SECRET_FILE = re.compile(r"(?:^|/)(?:\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks)|\.npmrc|\.pypirc|service[-_]account[^/]*\.json)$")
SKIP = re.compile(r"(?:^|/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp[34]|wasm)$")


def git(*a, root=None):
    r = subprocess.run(["git", *(["-C", root] if root else []), *a], capture_output=True, text=True, errors="replace")
    return r.stdout if r.returncode == 0 else ""


def added_lines(diff):
    """Yield (file, line_no, text) for added lines of a unified diff."""
    f, n = None, 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            f = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line); n = int(m.group(1)) if m else 0
        elif f and line.startswith("+"):
            yield f, n, line[1:]; n += 1
        elif f and not line.startswith("-"):
            n += 1


def scan(lines, files):
    block, warn = [], []
    for f in files:
        if SECRET_FILE.search(f):
            block.append((f, 0, "secret file", "this kind of file holds secrets; keep it out of git (add it to .gitignore)"))
    for f, n, text in lines:
        if SKIP.search(f) or "tropa:allow-secret" in text:
            continue
        for name, rx in BLOCK:
            m = re.search(rx, text)
            if m:
                block.append((f, n, name, mask(m.group(0)))); break
        else:
            for name, rx in WARN:
                m = re.search(rx, text)
                if not m:
                    continue
                val = m.group(1) if m.groups() else m.group(0)
                if PLACEHOLDER.match(val):
                    continue
                if name.startswith("database") and m.group(2).lower() in LOCAL_HOSTS:
                    continue
                warn.append((f, n, name, mask(m.group(0)))); break
    return block, warn


def mask(s):
    s = s.strip()
    return s[:4] + "…" + f"({len(s)} chars)" if len(s) > 12 else s[:2] + "…"


def report(block, warn, what):
    for f, n, name, hint in warn:
        print(f"⚠️  {f}{':' + str(n) if n else ''}: possible {name}: {hint}")
    for f, n, name, hint in block:
        print(f"⛔ {f}{':' + str(n) if n else ''}: {name}: {hint}")
    if block:
        print(f"""
tropa guardrails: {len(block)} likely secret(s) in {what}.
  • Move the value to an environment variable (.env, which git ignores) and document it in .env.example.
  • If a real key was ever committed, pushed or shared, it must be ROTATED, not just deleted.
  • A known-safe test value: add `tropa:allow-secret` on that line.
  • Agents: stop and tell @human. Only the human may bypass with `git commit --no-verify`.""")
    elif not warn and what != "this commit":
        print(f"tropa guardrails: no secrets found in {what}.")
    return 1 if block else 0


def hooks_dir(root):
    custom = git("config", "--get", "core.hooksPath", root=root).strip()
    if custom:
        return None, custom
    d = git("rev-parse", "--git-common-dir", root=root).strip()
    if not d:
        return None, None
    return os.path.join(root, d) if not os.path.isabs(d) else d, None


def install(root):
    root = os.path.abspath(root)
    gd, custom = hooks_dir(root)
    if custom:
        print(f"  = guardrails: this repo uses its own hooks ({custom}); add `python3 {root}/.agent_sync/secret_scan.py` to its pre-commit to scan for secrets")
        return 0
    if not gd:
        return 0                                    # not a git repo (yet)
    hook = os.path.join(gd, "hooks", "pre-commit")
    if os.path.exists(hook) and HOOK_TAG not in open(hook, errors="replace").read():
        print(f"  = guardrails: a pre-commit hook already exists; add `python3 {root}/.agent_sync/secret_scan.py || exit 1` to it to scan for secrets")
        return 0
    os.makedirs(os.path.dirname(hook), exist_ok=True)
    new = f"""#!/bin/sh
# {HOOK_TAG}: blocks commits that contain likely secrets (installed by tropa; `tropa guardrails off` removes it)
scan="{root}/.agent_sync/secret_scan.py"
[ -f "$scan" ] || {{ echo "tropa guardrails: $scan not found, skipping the secret scan"; exit 0; }}
command -v python3 >/dev/null 2>&1 || exit 0
exec python3 "$scan"
"""
    old = open(hook).read() if os.path.exists(hook) else ""
    if old != new:
        with open(hook, "w") as fh:
            fh.write(new)
        os.chmod(hook, 0o755)
        print("  + guardrails: pre-commit secret scan")
    return 0


def uninstall(root):
    gd, _ = hooks_dir(os.path.abspath(root))
    hook = gd and os.path.join(gd, "hooks", "pre-commit")
    if hook and os.path.exists(hook) and HOOK_TAG in open(hook, errors="replace").read():
        os.remove(hook); print("  - guardrails: pre-commit secret scan removed")
    return 0


def gitleaks(staged):
    """Also run gitleaks when it's installed (it knows hundreds of formats)."""
    if not staged or not shutil.which("gitleaks"):
        return 0
    for cmd in (["gitleaks", "git", "--pre-commit", "--staged", "--redact", "--no-banner"],
                ["gitleaks", "protect", "--staged", "--redact", "--no-banner"]):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if "unknown" in (r.stderr or "").lower() and "command" in (r.stderr or "").lower():
            continue
        if r.returncode == 1:
            print((r.stdout + r.stderr).strip()); print("⛔ gitleaks found secrets (see above).")
        return 1 if r.returncode == 1 else 0
    return 0


def main():
    a = sys.argv[1:]
    if a and a[0] in ("install", "uninstall"):
        return (install if a[0] == "install" else uninstall)(a[1] if len(a) > 1 else ".")
    if a and a[0] in ("-h", "--help"):
        print(__doc__); return 0
    if a[:1] == ["--all"]:
        files = [f for f in git("ls-files").splitlines()]
        lines = []
        for f in files:
            if SKIP.search(f) or not os.path.isfile(f):
                continue
            try:
                with open(f, errors="strict") as fh:
                    lines += [(f, i, t.rstrip("\n")) for i, t in enumerate(fh, 1)]
            except (UnicodeDecodeError, OSError):
                continue
        return report(*scan(lines, files), "tracked files")
    if a[:1] == ["--diff"] and len(a) > 1:
        diff = git("diff", "-U0", "--no-color", a[1])
        files = git("diff", "--name-only", "--diff-filter=AM", a[1]).splitlines()
        return report(*scan(added_lines(diff), files), a[1])
    diff = git("diff", "--cached", "-U0", "--no-color")
    files = git("diff", "--cached", "--name-only", "--diff-filter=AM").splitlines()
    rc = report(*scan(added_lines(diff), files), "this commit") if files else 0
    return rc or gitleaks(True)


if __name__ == "__main__":
    sys.exit(main())
