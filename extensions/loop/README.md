# Loop

Repeat a prompt in the current Pi session, on a fixed interval, a cron schedule, or a delay chosen by the model. Multiple loops share one scheduler and run one iteration at a time. The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/loop 5m check the build and report changes --name build
/loop watch the CI run and tell me when it succeeds
/loop --cron "0 9 * * MON-FRI" summarize overnight CI --wait --for 7d
/loop 1m fix the failing tests --max 6 --until "ALL TESTS PASS"
/loop list
/loop pause build
/loop resume build
/loop stop all
```

## Scheduling

- **Fixed:** a compact duration at the start or end of the prompt, such as `5m`, `1h30m`, or `2h`. Minimum interval is one minute. The schedule stays anchored to creation time and skips missed periods rather than drifting after long iterations.
- **Cron:** `--cron "<five fields>"`, using local time and the existing Croner dependency. Standard day-of-month/day-of-week OR semantics apply; Croner handles timezone and daylight-saving transitions. Cron controls calendar alignment; fixed intervals measure elapsed time from creation.
- **Model-paced:** omit the interval. During its own iteration, the model can call `loop_schedule(delaySeconds, reason)`, clamped to 60–3600 seconds. The delay starts after the entire Pi run settles. Without a scheduling call, the next pass is five minutes after settlement.

Every loop runs once immediately, unless `--wait` defers the first pass to the next fixed or cron occurrence. Each pass is a visible custom message in the existing conversation. The model is instructed to perform one pass, report meaningful changes, and call `loop_stop(reason)` when the objective is complete or requires a human decision. Fixed schedules cannot be changed by the model. Neither tool can create a loop or control a different loop.

When Pi is busy, has queued user messages, or is showing an extension dialog, due loops wait outside Pi's message queue. There is only one outstanding pass per loop; missed ticks never build a backlog. Other due loops run in due-time order after the active iteration fully settles, including automatic retries, compaction, and continuations.

## Commands and limits

| Command or option | Behavior |
| --- | --- |
| `/loop` or `/loop list` | List loops, their prompts, cadence, run counts, deadlines, and last reason. Includes a bounded history of completed loops. |
| `/loop list <name-or-id>` | Inspect one loop. `/loop status` is an alias. |
| `/loop pause [name-or-id\|all]` | Prevent further passes, retaining the loop. |
| `/loop resume [name-or-id\|all]` | Resume a paused loop at its next fixed/cron occurrence, or in one minute for model-paced loops. |
| `/loop stop [name-or-id\|all]` | End a loop permanently. Start a new loop to repeat it again. |
| `/loop help` | Show command syntax. |
| `--name build` | Assign a unique name of up to 32 letters, digits, underscores, or hyphens. |
| `--max 6` | Maximum dispatched iterations; default **25**, range 1–10,000. |
| `--for 2h` | Absolute lifetime from creation; default **6 hours**, maximum 365 days. Pausing does not extend it. |
| `--timeout 10m` | Maximum duration of one owned iteration; default **15 minutes**. A timeout pauses it and aborts its run. |
| `--until "ALL GREEN"` | Finish when the current iteration's final assistant text contains this exact, case-sensitive text. |
| `--converged 3` | Finish after this many identical nonempty final replies, comparing trimmed text. Empty replies and failed iterations reset the streak. |
| `--wait` | Defer the first pass; requires a fixed or cron schedule. |

Flags can appear before the prompt, beside the leading/trailing interval, or after the prompt. Quote values containing spaces. Task prose is preserved, including internal whitespace, quotes, and backslashes. Quote a whole prompt beginning with a management word such as `"stop"` to treat it as a task. Put literal option-like words inside the prompt rather than at its edges.

If there is exactly one live loop, its management target can be omitted. Otherwise supply its name, id, or `all`. At most 20 live loops and 100 total loop records are retained in the latest snapshot. Terminal history is pruned first.

Three consecutive failed iterations stop a loop. Context usage at or above 90% pauses a loop before dispatch; compact and resume it. Completion text and convergence are convenience stop conditions, not independent verification that code or external state is correct. For acceptance criteria, include concrete checks in the task or use Herder's verification workflow.

Pause and stop leave an already-started response free to finish, while preventing further passes. Escape aborts and pauses the loop that owns the interrupted run. Aborting an unrelated human turn does not disable scheduled loops. Human input taking over an iteration pauses that loop and removes model control of it. A canceled dispatch still being prepared by Pi is aborted before it reaches the model. An iteration that fails to start within 30 seconds pauses for explicit recovery.

## Footer integration

The extension publishes a short plain-text status through Pi's standard `ctx.ui.setStatus("loop", ...)` API:

```text
↻ build · next 4m
↻ build · run 3/6
↻ build · waiting
↻ build · paused
↻ 3 loops · next 2m
```

[Statusline Footer](../statusline-footer/README.md) displays it on the Git row in full mode and beside the model in compact mode when space permits. Model identity and context percentage take priority on narrow terminals. The default Pi footer also receives the status. No footer extension is required to run loops.

## Lifecycle and persistence

Loops run in TUI and RPC modes. Loading the extension alone creates no timers; print and JSON sessions, including child agents, never restore or run schedules. All timers are cleared on shutdown and session replacement. Scheduling uses one rearmed timer per session, with a 30-second idle status refresh and a one-second retry while due work waits on a busy session.

State is appended to Pi's session as versioned custom entries, outside model context. It survives compaction. The latest snapshot contains all loop state; convergence stores only a digest, not copies of replies.

- **Reload:** scheduled loops keep their due times. Interrupted in-flight iterations restore paused and are never silently replayed.
- **Startup, resume, fork, or new session:** inherited saved loops restore paused. Use `/loop resume` explicitly; no timer migrates automatically into another session.
- **Tree navigation:** pauses loops so an earlier conversation branch does not unexpectedly launch recurring work.
- **Corrupt snapshot:** restoration fails closed and reports the error; it does not fall back to an older active snapshot.

Pi must remain running for timers to fire. This is a session scheduler, with no cross-process ownership or shared project scheduler files. Existing tool permissions and approval extensions still apply to every iteration.

## Implementation research

This is an independent implementation informed by the sources below.

| Implementation inspected | Revision / package | Ideas carried forward |
| --- | --- | --- |
| [ArtemisAI/pi-loop](https://github.com/ArtemisAI/pi-loop) | `9c72768c69934d811aaa8dea998a3c72e4ab5cb4` | Model-paced wakeups, idle gating, session restoration. |
| [pwguler/pi-loop](https://github.com/pwguler/pi-loop) | `b6d2b4da7afd1045935a98fca793ad2c88ba522a` | Anchored scheduling, coalescing missed periods, names and management commands. |
| [ZachDreamZ/pi-loop](https://github.com/ZachDreamZ/pi-loop) | `988bfa8203cc7470260671e2190a88eb4cd0d7cd` | Completion text, convergence, iteration limits and timeouts. |
| [@pandi-coding-agent/loop](https://www.npmjs.com/package/@pandi-coding-agent/loop) | Published npm source, `0.2.1`; linked GitHub repository unavailable | Serialized ownership, bounded execution, status, and lifecycle cleanup. |
| [lnilluv/pi-ralph-loop](https://github.com/lnilluv/pi-ralph-loop) | `75d23c6d17eef4aaeef8894751d4813f1098bda3` | Explicit run outcomes, interruption handling, bounded campaign execution. |
| [samfoy/pi-ralph](https://github.com/samfoy/pi-ralph) | `55334dfd3ebb7aaa563efea67e1c16902cc87645` | Explicit state transitions and session handoff pitfalls. |
| [rahulmutt/pi-ralph](https://github.com/rahulmutt/pi-ralph) | `da2692b9d66a4361f091c79e0639c074d48df3ac` | Simple iteration bounds and durable session metadata. |
| [pi-autoresearch](https://www.npmjs.com/package/pi-autoresearch) | Installed source, `1.9.0` | Idle and pending-message checks, bounded continuation, and durable progress outside model context. Its experiment-specific commit/revert policy stays in autoresearch. |
| [mikefreno/ralpi](https://github.com/mikefreno/ralpi) | `c1a65f68acdf8e18a15ee7bcf03e299c57ac22cf` | Per-run ownership and recoverable progress. |

The Ralph implementations also offer fresh child sessions, DAGs, worktrees, review agents, and shell hooks. This extension focuses on recurring prompts in the current session; Herder, Subagents, and autoresearch already cover richer execution workflows in this collection. Fuzzy similarity, regex stop conditions, project-shared persistence, and shell hooks are outside this implementation.

## Development

```bash
npm run test:loop
npm run test:statusline
npm run typecheck
```

Tests run offline and require no provider credentials.
