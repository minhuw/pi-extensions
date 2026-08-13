# CLIProxyAPI Native Compaction

A Pi extension that bridges [`@router-for-me/pi-cliproxyapi-provider`](https://www.npmjs.com/package/@router-for-me/pi-cliproxyapi-provider) to CLIProxyAPI's native OpenAI Responses compact endpoint.

It participates in Pi's ordinary compaction lifecycle, sends the current conversation window to:

```text
POST {CLIProxyAPI}/backend-api/codex/responses/compact
```

and stores the returned canonical compacted window in the Pi session. Later requests replace the discarded transcript with that window and append only post-compaction turns.

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

The `models` array uses exact model IDs deliberately. Add an alias only after verifying that CLIProxyAPI resolves it to a genuine OpenAI backend supporting `/responses/compact`.

| Field | Default | Effect |
| --- | --- | --- |
| `fallbackToBuiltin` | `true` | If native `/responses/compact` fails and the session has no native checkpoint yet, let Pi's built-in summarizer run instead of canceling. |

Optional environment overrides:

| Variable | Effect |
| --- | --- |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_MODELS` | Comma-separated exact model IDs. |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_ENDPOINT` | Explicit full compact endpoint URL. |
| `PI_CLIPROXYAPI_NATIVE_COMPACTION_FALLBACK` | Override `fallbackToBuiltin` (`true` / `false`). |

## Overlapping GPT backends

CLIProxyAPI still resolves `/backend-api/codex/responses/compact` by **model name**, not by the Codex path. If `gpt-5.6-sol` is advertised by both Codex and an OpenAI-compatible provider (for example MiniMax), compact can fail with:

```text
auth_unavailable: no auth available (providers=codex,openai-compatible-minimax router, model=gpt-5.6-sol)
```

The extension does not try to pin that router to Codex. A native compact window is encrypted to the Codex account that created it, so later turns in that session would have to stay on Codex anyway.

If native compact fails and the session has **no** native checkpoint yet, the extension falls back to Pi's built-in text summarizer (`fallbackToBuiltin`, default on). That summary is portable across backends.

Once a native checkpoint exists, fallback is refused — the discarded transcript is only recoverable through the opaque Codex window.

## Failure and compatibility behavior

A malformed compact response, authentication failure, model mismatch, or network error does not replace history with incomplete data. When no native checkpoint exists, those failures fall back to Pi's built-in summarizer. After a native checkpoint exists, they cancel compaction instead.

Once a session contains an opaque OpenAI checkpoint, switching it to an incompatible model is blocked because that model cannot safely recover the discarded transcript.

The implementation accepts both opaque item names encountered in supported Responses flows:

- `compaction`, used by the public Responses API.
- `compaction_summary`, observed through CLIProxyAPI's Codex backend route.

The complete compact endpoint `output` array is preserved without pruning.

## Attribution and license

Parts of the Pi lifecycle and history conversion are adapted from Can Celik's MIT-licensed [`pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction). See the included [MIT license notice](LICENSE).
