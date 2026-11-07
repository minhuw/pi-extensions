# Development

Use Node.js **22.19.0 or newer**. Development dependencies target the **Pi 1.5.0 SDK**; the extensions retain runtime support for **Pi 1.3.0 or newer**. Run collection commands from the repository root:

```bash
npm ci
npm test
npm run typecheck
```

Install your checkout with `pi install "$PWD"` from the repository root. Pi loads TypeScript directly; `/reload` picks up edits. Reload Subagents only when no agents are running.

## Verify the changed behavior

Run the affected extension’s suite and the type checker first. For a Benchmark change:

```bash
npm run test:benchmark
npm run typecheck
```

Run the collection suite before handing off changes that cross extension boundaries. [AGENTS.md](../AGENTS.md#verification-commands) lists scoped checks; each [extension README](../README.md#extensions) explains its coverage. The default collection suite is offline. Impeccable's engine and browser checks are explicit opt-ins described in its [reference](../extensions/impeccable/README.md#checks-and-evidence).

Choose checks that exercise the behavior you changed. Loading a prompt and checking its expansion does not establish that a live model follows it; label those kinds of evidence separately. The [Code review guide](guides/code-review.md) explains cleanup, bug review, verification, and commit preparation.

## pika uses separate toolchains

The root `npm test` covers the pika **extension**, not the Rust service or React web UI. Use stable Rust **1.89 or newer**, locked Cargo dependencies, and a shared target directory for service work:

```bash
CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo test --locked --manifest-path services/pika/Cargo.toml
```

Build and test the web UI from a full repository checkout:

```bash
cd services/pika/web
npm ci
npm test
npm run build
```

The web build reads repository Markdown, so copying only `services/pika/web` is insufficient. It writes `services/pika/web/dist`. Back at the repository root, build the release binary after the web build:

```bash
CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo build --release --locked --manifest-path services/pika/Cargo.toml
```

Release builds embed `web/dist` in the pika binary. Debug builds and Rust tests can run without it and serve a placeholder when no UI build exists. For the local API, Vite server, and end-to-end checks, follow [pika development](../services/pika/README.md#development).

## Keep documentation with code

Update the owning extension's README when changing its commands, defaults, or behavior. Update these guides when the recommended workflow across extensions changes. The site publishes an explicit list of sources: the root README, the 16 top-level extension READMEs, the pika service README, and these six installation, configuration, development, and workflow guides. Other Markdown is not published automatically.

Use one H1 per page and repository-relative Markdown links. Those links work on GitHub; the docs build rewrites links between published pages for the site. Link to canonical reference pages instead of copying their complete command tables. To publish a new page, add it to the build’s source list and navigation.

Run the web build after content changes and inspect the public `/docs` pages through pika (or `/pika/docs` when the base path is `/pika`). Documentation ships in the same `web/dist` and binary as the rest of pika; there is no separate documentation server or database. Container builds need the repository root as their context:

```bash
docker build -f services/pika/Dockerfile -t pika .
```

See [pika's Docker instructions](../services/pika/README.md#docker) for runtime configuration.
