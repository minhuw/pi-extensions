# pika nodes v1 (shared contract)

pika nodes let the owner use terminals, files, and pi pane status on their machines from the pika web UI, instead of Orca. Each machine runs a `pika-node` daemon. The daemon owns the PTYs, a headless screen per terminal, file access, and pane status. The pika server only routes traffic: it keeps no terminal state, and it cannot read or inject terminal traffic.

- **Daemon:** `services/pika-node/` (TypeScript run by Node ≥ 22.19 directly, no build step), installed per user; its state lives in `~/.pika-node/` (see §8). `src/protocol.ts` is the canonical copy of every frame in this document. `src/crypto.ts` implements the end-to-end layer with WebCrypto only.
- **Server:** `services/pika/` (Rust), a `nodes` module next to `relay`. It authenticates nodes and the owner's browser, tracks presence, and forwards opaque channel frames.
- **Web:** `services/pika/web/`, with terminals (xterm.js), a file tree, and Monaco. It imports `services/pika-node/src/{protocol,crypto}.ts` by relative path.
- **Bridge:** a pi extension that runs inside panes the daemon spawns. It reports pane status and asks the UI to open files or diffs over a local unix socket. It keeps its own copy of the bridge-socket subset of `protocol.ts`; it imports no other extension.

Layers, outside in:

1. **Node ↔ server**, a WebSocket per node (node credential).
2. **Client ↔ server**, a WebSocket per browser tab (owner session).
3. **Channels:** the server pairs one client with one node in a *channel* and forwards its frames verbatim. Each channel carries one **end-to-end session**: a signed ECDH handshake, then AES-256-GCM records.
4. **Inner messages:** terminals, files, projects, and pane status, as JSON inside the records.
5. **Bridge socket:** NDJSON between the bridge and its daemon on the same machine.
6. **ssh fallback:** `ssh <node> pika-node attach` speaks the inner messages over stdio without the server.

Deferred, not in v1: binary frames, multiple owners, port forwarding, a desktop shell that serves the UI itself (security option A), resumable uploads.

## Security model (option B)

- **Client identity:** a P-256 ECDSA key pair per browser profile. WebCrypto generates it with `extractable: false`, and the UI stores the `CryptoKey` objects in IndexedDB. Its **fingerprint** is the lowercase hex SHA-256 of the public key's SPKI DER (64 characters).
- **Node identity:** a P-256 ECDSA key pair per node in `~/.pika-node/identity.json` (mode 0600; the private key is a JWK). Its fingerprint is computed the same way.
- **Allowlist:** a node accepts a channel only from a client key listed in `~/.pika-node/clients.json` (see "Enrolment"). The daemon rechecks the file's mtime, size, and inode every second and reloads it when they change. Removing a key closes that key's open channels within 1 s with `client_removed`. A file that does not parse denies every client until it is fixed.
- **Pinning:** the browser pins each node's public key by node id. It pins only after the user has confirmed the node fingerprint (see "Enrolment"). A later handshake signed by any other key fails with `node_key_changed`, and the client sends nothing on that channel. **A client never sends an inner message to a node it has not pinned.**
- **What the server sees:** node ids, channel ids, presence, frame sizes and timing, the handshake's public keys and signatures, and the record ciphertext. It never sees terminal input or output, file contents, paths, or pane status.
- **What a compromised server can do:** drop, delay, or reorder traffic, which closes the channel; list nodes and when they are online; and refuse service.
- **Limit of option B, stated plainly:** the UI's JavaScript comes from the pika server. An actively compromised server can serve modified JavaScript. While the owner has that page open, the modified code can use the stored non-extractable private key without exporting it, open channels, and type into every node that allowlists that browser. Option B protects against a leaked database or backup, a passive observer, and a server that is broken into but does not change the UI. It does not protect against an attacker who controls the server while the owner uses it. Option A (a client the server does not serve) closes that gap and needs no change to the protocol. Until then, keep nodes whose compromise would matter (shared servers) off the allowlist of any browser, and reach them only with `ssh <node> pika-node attach`.

### Server hardening

- **Node credentials** are separate from device tokens. A node credential is `pkn_` followed by 43 base64url characters (32 random bytes). The server stores only its SHA-256, in a `nodes` table (`id`, `name`, `token_hash`, `created_at`, `last_seen_at`, `last_host`, `public_key`). Node routes accept only node credentials. Every other route (ingest, relay, agent, pairing `bind`) answers 401 to a node credential. A capture device token never reaches a node route: it gets 401 `unauthorized` before the upgrade.
- **Getting a credential:** `pika node create <name>` prints the credential once on stdout; there is no pairing flow for nodes in v1. On the node, `pika-node server <url>` stores it (read from stdin) in `config.json`. `pika node list`, `pika node revoke <node>`, and `pika node rename <node> <name>` work like their `pika token` equivalents. Node names are at most 64 UTF-16 units. Revoking deletes the node's row and closes its socket with 4401 within 2 s (the server rechecks credentials across processes).
- **Browser socket:** it needs a valid owner session (see "Authentication" in `SPEC.md`), checked before the upgrade, and an `Origin` header equal to the accepted origin, else 403 `{ error: "forbidden_origin" }` (a missing `Origin` is rejected too). Two origins are accepted: `PIKA_PUBLIC_URL`'s, and the server's own as the request reached it (the `Host` header, with `https` only when a trusted proxy reports HTTPS, so behind a TLS proxy set `PIKA_PUBLIC_URL` or `PIKA_TRUST_PROXY=1`). In `PIKA_AUTH=none` the route answers 404 `nodes_disabled` unless `PIKA_NODES_INSECURE=1` is set.
- **Feature switch:** `PIKA_NODES` = `off` (default) | `on`. When off, every node route answers 404 `{ error: "nodes_disabled" }` before authentication, and health does not list `"nodes"`.
- **Content Security Policy:** with nodes on, every UI response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. With script injection blocked, an XSS bug in the UI cannot use the key either. Monaco and xterm are bundled, never loaded from a CDN.
- **Limits:** 64 open channels per node, 16 per browser socket, 30 channel opens per minute per browser socket, 32 online nodes per server, and (in password mode) 4 browser sockets per owner session, the 5th closed with 4429. Every refused channel open answers `refused` with `too_many_channels`, whichever limit it hit.

## Constants

| Name | Value |
| --- | --- |
| Server heartbeat (`ping`) interval, both sockets | 20 s |
| Socket considered dead after no frame for | 45 s (both sides) |
| Node `hello` must arrive within | 10 s of the upgrade |
| Handshake must finish within | 10 s of `open` (node side) |
| Max WebSocket text frame (routing JSON, incl. ciphertext) | 2 MiB |
| Max record plaintext (one inner message, UTF-8 JSON) | 1 MiB |
| Server outgoing buffer per socket | 16 MiB, else closed with 1008 |
| Records per direction per channel | 2³² (then `rekey_required`: reopen the channel) |
| Terminal output chunk | ≤ 64 KiB, flushed at least every 16 ms |
| Terminal input frame | ≤ 64 KiB |
| Snapshot (serialized screen + scrollback) | ≤ 512 KiB; headless scrollback 1000 rows, oldest rows dropped to fit (full history is the raw log) |
| Per-client output backlog per terminal | 1 MiB, then resync with a fresh snapshot |
| `fs.read` | ≤ 512 KiB of file content |
| `fs.readDir` | ≤ 5,000 entries |
| `fs.list` | ≤ 50,000 paths (20,000 without `limit`), ≤ 768 KiB of them |
| Upload | ≤ 256 MiB total; chunks ≤ 512 KiB |
| Watches per channel | 64 |
| Pending enrolments per node | 16, each expiring after 10 min |
| Bridge socket line | ≤ 1 MiB |

## Conventions (every layer)

- **Frames:** JSON text frames, one object each, with a string `type` (`t` inside `body`). Fields this document does not list are ignored. A peer ignores frame types it does not know, except an inner *request* that carries an `id`: the node answers it with `unsupported`, so the client does not wait.
- **Ids:** request ids (`id`) are 1–64 characters of `[A-Za-z0-9._:-]` chosen by the sender, unique among its open requests. Node, channel, terminal, watch, and upload ids are 1–64 characters of `[A-Za-z0-9_-]`.
- **Times:** Unix milliseconds as integers.
- **Bytes:** base64url without padding (RFC 4648 §5).
- **Paths:** absolute POSIX paths of at most 4,096 bytes without NUL. The daemon resolves `~` nowhere; the client asks `welcome.home` for it.
- **Untrusted text:** every string from the server or a node is rendered as text. Before display, terminal titles, file names, labels, and pane status strings are stripped of ESC sequences and C0/C1 controls, like relay's `sanitize`.

## 1. Node ↔ server

`GET {base}/api/node/v1/connect` with `Authorization: Bearer <node credential>`, checked before the upgrade: 401 `{ error: "unauthorized" }` otherwise. A proxy that authenticates must leave `/api/node/` open, like `/api/relay/`. The nginx location needs the same WebSocket headers as relay's.

Node → server:
- `hello`, exactly once, first: `{ type: "hello", host, version, protocolVersions: number[], publicKey }`. `host` is cut to 255 characters; `version` is the daemon's version; `publicKey` is the node's SPKI (base64url). The server stores `publicKey` for display and changes it only on `hello`. It is not trusted: clients verify the node key in the handshake.
- `frame`: `{ type: "frame", channel, body }` for an open channel.
- `close`: `{ type: "close", channel, code, reason? }` ends a channel; `code` is a channel close code (§7).
- `pong`: `{ type: "pong" }` in answer to `ping`; any frame counts as liveness.

Server → node:
- `welcome`: `{ type: "welcome", node, nodeName, serverVersion, limits: { heartbeatSeconds, maxFrameBytes, maxChannels } }`. `node` is the node's id (fixed at creation, a UUID); the node uses it in handshakes.
- `open`: `{ type: "open", channel, client: { session, userAgent?, ip? } }`. A client asks for a channel. `session` is the first 12 hex characters of the owner session's id hash. `client` is informational only and comes from the server.
- `frame`, `close`: as above, for the other direction.
- `ping`: `{ type: "ping", at }` every heartbeat (`at` in Unix milliseconds).

**Ownership of a node id:** one socket per node. A second `hello` for the same node closes the older socket with 4410; its channels close with `node_offline`.

**Routing:** the server forwards `body` verbatim, without parsing it, after checking that it is a JSON object and that the frame stays within 2 MiB. It forwards frames of one channel in order. When either socket of a channel closes, the server sends the other side `close` with `node_offline` or `client_gone`.

## 2. Client ↔ server

`GET {base}/api/v1/node/connect` with the owner session cookie and a same-origin `Origin` (see "Server hardening"). There is no hello: right after the upgrade the server sends `welcome`, then `nodes`.

Server → client:
- `welcome`: `{ type: "welcome", serverVersion, limits: { heartbeatSeconds, maxFrameBytes, maxChannels } }`.
- `nodes`: `{ type: "nodes", items: NodeInfo[] }`, the full list. It is sent on connect and again after every change (latest wins). `NodeInfo = { id, name, host?, online, version?, publicKey?, connectedAt?, lastSeenAt? }`. It covers every node with a credential, sorted by name case-insensitively, then by id.
- `opened`: `{ type: "opened", ref, channel, node }` answers `open`.
- `refused`: `{ type: "refused", ref, code }`, where `code` is `unknown_node`, `node_offline`, or `too_many_channels`.
- `frame`, `close`, `ping`: as in §1.

Client → server:
- `open`: `{ type: "open", ref, node }`, where `ref` is the client's correlation id (a request id). The server assigns `channel`, a 128-bit random base64url id, and sends the node `open`.
- `frame`, `close`, `pong`: as in §1.

The browser socket never carries anything but these frames. In particular it has no route that types into a node, and the node accepts only channel records that decrypt.

## 3. End-to-end channel

Inside a channel, `body` is one of:

| `t` | Direction | Fields |
| --- | --- | --- |
| `hs1` | client → node | `v: 1`, `clientKey` (SPKI), `eph` (raw uncompressed P-256 point, 65 bytes), `label?` (≤ 64 characters, e.g. "Firefox on mbp") |
| `hs2` | node → client | `v: 1`, `nodeKey` (SPKI), `eph`, `sig` (ECDSA P-256/SHA-256, IEEE P1363, 64 bytes) |
| `hs3` | client → node | `sig` |
| `hs_error` | node → client | `code`, `fingerprint?` (the client's, for `client_not_allowed`) |
| `rec` | both | `n` (record number, integer ≥ 0), `ct` (ciphertext and 16-byte tag) |

**Handshake** (all three messages must arrive within 10 s of `open`):

1. The client generates an ephemeral ECDH P-256 key and sends `hs1`.
2. The node checks `v`. If the version is unsupported, it sends `hs_error` `unsupported_version` and closes. Otherwise it generates its own ephemeral key and computes the transcript hash
   `th = SHA-256(lp("pika-node/1 handshake") ‖ lp(channel) ‖ lp(node) ‖ lp(clientKey) ‖ lp(clientEph) ‖ lp(label or "") ‖ lp(nodeKey) ‖ lp(nodeEph))`,
   where `lp(x)` is a 4-byte big-endian length followed by the bytes (strings as UTF-8). It then sends `hs2` with `sig = Sign(nodePriv, "pika-node/1 node-sig" ‖ th)`.
3. The client verifies `sig` against `nodeKey`, then compares `nodeKey`'s fingerprint with its pin for `node`. With no pin, it continues only to enrol (see below). It sends `hs3` with `sig = Sign(clientPriv, "pika-node/1 client-sig" ‖ th)`.
4. The node verifies the signature against `clientKey` and then checks the allowlist. A client that is not allowed gets `hs_error` `client_not_allowed` with its fingerprint, is recorded as a pending enrolment, and the channel closes with `client_not_allowed`. A bad signature closes with `handshake_failed`.
5. Both sides derive `shared = ECDH(eph, peerEph)` (256 bits). From it they derive `kc2n = HKDF-SHA-256(shared, salt = th, info = "pika-node/1 c2n")` and `kn2c` (with info `"pika-node/1 n2c"`), each an AES-256-GCM key. The node's first record is the inner `welcome`, which also confirms the keys.

`channel` and `node` are the server-assigned ids, so a transcript cannot be replayed into another channel or node. Both signatures cover both identities and both ephemeral keys.

**Records:** `rec.ct = AES-256-GCM(key_dir, iv, plaintext, aad)`.
- `iv` is 4 zero bytes followed by `n` as an 8-byte big-endian integer.
- `aad` is UTF-8 `"pika-node/1 rec|" + channel`.
- The plaintext is one inner message as UTF-8 JSON (≤ 1 MiB).
- Each direction counts `n` from 0 in steps of 1.

The receiver requires `n` to equal the next expected number. A smaller `n` is `replay`, a larger one `out_of_order`, and a tag that does not verify is `decrypt_failed`. Each closes the channel. The server forwards a channel's frames in order, so an honest path never produces these. Both sides drop all key material when the channel closes. A channel is never resumed: reconnecting means a new channel and a new handshake.

### Enrolment (adding a client key to a node)

1. The UI opens a channel to a node it has not pinned. If the client is not allowed yet, the node answers `client_not_allowed` and stores `{ fingerprint, publicKey, label, at }` in `~/.pika-node/pending.json` (at most 16 entries, the oldest replaced first; each expires after 10 min).
2. The UI shows both fingerprints and the command to run: `pika-node clients add <first 32 hex characters of the client fingerprint>`.
3. On the node, `pika-node clients add <prefix>` (prefix ≥ 20 hex characters) moves the one pending entry that matches into `clients.json`. It refuses when no entry matches or more than one does. It prints the client label, the full client fingerprint, and the node fingerprint.
4. The user confirms in the UI that the node fingerprint printed by the command matches the one shown. Only then does the UI pin the node key and open a new channel.
5. If the handshake succeeds without a pin (the key was allowed earlier, for example through another browser profile with the same key, or after the browser lost its pins), the UI still requires step 4 before it sends any inner message.

Other commands: `pika-node clients` (or `clients list`) lists allowed and pending keys, `pika-node clients remove <prefix>` revokes a key, and `pika-node identity` (alias `fingerprint`) prints the node fingerprint. See §8 for the rest. Fingerprints are displayed as 8 groups of 4 hex characters (the first 32), and compared in full by code.

`clients.json` is `{ version: 1, clients: [{ fingerprint, publicKey, label, addedAt }] }`, mode 0600. A pending entry is created only after a valid `hs3` signature, so the server cannot add keys whose private half it does not hold. Even so, a compromised server can plant its own key as a pending entry. It cannot make the user's command match that entry without a 2⁸⁰ prefix collision.

## 4. Inner messages (client ↔ node)

Requests are `{ type, id, ...params }`. The node answers each with exactly one `reply`: `{ type: "reply", id, result }` or `{ type: "reply", id, error: { code, message } }`. Events have no `id`. Messages without an `id` (`term.input`, `term.resize`, `pane.seen`) get no reply; when one fails, the node sends an `error` event `{ type: "error", code, message, terminalId? }`.

**`welcome`** (node → client, first record): `{ type: "welcome", node, name, host, home, version, protocolVersion, capabilities: string[], limits: { maxRecordBytes, maxSnapshotBytes, maxReadBytes, maxUploadBytes, maxUploadChunkBytes } }`. The v1 capabilities are `terminal`, `files`, `projects`, `status`.

### Terminals

`TerminalInfo = { terminalId, title, cwd, cols, rows, pid, createdAt, argv: string[], exited?: { code: number | null, signal: string | null }, status?: PaneView }`

| Request | Params | Result |
| --- | --- | --- |
| `term.create` | `cols` (1–1000), `rows` (1–500), `cwd?`, `argv?: string[]` (default: the user's login shell), `env?: Record<string, string>` (≤ 64 entries; see "Spawning") | `{ terminal: TerminalInfo }` |
| `term.list` | — | `{ terminals: TerminalInfo[] }`, newest first |
| `term.attach` | `terminalId` | `{ terminal, snapshot: Snapshot }` |
| `term.detach` | `terminalId` | `{}` |
| `term.kill` | `terminalId`, `signal?` (`SIGTERM` default, `SIGHUP`, `SIGINT`, `SIGKILL`) | `{}` |
| `term.cwd` | `terminalId` | `{ cwd }` |

`term.cwd` answers the working directory of the terminal's shell (the PTY's process) now, which a `cd` changes, while `TerminalInfo.cwd` stays where it started. Shells do not report a `cd` (only some send OSC 7, and not under `TERM_PROGRAM=pika-node`), so the web UI asks when it resolves a relative path printed in the terminal. The daemon reads `/proc/<pid>/cwd` on Linux and `lsof` on macOS, and answers the starting cwd when neither tells; an exited terminal answers `exited`. A daemon without it answers `unsupported`.

Without a reply: `term.input { terminalId, data }` (UTF-8 text, ≤ 64 KiB) writes to the PTY. `term.resize { terminalId, cols, rows, claim? }` resizes it (see "Resize").

Events:
- `term.created { terminal: TerminalInfo }`: to every channel, the creator's included (after its reply), when a terminal is created.
- `term.removed { terminalId }`: to every channel when `term.kill` removes an exited terminal. With these two, a client keeps its terminal list from one `term.list` without polling.
- `term.output { terminalId, seq, data }`: to clients attached to the terminal. `seq` counts the terminal's output chunks from 1 and never repeats while the daemon runs.
- `term.snapshot { terminalId, snapshot }`: replaces the client's screen (see backpressure).
- `term.resized { terminalId, cols, rows, owned }`: to all attached clients after any resize, including their own; `owned` is true only on the size owner's channel.
- `term.title { terminalId, title }`: to every channel (lists show titles).
- `term.exit { terminalId, code, signal }`: to every channel. An exited terminal stays in `term.list` with `exited` until `term.kill` removes it, so its last screen can still be attached.

`Snapshot = { data, cols, rows, outputSequence }`. `data` is the headless screen serialized as VT sequences (xterm's serialize addon: scrollback, screen, cursor, modes). Writing it to a fresh terminal of `cols` × `rows` reproduces the screen. `outputSequence` is the `seq` of the last chunk included.

**Attach:** the daemon keeps two counters per terminal: `seqIn`, the last chunk read from the PTY (it stamps `term.output`), and `seqApplied`, the last chunk the headless terminal has finished parsing (advanced in `write(data, callback)`; never the private `writeSync`). On attach the daemon starts streaming to the client at once, then serializes the headless screen when `seqApplied` catches up with the `seqIn` it saw at attach and reports that as `outputSequence`. The client buffers `term.output` that arrives before the snapshot, applies the snapshot, then plays the buffer from `seq = outputSequence + 1`. A gap in `seq` makes the client re-attach. The client resets its terminal, writes `data`, and drops any `term.output` whose `seq ≤ outputSequence`. After a disconnect, a client reattaches the same way on its new channel. Attaching twice on one channel answers a fresh snapshot. The v1 daemon queues the stream behind the `term.attach` reply (it sends no `term.output` with `seq ≤ outputSequence` and none before the reply), but clients must still buffer as above.

**Spawning:** the daemon's own environment is not trusted. It may have started from a non-login ssh command or a service manager with a stripped `PATH`, so a terminal never inherits it whole. The daemon starts each PTY from a clean login environment instead:
- **Variables:** `HOME`, `USER`, `LOGNAME`, `SHELL` (from the passwd entry), `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LANG` (the daemon's, else `C.UTF-8`), `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=pika-node`, `PI_PROGRAM_STATUS=1`, `PIKA_NODE_SOCKET`, and `PIKA_NODE_PANE_ID`.
- **Command:** the user's shell as a login shell (`-l`), which builds the real `PATH` from the profile. A requested `argv` runs through it as `[shell, "-l", "-c", 'exec "$@"', "pika-node", ...argv]`. fish has no `"$@"`, so a fish login shell gets `[shell, "-l", "-c", "exec $argv[2..]", "pika-node", ...argv]`; any other shell that is not POSIX (not `sh`, `bash`, `zsh`, `ksh`, `mksh`, `dash`, `ash`, `yash`) runs the argv through `/bin/sh -l` instead. `TerminalInfo.argv` is the requested argv, or `[shell, "-l"]`. The initial `cwd` is the requested one or the home directory: `not_found` when it does not exist, `not_a_directory` when it is a file. At most 128 terminals (live or exited) per daemon, else `limit`.
- **Requested `env`:** applied last, except that it may not set `PIKA_NODE_*`, `PI_PROGRAM_STATUS`, or any name starting with `ORCA_` or `__`.
- **Profile guards:** `__ETC_PROFILE_NIX_SOURCED` and every other `__*` variable never reach the PTY. Inherited with a stripped `PATH`, such a guard makes `nix-daemon.sh` return early, and pi then fails with `env: node: not found`.

**Terminal queries:** exactly one emulator answers a PTY's queries: the daemon's headless one. Pi's startup negotiation (DA1, keyboard protocol flags, cursor position) waits for answers, and a query answered twice leaves stray bytes in pi's input.
- **Daemon:** the headless terminal's `onData` (its replies, never user input) is written to the PTY.
- **Clients:** they must not answer. The web terminal registers parser handlers that swallow every query xterm.js would answer: CSI `c`, `>c`, `=c` (DA1/2/3), `n` and `?n` (DSR, cursor position), `$p` and `?$p` (DECRQM), `?u` (keyboard flags), `>q` (XTVERSION), CSI `t` window reports, DCS `$q` (DECRQSS), DCS `+q` (XTGETTCAP; xterm.js 6 does not answer it, but only the headless terminal may), and OSC 4/10/11/12 when their payload is `?`. These handlers must not swallow the sequences that set the same state.
- **Why the daemon answers:** it always exists, also while no client is attached, and pi often starts that way. It holds the PTY's true size and modes, while a client may render at another size. It is also exactly one, however many clients attach. If clients answered, a pane with no client would hang pi's startup, and a pane with two would get duplicates.
- **One version:** the daemon and the web UI use the same `@xterm/*` version and the same reply-affecting options (`windowOptions` off), so the modes that pi sets through the output stay the same on both sides.
- **Mouse input:** SGR mouse encoding (1006) works at any size. The legacy X10/default encoding, whose reports are bytes rather than UTF-8 text, is not supported beyond column or row 95 in v1 (`term.input` carries UTF-8 text only).
- **Snapshots:** a snapshot must restore every mode that changes what keys send: bracketed paste, application cursor and keypad, mouse tracking and encoding, and keyboard protocol flags. The daemon appends the sequence for any of these that the serialize addon leaves out. Measured with `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 (`services/pika-node/test/units.test.ts` fails if a new version changes this): the addon restores the alternate buffer, the cursor position, DECSET 1, 66, 2004, 4, 6, 45, 1004, 7, and the mouse protocol (9, 1000, 1002, 1003). It omits the mouse encoding (1006, 1016), cursor visibility (25), the scroll region (DECSTBM), and the cursor style (DECSCUSR), which the daemon appends, followed by a cursor position when it set a scroll region. xterm.js 6.0 has no kitty keyboard protocol (it leaves `CSI ? u` unanswered, so pi falls back to legacy keys), so there are no keyboard flags to restore. Both sides pin exactly these versions.

**Resize, one size owner:** each terminal has at most one size-owner channel. A `term.resize` with `claim: true` makes its channel the owner and applies; one without `claim` applies only from the owner, or when there is none (it then claims). Clients send `claim: true` on keyboard input while not owner and on an explicit "Fit here"; a passive viewport change never claims. Keyboard input means typing or pasting: the focus reports (DECSET 1004) and mouse reports a terminal sends by itself do not claim, or merely focusing a second window, or attaching to a pane whose snapshot restores 1004, would take the size from the window the user types in. The channel that created a terminal starts as its owner. The owner's channel closing clears the owner. A `term.resize` that does not apply answers only its sender with `term.resized` (the current size, `owned: false`). A `term.resize` with `claim: true` always answers with `term.resized`, also when the size does not change. After every applied resize the daemon sends `term.resized` to every attached client; a non-owner sets its terminal to exactly those `cols` × `rows` (letterboxed or scaled, never fitted) and offers "Fit here", so two clients cannot fight. (Orca does the same: owner claimed by typing or a desktop claim, `remote-desktop-terminal-floor.ts:155-162`.)

**Backpressure:** the daemon queues output per (channel, terminal). When the queue passes 1 MiB, or the server socket's own send buffer passes 4 MiB, the daemon stops sending `term.output` for that terminal to that channel and discards the queue. Once the backlog drains below 256 KiB, it sends `term.snapshot` with a fresh `outputSequence` and resumes. A slow client never slows the PTY or other clients: the PTY is never paused (Orca pauses it, which lets one slow consumer stall everyone).

### Projects

`projects.list` → `{ projects: [{ name, path, repository? }] }`. The list comes from the `projects` entries of `~/.pika-node/config.json` (absolute paths), plus each directory holding `.git` one level below each configured root, plus the git toplevel of each live terminal's cwd. Duplicates are removed by real path. `config.json` is `{ version: 1, server?: { url, credential }, roots?: string[] (default [home]), projects?: string[] }` (mode 0600). `server.url` is the pika server's base URL (`http(s)://…`, the daemon connects to its `ws(s)` form); `credential` is the `pkn_` node credential. Without `server` the daemon serves only `pika-node attach` and checks the file again every 5 s. A daemon that cannot parse `config.json` fails loudly (requests that need it answer `io`).

### Files

Paths are absolute. The daemon follows symlinks and does not limit file access to `roots`: an allowed client already has a shell. `Stat = { size, mtimeMs, hash? }`, where `hash` is the lowercase hex SHA-256 of the content.

| Request | Params | Result |
| --- | --- | --- |
| `fs.readDir` | `path` | `{ entries: [{ name, kind: "file" \| "dir" \| "symlink" \| "other", size, mtimeMs }], truncated }`, sorted by name |
| `fs.read` | `path` | `{ encoding: "utf8" \| "base64", data, stat: Stat }` (with `hash`) |
| `fs.write` | `path`, `encoding`, `data`, `expected: { hash } \| { mtimeMs, size } \| { absent: true }`, `mode?` (for new files) | `{ stat: Stat }` |
| `fs.watch` | `path` (file or directory, not recursive) | `{ watch }` |
| `fs.unwatch` | `watch` | `{}` |
| `fs.gitShow` | `path`, `ref: "HEAD" \| "index"` | `{ encoding: "utf8" \| "base64", data }` |
| `fs.list` | `root` (a directory), `limit?` (1–50,000) | `{ paths: string[], truncated, source: "git" \| "walk" }` |
| `fs.uploadStart` | `name` (a base name), `size`, `dir?` | `{ upload, path }` |
| `fs.uploadChunk` | `upload`, `offset`, `data` (base64url) | `{ received }` |
| `fs.uploadFinish` | `upload`, `hash` | `{ path, stat }` |
| `fs.uploadCancel` | `upload` | `{}` |

- **Read:** `utf8` when the content is valid UTF-8 without NUL, else `base64` (base64url without padding, as everywhere; the name is kept short). A file over 512 KiB, or a reply over the record limit, answers `too_large`.
- **Write if unchanged:** `fs.write` checks `expected` against the file right before writing. `{ hash }` compares content, `{ mtimeMs, size }` compares stat, and `{ absent: true }` requires that no file exists. A mismatch answers `conflict` and writes nothing; the error carries `current: Stat` (absent when the file is gone). The daemon writes to a temporary file in the same directory, keeps an existing file's mode, and renames it over the target.
- **Watch:** `fs.changed { watch, path, kind: "change" | "rename" | "gone" }`, coalesced to at most one event per watch per 100 ms. `gone` ends the watch. Closing the channel ends its watches. A file watch follows its path, not its inode: when a rename replaces the file (as `fs.write` and most editors save), the daemon watches the new file, so the watch keeps reporting after a save.
- **Git content:** `fs.gitShow` answers the file's content at `HEAD` or in the index (staged), for diffs: `pane.diff` with `staged: false` compares the index with the working file, and with `staged: true` compares `HEAD` with the index. The daemon resolves `path` with `realpath` (a deleted file through its parent directory), finds that real path's repository with `git rev-parse --show-toplevel`, and reads `git cat-file blob <ref>:<path inside it>`, so a symlink is read in the repository its target lives in. A path in no work tree, or absent from `ref` (a new or untracked file), answers `not_found`; content over 512 KiB answers `too_large`. Encoding is chosen as for `fs.read`. A daemon without it answers `unsupported`.
- **Listing:** `fs.list` answers the files under `root` for a fuzzy finder (the web UI's quick open), as paths relative to `root` with `/` separators. When `root` is in a git work tree, they are `git ls-files --cached --others --exclude-standard` (tracked and untracked files, never ignored ones), sorted; otherwise a breadth-first walk, each directory sorted by name, that lists files and symlinks, does not follow symlinked directories, and skips directories named `.git` and `node_modules`. The list stops at `limit` paths (20,000 by default), at 768 KiB of path bytes, or for a walk after 10,000 directories or 5 s, and then says `truncated`. `root` must be a directory (`not_found`, `not_a_directory`). A daemon without it answers `unsupported`.
- **Upload:** chunks arrive in order (`offset` must equal `received`). The file is written as `<dir or ~/.pika-node/uploads/YYYY-MM-DD>/<name>`; on a name clash, ` (2)`, ` (3)`, … go before the extension. `path` in `uploadStart` is the final path, so the UI can paste it into a pi prompt at once. `uploadFinish` verifies the SHA-256 and renames the partial file into place; a mismatch answers `conflict` and deletes it. An upload idle for 60 s, or whose channel closes, is deleted.

### Pane status

A pane status has two sources, and the daemon merges them. It keeps the latest merged view per terminal and sends it level-triggered (latest wins): as `TerminalInfo.status` in `term.list`, `term.create`, and `term.attach` replies, and as `pane.status { terminalId, status: PaneView | null }` to every channel on every change. `null` means the terminal has neither source, or has exited.

1. **Program status (primary; needs no extension).** pi writes OSC 7501 to its terminal when `PI_PROGRAM_STATUS=1`, which the daemon always sets. The format is `ESC ] 7501 ; state=<idle|working|blocked|done|error|clear>:app=<app>[:kind=<question|permission|auth>][:msg=<base64>] ST`.
   - **Parsing:** the headless emulator's `parser.registerOscHandler(7501, …)` passes the payload to `parseProgramStatus` (`protocol.ts`). A payload it rejects is ignored, as is the startup query `7501;?`. The daemon does not answer that query, because the variable already enables the reports.
   - **Coverage:** it covers pi's idle, working, and done states and every dialog, built-in or extension (`blocked`), except plain `showSelector` menus (`/model`, `/settings`).
   - **Clearing:** `clear` drops the program status. So does a change of the PTY's foreground process (node-pty `process`, polled every 2 s) away from the one that was in front when the status arrived, so a crashed pi leaves no stale `working`.
2. **Bridge status (`BridgeStatus`, §5).** Only the bridge knows background activities (Subagents, Herder), the session (id, name, cwd, file) and the model. Clients label a pane by its session name, else its terminal title, else `argv[0]`. The bridge sends no title of its own, and a `title` from an older bridge is ignored. It also reports `waiting` while an extension's `ctx.ui` dialog opened from a command or event handler is open (`ui_prompt_*`). pi's built-in dialogs and extension shortcut handlers emit no `ui_prompt_*`; OSC 7501 covers those.

```
ProgramStatus = { state: "idle" | "working" | "blocked" | "done" | "error", app, kind?: "question" | "permission" | "auth", message?, at }
BridgeStatus  = { state: "idle" | "busy" | "waiting", activities: Activity[], activityCount, session?: { id, name?, cwd, file? }, model?, updatedAt }
Activity      = { source, id, label, kind?: "agent" | "workflow" | "step", state?: "running" | "waiting", startedAt?, model?, progress?: { completed, total } }
PaneView      = { state: "idle" | "busy" | "waiting", program?: ProgramStatus, bridge?: BridgeStatus, bridgeConnected: boolean, unread: boolean }
```

`message` is the decoded `msg`, sanitized and cut to 240 characters. `program` and `bridge` are passed through so the UI can show the dialog kind, the activities, and the session. `PaneView.state` is computed by `mergeState` (`protocol.ts`), in this order:

1. **Root state:** from the program status when there is one: `blocked` → `waiting`, `working` → `busy`, and `idle`, `done`, or `error` → `idle`. Without a program status, the bridge's `state` gives it; without either source, the root is `idle`. While a program status exists, the bridge's `state` counts only for `waiting`.
2. `waiting` if the root is `waiting`, the bridge's `state` is `waiting`, or any activity is `waiting`. Blocked overrides busy.
3. Else `busy` if the root is `busy` or `activityCount > 0`. Background activities keep a pane busy after pi's own turn is done.
4. Else `idle`.

- `bridgeConnected` is false after the bridge's socket closes. The last `bridge` stays until the terminal exits, for its session, but a closed bridge no longer counts in the merged `state` (pi may have been killed while busy). Clients likewise show its session, marked as disconnected, but not its activities or model, which ended with that pi.
- **Unread** is the daemon's "done" flag: it becomes true when the merged state goes from `busy` or `waiting` to `idle`. `pane.seen { terminalId }` from any client clears it, and the daemon sends the new `pane.status` to every channel. A program status of `error` also sets it.
- Activities follow the Orca bridge's activity protocol (sources and ids 1–64 / 1–160 characters, labels ≤ 240, at most 128 activities per pane).

### Requests from the bridge

`pane.open { terminalId, path, line?, column? }` and `pane.diff { terminalId, path, staged }` go to every channel. The daemon has already checked `path` (see §5); the UI opens the file in Monaco, or the diff against the index or `HEAD`, and may ignore them when no window is focused.

## 5. Bridge ↔ daemon (unix socket)

The daemon listens on `~/.pika-node/run/daemon.sock` (directory mode 0700). It spawns each terminal with `PIKA_NODE_SOCKET` (that path) and `PIKA_NODE_PANE_ID` (the terminal's `terminalId`) in the environment. The bridge is active only when both are set. Each line is one JSON object (NDJSON), ≤ 1 MiB; a longer line closes the socket.

Bridge → daemon:
- `hello`, first: `{ type: "hello", role: "bridge", paneId, pid, version, protocolVersion }`. An unknown `paneId` answers `{ type: "reply", id: "hello", error: { code: "not_found" } }` and the daemon closes the socket.
- `status`: `{ type: "status", status: BridgeStatus }`, the complete status, latest wins. Its `state` is the root agent as the extension sees it: `busy` from `agent_start` to `agent_settled` (not `agent_end`: retries, compaction, and queued messages follow it), and `waiting` while a `ui_prompt_*` dialog is open. The bridge sends it on connect and after every change, at most every 100 ms, always ending on the latest. A new bridge connection for the same pane replaces the older one.
- `open`: `{ type: "open", id, path, line?, column? }`.
- `diff`: `{ type: "diff", id, path, staged? }`.

Daemon → bridge: `welcome { type: "welcome", version, protocolVersion }`, and `reply` for `open` and `diff` (`result: { delivered: number }`, the number of channels it went to).

**Containment:** the bridge sends absolute paths, resolving relative ones against its session cwd. The daemon resolves the path with `realpath`; for a `diff` of a deleted file, it resolves the parent directory and appends the base name. The resolved path must lie inside one of `config.json`'s `roots`, else `outside_roots`; `open` also requires a regular file (`not_found`, `is_a_directory`). The resolved path is what the UI receives.

The socket admits only the owning user (the directory's mode). Any process of that user may claim any pane, which grants it no more than that user already has.

## 6. ssh fallback

`ssh <node> pika-node attach` connects stdin and stdout to the daemon socket. It sends `{ "type": "hello", "role": "client", "version", "protocolVersion" }` for the client, then passes NDJSON both ways. After the hello, the daemon speaks §4 exactly as on a channel: `welcome` first, then requests, replies, and events, one JSON object per line, ≤ 1 MiB. There is no handshake and no allowlist: ssh authenticates and encrypts. This works without the pika server and is the only route for nodes no browser may reach.

## 7. Versioning and errors

- **Versions:** the routing protocol is versioned by its paths (`/api/node/v1/`, `/api/v1/node/`). The end-to-end and inner protocol version is `PROTOCOL_VERSION = 1`: `hs1.v`, `welcome.protocolVersion`, and the bridge `hello`. `hello.protocolVersions` lists what the daemon speaks. A client that needs a newer version shows "update pika-node". New fields and frame types may be added within a version; anything incompatible bumps it.
- **Health:** `GET {base}/api/health` lists `"nodes"` in `features` when nodes are on.

**Socket close codes:**

| Code | Meaning |
| --- | --- |
| 1001 | server shutting down, or silent for 45 s |
| 1008 | outgoing buffer full (slow reader) |
| 4400 | bad frame (invalid JSON, unknown routing `type`, binary, or over 2 MiB) |
| 4401 | credential or session revoked |
| 4408 | no `hello` within 10 s (node) |
| 4410 | replaced by a newer socket for the same node |
| 4429 | too many nodes, sockets, or channels |
| 4503 | nodes turned off |

**Channel close codes** (`close.code`, `hs_error.code`): `closed` (normal), `node_offline`, `client_gone`, `unknown_node`, `too_many_channels`, `handshake_timeout`, `handshake_failed`, `unsupported_version`, `client_not_allowed`, `client_removed`, `node_key_changed` (client side), `replay`, `out_of_order`, `decrypt_failed`, `rekey_required`, `too_large`, `protocol_error`.

**Inner error codes:** `invalid` (bad params), `unsupported` (unknown request type), `not_found`, `exists`, `conflict`, `too_large`, `permission_denied`, `is_a_directory`, `not_a_directory`, `outside_roots`, `exited` (the terminal has exited), `limit` (too many terminals, watches, or uploads), `io` (any other OS error, with its `errno` name in `message`).

## 8. Daemon process and files (spike)

- **Install:** `scripts/install.sh` in a checkout of `services/pika-node/` refuses platforms other than Linux and macOS and Node below 22.19, runs `npm ci` (node-pty builds from source where it has no prebuild; N-API, so it survives Node upgrades), runs a native preflight (node-pty spawns `/bin/sh -c 'exit 0'` in a PTY), and records the real path of `node` in `.node-path` last. `bin/pika-node` runs `src/cli.ts` with that path, so a nix profile switch or GC cannot retarget it, and fails with exit 127 when it is gone (rerun the install). Not yet: immutable `~/.pika-node/<version>/` installs with `.install-complete` and a `current` record swapped by `mv -f`, preflight before stopping the old daemon.
- **Commands:** `start` (detached; waits until the socket answers), `stop` (SIGTERM: hangs up every PTY, then exits), `status` (exit 3 when not running), `run` (foreground), `attach` (§6; starts the daemon when none runs), `clients [list|add|remove]`, `identity` / `fingerprint`, `server <url>` (credential on stdin or `PIKA_NODE_CREDENTIAL`), and `server clear`.
- **Lifetime:** the daemon never exits on its own, with or without terminals; only `stop` (or SIGTERM/SIGINT) ends it. It ignores SIGHUP and logs, rather than dies on, an uncaught exception, so one bad handler does not hang up every PTY.
- **Files:** `$PIKA_NODE_HOME` (default `~/.pika-node/`, mode 0700) holds `config.json`, `identity.json`, `clients.json`, `pending.json`, `daemon.log`, `logs/<terminalId>.log` (each terminal's raw output, 8 MiB per generation, one previous generation `.1`; deleted when the terminal is removed or the daemon stops), `uploads/`, and `run/` (mode 0700): `daemon.sock`, `daemon.pid`, and `state.json` (pid, version, start time, node fingerprint, terminal counts, and the server link's state, for `status`).
- **Socket bind:** a socket file nobody answers on is stale and is replaced under `run/daemon.sock.lock`, so two daemons starting at once cannot both bind; a daemon that finds another one answering exits.
- **Server link:** reconnects with exponential backoff from 1 s to 60 s (straight to 60 s after 4401 or 4410), and treats 45 s without a frame as dead.
