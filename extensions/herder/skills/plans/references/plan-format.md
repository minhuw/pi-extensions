# Herder Plan Protocol

## Truth and ownership

Store plan truth at the repository root:

```text
herder-plans/
  README.md
  CONTEXT.md               # optional shared verified context/toolchains
  001-short-imperative-slug.md
  002-another-plan.md
  leak/                    # non-executable Judge-deferred findings
  .herder/                 # ignored manager-owned runtime artifacts
    execution.sqlite3
```

README owns the authored graph; manager-owned SQLite owns live lifecycle and immutable attempt accounting; Git refs/worktrees own completion and integration truth. Use `herder_plan`, never a second parser, hand-maintained executable YAML/JSON, or direct database access. Grill, Improve, and Simplify produce this same **breaking Plan V2 format**. Old headings and legacy-format fallback are not supported; there is no format migration machinery.

The immutable compiled `planText` is execution authority. `snapshot` composes the exact optional shared context followed by the local plan and hashes both inputs and the compiled text. Parsed facts are an inspectable, derived `PlanContract` on plan records, snapshots, and shape output, not another source of truth. Executors receive no conversation or sibling-plan context. Local dependency guarantees must be explicit.

`leak/` findings are never indexed or scheduled. Producers must confirm, promote, number, and validate them before execution. Do not treat deferred findings as accepted intent.

## Index

README contains one table with these required headers; extra columns are allowed:

```markdown
| Plan | Title | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-establish-contract.md) | Establish contract | P1 | S | none | TODO |
| [002](002-consume-contract.md) | Consume contract | P1 | M | 001 | TODO |
```

Use unique numeric IDs, filenames padded to at least three digits, and explicit links unless exactly one numbered file makes the target unambiguous. Index every numbered file. Index/file dependency IDs must agree; dependencies are numeric IDs or `none` (`—` is also allowed in the index). The graph must be acyclic.

## Local contract

Each local plan has exactly these seven required, unique, nonempty level-2 sections, in order:

1. `Status`
2. `Outcome and acceptance`
3. `Boundaries`
4. `Starting conditions`
5. `Implementation route`
6. `Verification`
7. `Escalation and handoff`

Use [plan-template.md](plan-template.md). No extra legacy headings, branch boilerplate, per-step command duplication, or repeated generic Git/test/review checklists. Keep local plans at most **1,200 words** and shared context at most **1,600 words**; aim concise, with no minimum. File and line counts do not determine semantic scope, repair authority, or completion.

### Status

Required metadata:

- **Priority**: P1 / P2 / P3
- **Effort**: S / M / L
- **Risk**: LOW / MED / HIGH
- **Depends on**: comma-separated numeric IDs, or none
- **Category**: feature / bug / security / perf / tests / tech-debt / migration / dx / docs / direction
- **Planned at**: repository commit and date evidence
- **Kind**: behavioral / mechanical / migration / spike
- **Parent objective**: nonempty durable objective

### Outcome and acceptance

State intent and binding accepted decisions, then exactly one acceptance table:

```markdown
| ID | Required behavior | Proof |
| --- | --- | --- |
| A1 | One observable behavior | V1 |
```

IDs match `A[1-9][0-9]*`, are unique per plan, and number at most 64. Behavior is nonempty. Proof is one or more comma-separated V IDs without duplicates. Every criterion needs at least one **acceptance-phase** proof: a final-only check cannot gate prerequisite completion. Every proof resolves and its Verification Criteria refers back. A manual semantic judgment needs an explicit source-preserving inspection command and concrete expected observation, not a fake automated-test proof.

### Boundaries

Use **Write paths**, followed by backticked exact repository-relative file paths. **Out of scope** ends that list. Reject absolute paths, traversal, and ambiguous globs. Declare preserved invariants, direct callers/contracts, and the bounded review surface here, once.

Semantic scope governs companion paths, not counts. A discovered companion requires direct necessity for the same outcome and bounded subsystem, no unplanned public-contract/migration transition or unordered live overlap, Implementer justification linked to an A ID or route item, Reviewer acceptance, and Judge acceptance in escalated rounds. Explicit exclusions or subsystem/transition crossings require stop/replan before editing.

### Starting conditions

Separate **Observed baseline** (verified source facts at the planned commit, including honest check results or not-run limits), **Required starting state** (execution-time assumptions), and **Expected dependency changes** (anticipated upstream edits, not present-tense observations).

For direct dependencies include exactly one row per declared ID with a specific nonempty guarantee:

```markdown
| Plan | Consumes |
| --- | --- |
| 001 | The integrated adapter accepts the existing response schema without caller changes. |
```

With no dependencies write `Dependencies: none.` Consumes is an execution-time guarantee, not a claim that future code already exists. Stop for invalidated assumptions, not shifted lines or expected dependency changes. The downstream provided invariant and safe intermediate state belong in handoff.

### Implementation route

Give a short, specific **suggested** route linked to A/V IDs and exact file/symbol anchors. Clearly label binding design constraints rather than turning incidental patch suggestions into requirements. Include necessary terminology/ADR obligations in scope and acceptance; repository domain `CONTEXT.md` is distinct from plan-set shared context. Do not hide implementation details in glossaries.

### Verification

Exactly one verification table:

```markdown
| ID | Phase | Criteria | Toolchain | Command | Expected |
| --- | --- | --- | --- | --- | --- |
| V1 | acceptance | A1 | T1 | `npm run focused-test` | exit 0; named behavior tests pass |
```

V IDs match `V[1-9][0-9]*`, are unique, and number at most 64. Phase is `development`, `acceptance`, or `final`. Criteria is comma-separated A IDs without duplicates, or `none` for non-criterion diagnostics/regression gates. Toolchain is exactly one defined T ID. Command and Expected are nonempty. Reject dangling or duplicate references, nonreciprocal A.Proof → V.Criteria links, missing acceptance proof, unknown phases, and unknown toolchains.

- **development**: baseline diagnosis and focused iteration feedback; not a substitute for acceptance.
- **acceptance**: required evidence for this plan to complete before dependents start.
- **final**: aggregate integrated-tree checks considered by the main session when selecting the separate authoritative manifest.

Command text is descriptive evidence/instruction: the parser never executes it or scrapes it into final gate argv. Implementers perform pre-edit probes and baseline diagnosis; Reviewers independently rerun appropriate source-preserving acceptance checks. The manager does **not** automatically execute per-plan gates or add a preflight worker. Only the later request-bound final manifest is manager-executed authoritative verification. Agent `CHECKS` retains self-report provenance, never runtime authority.

Define toolchains locally in Verification and/or once in optional shared `CONTEXT.md`, using this exact table header:

```markdown
| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | npm project scripts | . | Node >=22.19; locked dependencies installed | `node --version` | `package.json`; `package-lock.json`; AGENTS.md |
```

T IDs match `T[1-9][0-9]*` and are unique across combined shared/local definitions; even identical shadowing is invalid. Cwd is `.` or a clean repository-relative directory, which may be created by a dependency. Owner names the repository-declared manager/framework, not merely a binary. Evidence cites repository manifests, lockfiles, CI, or instructions. Probe is a **non-mutating** availability/version invocation through that canonical environment when applicable, not `which` or `command -v`.

Discover invocations from package scripts, `pyproject.toml`, `uv.lock`, Nix declarations/locks, and CI/instructions as applicable. A declared uv project may require `uv run --no-sync ...`; a Nix project may require its declared `nix develop ... --command ...` environment. Verify the actual repository invocation and prepared environment; do not assume either ecosystem or silently realize/download missing prerequisites. Record setup separately in Prerequisites. Agents must not perform ad hoc/global installs, opportunistic `uvx`/`npx` downloads, unpinned substitutes, credential injection, or ambient HOME workarounds. Existing final GitDriver preparation is a separate bounded exception: direct npm/npx gates with declared dependencies, no node_modules, and an npm lockfile get temporary `npm ci --ignore-scripts --no-audit --no-fund`, then created modules are removed. This npm-only locked preparation is not new, universal, or worker setup authority; prerequisite failure can precede check evidence. This is explicit evidence-backed invocation, not a toolchain auto-detection framework. Do not duplicate shared toolchain tables or maintain a separate executable config.

### Escalation and handoff

State plan-specific stop/decision triggers, the downstream invariant provided, safe intermediate state, and meaningful deferred work. Resolve uncertainty necessary to start **before writing**, not with a generic STOP escape hatch. Environment/invocation/setup failures are not code findings: report the exact manager, command, cwd, error, and missing prerequisite; do not guess a repair or broaden scope. Missing product authority routes to a decision. Never invent passed checks or infer runtime authority from `CHECKS`. Worker ENVIRONMENT/INVOCATION blockers use same-round operator attention, not automatic code repair. In final recovery, wrong invocation is `manifest_error`, proven prerequisite absence is non-mutating `environment`. Gate outcomes (`passed`, `command_failed`, `unavailable`, `timed_out`, `runner_error`) and error/timedOut/signal are process evidence only: a started uv/Nix wrapper missing a nested tool can be `command_failed`; exit 127 or log text alone never diagnoses a source defect.

## Shaping and semantic readiness

Allocate monotonic IDs and graph edges centrally before prose; only the root producer writes the graph. Prefer independently verifiable behavioral slices. Split genuinely independent outcomes, ownership boundaries, caller cohorts, or public transitions at safe integration points; do not split by layer or create standalone tests/docs plans for the same invariant. Keep characterization and documentation with their bounded change unless an independently useful, gate-passing prerequisite justifies a separate node.

Mechanical work names its deterministic transformation and completeness proof. Migrations preserve valid intermediate states under the confirmed compatibility policy. A confirmed spike produces evidence/design, never silently implementation; Improve and Simplify resolve investigation in-session instead of producing spikes.

Two unordered plans with equal declared write paths make `shapeReady=false`; the existing overlap report remains visible. Order them by dependency or reshape; overlap is not a harmless warning. Size/structural validity cannot prove semantic readiness. Before `shape` and `validate`, cold-read compiled snapshots, verify sources, A/V/T sufficiency, toolchain evidence, starting guarantees, scope, and confirmed intent using the template's Producer self-review. Repeat after every local/shared edit.

## Lifecycle, tracking, and accounting

Authored statuses are `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED — reason`, and `REJECTED — rationale`. Allowed transitions remain:

```text
TODO → IN PROGRESS | BLOCKED | REJECTED
IN PROGRESS → TODO | DONE | BLOCKED | REJECTED
BLOCKED → TODO | IN PROGRESS | REJECTED
DONE → BLOCKED
REJECTED → TODO
```

The manager compiles initial lifecycle once and never rewrites README Status during a run. A terminal snapshot is optional after complete/failed/stopped. Dependencies require canonical `DONE` plus a plan-set-scoped private completion ref naming a reachable commit. `IN PROGRESS` belongs to an active run; `BLOCKED` needs explicit direction. Respect all active-Fire reservations and request-bound recovery restrictions; structural validity is not edit authority.

Initialization defaults to `/herder-plans/` in `.git/info/exclude`, without changing project `.gitignore`; tracking is opt-in and must ignore `.herder/`. Ignored backlogs are absent from new worktrees. Fire compiles assignments once into SQLite and materializes only the relevant immutable bundle; never copy the backlog into execution branches. Branch/worktree, commit, and review ownership live in package role contracts, not repeated plan prose.

Only the manager writes runtime state and usage. `report <plan-id>` and `report RUN` inspect durable convergence, outcomes, timing, models, and token coverage. Record idempotent attempts and available host telemetry; unknown fields remain unknown, never estimates. Input-plus-output subtotals do not double-count cached-input or reasoning details. The database stores compiled assignments, not worker prompts/responses/transcripts, unrelated repository contents, or secrets; it is excluded from assignment bundles and Git tracking.
