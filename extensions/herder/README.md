# Herder

Herder takes a coding goal through implementation, verification, and delivery, keeping a durable record of the work. You approve the goal before agent steps begin and confirm delivery before changes reach your checkout or branches.

- **Durable:** an append-only, fsynced journal records each run. After a crash, quit, or session change, Herder can reuse finished work whose inputs still match.
- **Verified:** the runtime computes the verdict from check results and, when required, a fresh verifier’s assessment. Agent summaries and plan checkboxes do not establish success.
- **Proportionate:** the main model picks how much orchestration a task needs. A single writing step plus checks is the default, and workflow scripts are for work that needs more.

Agents work in disposable git worktrees, and writing steps produce commits on hidden refs. Herder’s delivery code writes to your checkout or branches only after confirmation. Worktrees are not a security sandbox: agents with `bash` can still access shared repository refs, as described under [Roles](#roles).

```text
/herder add a --json flag to the export command
/herder status
/herder resume
/herder deliver
/herder deliver branch --curate
/herder deliver 20261025-141500-a3f9 squash
/herder abort
/herder clean
/herder-improve deep security
/herder-simplify quick --lang zh-CN
```

## Requirements

- Git 2.38 or newer (`git merge-tree --write-tree`). Herder checks the version and fails with a clear message.
- Node >=22.19.0 and Pi >=1.3.0.
- A git repository with at least one commit.
- An interactive session (TUI or RPC) for user confirmations: approving the goal, confirming delivery, and confirming a model-initiated abort. All three are refused in print and JSON modes, except that a [standing authorization](#standing-approval-and-parked-runs) approves goals and aborts its own runs without one.

## Run lifecycle

1. **Start.** `/herder <goal>` creates a run on the current `HEAD` and writes a draft `goal.md`. It then sends the main model the Herder skill instructions. Each session holds at most one active run at a time, while separate sessions can run concurrent runs in the same repository; within the same session, a new run starts once its held run is finished or [parked](#standing-approval-and-parked-runs) (or `blocked` under a standing authorization). A run whose journal cannot be read also blocks a new one (see [Where state lives](#where-state-lives)).
2. **Clarify.** The model reads the code and asks at most five questions, each with a recommended answer.
3. **Goal.** The model completes `goal.md` and calls `herder_run { action: "approve_goal" }`. Herder validates the file and asks you to confirm it. In the TUI, `goal.md` scrolls as styled Markdown inside the dialog (↑↓, PgUp/PgDn, Home/End) above `Approve`, `Reject`, and `Reject with a note` (`y`/`a`, `n`/`r`, `e`), so a rejection can hand revision notes straight back to the model; Esc closes the dialog without an answer, which Herder reports separately from a rejection. Once approved, the goal is frozen: its hash is journaled, and Herder's tools refuse to work if `goal.md` changes afterwards. A different goal needs a new run.
4. **Plan.** The model writes `plan.md` with task lines linked to acceptance criteria.
5. **Orchestrate.** The model runs direct steps (`herder_step`, then `herder_integrate`) or launches a workflow script in the background. A writing step's commit is integrated as one commit per task on the run's integration line. A step whose gate failed is refused; a fix step built on its commit is integrated once it passes. The integration checks must pass before the line advances.
6. **Verify.** `herder_verify` runs every check at the integration head. A fresh, read-only verifier also runs when any of these hold:
   - more than one task was integrated;
   - the diff exceeds 200 changed lines;
   - a criterion uses `verify: judge`.

   The runtime computes the verdict:
   - `met`: every check passes and every criterion is met.
   - `blocked`: every check passes, and every unmet criterion has a verifier explanation of why it cannot be satisfied as written. Each explanation must quote at least three words verbatim from its criterion, or the whole criterion if it is shorter.
   - `not_met`: anything else, including a verifier that fails or does not assess a criterion.

   Each verification appends a `## Convergence N` section listing the gaps to `plan.md`.
7. **Deliver.** `herder_deliver` or `/herder deliver` requires a `met` verdict at the current integration head. It shows you a summary with the diffstat and writes only after you confirm. A verified run you have not delivered yet is parked: it waits for `/herder deliver <runId>` while other runs start.

## Commands

| Command | Behavior |
| --- | --- |
| `/herder <goal>` | Start a run. A goal whose first word is a subcommand name needs a leading `--`, for example `/herder -- status page shows uptime`. |
| `/herder` or `/herder help` | Show usage. |
| `/herder status [runId]` | Show the run: status, tasks, launches, verdict, and lock holder, plus any parked runs and other unfinished runs. Without an id, it shows the held, active, or latest run. |
| `/herder resume [runId]` | Take the run in this session. The main model receives the goal, plan, progress, recorded decisions, and the next action. Without an id, it takes the held run or the only unfinished run. |
| `/herder deliver [runId] [series\|branch\|squash\|uncommitted] [--curate]` | Deliver the verified run. With an id, this session takes that run first (refused while another live session holds it). Without one, it delivers the held run or the only unfinished run. The mode defaults to `series`. |
| `/herder abort [runId]` | Stop the run's launch and tool calls, journal it as abandoned, and remove its refs and worktrees. The run directory stays. |
| `/herder clean [runId\|--finished]` | Delete the directories, refs, and worktrees of finished runs (delivered, abandoned, or failed). The default is `--finished`. A named run must be finished; abort it first. The exception is a run whose journal cannot be read: naming it deletes it unless another session's lock on it is still fresh, and `--finished` skips it. |
| `/herder-improve [quick\|standard\|deep] [focus\|path\|branch\|next\|features\|roadmap] [--lang <language>] [--auto]` | Audit the repository for vetted improvements and start a run for the findings you pick. See [Audits](#audits). |
| `/herder-simplify [quick\|standard\|deep] [focus\|path\|branch] [--lang <language>] [--auto]` | Audit the repository for vetted simplifications and start a run for the findings you pick. See [Audits](#audits). |

## Tools

The main model drives a run with these tools. All except `herder_run`, `herder_pick_findings`, and `herder_workflow { mode: "stop" }` require an approved goal.

| Tool | Purpose |
| --- | --- |
| `herder_run` | `action: "start"` creates a run for `goal` as `/herder <goal>` does and returns the instructions as its result. `"status"` shows the run, parked runs, and any other unfinished runs. `"approve_goal"` validates `goal.md` and asks you to approve it (interactive only, unless a standing authorization approves it). `"record_decision"` journals a question and your answer, given between launches. `"abort"` stops and abandons the run after your confirmation (interactive only, unless a standing authorization covers the run; a run it does not cover is then refused). |
| `herder_workflow` | `mode: "validate"` compiles a script and dry-runs it without agents. `"run"` launches `script` or `scriptPath` with `args` in the background and returns the launch number; a follow-up message reports the result. `resume: n` replays launch `n`. `"stop"` stops the running launch. |
| `herder_step` | Run one agent step directly. It takes the same options as a script's `agent()`. |
| `herder_integrate` | Integrate a step key or commit with a commit `message`, an optional `task`, and optional `checks`. A `gate_failed` step is refused, by key or by its commit. |
| `herder_check` | Run checks (default: all) at the integration head or at a given commit. |
| `herder_verify` | Verify the run and compute the verdict. |
| `herder_deliver` | Deliver after your confirmation (interactive only; refused under a standing authorization). It takes `runId`, `mode`, and `curate`. |
| `herder_pick_findings` | Show an audit's findings as a checklist (interactive only). Recommended findings start checked, checking a finding also checks the findings it depends on, and you can add a note. It returns the selected ids. Under a standing authorization it returns the recommended findings and their dependencies without asking. |

A run is named by `runId` where a tool takes one. Tools that take none use the run this session holds, else the repository's only unfinished run; when several are unfinished and none is held, they refuse and list them, so the user picks one with `/herder resume <runId>` or `/herder deliver <runId>`.

The model gets the full rules and the script API from the bundled `herder` skill (`skills/herder/SKILL.md`). The `/herder` and `/herder resume` commands also send it to the model, and `herder_run { action: "start" }` returns it.

## Audits

`/herder-improve` and `/herder-simplify` audit the repository before a run exists:

- `/herder-improve` looks for bugs, security, performance, test, architecture, dependency, tooling, and documentation problems, plus evidence-backed directions for the project.
- `/herder-simplify` looks for code to delete or consolidate, obsolete paths and abstractions, and needless state or control flow, while preserving the behavior that callers rely on.

The audit is read-only. It changes no files, installs nothing, and holds no run or lock. It needs an interactive session, a commit, and that this session does not already hold an unparked unfinished run (unless it is `blocked` under a standing authorization). The flow is:

1. The model recons the repository, audits it (with read-only `recon` subagents when Subagents is loaded), and vets every finding against the code.
2. It posts a table of the vetted findings, followed by a short explanation of each.
3. `herder_pick_findings` shows the findings as a checklist with the recommended ones checked. Cancelling or selecting nothing ends the audit without a run. A note you add becomes a constraint of the goal.
4. The model starts a run with `herder_run { action: "start" }` and writes `goal.md`: one acceptance criterion per selected finding, mapped to the repository's checks, with the unselected findings out of scope. A check that proves one finding gates only its task (`integrate: no`), and `max_agents` allows about 5 agents per finding. With more than about 15 findings selected, the model recommends narrowing the selection first: the approved goal and its budget are frozen.
5. You approve the goal, the run implements one task per finding, and you confirm delivery as for any run.

Arguments:

- `quick`, `standard` (default), or `deep` sets the effort.
- A focus (such as `security` or `deletion`), a path, or `branch` (the changes since the merge base) narrows the scope. `/herder-improve next` (or `features`, `roadmap`) reports directions only. Findings that need product intent are not selectable; start `/herder <goal>` for them.
- `--auto` takes the recommended findings, and every finding they depend on, without the checklist. You still approve the goal and confirm delivery.
- `--lang <language>` sets the language of the findings and the discussion, for example `--lang zh-CN` or `--lang "Traditional Chinese"`. The goal, plan, and agent prompts stay in English.

The skills live in `skills/improve/` and `skills/simplify/`, each with its playbook under `references/`. Improve derives from [shadcn/improve](https://github.com/shadcn/improve) (MIT); see `skills/improve/UPSTREAM.md`.

## Standing approval and parked runs

Another extension can let the session work while you are away (self-driving mode). It publishes a standing authorization: what you confirmed, for one repository and this Pi process. Extensions do not import each other, so the registry lives on `globalThis[Symbol.for("pi-extensions.standing-approval")]` as `{ grants: Map<id, { id, commonDir, toplevel, text, since }> }`, keyed by the granting session's id; whoever needs it first creates it. Herder's copy of the contract is `src/adapter/standing.ts`. While a grant covers the repository (the realpath of its git common dir):

- `approve_goal` validates `goal.md` as usual and approves it without a dialog, even without a UI. The `goal.approved` journal event records `approvedBy: "standing"`, the authorization's text, and the grant's id.
- `herder_pick_findings` takes the recommended findings and their dependencies without a checklist.
- A model-initiated `abort` needs no confirmation for a run whose goal the authorization approved, or that was created at or after the grant. Any other run is refused, not asked about.
- Delivery always needs your confirmation. Under the authorization `herder_deliver` refuses (the skills tell the model never to call it); `/herder deliver`, which you type, asks you as usual.

Nothing waits for you while a grant stands: every gate either answers from the authorization or refuses at once.

A run is parked when its goal is approved, its latest verdict is `met` at the current integration head, and no delivery has started. Parked runs do not block `/herder <goal>` or the audits in the same session, so several verified runs can wait for you; under a standing authorization, a run verified `blocked` at its current integration head can likewise be left behind by the session so subsequent runs can start. A session that starts or resumes another run gives up the parked (or standing-`blocked`) one it held; it stays on disk. `/herder status` lists parked runs and any other unfinished runs, and `/herder deliver <runId>` delivers a parked one.

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

- **Headings:** the `# Goal:` title and the section names above are the only headings; any other heading, at any level and outside code fences and HTML comments, fails validation.
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
- **Ignored files:** `series` and `squash` never overwrite a file your checkout ignores. If the run tracks a path where your checkout holds an ignored file, Herder refuses and names the path. Move or delete the file, then deliver again.
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
    sessions/        each agent session as a Pi session file
    lock             the holding session and its heartbeat
  worktrees/<runId>/ disposable worktrees (shared ro-<sha> for read-only steps, pooled rw-<n> for writers, plus integration, check, and delivery slots)
refs/herder/<runId>/base             the commit the run started from
refs/herder/<runId>/integration      the integration head
refs/herder/<runId>/steps/<stepKey>  each completed writing step's commit
```

If a writing step fails after its agent ran but before its commit is pinned under `refs/herder/<runId>/steps/`, Herder does not reset its `rw-<n>` slot. It quarantines the slot (`rw-<n>.quarantined` next to it), and the step's error names the slot path and, if one was made, the commit. Later steps use other slots, and launches and session release leave the slot alone. `/herder abort`, delivery, and `/herder clean` remove it with the run's other worktrees.

Run ids look like `20261025-141500-a3f9` (UTC). `/herder clean` deletes finished runs. Do not edit the journal, `progress.md`, or the refs by hand.

A run whose journal cannot be read (corrupt before its last line, or written by a newer Herder) still counts as a run: no new run starts while it exists. A readable unfinished run next to it stays usable. Without one, `/herder <goal>`, `herder_run { action: "start" }`, the other tools, and `/herder resume`, `/herder status`, and `/herder abort` without a run id report the unreadable run and its journal error. Update Herder if a newer version wrote the journal; otherwise delete the run, with its refs and worktrees, using `/herder clean <runId>`.

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
| `tester` | yes | Adds tests from a change's contract, without touching the implementation. |
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

Unknown fields are rejected. A read-only role (`write: false`) may list only `read`, `grep`, `find`, `ls`, and `bash`. If a read-only step changes files anyway, Herder discards the changes and reports a warning.

The role’s `model` selects the step’s model; step calls and workflow scripts cannot override it. With `inherit`, steps use the main session’s model or thinking level. A step’s `effort` option can override the role’s `thinking`.

Agents with `bash` share the repository's refs. The built-in roles forbid commands that change refs, but Herder cannot enforce that.

## Templates and skill

`templates/` holds three workflow scripts for runs that need scripted orchestration. The model can adapt a template or pass it as `scriptPath`:

- `sequential.js`: one task runs implement, gate, an optional probe (a `tester` adds tests from the contract, which the gate runs), a capped fix loop, then integration.
- `disjoint.js`: independent tasks with disjoint file ownership run in a pipeline and are integrated serially in task order. A `resolver` handles conflicts.
- `explore.js`: several variants of one task. The variants that pass their gates are judged, and exactly one is integrated.

The `herder` skill holds the orchestration decision table, the `goal.md` and `plan.md` formats, the script API, and the rules. The `herder-improve` and `herder-simplify` skills hold the audits. Pi loads all three through the package's `pi.skills` entry.

## Footer and activity

While a session holds a run, the footer shows live work and the number of integrated tasks. Parallel steps are summarized with their tasks, phases and labels; additional steps are counted. Direct checks, integrations, verification and delivery are shown while running, including the current check or verifier where available and confirmation waits. During a workflow, the latest script `phase()` and `log()` appear as separate, single-line progress; a phase is global to the script and may not describe every parallel step. Progress updates change the footer without sending messages or triggering model turns. Once work settles, the footer returns to the run's ready or verified state. Running steps are also published as activity snapshots, which [Orca Bridge](../orca-bridge/README.md) shows in its pane activity. Both are cleared on shutdown.

Each step attempt is also published as an external agent, which [Subagents](../subagents/README.md) lists in its widget and `/agents` list and opens in its live conversation viewer. Extensions do not import each other, so the registry lives on `globalThis[Symbol.for("pi-extensions.external-agents")]` as `{ agents: Map<id, ExternalAgent>, listeners: Set<(id) => void> }`; whoever needs it first creates it. Herder's copy of the contract is `src/adapter/external-agents.ts`; Subagents keeps an identical one.

- **Entries:** one per attempt, with id `herder:<runId>:<stepKey>:<attempt>@<attempt start, ms>`, so a rerun never replaces a finished entry; source `herder`, and `ownerSessionId` set to the Pi session holding the run (other sessions do not show it). The group is `Herder <runId> · launch <n>`, the name is the task and label, and the description is the first line of the step's prompt.
- **Lifecycle:** an entry appears once the attempt's agent session exists and carries that `AgentSession` while it is live; the session is removed when the runner disposes it. A settled step becomes `completed`, `failed` (also a failed gate, an error, or an attempt that is retried), or `stopped`. Finished entries stay 10 minutes. Abort, a lost lock, and session shutdown remove them at once.
- **Updates:** a publisher replaces an entry's object on every change, then calls each listener with its id after every add, update, or remove.

## Step sessions and run events

Every agent session of a run is saved as a Pi session file in `runs/<runId>/sessions/`, whose header names the orchestrating session's file as `parentSession` when that session has one. Before its first prompt, the session gets a `pi-extensions.session-link` custom entry with `kind: "herder-step"`, the orchestrating session id and file, and the run id, step key and id, task, role, attempt, launch, and repository name (`herder.repo`, the same name as `herder:run`'s `repo`). Verifier and curator sessions use their role name as the step key. `run.started` records the orchestrating session id; `step.completed` and `step.failed` record the attempt's `sessionId` and `sessionFile`, unless Pi never wrote that file (it does so with the first message, so an attempt that fails before its prompt, for example without an API key, records none).

Another extension can load itself into step sessions without Herder importing it. It adds `{ name, extensionFactory }` to the Set at `globalThis[Symbol.for("pi-extensions.child-session-hooks")]`, creating the Set if it is missing. Herder appends each registered factory to the step session's extensions, binds them so they see `session_start`, and emits `session_shutdown` before it disposes the session. When a hooked extension registers `fffind` or `ffgrep`, Herder keeps them active alongside `find` or `grep` whenever the step's role allows those tools. Steps load no other extensions.

While a session holds a run, Herder emits `herder:run` on `pi.events` with `{ runId, runDir, journalPath, goalPath, planPath, repo, title }`, where `repo` is the repository's name, as pika files its sessions: the name saved with pika's `/pika project` in the main checkout's `.pi/pika/project.json`, else the main checkout's folder name, also when the run starts in a linked worktree (derived from git's common dir; a bare repository or submodule is named after the common dir without its `.git`). It emits when the run starts or is resumed, and within 250 ms after journal appends.

## Development

```bash
npm run test:herder
npm run typecheck
```

The suite uses Vitest (`extensions/herder/vitest.config.ts`) against real temporary git repositories, a scripted fake agent runner, and Pi's faux provider. It runs offline and requires no provider credentials.
