# Subagents (vendored)

Subagents delegates tasks to a configurable fleet of Pi agents. This collection maintains an editable fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), with individual agents available by default and scripted workflows available after explicit opt-in. Requires **Pi >=1.3.0**.

## Upstream pin

| Field | Value |
| --- | --- |
| Package | `@tintinweb/pi-subagents` |
| Version / tag | **v0.23.1** |
| Commit | `9bb6c822bae9f4fe8d33384b715a5e2e96d5df10` |
| Previous vendor base | v0.22.0, `85a704cb8f35c96c0cabfa665b572bab296942e5` |
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

- **Foreground by default:** `Agent` waits for completion unless background execution is selected. An agent’s frontmatter takes precedence over the tool’s `run_in_background` argument, which takes precedence over `backgroundByDefault` (default `false`).
- **Default fleet:** `recon`, `worker`, and `reviewer` replace upstream Explore/Plan/general-purpose as the model-visible fleet, alongside three model-hidden council advisors (`council-argon`, `council-astra`, `council-opus`) loaded from `extensions/council/agents/` for cross-extension RPC deliberation. Unknown types fall back to `worker`; set `fallbackSubagent: "none"` to reject unknown types instead.
- **Package discovery is opt-in:** `packageAgents` and `packageWorkflows` default to `false`. Enable either in `subagents.json` (or specify a package allowlist) to discover explicitly declared resources from configured packages. Project trust still applies.
- **Nested delegation is opt-in per agent:** the new upstream delegation controls are available, but the embedded fleet does not gain recursive delegation automatically.
- **Scripted workflows are disabled by default pending reliability fixes:** `SubagentWorkflow`, the workflow inspector menu entry, and startup workflow execution are off unless `workflowsEnabled: true` is explicitly configured. Existing explicit opt-ins remain supported; set `workflowsEnabled: false` to disable them. Reload while no agents are running to apply changes to tool registration. When enabled, orchestration still requires an explicit user request.
- **Tool-requiring roles fail runs without tool calls:** agent frontmatter `require_tool_use: true` makes a run that ends normally (would be `completed` or `steered`) without calling a single tool settle as `error`: "<type> finished without calling any tool, though its role requires tools; the model may not have received its tool definitions. Its reply is kept below. Retry, or check the model route." The reply stays as the result. This catches a model route that drops the child's tool definitions, where the child answers "I have no tools available" and would otherwise look like a finished run. Only an agent's spawn run is checked: a resume may answer a follow-up in text alone. The rule is skipped when the run starts with no active tools. Embedded `recon`, `worker`, and `reviewer` set it; the council advisors and custom agents default to off. It applies to top-level, nested, and workflow children, and ejecting keeps the field.
- **Hidden agent types:** frontmatter `model_visible: false` keeps a type out of every model-facing path (the `Agent` tool's description and execution, the fallback, nested tools, `@type` mentions, workflows, schedules, and the subagent host); cross-extension RPC, the manager registry, and `/agents` still see it.
- **Context files for agents that ask:** frontmatter `context_files: true` loads AGENTS.md / CLAUDE.md as a main session would — the agent dir's global file, then the child's cwd and its ancestors, stopping at the first directory containing a `.git` entry, so a linked worktree's own file wins over its main checkout's. With `prompt_mode: append` the child then builds its own Pi prompt rather than cloning the parent's. Off by default.
- **Cross-extension RPC, protocol 3:** `subagents:rpc:send` steers or resumes an agent by id, `subagents:rpc:reopen` continues a persisted child session as a new agent, and spawns accept `notifyParent`, `retain`, `parentToolCallId`, and `linkData` (merged into the child's session link). Lifecycle events fire for every run and carry `sessionId`, `sessionFile`, and `runToolUses`. See [docs/rpc.md](docs/rpc.md).
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

Select an existing agent type with `subagent_type` (`agentType` in workflows). The resolved agent definition’s `model` is authoritative, including the embedded defaults below. If the definition has no model, the child inherits the current parent model. Agent tools and workflow scripts reject `model` overrides, including stale saved scripts. To change a type’s model, edit its agent definition. Trusted external hosts retain their own model bindings.

| Type | Job | Tools | Model defaults |
| --- | --- | --- | --- |
| `recon` | Read-only reconnaissance; compressed handoff | read-only; must call a tool | `claude-haiku-5-5` from any provider with credentials, thinking `max`, no tier override |
| `worker` | Bounded implementation and verification | coding tools; must call a tool | inherit parent |
| `reviewer` | Read-only severity-ranked review | read-only; must call a tool | inherit parent |
| `council-argon` | Read-only council advisor (`model_visible: false`, `isolation: off`) | read-only | `magpie/gemini-4-argon`, thinking `high`, no tier override |
| `council-astra` | Read-only council advisor (`model_visible: false`, `isolation: off`) | read-only | `magpie/gpt-6-astra`, thinking `xhigh`, no tier override |
| `council-opus` | Read-only council advisor (`model_visible: false`, `isolation: off`) | read-only | `magpie/claude-opus-5-5`, thinking `high`, no tier override |

The three council advisors are loaded from `extensions/council/agents/` and have `model_visible: false`, so they remain hidden from model-facing `Agent`, workflow, and nested delegation surfaces while remaining spawnable over cross-extension RPC. Custom `.md` files with the same name override embedded defaults through normal agent discovery; `disableDefaultAgents: true` hides all built-in defaults while leaving custom agents available.

The embedded fleet keeps Pi's built-in `grep`/`find` and inherits installed search extensions, including `npm:@ff-labs/pi-fff` (`fffind`/`ffgrep`). This also applies to nested agents through normal discovery. Explicit `extensions: false`, `exclude_extensions`, `disallowed_tools`, `ext:` selectors, and `isolated: true` still control which tools load. Custom definitions retain their chosen extension set. Read-only role instructions are not an OS sandbox.

`isolated: true` controls extension and MCP access; it does not create a separate working tree. File isolation uses `isolation: "worktree"`, subject to the project’s `worktreeIsolation` setting.

### Service tier

No embedded agent sets a service tier. Agent frontmatter is authoritative when set; for example, an OpenAI agent can request priority service with:

```yaml
model: openai/gpt-6-luna
thinking: max
service_tier: fast
```

Otherwise the `Agent` tool can pass `service_tier`. `fast` maps to provider `priority`; `standard` maps to `default`. Raw `priority`, `default`, `flex`, and `auto` are also supported. Compatible APIs are `openai-responses`, `openai-codex-responses`, and `cliproxyapi-codex-responses`. An unsupported explicit tool override is rejected; an incompatible frontmatter default is warned about and not applied. See `src/service-tier.ts`.

### Workflows

Scripted workflows are disabled by default because some validation failures return error text without an error flag, and reloads lose the in-memory run records required for resume. Enabling `workflowsEnabled: true` makes the tool available; its instructions still require an explicit user request before orchestration.

`SubagentWorkflow` executes JavaScript that composes agents with pipelines, parallel calls, structured results, and optional test gates. Children share the workflow’s working directory and current files by default. Set `isolation: "worktree"` on a workflow agent call when concurrent writers need separate copies, provided the project allows worktrees. Workflow calls use the script’s isolation option, not the agent definition’s `isolation` field. On successful cleanup, worktree changes are committed to a branch named in the result; applying them to the parent checkout is a separate action.

Saved scripts can be reused. Completed call prefixes can be replayed while the in-memory run record remains available.

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
