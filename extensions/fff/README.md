# FFF (`extensions/fff`)

FFF-powered file search (`fffind`), content search (`ffgrep`, opt-in `fff-multi-grep`), and `@` file mention autocomplete for Pi, ported from [`@ff-labs/pi-fff@0.11.0`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) (`@ff-labs/fff-node@0.11.0`, MIT).

## Coexistence & migration

Do **not** load this extension alongside a global or project install of `npm:@ff-labs/pi-fff` — both register the same tool names, `--fff-*` flags, and `/fff-*` commands. Remove any standalone package install first:

```bash
pi remove npm:@ff-labs/pi-fff
```

Configuration at `<agentDir>/pi-fff.json` (`~/.pi/agent/pi-fff.json` or `$PI_CODING_AGENT_DIR/pi-fff.json`) and LMDB databases under `~/.pi/agent/fff/{frecency,history}` (plus existing `fff.nvim` databases) remain 100% compatible.

## Architecture

Compared to upstream `@ff-labs/pi-fff@0.11.0`, this port makes three runtime changes (see `LOCAL-PATCHES.md`):

1. **Out-of-process IPC sidecar (`sidecar.mjs`):** `@ff-labs/fff-node` invokes `libfff_c` synchronously via `ffi-rs`. Running FFI calls in a dedicated Node child process keeps scans, greps, and `@`-mention queries off Pi's main V8 event loop, bounds stuck calls with a watchdog timeout + automatic crash/hang respawn, exits cleanly on IPC disconnect instead of calling `fff_destroy` (avoiding native teardown deadlocks), and recycles idle sidecars after pruning deleted temporary worktrees (`PI_FFF_MAX_DEAD_HANDLES`, default `8`) so the OS reclaims native watchers and mmaps with zero downtime.
2. **Process-wide canonical-`cwd` shared pool (`Symbol.for("pi-extensions.fff.backend")`):** top-level sessions, `/reload`, and in-process child sessions targeting the same canonical workspace or pooled git worktree share one warm `FileFinder` backend instead of re-scanning the repository or contending on LMDB locks. Reused git worktree slots that switch `HEAD` (`git checkout` / `git reset`) automatically trigger a coalesced `scanFiles()` refresh on `ensureRoot`.
3. **Child-session propagation (`Symbol.for("pi-extensions.child-session-hooks")`):** while active, `fff` registers an idempotent `"fff"` child-session hook so isolated child sessions (`noExtensions: true`, such as Herder steps) receive `fffind` and `ffgrep` backed by the shared sidecar, while deduplicating when a child also loads discovered extensions.

## Tools & commands

| Mode | Tools registered | `@` file autocomplete |
| --- | --- | --- |
| `tools-and-ui` *(default)* | `fffind`, `ffgrep` (`fff-multi-grep` when `PI_FFF_MULTIGREP=1`) | FFF-backed |
| `tools-only` | `fffind`, `ffgrep` (`fff-multi-grep` when `PI_FFF_MULTIGREP=1`) | Pi built-in |
| `override` | `find`, `grep` (`multi_grep` when `PI_FFF_MULTIGREP=1`) | FFF-backed |

- `fffind` / `find`: fuzzy repo-relative path and glob search (`pattern`, `path`, `exclude`, `limit` default `30`, `cursor`). Supports outside-workspace `path` (`/...`, `~/...`, `../...`) via auxiliary indexes.
- `ffgrep` / `grep`: smart-case literal/regex content search ranked by frecency (`pattern`, `path`, `exclude`, `caseSensitive`, `context`, `limit` default `20`, `cursor`).
- Commands: `/fff-health`, `/fff-rescan`, `/fff-mode [tools-and-ui | tools-only | override]` (switching to/from `override` applies tool names on `/reload`).

## Configuration & flags

Startup precedence: **CLI flag > environment variable > `<agentDir>/pi-fff.json` > default** (resumed sessions honor the latest `/fff-mode` entry).

| `pi-fff.json` key | CLI flag | Env var | Default |
| --- | --- | --- | --- |
| `mode` | `--fff-mode` | `PI_FFF_MODE` | `"tools-and-ui"` |
| `frecencyDbPath` | `--fff-frecency-db` | `FFF_FRECENCY_DB` | `fff.nvim` cache or `<agentDir>/fff/frecency` |
| `historyDbPath` | `--fff-history-db` | `FFF_HISTORY_DB` | `fff.nvim` data or `<agentDir>/fff/history` |
| `enableFsRootScanning` | `--fff-enable-root-scan` | `FFF_ENABLE_ROOT_SCAN` | `false` |
| `enableHomeDirScanning` | `--fff-enable-home-scan` | `FFF_ENABLE_HOME_SCAN` | `true` |
| `warnOnHomeDirScan` | `--fff-warn-home-scan` | `FFF_WARN_HOME_SCAN` | `true` |
| `followSymlinks` | `--fff-follow-symlinks` | `FFF_FOLLOW_SYMLINKS` | `true` |
