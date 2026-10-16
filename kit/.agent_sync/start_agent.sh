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
    case "$(cfg auto_approve)" in True|true|1) flags=$(cfg "auto_approve_flags.$tool"); echo "⚡ auto-approve is on: $tool runs without permission prompts" ;; esac
    local started; started=$(date +%s)
    # Local model through Ollama: model "ollama/<name>"
    local local_model="" ourl=""
    case "$model" in ollama/*)
        local_model="${model#ollama/}"
        ourl=$(OLLAMA_URL_CFG="$(cfg ollama_url)" python3 -c "import os,sys; sys.path.insert(0,'$HERE'); import ollama_local; print(ollama_local.url({'ollama_url': os.environ.get('OLLAMA_URL_CFG','')}))")
        echo "🦙 local model $local_model via Ollama at $ourl"
        if ! problem=$(OLLAMA_HOST="$ourl" python3 "$HERE/ollama_local.py" check "$local_model"); then
            echo "❌ $problem"; after_exit "$name" "$tool" 1 "$started"
        fi ;;
    esac
    export TROPA_PROJECT="$project"   # keys.py / openrouter.py: a project's own API key wins over the global one
    case "$tool:$model" in gemini:ollama/*|gemini:openrouter/*)
        echo "❌ Gemini CLI only runs Google's Gemini models; '$model' needs another CLI (Claude Code, Codex, OpenCode or Qwen Code)."
        after_exit "$name" "$tool" 1 "$started" ;;
    esac
    # OpenRouter: model "openrouter/<author>/<slug>" (key: the project's own, $OPENROUTER_API_KEY, or the global one; see keys.py)
    local or_model="" or_key=""
    case "$model" in openrouter/*)
        or_model="${model#openrouter/}"
        or_key=$(python3 "$HERE/openrouter.py" key) || or_key=""
        echo "🔀 $or_model via OpenRouter"
        if ! problem=$(python3 "$HERE/openrouter.py" check "$or_model"); then
            echo "❌ $problem"; after_exit "$name" "$tool" 1 "$started"
        fi
        export OPENROUTER_API_KEY="$or_key" ;;
    esac
    local boot="Startup: you are '$name' on the TropaAI chat. Call the tropa register tool with agent \"$name\", project \"$project\", provider \"$provider\", model set to your exact model id, and description \"$role\". Then read the last $history messages of room \"$room\" (read_messages with recent=true, limit=$history) to catch up; the chatroom is the team's memory. Project specs and docs are in $docs. Follow AGENTS.md: do not post an introduction or acknowledgement; act only if a message assigns you work (an @$name mention) or otherwise needs you. For assigned work: post a one-line plan, keep set_status current, and finish with a message that @mentions who is next (result, blocker or done). Never end a task silently."
    # Session resume: on a restart, continue the agent's previous conversation instead of starting blank.
    local resume=0 marker="$ws/.tropa-session"
    case "$(cfg resume_sessions)" in False|false|0) ;; *) [ -f "$marker" ] && resume=1 ;; esac
    local rboot="Restarted: your earlier conversation is above, so continue where you left off. If you were mid-task, post a one-line status first. $boot"
    run_cli "$resume"; local rc=$?
    if [ "$resume" = 1 ] && [ "$rc" != 0 ] && [ $(( $(date +%s) - started )) -lt 20 ]; then
        echo; echo "↻ Couldn't resume the previous session; starting a fresh one."
        started=$(date +%s); run_cli 0; rc=$?
    fi
    after_exit "$name" "$tool" $rc "$started"
}

# $1 = 1 to resume the agent's previous session (CLI permitting), 0 for a fresh one
run_cli() {
    local r="$1" p="$boot" res=()
    [ "$r" = 1 ] && p="$rboot"
    touch "$ws/.tropa-session"
    case "$tool" in
        claude)   [ "$r" = 1 ] && res=(--continue) && echo "↻ resuming the previous Claude Code session"
                  if [ -n "$local_model" ]; then   # Ollama ≥ 0.14 speaks the Anthropic Messages API
                      ANTHROPIC_BASE_URL="$ourl" ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" claude ${res[@]+"${res[@]}"} $flags -n "$name" --model "$local_model" "$p"
                  elif [ -n "$or_model" ]; then   # OpenRouter speaks the Anthropic Messages API; every model role points at the chosen one
                      ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$or_key" ANTHROPIC_API_KEY="" \
                      ANTHROPIC_DEFAULT_OPUS_MODEL="$or_model" ANTHROPIC_DEFAULT_SONNET_MODEL="$or_model" ANTHROPIC_DEFAULT_HAIKU_MODEL="$or_model" \
                      ANTHROPIC_DEFAULT_FABLE_MODEL="$or_model" CLAUDE_CODE_SUBAGENT_MODEL="$or_model" \
                      claude ${res[@]+"${res[@]}"} $flags -n "$name" --model "$or_model" "$p"
                  else   # long-lived login from `tropa claude-token set` (claude setup-token), so agents don't hit expired OAuth tokens
                      local ctok="$HOME/.config/tropa/claude.token"
                      if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -s "$ctok" ]; then
                          export CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$ctok")"; echo "🔑 using the long-lived Claude token (tropa claude-token)"
                      fi
                      claude ${res[@]+"${res[@]}"} $flags -n "$name" ${model:+--model "$model"} "$p"; fi ;;
        opencode) ( cd "$ROOT" || exit 1; local ochelp; ochelp=$(opencode --help 2>&1)
                    # OpenCode 2.x: a private server per agent (each has its own config + tropa identity), and --auto
                    case "$ochelp" in *--standalone*) flags="$flags --standalone" ;; esac
                    case "$(cfg auto_approve)" in True|true|1) case "$ochelp" in *--auto*) flags="$flags --auto" ;; esac ;; esac
                    # OpenCode keeps sessions per folder; all its agents share the project folder, so only
                    # resume when this is the project's only OpenCode agent (otherwise it could pick up a teammate's).
                    if [ "$r" = 1 ] && case "$ochelp" in *--continue*) true ;; *) false ;; esac &&
                       [ "$(grep -l '"tool": *"opencode"' "$ROOT"/agents/*/agent.json 2>/dev/null | wc -l)" -le 1 ]; then
                        res=(--continue); echo "↻ resuming the previous OpenCode session"
                    else p="$boot"; fi
                    OPENCODE_CONFIG="$ws/opencode.json" opencode $flags ${res[@]+"${res[@]}"} --prompt "$p" ) ;;   # model comes from opencode.json
        qwen)     if [ "$r" = 1 ] && qwen --help 2>&1 | grep -q -- '--continue'; then res=(--continue); echo "↻ resuming the previous Qwen Code session"; else p="$boot"; fi
                  if [ -n "$local_model" ]; then   # OpenAI-compatible endpoint (auth type set in .qwen/settings.json)
                      OPENAI_API_KEY=ollama OPENAI_BASE_URL="$ourl/v1" OPENAI_MODEL="$local_model" qwen ${res[@]+"${res[@]}"} $flags --include-directories "$ROOT" -m "$local_model" -i "$p"
                  elif [ -n "$or_model" ]; then   # OpenRouter's OpenAI-compatible endpoint
                      OPENAI_API_KEY="$or_key" OPENAI_BASE_URL="https://openrouter.ai/api/v1" OPENAI_MODEL="$or_model" qwen ${res[@]+"${res[@]}"} $flags --include-directories "$ROOT" -m "$or_model" -i "$p"
                  else qwen ${res[@]+"${res[@]}"} $flags --include-directories "$ROOT" ${model:+-m "$model"} -i "$p"; fi ;;
        gemini)   # Same layout as Qwen Code: GEMINI.md + .gemini/settings.json in the agent's folder (its own session history)
                  if [ "$r" = 1 ] && gemini --help 2>&1 | grep -q -- '--resume'; then res=(--resume latest); echo "↻ resuming the previous Gemini CLI session"; else p="$boot"; fi
                  local gkey="" gsrc=""
                  if gkey=$(python3 "$HERE/keys.py" get gemini --project "$project" 2>/dev/null); then
                      gsrc=$(python3 "$HERE/keys.py" where gemini --project "$project")
                      echo "🔑 Gemini API key: $gsrc"
                      GEMINI_API_KEY="$gkey" gemini ${res[@]+"${res[@]}"} $flags --include-directories "$ROOT" ${model:+-m "$model"} -i "$p"
                  else
                      echo "🔑 no Gemini API key set: using your Google sign-in (add a key in ⚙ Settings → API keys)"
                      gemini ${res[@]+"${res[@]}"} $flags --include-directories "$ROOT" ${model:+-m "$model"} -i "$p"
                  fi ;;
        codex)    # Runs in the project root (reads the root AGENTS.md itself); identity is in AGENT.md.
                  # The tropa MCP server is passed as a -c override, so ~/.codex (and its login) is untouched.
                  local url; url="$(cfg server)/mcp?agent=$name&project=$project"
                  local extra=() line sid=""
                  if [ -f "$ws/codex-tools.args" ]; then while IFS= read -r line; do [ -n "$line" ] && extra+=("$line"); done < "$ws/codex-tools.args"; fi
                  local oss=() m="$model"; [ -n "$local_model" ] && { oss=(--oss); m="$local_model"; export CODEX_OSS_BASE_URL="$ourl/v1"; }
                  # OpenRouter as a custom provider (Responses API), passed as -c overrides so ~/.codex stays untouched
                  [ -n "$or_model" ] && { m="$or_model"; oss=(-c 'model_provider="openrouter"' -c 'model_providers.openrouter.name="OpenRouter"'
                      -c 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"' -c 'model_providers.openrouter.wire_api="responses"'
                      -c 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"'); }
                  # Codex sessions all live in one place: find this agent's own latest one by its startup prompt
                  [ "$r" = 1 ] && sid=$(python3 "$HERE/last_session.py" codex "$name" "$project" 2>/dev/null)
                  if [ -n "$sid" ]; then res=(resume "$sid"); echo "↻ resuming Codex session $sid"; else p="$boot"; fi
                  ( cd "$ROOT" && codex ${res[@]+"${res[@]}"} $flags ${oss[@]+"${oss[@]}"} -C "$ROOT" ${m:+-m "$m"} \
                      -c "mcp_servers.tropa.url=\"$url\"" ${extra[@]+"${extra[@]}"} \
                      "First read agents/$name/AGENT.md (your identity and role) and .agent_sync/TEAM.md (the team). $p" ) ;;
        *) echo "Unknown tool '$tool' in agent.json"; sleep 30; exit 1 ;;
    esac
}


# The CLI ended. If it died early or with an error, keep the window open so the error stays readable,
# and tell the room (otherwise the window just vanishes and the agent is silently missing).
after_exit() {
    local name="$1" tool="$2" rc="$3" started="$4" ran=$(( $(date +%s) - $4 ))
    [ "$rc" = 0 ] && [ "$ran" -ge 60 ] && exit 0
    local tail; tail=$(tmux capture-pane -p -J -S -30 ${TMUX_PANE:+-t "$TMUX_PANE"} 2>/dev/null | grep -v '^[[:space:]]*$' | tail -8 | cut -c1-160)
    TROPA_SYNC="$HERE" python3 - "$name" "$tool" "$rc" "$ran" "$tail" <<'PY'
import json, sys, urllib.request
sys.path.insert(0, sys.path[0] or ".")
name, tool, rc, ran, tail = sys.argv[1:6]
try:
    import os; sys.path.insert(0, os.environ.get("TROPA_SYNC", "")); import config
    cfg = config.load()
    msg = (f"@{cfg['human']} ❌ `{name}` ({tool}) stopped after {ran}s (exit code {rc}). Its tmux window stays open with the error: "
           f"`tmux attach -t {cfg['tmux_session']}` → window `{name}`.\n```\n{tail[-900:] or '(no output)'}\n```\n"
           f"Fix it, then restart it with `tropa panel` → 4.")
    req = urllib.request.Request(cfg["server"] + "/api/watch/say", data=json.dumps({"room": cfg["room"], "content": msg}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=5).read()
except Exception as e:
    print("could not tell the room:", e)
PY
    echo; echo "❌ $tool exited after ${ran}s (code $rc). Fix the error above, then restart this agent: tropa panel → 4"
    read -r -p "Press Enter to close this window… " _
    exit "$rc"
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
