# CLIProxyAPI native compaction

This Pi extension bridges `@router-for-me/pi-cliproxyapi-provider` to CLIProxyAPI's native OpenAI Responses compact endpoint.

It intercepts Pi's compaction lifecycle, calls:

```text
POST {CLIProxyAPI}/backend-api/codex/responses/compact
```

and stores the returned canonical compacted window in the Pi session. Later provider requests replace the discarded transcript with that window and append only post-compaction turns.

## Safety boundary

OpenAI-compatible syntax alone does not enable native compaction. All of these must match:

- provider: `cliproxyapi`
- API: `cliproxyapi-codex-responses`
- model: explicitly allowlisted

The default allowlist contains only `gpt-5.6-sol`. Models such as Kimi, Claude, or Gemini continue using Pi's built-in text-summary compaction.

## Usage

Use Pi's ordinary `/compact` command for manual compaction. Pi's normal threshold and overflow compaction paths are intercepted automatically for eligible models.

Run `/cliproxyapi-native-compaction` to see whether the selected model currently passes the gate.

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
  "models": ["gpt-5.6-sol"]
}
```

The `models` array uses exact model IDs deliberately. Add an alias only after verifying that CLIProxyAPI resolves it to a genuine OpenAI backend supporting `/responses/compact`.

Optional environment overrides:

- `PI_CLIPROXYAPI_NATIVE_COMPACTION_MODELS`: comma-separated exact model IDs
- `PI_CLIPROXYAPI_NATIVE_COMPACTION_ENDPOINT`: explicit full compact endpoint URL

## Failure behavior

The extension fails closed. A malformed compact response, authentication failure, model mismatch, or network error cancels compaction rather than replacing history with incomplete data. Once a session contains an opaque OpenAI checkpoint, switching it to an incompatible model is blocked because that model cannot safely recover the discarded transcript.

The implementation accepts both opaque item names currently encountered in practice:

- `compaction` (public Responses documentation)
- `compaction_summary` (observed through the CLIProxyAPI Codex backend route)

The complete compact endpoint `output` array is always preserved without pruning.

Parts of the Pi lifecycle and history conversion are adapted from Can Celik's MIT-licensed [`pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction). Its license notice is included in this directory.
