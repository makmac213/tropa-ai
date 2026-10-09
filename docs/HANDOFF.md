# Handoff — Agent Team Bootstrap Kit (AI-IRC orchestration)

**From:** setup work in `outsource_accelerator/recruitment-os` (9 Oct 2026)
**For:** a new standalone project that bootstraps this setup into any project folder
**Owner:** Mark

---

## 1. Goal

A reusable kit that turns any project folder into a multi-agent team. Mark talks to the team through one AI-IRC chatroom. Agents run in different CLIs (Claude Code, OpenCode, Qwen Code), each in its own tmux window, and a watcher wakes them when the room has something for them.

The new project should:
1. Package the kit (`.agent_sync/` and `AGENTS.md`) so it can be dropped into or bootstrapped onto any project folder.
2. Include AI-IRC (the chat server) in the same bootstrap, so one setup brings up chat, agents and watcher.

---

## 2. Decisions already made (by Mark)

| # | Decision |
|---|---|
| 1 | **Project-agnostic.** No project name is hardcoded. The room is `project:<slug>`, and the slug defaults to the folder name (can be overridden in settings). |
| 2 | **Approval prompts are shown in the chatroom.** If an agent is waiting on a permission prompt, the watcher posts it to the project room for Mark instead of typing into it. |
| 3 | **No git** for now. Nothing depends on it. |
| 4 | **Auto-wake is a setting**, currently **on** (`wake: "auto"`). It can be paused, and there is an optional per-hour wake limit (off by default). |
| 5 | **One lead (optional)**, assigned when creating an agent or later in Settings. Mark's messages that name no agent go to the lead. |
| 6 | **A mention is an assignment.** `@QA ...` wakes QA only, and QA owns that task. Agent names are their @mentions. |
| 7 | **The chatroom is the memory.** Agents catch up from room history on startup. |
| 8 | **`./docs` holds project specs.** Every agent can read and edit the project folder, and is told to check `./docs`. |
| 9 | **History limit is a setting**, currently **20** messages. |

---

## 3. Architecture

```
            Mark (browser monitor http://localhost:8888  or  any agent)
                                   │
                    ┌──────────────▼──────────────┐
                    │   AI-IRC server (Docker)     │  SQLite on volume
                    │   REST /api  MCP /mcp  WS /ws│
                    └──────▲───────────────▲───────┘
         MCP (ai-irc tools)│               │ REST poll (GET messages?after=)
        ┌──────────────────┴───┐     ┌─────┴──────────────────────┐
        │ Agents (tmux windows)│◄────┤ room_watcher.py (tmux win)  │
        │  claude / opencode / │ types│ routes by @mention / lead  │
        │  qwen, one per agent │ "[ai-irc] read the room"        │
        └──────────────────────┘     │ posts approval prompts back │
                                     └─────────────────────────────┘
```

- **Agents** talk only through ai-irc MCP tools (`register`, `read_messages`, `send_message`, ...).
- **The watcher** is the only thing that triggers agents. It doesn't use any CLI's hook system, so it works the same for all three CLIs: it types a prompt into the agent's tmux window.
- **tmux session** (default `ai-team`) has a `ControlCenter` window, a `watcher` window and one window per agent, named exactly after the agent.

---

## 4. Current kit — file inventory

Everything lives in the project root:

```
<project>/
├── AGENTS.md                    shared team protocol (all CLIs read it)
├── docs/                        project specs (created by the panel if missing)
├── agents/<name>/               one folder per agent (generated)
│   ├── agent.json               source of truth: name, tool, provider, model, role, instruction
│   ├── AGENT.md                 generated identity (+ lead block if lead)
│   ├── CLAUDE.md, .mcp.json, .claude/settings.json      (Claude Code agents)
│   ├── opencode.json                                    (OpenCode agents)
│   └── QWEN.md, .qwen/settings.json                     (Qwen Code agents)
└── .agent_sync/
    ├── settings.json            all tunables (see §6)
    ├── config.py                loads settings + defaults; CLI: get/set KEY
    ├── models.conf              model menu for Claude/Qwen (tool|model-id|label)
    ├── manage_agents.sh         interactive control panel (entry point)
    ├── setup_agent.py           create/refresh agent folders, generate TEAM.md
    ├── start_agent.sh           launch agents in tmux (NAME | --all | --exec NAME)
    ├── room_watcher.py          the trigger: poll room, route, wake, approval alerts
    ├── wake_all.sh              manual wake (all or named agents)
    ├── TEAM.md                  generated roster (human, lead, room, docs, agents)
    └── chatroom/
        ├── broadcast.txt        touch it to wake everyone (manual trigger)
        └── .last_id             watcher's last processed message id
```

Bash scripts are written for **macOS bash 3.2** (no `mapfile`, no associative arrays). They need `tmux`, `python3` (standard library only) and `curl`.

---

## 5. Agent lifecycle

**Create** (panel option 1 or 2):
name → type (Claude Code / OpenCode / Qwen Code) → model (menu) → role → initial instruction → lead? (y/n)
→ `setup_agent.py create ...` writes `agents/<name>/agent.json`, regenerates `TEAM.md`, writes the tool configs
→ `start_agent.sh <name>` opens tmux window `<name>`.

**Model menu:**
- Claude: CLI default, then aliases `fable`, `opus`, `sonnet`, `haiku` (from `models.conf`).
- OpenCode: CLI default, plus the live list from `opencode models` (asks for a filter if there are more than 25).
- Qwen: CLI default, `qwen3-coder-plus`, `qwen3-coder-flash` (from `models.conf`, **ids unverified**).
- All menus end with "Other (type a model id)".

**Launch** (`start_agent.sh --exec NAME`, run inside the tmux window):
1. `setup_agent.py refresh NAME` rebuilds the configs on every launch, so paths, lead and roster are always current (this also makes the kit safe to move or copy).
2. Starts the CLI with the flags from settings and a startup prompt:

| Tool | Working dir | Command |
|---|---|---|
| Claude Code | `agents/<name>` | `claude <tool_flags.claude> -n <name> [--model M] "<boot>"` |
| OpenCode | project root | `OPENCODE_CONFIG=agents/<name>/opencode.json opencode <flags> [-m M] --prompt "<boot>"` |
| Qwen Code | `agents/<name>` | `qwen <tool_flags.qwen> --include-directories <root> [-m M] -i "<boot>"` |

**Startup prompt (`<boot>`):** register with `agent`, `project`, `provider`, exact `model`, and role as `description` → read the last `history_limit` messages of the room (`recent=true`) → note that docs are in `./docs` → follow AGENTS.md: no intro post, act only when mentioned or needed.

**How each CLI gets access to the project folder:**
- Claude: `permissions.additionalDirectories: [<root>]` in `agents/<name>/.claude/settings.json`.
- OpenCode: runs from the project root.
- Qwen: `--include-directories <root>`.

**How each CLI gets the AI-IRC connection** (the agent name and project are in the URL, so the server can fill them in):
- URL: `http://localhost:8888/mcp?agent=<name>&project=<slug>`
- Claude: `.mcp.json` `{type:"http"}`, plus `enableAllProjectMcpServers: true` and `permissions.allow: ["mcp__ai-irc"]`.
- OpenCode: `opencode.json` `mcp.ai-irc {type:"remote", url}`.
- Qwen: `.qwen/settings.json` `mcpServers.ai-irc {httpUrl, trust:true}`.

**How each CLI gets its instructions:**
- Claude `CLAUDE.md` and Qwen `QWEN.md` import `@<root>/AGENTS.md`, `@<root>/.agent_sync/TEAM.md` and `@AGENT.md`.
- OpenCode reads the root `AGENTS.md` natively, plus `instructions: [TEAM.md, AGENT.md]`.

---

## 6. Settings (`.agent_sync/settings.json`)

The watcher re-reads settings every loop, so most changes apply live. Launch flags apply at the next agent start.

| Key | Default | Meaning |
|---|---|---|
| `project` | `""` → folder name, slugified | Room becomes `project:<slug>` |
| `human` | `Mark` | Human's @name (must match AI-IRC `HUMAN_NAME`) |
| `lead` | `""` | Lead agent name; empty = no lead |
| `server` | `http://localhost:8888` | AI-IRC base URL |
| `tmux_session` | `ai-team` | tmux session name |
| `wake` | `auto` | `auto` or `paused` (manual wake still works when paused) |
| `wake_rules` | `smart` | `smart` (see §7) or `all` (every agent except the sender) |
| `max_wakes_per_agent_per_hour` | `0` | 0 = no limit; when hit, posts a notice to `@human` |
| `history_limit` | `20` | Messages read on startup and per wake |
| `poll_seconds` / `debounce_seconds` / `cooldown_seconds` | `3` / `4` / `20` | Poll rate; burst grouping; minimum gap between wakes per agent |
| `docs_dir` | `docs` | Project docs folder (relative to root) |
| `tool_flags.claude` | `--permission-mode auto` | Claude launch flags |
| `tool_flags.opencode` | `""` | OpenCode launch flags |
| `tool_flags.qwen` | `--approval-mode auto-edit` | Qwen launch flags |
| `approval_patterns` | list of regexes | Screen text that means "waiting for approval" |

---

## 7. Watcher spec (`room_watcher.py`)

**Loop** (every `poll_seconds`):
1. Ensure the room exists (`POST /api/rooms {project}`). On first run, set `.last_id` to the latest message so history isn't replayed.
2. `GET /api/rooms/<room>/messages?after=<last_id>`. If anything is new, wait `debounce_seconds`, fetch again, and process the batch.
3. Route each message (ignoring `system` messages and the watcher's own posts):

| Message | Wakes |
|---|---|
| contains `@all` / `@here` (also `@team`, `@everyone`) | every agent except the sender |
| mentions one or more running agents | those agents (not the sender) |
| from the human, names no agent | the **lead** if set and running, otherwise every agent |
| from an agent, names no agent | nobody (informational) |
| `wake_rules: "all"` | every agent except the sender, always |

4. `broadcast.txt` mtime changed → wake every agent.
5. For each pending agent:
   - Skip until `cooldown_seconds` have passed since its last wake.
   - Skip if it has hit the per-hour limit (and post a notice once).
   - If its pane shows an approval prompt, **don't type**. Post the prompt to the room once, keep the wake pending, and deliver it after the prompt clears.
6. Wake = `tmux send-keys -l "<text>"`, pause 0.4 s, then `send-keys Enter` (sending them separately stops TUIs from treating Enter as part of a paste).

**Wake text:** `[ai-irc] New message(s) #12-#14 from Mark, lead. Read your unread messages in project:<slug> (ai-irc read_messages, agent "<name>", limit <history_limit>). Follow AGENTS.md: act if you are mentioned or needed, otherwise stay silent.`

**Approval detection:** look at the last 30 non-empty lines of `tmux capture-pane`. Any line matching `approval_patterns` is a prompt. The alert includes the surrounding lines (box-drawing characters stripped, max 900 characters):
`@Mark \`QA\` is waiting for your approval in tmux (window \`QA\`, session \`ai-team\`): ...`
The watcher also checks for approval prompts every loop even when no wake is pending, and posts each new one once.

**Posting identity:** the watcher posts as agent **`watcher`** (it auto-registers in AI-IRC with no project). It must not post as the stuck agent, because posting as an agent marks that agent's unread messages as read (see §8.4).

**Manual:** `room_watcher.py wake [NAME...]` / `wake_all.sh [NAME...]` (also skips agents on an approval prompt).

**Reserved names** (cannot be agents): `ControlCenter`, `watcher`, `all`, `here`, `team`, `everyone`, and the human's name.

---

## 8. AI-IRC specification

Source: `outsource_accelerator/ai-irc` (`server.js`, ~950 lines; `public/index.html` monitor; `AGENT_GUIDE.md`; `README.md`).

### 8.1 Runtime and deployment
- **Stack:** Node ≥ 22.13 (uses built-in `node:sqlite`), Express 4, `ws` 8. One file: `server.js`.
- **Docker:** `node:22-slim`, runs as user `node`, data in `/data` (volume `ai-irc-data`), healthcheck `GET /health`.
- **Compose:** service `ai-irc` publishes `127.0.0.1:8888:8888` (localhost only). The optional `kokoro` service (local text-to-speech, `ghcr.io/remsky/kokoro-fastapi-cpu`) is reachable only on the compose network.
  - `docker compose up -d --build` starts both; `docker compose up -d ai-irc` starts chat only.
- **Env:** `PORT` (8888), `DATA_DIR` (/data), `TZ` (Asia/Manila), `HUMAN_NAME` (Mark), `KOKORO_URL` (http://kokoro:8880), `ALLOWED_ORIGINS` (extra browser origins, comma-separated).
- **Without Docker:** `npm install && npm start`.

### 8.2 Security
- No authentication. It's bound to `127.0.0.1` in compose.
- The origin check blocks browsers from other origins (DNS-rebinding guard). Requests without an `Origin` header (CLIs, curl) are allowed.
- Cloud-hosted agents can't reach it without a tunnel plus auth.

### 8.3 Data model (SQLite, WAL mode)
| Table | Columns |
|---|---|
| `rooms` | `id` (PK: `general` or `project:<slug>`), `kind` (`general`/`project`), `project`, `topic`, `created_at` |
| `messages` | `id` (autoincrement, global), `room_id`, `sender`, `sender_kind` (`agent`/`human`/`system`), `content`, `reply_to`, `mentions` (JSON array, lowercase), `created_at` (ms) |
| `agents` | `name` (PK, case-insensitive lookup), `project`, `description`, `status`, `last_seen`, `created_at`, `provider`, `model`, `provider_src`, `model_src` |
| `agent_aliases` | `alias` → `target` (former names after a rename) |
| `cursors` | `(agent, room_id)` → `last_read` (per-agent read position, only moves forward) |

### 8.4 Core behaviour
- **Rooms:** `general` always exists. `project:<slug>` is created when an agent registers with that project (or `POST /api/rooms`). Room ids are normalized: `#general`, `foo` and `project:Foo` all work, and slugs are lowercased (`[a-z0-9._-]`, max 60).
- **Names:** `cleanName` keeps only `[A-Za-z0-9._-]` (max 40), turns spaces into `-`, and is case-insensitive.
- **Mentions:** the regex `(^|[^A-Za-z0-9_])@([A-Za-z0-9._-]{1,40})`, stored lowercase with trailing dots removed. `@all` and `@here` count as mentions of everyone in `check_inbox`.
- **Read cursors:**
  - On first join, an agent's cursor starts at **latest id − 20**, so a new agent sees the last 20 messages as unread.
  - Posting a message marks the room as read for the **sender** up to that message.
  - `read_messages` (unread mode) advances the cursor.
- **Unknown agents** are auto-registered on first use (`resolveAgent` with `autoRegister`).
- **Profiles:** provider and model have a source rank, `manual` (edited in the monitor) > `agent` (self-reported via `register`) > `client` (detected from the MCP `clientInfo.name`). A lower rank never overwrites a higher one. The detected provider maps client names to `Claude Code`, `Codex`, `OpenCode`, `Gemini CLI`, `Cursor`, etc. (`mcp-remote` is ignored).
- **Online:** an agent counts as online if seen in the last 10 minutes.
- **Limits:** message content max 20,000 characters. `read_messages` defaults to 30, max 200. `wait_for_messages` defaults to 45 s, max 110 s, and groups bursts with a 750 ms delay.
- **Rename:** moves cursors, re-attributes past messages, leaves an alias for the old name, and posts a system notice in the agent's rooms.

### 8.5 MCP endpoint
- `POST /mcp`: Streamable HTTP, **stateless JSON** (no SSE). Batch requests are supported. `GET`/`DELETE /mcp` return 405.
- Protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. `initialize` returns an `Mcp-Session-Id`, used only to remember which client app is connected.
- **Default identity:** query `?agent=<name>&project=<slug>`, or headers `x-agent-name` / `x-agent-project`. These are used when a tool call omits `agent` or `project`.
- The server sends usage `instructions` on `initialize` (register first, check the inbox, use @mentions, `wait_for_messages` when blocked, project room versus general).

| Tool | Params (required in **bold**) | Behaviour |
|---|---|---|
| `register` | **agent**, project, description, provider, model | Create or update the agent, join `general` + `project:<slug>`, set the provider/model profile, return the inbox summary |
| `check_inbox` | **agent** | Unread count per room plus unread messages that mention the agent (or `@all`/`@here`) |
| `read_messages` | **agent**, **room**, since_id, recent, limit | Unread (advances the cursor), or `recent=true` for the latest N regardless of read state |
| `send_message` | **agent**, **room**, **content**, reply_to | Post; returns `Sent #id` |
| `wait_for_messages` | **agent**, room, timeout_seconds | Long-poll for a message from someone else; marks it read |
| `list_rooms` | agent | Rooms with message counts (+ the agent's unread) |
| `list_agents` | project | Agents with online flag, provider·model, project, status |
| `join_room` | **agent**, **room** | Follow another room (created if missing) |
| `set_status` | **agent**, **status** | Status line (max 200 characters) |
| `rename` | **agent**, **new_name** | Rename and keep history |

Messages are returned to agents as text: `[#id room dd/mm/yyyy, HH:MM ↩#reply] sender (human): content`.

### 8.6 REST API (`/api`)
| Method & path | Body / query |
|---|---|
| `GET /api/state` | `{human, rooms, agents}` |
| `GET /api/rooms` · `POST /api/rooms` | create: `{project, topic?}` |
| `PATCH /api/rooms/:room` · `DELETE /api/rooms/:room` | `{topic}` (`general` can't be deleted) |
| `GET /api/rooms/:room/messages` | `?limit=` (default 100, max 500) and `after=` or `before=` → array of message objects (`id, room_id, sender, sender_kind, content, reply_to, mentions[], created_at, created_iso`) |
| `POST /api/rooms/:room/messages` | agent: `{agent, content, reply_to?}` · human: `{sender, sender_kind:"human", content}` |
| `DELETE /api/messages/:id` | |
| `GET /api/agents` · `POST /api/agents/register` | register: `{agent, project?, description?, provider?, model?}` |
| `PATCH /api/agents/:name` | `{name?, provider?, model?, project?, description?}` — manual edits win |
| `POST /api/agents/:name/rename` · `DELETE /api/agents/:name` | `{new_name}` |
| `GET /api/inbox?agent=` · `POST /api/read` | read: `{agent, room, since_id?, limit?}` |
| `GET /api/wait?agent=&room=&timeout=` | long-poll (≤ 110 s) |
| `GET /api/search?q=` | up to 200 matches |
| `GET /api/rooms/:room/transcript?format=md\|txt\|json` · `GET /api/transcript?format=` | transcript download |
| `GET /api/tts/status` · `POST /api/tts` | Kokoro proxy: `{text, voice?, speed?}` → WAV |
| `GET /health` · `GET /agent-guide.md` | |

URL-encode the colon in room ids if the client needs it (`project%3Aslug`).

### 8.7 WebSocket `/ws` (used by the monitor)
- Origin-checked, with a 30 s ping. Every 30 s it also re-broadcasts `agents` with fresh online flags.
- Events: `hello`, `message`, `message_deleted`, `room`, `room_deleted`, `agent`, `agents`, `agent_renamed`, `agent_deleted`.

### 8.8 Monitor UI (`public/index.html`, `http://localhost:8888`)
- Live room view with an "All activity" feed, mentions, replies, search, agent sidebar with profile editor (name, provider, model, project, description), transcript download, and read-aloud (Kokoro, falling back to Mac voices).
- Slash commands (local to the viewer, never posted): `/blur`, `/unblur`, `/download [md|txt|json]`, `/read [n|#id]`, `/stop`, `/tts [kokoro|mac]`, `/help`. Start a message with `//` to post text that begins with `/`.

---

## 9. Verification status

**Tested in a sandbox** (fake CLIs, fake AI-IRC, real tmux, Linux):
- Creating Claude, OpenCode and Qwen agents with a model and a lead; `TEAM.md` and `AGENT.md` generation; launch arguments and working directories per tool.
- Routing: Mark with no mention → lead only; Mark `@QA` → QA; agent with no mention → nobody; `@all` → all but the sender.
- Pause blocks wakes; `broadcast.txt` and manual wake work.
- Approval prompt → alert posted to the room, wake held, then delivered once the prompt cleared.

**Not yet verified on the Mac with the real tools:**
- Real `claude` / `opencode` / `qwen` startup with these configs and flags. Specifically: `OPENCODE_CONFIG` handling, Qwen `--include-directories` and `-i`, Qwen `@file` imports in `QWEN.md`, and the Qwen model ids.
- Whether the default `approval_patterns` match each CLI's actual approval dialog text.
- How OpenCode and Qwen handle text typed while they are mid-turn (Claude Code queues it).
- Claude's `--permission-mode auto` being available on Mark's plan.

---

## 10. Known gaps / backlog for the bootstrap project

1. **`bootstrap` command:** `bootstrap <project-dir> [--project slug]` copies the kit, creates `docs/`, writes `settings.json`, checks that AI-IRC is up (or starts it), and optionally launches the panel.
2. **Bundle AI-IRC** in the same project (compose file + server) so a single setup brings everything up. Decide whether there is one AI-IRC per machine (current setup, shared by many projects) or one per project.
3. **`doctor` command:** check tmux, python3, curl and docker; check each CLI is installed and signed in; check AI-IRC health; and for each agent, confirm its MCP config can reach `/mcp`.
4. **Approve from chat:** let Mark reply in the room (e.g. `@watcher approve QA 1`) and have the watcher send the keystroke. Needs a safe per-CLI key mapping.
5. **Session resume:** relaunch with `claude -c` / `opencode --continue` / Qwen's resume option instead of a fresh session (optional, because the chatroom is the memory).
6. **First-run friction:** the Claude folder-trust dialog and OpenCode/Qwen sign-in need one manual pass per agent folder. `doctor` could detect this.
7. **Busy detection:** today the watcher only checks for approval prompts. It could also detect "agent is mid-turn" and hold wakes until the agent is idle.
8. **Watcher identity:** it shows up as agent `watcher` in AI-IRC. Consider a `system` sender (needs a server change) so it isn't listed as an agent.
9. **Absolute paths** in generated configs: they're fine because they're refreshed on every launch, but copying `agents/` between machines requires a `refresh`.
10. **Sync the human name:** `settings.human` must match AI-IRC's `HUMAN_NAME`. The bootstrap could read it from `GET /api/state`.

---

## 11. Quick start (current kit)

```bash
cd ~/outsource_accelerator/ai-irc && docker compose up -d ai-irc     # chat server
brew install tmux                                                    # if missing
cd <project> && ./.agent_sync/manage_agents.sh                       # create agents, pick type/model/lead
tmux attach -t ai-team                                               # watch agents
open http://localhost:8888                                           # chat as Mark
```

Panel: 1 create agent · 2 create several · 3 start all + watcher · 4 restart one · 5 change model · 6 list · 7 wake everyone · 8 settings (pause/resume, lead, history limit, wake limit, wake rules, CLI flags) · 9 exit.
