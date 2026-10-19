#!/usr/bin/env python3
"""Token and cost telemetry for TropaAI agents, read from the logs each CLI already writes.

Only sessions started by tropa are counted: their first prompt is tropa's boot prompt
("Startup: you are '<agent>' on the TropaAI chat … project "<slug>" …"), which names the
agent and project. Nothing but counts leaves this machine: no prompts, code or file names.

  Claude Code  ~/.claude/projects/*/*.jsonl (+ subagents)   message.usage, deduped by message.id
  Codex        ~/.codex/sessions/**/rollout-*.jsonl          token_count events (cumulative → deltas)
  OpenCode     ~/.local/share/opencode/storage/message/…     tokens + cost per assistant message
  Qwen Code    ~/.qwen/tmp/*/chats/*.json, ~/.qwen/projects/*/chats/*.jsonl   usage per reply
  Gemini CLI   ~/.gemini/tmp/*/chats/*.json (+ .jsonl)                         tokens per reply (same format as Qwen Code)

  usage.py --summary [--days N]   print what would be reported (for checking on your machine)
  usage.py --debug                which log folders were found and how many tropa sessions each has
"""
import glob, json, os, re, sqlite3, sys, time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
FIELDS = ("input", "cache_read", "cache_write", "cache_write_1h", "output", "turns")
BOOT = re.compile(r"""you are \\?'([A-Za-z0-9._-]{1,40})\\?' on (?:the TropaAI chat|the AI-IRC chat|ai-irc|AI-IRC|TropaAI)\. Call the [\w-]+ register tool with agent \\?"[^"\\]*\\?", project \\?"([A-Za-z0-9._-]{1,80})\\?\"""")
HEAD = 256 * 1024


def home(*p):
    return os.path.join(os.path.expanduser("~"), *p)


# ---------------------------------------------------------------- prices
def load_prices():
    prices = {}
    for p in (os.path.join(HERE, "prices.json"), home(".tropa", "prices.json")):
        try:
            prices.update({k: v for k, v in json.load(open(p)).items() if not k.startswith("_") and isinstance(v, dict)})
        except (OSError, ValueError):
            pass
    return {norm(k): v for k, v in prices.items()}


def norm(model):
    m = str(model or "").lower().strip()
    m = m.split("/")[-1]                       # anthropic/claude-… , openai/gpt-…
    m = re.sub(r"[^a-z0-9]+", "-", m).strip("-")
    return m


def price_for(prices, model):
    n = norm(model)
    best = max((k for k in prices if n == k or n.startswith(k + "-") or n.startswith(k)), key=len, default=None)
    return prices.get(best) if best else None


def cost_of(p, c):
    if not p:
        return None
    inp = p.get("input", 0)
    return (c["input"] * inp + c["cache_write"] * p.get("cache_write", inp * 1.25) + c["cache_write_1h"] * inp * 2
            + c["cache_read"] * p.get("cache_read", inp * 0.1) + c["output"] * p.get("output", 0)) / 1e6


# ---------------------------------------------------------------- helpers
def day_of(ts):
    try:
        if isinstance(ts, (int, float)):
            t = ts / 1000 if ts > 1e11 else ts
            return datetime.fromtimestamp(t).strftime("%Y-%m-%d")
        s = str(ts).strip().replace("Z", "+00:00")
        # Python 3.9 (macOS's python3) only accepts 3 or 6 fractional digits: normalize to 6
        s = re.sub(r"(\.\d+)(?=[+-]\d\d:\d\d$|$)", lambda m: (m.group(1) + "000000")[:7], s)
        return datetime.fromisoformat(s).astimezone().strftime("%Y-%m-%d")
    except (ValueError, OSError, OverflowError):
        return None


def linked(path, up):
    """True when the folder `up` levels above path is a symlink (a renamed agent's link to its old sessions)."""
    for _ in range(up):
        path = os.path.dirname(path)
    return os.path.islink(path)


def zero():
    return dict.fromkeys(FIELDS, 0)


def boot_in(text):
    """(agent, project) if this text contains tropa's boot prompt as a user prompt."""
    for m in BOOT.finditer(text):
        before = text[max(0, m.start() - 400):m.start()]
        if "Startup: " in before[-12:] or "Startup: " in before:
            return m.group(1), m.group(2)
    return None


def head(path):
    try:
        with open(path, "rb") as f:
            return f.read(HEAD).decode("utf-8", "replace")
    except OSError:
        return ""


def num(x):
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------- parsers (each yields (day, model, counts, reported_cost))
def parse_claude(f, st):
    seen = st.setdefault("seen", [])
    for line in f:
        if '"usage"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        msg = o.get("message") or {}
        u = msg.get("usage")
        if o.get("type") != "assistant" or not isinstance(u, dict) or msg.get("model") in (None, "<synthetic>"):
            continue
        mid = msg.get("id") or o.get("uuid")
        if mid in seen:
            continue
        seen.append(mid); del seen[:-300]
        cc = u.get("cache_creation") or {}
        w1h = num(cc.get("ephemeral_1h_input_tokens"))
        c = zero()
        c.update(input=num(u.get("input_tokens")), cache_read=num(u.get("cache_read_input_tokens")),
                 cache_write=max(0, num(u.get("cache_creation_input_tokens")) - w1h), cache_write_1h=w1h,
                 output=num(u.get("output_tokens")), turns=1)
        yield day_of(o.get("timestamp")), msg.get("model"), c, None


def parse_codex(f, st):
    for line in f:
        if '"token_count"' not in line and '"turn_context"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        p = o.get("payload") or {}
        if o.get("type") == "turn_context" and p.get("model"):
            st["model"] = p["model"]; continue
        if p.get("type") != "token_count":
            continue
        if (p.get("turn_context") or {}).get("model"):
            st["model"] = p["turn_context"]["model"]
        info = p.get("info") or {}
        tot = info.get("total_token_usage") or (p if "input_tokens" in p else None)
        if tot:
            cur = {k: num(tot.get(k)) for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
            prev = st.get("prev") or {}
            d = {k: cur[k] - prev.get(k, 0) for k in cur}
            if any(v < 0 for v in d.values()):
                d = cur                                   # counters were reset
            st["prev"] = cur
        elif info.get("last_token_usage"):
            l = info["last_token_usage"]
            d = {k: num(l.get(k)) for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
        else:
            continue
        if not any(d.values()):
            continue
        c = zero()
        cached = min(d["cached_input_tokens"], d["input_tokens"])
        c.update(input=d["input_tokens"] - cached, cache_read=cached, output=d["output_tokens"], turns=1)
        yield day_of(o.get("timestamp")), st.get("model") or "gpt-5", c, None


def qwen_counts(t):
    c = zero()
    if "promptTokenCount" in t or "candidatesTokenCount" in t:          # usageMetadata (Gemini API shape)
        cached = num(t.get("cachedContentTokenCount"))
        c.update(input=max(0, num(t.get("promptTokenCount")) - cached), cache_read=cached,
                 output=num(t.get("candidatesTokenCount")) + num(t.get("thoughtsTokenCount")), turns=1)
    else:                                                                  # chat-recording shape
        cached = num(t.get("cached"))
        c.update(input=max(0, num(t.get("input")) - cached), cache_read=cached,
                 output=num(t.get("output")) + num(t.get("thoughts")), turns=1)
    return c


def parse_qwen_jsonl(f, st):
    seen = st.setdefault("seen", [])
    for line in f:
        if "TokenCount" not in line and '"tokens"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        t = o.get("usageMetadata") or (o.get("message") or {}).get("usageMetadata") or o.get("tokens")
        if not isinstance(t, dict):
            continue
        key = o.get("uuid") or o.get("id")
        if key and key in seen:
            continue
        if key:
            seen.append(key); del seen[:-300]
        yield day_of(o.get("timestamp")), o.get("model") or st.get("model") or "qwen3-coder-plus", qwen_counts(t), None


def parse_gemini_jsonl(f, st):
    for day, model, c, cost in parse_qwen_jsonl(f, st):
        yield day, model if model != "qwen3-coder-plus" else "gemini", c, cost


def parse_gemini_json(path):
    for day, model, c, cost in parse_qwen_json(path):
        yield day, model if model != "qwen3-coder-plus" else "gemini", c, cost


def parse_qwen_json(path):
    try:
        d = json.load(open(path, errors="replace"))
    except (OSError, ValueError):
        return
    for m in d.get("messages") or []:
        t = m.get("tokens")
        if m.get("type") in ("gemini", "qwen", "model", "assistant") and isinstance(t, dict):
            yield day_of(m.get("timestamp") or d.get("lastUpdated")), m.get("model") or "qwen3-coder-plus", qwen_counts(t), None


def opencode_counts(m):
    t = m.get("tokens") or {}
    cache = t.get("cache") or {}
    c = zero()
    c.update(input=num(t.get("input")), cache_read=num(cache.get("read")), cache_write=num(cache.get("write")),
             output=num(t.get("output")) + num(t.get("reasoning")), turns=1)
    cost = m.get("cost")
    return c, (float(cost) if isinstance(cost, (int, float)) and cost > 0 else None)


# ---------------------------------------------------------------- collector
class Collector:
    def __init__(self, state_path):
        self.path = state_path
        try:
            self.st = json.load(open(state_path))
        except (OSError, ValueError):
            self.st = {}
        self.st.setdefault("files", {})        # path -> {off, mtime, who:[agent,project]|None, checked, contrib:{key:counts}, …}
        self.st.setdefault("v", 1)

    def save(self):
        tmp = self.path + ".tmp"
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(self.st, f)
        os.replace(tmp, self.path)

    # --- attribution: is this a tropa agent's session?
    def who(self, path, fs, text_fn):
        if fs.get("who"):
            return fs["who"]
        now = time.time()
        if fs.get("checked") and (fs.get("checked_size") == fs.get("size") or now - fs["checked"] < 300):
            return None
        fs["checked"], fs["checked_size"] = now, fs.get("size")
        w = boot_in(text_fn())
        if w:
            fs["who"] = list(w)
        return fs.get("who")

    def add(self, fs, rows):
        contrib = fs.setdefault("contrib", {})
        n = 0
        for day, model, c, rcost in rows:
            if not day:
                continue
            k = f"{day}|{model or '?'}"
            cur = contrib.setdefault(k, {**zero(), "rcost": 0.0})
            for f in FIELDS:
                cur[f] += c[f]
            if rcost:
                cur["rcost"] += rcost
            n += 1
        return n

    def scan_jsonl(self, path, parser, owner=None):
        try:
            s = os.stat(path)
        except OSError:
            return
        fs = self.st["files"].setdefault(path, {"off": 0})
        fs["size"] = s.st_size
        if fs.get("mtime") == s.st_mtime and fs.get("off") == s.st_size and fs.get("who"):
            return
        who = owner or self.who(path, fs, lambda: head(path))
        if not who:
            return
        fs["who"] = list(who)
        if s.st_size < fs.get("off", 0):
            fs.update(off=0, contrib={}, pst={})            # file was rewritten
        pos = [fs.get("off", 0)]
        with open(path, "rb") as f:                         # stream: Codex logs can be gigabytes
            f.seek(pos[0])
            def lines():
                for raw in f:
                    if not raw.endswith(b"\n"):
                        break                               # a line still being written
                    pos[0] += len(raw)
                    yield raw.decode("utf-8", "replace")
            self.add(fs, parser(lines(), fs.setdefault("pst", {})))
        fs["off"] = pos[0]
        fs["mtime"] = s.st_mtime

    def scan_whole(self, path, rows_fn, text_fn):
        try:
            s = os.stat(path)
        except OSError:
            return
        fs = self.st["files"].setdefault(path, {})
        fs["size"] = s.st_size
        if fs.get("mtime") == s.st_mtime and fs.get("who"):
            return
        if not self.who(path, fs, text_fn):
            return
        fs["contrib"] = {}
        self.add(fs, rows_fn())
        fs["mtime"] = s.st_mtime

    # --- per CLI
    def claude(self):
        roots = [os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "projects")] if os.environ.get("CLAUDE_CONFIG_DIR") else []
        roots += [home(".claude", "projects"), home(".config", "claude", "projects")]
        for r in dict.fromkeys(roots):
            for p in glob.glob(os.path.join(r, "*", "*.jsonl")):
                if os.path.islink(os.path.dirname(p)):   # a renamed agent's link to its old session folder: counted there
                    continue
                self.scan_jsonl(p, parse_claude)
            for p in glob.glob(os.path.join(r, "*", "*", "subagents", "*.jsonl")):   # subagents of a session
                parent = self.st["files"].get(os.path.dirname(os.path.dirname(p)) + ".jsonl", {})
                if parent.get("who"):
                    self.scan_jsonl(p, parse_claude, owner=parent["who"])

    def codex(self):
        base = os.environ.get("CODEX_HOME") or home(".codex")
        for sub in ("sessions", "archived_sessions"):
            for p in glob.glob(os.path.join(base, sub, "**", "rollout-*.jsonl"), recursive=True):
                self.scan_jsonl(p, parse_codex)

    def qwen(self):
        base = os.environ.get("QWEN_DATA_DIR") or home(".qwen")
        for p in glob.glob(os.path.join(base, "projects", "*", "chats", "*.jsonl")):
            if not linked(p, 2):
                self.scan_jsonl(p, parse_qwen_jsonl)
        for p in glob.glob(os.path.join(base, "tmp", "*", "chats", "*.json")):
            if not linked(p, 2):
                self.scan_whole(p, lambda p=p: parse_qwen_json(p), lambda p=p: head(p))

    def gemini(self):
        base = os.environ.get("GEMINI_CLI_HOME") and os.path.join(os.environ["GEMINI_CLI_HOME"], ".gemini") or home(".gemini")
        for p in glob.glob(os.path.join(base, "tmp", "*", "chats", "*.jsonl")):
            if not linked(p, 2):
                self.scan_jsonl(p, parse_gemini_jsonl)
        for p in glob.glob(os.path.join(base, "tmp", "*", "chats", "*.json")):
            if not linked(p, 2):
                self.scan_whole(p, lambda p=p: parse_gemini_json(p), lambda p=p: head(p))

    def opencode(self):
        base = os.environ.get("OPENCODE_DATA_DIR") or os.path.join(os.environ.get("XDG_DATA_HOME") or home(".local", "share"), "opencode")
        store = os.path.join(base, "storage")
        for d in glob.glob(os.path.join(store, "message", "*")):
            try:
                mtime = max(os.stat(x).st_mtime for x in [d] + glob.glob(os.path.join(d, "*.json")))
            except (OSError, ValueError):
                continue
            fs = self.st["files"].setdefault(d, {})
            if fs.get("mtime") == mtime and fs.get("who"):
                continue
            msgs = []
            for mp in glob.glob(os.path.join(d, "*.json")):
                try:
                    msgs.append(json.load(open(mp)))
                except (OSError, ValueError):
                    pass
            msgs.sort(key=lambda m: num((m.get("time") or {}).get("created")))
            def text(msgs=msgs):
                out = []
                for m in msgs[:6]:
                    if m.get("role") == "user":
                        for pp in sorted(glob.glob(os.path.join(store, "part", m.get("id", "?"), "*.json")))[:5]:
                            try:
                                out.append(str(json.load(open(pp)).get("text") or ""))
                            except (OSError, ValueError):
                                pass
                return "\n".join(out)
            fs["size"] = len(msgs)
            if not self.who(d, fs, text):
                continue
            fs["contrib"] = {}
            rows = []
            for m in msgs:
                if m.get("role") == "assistant" and m.get("tokens"):
                    c, rc = opencode_counts(m)
                    rows.append((day_of((m.get("time") or {}).get("created")), m.get("modelID") or "?", c, rc))
            self.add(fs, rows)
            fs["mtime"] = mtime
        for db in glob.glob(os.path.join(base, "opencode*.db")):
            self.opencode_sqlite(db)

    def opencode_sqlite(self, db):
        """Newer OpenCode keeps sessions in SQLite. Best effort: read JSON payloads, whatever the schema version."""
        try:
            s = os.stat(db)
            fs = self.st["files"].setdefault(db, {})
            if fs.get("mtime") == s.st_mtime:
                return
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
            tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
            def rows(table):
                if table not in tables:
                    return []
                cols = [r[1] for r in con.execute(f"pragma table_info({table})")]
                for r in con.execute(f"select * from {table}"):
                    d = dict(zip(cols, r))
                    for k, v in list(d.items()):
                        if isinstance(v, str) and v[:1] == "{":
                            try:
                                d.update({kk: vv for kk, vv in json.loads(v).items() if kk not in d})
                            except ValueError:
                                pass
                    yield d
            sid = lambda d: d.get("session_id") or d.get("sessionID") or d.get("sessionId")
            texts = {}
            for d in list(rows("part")) + [x for x in rows("session_message") if x.get("type") in ("user", "text")]:
                if isinstance(d.get("text"), str) and "Startup: " in d["text"]:
                    texts.setdefault(sid(d), d["text"])
            whos = {k: boot_in(v) for k, v in texts.items()}
            contrib = {}
            for table in ("message", "session_message"):
                for d in rows(table):
                    w = whos.get(sid(d))
                    if not w or not d.get("tokens") or d.get("role", "assistant") != "assistant":
                        continue
                    c, rc = opencode_counts(d)
                    model = d.get("modelID") or (d.get("model") or {}).get("id") if isinstance(d.get("model"), dict) else d.get("modelID") or d.get("model")
                    key = f"{json.dumps(w)}"
                    contrib.setdefault(key, []).append((day_of((d.get("time") or {}).get("created") or d.get("time_created")), model or "?", c, rc))
            con.close()
            for key, rws in contrib.items():
                sub = self.st["files"].setdefault(f"{db}#{key}", {})
                sub["who"], sub["contrib"] = json.loads(key), {}
                self.add(sub, rws)
            fs["mtime"] = s.st_mtime
        except Exception:
            pass

    def scan(self):
        for fn in (self.claude, self.codex, self.qwen, self.gemini, self.opencode):
            try:
                fn()
            except Exception as e:                     # one CLI's odd file never stops the others
                print(f"usage: {fn.__name__}: {e}", file=sys.stderr)
        self.save()

    def rows(self, days=400, prices=None):
        """Aggregate to (project, agent, cli, model, day) rows with an API-equivalent cost."""
        prices = prices if prices is not None else load_prices()
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        agg = {}
        for path, fs in self.st["files"].items():
            if not fs.get("who") or not fs.get("contrib"):
                continue
            agent, project = fs["who"]
            cli = cli_of(path)
            for k, c in fs["contrib"].items():
                day, model = k.split("|", 1)
                if day < cutoff:
                    continue
                cur = agg.setdefault((project, agent, cli, model, day), {**zero(), "rcost": 0.0})
                for f in FIELDS:
                    cur[f] += c.get(f, 0)
                cur["rcost"] += c.get("rcost", 0)
        local = local_models()
        out = []
        for (project, agent, cli, model, day), c in sorted(agg.items()):
            p = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0} if norm(model) in local else price_for(prices, model)
            cost = cost_of(p, c)
            if cost is None and c["rcost"]:
                cost = c["rcost"]
            out.append({"project": project, "agent": agent, "cli": cli, "model": model, "day": day,
                        "input": c["input"], "cache_read": c["cache_read"], "cache_write": c["cache_write"] + c["cache_write_1h"],
                        "output": c["output"], "turns": c["turns"], "cost": round(cost, 6) if cost is not None else None})
        return out


def local_models():
    """Normalized names of the models in the local Ollama: they cost nothing."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(HERE), "kit", ".agent_sync"))
        import ollama_local
        names = set()
        for m in ollama_local._get("/api/tags", timeout=2).get("models", []):
            n = m.get("name") or ""
            names |= {norm(n), norm(n.split(":")[0]) if n.endswith(":latest") else norm(n), norm("ollama/" + n)}
        return names
    except Exception:
        return set()


def cli_of(path):
    p = path.replace("\\", "/")
    return ("codex" if "/.codex" in p or "rollout-" in p else "opencode" if "opencode" in p
            else "qwen" if "/.qwen" in p or "/qwen" in p else "gemini" if "/.gemini" in p else "claude")


def debug():
    """Counts only: log folders, files, and how many start with tropa's boot prompt."""
    c = Collector(home(".tropa", "usage-check.json"))
    c.scan()
    by = {}
    for path, fs in c.st["files"].items():
        b = by.setdefault(cli_of(path), [0, 0, set()])
        b[0] += 1
        if fs.get("who"):
            b[1] += 1; b[2].add(f"{fs['who'][1]}/{fs['who'][0]}")
    for d in [home(".claude", "projects"), home(".config", "claude", "projects"), os.environ.get("CODEX_HOME") or home(".codex"),
              home(".local", "share", "opencode"), home(".qwen"), home(".gemini")]:
        print(f"  {'found  ' if os.path.isdir(d) else 'missing'} {d}")
    for cli, (n, hit, who) in sorted(by.items()):
        print(f"  {cli:<9} {n:>5} session files, {hit:>4} started by tropa  {', '.join(sorted(who))[:300]}")
    near = 0
    for path, fs in c.st["files"].items():
        if not fs.get("who") and os.path.isfile(path) and "Startup: you are" in head(path):
            near += 1
            if near <= 3:
                h = head(path); i = h.index("Startup: you are")
                print(f"  ? not matched: {h[i:i + 110]!r}")
    if near:
        print(f"  {near} file(s) mention a startup prompt that didn't match; please share the lines above")


if __name__ == "__main__":
    if "--debug" in sys.argv:
        debug(); sys.exit(0)
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 30
    c = Collector(home(".tropa", "usage-check.json"))
    c.scan()
    rows = c.rows(days)
    tot = {}
    for r in rows:
        t = tot.setdefault((r["project"], r["agent"], r["cli"], r["model"]), [0, 0, 0, 0, 0.0, True])
        t[0] += r["input"] + r["cache_read"] + r["cache_write"]; t[1] += r["output"]; t[2] += r["turns"]; t[3] += 1
        if r["cost"] is None: t[5] = False
        else: t[4] += r["cost"]
    print(f"tropa agent usage, last {days} days (API-equivalent cost):")
    for (proj, agent, cli, model), (i, o, n, d, cost, known) in sorted(tot.items()):
        print(f"  {proj:<18} {agent:<12} {cli:<8} {model:<30} in {i:>11,}  out {o:>9,}  turns {n:>5}  {'$%.2f' % cost if known else 'no price'}")
    if not tot:
        print("  nothing yet: no tropa agent sessions found in the Claude Code, Codex, OpenCode or Qwen logs")
