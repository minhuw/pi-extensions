# Selfdrive

Use `/selfdrive` to turn on self-driving mode 🚗 in a top-level TUI or RPC session before you leave it (to sleep, to travel). While you are away the session keeps working on its own on things you would likely want, as proposals you accept or discard when you come back. It acts as an orchestrator: background [Subagents](../subagents/README.md) and [Herder](../herder/README.md) runs do the work, and the session keeps only their summaries.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/selfdrive [on] [focus]   turn self-driving mode on, optionally with a focus
/selfdrive off            turn it off and show the report
/selfdrive status         on or off, since when, driver starts, tasks, and whether it is working, waiting, or done
/selfdrive report         the report so far
```

Turning it on asks for confirmation, with the scope below. With a focus, it respects that scope. Without one, it chooses evidence-based candidates across the project: unanswered questions or offers, known problems (reported limitations, TODOs, failing or flaky tests, docs that disagree with the code), and bounded audits with the herder-improve and herder-simplify skills. The latest conversation topic does not define the scope. It prefers work that is heavy for the machine and light for the model, such as relevant test suites, end-to-end runs, and benchmarks.

Task outcomes can supply new candidates. When the queue is empty, the model is guided to examine relevant project evidence through bounded discovery before deciding to stop, unless it already examined that evidence. It should not repeat audits without new evidence. This is guidance for choosing useful work; there is no minimum runtime, task quota, or required inventory of all test suites.

## What it may and never does

It may read the code, run tests and benchmarks on this machine, run background subagents, start Herder runs, and run audits. There is no cost or time limit.

It changes code only through Herder runs. While the mode is on it publishes a standing approval for this repository, which Herder reads: `approve_goal` approves goals and the findings picker takes the recommended findings without a dialog, and both are journaled with the approval's text. Verified runs are not delivered: they wait for you, and `/herder deliver <runId>` delivers one. Outside a git repository the mode still turns on, but no approval is published and Herder runs are unavailable.

It never delivers, pushes, publishes, opens pull requests or issues, uses sudo or ssh, changes system settings, or edits your checkout. A `tool_call` guard, active in every session of the process while an approval exists (subagent and Herder children included), refuses these and says what to do instead: write in a worktree under `.pi/workspaces/` or through a Herder run. The guard's checks on `bash` and `process_start` commands are heuristics that prevent accidents; they are not a sandbox.

## How it runs

The session continues on its own with a short message carrying the elapsed time, optional focus, up to five open tasks with a count of any others, and up to three recent outcomes. This context supports choosing the next useful work. `/selfdrive status` labels the kickoff and continuation count as `driver starts`; it does not count all model turns or Herder runs.

The model keeps candidates in the existing `selfdrive_task` ledger as `planned` with a `why`, marks work `running`, and finishes each as `proposed`, `done`, `failed`, or `dropped`, with the outcome in `result`. These outcomes inform follow-up choices and explain why candidates were dropped. It paces itself with `selfdrive_next`: `wait` while background work runs (a completion notification wakes it earlier), `done` when nothing worthwhile is left. `done` is rejected while any ledger task is `planned` or `running`; `proposed` is terminal, and an empty ledger may finish. This check relies on the recorded ledger.

Continuations are sent only while the session is idle, nothing is queued, and no dialog is open. Three continuations in a row that do nothing (no tool calls other than its own, and no wait), or three runs in a row that fail or never start, end the driving as done. User stops and these safeguards bypass the normal completion check. Done stops the continuations; the mode, the approval, and the status stay until you return.

On macOS the session runs `caffeinate -i` while the mode is on, so the machine does not sleep.

## Coming back

Your next message ends the mode before it is processed, and the report comes with it: what needs you (proposals with their `/herder deliver` commands, and questions), what was done, what failed or was dropped, and what is still open. Its headline shows elapsed time, task and proposal counts, and cost (subagents included); a recorded stop reason appears as `Stopped: …`, including safety stops. Esc or `/selfdrive off` end it too. Commands, relay messages, and subagent notifications do not count as your return.

The mode survives `/reload`. Any other restart, resume, or fork ends it, and `/selfdrive report` shows what it did.

While engaged, Selfdrive publishes `selfdrive` for its session in the process-wide `Symbol.for("pi-extensions.session-modes")` registry. The mode remains published after `done` and is removed on disengagement; other session modes are preserved and registry listeners are notified of changes.

While the mode is on, [Statusline Footer](../statusline-footer/README.md) shows `🚗 selfdrive 2h13m` in its bar, with `· waiting 20m` or `· done`.

Run `npm run test:selfdrive` for offline tests that drive real Pi sessions on a local faux provider.
