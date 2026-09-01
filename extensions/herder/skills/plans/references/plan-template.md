# Canonical Herder Plan Template

Every compiled plan snapshot is written for an executor model that has **zero context**: it has not seen the Grill interview, an Improve or Simplify audit, sibling plans, or prior conversation. It may be a smaller/cheaper model. Assume it is competent at following explicit instructions and weak at filling gaps, recovering from ambiguity, or knowing when to stop. A snapshot may compose an optional plan-set `CONTEXT.md` before the local plan, but the local plan must still state its own outcome, dependency guarantees, boundaries, and proof.

Four properties make a plan executable by a weaker model:

1. **Self-contained context** — everything needed is in the file: paths, code excerpts, conventions, commands.
2. **Verification gates** — every step ends with a command and its expected result. The executor never has to *judge* whether it succeeded.
3. **Hard boundaries and escape hatches** — explicit out-of-scope list, and "STOP and report" conditions instead of letting the model improvise when reality doesn't match the plan.
4. **Bounded review surface** — one independently verifiable invariant, explicit semantic boundaries, and an exact review map.

File naming: `herder-plans/NNN-short-slug.md`, numbered in recommended execution order.

Shape an objective before drafting. Prefer a dependency DAG of focused behavioral slices over one large plan or layer-by-layer fragments. A normal plan targets one bounded subsystem, one focused verification command, and at most one public-contract transition. Split multiple outcomes or transitions through valid intermediate states such as characterization tests, additive seams, bounded caller migrations, and compatibility cleanup. File and line counts are never scope or reviewability criteria.

Compactness is part of executability. Target 500–900 words per local plan and never exceed 1,200; the manager reports the count and marks larger plans shape-incomplete. State each fact once, prefer dense bullets/tables, and do not repeat acceptance language across decisions, steps, test plan, review map, and done criteria. Inline only the evidence needed to locate and verify the change. Shared `CONTEXT.md` must stay at or below 1,600 words.

---

## Template

```markdown
# Plan NNN: <Imperative title — what will be true after this plan>

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Never edit `herder-plans/README.md` during a
> Herder run; live lifecycle lives in SQLite and only a terminal snapshot
> may update README status rows.
>
> **Drift check (run first)**: `git diff --stat <planned-at SHA>..HEAD -- <in-scope paths>`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: herder-plans/NNN-*.md (or "none")
- **Category**: feature | bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>
- **Kind**: behavioral | mechanical | migration | spike
- **Parent objective**: <the durable plan-set outcome this subplan advances>

## Why this matters

1–3 sentences. State the requested or discovered outcome, its concrete value,
and what improves when this lands. Written so the executor (and a human
reviewer) understands the intent — intent is what lets a correct judgment call
happen when a detail is off.

### Accepted decisions

- The behavior, terminology, and trade-offs confirmed during Grill or selected
  from verified Improve or Simplify findings.
- Explicit non-goals and rejected alternatives that constrain implementation.
- Omit conversation history; state only the durable decisions and their reasons.

## Current state

The facts the executor needs, inlined — never "as discussed" or "see audit":

- The relevant files, each with one line on its role:
  - `src/orders/api.ts` — order-list endpoint; contains the N+1 (lines 130–160)
- Short code excerpts only when the exact current shape is load-bearing or
  ambiguous. Otherwise name the file, symbol, and verified fact in one bullet.
- The repo conventions that apply here, with a pointer to one exemplar file:
  "Error handling follows the Result pattern — see `src/lib/result.ts` and its
  use in `src/users/api.ts:40-60`. Match it."
- Any documented vocabulary or design constraints the plan must honor, inlined
  from the intent/design docs found in recon: the relevant `CONTEXT.md` terms
  the executor should use in names and comments, the `DESIGN.md` tokens/components
  to reuse, or the ADR whose decision this work must stay consistent with. Quote
  the specific lines — the executor has not read those docs.
- Any accepted glossary or architecture changes this work must record. Name the
  target `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` file and describe the
  intended content without relying on the planning session.

## Commands you will need

| Purpose | Command (cwd) | Expected on success |
|---------|---------------|---------------------|
| Install | `npm ci` (repo root) | exit 0 |
| Typecheck | `npm run typecheck` (repo root) | exit 0, no errors |
| Full Herder suite | `npm run test:herder` (repo root) | all pass |
| Focused tests | `npm run test:herder -- extensions/herder/tests/unit/<area>.test.ts` (repo root) | all pass |

(Exact commands from this repo — verified during recon, not guessed.)

## Dependency contract

- **Consumes**: the exact behavior or artifact guaranteed by each dependency,
  or "none". Never say only "plan NNN"; the executor does not read siblings.
- **Provides**: the independently testable invariant this plan leaves on
  integration for later plans.
- **Safe intermediate state**: why all required gates can pass after this plan
  even when later sibling plans are unfinished.

## Suggested executor toolkit

(Optional — include only when relevant skills/tools plausibly exist in the
executor's environment. Skip the section otherwise.)

- Skills the executor should invoke if available, and for what:
  "use `vercel-react-best-practices` when writing the memoization in step 3".
- Reference docs worth reading before starting, by path or URL.

## Scope

**In scope** (declared write paths):
- `src/orders/api.ts`
- `src/orders/api.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/orders/legacy-api.ts` — deprecated path, scheduled for deletion;
  changing it wastes effort and risks the v1 clients still pinned to it.
- Any change to the public response shape — clients depend on it.
- Every explicit product or implementation non-goal accepted during planning.

## Git workflow

(Commit style is filled from recon; branch and worktree ownership are fixed by Fire.)

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Commit per step or per logical unit; message style: <match repo, e.g. conventional commits — include an example from `git log`>
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: <imperative title>

What to do, precisely, in 2–5 bullets. Reference exact files/symbols. Include
the target code shape only when it is load-bearing; never prescribe incidental
line-by-line implementation.

**Verify**: `<command>` → <expected output>

### Step 2: ...

(Each step small enough to verify independently. Order steps so the codebase
is never broken between steps when possible — e.g. add new path, switch
callers, then remove old path.)

When accepted terminology or architectural constraints changed, include the
corresponding `CONTEXT.md` or ADR update as an ordered, verifiable step. Keep
domain glossaries free of implementation detail.

## Test plan

- In 3–6 bullets, name new tests, their file, and cases (list them:
  happy path, the specific bug/regression this plan fixes, named edge cases).
- Which existing test to use as the structural pattern:
  "model after `src/users/api.test.ts`".
- Verification: `<test command>` → all pass, including N new tests.

## Review map

Give the reviewer the shortest evidence path:

- **Outcome**: one observable behavior or invariant.
- **Modified symbols**: exact production symbols and configuration keys.
- **Direct contracts**: callers, interfaces, schemas, or invariants that must be
  inspected because this diff can affect them.
- **Expected unchanged behavior**: nearby behavior the reviewer should prove was
  preserved without reopening unrelated code.
- **Proof**: focused commands and named test cases.
- **Expected diff**: expected production/test paths, modified symbols, and
  observable behavior. Name likely companion test or documentation paths;
  any implementation-discovered path requires semantic justification and review.

## Done criteria

Machine-checkable; use 3–8 non-duplicative criteria. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run test:herder` exits 0; new tests for <X> exist and pass
- [ ] `grep -rn "<old pattern>" src/` returns no matches
- [ ] Every modified path is declared in scope or is a directly necessary,
  justified companion path accepted by review
- [ ] Required `CONTEXT.md` or ADR changes, when applicable, are present and match the accepted decision
- [ ] All done criteria above pass; the Herder Run Manager owns status updates

## STOP conditions

Use 3–6 plan-specific triggers. Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require an explicitly out-of-scope path.
- The actual diff would overlap an unordered plan, add an undeclared public
  transition, or cross another package/bounded subsystem.
- You discover the assumption "<key assumption>" is false.

## Maintenance notes

Use 1–3 bullets for the human/agent who owns this code after the change lands:

- What future changes will interact with this (e.g. "if pagination is added
  to this endpoint, the batching in step 2 must be revisited").
- What a reviewer should scrutinize in the PR.
- Any follow-up explicitly deferred out of this plan (and why).
```

---

## Optional shared `herder-plans/CONTEXT.md`

Create this only when two or more plans would otherwise repeat verified repository facts. Keep it concise, stable, non-repetitive, and at or below 1,600 words:

```markdown
# Herder Plan-Set Context

## Objective

The confirmed plan-set outcome and global non-goals.

## Shared repository facts

Verified architecture, conventions, baseline state, and exemplars reused by
multiple subplans.

## Shared commands

Repository-wide commands with expected results.

## Shared constraints

Accepted terminology, compatibility, security, rollout, and documentation
constraints that apply to every subplan.
```

Do not put a subplan's outcome, scope, dependency guarantee, or STOP condition here. `snapshot` hashes and composes this file before the local plan, so changing it changes every later snapshot.

---

## Index file: `herder-plans/README.md`

Written by a Herder plan producer. The manager compiles initial lifecycle into SQLite and does not rewrite Status during a run; an optional snapshot may run only at terminalization:

```markdown
# Implementation Plans

Generated by <Grill, Improve, or Simplify> on <date>. Execute in the order below unless
dependencies say otherwise. Each executor reads its plan fully and honors its
STOP conditions. README Status is authored before Fire; SQLite owns live lifecycle; the manager may snapshot Status only after a run is complete, failed, or stopped.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | ...   | P1       | S      | —          | TODO   |
| 002  | ...   | P1       | M      | 001        | TODO   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale — finding fixed independently or approach abandoned)

## Dependency notes

- 002 requires 001 because <reason>.

## Considered and rejected

- <request, alternative, or finding>: rejected because <one line>.
```

After `/herder-plans init`, edit the descriptive and plan-index sections in place instead of replacing the entire README. Execution attempts live in the ignored manager-owned `.herder/execution.sqlite3`; producers never edit, copy, inspect, or replace that database.

## Producer self-review — required before validation

After writing or changing a plan or shared `CONTEXT.md`, reread every authored plan from disk. For each new or changed plan ID, call `herder_plan` with `operation: "snapshot"` and review the returned compiled `planText` as an executor with zero session or sibling-plan context. If shared `CONTEXT.md` changes, refresh and reread every affected snapshot. Complete this semantic Producer self-review before running the Plans manager's mechanical validation:

1. **Intent or finding coverage** — "Why this matters", accepted decisions, non-goals, steps, tests, and done criteria all describe the same requested outcome or vetted finding. The draft introduces no unconfirmed product decision.
2. **Evidence** — current-state claims, file paths, symbols, excerpts, commands, dependencies, and conventions are verified against the repository rather than guessed. No secret value appears; name only its location and credential type.
3. **Executability** — a model new to the repository can execute the plan using only the plan and repository. Remove placeholders, "as discussed", vague references such as "the relevant module", judgment-only checks such as "make sure it works", and any hidden interview or audit context.
4. **Internal consistency** — Scope, drift-check paths, Git workflow, steps, test plan, done criteria, STOP conditions, dependencies, and the index agree. The Git workflow delegates branch/worktree ownership to Herder Fire, and every step names exact files or symbols and ends with a command plus expected result.
5. **Domain model** — accepted terminology, glossary changes, and ADR obligations are durable and consistent across current state, scope, ordered steps, and done criteria. Do not hide them in conversation history.
6. **Plan shape** — the draft is one coherent, independently testable invariant. Its semantic scope is credible, its review map gives a short evidence path, its dependency contract leaves a gate-passing intermediate state, and its steps are ordered and explicit about inputs, outputs, and boundaries.
7. **Split discipline** — split multiple outcomes, packages, public transitions, or caller cohorts before writing long prose. Do not split at a point where integration would be broken. A `mechanical` plan names the deterministic transformation and completeness proof; generated churn is not a waiver for broad semantic work.
8. **Overlap and composition** — repeated verified facts may live in plan-set `CONTEXT.md`, but no local outcome or dependency guarantee does. Overlapping in-scope paths are explicitly ordered by dependency or the plans are reshaped.

Repair omissions or inconsistencies directly when doing so only clarifies already confirmed intent or verified evidence. If review exposes a missing product decision, material scope or approach choice, or a second plan, return to the producer's clarification or selection phase and obtain confirmation before finalizing. A STOP condition is not a substitute for a decision required to begin implementation.

Then run `shape`, resolve every issue and unordered overlap, then run `validate`. Repeat the snapshot review and semantic self-review after any plan or shared `CONTEXT.md` change. Mechanical validation complements self-review; it does not replace it.
