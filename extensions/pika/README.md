# pika

pika uploads every Pi trajectory to a self-hosted pika server. The server ([`services/pika/`](../../services/pika/README.md)) stores the trajectories, makes them searchable, and serves a web UI to read them. pika is built for one user with several machines.

> [!WARNING]
> Trajectories contain everything the model saw: file contents, command output, and any secret that a tool printed. Send them only to a server you control, over a network you trust or through TLS.

## What pika records

- **Sessions.** Every line of the Pi session file, verbatim, including compactions, branches, and custom entries.
- **Model requests.** For each model call, the `before_provider_request` payload after every other extension has changed it, which is the body the provider received. Providers that expose no payload (for example custom `streamSimple` implementations) are recorded as `fidelity: "context"` with the full Pi context, system messages included. Each request is linked to its assistant message by timestamp and response id.
- **Child sessions.** Subagents (top-level, nested, and workflow children) and Herder step sessions, through the [child-session hook](#child-session-hook). Each is uploaded as its own session and linked to its parent session, tool call, agent, workflow, or Herder run and step.
- **Herder runs.** Each run's journal, and its `goal.md` and `plan.md` whenever their content changes and again after a switch to another server.

pika never records request headers, API keys or other credentials, or Pi's auth and settings files. It reads only session files, Herder run files, and the payload and context that Pi hands to extensions.

## Install

pika is part of this collection. Installing the collection loads it as the last entry in `pi.extensions`, so its `before_provider_request` handler sees the payload after every other extension's changes. It does nothing until it is configured.

1. Run the server. See the [server README](../../services/pika/README.md) for building, Docker, and the reverse proxy.
2. Install the collection on each machine: `pi install git:github.com/minhuw/pi-extensions` (see the [root README](../../README.md#install)).
3. In pi, run `/pika login`, enter the server URL, and pair the machine: approve the code pika shows on the server's Devices page (see [Log in](#log-in)). The current session starts uploading at once, and `/pika` confirms that it is captured. A token from `pika token create "<name>"` and writing `~/.pi/agent/pika.json` by hand (below) work too.

To load pika on its own, without the rest of the collection, narrow the package in `~/.pi/agent/settings.json`. Pi loads every resource type a filter leaves out, so the empty `skills`, `prompts`, and `themes` lists are needed too; with them, pika's extension is the only thing the package loads:

```json
{
  "packages": [
    {
      "source": "git:github.com/minhuw/pi-extensions",
      "extensions": ["extensions/pika/index.ts"],
      "skills": [], "prompts": [], "themes": []
    }
  ]
}
```

For one invocation, `pi --extension /path/to/pi-extensions/extensions/pika/index.ts` also works. Load pika after any extension that rewrites provider payloads; otherwise the recorded payload is the one before that extension's changes.

## Configuration

### Log in

`/pika login [url]` configures pika from inside pi, in the TUI or an RPC client:

1. It asks for the server URL, unless you pass it as the argument: `pika server URL: the address you open the pika web UI at, e.g. https://pika.example.com or http://192.168.1.10:7171`, including any base path (`https://homelab.example/pika`). The prompt shows the saved URL, and a blank answer keeps it. The URL must start with `http://` or `https://` and have no credentials, query, or fragment; trailing `/` are dropped. A blank answer with no saved URL, or an invalid URL, shows a warning saying what is wrong and asks again; Esc cancels. An invalid URL given as the argument ends the login with that message. A plain `http://` URL to another host works, but the token then travels unencrypted, and the success message says so.
2. It asks how the machine should log in: **Pair with the pika web UI (recommended)** or **Paste a token**.
3. It gets a token by [pairing](#pairing) or from the [token prompt](#pasting-a-token).
4. It sends the server an empty batch with the token and saves nothing unless the server accepts it. If the server rejects the token, has no pika ingest API at the URL (404), answers with another status or a redirect, or cannot be reached within 5 s, pika says so and leaves `pika.json` as it was. Messages never contain the token.
5. It saves `url` and `token` to `pika.json`, written atomically with mode `0600` (readable only by you), and keeps every other field. `"enabled": false` is removed, since logging in turns uploads on. If `pika.json` is a symbolic link, for example into a dotfiles repository, the link stays and the file it points to is replaced, also with mode `0600`; a link to a missing file is refused. If `pika.json` is not a JSON object, pika refuses to touch it until you fix or remove it.

The login applies at once: the current session starts uploading from its first line, or the process moves to the new server if it was already uploading. Every successful login starts uploading anew, even with the same server and token, so it also resumes uploads a 401 stopped. Child sessions in the same process follow, including those still open from before a `/pika logout`, and other pi processes pick the login up at their next session start. Cancelling any prompt changes nothing. After every successful login, pairing or pasted token, pika [binds](#device-identity) this machine's device key to the token's device in the background.

#### Pairing

Pairing needs no copying of tokens: you approve the machine in the web UI, where you are already logged in, and the server hands pika a new device token.

1. pika asks `Name for this machine in pika (any text up to 64 characters; blank uses <suggested>)`. The suggestion is the hostname without a trailing `.local`, cut to 64 characters (`pi` if that leaves nothing usable). A name is any text of 1 to 64 characters after trimming, without control characters; spaces, punctuation, and non-ASCII letters are fine, and names need not be unique. An invalid name shows a warning and asks again; Esc cancels. pika sends the name with this machine's [device key](#device-identity), and with the saved token when it belongs to the same server, so the server can recognize a machine it already knows.
2. pika shows an 8-character code such as `K7QM-3XRP` and the page to approve it on, `<url>/devices?pair=<code>`. In the TUI, a panel shows both with the time left and "Esc cancels"; in an RPC client, a notification shows them and the command waits.
3. Open the page, log in if asked, check that it shows the same code, and approve it on the Devices page. When the server recognizes the machine, by its saved token or its device key, approving continues that device by default: same id and history, the name you approve, and a new token that replaces its old one. You can add it as a new device instead, or continue another existing device. Denying ends the pairing.
4. pika asks the server for the decision every 2 s, or as often as the server says. Once you approve, it validates and saves the token exactly like a pasted one, and the login applies at once: `Logged in to <url> as <name>; saved to <file>.`, followed by ` This continues the existing device.` when it does.

Codes expire after 10 minutes, and pika stops waiting after 10 minutes. A denied, expired, or cancelled pairing (Esc in the TUI) changes nothing, nor does one the server no longer knows or one that cannot reach the server; pika says which happened. One login runs per pi process: a new `/pika login` or a `/pika logout` cancels a pairing that is still waiting and says so, and so does the end of the session that started it; approving its code afterwards saves nothing. Once the server has answered an approved pairing, it has created the device, or given an existing one a new token that replaced its old one, so when pika cannot keep the token (the token fails validation, for example because a proxy blocks `/api/ingest/`, or the login was cancelled as the approval arrived), the message names that device as `<name> (<id>)` to revoke on the Devices page, or, for a continued device, suggests running `/pika login` again. The token and the pairing's secret id never appear in a message. A server older than pika 0.2 has no pairing (it answers 404); pika says so and asks for a token instead, suggesting a name such a server accepts when the chosen one has other characters. A server older than 0.4 accepts only names of letters, digits, `.`, `_`, and `-`; when a server refuses a name pika considers valid, pika says so. Such a server does not recognize machines by their key or token, and its device ids are the names.

#### Pasting a token

pika asks for a token from `pika token create "<name>"` on the server. In the TUI, the input shows one `•` per character, never the token; typing, editing, and pasting work as usual. RPC clients show pika's prompt as a plain text input, which pika cannot mask. The token must be entered every time: pika never reuses the saved token or `PIKA_TOKEN`.

#### Device identity

On the server, a device has an id, which never changes, and a name, a label you choose when pairing and can change on the Devices page. Devices paired before pika 0.4 keep their old name as their id. pika shows the name the server approved.

Each agent dir has a device key: `<agentDir>/pika/device-key.json`, `{ "v": 1, "key": "<64 hex>", "machine": "<sha256 of the machine id>" }`, written atomically with mode `0600`. pika makes it the first time it needs it, and makes a new one when the file is missing, unreadable, or invalid, or when its `machine` is not this machine's [machine id](#several-pi-processes): an agent dir copied to another machine thus becomes a new device. That comparison needs the id from the OS: while pika has only the hostname fallback (when `ioreg` fails, for example), it keeps an existing key, and a file it makes then has `"machine": null`, which the next process with the OS's id fills in, keeping the key. When two processes write the file at once, both use the one that ends up on disk. The server stores only a hash of the key, and pika never shows it. `/pika logout` keeps the file; delete it to make the next pairing a new device.

- **Re-pairing continues the device.** A pairing sends the key, and the saved token (from `pika.json` or `PIKA_TOKEN`) only when the saved URL (`pika.json` or `PIKA_URL`) is the server being logged in to; a token never goes to another server. The web UI then offers to continue the device it recognized, keeping its history. After the pairing, the key points at the device it was paired as.
- **Bind.** Devices paired before 0.4, and logins with a pasted token, are recognized after pika binds the key to their token's device (`POST api/pair/v1/bind`). pika does this after every successful login and once per pi process when pika is enabled with a URL and token, in the background. A bind never moves a key that already belongs to another device, and every failure, including a 404 from a server older than 0.4, is ignored silently; it never delays or fails a session, and a bind still running when the process's last session ends is aborted, so it never delays exit (the next session binds again).

`/pika logout` removes `url` and `token` from `pika.json` and keeps the other fields. This pi process stops uploading at once, for its child sessions too; whatever is still queued stays in `<agentDir>/pika/` and is sent after the next login, which also resumes the sessions that are still open. With a symbolic link, the file it points to is rewritten, as for `/pika login`.

`PIKA_URL` and `PIKA_TOKEN` still take precedence over the saved login, and `PIKA_DISABLED=1` keeps pika off; `/pika login` and `/pika logout` warn when one of them is set.

### `pika.json`

`<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`, is what `/pika login` writes. You can also write it by hand:

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
| `token` | none | The device token from pairing or `pika token create "<name>"`. The server maps it to the device, so the device is never sent as data. |
| `enabled` | `true` | `false` turns pika off without removing the file. |
| `exclude` | `[]` | Working directories pika skips (below). |

pika is enabled only when it has both a URL and a token. A missing file means "not configured"; an unreadable or non-object file disables pika, and `/pika` shows why.

Environment variables override the file:

| Variable | Effect |
| --- | --- |
| `PIKA_URL` | Replaces `url`. |
| `PIKA_TOKEN` | Replaces `token`. |
| `PIKA_DISABLED=1` | Always disables pika, whatever the file says. |

The configuration is read at each session start, so hand edits apply to the next new, resumed, or reloaded session. `/pika login` and `/pika logout` also apply at once in the pi process that runs them.

### Exclude list

Each `exclude` entry is matched against the session's working directory:

- A plain path excludes that directory and everything below it: `"/home/me/work/client"` excludes `/home/me/work/client` and `/home/me/work/client/api`, but not `/home/me/work/client2`.
- A pattern with `*`, `**`, or `?` excludes a cwd when the pattern matches the cwd or one of its ancestors. `*` and `?` stay within one path segment, and `**` crosses segments: `"/home/me/scratch/*"` excludes every directory under `/home/me/scratch`, and `"**/secret-*"` excludes any directory below one whose name starts with `secret-`.
- `~` and `~/…` expand to the home directory, and absolute patterns are used as written.
- Relative patterns, plain or glob, resolve against the directory pi was started in: started in `/home/me`, `"scratch/*"` means `/home/me/scratch/*`. Patterns that start with `**` are the exception and match at any depth. Prefer absolute or `~/` patterns, since pi's start directory changes.

An excluded session's child sessions and Herder runs are skipped too, wherever they run. A child counts as the session's child when its `parentSession` header names the session file, or when its `pi-extensions.session-link` entry names the session id or file. A Herder run is also skipped when its run directory is excluded.

## Behaviour

### Which sessions are uploaded

Only sessions that start or resume while pika is enabled are uploaded; older sessions are never backfilled. A resumed session continues from its last acknowledged byte, or from its first line if pika has not seen it before. Entries usually reach the server within a second of being written. Sessions without a session file (`--no-session`) are not captured.

If pika is loaded twice in one session, for example from the package and again through the hook, only the last-loaded copy captures.

### Delivery and the offline spool

pika never blocks or fails a turn. Its handlers only enqueue work, and errors are recorded for `/pika`. Uploads run in the background as gzip batches under 8 MiB (uncompressed). A request's new blocks may go out over several batches before the request itself. A single block or session line larger than that is sent alone, so it must fit the server's `--max-body` (32 MiB by default) and the proxy's body limit.

Repeated messages and tool declarations are uploaded once, as content-addressed blocks: each element of a top-level array in the payload, and each top-level string over 2,048 characters, is sent by hash. pika remembers which hashes the server already has and sends only new ones.

Network errors, timeouts (30 s per batch), and error answers other than 401, 409, and 413 are retried with exponential backoff from 0.5 s up to 60 s, for as long as pi runs. A 401 stops uploading until `/pika login` succeeds, also with the same token, a new session starts in the same pi process, or pi restarts. When the last session shuts down, pika flushes for at most 2 s, and whatever remains is sent the next time pi starts with pika enabled.

On a 413, pika halves its batch size, down to 256 KiB. When a batch of one item still gets 413 three times, pika parks that item and goes on with the rest. A parked block or request moves to `spool/parked/` and is not retried, and requests that reference a parked block stay incomplete on the server. A parked session line stops only its own stream, because later lines depend on it. Parked files are kept for inspection and are never retried, so set the proxy's body limit and the server's `--max-body` high enough first.

State lives in `<agentDir>/pika/`, normally `~/.pi/agent/pika/`:

| Path | Contents |
| --- | --- |
| `streams/` | One cursor per stream: the byte length the server has acknowledged, written atomically. Session lines are read again from the session file itself, so the file is the queue. |
| `streams/done/` | Cursors of fully uploaded, closed streams. |
| `spool/requests/` | Captured requests, until the server accepts them with none of their blocks missing. A payload is written when the provider request starts; a `fidelity: "context"` call, when its response starts. |
| `spool/blobs/` | Block texts of spooled requests, so pika can always answer `missingBlobs`. A block is deleted once every request that references it is complete. |
| `spool/parked/` | Items the server refused as too large. |
| `device-key.json` | This agent dir's [device key](#device-identity). |
| `acked.log` | A bounded set (100,000) of block hashes the server already has, and the server URL they belong to. A different URL starts an empty set. |

After a crash or a lost connection nothing is lost and nothing is duplicated on the server. On the next start, pika resumes every open stream from its cursor and resends spooled requests; at worst something is sent twice, and the server ignores duplicates. A request stays held, and is not uploaded, until its assistant message arrives; an aborted or failed call is recorded with its aborted or error assistant message. A call that gets no assistant message, such as a compaction or another side request, is released without `assistant` when the next call starts or the session shuts down. If pi dies while it holds a request, another pi process or the next start uploads the request without its `assistant` link, for payload and context fidelity alike. Only a call that exposed no payload and whose response had not started yet is not recorded, for example when pi exits while the provider is still connecting. If the server reports a gap below pika's cursor, for example after it was restored from an older backup, pika rewinds the stream and resends from the server's length. If the server's copy of a stream differs from the local file, the stream stops with a conflict and `/pika` shows it.

Delete `~/.pi/agent/pika/` to forget all local state, including the device key, so the next pairing makes a new device. Sessions that are resumed afterwards are uploaded again from offset 0, and the server ignores the lines it already has.

### Several pi processes

All pi processes on a machine share `<agentDir>/pika/`, and any of them uploads what another spooled. A request held for its assistant message records the process that holds it: its pid, a machine id, and the process start time. Another process uploads the request without waiting once that process is gone, and checks again every 5 s while it runs.

- The machine id is `/etc/machine-id` (or `/var/lib/dbus/machine-id`) on Linux and `IOPlatformUUID` on macOS, so it survives hostname changes from DHCP or a VPN. Other platforms use the hostname.
- The start time rules out a reused pid. It is the boot id and start ticks on Linux and the `ps` start time in epoch seconds on macOS and other Unix systems. Requests held by an earlier pika version, which recorded a localized start time, are checked by pid alone, within the 6-hour limit below.
- Where pika cannot verify a holder, it uploads the request as it is 6 hours after it was captured: when the holder ran on another machine, or on Windows, which has no start time to tell a reused pid from the original process. On Windows, a request held by an exited process whose pid now belongs to another long-running process therefore waits up to 6 hours.

Do not share one agentDir between machines, for example over a network file system. pika cannot tell whether a process on another machine is alive, so requests that machine held would wait 6 hours.

### `/pika`

`/pika` (or `/pika status`) shows:

- whether pika is enabled, or why not;
- the server URL;
- whether the current session is captured, or why not (excluded, no session file);
- queued items and bytes;
- the last successful upload and the last error;
- any stream that stopped on a conflict or an oversized line, uploads stopped by a 401, and parked items with their directory.

When no URL and token are configured, it suggests `/pika login`. `/pika login [url]` and `/pika logout` are described under [Log in](#log-in).

### Child-session hook

Extensions never import each other. pika exposes itself to child-session creators through a process-wide registry:

```ts
const hooks: Set<{ name: string; extensionFactory: (pi: ExtensionAPI) => void }> =
	(globalThis as any)[Symbol.for("pi-extensions.child-session-hooks")] ??= new Set();
```

- Whoever needs the `Set` first creates it. pika adds one hook named `"pika"` when it starts capturing and removes it when the last captured session shuts down, or at `/pika logout`.
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

### Credentials registry

pika publishes its active server credentials for other extensions, such as [relay](../relay/README.md), which never import it:

```ts
const registry: { current: { url: string; token: string; isExcluded(cwd: string): boolean } | undefined; listeners: Set<() => void> } =
	(globalThis as any)[Symbol.for("pi-extensions.pika.credentials")] ??= { current: undefined, listeners: new Set() };
```

- `current` is set while pika is enabled with a URL and token, and `undefined` when it is disabled (including `PIKA_DISABLED=1`), logged out, or unconfigured. `isExcluded` applies the [exclude list](#exclude-list).
- pika reads the configuration at each session start, `/pika login`, and `/pika logout`, and calls every listener after each change, including a login that switches servers. A configuration that reads the same is no change.
- Either side may create the registry first.

### Herder runs

Herder emits `herder:run` on `pi.events` with `{ runId, runDir, journalPath, goalPath, planPath, repo, title }` when a run starts or resumes and after journal appends. pika tails `journalPath` as stream `herder:<runId>` and uploads `goal.md` and `plan.md` as documents whenever their sha256 changes. The uploaded versions are recorded with the server URL, like the acknowledged hashes, so after `/pika login` switches to another server the new server gets each run's goal and plan again without waiting for them to change. Versions recorded by pika 0.1, without a URL, count as the server's that the acknowledged hashes were recorded for. Only runs started from a captured session are uploaded.

## Deployment

The server is one Rust binary with the web UI embedded, published as the multi-arch image `ghcr.io/minhuw/pika` (amd64 and arm64). Its [README](../../services/pika/README.md) is the reference for image tags, building, the CLI, backups, and the [deployment examples](../../services/pika/deploy/). The short version:

```bash
docker run --rm -it -v pika-data:/data ghcr.io/minhuw/pika:latest password set
docker run -d --name pika --restart unless-stopped -p 127.0.0.1:7171:7171 -v pika-data:/data \
  -e PIKA_BASE_PATH=/pika -e PIKA_TRUST_PROXY=1 ghcr.io/minhuw/pika:latest
```

The first command stores the web UI's password (at least 12 characters) in the volume. Since 0.2 the server refuses to start without a password, unless `PIKA_AUTH=proxy` says the reverse proxy authenticates. The image runs as a non-root user with `/data` as its volume and a health check on `/api/health`. To build it yourself, run `docker build -t pika services/pika` and use `pika` as the image.

Behind nginx under a path prefix, forward the path unchanged, allow bodies up to the server's `--max-body`, and pass the client's address and scheme, which pika trusts with `PIKA_TRUST_PROXY=1`:

```nginx
location = /pika { return 301 /pika/; }
location /pika/ {
    proxy_pass http://127.0.0.1:7171;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 32m;
    client_body_timeout 120s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
}
```

Then run `/pika login https://homelab.example/pika` on each machine and pair it, or create a token with `docker exec pika pika token create laptop` and set it with the `url` in the machine's `pika.json`. Caddy examples, subdomain variants, and putting authentication in the proxy are covered in the server README; if the proxy adds authentication, leave `/api/ingest/` to pika's bearer tokens and `/api/pair/` open for pairing.

## Tests

```bash
npm ci
npm run test:pika
```

`npm run test:pika` runs offline Vitest suites against real Pi runtimes and a mock ingest server with the server's append, gap, conflict, and idempotency rules. `/pika login` and `/pika logout` run through a scripted UI, in both RPC and TUI mode, with pairing against the mock server's pairing API. One test runs a real pi TUI in `tmux` (skipped when `tmux` is not installed): it types and pastes a token, checks the captured screen never shows it, and pairs. Payload capture goes through Pi's real `openai-completions` implementation against a local mock endpoint. No live providers are used. `npm test` includes it. The cross-component test against the real server is `bash services/pika/scripts/e2e.sh`.
