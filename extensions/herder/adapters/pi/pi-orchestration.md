# Herder runtime for Pi

Pi is Herder's only host. The extension translates deterministic manager actions into native clean child sessions; it does not schedule work itself.

## Process and dashboard

Every `/herder-fire`, `/herder-resume`, or `/herder-revise` call checks the authenticated service identity stored in the plan directory's existing SQLite database. It reuses a healthy process or starts a detached replacement. The service starts the loopback read-only dashboard on an ephemeral port and requests the available VS Code or Orca host integration.

The service can disappear without losing run authority. A replacement reconstructs state from SQLite generations and phases, exact Git refs/branches/worktrees/leases, and immutable assignments. README lifecycle is a projection. Pi session entries are UI hints only.

## Planning workflows

`/herder-improve`, `/herder-grill`, and `/herder-validate` create a new parentless root session and inject the exact package-owned skill with its arguments. Namespaced equivalents remain available through Pi's standard `/skill:herder-<name>` surface. Planning-session replacement is rejected while the current Pi session owns an active Fire run.

`/herder-plans` parses deterministic init, validate, shape, status, ready, snapshot, report, track, and untrack subcommands and delegates them directly to the shared application layer without a model turn. Mutating configuration operations are rejected during an active run. The native `herder_plan` tool exposes those same canonical operations to the active model.

## Worker transport

The manager returns a batch of exact actions. For each action, the extension creates one native Pi SDK session with:

- the exact profile-selected role agent, model, and thinking level;
- a new persisted `SessionManager` with no parent and zero inherited messages;
- the manager-owned stable worktree as `cwd`;
- the complete manager prompt and immutable assignment evidence; and
- no extensions, skills, nested agents, managed temporary worktree, or second scheduler.

The extension prepares the clean sessions, returns action IDs and opaque `pi-worker:` session handles to the manager as one dispatch-results event, and starts them only after that event is accepted. It maps completion directly to the action, records Pi session token/timing evidence, and sends one terminal event. A serialized adapter queue prevents simultaneous completions from racing manager transitions. The manager applies gates, review policy, accounting, integration, and immediate role-agnostic slot backfill before returning the next batch.

Worker sessions never receive the root transcript. In particular, no structured tool-call history is copied or sanitized for CLIProxyAPI-compatible providers.

## Concurrency and recovery

`maxParallel` is the complete Implementer/Reviewer/Judge pool. No control slot is reserved. Reviews and judgments for one plan may overlap implementation on another; only integration is serialized in the manager service.

On Pi session restart, the extension reloads the manager run ID and calls the service status endpoint. An in-process worker handle that is no longer present is reported as interrupted so the manager applies its normal transport-retry policy. A foreign or legacy engine handle fails closed instead of dispatching a competing worker.

If plan content or dependencies change, normal resume pauses on graph drift. Once no worker is active, `/herder-revise` validates the edit and creates a generation-specific RUN assignment. It may add plans or revise only plans that have never started; it cannot remove or rewrite executed plans.

Stopping Herder aborts active child sessions, marks their exact actions interrupted, and preserves repository evidence. The service and dashboard may remain available for status until explicitly shut down.
