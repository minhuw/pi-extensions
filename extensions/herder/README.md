# Herder

Herder is Pi's deterministic multi-agent plan runner. It turns a validated Markdown dependency graph into concurrent Implementer and Reviewer pipelines, persists scheduling and proof state in SQLite and Git, and by default integrates only work backed by exact independent review evidence and approval. Explicit YOLO mode omits independent review, not mechanical integrity or final verification. Exhaustion is incomplete, not acceptance.

This is the maintained, Pi-first Herder implementation. The former standalone `minhuw/herder` package and its Codex and Claude Code adapters are deprecated.

## Install

Install the extension collection and its explicitly injected worker dependencies:

```bash
pi install git:github.com/minhuw/pi-extensions
pi install git:github.com/DietrichGebert/ponytail
pi install npm:pi-web-access
```

For development, install this repository by absolute path. No separate subagent package is required.

Node >=22.19.0 is required for supported Pi versions, built-in `node:sqlite`, and native TypeScript execution.

SQLite schema version **21** additively persists the immutable run `yolo` boolean, defaulting existing runs to `false`. Schema 20 introduced durable execution budgets; the schema-21 migration retains that accounting. Schema-19 migration retains the currently applied contract, existing actions, evidence, and worktrees, reconstructs conservative consumption, and pauses for explicit host authorization where retry attribution is ambiguous. It does not adopt a prepared revision or replay workers. Earlier unsupported schemas are retained and refused; do not reset a run to evade missing accounting.

Each execution profile binds exact root and worker models. Start Pi with the selected profile's orchestrator model and thinking level, then fire a validated plan directory:

```text
pi --model <provider>/gpt-6-astra --thinking high
/herder-fire herder-plans
```

Herder refuses to start when Pi's active providers cannot resolve every required model and thinking level. It never substitutes a different model after failure.

## What Herder owns

- Dependency-aware scheduling with a configurable global worker limit.
- Clean, parentless Pi worker sessions using Pi's built-in `grep` and `find` tools; Implementers load only Ponytail's exact `pi-extension/index.js`, while Reviewer and Judge load no extensions.
- A package-owned bounded nested executor: root Reviewers can launch actual `reviewer` children with optional `recon` leaves; Implementer and Judge delegation stays unchanged. Recon's local tools enforce worktree scope; other children use built-in repository search. `searcher` loads only `npm:pi-web-access`, `worker` loads only Ponytail, and `recon`/`reviewer` load no extensions. This is not a general recursive agent. See [Scoped nested delegation](adapters/README.md#scoped-nested-delegation) for permissions, limits, collection, and the ephemeral two-level tree.
- One stable Herder branch and isolated Git worktree per plan, stored under `<plan-dir>/.herder/worktrees/` so they stay inside the plan set.
- Immutable worker assignments, review rounds, completion proofs, and exact-tree verification evidence.
- Persistent SQLite accounting, crash recovery, and resumable runs.
- Serialized integration after independent review, while unrelated worker pipelines continue concurrently.
- A compact Pi progress widget, expandable blue/green worker input/output cards, and a read-only local dashboard.

For the internal division between the deterministic Run Manager and Pi adapter, see [Responsibility boundary](adapters/README.md#responsibility-boundary). Plan Markdown is never parsed as executable configuration; after integration, the main Pi session selects the smallest adequate, non-redundant verification manifest for the frozen tree, and the manager alone executes and records it. See [Final verification and bounded recovery](adapters/README.md#final-verification-and-bounded-recovery) for the post-integration verification and repair contract.

## Plan V2: breaking Markdown contract

**Herder completes repository changes, not releases.** Workers may implement deployment/infrastructure configuration, migration/recovery code, scripts, and runbooks, with local tests, emulators, and non-mutating dry-runs. Cloud provisioning, deployment/publishing, live migrations, and live restore/undo—including disposable targets—belong to a separately authorized external operator workflow. Plans must not require the run to perform or wait for those operations as starting conditions, dependencies, setup, or acceptance/final checks. Record outstanding live evidence in the handoff; code completion does not approve a release or real-data use. Producers and `/herder-validate` enforce this semantic [execution boundary](skills/plans/references/plan-format.md#execution-boundary); structural validation is not an operational safety check.

Local plans require exactly seven unique, nonempty sections: **Status**, **Outcome and acceptance**, **Boundaries**, **Starting conditions**, **Implementation route**, **Verification**, and **Escalation and handoff**. Old headings/formats are rejected; there is no compatibility fallback or format migration machinery. See the [canonical format](skills/plans/references/plan-format.md) and [template](skills/plans/references/plan-template.md).

A rows bind observable behavior to V proof; every criterion needs acceptance-phase proof before dependents start. V rows distinguish development, acceptance, and final checks and name a T toolchain. T rows identify repository-declared owner, cwd, source-backed preparation prerequisites, non-mutating availability/version probe, and manifest/lockfile/CI evidence, locally or once in shared context without shadowing. They may authorize locked restoration, pinned tool/browser assets, and repository-prescribed setup; dependency selection or tracked manifest/lock changes require explicit bootstrap/feature scope. Use scripts, pyproject/uv, Nix, and CI/instructions as applicable, not binary discovery, guessed packages, or unpinned global invocations.

Observed baseline is distinct from dependency starting guarantees and expected upstream edits. Binding requirements/decisions are distinct from a suggested route: a bounded fix that satisfies acceptance is not a violation merely because its patch differs. Exact write paths and semantic boundaries govern companions; independent review must accept directly necessary discoveries. Equal unordered write paths make `shapeReady=false`. Keep plans concise (local ≤1,200 words; shared ≤1,600; no minimum), without repeated Git/test/review boilerplate or layer/test/doc splitting for one invariant.

The derived PlanContract on records/snapshots/shape is inspectable; immutable compiled `planText` remains execution authority. Producers and Validate cold-read snapshots and verify source, proof sufficiency, and toolchain/setup evidence. Structural validation executes no commands, prepares nothing, and cannot prove semantic readiness or eager availability of assets a bootstrap plan creates later. Implementers perform declared bounded setup, pre-edit canonical probes, and baseline diagnosis; Reviewers/Judges reuse the prepared worktree and may repeat only source-preserving declared restoration before checks. They report `SETUP` separately from `CHECKS`. **No automatic manager per-plan gate/preflight phase is added.** Only the separate final manifest selected by the main session is manager-executed authoritative evidence. Existing final verification has bounded npm-only locked dependency preparation and supports a repository-owned pinned-asset setup-and-check command inside one isolated gate; it is not a universal preparer. See [Final verification environment](adapters/README.md#final-verification-environment).

## Planning and execution commands

| Command | Purpose |
| --- | --- |
| `/herder-grill <change>` | Clarify product intent and create a focused validated plan graph in the current session. |
| `/herder-grill --plan <id-or-path> [--plan-dir <dir>]` | Refine standalone plans. During execution, use the host-confirmed scope amendment path instead. |
| `/herder-grill --plan <id-or-path> --split [--plan-dir <dir>]` | Explicitly request/elevate a standalone graph split; rejected during active Fire. |
| `/herder-improve [quick\|standard\|deep] [focus] [--lang <language>]` | Audit the repository and write prioritized improvement plans. |
| `/herder-simplify [quick\|standard\|deep] [focus-or-path] [--lang <language>]` | Find safe codebase reductions and write prioritized simplification plans. |
| `/herder-validate [plan-dir] [--fix]` | Run a repository-aware semantic plan audit and conservative repair workflow. |
| `/herder-plans init [plan-dir] [--track]` | Initialize a plan directory. |
| `/herder-plans validate\|shape\|status\|ready [plan-dir]` | Run immediate deterministic plan-graph operations. |
| `/herder-plans snapshot <plan-id> [plan-dir]` | Refresh a plan's tracked file snapshot. |
| `/herder-plans report <plan-id\|RUN> [plan-dir]` | Report plan or run state. |
| `/herder-plans track\|untrack [plan-dir]` | Change plan-directory tracking policy. |
| `/herder-fire [plan-dir] [--yolo] [options]` | Validate and start a new run; optional YOLO skips independent review. |
| `/herder-attach [plan-dir] [--dashboard-port n]` | Safely take over an active run after its former Pi session died, without resuming paused lifecycle state. |
| `/herder-resume [plan-dir] [options]` | Recover and continue an existing run. |
| `/herder-revise [plan-dir]` | Explicitly request scope-amendment drafting, then confirm the exact change separately; budgets remain unchanged. |
| `/herder-budget <amount> [plan-dir] [--plan ID --rounds N --recoveries N]` | Confirm additional dispatch units and optional task rounds/recoveries separately from scope. |
| `/herder-rework <plan-id> [plan-dir]` | Legacy execution-reset path is refused; use an explicit scope amendment and separately authorized effort. |
| `/herder-status [plan-dir]` | Show current run status in Pi. |
| `/herder-dashboard [plan-dir]` | Open or report the read-only dashboard. |
| `/herder-cleanup [plan-dir] [--plan id] [--include-failed]` | Preview and confirm ordinary cleanup of eligible plan worktrees/branches while preserving integration, coordination refs, and plans. |
| `/herder-reset [plan-dir]` | Reset an unmerged Herder plan set to its pre-initialized execution state while preserving plan Markdown and tracking setup. |
| `/herder-cleanup [plan-dir] --deep [--include-failed]` | Destructively remove a fully terminal plan set after proving integration is merged into the current branch and all owned worktrees are safe. |
| `/herder-cleanup [plan-dir] --force` | Settle owned workers, then delete that plan set's files, worktrees, branches, and coordination refs. Refuses unsafe or foreign ownership; ignores terminality, proofs, and dirty worktrees. Cannot be undone. |
| `/herder-stop` | Stop the active run owned by the current Pi session. |

Improve and Simplify show a compact table, then automatically explain every vetted finding in table order using the same numbers and 2–3 plain-language sentences, before recommending what to plan and waiting for selection. `--lang <language>` changes the findings table, explanations, recommendation, and selection/follow-up discussion for that invocation only; use a language name or locale and quote multiword names. Without it, follow the user's conversation language, falling back to English. All authored plan content, the index, `CONTEXT.md`, and internal agent prompts/replies, findings reports, and handoffs remain English; paths, symbols, commands, and IDs stay verbatim. Example: `/herder-simplify quick --lang zh-CN`.

Fire and resume accept `--profile <name>`, `--dashboard-port <port>`, and `--max-parallel <count>`. Scope amendment preserves the recorded execution configuration. Attach accepts only `--dashboard-port`, derives the immutable profile, review mode, and parallelism from manager status, and refuses takeover while another live Pi process owns the run.

### YOLO: no independent review

`/herder-fire [plan-dir] --yolo` opts a **new run** into YOLO mode. `--yolo` is a standalone boolean flag (no value or `=true` form), accepted only by Fire; resume, revise, and attach reject it. The backend persists the mode immutably, and resume/attach recover it without a new flag. A scope amendment cannot flip it. Without the flag, normal review behavior is unchanged.

YOLO skips **all manager Reviewer and Judge actions**, including repair reviews and the final aggregate audit. Plan completion instead requires the Implementer's `COMPLETE` report plus the existing mechanical integrity and scope checks. The main session still selects the exact-tree final manifest, and the manager must execute and pass its gates before run completion. Implementer reports and mechanical checks are **not independent review or semantic approval**; start/status identify `YOLO/no independent review`. No synthetic Reviewer/Judge approvals are created.

Durable dispatch budgets, task rounds, recovery limits, scope boundaries, and host-approval requirements are unchanged; skipped review actions do not consume dispatch units. The review pipelines and final-approval requirements described below apply to normal mode, not YOLO.

General run control is user-invoked through the slash commands above. Attention does not initiate planning or dispatch. A separately user-invoked, exactly confirmed amendment may invalidate affected execution without replenishing its budget; explicit abandonment remains destructive and separately confirmed. `/herder-cleanup` remains command-only, and the active model has no run-control tool. Ordinary cleanup preserves the integration branch/worktree, coordination refs, and plan directory; `--include-failed` additionally selects BLOCKED/REJECTED evidence. `/herder-reset` restores pre-initialized execution state and permanently discards uncommitted changes and untracked files in Herder-owned worktrees. It still refuses merged or unsafe namespaces, including unknown or moved namespaces, preserving plan Markdown and tracking setup. Plan-set-level `--deep` removes those preserved resources and the plan directory after a fail-closed preview that still requires a terminal run, reachable completion proofs, and merge ancestry; it performs final terminality, merge-ancestry, current-branch, integration-worktree, and ordinary-eligibility revalidation under service exclusion before removing the plan directory last. `--force` is the last-resort destroyer: it stops a live run if needed, then deletes the plan directory, owned worktrees, `herder/<plan>/` branches, and `refs/plan-herder/<plan>/` refs without those proofs. It still refuses to delete the current checkout. The removed `--finalize` and `--handoff-target` modes are rejected with guidance to use `--deep` or `--force`. The model-facing Herder surfaces are planning-only `herder_plan` (including request-bound attention resolution), request-bound `herder_verification`, request-bound `herder_integration_repair` (classification plus `begin`, `finish`, or `cancel` only), and request-bound `herder_reignite`; the adapter uses internal `herder_run` dispatch for manager operations and does not expose it as a model tool. The agentic planning commands inject the exact package-owned instructions and supplied arguments into the current Pi conversation, preserving the user's context. The instruction files remain private implementation assets, so each workflow has one public `/herder-*` command. `/herder-plans` is the fast deterministic surface: it parses typed subcommands and calls the native `herder_plan` application tool without spending a model turn. Mechanical `/herder-plans validate` and semantic `/herder-validate` are intentionally separate.

Confirmed force cleanup immediately closes target-local publication across all adapter registrations in the Pi process before any fallible ownership or quarantine inspection, then retains exclusive Pi ownership and durably marks the claim cleanup-required to close recovery admission across adapters before settling admitted manager work and all worker preparation, prompts, nested execution, abort, and disposal. Only that exact successfully drained claim authorizes deletion. Live foreign or uncoordinated same-process owners are refused without signalling Pi; unmarked dead owners remain recoverable. Cancellation changes nothing. Confirmation-time quarantine collisions or marker failures also block subsequently completing workers from submitting terminals, proposing successors, publishing target state, or releasing ownership. Marker or settlement failures retain ownership and local exclusion for manual assessment. Force cleanup first persists a `.herder/pi-session-owner.lock.cleanup-required` hardlink, so a failure before marker writing also blocks dead-owner reclamation. A conflicting quarantine pathname likewise refuses cleanup and recovery, even if the primary claim is unmarked or missing; conflicting evidence is never overwritten or adopted as authorization. After manual child-process assessment, remove the retained evidence before recovery. Final directory deletion keeps the marked inode at the sibling `<plan-directory>.cleanup-required` until success; a failed removal retains that exclusion for manual assessment and removal even if `.herder` was already deleted. Ownership/runtime evidence is rechecked after service exclusion and before each destructive phase; replacement halts remaining deletion without rolling back prior removals. After manual cleanup, restart the Pi process before reusing the same target: its process-wide target exclusion is intentionally not reopened by removing evidence. Success does not prove other processes safe, and these checks are not atomic protection against hostile filesystem mutation.

Confirmed reset first drains local workers while keeping the current Pi alive. Resetting a live foreign owner requires separate PID/session confirmation: its **entire Pi exits**, affecting other work there. Termination checks the runtime inode and recorded process birth identity and uses bounded TERM/KILL waits (best-effort, not atomic PID-reuse protection). Exit without graceful ownership-lock release—including forced KILL—refuses destruction and requires manual child-process cleanup; local cleanup failures also retain ownership. Legacy live PID-only locks fail closed: exit the owning Pi once, then retry. Cancellation leaves lifecycle/state unchanged; reset holds exclusive Pi ownership through cleanup.

While a run owns execution authority, Improve, Simplify, mutating plan-configuration operations, and generic active-Grill/rework adoption are refused. Use `/herder-revise` for an explicit host-confirmed amendment; public `begin_edit`/`finish_edit` cannot create replacement execution authority. Existing legacy edit reservations may be cancelled. Standalone plan refinement and splitting remain planning operations outside execution. See [Active-Fire plan editing](adapters/README.md#active-fire-plan-editing).

Blocked plans and exhausted rounds remain in the durable attention queue, with worktrees, raw failures, and approved contributions preserved. `plan_recovery` identifies product failure, `user_decision` identifies missing authority or a contradictory requirement, and `operator_attention` identifies infrastructure or reporting problems. Attention is a quiet decision report, not an automatic model turn or a revision proposal. Independent approved work can proceed only within the remaining run budget.

Blocked worker envelopes may report `BLOCKER_KIND: ENVIRONMENT | INVOCATION | REQUIREMENT | SAFETY`. Environment/invocation failures preserve the same substantive round and require the specific external correction; they do not authorize guessed source repair. REQUIREMENT requests a precise decision, not expanded scope. SAFETY pauses for a decision without launching remediation. Frozen review/Judge checks precede classification, and unfinished patches are never treated as reviewed. Report `SETUP` separately from `CHECKS`; interrupted or unrun checks remain unknown.

Ordinary blocking findings must name an existing A/V obligation (qualified by plan ID for final audit), or quote an exact frozen Boundaries constraint, and supply concrete `evidence=` and causal `violation=` fields. The manager validates references and required fields, not arbitrary semantic relevance. Reviewers still establish causality and materiality. Advisory follow-ups cannot authorize repair; malformed blockers stop as protocol errors instead of spawning format-repair agents.

### Explicit scope amendments

Failure does not authorize planning. Only an explicit host-confirmed user operation opens a scope amendment. Workers, reviewers, Judges, and the model-facing attention tool cannot independently authorize a new prerequisite, requirement, permission, or generation. Existing immutable assignments and graph snapshots remain execution authority; editing Markdown does not replace them. Conservative confirmation is required for semantic changes; no semantic-equivalence engine is used.

After the entire graph passes shape/validation, `finish_edit` presents the exact revision and lists completed plans to **retain**, plans to **rerun**, and plans to **remove**. Changing one plan does not require rewriting unrelated completed plans. Herder compares immutable assignments and invalidates changed plans plus their downstream dependents in both the old and revised dependency graphs. Unchanged completed plans outside that closure retain their implementation and approval evidence; unfinished execution surfaces restart without inheriting unreviewed work. Shared-context changes can invalidate every plan. Authored `DONE` is not completion evidence.

Approval adopts a new generation of the same run. Herder safely reverses invalidated contributions on the integration branch, preserving unrelated completed history, and deletes only invalidated execution surfaces. Conflicts or changed ownership keep the run blocked rather than silently expanding what is discarded. Amendments also refuse cleanup of unfinished dirty or committed work; an operator must preserve/reconcile those patches before adoption. Final verification runs again against the revised integration tree; normal mode also requires final approval, while YOLO remains without independent review. The user's source checkout and branch are never reset; changed checkout/base or merged integration refuses recovery. A dismissed confirmation preserves the old execution and leaves the revision open, not retried. Explicit `abandon_run`, separately host-confirmed, discards the whole unmerged execution without restarting and preserves plan Markdown.

Scope approval and budget approval are separate: an amendment does not restore consumed rounds or dispatch capacity. Final **RUN** verification and integration repair remain exact-tree/request-bound and also consume the cumulative run budget. An answer alone is not approval or permission to resume. See [Attention, concurrency, and recovery](adapters/README.md#attention-concurrency-and-recovery) for the authorization boundaries.

## Profiles

| Profile | Role intent |
| --- | --- |
| `eclipse` | Sol orchestrates, reviews, and judges while Luna implements. |
| `poorman` | Luna orchestrates, reviews, and judges while DeepSeek implements. |
| `epic` | Fable orchestrates and judges, Opus implements, and Sol reviews. |
| `lightspeed` | Grok 4.6 orchestrates and implements while Luna reviews and judges. |
| `universe` (default) | Astra high orchestrates; Astra medium implements; Sol xhigh reviews and searches; Astra xhigh judges and rescues. Luna max/fast is Recon-only. |

Exact model, effort, and service-tier bindings live in `assets/profiles/profiles.json` and are resolved by the runtime.

Profiles configure three generic package roles: `herder.plan-implementer`, `herder.plan-reviewer`, and `herder.plan-judge`. Optional `rescue` and `searcher` bindings override only round-3 Implementer and nested web Searcher; existing profiles retain their bindings and `universe` is the default for new runs. Astra/Sol bindings in `universe` do not pin a service tier.

To use the default `universe` profile (or select it explicitly with `--profile universe`):

```text
pi --model <provider>/gpt-6-astra --thinking high
/herder-fire herder-plans
```

Roles prefer bounded Recon lookups for unfamiliar code and named narrow static defect-candidate questions, not for runtime proof or review judgment; known-path reads stay direct. Delegate only when cheaper than direct reading, reuse evidence without a duplicate full audit, and work on other coverage concurrently. Candidates need concrete trigger/consequence and `file:line` evidence plus remaining proof, never a verdict or authoritative severity. Reviewers retain independent verification, complete coverage, and required checks; zero candidates never implies complete review or approval. These are [prompt policies](adapters/README.md#scoped-nested-delegation), not wholesale review delegation or new runtime enforcement. Delegation may reduce expensive repeated exploration but adds scout latency, so any speed/quality gain needs measurement.

## Durable execution limits

The default remains one implementation round plus at most two repair rounds per approved task. These allocations survive generation changes, rework, and restarts. Newly added or renamed task identities do not receive automatic fresh allocations. Safe transport recovery has its own limit: at most one automatic recovery per task; an interrupted mutated worktree pauses immediately for reconciliation instead of replaying operations.

A run receives **8 × approved plan count + 12** dispatch units. Root Implementer, Reviewer, and Judge reservations, exact-tree verification attempts, and automatic integration-repair authorizations consume the durable run ledger. Cancelled/ambiguous reservations are not refunded. Each root's existing bounded descendant tree is charged to its root reservation, not a new independent budget. This bounds autonomous continuation, not elapsed time or provider token use. Dispatch admission and consumption are transactional; replay of the same reservation does not spend twice or launch a new attempt.

Scope approval never replenishes these limits. Additional effort requires a separate exact, audited host-approved budget grant. Exhaustion preserves the contract and work and stays stopped across resume/revision; final verification remains mandatory after recovery.

## Runtime model

Fire and resume start or reuse Herder's persistent local Run Manager, launch the read-only dashboard, dispatch the first eligible worker batch, and return control to the root session. Attach claims an unowned or stale-owned active run, preserves `running`, `paused`, or `needs_input`, and deterministically replaces vanished built-in Pi workers. Revise adopts a validated immutable graph generation after active workers settle. In an Orca-managed terminal, Herder automatically opens the loopback dashboard through Orca's workspace browser; other terminals receive the local URL without host-specific forwarding. As workers finish, the manager backfills the global pool, advances review rounds, and integrates approved plans in dependency order. Pi journals each admitted worker prompt in a blue expandable card and each returned response in a green card (red on interruption); cards identify the plan, exact model, thinking level, and service tier, and do not enlarge the root model context. See [Orchestration workflow](adapters/README.md#orchestration-workflow) for service, dashboard, and transport mechanics.

For ordinary code failures (not classified ENVIRONMENT/INVOCATION attention), each plan has at most **three substantive rounds**: (1) Implementer–Reviewer quick path; (2) Implementer–Reviewer, with Judge only on nonapproval; (3) `RESCUE` authorized by Judge or manager-proven operational failure/conflict, then independent Reviewer. Judge may return `DONE` or `REPAIR` (or surface unresolved input/blockage). `REPAIR` includes a binding `PASS_DOCUMENT` of at most 16384 characters, persisted in the immutable terminal action result and delivered with its actionId/hash—not a separate file. The manager may also advance round 2 to `RESCUE` for manager-proven operational failures or conflicts without any prior Reviewer or Judge (`PASS_DOCUMENT: none`); use the unchanged original assignment and precise manager-supplied failure evidence, never an invented waiver. Rescue is the existing Implementer with unchanged tools in fresh context, using the profile's optional rescue binding or otherwise its normal Implementer binding, receiving the original assignment, the round-2 Judge document for ordinary review-driven rescue (or precise failure evidence for operational rescue without one), and prior attempts/findings/check evidence. It may change approach within scope but cannot weaken criteria, add scope, or self-approve. Round-3 review checks that document when supplied, the unchanged original assignment, and serious introduced regressions; if none occurred earlier, first required discovery uses the same Plan V2 risk rule regardless of round. There is no round-3 Judge, fourth automatic mutation, or new rescue worker role. See [Three-round plan closure](adapters/README.md#three-round-plan-closure).

Plan `DISCOVERY` uses the existing Plan V2 Risk floor: **LOW = 1, MED = 2, HIGH = 4** reviewer children; missing risk means HIGH. Actual diff risk may escalate for authorization/authentication, persistence, concurrency, public boundaries, or executable Markdown/prompt policies; small diffs/file counts or documentation extensions never justify a downgrade. `FINAL_AUDIT` retains four parallel reviewers and full aggregate coverage. All four lenses, owned hunks, and cross-boundary questions remain covered regardless of child count. `VERIFICATION` defaults to one scoped child for accepted open IDs and repair-delta regressions, scaling only for distinct risky repair boundaries up to four, not broad rediscovery. These are prompt policy counts; hard runtime caps remain eight root calls and four concurrent direct children, with unchanged model bindings.

Materiality precedes expensive proof: a concrete plausible trigger and material consequence, or an explicit failed acceptance/scope obligation. Reviewers do not actively seek optional P2/P3 improvements; zero findings is valid, without suppressing confirmed serious defects. The parent independently checks materiality and verifies blockers, separates mandatory coverage gaps and credible material concerns from rejected speculation, and never approves serious unresolved concerns or missing required checks. Missing findings in partial reports are not resolution; resolved/rejected IDs reopen only with new evidence. The parent retains assignment and shared preparation authority, source-preserving setup before child checks, and shared gates once; children never run competing installs. Targeted second opinions are optional. Reviewer bash remains unrestricted, so source preservation is behavioral, not a sandbox. See [Reviewer protocol](adapters/README.md#reviewer-protocol).

`HERDER_REVIEW_TIMEOUT_MS` is opt-in: a positive integer no greater than 2147483647; unset disables it pending calibration. One deadline starts at root Reviewer start and includes SDK compaction/retries and all descendants. Exhaustion enters same-round operator attention, never automatic retry or approval; settlement may exceed the deadline for safe Bash cleanup. See [review calibration](TESTING.md#bounded-review-policy-and-calibration) before choosing a budget.

Final gate outcomes (`passed`, `command_failed`, `unavailable`, `timed_out`, `runner_error`) and error/timedOut/signal metadata are process evidence only, never automatic source-defect diagnosis. A launched uv/Nix wrapper missing a nested tool can report `command_failed`; inspect declared invocation and prerequisites rather than treating exit 127 or log text as a code finding. Final recovery classifies wrong argv/manager/cwd as `manifest_error`; proven prerequisite absence is the non-mutating `environment` decision outcome, with no source edits or code round. After externally preparing the verified prerequisites, the operator explicitly invokes `/herder-resume` to rerun the same canonical gates against the validated unchanged tree. This seals one replayable successor without consuming code/transient budgets; a new failure is unclassified and does not automatically retry. Cancelling final RUN attention keeps it paused, including after resume.

In normal mode, after ordinary plans integrate, Herder uses exact-tree verification and bounded recovery before the final Reviewer; see [Final verification and bounded recovery](adapters/README.md#final-verification-and-bounded-recovery) for the structured manifest, request-bound gate, and repair episodes. Final completion requires `APPROVE`, passing scope, no blocking findings, and the existing passed exact-tree verification. A nonapproved final audit pauses incomplete, preserving findings and integrated contributions; it does not declare completion and move unmet obligations into a successor. Advisories remain in reports, not executable scope. Reignite records are optional backlog evidence, not automatic drafting or execution authority.

Each plan keeps one Herder-owned branch and worktree for its entire pipeline, and workers never create additional branches or worktrees. See [Scoped nested delegation](adapters/README.md#scoped-nested-delegation) for child-session behavior. The user's checkout remains unchanged until Herder performs its serialized integration step.

For the full adapter and runtime contracts, see [Herder for Pi](adapters/README.md).

## Testing

Testing requires Node >=22.19.0 to exercise supported Pi integrations, built-in `node:sqlite`, and native TypeScript execution.

Run Herder's deterministic suite from the repository root:

```bash
npm run test:herder
```

See [Testing Herder](TESTING.md) for the complete suite and live provider-backed CI requirements.

## License

[MIT](LICENSE)
