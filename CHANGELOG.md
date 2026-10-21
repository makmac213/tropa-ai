# Changelog

## 0.5.1 (October 2026)

### Install
- **The installer is friendlier and checks everything before installing TropaAI.** It runs in 4 numbered steps: check the computer (✅/❌ for git, Python, tmux, Node.js and an AI agent), install what's missing after asking once, install TropaAI, open it. New: it installs Apple's Command Line Tools (and waits for Apple's window to finish), Homebrew when a Mac needs it for tmux, and an AI agent (Claude Code, OpenCode or both; `TROPA_CLI` chooses up front). It warns before anything asks for a password, and adds what it installed to your PATH. If something can't be installed it stops before installing TropaAI and says exactly what to do, so there's never a half-working install.
- **Windows setup for everyone:** download **TropaAI-Setup.cmd** and double-click it (or paste the PowerShell line). It turns on WSL with one Windows permission prompt and, if Windows needs a restart, **carries on by itself after it**; installs Ubuntu and walks you through creating your Linux user in the same run (no more "open Ubuntu, then run the installer again"); installs Linux tools without asking for a password; lets the Linux installer add Node.js and an AI agent; adds **TropaAI shortcuts** to the Desktop and Start menu (and, if you like, starts it when you sign in); and offers to sign you in to Claude Code or OpenCode right there. Problems such as virtualization being off are explained in plain words, and each run is logged to `%TEMP%\tropa-install.log`.

### Your name
- **Choose what your team calls you.** The first time you open TropaAI in Simple mode (or before your first project), a welcome asks for one word the agents can @mention, with a preview (*"Done, @Maria: here's the plan."*). It no longer has to be the computer's login name, which on Windows can be odd (`DESKTOP-7Q2X`).
- **The *You are* box now renames you everywhere**, not just on your own messages in that browser. The name is saved in the chat (it outlives restarts and wins over `tropa start --human`), and every running team adopts it: settings, TEAM.md and AGENT.md, the old name in roles and jobs, and a note in the room.
- Names that are reserved words (`all`, `team`…) or an agent's name are refused.

### Credits and limits
- **See why an agent stopped:** *out of credits*, *usage limit · resets at 3pm* or *rate-limited*, read off the agent's screen for Claude Code, Codex, Gemini CLI, OpenCode/OpenRouter and Qwen. A purple node on the graph, a purple dot in the sidebar, a banner on its Team card with **Switch model** and **Clone**, and *Paused: …* in Simple mode's *Your team*.
- **The room is told once:** right away for credits and usage limits (with the reset time when the CLI gives one), after a minute for rate limits (CLIs retry those). It clears by itself when the agent works again.

### Self-healing teams
- **Teams fix themselves.** Every 30 seconds the host helper checks each running team. If the room watcher stopped, or an agent's CLI crashed or its window disappeared, it restarts it and posts *🩺 Fixed the team…* in the room. Limits: 3 watcher restarts and 2 per agent an hour, then one warning instead of looping. It never starts a stopped team.
- **🩺 Fix the team** button (Simple: the side panel's *Your team*; Advanced: the ▦ Team bar) runs the check now, without the limits, or starts the team if it isn't running. No more `tropa panel` in a terminal for that.
- **Fixed:** a dead room watcher looked alive (its window's shell still mentioned `room_watcher`), so **Start the team** didn't restart it.
- **Docker isn't required**, and the README now says so: TropaAI runs on Node.js (installed for you); Docker is only for `--docker` or the optional Kokoro voices.

### Simple mode
- **Simple / Advanced switch** at the top of the sidebar. **Advanced** is the full interface, as before. **Simple** keeps the chat, Tasks, Docs and the side panel, and hides terminals, models, usage and public links. New users (no projects yet) start in Simple; the choice is remembered.
- **Build your team** (Simple's **+**): start from a ready-made team in `teams/` (or empty), rename members, change roles, read and edit each one's job, pick the lead, remove people, or **hire someone** from the role library (every role in every team) or by describing a new role. Then say what the team should work on and where it's saved (a new folder, or an existing one with Browse…), and **Create team and start**.
- **Your team** in the side panel (Simple): each member's status in plain words (working, waiting for work, running a long task, needs your OK), with **Allow / Don't allow** right there when one needs a decision.

### Ready-made teams
- **Teams are folders of prompts** in `teams/`: a `team.md` (name, summary, lead, how the team works) and one prompt file per member, named after the agent. Add a folder and it shows up in the New project form's **Start from** list, no code needed; your own go in `~/.tropa/teams/`. `tropa teams` lists them.
- **New teams:** Research & publishing desk, SEO team, Customer support desk and Market research team, next to Website studio, Small dev team and Solo developer (the old presets, now with full job descriptions).
- **Each agent keeps its job:** a member's prompt and the team's way of working are saved in its `AGENT.md` under *Your job* for the whole project. Teams that don't write code (`git: no`) start without branches and worktrees.

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
