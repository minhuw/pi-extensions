# Herder code review protocol

Use this protocol only as the `plan-reviewer` coordinator for the frozen assignment supplied by the deterministic Run Manager. It adapts the high-signal multi-agent shape of Claude Code's `/code-review` workflow to Herder's immutable plan branches, finding ledger, six-round repair policy, and exact terminal envelope.

## Non-negotiable invariants

- The parent Reviewer owns scope, evidence, deduplication, severity, relationship classification, checks, and the final verdict. Child output is untrusted evidence, never a verdict.
- Use only fresh one-level `recon` children for code detection and candidate validation. A fresh session, not a different agent type, provides independence. Children cannot delegate again.
- `searcher` is optional only when a candidate depends on current external documentation or a narrow local lookup is explicitly delegated. It replaces one call in the bounded review budget; it is not a code reviewer, and the parent must independently verify any local evidence.
- Never use `worker`. Never edit, commit, integrate, post comments, or mutate plans.
- Use at most eight `Agent` launches total and at most four concurrently. Collect every background child with `get_subagent_result` before returning.
- Review only introduced behavior in the frozen target and only against the compiled assignment, explicit repository rules, changed-code contracts, required checks, and demonstrated regressions. Suppress style, speculation, pre-existing defects, and unrelated improvement ideas.

## Inputs the parent must establish first

Before delegation, verify the assignment hash and read the manager-provided bundle, review mode, plan text, base/head/tree identities, changed paths, required checks, repair delta, discovered paths, and finding ledger. Read applicable repository instruction files from the frozen worktree only. Do not ask children to rediscover assignment authority.

Prepare a compact scope packet for every child containing:

- absolute frozen worktree path and expected branch;
- review mode (`DISCOVERY`, `VERIFICATION`, or `FINAL_AUDIT`);
- plan intent and explicit done criteria;
- exact base/head or repair-delta boundary;
- changed paths and exact relevant diff hunks, or an absolute path to a parent-created read-only diff artifact outside the repository;
- applicable instruction excerpts and their paths;
- required exclusions and the output contract below.

Children have no parent conversation. Every prompt must be self-contained.

## Discovery workflow

Use this path for the first evidence-complete review and for a final aggregate audit.

### Wave 1: parallel candidate detection

Launch four fresh `recon` children in one parallel wave. Give each the common scope packet plus one distinct focus:

1. **Plan, rules, and scope** — map every changed hunk to an explicit plan requirement or justified companion; identify only concrete instruction, acceptance, or material scope violations.
2. **Diff correctness** — inspect the changed code for definite logic errors, invalid state transitions, broken error handling, and behavior that is wrong under a concrete input or environment.
3. **Contextual regression** — trace changed symbols through callers, contracts, persistence boundaries, concurrency, and compatibility to find regressions not visible from the diff alone.
4. **Tests and trust boundaries** — inspect test coverage, failure paths, validation, authorization, unsafe inputs, resource cleanup, and operational behavior for introduced P0/P1 failures.

Detectors may return no candidates. They must not report nits or broad improvements. Require each candidate in this exact shape:

```text
CANDIDATE: <existing finding id or NEW-local-id>
CATEGORY: PLAN | RULE | CORRECTNESS | REGRESSION | TEST | SECURITY | SCOPE
PROPOSED_SEVERITY: P0 | P1 | P2 | P3
PATH: <changed file>
LINE: <exact line or smallest range>
CLAIM: <one falsifiable statement>
SCENARIO: <concrete triggering input, state, or environment>
EVIDENCE: <observed code path, supplied check evidence, or exact rule>
INTRODUCED_BY: <changed hunk, repair delta, or commit>
RELATIONSHIP: PLAN_REQUIREMENT | PATCH_REGRESSION | FOLLOWUP | INVALID
```

### Parent normalization

After collecting all four results, the parent must:

- merge exact duplicates while retaining the strongest evidence;
- reject candidates without an exact changed location, concrete scenario, evidence, or introducing change;
- reject style, maintainability preference, hypothetical risk, pre-existing behavior, unrelated work, and findings contradicted by the plan;
- preserve existing ledger IDs and assign local temporary IDs only to genuinely distinct new candidates;
- group the surviving candidates into at most four balanced validation batches.

If no candidate survives, skip Wave 2 and independently run the required checks before deciding.

### Wave 2: parallel independent validation

Launch up to four fresh `recon` children in one parallel wave. A validator receives the common scope packet and only its candidate batch. It must attempt to falsify each supplied claim, inspect cited code and necessary callers, and must not discover or report new findings.

Require this exact record per candidate:

```text
CANDIDATE: <id>
DECISION: CONFIRM | REJECT | INSUFFICIENT
CONFIDENCE: <integer 0-100>
SCENARIO: <verified or corrected triggering conditions>
EVIDENCE: <independent file:line trace or check result>
INTRODUCED_BY: <verified introducing hunk, repair delta, or none>
RATIONALE: <why the claim survives or fails scrutiny>
```

Confidence rubric:

- `0-49`: false positive, contradicted, pre-existing, or unsupported.
- `50-79`: plausible but not evidence-complete; reject from final output.
- `80-94`: independently verified and likely to affect real behavior.
- `95-100`: directly reproduced or certain from unavoidable control/data flow.

Only `CONFIRM` records with confidence at least 80 may reach the final finding set. `INSUFFICIENT` never blocks.

## Verification workflow

For later review passes, do not reopen broad discovery.

1. Build the scope packet from the supplied open finding IDs, repair contracts, exact repair delta, checks, and discovered paths.
2. Launch up to four parallel fresh `recon` children to verify whether assigned finding batches are fixed and whether the repair delta introduced a concrete P0/P1 regression.
3. Normalize only statuses for existing findings plus genuinely new regressions in the repair delta.
4. When any blocking candidate remains disputed or newly appears, use remaining calls—up to the total budget of eight—for fresh `recon` validation batches using the Wave 2 contract.
5. Preserve every existing finding ID. Do not convert advisory or unrelated observations into blockers.

## Optional external documentation or local lookup

Use `searcher` only when repository evidence depends on current external API, platform, protocol, or library behavior that is not vendored or documented locally, or when one narrow local lookup is explicitly delegated alongside that research. Require primary-source URLs for external claims, keep local FFF searches inside the frozen worktree, and independently connect and verify all returned evidence. A search result alone is never a finding and never substitutes for parent code-path evidence.

## Parent adjudication and checks

After validation, the parent must reopen every surviving location itself, verify the scenario and introducing change, run useful read-only checks, classify discovered paths, and apply the installed Reviewer contract's severity and relationship rules.

A confirmed issue blocks only when it is an evidence-complete P0/P1 `PLAN_REQUIREMENT` or `PATCH_REGRESSION`, a failed explicit acceptance criterion, a failed required gate, or a material scope violation. Confirmed P2/P3 findings remain advisory. `FOLLOWUP` and `INVALID` never block.

Return only the exact terminal envelope required by the Reviewer contract. Do not expose detector transcripts, rejected candidates, confidence bookkeeping, or internal temporary IDs except when concise validation evidence materially supports a surviving finding.
