#!/usr/bin/env python3
"""Fingerprint of what `tropa update` puts in a project: the team kit's scripts and tropa's default skills.

  kit_stamp.py          print it
`tropa update` saves it in <project>/.agent_sync/.kit-stamp; the host helper updates projects whose stamp differs.
"""
import hashlib, os

TROPA_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = {"settings.json", "TEAM.md", "chatroom", "__pycache__", ".kit-stamp"}   # what tropa update doesn't copy over


def stamp():
    h = hashlib.sha256()
    kit = os.path.join(TROPA_HOME, "kit", ".agent_sync")
    for f in sorted(os.listdir(kit)):
        p = os.path.join(kit, f)
        if f not in SKIP and os.path.isfile(p):
            h.update(f.encode() + b"\0" + open(p, "rb").read())
    skills = os.path.join(TROPA_HOME, "skills")
    for d, dirs, files in sorted(os.walk(skills)):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            h.update(os.path.relpath(p, skills).encode() + b"\0" + open(p, "rb").read())
    return h.hexdigest()[:16]


if __name__ == "__main__":
    print(stamp())
