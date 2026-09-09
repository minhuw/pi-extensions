# CLIProxyAPI Provider

Editable vendored source from the **locally installed @router-for-me/pi-cliproxyapi-provider 1.4.15 snapshot**, not a pristine npm release. It preserves the installed catalog-protection, WebSocket/retry, and pricing customizations. Upstream: [Router-For.ME/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider); copyright Router-For.ME, [MIT licensed](LICENSE).

The collection registers one entrypoint: `index.ts` awaits the provider factory in `src/index.ts`, then registers `src/tps.ts` for elapsed-time/TPS telemetry. It loads before Statusline Footer and [Native Compaction](../cliproxyapi-native-compaction/README.md).

## Setup

Install this collection as described in the [root README](../../README.md#install). **Do not also load `npm:@router-for-me/pi-cliproxyapi-provider` in the same Pi profile**: the vendored provider replaces it, including TPS. Remove the duplicate package registration when migrating; keep your existing credentials and configuration.

Use `/login CLIProxyAPI` or `/login cliproxyapi`, then enter the proxy base URL (default `http://127.0.0.1:8317`) and API key. Login validates the models endpoint before saving configuration and registering models. Existing names and locations are unchanged (under Pi's agent directory, normally `~/.pi/agent/`):

- `cliproxyapi.json`: `baseUrl`, `apiKey`, optional `providerId`, `providerName`, `fast`, and `pause`.
- `auth.json`: existing Pi-managed login credentials.
- `cliproxyapi-models.json`: endpoint-matched model catalog cache.

Non-interactive setup still supports `CLIPROXYAPI_BASE_URL` and `CLIPROXYAPI_API_KEY`; connection precedence is environment, config, stored login, then the default base URL. `CLIPROXYAPI_PROVIDER_ID`, `CLIPROXYAPI_PROVIDER_NAME`, and `CLIPROXYAPI_FAST` remain supported. Default provider/API identities are `cliproxyapi` / `cliproxyapi-codex-responses`.

## Commands

- `/fast`: toggle the persisted Fast preference; advertised Fast-capable models use the priority service tier and refreshed pricing.
- `/pause`: persistently gate subsequent provider requests; it does not interrupt an in-flight request.
- `/continue`: release that pause.
- `/cliproxyapi-refresh`: force a model-catalog refresh using the current connection.

## Catalog safety

The models endpoint accepts a JSON array, `{ "models": [...] }`, or `{ "data": [...] }`. Truncated JSON, body-read failures, and invalid envelopes reject the refresh even after a successful HTTP status. They do not overwrite the known-good model cache.

A refresh yielding no usable models (including a hidden-only catalog) is rejected when a populated cache exists for the **same endpoint**, including forced refresh and Fast-mode changes. A valid empty catalog during initial setup or for an unmatched endpoint is allowed; a legitimate smaller **nonempty** catalog is also allowed. This is not a blanket ban on catalog shrinkage. Aborted or superseded refreshes cannot commit cache writes.

Startup can use cached models while refreshing in the background. A failed refresh keeps the cached list; it does not report a successful empty replacement.

## Runtime and development

`src/` is maintained here so local changes are editable and reviewable, not to prohibit edits or require npm republishing. A local-path collection installation loads these TypeScript sources on extension load; editing them does **not** automatically reload existing Pi sessions. Start a new session or explicitly reload when ready. `/cliproxyapi-refresh` refreshes catalog data, not extension source.

The Codex transport derives a patched module at runtime from the host Pi AI `openai-codex-responses` implementation. It permits plain proxy keys, preserves custom provider/API identities, and retains the installed WebSocket/retry behavior rather than silently falling back to SSE. The generated module lives in a hash-named temporary cache; host `node_modules` source is not rewritten. Source-pattern checks may reject an incompatible future Pi AI version, so host upgrades need compatibility verification. Pricing still uses models.dev with its existing cache behavior.

Run from the repository root with Node >=22.19.0:

```bash
npm run test:cliproxyapi-provider
npm run typecheck
```

The provider test runs all 53 copied catalog regression scenarios with mocked fetch and temporary directories, plus an offline mocked entrypoint/registration check. It needs no proxy credentials or model calls. See [upstream](https://github.com/router-for-me/pi-cliproxyapi-provider#readme) for broader reference; the catalog failure behavior above describes this patched snapshot.
