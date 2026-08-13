# CLIProxyAPI Native Compaction

A Pi extension that bridges [`@router-for-me/pi-cliproxyapi-provider`](https://www.npmjs.com/package/@router-for-me/pi-cliproxyapi-provider) to CLIProxyAPI's native OpenAI Responses compact endpoint.

It participates in Pi's ordinary compaction lifecycle and uses OpenAI's current remote-compaction-v2 contract:

```text
POST {CLIProxyAPI}/backend-api/codex/responses
input: [...conversation, { "type": "compaction_trigger" }]
```

Remote compaction v2 returns an opaque compaction item rather than a complete replacement transcript. The extension reconstructs the canonical window from retained user context plus that item, stores it in the Pi session, and appends only post-compaction turns on later requests.

## Install

Install this extension collection and the CLIProxyAPI provider:

```bash
pi install git:github.com/minhuw/pi-extensions
pi install npm:@router-for-me/pi-cliproxyapi-provider
```

Configure the provider normally, then select an eligible model. The extension remains inert for every provider, API, or model that does not pass its exact gate.

## Usage

Use Pi's ordinary `/compact` command for manual compaction. The extension also intercepts Pi's automatic threshold and overflow compaction paths for eligible models.

Run `/cliproxyapi-native-compaction` to inspect the current provider, API, model, endpoint, and gate result.

## Activation gate

OpenAI-compatible syntax alone does not enable native compaction. All of these must match:

- Provider: `cliproxyapi`
- API: `cliproxyapi-codex-responses`
- Model: explicitly allowlisted by exact ID

The default allowlist contains only `gpt-5.6-sol`. Kimi, Claude, Gemini, and other OpenAI-compatible models continue using Pi's built-in text-summary compaction.

## Configuration

Global configuration belongs at:

```text
~/.pi/agent/cliproxyapi-native-compaction.json
```

A trusted project may override it at `.pi/cliproxyapi-native-compaction.json`:

```json
{
  "enabled": true,
  "providerId": "cliproxyapi",
  "apiId": "cliproxyapi-codex-responses",
  "models": ["gpt-5.6-sol"],
  "fallbackToBuiltin": true
}
```

The `models` array uses exact model IDs deliberately. Add an alias only after verifying that CLIProxyAPI resolves it to a genuine OpenAI backend supporting `compaction_trigger` on `/responses`.

| Field | Default | Effect |
| --- | --- | --- |
| `fallbackToBuiltin` | `true` | If native remote compaction fails and the session has no native checkpoint yet, let Pi's built-in summarizer run instead of canceling. |

Optional environment overrides:

| Variable | Effect |
| --- | --- |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_MODELS` | Comma-separated exact model IDs. |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_ENDPOINT` | Explicit full normal `/responses` endpoint URL. Legacy `/responses/compact` values are rejected. |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_FALLBACK` | Override `fallbackToBuiltin` (`true` / `false`). |

## Overlapping GPT backends

The extension sends compaction to the same Responses route as normal Codex turns. This matters because CLIProxyAPI versions through v7.2.131 treat a generic 404 from the legacy dedicated `/responses/compact` upstream as a 12-hour credential/model cooldown. When ChatGPT no longer exposes that route, the next request appears as `auth_unavailable`, even though the OAuth token is still valid.

Remote compaction v2 avoids that failure mode and follows the current Codex contract. Routing can still fail if the same model name is shared by incompatible providers; native compacted state remains account/backend-bound, so use an exact Codex-only model alias where possible.

If native compact fails and the session has **no** native checkpoint yet, the extension falls back to Pi's built-in text summarizer (`fallbackToBuiltin`, default on). That summary is portable across backends.

Once a native checkpoint exists, fallback is refused — the discarded transcript is only recoverable through the opaque Codex window.

## Failure and compatibility behavior

A malformed compact response, authentication failure, model mismatch, or network error does not replace history with incomplete data. When no native checkpoint exists, those failures fall back to Pi's built-in summarizer. After a native checkpoint exists, they cancel compaction instead.

Sessions created by extension version 1 used the legacy dedicated endpoint. Their stored version-1 checkpoints remain readable and replayable; newly created checkpoints use remote compaction v2.

Once a session contains an opaque OpenAI checkpoint, switching it to an incompatible model is blocked because that model cannot safely recover the discarded transcript.

The implementation accepts both opaque item names encountered in supported Responses flows:

- `compaction`, used by the public Responses API.
- `compaction_summary`, observed through CLIProxyAPI's Codex backend route.

For legacy version-1 checkpoints, the complete dedicated-endpoint `output` array remains preserved. For new version-2 checkpoints, the extension follows Codex's retention shape: user context is retained within a bounded token budget, obsolete reasoning/tool/assistant history is dropped, and the single opaque compaction item is appended.

## Attribution and license

Parts of the Pi lifecycle and history conversion are adapted from Can Celik's MIT-licensed [`pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction). See the included [MIT license notice](LICENSE).
