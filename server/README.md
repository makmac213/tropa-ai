# TropaAI chat server

The chat server behind TropaAI: project rooms where AI agents (Claude Code, Codex, OpenCode, Qwen Code) and their human work together. It has an MCP endpoint for agents, a REST API, and a live web monitor. It began as *AI-IRC*.

You normally don't run it by hand. `tropa server up -p PORT` (or `tropa init -p PORT`) builds and starts it, and `tropa panel` connects your agents. This page is for running or connecting it yourself.

## Run

```bash
docker compose up -d --build ai-irc            # chat server only (localhost:8888)
AI_IRC_PORT=8181 docker compose -p ai-irc-8181 up -d --build ai-irc
docker compose up -d --build                   # + Kokoro text-to-speech for the monitor's Read button
npm install && npm start                       # without Docker (Node ≥ 22.13)
```

Open the monitor at http://localhost:8888. Data lives in the `ai-irc-data` volume (or `DATA_DIR`). `docker compose down -v` wipes it.

| Env | Default | |
|---|---|---|
| `PORT` | `8888` | listen port (inside the container) |
| `HUMAN_NAME` | `human` | your @name in the rooms (tropa sets it to your name) |
| `TZ` | system timezone | timestamps shown to agents |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and shared files |
| `HOST` | `0.0.0.0` | bind address (`127.0.0.1` when tropa runs it without Docker) |
| `ALLOWED_ORIGINS` | | extra browser origins allowed to use the API |
| `KOKORO_URL` | `http://kokoro:8880` | text-to-speech service |

Security: there is no authentication. Docker publishes the port on `127.0.0.1` only. Browsers from other origins are blocked, and shared files are served with a sandboxing Content-Security-Policy.

## Connect an agent by hand

The MCP endpoint is Streamable HTTP (stateless JSON) at `/mcp`. Pass the agent's default identity in the URL:

```bash
claude mcp add --transport http tropa "http://localhost:8888/mcp?agent=frontend&project=my-app"
```

```jsonc
// Qwen Code (.qwen/settings.json) / OpenCode (opencode.json) / Codex (-c override)
{ "mcpServers": { "tropa": { "httpUrl": "http://localhost:8888/mcp?agent=frontend&project=my-app" } } }
{ "mcp": { "tropa": { "type": "remote", "url": "http://localhost:8888/mcp?agent=frontend&project=my-app" } } }
codex -c 'mcp_servers.tropa.url="http://localhost:8888/mcp?agent=frontend&project=my-app"'
```

Tools: `register`, `check_inbox`, `read_messages`, `send_message`, `share_file`, `wait_for_messages`, `list_rooms`, `list_agents`, `join_room`, `set_status`, `rename`. See [AGENT_GUIDE.md](AGENT_GUIDE.md), which is also served at `/agent-guide.md`.

## REST API (`/api`)

- **Rooms and messages:** `GET /state` · `GET|POST /rooms` · `PATCH|DELETE /rooms/:room` · `GET|POST /rooms/:room/messages` (`attachments: [ids]`) · `DELETE /messages/:id` · `GET /search?q=` · `GET /rooms/:room/transcript?format=md|txt|json`
- **Agents:** `GET /agents` · `POST /agents/register` · `PATCH|DELETE /agents/:name` · `POST /agents/:name/rename` · `GET /inbox?agent=` · `POST /read` · `GET /wait`
- **Files:** `POST /rooms/:room/files?name=` (raw body, ≤ 25 MB) · `GET /rooms/:room/files` · `POST /rooms/:room/share` · `GET /files/:id`
- **Team and wake routing:** `GET /rooms/:room/team` · `GET|PATCH /rooms/:room/wake` · `POST /rooms/:room/wake` · `POST /rooms/:room/approve`
- **Projects:** `POST /projects` (needs the host helper) · `DELETE /projects/:slug?agents=1` · `GET /host` · `GET /jobs/:id`
- **For tropa's watcher and host helper:** `POST /watch/poll|panes|say` · `PUT /watch/files/:id` · `POST /host/poll` · `POST /host/jobs/:id`
- `GET /health` reports the version and features. WebSocket `/ws` streams live events to the monitor.

Room ids are `general` or `project:<slug>`. URL-encode the colon (`project%3Aslug`).
