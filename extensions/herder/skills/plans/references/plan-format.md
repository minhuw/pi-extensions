# Herder Plan Protocol

## 1. Truth and Ownership

Store plan truth at the repository root:

```text
herder-plans/
  README.md
  CONTEXT.md              # optional shared verified context
  001-short-imperative-slug.md
  002-another-plan.md
  leak/                   # optional judge-deferred findings awaiting user choice
  .herder/                 # ignored runtime artifacts; never plan truth
    execution.sqlite3      # manager-owned immutable attempt accounting
```

Do not require YAML execution configuration, another database, or `.herder/state.json`. The one manager-owned SQLite file records execution attempts and statistics only; README owns lifecycle and plan-graph truth, while Git refs/worktrees own completion and integration truth. Plans owns format, parsing, validation, and transitions; Grill and Improve produce the same format; Fire owns execution, branches, and worktrees. Plans must use the canonical Fire-assigned branch instruction and never name a concrete execution branch. Provenance must not alter what Fire receives or require hidden session context.

The zero-context invariant applies to the immutable snapshot Fire dispatches. A plan may remain file-self-contained, or a producer may put facts reused by multiple plans in `CONTEXT.md`. `snapshot` deterministically composes the exact shared context followed by the local plan and returns hashes for both inputs and the compiled text. A plan must never rely on a sibling plan file or conversation history. Dependency guarantees belong in its local `## Dependency contract`.

`leak/` contains non-executable findings that Judge found valid but outside the original task. They are never indexed, scheduled, or treated as accepted intent. Fire deduplicates them by recorded key; Grill or Improve must confirm, promote, number, and validate them before Fire can execute them.

Before manager validation, reread every draft and complete [plan-template.md](plan-template.md)'s semantic Producer self-review. Validation checks structure, graph integrity, and write-scope overlap; producers and Validate still own semantic evidence quality.

## 2. Index

`README.md` contains one plan table with these headers; extra columns are allowed:

```markdown
| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | Establish baseline | P1 | S | — | TODO |
| [002](002-second.md) | Refactor safely | P1 | M | 001 | TODO |
```

- Use unique numeric IDs and filenames padded to at least three digits.
- Link each Plan cell to its `NNN-*.md`, unless exactly one matching file makes the target unambiguous.
- Use numeric dependency IDs and `—` or `none` for no dependencies.
- Keep every numbered file indexed, every entry present, and index/file dependencies identical.
- Keep the dependency graph acyclic.

## 3. Plan File

Every plan follows the shared template and begins with:

```markdown
# Plan NNN: <imperative title>

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: herder-plans/NNN-*.md (or "none")
- **Category**: feature | bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>
- **Kind**: behavioral | mechanical | migration | spike
- **Parent objective**: <one durable outcome shared by this plan set>
```

Use [plan-template.md](plan-template.md) for all required evidence, decisions, dependency guarantees, scope, ordered work, tests, review map, done criteria, STOP conditions, and maintenance guidance. New producers always write the two shape fields above plus `## Dependency contract` and `## Review map`.

File count and line count must never stop, block, repair, reject, authorize, or otherwise shape a plan.

When terminology or architecture decisions change, schedule the relevant repository `CONTEXT.md`, `CONTEXT-MAP.md`, or ADR update in scope, steps, and done criteria; keep implementation details out of glossaries. Do not confuse a repository domain `CONTEXT.md` with `herder-plans/CONTEXT.md`, which is only shared snapshot input.

The executor receives the repository and the compiled snapshot, not the Grill interview, Improve audit, or sibling plan files. Inline every plan-local fact and durable decision; place only genuinely reused, verified facts in shared context.

## 4. Plan Shaping

Partition an objective into a dependency DAG before drafting prose. A normal subplan targets one independently verifiable invariant, one package or bounded subsystem, one focused verification command, and at most one public-contract or migration transition. File and line counts are descriptive only and never determine plan shape or reviewability.

Target 500–900 words and require at most 1,200 words in each local plan. Shared `CONTEXT.md` is capped at 1,600 words. The manager includes local line/word counts in `shape`, marks larger content shape-incomplete, and leaves legacy content readable with warnings. Compact plans state each fact once and include only evidence needed to locate, implement, and verify their bounded outcome.

Split when work contains multiple observable outcomes, independently releasable caller cohorts, ownership/package boundaries, more than one public transition, or no focused verification command. Every cut must leave integration valid. Prefer additive seams: characterize current behavior, add an adapter or expansion, migrate bounded caller groups, then remove compatibility code. Do not split by architectural layer when an intermediate layer cannot pass required gates.

`mechanical` plans name the deterministic transformation and a repository command that proves completeness. `migration` plans must be phased through backward-compatible states. `spike` plans produce evidence or a confirmed design and do not silently become implementation plans.

Two ready plans with the same machine-readable in-scope path must be ordered by dependency or reshaped. The manager reports unordered overlap. An implementation-discovered companion path may proceed only when it directly supports the original outcome, stays in the declared bounded subsystem, adds no unplanned public-contract or migration transition, and does not overlap an unordered live plan. The Implementer must justify each discovered path against a step or done criterion; Reviewer must accept it, and escalated rounds additionally require Judge acceptance. An explicitly out-of-scope path or a subsystem/transition boundary crossing is a STOP condition and requires split/replan before broad review. The number of changed or discovered paths is never a STOP condition.

## 5. Status

```text
TODO
IN PROGRESS
DONE
BLOCKED — <one-line reason>
REJECTED — <one-line rationale>
```

Allowed transitions:

```text
TODO → IN PROGRESS | BLOCKED | REJECTED
IN PROGRESS → TODO | DONE | BLOCKED | REJECTED
BLOCKED → TODO | IN PROGRESS | REJECTED
DONE → BLOCKED
REJECTED → TODO
```

Only the deterministic Run Manager writes status during Fire runs. It compiles dependencies and initial lifecycle into SQLite once; later README status cells are projections. Dependencies require both canonical `DONE` state and a plan-set-scoped private completion ref naming a reachable commit. `IN PROGRESS` belongs to an active manager run and `BLOCKED` needs explicit user direction.

## 6. Tracking and Worktrees

Default initialization adds `/herder-plans/` to `.git/info/exclude` without changing project `.gitignore`; tracking is opt-in. When tracked, ignore `.herder/` because runtime artifacts change frequently.

An ignored backlog is absent from new worktrees. Fire compiles every assignment into SQLite once and materializes the relevant immutable bundle in each plan worktree; never copy the whole backlog into execution branches.

## 7. Execution Accounting

The manager creates `.herder/execution.sqlite3` during initialization or the first accounting mutation. Only the deterministic Fire Run Manager writes runtime state and usage; workers return usage envelopes through the root. Read-only `usage` and `report` commands inspect the same database.

Record model, effort, outcome, and an idempotent attempt ID for every Implementer, Reviewer, Judge, and run-wide attempt. When known, also record round, generation, harness, service tier, timestamps, and duration. Copy only host telemetry; keep unavailable token fields `unknown` and never estimate. Input-plus-output subtotals do not add cached-input or reasoning details again, and incomplete coverage must remain visible.

`report <plan-id>` returns convergence, outcome, token-coverage, model/harness, and timing statistics for one plan; `report RUN` aggregates the plan set. The database stores compiled assignment text but never worker prompts, responses, transcripts, unrelated repository contents, or secrets. It is excluded from assignment bundles and Git tracking.
