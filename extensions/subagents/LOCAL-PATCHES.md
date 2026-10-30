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
| Default fleet | `src/default-agents.ts`, `src/agent-types.ts`, runner/workflow defaults | `recon` / `worker` / `reviewer` / `expert`; Expert is a read-only advisor selected by the user/parent for difficult judgment, pinned to `magpie/gpt-6-astra` with `xhigh` thinking and no tier override. User `expert.md` overrides and disabling defaults use the normal registry. Recon defaults to `openai/gpt-6-luna`, max thinking, and fast tier. Canonical fallback is `worker`, not an absent upstream `general-purpose` agent. Built-in search remains available without an external search dependency. Installed extensions, including `npm:@ff-labs/pi-fff` when present, are inherited by default agents and nested children through normal extension discovery; FFF is optional and is not a required dependency. Explicit agent extension restrictions continue to apply. |
| Service tiers | `src/service-tier.ts`, types, config, runner, manager, schedule, tool entry | Agent-file tier takes precedence over a spawn override; compatible streams receive the normalized provider tier. |
| Scoped host | `src/host-registry.ts`, manager and entry | Preserve registration ownership and host spawning. Generic resume/stop/steer cannot take over externally owned agents; parent cancellation remains effective. |
| Telemetry | manager and entry | Preserve ownership, parentage, activity, turn count, usage, and bounded response metadata. |
| Activity reporting | `src/index.ts`, `tests/workflow-busy.test.ts` | Publish per-agent/workflow snapshots on `pi-extensions:activity` and replay on `pi-extensions:activity-request`. Only the root host publishes; release on shutdown. Orca Bridge owns transport and presentation. Large fleets retain 127 detailed entries plus a counted overflow entry. |
| Invocation UI | `src/ui/`, entry | Preserve compact actual model/thinking/tier and invocation details while retaining upstream fullscreen, costs, and render caching. |
| Default policies | invocation config, settings, package resources | Foreground by default; scripted workflows and package discovery require explicit configuration opt-in. Workflows default off pending error-reporting and reload-recovery fixes; the tool, inspector entry, and startup execution are gated together. Existing explicit settings continue to win. |
| Workflow primitives | `src/workflow/`, `src/structured-output.ts` | Runtime, metadata, journal, progress, JSON Schema, and worker-source primitives live under `src/workflow/`; structured output lives at `src/structured-output.ts`. Keep attribution/license with the code. Subagents owns the only scripted-workflow frontend (`SubagentWorkflow`) and retains its isolation and resume support. |
| Agent frontmatter | `src/agent-definitions.ts`, `src/custom-agents.ts` | Subagents owns the zero-dependency frontmatter parser and normalizer; `custom-agents.ts` preserves its parser export. Keep aliases, inline lists, block scalars, names, disabled entries, tool selectors, and model/thinking/tier fields compatible. The parser enforces no capability boundary by itself. |
| Model selection | Agent/nested tool schemas, invocation boundaries, `src/workflow/`, guidance/tests | LLMs select an existing agent type: its user-configured model is authoritative, otherwise inherit the current parent model. Reject raw `model` fields before spawning, scheduling or resuming, including old workflow script requests. No discovery tool or LLM model override. Preserve trusted host bindings, central resolution APIs, provider configuration, and actual session/journal model metadata. |
| External agents | `src/external-agents.ts`, `src/ui/agent-widget.ts`, `src/ui/fleet-list.ts`, `src/ui/conversation-viewer.ts`, entry, `tests/external-agents*.test.ts` | Read agents other extensions publish on `globalThis[Symbol.for("pi-extensions.external-agents")]` (`{ agents: Map<id, ExternalAgent>, listeners: Set<(id) => void> }`; Herder keeps an identical copy of the contract). Show only entries whose `ownerSessionId` is absent or the current session's: in the widget under their `group` heading in the native row format, after Subagents' own and with the same turn linger; in the fleet list while they have a live session; and in `/agents → Running agents`, which opens a read-only conversation viewer (`nameLabel`, no stop/steer/background). Activity, turns, usage, and compactions come from subscribing to the entry's live `AgentSession`, mirroring `observeRun`. Never modify, stop, or remove external entries; release every subscription and the registry listener on shutdown. |
| Child-session hooks | `src/child-session-hooks.ts`, runner, manager, nested tools, workflow host, `src/mention-clone.ts`, entry; `tests/child-session-hooks.test.ts`, `tests/mention-clone-hooks.test.ts` | Lets a capture extension (pika) see every child session without the two extensions importing each other. Every child AgentSession (top-level, nested, workflow, and the @mention conversation clone; all, allowlist, none, and isolated extension modes) appends each `{ name, extensionFactory }` in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` last to its `extensionFactories` as a named factory; the allowlist/exclude override never filters it. While a hook is registered, every new child is persisted with `SessionManager.create` (same session-dir resolution and `parentSession` header), including nested and `persist_session: false` children, and gets a `pi-extensions.session-link` custom entry (`kind: "subagent"`, parent session id/file, spawning tool call, agent, parent agent, workflow, type, description) before its first prompt. While a hook is registered, the @mention clone loads the hook factories and is persisted in the same session directory with the same `parentSession` header: its file is the SDK-built header followed by the parent's root-to-leaf entries verbatim, then a link entry (`agentType` of the mentioned agent, `description: "@mention clone"`, parent session id/file), a session name, and extension binding before its prompt; it emits `session_shutdown` on disposal. Without hooks, loading and persistence are unchanged and no link entry is written; the clone stays in memory. `subagents:record` covers top-level agents only and additionally carries `sessionId`, `sessionFile`, `outputFile`, and `toolCallId` (the spawning call) when known; readers must treat them as optional. Nested and workflow children write no record; their link entries carry `parentAgentId` and `workflowId`. RPC spawns cannot set `parentToolCallId`. |
| Pi SDK baseline | root manifest, runner/entry and regression fixtures | Pi >=1.3.0; development dependencies and compatibility checks target Pi SDK 1.4.0. |

## Selective post-release backports

These do not change the declared release base:

- [`d7c9ec0`](https://github.com/tintinweb/pi-subagents/commit/d7c9ec0): enforce `max_turns` and count turns on resumed agents.
- [`ca93a52`](https://github.com/tintinweb/pi-subagents/commit/ca93a52): make inline resumes stoppable, retain the spawn budget, and pass nested `max_turns` through resume.

The intervening main-branch usage-event and RPC-steer features are not implied by these backports.

Integration review also required two local corrections: standalone Subagents host delegation rejects agent frontmatter that disables its mandatory isolation, and foreground resumes report turn-limit/user-stop outcomes in model-visible text instead of presenting partial output as an ordinary completed answer. Both have regression coverage.

## Tests and deliberate adaptations

Maintenance cleanup shares the config projection for selected and fallback agents while retaining the disabled/missing-worker defaults. Source comments describe current contracts; tests omit duplicate assertions and checks for artifacts deleted during earlier migrations. Keep behavioral coverage for dispatch, prompt loading, cancellation, and worktree gate ordering.

`test/` is the imported upstream suite, adapted where the default fleet, foreground/package policy, SDK 1.3 APIs, or collection layout differs. `tests/` holds local compatibility regressions. The scoped Vitest configuration prevents the default collection command from spending real provider credits, and its setup file `tests/support/isolated-agent-dir.ts` gives each test file an empty temporary `PI_CODING_AGENT_DIR`, so real pi sessions never read the developer's `~/.pi/agent` settings or install the packages listed there. Keep assertions for upstream correctness fixes; do not silence failures simply because a file was vendored.

The dedicated TypeScript configuration checks the source and is invoked by root `npm run typecheck`. Root SDK-fixture updates are part of the upgrade where Pi's event/API contracts changed.

## Upgrade verification

The current development baseline is Pi SDK 1.4.0. The 1.4 update retains the tool-scope activation and call gates: native resumed-tool restoration does not replace an agent's explicit tool restrictions. Native codemode now queues at worker capacity; no extension-owned worker-pool workaround is needed.

The original vendor-upgrade results below were checked with Pi SDK 1.3.0 and Vitest 4.1.12:

- Collection and Subagents strict typechecks passed.
- Subagents: **123 files, 2,459 passing tests**; seven real-provider cases intentionally skipped. An ambient `PI_E2E_LIVE=1` still selected faux providers, and explicit live harness requests were rejected before credential discovery.
- CLIProxyAPI Provider, Magpie/shared compaction, native compaction, Commit, Statusline, and Writer checks passed.
- Herder: **252 integration tests** passed. The first full collection run timed out during the unbounded unit phase with several test deadline failures; rerunning all **1,044 unit tests** at two-file concurrency passed. The smoke runner now uses that same bound for both phases. These are separate verification runs, not a claim that the original `npm test` invocation passed.
- Package dry-run, dependency audit, and diff whitespace checks passed.
- Independent integration review found standalone Subagents mandatory-host-isolation and resumed-output disclosure defects; both were fixed, regression-tested, and approved on focused re-review.

No real-provider E2E or live terminal/Orca interaction was performed. Mocked and faux-provider tests exercise the integration contracts, not real gateway reliability or visual rendering on every terminal.
