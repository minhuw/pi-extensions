# Herder

Herder runs a coding goal to delivery as a durable, verified run. It has three properties:

- **Durable:** each run has an append-only, fsynced journal. A run survives crashes, quits, and new sessions without repeating finished work.
- **Verified:** the runtime decides success from real check results and its own verification. Agent summaries and plan checkboxes are not evidence.
- **Proportionate:** the main model picks how much orchestration a task needs. A single writing step plus checks is the default, and workflow scripts are for work that needs more.

Agents work in disposable git worktrees. Their results are commits on hidden refs. Herder never writes to your checkout or branches until you confirm delivery.

```text
/herder add a --json flag to the export command
/herder status
/herder resume
/herder deliver
/herder deliver branch --curate
/herder abort
/herder clean
```

## Requirements

- Git 2.38 or newer (`git merge-tree --write-tree`). Herder checks the version and fails with a clear message.
- Node >=22.19.0 and Pi >=1.3.0.
- A git repository with at least one commit.
- An interactive session (TUI or RPC) for the two user decisions: approving the goal and confirming delivery. Both are refused in print and JSON modes.

## Run lifecycle

1. **Start.** `/herder <goal>` creates a run on the current `HEAD` and writes a draft `goal.md`. It then sends the main model the Herder skill instructions. Only one unfinished run per repository is allowed; finish, resume, or abort the existing one first.
2. **Clarify.** The model reads the code and asks at most five questions, each with a recommended answer.
3. **Goal.** The model completes `goal.md` and calls `herder_run { action: "approve_goal" }`. Herder validates the file and asks you to confirm it. Once approved, the goal is frozen: its hash is journaled, and Herder's tools refuse to work if `goal.md` changes afterwards. A different goal needs a new run.
4. **Plan.** The model writes `plan.md` with task lines linked to acceptance criteria.
5. **Orchestrate.** The model runs direct steps (`herder_step`, then `herder_integrate`) or launches a workflow script in the background. A writing step's commit is integrated as one commit per task on the run's integration line. The integration checks must pass before the line advances.
6. **Verify.** `herder_verify` runs every check at the integration head. A fresh, read-only verifier also runs when any of these hold:
   - more than one task was integrated;
   - the diff exceeds 200 changed lines;
   - a criterion uses `verify: judge`.

   The runtime computes the verdict:
   - `met`: every check passes and every criterion is met.
   - `blocked`: the checks pass, but the verifier quoted a criterion that cannot be satisfied as written.
   - `not_met`: anything else, including a verifier that fails or does not assess a criterion.

   Each verification appends a `## Convergence N` section listing the gaps to `plan.md`.
7. **Deliver.** `herder_deliver` or `/herder deliver` requires a `met` verdict at the current integration head. It shows you a summary and writes only after you confirm.

## Commands

| Command | Behavior |
| --- | --- |
| `/herder <goal>` | Start a run. A goal whose first word is a subcommand name needs a leading `--`, for example `/herder -- status page shows uptime`. |
| `/herder` or `/herder help` | Show usage. |
| `/herder status [runId]` | Show the run: status, tasks, launches, verdict, and lock holder. Without an id, it shows the held, active, or latest run. |
| `/herder resume [runId]` | Take the run in this session. The main model receives the goal, plan, progress, recorded decisions, and the next action. |
| `/herder deliver [series\|branch\|squash\|uncommitted] [--curate]` | Deliver the verified run. The mode defaults to `series`. |
| `/herder abort [runId]` | Stop the run's launch and tool calls, journal it as abandoned, and remove its refs and worktrees. The run directory stays. |
| `/herder clean [runId\|--finished]` | Delete the directories, refs, and worktrees of finished runs (delivered, abandoned, or failed). The default is `--finished`. A named run must be finished; abort it first. |

## Tools

The main model drives a run with these tools. All except `herder_run` and `herder_workflow { mode: "stop" }` require an approved goal.

| Tool | Purpose |
| --- | --- |
| `herder_run` | `action: "status"` shows the run. `"approve_goal"` validates `goal.md` and asks you to approve it (interactive only). `"record_decision"` journals a question and your answer, given between launches. |
| `herder_workflow` | `mode: "validate"` compiles a script and dry-runs it without agents. `"run"` launches `script` or `scriptPath` with `args` in the background and returns the launch number; a follow-up message reports the result. `resume: n` replays launch `n`. `"stop"` stops the running launch. |
| `herder_step` | Run one agent step directly. It takes the same options as a script's `agent()`. |
| `herder_integrate` | Integrate a step key or commit with a commit `message`, an optional `task`, and optional `checks`. |
| `herder_check` | Run checks (default: all) at the integration head or at a given commit. |
| `herder_verify` | Verify the run and compute the verdict. |
| `herder_deliver` | Deliver after your confirmation (interactive only). It takes `mode` and `curate`. |

The model gets the full rules and the script API from the bundled `herder` skill (`skills/herder/SKILL.md`). The `/herder` and `/herder resume` commands also send it to the model.

## goal.md

```markdown
# Goal: Add a --json flag to the export command

## Intent
Scripts need machine-readable export output.

## Acceptance criteria
- AC-1: WHEN export runs with --json THE SYSTEM SHALL print one JSON document. verify: check:unit-tests
- AC-2: The help text documents --json. verify: judge — rubric: "export --help lists --json with a one-line description"

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| unit-tests | npm ci && npm test | 10m | yes |
| typecheck | npm ci && npm run typecheck | 5m | no |

## Constraints
- The default text output is unchanged.

## Out of scope
- Other commands.

## Budget
max_agents: 40
max_fix_attempts: 3
```

- **Acceptance criteria:** at least one is required. Each criterion maps to one or more checks (`verify: check:<id>`) or to `verify: judge` with a binary rubric.
- **Checks:**
  - An `id` contains lowercase letters, digits, and hyphens, and must be unique.
  - Exit code 0 means pass.
  - `timeout` takes values such as `30s`, `10m`, `1h`, or `1h30m`. The default is 10 minutes, and the process group is killed when it runs out.
  - `integrate: yes` runs the check before every integration. Every check runs at verification.
- **Budget:**
  - `max_agents` caps step agent starts for the run (`agent()` and `herder_step`), at most 400. The verifier and curator do not count, so a spent budget never blocks verification or delivery.
  - `max_fix_attempts` is the fix-loop cap that scripts honor (default 3).

Checks and agents run in fresh Herder worktrees checked out at a commit. Ignored files such as installed dependencies and build output are not there, so a check must prepare what it needs.

`plan.md` is free-form, but task lines must match `- [ ] T<n> (AC-<n>[, AC-<n>]) <text>`. Task status comes from the journal and is rendered in `progress.md`.

## Delivery

| Mode | Result | Guard |
| --- | --- | --- |
| `series` (default) | Fast-forwards your branch to the run's commit series: one commit per integrated task. | The checkout is on a branch and clean. |
| `branch` | Creates `herder/<runId>` at the series tip, on the run's base. The checkout is not touched. | The branch must not exist. |
| `squash` | Adds one commit with the verified tree on top of your branch. The commit message is the goal title. | The checkout is on a branch and clean. |
| `uncommitted` | Applies the changes to your working tree, unstaged. | The checkout is clean; a detached `HEAD` is allowed. |

- **Moved branch:** if your `HEAD` moved since the run started, Herder replays the series onto it for all modes except `branch`. The commit messages are kept. Herder drops commits whose changes your branch already has, then reruns every check at the new tip. A failing check refuses the delivery. A replay conflict stops and reports the conflicting paths. You can then deliver as `branch`, which never replays, or resolve the conflict on your branch and deliver again.
- **Checkout changes after confirmation:** Herder checks the checkout again after you confirm. If `HEAD` or the branch changed while the dialog was open, it refuses and asks you to deliver again.
- **Curation:** `--curate` (or `curate: true`) has a `curator` agent regroup the series into logical commits first. Herder keeps the curated series only if three conditions hold:
  - its tip tree equals the verified tree;
  - its history is linear above the base;
  - no commit carries `Herder-*` trailers.

  Otherwise Herder delivers the original series and says why.
- **Interrupted delivery:** Herder journals the delivery before writing to your checkout or branches. If Pi dies in between, the next `/herder deliver` checks the repository:
  - If the write happened, Herder records the delivery and finishes the run.
  - If the write did not happen, Herder delivers normally.
  - If the result is ambiguous (for example, you committed or edited since), Herder refuses and tells you what to inspect or reset.
- **After delivery:** Herder deletes the run's refs and worktrees. The run directory stays until `/herder clean`.

Herder's integration and delivery commits are unsigned because a signing prompt would block Pi. If your branch requires signed commits, re-sign them after delivery.

## Where state lives

All state lives under the repository's git common directory (`git rev-parse --git-common-dir`). It never appears in the working tree, `git status`, or history, and linked worktrees share it.

```text
<git-common-dir>/herder/
  runs/<runId>/
    goal.md          your approved goal (frozen)
    plan.md          the model's plan; verification appends Convergence sections
    progress.md      rendered from the journal; do not edit
    notes.md         short operational notes
    scripts/<n>.js   each launched script, immutable
    journal.jsonl    the source of truth, append-only
    outputs/         large step outputs, transcripts, and check logs
    lock             the holding session and its heartbeat
  worktrees/<runId>/ disposable worktrees for steps, integration, checks, and delivery
refs/herder/<runId>/base             the commit the run started from
refs/herder/<runId>/integration      the integration head
refs/herder/<runId>/steps/<stepKey>  each completed writing step's commit
```

Run ids look like `20261025-141500-a3f9` (UTC). `/herder clean` deletes finished runs. Do not edit the journal, `progress.md`, or the refs by hand.

## Resuming

After a crash, a quit, or in a new session, run `/herder resume`. A session holds a run through its lock file and refreshes the heartbeat every 30 seconds. Another session can take over the run in two cases:

- the heartbeat is older than 2 minutes;
- the holder ran on the same host and its process is gone.

Until then, the run reports who holds it.

To continue an interrupted launch, the model relaunches it with `herder_workflow { mode: "run", scriptPath: ".../scripts/<n>.js", args, resume: <n> }`; the resume prompt gives the exact call. On a relaunch:

- A step whose id, prompt, options, and base are unchanged returns its recorded result without running an agent.
- A completed or adoptable integration is reused, never applied twice.
- Failed and interrupted steps run again.

For an exact replay, scripts must call `integrate()` serially, from the top level, in a fixed order. Integrating inside concurrent `parallel` or `pipeline` branches can change the order on a resumed launch, and later steps then rerun instead of being reused.

## Limits and defaults

| Limit | Value |
| --- | --- |
| Concurrent agents per launch | `min(6, max(1, CPUs - 2))` |
| Concurrent writing agents | 4 |
| `agent()` calls per launch | 100 |
| Step agent starts per run | 400, or `max_agents` if lower |
| Items per `parallel` / `pipeline` call | 1024 |
| Wall clock per step attempt | 60 minutes (`timeoutMs`) |
| Stall window (no agent events) | 10 minutes (`stallMs`) |
| Transient and rate-limit retries | 3, after 30 s, 2 min, and 8 min |
| Stall restarts | 2 |
| Check timeout | 10 minutes unless `goal.md` sets one |
| Script return value in the follow-up | first 4,000 characters; the rest goes to `outputs/` |

Exceeding a cap throws at the call site. A usage-limit error stops new agents in the launch and returns `failed` with class `usage_limit`. Auth errors, fatal errors, and timeouts are final.

## Roles

| Role | Writes | Purpose |
| --- | --- | --- |
| `worker` | yes | Implements one bounded task (the default role). |
| `reviewer` | no | Reviews one change against its contract in a clean context. |
| `verifier` | no | Checks a finished run against its criteria; fails closed. |
| `resolver` | yes | Resolves integration conflicts, preserving both sides. |
| `curator` | yes | Regroups a commit series with an identical final tree. |
| `explorer` | no | Read-only research. |

Roles are Markdown files with frontmatter in `agents/`. A file `~/.pi/agent/herder/agents/<role>.md` replaces the built-in role of the same name entirely; other file names add new roles.

Frontmatter fields:

- `name`: must match the file name.
- `description`
- `write`: `true` or `false`.
- `tools`: plain tool names only; patterns and `+`/`-` modifiers are rejected.
- `model`: `inherit` or `provider/model-id`.
- `thinking`: `inherit` or one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Unknown fields are rejected. A read-only role (`write: false`) may list only `read`, `grep`, `find`, `ls`, and `bash`. If a read-only step changes files anyway, Herder discards the changes and reports a warning. With `inherit`, steps use the main session's model and thinking level.

Agents with `bash` share the repository's refs. The built-in roles forbid commands that change refs, but Herder cannot enforce that.

## Templates and skill

`templates/` holds three workflow scripts. The model adapts them, or passes one as `scriptPath`:

- `sequential.js`: one task runs implement, gate, optional review, a capped fix loop, then integration.
- `disjoint.js`: independent tasks with disjoint file ownership run in a pipeline and are integrated serially in task order. A `resolver` handles conflicts.
- `explore.js`: several variants of one task. The variants that pass their gates are judged, and exactly one is integrated.

The `herder` skill holds the orchestration decision table, the `goal.md` and `plan.md` formats, the script API, and the rules. Pi loads it through the package's `pi.skills` entry.

## Footer and activity

While a session holds a run, the footer shows a status such as `herder: T2 integrate · 3/5 tasks`. Running steps are published as activity snapshots, which [Orca Bridge](../orca-bridge/README.md) shows in its pane activity. Both are cleared on shutdown.

## Development

```bash
npm run test:herder
npm run typecheck
```

The suite uses Vitest (`extensions/herder/vitest.config.ts`) against real temporary git repositories, a scripted fake agent runner, and Pi's faux provider. It runs offline and requires no provider credentials.
