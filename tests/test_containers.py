"""The team's Docker apps for "Running now" and the share dialog: this project's containers and the ports they publish
(python3 -m unittest discover -s tests). A fake `docker` stands in for the real one."""
import json, os, stat, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kit", ".agent_sync"))
import reap  # noqa: E402


class ContainersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj = os.path.join(self.tmp, "recruitment-os")
        os.makedirs(os.path.join(self.proj, "app"))
        rows = [
            {"Names": "recruitment-os-frontend-1", "Image": "node:22", "Status": "Up 4 minutes", "Ports": "0.0.0.0:3011->3000/tcp, :::3011->3000/tcp",
             "Labels": f"com.docker.compose.project=recruitment-os,com.docker.compose.service=frontend,com.docker.compose.project.working_dir={self.proj}/app"},
            {"Names": "recruitment-os-db-1", "Image": "postgres:16", "Status": "Up 4 minutes", "Ports": "0.0.0.0:5433->5432/tcp",
             "Labels": "com.docker.compose.project=recruitment-os,com.docker.compose.service=db,com.docker.compose.project.working_dir=/elsewhere/recruitment-os"},
            {"Names": "other-web-1", "Image": "nginx", "Status": "Up 1 hour", "Ports": "0.0.0.0:8080->80/tcp",
             "Labels": "com.docker.compose.project=other,com.docker.compose.service=web,com.docker.compose.project.working_dir=/srv/other"},
            {"Names": "loose", "Image": "redis", "Status": "Up", "Ports": "6379/tcp", "Labels": ""},
        ]
        bin_ = os.path.join(self.tmp, "bin"); os.makedirs(bin_)
        data = os.path.join(self.tmp, "ps.jsonl")
        with open(data, "w") as f:
            f.write("\n".join(json.dumps(r) for r in rows) + "\n")
        p = os.path.join(bin_, "docker")
        with open(p, "w") as f:
            f.write(f"#!/bin/sh\ncat {data}\n")
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        self.path = os.environ["PATH"]
        os.environ["PATH"] = bin_ + os.pathsep + self.path

    def tearDown(self):
        os.environ["PATH"] = self.path

    def test_this_projects_containers_and_their_published_ports(self):
        got = reap.containers({"root": self.proj, "project": "recruitment-os"})
        self.assertEqual([(c["service"], c["ports"]) for c in got], [("frontend", [3011]), ("db", [5433])])   # by folder, then by project name

    def test_other_projects_and_no_docker(self):
        self.assertEqual(reap.containers({"root": os.path.join(self.tmp, "unrelated"), "project": "unrelated"}), [])
        os.environ["PATH"] = "/nonexistent"
        self.assertEqual(reap.containers({"root": self.proj, "project": "recruitment-os"}), [])


if __name__ == "__main__":
    unittest.main()
