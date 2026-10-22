# Skills

Default [Agent Skills](https://agentskills.io) that `tropa init` adds to every project. A skill is a folder containing a `SKILL.md` file, and an agent loads it only when the description matches what it's doing.

| Skill | For | What it teaches |
|---|---|---|
| [`team-handoff`](team-handoff/SKILL.md) | everyone | Handoffs and status messages that unblock the next person |
| [`task-planning`](task-planning/SKILL.md) | lead | Turning a spec into tasks, branches and an order of work |
| [`plan-flowchart`](plan-flowchart/SKILL.md) | lead | Setting card dependencies so the board's Flow tab and `docs/PLAN.md` show the plan: order, parallel work, critical path |
| [`worktree-dev`](worktree-dev/SKILL.md) | developers | The branch / worktree cycle from start to handoff |
| [`code-review`](code-review/SKILL.md) | lead | Reviewing a branch, then approving, requesting changes or merging |
| [`qa-testing`](qa-testing/SKILL.md) | QA | Test plans, testing a branch, bug reports, PASS / FAIL |
| [`guardrails`](guardrails/SKILL.md) | everyone | Secrets, input/auth, risky commands, dependencies, and the pre-handoff checklist |

## How they reach the agents

`tropa init` copies these folders into the project's **`.agents/skills/`**, the cross-tool location, and that folder is the single source:

- **Codex and OpenCode** read `.agents/skills/` themselves.
- **Claude Code and Qwen Code** get links in each agent's `agents/<name>/.claude/skills/` or `.qwen/skills/`. These are rebuilt every time the agent starts.

**`metadata.tropa-roles`** limits a skill to some roles: `lead`, `dev`, `qa`, or several, comma-separated. Leave it out and every agent gets the skill. Codex and OpenCode read the whole folder, so each description also says who the skill is for.

## Your own skills

- **For a project:** use **🧩 Skills** in the project's chat room (add, edit, import a `SKILL.md`, remove), or add a folder to its `.agents/skills/`. Every agent it's for gets it the next time it starts.
- **Who gets it:** `metadata.tropa-roles` takes roles (`lead`, `dev`, `qa`) and also agent names (`writer`).
- **For every project:** add the folder here in tropa's `skills/`.
- **Changing a default skill:** edit it in the project. `tropa update` only refreshes skills that still have their `.tropa-managed` file, so delete that file to keep your edits.

Format: YAML front matter with `name` (lowercase-hyphenated, same as the folder) and `description` (what it does and when to use it), followed by Markdown instructions. Keep them short and concrete.
