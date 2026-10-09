#!/bin/bash
# End-to-end demo: a 5-agent Claude Code team builds a small todo app.
#   scripts/demo-todo.sh [DIR] [-p PORT]        (default ~/projects/todo-demo, port 8888)
# Uses your Claude Code account. Stop everything with:  tmux kill-session -t ai-todo-demo
set -e
TROPA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tropa"
DIR="$HOME/projects/todo-demo"; PORT=8888
while [ $# -gt 0 ]; do case "$1" in -p) PORT="$2"; shift;; *) DIR="$1";; esac; shift; done
command -v claude >/dev/null || { echo "❌ claude (Claude Code) is not installed"; exit 1; }
command -v tmux   >/dev/null || { echo "❌ tmux is not installed (brew install tmux)"; exit 1; }

mkdir -p "$DIR/docs"
"$TROPA" init -p "$PORT" "$DIR"
cd "$DIR"
S=.agent_sync
C() { python3 "$S/config.py" "$@"; }
SESSION=$(C get tmux_session); ROOM=$(C get room); HUMAN=$(C get human)

# Claude permission mode: "auto" if this Claude Code has it, else auto-accept edits
if claude --help 2>/dev/null | grep -q '"auto"'; then C set tool_flags.claude '"--permission-mode auto"'
else C set tool_flags.claude '"--permission-mode acceptEdits"'; echo "ℹ️  Claude Code has no 'auto' mode here; using acceptEdits (shell commands will ask — the watcher posts those to the room)"; fi

cat > docs/SPEC.md <<'MD'
# Todo app — spec

A small single-user todo app. Keep it dependency-free so it runs anywhere with Node ≥ 18.
All paths below are relative to the **project folder** (the folder that contains `docs/`), not your agent folder.

## Layout
- `app/server.js` — Node `http` server (no frameworks) on `PORT` (default **3000**)
- `app/public/index.html` — the UI (vanilla HTML/CSS/JS, one file), served at `/`
- `app/data/todos.json` — storage (created on first run; gitignored)
- `tests/` — `node --test` tests
- `Dockerfile`, `Makefile` (or `run.sh`) and `README.md` — run, test, build

## API (JSON)
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/todos` | | `[{id, title, done, createdAt}]` |
| POST | `/api/todos` | `{title}` | 201 + created todo; 400 if title empty/missing or > 200 chars |
| PATCH | `/api/todos/:id` | `{title?, done?}` | updated todo; 404 if missing |
| DELETE | `/api/todos/:id` | | 204; 404 if missing |
| GET | `/health` | | `{ok: true}` |

## UI
Add a todo (Enter or button), tick to complete, double-click to edit, delete button, filter All / Active / Done, "N items left" counter. Works on a phone-width screen.

## Done means
- `npm test` (or `node --test`) passes; tests cover every endpoint, including the error cases
- `node app/server.js` serves the UI and API on :3000
- `docker build` works and the container passes `/health`
- README explains run / test / docker
MD

create() { python3 "$S/setup_agent.py" create "$@" >/dev/null && echo "  + @$1"; }
echo "🤖 Creating agents"
create lead claude "Tech lead: plans the work, assigns tasks, reviews, reports to $HUMAN" \
  "Read docs/SPEC.md. When $HUMAN asks for the app, split it into tasks and assign them with @mentions (backend, frontend, ops, QA). Agree the API contract first so frontend and backend can work in parallel. Keep the room updated and tell @$HUMAN when everything in 'Done means' is met." sonnet --lead
create backend claude "Backend developer: Node http server and JSON storage in app/" \
  "Own app/server.js and the API in docs/SPEC.md. No npm dependencies. When done, post the exact run command and hand off to @QA." sonnet
create frontend claude "Frontend developer: the single-page UI in app/public/index.html" \
  "Own app/public/index.html per docs/SPEC.md, calling the API with fetch. No frameworks or build step. Hand off to @QA when ready." sonnet
create QA claude "QA engineer: tests with node --test, finds and reports bugs" \
  "Write tests in tests/ with node:test (start the server on a random port in the test). Cover every endpoint and error case. Report bugs to the owner by @mention with steps to reproduce; confirm fixes." haiku
create ops claude "DevOps: Dockerfile, run/test scripts, README" \
  "Own Dockerfile, package.json scripts (start, test), .gitignore and README.md. Verify docker build if Docker is available; otherwise say so. Tell @lead when done." haiku

# Pre-accept Claude Code's folder-trust dialog for the agent folders (backup kept)
python3 - "$DIR" <<'PY'
import json, os, shutil, sys, time
p = os.path.expanduser("~/.claude.json")
if not os.path.exists(p):
    sys.exit()
shutil.copy(p, p + ".bak-tropa")
d = json.load(open(p))
for name in ("lead", "backend", "frontend", "QA", "ops"):
    ws = os.path.realpath(os.path.join(sys.argv[1], "agents", name))
    d.setdefault("projects", {}).setdefault(ws, {})["hasTrustDialogAccepted"] = True
tmp = p + ".tmp"; json.dump(d, open(tmp, "w"), indent=2); os.replace(tmp, p)
print("🔓 Trusted the 5 agent folders in ~/.claude.json (backup: ~/.claude.json.bak-tropa)")
PY

echo "🚀 Starting agents + watcher in tmux session '$SESSION'"
"$S/start_agent.sh" --all
tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx watcher || \
  tmux new-window -d -t "$SESSION" -n watcher -c "$DIR" "python3 $S/room_watcher.py; read -p 'watcher stopped — Enter to close'"

echo "⏳ Letting agents boot and register (30s)..."
sleep 30
MSG="Hi team. Please build the todo app described in docs/SPEC.md (project folder: $DIR). Lead: plan it, assign the work, and tell me when everything under 'Done means' is met."
python3 - "$(C get server)" "$ROOM" "$HUMAN" "$MSG" <<'PY'
import json, sys, urllib.parse, urllib.request
server, room, human, msg = sys.argv[1:5]
req = urllib.request.Request(f"{server}/api/rooms/{urllib.parse.quote(room, safe='')}/messages",
    data=json.dumps({"sender": human, "sender_kind": "human", "content": msg}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
print("📨 Kickoff posted as @%s (#%s)" % (human, json.load(urllib.request.urlopen(req)).get("id")))
PY
echo ""
echo "Watch:  tmux attach -t $SESSION       (Ctrl-b n / p to switch windows, Ctrl-b d to detach)"
echo "Chat:   open $(C get server)  → room $ROOM"
echo "Stop:   tmux kill-session -t $SESSION"
