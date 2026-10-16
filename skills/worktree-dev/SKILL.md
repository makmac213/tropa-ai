---
name: worktree-dev
description: For developers. The git branch and worktree cycle used by TropaAI teams. Start a task branch (in its own worktree when several developers work at once), commit as yourself, rebase onto the main branch, resolve conflicts, and hand off for review. Use when starting, finishing or fixing up a coding task in a git project.
metadata:
  tropa-roles: "dev,qa"
  tropa-managed: "true"
---

# Branch and worktree cycle (developers)

Your `AGENT.md` lists the exact paths and the main branch (`<base>`, usually `main`). The project root is `<root>`.

## Start a task
```bash
git -C <root> fetch -q 2>/dev/null; git -C <root> worktree add .worktrees/<you>-<task> -b <you>/<task> <base>
cd <root>/.worktrees/<you>-<task>          # work ONLY here for this task
```
If you're the only developer, a branch is enough: `git -C <root> switch -c <you>/<task> <base>`.

- **"already exists":** the worktree or branch is left over from earlier. Reuse it if it's yours and still relevant: `git -C <root> worktree list`.
- **Dependencies:** install them in the worktree too (`npm install` and so on). Worktrees don't share `node_modules`.

## While working
- Keep to the files your task needs. If you have to touch a file another developer owns, say so in the room first.
- Run the tests before every commit.
- Commit small and often, as yourself:
  ```bash
  git add -A && git -c user.name="<you>" -c user.email="<you>@tropa.local" commit -m "Add login endpoint"
  ```
- Never commit secrets, `.env` files or build output. Check `git status` before you commit.

## Before handing off: bring your branch up to date
```bash
git rebase <base>          # inside your worktree; <base> moves forward as the lead merges
```
- **Conflicts:** fix the files, then `git add <file>` and `git rebase --continue`. If a conflict is about someone else's design, stop with `git rebase --abort` and ask the lead.
- Re-run the tests after rebasing.

## Hand off
Move your card first: `task_update` → `review` (or `blocked` with a note). When you start a task, set it to `doing`.
First run the `guardrails` checklist: `python3 <root>/.agent_sync/secret_scan.py --diff <base>...HEAD`, then lint, the tests and the dependency audit if you added packages.
Use the `team-handoff` format: `@lead ready for review: branch <you>/<task> (.worktrees/<you>-<task>)`, then what changed, how to check it, what's left, and the one-line guardrails check.

## After review or QA
Fix things on the **same branch**, commit, and reply `@lead updated <you>/<task>: <what changed>`. The lead merges and removes the worktree. Don't merge into `<base>`, push, force-push or delete branches yourself.
