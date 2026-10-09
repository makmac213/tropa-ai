#!/bin/bash
# Launch (or relaunch) agents from agents/<name>/agent.json in the team tmux session.
#   start_agent.sh NAME          open a tmux window for NAME and start its CLI
#   start_agent.sh --all         start every agent that isn't running
#   start_agent.sh --exec NAME   (internal) run the CLI in the current terminal
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(dirname "$HERE")"
cfg() { python3 "$HERE/config.py" get "$1"; }
SESSION_NAME="$(cfg tmux_session)"

field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }

ensure_session() {
    tmux has-session -t "$SESSION_NAME" 2>/dev/null || \
        tmux new-session -d -s "$SESSION_NAME" -n ControlCenter -c "$ROOT"
}

launch_window() {
    local name="$1" ws="$ROOT/agents/$1"
    [ -f "$ws/agent.json" ] || { echo "❌ No agent named '$name' (missing $ws/agent.json)"; return 1; }
    ensure_session
    if tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' | grep -qx "$name"; then
        echo "↺ '$name' already has a window; restarting it"
        tmux kill-window -t "$SESSION_NAME:$name"
    fi
    tmux new-window -d -t "$SESSION_NAME" -n "$name" -c "$ws" "\"$HERE/start_agent.sh\" --exec \"$name\""
    tmux set-option -w -t "$SESSION_NAME:$name" automatic-rename off >/dev/null
    tmux set-option -w -t "$SESSION_NAME:$name" allow-rename off >/dev/null
    echo "✅ Started @$name"
}

exec_agent() {
    local name="$1" ws="$ROOT/agents/$1"
    cd "$ws" || exit 1
    # Rebuild config from agent.json + settings so roster, lead and paths are always current.
    python3 "$HERE/setup_agent.py" refresh "$name"
    local tool model role provider project room history human docs flags
    tool=$(field agent.json tool); model=$(field agent.json model)
    role=$(field agent.json role); provider=$(field agent.json provider)
    project=$(cfg project); room=$(cfg room); history=$(cfg history_limit)
    human=$(cfg human); docs=$(cfg docs_path); flags=$(cfg "tool_flags.$tool")
    local boot="Startup: you are '$name' on the TropaAI chat. Call the tropa register tool with agent \"$name\", project \"$project\", provider \"$provider\", model set to your exact model id, and description \"$role\". Then read the last $history messages of room \"$room\" (read_messages with recent=true, limit=$history) to catch up; the chatroom is the team's memory. Project specs and docs are in $docs. Follow AGENTS.md: do not post an introduction or acknowledgement; act only if a message assigns you work (an @$name mention) or otherwise needs you, then wait."
    case "$tool" in
        claude)   exec claude $flags -n "$name" ${model:+--model "$model"} "$boot" ;;
        opencode) cd "$ROOT" && OPENCODE_CONFIG="$ws/opencode.json" exec opencode $flags ${model:+-m "$model"} --prompt "$boot" ;;
        qwen)     exec qwen $flags --include-directories "$ROOT" ${model:+-m "$model"} -i "$boot" ;;
        codex)    # Runs in the project root (reads the root AGENTS.md itself); identity is in AGENT.md.
                  # The tropa MCP server is passed as a -c override, so ~/.codex (and its login) is untouched.
                  local url; url="$(cfg server)/mcp?agent=$name&project=$project"
                  cd "$ROOT" && exec codex $flags -C "$ROOT" ${model:+-m "$model"} \
                      -c "mcp_servers.tropa.url=\"$url\"" \
                      "First read agents/$name/AGENT.md (your identity and role) and .agent_sync/TEAM.md (the team). $boot" ;;
        *) echo "Unknown tool '$tool' in agent.json"; sleep 30; exit 1 ;;
    esac
}

case "$1" in
    --exec) exec_agent "$2" ;;
    --all)
        for d in "$ROOT"/agents/*/; do
            n=$(basename "$d"); [ -f "$d/agent.json" ] || continue
            tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -qx "$n" || launch_window "$n"
        done ;;
    "") echo "usage: start_agent.sh NAME | --all" ; exit 1 ;;
    *) launch_window "$1" ;;
esac
