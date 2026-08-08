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

The extension translates manager actions directly into Implementer, Reviewer, and Judge child sessions and sends their terminal evidence back to the service. The manager backfills the global pool as soon as any role finishes. Each plan keeps one Herder-owned branch/worktree; the worker engine never creates another worktree or branch. Only integration is globally serialized.

Three generic package agents are available for every profile:

```text
herder.plan-implementer
herder.plan-reviewer
herder.plan-judge
```

The profile supplies each exact model and Pi thinking level at launch. Before repository mutation, Herder validates the root model, requested child-model efforts, and package-owned definitions against the same Pi model runtime used for children. It never substitutes another model after failure.
