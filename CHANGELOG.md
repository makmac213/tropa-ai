# Changelog

## 0.5.1 (October 2026)

### Install
- **The installer is friendlier and checks everything before installing TropaAI.** It runs in 4 numbered steps: check the computer (✅/❌ for git, Python, tmux, Node.js and an AI agent), install what's missing after asking once, install TropaAI, open it. New: it installs Apple's Command Line Tools (and waits for Apple's window to finish), Homebrew when a Mac needs it for tmux, and an AI agent (Claude Code, OpenCode or both; `TROPA_CLI` chooses up front). It warns before anything asks for a password, and adds what it installed to your PATH. If something can't be installed it stops before installing TropaAI and says exactly what to do, so there's never a half-working install.
- **Windows setup for everyone:** download **TropaAI-Setup.cmd** and double-click it (or paste the PowerShell line). It turns on WSL with one Windows permission prompt and, if Windows needs a restart, **carries on by itself after it**; installs Ubuntu and walks you through creating your Linux user in the same run (no more "open Ubuntu, then run the installer again"); installs Linux tools without asking for a password; lets the Linux installer add Node.js and an AI agent; adds **TropaAI shortcuts** to the Desktop and Start menu (and, if you like, starts it when you sign in); and offers to sign you in to Claude Code or OpenCode right there. Problems such as virtualization being off are explained in plain words, and each run is logged to `%TEMP%\tropa-install.log`.

### Existing projects anywhere
- **📂 Browse… for an existing project folder:** the New project form opens your computer's own folder window (Finder, File Explorer in WSL, zenity/kdialog on a Linux desktop) and fills in the path. Before, the list only showed git repos found in a quick scan of your home folder, and anything else meant typing the path.
- **External drives are allowed:** `/Volumes/…` on a Mac and `/media/…`, `/run/media/…`, `/mnt/…` on Linux (in WSL, Windows drives such as `/mnt/c/Users/you/code`), never a whole drive or Windows' system folders. `TROPA_PROJECT_ROOTS` still adds other places.
- **macOS privacy protection is explained:** when macOS blocks TropaAI from Documents, Desktop or Downloads, the form says so and how to allow it, instead of "isn't a folder" or a silently missing project.

### Fixes
- **Renaming an agent renames it everywhere:** its `agents/<name>/` folder, configs, `TEAM.md`, the lead setting, `@mentions` in teammates' instructions, its tasks, questions and token usage. Its CLI restarts under the new name and resumes its conversation (an agent renaming itself waits until it's idle).
- **The Team view and graph show the new name** right away.
- **Approving a new agent in plain words works:** "approve backend2" (or a yes/no reply to the request or to the lead's message about it) approves or denies the pending request, like the button. The lead is told when it's approved, and is asked not to welcome a teammate before that.
- **Team cards:** the buttons (Model, Wake, Restart, Clone, Remove) are on their own row, so they're never cut off on narrow cards.
- **Agents that lose the chat connection restart themselves:** when an idle agent's screen shows the tropa tool dropped (after a server restart or a CLI update), the watcher restarts it and it resumes its conversation (at most once every 10 minutes).
- **Agents don't get stuck on "trust this folder?" after a CLI update:** each CLI asks once per folder, an update can ask again, and pressing Enter there (or a wake typed into it) picks *No*, which runs the agent without the tropa tool. Before every start tropa now records the answer in each CLI's own file (Claude Code: folder trust and CLAUDE.md imports; Gemini CLI and Qwen Code: `trustedFolders.json`; Codex: `config.toml`), and the watcher answers *Yes* if Claude still asks. Setting `trust_agent_folders` (on by default; the New project form's trust box sets it).
- **Agents run the same CLI you do:** tmux keeps the PATH it started with, so agents could run an older or different install of `claude` (not signed in, an old version). `tropa` now saves your terminal's PATH and agents use it first; each agent's screen shows which binary it runs.
- **A CLI showing its sign-in or first-run screens** (theme, login) is reported in the room once, with what to do; wakes wait.
- **Any other question in an agent's terminal** (a new screen after an update, an unknown menu) holds wakes instead of typing into it, and is posted in the room once with how to answer it.
- **The port you use sticks:** `tropa start`, `stop`, `host`, `server` and `autostart` without `-p` use the port you last started with (or the one TropaAI already runs on), not always 8888.
- **Copy button on code blocks:** hover a code block in the chat (or a question or task description) and click the copy icon in its top-right corner to copy the code; it turns into a ✓. It also works when you open TropaAI from another computer over plain http.
- **Chat side panel:** the chat takes 4/5 of the width and a panel the other 1/5, with three sections. *Background tasks*: agents running a shell or background task, with what they set as their status (`dev server on :5173`); click one to open its terminal. *Files shared*: every file pasted or shared in the room, with who, when and size; click to open, ↪ to jump to its message. *Docs mentioned*: files in the docs folder that people and agents mention in the chat, opened in the Docs view on click (ones not written yet are dimmed). Sections collapse, ⟩ hides the panel, and it steps aside on narrow screens.
- **Type into an agent's terminal from the Team view:** when a CLI is waiting on a menu or a question, answer it from its card: ↑ ↓ ⏎ Esc Tab 1–4 y n and ^C buttons, and a box that types your text and presses Enter. The watcher sends it with tmux, so there's no need to `tmux attach`. Run `tropa update` in a project to turn it on.
- **Agents no longer leave processes running after they're done:** dev servers and other background commands an agent started outlived it (its shell hands them to launchd as soon as the command returns), so they piled up with every restart, model switch and removal, slowing the computer down. Agents now tag everything they start, and restarting, removing, renaming or switching the model of an agent stops what it left running; stopping or deleting the team stops all of it. `tropa reap [DIR]` lists leftovers (including untagged ones from before this version, found by their working folder) and `tropa reap --kill` stops them. Agents are also asked to stop servers they no longer need before they hand off, and to reuse one that's already running. Run `tropa update` in each project to get it.
- **Agents running a background shell aren't shown as idle:** when an agent is back at its prompt but its CLI reports a background shell or task (a dev server, a build, a test run), the graph shows it in teal as *running 1 shell* (green stays for actively working, gray for truly idle). The sidebar dot matches, and *hide inactive* keeps those agents visible.
- **Team view filter:** 🔍 type part of a name to show only matching agents, in the cards and the graph.
- **A new project no longer takes over agents of another project with the same name** (`lead`, `qa`…): the new agents get the project's name added (`lead-shop`), the form warns first, and the setup chat avoids names in use.

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
