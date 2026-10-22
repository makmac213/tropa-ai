# TropaAI design notes

How tropa is put together and why. For setup and day-to-day use, see the [README](../README.md). The code is the reference for exact details (flags, endpoints, defaults); this file explains the shape.

---

## 1. Goal

Turn any project folder into a multi-agent team. You talk to the team in one chat room. Each agent runs in its own CLI (Claude Code, Codex, OpenCode or Qwen Code) in its own tmux window, and a watcher wakes an agent when the room has something for it.

One install brings up everything: the `tropa` CLI, the chat server, the kit that goes into each project, and the host helper that lets the chat create projects.

## 2. Design decisions

| # | Decision |
|---|---|
| 1 | **Project-agnostic.** Nothing is hardcoded. A project's room is `project:<slug>`; the slug defaults to the folder name. |
| 2 | **The chat room is the memory.** Agents catch up from room history on startup and on every wake. Session resume (`resume_sessions`) is a bonus, not a requirement. |
| 3 | **A mention is an assignment.** `@QA ...` wakes QA only, and QA owns that task. Agent names are their @mentions. |
| 4 | **One optional lead.** Your messages that name no agent go to the lead (or to everyone if there is no lead). |
| 5 | **Approvals surface in the chat.** The watcher never types into an agent sitting on a permission prompt. It posts the prompt to the room and waits for `@watcher approve|always|deny NAME` (or the Team view buttons). |
| 6 | **CLI-neutral wake.** No CLI hook system is used; the watcher types a prompt into the agent's tmux window, so every CLI is woken the same way. |
| 7 | **Local first.** The server binds to `127.0.0.1`. Public links (ngrok) are optional, need your approval when an agent asks, and are capped at three. |
| 8 | **Safe by default.** Guardrails (rules, a pre-commit secret scan, `.gitignore` entries, a Claude deny list) are on; auto-approve is off. |
| 9 | **Portable.** Bash 3.2 (stock macOS), Python standard library only, Node 22.13+ for the server (built-in `node:sqlite`). Windows runs through WSL 2. |

## 3. Architecture

```
                 You (browser: http://localhost:8888)
                                │
               ┌────────────────▼────────────────┐
               │  TropaAI server (Docker or Node) │  SQLite
               │  REST /api · MCP /mcp · WS /ws   │
               └──▲──────────────▲────────────▲───┘
         MCP tools│     long-poll│            │ long-poll
   ┌──────────────┴──┐  ┌────────┴─────────┐  ┌┴──────────────────────┐
   │ Agents (tmux)   │◄─┤ room_watcher.py  │  │ host helper            │
   │ claude / codex /│  │ wakes, approvals,│  │ creates/adopts projects│
   │ opencode / qwen │  │ screens, files   │  │ shares (ngrok), usage  │
   └─────────────────┘  └──────────────────┘  └────────────────────────┘
```

- **The server decides who to wake** (mentions, lead, `@all`, pause, cooldown, hourly limit) and keeps rooms, agents, tasks, files, shares and usage.
- **The watcher is the hands** on the machine: it long-polls `/api/watch/poll`, types wake prompts, presses approval keys, streams each agent's screen to the Team view, and syncs shared files.
- **The host helper** runs outside any project. It handles requests from the chat that need the machine: creating or adopting a project, setting up agents, tools, skills and the design system, running public links, and reading CLI logs for usage.
- **Agents** talk only through the `tropa` MCP tools.
- **The Docs view** reads the project through the watcher, because the server (often in Docker) can't see the project folder. The watcher posts the docs folder's file list every few seconds when it changes (`/api/watch/docs`). When someone opens a file, the server queues a `doc_read` event; the watcher answers with the bytes (`PUT /api/watch/docs/:id`), and the server caches them by mtime. Changing the folder is a `set_docs_dir` event: the watcher checks the folder is inside the project, saves `docs_dir` and refreshes the agents' configs.

## 4. Kit layout (per project)

```
<project>/
├── AGENTS.md                 shared team protocol (every CLI reads it)
├── docs/                     project specs
├── agents/<name>/            one folder per agent (generated)
│   ├── agent.json            source of truth: name, tool, model, role, instruction
│   ├── AGENT.md              generated identity (+ lead block if lead)
│   └── CLI configs           CLAUDE.md / .mcp.json / .claude/, opencode.json, QWEN.md / .qwen/, codex args
└── .agent_sync/
    ├── settings.json         all tunables
    ├── config.py             loads settings + defaults; CLI: get/set KEY
    ├── models.conf           model menu
    ├── tools.json            optional hosted MCP tools (Vercel, Supabase, Render, ...)
    ├── manage_agents.sh      terminal control panel
    ├── setup_agent.py        create/refresh agent folders, write TEAM.md
    ├── start_agent.sh        launch agents in tmux (resume when possible)
    ├── room_watcher.py       the watcher
    ├── doctor.py             health checks
    ├── secret_scan.py        pre-commit secret scan
    ├── ollama_local.py / openrouter.py   local and OpenRouter models
    └── TEAM.md               generated roster
```

Agent configs are regenerated on every launch, so absolute paths, the lead and the roster are always current and the kit is safe to move.

## 5. Agents

**Per-CLI wiring** (all written by `setup_agent.py`):

| | Working dir | Instructions | MCP connection |
|---|---|---|---|
| Claude Code | `agents/<name>` | `CLAUDE.md` imports `AGENTS.md`, `TEAM.md`, `AGENT.md` | `.mcp.json` (http) |
| Codex | project root | root `AGENTS.md` + `AGENT.md` | `-c` override (your `~/.codex` is untouched) |
| OpenCode | project root | root `AGENTS.md` + `instructions` | `opencode.json` (remote) |
| Qwen Code | `agents/<name>` | `QWEN.md` imports | `.qwen/settings.json` |

The MCP URL carries the identity: `http://localhost:<port>/mcp?agent=<name>&project=<slug>`.

**Models:** each CLI's own models, plus local models through Ollama (`ollama/<model>`) and OpenRouter (`openrouter/<author>/<slug>`, key via `tropa openrouter key`).

**Startup prompt:** register (name, project, provider, model, role), read the last `history_limit` messages, note `./docs`, then follow `AGENTS.md` (no intro post; act only when mentioned or needed).

## 6. Wake routing

| Message | Wakes |
|---|---|
| `@all` / `@here` / `@team` / `@everyone` | every agent except the sender |
| mentions running agents | those agents |
| from you, names no agent | the lead, or every agent if there is no lead |
| from an agent, names no agent | nobody |
| `wake_rules: "all"` | every agent except the sender |

Then per agent: debounce bursts, respect `cooldown_seconds` and `max_wakes_per_agent_per_hour`, and hold the wake while an approval prompt is on screen. Pause and the routing keys can be changed live in `settings.json` or the Team view; the two stay in sync.

**Wake text:** `[tropa] <reason> Read your unread messages in <room> ... If it assigns you work: post a one-line plan, do it, and finish with a message that @mentions who is next. If it doesn't concern you, stay silent.`

If an agent stops without reporting back, the watcher nudges it once.

**Approvals:** the last lines of each pane are matched against `approval_patterns`. With `auto_approve` off, the prompt goes to the room; `approve`, `always` and `deny` press the keys in `approval_keys` for that CLI. With it on, the watcher presses "yes" once per prompt and falls back to asking if the prompt stays.

**Pop-ups:** CLI questions that aren't about the work (Claude's feedback survey, for example) are turned off where the CLI allows it (`claude_feedback_survey`, `claude_env`). The rest are listed in `dismiss_prompts`: the watcher presses their keys before a wake and on every screen check, holds wakes while one is up, and tells you if three tries don't clear it.

**Reserved names:** `ControlCenter`, `watcher`, `all`, `here`, `team`, `everyone`, and your name.

## 7. Server

- **Stack:** Node 22.13+, Express, `ws`, SQLite (WAL). `server/server.js` and `server/public/index.html`.
- **Runs** in Docker (`tropa server up -p PORT`) or directly with Node. Several ports can run side by side, each with its own data. Env: `PORT`, `HOST`, `DATA_DIR`, `HUMAN_NAME`, `TZ`, `KOKORO_URL`, `ALLOWED_ORIGINS`.
- **Security:** no login; localhost only; an origin check blocks other sites in the browser (DNS-rebinding guard).
- **Tables:** `rooms`, `messages`, `agents`, `agent_aliases`, `cursors`, `attachments`, `room_wake`, `tasks`, `task_events`, `questions`, `usage`, `deleted_projects`.
- **MCP tools:** `register`, `check_inbox`, `read_messages`, `send_message`, `wait_for_messages`, `list_rooms`, `list_agents`, `join_room`, `rename`, `set_status`, `share_file`, `request_share`, `task_add`, `task_update`, `task_list` (cards carry `depends_on` / `contract_from`), `ask_human`.
- **Dependencies:** `tasks.deps` holds `[{id, kind}]`, kind `merge` (met when that card is done) or `contract` (met once it has started). Views add `waits_for`, `ready` and `unblocks`; loops are refused. When a card moves, owners of cards that just became ready get a system note and a wake. The server renders the board as Mermaid (`/api/rooms/:id/plan.md`) and, debounced, sends it to the watcher (`write_plan`), which writes `<docs>/PLAN.md` unless the file lacks tropa's marker line.
- **Questions:** `questions` table. `ask_human` posts the question in the room and records options, recommendation, fallback and deadline; agent messages that @mention the human with a `?` are recorded too. A human reply to the message (or a message to that agent) closes it; the panel's answer posts such a reply. A 15 s timer closes overdue questions with their fallback and wakes the agent.
- **Needs attention:** computed from the board, the watcher's screens (state and last change; approval start is tracked per agent) and the room's `attention` limits, every 10 s and on board changes; broadcast only when the list changes. Snoozes are in memory.
- **REST** (`/api`): rooms and messages, agents, inbox/read/wait, search, transcripts, TTS, wake settings, approvals, files, tasks, shares, usage, projects, plus the `watch/*` and `host/*` endpoints used by the watcher and host helper.
- **WebSocket** (`/ws`): live messages, agents, team panes, tasks, files, shares, usage and jobs for the monitor.
- **Read cursors:** a new agent starts 20 messages back; posting marks the room read for the sender; unread reads advance the cursor. This is why the watcher posts as `watcher`, never as a stuck agent.

The server was originally called AI-IRC; some internal names (`ai-irc.db`, the `ai-irc` compose project and volume) are kept so existing data carries over.

## 8. Usage telemetry

`host/usage.py` reads the CLIs' own logs (Claude Code, Codex, OpenCode, Qwen), attributes sessions to agents by tropa's boot prompt, and posts totals to `/api/usage`. Costs are API-equivalent prices from `host/prices.json`. Only sessions started after install are counted.

## 9. Ideas

- Budget alerts from the usage data.
- Password-protected public links.
- Deny rules for OpenCode and Qwen (Claude has a deny list today).
- Busy detection: hold wakes while an agent is mid-turn, not only on approval prompts.
- Notifications for new "needs attention" items and questions past their deadline.
- Relay unknown terminal menus to the room (`@watcher answer NAME 2`, `@watcher keys NAME Escape`) instead of only the ones listed in `dismiss_prompts`. Parked: it needs new chat commands, not just settings.
- **Model choice in Simple mode, for intermediate users** (noted, not built). Today Simple mode runs every agent on Claude Code with the models the team's prompt files set: Sonnet for leads and roles that need judgement or writing, Haiku for routine roles. Changing a model or CLI means switching to Advanced. The idea keeps those defaults (zero decisions for beginners) and adds optional, progressive controls to *Build your team*:
  1. A closed-by-default **Models** choice: *Budget* (Haiku, Sonnet for the lead), *Balanced* (today's per-role defaults), *Best* (Opus for the lead and key thinkers, Sonnet for the rest), with a rough cost hint. It maps each role's tier to a model, so the team folders don't change.
  2. A **Change** link on each member card: a short picker with friendly labels (*Haiku: fast, cheap · Sonnet: balanced · Opus: smartest, priciest*), plus other CLIs' models only when that CLI is installed and signed in (from the host helper's `clis`).
  3. When Claude Code isn't installed but another CLI is, Simple mode uses that CLI's sensible default instead of asking for Claude Code.
