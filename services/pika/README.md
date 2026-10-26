# pika server

`pika` is one Rust binary that stores every Pi trajectory from your machines and serves it back. It takes uploads from the [pika extension](../../extensions/pika/README.md), keeps each session line verbatim in SQLite, stores large content and request blocks once in a compressed blob store, and serves a read API and an embedded web UI: a filtered session list, session views with per-tool rendering, inline subagents and the exact request each model call received, Herder run views, and full-text search.

It is built for one user in a homelab: plain HTTP, meant to sit behind a reverse proxy that terminates TLS. Devices authenticate with per-device tokens; the UI is open or protected by one optional password.

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

pika serve [--bind ADDR] [--base-path PATH] [--password PASSWORD] [--max-body SIZE]
pika token create <device>
pika token list
pika token revoke <device>
pika reindex
pika export <sessionId>
```

| Command | What it does |
| --- | --- |
| `serve` | Serves ingest, the read API, and the web UI. Stops cleanly on Ctrl-C or SIGTERM. |
| `token create <device>` | Creates a token for a device and prints it once. Only its SHA-256 is stored. Device names use 1–64 characters from `[A-Za-z0-9._-]`; an existing name must be revoked first. |
| `token list` | Lists devices with tokens and their creation times. |
| `token revoke <device>` | Revokes a device's token at once. Its uploaded data stays. |
| `reindex` | Rebuilds every derived table (sessions, entries, turns, model and tool calls, links, Herder runs, search index) from the stored verbatim lines. |
| `export <sessionId>` | Writes a session's JSONL to stdout, byte-identical to the original file. |

Every command opens the data directory and creates it if needed. `token`, `reindex`, and `export` can run while the server is running.

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--data-dir` | `PIKA_DATA_DIR` | `./pika-data` | Directory holding `pika.db` and `blobs/`. Accepted by every command. |
| `--bind` | `PIKA_BIND` | `127.0.0.1:7171` | Listen address of `serve`. |
| `--base-path` | `PIKA_BASE_PATH` | `/` | Path prefix for every route, such as `/pika`. `pika/`, `/pika/`, and `/pika` are equivalent. |
| `--password` | `PIKA_PASSWORD` | none | Requires a login for the read API. Empty means no password. |
| `--max-body` | `PIKA_MAX_BODY` | `32MiB` | Largest ingest body, both as sent and after gzip decompression. Accepts bytes or `K`/`KiB`, `M`/`MiB`, `G`/`GiB` (all binary). |

Flags win over environment variables. `PIKA_DEBUG=1` turns on debug logging. Prefer `PIKA_PASSWORD` over `--password`, which other users can see in the process list.

### Routes

Every route is under the base path:

- `GET api/health` returns `{ "ok": true, "version", "basePath" }`, without authentication.
- `POST api/ingest/v1/batch` takes uploads from devices with `Authorization: Bearer <token>`.
- `api/v1/*` is the read API used by the UI.
- Every other path serves the UI. The server injects `<meta name="pika-base">` into `index.html`, so one build works under any base path.

The protocol and the read API are specified in [`docs/SPEC.md`](docs/SPEC.md).

### First run

1. Start the server, on the machine that keeps the data:

   ```bash
   PIKA_DATA_DIR=/srv/pika PIKA_PASSWORD='choose-one' pika serve
   ```

   Pick one way to protect the UI. With `PIKA_PASSWORD`, the UI shows a login page, and every `api/v1` route except `login` and `me` needs the login cookie (`pika_auth`: HttpOnly, `SameSite=Lax`, scoped to the base path, valid for 30 days). Changing the password logs every browser out. Alternatively, leave the password unset and let the reverse proxy authenticate (see [Reverse proxy](#reverse-proxy)), or keep the server on a private network. There is no rate limiting on login, so prefer the proxy when the server is reachable from the internet.

2. Create one token per machine. The token is printed once:

   ```bash
   PIKA_DATA_DIR=/srv/pika pika token create laptop
   PIKA_DATA_DIR=/srv/pika pika token create desktop
   ```

3. On each machine, run `/pika login` in pi and enter the public URL including the base path, then that machine's token. pika checks the token against the server before saving it, and uploads start right away; `/pika logout` removes it again. Alternatively, write `~/.pi/agent/pika.json` by hand and start a new pi session:

   ```json
   { "url": "https://homelab.example/pika", "token": "pika_…" }
   ```

   `/pika` in pi shows whether uploads work. See the [extension README](../../extensions/pika/README.md#configuration) for every field, `PIKA_URL`/`PIKA_TOKEN`/`PIKA_DISABLED`, and the exclude list.

## Data

```text
<data-dir>/
├── pika.db          SQLite in WAL mode (with pika.db-wal and pika.db-shm while open)
└── blobs/
    └── ab/cd/abcd….zst   zstd-compressed content-addressed blobs, named by SHA-256
```

`pika.db` is the source of truth. It holds every stream's verbatim lines (lines over 1 MiB live in the blob store, referenced by hash), the uploaded requests with their block lists, Herder goal and plan documents, device token hashes, and the cookie signing key. The typed tables (sessions, models, links, entries, turns, model and tool calls, Herder runs, events, and steps, and the search index) are derived from the verbatim lines. The blob store holds request blocks and oversized lines; each is written once, and blobs are never modified or deleted.

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
| `latest`, `0.1.0`, `0.1` | a `pika-v0.1.0` release tag |
| `edge` | the newest `master` commit that changed `services/pika/` |
| `sha-<commit>` | that commit |

Prefer a version tag in production and `edge` to follow `master`.

To release, set `version` in `Cargo.toml`, commit, then push a matching tag; the workflow refuses a tag that disagrees with `Cargo.toml`:

```bash
git tag pika-v0.1.0 && git push origin pika-v0.1.0
```

Published from this public repository, the package is public, so servers pull it without logging in. A fork or a private copy of the repository may publish it as private; then make it public under the package's **Package settings → Change visibility**, or log in on the server with `docker login ghcr.io` and a token that has `read:packages`.

### Running it

```bash
docker run -d --name pika --restart unless-stopped \
  -p 127.0.0.1:7171:7171 \
  -v pika-data:/data \
  -e PIKA_BASE_PATH=/pika \
  -e PIKA_PASSWORD='choose-one' \
  ghcr.io/minhuw/pika:latest

docker exec pika pika token create laptop
docker exec pika pika token list
```

To upgrade, `docker pull` the tag and recreate the container with the same volume; the server migrates the database when it opens it.

### Building it yourself

The [`Dockerfile`](Dockerfile) builds the web UI on `node:22-bookworm-slim`, builds the binary on `rust:1-bookworm` with `cargo build --release --locked` (embedding the UI), and runs it on `debian:bookworm-slim` as the non-root user `pika` (uid 10001). The build context is `services/pika/`:

```bash
docker build -t pika services/pika
```

Then use `pika` in place of `ghcr.io/minhuw/pika:latest` in the commands here.

### Configuration

The image sets `PIKA_BIND=0.0.0.0:7171`, `PIKA_DATA_DIR=/data`, and `PIKA_BASE_PATH=/`, declares `/data` as a volume, and exposes 7171. Its entrypoint is `pika` and its default command is `serve`, so `docker run … ghcr.io/minhuw/pika:latest token list` runs any other command against the same volume. Pass `PIKA_PASSWORD`, `PIKA_MAX_BODY`, or `PIKA_BASE_PATH` with `-e`.

The `HEALTHCHECK` requests `http://127.0.0.1:<port from PIKA_BIND><PIKA_BASE_PATH>/api/health` with `curl` every 30 s, normalizing the base path as the server does (`pika`, `pika/`, and `/pika/` all mean `/pika`). It reads only the environment, so set the base path and bind address with `-e PIKA_BASE_PATH` and `-e PIKA_BIND`, not as `serve --base-path` or `--bind` arguments: with a flag the server moves but the health check does not, and the container stays unhealthy. `docker ps` shows the result, and you can check it by hand:

```bash
curl -fsS http://127.0.0.1:7171/pika/api/health
```

To keep the data in a host directory instead of a named volume, make it writable by uid 10001:

```bash
sudo install -d -o 10001 -g 10001 /srv/pika
docker run -d --name pika -p 127.0.0.1:7171:7171 -v /srv/pika:/data -e PIKA_BASE_PATH=/pika ghcr.io/minhuw/pika:latest
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
- with a path prefix, redirects `/pika` to `/pika/`, because the UI loads its assets by relative URL.

A path-prefix site in nginx, for example:

```nginx
location = /pika { return 301 /pika/; }
location /pika/ {
    client_max_body_size 32m;
    client_body_timeout 120s;
    proxy_pass http://127.0.0.1:7171;
    proxy_set_header Host $host;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
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

The proxy may handle authentication instead of the built-in password: basic auth, or forward auth with Authelia, Authentik, or a VPN. Exempt `api/ingest/` (for example `/pika/api/ingest/`) from it, because devices send their own `Authorization: Bearer` token there and cannot answer a proxy login. The examples include commented-out basic-auth lines that do this. Set the devices' `url` to the `https://` address: pika does not follow redirects, so an `http://` URL that the proxy redirects never uploads.

## Development

```bash
cd services/pika
cargo test --locked          # no web build needed; the UI routes serve the placeholder
```

The `service-tests` check uses a shared target directory: `CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo test --locked --manifest-path services/pika/Cargo.toml`.

The web UI is React, Vite, TypeScript, and Tailwind in [`web/`](web/):

```bash
cargo run -- serve                    # API on 127.0.0.1:7171, base path /
cd web && npm ci && npm run dev       # Vite dev server; proxies /api to 127.0.0.1:7171
npm test                              # Vitest + jsdom
npm run build                         # type-check, then write web/dist
```

The dev server proxies `/api` to the server at `127.0.0.1:7171`, so run that server with the default base path `/`.

End-to-end and performance checks run from the repository root:

```bash
bash services/pika/scripts/e2e.sh     # real server, pi with the extension, and the UI in local Chrome
bash services/pika/scripts/perf.sh    # one year of generated data from five machines; latency targets
```

Neither calls a live provider or downloads a browser; the UI checks use a locally installed Chrome.

`e2e.sh` installs and builds everything (`npm ci` at the root, in `web/`, and in `e2e/`, the web build, and the release binary), serves the binary under `/pika` with a password, and runs [`e2e/driver.ts`](e2e/driver.ts): a real pi runtime with Subagents, Herder, and pika, pika last, against a mock OpenAI-compatible provider. It checks that every entry of the main, subagent, and Herder step sessions reaches the read API within 5 s and exports byte for byte, that every stored request equals the body the provider received (or the pi context, for a provider without a payload), the links to the Agent call and the Herder step, delivery after a server outage and a pi restart with no duplicate requests, and then drives the UI in Chrome, including a 5,000-entry session, in the light and dark themes. It prints the directory with the screenshots. `PIKA_CHROME` selects the browser binary, `PIKA_E2E_SKIP_BUILD=1` reuses earlier installs and builds, and `PIKA_E2E_KEEP=1` keeps the temporary workspace and server data.

The ingest protocol, request blocks, link entries, child-session hook, read API, and configuration are specified in [`docs/SPEC.md`](docs/SPEC.md).
