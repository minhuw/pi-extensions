# Canonical Herder Plan Template

Use the seven sections below, once each and in order. The A/V/T tables are authoritative structured facts; prose explains them without duplicating requirements or commands. A competent executor gets only the immutable compiled snapshot and assigned repository, not the interview, audit, or sibling files. Keep local content under 1,200 words and shared context under 1,600; there is no minimum.

## Local example

This is an **illustrative repository**, not evidence about the checkout being planned. Replace its paths, symbols, commit/date, decisions, scripts, and observations with verified facts. Here plan 001 has a separately confirmed adapter guarantee; plan 002 must not pretend that guarantee already exists at planning time.

```markdown
# Plan 002: Preserve empty order-list responses

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 001
- **Category**: bug
- **Planned at**: commit `a1b2c3d`, 2026-06-01
- **Kind**: behavioral
- **Parent objective**: Keep supported order-list clients working through the adapter change.

## Outcome and acceptance

Preserve the confirmed empty-list response. Binding decision: return an empty
array, not null; the public schema and authorization behavior stay unchanged.

| ID | Required behavior | Proof |
| --- | --- | --- |
| A1 | An authorized request for an account without orders returns HTTP 200 and `[]`. | V2 |

## Boundaries

**Write paths**
- `src/orders/api.ts`
- `src/orders/api.test.ts`

**Out of scope**
- Public schema, authorization policy, and legacy endpoint changes.

Review `listOrders`, its route caller, and the existing unauthorized-request
case; preserve nonempty response ordering and account isolation.

## Starting conditions

**Observed baseline**: At the planned commit, `listOrders` in
`src/orders/api.ts` forwards the store result. The tests cover nonempty and
unauthorized requests but not empty results. V1 was not run during planning;
these observations come from source inspection, not a passed-check claim.

**Required starting state**: The integrated adapter contract below is available;
the declared npm environment is prepared.

| Plan | Consumes |
| --- | --- |
| 001 | `readOrders` resolves to an array, including an empty array, and retains account filtering. |

**Expected dependency changes**: Plan 001 replaces the store adapter used by
`listOrders`. Recheck its guarantee, not old line offsets; that expected edit
is not unexpected drift.

## Implementation route

Suggested route: inspect `listOrders` and its route caller, add the empty-result
case alongside the existing account-isolation test, and preserve the adapter's
array at the HTTP boundary (A1; V1 for iteration, V2 for acceptance). The response
contract is binding; a particular helper or patch shape is not.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
| --- | --- | --- | --- | --- | --- |
| V1 | development | none | T1 | `npm run focused-test` | Establish baseline; after edits the empty, nonempty, and unauthorized cases pass. |
| V2 | acceptance | A1 | T1 | `npm run focused-test` | exit 0; empty results return 200 and `[]`; account isolation and ordering cases pass. |
| V3 | final | none | T1 | `npm test` | exit 0; integrated repository regression suite passes. |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | npm project scripts | . | Node >=22.19; locked dependencies installed | `node --version` | `package.json`; `package-lock.json`; AGENTS.md |

## Escalation and handoff

Stop for a dependency that can return null, unknown account-filtering semantics,
or a required public-schema change. Ask for authority rather than inventing it.
If T1 is unavailable or invoked incorrectly, report manager/command/cwd/error
and the prerequisite; do not repair source to compensate.

Provides: the empty-array HTTP invariant, independently accepted before any
consumer plan. Safe intermediate state: existing clients retain the same schema
with later migrations unfinished. Pagination remains deferred because it is a
separate product behavior.
```

If there are no dependencies, use `Depends on: none` in metadata and
`Dependencies: none.` under Starting conditions instead of the Plan/Consumes table.
Keep all three starting-condition labels, even when expected dependency changes
are `none`. Acceptance Proof and Verification Criteria use comma-separated IDs;
every A row has an acceptance-phase proof, even when it also has final evidence.
An explicit source-preserving inspection command with a concrete expected
observation is valid for semantic/manual acceptance; do not label it a test pass.

The example repeats one command only to distinguish its baseline and acceptance
uses. Do not duplicate commands per route step or add generic typecheck/full-suite
rows without a risk they cover. Final-only proof cannot defer acceptance to a
later plan. Toolchain probes establish availability, not behavioral acceptance.

## Optional shared `herder-plans/CONTEXT.md`

Use only when several plans reuse verified facts. Include the confirmed shared
objective/non-goals, concise repository facts/exemplars and accepted constraints.
A single shared toolchain table may use exactly:

```markdown
| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | npm project scripts | . | Node >=22.19; locked dependencies installed | `node --version` | `package.json`; `package-lock.json`; AGENTS.md |
```

When moving T1 here, remove its local definition: shared/local IDs cannot shadow,
even identically. Keep commands in V rows and setup in T prerequisites, not a
second shared-command list or executable config. `Cwd` may be a dependency-created
directory; distinguish that guarantee from observed baseline. Discover the
canonical invocation from scripts, pyproject/uv, Nix, CI, and instructions as
applicable, never merely from a binary on PATH. Do not assume uv/Nix is present or
silently install, sync, download, inject credentials, or inherit ambient HOME.
Existing final-manager npm-only locked preparation is separate: it temporarily
prepares missing node_modules for qualifying direct npm/npx gates and removes
what it created. It is not a universal preparer or agent setup authority; see the
format reference. Preparation failure is not check success.

Do not move local acceptance, write scope, dependency guarantees, or escalation
triggers into shared context. Any shared edit changes all affected snapshots.

## Index

After `herder_plan` `init`, edit the descriptive/index sections in place, not the
whole README. Keep provenance, dependency reasons, and considered/rejected choices
short. Use the [format reference](plan-format.md#index)'s exact index headers and
numeric IDs; preserve existing lifecycle and manager-owned runtime data. Generic
Git ownership belongs to role contracts, not plans or index checklists.

## Producer self-review — before validation

After writing, reread every authored local file from disk. Call `herder_plan`
`operation: "snapshot"` for every new/changed ID and cold-read the compiled
`planText` with no session or sibling context. Refresh all affected snapshots
when shared context changes. Check:

1. **Confirmed contract**: intent, binding A requirements, non-goals, preserved
   callers/invariants, and suggested route agree. No unresolved decision necessary
   to start has been disguised as a STOP condition.
2. **Source evidence**: verify paths, symbols, current facts, commit/date, test
   cases, conventions, toolchain owner/invocation/cwd/prerequisites, and cited
   manifests/lockfiles/CI. Record unrun checks as unrun; never expose secrets.
3. **Starting guarantees**: observed facts are distinct from dependency promises;
   every direct dependency has one specific Consumes row, matches the index, and
   leaves a valid intermediate state. Expected edits/shifted lines are not drift.
4. **Proof sufficiency**: A/V links resolve reciprocally, every A has acceptance
   proof, phases reflect actual completion order, and concrete commands/expected
   observations test the named behavior and failure modes. No redundant generic
   gates, fake test proof, or final-only prerequisite acceptance.
5. **Bounded execution**: exact write paths and direct contracts give reviewers a
   short evidence path; companions require semantic justification and review.
   Suggested patch directions do not become binding requirements. Split only at
   independently useful, safe boundaries—not tests/docs/layers for one invariant.
6. **Phase ownership**: Implementer probes/diagnoses before edits; Reviewer
   independently checks the frozen target; main session selects the final
   manifest and manager executes it. Parser/shape validation runs no plan commands
   and cannot prove semantic readiness; agent CHECKS is not authoritative gate evidence.

Repair only omissions supported by confirmed intent and verified evidence. Missing
product authority or material scope/approach choices return to clarification and
confirmation; a STOP condition is not a substitute. Respect active-Fire/request
capabilities over generic authoring steps.

Then call `shape`, resolve every issue and unordered overlap (`shapeReady=false`),
and call `validate`. Repeat snapshot and semantic self-review after any change.
