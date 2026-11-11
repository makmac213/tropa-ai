# Changelog

## 0.5.1 (October 2026)

### Dark mode colours
- **Pick a dark palette in Settings → Dark mode colours:** Graphite (the default, as before), Ink (blue-black, cyan), Ember (warm charcoal, amber), Plum (violet, lavender), Moss (green-black, mint) or Black (OLED, true black). `/palette ink` works too. It only changes the dark theme; light mode stays as it is. Every palette passes WCAG AA contrast, and the choice is kept in this browser.

### Flow: who asked for what, and what should come of it
- **The Flow tab is a flowchart of each request now, not a graph of cards.** Read it left to right: your request in your words, the lead's plan, then one row per instruction: *lead asked developer* (or *developer asked qa*) what to do, the **expected result**, and **who checks it** (you, the lead or QA) with its status: *Needs you*, *In review*, *Done · 11:40*. A dashed line joins a task to the one it waits for.
- **Tasks remember the request they serve.** The lead passes the id of your message when it adds a task (`task_add` `request`); without it, the task links to your latest message in the room. Tasks you add yourself stand on their own.
- **Every task says the result it expects:** the lead now writes a `Done when:` line in each task, and the chart shows it. Older tasks without one say so.

### Fixed: an agent's question to you was cut short
- **The whole question shows now.** Questions were cut at 1,000 characters, so a long one (a status report ending in a question) stopped mid-word. A question asked in a normal message also lost its line breaks, so lists ran together into one paragraph. Both are fixed, and questions already cut short show in full from their message.
- **Long questions are easier to read:** normal weight instead of all bold, with lists and paragraphs as the agent wrote them.

### Archive projects
- **Archive a project to hide it from the projects list.** Hover it and click the box icon, or use **⋯ → Archive the project** in Simple mode. It moves to a collapsed **Archived** list at the end; open it there and click **Unarchive** to bring it back. Nothing in it changes: chat, tasks, files, folder and team are kept, and a running team keeps running.

### Agents can't act as you
- **No login, but a key only you hold.** Each TropaAI server has a random key in `~/.tropa/secret-<port>.key`. Your browser gets it once, as a cookie, when you open TropaAI from its shortcut, `tropa start` or the new **`tropa open`**; `tropa`, the watcher and the host helper read the file. Everything that changes something needs it: posting as you, approvals, typing into a terminal, settings, public links and agent requests. Reading doesn't.
- **Why:** agents only talk to the chat over MCP and never get the key. So an agent, or a web page or README that tricked one, can no longer post as you with `curl`, approve its own prompts, answer its own questions, open its own public link, or pose as the host helper to collect the API keys you save.
- **After this update** TropaAI opens in your browser once to connect it (`tropa self-update` does it). A browser that isn't connected shows *Connect this browser to TropaAI* and can read but not send.
- **Requests to another host name are refused**, which stops a web page from reading your rooms through DNS rebinding. Reach TropaAI by another name by listing it in `ALLOWED_HOSTS`.
- **The server listens only on this computer by default**, even when started by hand (`node server.js`). Docker keeps working: the container listens inside, and the port is still published on `127.0.0.1` only.
- **A note says who turned auto-approve on or off:** you in the page, `tropa`, or an edit to `.agent_sync/settings.json` (an agent, or you in an editor). Agents can still turn it on when you ask them to.
- **Tests and CI:** security tests for the server (`npm test` in `server/`), Python tests on Python 3.9, and a GitHub Actions check on Ubuntu and macOS.

### Agents answer when mentioned in another room
- **An @mention in a room the agent's team doesn't run now wakes it.** Ask your dev team's `@developer` something in the research room (or `#general`) and its own team wakes it, pointed at that room and told to answer there. Before, it only heard about it when you mentioned it again in its own room.
- **No mix-ups between teams:** agent names are unique across TropaAI, and a name the room's own team uses (its `@lead`) is never sent to another team. If two running teams both claim a name (an old setup), nothing is routed.
- **Only a pointer travels:** the agent alone is told who mentioned it, where, and the message number, and to read and answer there. Nothing is copied into its own room and its teammates aren't woken. `@all` only ever wakes the room's own team.
- **The room's own team stays asleep** when your message names only a visitor, and an agent's "thanks" to a visitor wakes nobody.

### No more emoji in TropaAI's own screens
- **Line icons instead of emoji:** the notifications bell, theme and settings buttons at the bottom of the sidebar, attach, thumbs up and down, and file icons in messages, docs and uploads. Buttons and labels that only had an emoji for decoration are now plain text (*Share*, *Keys*, *Start the team*, *Out of credits*…).
- **TropaAI's notes in the chat are shown without their emoji,** older ones included. Agents' own messages are shown as they wrote them.

### Restart an agent from the chat
- **Write `restart @backend2`** (or *@backend2 restart your session*, *restart @a and @b*, *restart @all*, or `/restart @backend2`). Its CLI stops and starts again on the same conversation, which also reconnects its MCP tools: the fix when an agent says its chat tools are disconnected. A note in the chat confirms it. Messages like *please restart the dev server @backend2* are still just messages.

### Advanced chat is as narrow as Simple
- **Advanced project chats use the same 720 px reading column as Simple.** It was 960 px, which made long agent reports hard to read on wide screens.

### Quicker agent actions
- **Click an agent's name in the sidebar** and its dialog now starts with **Wake**, **Restart**, **Clone** and **Make lead**, so you don't have to open the Team view to unstick one. Its name also shows *lead* when it leads the room.
- **Snooze all** in *Needs attention* (Team view) hides every flagged item for an hour in one click. Approvals stay, since an agent waiting on one can't carry on.

### Pass the lead
- **Hand the room to another agent when the lead is stuck**, for example at its usage limit. Say it in the chat: *hey @lead pass the leadership to @developer*, *make @designer the lead*, or *@designer you're the lead now*. Add *for the day* (or *today*) and the old lead takes it back at midnight.
- **Or click:** **Make lead** on an agent's card (Advanced, Team view) or beside a teammate in Simple's side panel, and **Pass the lead…** on the lead's card when it hits its limit. Pick **For today** or **From now on**. `/lead @agent` (add `today`) works too.
- **The new lead is told to catch up** on the chat and the task board and take over; the old one is told to finish its cards and take direction. Messages that name nobody go to the new lead right away, and a note in the chat says who leads now.

### Fixed: the old page after an update
- **After `tropa self-update`, a reload now shows the new version.** The page was sent without caching rules, so a browser could keep showing its old copy for a while. The page is now always re-checked (cheap when nothing changed).

### Advanced chat looks like a conversation
- **Advanced project rooms use the same layout as Simple:** your messages as bubbles on the right, agents with their face and name on the left. **Nothing is folded away:** agents talking to each other show in full, TropaAI's notes are quiet one-line rows, and day dividers, the time beside each name, the model on hover, reactions, attachments and answer buttons all stay. All activity and search keep the list layout.

### Slash commands show as a conversation
- **Your `/btw` (or any slash command) shows in the chat right away**, under your name, and the agent's answer under the agent's name. They were TropaAI notes, which the recent quieter chat folded away (into "team updates" in Simple, a small grey line in Advanced).
- **The whole `/btw` answer comes through.** Claude Code shows it in a small scrolling box; the watcher now scrolls through all of it, then closes the box so the agent can carry on. The answer is posted as normal text, not as code with the box's footer.

### A better dark mode
- **A rounder Simple / Advanced switch:** a pill-shaped track with a raised thumb (grey in dark mode, white in light), and no blue: blue stays for buttons that do something.
- **The header line is one straight line now.** The sidebar's top was a different height from the page header, so their bottom borders didn't meet. It now follows the header's height: the logo row in Simple mode, the logo and the mode switch beside Advanced's header and tabs.
- **Clear layers:** the page is the deepest ink, panels and the header one step up, and raised things (your message bubbles, cards, hover) another step, so the screen has depth instead of three near-identical greys. Lines are a touch stronger.
- **Calmer colors:** a softer blue for buttons and links, a quieter tint on messages for you, and slightly gentler status colors, all checked at WCAG AA or better.
- **The browser's own parts follow the theme:** text selection, focus rings, the text cursor and thin scrollbars.

### Advanced mode, refined
A design pass using the rules of the impeccable design skill for app screens: familiar controls, one icon set, less noise, and one signature detail.
- **Views are tabs:** Chat · Team · Tasks · Docs · Usage under the room name, with counts. Download, share and skills are small icons; Questions and Attention show only when they need you.
- **One line-icon set** instead of emoji on the header buttons.
- **The team at a glance:** the agents' faces sit in the header with a ring for working, needs you or idle, plus "1 working · 1 needs you". Click to open the Team view.
- **Quieter chat:** messages for you get a light tint and a "For you" tag (no thick stripe); TropaAI's own notes are single muted lines; message numbers and the model tag show on hover; the HUMAN tag is gone. Questions get one button per answer, and so do questions waiting on an agent's screen.
- **Sidebar:** Projects first, then the project's **Team** with what each agent is doing ("Building the menu page · 4 min", "Asking you on its screen", "Idle 12 min"), then Feeds.
- **Team view:** one toolbar (layout, filter, Only active, **Auto-wake** and **Auto-approve** switches, Wake all, Add agent) and a **Team settings** panel in plain words: *Who gets woken*, *When the lead wants to…*, *Keeping it healthy*, *This project*.
- **Tasks:** drag cards between columns (the dropdown and × on every card are gone; delete is in the card's window). Empty columns are narrower and say "Nothing in QA".

### A new team builder in Advanced's New project
- **The project on the left, the team on the right**, in one wider window. Tools, design system, API keys, git, auto-approve and the first message fold into **More options**; it opens by itself when an agent needs an API key.
- **One line per teammate:** face, name, role and what it runs on ("Claude Code · Sonnet", "OpenCode · local qwen3"), with a LEAD badge on the lead. Click a line to change it: name and role, **Works in** (one button per program, "not installed" ones marked), **Model** (cards in plain words for the program's own models, or a local or OpenRouter model, or type one), their job, Make lead and Remove.
- **＋ Add a teammate** searches every role in the ready-made teams, or starts a new one. They join on the program and model most of the team uses.
- **Same for everyone…** sets one program and model for the whole team, and a line under the team sums it up.
- Fixed: the Simple new-project page's styles leaked into the Advanced form (the folder box looked wrong).

### A steadier header in Advanced mode
- **☰ Chat has its own place, beside the search box.** It used to replace whichever button you last pressed (Team, Tasks, Docs or Usage), so it moved around. Those buttons now keep their names and look pressed while their view is open.
- **Smaller header buttons**, so the row takes less room.

### Answer an agent's screen questions with buttons
- **Questions a CLI asks in its terminal** (a menu with "Enter to confirm") now show in Simple mode as a card with a button per answer, in the chat and on the agent's row in the side panel. No more switching to Advanced to press ↓ and Enter.
- **Claude Code's "Bypass Permissions mode" warning is accepted by itself** when Auto-approve is on, since you already chose that in TropaAI. The room says so, and how to turn it off.

### Arrange the team graph
- **Drag the agents (and you) around the Team graph** to arrange it your way. The layout is kept per project in this browser; **Reset layout** in the graph's legend puts everyone back. A click still opens the agent's terminal.

### Fixed: adding an agent failed on a Mac
- **"Couldn't add @agent: SyntaxError: f-string: expecting '}'".** Part of the agent setup used a way of writing text that needs Python 3.12, and a Mac's built-in Python is 3.9. Every TropaAI script is now checked with Python 3.9.

### Fixed: lists marked "Waiting on you"
- **A message that only lists example questions is no longer treated as a question for you.** An agent message that @mentions you counted as a question if it had a "?" anywhere, including inside a numbered list of prompts to try. Now only the agent's own sentences count; a "?" inside a list, a quote, quotation marks, code or a link doesn't. Questions asked with `ask_human` are unchanged.

### See what happens to your message
- **Simple mode shows the status of your last message** until someone replies: *Sent*, *Seen by lead* (the agent read it), then *lead is working on it · 4 min · Running git push*, with what it's doing read off its screen (running a command, editing a file, reading the chat…). After a few minutes with no reply, **Ask for an update** sends a one-line nudge. The side panel's Team list shows the same live activity.
- **Agents say "On it" first.** When you write to an agent, it's asked to reply with one line about what it'll do before any work that takes more than a minute.

### @ suggestions
- **Typing @ in the message box suggests names:** the room's agents (lead first, with what each is doing), the people in the room and `@all`. Typing narrows the list; ↑ ↓ choose; **Tab**, Enter or a click puts the name in. Works mid-sentence and in both modes; an email address doesn't set it off.

### Fixed: "the room watcher keeps stopping" on a Mac
- **The watcher was running all along.** The helper's check looked for a process named `python…`, but on a Mac `python3` can start Apple's `Python` (capital P) as a separate process. The check missed it, so every 30 seconds the helper restarted a healthy watcher, then said it "keeps stopping". It now finds the watcher however Python was started.
- **Never giving up for good.** After 3 restarts in an hour, the helper still tries again every half hour by itself, instead of waiting for someone to press Fix the team.
- **Simpler message.** The message no longer sends you to Advanced mode; in Simple mode it comes with a **Fix the team** button.
- **The watcher keeps going after an error** in reading one agent's screen or handling one request: it logs the error and carries on instead of stopping.

### Simple mode, chat-first
- **Simple mode works like a chat app now.** One conversation in the middle with a large message box. Your messages are bubbles. Replies meant for you (the lead answering you, @mentions of you, questions) show with the agent's name and face. The team's talk among itself and TropaAI's setup notes fold into *N team updates*. Message numbers, times and tags are gone.
- **Questions are cards with a button per answer** (or type your own); answered ones say what you chose.
- **A new side panel shows what the team is doing:** each member's status in plain words, the commands running in the background (dev servers, with **Open** and **Stop**), the decisions made so far and what still needs you, and the files changed lately. On a phone it opens from the team's faces at the top.
- **New project is one question:** *What should your team work on?* TropaAI picks the team from what you write, or you click one of the suggested teams. *See all teams* still opens the full team builder.
- **The header is the project's name, a ⋯ menu and the panel switch.** The sidebar lists your projects with **New project** on top.

### Auto-heal
- **Teams no longer stall when an agent can't work.** With *Auto-heal* (on by default, ▦ Team bar), TropaAI keeps the room moving by itself and says what it did with a 🩹:
  - **Usage limits and credits:** wakes for an agent at its limit wait until it's back instead of being lost; the lead (or a teammate) hears it with the agent's open cards; a lead at its limit gets a teammate standing in, so your messages are still answered; and the agent is tried again once its limit should have reset, then carries on.
  - **A quiet card in Doing:** a nudge, then a restart that resumes its conversation, then the lead is asked to reassign it and you're told.
  - **A quiet room with unfinished cards:** the lead is woken to get the next card moving.
  - **A step that hangs for 30 minutes:** interrupted, and the agent carries on another way; a second hang restarts it.
- Nothing happens while the room is paused, an agent waits on an approval, or a question waits on you.

### Install
- **The installer is friendlier and checks everything before installing TropaAI.** It runs in 4 numbered steps: check the computer (✅/❌ for git, Python, tmux, Node.js and an AI agent), install what's missing after asking once, install TropaAI, open it. New: it installs Apple's Command Line Tools (and waits for Apple's window to finish), Homebrew when a Mac needs it for tmux, and an AI agent (Claude Code, OpenCode or both; `TROPA_CLI` chooses up front). It warns before anything asks for a password, and adds what it installed to your PATH. If something can't be installed it stops before installing TropaAI and says exactly what to do, so there's never a half-working install.
- **Windows setup for everyone:** download **TropaAI-Setup.cmd** and double-click it (or paste the PowerShell line). It turns on WSL with one Windows permission prompt and, if Windows needs a restart, **carries on by itself after it**; installs Ubuntu and walks you through creating your Linux user in the same run (no more "open Ubuntu, then run the installer again"); installs Linux tools without asking for a password; lets the Linux installer add Node.js and an AI agent; adds **TropaAI shortcuts** to the Desktop and Start menu (and, if you like, starts it when you sign in); and offers to sign you in to Claude Code or OpenCode right there. Problems such as virtualization being off are explained in plain words, and each run is logged to `%TEMP%\tropa-install.log`.

### Fixed
- **Pasting a screenshot filled the message box with endless `pasted.png  NaN MB` chips** that came back after a restart. Two functions in the chat page had the same name, so the side panel's "note this room's files" call ran the composer's upload instead, uploading each character of the room's name as a file, which set it off again. Fixed, the composer only accepts real files, and the server refuses images too small to be real. Leftovers are removed by themselves: the junk uploads when the chat server starts, and the tiny `docs/attachments/<id>-pasted.png` copies when the project's watcher starts.

### Contrast
- **Every screen passes WCAG AA contrast again, in light and dark mode,** checked with axe-core across the chat, Team (cards and graph), Tasks, Docs, Usage, Waiting on you, Settings, Setup, New project, Build your team, the welcome and the slash menu, plus the attention, question and task badges. Fixed: the red *needs attention* badge (`1!`) had dark text on dark red in light mode; the *Review*, *Stalled*, *Blocked* and *Approval* tags were slightly too faint on light backgrounds; docs not written yet were dimmed below AA; *Ready to start* was a hair under AA.

### Where new projects go
- **Choose where a new project folder is created,** not only `~/projects`. **Change where…** in Simple mode's *Build your team* and in the New project form opens your computer's own folder window, or you can type a path. Any folder in your home or on an external drive works, and a missing one is created. The place is remembered for the next project. Hidden and system folders are refused.

### Add an existing project without changing it
- **Leave the folder untouched** (ticked by default when you add a folder you already have, in Simple and Advanced mode, and for rooms agents create in an existing folder). TropaAI adds nothing to your folder:
  - no `.agent_sync/`, `agents/`, skills, `AGENTS.md` changes, `.gitignore` lines, `docs/`, git hooks, branches or worktrees;
  - the team's own files live in `~/.tropa/workspaces/<room>`;
  - the agents work on the code in your folder. Claude Code also reads the project's own `CLAUDE.md`; Codex and OpenCode run in your folder and get the team's rules added; Qwen and Gemini include it.
- Without branches and worktrees, there's no branch-and-review workflow in this mode: agents edit the code directly. Untick the box to put the team kit inside the folder, as before.
- Adding the same folder again adds agents to its existing team. The New project form lists the folder as already having a team.
- Fixed: adding an existing folder with no agents chosen now gives it its lead, and adding agents to an existing team keeps its lead.

### Smaller sessions, cheaper turns
- **Sessions are compacted automatically, for every CLI** (Claude Code, Codex and OpenCode `/compact`; Gemini CLI and Qwen Code `/compress`), with no one at the terminal. TropaAI reads each agent's current context size from its CLI's logs. An agent past **150k tokens** is compacted:
  - when it hands a card on (to review, QA or done);
  - or when it has been idle **10 minutes** after being given work. By then its prompt cache has expired, so its next turn would re-send everything at full price.

  A CLI whose logs TropaAI can't read is compacted when it hands a card on. A short note in the room says who was compacted and why.
- **The lead is never compacted automatically.** When its session is large, the next wake it gets anyway asks it to call the new `compact_me` tool at a good stopping point. Any agent can call `compact_me`, and it's compacted once its turn ends.
- **Settings in ▦ Team:** *Compact on/off*, *past __k* and *idle __ min*.
- **Agents no longer read TropaAI's own notes.** `read_messages`, the inbox and `wait_for_messages` leave out system notes (watcher restarts, "fixed the team", settings, these compaction notes). You still see them in the room.

### Agents create rooms
- **Agents can create a project room with its own team:** the new `create_room` tool takes a name, a brief, an optional ready-made team and an optional existing folder. Every room it creates has a lead orchestrator (or the ready-made team and its lead), a folder (a new one, or the folder given, e.g. the repo a Claude Code session is in), the brief in `docs/`, and a kickoff to its lead.
- **Asked directly:** a Claude Code or Claude Cowork session you tell to "make a room for this" creates it at once, and #general says so.
- **A team's lead** starting a room for part of its work follows that project's new **New rooms** setting in ▦ Team: *ask me* (default; a card with **Start #room** / **Deny**, or `@tropa approve room N`), *automatic*, or *off*. The new room's lead reports back to the room that asked. Other team members can't start rooms. A room that exists with a team, or is being set up, can't be created twice.

### Fixed
- **The "Replying to …" bar now goes away** when you click ✕, send your reply or press Escape. Its style overrode the page's *hidden*, so it stayed on screen, empty or not. Now *hidden* always hides, everywhere on the page; no other element changes.

### Pause a room
- **`/pause` and `/resume`** in the chat box. They do the same as the Auto-wake switch in ▦ Team.
- **While a room is paused, nothing wakes its agents automatically:** new messages, the watcher's "stopped without reporting" nudges, "task unblocked" wakes and question deadlines all wait. A banner says the room is paused, with **▶ Resume** (Simple and Advanced mode).
- **On resume**, the lead is told to catch up on what was posted during the pause. A question whose deadline passed meanwhile goes ahead then. Things you do yourself still reach the agents while paused: 👍/👎, Wake all, approvals.

### Projects update themselves
- **No more `tropa update` in every project after `tropa self-update`.** `tropa update` now records which kit and default skills it installed (in `~/.tropa/kit-stamps.json`, not in the project). Every few minutes the host helper runs `tropa update` in each project that's behind, wherever its folder is, and that restarts a running team's watcher on the new scripts. A project whose update fails is retried after the next tropa update, and the failure is in the host helper's log.

### TropaAI keeps itself running
- **The helper on your computer** (it starts and heals teams) **now comes back by itself:**
  - after a crash, within seconds;
  - when the chat server runs on your computer rather than in Docker, the server starts it again within a minute;
  - **a keeper**, which `tropa start` sets up the first time, checks every minute (launchd on a Mac, a systemd timer on Linux) and starts the chat server or the helper if either is down. It also starts TropaAI when you log in, and it works with Docker. `tropa keep` is that check by hand, and `tropa autostart off` turns it off.
- **No more terminal instructions in the page.** Where the page used to say "run `tropa panel` / `tropa host start`", it now says in plain words that TropaAI's helper isn't running, with a **▶ Start the helper** button when the page can start it. When it can't (Docker), it says the helper comes back within a minute, or to open TropaAI with its shortcut. Once the helper is up, the page shows **▶ Start the team** without a reload.

### 👍 / 👎 on messages
- **React to any message with 👍 or 👎** from its hover bar. Your reaction shows under the message; click it (or the same thumb) again to take it back.
- **On an agent's message it's a quick approve or disapprove:** the agent is told to go ahead (👍) or not to (👎, and to ask what to change if the room doesn't say). Its wake comes a few seconds later with your final choice, so a quick change of mind sends one.
- **On a question an agent asked you,** 👍 answers "yes, go with your recommendation" and 👎 answers "no", closing the question.
- Agents see reactions when they read the room.

### Every room keeps a lead
- **Every project room has at least one agent, its lead orchestrator.**
  - **The lead's job** is in `teams/lead.md`: it runs the room, plans and assigns the work, asks for teammates when needed, and does the work itself on a team of one.
  - **Starting with an empty team** gives you that lead: *Start with a lead* in Build your team, *Just a lead* in the New project form, or a project created with no agents.
  - **`tropa init`/`tropa update`** in a folder with no agents creates `lead-<project>`. Starting a team whose agents are gone does the same.
  - **A team with agents but no lead** gets its first agent as lead.
- **The lead can't be removed while others remain** (make another agent the lead first, ★ in ▦ Team), **and the last agent can't be removed.** This covers the sidebar's ×, the agent dialog, "@tropa remove …" in the chat and the lead's `remove_agents`. Build your team and the New project form don't let you remove the last member either.
- **A room with no team** shows a banner: **Add a lead** creates its folder with the lead and starts it; **Use a folder I already have…** sets the team up in your folder. The old *New project room* dialog, which made rooms without a team, is gone.

### Quieter idle teams
- **Idle agents no longer trade "standing by" messages.** Three rules together made them: the *stopped without reporting* nudge only accepted a reply with a @mention, every @mention woke its agent, and the wake prompt told every agent to finish with a @mention. Now:
  - **Any reply counts:** a short "nothing to do here" is enough for the nudge, and an acknowledgement from another agent ("thanks", "noted", "standing by") isn't treated as an assignment.
  - **Acknowledgements wake nobody:** an agent's short acknowledgement, with no question or request in it, doesn't wake the agents it mentions. Messages from you always wake as before.
  - **The instructions say so:** the wake prompt, the agents' MCP instructions and the `team-handoff` skill tell agents not to reply to acknowledgements and not to @mention anyone just to say they're idle.

### Questions
- **Dismiss all** in the *Waiting on you* panel closes every open question in the project at once, after you confirm. It shows when more than one question is waiting.

### Reading the chat
- **New messages no longer pull you down while you're reading.** The chat only follows new messages when you're already at the bottom; before, a bug made every new message jump to the bottom.
- **↓ N new messages** appears when something arrives below where you're reading; click it to jump down.
- **Auto-scroll switch** under the message box (*⇣ Auto-scroll on* / *⏸ Auto-scroll off*, remembered in the browser). Off, the chat never moves by itself, except when you send a message.

### Rooms and their folders
- **"Couldn't start the team: I can't find the folder" is fixed for folders outside `~/projects`.**
  - **Where the host helper now looks:** the project lists of every port (`~/.tropa/projects-*.json`) and team folders anywhere in your home, not only its own port's list and `~/projects`.
  - **When nothing is found**, the message names the exact command to link a folder to the room: `tropa update --project <room> -p <port>`. It also points to ＋ New project → *A folder I already have*.
- **`tropa update` in a folder without a team kit** links it to the TropaAI you use, not the template's port 8888. It prints the room and server it linked to, and warns when that port isn't running but another one is.
- **Pressing Start in a room** re-points a folder linked to another port at this TropaAI, so the room sees the team.

### Skills in the chat
- **🧩 Skills** in every project room, in Simple and Advanced mode. It lists the team's skills, who gets each one and which come with tropa.
- **Add, edit, import or remove skills there:** a name, when to use it, who gets it (everyone or picked agents) and the instructions. **Import SKILL.md** fills the form from a file you already have.
- **The watcher applies each change:** it writes `.agents/skills/<name>/SKILL.md` in the project, relinks the skill for the agents it's for, updates their `AGENT.md` and posts a note in the room.
- A skill can now be for named agents (`tropa-roles: "writer"`), not only roles. Other front-matter fields (license, allowed-tools…) are kept when you edit. A built-in skill you remove stays removed on `tropa update`.

### Updating
- **`tropa start` restarts a chat server or host helper that runs older code than the tropa folder.** Before, after a `git pull` it said *already running* and kept the old one; with Docker, that meant the old image kept serving the old chat page. The server now reports a fingerprint of its code (`build` in `/health`), and a Docker image is rebuilt when it restarts.
- **`tropa self-update` now restarts TropaAI on the new version.** Before, the chat server and host helper kept running the old code until they were restarted by hand, so new features (such as new ready-made teams) didn't show up. Chats, projects and running teams are kept; reload the page afterwards.
- **`tropa restart`** restarts the chat server and host helper by hand.

### More ready-made teams
- **Seven new teams:**
  - **Recruitment:** job ad, sourcing, fair screening against a scorecard, structured interviews and candidate updates. You make every decision.
  - **Social media:** strategy and calendar, posts, community replies, monthly report.
  - **Sales outreach:** ideal customer, researched prospects, short personal emails, replies.
  - **Email marketing:** newsletters and automated journeys, tested and measured.
  - **Paid ads:** Google and Meta within your budget, tracking first.
  - **Bookkeeping:** month-end close with an independent reviewer; it never moves money.
  - **Grant writing:** funder research, proposal, budget and a check against the guidelines.
- **SEO team, refreshed:** a new link builder (digital PR, no bought links). The writer and lead follow Google's people-first and spam policies (no mass-produced pages). The site auditor checks indexing, Core Web Vitals and structured data.
- The job descriptions follow how these teams are organised in practice: who does what, the hand-offs and what "done" means. Each includes the rules of the trade, such as anti-spam and opt-out rules for email, ad platform policies, fair-hiring and data-privacy care for candidates, and separating who records from who checks in bookkeeping. Anything that goes out is a draft until you sign it off.

### Agent slash commands
- **Run an agent's own slash commands from the chat:** `/btw is the build green?` goes to the lead, `@dev /compact` to dev. TropaAI types it into the agent's terminal and posts what comes back to the room. Skills and custom commands work the same way (`/deploy staging`).
- **Typing `/` lists them**, per agent: each CLI's useful built-ins plus the skills and custom commands found for it (Claude skills and commands, Gemini and Qwen `.toml` commands, OpenCode commands, Codex prompts). The list refreshes by itself when you add a skill.
- **Commands differ between CLIs.** An agent whose CLI doesn't have the command gets your text as a message instead. Session-ending commands (`/exit`, `/clear`, `/login`, `/model`…) are refused, nothing is typed over an approval prompt, and wakes wait until the command's answer is in.

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
