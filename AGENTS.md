# Agent execution guide

## What this repo is

This repository maintains a collection of extensions for the Pi coding agent.
The published extension table and installation details live in the root [README](README.md#extensions).

## Layout

- `extensions/cliproxyapi-native-compaction/` — native OpenAI Responses compaction for eligible CLIProxyAPI-backed Pi sessions.
- `extensions/commit/` — a commit-writing extension with preflight helpers and tests.
- `extensions/herder/` — the deterministic multi-agent plan runner, Pi adapter, runtime source, tests, and documentation.
- `extensions/shared/` — shared Orca busy-state coordination plus its strict Node test.
- `extensions/statusline-footer/` — a theme-aware Pi statusline footer and its tests.
- `extensions/subagents/` — vendored Claude Code-style autonomous subagents, examples, source, and tests.
- `extensions/writer/` — command-owned academic writing workflows and skills for conference papers, with tests.
- `themes/` — Pi themes; the repository currently contains the `material-bloom` theme.

## Verification commands

Run commands from the repository root with Node `>=22.19.0`.

| Command | Coverage |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run typecheck` | Run strict, no-emit TypeScript checking for the configured `extensions` sources; `extensions/subagents` is excluded. |
| `npm test` | Run the safe collection suite: Commit, Statusline Footer, Subagents, native compaction, Herder, and Writer tests. |
| `npm run test:commit` | Run Commit's strict TypeScript `node --test` suite. |
| `npm run test:writer` | Run Writer's strict TypeScript `node --test` suite. |
| `npm run test:statusline` | Run Statusline Footer's Vitest suite. |
| `npm run test:subagents` | Run the Subagents widget's Vitest suite. |
| `npm run test:herder` | Run Herder's deterministic smoke suite; its first phase already runs `npm run typecheck`. |

## Live E2E warning

`npm run test:e2e:herder` runs the provider-backed Herder fixture, spends real model/provider credits, and requires `HERDER_LIVE_E2E=1` plus provider credentials. Run it only when a human explicitly asks; it is not part of the default `npm test` gate. Read the [Herder testing guide](extensions/herder/TESTING.md) first.

## Conventions

- Use conventional commits with a scope, for example `fix(herder): persist restack targets` and `test(client): cover terminal operation failure recovery`.
- TypeScript is strict and configured with `noEmit`.
- Commit, Writer, and Herder tests use strict TypeScript with Node's `node --test`; Statusline Footer, Subagents, and native compaction tests use Vitest.
- Herder integration tests run sequentially within each file, and temporary fixtures under `os.tmpdir()` are removed in `finally` blocks.

## Do not touch

- `node_modules/` — generated dependency state.
- Any `*/.herder/` runtime directory — manager-owned SQLite state, locks, and worktrees.
- `herder-plans/README.md` during a run — its lifecycle status rows are manager-owned.
- `extensions/subagents` vendored source — change it only through upstream pin updates.

## Deeper docs

- [Herder README](extensions/herder/README.md)
- [Herder adapter/runtime docs](extensions/herder/adapters/README.md)
- [Herder testing guide](extensions/herder/TESTING.md)
