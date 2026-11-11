# pika-node bridge

Reports what Pi is doing in a [pika-node](../../services/pika-node/README.md) terminal to the daemon that runs it, so the pika web UI's Nodes page can show the pane as busy, waiting, or idle with its background agents and session. It also adds `/pika-open` and `/pika-diff`, which open a file or a diff in the web UI. The wire contract is §5 of [NODE.md](../../services/pika/docs/NODE.md).

The collection registers this extension automatically. It has no runtime dependencies and imports no other extension. Try it on its own with:

```sh
pi --extension ./extensions/pika-node-bridge/index.ts
```

## Activation

The bridge is active only when Pi runs in a terminal the daemon spawned, which sets `PIKA_NODE_SOCKET` (the daemon's unix socket) and `PIKA_NODE_PANE_ID` (the terminal's id). Otherwise it does nothing, and the two commands say so.

One bridge reports per pane: the first top-level (TUI or RPC) session at `session_start`.
- Child sessions that run in the same process (subagents, Herder steps, council advisors) bind extensions without a TUI or RPC mode, and a process-global registry admits only one bridge per pane.
- Child Pi processes inherit the environment, so the active bridge sets `PIKA_NODE_BRIDGE_OWNER` to its pid; a bridge that finds a different live pid there stays inactive.
- Shutdown releases the pane at once, so the replacement session after `/new`, `/resume`, `/fork`, or `/reload` takes it over.

## Pane status

The daemon's primary status source is the OSC 7501 sequence that Pi writes to its terminal: it covers idle, working, and done, and every dialog, built-in or not. The bridge adds what only it knows, as a complete `BridgeStatus` snapshot:

- `state`: `busy` from `agent_start` to `agent_settled`, and `waiting` while an extension `ctx.ui` dialog is open (`ui_prompt_start` / `ui_prompt_end`, nested dialogs counted). `agent_end` never ends a run: a retry, compaction, or queued continuation can follow it.
- `activities` and `activityCount`: background work from the `pi-extensions:activity` bus (Subagents, Herder, and any producer), in the [Orca bridge's activity protocol](../orca-bridge/README.md#activity-protocol). Each snapshot replaces its source's list, and the bridge asks producers to replay with `pi-extensions:activity-request` at `session_start`. At most 128 rows are sent; `activityCount` is the full total.
- `session`: id, name, cwd, and the session file once it exists, from the session manager; it is refreshed on `session_info_changed`.
- `model`: the current model as `provider/id`.

The daemon merges the two sources (NODE.md, "Pane status"): with a program status present, the bridge's `state` counts only for `waiting`, and activities keep a pane busy after Pi's own turn ends.

## Delivery

The bridge connects on `session_start`, sends `hello`, and sends its full status after every `welcome`, then after every change. Status is latest-wins: one write is in flight and one newer snapshot waits, which a later change replaces. Writes start at least 100 ms apart, so a burst ends on the latest state. A write that the socket does not take within 1 s counts as a wedged daemon: the bridge drops the connection and reconnects. Nothing here blocks or fails the agent.

When the socket closes, the bridge reconnects after 1 s, doubling to at most 30 s. It stops for good when the daemon refuses the `hello` (an unknown pane or protocol version). On `session_shutdown` it sends a last idle status without activities, since the daemon keeps a closed bridge's last status, then closes.

## Commands

```text
/pika-open <path> [--line N] [--column N]
/pika-diff <path> [--staged]

/pika-open "notes/Review Report.md" --line 42 --column 7
/pika-diff src/old.ts --staged
/pika-open -- "-leading-dash.md"
```

Relative paths resolve against the session's working directory. Arguments are parsed like the Orca bridge's: matching quotes group a name with spaces, backslashes are literal, `--` ends options, duplicate or unknown options are errors, and `--column` needs `--line`. There is no shell expansion.

The daemon resolves the path with `realpath` and requires it inside the `roots` of `~/.pika-node/config.json`; `/pika-open` also requires a regular file, while `/pika-diff` accepts a deleted file. The command shows the daemon's answer with `ctx.ui.notify`: how many pika windows received the request, a warning when none is connected, or the error code and message (`outside_roots`, `not_found`, `is_a_directory`, or `unavailable` when the daemon is not connected). A request waits at most 5 s. The commands never send anything to the model.

## Offline verification

```sh
npm run test:pika-node-bridge
npm run typecheck
```

The suite covers the state machine, activity aggregation, the latest-wins sender (with fake timers), argument parsing, and the extension against a fake daemon on a real unix socket, whose every line must pass the daemon's own parser. `tests/protocol.test.ts` reads `services/pika-node/src/protocol.ts` and fails when this extension's copy of the bridge-socket declarations differs. `tests/daemon.test.ts` runs against the real daemon when `services/pika-node/node_modules` is installed (`npm ci` there) and is skipped otherwise. No live provider is called.
