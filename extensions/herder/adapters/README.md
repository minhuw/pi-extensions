# Herder for Pi

Herder is a native Pi extension package with package-owned planning skills.

## Install

```sh
pi install git:github.com/minhuw/pi-extensions
```

Use `pi install /absolute/path/to/pi-extensions` while developing this checkout. No separate subagent package is required.

Start Pi with the root model and thinking level required by the chosen profile:

```text
pi --model <provider>/gpt-5.6-luna --thinking max
/herder-fire herder-plans --profile poorman
```

Available commands:

- `/herder-improve [quick|standard|deep] [focus]`
- `/herder-simplify [quick|standard|deep] [focus-or-path]`
- `/herder-grill <change-description>`
- `/herder-grill --plan <id-or-path> [--plan-dir <dir>]`
- `/herder-grill --plan <id-or-path> --split [--plan-dir <dir>]`
- `/herder-plans init [plan-dir] [--track]`
- `/herder-plans validate|shape|status|ready [plan-dir]`
- `/herder-plans snapshot <plan-id> [plan-dir]`
- `/herder-plans report <plan-id|RUN> [plan-dir]`
- `/herder-plans track|untrack [plan-dir]`
- `/herder-validate [plan-dir] [--fix]`
- `/herder-fire [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-attach [plan-dir] [--dashboard-port n]`
- `/herder-resume [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-revise [plan-dir] [--profile name] [--dashboard-port n]`
- `/herder-status [plan-dir]`
- `/herder-dashboard [plan-dir]`
- `/herder-cleanup [plan-dir] [--plan <id>] [--include-failed]`
- `/herder-reset [plan-dir]`
- `/herder-cleanup [plan-dir] --deep [--include-failed]`
- `/herder-cleanup [plan-dir] --force`
- `/herder-stop`

The agentic planning commands—`/herder-improve`, `/herder-simplify`, `/herder-grill`, and `/herder-validate`—inject the exact package-owned instructions plus the supplied arguments into the current Pi session. The skill files are command-owned implementation assets rather than separately exposed `/skill:` commands.

`/herder-plans` is the fast deterministic surface: it parses typed subcommands and calls the shared plan application directly without spending a model turn. `validate` there is mechanical graph validation; `/herder-validate` is the repository-aware semantic audit and optional repair workflow. Mutating plan-configuration operations refuse to run while the current Pi session owns an active Fire run. The active model receives the planning-only `herder_plan` tool for canonical plan operations.

`/herder-grill --plan <id-or-path>` is the standalone plan-authoring/refinement path for TODO and decision-blocked work. It may decompose the target into a confirmed dependency-aware plan set when shaping requires that split; `--split` explicitly requests/elevates this intent. The split preserves the old objective and downstream guarantee, allocates monotonic IDs centrally, and updates only the target and directly affected siblings, index, dependencies, or shared context.

During active Fire, `/herder-grill --plan <id>` is a narrower exception. The manager must prove the plan has no runtime, action, attempt, worktree, or approval evidence before reserving it. While Grill interviews and edits, only that plan is withheld from scheduling. Finishing the edit raises a revision barrier: existing workers settle, no new workers dispatch, the validated target-only change becomes the next immutable graph generation, and scheduling resumes. Cancelling without changes releases the reservation. Explicit `--split` is rejected before reservation because active-Fire edit authority is target-local; finish or stop Fire and run the split standalone.

Run control is user-invoked through the slash commands above. `/herder-cleanup` remains command-only: ordinary mode removes only eligible plan branches/worktrees and preserves integration, coordination refs, and the plan directory. `/herder-reset [plan-dir]` removes an unmerged Herder plan set's runtime branches, worktrees, refs, and execution evidence while restoring durable initial statuses; it refuses merged or unsafe namespaces and preserves plan Markdown and tracking setup. `--deep` is the proven plan-set-destructive mode and performs terminality, merge ancestry, current-branch, integration-worktree, and ordinary-eligibility checks again under service exclusion before removing the plan directory last. `--force` is the unconditional destroyer for a stuck or rewritten namespace: it may stop a live run, then deletes owned worktrees (including dirty or locked), `herder/<plan>/` branches, coordination refs, and the plan directory. It still refuses to remove the current checkout. Legacy `--finalize` and `--handoff-target` are rejected. The active model has no run-control tool. The other model-facing Herder surfaces are request-bound `herder_verification` (which only selects final verification gates), request-bound `herder_integration_repair` (which exposes only one failed-request classification and its `begin`, `finish`, or `cancel` transaction), request-bound `herder_reignite` (which acknowledges a one-shot sibling plan write after a complete run), and `herder_plan` attention resolution (which submits request-bound answers, retries, or target-local recovery decisions). The adapter uses internal `herder_run` dispatch for manager operations and does not expose it as a Pi tool. Fire and resume start or reuse the persistent local Run Manager and its dashboard, dispatch the first available worker batch, then return. Attach is the takeover path for a new Pi session after the former session died: it derives immutable profile and parallelism from manager status, refuses a live foreign Pi owner, preserves paused or needs-input lifecycle state, and replaces only vanished built-in `pi-worker:` actions. Revise is strictly run-bound: it adopts a validated new immutable graph generation into an existing deterministic run after all active workers settle, and never serves as standalone plan authoring or splitting. A compact Pi widget and the dashboard report progress. Each admitted child prompt is also journaled as a blue, expandable transcript card, and each terminal child response is journaled as a green card (red when interrupted). Both cards identify the plan, exact model, thinking level, and service tier, so the root conversation shows the actual worker handoff and evidence instead of repeated run-state lines. These cards are TUI-only custom entries and never enter the root model context.

## Responsibility boundary

The shared deterministic Run Manager retains ownership of plan state, SQLite accounting, stable branches/worktrees, immutable assignments, review rounds, recovery, verification execution, and serialized integration. The native Pi adapter supplies fresh child sessions and their lifecycle events, and delegates final verification selection—not execution—to the main Pi session.

Three generic package agents are available for every profile:

```text
herder.plan-implementer
herder.plan-reviewer
herder.plan-judge
```

The profile supplies each exact model and Pi thinking level at launch. Before repository mutation, Herder validates the root model, requested child-model efforts, and package-owned definitions against the same Pi model runtime used for children. It never substitutes another model after failure.

## Orchestration workflow

Pi is Herder's only host. The adapter translates deterministic manager actions into native clean child sessions; it does not schedule work itself.

**Service and dashboard.** Fire, resume, revise, worker events, edits, stop, verification, and reignite acks use durable SQLite operations. A POST only validates and accepts an idempotent operation ID; clients poll short reads for its result. Reconciliation, Git integration, and verification run serially on the manager worker without holding an HTTP request, while `/health`, `/v1/status`, operation submission, and operation polling remain responsive. The latest manager reply is persisted as a snapshot, so status never queues behind heavy work. A healthy authenticated service is reused; a live but unresponsive one is waited out through a grace period and replaced only when wedged, never duplicated. Accepted operations, snapshots, and run authority survive service replacement. When Orca-owned environment markers are present, Herder asks the Orca CLI to open the loopback dashboard in the current workspace browser; it does not attempt editor-specific forwarding elsewhere. README lifecycle is a projection; Pi session entries are UI hints only.

**Worker transport.** The manager returns a batch of exact actions. For each action, the adapter creates one native Pi SDK session with:

- the exact profile-selected role agent, model, thinking level, and service tier;
- a new persisted `SessionManager` with no parent and zero inherited messages;
- the manager-owned stable worktree as `cwd`;
- the complete manager prompt and immutable assignment evidence; and
- no extensions, skills, managed temporary worktree, or second scheduler; and
- scoped parallel `Agent` and `get_subagent_result` tools for bounded foreground or background delegation.

The adapter prepares the clean sessions, returns action IDs and opaque `pi-worker:` session handles as one dispatch-results event, and starts workers only after that event is accepted. At that boundary it appends a bounded, expandable input card to the root Pi transcript; when the child settles, it appends the bounded response, duration, and token evidence as an output card before reporting the terminal event. Each completion maps directly to its action and returns token and timing evidence as one terminal event. Event operations reuse the same event and operation identities across retries; a serialized adapter queue prevents simultaneous completions from racing manager transitions. The manager applies review policy, accounting, integration, and role-agnostic slot backfill before publishing the next snapshot. Worker sessions never receive the root transcript, and transcript cards are excluded from model context.

**Scoped nested delegation.** Herder owns a narrow, one-level nested executor; it does not depend on the standalone `extensions/subagents` scheduler or telemetry bus. Each active role may run up to four direct children concurrently, with eight launches per role action. Multiple `Agent` calls in one model response execute in parallel. A call may also set `run_in_background: true`, return an ID immediately, and later retrieve or wait for the child through Herder's scoped `get_subagent_result` tool. Every background child must be collected before the role returns its final envelope; otherwise the action fails closed and outstanding children are aborted. The package-owned child types are `recon`, `searcher`, and `worker`; Reviewer and Judge parents may use `recon` and `searcher`, while Implementer may also use `worker`. `searcher` is the only extension-enabled type and loads the explicitly installed, allowlisted `npm:pi-web-access` package with only `web_search`, `source_check`, `fetch_content`, and `get_search_content` active. `recon` and `searcher` use the package-owned scout binding `gpt-5.6-luna` at `max` on the fast tier. `worker` inherits the parent action's exact model object, thinking level, and service tier. Every child inherits the stable manager-owned worktree and cancellation lifetime, while receiving a private session-storage directory. It receives a clean direct Pi SDK session with no custom `Agent` or result tool, skills, prompt templates, themes, project context files, inherited conversation, scheduling, resume, or secondary worktree, so a child cannot delegate again. Extension discovery remains disabled: only package-owned extension allowlists declared by the child type are resolved from Pi's trusted user package store, project-scoped package shadowing is rejected, and missing packages fail with an explicit `pi install` instruction. Concurrent children still share the parent action worktree. Live child status appears as one flat level beneath the parent in Herder's TUI. Terminal usage keeps parent-session tokens on the parent model and records a nested breakdown by child type and model; the dashboard implementation card shows that breakdown. The live TUI state remains ephemeral: Herder does not persist it to manager SQLite or expose it on the dashboard, and parent completion aborts and settles all remaining children before removing the tree.

**Reviewer protocol.** Every Reviewer receives the package-owned `assets/review/code-review-protocol.md` path alongside its role contract. Discovery reviews run a Claude-Code-style two-wave process within the existing eight-call budget: four parallel fresh `recon` detectors with distinct plan/scope, diff-correctness, contextual-regression, and tests/security focuses, followed by up to four fresh `recon` validation batches that attempt to falsify normalized candidates. Only independently confirmed candidates at confidence 80 or higher survive; the parent Reviewer then reopens the evidence, runs checks, applies Herder's P0/P1 and relationship rules, and returns the existing exact envelope. Later verification passes stay bounded to open findings and the repair delta. `searcher` is optional only for narrow external documentation and never substitutes for code-path evidence.

**Final verification and bounded recovery.** Herder does not scrape shell commands from plan prose. When all ordinary plans are integrated, the manager persists an exact-tree verification request and pauses. The adapter injects that request into the current main Pi conversation. The main model inspects the frozen integration worktree and calls `herder_verification` with a typed list of direct argv commands, TreeRelative working directories, and rationales. The tool returns immediately after durable submission. The manager validates every binding and path, executes the commands asynchronously, stores log hashes and results, and only then proposes the final aggregate Reviewer. If no main session is available, the request remains durably paused and is re-exposed on resume.

If an authoritative gate fails, the adapter injects a structured recovery turn containing the exact log path, failed gate, frozen head/tree, and a request-bound capability. Every failed verification request is one immutable classification episode, and the prompt displays that episode's request/hash, head/tree, and canonical gate evidence. The main session submits exactly one classification for the current episode: `manifest_error` replaces the manifest, `transient` performs one unchanged retry, `code_defect` opens a writable integration-repair transaction, and design, scope, credential, or product ambiguity records a request-bound non-mutating user-decision outcome. A newly failed successor closes the prior episode and is classified from its own evidence; history remains queryable and the prior classification is never rewritten. Only after `begin` may the owning session edit failure-related paths in the assigned integration worktree; local diagnostics are optional and non-authoritative. For a code defect, the owning session stages and creates the next bounded repair commit or amends the logical repair commit while retaining the fixed parent, confirms a clean worktree, and submits its observed `HEAD`; Herder only validates the clean single-parent commit and reruns the inherited authoritative gates. `finish` and `cancel` are request-bound, replay-safe transitions. Accepted code commits remain capped at three across episodes, manifest corrections do not consume code rounds, and an unchanged transient retry cannot reset when the head/tree/gate program is identical. Retained gates stay in their exact order, and additions must be explicit. `/herder-resume` remains operator recovery for interrupted or deliberately deferred state; ordinary deterministic integration defects no longer require graph revision. The frozen tree is otherwise never edited in place.

**Reignite write.** After exact-tree gates pass, a parseable final Reviewer report completes the original run. Residual `PLAN_REQUIREMENT` and `PATCH_REGRESSION` findings are recorded as a pending dossier. The adapter injects one `HERDER_MAIN_SESSION_REIGNITE_V1` follow-up while this session owns the source run, naming a previously unused repo-root sibling (`herder-reignite`, then `herder-reignite-2`, …). The main session writes only there with `herder_plan` `init`/`shape`/`validate`, then calls `herder_reignite` with the `graphSha256` returned by `validate`. `planDirectory` may be the source run or the allocated sibling; acknowledgement always targets the source run. Fire of the allocated directory is a separate user command. A failed or ignored write leaves the source run complete; `/herder-resume` on the source directory re-injects the same request and path. Attach still refuses `complete`.

**Path kinds.** Herder distinguishes host locations from positions inside a known tree:

- **LocationRoot** — absolute realpath host locations such as `repositoryRoot`, `planDirectory`, plan/integration worktrees under `<planDirectory>/.herder/worktrees/`, and assignment/log paths.
- **TreeRelative** — positions inside an already-known LocationRoot. Verification gate `cwd` is TreeRelative only (`"."` or a clean relative path such as `pkg`). Absolute gate `cwd` values are rejected with no compatibility rewrite; execution resolves `path.resolve(integrationWorktree, gate.cwd)`.

**Attention, concurrency, and recovery.** The adapter holds a private exclusive ownership lock for each controlled run. A live foreign Pi PID blocks attach and dispatch; a safely parsed dead owner may be reaped, while malformed, symlink, or non-regular lock state fails closed. `maxParallel` is the complete Implementer/Reviewer/Judge pool. No control slot is reserved. Reviews and judgments for one plan may overlap implementation on another; only integration is serialized in the manager service. Substantive blocked transitions create `plan_recovery`; Judge questions create `user_decision`; exhausted provider or transport handling creates `operator_attention` and resumes the recorded role without plan rewriting. Final Reviewer residuals do not wait for `user_decision`. The adapter presents exactly one durable request in deterministic plan-ID order as a typed custom follow-up message when the main session settles, acknowledges only after injection succeeds, and re-exposes it after status refresh, `/herder-resume`, or replacement. Defer leaves the request durable; a justified unchanged retry is distinct from a target-only validated replacement. Unresolved attention blocks planning mutations but never reserves a worker slot or stops unrelated scheduling. Recovery cleanup force-removes only the exact manager-owned failed worktree and branch after identity checks; SQLite attempts, generations, approvals, findings, worker responses, usage, verification evidence, logs, and the completed recovery record remain intact. Before Pi reloads, switches, forks, or exits the current session, the adapter aborts and settles its in-process children without holding shutdown open for manager reconciliation or dispatching replacements from the stale session. The replacement or later resumed session reports each vanished handle interrupted so the manager applies its transport-retry policy; a foreign or legacy engine handle fails closed instead of dispatching a competing worker. Plan edits pause resume on graph drift; `/herder-revise` adopts a validated new immutable generation once workers settle. Stop aborts active child sessions, marks their exact actions interrupted, and preserves repository evidence.

## Final verification environment

Final verification gates run with an explicit minimal environment. Command discovery (`PATH`), locale settings, and the Windows launch variables required to start ordinary commands are retained; ambient variables are not inherited. In particular, credential variables and ambient configuration are unavailable to deterministic gates.

Each gate receives a fresh private state root under the external verification log directory. `HOME`, XDG configuration/data/cache/state/runtime paths, platform home and application-data paths, and temporary directories point into that root. The root is removed after the gate evidence is finalized, while the mode-`0600` log and its hashes are preserved.

Credential-backed verification is unsupported until it has a separate safe contract. Gate logs are not raw-log-redacted; artifact sanitization is a separate responsibility.
