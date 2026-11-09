# pika

pika captures your Pi sessions and model requests on a self-hosted [server](../../services/pika/README.md), where you can search and read them in a web UI. It is designed for one user working across several machines. The same server connection powers [relay](#relay), which lets running Pi sessions message each other, and [recall](#recall), which lets the agent search past sessions and Herder runs, and [memory](#memory), which lets the agent keep durable notes for you and each project and consolidates them in background [dreams](#dreaming).

> [!WARNING]
> Trajectories contain everything the model saw: file contents, command output, and any secret that a tool printed. Send them only to a server you control, over a network you trust or through TLS.

## What pika records

- **Sessions.** Every line of the Pi session file, verbatim, including compactions, branches, and custom entries. With them, the session's working directory, its git repository's name, and the repository's web URL with any credentials removed (see [Projects and repositories](#projects-and-repositories)).
- **Model requests.** For each model call, the `before_provider_request` payload after every other extension has changed it, which is the body the provider received. Providers that expose no payload (for example custom `streamSimple` implementations) are recorded as `fidelity: "context"` with the full Pi context, system messages included. Each request is linked to its assistant message by timestamp and response id. Its `timing` holds when the payload was sent (`sentAt`, at `before_provider_request`), when the provider's response headers came back (`responseAt`, at `after_provider_response`), and when the first text, thinking, or tool-call token arrived (`firstTokenAt`, with its kind in `firstToken`), each in Unix epoch milliseconds and only when the transport reported that stage.
- **Child sessions.** Subagents (top-level, nested, and workflow children) and Herder step sessions, through the [child-session hook](#child-session-hook). Each is uploaded as its own session and linked to its parent session, tool call, agent, workflow, or Herder run and step.
- **Herder runs.** Each run's journal, and its `goal.md` and `plan.md` whenever their content changes and again after a switch to another server.

pika does not collect transport request headers or read Pi's auth and settings files for capture. It records session files, Herder run files, and the payload and context Pi hands to extensions. **Credentials that appear in this content are uploaded too**, including secrets printed by tools.

## Install

pika is included in this collection and listed last in `pi.extensions`, so its `before_provider_request` handler sees the payload after the other extensions have changed it. Capture starts only after configuration. Relay, recall, and memory are included; they need no separate installation or login.

1. Run the server. See the [server README](../../services/pika/README.md) for building, Docker, and the reverse proxy.
2. Install the collection on each machine: `pi install git:github.com/minhuw/pi-extensions` (see the [root README](../../README.md#install)).
3. In pi, run `/pika login`, enter the server URL, and approve the displayed code on the server's Devices page (see [Log in](#log-in)). The current session starts uploading immediately; run `/pika` to check its status. You can also create a token with `pika token create "<name>"` and write `~/.pi/agent/pika.json` by hand, as shown below.

To load pika on its own, without the rest of the collection, narrow the package in `~/.pi/agent/settings.json`. Pi loads every resource type a filter leaves out, so the empty `skills`, `prompts`, and `themes` lists are needed too; with them, pika's extension, relay, recall, and memory included, is the only thing the package loads:

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
- **Bind.** Devices paired before 0.4, and logins with a pasted token, are recognized after pika binds the key to their token's device (`POST api/pair/v1/bind`). pika does this after every successful login and once per pi process when pika is enabled with a URL and token, in the background. A bind never moves a key that already belongs to another device, and every failure, including a 404 from a server older than 0.4, is ignored silently; it never delays or fails a session, and a bind still running when the process's last session ends is aborted before it starts a key write or a request, and the shutdown waits at most a second for it to settle (the next session binds again).

`/pika logout` removes `url` and `token` from `pika.json` and keeps the other fields. This pi process stops uploading at once, for its child sessions too; whatever is still queued stays in `<agentDir>/pika/` and is sent after the next login, which also resumes the sessions that are still open. With a symbolic link, the file it points to is rewritten, as for `/pika login`.

`PIKA_URL` and `PIKA_TOKEN` still take precedence over the saved login, and `PIKA_DISABLED=1` keeps pika off; `/pika login` and `/pika logout` warn when one of them is set.

### `pika.json`

`<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`, is what `/pika login` writes. You can also write it by hand:

```json
{
  "url": "https://homelab.example/pika",
  "token": "pika_…",
  "enabled": true,
  "exclude": ["~/work/client-secret", "/home/me/scratch/*"],
  "memory": { "autoDream": true, "dreamIdleMinutes": 20, "dreamModel": "anthropic/claude-haiku-5-5" }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `url` | none | The server's address, including its base path (`https://pika.example.com` or `https://homelab.example/pika`). It must be `http://` or `https://`, without a user name, password, query, or fragment; a trailing `/` is ignored. Plain `http://` works on a trusted network. |
| `token` | none | The device token from pairing or `pika token create "<name>"`. The server maps it to the device, so the device is never sent as data. |
| `enabled` | `true` | `false` turns pika off without removing the file. |
| `exclude` | `[]` | Working directories pika skips (below). |
| `memory.autoDream` | `true` | `false` stops idle sessions from starting [dreams](#dreaming) on their own; `/memory dream` still works. |
| `memory.dreamIdleMinutes` | `20` | How long a session stays idle after its last run before it asks for a dream; at least 1 and at most 35,791 (about 24.8 days, the longest timer Node.js holds), and a larger value counts as 35,791. |
| `memory.dreamModel` | none | `<provider>/<model id>` for dreams, such as `anthropic/claude-haiku-5-5`. Unset or not found, a dream uses its session's model, and `/memory status` says so. |

Invalid `memory` values fall back to their defaults. pika reads `memory` again at every idle wait and `/memory` command, so edits apply without a restart.

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

pika uploads sessions that start or resume while it is enabled, and the current session when `/pika login` succeeds. It does not scan older sessions for backfill. A resumed session continues from its last acknowledged byte, or from its first line if pika has not seen it before. Entries usually reach the server within a second of being written. Sessions without a session file (`--no-session`) are not captured.

If pika is loaded twice in one session, for example from the package and again through the hook, only the last-loaded copy captures.

### Projects and repositories

Each session is filed under a project: the name of the git repository holding its working directory, wherever Pi runs in it. pika asks git for the repository's common directory (`git rev-parse --git-common-dir`); for a `.git` directory the name is the folder holding it, the main checkout's folder, so a session in a subdirectory, in a linked `git worktree`, in a Herder step's worktree, or in a Subagents `isolation: "worktree"` child is filed under the same name as one at the repository's root. A bare repository is named after its directory without one trailing `.git`, a submodule after its directory under `.git/modules`. Both `/` and `\` separate folders. A name that is blank, `.` or `..`, holds a control character or path separator, or exceeds 255 bytes is no name; [`project-names.json`](../../services/pika/docs/project-names.json) lists the cases, which Herder's `repo` shares. git older than 2.31, which lacks `--path-format=absolute`, is asked again without it, within the same 2 s. Outside git, or when git is missing or does not answer within 2 s, the server keeps the basename of the working directory. For older uploads without repository metadata, the server also recognizes `<repo>/.git/superagent/worktrees/<ticket>` and `<repo>/.git/herder/worktrees/<run>/<step>` (including their subdirectories) and uses `<repo>` instead of the ticket or step folder. Existing sessions in these layouts are corrected once when the updated server opens its database, without reuploading or reindexing. Other old worktree paths still need client metadata to identify their repository.

pika also uploads the repository's web URL, which the web UI links to from the session page. It comes from the `origin` remote, or the only remote when there is no `origin`: scp-like `git@host:path`, `ssh://`, and `git://` URLs become `https://host/path` without the port, and `https://` and `http://` URLs keep their scheme and port. Credentials (a user, password, or token before the `@`), query, fragment, a trailing `/`, and `.git` are removed. Local paths, `file://` URLs, hosts other than plain names or IPv4 addresses, and URLs with whitespace or control characters give no URL.

git runs once per working directory and process, without prompts and without the `GIT_*` environment, so `GIT_DIR` cannot point it at another repository; when it does not answer within 2 s, the next lookup asks it again. The session's stream opens once git answered, so its first upload already carries both fields; lines written meanwhile are uploaded from the session file. Both travel in the session stream's `meta` as `project` and `repository`. The [exclude list](#exclude-list) still applies to the working directory.

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

pika publishes its active server credentials for [relay](#relay), [recall](#recall), and [memory](#memory) through a process-global registry, so module copies loaded for other cwds share them:

```ts
const registry: {
	current: { url: string; token: string; isExcluded(cwd: string): boolean } | undefined;
	listeners: Set<() => void>;
	repository?: (cwd: string) => Promise<{ project?: string; repository?: string }>;
} = (globalThis as any)[Symbol.for("pi-extensions.pika.credentials")] ??= { current: undefined, listeners: new Set() };
```

- `current` is set while pika is enabled with a URL and token, and `undefined` when it is disabled (including `PIKA_DISABLED=1`), logged out, or unconfigured. `isExcluded` applies the [exclude list](#exclude-list).
- pika reads the configuration at each session start, `/pika login`, and `/pika logout`, and calls every listener after each change, including a login that switches servers. A configuration that reads the same is no change.
- `repository(cwd)` resolves the git repository of `cwd` as pika files sessions (see [Projects and repositories](#projects-and-repositories)): `project` is its name and `repository` its web URL without credentials, both absent outside git. It is cached per cwd once git answered, never rejects, and settles within a few seconds. pika sets it whether or not it is logged in; older pika versions lack it, so callers fall back to the basename of `cwd`. relay names its sessions' project with it, and recall resolves `scope: "project"` with it.
- Either side may create the registry first.

### Herder runs

Herder emits `herder:run` on `pi.events` with `{ runId, runDir, journalPath, goalPath, planPath, repo, title }` when a run starts or resumes and after journal appends. pika tails `journalPath` as stream `herder:<runId>` and uploads `goal.md` and `plan.md` as documents whenever their sha256 changes. The uploaded versions are recorded with the server URL, like the acknowledged hashes, so after `/pika login` switches to another server the new server gets each run's goal and plan again without waiting for them to change. Versions recorded by pika 0.1, without a URL, count as the server's that the acknowledged hashes were recorded for. Only runs started from a captured session are uploaded.

## Relay

relay lets running Pi sessions send text messages to each other across your machines through the pika server. Connected sessions appear on the server's **Active sessions** page, where you can also send them messages.

Codex desktop threads can join through the [Pika Relay for Codex](../../plugins/pika-relay/README.md) plugin; they appear as sessions named `codex-…` and use the same tools.

The server is the only route between sessions, including two sessions on the same machine. The wire contract is [`services/pika/docs/RELAY.md`](../../services/pika/docs/RELAY.md).

### Requirements

- pika logged in with `/pika login`. relay uses pika's server URL and device token; there is no separate key or login. It reads them from the [credentials registry](#credentials-registry), so it follows `/pika login` and `/pika logout` at once.
- A pika server 0.3.0 or newer with relay on (the default). With an older server, or one started with `PIKA_RELAY=off`, sessions stay offline and pi says so once per process.
- Node's built-in `WebSocket` with custom headers, which Node 22.19 and newer provide.

### Open by default

relay connects every eligible session as soon as pika is logged in. A session connects when all of these hold:

- `PI_RELAY_DISABLED` is not `1`;
- pika has credentials and its `exclude` list does not cover the session's working directory;
- pi runs in the TUI or in RPC mode (not `-p` print or JSON mode);
- the session is a top-level session, not a Subagents child or Herder step;
- you have not run `/relay off` in it;
- the server's `/api/health` lists the `relay` feature.

One WebSocket per online session opens after the session starts; `/new`, `/resume`, and forks move the connection to the new session, `/reload` reconnects it, and quitting closes it. When pi asks to switch or fork, the outgoing session closes its connection without reconnecting, so the server keeps its messages queued and drops them after 5 minutes as usual; nothing is held in pi. If the replacement does not happen after all (another extension cancelled it, or it failed, as a `/clone` of a session without a reply yet or a `/resume` of a session whose working directory is gone can), the session reconnects at your next prompt, at `/relay`, or after 10 s, whichever comes first, and the server pushes again whatever has not expired. Lost connections are retried after 1 s, 2 s, 4 s, and so on up to 30 s, with jitter. A revoked token (close code 4401), a session owned by another device (4403) or already online from another device (4409), another pi process that opened the same session and took it over (4410), or relay turned off on the server (4503) stops the retries until pika's credentials change or you run `/relay on`; `/relay` says which. After a takeover, `/relay on` takes the session back, and the other process stops in turn.

#### Child sessions and the persistence side effect

Subagents children and Herder steps never connect. To recognize them, relay registers a hook that Subagents and Herder load into every child session. A registered child-session hook makes Subagents keep every child session on disk, including nested children and agents with `persist_session: false`, so relay registers it only while at least one session in the process could connect: pika has credentials, its `exclude` list does not cover the session, the session runs in the TUI or RPC mode, and it is not `/relay off`. `/relay off`, `/relay on`, pika's credentials changing, and sessions starting, being replaced, or quitting re-evaluate it. pika's upload registers a hook of its own while it uploads, with the same effect; it adds only the upload to a child session, never relay, recall, or memory.

### Turning it off

- For every session of a pi process: start pi with `PI_RELAY_DISABLED=1`.
- For one session: `/relay off` (until `/relay on`, or the end of the session).
- For the whole server: start the pika server with `PIKA_RELAY=off`.

### Receiving messages

A message from another session or from the web UI is added to the session as a `relay-message` and shown with its sender:

- when the session is idle, it starts a turn;
- when the session is busy, it is queued after the current turn, or steered into it when the sender marked it urgent.

The model reads who sent it, the message id, and, for another session, that it did not come from you and how to answer with `relay_send`. Each message is handed to pi, then recorded as a `relay-received` entry with its text, and then acknowledged to the server. A message pi refused at once (its `sendMessage` threw) is neither recorded nor acknowledged, so the server pushes it again after a reconnect and it is delivered then. A message that arrives while pi compacts the session or summarizes a branch is not acknowledged either, because pi would start a turn next to the compaction; once that ends, relay reconnects and the server pushes the message again. A message the server pushes again after it was delivered, after a reconnect or `/resume`, is acknowledged without being delivered twice.

A message that arrives while the session is busy waits in pi's follow-up or steer queue. Pressing Esc, or RPC `clear_queue`, clears those queues and restores only plain user messages to the editor: a queued relay message is then dropped from the model's context. Its text stays in the transcript in the `relay-received` entry.

Every field of a message comes from another device or the web UI. Terminal escape sequences and control characters other than newline and tab are stripped before a message is shown, and the sender's name, title, device, and project are put on one line without double quotes, zero-width characters, or bidirectional controls, in the text the model reads and in the sender line pi shows, so a crafted name cannot forge a second message header or disguise itself.

### Device names

A device has an id, which never changes, and a name, which you choose when you pair it and can change on the server's Devices page. relay shows the name wherever it shows a device: in `relay_list` and `/relay`, in the sender line of a message and the header the model reads, and in delivery notices. A pika server older than 0.4 sends no names; relay then shows the device id, which for devices paired before 0.4 is the name they were paired with. Names need not be unique; addressing, ownership, and revocation use the id.

### Tools

Top-level sessions in the TUI or RPC mode get three tools; print and JSON sessions, including every Subagents and Herder child, never do:

- **`relay_list`** `{ device?, project?, query? }` lists the other online sessions: id, device, project, name or title, idle or busy, model, and how long each has been online. `device` matches a device's name or its id, ignoring case. A session's project is the name of its git repository as pika files it (the main checkout's folder, also from a subdirectory or a linked worktree), else the basename of its working directory; relay asks pika's registry for it, and uses the basename with a pika version that cannot answer.
- **`relay_send`** `{ to, text, urgent?, replyTo? }` sends a message and reports `delivered` (the target session accepted it) or `queued` (it is offline or busy accepting it). A message not delivered within 5 minutes is dropped, and the sender's session gets a `relay-notice` that starts a turn. Delivered means received, not read or answered; answers arrive later as messages.
- **`relay_status`** `{ id? }` shows the state of messages this session sent in this process: `queued`, `delivered`, `expired`, `rejected`, `failed` (it never left the session), or `unknown` (the server never answered: a timeout, a dropped connection, or a cancelled tool call, so it may or may not have been accepted).

### Command

- `/relay` shows the connection state, or why the session is offline, the server URL, this session's id, and the other online sessions.
- `/relay send <sessionId> <text>` sends a message as you.
- `/relay off` and `/relay on` disconnect or reconnect this session.

### Safety

- **Any device token can message every online session.** A machine you paired with pika can start turns in all your connected sessions, on every machine. Revoke devices you no longer use on the server's Devices page; revoking one closes its relay connections at once.
- **Hop limit.** Every message carries a hop count. A turn you start resets it; a turn started by a relay message continues from that message's count, and each `relay_send` adds one. The server rejects messages above its hop limit (128 unless the server sets `PIKA_RELAY_MAX_HOPS`), which stops sessions that keep relaying to each other without you.
- Messages pass through the server as plain text and are held in memory only until they are delivered or expire. The session transcripts that pika uploads are the permanent record.
- Messages from other sessions are marked as not coming from you, but a model may still act on them. Treat every connected session as able to ask any other for work.

## Recall

recall lets the agent search and read the sessions and Herder runs pika has uploaded from every machine and project. It can look up earlier decisions, solutions to past errors, and the steps and outcome of a Herder run.

It reads through the server's agent read API (`{base}/api/agent/v1/`, "Agent read API" in [`services/pika/docs/SPEC.md`](../../services/pika/docs/SPEC.md)), which sees every recorded session and Herder run, published or not, with credentials scrubbed as in public responses.

### Requirements

- pika logged in with `/pika login`. recall uses pika's server URL and device token; there is no separate key or login. It reads them from the [credentials registry](#credentials-registry), so it follows `/pika login` and `/pika logout` at once.
- A pika server with the agent read API (its `/api/health` lists the `agent` feature).
- Read access for the device, which every device has by default. To stop a device's agents, turn off "Agents can read" for it on the server's Devices page, or run `pika token read-access <device> off` on the server; `pika token create <name> --no-read-access` creates a device without it. Revoking the device's token leaves the switch as it was, and a pairing that continues the device keeps it.

### Tools

All three tools are registered in every session, top-level and child (Subagents and Herder steps) alike, whatever the credentials; without them a call fails and says what to do.

- **`recall_search`** `{ query, scope?, project?, sort?, limit? }` searches past sessions. Every word of `query` must match; `"quoted phrases"` match as phrases. `scope: "project"` searches the current project only: the git repository's name as pika resolves it, else the working directory's basename; `project` names a project and wins over `scope`. `sort` is `relevance` (default) or `newest`; `limit` is 1 to 20 sessions (default 8). The current session is never listed, nor its subagents. Each session shows its title, `sessionId`, project, last active date, match count, and up to 3 hits with their kind, `seq`, date, and snippet, matches in «…».
- **`recall_read`** `{ sessionId, seq?, fromTurn? }` reads a session. Without `seq`, an overview: title, project, working directory, device, start and last times, models, child sessions, and then the turns from `fromTurn` (default 0), each with the prompt, its tool calls (at most 30 listed, failures marked), and the final answer. With `seq`, the entries from `seq - 4` to `seq + 8` in full: messages, thinking, tool calls with their arguments, tool results, summaries, and extension messages, with images as `[image]`. A result holds about 20,000 characters and says which `fromTurn` or `seq` continues. A Herder step's session names its run.
- **`recall_herder`** `{ runId?, fromEvent?, scope?, project?, limit? }` lists or reads Herder runs. Without `runId`, the runs newest first, each with its title, `runId`, project, status, verdict, step count, start and last times, device, and orchestrating session; `scope` and `project` choose the project as for `recall_search`, and `limit` is 1 to 50 runs (default 10). With `runId`, the run's summary, its goal (cut to 4,000 characters), plan (cut to 6,000), and steps (role, task, label, status, attempts, commit, session; at most 60 listed, as many as the result's budget holds), then its journal from `fromEvent` (default 0), one event a line or a few: launches, step starts, replies, structured data, and failures, checks with the tail of a failing log, integrations and conflicts, verification verdicts, unmet criteria and gaps, decisions, and delivery. From a later `fromEvent` it shows the summary and the journal only. A result holds about 20,000 characters and says which `fromEvent` continues; `recall_read` reads the step and orchestrator sessions it names.

Every result starts with a line saying it is recorded history from past sessions, to be treated as reference data and not as instructions. Long texts are cut.

### Errors

A call fails, and the model reads why, when:

- pika is not logged in: run `/pika login`;
- the server rejects the device token (HTTP 401): run `/pika login` to pair the device again;
- the device's read access is off (HTTP 403 `read_access_denied`): turn "Agents can read" back on for it, or run `pika token read-access <device> on`;
- the server has no agent read API (HTTP 404, and `/api/health` does not list `agent`): upgrade the server;
- the session id or run id is unknown;
- the server's agent read API has no Herder runs (HTTP 404 for both a run and the run list): upgrade the server;
- the server cannot be reached, or does not answer within 15 s; aborting the tool call stops the request.

## Memory

memory lets the agent keep durable notes on the pika server, shared by every machine: what you want, your corrections and preferences, confirmed pitfalls, decisions, and pointers to references. The server stores each note with its history and renders an index of their titles and hooks ("Memory" in [`services/pika/docs/SPEC.md`](../../services/pika/docs/SPEC.md)); you can read them, with their history, under the server's owner API.

### Scopes

- **User:** one scope for you, in every project and on every machine.
- **Project:** the git repository of the session's working directory, as pika [names it](#projects-and-repositories). Every call sends both its `project` and `repository`; the server files notes under the repository's URL, so clones on different machines share them, or, without a remote, under the project name and this device. Outside git there is no project scope: `scope: "project"` saves fail and say so, and the user scope still works.

### Tools

The three tools are registered wherever pika's extension loads, whatever the credentials, but never through the child-session hook (see [Memory in child sessions](#memory-in-child-sessions)). Every call sends the session's id, which the server keeps as the note's last writer.

- **`memory_read`** `{ ids?, query?, category?, scope? }` reads the user scope's and the project scope's notes and filters them in pi: `ids` by note id (the `[id]` in the index), `query` by text in the title, hook, or body, ignoring case, `category` (`user`, `feedback`, `project`, or `reference`), and `scope` (`user` or `project`). Each note shows its id, scope, category, title, hook, body, revision, and last update; a result holds about 20,000 characters and lists the notes past that by title.
- **`memory_save`** `{ id?, expectedRevision, scope, category, title, hook, body, reason? }` creates a note (no `id`, `expectedRevision: 0`) or replaces one (`id` and its current revision). Titles are up to 120 characters, hooks one line up to 150, bodies up to 8 KiB, and the index of the user and project scopes together up to 8 KiB and 200 lines. The result shows the server's new index and says the session's pinned section stays unchanged.
- **`memory_forget`** `{ id, expectedRevision, reason? }` forgets a note; it leaves the index, and its history stays on the server.

The tools' guidelines ask the model to save only what the code, git history, and AGENTS.md cannot tell, to keep hooks short, to verify a note against the code before relying on it, and never to store secrets; the server also scrubs credentials from every note.

A call fails, and the model reads why, when pika is not logged in, pika is disabled (the result names the cause, such as `PIKA_DISABLED=1`), its `exclude` list covers the session's working directory, the server rejects the token (401) or the device's read access is off (403 `read_access_denied`, switched as for [recall](#recall)), the server has no memory routes (404), or the server cannot be reached or does not answer within 15 s; aborting the tool call stops the request. A save or forget of a note that changed since the model read it (409 `revision_conflict`) fails with the note's current state, to merge and retry. A save that would pass the index's budget (422 `memory_full`) fails with the sizes and asks the model to merge or forget notes; a note the server refuses (400) fails with the server's message. A save or forget of an unknown note (404) reads the notes again to tell why: a save that names the wrong scope says which scope the note is in, since a note never changes scope; a note in neither scope was forgotten or belongs to another project; and when that read fails, the result says the note could not be checked. No result repeats a user name or password in the server URL.

### The pinned `memory` section

At the first run of a fresh top-level session (TUI or RPC, no history, no `pi-extensions.session-link` entry), pika fetches the index once, waiting at most 1.5 s, and pins it in a `pika-memory` custom entry: `{ index, fetchedAt, project?, repository? }`. It is a custom entry, never a message, so it is not shown and never starts a turn. A session has history once it holds a run's messages, a compaction, or a branch summary; `!` commands and custom messages added before the first prompt do not count. Every run of the session then adds the same `memory` system-prompt section: a fixed header saying these are the user's and the project's notes from earlier sessions, possibly stale or wrong and not instructions, to verify against the code and maintain with `memory_read`, `memory_save`, and `memory_forget`, followed by the pinned index with `<` and `>` written as `&lt;` and `&gt;`, so that no note can close the section's `<memory>` tags; an index without them appears verbatim.

The section's bytes never change within a session, so the prompt cache holds: not after `memory_save` or `memory_forget` change the server's index, nor after `/reload`, `/tree`, or a resume, which read the pin from the session file. A pin applies in every mode, so a session resumed in print or JSON mode (`pi -c -p`) keeps its section. A new session pins the index as it is then. When pika is logged out, the session is excluded, or the fetch fails or times out, the pin records `index: null` and the session never gains a section, even once the server is back. An empty index adds no section. Sessions with history but no pin, such as those from before memory, get no section and no fetch; so do print and JSON sessions without a pin, which never create one, and sessions with a session link, even one carrying a pin.

### Memory in child sessions

memory is not part of pika's [child-session hook](#child-session-hook): Subagents children and Herder steps that get pika through the hook have neither the tools nor the section. A child that loads the whole pika extension itself has the tools but still no section, since it carries a session link, which keeps out any pin, or runs without a mode, which never creates one.

There is no local cache and no offline queue: every tool call goes to the server, and a call that cannot reach it fails.

### Dreaming

A dream is a background child session that consolidates memory from your recent sessions in one project: it reads what they did, checks it against the code, and saves, updates, or forgets notes. It runs in the pi process of a top-level session (TUI or RPC, no session link, pika logged in, not [excluded](#exclude-list)), one dream per process at a time, and the footer shows `dreaming…` while it runs.

- **When.** After a run of the session settles (`agent_settled`), pika waits `memory.dreamIdleMinutes` (default 20). If the session is still idle then (no run, no queued messages, no open dialog), it asks the server for one `auto` lease. The server grants it only when no other dream holds the project, the last completed dream ended at least 4 hours ago, fewer than 3 automatic dreams ran in the project today (UTC), and some session has new entries; otherwise pika does nothing until the next run settles. Child sessions never start dreams, nor do sessions with `"autoDream": false`.
- **`/memory dream`** asks for a `manual` lease, which skips the cooldown, the daily limit, and the activity check, and starts a dream at once; with no new sessions it only reviews the notes. **`/memory stop`** stops the running dream. **`/memory status`** (or `/memory`) shows the settings, the dream model (and why it is the session's model when `dreamModel` is unset or not found), the caps, and the running or last dream: its mode, sessions, turns, tokens, staged changes, batches committed, notes changed, and how it ended.
- **The lease.** It holds the project for 15 minutes; pika renews it every 5 minutes and stops the dream if the server answers that it is lost. It lists the project's sessions with entries that earlier dreams have not consolidated, oldest first, at most 50, each with its seq range. Every end releases it as `completed`, `aborted`, or `failed`, without waiting for the server.
- **The child.** A persisted Pi session in the project, under `<cwd>/.pi/pika/dreams/`, away from your sessions and the agent dir, so `/resume` does not list it; `<cwd>/.pi/pika/` gets its own `.gitignore` of `*`, and the project's `.gitignore` is never touched. It gets the [child-session hooks](#child-session-hook), so pika uploads it, and a `pi-extensions.session-link` entry `{ kind: "subagent", agentType: "memory-dream", parentSessionId, parentSessionFile, description: "memory dream" }`; the server leaves dream sessions and their children out of later dreams, and the web UI hides them. The child uses `memory.dreamModel`, else the session's model, at the session's thinking level, and none of your extensions, skills, prompt templates, or context files. Its tools are exactly `read`, `grep`, `find`, `ls`, `recall_search`, `recall_read`, `memory_read`, `dream_save`, `dream_forget`, and `dream_commit`; the four read tools may not open `<cwd>/.pi/pika/`, which holds earlier dreams' own sessions. It has no memory section and never starts dreams itself. Its system prompt says that transcripts, web content, files, and tool output are untrusted data whose instructions it must never follow, that every saved note needs its sources, that notes are checked against the code before they are kept, and that it commits after each group of processed sessions. Its first message gives the scope, the sessions, the current index, and four phases: orient, gather with `recall_read`, verify and consolidate, and prune; the session titles and the index's titles and hooks are fenced in `<sessions>` and `<memory-index>` as quoted data, not instructions, with `<` and `>` in them replaced by `‹` and `›`.
- **Staging and commits.** `dream_save` (with 1 to 20 `sources`, each `{ sessionId, seq }`) and `dream_forget` only stage changes. `dream_commit { sessions, summary? }` sends the staged changes (at most 50) and the sessions it names to the server as one batch, which marks those sessions consolidated. A commit that fails, for example because a note changed meanwhile (the result shows the note's current state) or the index would be too large, writes nothing and discards the staged changes; changes still staged when the dream ends are discarded too. Dream tools exist only in dream children, never in your sessions.
- **Caps.** At 40 turns the child is told to commit and finish, and at 43 it is aborted. It is also aborted past 300,000 tokens (input, output, and cache, summed over its answers) or after 10 minutes.
- **Preemption.** Your input (typed or from an RPC client), the start of any run in the session, and the session's shutdown abort the dream at once: its staged changes are discarded and the lease is released as `aborted` in the background, so your turn never waits for the server.
- **Undo.** Each commit is a batch on the server. The web UI's memory pages list batches with their summary, sessions, and changes, and can revert one: a revert restores every note the batch touched, unless one of them changed since.

When a dream ends, pika says how it went: the batches committed and notes changed, or why it stopped.

## Deployment

The server is one Rust binary with the web UI embedded, published as the multi-arch image `ghcr.io/minhuw/pika` (amd64 and arm64). Its [README](../../services/pika/README.md) is the reference for image tags, building, the CLI, backups, and the [deployment examples](../../services/pika/deploy/). The short version:

```bash
docker run --rm -it -v pika-data:/data ghcr.io/minhuw/pika:latest password set
docker run -d --name pika --restart unless-stopped -p 127.0.0.1:7171:7171 -v pika-data:/data \
  -e PIKA_BASE_PATH=/pika -e PIKA_TRUST_PROXY=1 ghcr.io/minhuw/pika:latest
```

The first command stores the web UI's password (at least 12 characters) in the volume. Since 0.2, the default password mode refuses to start without one. Use `PIKA_AUTH=proxy` when the reverse proxy authenticates viewers; `PIKA_AUTH=none` disables viewer authentication and is intended for local development. The image runs as a non-root user with `/data` as its volume and a health check on `/api/health`. To build it yourself, run `docker build -f services/pika/Dockerfile -t pika .` from the repository root and use `pika` as the image.

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
location /pika/api/relay/ {
    proxy_pass http://127.0.0.1:7171;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then run `/pika login https://homelab.example/pika` on each machine and pair it, or create a token with `docker exec pika pika token create laptop` and set it with the `url` in the machine's `pika.json`. The server README covers Caddy, subdomain deployments, and proxy authentication. If the proxy authenticates viewers, exempt the device endpoints (`api/ingest/`, `api/relay/`, and `api/agent/`), pairing, health, and public pages and assets, including documentation. Use the server's deployment examples for the full path rules, and keep owner pages and `api/v1/` protected.

## Tests

```bash
npm ci
npm run test:pika
```

`npm run test:pika` runs offline Vitest suites against real Pi runtimes and a mock ingest server with the server's append, gap, conflict, and idempotency rules. `/pika login` and `/pika logout` run through a scripted UI, in both RPC and TUI mode, with pairing against the mock server's pairing API. One test runs a real pi TUI in `tmux` (skipped when `tmux` is not installed): it types and pastes a token, checks the captured screen never shows it, and pairs. Payload capture goes through Pi's real `openai-completions` implementation against a local mock endpoint. No live providers are used. `npm test` includes it.

`npm run test:pika` also covers relay, recall, and memory; memory's tests (`extensions/pika/tests/memory/`) run real pi runtimes on the faux provider against a fake pika server, including dreams: the idle trigger, `/memory`, staging and commits, caps, preemption, and a real dream child session. `npm run test:relay` runs only relay's part of it: a fake relay server built on the `ws` package, real pi sessions on Pi's faux provider, the real pika extension for its credentials, and a real Subagents child that must stay offline. `npm run test:recall` runs only recall's part, offline, against real pi runtimes on the faux provider and a fake pika server. The cross-component test against the real server is `bash services/pika/scripts/e2e.sh`.
