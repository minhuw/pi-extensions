# pika

pika uploads every Pi trajectory to a self-hosted pika server. It sends each session entry verbatim, records the exact request body of every model call, and uploads subagent and Herder step sessions and Herder journals, goals, and plans. The server (`services/pika/`) stores them, makes them searchable, and serves a web UI to read them. pika is built for one user with several machines.

The collection loads this extension automatically, as the last entry in `pi.extensions`. It does nothing until it is configured.

## Install

1. Run the server and create one token per machine. See the [server README](../../services/pika/README.md) for build, Docker, and token commands.

   ```bash
   pika token create laptop     # prints the token once
   ```

2. Install the collection on each machine (`pi install git:github.com/minhuw/pi-extensions`, see the [root README](../../README.md#install)).
3. Write `~/.pi/agent/pika.json` and run `/reload` or start a new pi session.

## Configuration

`<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`:

```json
{
  "url": "https://homelab.example/pika",
  "token": "…",
  "enabled": true,
  "exclude": ["~/work/client-secret", "/home/me/scratch/*"]
}
```

- `url` is the server's address including its base path. Plain `http://` works on a trusted network.
- `token` is the device token from `pika token create`. The server maps it to the device name.
- `enabled: false` turns pika off without removing the file.
- `exclude` lists working directories pika skips. A plain path excludes that directory and everything below it. A pattern with `*`, `**`, or `?` excludes a cwd that it, or one of the cwd's ancestors, matches. `~/` expands to the home directory. An excluded session's Herder runs and child sessions are skipped too, wherever they run. A child counts as the session's child when its `parentSession` header names the session file, or when its `pi-extensions.session-link` entry names the session id.

Environment variables override the file: `PIKA_URL` and `PIKA_TOKEN` replace `url` and `token`, and `PIKA_DISABLED=1` always disables pika.

`/pika` shows whether pika is enabled (or why not), the server URL, whether the current session is captured, queued items and bytes, the last successful upload, the last error, any stream that stopped on a conflict or an oversized line, and parked items.

## What is captured

- **Sessions.** Only sessions that start or resume while pika is enabled are uploaded. Older sessions are never backfilled. A resumed session continues from its last acknowledged byte, or from its first line if pika has not seen it before. Entries usually reach the server within a second of being written.
- **Model requests.** For each model call, pika records the `before_provider_request` payload, without headers, after every other extension has changed it. That is the body the provider received. The payload is spooled to disk as soon as the request starts, and its assistant message is added when the response arrives. If pi dies while the response is streaming, the next pi start uploads the request without `assistant`. Providers that expose no payload (for example custom `streamSimple` implementations) are recorded as `fidelity: "context"` with the full Pi context, system messages included. Each request is linked to its assistant message by timestamp and response id. Repeated messages and tool declarations are uploaded once, as content-addressed blocks.
- **Child sessions.** pika registers a child-session hook (`globalThis[Symbol.for("pi-extensions.child-session-hooks")]`). Subagents and Herder add it to every child session they create, so nested subagents, workflow children, and Herder steps are captured as their own sessions, linked to their parent through the `pi-extensions.session-link` entry.
- **Herder runs.** On each `herder:run` event, pika uploads the run journal as stream `herder:<runId>`. It also uploads `goal.md` and `plan.md` whenever their content changes.

If pika is loaded twice in one session, for example from the package and again through the hook, only the last-loaded copy captures.

## Delivery and local state

pika never blocks or fails a turn. Its handlers only enqueue work, and errors are recorded for `/pika`. Uploads run in the background in gzip batches under 8 MiB (uncompressed). A request's new blocks may go out over several batches before the request itself. A single block or session line larger than that is sent alone, so it must fit the server's `--max-body` (32 MiB by default). Network errors and 5xx answers are retried with exponential backoff up to 60 s. A 401 stops uploading until pi restarts. When a session shuts down, pika flushes for at most 2 s, and whatever remains is sent the next time pi starts.

On a 413, pika halves its batch size, down to 256 KiB. When a batch of one item still gets 413 three times, pika parks that item and goes on with the rest. A parked block or request moves to `spool/parked/` and is not retried, and requests that reference a parked block stay incomplete on the server. A parked session line stops only its own stream, because later lines depend on it. `/pika` lists both. Parked files are kept for inspection and are never retried, so set the proxy's `client_max_body_size` and the server's `--max-body` high enough first.

State lives in `<agentDir>/pika/`:

- `streams/` holds one cursor per stream: the byte length the server has acknowledged. It is written atomically. Session lines are read again from the session file itself, so the file is the queue. Fully uploaded, closed streams move to `streams/done/`.
- `spool/requests/` holds captured requests until the server accepts them with none of their blocks missing. `spool/blobs/` holds the block texts of those requests, so pika can always answer `missingBlobs`. A block is deleted once every request that references it is complete.
- `spool/parked/` holds items the server refused as too large.
- `acked.log` holds a bounded set of block hashes the server already has, and the server URL they belong to. A different URL starts an empty set.

Nothing is lost on a crash. At worst something is sent twice, and the server ignores duplicates. Delete the directory to forget all local state. Sessions that are resumed afterwards are uploaded again from offset 0, and the server ignores the lines it already has.

## Deployment

pika talks plain HTTP to whatever `url` names, so the server can sit behind a reverse proxy under a base path. A minimal setup, with the server's own [README](../../services/pika/README.md) as the reference:

```dockerfile
# Dockerfile (build context: services/pika)
FROM node:22-bookworm AS web
WORKDIR /src/web
COPY web/ .
RUN npm ci && npm run build

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /src/target/release/pika /usr/local/bin/pika
ENV PIKA_BIND=0.0.0.0:7171 PIKA_DATA_DIR=/data PIKA_BASE_PATH=/pika
VOLUME /data
EXPOSE 7171
CMD ["pika"]
```

```nginx
# nginx: serve the server under https://homelab.example/pika
location /pika/ {
    proxy_pass http://127.0.0.1:7171;
    proxy_set_header Host $host;
    client_max_body_size 32m;
}
```

Keep `client_max_body_size` at or above the server's `--max-body` (32 MiB by default). The extension keeps its batches under 8 MiB, except that a single larger block or line is sent alone.

## Tests

`npm run test:pika` runs offline Vitest suites against real Pi runtimes and a mock ingest server with the server's append, gap, conflict, and idempotency rules. Payload capture goes through Pi's real `openai-completions` implementation against a local mock endpoint. No live providers are used.
