# Changelog

## 0.5.0 (October 2026)

### Easier to install and run
- **One-line install that ends in the browser:** the installer offers to install what's missing (tmux, Python, git; Node.js 22 goes into `~/.tropa/node`, no admin rights needed), puts `tropa` on your PATH, then starts TropaAI and opens it.
- **`tropa start` / `tropa stop`:** the chat server and the host helper in one command. It uses Node by default; Docker is still supported (`--docker`), and ports that already keep their chats in Docker stay there.
- **`tropa autostart on|off|status`:** start TropaAI when you log in (launchd on macOS, a systemd user service on Linux).
- **Setup check in the browser:** shown on first run and from ⚙ Settings. It covers the host helper, Claude Code, git, the other agent CLIs, API keys and ngrok, with the command to fix each.

### New project by chatting with Claude
- Describe the project. Claude asks what it needs and proposes a plan: the folder, each agent's CLI, model and job, the settings, and a brief. You revise it in plain words and create it with one click. The form is still there ("Use the form instead" / "Edit as a form").
- Claude runs on your computer through the host helper (`claude -p`, no tools, an empty folder). Nothing is created until you confirm.

### Teams that change while they work
- **The lead can add agents** (`request_agent`): **New agents** set to ask me / automatic (limited to N per hour) / off.
- **Clone an agent** from its Team card, with `@tropa clone NAME`, or by the lead (`clone_of`).
- **Remove agents from the chat** ("remove x and y from the room", always confirmed), or by the lead (`remove_agents`, setting **Lead removes**). A removed agent's CLI stops and its folder moves to `agents/.removed/`; its messages and usage are kept.
- **Hide inactive** agents in the Team view and graph.

### Models and keys
- **Gemini CLI** as a fifth agent CLI.
- **API keys for OpenRouter and Gemini, set in the UI:** a global key, or a key for one project. Keys are checked with the provider and saved outside every project folder (mode 600).

### Fixes
- Removed agents no longer come back or linger in the Team view or graph.
