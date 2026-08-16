# Standalone Plans CLI compatibility dossier

## Verified current surfaces

This dossier records repository evidence only. It does not select a support or removal policy, and it does not change the executable CLI.

### Repository and Pi entry points

- `extensions/herder/src/core/plans.ts:1` has a `#!/usr/bin/env node` shebang. Its executable tail at `:990-1091` parses `process.argv`, dispatches commands, writes JSON to stdout, and runs only when `isMain` matches the module URL.
- The standalone usage block at `extensions/herder/src/core/plans.ts:962-977` names exactly these 13 commands: `init`, `validate`, `status`, `shape`, `ready`, `snapshot`, `record-usage`, `bind-profile`, `profile`, `usage`, `report`, `track`, and `untrack`.
- The application-facing Pi command inventory at `extensions/herder/adapters/arguments.ts:43-57` exposes only `init`, `validate`, `shape`, `status`, `ready`, `snapshot`, `report`, `track`, and `untrack`. The Pi adapter registers `/herder-plans` at `extensions/herder/adapters/planning-workflows.ts:197-209`; its model tool operation union is at `:216-221` and likewise has no usage/profile commands.
- The public command reference at `extensions/herder/README.md:51-55` documents the same nine Pi `/herder-plans` operations and does not document the four standalone-only names `record-usage`, `bind-profile`, `profile`, or `usage`. README `:70` explicitly describes `/herder-plans` as a typed, native application-tool surface.
- Repository search (`rg -n 'src/core/plans\\.ts|(?:node|tsx|bun)[^\\n]*plans\\.ts|herder-plans (record-usage|bind-profile|profile|usage)' . --glob '!node_modules/**'`) found imports from `src/core/plans.ts` in production/test TypeScript and the standalone usage strings, but no repository subprocess or script invocation of the file. The imports include `buildGraph`, `initPlanDir`, `recordUsage`, `projectStatuses`, and `snapshotPlan`; exported library reachability is therefore established and is not evidence for deleting exports.

### Current read-only drift

The requested drift check was run against `9581958..HEAD` for the listed source, manifest, README, architecture-test, and dossier paths. It reports current changes in `extensions/herder/src/application/tools.ts` and `extensions/herder/tests/integration/architecture.test.ts`. Current evidence was refreshed against this checkout rather than copied from the planned-at description. In particular, the current application facade has separate lifecycle and execution paths (`extensions/herder/src/application/tools.ts:84-108`), and the current adapter performs repository path resolution and trust/mutation checks (`extensions/herder/adapters/planning-workflows.ts:200-207,242-264`).

## Behavioral differences

The standalone file and the Pi command are related surfaces over some shared functions, but they are not equivalent callers. The following inventory covers every standalone command and each decision dimension requested by the plan.

| Standalone command | Pi surface / behavioral comparison |
| --- | --- |
| `init` | Both ultimately call `initPlanDir` (`extensions/herder/src/core/plans.ts:744-756`; application `tools.ts:84`). Standalone accepts a path resolved from the process working directory and has no Pi trust or active-run guard. Pi resolves a target relative to the canonical repository (`extensions/herder/adapters/paths.ts:25-43`), requires project trust (`planning-workflows.ts:202` or `:243-245`), and calls `assertMutationAllowed` for mutations (`:247-251`; adapter callback in `extensions/herder/adapters/index.ts:1274-1277`). Standalone's `--track` is a flag removed before dispatch (`plans.ts:990-997`); Pi's parser permits it only for `init` (`arguments.ts:270-306`). |
| `validate` | Standalone dispatches directly to `buildGraph` (`plans.ts:1032-1034`) and emits the full authored graph. Pi validates through the application tool (`tools.ts:85-88`), after trust and repository confinement, and adds `graphSha256` to the graph result (`tools.ts:43-45,86-88`). |
| `status` | Standalone dispatches to `buildGraph` (`plans.ts:1032-1034`), so statuses, readiness, counts, and completion are authored Markdown/index state. Pi maps `status` to `readPlanLifecycleGraph` (`tools.ts:89`), which overlays SQLite runtime lifecycle when an initialized run exists (`extensions/herder/src/core/workflow.ts:48-69,105-108`). Thus an active or terminal run can make Pi status differ from standalone status without changing plan Markdown. |
| `shape` | Standalone calls `getShapeReport` (`plans.ts:1035-1037`). Pi calls the same shape report but also computes and returns `graphSha256` (`tools.ts:90-93`). Pi additionally applies trust and canonical repository-directory resolution before entering the application facade. |
| `ready` | Standalone builds the authored graph and selects `ready`, `inProgress`, `blocked`, `waiting`, and `complete` from it (`plans.ts:1038-1048`). Pi reads the lifecycle-overlay graph first (`tools.ts:97-106`; `workflow.ts:105-108`), so readiness and completion reflect SQLite runtime state when present. The returned field names are otherwise the same five graph projections plus `planDir`. |
| `snapshot` | Standalone calls `snapshotPlan` with the positional ID and directory (`plans.ts:1049-1051`), returning the exported snapshot structure including `planText`, source text, inputs, and hash (`plans.ts:779-818`). Pi requires a typed `planId`, confines the directory, and invokes the same application operation (`tools.ts:94`); Pi command output is formatted for a notification rather than raw JSON (`planning-workflows.ts:145-149`). |
| `record-usage` | This is standalone-only. Its required attempt/model/effort/outcome and token/timing flags are parsed by the executable tail (`plans.ts:998-1022,1052-1059`) and stored through `recordUsage` / the execution store (`plans.ts:906-922`). It is absent from the Pi parser and operation union (`arguments.ts:270-306`; `planning-workflows.ts:216-221`), so there is no documented Pi equivalent in this command surface. |
| `bind-profile` | This is standalone-only. The standalone parser accepts profile, hash, host, and roles JSON (`plans.ts:1016-1021,1066-1069`) and calls `bindRunProfile` (`plans.ts:936-940`). It is not in the Pi command parser or application plan-operation union. Profile selection for runs is instead part of other Pi run-control flows, not a `/herder-plans bind-profile` operation (README `:68`). |
| `profile` | This is standalone-only and reads the execution-store run configuration through `getRunProfile` (`plans.ts:942-945,1070-1072`). No Pi `/herder-plans` parser operation or public command documents it. |
| `usage` | This is standalone-only and reads execution-store usage state through `getUsageReport` (`plans.ts:925-928,1060-1062`). No Pi `/herder-plans` parser operation or public command documents it. |
| `report` | Both expose a report operation. Standalone parses `<plan-id|RUN>` and calls `getExecutionReport` (`plans.ts:1063-1065`); Pi passes its typed optional `planId` to the same application function (`tools.ts:95`). Standalone emits the complete result as JSON; the Pi slash command formats a concise attempts/interruptions/tokens/duration notification (`planning-workflows.ts:150-153`), while the model tool returns JSON text (`:264-275`). The report's RUN/plan lifecycle fields come from `getExecutionReport` (`plans.ts:946-959`), not the separate status/ready lifecycle-overlay path. |
| `track` | Both ultimately call `setTracking` (`plans.ts:758-777`; `tools.ts:96`). Standalone has no trust or active-run guard and resolves its argument from the process working directory. Pi resolves an existing canonical directory inside the repository (`paths.ts:11-23`), checks project trust, and rejects mutation while an active Fire run is present (`planning-workflows.ts:202-207,242-251`; `adapters/index.ts:1274-1277`). |
| `untrack` | The comparison is the same as `track`: shared `setTracking` behavior, but standalone has no Pi trust/confinement/active-run policy, while Pi uses the confined, trusted, mutation-guarded route. |

### Cross-cutting parser, path, trust, mutation, and contracts

- **Parser:** The standalone `main` removes `--pretty`/`--track`, consumes known value flags with `takeFlag`, rejects remaining `--` options, and dispatches positional arguments (`plans.ts:981-1027`). It has no quoting/tokenization layer. The Pi parser tokenizes quoted and escaped input (`extensions/herder/adapters/arguments.ts:59-103`), validates operation names and duplicate/unknown options (`:270-306`), and emits the documented slash-command usage on parse failures (`:43-50`). The standalone parser additionally retains four execution-store command families that the Pi parser intentionally omits.
- **Repository confinement and resolution:** Standalone top-level command paths use `path.resolve` in `buildGraph`, `initPlanDir`, and `setTracking`; `buildGraph`'s plan-file links do enforce plan-directory and symlink boundaries (`plans.ts:295-329`), and `init`/tracking derive Git context (`:664-676`). The standalone executable does not first canonicalize the requested directory against the repository root as the Pi adapter does. Pi uses `realpathSync` plus an inside-repository check for existing directories and a safe target resolver for `init` (`paths.ts:4-43`).
- **Trust and mutation guards:** Standalone has no Pi context, so its executable tail has no `isProjectTrusted` check and no active-run mutation gate. The Pi slash handler requires project trust (`planning-workflows.ts:200-207`); the model tool repeats the trust check and gates `init`, `track`, and `untrack` (`:242-251`). The adapter supplies the active-Fire rejection (`adapters/index.ts:1274-1277`).
- **Lifecycle overlay:** Standalone `status` and `ready` use authored `buildGraph` state (`plans.ts:1032-1048`). Pi `status` and `ready` use SQLite-backed `readPlanLifecycleGraph` (`tools.ts:89,97-106`), whose overlay maps runtime phases to `DONE`, `BLOCKED`, or `IN PROGRESS` (`workflow.ts:35-69`). This is a behavioral difference, not merely formatting.
- **Returned fields:** Standalone `validate` returns the graph and `shape` returns its shape projection; Pi adds `graphSha256` to both (`tools.ts:43-45,85-93`). Standalone `ready` and Pi `ready` expose the same projection keys but potentially different values due to lifecycle overlay. `snapshot` and `report` share the core result shapes, while Pi slash notifications intentionally summarize them.
- **Output and errors:** Standalone serializes one JSON result to stdout, with optional pretty printing, and catches failures as `herder-plans: ...` on stderr with exit code 1 (`plans.ts:1080-1089`). The Pi slash handler sends success/error notifications through `ctx.ui.notify` (`planning-workflows.ts:200-207`); the Pi tool returns JSON text and marks caught failures with `isError: true` (`:264-277`). Consequently, scripts consuming standalone stdout/stderr cannot assume the Pi notification contract, and Pi callers cannot assume standalone exit-code/JSON-stream behavior.

## Package exposure

Evidence command: `npm pack --dry-run --json --ignore-scripts` completed with exit 0. Its dry-run file list includes `extensions/herder/src/core/plans.ts` with executable mode `493`, but the package metadata in `package.json:1-48` has no `bin`, `exports`, or `files` field. The same manifest registers the Pi adapter at `package.json:40-45` (`./extensions/herder/adapters/index.ts`), not `src/core/plans.ts`. The dry-run reports a prospective `pi-extensions-0.2.0.tgz` filename as normal npm metadata, but no tarball was written at the repository root: `find . -maxdepth 1 -name '*.tgz'` was empty both before and after the dry run.

Therefore the source file is package content and remains directly addressable to a source-install consumer who knows its path, but it is not an npm executable entry point. There is no repository evidence that package installation creates a `herder-plans` binary.

## History and purpose

- `git log --follow --oneline -- extensions/herder/src/core/plans.ts` shows the file was introduced in `f4ada67` (`feat: add Pi-native Herder orchestration`), then changed by `c2bcaf0` (snapshot compilation), `03a34e4` (metadata-file confinement), and `08b154f` (shared protocol hash helpers).
- `git show --stat f4ada67` shows the initial commit added `src/core/plans.ts` and the Pi adapter/planning workflow in the same Pi-native orchestration change. This supports shared-origin/convergence history, not a claim that external source-path consumers do or do not exist.
- The file has a dual role: its named exports are imported by production and tests (repository search above), while its shebang and executable tail provide a second, unregistered command parser. The accepted compatibility fact is therefore narrow: exported functions are demonstrably reachable; executable-path support outside repository callers remains unresolved.

## External unknowns

- No repository subprocess, script, `bin`, or `exports` entry was found for the standalone path. That is evidence about this repository and package metadata only; it does **not** prove that source checkouts, copied extension files, local automation, or undocumented external scripts do not execute `extensions/herder/src/core/plans.ts`.
- There is no telemetry or supported-caller registry in the inspected surfaces. Absence of usage records must not be interpreted as absence of usage.
- The supported external contract for the shebang path is unknown: caller expectations for its four standalone-only execution-store commands, authored-versus-runtime status semantics, relative paths, stdout JSON shape, stderr prefix, exit codes, and direct source execution are not established by repository evidence.
- Support intent is unknown. No retain, deprecation, wrapper, or removal policy is selected here. In particular, the Pi `/herder-plans` documentation is evidence for the supported Pi surface, not evidence that the source path is unsupported for external callers.

## Candidate exit criteria

Grill should choose exactly one of the following only after confirming support intent and resolving the external source-path reachability question. None is selected by this dossier.

### 1. Retain and document

- **Compatibility effect:** Keep the shebang and all 13 standalone commands unchanged; add or maintain explicit documentation that distinguishes the source CLI from `/herder-plans`, including path, lifecycle, trust, mutation, and output/error differences. Exported functions remain untouched.
- **Follow-up tests/docs:** Add CLI-level tests for each command, parser/error/output contracts, relative and repository path behavior, and direct source execution; document whether the CLI is a supported source-install interface and which lifecycle state it reports.
- **Negative completeness proof:** Show no executable tail, command name, exported function, package entry-point assumption, or documented Pi behavior was unintentionally removed or altered; verify `npm pack --dry-run` still exposes the stated source path without creating an artifact.

### 2. Deprecate with a support window

- **Compatibility effect:** Keep the current executable behavior during a published, versioned window; add a warning and migration guidance only after confirming where warnings may safely go without corrupting stdout JSON. Do not change exported functions or silently redirect status semantics.
- **Follow-up tests/docs:** Define the warning channel and machine-readable compatibility contract, test all 13 commands and both direct/Pi surfaces, publish a replacement mapping for the four standalone-only commands and the status/ready lifecycle difference, and record the end date/version for support.
- **Negative completeness proof:** Demonstrate that every known repository caller and documented Pi operation continues to work, that warnings do not alter stdout/error exit contracts, and that no removal is performed before the support window and external-reachability review close.

### 3. Remove only the executable tail

- **Compatibility effect:** Delete only the shebang/`isMain` dispatch tail after support intent is explicitly removal and external source-path reachability is resolved; preserve every exported library function and the Pi adapter/application/tool surface. This would break direct source-path CLI callers and all 13 standalone command invocations, including commands with no Pi equivalent.
- **Follow-up tests/docs:** Add an architecture or source test proving the exported graph/snapshot/tracking/profile/usage APIs remain importable; test the nine Pi operations and their trust/confinement/mutation/lifecycle contracts; document the removal and migration path, and prove package metadata still has no accidental `bin`/`exports` change.
- **Negative completeness proof:** Establish zero supported executable-path callers through explicit owner/support confirmation plus repository/package/source-install investigation; compare the complete 13-command inventory and all six behavioral dimensions before and after; assert no CLI-only name, shebang, output contract, or direct path is left as an undocumented partial interface.

**Decision rule / exact exit criteria for any removal plan:** confirmed support intent to remove; resolved external source-path reachability with explicit treatment of unknown source-install consumers; preserved exported functions and their production/test imports; unchanged nine-command Pi contract unless separately planned; and passing CLI/Pi regression, package dry-run, typecheck, and no-root-tarball checks. Until all are true, retain this dossier as decision input and select no option.
