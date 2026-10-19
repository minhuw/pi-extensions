# Local patch ledger

Base: upstream **v0.22.0**, commit `85a704cb8f35c96c0cabfa665b572bab296942e5`.

This is an editable fork, not a byte-identical distribution. Keep this ledger current when upgrading; a local patch should disappear when upstream supplies equivalent behavior.

## Upgrade plan and boundaries

1. Import the released source, examples, documentation, and upstream regression suite using v0.14.3 as the three-way merge base.
2. Retain the smallest necessary fleet, service-tier, host ownership, telemetry, Orca, and invocation-display changes. Use upstream lifecycle, scoping, completion scheduling, and rendering fixes rather than reimplementing them.
3. Preserve foreground execution and opt-in package discovery. Expose upstream Workflow as a separate explicit-invocation capability, not as a replacement for Herder.
4. Backport the upstream resume correctness fixes separately; test turn budgets, cancellation, and background resumes together with local ownership rules.
5. Align development dependencies with Pi 1.3.0, add strict Subagents typechecking, run offline upstream/local regressions and the safe collection suite, then independently review the integration.

No changes to user configuration, provider credentials, runtime databases, or existing session files are part of this upgrade. No live provider tests or release/publish operations are authorized by this plan.

## Retained local changes

| Change | Primary source | Compatibility contract |
| --- | --- | --- |
| Default fleet | `src/default-agents.ts`, `src/agent-types.ts`, runner/workflow defaults | `recon` / `worker` / `reviewer`; Recon defaults to `deepseek/deepseek-flash`, high thinking, and no tier override. Canonical fallback is `worker`, not an absent upstream `general-purpose` agent. Built-in search remains available without an external search dependency. Installed extensions, including `npm:@ff-labs/pi-fff` when present, are inherited by default agents and nested children through normal extension discovery; FFF is optional and is not a required dependency. Explicit agent extension restrictions continue to apply. |
| Service tiers | `src/service-tier.ts`, types, config, runner, manager, schedule, tool entry | Agent-file tier takes precedence over a spawn override; compatible streams receive the normalized provider tier. |
| Scoped host | `src/host-registry.ts`, manager and entry | Preserve registration ownership and host spawning. Generic resume/stop/steer cannot take over externally owned agents; parent cancellation remains effective. |
| Telemetry | manager and entry | Preserve ownership, parentage, activity, turn count, usage, and bounded response metadata. |
| Orca coordination | entry, shared busy-state module | Keep the pane busy while owned asynchronous work runs; release leases on completion and shutdown. |
| Invocation UI | `src/ui/`, entry | Preserve compact actual model/thinking/tier and invocation details while retaining upstream fullscreen, costs, and render caching. |
| Default policies | invocation config, settings, package resources | Foreground by default; package agents/workflows require opt-in. Existing explicit settings continue to win. |
| Shared workflow extraction | `../shared/workflow/`, `src/workflow/`, `src/structured-output.ts` | Canonical runtime, metadata, journal, progress, JSON Schema, structured-output, and worker-source primitives live under `extensions/shared/workflow/`. Old Subagents paths re-export them for import compatibility; keep attribution/license with the extracted code. Subagents owns the only scripted-workflow frontend (`SubagentWorkflow`) and keeps its legacy isolation and resume support in the shared runtime; extraction does not transfer Herder authority. |
| Shared agent frontmatter | `../shared/agent-definitions.ts`, `src/custom-agents.ts` | Zero-dependency frontmatter parser and normalizer shared with the rest of the collection; `custom-agents.ts` preserves its parser export. Keep aliases, inline lists, block scalars, names, disabled entries, tool selectors, and model/thinking/tier fields compatible. Subagents retains its own discovery and execution policy; the shared parser enforces no capability boundary by itself. |
| Pi SDK baseline | root manifest, runner/entry and regression fixtures | Pi >=1.3.0, checked against the same SDK version used by the host. |

## Selective post-release backports

These do not change the declared release base:

- [`d7c9ec0`](https://github.com/tintinweb/pi-subagents/commit/d7c9ec0): enforce `max_turns` and count turns on resumed agents.
- [`ca93a52`](https://github.com/tintinweb/pi-subagents/commit/ca93a52): make inline resumes stoppable, retain the spawn budget, and pass nested `max_turns` through resume.

The intervening main-branch usage-event and RPC-steer features are not implied by these backports.

Integration review also required two local corrections: host delegation rejects agent frontmatter that disables its mandatory isolation, and foreground resumes report turn-limit/user-stop outcomes in model-visible text instead of presenting partial output as an ordinary completed answer. Both have regression coverage.

## Tests and deliberate adaptations

`test/` is the imported upstream suite, adapted where the default fleet, foreground/package policy, SDK 1.3 APIs, or collection layout differs. `tests/` holds local compatibility regressions. The scoped Vitest configuration prevents the default collection command from spending real provider credits. Keep assertions for upstream correctness fixes; do not silence failures simply because a file was vendored.

The dedicated TypeScript configuration checks the source and is invoked by root `npm run typecheck`. Root SDK-fixture updates are part of the upgrade where Pi's event/API contracts changed; they do not change Herder's execution policy.

## Upgrade verification

Checked with Pi SDK 1.3.0 and Vitest 4.1.12:

- Collection and Subagents strict typechecks passed.
- Subagents: **123 files, 2,459 passing tests**; seven real-provider cases intentionally skipped. An ambient `PI_E2E_LIVE=1` still selected faux providers, and explicit live harness requests were rejected before credential discovery.
- CLIProxyAPI Provider, Magpie/shared compaction, native compaction, Commit, Statusline, and Writer checks passed.
- Herder: **252 integration tests** passed. The first full collection run timed out during the unbounded unit phase with several test deadline failures; rerunning all **1,044 unit tests** at two-file concurrency passed. The smoke runner now uses that same bound for both phases. These are separate verification runs, not a claim that the original `npm test` invocation passed.
- Package dry-run, dependency audit, and diff whitespace checks passed.
- Independent integration review found mandatory-host-isolation and resumed-output disclosure defects; both were fixed, regression-tested, and approved on focused re-review.

No real-provider E2E or live terminal/Orca interaction was performed. Mocked and faux-provider tests exercise the integration contracts, not real gateway reliability or visual rendering on every terminal.
