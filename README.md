# Tropa AI

Turn any project folder into a multi-agent team you talk to through one AI-IRC chatroom.
Agents run in Claude Code, OpenCode or Qwen Code, each in its own tmux window; a watcher
wakes them when the room has something for them.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh | bash
```

This installs the latest release into `~/.tropa/app` and links `tropa` into `/usr/local/bin` (or `~/.local/bin`).
It also needs tmux and python3 (`brew install tmux`), plus Docker or Node ≥ 22.13 for the AI-IRC server.

- Pin a version: `curl … | TROPA_VERSION=0.2.0 bash`
- Update: `tropa self-update`, then `tropa update` in each project to refresh its kit (settings are kept).
- From a clone: `git clone … && cd tropa-ai && ./tropa install` (then `self-update` does a `git pull`).
- Private repo: the curl one-liner can't download it. Clone it and use `./tropa install` instead.

### Releasing (maintainer)
`scripts/release.sh 0.2.0` bumps `VERSION`, commits, tags `v0.2.0`, pushes and creates the GitHub release. `install.sh` picks up the newest release, or `main` if there are none.

## Use

```bash
cd ~/projects/my-app
tropa init -p 8080       # kit + docs/ in this folder, AI-IRC on port 8080 (started if not running)
tropa panel              # create agents (type, model, role, lead), start them + the watcher
tmux attach -t ai-my-app # watch the agents
open http://localhost:8080   # chat as Mark
tropa doctor             # check tools, server, agent MCP configs, sign-in, tmux
```

| Command | What it does |
|---|---|
| `tropa init [-p PORT] [-n SLUG] [--human NAME] [--no-server] [--panel] [--node] [--tts] [DIR]` | Set up DIR (default: current folder). Re-run any time to update the kit; settings are kept. |
| `tropa panel [DIR]` | The interactive control panel (`.agent_sync/manage_agents.sh`). |
| `tropa doctor [DIR]` | Health check with fixes. |
| `tropa server up\|down\|status\|logs [-p PORT]` | Manage the AI-IRC server for a port (defaults to the project's port, else 8888). |
| `tropa install [BIN_DIR]` | Put `tropa` on your PATH. |

### Ports and servers
- `-p PORT` is saved in the project's `.agent_sync/settings.json` (`server`), and every agent's MCP URL uses it.
- If something already answers on that port, the project just uses it, so several projects can share one server. The human's name is taken from the running server.
- Otherwise tropa starts AI-IRC there: in Docker (compose project `ai-irc` for 8888, which reuses the old `ai-irc` data volume, and `ai-irc-<port>` for other ports), or with Node if Docker isn't running (data in `~/.tropa/ai-irc-<port>/`, bound to 127.0.0.1). `--node` forces Node; `--tts` also starts Kokoro TTS (Docker only).

### What `init` writes
- `.agent_sync/` — scripts, `settings.json` (created once, then kept), `chatroom/`.
- `AGENTS.md` — the team protocol inside a `<!-- tropa:begin -->…<!-- tropa:end -->` block. An existing AGENTS.md keeps its own content; the block is appended, and replaced on later runs.
- `docs/`, `agents/`. Each new project gets its own tmux session (`ai-<slug>`), so watchers never wake another project's agents.
- `.gitignore` entries only if the folder already has `.git` or `.gitignore`.

## Layout

```
tropa-ai/
├── tropa                 CLI (bash 3.2)
├── kit/                  copied into projects: AGENTS.md + .agent_sync/ (incl. doctor.py)
├── server/               AI-IRC (server.js, monitor UI, Dockerfile, compose)
└── docs/HANDOFF.md       original design handoff (decisions, specs, backlog)
```

See `docs/HANDOFF.md` for the full design: routing rules, settings, watcher and AI-IRC API.
