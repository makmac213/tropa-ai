# Plan: connecting chat apps and other AIs to TropaAI

Status: **planned, not built.** Decisions below were agreed with the owner on 11 Nov 2026.

## Goal

Let people and AIs outside this computer work with a TropaAI team through the apps they already use, starting
with Discord, without opening TropaAI's own web address to the internet.

- Chat apps (Discord first; Telegram and Slack later) mirror each project room.
- Other agent harnesses (OpenClaw, Hermes, plain MCP or HTTP clients) join through the same API.
- TropaAI is single-user today; the design is ready for other humans and outside AIs later.

## Decisions

| | Decision |
|---|---|
| Who | The owner only for now; designed for invited humans and outside AIs later |
| Traffic | The whole room is mirrored, not only what's addressed to the owner |
| Layout | One Discord server; one channel per project |
| Threads | None: everything stays in the project channel (a TropaAI room is one ordered conversation with replies, so the channel mirrors it exactly). "A thread per task" can be an option later. |
| Approving permission prompts from Discord | Per person, off by default, can be switched on |
| First connector | Discord |

## What must stay true

1. Single-user use doesn't change: until Discord is linked or someone is invited, TropaAI behaves as today.
2. The local web app stays the control centre. Discord is the door for the owner on the go and, later, for others.
   TropaAI's own address stays private (see the security notes in the README).
3. Every action by a person is labelled (who, and through what) and checked against their role.
4. Approvals from Discord are per person and off by default.

## 1. Data model

| Table | Holds |
|---|---|
| `participants` | id, name, kind (`owner` / `human` / `ai`), disabled. Names share the agents' namespace, so every @mention means exactly one person or agent. |
| `links` | participant ↔ Discord user ID and handle, verified at |
| `roles` | participant, project (or `*`), role: `viewer` / `member` / `approver` / `admin` |
| `prefs` | per person: `approve_from_discord` (default false) |
| `connections` | Discord, and one per outside AI: token (stored hashed), allowed rooms and actions, config (server ID, channel per project), last seen, last error |
| `messages` + 2 columns | `participant_id` (who) and `via` (`web` / `discord` / `bridge` / `mcp`) |
| `discord_map` | room message ↔ Discord message, for replies, deletes and no duplicates |

Migration: today's `HUMAN_NAME` becomes the owner participant. Existing messages keep working unchanged.

Today's code assumes one human in 91 places, but most are wording in prompts to agents ("Maria is waiting on you").
About 15 are real permission checks (the 13 `sender_kind === 'human'` checks and the key gates); those move to `can()`.

## 2. One permission check

`can(who, action, room)` with actions `read`, `post`, `answer`, `approve`, `team` (restart, pass the lead, archive,
add or remove agents) and `settings` (owner only).

- Roles: Viewer reads; Member also posts and answers questions; Approver also presses permission prompts;
  Admin also changes the team. The owner has every role everywhere.
- The browser (the owner's cookie) is the owner.
- Discord: the linked person's role decides; `approve` also needs their own `approve_from_discord` on.
- Outside AIs: their connection's limits apply; never `approve` unless granted explicitly; Member at most by default.
- Wake routing: a message from any human counts as "from a human" (the lead picks it up when nobody is named).
- `ask_human` goes to the owner; later it can go to "the project's humans", first answer wins.

## 3. Bridge API v1

Used by the Discord connector and by outside AIs; each caller has its own scoped token.

- `GET /api/bridge/events?since=<cursor>`: a live stream (SSE) of messages, questions, approval prompts, task
  changes, agent status and project changes; resumes after a disconnect.
- `POST /api/bridge/rooms/:id/messages`: post as a participant, with `reply_to`, attachments and `via`.
- `POST /api/bridge/questions/:id/answer` and `POST /api/bridge/approvals`, both checked with `can()`.
- `GET /api/bridge/rooms`.
- The same calls as MCP tools at a separate human endpoint (`list_rooms`, `read_room`, `post`, `answer_question`,
  `approve`), so MCP-capable harnesses join without custom code. Confirm what OpenClaw and Hermes support before
  writing their guides.
- Tokens: stored hashed, revocable in Settings → Connections, limited to chosen rooms and actions.

## 4. Discord connector

Runs inside the TropaAI server as an optional module, isolated so a Discord outage can't affect the app.
It connects outward only (Discord's gateway over WebSocket, REST over HTTPS); nothing is exposed to the internet.
Use the `ws` package and `fetch` the server already has, keeping the dependency list small; switch to discord.js
only if our reconnect and rate-limit handling proves fragile.

Bot permissions: View Channels, Send Messages, Read Message History, Attach Files, Manage Channels,
Manage Webhooks; intent: Message Content.

### Setup (Settings → Connections → Discord, no terminal)

1. Create a Discord application (TropaAI links to the page) and turn on Message Content for the bot.
2. Paste the bot token.
3. TropaAI shows an invite link with exactly the permissions above; add the bot to your server.
4. Link your account: `/tropa link` (or a code TropaAI shows) in any channel; that account becomes the owner.
5. TropaAI creates a **TropaAI** category with one channel per project.

### Mirroring

| In TropaAI | In Discord |
|---|---|
| An agent's message | Posted by a per-agent webhook with the agent's name and an uploaded initials avatar (Discord can't load images from this computer). One webhook per agent per channel; beyond about 10 agents, extra agents share one with just a name. |
| The owner's message from the web | Posted by a webhook as the owner ("Maria · web") |
| A message typed in Discord by a linked person | Stays as typed; becomes a room message "via Discord"; never posted back |
| TropaAI's notes | Short bot messages |
| A question for a human | A message with answer buttons and "Answer in your own words" (a modal); edited to show the answer once answered |
| An approval prompt | Approve / Always / Deny buttons; a click works only with the Approver role and `approve_from_discord` on, otherwise a private "approvals from Discord are off for you" |
| Replies and 👍/👎 reactions | Kept both ways |
| Files | Both ways, up to the size limits |
| An @mention of a linked person | A real Discord ping (so phones notify) |
| New / archived / renamed project | Channel created / moved to "TropaAI archive" (and back) / renamed |
| Long messages | Split at 2,000 characters with code blocks kept whole; very long ones attached as a file |
| First connect | No history dump; starts from now (option: post the last 20 messages) |

Every approval made from Discord is noted in the room: "Approved by Ana · via Discord".

## 5. Failure cases

| Case | Handling |
|---|---|
| Discord down or slow | Queue up to 500 messages, then one "N messages skipped, open TropaAI" note |
| Rate limited (429) | Back off and retry; combine fast bursts into one post |
| Bot removed or token revoked | Connections shows the error and a Reconnect button |
| A project channel is deleted | Recreated on the next message |
| The same bot used by two TropaAI servers | Refused, using an instance ID stored in each channel's topic |
| An unlinked person posts | Ignored, with a one-time "ask the owner for access" note |
| A Discord message is edited | The room keeps the original (documented) |

## 6. Security

- Tokens stored hashed, revocable, limited per connection; only the owner changes Settings.
- Every message carries its `via` label; every approval from Discord is noted in the room.
- Approvals from Discord: per person, off by default.
- Text from Discord is untrusted input to agents, exactly like text from the web today.
- Outside AIs join as participants labelled as AI, Member at most, no approvals unless granted.
- Opening TropaAI to others goes through Discord's identity first. A public web login (TLS, accounts) is a separate,
  later decision.

## 7. Testing

- Unit tests for `can()` across every role and action.
- Bridge API tests, including that a token can't act beyond its limits or as someone else.
- The Discord connector against a fake Discord (local gateway and REST) in CI: posts, replies, buttons, approvals off
  and on, rate limits, reconnects, loop safety.
- A manual checklist on a real Discord server before release.

## 8. Order of work

| Step | What | Size |
|---|---|---|
| 1 | Participants, roles and `can()`; nothing visible changes | M |
| 2 | Bridge API, tokens, Settings → Connections (beta) | M |
| 3 | Discord connector and guided setup | L |
| 4 | Inviting people through Discord; roles per project in Settings | M |
| 5 | Guides for outside AIs (OpenClaw, Hermes, MCP, HTTP) | S |
| Later | Telegram and Slack on the same Bridge API; a public web login if ever needed | |
