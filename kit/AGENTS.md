# 🤖 TropaAI Agent Team — Protocol

Every agent in this project works through the local **TropaAI** chat server (URL in `.agent_sync/TEAM.md`) using its `tropa` MCP tools.
Your own identity is in `AGENT.md` in your folder (`agents/<name>/`). The team roster, lead and project room are in `.agent_sync/TEAM.md`.

## 🛠️ Onboarding
- **Register on startup:** call `register` with your agent name, the project slug, `provider` (Claude Code / OpenCode / Qwen Code / Codex / Gemini CLI), your exact `model` string, and your role as `description`. Do not post an intro message.
- **Catch up:** read the recent history of the project room (`read_messages` with `recent=true` and the configured limit) before touching any files.
- **The chatroom is the team's memory.** Decisions, handoffs and results live there. If it isn't in the room, the rest of the team doesn't know it.
- **Project docs:** specs and other documentation live in the project's `./docs` folder. Read the relevant docs before you build, and update them when a decision changes the spec.

## 🎯 How work is assigned
- **A mention is an assignment.** `@QA test the login flow` means QA owns that task. Only the mentioned agent picks it up.
- **The lead** (if the roster names one) receives messages from the human that don't name anyone. The lead breaks work down and assigns it with mentions.
- **Growing the team (lead only):** if the work needs a role nobody on the roster covers (and a teammate can't reasonably take it on), call `request_agent` with a name, CLI, model, one-line role and the reason. Depending on the project setting, the human approves it in the room or it's added at once. When it joins, give it its first assignment. Don't add agents for one-off tasks. To get another agent like an existing one (e.g. one more researcher), pass `clone_of` with that teammate's name; add `model` to put the copy on a different model.
- **Removing teammates (lead only):** when a teammate can't help any more (rate-limited for days, out of credit, failing every time, or its work is done and won't be needed), reassign its open tasks, then call `remove_agents` with the names and the reason. Only when you're sure. Never remove yourself.
- **The human** (named in TEAM.md) has the final say. A message from them in the room is an instruction, the same as if they typed it in your session.
- **`@all`** is for announcements that every agent must read.

## 🔔 Wake-ups
A room watcher types a prompt starting with `[tropa]` into your terminal when there is something for you. It is your cue to read the room, not an instruction from the human.
- An `@name` mention wakes that agent. `@all` wakes everyone.
- A message from the human that names no agent wakes the lead, or everyone if there is no lead.
- An agent message that names no agent wakes nobody. **If you need someone, mention them.**
- If you are stuck on an approval prompt, the watcher posts it to the room. The human answers from the room or the monitor's Team view; you'll be woken once it clears.
- Your screen is shown live in the monitor's Team view, so the human can see what you're doing.

## 💬 Chatroom Communication Protocol
The room is how the human and the team see your work. **Be quiet about other people's work, and loud about your own.**

**When a message assigns you work** (it @mentions you, or you're the lead and the human wrote without naming anyone):
1. **Start:** post one line with your plan, e.g. `On it: add POST /todos + validation, then tests. ~15 min.` That's a plan, not a "Got it".
2. **Progress:** keep `set_status` current (`writing tests`, `waiting for npm install`). It shows next to your name in the sidebar and doesn't wake anyone. For work longer than ~10 minutes, also post a short milestone in the room, e.g. `API done, 12/12 tests pass; starting the UI hookup`.
3. **Finish:** end with a handoff that @mentions whoever is next: the result (`@lead ready for review: …`, `@lead PASS …`), a blocker (`@lead blocked: need the API base URL`), or, when everything is done, `@<human> done: …`. **Never end your turn without it.** The team only moves when someone is mentioned. If you stop silently, the watcher nudges you and then tells the human.
4. **Questions:** ask as soon as you're unsure, rather than guessing for a long time. A teammate: @mention them in the room. **The human:** use the `ask_human` tool (the question, numbered options, your recommendation, and what you'll do if there's no answer in time); it lands in the human's "Waiting on you" list and you're woken with the answer. Then carry on with work that doesn't depend on it, or end your turn.

**The task board** (the human watches it): the lead adds one card per assignment with `task_add` (title, assignee, branch, a short description with the acceptance criteria, and `depends_on` / `contract_from`: the cards it waits for) and puts the task id (`#12`) in the assignment message. When a card's dependencies are met, its owner is woken; don't start a card that still waits for another. Mention the id in your handoffs, so the human sees the conversation on the card. Move **your own** card with `task_update` as you go: `doing` when you start, `review` when you hand it to the lead, `blocked` with a note when stuck. The lead moves it to `qa`, QA back to `doing` on FAIL, and the lead to `done` after merging. Handoffs that name the branch also move the card automatically.

**Stay silent when** a message doesn't concern you: informational updates, agents talking among themselves about work that isn't yours, or when all you'd say is "Got it", "Thanks" or "Acknowledged".

**Long-running commands** (dev servers, watchers, `npm run dev`): start them in the background with a pid file (`npm run dev > /tmp/<name>.log 2>&1 & echo $! > /tmp/<name>.pid`), wait until the port answers, then carry on in the same turn. Before you hand off, stop the ones nobody needs anymore (`kill $(cat /tmp/<name>.pid)`), and reuse a server that's already running instead of starting a second copy: each one left behind keeps using memory. tropa stops whatever you left running when you're restarted or removed.

## 📎 Files
- Files shared in the room appear as `📎 <path>`; they are saved in the project (usually `docs/attachments/`). Read them there.
- To show the human or the team a file (mockup, screenshot, PDF, doc), save it inside the project and call the tropa `share_file` tool with its path, e.g. `docs/mockups/home.png`. Never share secrets (`.env`, keys).

## 🛡️ Guardrails (unless TEAM.md says they're off)
Load the `guardrails` skill before work that touches auth, user input, databases, files, secrets, payments or external APIs, and before adding a dependency. The hard rules:
- **No secrets** in code, commits, logs or chat. Use env vars: real values go in `.env` (git-ignored), placeholders in `.env.example`. A commit that contains a likely secret is blocked; never bypass it with `--no-verify`.
- **Validate input and check authorisation on the server**, for every request. No string-built SQL or shell commands with user input.
- **Ask @human first** before destructive or irreversible actions: force-push, `reset --hard`, deleting data or tables, production changes, `curl | sh`, `sudo`, or exposing a port to the internet (use the `request_share` tool, never ngrok yourself).
- **Dependencies:** real, maintained packages with a compatible licence; commit the lockfile; run the audit after adding any.
- **Before handoff, approval or PASS:** post the one-line guardrails check from the skill.

## 🌿 Git workflow (default)
When the project is a git repository, code changes go through review → test → merge. Your own steps are in your `AGENT.md`.
- **Developers never commit to the main branch.** Each task gets its own branch (`<agent>/<task>`). When **two or more developers** work at the same time, each task also gets its own **git worktree** in `.worktrees/<agent>-<task>`, so nobody edits the same checkout.
- **Hand off for review** when the branch is committed: `@lead ready for review: branch <agent>/<task> — what changed, how to test`.
- **The lead reviews** (`git diff <main>...<branch>`), then either asks for changes or sends it to **QA**.
- **QA tests** the branch in its worktree and reports `PASS` / `FAIL` to the lead (a FAIL also @mentions the developer, with steps to reproduce).
- **Only the lead merges** into the main branch, after QA passes, and then removes the worktree and branch.
- Commit as yourself (`git -c user.name="<agent>" -c user.email="<agent>@tropa.local" commit …`). Nobody pushes, force-pushes or resets unless the human asks.
- No git repo yet? Work in the folder, coordinate files through the lead, and the lead asks the human whether to `git init`.
