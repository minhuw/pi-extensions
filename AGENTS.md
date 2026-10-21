# Agent execution guide

## What this repo is

This repository maintains a collection of extensions for the Pi coding agent.
The published extension table and installation details live in the root [README](README.md#extensions).

## Layout

- `extensions/magpie-provider/` — live Magpie gateway model discovery, built-in Pi API delegation, and automatic native compaction for OpenAI/Codex Responses models with configurable opt-out and exact overrides. Its protocol/replay engine and tests live in `native-compaction/`.
- `extensions/commit/` — a native `/commit` prompt template for self-contained patch series, with loading/contract tests.
- `extensions/simplify/` — a native `/simplify` prompt template for bounded cleanup with three review lenses, with loading/contract tests.
- `extensions/herder/` — the deterministic multi-agent plan runner, Pi adapter, runtime source, tests, and documentation.
- `extensions/orca-bridge/` — Orca hook delivery, background activity aggregation in terminal panes, prompt-aware titles, file/diff navigation, and stock Orca compatibility checks; Herder and Subagents publish snapshots through Pi's event bus. Integrations must use released Orca interfaces without modifying Orca.
- `extensions/autoresearch/` — native main-session optimization: baseline harness design and repeated measurement, explicit user approval before bounded iterations, pinned methodology/harness files, session-owned continuation, durable reports, and footer integration. It owns `/autoresearch`; do not also load `npm:pi-autoresearch`.
- `extensions/loop/` — session-owned recurring prompts, fixed/cron/model-paced scheduling, completion and lifetime limits, and footer integration.
- `extensions/statusline-footer/` — a theme-aware Pi statusline footer and its tests.
- `extensions/subagents/` — vendored pi-subagents v0.22.0, explicit scriptable workflows (`SubagentWorkflow`), a local fleet (`recon`, `worker`, `reviewer`, `expert`), integrations, and offline upstream/compatibility tests. Workflow primitives live in `src/workflow/`, structured output in `src/structured-output.ts`, and frontmatter parsing in `src/agent-definitions.ts`. See its `LOCAL-PATCHES.md` before resyncing.
- `extensions/writer/` — eight explicit native academic writing prompt templates for conference papers, with loading/contract tests.
- `themes/` — Pi themes; the repository currently contains the `material-bloom` theme.

## Verification commands

Run commands from the repository root with Node `>=22.19.0`.


| Command                             | Coverage                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                            | Install the locked dependencies.                                                                                                        |
| `npm run typecheck`                 | Run strict, no-emit TypeScript checking for the collection and Subagents' dedicated source configuration.                              |
| `npm test`                          | Run the safe collection suite: Orca Bridge, Magpie Provider, Commit, Simplify, Statusline Footer, Autoresearch, Loop, Subagents, native compaction, Herder, and Writer tests. |
| `npm run test:orca-bridge` | Run Orca Bridge's offline activity, lifecycle, navigation, release compatibility, real Pi RPC, title, and transport tests. |
| `npm run test:magpie-provider` | Run Magpie's offline provider/lifecycle tests and its native-compaction suite. |
| `npm run test:commit`               | Run Commit's strict TypeScript `node --test` suite.                                                                                     |
| `npm run test:simplify`            | Run Simplify's strict TypeScript `node --test` loading, expansion, and contract suite.                                                   |
| `npm run test:writer`               | Run Writer's strict TypeScript `node --test` suite.                                                                                     |
| `npm run test:statusline`           | Run Statusline Footer's Vitest suite.                                                                                                   |
| `npm run test:autoresearch` | Run Autoresearch's offline approval, measurement, scheduling, persistence, footer, and real Pi/bash integration tests. |
| `npm run test:loop` | Run Loop's offline scheduling, command, lifecycle, persistence, and Pi integration tests. |
| `npm run test:subagents`            | Run Subagents' offline upstream and local compatibility Vitest suites, including scripted workflows; live provider tests are not enabled.                            |
| `npm run test:herder`               | Run Herder's deterministic smoke suite; its first phase already runs `npm run typecheck`.                                               |


## Live E2E warning

`npm run test:e2e:herder` runs the provider-backed Herder fixture, spends real model/provider credits, and requires provider credentials (the script sets `HERDER_LIVE_E2E=1` itself; only a direct `node --test` invocation must pass the flag manually). Run it only when a human explicitly asks; it is not part of the default `npm test` gate. Read the [Herder testing guide](extensions/herder/TESTING.md) first.

## Conventions

- Use conventional commits with a scope, for example `fix(herder): persist restack targets` and `test(client): cover terminal operation failure recovery`.
- Workflow scripts run only on an explicit orchestration request. Subagents workflow children share the run cwd and current files, including existing edits and dependencies; `isolation: "worktree"` gives a single child its own worktree when parallel writers would conflict. Await relevant writers before verification. Herder retains its own worktree, integration, and verification policy.
- TypeScript is strict and configured with `noEmit`.
- Commit, Simplify, Writer, and Herder tests use strict TypeScript with Node's `node --test`; Statusline Footer, Subagents, and native compaction tests use Vitest.
- Herder integration tests run sequentially within each file, and temporary fixtures under `os.tmpdir()` are removed in `finally` blocks.

## Do not touch

- `node_modules/` — generated dependency state.
- Any `*/.herder/` runtime directory — manager-owned SQLite state, locks, and worktrees.
- `herder-plans/README.md` during a run — its lifecycle status rows are manager-owned.

## Deeper docs

- [Herder README](extensions/herder/README.md)
- [Herder adapter/runtime docs](extensions/herder/adapters/README.md)
- [Herder testing guide](extensions/herder/TESTING.md)

