---
name: herder-plans
description: Initialize, shape, validate, inspect, snapshot, and report Herder Markdown plan graphs through Pi's native plan tool. Use when creating or repairing herder-plans/, checking dependencies and readiness, changing tracking policy, or inspecting execution statistics.
---

# Herder Plans

Read [references/plan-format.md](references/plan-format.md) and [references/plan-template.md](references/plan-template.md) before authoring or repairing plans. Use `herder_plan` for every plan operation; never invoke a bundled script or open the runtime database directly.

Pi exposes deterministic operations through `/herder-plans <operation>` and the native `herder_plan` tool. Use `/herder-grill` for new product intent and `/herder-validate --fix` for semantic plan repair.

- `init`: create the plan index and tracking policy.
- `shape`: report derived contract structure, size, and unordered write-path overlaps (`shapeReady=false` for equal unordered paths); it cannot prove semantic readiness.
- `validate`: parse the complete graph and fail on malformed plans, cycles, dependency disagreement, or unsafe overlap.
- `status` and `ready`: inspect lifecycle and dependency readiness.
- `snapshot`: compile one immutable shared-context-plus-plan assignment.
- `report`: read durable per-plan or full-run attempts, usage, timing, and outcomes.
- `track` and `untrack`: change only the plan-directory tracking policy.

Default to `<repository>/herder-plans`. Keep a single manager-owned `.herder/execution.sqlite3`. SQLite is runtime authority, README lifecycle is its human-readable projection, and Git refs/worktrees are execution proof.

Create focused, independently verifiable nodes in the breaking seven-section Plan V2 format: Status; Outcome and acceptance; Boundaries; Starting conditions; Implementation route; Verification; Escalation and handoff. No old-format fallback. A rows bind behavior to V proof; each A needs acceptance-phase evidence. V rows distinguish development, acceptance, and final checks and reference one T toolchain. Shared/local T IDs must not shadow. Discover canonical invocations from repository scripts, pyproject/uv, Nix, CI, and instructions—not binary presence. Separate setup prerequisites from checks, observed baseline from dependency starting guarantees, and binding decisions from suggested route.

Use `CONTEXT.md` only for genuinely shared verified facts/toolchains. Resolve material uncertainty before writing. Cold-read every affected compiled snapshot and perform the template's semantic Producer self-review, then run `shape` and `validate`. Plans stay concise (local ≤1,200 words; shared ≤1,600, no minimum), without generic Git/test/review boilerplate or per-step command repetition. Keep tests/docs with the same invariant unless a separately useful prerequisite warrants a node.

The derived PlanContract is inspectable, but immutable `planText` remains execution authority. The parser never executes V commands or converts them to final argv. Implementers perform pre-edit canonical probes and baseline diagnosis; Reviewers independently rerun appropriate source-preserving checks; main-session-selected final manifests alone become manager-executed authoritative gate evidence. No automatic manager per-plan preflight/gate phase exists.

File and line counts never determine scope or completion. A discovered companion path is valid only when necessary for the same bounded subsystem and accepted by review. Split or revise for semantic boundary violations, not numeric path counts.

During Fire, only the deterministic manager changes lifecycle or accounting. Producers and workers never call status-transition or usage-recording internals. Generic authoring never overrides active-Fire reservations, immutable assignments, or request-bound recovery capabilities; obtain the confirmed target-local authority before edits.
