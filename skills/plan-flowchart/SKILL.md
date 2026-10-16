---
name: plan-flowchart
description: For the team lead. Make the plan's flowchart right: the task board draws it from each card's dependencies (Tasks → Flow, and docs/PLAN.md kept up to date by the watcher). Use right after posting a plan, whenever the plan is re-cut, or when the human asks for the flowchart.
metadata:
  tropa-roles: "lead"
  tropa-managed: "true"
---

# Plan flowchart (lead)

The human reads the plan as a picture: which tasks run in parallel, what waits for what, who owns each box, and the critical path (the longest chain still to do). TropaAI draws it **from the task board**, so your job is to get the dependencies right, not to draw.

- In the monitor: **Tasks → Flow**.
- As a file: **`docs/PLAN.md`** (Mermaid), rewritten by the watcher a few seconds after any card changes. GitHub, VS Code and the 📄 Docs view show it as a diagram.

## 1. Set the dependencies when you add cards
- `task_add` with `depends_on: [ids]` for cards that can only start once those are **merged** (done).
- `contract_from: [ids]` for cards that only need the other card's **agreed contract** (routes, payloads, errors): they can start as soon as that card has started. Post the contract in the room first.
- Add cards in order, so the ids you depend on exist. A loop is refused.
- Change them later with `task_update` (`depends_on` / `contract_from` replace the list; `[]` clears it).

## 2. Check the picture
After posting the plan, run `task_list`: each card shows `waits for #…` and `unblocks #…`, and ready cards show `[ready]`. Check that:
- every card that can start now is **ready**, and the rest wait for the right cards;
- two developers aren't waiting on each other (that's a loop: split a card or add a contract card);
- the chain to the finish is as short as it can be. If one agent owns most of the critical path, rebalance.

## 3. Share it
Post one line with the plan, e.g. `Flowchart: Tasks → Flow, or docs/PLAN.md (#12–#16, 2 in parallel, QA after both merge).` If the project uses git, commit `docs/PLAN.md` with your next merge on the main branch. Don't paste Mermaid into the chat.

## When the file is yours
`docs/PLAN.md` starts with a `tropa:auto-plan` comment line. Delete that line and the watcher leaves the file alone (for a hand-drawn chart). `auto_plan: false` in `.agent_sync/settings.json` turns the file off; the Flow tab still works.
