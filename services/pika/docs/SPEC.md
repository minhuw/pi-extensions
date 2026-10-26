# pika spec v1 (shared contract for every task)

pika stores every pi trajectory from several machines on one self-hosted service.

- `extensions/pika/` is a TypeScript pi extension that captures and uploads.
- `services/pika/` is a Rust binary `pika`: ingest, storage, read API, and the embedded web UI built from `services/pika/web/`.

Single user, homelab, plain HTTP behind a reverse proxy.

## Identity
- **Device:** authenticated by a bearer token; the server maps token → device name. `pika token create <name>` prints a new token once and stores only its SHA-256 hash. `pika token list` and `pika token revoke <name>` manage them.
- **Session:** the pi session header `id`. Its stream key is `session:<sessionId>`.
- **Herder run:** stream key `herder:<runId>`. Its documents are keyed `herder:<runId>:goal.md` and `herder:<runId>:plan.md`.

## Ingest API
Paths are relative to the configured base path (`/` or e.g. `/pika`).

`POST {base}/api/ingest/v1/batch` takes these headers:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`
- optionally `Content-Encoding: gzip`

Request body:
```json
{
  "client": { "host": "string", "pikaVersion": "string", "piVersion": "string?" },
  "streams": [{
    "key": "session:<id> | herder:<runId>",
    "kind": "session | herder-journal",
    "offset": 0,
    "lines": ["<verbatim line without the trailing \\n>"],
    "path": "source file path on the device (informational, optional)",
    "meta": { "optional informational object": true }
  }],
  "documents": [{ "key": "herder:<runId>:goal.md", "kind": "herder-goal | herder-plan", "runId": "…", "content": "…", "sha256": "…" }],
  "blobs": [{ "hash": "<lowercase hex sha256 of the UTF-8 bytes of data>", "data": "<exact block text>" }],
  "requests": [{
    "id": "client-generated UUID (idempotency key)",
    "sessionId": "…",
    "seq": 1,
    "at": "ISO time of capture",
    "fidelity": "payload | context",
    "provider": "…?", "api": "…?", "model": "…?",
    "assistant": { "timestamp": 1733234402000, "responseId": "…?" },
    "skeleton": {},
    "blocks": ["hash", "…"]
  }]
}
```
All top-level arrays are optional.

Field notes:
- `offset` is the byte offset of the first line in the source file. Each line occupies `utf8Length(line) + 1` bytes.
- `seq` counts requests per session. It is 1-based, informational, and may restart when pi restarts.
- `assistant` is present when known. `timestamp` is the assistant message's `timestamp` field.
- `skeleton` is the payload with its split parts replaced by references (see "Request blocks").
- `blocks` lists every hash the skeleton references, in order of first appearance.

Response 200:
```json
{ "streams": { "<key>": { "length": 1234 } }, "missingBlobs": ["hash"] }
```
- `length` is the server's committed byte length of each stream after the batch.
- `missingBlobs` lists hashes referenced by accepted requests that the server does not have. The client must send them. Until then the server stores the request and marks it incomplete.

Rules:
- **Append:** a stream whose `offset` equals the server's committed length is appended.
- **Duplicates:** lines that fall entirely below the committed length are ignored when they are byte-identical. If they differ, the server answers 409 `{ "error": "conflict", "key", "length" }`.
- **Gaps:** if `offset` is greater than the committed length, the server answers 409 `{ "error": "gap", "key", "length" }` and the client resends from `length`.
- **Atomicity:** each batch is applied in one SQLite transaction.
- **Errors and limits:**
  - 401 for a missing or unknown token.
  - 413 above the maximum body size (default 32 MiB). The client keeps batches under 8 MiB.
- **Idempotency:** resending a request id or a blob is a no-op. Documents are upserted by key; the newest `sha256` wins.

## Request blocks (client splits, server reconstructs)
Let `P` be the payload object from `before_provider_request` after a JSON round-trip. The client:
- replaces each element `E` of every top-level array property of `P` with `{"$pika": sha256(JSON.stringify(E))}` and emits `JSON.stringify(E)` as a block;
- replaces every top-level string property longer than 2048 characters with `{"$pika": sha256(value), "$type": "string"}` and emits the string itself as the block;
- leaves everything else inline in the skeleton.

The server reconstructs the request by replacing each `{"$pika": h}` with `JSON.parse(block)`, or with the block text when `"$type": "string"`. The reconstruction must deep-equal `P`.

For fidelity `context`, `P` is `{ "messages": <the pi context messages for that call, including system messages> }`, split by the same rules.

The client remembers which block hashes the server already acknowledged and sends only new blocks. It still answers `missingBlobs`.

## Link entries for child sessions
Child-session creators (Subagents, Herder) append this custom entry to the child session before the child's first prompt:
```json
{"type":"custom","customType":"pi-extensions.session-link","data":{
  "kind":"subagent | herder-step",
  "parentSessionId":"…?","parentSessionFile":"…?","parentToolCallId":"…?",
  "agentId":"…?","parentAgentId":"…?","workflowId":"…?","agentType":"…?","description":"…?",
  "herder":{"runId":"…","stepKey":"…","stepId":"…","task":"…?","role":"…","attempt":1,"launch":1,"repo":"…?"}
}}
```
`herder` is present only for Herder steps. The server derives session links from this entry, and falls back to the session header's `parentSession`.

## Child-session hook (in process; extensions never import each other)
- `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` is a `Set` of `{ name: string, extensionFactory: (pi: ExtensionAPI) => void }`. Whoever needs it first creates it.
- pika registers one hook when it loads and removes it on shutdown.
- Subagents and Herder append every registered hook's `extensionFactory`, last, to the `extensionFactories` of every child AgentSession they create. This applies even when the child loads no other extensions.
- When at least one hook is registered, Subagents persists every child session as a pi session file in its configured session directory, including nested and `persist_session: false` children. Without hooks, its existing behavior is unchanged.
- Herder always persists step sessions as pi session files in `<runDir>/sessions/`.

## Herder run discovery
Herder emits on `pi.events` channel `"herder:run"` the payload `{ runId, runDir, journalPath, goalPath, planPath, repo, title }`, where `repo` is the basename of the repository's top-level directory. It emits when a run starts or is resumed, and after every journal append.

pika tails `journalPath` as stream kind `herder-journal` and uploads goal and plan as documents whenever their sha256 changes.

Additions to the Herder journal (all optional fields, so old journals stay valid):
- `run.started` gains `sessionId`, the orchestrating pi session id.
- `step.started`, `step.completed`, and `step.failed` gain `sessionId` and `sessionFile` for the step's session.

## Read API (JSON; used by the web UI)
Every path is under `{base}/api/v1/`. Cursors are opaque strings, and `limit` defaults to 50. Times in responses are ISO 8601 strings in UTC; time parameters accept ISO 8601, `YYYY-MM-DD`, or Unix milliseconds.

- **`GET facets`** returns `{ devices: string[], projects: string[], models: string[] }`.
- **`GET sessions`** accepts `device`, `project`, `model`, `from`, `to` (inclusive bounds on `lastAt`), `root` (`true` lists only sessions without a parent), `cursor`, and `limit`. It returns `{ items: SessionSummary[], nextCursor }`, newest `lastAt` first. `SessionSummary` is:
  ```
  { id, device, project, cwd, title, startedAt, lastAt, durationMs, entryCount,
    models: string[],
    tokens: { input, output, cacheRead, cacheWrite }, cost,
    parentSessionId?, link?, childCount, herderRunId? }
  ```
  - `project` is the basename of `cwd`; Herder step sessions use the link's `herder.repo` instead.
  - `title` is the `session_info` name if set, otherwise the first user prompt cut to 120 characters.
  - Pages are keyset-paged on `lastAt`, so later pages never repeat a session. A session that gains entries between page fetches moves to the top of the list: it appears on a fresh first page and not on the later pages of the old walk.
- **`GET sessions/:id`** returns a `SessionSummary` plus `{ children: (SessionSummary & { parentToolCallId? })[] }`.
- **`GET sessions/:id/turns`** accepts `cursor` and `limit` (default 100). It returns `{ items: Turn[], nextCursor }`, with one `Turn` per user prompt, or per displayed extension message (a `custom_message` with `display: true`) that starts a run while the session is idle:
  ```
  { index, startSeq, endSeq, userText, at, durationMs,
    modelCalls, toolCalls, toolErrors, cost, tokens, finalText }
  ```
  `finalText` is the last assistant text in the turn, cut to 2,000 characters.
  - A run is in progress after a user prompt until its first assistant reply, and after an assistant reply with `stopReason: "toolUse"` or with tool calls that have no tool result yet, unless its `stopReason` is `aborted` or `error`. A displayed extension message saved during a run, such as a subagent notice steered between a tool result and the next model call, stays inside its turn and changes neither its `userText` nor its `finalText`. A displayed message before the session's first turn starts one.
- **`GET sessions/:id/entries`** accepts `from` (a seq), `to`, and `limit` (default 200, max 1000). It returns `{ items: Entry[] }`, where `Entry` is:
  ```
  { seq, offset, id, parentId, type, timestamp, raw, requestId?, truncated? }
  ```
  - `raw` is the parsed verbatim line. An escaped unpaired UTF-16 surrogate (such as `\ud83d` alone, which `JSON.stringify` writes for a string cut inside a pair) parses as U+FFFD; derived tables parse lines the same way.
  - Strings longer than 65,536 characters are cut to that length and the entry is marked `truncated: true`.
  - Each image block's `data` becomes `""` and the block gains `src`: the URL of `GET sessions/:id/entries/:seq/image/:index`.
  - `GET sessions/:id/entries/:seq/raw` returns the verbatim line.
- **`GET sessions/:id/updates`** accepts `since` (the caller's last seq; missing or invalid counts as `-1`) and returns `{ lastSeq, lastAt, session?, turns?, truncated? }`, so the UI can poll an active session cheaply and fetch `entries?from=<since + 1>` when `lastSeq` grew.
  - `lastSeq` and `lastAt` are the session's newest entry seq (`-1` for a session without entries) and its time.
  - When `lastSeq > since`, `session` is the session's `SessionSummary` (as `GET sessions/:id` returns it, without `children`), and `turns` lists every `Turn` whose `endSeq > since`, ascending by `index`: the turn that grew plus any new turns. At most 50 are listed; when more qualify, `turns` holds the newest 50 and `truncated: true` is set, and the UI refetches its turns list instead.
  - When `lastSeq <= since`, `session`, `turns`, and `truncated` are omitted.
  - An unknown session id returns 404.
- **`GET sessions/:id/export`** returns the verbatim JSONL, byte-identical to the original file.
- **`GET requests/:id`** returns `{ id, sessionId, fidelity, provider, api, model, at, complete, payload }`, where `payload` is the reconstructed request. Block text is spliced in verbatim, so escapes of unpaired UTF-16 surrogates in context messages come back exactly as the client split them.
- **Herder runs:**
  - `GET herder/runs` accepts `cursor` and `limit`, and returns `{ items: RunSummary[], nextCursor }`. `RunSummary` is `{ runId, device, repo, title, status, verdict?, startedAt, lastAt, stepCount }`.
  - `GET herder/runs/:id` returns `{ run: RunSummary, goal?, plan?, events: [{ seq, t, at, data }], steps: [{ key, id, task?, role, label?, phase?, status, attempts, sessionId?, commit?, startedAt?, endedAt? }] }`.
- **`GET search`** accepts `q`, `device`, `project`, `sort`, `cursor`, and `limit`. It returns `{ items: [{ sessionId, sessionTitle, seq, entryId, kind, snippet, at }], nextCursor }`.
  - Every word of `q`, or `"quoted phrase"`, must match; operators and special characters are plain text.
  - `sort` is `newest` (default, by entry time, keyset-paged with `cursor`) or `relevance`.
  - `sort=relevance` returns a single page: the best `limit` (at most 100) matches by bm25 among the 20,000 newest matches that pass the `device` and `project` filters, with `nextCursor: null`. It does not page because bm25 scores change as documents are indexed; a `cursor` with `sort=relevance` is a 400.
  - `kind` is one of `user`, `assistant`, `tool-call`, `tool-result`, or `title` (a `session_info` name).
  - `snippet` is HTML-escaped text with `<mark>` around matches.
- **Auth:**
  - `POST login {password}` sets an HttpOnly cookie scoped to the base path.
  - `POST logout` clears it.
  - `GET me` returns `{ authenticated, passwordRequired }`.
  - When no password is configured, everything is open. Otherwise every `/api/v1/*` route except `login` and `me` requires the cookie.
- **Static UI:** served at `{base}/`. Unknown non-API paths under the base return `index.html`. The server injects `<meta name="pika-base" content="{base}">` into `index.html`, and the UI uses it for API calls and router paths. The UI build uses relative asset URLs.

## Server configuration
- **Settings (flag / environment variable):**
  - `--bind` / `PIKA_BIND`, default `127.0.0.1:7171`
  - `--base-path` / `PIKA_BASE_PATH`, default `/`
  - `--data-dir` / `PIKA_DATA_DIR`, default `./pika-data`
  - `--password` / `PIKA_PASSWORD`, optional
  - `--max-body` / `PIKA_MAX_BODY`
- **Data dir layout:**
  - `pika.db`: SQLite in WAL mode.
  - `blobs/<h[0..2]>/<h[2..4]>/<h>.zst`: zstd-compressed content-addressed blobs.
- **Storage model:**
  - Verbatim lines are kept in SQLite as the source of truth. Lines over 1 MiB go to the blob store, referenced by hash.
  - All typed tables are derived from the verbatim lines, so `pika reindex` can rebuild them.
  - A schema migration that adds derived tables or changes how they are derived records the `needs_reindex` setting in its own transaction; opening the database reindexes while it is set, and the reindex transaction clears it, so an interrupted upgrade reindexes on the next start.
- **Embedded UI:** the binary embeds `services/pika/web/dist` when present. `cargo test` and debug builds must work without it, serving a placeholder page.

## Extension configuration
- **Config file:** `<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`:
  ```
  { "url": "https://host/pika", "token": "…", "enabled": true, "exclude": ["<cwd prefix or glob>"] }
  ```
- **Environment overrides:** `PIKA_URL` and `PIKA_TOKEN` override the file. `PIKA_DISABLED=1` always disables pika.
- **Local state:** kept under `<agentDir>/pika/`: per-stream cursors, a disk spool for pending requests and blobs, and the set of hashes the server has acknowledged.
- **Status command:** `/pika` shows whether pika is enabled, the server URL, queued items and bytes, the last successful upload, and the last error.
- **Load order:** the extension is listed last in this repository's `package.json` `pi.extensions`, so its `before_provider_request` handler runs after every other extension's.
