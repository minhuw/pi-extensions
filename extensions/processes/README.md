# Processes

Processes runs long-lived commands (dev servers, watchers) and one-shot background jobs (builds, test suites) outside the agent's turn, logs their output, and wakes the agent when one becomes ready, prints errors, or exits. The agent starts a process, ends its turn or keeps working, and is told what happened, without polling, sleeping, or leaving orphaned `&` jobs.

The collection loads this extension automatically; use `/reload` after installing or updating it.

## Three kinds of command

| Kind | Example | Here |
| --- | --- | --- |
| Service (process manager) | `npm run dev`, `cargo watch` | `process_start` (default `kind: "service"`): runs until stopped, with readiness tracking. |
| Background task | `npm run build`, a long test run | `process_start` with `kind: "task"`: no readiness; you are notified when it exits, with its last lines. |
| Interactive terminal (PTY) | `vim`, REPLs, prompts | Not supported. Processes get no terminal and no stdin. |

## Tools

| Tool | Does |
| --- | --- |
| `process_start` | `{ command, name?, cwd?, kind?, ready?, errorPattern? }`. `cwd` is relative to the session's directory and must resolve, symlinks followed, inside it or the system temp dir. `ready` (services only) takes `pattern`, `port`, `url`, and `timeoutSeconds` (default 120), all of which must hold. Without `ready`, a service is ready once a local URL it prints accepts TCP. Starting the same name, command, and cwd again reuses the live process. |
| `process_list` | Name, id, status, pid, uptime, URLs, and exit of every process. |
| `process_logs` | `{ name, cursor?, tail?, filter? }`: the tail (default 50 lines), or with `cursor` only output after an earlier read, plus `nextCursor` and notes about rotated or remaining output. |
| `process_stop` / `process_restart` | SIGTERM to the process group, then SIGKILL after 3 s. A restart keeps the id and name. |
| `process_wait` | `{ name, until: "ready" \| "exit" \| "match", pattern?, timeoutSeconds? }` (default 600 s): returns at once and sends a notification when the condition holds, times out, or the process ends first. |

Every process runs in its own process group through Pi's shell (`getShellConfig()`), and is tagged with the session that started it.

## Notifications

Events from a session's own processes arrive in that session as one `process-event` message per 250 ms window, steered into a running turn or starting one when the agent is idle:

```text
[process dev] ready (auto-url) http://127.0.0.1:5173 after 2.1s
[process build] exited with code 1 after 34s; last lines:
  ...
```

Reported: ready, readiness timeout (the process keeps running), error output matching `errorPattern` (at most one per 30 s per process), exits the agent did not ask for (with up to 20 last lines), and results of `process_wait` calls the session made. Exits caused by the agent's own `process_stop`/`process_restart` are not reported again. A stop or restart from `/ps` is reported without starting a turn. Other sessions' processes, a subagent's for example, only show a UI notification.

## Lifecycle

One manager serves the whole Pi process. It survives `/reload`, `/new`, `/resume`, and forks, so processes and their notifications carry over. Quitting Pi stops every process gracefully. On any other exit, a crash included, every process group gets SIGKILL, and a per-process watchdog shell kills the group if Pi dies without running exit handlers.

Subagents, Herder steps, and dreams load this extension too. Their sessions end with the same `quit` reason, but only the top-level session (the one that created the manager, or the session that replaced it) may stop the manager. A child session's exit only cancels its pending waits.

## Bash

The extension replaces Pi's `bash` tool with the same tool (parameters, output truncation, rendering) executed through the manager. A command runs attached: the call waits for it, and its run is neither notified nor listed. It moves to the background as a managed process, instead of blocking the turn, when:

- it prints a local URL and is still running 2 s later (a dev server);
- the user sends a message while it runs (typed or over RPC, after it has run 3 s);
- it runs 120 s without an explicit `timeout` and does not start with `sleep`.

The result then keeps the output so far, drops `exit_code`, adds `process_id`, `process_name`, and `background_reason`, and says `Command still running; moved to the background as process <name> (<id>) because <reason>.` Its exit later arrives as a `process-event` notification. An explicit `timeout` and an abort still kill the process group. Another extension that also overrides `bash` conflicts with this one.

## Bash guard

A `bash` tool call that backgrounds a process itself is blocked, since a foreground command moves to the background on its own: a job-control `&` anywhere in the command (`npm run dev &`, `server & sleep 5 && curl ...`, `(x &)`), or `nohup`, `setsid`, or `disown` as a command word. The scanner understands quotes, escapes, comments, heredoc bodies, `$(...)`, `${...}`, arithmetic, `case` terminators, and redirections, so `&&`, `2>&1`, `>&2`, `&>file`, `|&`, and a quoted or escaped `&` pass.

## Limits and logs

- At most 16 live processes.
- Logs live under `<agentDir>/processes/<pi pid>-<start time>/<id>.log`. Each keeps 32 MiB plus one previous generation, and logs of earlier Pi runs are deleted after 7 days.
- `/ps` → **Clear finished** removes exited and stopped processes together with their logs.

## `/ps`

Lists the processes. Pick one to view its last 100 lines (↑↓ PgUp PgDn scroll, Esc closes), restart it, or stop it after a confirmation. Without a UI, `/ps` prints the table.

The statusline footer counts processes through the in-process `processes:request:list` / `processes:changed` protocol.

## Development

`src/types.ts` is the contract between the substrate (`src/manager.ts`, `src/core/`, no Pi imports) and the Pi facade (`index.ts`, `src/extension.ts`, `bash.ts`, `tools.ts`, `notify.ts`, `guard.ts`, `ui.ts`, `footer.ts`).

```bash
npm run test:processes                        # all offline suites
npx vitest run extensions/processes/tests/facade   # facade only, against a fake manager
```
