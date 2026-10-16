#!/usr/bin/env python3
"""Design systems: one Markdown file each in <tropa>/design-systems/ (front matter + guidance for agents).

  design_systems.py list                       id · name · best for
  design_systems.py show ID                    the file
  design_systems.py use ID PROJECT_DIR         write docs/DESIGN_SYSTEM.md + the `design-system` skill
  design_systems.py json                       catalog as JSON (used by the host helper / chat)
"""
import json, os, re, subprocess, sys

TROPA_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(TROPA_HOME, "design-systems")
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def parse(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return None
    meta = {}
    for line in m.group(1).splitlines():
        line = re.sub(r"\s+#.*$", "", line) if not line.strip().startswith('"') else line
        mm = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if mm:
            v = mm.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            meta[mm.group(1)] = v
    meta["body"] = m.group(2).strip()
    return meta


def catalog():
    out = []
    if not os.path.isdir(DIR):
        return out
    for f in sorted(os.listdir(DIR)):
        if not f.endswith(".md") or f.lower() == "readme.md":
            continue
        meta = parse(os.path.join(DIR, f))
        if not meta:
            continue
        ds_id = meta.get("id") or f[:-3]
        if not ID_RE.match(ds_id):
            continue
        preview = {k[len("preview-"):]: v for k, v in meta.items() if k.startswith("preview-")}
        out.append({"id": ds_id, "name": meta.get("name", ds_id), "summary": meta.get("summary", ""),
                    "best_for": meta.get("best-for", ""), "docs": meta.get("docs", ""), "preview": preview,
                    "guidance": meta["body"][:12000], "file": os.path.join(DIR, f)})
    return out


def get(ds_id):
    return next((d for d in catalog() if d["id"] == ds_id), None)


def use(ds_id, root):
    """Apply a design system to a project. Returns a short report line."""
    d = get(ds_id)
    if not d:
        raise SystemExit(f"unknown design system '{ds_id}'. Try: {', '.join(x['id'] for x in catalog())}")
    root = os.path.abspath(root)
    docs = os.path.join(root, "docs")
    os.makedirs(docs, exist_ok=True)
    header = (f"<!-- Design system for this project: {d['name']} (id: {d['id']}). Added by tropa; edit freely. "
              f"Re-apply with: tropa design use {d['id']} -->\n\n")
    meta = f"> **Best for:** {d['best_for']}  \n> **Reference:** {d['docs']}\n\n" if d["best_for"] or d["docs"] else ""
    with open(os.path.join(docs, "DESIGN_SYSTEM.md"), "w") as f:
        f.write(header + (insert_after_title(d["guidance"], meta) if meta else d["guidance"]) + "\n")
    skill_dir = os.path.join(root, ".agents", "skills", "design-system")
    os.makedirs(skill_dir, exist_ok=True)
    desc = (f"This project's design system is {d['name']}. Load it for ANY UI or frontend work: pages, components, "
            f"styling, theming, layout, UI review and UI testing. It covers the packages, tokens, components, layout rules and do/don't.")
    with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
        f.write(f"---\nname: design-system\ndescription: {desc}\nmetadata:\n  tropa-roles: \"dev,lead,qa\"\n  tropa-design-system: \"{d['id']}\"\n---\n\n"
                f"Full guidance (also in `docs/DESIGN_SYSTEM.md`, the copy humans edit; if they differ, follow `docs/DESIGN_SYSTEM.md`):\n\n{d['guidance']}\n")
    cfg = os.path.join(root, ".agent_sync", "config.py")
    if os.path.exists(cfg):
        subprocess.run([sys.executable, cfg, "set", "design_system", json.dumps(d["id"])], check=False)
        subprocess.run([sys.executable, os.path.join(root, ".agent_sync", "setup_agent.py"), "refresh"], capture_output=True)
    return f"{d['name']} → docs/DESIGN_SYSTEM.md and the design-system skill"


def insert_after_title(body, block):
    lines = body.split("\n", 1)
    return lines[0] + "\n\n" + block + (lines[1].lstrip("\n") if len(lines) > 1 else "")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "list":
        for d in catalog():
            print(f"  {d['id']:<18} {d['name']:<24} {d['best_for']}")
    elif a[0] == "json":
        print(json.dumps([{k: v for k, v in d.items() if k != "file"} for d in catalog()]))
    elif a[0] == "show" and len(a) > 1:
        d = get(a[1]) or sys.exit(f"unknown design system '{a[1]}'")
        print(open(d["file"]).read())
    elif a[0] == "use" and len(a) > 1:
        print("🎨 " + use(a[1], a[2] if len(a) > 2 else "."))
    else:
        sys.exit(__doc__)
