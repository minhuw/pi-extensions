# Herder

Herder is Pi's deterministic multi-agent plan runner. It turns a validated dependency graph into isolated Implementer and Reviewer pipelines, persists scheduling and proof state in SQLite and Git, and integrates only changes with exact independent approval evidence.

This is the maintained Herder implementation. The former standalone `minhuw/herder` package and its Codex and Claude Code adapters are deprecated.

## Commands

- `/herder-improve`, `/herder-grill`, and `/herder-validate` start clean Pi planning sessions backed by package-owned skills.
- `/herder-plans` runs deterministic plan operations directly: init, validate, shape, status, ready, snapshot, report, track, and untrack.
- `/herder-fire`, `/herder-resume`, `/herder-revise` control execution.
- `/herder-status`, `/herder-dashboard`, `/herder-stop` inspect or stop a run.

Agentic planning commands replace the active root with a parentless session containing the exact packaged skill. Deterministic plan operations execute immediately through the native `herder_plan` application tool. Fire uses Pi-native clean worker sessions with no inherited transcript or nested extension runtime.

## Profiles

- `eclipse`: Sol orchestrator, Luna implementer, Sol reviewer and judge.
- `shannon`: Claude models for the orchestrator and workers.
- `offcut`: Kimi orchestrator, Grok implementer, Sol reviewer and judge.

Herder does not provide models. A profile starts only when Pi's active provider exposes every exact model and requested thinking level.

See [Pi orchestration](adapters/pi/pi-orchestration.md) for the runtime contract.
