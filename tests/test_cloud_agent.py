"""Cloud agents: the bridge starts and messages a session through `claude`, and posts what the agent pushes to GitHub
(python3 -m unittest discover -s tests). A fake `claude` and a local bare repository stand in for Claude's cloud and GitHub."""
import http.server, json, os, stat, subprocess, sys, tempfile, threading, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "kit", ".agent_sync"))
import cloud_agent  # noqa: E402


class Catch(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        Catch.seen.append((self.path, json.loads(self.rfile.read(n) or b"{}")))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


def sh(cwd, *args):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class CloudAgentTest(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Catch)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        Catch.seen = []
        self.tmp = tempfile.mkdtemp()
        os.environ["TROPA_SECRET"] = "k"
        origin, self.proj, self.cloud = (os.path.join(self.tmp, d) for d in ("origin.git", "proj", "cloud"))
        sh(self.tmp, "git", "init", "-q", "--bare", "-b", "main", origin)
        sh(self.tmp, "git", "init", "-q", "-b", "main", self.proj)
        sh(self.proj, "git", "commit", "-q", "--allow-empty", "-m", "start")
        sh(self.proj, "git", "remote", "add", "origin", origin)
        sh(self.proj, "git", "push", "-q", "-u", "origin", "main")
        sh(self.tmp, "git", "clone", "-q", origin, self.cloud)
        os.makedirs(os.path.join(self.proj, "agents", "ada"))
        with open(os.path.join(self.proj, "agents", "ada", "agent.json"), "w") as f:
            json.dump({"name": "ada", "role": "backend", "where": "cloud"}, f)
        self.cfg = {"server": "http://127.0.0.1:%d" % self.srv.server_address[1], "root": self.proj, "room": "project:p",
                    "project": "p", "human": "mark"}

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        os.environ.pop("TROPA_SECRET", None)

    def posts(self):
        return [b["content"] for p, b in Catch.seen if p == "/api/rooms/project%3Ap/messages"]

    def fake_claude(self, script):
        bin_ = os.path.join(self.tmp, "bin")
        os.makedirs(bin_, exist_ok=True)
        p = os.path.join(bin_, "claude")
        with open(p, "w") as f:
            f.write("#!/bin/sh\n" + script)
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        os.environ["PATH"] = bin_ + os.pathsep + os.environ["PATH"]
        self.addCleanup(lambda: os.environ.__setitem__("PATH", os.environ["PATH"].replace(bin_ + os.pathsep, "", 1)))

    def test_first_message_starts_a_session_then_follow_ups_go_to_it(self):
        log = os.path.join(self.tmp, "calls")
        self.fake_claude(f'echo "$@" >> {log}; cat >> {log}\n'
                         'if [ "$1" = "--cloud" ]; then echo "Created session_01AbCdEfGh: https://claude.ai/code/session_01AbCdEfGh"; '
                         'else echo \'{"ok":true,"session_id":"session_01AbCdEfGh"}\'; fi\n')
        self.assertTrue(cloud_agent.send(self.cfg, "ada", "build the login page"))
        st = cloud_agent.load_state(self.cfg, "ada")
        self.assertEqual(st["session"], "session_01AbCdEfGh")
        self.assertEqual(st["url"], "https://claude.ai/code/session_01AbCdEfGh")
        self.assertIn("I'm working in Claude's cloud: https://claude.ai/code/session_01AbCdEfGh", self.posts()[0])
        self.assertTrue(cloud_agent.send(self.cfg, "ada", "also add a logout button"))
        calls = open(log).read()
        self.assertIn("build the login page", calls)
        self.assertIn(".tropa/outbox/ada.md", calls)   # the intro explains how to report back
        self.assertIn("-p --cloud session_01AbCdEfGh --output-format json", calls)
        self.assertIn("also add a logout button", calls)

    def test_a_failed_start_tells_the_human(self):
        self.fake_claude('echo "Error: not logged in" >&2; exit 1\n')
        self.assertFalse(cloud_agent.send(self.cfg, "ada", "hi"))
        says = [b["content"] for p, b in Catch.seen if p == "/api/watch/say"]
        self.assertTrue(says and "not logged in" in says[0] and "claude auth login" in says[0])
        self.assertNotIn("session", cloud_agent.load_state(self.cfg, "ada"))

    def test_pushes_and_outbox_messages_are_posted_once(self):
        st = {"session": "session_x", "branches": {}, "outbox": {}}
        sh(self.cloud, "git", "checkout", "-q", "-b", "tropa/ada/login")
        os.makedirs(os.path.join(self.cloud, ".tropa", "outbox"))
        box = os.path.join(self.cloud, ".tropa", "outbox", "ada.md")
        with open(box, "w") as f:
            f.write("Plan: a form and a session cookie.\n")
        sh(self.cloud, "git", "add", "-A")
        sh(self.cloud, "git", "commit", "-q", "-m", "Add the login form")
        sh(self.cloud, "git", "push", "-q", "origin", "tropa/ada/login")
        cloud_agent.poll(self.cfg, "ada", st)
        self.assertEqual(len(self.posts()), 2)
        self.assertIn("Pushed 1 commit to `tropa/ada/login`", self.posts()[0])
        self.assertIn("- Add the login form", self.posts()[0])
        self.assertEqual(self.posts()[1], "Plan: a form and a session cookie.")

        cloud_agent.poll(self.cfg, "ada", st)   # nothing new: nothing posted
        self.assertEqual(len(self.posts()), 2)

        with open(box, "a") as f:
            f.write("---\n@lead done, PR: https://github.com/x/y/pull/1\n---\n@mark one question: dark mode?\n")
        sh(self.cloud, "git", "commit", "-q", "-am", "Done")
        sh(self.cloud, "git", "push", "-q", "origin", "tropa/ada/login")
        cloud_agent.poll(self.cfg, "ada", st)
        self.assertEqual(self.posts()[2:], ["Pushed 1 commit to `tropa/ada/login`:\n- Done",
                                            "@lead done, PR: https://github.com/x/y/pull/1", "@mark one question: dark mode?"])
        self.assertEqual(cloud_agent.load_state(self.cfg, "ada")["branches"]["tropa/ada/login"], st["branches"]["tropa/ada/login"])

    def test_check_reports_the_repo(self):
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cloud_agent.check(self.cfg)
        c = json.loads(out.getvalue())
        self.assertTrue(c["repo"] and c["pushed"])
        self.assertEqual(c["branch"], "main")
        self.assertEqual(c["github"], "")   # a local bare repo is not GitHub


if __name__ == "__main__":
    unittest.main()
