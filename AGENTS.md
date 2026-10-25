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
- `extensions/herder/` — durable, verified orchestration of coding runs: an append-only journal per run under `<git-common-dir>/herder/`, model-written workflow scripts in a sandbox, writing steps as git transactions in disposable worktrees, serial integration on hidden `refs/herder/` refs, runtime-computed verification, and delivery to the user's branch only after confirmation. Shared contracts live in `src/types.ts` and limits in `src/config.ts`.
- `extensions/writer/` — eight explicit native academic writing prompt templates for conference papers, with loading/contract tests.
- `themes/` — Pi themes; the repository currently contains the `material-bloom` theme.

## Verification commands

Run commands from the repository root with Node `>=22.19.0`. The development SDK baseline is Pi 1.4.0; runtime peer dependencies retain Pi >=1.3.0 compatibility.


| Command                             | Coverage                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                            | Install the locked dependencies.                                                                                                        |
| `npm run typecheck`                 | Run strict, no-emit TypeScript checking for the collection and Subagents' dedicated source configuration.                              |
| `npm test`                          | Run the safe collection suite: Orca Bridge, Magpie Provider, Commit, Quality, Statusline Footer, Autoresearch, Loop, Molt, Subagents, native compaction, Herder, and Writer tests. |
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


## Conventions

- Use conventional commits with a scope, for example `fix(subagents): reject stored raw models in scheduled jobs` and `test(extensions): pin error messages and assert rendered output`.
- Workflow scripts run only on an explicit orchestration request. Subagents workflow children share the run cwd and current files, including existing edits and dependencies; `isolation: "worktree"` gives a single child its own worktree when parallel writers would conflict. Await relevant writers before verification.
- TypeScript is strict and configured with `noEmit`.
- Commit, Quality, and Writer tests use strict TypeScript with Node's `node --test`; Statusline Footer, Subagents, Herder, and native compaction tests use Vitest.

## Do not touch

- `node_modules/` — generated dependency state.

