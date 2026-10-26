# relay

relay lets a running pi session send text messages to any other running pi session, on this machine or on your other machines, through your self-hosted [pika server](../../services/pika/README.md). Every connected session also appears on the server's "Active sessions" page, where you can message a session from the web UI.

The server is the only route between sessions, including two sessions on the same machine. The wire contract is [`services/pika/docs/RELAY.md`](../../services/pika/docs/RELAY.md).

## Requirements

- The [pika extension](../pika/README.md), logged in with `/pika login`. relay uses pika's server URL and device token; there is no separate key or login. relay never imports pika: it reads pika's credentials from a process-global registry, so it follows `/pika login` and `/pika logout` at once.
- A pika server 0.3.0 or newer with relay on (the default). With an older server, or one started with `PIKA_RELAY=off`, sessions stay offline and pi says so once per process.
- Node's built-in `WebSocket` with custom headers, which Node 22.19 and newer provide.

## Open by default

relay is part of this collection and connects every eligible session as soon as pika is logged in. A session connects when all of these hold:

- `PI_RELAY_DISABLED` is not `1`;
- pika has credentials and its `exclude` list does not cover the session's working directory;
- pi runs in the TUI or in RPC mode (not `-p` print or JSON mode);
- the session is a top-level session, not a Subagents child or Herder step;
- you have not run `/relay off` in it;
- the server's `/api/health` lists the `relay` feature.

One WebSocket per online session opens after the session starts; `/new`, `/resume`, and forks move the connection to the new session, `/reload` reconnects it, and quitting closes it. When pi asks to switch or fork, the outgoing session closes its connection without reconnecting, so the server keeps its messages queued and drops them after 5 minutes as usual; nothing is held in pi. If the replacement does not happen after all (another extension cancelled it, or it failed, as a `/clone` of a session without a reply yet or a `/resume` of a session whose working directory is gone can), the session reconnects at your next prompt, at `/relay`, or after 10 s, whichever comes first, and the server pushes again whatever has not expired. Lost connections are retried after 1 s, 2 s, 4 s, and so on up to 30 s, with jitter. A revoked token (close code 4401), a session owned by another device (4403) or already online from another device (4409), another pi process that opened the same session and took it over (4410), or relay turned off on the server (4503) stops the retries until pika's credentials change or you run `/relay on`; `/relay` says which. After a takeover, `/relay on` takes the session back, and the other process stops in turn.

### Child sessions and the persistence side effect

Subagents children and Herder steps never connect. To recognize them, relay registers a hook that Subagents and Herder load into every child session. A registered child-session hook makes Subagents keep every child session on disk, including nested children and agents with `persist_session: false`, so relay registers it only while at least one session in the process could connect: pika has credentials, its `exclude` list does not cover the session, the session runs in the TUI or RPC mode, and it is not `/relay off`. `/relay off`, `/relay on`, pika's credentials changing, and sessions starting, being replaced, or quitting re-evaluate it. The pika extension registers a hook of its own while it uploads, with the same effect.

## Turning it off

- For every session of a pi process: start pi with `PI_RELAY_DISABLED=1`.
- For one session: `/relay off` (until `/relay on`, or the end of the session).
- For the whole server: start the pika server with `PIKA_RELAY=off`.

## Receiving messages

A message from another session or from the web UI is added to the session as a `relay-message` and shown with its sender:

- when the session is idle, it starts a turn;
- when the session is busy, it is queued after the current turn, or steered into it when the sender marked it urgent.

The model reads who sent it, the message id, and, for another session, that it did not come from you and how to answer with `relay_send`. Each message is handed to pi, then recorded as a `relay-received` entry with its text, and then acknowledged to the server. A message pi refused at once (its `sendMessage` threw) is neither recorded nor acknowledged, so the server pushes it again after a reconnect and it is delivered then. A message that arrives while pi compacts the session or summarizes a branch is not acknowledged either, because pi would start a turn next to the compaction; once that ends, relay reconnects and the server pushes the message again. A message the server pushes again after it was delivered, after a reconnect or `/resume`, is acknowledged without being delivered twice.

A message that arrives while the session is busy waits in pi's follow-up or steer queue. Pressing Esc, or RPC `clear_queue`, clears those queues and restores only plain user messages to the editor: a queued relay message is then dropped from the model's context. Its text stays in the transcript in the `relay-received` entry.

Every field of a message comes from another device or the web UI. Terminal escape sequences and control characters other than newline and tab are stripped before a message is shown, and the sender's name, title, device, and project are put on one line without double quotes, zero-width characters, or bidirectional controls, in the text the model reads and in the sender line pi shows, so a crafted name cannot forge a second message header or disguise itself.

## Tools

Top-level sessions in the TUI or RPC mode get three tools; print and JSON sessions, including every Subagents and Herder child, never do:

- **`relay_list`** `{ device?, project?, query? }` lists the other online sessions: id, device, project, name or title, idle or busy, model, and how long each has been online.
- **`relay_send`** `{ to, text, urgent?, replyTo? }` sends a message and reports `delivered` (the target session accepted it) or `queued` (it is offline or busy accepting it). A message not delivered within 5 minutes is dropped, and the sender's session gets a `relay-notice` that starts a turn. Delivered means received, not read or answered; answers arrive later as messages.
- **`relay_status`** `{ id? }` shows the state of messages this session sent in this process: `queued`, `delivered`, `expired`, or `rejected`.

## Command

- `/relay` shows the connection state, or why the session is offline, the server URL, this session's id, and the other online sessions.
- `/relay send <sessionId> <text>` sends a message as you.
- `/relay off` and `/relay on` disconnect or reconnect this session.

## Safety

- **Any device token can message every online session.** A machine you paired with pika can start turns in all your connected sessions, on every machine. Revoke devices you no longer use on the server's Devices page; revoking one closes its relay connections at once.
- **Hop limit.** Every message carries a hop count. A turn you start resets it; a turn started by a relay message continues from that message's count, and each `relay_send` adds one. The server rejects messages above 8 hops, which stops sessions that keep relaying to each other without you.
- Messages pass through the server as plain text and are held in memory only until they are delivered or expire. The session transcripts that pika uploads are the permanent record.
- Messages from other sessions are marked as not coming from you, but a model may still act on them. Treat every connected session as able to ask any other for work.

## Development

`npm run test:relay` runs the offline Vitest suite: a fake relay server built on the `ws` package, real pi sessions on Pi's faux provider, the real pika extension for its credentials, and a real Subagents child that must stay offline.
