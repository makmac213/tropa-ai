#!/bin/bash
# TropaAI team control panel: create agents (Claude Code / OpenCode / Qwen Code),
# pick their model and lead, start them in tmux, and run the room watcher.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(dirname "$HERE")"
cfg()  { python3 "$HERE/config.py" get "$1"; }
setc() { python3 "$HERE/config.py" set "$1" "$2"; }

mkdir -p "$HERE/chatroom" "$ROOT/agents" "$ROOT/$(cfg docs_dir)"
touch "$HERE/chatroom/broadcast.txt"
SESSION_NAME="$(cfg tmux_session)"

# --- preflight -------------------------------------------------------------
for bin in tmux python3 curl; do
    command -v "$bin" >/dev/null || { if [ "$(uname)" = Darwin ]; then h="brew install $bin"; else h="install $bin with your package manager (e.g. sudo apt-get install -y $bin)"; fi; echo "❌ '$bin' is not installed — $h"; exit 1; }
done
if ! curl -fsS "$(cfg server)/health" >/dev/null 2>&1; then
    echo "⚠️  TropaAI is not answering at $(cfg server)."
    TH="$(cfg tropa_home)"
    if [ -n "$TH" ] && [ -x "$TH/tropa" ]; then
        read -p "   Start it now with '$TH/tropa server up'? (y/n) [y]: " SU
        [ "${SU:-y}" = y ] && "$TH/tropa" server up
    else
        echo "   Start it: <tropa-ai>/tropa server up"
    fi
fi
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux new-session -d -s "$SESSION_NAME" -n ControlCenter -c "$ROOT"
    echo "Initialized tmux session '$SESSION_NAME'"
fi

# --- pickers (bash 3.2 compatible) -------------------------------------------
pick_tool() {
    echo "Agent type:"
    echo "  1) Claude Code   2) OpenCode   3) Qwen Code   4) Codex"
    read -p "Choose [1]: " T
    case "${T:-1}" in
        1) TOOL=claude ;; 2) TOOL=opencode ;; 3) TOOL=qwen ;; 4) TOOL=codex ;;
        *) echo "❌ Invalid choice"; return 1 ;;
    esac
    command -v "$TOOL" >/dev/null || echo "⚠️  '$TOOL' not found on PATH — install it before the agent can start."
}

# pick_model TOOL -> sets PICKED_MODEL ("" = CLI default)
pick_model() {
    local tool="$1" ids=() labels=() t id label filter n i choice live
    ids+=(""); labels+=("CLI default")
    while IFS='|' read -r t id label; do
        case "$t" in ''|\#*) continue;; esac
        [ "$t" = "$tool" ] || continue
        ids+=("$id"); labels+=("${label:+$label — }$id")
    done < <(
        TH="$(cfg tropa_home)"
        if [ -n "$TH" ] && [ -f "$TH/host/tropa_host.py" ]; then
            echo "Looking up models (your accounts + models.conf)..." >&2
            python3 "$TH/host/tropa_host.py" --list-models "$tool" 2>/dev/null
        else cat "$HERE/models.conf"; fi)
    if [ "$tool" = opencode ] && command -v opencode >/dev/null && [ ! -f "$(cfg tropa_home)/host/tropa_host.py" ]; then
        echo "Fetching models from 'opencode models'..."
        live=$(opencode models 2>/dev/null | grep '/')
        if [ -n "$live" ]; then
            n=$(printf '%s\n' "$live" | wc -l | tr -d ' ')
            if [ "$n" -gt 25 ]; then
                read -p "$n models available. Filter (e.g. anthropic, qwen, free) or Enter for all: " filter
                [ -n "$filter" ] && live=$(printf '%s\n' "$live" | grep -i -- "$filter")
            fi
            while IFS= read -r id; do [ -n "$id" ] && { ids+=("$id"); labels+=("$id"); }; done <<< "$live"
        fi
    fi
    ids+=("__other__"); labels+=("Other (type a model id)")
    echo "Model:"
    i=0; while [ $i -lt ${#ids[@]} ]; do printf "  %2d) %s\n" $((i+1)) "${labels[$i]}"; i=$((i+1)); done
    while true; do
        read -p "Choose [1]: " choice; choice=${choice:-1}
        if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#ids[@]} ]; then break; fi
        echo "Enter a number from the list."
    done
    PICKED_MODEL="${ids[$((choice-1))]}"
    [ "$PICKED_MODEL" = "__other__" ] && read -p "Model id: " PICKED_MODEL
}

# --- actions -----------------------------------------------------------------
start_watcher() {
    if tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' | grep -qx watcher; then
        echo "👀 Room watcher already running (window 'watcher')"
    else
        tmux new-window -d -t "$SESSION_NAME" -n watcher -c "$ROOT" "python3 \"$HERE/room_watcher.py\"; read -p 'watcher stopped — Enter to close'"
        echo "👀 Room watcher started (window 'watcher')"
    fi
}

list_agents() {
    python3 - "$ROOT/agents" "$(cfg lead)" <<'PY'
import glob, json, os, sys
rows = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(sys.argv[1], "*", "agent.json")))]
if not rows: print("  (no agents yet)")
for d in rows:
    star = "★" if d["name"] == sys.argv[2] else " "
    print(f"  {star} @{d['name']:<16} {d['tool']:<9} {d.get('model') or 'CLI default':<30} {d.get('role','')}")
PY
}

refresh_all() {
    # Roster/lead changed: rebuild files; running agents see TEAM.md on their next read.
    python3 "$HERE/setup_agent.py" refresh
}

create_single_agent() {
    echo ""
    echo "========================================="
    echo "🤖 CREATE A NEW AGENT"
    echo "========================================="
    read -p "Agent name (this is its @mention, e.g. lead, BA, QA, dev): " AGENT_NAME
    AGENT_NAME=$(echo "$AGENT_NAME" | tr -cd 'A-Za-z0-9._-')
    [ -z "$AGENT_NAME" ] && { echo "❌ Agent name cannot be empty!"; return; }
    case "$(echo "$AGENT_NAME" | tr 'A-Z' 'a-z')" in
        controlcenter|watcher|all|here|team|everyone|"$(cfg human | tr 'A-Z' 'a-z')") echo "❌ '$AGENT_NAME' is reserved"; return;;
    esac
    if [ -d "$ROOT/agents/$AGENT_NAME" ]; then
        read -p "⚠️  '$AGENT_NAME' exists. Overwrite its config and restart it? (y/n): " CONFIRM
        [ "$CONFIRM" != "y" ] && return
    fi

    pick_tool || return
    pick_model "$TOOL"; AGENT_MODEL="$PICKED_MODEL"
    read -p "Role description: " AGENT_ROLE
    read -p "Initial instruction: " AGENT_INIT

    local cur_lead lead_flag=""; cur_lead=$(cfg lead)
    if [ -z "$cur_lead" ]; then
        read -p "Make @$AGENT_NAME the team lead? (y/n) [n]: " L
    elif [ "$cur_lead" != "$AGENT_NAME" ]; then
        read -p "Make @$AGENT_NAME the lead instead of @$cur_lead? (y/n) [n]: " L
    else
        L=y
    fi
    [ "$L" = y ] && lead_flag="--lead"

    python3 "$HERE/setup_agent.py" create "$AGENT_NAME" "$TOOL" "$AGENT_ROLE" "$AGENT_INIT" "$AGENT_MODEL" $lead_flag >/dev/null || return
    refresh_all
    "$HERE/start_agent.sh" "$AGENT_NAME"
}

change_model() {
    read -p "Agent name: " N
    local f="$ROOT/agents/$N/agent.json"
    [ -f "$f" ] || { echo "❌ No agent named '$N'"; return; }
    local tool; tool=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["tool"])' "$f")
    pick_model "$tool"
    python3 - "$f" "$PICKED_MODEL" <<'PY'
import json, sys
p, m = sys.argv[1], sys.argv[2]
d = json.load(open(p)); d["model"] = m
with open(p, "w") as fh: json.dump(d, fh, indent=2); fh.write("\n")
PY
    echo "Model set to: ${PICKED_MODEL:-CLI default}"
    refresh_all
    read -p "Restart @$N now to apply? (y/n): " R
    [ "$R" = y ] && "$HERE/start_agent.sh" "$N"
}

set_lead() {
    list_agents
    read -p "Lead agent name (blank = no lead): " N
    if [ -n "$N" ] && [ ! -f "$ROOT/agents/$N/agent.json" ]; then echo "❌ No agent named '$N'"; return; fi
    setc lead "\"$N\""; refresh_all
    echo "Lead: ${N:-none}. Restart agents (option 3 restarts any that are stopped; option 4 restarts one) so they pick up the new role."
}

settings_menu() {
    while true; do
        echo ""
        echo "--- Settings (.agent_sync/settings.json) ---"
        echo "  project room : $(cfg room)"
        echo "  lead         : $(cfg lead)"
        echo "  auto-wake    : $(cfg wake)   rules: $(cfg wake_rules)   limit/hour: $(cfg max_wakes_per_agent_per_hour) (0 = none)"
        echo "  history      : last $(cfg history_limit) messages"
        echo "  claude flags : $(cfg tool_flags.claude)"
        echo "  opencode     : $(cfg tool_flags.opencode)"
        echo "  qwen flags   : $(cfg tool_flags.qwen)"
        echo "  codex flags  : $(cfg tool_flags.codex)"
        echo "1) Pause / resume auto-wake   2) Set lead   3) History limit"
        echo "4) Wake limit per hour        5) Wake rules (smart/all)"
        echo "6) Edit CLI flags             7) Back"
        read -p "Choose: " S
        case $S in
            1) if [ "$(cfg wake)" = paused ]; then setc wake '"auto"'; echo "▶️  auto-wake on"; else setc wake '"paused"'; echo "⏸  auto-wake paused"; fi ;;
            2) set_lead ;;
            3) read -p "Messages to read: " V; [[ "$V" =~ ^[0-9]+$ ]] && setc history_limit "$V" ;;
            4) read -p "Max wakes per agent per hour (0 = no limit): " V; [[ "$V" =~ ^[0-9]+$ ]] && setc max_wakes_per_agent_per_hour "$V" ;;
            5) read -p "smart or all: " V; case "$V" in smart|all) setc wake_rules "\"$V\"";; esac ;;
            6) read -p "Tool (claude/opencode/qwen/codex): " T
               case "$T" in claude|opencode|qwen|codex)
                   read -p "Flags for $T [$(cfg tool_flags.$T)]: " V
                   python3 - "$HERE/settings.json" "$T" "$V" <<'PY'
import json, sys
p, t, v = sys.argv[1:4]
d = json.load(open(p)); d.setdefault("tool_flags", {})[t] = v
with open(p, "w") as fh: json.dump(d, fh, indent=2); fh.write("\n")
PY
                   echo "Saved. Applies the next time each $T agent starts." ;;
               esac ;;
            7) return ;;
        esac
    done
}

while true; do
    echo ""
    echo "========================================="
    echo "🛠️  TropaAI Agent Panel — $(cfg room)"
    echo "========================================="
    echo "1) Create a single agent        2) Create multiple agents"
    echo "3) Start all agents + watcher   4) Restart one agent"
    echo "5) Change an agent's model      6) List agents"
    echo "7) Wake everyone now            8) Settings"
    echo "9) Exit panel                   d) Doctor (check setup)"
    read -p "Choose an option: " OPT
    case $OPT in
        1) create_single_agent; start_watcher ;;
        2) read -p "How many agents? " COUNT
           for ((i=1; i<=COUNT; i++)); do echo ""; echo "--- Agent $i of $COUNT ---"; create_single_agent; done
           start_watcher ;;
        3) "$HERE/start_agent.sh" --all; start_watcher ;;
        4) read -p "Agent name: " N; "$HERE/start_agent.sh" "$N" ;;
        5) change_model ;;
        6) list_agents ;;
        7) "$HERE/wake_all.sh" ;;
        8) settings_menu ;;
        d|D) python3 "$HERE/doctor.py" ;;
        9) echo "Run 'tmux attach -t $SESSION_NAME' to watch your agents."; exit 0 ;;
        *) echo "Invalid choice." ;;
    esac
done
