# pika relay v1 (shared contract)

Relay lets a running pi session send text messages to any other running pi session on any machine logged into the same pika server, and shows every active session on a dashboard in the web UI. It is open by default and uses pika's existing device tokens; there is no separate key or login.

- **Server:** `services/pika/` (Rust), a new `relay` module next to ingest. The server is the only route between sessions, including two sessions on the same machine.
- **Extension:** `extensions/pika/relay/`, part of the pika extension (TypeScript pi extension). It reads pika's credentials through the `globalThis` registry that `extensions/pika/credentials.ts` publishes, so module copies loaded for other cwds share them.
- **Web:** `services/pika/web/`, an "Active sessions" dashboard.

Deferred, not in v1: addressing subagent and Herder child sessions, a same-machine shortcut, groups or broadcast, attachments, a blocking ask tool.

## Terms

- **Session id:** pi's session header `id` (a UUID), the same id pika uses for uploaded sessions. It is the only address; names and titles are for display.
- **Online session:** a session holding an open relay connection that has passed `hello`.
- **Device:** every `device` field is the device's id, which never changes; every object that carries `device` also carries `deviceName`, the device's current display name (its id when it has none; see "Identity" in `SPEC.md`). Ownership, addressing, limits, and revocation are keyed by the id. The server looks names up when it serializes an object, so a rename shows in the next `relay/sessions` or `relay/events` answer and in every frame sent after it.
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
- `PIKA_RELAY_MAX_HOPS` = the hop limit, a positive integer, default 128.
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
  - `project` is the name of the git repository holding `cwd` as pika files the session: the main checkout's folder, also from a subdirectory, a linked worktree, a Herder step, or a Subagents worktree child. The extension gets it from the credentials registry's `repository(cwd)` and waits at most 3 s for it before each connect. Outside git, with an older pika without `repository`, or when it fails, `project` is the basename of `cwd`.
  - **Ownership:** the owner of a session id is, in order, the device pika's `sessions` table records for it, the device holding it online, or the device that last held it online if that was within the TTL or messages are still queued for it. A `hello` from a device other than a recorded or remembered owner closes 4403; one while the id is online from another device closes 4409. If it is online from the same device, the older connection is closed with 4410 and this one takes over. The same owner decides which device may act for a session in a room (`POST {base}/api/relay/v1/rooms`).
  - The token is checked again when `hello` arrives, so a device revoked between the upgrade and `hello` is closed with 4401.
  - On success the server answers `welcome` and then pushes every queued, unexpired message for this session in acceptance order.
- `state`: `{ type: "state", state?: "idle" | "busy", name?, title?, model? }` updates the online entry.
- `send`: `{ type: "send", clientId, to, text, urgent?: boolean, replyTo?: string, hops: number }`
  - `clientId` is the sender's correlation id (≤ 64 characters); `to` is a session id; `hops` is an integer ≥ 1.
  - The server answers `sent` with the same `clientId`: either `{ type: "sent", clientId, id, status: "delivered" | "queued", to: Target }`, where `queued` means the target is offline or has not acknowledged yet, or `{ type: "sent", clientId, status: "rejected", reason }`.
  - **Rejection reasons, checked in this order:** `invalid` (empty text, bad id, bad hops), `self` (to its own session), `too_large` (text over 32 KiB, or a `message` frame over 64 KiB once JSON-encoded, which escaping control characters can cause; this applies to web sends too), `rate_limited` (per session or per device), `hop_limit` (`hops` > the hop limit, 128 by default), `unknown_session` (`to` is neither online nor a session pika has recorded), `mailbox_full`.
  - A message to an online target is pushed at once; `sent` reports `delivered` only if the target's `ack` arrives within 2 s, otherwise `queued`.
- `send` to a room: `{ type: "send", clientId, room, text, mentions?: string[], urgent?, replyTo?, hops }`, without `to` (see Rooms).
  - Answered `{ type: "sent", clientId, id, status: "delivered", room, notified: Target[], to: Target, unmatched?: string[] }`, where `to` is `#<room>`, or rejected as above.
  - **Rejection reasons, checked in this order:** `invalid`, `too_large`, `rate_limited`, `hop_limit`, `unknown_room` (no such room), `not_member` (the sending session is not a member).
- `ack`: `{ type: "ack", id }` from the target after it delivered message `id`. Unknown or already-acknowledged ids are ignored.
- `pong`: `{ type: "pong" }` in answer to `ping`. Any frame counts as liveness.

#### Server → client

- `welcome`: `{ type: "welcome", device, deviceName, serverVersion, limits: { ttlSeconds, heartbeatSeconds, maxTextBytes, maxHops } }`.
- `message`: `{ type: "message", id, room?, mentions?, from: Sender, text, urgent, replyTo?, hops, sentAt }`, where `Sender` is `{ kind: "session", sessionId, device, deviceName, name?, title?, project? }` or `{ kind: "web" }`. Pushed again after a reconnect while unacknowledged; the client deduplicates by `id`.
- `status`: `{ type: "status", id, status: "delivered" | "expired", to: Target, at }` for messages this session sent. Sent to the sender's current connection; if the sender is offline it is dropped.
- `ping`: `{ type: "ping", at }` every heartbeat interval.
- `room`: `{ type: "room", room, representative?, at }` when a room's representative changes (see Room representatives); `representative` is the new one's session id, absent when nobody represents the room now.

Clients ignore frame types they do not know, so a server may add frames.

`Target` is `{ sessionId, device?, deviceName?, name?, title?, project? }`, filled from the online entry or pika's records when known; `deviceName` is present exactly when `device` is. Servers older than 0.4 send no `deviceName` anywhere, so clients treat it as optional.

Message ids are server-generated and URL-safe, carrying 72 random bits plus a counter so they stay unique across restarts.

### Mailbox and lifecycle

- Live WebSocket connections and online state are held in memory; the mailbox (unexpired queued messages, re-armed for their remaining TTL or expired on startup), the 500-event ring, and chatrooms (up to 200 rooms, with their members, representatives, monotonic `seq`, and last 200 messages per room) are persisted in SQLite (`relay_*` tables, not cleared by `pika reindex`). Session transcripts, which pika already uploads, are the permanent record.
- A message is accepted (`queued`), pushed while the target is online, and becomes `delivered` on `ack`. If it is not acknowledged within the TTL of its acceptance, it is removed and becomes `expired`, and the sender gets `status: expired`.
- **Bound to the target's device:** when a message is accepted, the target's owner (see Ownership) is recorded with it if known, and the message is pushed only to a connection of that device.
- **Sender reconnecting:** if the sender's connection changed between `send` and the outcome, a `delivered` outcome that can no longer be reported as `sent` goes to the sender's current connection as `status: delivered`.
- **Timers:** expiry and the 2 s ack wait are cancelled or ignored once a message is acknowledged; the number of pending timers never exceeds the number of queued messages plus sends in their 2 s ack wait.
- **Stopping the server** (SIGTERM or Ctrl+C) closes every relay connection with 1001 and waits up to 3 s for them to finish. A closing connection reads the peer's answer to its close frame for up to 2 s, because a socket closed with that answer unread is reset and the peer never sees the close frame.
- **Dead connections:** the server closes a connection after 45 s without any frame and marks the session offline. Unacknowledged messages stay queued for their remaining TTL.
- **Revoking a token** closes every relay connection made with it with 4401 at once: from the Devices route, and when a pairing that continues a device revokes its old token. `pika token revoke` runs in another process, so the server also checks each connection's token every heartbeat and closes it within one heartbeat.
- `PIKA_RELAY=off` at startup disables everything. There is no runtime toggle in v1.

### Device HTTP route

- `GET {base}/api/relay/v1/sessions` with the bearer token → `{ items: OnlineSession[] }`.
  ```
  OnlineSession = { id, device, deviceName, host, name?, title?, cwd, project, model?, state, piVersion?, connectedAt, stateSince, lastSeenAt, recorded: boolean }
  ```
  `recorded` says whether pika has the session's transcript. Items are sorted by `deviceName` case-insensitively, then by `device`, then by `connectedAt` with the newest first.

- **GET `{base}/api/relay/v1/rooms`** with the bearer token → `{ items: RelayRoom[] }` (explicit topic chatrooms). `RelayRoom` is `{ name, topic?, createdAt, updatedAt, messageCount, members, representative?, lastMessage? }`; `representative` is the session id of the room's representative, absent when it has none.
- **POST `{base}/api/relay/v1/rooms`** with `{ room, sessionId, action?: "join" | "leave" | "represent" | "unrepresent", topic? }` → joins, leaves, represents, or stops representing an explicit room (joining or representing creates it), returning `{ room: RelayRoom, messages: RoomMessage[] }`. A device acts only for its own sessions: for every action, a session whose owner (see Ownership) is another device answers 403 `not_owner`, and one that nobody owns 400 `unknown_session`; neither changes the room or pushes a frame. Joining or representing also needs a session that is online or recorded (else 400 `unknown_session`), and leaving or unrepresenting a room that does not exist answers 400 `invalid`.
- **GET `{base}/api/relay/v1/rooms/{name}?limit=&after=`** → `{ room: RelayRoom, messages: RoomMessage[] }`, allowing any agent to read room message history on demand.

### Rooms

- Rooms are created and joined only by the user: `/relay join` and `/relay represent` in pi (the device `POST rooms` route), or the web UI (`POST relay/rooms`, the member route). Leaving likewise. Posting never creates a room or adds a member.
- **Posting:** the room must exist (`unknown_room`), and a session must be a member (`not_member`); a refused post is stored nowhere and pushed to nobody, and appears in the event ring as rejected. The web UI may post to any existing room. An accepted post joins the room's history (its last 200 messages) and is answered `delivered`.
- **Mentions:** the tokens of `mentions` and the `@token`s in `text` resolve only among the room's current members: by session id (or a prefix of at least 8 characters), or by name, title, or project (case-insensitive, spaces as `-` or `_`). `all`, `everyone`, and `*` name every member. Each named member except the sender gets a `message` with `room` and `mentions`, queued while it is offline, with no `status` to the sender; the others see the post only in the history.
- `unmatched` lists the tokens that named no member, in order (`all`, `everyone`, `*`, and a token naming the sender count as matched); it is absent when every token matched. Clients that predate it ignore it.

### Room representatives

A room may have one representative: a member session that stands for the user. The other members take it that the user does not read their own output and report to the representative, which talks to the user. The extension lets only a session with swarm mode represent (see `/relay represent`).

- `represent` makes the session a member if it is not one, and replaces any previous representative.
- `unrepresent` clears the representative only when this session is it; otherwise nothing changes.
- A representative that leaves the room, by `leave` or by the browser's member route, stops representing it. Deleting a room ends its representative too. Going offline does not.
- Each change pushes `room` to every online member of the room, and to the previous representative if it left. An action that changes nothing pushes nothing. Clients learn the current representatives from `GET rooms` when they connect.
- The representative is persisted with the room in SQLite (`relay_rooms`), so it survives restarts.

### Browser routes (authenticated like the rest of `{base}/api/v1/`)

- `GET relay/sessions` → `{ items: OnlineSession[] }`, the same list.
- `GET relay/rooms` → `{ items: RelayRoom[] }`, with `representative` as for devices.
- `POST relay/rooms` with `{ name, topic?: string | null, members?: string[] }` → creates or updates an explicit chatroom and its member sessions; omitting `topic` keeps an existing room's topic unchanged, while passing `null` or `""` (or whitespace) clears it.
- `GET relay/rooms/{name}` → `{ room: RelayRoom, messages: RoomMessage[] }`.
- `POST relay/rooms/{name}/members` with `{ sessionId, action?: "add" | "remove" | "represent" | "unrepresent" }` → adds, removes, elects as representative, or clears as representative a member session, whichever device owns it; removing the representative clears it.
- `DELETE relay/rooms/{name}` → deletes the room (`204 No Content`); if it had a representative, its online members get `room` without one.
- `POST relay/messages` with body `{ to, text, urgent?: boolean }` (1:1) or `{ room, text, mentions?: string[], urgent?: boolean }` (chatroom) → 200 `{ id, status: "delivered" | "queued", to: Target, room?, notified?, unmatched? }`, or 400, 404, or 429 `{ error: <reason> }` with the same reasons as `send` (no `self` or `hop_limit`; an unknown room is 404 `unknown_room`, and `not_member`, which a web post never gets, would be 403). The sender is `{ kind: "web" }`, with hops 0. In a chatroom, which must exist, only the `@`-mentioned members receive a `message` push that triggers a turn (see Rooms).
- `GET relay/events?limit=` (default 100, max 500) → `{ items: RelayEvent[] }`, newest first:
  ```
  RelayEvent = { id, at, from: Sender, to: Target, status: "queued" | "delivered" | "expired" | "rejected", reason?, deliveredAt?, urgent, replyTo?, hops, text }
  ```
  One entry per message, updated in place as its status changes. Rejected sends appear with a generated id.

### Boards

A swarm board is the kanban board of a coordinator session: its cards and their status. The coordinator's pi process publishes it in process (see "Swarm boards" under Extension); pika uploads the full snapshot, and the web UI shows the boards of a room's members. The server keeps one board per session, the latest snapshot, in `relay_boards` (schema version 20, not derived, so `pika reindex` leaves it; deleting the session deletes it). Board routes are relay routes: `PIKA_RELAY=off` answers them 404 `relay_disabled`.

```
Board = { version: 1, sessionId, updatedAt: number /* Unix ms */, cards: Card[] }
Card = { id, title, status: "todo" | "doing" | "blocked" | "done" | "failed" | "dropped", agentId?, agent?, note?,
         createdBy, updatedBy, createdAt: number, updatedAt: number }
```

- **`PUT {base}/api/relay/v1/boards/{sessionId}`** with the bearer token and a `Board` body → 200 `{ sessionId, status: "stored" | "stale", updatedAt }`.
  - Only the session's owner (see Ownership) may upload: another device answers 403 `not_owner`, a session nobody owns 400 `unknown_session`.
  - The body is at most 64 KiB and holds at most 200 cards, else 413 `{ error: "too_large", message }`. A body that is not JSON, has another `version`, a `sessionId` other than the path's, a time that is not an integer of Unix milliseconds, an unknown `status`, a card without `id`, `title`, `createdBy`, or `updatedBy` strings, or two cards with one `id` answers 400 `{ error: "invalid", message }`. Unknown fields are dropped.
  - A snapshot whose `updatedAt` is older than the stored one's changes nothing and answers `stale` with the stored `updatedAt`; an equal one replaces it.
- **`GET relay/boards/{sessionId}`** (browser) → `BoardView`, or 404 `not_found` when the session has none.
- **`GET relay/rooms/{name}/boards`** (browser) → `{ room, items: BoardView[] }`, the boards of the room's member sessions in member order, each with the member's `online`; 404 `not_found` for an unknown room.
  ```
  BoardView = { sessionId, device, deviceName, name?, title?, project?, online?, updatedAt, receivedAt, cards: CardView[] }
  ```
  Times are ISO strings: `updatedAt` the snapshot's, `receivedAt` when the server stored it; `CardView` is `Card` with ISO `createdAt` and `updatedAt`. `name`, `title`, and `project` come from the online session, else the room member or pika's records.

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
- revoking a device, and continuing it by pairing, which close with 4401;
- `deviceName` in every object that carries `device`, the sort order of the session lists, and renames showing at once;
- `PIKA_RELAY=off`, health `features`, and the browser routes, including web sends;
- room posts: `unknown_room`, `not_member` storing and pushing nothing, mentions reaching members only with the rest in `unmatched`, and web posts to any existing room;
- room actions only for the calling device's sessions: each from the owner, 403 `not_owner` from another device changing nothing, 400 `unknown_session` for an id nobody owns;
- boards: upload by the owner only, validation and the 200-card and 64 KiB caps, stale snapshots, the room and session reads, and deletion with the session;
- room representatives: `represent` replacing and joining, `unrepresent` by others changing nothing, leaving, browser removal, and deletion clearing it, the `room` frame reaching exactly the online members, and the summaries in every room route.

## Credentials registry (`extensions/pika/`, additive)

pika publishes its active server credentials:

```ts
globalThis[Symbol.for("pi-extensions.pika.credentials")] ??= { current: undefined, listeners: new Set() }
current: { url: string, token: string, isExcluded(cwd: string): boolean } | undefined
listeners: Set<() => void>
repository?: (cwd: string) => Promise<{ project?: string, repository?: string }>
```

- `current` is set when pika is enabled with a URL and token, and set to `undefined` when it is disabled (including `PIKA_DISABLED=1`), logged out, or unconfigured.
- pika calls every listener after each change, including `/pika login` switching servers and `/pika logout`.
- `isExcluded` applies pika's `exclude` patterns.
- `repository(cwd)` resolves the git repository of `cwd` the way pika names its sessions: `project` is the repository's name and `repository` its web URL without credentials, both absent outside git. It is cached per cwd, never rejects, and settles within a few seconds. pika sets it whether or not it is logged in; pika versions before it lack it, so callers fall back to the basename of `cwd`.
- Either side may create the registry object first, using `??=`, so load order does not matter.

## Extension (`extensions/pika/relay/`)

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
   - when busy, `{ deliverAs: "steer", triggerTurn: true }` if the message is urgent, or if its peer is a conversation of the session (see below) and no earlier message of that peer waits as a follow-up;
   - otherwise `{ deliverAs: "followUp", triggerTurn: true }`.
2. Append a custom entry with `pi.appendEntry("relay-received", { id, from, text, replyTo, hops, urgent, at })`. It keeps the text in the transcript even if a queued delivery is later dropped: pressing Esc, or RPC `clear_queue`, clears pi's steer and follow-up queues, and only plain user messages are restored to the editor.
3. Send `ack`.

If `sendMessage` throws, there is no receipt and no `ack`, so the server pushes the message again. Delivering before recording means a failed delivery never leaves a receipt that would suppress that retry. If recording fails after delivery, the message is still acknowledged, because pi already holds it.

**Conversations:** pi holds a follow-up until the turn ends. A busy session that writes to the sender meanwhile has not read the sender's message, so the two messages cross and each side answers the other's stale one. A message's peer is its room (`#<room>`), else its sending session; web UI messages have none. A peer is a conversation of the session for 30 minutes after the session last sent to it (`relay_send`, `relay_room` send, `/relay send`) or its model last read a message of it, which is when pi emits `message_start` for the `relay-message`. A peer's message never overtakes an earlier one of the same peer that waits as a follow-up, unless it is urgent.

**Unread messages:** a delivered message of a peer stays unread until its `message_start`. `agent_settled` forgets what is still unread then, because Esc or RPC `clear_queue` dropped it. `relay_send` and `relay_room` send refuse a send to a peer once for each unread message of it (see Tools), so the model reads the peer's message before it writes again. `/relay send` comes from the user and is never refused.

**During replacement:** the session is offline while leaving (see Lifecycle), so no message or status arrives for it then.

**During compaction or a tree summary:** pi would start a run alongside it, so a message that arrives between `session_before_compact` and `session_compact` or `session_compact_failed` (or between `session_before_tree` and `session_tree`) is neither delivered nor acknowledged. When it ends, or the session is idle again, the session reconnects and the server pushes again whatever has not expired.

Seen ids are the `relay-received` entries of the current session (scanned on connect) plus an in-memory set, so a re-push after a reconnect or `/resume` is acknowledged without being delivered again.

**Content** for a session sender:
```
[relay] Message <id> from pi session <sessionId> ("<name or title>") on <deviceName, else device>, project <project>[, replying to <replyTo>][, marked urgent]:

<text>

This message came from another pi session through pika relay, not from your user. To answer, call relay_send with to "<sessionId>" and replyTo "<id>". Messages can cross on the way: if this one adds nothing to what you already sent, do not reply just to say so.
```
A room message ends with the same last sentence.
For the web UI:
```
[relay] Message <id> from your user in the pika web UI[, marked urgent]:

<text>
```

**Unanswered answers:** a message that starts a turn or waits as a follow-up reaches the model right after an answer the user has not replied to, in the same place a user's reply would take. The model then takes that answer for read and ends the new turn with a summary of it, so a question the user never saw scrolls away above the relay exchange. Every delivery from a session except a steered one therefore ends with one more paragraph:
```
Your user has not written since your last answer to them, so do not take that answer as read. If it still holds something they need (a question, a decision, a result), repeat that in full, not as a summary, in the answer that ends this turn, then say what changed since.
```
A steered message comes before the turn's answer and has no such paragraph; a web UI message is from the user and has none either.

Register a message renderer for `relay-message` that shows one line, `✉ relay ← <sender> [#room] [urgent] [reply to <id>] · <size>` (`42 chars`, `1.2k chars`, `12k chars`), and the text under it only when the message is expanded (Ctrl+O); the content the model reads stays as above. `relay_send` and `relay_room` render their calls and results the same way, one line each until expanded. Every send the server accepts is recorded with `pi.appendEntry("relay-sent", { id, to?, label?, room?, mentions?, text, replyTo?, urgent, status, at })` (`to` and `label` for a session, `room` for a chatroom; `status` is the `sent` answer's `delivered` or `queued`); a rejected, failed, or unanswered send records nothing. `/relay log` lists the branch's `relay-received` and `relay-sent` entries.

**Untrusted fields:** every field of a message comes from another device or the web UI. Before rendering, strip ESC sequences and C0/C1 control characters except `\n` and `\t` from the text and every sender field. In the model-facing header, also collapse whitespace (including newlines) in `name`, `title`, `device`, `deviceName`, and `project` and remove double quotes, so a field cannot forge a second header line.

### Swarm boards

Client-only (`extensions/pika/board.ts`). A coordinator's extension publishes its board in process:

```ts
globalThis[Symbol.for("pi-extensions.swarm-boards")] ??= { version: 1, boards: new Map(), listeners: new Set() }
boards: Map<sessionId, Board>        // Board as in "Boards"
listeners: Set<(board: Board) => void>
```

pika adds a listener while a top-level session (TUI or RPC mode, no `parentSession` in its header) that it captures is open, and uploads that session's board with `PUT boards/{sessionId}`: the snapshot's `version`, `sessionId`, `updatedAt`, and `cards`, at most once per board per second, always the latest snapshot, and once more at `session_shutdown` (waiting at most 2 s). A failure is recorded as `/pika`'s last error, once until it changes: a network error, 429, or 5xx retries after 5 s, doubling up to 60 s; 400, 401, 403, 404, or 413 stops the board's uploads until the credentials change.

### Side answers

Client-only (`extensions/pika/relay/side.ts`); the wire format is unchanged. A busy session that leaves a message from another session unread for `relay.sideAnswerSeconds` of `pika.json` (60 s; `relay.sideAnswers: false` or `/relay side off` turns it off) answers it with one model request beside the turn:

- **Request:** the messages of the turn's last `context_with_system` (pika loads last, so that is what the provider got), the non-error assistant messages and tool results since its `message_end`, a placeholder tool result ("still running for N") for each tool call without one, and a user message `[relay side request] …` holding the message and the answers already given in this run. It goes through `ctx.modelRegistry.streamSimple` with the session's model, `reasoning` set to its thinking level, and its session id, and no `toolChoice`, which on Anthropic would drop the cached messages. Tool calls in the response are never run. `timing.sideTimeoutMs` (120 s) bounds it.
- **Outcomes:** `NO_REPLY` sends nothing. Text sends `[side answer] <preamble>\n\n<answer>`. `DEFER: <reason>`, an empty or tool-call-only response, a failure, or the timeout sends `[busy notice] …` with the run's duration, the oldest running top-level tool and its duration, when the message is read (after the current tool calls when steered, else when the turn ends), and the reason. Both are replies (`replyTo` the message, `hops` the message's plus one; in a room with `mentions: [sender]`) through the same `send` as the tools, without the unread check.
- **The turn:** after an answer, a `relay-side` custom message `{ id, replyId, label, question, text }` is steered in, quoting the question and the answer. pi may deliver the message itself only after the turn, in a turn of its own, so the note comes first and tells the model to correct the answer rather than answer again. The message's unread entry is marked refused, so a correction is not refused.
- **Scheduling:** a timer per message, started after its `ack`; one request at a time, in due order. A message is skipped or its request aborted, and nothing is sent, when its `message_start` comes first, at `agent_settled`, when the session leaves or shuts down, and when side answers are turned off. `agent_start` forgets the previous run's request, so a message due before the run's first request gets a busy notice.
- **Never side-answered:** web UI messages, and messages whose text starts with `[side answer]` or `[busy notice]`, so two busy sessions cannot answer each other's automatic replies.

### Hops

The extension tracks `runHops`. It resets to 0 at `before_agent_start` with `messageType: "user"`. Each delivered relay message raises it to `max(runHops, message.hops)`. Outgoing messages carry `hops = runHops + 1`, and `/relay send` from the user carries 1. The server rejects `hops` above its hop limit, 128 unless `PIKA_RELAY_MAX_HOPS` sets another, and advertises it as `welcome.limits.maxHops`, which the extension's `hop_limit` error text shows. This stops agent-to-agent chains that run without the user; the per-session and per-device send rates still slow a loop below the limit.

### Tools (registered in top-level sessions only)

- **`relay_list`** `{ device?, project?, query? }` → the online sessions from `GET /api/relay/v1/sessions`, excluding this session, filtered (`device` matches the device name or id, `query` matches id, name, title, cwd, case-insensitively). Each line shows the id, device (its name, else its id), project, name or title, state, model, and how long it has been online.
- **`relay_send`** `{ to, text, urgent?, replyTo? }` → sends over the connection and waits for `sent` (up to 10 s):
  - `delivered` → "Delivered message <id> to <label>.";
  - `queued` → "Queued message <id> for <label>: it has not been delivered yet. If it is not delivered within 5 minutes it is dropped and you will get a notice.";
  - `rejected` → an error result naming the reason.
  - If the session is not connected, an error result explaining why.
  - If the target (a session id, or `#<room>`) has unread messages not yet refused for, an error result, without sending; the next send goes out unless another message arrived. When every such message is steered or starts a turn: "Not sent: message <id> from <label> arrived while you were writing yours, and you have not read it yet. It follows this result: read it, then send again if your message still adds something." When one waits as a follow-up: "Not sent: message <id> from <label> waits for you until your current turn ends. End your turn now to read it, then reply if your message still adds something."
  - No `sent` within 10 s, a connection that drops first, or an aborted tool call (pi's abort signal) → an error result saying the message may or may not have been accepted; `relay_status` records it as `unknown` (`timeout`, `closed`, or `cancelled`). A send that never left the session (the connection went offline, or the call was aborted before it was sent) is recorded as `failed`.
  - The `delivered` and `queued` results end with: "Any answer arrives as a new [relay] message after your current turn ends, never during it: do not sleep or poll for it. End your turn now, telling your user what you are waiting for if that helps." The tool descriptions of `relay_send` and `relay_status` say the same. In a live test a model otherwise kept sleeping and polling `relay_status` inside its turn, while pi held the answer until that turn ended. `/relay send` shows the results without this sentence.
- **`relay_room`** `{ action: "list" | "history" | "send", room?, text?, mentions?, urgent?, replyTo?, limit?, after? }` → lists rooms, reads a room's history, or posts to a room. It cannot join or leave: only the user does (`/relay join`, the web UI). A post refused as `unknown_room` or `not_member` says so, and an accepted one names its `unmatched` mentions.
- **`relay_status`** `{ id? }` → the state of messages this session sent in this process (`queued` | `delivered` | `expired` | `rejected` | `failed` | `unknown`), newest first, at most 50.

### Notices to the sender

On `status: expired`, the extension sends `pi.sendMessage({ customType: "relay-notice", content, display: true, details }, { deliverAs: "steer", triggerTurn: true })` with:
```
[relay] Your message <id> to <label> expired: it was not delivered within 5 minutes and was dropped.
```
When the session is idle, the notice starts a turn, and its content ends with the paragraph for unanswered answers (see Receiving). The renderer for `relay-notice` shows the first line only.

`status: delivered` updates `relay_status` silently and does not wake the session.

### Command `/relay`

- `/relay` shows the connection state and reason, the server URL, this session's id, and the online sessions.
- `/relay send <sessionId> <text>` sends as the user (hops 1).
- `/relay rooms`, `/relay join <room> [topic]`, and `/relay leave <room>` list, join, or leave chatrooms; `/relay log` lists the branch's relay messages.
- `/relay represent <room>` makes this session the room's representative, refused unless swarm mode is on; `/relay represent off [<room>]` stops. Turning swarm mode off stops representing every room.
- `/relay side [on|off]` shows side answers, or overrides `relay.sideAnswers` for this session.
- `/relay off` and `/relay on` disconnect or reconnect this session for its lifetime.

### Tests (Vitest, offline)

- A fake relay server using the `ws` package (a devDependency) and real pi sessions with the faux provider, as pika's tests do.
- Cover:
  - each connect condition: mode, child, excluded, disabled, unsupported server, and credentials appearing late or switching;
  - `hello` contents;
  - `state` updates;
  - delivery when idle (starts a turn), when busy (followUp), when urgent or from a conversation (steer), and in order behind a waiting follow-up;
  - the refusal of a send that would cross an unread message, once per message, and forgetting messages a cleared queue dropped;
  - the paragraph for unanswered answers on every delivery but a steered or web UI one, and on an idle session's expiry notice;
  - the receipt entry, deduplication across reconnect and `/resume`, and `ack`;
  - hop accounting;
  - the three tools and every `sent` outcome;
  - the expiry notice waking the sender;
  - reconnect backoff and the terminal close codes;
  - `/relay` subcommands;
  - side answers: the repeated request and its placeholder tool results, each outcome, tool calls never run, the note steered into the turn, rooms, dropping an answer the turn read first, the timeout, the settings, and never answering the web UI or an automatic reply;
  - a real Subagents child staying offline.

## Web (`services/pika/web/`)

- **"Active sessions" page** at `/active`, linked in the sidebar above Devices, with a count badge of online sessions.
  - Online sessions are grouped by device id, each group headed by the device name. Each row shows the name or title, project, cwd, an idle or busy indicator, the model, how long it has been online, and the last activity.
  - When `recorded`, the row links to the session page.
  - Each row has a "Message" action that opens a composer: text, an "urgent" checkbox, and Send. Send posts `relay/messages` and shows the resulting status.
  - The page polls `relay/sessions` and `relay/events` every 3 s while visible.
- **"Recent messages"** on the same page: the events, newest first. Each shows the sender, the target, the status (with the reason for rejections), the time, and the text collapsed to 3 lines and expandable.
- **Session page:** shows an "Online" badge and the same Message action when the session is online.
- **Turns started by a relay message:** `GET sessions/:id/turns` gains `customType?: string`, the `customType` of the `custom_message` that started the turn (absent for user prompts). It is read from the existing `entries.custom_type` at the turn's `startSeq`, so it needs no migration or reindex. The turn list shows a `relay-message` turn as "Relay message" with a message icon instead of "Prompt N" with a person icon, and other extension-started turns as "Extension message"; their text is unchanged.
- **Room boards:** a chatroom's header has a Messages | Board switch. Board replaces the messages and composer with the swarm boards of the room's members (`GET relay/rooms/{name}/boards`, polled every 3 s like the history): one group per coordinator session, headed by its name, project, device, and when it was updated, with columns To do, Doing, Blocked, and Done. Failed and dropped cards sit under Done with a "Failed" or "Dropped" tag. Each card shows its title, note, agent, and when it was updated. Without boards, one line says so.
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
