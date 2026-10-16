#!/usr/bin/env python3
"""Public links for the tropa host helper: runs `ngrok http PORT` (optional; only if ngrok is installed).

Each share is one ngrok agent process owned by the host helper. They stop when it stops
(tmux kill → hangup), when their time is up, or when the chat asks. Nothing is written to
disk except the PID list in ~/.tropa/shares-<port>.json, used to clean up after a crash.
"""
import json, os, re, shutil, signal, socket, subprocess, threading, time, urllib.request

NGROK_CONFIGS = ["~/Library/Application Support/ngrok/ngrok.yml", "~/.config/ngrok/ngrok.yml", "~/.ngrok2/ngrok.yml"]
RESERVED_PORTS = {8880: "the Kokoro voice server"}


def ngrok_info(_cache={}):
    now = time.time()
    if _cache.get("at", 0) > now - 60:
        return _cache["v"]
    exe = shutil.which("ngrok")
    v = {"installed": bool(exe), "authed": False, "version": ""}
    if exe:
        try:
            out = subprocess.run([exe, "version"], capture_output=True, text=True, timeout=5).stdout
            v["version"] = out.strip().replace("ngrok version ", "")[:40]
        except Exception:
            pass
        paths = [os.path.expanduser(p) for p in NGROK_CONFIGS]
        if os.environ.get("NGROK_CONFIG"):
            paths.insert(0, os.environ["NGROK_CONFIG"])
        try:   # ask ngrok where its config lives ("Valid configuration file at /path/ngrok.yml")
            out = subprocess.run([exe, "config", "check"], capture_output=True, text=True, timeout=5)
            m = re.search(r"(/\S.*ngrok\.yml)", out.stdout + out.stderr)
            if m:
                paths.insert(0, m.group(1).strip())
        except Exception:
            pass
        v["authed"] = bool(os.environ.get("NGROK_AUTHTOKEN")) or any(
            os.path.isfile(p) and re.search(r"(?m)^\s*authtoken:\s*\S{10,}", open(p, errors="replace").read()) for p in paths)
    _cache.update(at=now, v=v)
    return v


def listening(port):
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            continue
    return False


def is_tropa_server(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return json.loads(r.read().decode()).get("app") == "tropa-ai"
    except Exception:
        return False


class Shares:
    def __init__(self, server_port, report, log):
        self.server_port, self.report, self.log = server_port, report, log
        self.items = {}          # share_id -> {proc, port, url, expires, room}
        self.lock = threading.Lock()
        self.state = os.path.expanduser(f"~/.tropa/shares-{server_port}.json")
        self._cleanup_stale()

    # ---- bookkeeping ----
    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.state), exist_ok=True)
            with open(self.state, "w") as f:
                json.dump([i["proc"].pid for i in self.items.values()], f)
        except OSError:
            pass

    def _cleanup_stale(self):
        """Kill ngrok processes left over from a helper that crashed (only PIDs we recorded, only if they're ngrok)."""
        try:
            pids = json.load(open(self.state))
        except Exception:
            return
        for pid in pids:
            try:
                cmd = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout
                if "ngrok" in cmd:
                    os.kill(pid, signal.SIGTERM); self.log(f"stopped a leftover ngrok (pid {pid})")
            except Exception:
                pass
        try:
            os.remove(self.state)
        except OSError:
            pass

    def ids(self):
        with self.lock:
            return list(self.items)

    # ---- jobs ----
    def start(self, job):
        threading.Thread(target=self._start, args=(job,), daemon=True).start()

    def _start(self, job):
        sid, port, hours = int(job["share_id"]), int(job["port"]), float(job.get("hours") or 0)
        fail = lambda msg: self.report(sid, "failed", error=msg)
        if port == self.server_port or is_tropa_server(port):
            return fail(f"port {port} is a TropaAI chat server; sharing it would let anyone control your agents")
        if port in RESERVED_PORTS:
            return fail(f"port {port} is {RESERVED_PORTS[port]}")
        info = ngrok_info()
        if not info["installed"]:
            return fail("ngrok is not installed (https://ngrok.com/download)")
        warning = "" if listening(port) else f"nothing is listening on port {port} yet; the link shows an error until the app is running"
        try:
            proc = subprocess.Popen([shutil.which("ngrok"), "http", str(port), "--log", "stdout", "--log-format", "json"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, bufsize=1)
        except OSError as e:
            return fail(f"could not run ngrok: {e}")
        found, last_err, lines = {}, [""], []

        def reader():
            for line in proc.stdout:
                lines.append(line.strip()); del lines[:-20]
                try:
                    ev = json.loads(line)
                except ValueError:
                    if "ERR_NGROK" in line or "ERROR" in line:
                        last_err[0] = line.strip()[:300]
                    continue
                url = ev.get("url") or ev.get("public_url") or ""
                if url.startswith("https://") and "url" not in found:
                    found["url"] = url
                if ev.get("lvl") in ("eror", "crit", "error") or ev.get("err") not in (None, "", "<nil>"):
                    last_err[0] = str(ev.get("err") or ev.get("msg"))[:300]
        threading.Thread(target=reader, daemon=True).start()
        deadline = time.time() + 20
        while time.time() < deadline and "url" not in found and proc.poll() is None:
            time.sleep(0.2)
        if "url" not in found:
            if proc.poll() is None:
                proc.terminate()
            err = last_err[0] or (lines[-1] if lines else "ngrok did not report a URL")
            if "4018" in err or "authtoken" in err.lower():
                err += " · run: ngrok config add-authtoken <token>"
            elif "108" in err or "limited to" in err.lower():
                err += " · your ngrok plan's agent limit is reached; stop another link"
            return fail(err)
        with self.lock:
            self.items[sid] = {"proc": proc, "port": port, "url": found["url"], "expires": time.time() + hours * 3600 if hours else 0}
            self._save()
        self.log(f"share #{sid}: {found['url']} → localhost:{port}")
        self.report(sid, "online", url=found["url"], warning=warning)

    def stop(self, sid, reason=""):
        with self.lock:
            it = self.items.pop(int(sid), None)
            self._save()
        if it:
            it["proc"].terminate()
            try:
                it["proc"].wait(5)
            except subprocess.TimeoutExpired:
                it["proc"].kill()
        self.report(int(sid), "stopped", reason=reason)

    def tick(self):
        now = time.time()
        for sid, it in list(self.items.items()):
            if it["expires"] and now > it["expires"]:
                self.stop(sid, "time's up")
            elif it["proc"].poll() is not None:
                with self.lock:
                    self.items.pop(sid, None); self._save()
                self.report(sid, "stopped", reason="ngrok exited")

    def stop_all(self):
        for sid in list(self.items):
            self.stop(sid, "the host helper stopped")
