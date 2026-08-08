# Herder for Pi

Herder is a native Pi extension package with package-owned planning skills.

## Install

```sh
pi install git:github.com/minhuw/pi-extensions
```

Use `pi install /absolute/path/to/pi-extensions` while developing this checkout. No separate subagent package is required.

Start Pi with the root model and thinking level required by the chosen profile:

```text
pi --model <provider>/kimi-k3 --thinking max
/herder-fire herder-plans --profile poorman
```

Available commands:

- `/herder-improve [quick|standard|deep] [focus]`
- `/herder-grill <change-description>`
- `/herder-plans init [plan-dir] [--track]`
- `/herder-plans validate|shape|status|ready [plan-dir]`
- `/herder-plans snapshot <plan-id> [plan-dir]`
- `/herder-plans report <plan-id|RUN> [plan-dir]`
- `/herder-plans track|untrack [plan-dir]`
- `/herder-validate [plan-dir] [--fix]`
- `/herder-fire [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-resume [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-revise [plan-dir] [--profile name] [--dashboard-port n]`
- `/herder-status [plan-dir]`
- `/herder-dashboard [plan-dir]`
- `/herder-stop`

The agentic planning commands—`/herder-improve`, `/herder-grill`, and `/herder-validate`—inject the exact package-owned instructions plus the supplied arguments into the current Pi session. The skill files are command-owned implementation assets rather than separately exposed `/skill:` commands.

`/herder-plans` is the fast deterministic surface: it parses typed subcommands and calls the shared plan application directly without spending a model turn. `validate` there is mechanical graph validation; `/herder-validate` is the repository-aware semantic audit and optional repair workflow. Mutating plan-configuration operations refuse to run while the current Pi session owns an active Fire run. The active model receives the same native `herder_plan` tool for canonical plan operations.

`/herder-grill --plan <id>` is the narrow active-Fire exception. The manager must prove the plan has no runtime, action, attempt, worktree, or approval evidence before reserving it. While Grill interviews and edits, only that plan is withheld from scheduling. Finishing the edit raises a revision barrier: existing workers settle, no new workers dispatch, the validated target-only change becomes the next immutable graph generation, and scheduling resumes. Cancelling without changes releases the reservation.

The `herder` tool exposes fire, resume, revise, status, and dashboard actions to the active Pi model. Fire and resume start or reuse the persistent local Run Manager and its dashboard, dispatch the first available worker batch, then return. Revise adopts a validated new immutable graph generation after all active workers settle. A compact Pi widget and the dashboard report progress.

## Responsibility boundary

The shared deterministic Run Manager retains ownership of plan state, SQLite accounting, stable branches/worktrees, immutable assignments, review rounds, recovery, gates, and serialized integration. The native Pi adapter supplies only fresh child sessions and their lifecycle events.

Three generic package agents are available for every profile:

```text
herder.plan-implementer
herder.plan-reviewer
herder.plan-judge
```

The profile supplies each exact model and Pi thinking level at launch. Before repository mutation, Herder validates the root model, requested child-model efforts, and package-owned definitions against the same Pi model runtime used for children. It never substitutes another model after failure.

## Orchestration workflow

Pi is Herder's only host. The adapter translates deterministic manager actions into native clean child sessions; it does not schedule work itself.

**Service and dashboard.** Fire, resume, and revise check the authenticated service identity stored in the plan directory's SQLite database. A healthy service is reused; a live but unresponsive one is waited out through a grace period and replaced only when wedged, never duplicated. The service runs the manager core on a worker thread, so loopback health stays responsive during reconciliation, and starts the read-only dashboard on an ephemeral port. The service can disappear without losing run authority: a replacement reconstructs state from SQLite generations and phases, exact Git refs, worktrees, leases, and immutable assignments. README lifecycle is a projection; Pi session entries are UI hints only.

**Worker transport.** The manager returns a batch of exact actions. For each action, the adapter creates one native Pi SDK session with:

- the exact profile-selected role agent, model, thinking level, and service tier;
- a new persisted `SessionManager` with no parent and zero inherited messages;
- the manager-owned stable worktree as `cwd`;
- the complete manager prompt and immutable assignment evidence; and
- no extensions, skills, nested agents, managed temporary worktree, or second scheduler.

The adapter prepares the clean sessions, returns action IDs and opaque `pi-worker:` session handles as one dispatch-results event, and starts workers only after that event is accepted. Each completion maps directly to its action and returns token and timing evidence as one terminal event. Event posts retry transport failures with backoff while reusing the same event ID, because the manager dedupes exact replays; a serialized adapter queue prevents simultaneous completions from racing manager transitions. The manager applies gates, review policy, accounting, integration, and role-agnostic slot backfill before returning the next batch. Worker sessions never receive the root transcript.

**Concurrency and recovery.** `maxParallel` is the complete Implementer/Reviewer/Judge pool. No control slot is reserved. Reviews and judgments for one plan may overlap implementation on another; only integration is serialized in the manager service. On Pi session restart, an in-process worker handle that vanished is reported as interrupted so the manager applies its transport-retry policy; a foreign or legacy engine handle fails closed instead of dispatching a competing worker. Plan edits pause resume on graph drift; `/herder-revise` adopts a validated new immutable generation once workers settle. Stop aborts active child sessions, marks their exact actions interrupted, and preserves repository evidence.
