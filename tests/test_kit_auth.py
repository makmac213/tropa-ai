"""The watcher and host helper send the server's key with every change (python3 -m unittest discover -s tests)."""
import http.server, json, os, sys, tempfile, threading, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "kit", ".agent_sync"))
sys.path.insert(0, os.path.join(ROOT, "host"))


class Catch(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        Catch.seen.append((self.path, self.headers.get("X-Tropa-Key")))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


class KeyTest(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Catch)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.state = tempfile.mkdtemp()
        with open(os.path.join(self.state, "secret-%d.key" % self.port), "w") as f:
            f.write("ab" * 32 + "\n")
        os.environ["TROPA_STATE"] = self.state
        os.environ.pop("TROPA_SECRET", None)
        Catch.seen = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_watcher_sends_the_key(self):
        import room_watcher
        server = "http://127.0.0.1:%d" % self.port
        self.assertEqual(room_watcher.tropa_key(server), "ab" * 32)
        room_watcher.http({"server": server}, "/watch/say", {"room": "x", "content": "hi"})
        self.assertEqual(Catch.seen, [("/api/watch/say", "ab" * 32)])

    def test_host_helper_reads_the_same_key(self):
        import tropa_host
        self.assertEqual(tropa_host.tropa_key("http://localhost:%d" % self.port), "ab" * 32)

    def test_no_key_file_sends_nothing_secret(self):
        import room_watcher
        self.assertEqual(room_watcher.tropa_key("http://127.0.0.1:1"), "")


if __name__ == "__main__":
    unittest.main()
