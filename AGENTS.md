# Agent execution guide

## What this repo is

This repository maintains a collection of extensions for the Pi coding agent.
The published extension table and installation details live in the root [README](README.md#extensions).

## Layout

- `extensions/magpie-provider/` — live Magpie gateway model discovery, built-in Pi API delegation, and automatic native compaction for OpenAI/Codex Responses models with configurable opt-out and exact overrides. Its protocol/replay engine and tests live in `native-compaction/`.
- `extensions/commit/` — a native `/commit` prompt template for self-contained patch series, with loading/contract tests.
- `extensions/quality/` — native `/simplify`, `/review`, `/verify`, and `/deslop` prompt templates for bounded cleanup, read-only bug review, evidence-based verification, and AI-slop removal, with shared loading/contract tests.
- `extensions/orca-bridge/` — Orca hook delivery, background activity aggregation in terminal panes, prompt-aware titles, file/diff navigation, and stock Orca compatibility checks; Subagents publishes snapshots through Pi's event bus. Integrations must use released Orca interfaces without modifying Orca.
- `extensions/autoresearch/` — native main-session optimization: baseline harness design and repeated measurement, explicit user approval before bounded iterations, pinned methodology/harness files, session-owned continuation, durable reports, and footer integration. It owns `/autoresearch`; do not also load `npm:pi-autoresearch`.
- `extensions/loop/` — session-owned recurring prompts, fixed/cron/model-paced scheduling, completion and lifetime limits, and footer integration.
- `extensions/molt/` — `/molt`, which starts a new session that keeps the current model and thinking level.
- `extensions/statusline-footer/` — a theme-aware Pi statusline footer and its tests.
- `extensions/subagents/` — vendored pi-subagents v0.22.0, explicit scriptable workflows (`SubagentWorkflow`), a local fleet (`recon`, `worker`, `reviewer`, `expert`), integrations, and offline upstream/compatibility tests. Workflow primitives live in `src/workflow/`, structured output in `src/structured-output.ts`, and frontmatter parsing in `src/agent-definitions.ts`. See its `LOCAL-PATCHES.md` before resyncing.
- `extensions/herder/` — durable, verified orchestration of coding runs: an append-only journal per run under `<git-common-dir>/herder/`, model-written workflow scripts in a sandbox, writing steps as git transactions in disposable worktrees, serial integration on hidden `refs/herder/` refs, runtime-computed verification, and delivery to the user's branch only after confirmation. Shared contracts live in `src/types.ts` and limits and defaults in `src/config.ts`; the Pi commands and tools live in `src/adapter/`, built-in roles in `agents/`, script templates in `templates/`, the skill in `skills/herder/SKILL.md`, and the read-only `/herder-improve` and `/herder-simplify` audit skills in `skills/improve/` and `skills/simplify/` (all registered under `pi.skills`). Herder requires git >=2.38.
- `extensions/pika/` — capture and upload of every session entry, `before_provider_request` payload (or `fidelity: context`), child session via the `pi-extensions.child-session-hooks` hook, and Herder journal, goal, and plan to a self-hosted pika server, with a disk spool, cursors, and acknowledged hashes under `<agentDir>/pika/` and the `/pika` status command. It is listed last in `pi.extensions` so its payload capture runs after every other extension.
- `services/pika/` — the pika server: one Rust binary (`pika serve`, `token`, `password`, `reindex`, `export`) with ingest, device pairing, password login with server-side sessions, SQLite storage plus a zstd blob store, the read API, and the embedded web UI from `web/` (React, Vite, TypeScript, Tailwind). The shared contract is `docs/SPEC.md`; Docker and reverse-proxy examples are `Dockerfile` and `deploy/`; end-to-end and performance scripts are in `scripts/`.
- `extensions/writer/` — eight explicit native academic writing prompt templates for conference papers, with loading/contract tests.
- `themes/` — Pi themes; the repository currently contains the `material-bloom` theme.

## Verification commands

Run commands from the repository root with Node `>=22.19.0`. The development SDK baseline is Pi 1.4.0; runtime peer dependencies retain Pi >=1.3.0 compatibility.


| Command                             | Coverage                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                            | Install the locked dependencies.                                                                                                        |
| `npm run typecheck`                 | Run strict, no-emit TypeScript checking for the collection and Subagents' dedicated source configuration.                              |
| `npm test`                          | Run the safe collection suite: Orca Bridge, Magpie Provider, Commit, Quality, Statusline Footer, Autoresearch, Loop, Molt, Subagents, native compaction, Herder, Writer, and pika extension tests. |
| `npm run test:orca-bridge` | Run Orca Bridge's offline activity, lifecycle, navigation, release compatibility, real Pi RPC, title, and transport tests. |
| `npm run test:magpie-provider` | Run Magpie's offline provider/lifecycle tests and its native-compaction suite. |
| `npm run test:commit`               | Run Commit's strict TypeScript `node --test` suite.                                                                                     |
| `npm run test:quality`            | Run Quality's strict TypeScript `node --test` loading, expansion, documentation, and contract suite.                                     |
| `npm run test:simplify`           | Compatibility alias for `npm run test:quality`.                                                                                        |
| `npm run test:writer`               | Run Writer's strict TypeScript `node --test` suite.                                                                                     |
| `npm run test:statusline`           | Run Statusline Footer's Vitest suite.                                                                                                   |
| `npm run test:autoresearch` | Run Autoresearch's offline approval, measurement, scheduling, persistence, footer, and real Pi/bash integration tests. |
| `npm run test:loop` | Run Loop's offline scheduling, command, lifecycle, persistence, and Pi integration tests. |
| `npm run test:molt` | Run Molt's offline session-replacement tests against a real Pi runtime. |
| `npm run test:herder` | Run Herder's offline Vitest suite against real git repositories, a scripted fake agent runner, and Pi's faux provider; no live provider tests. |
| `npm run test:subagents`            | Run Subagents' offline upstream and local compatibility Vitest suites, including scripted workflows; live provider tests are not enabled.                            |
| `npm run test:pika` | Run the pika extension's offline Vitest suites against real Pi runtimes, a mock ingest server, and a local mock provider endpoint. |
| `CARGO_TARGET_DIR="$HOME/.cache/pika-target" cargo test --locked --manifest-path services/pika/Cargo.toml` | Run the pika server's Rust unit and integration tests; no web build needed. |
| `cd services/pika/web && npm ci && npm test && npm run build` | Run the pika web UI's Vitest suite, then type-check and build `web/dist`. |
| `bash services/pika/scripts/e2e.sh` | Run pika end to end: the real server, Pi with the extension, and the UI in a locally installed Chrome, including pairing, device revocation, sign-out, the login rate limit, and the refusal to start without a password. |
| `bash services/pika/scripts/perf.sh` | Generate one year of data from five machines and check pika's session-list, session-page, and search latency targets. |


## Conventions

- Use conventional commits with a scope, for example `fix(subagents): reject stored raw models in scheduled jobs` and `test(extensions): pin error messages and assert rendered output`.
- Workflow scripts run only on an explicit orchestration request. Subagents workflow children share the run cwd and current files, including existing edits and dependencies; `isolation: "worktree"` gives a single child its own worktree when parallel writers would conflict. Await relevant writers before verification.
- TypeScript is strict and configured with `noEmit`.
- The pika server builds with stable Rust and `--locked`. Set `CARGO_TARGET_DIR="$HOME/.cache/pika-target"` to share build artifacts across worktrees. `cargo test` and debug builds must not need `web/dist`: without it the UI routes serve a placeholder page, and only release builds embed the UI, so build `web/` first for a release.
- pika, Subagents, and Herder never import each other. Child sessions reach pika only through the `Symbol.for("pi-extensions.child-session-hooks")` Set and the `pi-extensions.session-link` entry; Herder announces runs on the `herder:run` event.
- Commit, Quality, and Writer tests use strict TypeScript with Node's `node --test`; Statusline Footer, Subagents, Herder, and native compaction tests use Vitest.
- `npm run test:herder` uses `extensions/herder/vitest.config.ts` (30 s test and hook timeouts). Herder tests create real git repositories with `tests/support/git-fixture.ts` and remove them in `finally`; agents are the scripted fake runner (`tests/support/fake-runner.ts`) or, in `tests/agents/`, Pi's faux provider. No live provider tests.

## Do not touch

- `node_modules/` — generated dependency state.
- `<git-common-dir>/herder/` — Herder run state (journals, run files, worktrees); change it only through `/herder` commands.
- `refs/herder/` — Herder run refs; never create, move, or delete them by hand.

