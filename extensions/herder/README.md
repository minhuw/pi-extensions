# Herder

Herder is Pi's deterministic multi-agent plan runner. It turns a validated Markdown dependency graph into concurrent Implementer and Reviewer pipelines, persists scheduling and proof state in SQLite and Git, and integrates only work backed by exact independent approval evidence.

This is the maintained, Pi-first Herder implementation. The former standalone `minhuw/herder` package and its Codex and Claude Code adapters are deprecated.

## Install

Install the extension collection:

```bash
pi install git:github.com/minhuw/pi-extensions
```

For development, install this repository by absolute path. No separate subagent package is required.

Each execution profile binds exact root and worker models. Start Pi with the selected profile's orchestrator model and thinking level, then fire a validated plan directory:

```text
pi --model <provider>/gpt-5.6-sol --thinking max
/herder-fire herder-plans --profile eclipse
```

Herder refuses to start when Pi's active providers cannot resolve every required model and thinking level. It never substitutes a different model after failure.

## What Herder owns

- Dependency-aware scheduling with a configurable global worker limit.
- Clean, parentless Pi worker sessions with no inherited root transcript or nested extension runtime.
- One stable Herder branch and isolated Git worktree per plan.
- Immutable worker assignments, review rounds, completion proofs, and exact-tree verification evidence.
- Persistent SQLite accounting, crash recovery, and resumable runs.
- Serialized integration after independent review, while unrelated worker pipelines continue concurrently.
- A compact Pi progress widget, expandable blue/green worker input/output cards, and a read-only local dashboard.

The deterministic Run Manager owns plan state, Git coordination, verification execution, recovery, and integration. Pi supplies fresh Implementer, Reviewer, and Judge sessions and returns their lifecycle evidence to the manager. Plan Markdown is never parsed as executable configuration: after integration, the main Pi session semantically selects a structured, non-redundant verification manifest for the frozen tree, and the manager alone executes and records it.

## Planning and execution commands

| Command | Purpose |
| --- | --- |
| `/herder-grill <change>` | Clarify product intent and create a focused validated plan graph in the current session. |
| `/herder-grill --plan <id>` | Refine an unstarted plan; during Fire, reserve it and adopt the edit at a safe revision barrier. |
| `/herder-improve [quick\|standard\|deep] [focus]` | Audit the repository and write prioritized improvement plans. |
| `/herder-validate [plan-dir] [--fix]` | Run a repository-aware semantic plan audit and conservative repair workflow. |
| `/herder-plans init [plan-dir] [--track]` | Initialize a plan directory. |
| `/herder-plans validate\|shape\|status\|ready [plan-dir]` | Run immediate deterministic plan-graph operations. |
| `/herder-plans snapshot <plan-id> [plan-dir]` | Refresh a plan's tracked file snapshot. |
| `/herder-plans report <plan-id\|RUN> [plan-dir]` | Report plan or run state. |
| `/herder-plans track\|untrack [plan-dir]` | Change plan-directory tracking policy. |
| `/herder-fire [plan-dir] [options]` | Validate and start a new run. |
| `/herder-resume [plan-dir] [options]` | Recover and continue an existing run. |
| `/herder-revise [plan-dir] [options]` | Adopt a newly validated immutable graph generation after active workers settle. |
| `/herder-status [plan-dir]` | Show current run status in Pi. |
| `/herder-dashboard [plan-dir]` | Open or report the read-only dashboard. |
| `/herder-stop` | Stop the active run owned by the current Pi session. |

Fire, resume, and revise accept `--profile <name>` and `--dashboard-port <port>`; fire and resume also accept `--max-parallel <count>`.

The agentic planning commands inject the exact package-owned instructions and supplied arguments into the current Pi conversation, preserving the user's context. The instruction files remain private implementation assets, so each workflow has one public `/herder-*` command. `/herder-plans` is the fast deterministic surface: it parses typed subcommands and calls the native `herder_plan` application tool without spending a model turn. Mechanical `/herder-plans validate` and semantic `/herder-validate` are intentionally separate.

During an active Fire run, Improve and graph-wide planning mutations remain blocked. `/herder-grill --plan <id>` is allowed only when SQLite proves the target has never started. The manager reserves that plan so unrelated work continues, then stops new dispatches after the confirmed edit, lets current workers settle, adopts a new immutable graph generation, and resumes automatically. Manual or externally authored graph changes still use `/herder-revise`.

## Profiles

| Profile | Orchestrator | Implementer | Reviewer and Judge |
| --- | --- | --- | --- |
| `eclipse` (default) | `gpt-5.6-sol` at `max` | `gpt-5.6-luna` at `max` on the fast tier | `gpt-5.6-sol` at `xhigh` |
| `poorman` | `kimi-k3` at `max` | `deepseek-v4-flash` at `high` | `gpt-5.6-luna` at `max` |

Profiles configure three generic package roles: `herder.plan-implementer`, `herder.plan-reviewer`, and `herder.plan-judge`.

## Runtime model

Fire and resume start or reuse Herder's persistent local Run Manager, launch the read-only dashboard, dispatch the first eligible worker batch, and return control to the root session. In an Orca-managed terminal, Herder automatically opens the loopback dashboard through Orca's workspace browser; other terminals receive the local URL without host-specific forwarding. All mutating manager calls use durable submit-and-poll operations: loopback requests only accept or read persisted state and never wait for reconciliation, Git integration, or verification commands. As workers finish, the manager backfills the global pool, advances review rounds, and integrates approved plans in dependency order. Pi journals each admitted worker prompt in a blue expandable card and each returned response in a green card (red on interruption); these custom entries are display-only and do not enlarge the root model context.

After ordinary plans integrate, Herder asks the main Pi session to inspect the exact integration tree and submit a typed `herder_verification` manifest. The main session chooses commands but does not execute them. Gate working directories are TreeRelative (`"."` or a path inside the integration worktree); absolute host paths are rejected. The manager validates the manifest's run, generation, assignment, head, tree, argv, and working directories, executes the gates in the background, and creates the final aggregate Reviewer only after they pass.

Each plan keeps one Herder-owned branch and worktree for its entire pipeline; workers never create additional branches or worktrees. The user's checkout remains unchanged until Herder performs its serialized integration step.

For the full adapter and runtime contracts, see [Herder for Pi](adapters/README.md).

## Testing

Run Herder's deterministic suite from the repository root:

```bash
npm run test:herder
```

See [Testing Herder](TESTING.md) for the complete suite and live provider-backed CI requirements.

## License

[MIT](LICENSE)
