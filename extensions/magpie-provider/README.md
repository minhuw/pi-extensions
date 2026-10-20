# Magpie provider

A standalone native Pi provider named `magpie`. It discovers the running Magpie gateway's chat models and delegates streaming to Pi's existing OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages implementations. It does not replace other providers or implement a transport/parser.

## Use

Start Magpie separately, then load this extension (or the containing Pi package):

```sh
pi -e ./extensions/magpie-provider/index.ts
```

Run `/login magpie` for interactive setup, then use `/model` to select a discovered Magpie model. Enter the gateway URL (blank accepts the displayed current/local default), then its API key in the **secret** prompt. Blank keys use `magpie-pi` only for loopback; remote gateways require a newly entered key. Login never reuses a stored or environment key, even when the URL is unchanged. It validates authenticated `/v1/models` before Pi atomically saves the key and canonical URL in its credential store. An empty valid catalog is allowed at login. Failed/cancelled validation leaves the existing credential and catalog untouched. This is one native API-key method, not OAuth or a separate command.

The extension marks the key prompt as secret, but masking is controlled by Pi's client. The Pi TUI implementation inspected renders ordinary input even for secret prompts; avoid screen sharing or terminal recording while entering a key.

Discovery finishes before provider registration, so startup model selection and model listing can see the catalog. IDs are preserved exactly, including `group/foo`. Startup reads only Magpie's optional saved credential through Pi's public read-only helper; no other credentials are resolved. Environment-only setup remains supported:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425` | HTTP(S) gateway origin; an optional trailing `/v1` or `/v1/` is removed. |
| `MAGPIE_API_KEY` | `magpie-pi` on loopback only | Bearer credential for discovery and fallback request authentication. Required for remote gateways. |

Loopback means `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1`, not arbitrary names resolving locally. Userinfo, queries, fragments, other URL paths, and non-HTTP(S) protocols are rejected. Use HTTPS for remote gateways: explicit HTTP sends credentials without encryption. Configuration errors are surfaced during extension loading.

Saved URL/key take precedence over environment values per field; older saved keys without a URL use the environment/local URL. Native refresh uses Pi's effective credential, including its URL. A remote URL without a key still registers so `/login magpie` can configure it; no unauthenticated discovery is sent.

`/logout` removes the stored connection and returns to environment/local defaults. Saved credentials never become permanent fallback configuration. Pi refreshes discovery after successful authentication. Request authentication supplies both key and endpoint, so even a previously selected model uses the current connection; Anthropic delegates remove the final `/v1` before their SDK adds `/v1/messages`.

## Automatic web-search MCP

A saved `/login magpie` connection automatically registers **one** native MCP server, `magpie-web-search`, at `<gateway-origin>/mcp/magpie/web-search`. It exposes only `web_search` and `web_fetch` directly (Pi names them `mcp__magpie_web_search__web_search` and `mcp__magpie_web_search__web_fetch`); other server tools stay hidden. Start Magpie and configure its web-search backend separately. Model discovery validates login, not search-backend availability.

Registration happens at startup for an existing saved login and after Pi persists a successful login. It follows accepted key/gateway changes and is removed on logout; failed or cancelled login does not change it. The Authorization header and gateway are paired in memory, not stored in `mcp.json`, and a new gateway's key is never resolved against an old registered URL. Environment-only model configuration does not auto-enable search; use `/login magpie` or a manual MCP entry.

Pi's native MCP extension owns connection startup and cleanup. A same-name `mcp.json` entry takes precedence and is never overwritten. To disable automatic search persistently, add a complete disabled user-level entry (use your gateway URL):

```json
{
  "mcpServers": {
    "magpie-web-search": {
      "url": "http://127.0.0.1:3425/mcp/magpie/web-search",
      "enabled": false
    }
  }
}
```

`--no-mcp` disables MCP for a run. `/mcp` shows the session registration; `pi mcp list` does not, because shell MCP commands do not load extensions. No configuration files are created or edited by this extension.

Herder's Searcher uses the host registration when no user-level entry exists, while other Herder roles remain isolated. New ordinary Subagents load it when both the Magpie provider and native MCP extensions are enabled; `isolated: true`, `extensions: false`, and extension/tool exclusions still apply. Already-running children retain their own connection until they finish; newly launched children use the current login.

## Refresh and failures

Run `/magpie-refresh` to immediately fetch Magpie's latest model list without opening the model picker. It refreshes only Magpie, explicitly allows network discovery even in an offline session, and reports the updated model count, cancellation, or failure. It uses Pi's standard credential resolution and catalog publication; failures retain the previous catalog only for the same URL/key.

Opening `/model` also runs Pi's standard catalog refresh, including Magpie. `/reload` reloads the extension and rereads its environment configuration.

With `pi --offline` or `PI_OFFLINE=1` (also `true`/`yes`, case-insensitive), startup discovery is skipped entirely and an empty provider is registered. There is no offline disk catalog, so startup selection of a discovered Magpie model is unavailable. Later native refresh obeys Pi's `allowNetwork` decision.

Every discovery uses authenticated `GET /v1/models`, disallows redirects, and has a **3-second timeout**, including body reading. Native refresh also honors Pi's cancellation signal and `allowNetwork: false`. New models are installed only through Pi's generation-checked `publish({ update })` callback.

A stopped/unavailable gateway does not break ordinary Pi startup: initial discovery failure quietly registers an empty provider. Start the gateway and run `/magpie-refresh` or open `/model` to retry. Selecting a Magpie model at startup still requires successful discovery. There is no disk cache, so an offline restart does not retain the previous run's models. Network failures, malformed catalogs, and catalogs with no usable chat models retain the current in-memory list only for the same connection. A URL/key change clears the old catalog through Pi's publication callback, even offline or if subsequent discovery fails. Error messages never include response bodies or credentials.

## Magpie's built-in Pi adapter

This extension requires **one configuration owner**: remove the entire `providers.magpie` entry from the standard Pi `models.json`, and stop Magpie's Pi config-sync feature (or use the adapter without this extension). Configure the native extension through `/login magpie` or `MAGPIE_BASE_URL`/`MAGPIE_API_KEY` instead. Back up your configuration first; preserve other providers and settings. The extension checks this file at startup, login, authentication resolution, refresh, and discovery, including live `/model` reloads. It only reads the file and reports an actionable error; it never rewrites it.

All Magpie overlays are blocked, including empty entries, metadata-only `modelOverrides`, headers, compatibility overrides, and API-key fallbacks. Even a metadata-only overlay activates Pi's provider composer, which can bypass Magpie's Anthropic endpoint normalization when a connection change clears the native catalog and discovery fails. A stale selected model could then use a malformed endpoint. Metadata overrides cannot be supported until the host guarantees native delegation independently of the live catalog.

No placeholder models or Pi runtime patches are used. The guard reads `getAgentDir()/models.json` and matches the installed Pi parser's BOM, `//` comments and trailing commas; block comments are not supported. Nonstandard programmatic `ModelRuntime.modelsPath` files are outside this guard's supported configuration.

## Metadata and limitations

- API preference: advertised `/v1/responses`, then `/v1/messages`, otherwise Chat Completions. OpenAI base URLs end in `/v1`; Anthropic uses the origin because its SDK adds `/v1/messages`.
- Chat Completions and Anthropic Messages enable Pi's session-affinity headers, matching Magpie's built-in adapter, so the gateway can associate requests with a Pi session for routing and configured conversation recording. Responses already sends session identity through Pi's delegate. Pi controls these headers (for example, `cacheRetention: "none"` suppresses them).
- Text input is the default; image input is enabled only when advertised. Clearly image/audio-only output models are excluded. No image generation, audio, or classifier integration is provided.
- Missing/invalid limits use **32,768 context tokens** and **4,096 output tokens**. Limits must be positive safe integers, and output is capped at context size. These conservative defaults are not measured model capabilities.
- Prices use exact upstream model IDs from Pi's bundled provider catalogs. Namespace mappings are `auto/`, `mercerrouter/`, and `anthropic/` → Anthropic; `codex/` and `openai/` → OpenAI; `deepseek/` → DeepSeek; and `grok/` and `xai/` → xAI. Cache prices and long-context tiers are preserved. These are **upstream API-equivalent estimates**, not gateway invoices or subscription charges. No LiteLLM dependency or external pricing fetch is required. Routing groups, unknown namespaces, and unmatched IDs (including unverified `@500k` and `build-fast` variants) remain unpriced; no suffix stripping or fuzzy matching is used. Pi still requires numeric rates, so unmatched models carry zero placeholders plus explicit unavailable-pricing metadata. The Statusline Footer shows **price unavailable** for these models and for sessions containing unpriced usage, rather than reporting the placeholders as free. `/magpie-refresh` rebuilds pricing from the installed catalog; updating Pi updates its bundled prices. Earlier zero-cost usage is not retroactively repriced.
- Explicit reasoning efforts populate every Pi thinking level, with unsupported levels set to `null` and `off` mapped to `none`. Unknown/empty effort lists retain Pi defaults. Claude on native Messages may offer `off` without `none`. Adaptive thinking is enabled only for Claude versions recognized by Magpie's upstream rule (4.6 onward), not for arbitrary Anthropic-compatible models.
- Metadata mapping follows Magpie `internal/gateway/gateway.go:modelObject`, `internal/agent/agents.go:piThinkingLevels`/`piModelJSON`, and `internal/gateway/anthropic.go:AdaptiveThinking`/`ThinksOnlyWhenAsked` (reviewed Magpie commit `1755713`).

The extension itself never writes Magpie files, Pi settings, `models.json`, or credential files; Pi alone persists successful login and logout. No process management, telemetry, or runtime patches are implemented. Streaming message conversion, tools, images, usage, cancellation, and parser behavior remain Pi's responsibility. Gateway compatibility still requires live validation.

Native compaction is bundled and **enabled by default, experimental and unverified live**. With `models` omitted, it automatically allows exact registry IDs in the `openai/<model>` and `codex/<model>` namespaces advertised as Magpie Responses models, including `codex/gpt-6.1-sol` and future names. This is an identification heuristic, not proof of backend capability: the remote Magpie provider still requires `compaction=native`. Other namespaces/aliases need an explicit verified exact list; groups are excluded. Run `/reload`, open `/model` to refresh, then inspect `/magpie-native-compaction`. An explicit `models` list replaces discovery; remove that key from old `magpie-native-compaction.json` files to restore automatic selection. Existing `enabled: false` and `models: []` remain optouts. Default fallback to ordinary compaction is allowed only before the first native checkpoint, never after. See [Native compaction setup](NATIVE-COMPACTION.md) for configuration, checkpoint safety, and migration from the old experimental recipe. Magpie uses its provider-neutral engine in `extensions/magpie-provider/native-compaction/` and has no runtime dependency on either CLIProxyAPI extension.

## Offline checks

```sh
npm run test:magpie-provider
npm run typecheck
```

Tests cover native login persistence/cancellation, connection precedence/logout, isolated saved-credential startup, URL/auth validation, metadata mapping, bounded discovery, publication and retention, and offline registration. A loopback MCP fixture verifies same-session login activation, both real native tool calls, literal bearer forwarding, and tool withdrawal on logout without an MCP configuration file. Real Pi runtime/delegate tests verify stale-model endpoint overrides, secret pairing, request hooks, and session-affinity headers with intercepted HTTP. They do not require a Magpie executable or credentials.

The bundled-loader regression test copies only the Magpie extension directory into a temporary directory without checkout dependencies, then loads the full extension in a separate Node process using the installed Pi package's actual bundled virtual modules. It exercises both streaming methods for all three APIs and checks gateway URLs and credentials with intercepted HTTP. This catches imports that work only because development dependencies are present. Streaming delegates must use the loader-supported `@earendil-works/pi-ai/providers/all` entrypoint; Pi 1.3.0 does not expose `pi-ai/api/*` through its bundled loader. The Magpie CI workflow runs these checks on Linux and macOS with Node 22.19 and 24, including changes to the Pi dependency lockfile. Run the same checks whenever upgrading Pi.
