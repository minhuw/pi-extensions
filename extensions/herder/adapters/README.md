# Herder for Pi

Herder is a native Pi extension package with package-owned planning skills.

## Install

See the [canonical installation and quickstart](../README.md#install) in the package README. For an adapter-specific profile example:

```text
pi --model <provider>/gpt-5.6-luna --thinking max
/herder-fire herder-plans --profile poorman
```

User-facing commands, planning behavior, run control, and lifecycle summaries are authoritative in the package README's [canonical planning and execution command reference](../README.md#planning-and-execution-commands). This document continues with the detailed Pi adapter and runtime contract.

### Active-Fire plan editing

The package README's [canonical planning and execution command reference](../README.md#planning-and-execution-commands) summarizes this user-facing contract; this section owns its reservation and revision-barrier mechanics. During an active Fire run, the adapter refuses mutating plan-configuration operations (`/herder-plans init`, `track`, and `untrack`) for the current session. `/herder-grill --plan <id>` is accepted only after the manager proves the target has no runtime, action, attempt, worktree, or approval evidence. The reservation withholds only that plan from scheduling, so unrelated work continues. After the confirmed target-local edit, the adapter raises a revision barrier: it stops new dispatches, waits for existing workers to settle, adopts the validated target-only change as the next immutable graph generation, and resumes scheduling automatically. Cancelling without changes releases the reservation. Explicit `--split` is rejected before reservation because active-Fire edit authority is target-local; finish or stop Fire before running the split standalone. `/herder-rework <plan-id>` is the started-plan counterpart: it reserves a blocked or exhausted non-integrated plan and injects Grill before any deletion. On model-requested finish, the adapter prepares the rewrite, presents the destructive host confirmation, records approval, settles only the target's workers, and then resets that plan's exact worktree, branch, and transient refs before recreating it from the current integration HEAD at round 1. Declining confirmation or cancelling Grill restores the pre-interview graph and leaves existing execution untouched; validation failure stops before worker settlement. Integrated plans and plans with active or integrated downstream consumers are refused.

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

### Service and dashboard

Fire, resume, revise, worker events, edits, stop, verification, and reignite acks use durable SQLite operations. A POST only validates and accepts an idempotent operation ID; clients poll short reads for its result. Reconciliation, Git integration, and verification run serially on the manager worker without holding an HTTP request, while `/health`, `/v1/status`, operation submission, and operation polling remain responsive. The latest manager reply is persisted as a snapshot, so status never queues behind heavy work. A healthy authenticated service is reused; a live but unresponsive one is waited out through a grace period and replaced only when wedged, never duplicated. Accepted operations, snapshots, and run authority survive service replacement. When Orca-owned environment markers are present, Herder asks the Orca CLI to open the loopback dashboard in the current workspace browser; it does not attempt editor-specific forwarding elsewhere. In non-Orca terminals, the adapter reports the loopback dashboard URL without host-specific forwarding. README lifecycle is a projection; Pi session entries are UI hints only.

### Worker transport

The manager returns a batch of exact actions. For each action, the adapter creates one native Pi SDK session with:

- the exact profile-selected role agent, model, thinking level, and service tier;
- a new persisted `SessionManager` with no parent and zero inherited messages;
- the manager-owned stable worktree as `cwd`;
- the complete manager prompt and immutable assignment evidence; and
- FFF's exact `npm:@ff-labs/pi-fff` package from Pi's trusted user npm store for every role, plus Ponytail's exact `pi-extension/index.js` from Pi's trusted user Git store only for Implementers, with no ambient/project discovery or extension skills, prompts, or themes;
- no managed temporary worktree or second scheduler; and
- scoped parallel `Agent` and `get_subagent_result` tools for bounded foreground or background delegation.

The adapter prepares the clean sessions, returns action IDs and opaque `pi-worker:` session handles as one dispatch-results event, and starts workers only after that event is accepted. At that boundary it appends a bounded, expandable blue input card to the root Pi transcript; when the child settles, it appends a bounded, expandable green output card, or a red interrupted-output card, carrying the plan, exact model, thinking level, service tier, response, duration, and token evidence before reporting the terminal event. Each completion maps directly to its action and returns token and timing evidence as one terminal event. Event operations reuse the same event and operation identities across retries; a serialized adapter queue prevents simultaneous completions from racing manager transitions. The manager applies review policy, accounting, integration, and role-agnostic slot backfill before publishing the next snapshot. Worker sessions never receive the root transcript, and transcript cards are excluded from model context.

### Scoped nested delegation

Herder owns a bounded nested executor, independent of the standalone `extensions/subagents` scheduler and telemetry bus. Each root role may run up to four direct children concurrently, with eight launches per action. Multiple `Agent` calls in one model response execute in parallel; `run_in_background: true` returns an ID while the caller continues.

The package-owned types are `recon`, `searcher`, `worker`, and `reviewer`:

- **Recon** is a strictly read-only source navigator: read, FFF-backed path/content search, and ls. Initial capability triage returns `HANDOFF_REQUIRED` immediately for runtime, implementation, or general-review objectives. Supported questions return `ANSWERED` or early `PARTIAL` when static sources are exhausted or a tool mismatch emerges, with `ANSWER`, `EVIDENCE`, and `REMAINING`. A useful early handoff is success. Recon has a fixed hard one-hour wall-clock deadline including setup, compaction, and retries. Expiry requests session cancellation and returns `timed_out` with any available partial output after at most a five-second cleanup grace; partial output is incomplete evidence. The caller owns continuation, with no automatic unchanged relaunch.
- **Searcher** is a strictly read-only leaf, primarily remote web research with FFF only for explicitly delegated local evidence. It additionally loads `npm:pi-web-access`.
- **Worker** may mutate and is available only to Implementer. It additionally loads Ponytail's exact trusted user-Git `pi-extension/index.js`, which adds instructions but no LLM tools. Cancellation retains ownership until its setup, prompt, and cleanup settle; the bounded scout cleanup policy never releases a still-mutating worker's worktree.
- **Reviewer** is available only under root plan-reviewer. It inherits that parent's exact model, thinking level, and service tier; loads FFF only; and has exactly read, bash, ffgrep, fffind, ls, Agent, and get_subagent_result. Its unrestricted bash makes `readOnly: false` honest: source preservation is a behavioral contract, not a sandbox. Targeted safe reproductions use external scratch for writes and avoid source/plan edits or mutation of the shared frozen worktree. Each reviewer may optionally launch only recon leaves, at most one concurrently and two total per subreview. Cancellation waits for the reviewer's Bash-capable session to settle before releasing the worktree; its recon leaf still has bounded cancellation. There is no general recursive agent.

Root Reviewer and Judge retain direct recon/searcher access; Implementer also retains worker access. Recon and searcher keep the package-owned scout binding `gpt-5.6-luna` at `max` on the fast tier; worker inherits its parent action binding. All leaves lack Agent/result tools and cannot recurse. Every child loads the explicitly installed, allowlisted `npm:@ff-labs/pi-fff` package, shares the stable manager-owned worktree and cancellation lifetime, and receives a clean direct Pi SDK session with a private session-storage directory. Children have no inherited conversation, extension skills, prompt templates, themes, project context files, scheduling, resume, or secondary worktree. Only reviewer receives scoped Agent/result tools for its recon leaves. Extension discovery stays disabled; exact trusted user package paths are required, project-scoped shadowing is rejected, and missing packages fail with an explicit `pi install` instruction.

Collect every background direct result before the caller returns, including terminal timeout/error results. `get_subagent_result` accepts `wait_any: true` for the first uncollected background direct result or `agent_id` for a specific child, mutually exclusively; omitting both lists direct children. Waiting defaults to true for either selector. Each wait is bounded to 60 seconds and then returns running without cancelling the child. When idle, wait again rather than short-polling or issuing a parallel all-results barrier. Collection is caller-driven, not an automatic LLM push notification. Uncollected children fail the action closed; reviewer uncollected grandchildren also fail closed. Stops and parent completion cascade abort/settlement through the tree.

The live TUI tree is ephemeral and includes both reviewer and recon levels. Grandchildren use compact inline activity, tool-count, token, and elapsed-time rows, omitting repeated model/thinking/tier and context statistics; failed scouts remain visible after their reviewer completes. It is not persisted to manager SQLite or exposed on the dashboard; parent completion removes it after settlement. Terminal usage counts every descendant exactly once, keeping parent-session tokens on the parent model and a breakdown by nested type/model; the dashboard implementation card shows that breakdown. Parent and nested extension sessions bind noninteractively before prompting and emit `session_shutdown` before disposal.

### Reviewer protocol

Every root Reviewer receives `assets/review/code-review-protocol.md` alongside its role contract. The parent verifies the compiled assignment/hash and frozen authority, then sends self-contained relevant packets; children never need coordinator checkout or source-plan authority.

Discovery and final aggregate audits launch four parallel fresh `reviewer` children with primary explicit hunk/subsystem ownership and named cross-boundary questions. Plan/rules/scope, diff correctness, contextual regression, and tests/trust boundaries remain four coverage lenses, not four redundant whole audits. Each child reviews its assigned area, may run targeted safe bash reproductions, and may ask optional recon leaves for bounded source navigation. The parent runs required shared gates once. The eight-call root budget allows optional targeted fresh reviewer second opinions, not a mandatory second discovery wave.

Children return evidence-backed proposed findings plus explicit unresolved questions and coverage. Missing proof is handed to the parent, neither silently rejected nor promoted; child confidence scores are not an admission gate. The parent independently verifies surviving merged claims, reconciles coverage, applies unchanged final evidence-completeness, severity, relationship, and repair rules, and returns the exact manager terminal envelope. A runtime timeout is neither a code defect nor approval evidence: the parent completes unfinished mandatory review/checks or returns `BLOCK` if genuinely unable. Later verification stays bounded to ledger/open IDs and the repair delta. Root recon/searcher lookups remain optional evidence helpers, never substitutes for actual reviewers or parent code-path verification.

### Final verification and bounded recovery

Herder does not scrape shell commands from plan prose. When all ordinary plans are integrated, the manager persists an exact-tree verification request and pauses. The adapter injects that request into the current main Pi conversation. The main model inspects the frozen integration worktree and selects the smallest adequate non-redundant manifest of direct argv commands, each with a TreeRelative working directory and rationale, then calls `herder_verification`. The tool returns immediately after durable submission. The manager validates every binding and path, executes the commands asynchronously, stores log hashes and results, and only then proposes the final aggregate Reviewer. If no main session is available, the request remains durably paused and is re-exposed on resume.

If an authoritative gate fails, the adapter injects a structured recovery turn containing the exact log path, failed gate, frozen head/tree, and a request-bound capability. Every failed verification request is one immutable classification episode, and the prompt displays that episode's request/hash, head/tree, and canonical gate evidence. The main session submits exactly one classification for the current episode: `manifest_error` replaces the manifest, `transient` performs one unchanged retry, `code_defect` opens a writable integration-repair transaction, and design, scope, credential, or product ambiguity records a request-bound non-mutating user-decision outcome. A newly failed successor closes the prior episode and is classified from its own evidence; history remains queryable and the prior classification is never rewritten. Only after `begin` may the owning session edit failure-related paths in the assigned integration worktree; local diagnostics are optional and non-authoritative. For a code defect, the owning session stages and creates the next bounded repair commit or amends the logical repair commit while retaining the fixed parent, confirms a clean worktree, and submits its observed `HEAD`; Herder only validates the clean single-parent commit and reruns the inherited authoritative gates. `finish` and `cancel` are request-bound, replay-safe transitions. Accepted code commits remain capped at three across episodes, manifest corrections do not consume code rounds, and an unchanged transient retry cannot reset when the head/tree/gate program is identical. Retained gates stay in their exact order, and additions must be explicit. `/herder-resume` remains operator recovery for interrupted or deliberately deferred state; ordinary deterministic integration defects no longer require graph revision. The frozen tree is otherwise never edited in place.

### Reignite write

After exact-tree gates pass, a parseable final Reviewer report completes the original run. Residual `PLAN_REQUIREMENT` and `PATCH_REGRESSION` findings are recorded as a pending dossier. The adapter injects one `HERDER_MAIN_SESSION_REIGNITE_V1` follow-up while this session owns the source run, naming a previously unused repo-root sibling (`herder-reignite`, then `herder-reignite-2`, …). The main session writes only there with `herder_plan` `init`/`shape`/`validate`, then calls `herder_reignite` with the `graphSha256` returned by `validate`. `planDirectory` may be the source run or the allocated sibling; acknowledgement always targets the source run. Fire of the allocated directory is a separate user command. A failed or ignored write leaves the source run complete; `/herder-resume` on the source directory re-injects the same request and path. Attach still refuses `complete`.

### Path kinds

Herder distinguishes host locations from positions inside a known tree:

- **LocationRoot** — absolute realpath host locations such as `repositoryRoot`, `planDirectory`, plan/integration worktrees under `<planDirectory>/.herder/worktrees/`, and assignment/log paths.
- **TreeRelative** — positions inside an already-known LocationRoot. Verification gate `cwd` is TreeRelative only (`"."` or a clean relative path such as `pkg`). Absolute gate `cwd` values are rejected with no compatibility rewrite; execution resolves `path.resolve(integrationWorktree, gate.cwd)`.

### Attention, concurrency, and recovery

The adapter holds a private exclusive ownership lock for each controlled run. A live foreign Pi PID blocks attach and dispatch; a safely parsed dead owner may be reaped, while malformed, symlink, or non-regular lock state fails closed. `maxParallel` is the complete Implementer/Reviewer/Judge pool. No control slot is reserved. Reviews and judgments for one plan may overlap implementation on another; only integration is serialized in the manager service. Substantive blocked transitions create `plan_recovery`; Judge questions create `user_decision`; exhausted provider or transport handling creates `operator_attention` and resumes the recorded role without plan rewriting. Final Reviewer residuals do not wait for `user_decision`. The adapter presents exactly one durable request in deterministic plan-ID order as a typed custom follow-up message when the main session settles, acknowledges only after injection succeeds, and re-exposes it after status refresh, `/herder-resume`, or replacement. Answers carry the request ID and decision; the adapter binds immutable request and recovery Git evidence. `plan_recovery` keeps the Grill one-question and final-confirmation guarantees; it permits a justified unchanged retry, distinct from a target-only validated replacement, and edits only the confirmed target plan. Defer leaves the request durable. After an unchanged retry, validated replacement, or rejection, the manager reschedules the recorded continuation. `/herder-resume` re-exposes unresolved requests after a reload. Unresolved attention blocks planning mutations but never reserves a worker slot or stops unrelated scheduling. Recovery cleanup force-removes only the exact manager-owned failed worktree and branch after identity checks; SQLite attempts, generations, approvals, findings, worker responses, usage, verification evidence, logs, and the completed recovery record remain intact. Before Pi reloads, switches, forks, or exits the current session, the adapter aborts and settles its in-process children without holding shutdown open for manager reconciliation or dispatching replacements from the stale session. The replacement or later resumed session reports each vanished handle interrupted so the manager applies its transport-retry policy; a foreign or legacy engine handle fails closed instead of dispatching a competing worker. Plan edits pause resume on graph drift; `/herder-revise` adopts a validated new immutable generation once workers settle. Stop aborts active child sessions, marks their exact actions interrupted, and preserves repository evidence.

## Final verification environment

Final verification gates run with an explicit minimal environment. Command discovery (`PATH`), locale settings, and the Windows launch variables required to start ordinary commands are retained; ambient variables are not inherited. In particular, credential variables and ambient configuration are unavailable to deterministic gates.

Each gate receives a fresh private state root under the external verification log directory. `HOME`, XDG configuration/data/cache/state/runtime paths, platform home and application-data paths, and temporary directories point into that root. The root is removed after the gate evidence is finalized, while the mode-`0600` log and its hashes are preserved.

Child stdout and stderr are drained into one combined log with a fixed 16777216-byte child-output cap. On overflow, the runner appends `\n[herder] gate log truncated at 16777216 bytes\n` exactly once outside that cap and reports `logTruncated: true`; `logBytes` and `logSha256` describe the final on-disk bytes, including the marker. Under-limit single-stream bytes remain unchanged, but pipe capture may change undocumented cross-stream interleaving.

Credential-backed verification is unsupported until it has a separate safe contract. Gate logs are not raw-log-redacted; artifact sanitization is a separate responsibility.
