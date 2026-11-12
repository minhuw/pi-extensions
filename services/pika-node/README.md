# pika-node

The per-machine daemon behind pika nodes: PTYs with a headless screen each, files, and pane status, reached end to end through the pika server or over `ssh <node> pika-node attach`. The contract is [`services/pika/docs/NODE.md`](../pika/docs/NODE.md); `src/protocol.ts` is its canonical copy.

## Install (per user)

```sh
scripts/install.sh          # npm ci, native preflight, records node's real path in .node-path
bin/pika-node start
bin/pika-node identity      # node fingerprint
pika node create <name>     # on the server host; then, on the node:
bin/pika-node server https://pika.example   # paste the pkn_ credential on stdin
```

Linux and macOS only; Node ≥ 22.19 runs the TypeScript directly (no build). `$PIKA_NODE_HOME` (default `~/.pika-node`) holds all state.

## Layout

- `src/cli.ts`: commands; `src/run.ts`: the daemon process (socket, pid/state files, server link).
- `src/daemon.ts`: inner protocol core: terminals, attachments and backlog resync, size owner, pane status, bridge requests.
- `src/terminal.ts`: one PTY + headless xterm (sole query answerer, OSC 7501, seq/snapshot); `src/snapshot.ts`: serialization and the modes the serialize addon omits.
- `src/link.ts`: WebSocket to the server and E2E channels; `src/crypto.ts`: handshake and records.
- `src/socket.ts`: unix socket (bridge and `attach` clients); `src/files.ts`: files; `src/checkouts.ts`: checkouts and worktrees (`src/repository.ts`: repository and project names); `src/store.ts`: config, identity, allowlist, pending enrolments.

## Tests

`npm test` (Vitest) and `npx tsc --noEmit`. `test/daemon.integration.test.ts` runs the real daemon from `bin/pika-node` with a temporary home; `test/link.e2e.test.ts` runs it in-process behind a fake forwarding server. `@xterm/headless` and `@xterm/addon-serialize` are pinned exactly: the web UI must use the same xterm version, and `test/units.test.ts` fails if a new version changes which modes a snapshot restores.
