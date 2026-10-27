# pika server

`pika` is one Rust binary that stores every Pi trajectory from your machines and serves it back. It takes uploads from the [pika extension](../../extensions/pika/README.md), keeps each session line verbatim in SQLite, stores large content and request blocks once in a compressed blob store, and serves a read API and an embedded web UI: a filtered session list, session views with per-tool rendering, inline subagents and the exact request each model call received, Herder run views, and full-text search. It also relays messages between running Pi sessions on any of your machines (see [Relay](#relay)).

It is built for one user in a homelab: plain HTTP, meant to sit behind a reverse proxy that terminates TLS. Devices authenticate with per-device tokens, which they get by pairing with the web UI. The UI is protected by one password with server-side sessions, or by the reverse proxy; the server refuses to start until one of them is set up.

## Build

Requirements: stable Rust 1.89 or newer (the locked dependencies need it) and Node 22 for the web UI. SQLite and zstd are compiled in; there are no system library dependencies.

```bash
cd services/pika
(cd web && npm ci && npm run build)   # writes web/dist
cargo build --release --locked        # embeds web/dist
./target/release/pika --help
```

Build the web UI first: release builds embed `web/dist` at compile time. Without it the binary still builds and runs, but serves a placeholder page instead of the UI. Debug builds read `web/dist` from disk at run time, so `cargo run` picks up a fresh `npm run build` without recompiling.

## CLI

```text
pika [--data-dir DIR] <command>

pika serve [--bind ADDR] [--base-path PATH] [--auth password|proxy|none] [--password-file FILE]
           [--password PASSWORD] [--cookie-secure auto|always|never] [--trust-proxy] [--max-body SIZE]
           [--relay on|off]
pika password set
pika password clear
pika token create <name>
pika token list
pika token revoke <device>
pika token rename <device> <name>
pika reindex
pika export <sessionId>
```

| Command | What it does |
| --- | --- |
| `serve` | Serves ingest, pairing, the read API, and the web UI. Stops cleanly on Ctrl-C or SIGTERM. In `password` mode (the default) it exits with status 2 when no password is configured. |
| `password set` | Stores a new UI password (at least 12 characters) as an argon2id hash and signs every browser out. Reads it twice without echo from the terminal, or once from stdin. |
| `password clear` | Removes the stored password and signs every browser out. |
| `token create <name>` | Creates a new device named `<name>` and prints its token once on stdout; stderr says `created device <id> (<name>)`. Only the token's SHA-256 is stored. A name is any text of 1–64 characters without control characters (quote it in the shell); names need not be unique. The device gets a new random id. Pairing (see [First run](#first-run)) is the easier way to add a machine. |
| `token list` | Lists devices with a token, tab-separated: id, name, creation time, how the token was made (`cli` or `pairing`), last upload (`never`), and the host it came from (`-`), sorted by name. |
| `token revoke <device>` | Revokes a device's token at once and prints `revoked <name> (<id>)`. Its uploaded data, name, and id stay. |
| `token rename <device> <name>` | Renames a device, with or without a token, and prints `renamed <id> to <name>`. Its id, and everything recorded under it, stay. |
| `reindex` | Rebuilds every derived table (sessions, entries, turns, model and tool calls, links, Herder runs, search index) from the stored verbatim lines. |
| `export <sessionId>` | Writes a session's JSONL to stdout, byte-identical to the original file. |

`<device>` is a device id, or a name that exactly one device has; when several share it, the command fails and lists their ids, so use one of those. `revoke` considers only devices that have a token.

Every command opens the data directory and creates it if needed. `password`, `token`, `reindex`, and `export` can run while the server is running; a new stored password and revoked tokens apply at once.

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--data-dir` | `PIKA_DATA_DIR` | `./pika-data` | Directory holding `pika.db` and `blobs/`. Accepted by every command. |
| `--bind` | `PIKA_BIND` | `127.0.0.1:7171` | Listen address of `serve`. |
| `--base-path` | `PIKA_BASE_PATH` | `/` | Path prefix for every route, such as `/pika`. `pika/`, `/pika/`, and `/pika` are equivalent. |
| `--auth` | `PIKA_AUTH` | `password` | Who authenticates viewers of the UI and read API: `password` (pika's login), `proxy` (the reverse proxy; see [Reverse proxy](#reverse-proxy)), or `none` (nobody; for local development). `proxy` and `none` log a warning at startup. |
| `--password-file` | `PIKA_PASSWORD_FILE` | none | Reads the password from this file, without one trailing newline. Wins over `--password` and the stored password; suits Docker secrets. |
| `--password` | `PIKA_PASSWORD` | none | The password. Wins over the stored one. Empty means unset. |
| `--cookie-secure` | `PIKA_COOKIE_SECURE` | `auto` | When the session cookie is `Secure`: `auto` when a trusted proxy reports HTTPS, `always`, or `never`. |
| `--trust-proxy` | `PIKA_TRUST_PROXY` | off | Takes the client address from the rightmost `X-Forwarded-For` entry and HTTPS from `X-Forwarded-Proto`. Turn it on behind a reverse proxy, and only then: without a proxy, clients could pick their own address. `1`, `true`, `yes`, or `on` turn it on; `0`, `false`, `no`, `off`, or empty leave it off; any other value stops `serve` with an error. |
| `--max-body` | `PIKA_MAX_BODY` | `32MiB` | Largest ingest body, both as sent and after gzip decompression. Accepts bytes or `K`/`KiB`, `M`/`MiB`, `G`/`GiB` (all binary). |
| `--relay` | `PIKA_RELAY` | `on` | Relay between Pi sessions (see [Relay](#relay)): `on` or `off`, with the same spellings as `--trust-proxy`, except that empty means `on`. When `off`, every relay route answers 404 `{ "error": "relay_disabled" }`. |

Flags win over environment variables. `PIKA_DEBUG=1` turns on debug logging. In `password` mode the password comes from `--password-file`, else `--password`, else `pika password set`; the server logs when a configured password overrides a stored one. Prefer `pika password set` or a password file over `--password` and `PIKA_PASSWORD`, which other users can see in the process list or the container's configuration.

### Routes

Every route is under the base path:

- `GET api/health` returns `{ "ok": true, "version", "basePath", "features", "revision" }`, without authentication. `features` lists `"relay"` when relay is on; `revision` is the commit the server was built from, which the published images record and a plain `cargo build` leaves out (set `PIKA_REVISION` to record one).
- `POST api/ingest/v1/batch` takes uploads from devices with `Authorization: Bearer <token>`.
- `POST api/pair/v1/start` and `poll` let a device ask for a token, without authentication; you approve it in the UI. `POST api/pair/v1/bind` lets a device with a token register its device key.
- `GET api/relay/v1/connect` (a WebSocket) and `GET api/relay/v1/sessions` are the relay's device routes, with `Authorization: Bearer <token>`.
- `api/v1/*` is the read API used by the UI, plus login, browser sessions (`auth/sessions`), devices, pairing approval, and the relay dashboard (`relay/sessions`, `relay/messages`, `relay/events`).
- Every other path serves the UI. The server injects `<meta name="pika-base">` into `index.html`, so one build works under any base path.

The protocol and the read API are specified in [`docs/SPEC.md`](docs/SPEC.md).

### First run

1. Set a password for the UI, on the machine that keeps the data, and start the server:

   ```bash
   PIKA_DATA_DIR=/srv/pika pika password set     # asks twice, at least 12 characters
   PIKA_DATA_DIR=/srv/pika pika serve
   ```

   Instead of `password set`, you can point `PIKA_PASSWORD_FILE` at a file holding the password (a Docker secret, for example; see [Docker](#docker)). If your reverse proxy authenticates every request, start with `PIKA_AUTH=proxy` and no password (see [Reverse proxy](#reverse-proxy)). Without any of these, `pika serve` refuses to start and says so.

2. Add each machine by pairing. In pi on that machine, run `/pika login`, enter the public URL including the base path, and choose **Pair with the pika web UI**. pi shows a code such as `K7PM-2QXD` and a link to the UI's Devices page (`<url>/devices?pair=<code>`); open it, log in, check the code, and approve. pi receives its token within a few seconds and uploads start right away. The code is valid for 10 minutes. `/pika logout` removes the token again.

   Logging in again from the same pi install continues the same device: pika recognizes it by its current token or by its device key (a random key the extension keeps in `<agentDir>/pika/device-key.json`; the server stores only its hash), and the approval card offers to continue it, which keeps its history together and makes its old token stop working. You can choose a new device instead, or continue any other device.

   Alternatively, create a token on the server and paste it at the **Paste a token** prompt of `/pika login`, or write it into `~/.pi/agent/pika.json` by hand and start a new pi session. The token is printed once:

   ```bash
   PIKA_DATA_DIR=/srv/pika pika token create "Ana's laptop"
   ```

   ```json
   { "url": "https://homelab.example/pika", "token": "pika_…" }
   ```

   `/pika` in pi shows whether uploads work. See the [extension README](../../extensions/pika/README.md#configuration) for every field, `PIKA_URL`/`PIKA_TOKEN`/`PIKA_DISABLED`, and the exclude list.

### Logins, sessions, and devices

- **Sessions:** logging in creates a server-side session that lasts 30 days. The browser holds only a random id in the `pika_session` cookie (HttpOnly, `SameSite=Lax`, scoped to the base path); the database keeps its SHA-256. The UI lists the browsers that are logged in, signs out one of them, or signs out everywhere. Logging out ends the session on the server, so a copied cookie stops working too. Changing the password, with `pika password set` or by starting with a different `PIKA_PASSWORD`/`PIKA_PASSWORD_FILE`, signs every browser out.
- **`Secure` cookies:** with the default `--cookie-secure auto`, the cookie is `Secure` when a trusted proxy (`PIKA_TRUST_PROXY=1`) reports `X-Forwarded-Proto: https`. Set `PIKA_COOKIE_SECURE=always` if the proxy does not send that header; `never` is for plain-HTTP setups.
- **Rate limits:** after 5 failed logins from one client address in 15 minutes, that address gets `429 Too Many Requests` with `Retry-After` until the oldest failure is 15 minutes old; a successful login clears its count. After 100 failed logins in an hour from all addresses together, every login is refused until the hour frees up. Pairing allows 5 starts per address in 10 minutes and 10 pending pairings at a time. An IPv6 client counts by its /64, since one client usually holds a whole /64. The counts live in memory and reset when the server restarts. Behind a reverse proxy, set `PIKA_TRUST_PROXY=1`, or every client shares the proxy's address and its limits.
- **If logins are blocked:** because of the global limit, anyone who can reach the login page can block new logins for up to an hour by sending wrong passwords from many addresses. Browsers that are already logged in keep working, and devices keep uploading. To get back in, use a browser that is still logged in, or restart pika (`docker restart pika`, or stop and start `pika serve`), which clears every limit. Then block the offending addresses at the reverse proxy, or put an authenticating proxy in front with `PIKA_AUTH=proxy` if it keeps happening.
- **Devices:** each device has an id, which never changes and keys everything it uploaded, and a name, a free label of up to 64 characters that you can change at any time; two devices may share a name. The UI's Devices page lists each device with its name and id, how its token was made, when it last uploaded, and from which host (updated at most once a minute), renames devices, and revokes tokens; ingest refuses a revoked token at once, and the device's relay connections close at once. A revoked device keeps its name and history, and a later pairing can continue it. `pika token list`, `pika token rename`, and `pika token revoke` do the same from the command line; a running server notices a token revoked by `pika token revoke` within one relay heartbeat (20 s) and closes that device's relay connections then.

### Relay

Relay lets a running Pi session send a text message to any other running Pi session on any machine logged into this server, and the UI's **Active sessions** page lists every online session and lets you message one. The [relay extension](../../extensions/relay/) connects each top-level Pi session over a WebSocket, using the pika extension's existing device token; there is no separate key or login. The protocol is specified in [`docs/RELAY.md`](docs/RELAY.md).

- **Open by default:** relay is on unless you start the server with `PIKA_RELAY=off`. Any device token may connect, so **a device token now also lets that device see and message every online session**, not only upload. Revoke a device to cut it off; its relay connections close at once.
- **Messages:** up to 32 KiB of text each, kept in memory until the target session accepts them or 5 minutes pass; a server restart drops queued messages and the dashboard's recent messages. Session transcripts, which pika already stores, are the permanent record. Each sending session may send 60 messages a minute, and the server keeps at most 100 queued messages per target and 10,000 in total.
- **Turning it off:** set `PIKA_RELAY=off` (or `--relay off`) and restart the server. Health then omits `"relay"` from `features`, so extensions stay offline and the UI hides the page.
- **Behind a proxy:** `/api/relay/` must stay open to devices and needs WebSocket upgrades (see [Reverse proxy](#reverse-proxy)).

`PIKA_RELAY_TTL_SECS` and `PIKA_RELAY_HEARTBEAT_SECS` shorten the message lifetime and the heartbeat. They exist for tests and the end-to-end script only; do not set them in production.

### Upgrading from 0.3

- Existing devices keep their names as their ids, so their history, filters, and relay ownership are unchanged. Names are now separate, editable labels: rename a device on the Devices page or with `pika token rename`. Devices known only from their uploads (their token is gone) get a row too, so a pairing can continue them.
- The database migrates when the server opens it, without a reindex. The migration is one-way: a 0.3 binary refuses the migrated database (`database schema version 5 is newer than this pika (4)`), so to go back to 0.3, restore a [backup](#backup) taken before upgrading.
- Older pika extensions still pair and upload as before. Their pairing requests carry neither a device key nor the current token, so pika does not recognize them: to keep a re-paired machine's history together, choose its device under "Continue an existing device instead" on the approval card. Names with spaces or other characters outside `[A-Za-z0-9._-]` need the new extension, since older ones check names themselves.
- Pairing approval no longer has a **replace** option: continuing an existing device takes its place, and its old token stops working when the device collects the new one.

### Upgrading from 0.2

- [Relay](#relay) is new and on by default: every device token can now also message every online Pi session. Set `PIKA_RELAY=off` to keep 0.2's behavior.
- Behind nginx, add the `api/relay/` location from the [`deploy/`](deploy/) examples, which passes WebSocket upgrades. If the proxy authenticates, also leave `/api/relay/` open.

### Upgrading from 0.1

- A password is now required unless `PIKA_AUTH` says otherwise. A 0.1 server that ran without `PIKA_PASSWORD` stops at startup with exit status 2: run `pika password set`, set `PIKA_PASSWORD_FILE` or `PIKA_PASSWORD`, or set `PIKA_AUTH=proxy` if the reverse proxy authenticates (`PIKA_AUTH=none` keeps the server open).
- Logins moved to server-side sessions, and the old `pika_auth` cookie is no longer accepted: everyone logs in again once.
- Existing device tokens keep working; `pika token list` shows them as made by `cli`. The database migrates when the server opens it, without a reindex.
- Behind a reverse proxy, set `PIKA_TRUST_PROXY=1` and forward `X-Forwarded-For` and `X-Forwarded-Proto` (see [Reverse proxy](#reverse-proxy)); if the proxy authenticates, also leave `/api/pair/` open.

## Data

```text
<data-dir>/
├── pika.db          SQLite in WAL mode (with pika.db-wal and pika.db-shm while open)
└── blobs/
    └── ab/cd/abcd….zst   zstd-compressed content-addressed blobs, named by SHA-256
```

`pika.db` is the source of truth. It holds every stream's verbatim lines (lines over 1 MiB live in the blob store, referenced by hash), the uploaded requests with their block lists, Herder goal and plan documents, device token hashes, the password hash, browser session and pairing records (only hashes of their secrets), an argon2id hash of a password from `PIKA_PASSWORD`/`PIKA_PASSWORD_FILE` (to notice when it changes), and a random database key that fingerprints the stored hash. The typed tables (sessions, models, links, entries, turns, model and tool calls, Herder runs, events, and steps, and the search index) are derived from the verbatim lines. The blob store holds request blocks and oversized lines; each is written once, and blobs are never modified or deleted.

### Backup

Back up the database online, then the blobs:

```bash
sqlite3 /srv/pika/pika.db ".backup '/backups/pika/pika.db'"
rsync -a /srv/pika/blobs/ /backups/pika/blobs/
```

Copy in that order: blobs are never deleted, so a blob copy taken after the database snapshot contains every blob the snapshot references. Do not copy `pika.db` with `cp` while the server runs; use `.backup` or stop the server first. The Docker image has no `sqlite3`, so with Docker either bind-mount the data directory and run the commands on the host, or stop the container and copy the volume.

### Restore

1. Stop the server.
2. Put the backed-up `pika.db` and `blobs/` into the data directory, and delete any `pika.db-wal` and `pika.db-shm` left by the old database.
3. Start the server.

Devices that uploaded after the backup get a gap answer and resend from the server's length, as long as the session or journal file still exists on the device and pika still tracks it (an open stream, or one that is resumed later). Model requests already removed from a device's spool are not resent.

### Reindex

```bash
pika reindex
```

`pika reindex` rebuilds every derived table from the verbatim lines in one transaction; the read API returns the same output before and after. The server also reindexes on its own when it starts after a schema upgrade. Uploads wait while `reindex` holds the write lock and fail after 10 s, and devices retry them, so on a large database stop the server first or expect a short pause in ingest.

## Docker

### Prebuilt image

The [`pika image`](../../.github/workflows/pika-image.yml) workflow publishes a multi-arch image (`linux/amd64` and `linux/arm64`, each built natively and smoke-tested) to `ghcr.io/minhuw/pika`:

| Tag | Source |
| --- | --- |
| `latest`, `0.4.0`, `0.4` | a `pika-v0.4.0` release tag |
| `edge` | the newest `master` commit that changed `services/pika/` |
| `sha-<commit>` | that commit |

Prefer a version tag in production and `edge` to follow `master`.

To release, set `version` in `Cargo.toml`, commit, then push a matching tag; the workflow refuses a tag that disagrees with `Cargo.toml`:

```bash
git tag pika-v0.4.0 && git push origin pika-v0.4.0
```

Published from this public repository, the package is public, so servers pull it without logging in. A fork or a private copy of the repository may publish it as private; then make it public under the package's **Package settings → Change visibility**, or log in on the server with `docker login ghcr.io` and a token that has `read:packages`.

### Running it

Set the password once in the volume, then start the server behind your proxy:

```bash
docker run --rm -it -v pika-data:/data ghcr.io/minhuw/pika:latest password set

docker run -d --name pika --restart unless-stopped \
  -p 127.0.0.1:7171:7171 \
  -v pika-data:/data \
  -e PIKA_BASE_PATH=/pika \
  -e PIKA_TRUST_PROXY=1 \
  ghcr.io/minhuw/pika:latest

docker exec pika pika token list
```

Instead of `password set`, mount the password as a file, such as a Docker or Compose secret, and point `PIKA_PASSWORD_FILE` at it (`-v /srv/secrets/pika-password:/run/secrets/pika_password:ro -e PIKA_PASSWORD_FILE=/run/secrets/pika_password`; the file must be readable by uid 10001). [`deploy/compose.yaml`](deploy/compose.yaml) does this with a Compose secret. With `-e PIKA_AUTH=proxy` the proxy authenticates instead. Without a password or `PIKA_AUTH`, the container exits at once and `docker logs pika` says why.

To upgrade, `docker pull` the tag and recreate the container with the same volume; the server migrates the database when it opens it. Coming from 0.1, read [Upgrading from 0.1](#upgrading-from-01) first.

The bottom of the UI's sidebar shows the version and commit the server runs, such as `pika 0.3.0 (a1b2c3d)`; `docker exec pika pika --version` and `curl …/api/health` say the same. `edge` keeps the version of the last release, so compare the commit with the latest one on `master` to tell whether it is up to date.

### Building it yourself

The [`Dockerfile`](Dockerfile) builds the web UI on `node:22-bookworm-slim`, builds the binary on `rust:1-bookworm` with `cargo build --release --locked` (embedding the UI), and runs it on `debian:bookworm-slim` as the non-root user `pika` (uid 10001). The build context is `services/pika/`:

```bash
docker build -t pika services/pika
```

Then use `pika` in place of `ghcr.io/minhuw/pika:latest` in the commands here.

### Configuration

The image sets `PIKA_BIND=0.0.0.0:7171`, `PIKA_DATA_DIR=/data`, and `PIKA_BASE_PATH=/`, declares `/data` as a volume, and exposes 7171. Its entrypoint is `pika` and its default command is `serve`, so `docker run … ghcr.io/minhuw/pika:latest token list` runs any other command against the same volume. Pass `PIKA_AUTH`, `PIKA_PASSWORD_FILE`, `PIKA_TRUST_PROXY`, `PIKA_COOKIE_SECURE`, `PIKA_MAX_BODY`, `PIKA_RELAY`, or `PIKA_BASE_PATH` with `-e`. The image keeps the default `PIKA_TRUST_PROXY` (off); turn it on when the published port is reachable only by your proxy, as with `-p 127.0.0.1:7171:7171`.

The `HEALTHCHECK` requests `http://127.0.0.1:<port from PIKA_BIND><PIKA_BASE_PATH>/api/health` with `curl` every 30 s, normalizing the base path as the server does (`pika`, `pika/`, and `/pika/` all mean `/pika`). It reads only the environment, so set the base path and bind address with `-e PIKA_BASE_PATH` and `-e PIKA_BIND`, not as `serve --base-path` or `--bind` arguments: with a flag the server moves but the health check does not, and the container stays unhealthy. `docker ps` shows the result, and you can check it by hand:

```bash
curl -fsS http://127.0.0.1:7171/pika/api/health
```

To keep the data in a host directory instead of a named volume, make it writable by uid 10001:

```bash
sudo install -d -o 10001 -g 10001 /srv/pika
docker run --rm -it -v /srv/pika:/data ghcr.io/minhuw/pika:latest password set
docker run -d --name pika -p 127.0.0.1:7171:7171 -v /srv/pika:/data -e PIKA_BASE_PATH=/pika -e PIKA_TRUST_PROXY=1 \
  ghcr.io/minhuw/pika:latest
```

[`deploy/compose.yaml`](deploy/compose.yaml) is the same setup for Docker Compose.

## Reverse proxy

pika speaks plain HTTP and expects a reverse proxy in front of it for TLS. The examples in [`deploy/`](deploy/) are complete configurations; replace the host names and certificate paths.

| File | Serves pika at | Run the server with |
| --- | --- | --- |
| [`deploy/Caddyfile.subdomain`](deploy/Caddyfile.subdomain) | `https://pika.example.com/` | default base path `/` |
| [`deploy/Caddyfile.path`](deploy/Caddyfile.path) | `https://homelab.example/pika/` | `--base-path /pika` |
| [`deploy/nginx-subdomain.conf`](deploy/nginx-subdomain.conf) | `https://pika.example.com/` | default base path `/` |
| [`deploy/nginx-path.conf`](deploy/nginx-path.conf) | `https://homelab.example/pika/` | `--base-path /pika` |

Every example:

- forwards the path unchanged. pika strips its base path itself, so do not use Caddy's `handle_path` or an nginx `proxy_pass` with a URI part;
- allows request bodies of at least the server's `--max-body` (32 MiB by default) with `request_body max_size` or `client_max_body_size`; raise both together;
- allows slow uploads: devices send gzip batches of up to 8 MiB uncompressed and give up on a batch after 30 s, then retry;
- forwards `X-Forwarded-For` and `X-Forwarded-Proto`, so that with `PIKA_TRUST_PROXY=1` pika sees each client's address (for the login and pairing limits and the session list) and marks cookies `Secure` over HTTPS. Caddy sends both headers by default; nginx needs the two `proxy_set_header` lines;
- passes WebSocket upgrades on `api/relay/`, for [Relay](#relay). Caddy does this as is. nginx needs a `location` for it with `proxy_http_version 1.1` and the `Upgrade` and `Connection` headers; because a `location` with its own `proxy_set_header` inherits none from the enclosing block, that location repeats `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`. The default 120 s read timeout is enough, since the server sends a heartbeat every 20 s;
- with a path prefix, redirects `/pika` to `/pika/`, because the UI loads its assets by relative URL.

Run pika behind a proxy with `PIKA_TRUST_PROXY=1`, and keep its port reachable only by the proxy (the examples bind it to `127.0.0.1`): when trusted, `X-Forwarded-For` decides the client address, and a client that reaches pika directly could set it.

A path-prefix site in nginx, for example:

```nginx
location = /pika { return 301 /pika/; }
location /pika/ {
    client_max_body_size 32m;
    client_body_timeout 120s;
    proxy_pass http://127.0.0.1:7171;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
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

and in Caddy:

```caddy
homelab.example {
	redir /pika /pika/
	handle /pika/* {
		request_body {
			max_size 32MiB
		}
		reverse_proxy 127.0.0.1:7171
	}
}
```

The proxy may handle authentication instead of the built-in password: basic auth, or forward auth with Authelia, Authentik, or a VPN. Then start pika with `PIKA_AUTH=proxy`, and exempt four paths from the proxy's login (for example `/pika/api/ingest/`): `api/ingest/` and `api/relay/`, because devices send their own `Authorization: Bearer` token there; `api/pair/`, because a device pairing with the server has no login yet; and `api/health`, for monitoring. Everything else, the UI and `api/v1/` included, must go through the proxy's login: with `PIKA_AUTH=proxy`, pika itself lets every request in. The examples include commented-out basic-auth lines that do this. Set the devices' `url` to the `https://` address: pika does not follow redirects, so an `http://` URL that the proxy redirects never uploads.

## Development

```bash
cd services/pika
cargo test --locked          # no web build needed; the UI routes serve the placeholder
```

The `service-tests` check uses a shared target directory: `CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo test --locked --manifest-path services/pika/Cargo.toml`.

The web UI is React, Vite, TypeScript, and Tailwind in [`web/`](web/):

```bash
PIKA_AUTH=none cargo run -- serve     # API on 127.0.0.1:7171, base path /, no login
cd web && npm ci && npm run dev       # Vite dev server; proxies /api to 127.0.0.1:7171
npm test                              # Vitest + jsdom
npm run build                         # type-check, then write web/dist
```

The dev server proxies `/api` to the server at `127.0.0.1:7171`, so run that server with the default base path `/`.

End-to-end and performance checks run from the repository root:

```bash
bash services/pika/scripts/e2e.sh     # real server, pi with the extension, and the UI in local Chrome
bash services/pika/scripts/perf.sh    # one year of generated data from five machines; latency targets (PIKA_AUTH=none)
```

Neither calls a live provider or downloads a browser; the UI checks use a locally installed Chrome.

`e2e.sh` installs and builds everything (`npm ci` at the root, in `web/`, and in `e2e/`, the web build, and the release binary), checks that the binary refuses to start without a password (status 2), serves it under `/pika` with a password, and runs [`e2e/driver.ts`](e2e/driver.ts): a real pi runtime with Subagents, Herder, and pika, pika last, against a mock OpenAI-compatible provider. It checks that every entry of the main, subagent, and Herder step sessions reaches the read API within 5 s and exports byte for byte, that every stored request equals the body the provider received (or the pi context, for a provider without a payload), the links to the Agent call and the Herder step, delivery after a server outage and a pi restart with no duplicate requests, and then drives the UI in Chrome, including a 5,000-entry session, in the light and dark themes. Then a second machine with its own agent dir runs `/pika login` and chooses pairing while the browser opens `/devices?pair=<code>`, denies the first request and approves the second; the machine saves the token with mode 0600 and uploads as the paired device. Revoking that device on the Devices page makes ingest refuse its token and `/pika` report the 401; signing out and signing out everywhere retire the session cookies; and, last, because every client shares 127.0.0.1, five wrong passwords on the login page lead to its "Too many attempts" message. Only those deliberate 401 and 429 answers are allowed; any other console error, page error, or failed request fails the run. It prints the directory with the screenshots. `PIKA_CHROME` selects the browser binary, `PIKA_E2E_SKIP_BUILD=1` reuses earlier installs and builds, and `PIKA_E2E_KEEP=1` keeps the temporary workspace and server data.

The ingest protocol, request blocks, link entries, child-session hook, read API, and configuration are specified in [`docs/SPEC.md`](docs/SPEC.md).
