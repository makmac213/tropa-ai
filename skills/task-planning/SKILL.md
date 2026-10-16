---
name: task-planning
description: For the team lead. Turn a spec or a request from the human into small tasks with owners, branch names and an order of work that lets developers work in parallel without editing the same files. Use when a new spec, feature or batch of bugs arrives, or when the plan needs re-cutting.
metadata:
  tropa-roles: "lead"
  tropa-managed: "true"
---

# Task planning (lead)

## 1. Read before you plan
- Read `docs/SPEC.md` (or `docs/BRIEF.md`) and every file in `docs/attachments/`.
- In an existing codebase, skim the structure first: README, package/requirements files, the main folders and how tests run.
- If something that changes the design is unclear, ask **@human** first, in one message, with numbered questions and your recommended answer for each. Make small decisions yourself and say so.

## 2. Cut the work
- One task is one reviewable change: ideally under ~300 changed lines, done in under an hour.
- Name each task with a short slug (`api-auth`, `todo-list-ui`). The branch is `<owner>/<slug>`.
- **Agree contracts first.** If frontend and backend depend on each other, post the API contract (routes, payloads, status codes and errors) before anyone starts, so they can build in parallel.
- **Avoid collisions:** two developers shouldn't edit the same files at the same time. When they must (for example, a shared config file), order the tasks or give that file to one owner.
- Include tests in each task. Hand QA a task to write or extend tests once there's something to test.

## 3. Post the plan (one message)
```
Plan for <feature>:
1. @backend api-auth → branch backend/api-auth: POST /api/login, /api/logout (+ tests)
2. @frontend login-ui → branch frontend/login-ui: login form against the contract below (after 1's contract, not its code)
3. @QA after 1+2 merge: end-to-end login tests
Contract: POST /api/login {email,password} → 200 {user} | 401 {error}
Order: 1 and 2 in parallel; 3 after both merge. I review each branch, QA tests it, I merge.
```
Before posting, put each task on the board with `task_add` (title, assignee, branch, a **description**: what to build, the acceptance criteria, the contract and files involved, in a few Markdown bullets) and **its dependencies**: `depends_on` for cards it can only start after they're merged, `contract_from` for cards whose agreed contract is enough to start in parallel. Add cards in order so the ids exist, and write each id in the plan (`#12 @backend api-auth …`). The human follows progress there. Move cards to `qa` when you send a branch to QA, and to `done` after you merge: that wakes the owners of the cards it unblocks.

The board draws the plan as a flowchart (the `plan-flowchart` skill).

## 4. Keep it moving
- Track who is on what. When someone goes quiet for a long time, check their status, and wake them from the Team view if needed.
- When the human's request changes, re-cut the plan and post it, and update the cards' dependencies with `task_update`. Don't silently reassign.
- When everything under "Done means" in the spec is met, report to @human: what was built, how to run it, and what's left.
