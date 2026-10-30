# Subagents (vendored)

Editable fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents): autonomous subagents and scriptable multi-agent workflows for Pi. Requires **Pi >=1.3.0** in this collection.

## Upstream pin

| Field | Value |
| --- | --- |
| Package | `@tintinweb/pi-subagents` |
| Version / tag | **v0.22.0** |
| Commit | `85a704cb8f35c96c0cabfa665b572bab296942e5` |
| Previous vendor base | v0.14.3, `c10b1836256e760da75296ccd4e57a77ada1325e` |
| Entry | [`src/index.ts`](./src/index.ts) |

[Upstream documentation](UPSTREAM.md), [changelog](CHANGELOG.md), and [local patch ledger](LOCAL-PATCHES.md). The local behavior described here takes precedence over upstream defaults.

## Install

```bash
pi install git:github.com/minhuw/pi-extensions
# or local:
pi install /absolute/path/to/pi-extensions
# only this extension:
pi -e ./extensions/subagents/src/index.ts
```

Do **not** also install `npm:@tintinweb/pi-subagents` in the same Pi profile. After updating Pi and this collection, restart Pi or `/reload` while no agents are running. Existing agent definitions and `subagents.json` settings remain supported; no settings or session data migration is performed.

## Local defaults and compatibility

- **Foreground by default:** `Agent` still waits unless `run_in_background: true` is requested. Upstream's `backgroundByDefault` setting is supported, but defaults to `false` here.
- **Default fleet:** `recon`, `worker`, `reviewer`, and `expert` replace upstream Explore/Plan/general-purpose. Unknown types fall back to `worker`; set `fallbackSubagent: "none"` to reject unknown types instead.
- **Package discovery is opt-in:** `packageAgents` and `packageWorkflows` default to `false`. Enable either in `subagents.json` (or specify a package allowlist) to discover explicitly declared resources from configured packages. Project trust still applies.
- **Nested delegation is opt-in per agent:** the new upstream delegation controls are available, but the embedded fleet does not gain recursive delegation automatically.
- **Scripted workflows are disabled by default pending reliability fixes:** `SubagentWorkflow`, the workflow inspector menu entry, and startup workflow execution are off unless `workflowsEnabled: true` is explicitly configured. Existing explicit opt-ins remain supported; set `workflowsEnabled: false` to disable them. Reload while no agents are running to apply changes to tool registration. When enabled, orchestration still requires an explicit user request.
- **Background completion delivery changed:** upstream now batches completions at the parent's turn boundary, with an idle-parent delivery path, rather than relying only on a short notification timer.
- **Local integrations remain:** service tiers, scoped host/telemetry ownership, Orca busy-state coordination, and compact invocation/model metadata.
- **External agents:** agents other extensions publish in the shared `pi-extensions.external-agents` registry, such as [Herder](../herder/README.md)'s steps, appear in the widget under their own group heading, in the fleet list, and in `/agents → Running agents`. Their live conversation opens read-only: Subagents cannot stop, steer, or background them. Each Pi session sees only the agents it started. The contract is documented in `src/external-agents.ts`.

Settings live in the global or project `subagents.json`; see [upstream configuration](UPSTREAM.md) for locations and precedence. For example:

```json
{
  "backgroundByDefault": false,
  "workflowsEnabled": false,
  "packageAgents": false,
  "packageWorkflows": false,
  "fallbackSubagent": "none"
}
```

## Usage

Default tools: `Agent`, `get_subagent_result`, and `steer_subagent`. Use `/agents` for the fleet and settings. Custom agent definitions can override embedded names; upstream also supports mentions. `SubagentWorkflow` and its inspector are available only after explicit configuration opt-in.

Select an existing agent type with `subagent_type` (`agentType` in workflows). Its user-configured frontmatter `model` is authoritative; without one, the child inherits the current parent model. Agent tools and workflow scripts reject `model` overrides, including stale saved scripts. To change a type's model, edit its agent definition. Trusted external hosts retain their own model bindings.

| Type | Job | Tools | Model defaults |
| --- | --- | --- | --- |
| `recon` | Read-only reconnaissance; compressed handoff | read-only | `openai/gpt-6-luna`, thinking `max`, fast tier |
| `worker` | Bounded implementation and verification | coding tools | inherit parent |
| `reviewer` | Read-only severity-ranked review | read-only | inherit parent |
| `expert` | Read-only advice on plans, designs, tradeoffs, and complicated technical questions; selected by user/parent for difficult judgment, not routine questions | read-only | `magpie/gpt-6-astra`, thinking `xhigh`, no tier override |

A custom `expert.md` overrides the embedded Expert through normal agent discovery. `disableDefaultAgents: true` hides Expert along with the other built-ins; custom agents remain available.

The embedded fleet keeps Pi's built-in `grep`/`find` and inherits installed search extensions, including `npm:@ff-labs/pi-fff` (`fffind`/`ffgrep`). This also applies to nested agents through normal discovery. Explicit `extensions: false`, `exclude_extensions`, `disallowed_tools`, `ext:` selectors, and `isolated: true` still control which tools load. Custom definitions retain their chosen extension set. Read-only role instructions are not an OS sandbox.

### Service tier

Recon defaults to fast tier, which requests OpenAI priority service. Agent frontmatter is authoritative when set; for example:

```yaml
model: openai/gpt-6-luna
thinking: max
service_tier: fast
```

Otherwise the `Agent` tool can pass `service_tier`. `fast` maps to provider `priority`; `standard` maps to `default`. Raw `priority`, `default`, `flex`, and `auto` are also supported. Compatible APIs are `openai-responses`, `openai-codex-responses`, and `cliproxyapi-codex-responses`. An unsupported explicit tool override is rejected; an incompatible frontmatter default is warned about and not applied. See `src/service-tier.ts`.

### Workflows

Scripted workflows are disabled by default because validation errors can be swallowed as successful empty results, and reloads lose the in-memory run records required for resume. If explicitly enabled, `SubagentWorkflow` executes JavaScript that composes agents with pipelines, parallel calls, structured results, and optional test gates. Saved scripts can be reused, and completed call prefixes can be replayed while the run record remains available.

## Verification

From the repository root:

```bash
npm run typecheck:subagents
npm run test:subagents
```

The suite includes imported upstream regression tests and local compatibility tests. The default command uses offline/faux providers, not paid provider-backed tests. The collection's `npm run typecheck` also checks Subagents through its dedicated strict configuration.

## Resync

1. Compare the pinned tag with the next release; read its changelog and dependency requirements.
2. Three-way merge `src/` against the previous upstream base. Update `test/`, `examples/`, `docs/`, `UPSTREAM.md`, `CHANGELOG.md`, and `LICENSE` from the same tag.
3. Reconcile the [local patch ledger](LOCAL-PATCHES.md); prefer upstream implementations where they replace local patches. Preserve deliberate local defaults and integration contracts.
4. Update the root dependency lock and test fixtures for the supported Pi SDK. Run Subagents typechecking/tests and the full safe collection suite. Do not enable live E2E implicitly.
5. Update the pin and record any selective post-release backports separately; do not claim an unmodified upstream snapshot.

## License

[MIT](LICENSE), Copyright (c) 2026 tintinweb. Preserve the upstream license when distributing. Collection registration and local packaging are under the [repository MIT license](../../LICENSE).
