# Ready-made teams

Each folder here is a team you can start a project with (**＋ New project → Team**). A team is just prompts:
add a folder and it shows up in the chat the next time the host helper checks in (within a few seconds), no code needed.

```
teams/
  seo/
    team.md              the team: name, summary, lead, member order, and how the team works
    seo-lead.md          one file per member: the file name is the agent's name (@seo-lead)
    keyword-researcher.md
    ...
```

## team.md

```markdown
---
name: SEO team
summary: Finds what people search for and makes your pages rank for it
lead: seo-lead
members: seo-lead, keyword-researcher, content-writer, on-page, site-auditor
---
How this team works (every member gets this text): who hands off to whom, what needs
{human}'s sign-off, rules everyone follows.
```

- `name`, `summary`: what the chat shows.
- `lead`: the member who gets the human's un-addressed messages and assigns the work.
- `members`: the order members are listed in (optional; default: the lead first, then alphabetical).
- `git: no` (optional): for teams that don't write code. The project then starts without git branches and worktrees (the New project form unticks it).
- The body is how the team works together. It's added to every member's job.

## A member file

```markdown
---
role: Keyword researcher: finds the searches worth ranking for
model: sonnet
---
The member's job description, in plain words: what they do, how they do it,
what "done" looks like, who they hand off to, what they never do.
```

- The file name (without `.md`) is the agent's name: letters, digits, `.`, `_` and `-`.
- `role`: one line, shown in the roster (TEAM.md) and the chat.
- `model` (optional): a model alias or id for the CLI, e.g. `sonnet`, `haiku`, `opus`. Empty means the CLI's default.
- `tool` (optional): the CLI, `claude` by default (`codex`, `opencode`, `qwen`, `gemini`).
- The body is the member's job. It's saved in the agent's `AGENT.md` under *Your job* and stays there for the whole project.

`{human}` in any text is replaced by your name in the chat.

## Your own teams

Put team folders in `~/.tropa/teams/` (same layout) to keep them out of the tropa install: they survive updates,
and a folder there with the same name as one here replaces it.
