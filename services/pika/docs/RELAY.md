# pika relay v1 (shared contract)

Relay lets a running pi session send text messages to any other running pi session on any machine logged into the same pika server, and shows every active session on a dashboard in the web UI. It is open by default and uses pika's existing device tokens; there is no separate key or login.

- **Server:** `services/pika/` (Rust), a new `relay` module next to ingest. The server is the only route between sessions, including two sessions on the same machine.
- **Extension:** `extensions/relay/` (TypeScript pi extension). It never imports pika; it reads pika's credentials through a `globalThis` registry that `extensions/pika/` publishes.
- **Web:** `services/pika/web/`, an "Active sessions" dashboard.

Deferred, not in v1: addressing subagent and Herder child sessions, a same-machine shortcut, groups or broadcast, attachments, persistent message storage, a blocking ask tool.

## Terms

- **Session id:** pi's session header `id` (a UUID), the same id pika uses for uploaded sessions. It is the only address; names and titles are for display.
- **Online session:** a session holding an open relay connection that has passed `hello`.
- **Message:** UTF-8 text from a session, or from the user in the web UI, to one session id.
- **Delivered:** the target's pi process accepted the message into its session (`pi.sendMessage` returned and the receipt entry was appended) and acknowledged it. It does not mean the model has read it.

## Constants

| Name | Value |
| --- | --- |
| Message TTL (undelivered messages are dropped after) | 300 s |
| Server heartbeat interval (`ping`) | 20 s |
| Connection considered dead after no frame for | 45 s (both sides) |
| `hello` must arrive within | 10 s of the upgrade |
| Max message text | 32 KiB (UTF-8 bytes) |
| Max WebSocket frame | 64 KiB |
| Send rate per sending session | 60 per minute (sliding window) |
| Send rate per device, across its sessions | 300 per minute (sliding window) |
| Outgoing buffer per connection | 8 MiB of queued frames, above a full backlog (100 frames of at most 64 KiB plus metadata); a slower reader is closed with 1008 |
| A socket write must finish within | 45 s, or the connection is closed as dead |
| Owner memory after a session goes offline | the message TTL, and while messages are queued for it; at most 10,000 remembered sessions, the oldest forgotten first |
| Queued messages per target session | 100 |
| Queued messages in the whole mailbox | 10,000 |
| Max hops | 8 |
| Online sessions per server | 1,000 |
| Connections per device | 64 |
| Dashboard event ring | last 500 events |

The server reads TTL and heartbeat from internal configuration so tests can shorten them. `PIKA_RELAY_TTL_SECS` and `PIKA_RELAY_HEARTBEAT_SECS` exist for tests and the end-to-end script only and are documented as such.

## Server

### Configuration and discovery

- `PIKA_RELAY` = `on` (default) | `off`. When off, every relay route answers 404 `{ error: "relay_disabled" }` and the WebSocket upgrade is refused with that response.
- `GET {base}/api/health` gains `features: string[]`, containing `"relay"` when relay is on. Older servers have no `features`; the extension treats that as "no relay".
- Version 0.3.0.

### Device WebSocket: `GET {base}/api/relay/v1/connect`

- **Auth:** `Authorization: Bearer <device token>`, checked before the upgrade: 401 `{ error: "unauthorized" }` for a missing, unknown, or revoked token. Any device token may connect (open by default). The connection belongs to that device.
- Proxies that authenticate must leave `/api/relay/` open, like `/api/ingest/` and `/api/pair/`.
- **Frames:** JSON text frames, one object each, with a string `type`. A frame that is not valid JSON, has an unknown `type`, or exceeds 64 KiB closes the connection with code 4400. Binary frames close with 4400.
- **Close codes:** 1001 server shutting down or connection silent too long, 1008 outgoing buffer full (slow reader), 4400 bad frame, 4401 token revoked, 4403 session belongs to another device, 4408 no `hello` in time, 4409 session already online from another device, 4410 replaced by a newer connection for the same session, 4429 too many connections or online sessions, 4503 relay turned off (reserved; v1 has no runtime toggle).
- **Writes never block the connection:** each connection has a writer separate from its reader, so the silence timeout, heartbeat, token check, and close still run while a write waits. A write that does not finish within 45 s, or a queue over 8 MiB, closes the connection. Unacknowledged messages stay queued and are pushed again on reconnect.

#### Client → server

- `hello`, exactly once, first:
  ```
  { type: "hello", session: { id, name?, title?, cwd, project, host, model?, state: "idle" | "busy", piVersion?, relayVersion } }
  ```
  - `id` must look like a pi session id (1–128 characters of `[A-Za-z0-9._-]`); `name`, `title`, `model` are cut to 200 characters, `cwd` to 1024, `project` and `host` to 255.
  - **Ownership:** the owner of a session id is, in order, the device pika's `sessions` table records for it, the device holding it online, or the device that last held it online if that was within the TTL or messages are still queued for it. A `hello` from a device other than a recorded or remembered owner closes 4403; one while the id is online from another device closes 4409. If it is online from the same device, the older connection is closed with 4410 and this one takes over.
  - The token is checked again when `hello` arrives, so a device revoked between the upgrade and `hello` is closed with 4401.
  - On success the server answers `welcome` and then pushes every queued, unexpired message for this session in acceptance order.
- `state`: `{ type: "state", state?: "idle" | "busy", name?, title?, model? }` updates the online entry.
- `send`: `{ type: "send", clientId, to, text, urgent?: boolean, replyTo?: string, hops: number }`
  - `clientId` is the sender's correlation id (≤ 64 characters); `to` is a session id; `hops` is an integer ≥ 1.
  - The server answers `sent` with the same `clientId`: either `{ type: "sent", clientId, id, status: "delivered" | "queued", to: Target }`, where `queued` means the target is offline or has not acknowledged yet, or `{ type: "sent", clientId, status: "rejected", reason }`.
  - **Rejection reasons, checked in this order:** `invalid` (empty text, bad id, bad hops), `self` (to its own session), `too_large` (text over 32 KiB, or a `message` frame over 64 KiB once JSON-encoded, which escaping control characters can cause; this applies to web sends too), `rate_limited` (per session or per device), `hop_limit` (`hops` > 8), `unknown_session` (`to` is neither online nor a session pika has recorded), `mailbox_full`.
  - A message to an online target is pushed at once; `sent` reports `delivered` only if the target's `ack` arrives within 2 s, otherwise `queued`.
- `ack`: `{ type: "ack", id }` from the target after it delivered message `id`. Unknown or already-acknowledged ids are ignored.
- `pong`: `{ type: "pong" }` in answer to `ping`. Any frame counts as liveness.

#### Server → client

- `welcome`: `{ type: "welcome", device, serverVersion, limits: { ttlSeconds, heartbeatSeconds, maxTextBytes, maxHops } }`.
- `message`: `{ type: "message", id, from: Sender, text, urgent, replyTo?, hops, sentAt }`, where `Sender` is `{ kind: "session", sessionId, device, name?, title?, project? }` or `{ kind: "web" }`. Pushed again after a reconnect while unacknowledged; the client deduplicates by `id`.
- `status`: `{ type: "status", id, status: "delivered" | "expired", to: Target, at }` for messages this session sent. Sent to the sender's current connection; if the sender is offline it is dropped.
- `ping`: `{ type: "ping", at }` every heartbeat interval.

`Target` is `{ sessionId, device?, name?, title?, project? }`, filled from the online entry or pika's records when known.

Message ids are server-generated, URL-safe, and unique for the server's lifetime.

### Mailbox and lifecycle

- Held in memory only; a restart drops queued messages and the event ring. Session transcripts, which pika already uploads, are the permanent record.
- A message is accepted (`queued`), pushed while the target is online, and becomes `delivered` on `ack`. If it is not acknowledged within the TTL of its acceptance, it is removed and becomes `expired`, and the sender gets `status: expired`.
- **Bound to the target's device:** when a message is accepted, the target's owner (see Ownership) is recorded with it if known, and the message is pushed only to a connection of that device.
- **Sender reconnecting:** if the sender's connection changed between `send` and the outcome, a `delivered` outcome that can no longer be reported as `sent` goes to the sender's current connection as `status: delivered`.
- **Timers:** expiry and the 2 s ack wait are cancelled or ignored once a message is acknowledged; the number of pending timers never exceeds the number of queued messages plus sends in their 2 s ack wait.
- **Dead connections:** the server closes a connection after 45 s without any frame and marks the session offline. Unacknowledged messages stay queued for their remaining TTL.
- **Revoking a token** closes every relay connection made with it with 4401 at once: from the Devices route, and when a pairing approved with `replace` revokes the old token. `pika token revoke` runs in another process, so the server also checks each connection's token every heartbeat and closes it within one heartbeat.
- `PIKA_RELAY=off` at startup disables everything. There is no runtime toggle in v1.

### Device HTTP route

- `GET {base}/api/relay/v1/sessions` with the bearer token → `{ items: OnlineSession[] }`.
  ```
  OnlineSession = { id, device, host, name?, title?, cwd, project, model?, state, piVersion?, connectedAt, stateSince, lastSeenAt, recorded: boolean }
  ```
  `recorded` says whether pika has the session's transcript. Items are sorted by device, then by `connectedAt` with the newest first.

### Browser routes (authenticated like the rest of `{base}/api/v1/`)

- `GET relay/sessions` → `{ items: OnlineSession[] }`, the same list.
- `POST relay/messages` with body `{ to, text, urgent?: boolean }` → 200 `{ id, status: "delivered" | "queued", to: Target }`, or 400 or 429 `{ error: <reason> }` with the same reasons as `send` (no `self` or `hop_limit`). The sender is `{ kind: "web" }`, with hops 0.
- `GET relay/events?limit=` (default 100, max 500) → `{ items: RelayEvent[] }`, newest first:
  ```
  RelayEvent = { id, at, from: Sender, to: Target, status: "queued" | "delivered" | "expired" | "rejected", reason?, deliveredAt?, urgent, replyTo?, hops, text }
  ```
  One entry per message, updated in place as its status changes. Rejected sends appear with a generated id.

### Tests (Rust)

Use a WebSocket client (for example `tokio-tungstenite`) against the real router. Cover:
- auth and the 401 response;
- `hello` and `welcome`, the 10 s hello timeout, and ownership (4403, 4409, 4410);
- delivery with `ack` and `sent: delivered`;
- an offline target: queued, then delivered on reconnect;
- expiry with a short TTL, sending `status: expired` to an online sender;
- deduplicated re-push after a dropped connection;
- every rejection reason, the rate limit, and the per-target and global queue limits;
- the heartbeat timeout marking a session offline;
- revoking a device, which closes with 4401;
- `PIKA_RELAY=off`, health `features`, and the browser routes, including web sends.

## Credentials registry (`extensions/pika/`, additive)

pika publishes its active server credentials:

```ts
globalThis[Symbol.for("pi-extensions.pika.credentials")] ??= { current: undefined, listeners: new Set() }
current: { url: string, token: string, isExcluded(cwd: string): boolean } | undefined
listeners: Set<() => void>
```

- `current` is set when pika is enabled with a URL and token, and set to `undefined` when it is disabled (including `PIKA_DISABLED=1`), logged out, or unconfigured.
- pika calls every listener after each change, including `/pika login` switching servers and `/pika logout`.
- `isExcluded` applies pika's `exclude` patterns.
- Either side may create the registry object first, using `??=`, so load order does not matter.

## Extension (`extensions/relay/`)

### When a session connects

A session connects when all of these hold:
- `PI_RELAY_DISABLED` is not `1`;
- the credentials registry has a `current` value, and `isExcluded(cwd)` is false;
- `ctx.mode` is `tui` or `rpc`;
- the session is not a child;
- the user has not run `/relay off` in this session;
- the server's health lists `"relay"`.

Otherwise it stays offline. `/relay` explains why, and the reason is reported once per process with `ctx.ui.notify` only for an unsupported server.

**Tools and the child hook follow the same conditions.** The tools are registered only in a session that is not a child and runs in `tui` or `rpc` mode; print and json sessions, including every Subagents and Herder child, never get them. The child-session hook is registered only while at least one session in the process could connect (not excluded, not `/relay off`, a supported mode, credentials present), because a registered hook makes Subagents persist every child session to disk; `/relay off` and `/relay on` re-evaluate it.

**Children:** the extension registers a child-session hook in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]`. Subagents and Herder append its factory last to every child session. The factory records the child's session id in a process-wide set when its `session_start` runs. The relay instance in a child defers its connect decision until after `session_start` handlers have run, and stays offline if its id is in that set.

**Lifecycle:**
- One connection per online session, opened after `session_start`.
- On session replacement (`/new`, `/resume`, fork), the old connection closes and the new session connects.
- On `session_shutdown` the connection closes.
- A credentials change reconnects to the new server, or disconnects on logout.
- Reconnects use backoff of 1 s, 2 s, 4 s … up to 30 s, with jitter. Close codes 4401, 4403, 4409, 4410 and 4503 stop reconnecting until credentials change or `/relay on`. 4410 means another pi process opened the same session and took it over; `/relay on` takes it back.
- **Leaving:** on `session_before_switch` or `session_before_fork` the session closes its connection (code 1000) without reconnecting, so the server keeps its messages queued and enforces their TTL. Nothing is held locally. If `session_shutdown` has not followed within 10 s (the replacement was cancelled, or failed as a `/clone` of an unsaved session or a `/resume` of a session whose cwd is gone can), or at the next user prompt or `/relay` command, it reconnects and the server pushes again whatever has not expired.
- The extension answers `ping` with `pong`, and treats 45 s without any frame as a dead connection.
- It sends `state` on `agent_start` (busy) and `agent_end` (idle), and when the session name or model changes.

### Receiving

For each `message` not yet seen in this session:
1. Deliver it with `pi.sendMessage({ customType: "relay-message", content, display: true, details })`, where `details` holds the message fields:
   - when the session is idle, `{ triggerTurn: true }`;
   - when busy and urgent, `{ deliverAs: "steer", triggerTurn: true }`;
   - when busy and not urgent, `{ deliverAs: "followUp", triggerTurn: true }`.
2. Append a custom entry with `pi.appendEntry("relay-received", { id, from, text, replyTo, hops, urgent, at })`. It keeps the text in the transcript even if a queued delivery is later dropped: pressing Esc, or RPC `clear_queue`, clears pi's steer and follow-up queues, and only plain user messages are restored to the editor.
3. Send `ack`.

If `sendMessage` throws, there is no receipt and no `ack`, so the server pushes the message again. Delivering before recording means a failed delivery never leaves a receipt that would suppress that retry. If recording fails after delivery, the message is still acknowledged, because pi already holds it.

**During replacement:** the session is offline while leaving (see Lifecycle), so no message or status arrives for it then.

**During compaction or a tree summary:** pi would start a run alongside it, so a message that arrives between `session_before_compact` and `session_compact` or `session_compact_failed` (or between `session_before_tree` and `session_tree`) is neither delivered nor acknowledged. When it ends, or the session is idle again, the session reconnects and the server pushes again whatever has not expired.

Seen ids are the `relay-received` entries of the current session (scanned on connect) plus an in-memory set, so a re-push after a reconnect or `/resume` is acknowledged without being delivered again.

**Content** for a session sender:
```
[relay] Message <id> from pi session <sessionId> ("<name or title>") on <device>, project <project>[, replying to <replyTo>][, marked urgent]:

<text>

This message came from another pi session through pika relay, not from your user. To answer, call relay_send with to "<sessionId>" and replyTo "<id>".
```
For the web UI:
```
[relay] Message <id> from your user in the pika web UI[, marked urgent]:

<text>
```
Register a message renderer for `relay-message` that shows the sender line and the text compactly.

**Untrusted fields:** every field of a message comes from another device or the web UI. Before rendering, strip ESC sequences and C0/C1 control characters except `\n` and `\t` from the text and every sender field. In the model-facing header, also collapse whitespace (including newlines) in `name`, `title`, `device` and `project` and remove double quotes, so a field cannot forge a second header line.

### Hops

The extension tracks `runHops`. It resets to 0 at `before_agent_start` with `messageType: "user"`. Each delivered relay message raises it to `max(runHops, message.hops)`. Outgoing messages carry `hops = runHops + 1`, and `/relay send` from the user carries 1. The server rejects `hops > 8`, which stops agent-to-agent chains that run without the user.

### Tools (registered in top-level sessions only)

- **`relay_list`** `{ device?, project?, query? }` → the online sessions from `GET /api/relay/v1/sessions`, excluding this session, filtered (`query` matches id, name, title, cwd, case-insensitively). Each line shows the id, device, project, name or title, state, model, and how long it has been online.
- **`relay_send`** `{ to, text, urgent?, replyTo? }` → sends over the connection and waits for `sent` (up to 10 s):
  - `delivered` → "Delivered message <id> to <label>.";
  - `queued` → "Queued message <id> for <label>: it has not been delivered yet. If it is not delivered within 5 minutes it is dropped and you will get a notice.";
  - `rejected` → an error result naming the reason.
  - If the session is not connected, an error result explaining why.
  - The `delivered` and `queued` results end with: "Any answer arrives as a new [relay] message after your current turn ends, never during it: do not sleep or poll for it. End your turn now, telling your user what you are waiting for if that helps." The tool descriptions of `relay_send` and `relay_status` say the same. In a live test a model otherwise kept sleeping and polling `relay_status` inside its turn, while pi held the answer until that turn ended. `/relay send` shows the results without this sentence.
- **`relay_status`** `{ id? }` → the state of messages this session sent in this process (`queued` | `delivered` | `expired` | `rejected`), newest first, at most 50.

### Notices to the sender

On `status: expired`, the extension sends `pi.sendMessage({ customType: "relay-notice", content, display: true, details }, { deliverAs: "steer", triggerTurn: true })` with:
```
[relay] Your message <id> to <label> expired: it was not delivered within 5 minutes and was dropped.
```
`status: delivered` updates `relay_status` silently and does not wake the session.

### Command `/relay`

- `/relay` shows the connection state and reason, the server URL, this session's id, and the online sessions.
- `/relay send <sessionId> <text>` sends as the user (hops 1).
- `/relay off` and `/relay on` disconnect or reconnect this session for its lifetime.

### Tests (Vitest, offline)

- A fake relay server using the `ws` package (a devDependency) and real pi sessions with the faux provider, as pika's tests do.
- Cover:
  - each connect condition: mode, child, excluded, disabled, unsupported server, and credentials appearing late or switching;
  - `hello` contents;
  - `state` updates;
  - delivery when idle (starts a turn), when busy (followUp), and when urgent (steer);
  - the receipt entry, deduplication across reconnect and `/resume`, and `ack`;
  - hop accounting;
  - the three tools and every `sent` outcome;
  - the expiry notice waking the sender;
  - reconnect backoff and the terminal close codes;
  - `/relay` subcommands;
  - a real Subagents child staying offline.

## Web (`services/pika/web/`)

- **"Active sessions" page** at `/active`, linked in the sidebar above Devices, with a count badge of online sessions.
  - Online sessions are grouped by device. Each row shows the name or title, project, cwd, an idle or busy indicator, the model, how long it has been online, and the last activity.
  - When `recorded`, the row links to the session page.
  - Each row has a "Message" action that opens a composer: text, an "urgent" checkbox, and Send. Send posts `relay/messages` and shows the resulting status.
  - The page polls `relay/sessions` and `relay/events` every 3 s while visible.
- **"Recent messages"** on the same page: the events, newest first. Each shows the sender, the target, the status (with the reason for rejections), the time, and the text collapsed to 3 lines and expandable.
- **Session page:** shows an "Online" badge and the same Message action when the session is online.
- **Turns started by a relay message:** `GET sessions/:id/turns` gains `customType?: string`, the `customType` of the `custom_message` that started the turn (absent for user prompts). It is read from the existing `entries.custom_type` at the turn's `startSeq`, so it needs no migration or reindex. The turn list shows a `relay-message` turn as "Relay message" with a message icon instead of "Prompt N" with a person icon, and other extension-started turns as "Extension message"; their text is unchanged.
- **No relay:** when the server has relay off, or health lacks `"relay"`, the page explains that relay is off and the sidebar item is hidden.
- Tests in the existing web suite, in the existing Notion-like style, in light and dark.

## Reverse proxies (`services/pika/deploy/`)

- **nginx:** add a `location /api/relay/` (and `/pika/api/relay/` in the path example) with `proxy_http_version 1.1`, `Upgrade $http_upgrade`, and `Connection "upgrade"`.
  - It must repeat `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`, because a location with its own `proxy_set_header` inherits none from the server block.
  - `auth_basic off`.
  - The default 120 s read timeout is enough with the 20 s heartbeat.
- **Caddy:** proxies WebSockets as is. Add `/api/relay/*` to the paths left open in the optional `basic_auth` matcher.

## End to end (`services/pika/scripts/e2e.sh`)

- Two real pi processes (RPC mode, faux or mock provider) logged into the real server.
- A asks B something with `relay_send`; B's turn starts with the message, and B's reply reaches A.
- A message to a session that goes offline expires with a short test TTL, and A receives the notice.
- The dashboard is screenshotted in light and dark with both sessions online and messages listed.
- A message sent from the dashboard reaches B.
