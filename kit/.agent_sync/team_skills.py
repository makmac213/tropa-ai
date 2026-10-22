"""The team's skills (<root>/.agents/skills/<name>/SKILL.md), listed for and edited from the chat.

list_skills(root)                                   -> [{name, description, roles, managed, text}]
save_skill(root, name, description, roles, body)    write SKILL.md (keeps front matter it doesn't manage)
remove_skill(root, name)                            delete the folder; a default skill stays removed on tropa update
"""
import json, os, re, shutil

NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")   # Agent Skills: lowercase letters, digits and hyphens
MAX_TEXT = 60000
REMOVED = ".tropa-removed"                          # default skills the human deleted (sync_skills.py skips them)


def base(root):
    return os.path.join(root, ".agents", "skills")


def skill_dir(root, name):
    if not NAME.match(name or "") or len(name) > 64:
        raise ValueError("a skill name is lowercase letters, digits and hyphens, e.g. weekly-report")
    b = os.path.realpath(base(root))
    d = os.path.join(b, name)
    if os.path.islink(d) or not os.path.realpath(d).startswith(b + os.sep):
        raise ValueError(f"{name} isn't a skill folder tropa can change")
    return d


def split(text):
    """(front matter lines, body) of a SKILL.md."""
    m = re.match(r"^---[ \t]*\n(.*?)\n---[ \t]*\n?", text, re.S)
    return (m.group(1).split("\n"), text[m.end():]) if m else ([], text)


def field(fm, key):
    for i, line in enumerate(fm):
        m = re.match(rf"^\s*{key}:\s*(.*)$", line)
        if m:
            v = m.group(1).strip()
            if v in (">", "|", ">-", "|-", ">+", "|+"):   # folded / literal block: the indented lines after it
                lines = []
                for nxt in fm[i + 1:]:
                    if nxt.strip() and not nxt.startswith((" ", "\t")):
                        break
                    lines.append(nxt.strip())
                return " ".join(x for x in lines if x)
            try:
                return json.loads(v) if v.startswith('"') else v.strip("'")
            except ValueError:
                return v.strip('"')
    return ""


def list_skills(root):
    out, b = [], base(root)
    try:
        names = sorted(os.listdir(b))
    except OSError:
        return out
    for name in names:
        p = os.path.join(b, name, "SKILL.md")
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                text = f.read(MAX_TEXT + 1)
        except OSError:
            continue
        fm, _ = split(text)
        roles = [r.strip() for r in field(fm, "tropa-roles").split(",") if r.strip()]
        out.append({"name": field(fm, "name") or name, "dir": name, "description": field(fm, "description")[:1024],
                    "roles": roles or ["all"], "managed": os.path.exists(os.path.join(b, name, ".tropa-managed")),
                    "text": text[:MAX_TEXT]})
        if len(out) >= 100:
            break
    return out


def drop_key(fm, key, nested=False):
    """Remove a key (top-level, or at any depth if nested) and the indented lines that belong to it."""
    out, skipping = [], False
    for line in fm:
        if re.match(rf"^\s*{key}:" if nested else rf"^{key}:", line):
            skipping = not line.startswith((" ", "\t"))   # a top-level key owns the indented lines after it
            continue
        if skipping and (not line.strip() or line.startswith((" ", "\t"))):
            continue
        skipping = False
        out.append(line)
    return out


def save_skill(root, name, description, roles, body):
    d = skill_dir(root, name)
    description = re.sub(r"\s+", " ", str(description or "")).strip()
    if not description:
        raise ValueError("say when the skill should be used (its description)")
    if len(description) > 1024:
        raise ValueError("the description is too long (1024 characters at most)")
    body = str(body or "").strip()
    if len(body) > MAX_TEXT:
        raise ValueError("the instructions are too long")
    roles = [r for r in (str(x).strip() for x in roles or []) if re.fullmatch(r"[A-Za-z0-9._-]{1,40}", r)]
    p = os.path.join(d, "SKILL.md")
    try:
        with open(p, encoding="utf-8") as f:
            fm, _ = split(f.read())
    except OSError:
        fm = []
    fm = drop_key(drop_key(drop_key(fm, "name"), "description"), "tropa-roles", nested=True)
    fm = [f"name: {name}", f"description: {json.dumps(description, ensure_ascii=False)}"] + [x for x in fm if x.strip()]
    if roles and "all" not in roles:
        line = f'  tropa-roles: "{", ".join(roles)}"'
        i = next((i for i, x in enumerate(fm) if re.match(r"^metadata:\s*$", x)), None)
        if i is None:
            fm += ["metadata:", line]
        else:
            fm.insert(i + 1, line)
    i = next((i for i, x in enumerate(fm) if re.match(r"^metadata:\s*$", x)), None)
    if i is not None and not (i + 1 < len(fm) and fm[i + 1].startswith((" ", "\t"))):
        del fm[i]                                       # an empty metadata block
    os.makedirs(d, exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("---\n" + "\n".join(fm) + "\n---\n\n" + body + "\n")
    os.replace(tmp, p)
    unremove(root, name)


def removed(root):
    try:
        with open(os.path.join(base(root), REMOVED), encoding="utf-8") as f:
            return {x.strip() for x in f if x.strip()}
    except OSError:
        return set()


def unremove(root, name):
    r = removed(root)
    if name in r:
        r.discard(name)
        with open(os.path.join(base(root), REMOVED), "w", encoding="utf-8") as f:
            f.write("".join(x + "\n" for x in sorted(r)))


def remove_skill(root, name):
    d = skill_dir(root, name)
    if not os.path.isdir(d):
        raise ValueError(f"there's no skill named {name}")
    managed = os.path.exists(os.path.join(d, ".tropa-managed"))
    shutil.rmtree(d)
    if managed:   # one of tropa's defaults: remember, so tropa update doesn't bring it back
        with open(os.path.join(base(root), REMOVED), "a", encoding="utf-8") as f:
            f.write(name + "\n")
