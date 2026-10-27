# pika spec v1 (shared contract for every task)

pika stores every pi trajectory from several machines on one self-hosted service.

- `extensions/pika/` is a TypeScript pi extension that captures and uploads.
- `services/pika/` is a Rust binary `pika`: ingest, storage, read API, and the embedded web UI built from `services/pika/web/`.

Single user, homelab, plain HTTP behind a reverse proxy.

## Identity
- **Device:** authenticated by a bearer token; the server maps token → device id and stores only the token's SHA-256 hash. A device gets its token by pairing (see "Pairing"), or from `pika token create <name>`, which creates a new device and prints its token once. `pika token list`, `revoke`, and `rename` manage them, as do the UI's Devices page and "Devices" routes.
  - **Device id:** the identity, which never changes. Every `device` field and column (streams, requests, documents, sessions, Herder runs, relay) holds it. Devices from before 0.4 keep their old name as their id; new devices get a random UUID v4, lowercase and hyphenated. Every id matches `^[A-Za-z0-9._-]{1,64}$`, which ids in URLs and the CLI must match.
  - **Device name:** a display label. Valid when, after trimming whitespace at both ends, it is 1–64 Unicode scalar values and contains no control characters (general category Cc, including U+0085) and no U+2028 or U+2029. Names need not be unique; the trimmed form is stored and returned. Responses carry it as `deviceName` next to `device`; a device without a `devices` row is named by its id.
  - **Device key:** 32 random bytes as 64 lowercase hex characters, which the pi extension keeps per agent dir, so that a later pairing from the same install can continue its device. The server stores only `sha256(key)` (hex) and never logs or returns a key.
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

- **`GET facets`** returns `{ devices: { id, name }[], projects: string[], models: string[] }`. `devices` are the devices of recorded sessions, sorted by name case-insensitively, then by id.
- **`GET sessions`** accepts `device` (an id), `project`, `model`, `from`, `to` (inclusive bounds on `lastAt`), `root` (`true` lists only sessions without a parent), `cursor`, and `limit`. It returns `{ items: SessionSummary[], nextCursor }`, newest `lastAt` first. `SessionSummary` is:
  ```
  { id, device, deviceName, project, cwd, title, startedAt, lastAt, durationMs, entryCount,
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
    modelCalls, toolCalls, toolErrors, cost, tokens, finalText, customType? }
  ```
  `finalText` is the last assistant text in the turn, cut to 2,000 characters. `customType` is the `customType` of the `custom_message` that started the turn, such as `relay-message`, and is absent for a user prompt; it is read from the entry at `startSeq`, so it needs no reindex.
  - A run is in progress after a user prompt until its first assistant reply. After a reply, it depends on the turn's last reply's `stopReason`:
    - `toolUse`: in progress.
    - `aborted`: ended.
    - `error` or `length`: in progress if a `context_edit` or `compaction` entry follows the reply, because pi recorded a recovery (an automatic retry, or overflow or truncation recovery) and calls the model again. A `length` reply with tool calls is also in progress, since pi answers them with error results and continues. Otherwise ended.
    - anything else, or missing: in progress if the reply has tool calls, whether or not their results have arrived; otherwise ended.

    A displayed extension message saved during a run, such as a subagent notice steered between a tool result and the next model call, stays inside its turn and changes neither its `userText` nor its `finalText`. A displayed message before the session's first turn starts one.
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
  - `GET herder/runs` accepts `cursor` and `limit`, and returns `{ items: RunSummary[], nextCursor }`. `RunSummary` is `{ runId, device, deviceName, repo, title, status, verdict?, startedAt, lastAt, stepCount }`.
  - `GET herder/runs/:id` returns `{ run: RunSummary, goal?, plan?, events: [{ seq, t, at, data }], steps: [{ key, id, task?, role, label?, phase?, status, attempts, sessionId?, commit?, startedAt?, endedAt? }] }`.
- **`GET search`** accepts `q`, `device` (an id), `project`, `sort`, `cursor`, and `limit`. It returns `{ items: [{ sessionId, sessionTitle, seq, entryId, kind, snippet, at }], nextCursor }`.
  - Every word of `q`, or `"quoted phrase"`, must match; operators and special characters are plain text.
  - `sort` is `newest` (default, by entry time, keyset-paged with `cursor`) or `relevance`.
  - `sort=relevance` returns a single page: the best `limit` (at most 100) matches by bm25 among the 20,000 newest matches that pass the `device` and `project` filters, with `nextCursor: null`. It does not page because bm25 scores change as documents are indexed; a `cursor` with `sort=relevance` is a 400.
  - `kind` is one of `user`, `assistant`, `tool-call`, `tool-result`, or `title` (a `session_info` name).
  - `snippet` is HTML-escaped text with `<mark>` around matches.
- **Auth, sessions, devices, and pairings:** `login`, `logout`, `me`, `auth/sessions`, `devices`, and `pairings` are specified in "Authentication" and the sections after it. In `password` mode every `/api/v1/*` route except `login` and `me` requires a session cookie.
- **Static UI:** served at `{base}/`. Unknown non-API paths under the base return `index.html`. The server injects `<meta name="pika-base" content="{base}">` into `index.html`, and the UI uses it for API calls and router paths. The UI build uses relative asset URLs.

## Authentication
`--auth` / `PIKA_AUTH` selects who authenticates viewers of the UI and the read API: `password` (default), `proxy`, or `none`. Ingest (`{base}/api/ingest/`) and the relay's device routes (`{base}/api/relay/`) always use device tokens; pairing (`{base}/api/pair/`) and `{base}/api/health` are always open.

- **`password`:** the UI's data and every `/api/v1/*` route except `login` and `me` require a valid session cookie. **The server refuses to start when no password is configured:** it exits with status 2 and prints `pika: no password configured. Run 'pika password set', set PIKA_PASSWORD_FILE or PIKA_PASSWORD, or set PIKA_AUTH=proxy if your reverse proxy authenticates (PIKA_AUTH=none disables authentication).`
- **`proxy`:** pika does no viewer authentication; the reverse proxy must authenticate every path except `/api/ingest/`, `/api/pair/`, `/api/relay/`, and `/api/health`. The server logs one warning at startup.
- **`none`:** no authentication at all, for local development and benchmarks. The server logs one warning at startup.

### Passwords
In `password` mode the first of these sources wins:
1. `--password-file` / `PIKA_PASSWORD_FILE`: the file's contents with one trailing newline removed. An empty or unreadable file stops the server.
2. `--password` / `PIKA_PASSWORD` (empty means unset).
3. The hash stored by `pika password set`.

A password from 1 or 2 is hashed in memory at startup; when one is used while a stored hash also exists, the server logs that the stored one is ignored. A server using the stored hash reads it at each login, so `pika password set` applies at once.

- `pika password set` reads the new password twice without echo from the terminal, or once from stdin (one trailing newline removed) when stdin is not a terminal. It requires at least 12 characters, stores an argon2id PHC string in `settings` (`password_hash`), and revokes every session.
- `pika password clear` removes the stored hash and, when there was one, revokes every session.

Passwords are verified with argon2id: the `argon2` crate's default parameters, a random salt, and constant-time comparison.

### Sessions
- **Storage:** the table `auth_sessions(id_hash TEXT PRIMARY KEY, created_at INTEGER, last_seen_at INTEGER, expires_at INTEGER, user_agent TEXT, ip TEXT)` (named so because `sessions` holds pi sessions). The cookie `pika_session` holds a random 32-byte base64url id; only its SHA-256 is stored.
- **Lifetime:** 30 days absolute. `last_seen_at` is updated at most once a minute per session. Expired rows are deleted lazily: when their cookie is next seen, and at every login.
- **Retirement:** the 0.1 HMAC cookie `pika_auth` is no longer accepted; users log in again.
- **Password change:** when the effective password changes between starts, every session is revoked. The server detects this with a fingerprint in `settings` (`password_fingerprint`); neither the password nor a fast hash of it is ever stored.
  - For a password from `--password-file` or `--password`, the fingerprint is an argon2id PHC string of it, with the same parameters as login hashes. At startup the server verifies the password against the stored fingerprint (one argon2 run) and uses that PHC string for logins. When it does not match, or there is none, the server revokes every session and stores a new PHC string.
  - For the stored hash, the fingerprint is an HMAC of its PHC string keyed with a random database key (`cookie_key`). `pika password set` updates it along with the hash.
- **Cookie attributes:** `HttpOnly; SameSite=Lax; Path=<base>/` (or `/`); `Max-Age`. `Secure` follows `--cookie-secure` / `PIKA_COOKIE_SECURE`:
  - `auto` (default): set when the request arrived over HTTPS, as reported by a trusted proxy;
  - `always`;
  - `never`.
- **Trusted proxy:** `--trust-proxy` / `PIKA_TRUST_PROXY=1` (default off). The variable accepts `1`, `true`, `yes`, or `on`, and `0`, `false`, `no`, `off`, or empty, in any case. Any other value stops the server at startup with a usage error (exit status 2).
  - When on: the client IP is the rightmost `X-Forwarded-For` address (the socket peer when that is missing or not an address), and HTTPS is `X-Forwarded-Proto: https`.
  - When off: the client IP is the socket peer, and HTTPS is never assumed.
- **Routes** under `{base}/api/v1/`. Browser sessions live under `auth/` because `sessions` is the pi session list.
  - `POST login {password}` creates a session and sets the cookie; 200 `{ authenticated: true }`, 401 `{ error: "invalid_password" }`, or 429 (see "Login rate limiting"). In `proxy` and `none` modes it answers 200 without a cookie.
  - `POST logout` deletes the current session and clears the cookie.
  - `GET auth/sessions` → `{ items: [{ id, createdAt, lastSeenAt, expiresAt, userAgent?, ip?, current }] }`, live sessions newest first. `id` is the first 12 hex characters of the id hash.
  - `DELETE auth/sessions/:id` → 204, or 404. Deleting the current session also clears the cookie.
  - `POST auth/sessions/revoke-all` deletes every session including the current one, clears the cookie, and returns 200 `{}`.
  - `GET me` → `{ authenticated, passwordRequired, authMode: "password" | "proxy" | "none" }`. In `proxy` and `none` modes `authenticated` is true and `passwordRequired` false.
- **CSRF:** state-changing `/api/v1` routes use only POST or PATCH with a JSON body (`{}` when there is nothing to send) or DELETE, and never GET. The JSON extractor rejects form posts with 415.

### Login rate limiting
Kept in memory, so a restart resets it.
- **Per client IP:** at most 5 failed logins in a sliding 15 minutes. Further attempts get 429 `{ error: "too_many_attempts", retryAfter: <seconds> }` with a `Retry-After` header, without checking the password. A successful login clears that IP's failures.
- **Global:** at most 100 failed logins per hour across all IPs. Past that, everyone gets the same 429 until the window frees.
  - **Lockout:** this means anyone can block new logins for up to an hour by sending wrong passwords from many addresses. Existing sessions keep working (only `POST login` is refused), and ingest and pairing are unaffected. Restarting the server clears every login and pairing limit. To recover, use a browser that is still logged in, or restart pika, then block the offending addresses at the reverse proxy.
- **Client IP:** an IPv4 address, also when it arrives IPv4-mapped (`::ffff:a.b.c.d`); for IPv6, the address's /64. The pairing limit counts clients the same way. Each limit tracks at most 10,000 clients; when that many have live entries, a new client gets the same 429 until one expires.
- **Counting:** an attempt counts as failed before its password is checked, and a correct password takes it back. A request cancelled during the check still counts.
- **Password checks:** at most 2 run at once. A login waits up to 5 s for one, then gets 429 `too_many_attempts` with `retryAfter: 1`. A check whose request was cancelled keeps its slot until argon2 finishes.

## Devices
- **`devices` table:** `id` (primary key), `name`, `key_hash` (unique, nullable), and `created_at`. Every path that creates a device inserts its row in the same transaction as its token. Revoking a device deletes its token only; the row, with its name and key, stays. The version 5 migration creates a row for every existing token (`id` and `name` = the token's name) and for every other distinct `streams.device` (`created_at` = its earliest stream), without a reindex.
- **`tokens` table:** `name` (the device id; at most one token per device), `hash`, `created_at`, `created_via` (`cli` | `pairing`, default `cli`), `last_seen_at`, and `last_host`. Ingest updates the last two at most once a minute per device, from the batch's `client.host`.
- **Routes** under `{base}/api/v1/`, authenticated:
  - `GET devices` → `{ items: [{ id, name, createdAt, createdVia, lastSeenAt?, lastHost?, hasKey }] }`, the devices with a token, sorted by name case-insensitively, then by id. `createdAt` and `createdVia` describe the token; `hasKey` says whether a device key is bound to the device.
  - `PATCH devices/:id` with body `{ name }` → 200 `{ id, name }` (the stored, trimmed name), 400 `{ error: "invalid_name" }`, or 404 `{ error: "unknown_device" }`. It renames devices with or without a token.
  - `DELETE devices/:id` → 204, or 404. Ingest refuses a revoked token immediately, and the device's relay connections close with 4401 at once.
- **CLI:**
  - `pika token create <name>` creates a new device with a new id; stdout is the token only, and stderr says `created device <id> (<name>)`.
  - `pika token list` prints one tab-separated line per device with a token: id, name, creation time, `created_via`, last-seen time (`never`), and last host (`-`), sorted like `GET devices`.
  - `pika token revoke <device>` and `pika token rename <device> <name>` take a device id (exact), or else a name that exactly one device has (for `revoke`, only devices with a token count). Several matches fail with an error naming their ids; none fails with `pika: no device "<device>"`. Revoke prints `revoked <name> (<id>)`.

## Pairing
Device authorization, like OAuth's device flow. The unauthenticated routes live under `{base}/api/pair/v1/`; a proxy that authenticates must leave `/api/pair/` open, as it does `/api/ingest/`.

- **`POST start`** with body `{ device: string, host?: string, pikaVersion?: string, key?: string }`, and optionally `Authorization: Bearer <token>`.
  - **Validation:** `device` is the requested name and follows the name rule (see "Identity"); `host` is at most 255 characters. Otherwise, or for a body that is not such JSON, 400 `{ error: "invalid_device" }`. A `key` that is not 64 lowercase hex characters is 400 `{ error: "invalid_key" }`. `pikaVersion` is cut to 64 characters.
  - **Recognition:** a bearer token that belongs to a device matches that device (`token`); otherwise a `key` whose hash is some device's `key_hash` matches that device (`key`). A bearer token that belongs to no device is ignored, without a 401: re-pairing usually happens because the token is gone. The match and the key's hash are stored with the pairing; the response never reveals a match.
  - **Response:** 200 `{ pairingId, code, expiresAt, expiresIn: 600, interval: 2 }`.
    - `pairingId` is a random 32-byte base64url secret known only to the device; the server stores its SHA-256.
    - `code` is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, formatted `XXXX-XXXX`, unique among stored pairings. Codes match case-insensitively, with or without the hyphen.
  - **Limits:**
    - at most 10 pending, unexpired pairings at a time, otherwise 429 `{ error: "too_many_pairings" }`. Expired pairings do not count; each start deletes those that expired more than 10 minutes ago;
    - at most 5 starts per client IP per 10 minutes, otherwise 429 `{ error: "too_many_attempts", retryAfter }` with `Retry-After`. Every valid start counts, except one refused for `too_many_pairings`, which is checked first.
  - **Recorded:** the request's client IP, requested name, host, pikaVersion, key hash, and match.
- **`POST poll`** with body `{ pairingId }` answers 200 with `status`, except an unknown id, which answers 404 `{ error: "unknown_pairing" }` (a body that is not JSON gets 400):
  - `{ status: "pending" }` until it's decided;
  - `{ status: "approved", device: <id>, name, token, continued: boolean }`, only once. The server creates the device token at this moment, in one transaction: if the approved device has a `devices` row (`continued: true`), it sets its name and revokes its current token, whose relay connections close with 4401 at once; otherwise it inserts the row. It stores the new token's hash with `created_via = 'pairing'`. If the pairing carried a key, the key moves to this device: it is cleared from any other device and set on this one, so a machine's key points at the device it was last paired as. Then it deletes the pairing. **No plaintext token is ever stored.**
  - `{ status: "denied" }`, after which the pairing is deleted;
  - `{ status: "expired" }`, after which the pairing is deleted. An expired pairing is kept for this answer until the next start deletes it (see the limits above); after that its poll gets 404.
- **`POST bind`** with `Authorization: Bearer <token>` and body `{ key }` binds a device key to a device that has none, so that devices paired before keys existed, and pasted-token logins, become recognizable:
  - 401 `{ error: "unauthorized" }` without a valid token; 400 `{ error: "invalid_key" }` for a malformed key;
  - 204 when the token's device already has this key, or when it has no key and no other device has this one (then it is set);
  - otherwise 409 `{ error: "key_conflict" }`. Bind never overwrites or moves a key.
- **Authenticated `/api/v1` routes:**
  - `GET pairings` → `{ items: [{ code, name, host?, ip?, pikaVersion?, requestedAt, expiresAt, match? }] }`, pending and unexpired only, newest first. `name` is the requested name. `match` is `{ id, name, by: "token" | "key", active }` when the request was recognized: the device, its current name, how it was recognized, and whether it has a token.
  - `POST pairings/:code/approve` with body `{ name?: string, continues?: string | null }`:
    - `continues` chooses the device: omitted, the match (a new device when there is none); `null`, a new device; a string, that existing device id, with or without a token, else 404 `{ error: "unknown_device" }`;
    - `name` defaults to the continued device's current name, or the requested name for a new device, and follows the name rule (400 `{ error: "invalid_name" }`);
    - 404 `{ error: "unknown_pairing" }` when the pairing is missing, expired, or no longer pending;
    - 200 `{ device: <id>, name, continued: boolean }` on success, marking the pairing approved with that device (a fresh UUID for a new device) and name. Nothing else changes until the device polls.
  - `POST pairings/:code/deny` with a JSON body → 204, or 404 `{ error: "unknown_pairing" }`.
- **Approval page:** the UI route `{base}/devices?pair=<code>`. The extension builds this URL from its configured server URL.

## Relay
Relay lets running pi sessions send text messages to each other through the server, and lists the online sessions in the web UI. Its contract, including frames, close codes, limits, and the extension and web sides, is [`docs/RELAY.md`](RELAY.md); this section lists what the server adds.

- **Routes:**
  - `GET {base}/api/relay/v1/connect`: the device WebSocket, authenticated with `Authorization: Bearer <device token>` before the upgrade (401 `{ error: "unauthorized" }` otherwise). Any device token may connect.
  - `GET {base}/api/relay/v1/sessions` with the bearer token → `{ items: OnlineSession[] }`.
  - Under the authenticated `{base}/api/v1/`: `GET relay/sessions`, `POST relay/messages`, and `GET relay/events?limit=`.
  - `GET {base}/api/health` lists `"relay"` in `features` when relay is on.
- **Settings:** `--relay` / `PIKA_RELAY`: `on` (default) or `off`, with the same spellings as `PIKA_TRUST_PROXY`; empty means on. When off, every relay route answers 404 `{ error: "relay_disabled" }`, before any authentication. `PIKA_RELAY_TTL_SECS` (default 300) and `PIKA_RELAY_HEARTBEAT_SECS` (default 20) exist for tests and the end-to-end script only, and are hidden from `--help`.
- **State:** online sessions, the mailbox, and the event ring live in memory; a restart drops them. Ownership checks and `recorded` use the `sessions` table. Ownership, addressing, limits, and revocation are keyed by device id; `deviceName` fields are looked up when an object is serialized, so a rename shows in the next list and in every frame sent after it.
- **Revocation:** revoking a token closes every relay connection made with it with 4401 at once, both from `DELETE devices/:id` and when a pairing that continues a device deletes its old token. A token revoked by another process (`pika token revoke`) is noticed within one heartbeat, because each connection re-checks its token every heartbeat; it is also checked again at `hello`.
- **Shutdown:** stopping the server closes every relay connection with 1001.

## Server configuration
- **Version:** `GET {base}/api/health`, always open, returns `{ ok, version, basePath, features, revision? }`. `revision` is the first 7 hex digits of the commit the binary was built from, taken at build time from `PIKA_REVISION` (the image workflow passes the commit); it is missing when the build had none. `pika --version` and the startup log line show `<version> (<revision>)` the same way, and the web UI shows it at the bottom of the sidebar.
- **Settings (flag / environment variable):**
  - `--bind` / `PIKA_BIND`, default `127.0.0.1:7171`
  - `--base-path` / `PIKA_BASE_PATH`, default `/`
  - `--data-dir` / `PIKA_DATA_DIR`, default `./pika-data`
  - `--auth` / `PIKA_AUTH`: `password` (default), `proxy`, or `none`
  - `--password-file` / `PIKA_PASSWORD_FILE`, optional
  - `--password` / `PIKA_PASSWORD`, optional
  - `--cookie-secure` / `PIKA_COOKIE_SECURE`: `auto` (default), `always`, or `never`
  - `--trust-proxy` / `PIKA_TRUST_PROXY=1`, default off
  - `--max-body` / `PIKA_MAX_BODY`
  - `--relay` / `PIKA_RELAY`: `on` (default) or `off` (see "Relay")
- **Data dir layout:**
  - `pika.db`: SQLite in WAL mode.
  - `blobs/<h[0..2]>/<h[2..4]>/<h>.zst`: zstd-compressed content-addressed blobs.
- **Storage model:**
  - Verbatim lines are kept in SQLite as the source of truth. Lines over 1 MiB go to the blob store, referenced by hash.
  - All typed tables are derived from the verbatim lines, so `pika reindex` can rebuild them. The settings, tokens, `devices`, `auth_sessions`, and `pairings` tables are not derived, and `reindex` leaves them alone.
  - A schema migration that adds derived tables or changes how they are derived records the `needs_reindex` setting in its own transaction; opening the database reindexes while it is set, and the reindex transaction clears it, so an interrupted upgrade reindexes on the next start.
- **Embedded UI:** the binary embeds `services/pika/web/dist` when present. `cargo test` and debug builds must work without it, serving a placeholder page.

## Extension configuration
- **Config file:** `<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`:
  ```
  { "url": "https://host/pika", "token": "…", "enabled": true, "exclude": ["<cwd prefix or glob>"] }
  ```
- **Environment overrides:** `PIKA_URL` and `PIKA_TOKEN` override the file. `PIKA_DISABLED=1` always disables pika.
- **Local state:** kept under `<agentDir>/pika/`: per-stream cursors, a disk spool for pending requests and blobs, the set of hashes the server has acknowledged, and the device key in `device-key.json` (`{ "v": 1, "key", "machine" }`, mode 0600; a file copied from another machine is replaced, and `/pika logout` keeps it).
- **Login command:** `/pika login` asks for the server URL, then `ctx.ui.select("How should this machine log in?", ["Pair with the pika web UI (recommended)", "Paste a token"])`; cancelling changes nothing.
  - **Pairing:** it asks for the device name (any name per the rule in "Identity"; default: the hostname without a trailing `.local`, cut to 64 characters, else `pi`) and calls `POST start` with the device key, and with the configured token as the bearer only when the configured URL is the one being logged in to. A 404 (a pika older than 0.2) means the server cannot pair: it says so and continues with the token prompt. It shows the code and `<url>/devices?pair=<code>` (in the TUI with the remaining time and "Esc cancels"; elsewhere as a notification, waiting until the pairing ends or `ctx.signal` aborts), and polls every `interval` seconds until approved, denied, expired, unknown, cancelled, or 10 minutes have passed.
  - On approval the token is validated and saved exactly like a pasted one, and the login takes effect at once. Denied, expired, or cancelled changes nothing.
  - After every successful login, and once per pi process when pika is enabled with a URL and token, it calls `POST bind` with the device key and ignores every failure.
  - Messages never include the `pairingId` or the token.
- **Status command:** `/pika` shows whether pika is enabled, the server URL, queued items and bytes, the last successful upload, and the last error.
- **Load order:** the extension is listed last in this repository's `package.json` `pi.extensions`, so its `before_provider_request` handler runs after every other extension's.
