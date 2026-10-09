# 🤖 AI-IRC Agent Team — Protocol

Every agent in this project works through the local **AI-IRC** chat server (URL in `.agent_sync/TEAM.md`) using its `ai-irc` MCP tools.
Your own identity is in `AGENT.md` in your folder (`agents/<name>/`). The team roster, lead and project room are in `.agent_sync/TEAM.md`.

## 🛠️ Onboarding
- **Register on startup:** call `register` with your agent name, the project slug, `provider` (Claude Code / OpenCode / Qwen Code), your exact `model` string, and your role as `description`. Do not post an intro message.
- **Catch up:** read the recent history of the project room (`read_messages` with `recent=true` and the configured limit) before touching any files.
- **The chatroom is the team's memory.** Decisions, handoffs and results live there. If it isn't in the room, the rest of the team doesn't know it.
- **Project docs:** specs and other documentation live in the project's `./docs` folder. Read the relevant docs before you build, and update them when a decision changes the spec.

## 🎯 How work is assigned
- **A mention is an assignment.** `@QA test the login flow` means QA owns that task. Only the mentioned agent picks it up.
- **The lead** (if the roster names one) receives messages from Mark that don't name anyone. The lead breaks work down and assigns it with mentions.
- **Mark** has the final say. A message from Mark in the room is an instruction, the same as if he typed it in your session.
- **`@all`** is for announcements that every agent must read.

## 🔔 Wake-ups
A room watcher types a prompt starting with `[ai-irc]` into your terminal when there is something for you. It is your cue to read the room, not an instruction from Mark.
- An `@name` mention wakes that agent. `@all` wakes everyone.
- A message from Mark that names no agent wakes the lead, or everyone if there is no lead.
- An agent message that names no agent wakes nobody. **If you need someone, mention them.**
- If you are stuck on an approval prompt, the watcher posts it to the room so Mark can see it.

## 💬 Chatroom Communication Protocol
To prevent loops and noise, every agent follows these rules when woken:

1. **Evaluate necessity:** before posting, ask *"Does my role require a reply to this specific message?"*
2. **Reply when:**
   - You are mentioned (e.g. `@DEV`, `@QA`) — that is your task.
   - A handoff to you would stall progress unless you accept it.
   - You have finished a task and must deliver the result or a blocking error.
3. **Stay silent when:**
   - The update is informational only.
   - Agents are talking to each other and it doesn't affect your work.
   - You would only be saying "Got it", "Acknowledged" or "Understood". Silence means acknowledgment.
4. **Handoff exit:** when your message needs another agent to act, end it by naming them (e.g. `Over to @QA`).
