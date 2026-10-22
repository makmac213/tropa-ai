#!/usr/bin/env python3
"""Copy tropa's default skills into a project's .agents/skills.

  sync_skills.py SRC_SKILLS_DIR PROJECT/.agents/skills

New skills are added; skills tropa installed earlier are refreshed. A skill is left alone if
the project has its own skill with that name (no .tropa-managed file) or if its SKILL.md was
edited since tropa installed it (.tropa-managed holds the hash of what was installed).
"""
import hashlib, os, shutil, sys

src, dst = sys.argv[1], sys.argv[2]
digest = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
added, updated, kept = [], [], []
os.makedirs(dst, exist_ok=True)
try:   # default skills the human deleted in the chat's Skills panel: don't bring them back
    removed = {x.strip() for x in open(os.path.join(dst, ".tropa-removed")) if x.strip()}
except OSError:
    removed = set()
for name in sorted(os.listdir(src)):
    if name in removed:
        continue
    s = os.path.join(src, name)
    if not os.path.isfile(os.path.join(s, "SKILL.md")):
        continue
    d = os.path.join(dst, name)
    if os.path.exists(d):
        marker, skill = os.path.join(d, ".tropa-managed"), os.path.join(d, "SKILL.md")
        if not os.path.exists(marker):
            kept.append(name); continue                       # the project's own skill with this name
        recorded = open(marker).read().strip()
        if recorded and os.path.exists(skill) and digest(skill) != recorded:
            kept.append(name + " (edited)"); continue         # edited in the project: leave it alone
        if os.path.exists(skill) and digest(skill) == digest(os.path.join(s, "SKILL.md")):
            continue                                          # already current
        shutil.rmtree(d); updated.append(name)
    else:
        added.append(name)
    shutil.copytree(s, d)
    with open(os.path.join(d, ".tropa-managed"), "w") as f:
        f.write(digest(os.path.join(d, "SKILL.md")) + "\n")
if added:   print("  + skills: " + ", ".join(added))
if updated: print("  ↻ skills: " + ", ".join(updated))
if kept:    print("  = skills kept as you have them: " + ", ".join(kept))
