# Herder

Herder is Pi's deterministic multi-agent plan runner. It turns a validated Markdown dependency graph into concurrent Implementer and Reviewer pipelines, persists scheduling and proof state in SQLite and Git, and integrates only work backed by exact independent approval evidence.

This is the maintained, Pi-first Herder implementation. The former standalone `minhuw/herder` package and its Codex and Claude Code adapters are deprecated.

## Install

Install the extension collection and explicitly injected role extensions:

```bash
pi install git:github.com/minhuw/pi-extensions
pi install git:github.com/DietrichGebert/ponytail
pi install npm:@ff-labs/pi-fff
```

For development, install this repository by absolute path. No separate subagent package is required.

Node >=22.19.0 is required for supported Pi versions, built-in `node:sqlite`, and native TypeScript execution.

Each execution profile binds exact root and worker models. Start Pi with the selected profile's orchestrator model and thinking level, then fire a validated plan directory:

```text
pi --model <provider>/gpt-5.6-sol --thinking xhigh
/herder-fire herder-plans --profile eclipse
```

Herder refuses to start when Pi's active providers cannot resolve every required model and thinking level. It never substitutes a different model after failure.

## What Herder owns

- Dependency-aware scheduling with a configurable global worker limit.
- Clean, parentless Pi worker sessions: Implementers and their nested `worker` children explicitly load only Ponytail's `pi-extension/index.js`, while Reviewers and Judges remain extension-free.
- A package-owned, one-level nested executor for bounded delegation; nested `recon` loads no extension and nested `searcher` loads only `npm:pi-web-access`. See [Scoped nested delegation](adapters/README.md#scoped-nested-delegation) for its child limits and transport contract.
- One stable Herder branch and isolated Git worktree per plan, stored under `<plan-dir>/.herder/worktrees/` so they stay inside the plan set.
- Immutable worker assignments, review rounds, completion proofs, and exact-tree verification evidence.
- Persistent SQLite accounting, crash recovery, and resumable runs.
- Serialized integration after independent review, while unrelated worker pipelines continue concurrently.
- A compact Pi progress widget, expandable blue/green worker input/output cards, and a read-only local dashboard.

For the internal division between the deterministic Run Manager and Pi adapter, see [Responsibility boundary](adapters/README.md#responsibility-boundary). Plan Markdown is never parsed as executable configuration; after integration, the main Pi session selects the smallest adequate, non-redundant verification manifest for the frozen tree, and the manager alone executes and records it. See [Final verification and bounded recovery](adapters/README.md#final-verification-and-bounded-recovery) for the post-integration verification and repair contract.

## Planning and execution commands

| Command | Purpose |
| --- | --- |
| `/herder-grill <change>` | Clarify product intent and create a focused validated plan graph in the current session. |
| `/herder-grill --plan <id-or-path> [--plan-dir <dir>]` | Standalone, refine a TODO or decision-blocked plan and split it into a focused dependency-aware plan set when shaping requires it; during Fire, only a target-local unstarted-plan edit is allowed. |
| `/herder-grill --plan <id-or-path> --split [--plan-dir <dir>]` | Explicitly request/elevate a standalone graph split; rejected during active Fire. |
| `/herder-improve [quick\|standard\|deep] [focus]` | Audit the repository and write prioritized improvement plans. |
| `/herder-simplify [quick\|standard\|deep] [focus-or-path]` | Find safe codebase reductions and write prioritized simplification plans. |
| `/herder-validate [plan-dir] [--fix]` | Run a repository-aware semantic plan audit and conservative repair workflow. |
| `/herder-plans init [plan-dir] [--track]` | Initialize a plan directory. |
| `/herder-plans validate\|shape\|status\|ready [plan-dir]` | Run immediate deterministic plan-graph operations. |
| `/herder-plans snapshot <plan-id> [plan-dir]` | Refresh a plan's tracked file snapshot. |
| `/herder-plans report <plan-id\|RUN> [plan-dir]` | Report plan or run state. |
| `/herder-plans track\|untrack [plan-dir]` | Change plan-directory tracking policy. |
| `/herder-fire [plan-dir] [options]` | Validate and start a new run. |
| `/herder-attach [plan-dir] [--dashboard-port n]` | Safely take over an active run after its former Pi session died, without resuming paused lifecycle state. |
| `/herder-resume [plan-dir] [options]` | Recover and continue an existing run. |
| `/herder-revise [plan-dir] [options]` | Run-bound only: adopt a newly validated immutable graph generation into an existing deterministic run after active workers settle. |
| `/herder-status [plan-dir]` | Show current run status in Pi. |
| `/herder-dashboard [plan-dir]` | Open or report the read-only dashboard. |
| `/herder-cleanup [plan-dir] [--plan id] [--include-failed]` | Preview and confirm ordinary cleanup of eligible plan worktrees/branches while preserving integration, coordination refs, and plans. |
| `/herder-reset [plan-dir]` | Reset an unmerged Herder plan set to its pre-initialized execution state while preserving plan Markdown and tracking setup. |
| `/herder-cleanup [plan-dir] --deep [--include-failed]` | Destructively remove a fully terminal plan set after proving integration is merged into the current branch and all owned worktrees are safe. |
| `/herder-cleanup [plan-dir] --force` | Unconditionally stop the run and delete that plan set's files, worktrees, branches, and coordination refs. Ignores terminality, proofs, and dirty worktrees. Cannot be undone. |
| `/herder-stop` | Stop the active run owned by the current Pi session. |

Fire, resume, and revise accept `--profile <name>` and `--dashboard-port <port>`; fire and resume also accept `--max-parallel <count>`. Attach accepts only `--dashboard-port`, derives the immutable profile and parallelism from manager status, and refuses takeover while another live Pi process owns the run.

All run control is user-invoked through the slash commands above. `/herder-cleanup` remains command-only, and the active model has no run-control tool. Ordinary cleanup preserves the integration branch/worktree, coordination refs, and plan directory; `--include-failed` additionally selects BLOCKED/REJECTED evidence. `/herder-reset` restores pre-initialized execution state but refuses merged or unsafe namespaces, including unknown or moved namespaces, preserving plan Markdown and tracking setup. Plan-set-level `--deep` removes those preserved resources and the plan directory after a fail-closed preview that still requires a terminal run, reachable completion proofs, and merge ancestry; it performs final terminality, merge-ancestry, current-branch, integration-worktree, and ordinary-eligibility revalidation under service exclusion before removing the plan directory last. `--force` is the last-resort destroyer: it stops a live run if needed, then deletes the plan directory, owned worktrees, `herder/<plan>/` branches, and `refs/plan-herder/<plan>/` refs without those proofs. It still refuses to delete the current checkout. The removed `--finalize` and `--handoff-target` modes are rejected with guidance to use `--deep` or `--force`. The model-facing Herder surfaces are planning-only `herder_plan` (including request-bound attention resolution), request-bound `herder_verification`, request-bound `herder_integration_repair` (classification plus `begin`, `finish`, or `cancel` only), and request-bound `herder_reignite`; the adapter uses internal `herder_run` dispatch for manager operations and does not expose it as a model tool. The agentic planning commands inject the exact package-owned instructions and supplied arguments into the current Pi conversation, preserving the user's context. The instruction files remain private implementation assets, so each workflow has one public `/herder-*` command. `/herder-plans` is the fast deterministic surface: it parses typed subcommands and calls the native `herder_plan` application tool without spending a model turn. Mechanical `/herder-plans validate` and semantic `/herder-validate` are intentionally separate.

While the current Pi session owns an active Fire run, Improve, Simplify, graph-wide planning mutations, and the mutating `/herder-plans init`, `track`, and `untrack` commands are refused. The active-Fire `/herder-grill --plan <id>` path is limited to a target-local edit for a plan SQLite proves has never started; explicit `--split` is rejected. See [Active-Fire plan editing](adapters/README.md#active-fire-plan-editing) for reservation and revision-barrier mechanics. Outside Fire, ordinary `--plan` refinement may split when shaping requires it, and `--split` makes that intent explicit; Grill may update the target, directly affected siblings, index, dependencies, and shared context only as needed to preserve the decomposed objective and downstream guarantee. `/herder-revise` never authors or splits a standalone plan: it only adopts validated graph changes into an existing deterministic run.

Blocked-plan recovery and input waits are durable main-session attention requests. Substantive failures use `plan_recovery`, which may authorize a confirmed target-local `revise`; Judge questions use `user_decision`; exhausted provider or transport handling uses `operator_attention`, which never authorizes plan rewriting. A parseable final Reviewer report completes the original run. See [Attention, concurrency, and recovery](adapters/README.md#attention-concurrency-and-recovery) for request binding, interview and confirmation, continuation scheduling, and cleanup mechanics.

## Profiles

| Profile | Role intent |
| --- | --- |
| `eclipse` (default) | Sol orchestrates, reviews, and judges while Luna implements. |
| `poorman` | Luna orchestrates, reviews, and judges while DeepSeek implements. |
| `epic` | Fable orchestrates and judges, Opus implements, and Sol reviews. |
| `lightspeed` | Grok 4.6 orchestrates and implements while Luna reviews and judges. |

Exact model, effort, and service-tier bindings live in `assets/profiles/profiles.json` and are resolved by the runtime.

Profiles configure three generic package roles: `herder.plan-implementer`, `herder.plan-reviewer`, and `herder.plan-judge`.

## Runtime model

Fire and resume start or reuse Herder's persistent local Run Manager, launch the read-only dashboard, dispatch the first eligible worker batch, and return control to the root session. Attach claims an unowned or stale-owned active run, preserves `running`, `paused`, or `needs_input`, and deterministically replaces vanished built-in Pi workers. Revise adopts a validated immutable graph generation after active workers settle. In an Orca-managed terminal, Herder automatically opens the loopback dashboard through Orca's workspace browser; other terminals receive the local URL without host-specific forwarding. As workers finish, the manager backfills the global pool, advances review rounds, and integrates approved plans in dependency order. Pi journals each admitted worker prompt in a blue expandable card and each returned response in a green card (red on interruption); cards identify the plan, exact model, thinking level, and service tier, and do not enlarge the root model context. See [Orchestration workflow](adapters/README.md#orchestration-workflow) for service, dashboard, and transport mechanics.

Reviewers use Herder's high-signal, two-wave protocol; see [Reviewer protocol](adapters/README.md#reviewer-protocol) for discovery, validation, and evidence rules.

After ordinary plans integrate, Herder uses exact-tree verification and bounded recovery before the final Reviewer; see [Final verification and bounded recovery](adapters/README.md#final-verification-and-bounded-recovery) for the structured manifest, request-bound gate, and repair episodes. A parseable final Reviewer report completes the original run. Residual `PLAN_REQUIREMENT` and `PATCH_REGRESSION` findings are handed off through a sibling `herder-reignite` plan; see [Reignite write](adapters/README.md#reignite-write) for that handoff.

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
