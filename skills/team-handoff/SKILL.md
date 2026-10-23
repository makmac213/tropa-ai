---
name: team-handoff
description: Write handoffs, status updates and questions in the TropaAI project room that the next agent or the human can act on without asking back. Use whenever you finish a piece of work, hand it to someone, report a blocker, or ask the human for a decision. For every agent on the team.
metadata:
  tropa-managed: "true"
---

# Team handoff

The room is the team's memory. A good message lets the reader act **without opening your terminal or asking you anything**.

## Every handoff has five parts

1. **To whom**: start or end with the @mention of whoever must act next. A mention is an assignment; without one, nobody is woken.
2. **What**: one sentence on what you did or need.
3. **Where**: exact paths, the branch, and the worktree folder if there is one, e.g. `branch backend/api-auth (.worktrees/backend-api-auth)`.
4. **How to check it**: the command to run or the steps to verify, e.g. `npm test`, `curl -s localhost:3000/health`.
5. **What's left**: open issues, known gaps, or "nothing".

```
@lead ready for review: branch backend/api-auth (.worktrees/backend-api-auth)
- Adds POST /api/login and /api/logout with session cookies; passwords hashed with scrypt.
- Check: npm test (12 new tests) · curl -i -XPOST localhost:3000/api/login -d '{"email":"a@b.c","password":"x"}'
- Left: rate limiting (separate task), no UI yet.
```

## When there's nothing to do

- A @mention wakes that agent. Mention someone only when they have something to do or decide.
- **Don't reply to acknowledgements** ("thanks", "noted", "standing by"), and don't post just to say you're idle. Two agents acknowledging each other keep waking each other up.
- If a status helps the human, post it without a @mention, or put it in your next real update.

## Status and blockers

- **Blocked:** say what you tried and what you need, and @mention the one person who can unblock you.
- **Long tasks:** keep `set_status` current. Over ~10 minutes, also post a milestone with real content (`API done, 12/12 tests pass; starting the UI`), not just "still working".
- **Questions for the human:** use the `ask_human` tool: one concrete question, 2–3 options, which you recommend, and what you'll do if there's no answer in time. Example: question "Store sessions in SQLite or in memory?", options ["SQLite", "In memory"], recommended 1, if_no_answer "use SQLite", wait_minutes 30. It shows up in the human's "Waiting on you" list, and you're woken with the answer.

## Files

To show a mockup, screenshot, PDF or log, save it in the project and use the `share_file` tool with its path. Don't paste big files into the chat.

## Don't

- Post "OK", "Got it" or "Thanks". Silence means acknowledged.
- Paste secrets, tokens, `.env` contents or personal data.
- Write walls of text. If it needs more than ~15 lines, put the details in a file under `docs/` and link it.
