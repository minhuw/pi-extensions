# Native compaction through Magpie

Magpie Provider includes its own native-compaction integration. Its protocol and replay engine lives in `extensions/magpie-provider/native-compaction/`, alongside its configuration and lifecycle integration. The legacy CLIProxyAPI extensions are no longer included in this collection.

**Enabled by default, experimental and unverified live:** the Magpie protocol assessment inspected commit `1755713`; no live gateway/upstream compaction has been run. Automatic eligibility uses known OpenAI/Codex namespaces as an identification heuristic, not runtime proof of native capability. The remote Magpie provider still requires `compaction=native`.

## Automatic eligibility and setup

With no configuration file, defaults are `enabled: true` and `fallbackToBuiltin: true`. When `models` is omitted, the integration derives a deduplicated exact allowlist from the synchronous Pi model registry: provider `magpie`, API `openai-responses`, and concrete `openai/<model>` or `codex/<model>` IDs. The remaining ID must be nonempty, without whitespace or wildcard patterns. There is no model-version gate: `codex/gpt-6.1-sol`, future GPT names, and OpenAI o-series names qualify if advertised on Responses. Groups, other providers/APIs, and other namespaces (including the usual DeepSeek and Claude routes) are not automatically enabled. An alias under `openai/` or `codex/` is treated as belonging to that namespace; the client cannot prove its actual upstream from the name.

The registry alone is used; a stale selected model absent from it does not enable new native compactions. No extra network request or remote-settings lookup is made. An OpenAI-looking name or Responses endpoint is not proof that the backend supports native compaction.

Only try this with a disposable session and a **concrete Responses model whose upstream supports native compaction**, not a routing group or translated Chat/Anthropic model.

1. On your remote Magpie server, enable native compaction for that upstream provider (off by default):

   ```sh
   magpie provider set <provider-id> compaction=native
   ```

   Magpie's provider editor also exposes a Compaction row. Without this setting, Magpie can generate its own portable summary rather than the upstream's sealed checkpoint. A successful response alone is not proof of native upstream compaction.

2. Run `/reload`, then open `/model` to refresh the catalog and select the exact Magpie model. Run `/magpie-native-compaction`: an eligible model should show **Enabled** and its exact ID in the allowlist without a config file.

3. For verification, optionally create `~/.pi/agent/magpie-native-compaction.json` (under `PI_CODING_AGENT_DIR` when set) with `{"fallbackToBuiltin": false}`. Use ordinary `/compact`, then send another turn and resume the disposable session to verify checkpoint replay. Disabling fallback prevents ordinary text summarization from masquerading as native success.

### Explicit configuration and optouts

Other custom provider namespaces/aliases require an explicit exact `models` list after verifying the actual backend; their names do not prove capability:

```json
{
  "enabled": true,
  "models": ["<provider-id>/<verified-model-id>"],
  "fallbackToBuiltin": false
}
```

Use exact IDs from `/v1/models`, without Pi's outer `magpie/` prefix. An explicit `models` array **replaces**, rather than extends, automatic discovery. `models: []` intentionally disables all new native compactions; `enabled: false` is also honored. Remove the `models` key from an old config to restore automatic discovery, and remove or change `enabled: false` if you want to enable it. Groups, wildcard patterns, unknown configuration fields, and malformed values are rejected.

A trusted project's `.pi/magpie-native-compaction.json` overrides individual global fields; untrusted project files are ignored. A global explicit list stays in effect unless a trusted project replaces it. The provider/API are fixed to `magpie`/`openai-responses`; there is no endpoint override or separate credential store. Configuration is read when needed; no files are changed or migrated automatically. Invalid configuration cancels compaction rather than silently falling through.

By default, an unsuccessful **first** native attempt may use Pi's ordinary summarizer. After a native checkpoint exists, failures cancel compaction instead: a text summary cannot recover the opaque history. Disabling native compaction or removing the model from the allowlist stops new native compactions but does not discard a saved checkpoint or disable its safe replay.

## Protocol and checkpoint compatibility

The engine sends Codex remote-compaction-v2 to the effective gateway's ordinary Responses endpoint, using Pi's resolved gateway URL and credentials (including `/login magpie` settings, even if the selected model still carries an older URL):

```text
POST http://127.0.0.1:3425/v1/responses
{"model":"<provider>/<model>","stream":true,"instructions":"","input":[...,{"type":"compaction_trigger"}]}
```

The request accepts SSE (`text/event-stream`) and JSON. For SSE, only the terminal `response.completed` response is validated and stored; partial output items, failed/incomplete/error events, and streams ending without completion cannot create a checkpoint. JSON responses remain supported.

Streaming is required for Magpie to relay native compaction to stream-only Codex accounts. The old non-streaming request could instead fail with the misleading “Codex doesn't serve … on the Responses API” error even when native compaction was enabled.

The returned opaque item is stored in the Pi session. On later turns, the `before_provider_request` hook restores the canonical Responses history and appends post-checkpoint turns; Pi's ordinary Responses serializer alone does not replay the checkpoint.

Magpie rejects the legacy `/responses/compact` route for Magpie-qualified models. The integration uses `/v1/responses`, not that legacy route.

The engine deliberately retains the historical checkpoint kind `cliproxyapi-openai-native-compaction` and reads version-1 and version-2 checkpoints. This is a persisted format identifier, **not a runtime dependency**. Existing Magpie checkpoints produced with the old experimental bridge remain readable, including their exact provider/API/model binding. CLIProxyAPI-bound checkpoints are not silently migrated to Magpie and cannot be replayed under a different model identity.

## Migrating from the experimental CLIProxyAPI recipe

Older instructions retargeted `cliproxyapi-native-compaction.json` to Magpie. Magpie now reads only `magpie-native-compaction.json`; copy the verified model IDs and desired enable/fallback settings into the new file. Do not copy `providerId`, `apiId`, or `endpoint` fields. No old configuration is read or migrated automatically.

Remove any explicit Pi settings entries for the removed CLIProxyAPI extension paths or separately installed legacy wrappers. This collection does not edit user settings, saved credentials, or legacy configuration files.

## Verification and remaining risks

Offline tests cover the Magpie configuration and lifecycle, history/transport logic, checkpoint replay, exact gates, malformed history, and fallback/cancellation safeguards. A standalone-loading test copies only the Magpie directory into a temporary package to check that it loads without sibling extensions.

These tests do **not** prove compatibility with a running gateway or upstream. Offline transport tests cover Magpie's stream-only relay gate, split/multiline SSE frames, terminal failures, cancellation, and JSON compatibility. Validate streaming with your actual gateway/upstream, plus tools, cancellation, a second compaction, and session resume before using important sessions.

A sealed checkpoint is bound to its writer. Magpie records that affinity and refuses incompatible rerouting; losing or disabling the account, hitting its quota, or losing the checkpoint-affinity record can prevent continuation. Magpie currently retains at most 1,024 writer records for 30 days. Do not delete its `compactions.json` to troubleshoot an active compacted session. Switching to another provider/model is blocked after an opaque checkpoint; use a new session instead. Changing `/login magpie` to a different gateway or account does not make old checkpoints portable either; start a new session when changing their backend.

Magpie allows native compaction for groups only when every member qualifies, but that is not a portability guarantee. This initial integration rejects groups in its allowlist.

## Source evidence

- [Magpie native compaction and writer affinity](https://github.com/yetone/magpie/blob/1755713/internal/gateway/native_compaction.go)
- [Magpie Responses and legacy compact routing](https://github.com/yetone/magpie/blob/1755713/internal/gateway/codex_backend.go)
- [Magpie provider setting and restrictions](https://github.com/yetone/magpie/blob/1755713/internal/provider/native_compaction.go)
- [Magpie gateway-routing documentation](https://github.com/yetone/magpie/blob/1755713/docs/subsystems/gateway-routing.md)

The engine includes its original MIT attribution in `extensions/magpie-provider/native-compaction/LICENSE`.
