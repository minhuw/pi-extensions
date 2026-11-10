# Agent execution guide

## What this repo is

Extensions, prompts, skills, and a theme for the Pi coding agent, plus the self-hosted `pika` server.
See the root [README](README.md#extensions) for the overview, and read the target directory's `README.md` before modifying an extension or service.

## Layout

- `extensions/magpie-provider/` — Magpie gateway discovery, Pi API delegation, and native compaction (`native-compaction/`).
- `extensions/commit/` — `/commit` prompt template for self-contained patch series.
- `extensions/continue-session/` — `/continue-session <session ID> [instructions]` prompt template for continuing a pika-recorded session's work.
- `extensions/recap/` — `/recap [focus or time range]` session summary prompt template.
- `extensions/quality/` — `/simplify`, `/review`, `/verify`, and `/deslop` prompt templates.
- `extensions/writer/` — eight conference-paper writing prompt templates.
- `extensions/orca-bridge/` — Orca hooks, pane activity, titles, file/diff navigation, and `/orca-status` via released Orca interfaces.
- `extensions/autoresearch/` — `/autoresearch` optimization loop and reports (do not load with `npm:pi-autoresearch`).
- `extensions/benchmark/` — `core.ts` (shared measurement module; registers nothing with Pi and imports no extension; Autoresearch imports only `core.ts`), `benchmark_compare` (`index.ts`), and `/benchmark <what>` (`prompts/benchmark.md`).
- `extensions/loop/` — `/loop` recurring prompts (fixed, cron, model-paced) and `loop_schedule` / `loop_stop`.
- `extensions/molt/` — `/molt` new session keeping model and thinking level, and `/handoff` (model-written handover sent as the new session's first message, never written to disk).
- `extensions/language/` — `/language` default (`<agentDir>/language.json`), cache-safe mid-session switches, and footer status.
- `extensions/spokesman/` — `/spokesman` secondary communicator (`auto`/`always`, `/spokesman for` main-model filter, `<agentDir>/spokesman.json`), foldable original reply, and context replacement.
- `extensions/boom/` — `/boom` session-only subagent-first mode (never on by default), cache-safe mid-session switches, and status.
- `extensions/alwayson/` — `/alwayson` session-only mode (never on by default) that sends long tasks to background subagents so the session keeps answering relay messages; boom's cache-safe switches and status.
- `extensions/workspace/` — `.pi/workspaces/<name>`, `/tmp` allowance, `write`/`edit`/`bash` guards, `workspace` tool, and `/workspace`.
- `extensions/statusline-footer/` — theme-aware Pi statusline footer.
- `extensions/impeccable/` — vendored Impeccable 4.8.1 (`vendor/impeccable-4.8.1/`), 26 prompts, engine 0.1.19, `impeccable_*` tools, and `scripts/transform.mjs` (never hand-edit `skills/`, `prompts/`, or vendor files; see `LOCAL-PATCHES.md`).
- `extensions/agent-browser/` — `agent-browser` skill, `agent_browser` tool (`AGENT_BROWSER_SESSION`, inline screenshots), and `/agent-browser`.
- `extensions/subagents/` — vendored `pi-subagents` v0.23.1 (`Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent`), `recon`/`worker`, and hidden `council-*` advisors (`LOCAL-PATCHES.md`).
- `extensions/council/` — `/council` and `council` tool for two-round blinded deliberation across `argon`, `astra`, and `opus` (`agents/`).
- `extensions/herder/` — verified git-worktree runs (`<git-common-dir>/herder/`, `refs/herder/`, git >=2.38): `src/adapter/` (`herder_*`), `agents/`, and `skills/{herder,improve,simplify}/`.
- `extensions/pika/` — session/payload/child/Herder capture (`<agentDir>/pika/` spool), `/pika`, `project.ts` (`/pika project`, repository identity in the main checkout's git-ignored `.pi/pika/project.json`, which Herder's `repo` also reads), `credentials.ts` (`Symbol.for("pi-extensions.pika.credentials")`), `log-viewer.ts` (the overlay `/relay log` and `/memory log` share), `relay/` (`relay_*`, `/relay`), `recall/` (`recall_*`), and `memory/` (`memory_*`, pinned `pika-memory` section, `/memory log`, and `dream/`: dreaming in background child sessions with an idle trigger, `dream_*` staging tools, `pika-memory-dream` outcome entries, and `/memory`). Listed last in `pi.extensions`.
- `plugins/pika-relay/` — Codex desktop plugin (marketplace `.agents/plugins/marketplace.json`): `src/` (MCP server, hooks, per-user broker), committed `dist/` built by `scripts/build.mjs` from `src/` plus shared `extensions/pika/{config,repository}.ts` and `relay/{protocol,connection}.ts` (rebuild with `npm run build:codex-relay` after changing any of them), `hooks/`, and `skills/`.
- `services/pika/` — Rust server binary (ingest, auth, SQLite + zstd blobs, read API, `src/pricing.rs` with `PIKA_PRICES=off` offline), `web/` UI, `docs/{SPEC,RELAY}.md`, and `scripts/{e2e,perf}.sh`.
- `themes/` — `material-bloom` theme.

## Verification commands

Run from the repository root with Node `>=22.19.0` (SDK baseline Pi 1.5.0; peer compatibility Pi `>=1.3.0`).

| Command | Scope |
| --- | --- |
| `npm ci` / `npm run typecheck` / `npm test` | Install locked deps / strict `noEmit` TS check (collection + Subagents) / full offline collection suite. |
| `npm run test:orca-bridge`, `npm run test:magpie-provider`, `npm run test:commit`, `npm run test:continue-session`, `npm run test:quality` (`npm run test:simplify`), `npm run test:writer`, `npm run test:statusline`, `npm run test:benchmark`, `npm run test:autoresearch`, `npm run test:loop`, `npm run test:molt`, `npm run test:language`, `npm run test:spokesman`, `npm run test:boom`, `npm run test:alwayson`, `npm run test:workspace`, `npm run test:agent-browser`, `npm run test:herder`, `npm run test:subagents`, `npm run test:council`, `npm run test:pika`, `npm run test:relay`, `npm run test:recall`, `npm run test:codex-relay` | Offline suite for the named extension or subsystem (`test:codex-relay` also fails when `plugins/pika-relay/dist/` is stale). |
| `npm run test:impeccable:contracts`, `npm run test:impeccable`, `npm run test:impeccable:package` | Offline Impeccable contracts/hashes, runtime doubles, and tarball checks. |
| `npm run test:impeccable:engine`, `npm run test:impeccable:visual-foundations`, `npm run test:impeccable:e2e` | Explicit network/browser Impeccable gates (managed engine + Chromium, no paid calls). |
| `CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo test --locked --manifest-path services/pika/Cargo.toml` | pika Rust server unit and integration tests (no `web/dist` needed). |
| `cd services/pika/web && npm ci && npm test && npm run build` | pika web UI Vitest suite, typecheck, and `web/dist` build. |
| `bash services/pika/scripts/e2e.sh` / `bash services/pika/scripts/perf.sh` | Real server + Chrome + Pi RPC E2E suite / 1-year latency benchmark. |

## Conventions

- Use conventional commits with a scope (`fix(subagents): ...`, `test(extensions): ...`).
- TypeScript is strict (`noEmit`). Commit, Quality, and Writer tests use `node --test`; all other extension suites use Vitest.
- Keep `extensions/pika/index.ts` last in `package.json` `pi.extensions` so payload capture runs last.
- Cross-extension isolation: extensions never import each other (`plugins/pika-relay` copies its shared pika modules into `dist/shared/` at build time); share runtime hooks only via `Symbol.for("pi-extensions.child-session-hooks")`, `Symbol.for("pi-extensions.pika.credentials")`, `pi-extensions.session-link` entries, and `herder:run` events.
- Subagents workflows run only on explicit orchestration requests; use `isolation: "worktree"` when parallel writers conflict, and await writers before verification.
- Impeccable activation, `npm ci`, and default/scoped/package tests stay offline and never download the engine or browser. Regenerate `skills/` and `prompts/` via `scripts/transform.mjs`; never commit binaries, caches, or credentials.
- `services/pika` builds with stable Rust and `--locked` (`CARGO_TARGET_DIR="$HOME/.cache/pika-target"`). Debug builds and `cargo test` work without `web/dist`; build `services/pika/web` first for release builds.
- Herder tests (`extensions/herder/vitest.config.ts`, 30 s timeout) use `tests/support/git-fixture.ts` (cleaned up in `finally`) and `tests/support/fake-runner.ts` or Pi's faux provider—never live providers.

## Do not touch

- `node_modules/` — generated dependency state.
- `<git-common-dir>/herder/` — Herder run state (journals, run files, worktrees); change it only through `/herder` commands.
- `refs/herder/` — Herder run refs; never create, move, or delete them by hand.
