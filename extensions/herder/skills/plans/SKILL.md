---
name: herder-plans
description: Initialize, shape, validate, inspect, snapshot, and report Herder Markdown plan graphs through Pi's native plan tool. Use when creating or repairing herder-plans/, checking dependencies and readiness, changing tracking policy, or inspecting execution statistics.
---

# Herder Plans

Read [references/plan-format.md](references/plan-format.md) and [references/plan-template.md](references/plan-template.md) before authoring or repairing plans. Use `herder_plan` for every plan operation; never invoke a bundled script or open the runtime database directly.

Pi exposes deterministic operations through `/herder-plans <operation>` and makes this guidance available to the model as `/skill:herder-plans`. Use `/herder-grill` for new product intent and `/herder-validate --fix` for semantic plan repair.

- `init`: create the plan index and tracking policy.
- `shape`: report semantic shape, size, and unordered write-scope overlaps.
- `validate`: parse the complete graph and fail on malformed plans, cycles, dependency disagreement, or unsafe overlap.
- `status` and `ready`: inspect lifecycle and dependency readiness.
- `snapshot`: compile one immutable shared-context-plus-plan assignment.
- `report`: read durable per-plan or full-run attempts, usage, timing, and outcomes.
- `track` and `untrack`: change only the plan-directory tracking policy.

Default to `<repository>/herder-plans`. Keep a single manager-owned `.herder/execution.sqlite3`. SQLite is runtime authority, README lifecycle is its human-readable projection, and Git refs/worktrees are execution proof.

Create focused, independently verifiable nodes. Each plan declares its kind, parent objective, dependency contract, review map, exact semantic boundary, commands, checks, and STOP conditions. Use `CONTEXT.md` only for verified facts genuinely shared by multiple plans. Reread saved plans, then run both `shape` and `validate`.

File and line counts never determine scope or completion. A discovered companion path is valid only when necessary for the same bounded subsystem and accepted by review. Split or revise for semantic boundary violations, not numeric path counts.

During Fire, only the deterministic manager changes lifecycle or accounting. Producers and workers never call status-transition or usage-recording internals.
