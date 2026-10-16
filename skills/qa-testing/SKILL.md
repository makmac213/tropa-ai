---
name: qa-testing
description: For QA. Plan and run tests for a branch the lead hands over (inside its worktree), write bug reports a developer can reproduce in one go, and report PASS or FAIL in the room. Also for adding automated tests on your own branch. Use when asked to test a branch, verify a fix, or improve test coverage.
metadata:
  tropa-roles: "qa"
  tropa-managed: "true"
---

# QA testing

## Before testing
- Read the task: the plan message, the spec section and the developer's handoff (what changed, how to check it).
- Write a short test plan for yourself, covering:
  - the **happy path**
  - **edge cases**: empty, long, duplicate, unicode, and boundaries like 0, 1 and max
  - **errors**: invalid input, missing fields, unauthorised, not found
  - **regressions**: the features this change could break
  - **abuse** (guardrails): another user's record by id (should get 403/404), script or HTML in text fields, oversized input and uploads, repeated login attempts, missing or expired session

## Test the branch where it lives
```bash
cd <root>/.worktrees/<dir>        # the worktree the lead named (single developer: the branch in the project root)
# install dependencies if needed, run the automated tests, then exercise the app (curl, the UI, the CLI)
```
Don't fix application code yourself. You test and report.
- **Servers:** start them in the background (`npm run dev > /tmp/web.log 2>&1 &`), wait for the port (`until curl -s localhost:3000 >/dev/null; do sleep 1; done`), test, then stop them (`kill %1`). Never end your turn just because a server is running.
- **The board:** on FAIL move the task back to `doing` (`task_update`). On PASS leave it for the lead, who merges and marks it `done`.
- **Always finish with the report below.** If you stop without posting PASS or FAIL, the team waits on you.

## Report: one message to the lead
**PASS:**
```
@lead PASS: branch <branch> — tested: login ok/bad password/empty fields/locked user; npm test 48/48.
guardrails: ✅ secrets (secret_scan --diff clean) · ✅ other user's data 404 · ✅ npm audit: 0 high/critical
```
**FAIL** (also mention the developer):
```
@lead FAIL: branch <branch> — @<dev> 2 issues:
1. POST /api/login with empty password returns 500 (expected 400 {error}).
   Steps: curl -i -XPOST localhost:3000/api/login -H 'content-type: application/json' -d '{"email":"a@b.c","password":""}'
2. Minor: error text says "Unauthorised" vs spec "Invalid email or password".
```
Each bug gives: **steps** (copy-pasteable), **expected**, **actual**, and how bad it is (blocker, major or minor).

## Writing tests
New or better tests are code: put them on your own branch (`qa/<task>`, in your own worktree when several people are working). Hand them to the lead for review like a developer would. Prefer tests that would have caught the bugs you found.
