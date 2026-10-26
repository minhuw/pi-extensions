# pika

pika uploads every Pi trajectory to a self-hosted pika server. The server ([`services/pika/`](../../services/pika/README.md)) stores the trajectories, makes them searchable, and serves a web UI to read them. pika is built for one user with several machines.

> [!WARNING]
> Trajectories contain everything the model saw: file contents, command output, and any secret that a tool printed. Send them only to a server you control, over a network you trust or through TLS.

## What pika records

- **Sessions.** Every line of the Pi session file, verbatim, including compactions, branches, and custom entries.
- **Model requests.** For each model call, the `before_provider_request` payload after every other extension has changed it, which is the body the provider received. Providers that expose no payload (for example custom `streamSimple` implementations) are recorded as `fidelity: "context"` with the full Pi context, system messages included. Each request is linked to its assistant message by timestamp and response id.
- **Child sessions.** Subagents (top-level, nested, and workflow children) and Herder step sessions, through the [child-session hook](#child-session-hook). Each is uploaded as its own session and linked to its parent session, tool call, agent, workflow, or Herder run and step.
- **Herder runs.** Each run's journal, and its `goal.md` and `plan.md` whenever their content changes.

pika never records request headers, API keys or other credentials, or Pi's auth and settings files. It reads only session files, Herder run files, and the payload and context that Pi hands to extensions.

## Install

pika is part of this collection. Installing the collection loads it as the last entry in `pi.extensions`, so its `before_provider_request` handler sees the payload after every other extension's changes. It does nothing until it is configured.

1. Run the server and create one token per machine. See the [server README](../../services/pika/README.md) for building, Docker, and the reverse proxy.

   ```bash
   pika token create laptop     # prints the token once
   ```

2. Install the collection on each machine: `pi install git:github.com/minhuw/pi-extensions` (see the [root README](../../README.md#install)).
3. Write `~/.pi/agent/pika.json` (below) and run `/reload` or start a new pi session. `/pika` confirms that the session is captured.

To load pika on its own, without the rest of the collection, narrow the package's extensions in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "git:github.com/minhuw/pi-extensions", "extensions": ["extensions/pika/index.ts"] }
  ]
}
```

For one invocation, `pi --extension /path/to/pi-extensions/extensions/pika/index.ts` also works. Load pika after any extension that rewrites provider payloads; otherwise the recorded payload is the one before that extension's changes.

## Configuration

`<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`:

```json
{
  "url": "https://homelab.example/pika",
  "token": "pika_…",
  "enabled": true,
  "exclude": ["~/work/client-secret", "/home/me/scratch/*"]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `url` | none | The server's address, including its base path (`https://pika.example.com` or `https://homelab.example/pika`). It must be `http://` or `https://`; a trailing `/` is ignored. Plain `http://` works on a trusted network. |
| `token` | none | The device token from `pika token create <device>`. The server maps it to the device name, so it is never sent as data. |
| `enabled` | `true` | `false` turns pika off without removing the file. |
| `exclude` | `[]` | Working directories pika skips (below). |

pika is enabled only when it has both a URL and a token. A missing file means "not configured"; an unreadable or non-object file disables pika, and `/pika` shows why.

Environment variables override the file:

| Variable | Effect |
| --- | --- |
| `PIKA_URL` | Replaces `url`. |
| `PIKA_TOKEN` | Replaces `token`. |
| `PIKA_DISABLED=1` | Always disables pika, whatever the file says. |

The configuration is read at each session start, so edits apply to the next new, resumed, or reloaded session.

### Exclude list

Each `exclude` entry is matched against the session's working directory:

- A plain path excludes that directory and everything below it: `"/home/me/work/client"` excludes `/home/me/work/client` and `/home/me/work/client/api`, but not `/home/me/work/client2`.
- A pattern with `*`, `**`, or `?` excludes a cwd when the pattern matches the cwd or one of its ancestors. `*` and `?` stay within one path segment, and `**` crosses segments: `"/home/me/scratch/*"` excludes every directory under `/home/me/scratch`, and `"**/secret-*"` excludes any directory below one whose name starts with `secret-`.
- `~` and `~/…` expand to the home directory. Relative paths resolve against the directory pi was started in, so prefer absolute paths.

An excluded session's child sessions and Herder runs are skipped too, wherever they run. A child counts as the session's child when its `parentSession` header names the session file, or when its `pi-extensions.session-link` entry names the session id or file. A Herder run is also skipped when its run directory is excluded.

## Behaviour

### Which sessions are uploaded

Only sessions that start or resume while pika is enabled are uploaded; older sessions are never backfilled. A resumed session continues from its last acknowledged byte, or from its first line if pika has not seen it before. Entries usually reach the server within a second of being written. Sessions without a session file (`--no-session`) are not captured.

If pika is loaded twice in one session, for example from the package and again through the hook, only the last-loaded copy captures.

### Delivery and the offline spool

pika never blocks or fails a turn. Its handlers only enqueue work, and errors are recorded for `/pika`. Uploads run in the background as gzip batches under 8 MiB (uncompressed). A request's new blocks may go out over several batches before the request itself. A single block or session line larger than that is sent alone, so it must fit the server's `--max-body` (32 MiB by default) and the proxy's body limit.

Repeated messages and tool declarations are uploaded once, as content-addressed blocks: each element of a top-level array in the payload, and each top-level string over 2,048 characters, is sent by hash. pika remembers which hashes the server already has and sends only new ones.

Network errors, timeouts (30 s per batch), and error answers other than 401, 409, and 413 are retried with exponential backoff from 0.5 s up to 60 s, for as long as pi runs. A 401 stops uploading until pi restarts. When the last session shuts down, pika flushes for at most 2 s, and whatever remains is sent the next time pi starts with pika enabled.

On a 413, pika halves its batch size, down to 256 KiB. When a batch of one item still gets 413 three times, pika parks that item and goes on with the rest. A parked block or request moves to `spool/parked/` and is not retried, and requests that reference a parked block stay incomplete on the server. A parked session line stops only its own stream, because later lines depend on it. Parked files are kept for inspection and are never retried, so set the proxy's body limit and the server's `--max-body` high enough first.

State lives in `<agentDir>/pika/`, normally `~/.pi/agent/pika/`:

| Path | Contents |
| --- | --- |
| `streams/` | One cursor per stream: the byte length the server has acknowledged, written atomically. Session lines are read again from the session file itself, so the file is the queue. |
| `streams/done/` | Cursors of fully uploaded, closed streams. |
| `spool/requests/` | Captured requests, written as soon as the request starts, until the server accepts them with none of their blocks missing. |
| `spool/blobs/` | Block texts of spooled requests, so pika can always answer `missingBlobs`. A block is deleted once every request that references it is complete. |
| `spool/parked/` | Items the server refused as too large. |
| `acked.log` | A bounded set (100,000) of block hashes the server already has, and the server URL they belong to. A different URL starts an empty set. |

After a crash or a lost connection nothing is lost and nothing is duplicated on the server. On the next start, pika resumes every open stream from its cursor and resends spooled requests; at worst something is sent twice, and the server ignores duplicates. If pi dies while a response is streaming, the request is uploaded without its `assistant` link. If the server reports a gap below pika's cursor, for example after it was restored from an older backup, pika rewinds the stream and resends from the server's length. If the server's copy of a stream differs from the local file, the stream stops with a conflict and `/pika` shows it.

Delete `~/.pi/agent/pika/` to forget all local state. Sessions that are resumed afterwards are uploaded again from offset 0, and the server ignores the lines it already has.

### `/pika`

`/pika` shows:

- whether pika is enabled, or why not;
- the server URL;
- whether the current session is captured, or why not (excluded, no session file);
- queued items and bytes;
- the last successful upload and the last error;
- any stream that stopped on a conflict or an oversized line, uploads stopped by a 401, and parked items with their directory.

### Child-session hook

Extensions never import each other. pika exposes itself to child-session creators through a process-wide registry:

```ts
const hooks: Set<{ name: string; extensionFactory: (pi: ExtensionAPI) => void }> =
	(globalThis as any)[Symbol.for("pi-extensions.child-session-hooks")] ??= new Set();
```

- Whoever needs the `Set` first creates it. pika adds one hook named `"pika"` when it starts capturing and removes it when the last captured session shuts down.
- An extension that creates child `AgentSession`s (Subagents and Herder in this collection) appends every registered hook's `extensionFactory`, last, to the child's `extensionFactories`, even when the child loads no other extensions.
- While a hook is registered, Subagents persists every child as a Pi session file in its configured session directory, including nested and `persist_session: false` children. Herder always persists step sessions in `<runDir>/sessions/`.

Before the child's first prompt, the creator appends a link entry to the child session:

```json
{"type":"custom","customType":"pi-extensions.session-link","data":{
  "kind":"subagent | herder-step",
  "parentSessionId":"…?","parentSessionFile":"…?","parentToolCallId":"…?",
  "agentId":"…?","parentAgentId":"…?","workflowId":"…?","agentType":"…?","description":"…?",
  "herder":{"runId":"…","stepKey":"…","stepId":"…","task":"…?","role":"…","attempt":1,"launch":1,"repo":"…?"}
}}
```

Every field except `kind` is optional, and `herder` is present only for Herder steps. The server links the child to its parent from this entry and falls back to the session header's `parentSession`. Another extension that creates child sessions can follow the same contract to have them captured and linked.

### Herder runs

Herder emits `herder:run` on `pi.events` with `{ runId, runDir, journalPath, goalPath, planPath, repo, title }` when a run starts or resumes and after journal appends. pika tails `journalPath` as stream `herder:<runId>` and uploads `goal.md` and `plan.md` as documents whenever their sha256 changes. Only runs started from a captured session are uploaded.

## Deployment

The server is one Rust binary with the web UI embedded. Its [README](../../services/pika/README.md) is the reference for building, the CLI, backups, and the [deployment examples](../../services/pika/deploy/). The short version, from `services/pika/`:

```bash
docker build -t pika .
docker run -d --name pika -p 127.0.0.1:7171:7171 -v pika-data:/data \
  -e PIKA_BASE_PATH=/pika -e PIKA_PASSWORD='choose-one' pika
docker exec pika pika token create laptop
```

The [`Dockerfile`](../../services/pika/Dockerfile) builds the web UI with Node 22, builds the binary with `cargo build --release --locked`, and runs it as a non-root user with `/data` as its volume and a health check on `/api/health`.

Behind nginx under a path prefix, forward the path unchanged and allow bodies up to the server's `--max-body`:

```nginx
location = /pika { return 301 /pika/; }
location /pika/ {
    proxy_pass http://127.0.0.1:7171;
    proxy_set_header Host $host;
    client_max_body_size 32m;
    client_body_timeout 120s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
}
```

Then set `"url": "https://homelab.example/pika"` in each machine's `pika.json`. Caddy examples, subdomain variants, and putting authentication in the proxy are covered in the server README; if the proxy adds authentication, leave `/api/ingest/` to pika's bearer tokens.

## Tests

```bash
npm ci
npm run test:pika
```

`npm run test:pika` runs offline Vitest suites against real Pi runtimes and a mock ingest server with the server's append, gap, conflict, and idempotency rules. Payload capture goes through Pi's real `openai-completions` implementation against a local mock endpoint. No live providers are used. `npm test` includes it. The cross-component test against the real server is `bash services/pika/scripts/e2e.sh`.
