# Tropa AI

Turn any project folder into a multi-agent team you talk to through one AI-IRC chatroom.
Agents run in Claude Code, Codex, OpenCode or Qwen Code, each in its own tmux window; a watcher
wakes them when the room has something for them.

## Install

### 1. Requirements (macOS or Linux; on Windows use WSL)

```bash
brew install tmux                 # macOS (python3 and curl come with it)
sudo apt-get install -y tmux python3 curl   # Debian/Ubuntu
```

You also need **one** way to run the AI-IRC chat server:
- **Docker Desktop** (recommended), or
- **Node.js 22.13 or newer** (`brew install node`, or your distro's/nvm's Node 22)

You also need at least one agent CLI, signed in: [Claude Code](https://code.claude.com) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [OpenCode](https://opencode.ai) (`opencode`) or [Qwen Code](https://github.com/QwenLM/qwen-code) (`qwen`).

### 2. Install tropa

```bash
curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh | bash
```

This downloads the latest release (or `main` if there are no releases yet) into `~/.tropa/app` and links the `tropa` command into `/usr/local/bin`, or `~/.local/bin` if that isn't writable.

If the installer says to add a folder to your PATH, run the line it prints, for example:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

### 3. Check it works

```bash
tropa version
```

### 4. Set up your first project

```bash
cd ~/projects/my-app
tropa init -p 8080       # sets up this folder and starts AI-IRC on port 8080
tropa doctor             # confirms tools, server and sign-ins
tropa panel              # create your agents
```

### Other ways to install

| Want to… | Run |
|---|---|
| Install a specific version | `curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh \| TROPA_VERSION=0.1.0 bash` |
| Install somewhere else | `… \| TROPA_DIR=~/tools/tropa BIN_DIR=~/bin bash` |
| Install from a clone (for development) | `git clone git@github.com:makmac213/tropa-ai.git && cd tropa-ai && ./tropa install` |

### Update

```bash
tropa self-update        # update tropa itself (does a git pull if installed from a clone)
cd ~/projects/my-app && tropa update   # refresh that project's kit; settings and agents are kept
```

### Uninstall

```bash
rm "$(command -v tropa)"
rm -rf ~/.tropa/app ~/.tropa/versions   # keeps ~/.tropa/ai-irc-* chat data; remove ~/.tropa to delete everything
```

In each project, the kit lives in `.agent_sync/`, `agents/` and the `tropa` block in `AGENTS.md`. Delete those to remove it.

### Troubleshooting

| Problem | Fix |
|---|---|
| `tropa: command not found` | The install folder isn't on your PATH. See step 2. |
| `download failed` | The repo is private or the network is blocked. Clone it and run `./tropa install`. |
| `Need Docker (running) or Node ≥ 22.13` | Start Docker Desktop, or `brew install node`. |
| Anything else | Run `tropa doctor` in the project; each problem comes with a fix. |

### Releasing (maintainer)
`scripts/release.sh 0.2.0` bumps `VERSION`, commits, tags `v0.2.0`, pushes and creates the GitHub release (needs `gh`). From then on, `install.sh` installs the newest release.

## Use

```bash
cd ~/projects/my-app
tropa init -p 8080       # kit + docs/ in this folder, AI-IRC on port 8080 (started if not running)
tropa panel              # create agents (type, model, role, lead), start them + the watcher
tmux attach -t ai-my-app # watch the agents
open http://localhost:8080   # chat as yourself
tropa doctor             # check tools, server, agent MCP configs, sign-in, tmux
```

| Command | What it does |
|---|---|
| `tropa init [-p PORT] [-n SLUG] [--human NAME] [--no-server] [--panel] [--node] [--tts] [DIR]` | Set up DIR (default: current folder). Re-run any time to update the kit; settings are kept. |
| `tropa panel [DIR]` | The interactive control panel (`.agent_sync/manage_agents.sh`). |
| `tropa doctor [DIR]` | Health check with fixes. |
| `tropa server up\|down\|status\|logs [-p PORT]` | Manage the AI-IRC server for a port (defaults to the project's port, else 8888). `up` also starts the host helper. |
| `tropa host start\|stop\|status\|logs [-p PORT]` | The host helper that lets the chat create projects and start teams. |
| `tropa install [BIN_DIR]` | Put `tropa` on your PATH. |

### Working with the team in the monitor (http://localhost:PORT)
- **Waking is decided by AI-IRC.** `@name` wakes that agent, `@all` wakes everyone, a message from you with no mention goes to the lead (or everyone if there's no lead), and an agent's message with no mention wakes nobody. Cooldown, hourly limit and pause apply per room.
- **▦ Team** (in a project room's header) shows every agent's terminal live. Pick a layout: **Auto**, **1 / 2 / 3 per row**, or **◉ Graph**, a node view of the team (green = working, gray = idle, amber = needs approval) with arrows for who mentioned whom; click a node to see its terminal. Each terminal shows with its state (working, idle, waiting for approval), plus **Wake** buttons and the room's wake settings: auto-wake on/pause, lead, rules, cooldown, limit. These stay in sync with `.agent_sync/settings.json`, so you can edit either one.
- **Approvals:** when an agent hits a permission prompt, it is posted to the room once and its card turns amber. Click **Approve / Always / Deny**, or type `@watcher approve QA` (also `always`, `deny`).
- **Agents** in the sidebar are filtered to the open project; click **show all** to see every project's agents.
- **Delete a project** with the × on its row: removes the room and its messages, and optionally its agents. Files are not touched.

- **Files:** attach with 📎, drag and drop, or paste an image. Files are copied into the project at `docs/attachments/<id>-<name>`, and agents see that path in the message. Agents share files back with the `share_file` tool (mockups, screenshots, PDFs). Images show inline, everything else downloads. Shared files are served without scripts, and `.env`/keys can't be shared.
- **Start a project from the chat:** click **+** next to *Projects*. Give it a name, a brief (saved as `docs/SPEC.md`), files, and a team (CLI, model, role and ★ lead per agent; presets for a 5-person web team, a small team, or solo). TropaAI creates the folder under `~/projects/`, sets up the kit, starts the agents and the watcher, and posts your kickoff message. Progress is reported in the room.

### Existing projects
tropa never touches your code; it adds the team kit next to it (`.agent_sync/`, `agents/`, a `tropa` block in `AGENTS.md`, `docs/`).
- **From the chat:** **+** → *Existing project folder* → pick a folder in your projects folder → add a brief (saved as `docs/SPEC.md`, or `docs/BRIEF.md` if a spec already exists), files and a team → **Add team**. Agents are told it's an existing codebase and to follow its conventions.
- **From a terminal (any folder):** `cd path/to/project && tropa init -p 8181`, then `tropa panel` (or use the chat).
- What's kept: your `AGENTS.md` (the team protocol is appended in a marked block), `CLAUDE.md`, `docs/SPEC.md`, `.gitignore` (entries appended) and all code. Claude agents still read your root `CLAUDE.md`, since they run inside the project.
- Projects outside `~/projects`: start the host helper with `tropa host start -p 8181 --projects-dir ~/code`, or set `TROPA_PROJECTS_DIR`.

### Models
`tropa models` lists what each CLI can use. The model menus combine `kit/.agent_sync/models.conf` with what your own accounts report, so versioned ids stay current without editing tropa: the Anthropic models API (`ANTHROPIC_API_KEY`), your Codex default in `~/.codex/config.toml` and the OpenAI models API (`OPENAI_API_KEY`), your Qwen Code model and your endpoint's `/models` (`OPENAI_BASE_URL`), and `opencode models`. Whatever you pick, each agent reports the exact model it runs on at startup, and the Team view shows it. Claude's `opus` / `sonnet` / `haiku` / `fable` are **aliases** for the latest model of that family, so they move forward when Claude Code updates and can differ by provider. Pick a full id like `claude-sonnet-5-5` to pin a version. Codex's roster depends on your OpenAI account; add the ids you use to `models.conf`, or type one.

### The host helper
The chat server runs in Docker, so it can't create folders or start agents itself. `tropa server up` also starts a small **host helper** (tmux session `tropa-host-<port>`) that does this machine-side work: it only creates folders directly under `~/projects` (or `--projects-dir` / `$TROPA_PROJECTS_DIR`) and only runs tropa's own scripts.
`tropa host start|stop|status|logs [-p PORT] [--projects-dir DIR]`

### Your name and timezone
The human name defaults to your OS user name (override with `--human NAME` or `$TROPA_HUMAN`). The server uses your machine's timezone.

The watcher (`.agent_sync/room_watcher.py`, started by the panel) is the only piece on your machine. It long-polls AI-IRC for wake and approval events, types into tmux, and streams the agents' screens.

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

## Credits

Built by **Mark Allan Meriales** with **Claude** (an AI assistant by Anthropic). See [AUTHORS.md](AUTHORS.md).
