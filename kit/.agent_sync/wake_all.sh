#!/bin/bash
# Manually tell agents to read the room. No args = everyone; or pass agent names.
# (Touching .agent_sync/chatroom/broadcast.txt does the same while the watcher runs.)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$HERE/room_watcher.py" wake "$@"
