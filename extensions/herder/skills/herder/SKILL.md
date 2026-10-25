---
name: herder
description: Runs coding work as a durable, verified Herder run - an approved goal with checks, agent steps in isolated git worktrees, serial integration, runtime verification, and delivery after user confirmation. Use after /herder or /herder resume, or when a Herder run is active and you need to plan, orchestrate, verify, or deliver it.
---

# Herder

Herder runs a coding goal to delivery. Work happens in agent **steps**, each in a disposable git worktree; writing steps become commits that are **integrated** one task at a time on a hidden integration line. Every result is journaled, so a run survives crashes, stops, and new sessions without repeating finished work. Nothing touches the user's checkout or branches until the user confirms delivery.

Success is computed by the runtime from real check results and its own verification. **Agent summaries, plan checkboxes, and commit messages are claims, not evidence.** Never report a task as done because an agent said so; report what the checks and the runtime's verdict say.

## Run lifecycle

1. **Start.** The user runs `/herder <goal>`, or you call `herder_run { action: "start", goal }` when the user asked for a run (as the audits do); the tool result then carries these instructions. Herder creates the run and a draft `goal.md`; the command message or tool result gives you its path. Run files live in the run directory under the repository's git directory, never in the working tree.
   A run started from a `/herder-improve` or `/herder-simplify` audit implements the findings the user picked: one acceptance criterion and one task per finding, the unpicked findings out of scope. The audit already did the clarifying.
2. **Clarify.** Read the relevant code first, then ask at most 5 questions, only ones whose answers change the work. For a run you started with `herder_run`, ask only what is still open: the conversation or audit that led to it usually answered them. Give each a recommended answer so the user can reply "yes". Skip questions you can answer from the code.
3. **Write `goal.md`** in the format below. Prefer acceptance criteria that a check can decide.
4. **Approve.** Call `herder_run { action: "approve_goal" }`. Herder validates the file and asks the user to confirm. If validation fails, fix the file and call it again. After approval the goal is frozen; to change it, tell the user.
5. **Write `plan.md`** next to `goal.md`: tasks with IDs mapped to criteria.
6. **Orchestrate** (see the decision table):
   - Simple runs: `herder_step` (one `agent()` step with the same options) then `herder_integrate` with its commit. Inspect each result before the next call.
   - Larger runs: write a script, check it with `herder_workflow { mode: "validate", script | scriptPath }`, then launch it with `herder_workflow { mode: "run", script | scriptPath, args }`. It runs in the background and returns a launch number; a follow-up message reports the script's return value and how many steps were reused, changed, or new. Do not poll; continue when the follow-up arrives. `herder_workflow { mode: "stop" }` stops it.
7. **Check and verify.** `herder_check` runs checks at the integration head (or a given commit). `herder_verify` runs every check, runs the fresh-context verifier when the run is non-trivial, and computes the verdict (`met`, `not_met`, or `blocked`). On `not_met`, read the gaps it appended to `plan.md` (a `## Convergence N` section), plan a fix, and launch again. On `blocked`, take the quoted criterion to the user.
8. **Deliver.** `herder_deliver` requires a `met` verdict at the current head and the user's confirmation. Modes:
   - `series` (default): the run's commits, one per integrated task, fast-forwarded onto the user's branch (the checkout must be clean and on that branch).
   - `branch`: a new `herder/<runId>` branch; the checkout is untouched.
   - `squash`: one commit on the user's branch, titled from the goal.
   - `uncommitted`: the changes applied to the clean working tree, unstaged.
   - `curate: true` first asks a curator to regroup the series into logical commits; it is kept only if the final tree is identical.

`herder_run { action: "status" }` shows the run at any time. The user also has `/herder status`, `/herder deliver`, `/herder abort`, and `/herder clean`.

### Resuming

After a crash, a stop, or in a new session, the user runs `/herder resume`, which re-primes you with the goal, plan, progress, and last results. Then:

- Relaunch the interrupted script with `herder_workflow { mode: "run", scriptPath, args, resume: <n> }`, where `<n>` is the interrupted launch and its script is `scripts/<n>.js` in the run directory. Use the same `args`. You may edit a copy of the script first; steps whose id, prompt, options, and base are unchanged return their recorded results instantly, and their integrations are reused instead of applied twice.
- Steps that failed or were interrupted run again. Changed steps run live.
- `fresh: true` on an `agent()` call deliberately resamples a step that would otherwise be reused.
- Without `resume`, a launch starts from the current integration head (use this for follow-up work, such as fixes after verification).

## Choosing orchestration

Start with the cheapest shape that fits; escalate only when it fails or the work clearly needs more.

| Situation | Shape | How |
| --- | --- | --- |
| Trivial change (a few lines, one file) | One writing step + checks | `herder_step` with `gate`, then `herder_integrate` |
| Normal task | One writer + gates, optional clean reviewer, capped fix loop | `sequential.js` |
| Several independent tasks with disjoint files | Partitioned fan-out with explicit file ownership, serial integration, resolver on conflict | `disjoint.js` |
| Several tasks that touch the same files | Sequential tasks, each integrated before the next starts | `sequential.js` per task, or a script that loops over tasks |
| Uncertain approach, worth trying several | Generate and filter, then a tournament judge, in separate worktrees | `explore.js` |
| Research before planning | One read-only `explorer` step | `herder_step { role: "explorer" }` |

Never run parallel writers on overlapping files. If ownership is unclear, run the tasks sequentially.

## goal.md

```markdown
# Goal: <one line>

## Intent
<≤5 lines: why and for whom>

## Acceptance criteria
- AC-1: WHEN <trigger> THE SYSTEM SHALL <observable outcome>. verify: check:unit-tests
- AC-2: <criterion>. verify: judge — rubric: "<binary statement the verifier can confirm>"

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| unit-tests | npm ci && npm test | 10m | yes |
| typecheck | npm ci && npm run typecheck | 5m | yes |

## Constraints
- <must not change …>

## Out of scope
- <…>

## Budget
max_agents: 40
max_fix_attempts: 3
```

**Acceptance criteria**
- Number them `AC-1`, `AC-2`, …. Write each as one observable outcome in EARS style: `WHEN <trigger> THE SYSTEM SHALL <outcome>`, `WHILE <state> …`, `IF <condition> THEN …`, or a plain `THE SYSTEM SHALL …`.
- Map every criterion to evidence: `verify: check:<id>` (one or more check ids, comma separated) or `verify: judge — rubric: "<statement>"`. Prefer checks: they are deterministic and cheap. Add a test to the plan when no existing check covers a criterion, then map the criterion to the check that runs it.
- A judge rubric is a binary statement a fresh reviewer can confirm by reading code, such as `"Every public function in src/api.ts validates its input before use"`. Avoid "good", "clean", "robust". The rubric text must not itself contain `verify:`.
- Keep criteria about outcomes, not implementation steps. At least one criterion is required.

**Checks**
- `id`: lowercase letters, digits, and hyphens (`/^[a-z0-9][a-z0-9-]*$/`), unique. Every `check:<id>` in the criteria must exist here.
- `command`: a shell command; exit code 0 means pass. Checks and agents run in fresh worktrees of a commit, without ignored files such as node_modules: the command runs at the top level of a fresh checkout of the commit being checked, with no installed dependencies, virtualenvs, build output, or local config. Make each check self-contained, e.g. `npm ci && npm test` or `uv run pytest`. Keep it non-interactive and deterministic, and prefer fast, scoped commands when the full suite is slow.
- `timeout`: `30s`, `10m`, `1h`.
- `integrate`: `yes` runs the check before each integration advances the head (default integration checks); keep these fast. `no` runs it only for gates you name and at verification.
- Every check runs at verification, whatever its `integrate` value.

**Budget**: `max_agents` caps live step agent starts for the run (`agent()` calls and `herder_step`; the verifier and curator do not count, so a spent budget never blocks verification or delivery); `max_fix_attempts` is the fix-loop cap your scripts should honor (default 3).

## plan.md

Free-form Markdown that you own; rewrite it as you learn. Task lines must match exactly:

```markdown
- [ ] T1 (AC-1) Add the parser for the new config section
- [ ] T2 (AC-2, AC-3) Wire the parser into startup and report errors
```

Give each task its file ownership and dependencies in prose under it when you plan a fan-out. Task status comes from the journal and is rendered in `progress.md`; do not tick checkboxes as progress, and never edit `progress.md` or the journal. The runtime appends `## Convergence N` sections after verification; leave them in place.

## Scripts

A script is the body of an async function: top-level `await` and `return` work. There is no `import`, `export`, or `require`, and no file system, network, timers, `eval`, or `Function`. `Date.now()`, `Math.random()`, and `new Date()` without arguments throw, because replay must be deterministic. Binary buffers (`ArrayBuffer`, typed arrays, `DataView`, `Atomics`, `WebAssembly`), `Intl`, and `Temporal` are not available either: they hold memory outside the script's heap limit. Pass inputs through `args`; the return value must be JSON-serializable and should be a compact summary.

Globals:

- `agent(prompt, opts)` runs one step and resolves to a result. Options (unknown keys throw):
  - `id` — stable step id. Always set it, derived from the task and the attempt number (`impl-T1`, `fix-T1-2`, `review-T1`), so a relaunch reuses unchanged steps. Never give one id to calls with different prompts or options in the same launch; that throws.
  - `task` — the plan task id (`"T1"`), for progress per task.
  - `role` — `worker` (default, writes), `reviewer`, `verifier`, `explorer` (read-only), `resolver`, `curator` (write).
  - `write` — override the role's default.
  - `base` — commit to start from (default: the launch's integration head). Use a previous step's `commit` to build on it.
  - `gate` — check id or ids from `goal.md`, run in the step's worktree afterwards.
  - `schema` — a JSON Schema; the agent must return matching data in `result.data`.
  - `label`, `phase` — display only. `fresh: true` — resample instead of reusing. `timeoutMs`, `stallMs` — per-step limits. `effort` — thinking level for this step: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `integrate(source, { message, task?, checks? })` merges a step result (or a commit SHA) onto the integration head as one commit with `message`, runs the integration checks (default: those marked `integrate: yes`), and advances the head only if they pass.
- `parallel([() => …, …])` runs thunks concurrently and waits for all; a thunk whose own code throws yields `null`.
- `pipeline(items, stage1, stage2, …)` runs each item through the stages; a stage receives `(previous, item, index)` and the first stage's `previous` is the item. Items do not wait for each other between stages. A stage whose own code throws makes that item `null`.
- `phase(title)` and `log(message)` report progress. `args` holds the launch arguments.

Results are values. Invalid options (including a reused id), cap breaches, and host or runtime rejections throw, and they propagate out of `parallel` and `pipeline`; only ordinary errors thrown by your own thunk or stage code become `null`.

- Step result: `{ status, key, text, data, commit, checks, error, reused }`, with `status` one of:
  - `ok` — finished; for writers, `commit` holds the change and any gates passed.
  - `no_changes` — a writer changed nothing.
  - `gate_failed` — gates failed; `commit` still holds the change, and `checks` holds each check's `{ id, passed, exitCode, timedOut, tail }`.
  - `failed` — the agent failed after the runtime's own retries; `error` is `{ class, message }`. `class` `usage_limit` means stop and tell the user.
  - `stopped` — the launch was stopped.
- Integration result: `{ status, head, conflicts, checks }` with `status` one of `integrated` (the new `head`), `conflict` (the conflicting paths; the head did not move), or `checks_failed` (the head did not move).

The runtime caps concurrency, agents per launch and per run, items per call, and step wall-clock and stall time; caps are enforced, not advisory.

### Templates

Three templates live in this extension at `../../templates/<name>.js` relative to this skill's directory. Read the one you need, copy it into your script (or pass its path as `scriptPath` when it fits unchanged), and adapt it to the plan. Each documents its `args` in a header comment.

- `sequential.js` — one task: implement, gate, optional read-only review with structured findings, fix loop capped at `maxAttempts` (default 3) that stops when the same gate fails with the same output twice (ignoring durations, times, and hashes), then integrate. A review step that fails or stops returns `review_failed` or `stopped` without integrating. Args: `{ task, prompt, gate?, review?, maxAttempts?, message, checks? }`.
- `disjoint.js` — independent tasks in a `pipeline`, each prompt stating the paths it may edit; refuses duplicate task ids, `..` in `owns`, and overlapping `owns` before any step runs (a glob counts as owning its whole directory); integrates serially in task order; on a conflict runs a `resolver` from the current head that applies the task's whole change (implementation plus fixes, `git diff --binary <first>^ <last> | git apply --3way`), resolves the conflicts, and is integrated in its place; a resolver that cannot keep both sides changes nothing (`no_changes`) and the task is reported as a conflict; reports tasks that still fail. Args: `{ tasks: [{ id, prompt, owns, gate?, message, checks? }], maxAttempts? }`.
- `explore.js` — N variants of one task (`variants`, default 3, optional `approaches`), keeps those whose gates pass, lets one read-only judge step pick a winner with structured output, and integrates exactly one (none if none passes). Args: `{ task, prompt, variants?, approaches?, gate?, criteria?, judge?, message, checks? }`.

Always run `herder_workflow { mode: "validate" }` before `run`.

## Writing step prompts

A step sees only its prompt and its worktree, not this conversation. Make every prompt self-contained:

- the task and the acceptance criteria it serves, quoted from `goal.md`;
- the relevant constraints and out-of-scope items;
- the files and interfaces to start from, and for fan-out the exact paths the step may edit;
- which checks matter and how to run them, including installing dependencies first (the worktree has none);
- for fixes, the failing check output or the review findings verbatim.

Use the reviewer for a clean second look at risky changes; give it the contract and the diff range, not the author's summary.

## Rules

- **Results are values.** Check `status` after every `agent()` and `integrate()` call, and after every tool call. Never assume success, never integrate a step that is not `ok`, and never treat `text` as proof.
- **Cap fix loops.** At most `max_fix_attempts` (default 3) fix attempts per task. Stop early when the same gate fails with the same output twice; report it instead of retrying.
- **Partition writers.** Parallel writers only with explicit, disjoint file ownership stated in each prompt; integration is always serial. When in doubt, go sequential.
- **Integrate in a fixed order.** Call `integrate()` from the script's top level, one task after another in a fixed order (as `disjoint.js` does after its `pipeline`), never inside `parallel` or `pipeline` branches. Concurrent branches can integrate in a different order on a resumed launch, which changes later steps' bases, so they rerun instead of being reused.
- **Stable ids.** Give every step an explicit `id` that includes its task and attempt number (`fix-T1-2`). Never reuse one id for a different prompt or options in the same launch; it throws.
- **No human waits in scripts.** Scripts cannot ask the user anything. When a decision is needed, let the script return, ask the user, record the answer with `herder_run { action: "record_decision", question, answer }`, and launch again.
- **Failures surface.** Report `failed`, `conflict`, `checks_failed`, and `not_met` honestly with the check output. Do not weaken checks or criteria to get a pass; changing the goal needs the user.
- **Hands off the user's checkout.** Steps run in their own worktrees. Do not edit the repository yourself during a run; all changes go through steps and reach the user only via `herder_deliver`.
- **Verify before delivery.** Deliver only after `herder_verify` reports `met` at the current head, and tell the user what the checks and verifier found.
