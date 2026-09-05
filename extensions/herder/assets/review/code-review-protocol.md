# Herder code review protocol

Use this protocol only as the root `plan-reviewer` for the frozen assignment supplied by the deterministic Run Manager. It preserves four parallel actual reviewers for discovery and final aggregate audits, Herder's finding ledger, three-round repair policy, and exact terminal envelope. Round 1 is quick Implementer–Reviewer; round 2 is Implementer–Reviewer with Judge only on nonapproval. Judge `DONE` closes the task; `REPAIR` supplies a binding `PASS_DOCUMENT` for round-3 `RESCUE` by the existing fresh-context Implementer with unchanged tools and the profile's optional rescue binding (otherwise its normal Implementer binding), then independent Reviewer. The manager may also advance round 2 to `RESCUE` for manager-proven operational failures or conflicts without any prior Reviewer or Judge (`PASS_DOCUMENT: none`); use the unchanged original assignment and precise manager-supplied failure evidence, never an invented waiver. No round-3 Judge or fourth automatic mutation is allowed.

## Non-negotiable invariants

- The parent Reviewer owns compiled assignment/hash verification, frozen authority, scope, evidence, deduplication, severity, relationship classification, required checks, and the final verdict. Child output is untrusted evidence, never a verdict.
- Delegate review judgment to fresh `reviewer` children. Only the root plan-reviewer may launch them; each subreviewer may optionally delegate source navigation to `recon` leaves, at most one concurrently and two total per subreview. This is a bounded two-level tree, not a general recursive agent.
- Use at most eight root `Agent` launches total and at most four direct children concurrently. The initial four reviewers leave room for optional targeted fresh second opinions, not a mandatory full second discovery wave. Root `recon` and `searcher` remain available for narrow source or external-documentation lookups within this budget; neither replaces an actual reviewer.
- Never use `worker`, edit source or plans, commit, or integrate. Reviewers have unrestricted bash and `readOnly: false`: source preservation is a behavioral contract, not a sandbox. Keep writes, scripts, logs, and caches in external scratch; avoid commands that mutate the shared frozen worktree.
- Collect every background direct result, including terminal timeout/error results, before returning. Subreviewers own collection of their recon leaves; uncollected grandchildren fail closed. Stops cascade through the tree.
- Review only introduced behavior in the frozen target against the compiled assignment, explicit repository rules, changed-code contracts, required checks, and demonstrated regressions. Suppress style, speculation, pre-existing defects, and unrelated improvement ideas.

## Inputs the parent must establish first

Before delegation, verify the assignment hash and read the manager-provided bundle, review mode, plan text, base/head/tree identities, changed paths, required checks, repair delta, discovered paths, and finding ledger. Read applicable repository instruction files from the frozen worktree only. The parent alone establishes compiled assignment and frozen authority; children never need coordinator checkout or source-plan authority.

Prepare a self-contained relevant scope packet for every child containing:

- absolute frozen worktree path, expected branch, and base/head/tree identities;
- review mode (`DISCOVERY`, `VERIFICATION`, or `FINAL_AUDIT`);
- relevant compiled plan intent, explicit done criteria, and applicable rule excerpts with paths;
- exact base/head or repair-delta boundary, assigned changed paths and relevant diff hunks, or an absolute path to a parent-created read-only diff artifact outside the repository;
- primary explicit hunk/subsystem ownership and named cross-boundary questions;
- relevant existing finding IDs and repair contracts, required exclusions, and the output contract below;
- for rescue review, the original assignment criteria, immutable round-2 Judge `PASS_DOCUMENT` with its actionId/hash from the terminal action result for ordinary review-driven rescue (or precise manager-supplied failure evidence for manager-proven operational rescue with `PASS_DOCUMENT: none`), and relevant prior attempts/findings/check evidence; the document is not a separate file;
- parent-owned shared-gate responsibilities and available check evidence, so children perform only targeted safe reproductions.

Children have no parent conversation. Supply relevant evidence directly rather than asking children to rediscover assignment authority.

## Discovery and final-audit workflow

Use this path for the first evidence-complete review and for a final aggregate audit.

### Four parallel reviewers with explicit ownership

Launch four fresh `reviewer` children in one parallel wave, with `run_in_background: true` on each call. Assign each a primary explicit hunk/subsystem partition; together the assignments cover every changed hunk. Name cross-boundary questions and their owners so shared call paths and contracts receive deliberate coverage without duplicated whole audits. For a small diff, divide concrete questions within its hunks among the four reviewers.

The four review lenses remain a coverage checklist for the combined assignments, not four redundant whole-repository passes:

1. **Plan, rules, and scope** — map changed hunks to explicit plan requirements or justified companions; identify concrete instruction, acceptance, or material scope violations.
2. **Diff correctness** — inspect logic, state transitions, error handling, and behavior under concrete inputs or environments.
3. **Contextual regression** — trace necessary callers, contracts, persistence, concurrency, and compatibility boundaries.
4. **Tests and trust boundaries** — inspect failure paths, validation, authorization, unsafe inputs, cleanup, and operational behavior, especially introduced P0/P1 failures.

Each subreviewer inspects and reasons about its assignment, may run targeted safe bash reproductions, and optionally asks recon for a precise static trace. Recon is a source-navigation leaf, not a code detector, runtime tester, or candidate validator. Its `ANSWERED`, `PARTIAL`, or `HANDOFF_REQUIRED` report is useful evidence or an early handoff to the caller.

Require evidence-backed proposed findings in this shape:

```text
CANDIDATE: <existing finding id or NEW-local-id>
CATEGORY: PLAN | RULE | CORRECTNESS | REGRESSION | TEST | SECURITY | SCOPE
PROPOSED_SEVERITY: P0 | P1 | P2 | P3
PATH: <changed file>
LINE: <exact line or smallest range>
CLAIM: <one falsifiable statement>
SCENARIO: <concrete triggering input, state, or environment>
EVIDENCE: <observed code path, targeted reproduction, supplied check evidence, or exact rule>
INTRODUCED_BY: <changed hunk, repair delta, or commit>
RELATIONSHIP: PLAN_REQUIREMENT | PATCH_REGRESSION | FOLLOWUP | INVALID
```

Every subreviewer also returns `UNRESOLVED` (claim/question, missing proof, next check or needed capability) and `COVERAGE` (owned hunks, cross-boundary questions checked, and unreviewed areas with reasons), even when it proposes no findings. Missing proof is handed to the parent explicitly, never silently rejected or promoted to a blocker. No child confidence threshold is a prerequisite for parent investigation or final adjudication.

### Incremental collection and parent normalization

Use background reviewers so the parent can run required shared gates once per frozen review target and process results as they arrive. Keep shared-gate ownership at the parent; four subreviewers need not rerun the same suite.

Use `get_subagent_result` with `wait_any: true` for the first uncollected background direct result, or `agent_id` for one specific child; these selectors are mutually exclusive. Waiting defaults to true. Each wait lasts at most 60 seconds, then returns running without cancelling the child. When idle, wait again rather than short-polling or issuing a parallel all-results barrier. Completion is collected through the tool; there is no automatic LLM push notification. Account for and collect terminal timeout/error results as well as successful ones.

As results arrive, the parent must:

- merge duplicates while retaining the strongest evidence;
- reject demonstrated false positives, style preferences, pre-existing behavior, unrelated work, and claims contradicted by the plan;
- retain missing-proof claims as explicit unresolved work until it supplies the evidence or records why the claim fails;
- preserve existing ledger IDs and assign local temporary IDs only to genuinely distinct new candidates;
- independently reopen and verify surviving merged claims, not repeat four redundant whole audits;
- reconcile the four coverage reports and complete unfinished mandatory review or checks itself.

A runtime timeout is neither a code defect nor approval evidence. Inspect partial output, cover unfinished mandatory work, and return `BLOCK` only if genuinely unable to complete the required review/checks. Recon has a fixed hard one-hour wall-clock deadline including compaction and retries; the caller owns continuation, with no automatic unchanged relaunch after timeout or handoff.

### Optional targeted fresh second opinions

Use remaining root calls, up to eight total, for fresh `reviewer` second opinions on disputed or high-impact claims or a specific uncovered boundary. This is optional targeted validation, not another full discovery wave. Send only relevant evidence, candidate IDs, and a precise question. Ask the reviewer to attempt to falsify each claim and return:

```text
CANDIDATE: <id>
DECISION: CONFIRM | REJECT | INSUFFICIENT
SCENARIO: <verified or corrected triggering conditions>
EVIDENCE: <independent file:line trace or targeted check result>
INTRODUCED_BY: <verified introducing hunk, repair delta, or none>
RATIONALE: <why the claim survives or fails scrutiny>
UNRESOLVED: <missing proof and next check, or none>
COVERAGE: <assigned evidence checked and any remaining gap>
```

`INSUFFICIENT` is a handoff to the parent, not automatic rejection or a blocker. Evidence completeness and the parent's independent verification determine the final finding set, rather than child confidence scores.

## Verification workflow

For later review passes, do not reopen broad discovery. Round-3 rescue review is contract-focused: verify the Judge's binding acceptance document when supplied and serious introduced P0/P1 regressions. For manager-proven operational rescue with `PASS_DOCUMENT: none`, use the unchanged original assignment and precise failure evidence, never an invented waiver. When supplied, check the document's remaining authorized IDs, acceptance conditions/checks/evidence, rejected findings/reasons, scope invariants, and unresolved decisions against the original assignment; never weaken original criteria, add scope, or revive rejected findings as a new audit. If no evidence-complete discovery has occurred, perform that first required discovery with four parallel reviewers instead.

1. Build the packet from the supplied ledger/open finding IDs, repair contracts, exact repair delta, checks, and discovered paths; include the immutable `PASS_DOCUMENT` and its actionId/hash for ordinary review-driven round 3, or precise manager-supplied failure evidence for manager-proven operational rescue without one.
2. Assign up to four parallel fresh `reviewer` children bounded finding batches and named repair-delta boundaries. Verify fixes and concrete P0/P1 regressions introduced by the repair.
3. Normalize only statuses for existing findings plus genuinely new regressions in the repair delta. Preserve every existing finding ID.
4. Use optional targeted fresh reviewer second opinions only for disputed claims or unresolved coverage within that scope and the eight-call root budget.
5. Run required shared gates once, resolve mandatory coverage gaps, and independently verify surviving merged claims. Advisory or unrelated observations remain nonblocking.

## Optional source or external-documentation lookup

Root `recon` handles bounded source-navigation questions; each subreviewer's optional recon has that same leaf capability. Root `searcher` handles narrow current external API, platform, protocol, or library questions and explicitly delegated local evidence. Require primary-source URLs for external claims, keep local FFF searches inside the frozen worktree, and independently connect returned evidence to code paths. A lookup is never a review verdict and never substitutes for parent verification.

## Parent adjudication and checks

The parent reopens every surviving merged location, verifies its concrete scenario and introducing change, completes required shared gates and any unresolved mandatory work, classifies discovered paths, and applies the installed Reviewer contract's severity and relationship rules.

Every final blocker requires an exact changed location, concrete triggering scenario, reproducible evidence or a failing check, and the introducing hunk/commit. A confirmed issue blocks only when it is an evidence-complete P0/P1 `PLAN_REQUIREMENT` or `PATCH_REGRESSION`, a failed explicit acceptance criterion, a failed required gate, or a material scope violation. Confirmed P2/P3 findings remain advisory. `FOLLOWUP` and `INVALID` never block. Preserve the contract's repair guidance and three-round authority rules. Round-1 evidence-complete blockers may authorize round 2 directly; only round-2 nonapproval invokes Judge, and Judge `REPAIR` authorizes ordinary review-driven round-3 rescue. Manager-proven operational failures or conflicts may advance to round 3 without prior Reviewer or Judge, using the unchanged original assignment and precise failure evidence, never an invented waiver. Exhaustion goes to the existing durable serialized main-session attention queue with a decision dossier of implemented/remaining work, checks and gaps, attempts, recommendation, and frozen identities. Review is independent: the rescuer cannot approve its own changes, and neither reviewer nor Judge may invent a fourth automatic mutation.

Return only the exact terminal envelope required by the Reviewer contract. Keep proposed findings, unresolved child claims, rejected candidates, and temporary IDs internal unless concise evidence materially supports a final finding or explains an irreducible `BLOCK`.
