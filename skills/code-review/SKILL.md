---
name: code-review
description: For the team lead. Review a developer's branch, then approve it for QA, request specific changes, or (after QA passes) merge it into the main branch and clean up the worktree. Use when a developer posts "ready for review" or QA reports PASS.
metadata:
  tropa-roles: "lead"
  tropa-managed: "true"
---

# Code review and merge (lead)

## Look at the change
```bash
git -C <root> log --oneline <base>..<branch>
git -C <root> diff --stat <base>...<branch>
git -C <root> diff <base>...<branch>
```
Run it if that's useful: `cd <root>/.worktrees/<dir>` and run the tests or start the app there.

## Checklist (in order of importance)
1. **Does it do the task**, matching the spec and the agreed contract (routes, payloads, errors)?
2. **Correctness:** edge cases, error handling, empty and invalid input, no leftover debug code.
3. **Tests:** new behaviour is tested, the suite passes, and tests check results rather than just calling code.
4. **Security (guardrails):** run `python3 <root>/.agent_sync/secret_scan.py --diff <base>...<branch>`. Input is validated and authorisation checked on the server, there's no injection (SQL, shell, HTML), and new dependencies are real, licensed and audited. Any failure is a *must-fix*.
5. **Scope:** no unrelated changes. Big refactors belong in their own task.
6. **Readability:** clear names, it fits the codebase's conventions, comments where the "why" isn't obvious.

## Respond (one message)
- **Changes needed:** `@<dev> changes for <branch>:`, then a numbered list. Each item says the file and line or function, what's wrong and what you expect. Separate *must-fix* from *nice-to-have*.
- **Approved:** `@QA please test branch <branch> in .worktrees/<dir> — focus on: <risky areas>`.

## Merge (only after QA says PASS)
```bash
git -C <root> switch <base>                       # the project root stays on <base>
git -C <root> merge --no-ff <branch> -m "Merge <branch>"
# run the tests on <base>
git -C <root> worktree remove .worktrees/<dir>
git -C <root> branch -d <branch>
```
- **Conflicts:** resolve trivial ones yourself. Otherwise `git merge --abort` and ask the developer to rebase onto `<base>`.
- **Announce it:** `@<human> merged <branch> into <base>` (or @mention whoever picks up next) plus the guardrails line from the developer's handoff (e.g. `guardrails: ✅ secrets · ✅ input/auth · ✅ deps · ✅ tests`). If other open branches touch the same area, tell their owners to rebase.
- Never force-push, reset `<base>` or push to a remote unless @human asks.
