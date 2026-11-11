# Local patch ledger

Base: upstream **`@ff-labs/pi-fff@0.11.0`** / **`@ff-labs/fff-node@0.11.0`** ([`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff), MIT).

This is a maintained fork adapted for `pi-extensions`. Keep this ledger current when upgrading the pinned `@ff-labs/fff-node` version or syncing upstream `packages/pi-fff` changes.

## Retained local changes

| Change | Primary source | Compatibility contract |
| --- | --- | --- |
| Out-of-process IPC sidecar | `sidecar.mjs`, `client.ts` | `@ff-labs/fff-node` calls `libfff_c` synchronously through `ffi-rs` (`fileSearch`, `grep`, `multiGrep`, `mixedSearch`, `FileFinder.create`, `scanFiles`, `healthCheck`). Running those calls inside Pi's main process blocks the V8 event loop during large scans or cold greps and risks taking down the host on native faults. `client.ts` spawns `sidecar.mjs` over Node IPC, enforces per-request watchdog timeouts, and automatically kills and respawns a hung or crashed sidecar. On shutdown/disconnect, `sidecar.mjs` exits cleanly instead of calling `fff_destroy`, avoiding native background-thread / LMDB teardown deadlocks. |
| Process-wide shared `FileFinder` pool | `client.ts`, `index.ts` | A single backend registry at `globalThis[Symbol.for("pi-extensions.fff.backend")]` pools sidecar-backed finders keyed by canonical `cwd` (`canonicalRoot(cwd)`) plus auxiliary outside-workspace roots. Top-level sessions, `/reload` cycles, and in-process subagents in the same workspace share the warm index and LMDB handles without re-scanning the tree or contending on LMDB locks. |
| Canonical path & `agentDir` helpers | `paths.ts`, `query.ts`, `config.ts` | `canonicalRoot(dir)` resolves symlinks via `fs.realpathSync.native(path.resolve(dir))` (falling back to `path.resolve(dir)` when missing), and `isHomeDir` / `isFsRoot` compare canonical paths so symlinked roots (e.g. macOS `/var` -> `/private/var`) match reliably. `resolveDbPaths(overrides, agentDir)` accepts an explicit `agentDir` parameter for deterministic testing alongside `loadConfig(agentDir)`. Pure outside-workspace routing helpers (`resolveAuxRoot`, `isOutsideWorkspaceRelativePath`, `routePathConstraint`, `rootCovers`) live in `query.ts` so routing is testable without instantiating native finders. |
| NodeNext strict TypeScript & runtime deps | `*.ts`, root `package.json` | Relative TypeScript imports use explicit `.ts` specifiers (`allowImportingTsExtensions: true`, `moduleResolution: "nodenext"`, `strict: true`) checked by root `npm run typecheck`. Only `@ff-labs/fff-node@0.11.0` is depended on; `@ff-labs/fff-bun` is omitted because `sidecar.mjs` always runs under Node. |

## Preserved upstream contracts

- `<agentDir>/pi-fff.json` (`pi-fff.schema.json`), CLI flags (`--fff-*`), and environment variables (`PI_FFF_MODE`, `FFF_*`, `PI_FFF_MULTIGREP=1`) retain upstream names, validation, and precedence (`flag > env > config > default`).
- LMDB resolution order (`override > env > config > existing fff.nvim DB > <agentDir>/fff/{frecency,history}`) is unchanged; existing `~/.pi/agent/pi-fff.json` and `~/.pi/agent/fff/` state work without migration.
