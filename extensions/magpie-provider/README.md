# Magpie provider

Use Magpie gateway models in Pi through the native `magpie` provider. The extension discovers the running gateway's chat models and delegates streaming to Pi's existing OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages implementations. It leaves other providers in place and adds no separate streaming transport or parser.

## Use

Start Magpie separately, then load this extension (or the containing Pi package):

```sh
pi -e ./extensions/magpie-provider/index.ts
```

Run `/login magpie` for interactive setup:

1. Enter the gateway URL. Leave it blank to accept the displayed current or local default.
2. Enter its API key in the **secret** prompt. A blank key uses `magpie-pi` only for loopback; remote gateways require a newly entered key. Login never reuses a stored or environment key, even when the URL is unchanged.
3. After validation succeeds, use `/model` to select a discovered Magpie model.

Login validates authenticated `/v1/models` before Pi atomically saves the key and canonical URL in its credential store. An empty valid catalog is allowed at login. Failed or cancelled validation leaves the existing credential and catalog untouched. This uses Pi's native API-key login method, not OAuth or a separate command.

The extension marks the key prompt as secret, but masking is controlled by Pi's client. The Pi TUI implementation inspected renders ordinary input even for secret prompts; avoid screen sharing or terminal recording while entering a key.

When startup discovery succeeds, its catalog is available before provider registration, so startup model selection and model listing can use it. IDs are preserved exactly, including `group/foo`. Startup reads only Magpie's optional saved credential through Pi's public read-only helper; no other credentials are resolved. Environment-only setup remains supported:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425` | HTTP(S) gateway origin; an optional trailing `/v1` or `/v1/` is removed. |
| `MAGPIE_API_KEY` | `magpie-pi` on loopback only | Bearer credential for discovery and fallback request authentication. Required for remote gateways. |

Loopback means `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1`, not arbitrary names resolving locally. Userinfo, queries, fragments, other URL paths, and non-HTTP(S) protocols are rejected. Use HTTPS for remote gateways: explicit HTTP sends credentials without encryption. Configuration errors are surfaced during extension loading.

Saved URL/key take precedence over environment values per field; older saved keys without a URL use the environment/local URL. Native refresh uses Pi's effective credential, including its URL. A remote URL without a key still registers so `/login magpie` can configure it; no unauthenticated discovery is sent.

`/logout` removes the stored connection and returns to environment/local defaults. Saved credentials never become permanent fallback configuration. Pi refreshes discovery after successful authentication. Request authentication supplies both key and endpoint, so even a previously selected model uses the current connection; Anthropic delegates remove the final `/v1` before their SDK adds `/v1/messages`.

## Short model IDs

The picker shows automatic routes by their model name and keeps concrete provider choices qualified. For example, a catalog with `auto/gpt-6-astra`, `codex/gpt-6-astra`, and `token-zhang-s-gateway/codex/gpt-6-astra` offers:

- `gpt-6-astra` — the automatic routing group.
- `codex/gpt-6-astra` — the explicit Codex provider.
- `token-zhang-s-gateway/codex/gpt-6-astra` — the explicit remote provider route.

Pi's outer provider is still `magpie`, so the short selection is `magpie/gpt-6-astra`. This works without changing Magpie's settings: when the gateway does not advertise the bare name, the extension creates a local alias that sends the exact `auto/gpt-6-astra` ID. Only exact `auto/<name>` routes receive these aliases; user-created `group/…` routes and nested `auto/…` paths stay qualified. A concrete provider remains qualified beside its automatic group even if it is the only concrete source.

Magpie's **Settings → Network and sharing → Model ids without the provider** setting can also add bare IDs to discovery; run `/magpie-refresh` after changing it. When an advertised bare row is a proven alias of `auto/<name>`, the picker prefers that row. If the bare name already belongs to another route or has conflicting metadata, the extension preserves it and keeps the automatic route qualified. It never overwrites gateway-advertised IDs.

The picker hides only **proven aliases of the same route**. Discovery links a gateway alias to its qualified source when `owned_by`, the corresponding qualified ID, and all raw metadata except `id` agree. Equally named models from different providers remain separate. Different nested routes under the same provider also remain separate; matching names or owner labels alone do not establish equivalence. Automatic groups stay distinct from concrete providers even when the group appears under its short name.

For a final name beginning `claude-`, the extension adds a local alias to a concrete source only when exactly one concrete source remains, that source has valid ownership metadata, and neither a gateway row nor an automatic alias already uses the short name. For example, without an automatic group, `contabo/claude/claude-opus-5-5` and its proven gateway alias `claude/claude-opus-5-5` can appear as `claude-opus-5-5`. That local alias sends requests to the exact `contabo/claude/claude-opus-5-5` source. If `claude1/claude-opus-5-5` and `claude2/claude-opus-5-5` both exist, both qualified sources remain visible and no concrete-source alias is created. Missing or inconsistent metadata also retains explicit routes.

Short aliases retain their route's API, limits, thinking support, and pricing without merging capabilities. Magpie omits native-endpoint metadata for routing groups. When every advertised concrete route with the same exact final model name selects Responses, the extension also selects Responses for a group lacking endpoint metadata and its proven short aliases. This preserves service tiers such as `fast` (`priority`) while requests still target the group. Explicit endpoint metadata takes precedence; missing concrete routes or conflicting APIs retain Chat Completions. This is a client protocol preference, not proof of group membership or native backend capability. Limits, thinking support, and pricing remain the group's own. The complete catalog, including local aliases and original `auto/…` IDs, remains registered for exact-ID lookup. Gateway-advertised bare IDs still use their own exact request and checkpoint identities.

Local aliases keep the short selection ID in assistant messages so Pi's automatic overflow and truncated-response recovery still work. Messages also persist the exact target as `magpiePhysicalModel`; streaming restores that ID before SDK serialization to preserve signed thinking and tool history. Native-compaction requests and checkpoint bindings use the exact target, so an alias can share a checkpoint with that route. Missing targets, conflicting alias metadata, or history showing a different route block alias dispatch. Concrete Claude aliases additionally reject competing sources and changed owners. Automatic aliases allow group membership and first-member ownership to change: Magpie owns routing within the selected group. Short-ID error or aborted entries synthesized by Pi without target metadata are skipped when checking history, so a failed request does not hide the last recorded route or block retries. Refresh removes unavailable or newly ambiguous local aliases from the catalog.

When `enabledModels` or `--models` configures a scope, the extension preserves the full availability list and original display names so Pi can resolve and cycle exact IDs, wildcard patterns, and thinking levels without changing the scope. Pi's scoped picker view follows that existing selection. Clear the scope and refresh to return to the deduplicated short-ID list. Before Pi's settings API is initialized, the extension checks scope presence read-only in the settings files; an unreadable file conservatively preserves the full list.

A gateway-advertised bare ID follows Magpie's routing rules: a matching routing group when enabled, otherwise the first matching provider in the Providers order. The extension sends that advertised ID unchanged; a local alias explicitly maps to its automatic group or concrete Claude source instead.

Pricing and automatic compaction eligibility still use the exact model name after the last `/`, independently of gateway provider prefixes and `owned_by`. These are estimates and eligibility heuristics, not evidence that different providers serve equivalent models. Case and model suffixes are preserved; no display-label matching or fuzzy matching is used. The picker therefore keeps different sources separate even when their estimates match. See [Magpie's bare-ID documentation](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-routing.md#model-ids-without-the-provider).

## Fast mode

Run `/fast` or `/fast on` to request Fast mode for the current session; `/fast off` stops this switch from adding the tier and `/fast status` shows the switch. The selected model must be a Magpie Responses model whose current gateway catalog advertises `priority`. While enabled, eligible requests send `service_tier: "priority"`; switching to a model without that capability leaves its requests unchanged. `/magpie-refresh` updates the catalog. Fast is off in a new session; the switch follows the active session branch and survives reload, resume and fork. Subagents have separate sessions and can request a tier through their own `service_tier` setting.

Fast can increase API charges or subscription usage. For eligible models, the footer shows `FAST` or `FAST OFF` immediately after the model name to reflect the session switch; this does not confirm the tier or speed delivered upstream. Its cost is an estimate, not a subscription bill or a guarantee that Fast pricing is reflected. Gateway and upstream routing can reject, drop or downgrade a tier, and Codex responses may report `default` even when Magpie forwarded `priority`. Check Magpie's request log for the requested and sent tiers. Native compaction uses a separate request and does not use this switch.

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

New ordinary Subagents load it when both the Magpie provider and native MCP extensions are enabled; `isolated: true`, `extensions: false`, and extension/tool exclusions still apply. Already-running children retain their own connection until they finish; newly launched children use the current login.

## Refresh and failures

Run `/magpie-refresh` to immediately fetch Magpie's latest model list without opening the model picker. It refreshes only Magpie, explicitly allows network discovery even in an offline session, and reports the updated number of picker choices, cancellation, or failure. It uses Pi's standard credential resolution and catalog publication; failures retain the previous catalog only for the same URL/key.

Opening `/model` also runs Pi's standard catalog refresh, including Magpie. `/reload` reloads the extension and rereads its environment configuration.

With `pi --offline` or `PI_OFFLINE=1` (also `true`/`yes`, case-insensitive), startup discovery is skipped entirely. An extension instance can reuse a validated catalog still held by another provider in the same process and configuration scope. A fresh process registers an empty provider: there is no offline disk catalog, so startup selection of a discovered Magpie model is unavailable until discovery succeeds. Later native refresh obeys Pi's `allowNetwork` decision.

Every discovery uses authenticated `GET /v1/models`, disallows redirects, and has a **3-second timeout**, including body reading. After validating usable gateway models, network refresh may make a separate optional public request to `https://models.dev/api.json`, with its own **3-second timeout** and **16 MiB response limit**. This request sends no gateway credentials or cookies and disallows redirects. Login validation skips public pricing lookup. A pricing-source failure does not discard usable gateway models. Native refresh also honors Pi's cancellation signal and `allowNetwork: false`. New models are installed only through Pi's generation-checked `publish({ update })` callback.

A stopped or unavailable gateway does not break ordinary Pi startup. If initial discovery fails and no matching live catalog exists, Pi registers an empty provider. Start the gateway and run `/magpie-refresh` or open `/model` to retry. Network failures, malformed catalogs, and catalogs with no usable chat models retain the current in-memory list only for the same configuration scope. Error messages never include response bodies or credentials.

Only public pricing snapshots are cached on disk; offline startup and `allowNetwork: false` never fetch public prices.

Magpie instances in one process share validated catalog snapshots scoped by agent directory, normalized gateway URL, effective API key, and saved-credential provenance. This lets concurrent workers and `/reload` retain valid routes when startup discovery fails or is skipped. Providers and their session callbacks remain separate. Credential or gateway changes switch to a separate scope without clearing another session's catalog; saved and environment-only authentication never share provenance. Successful discovery replaces the entire shared snapshot, including removals and newly competing sources. A delayed older discovery cannot overwrite a later discovery, and rejected or cancelled publication cannot install a catalog. Catalogs are released when no provider retains them.

Alias failures distinguish an unavailable catalog, a missing target, conflicting route metadata, competing sources, and conflicting session history. Availability failures advise checking the gateway and credentials and running `/magpie-refresh`; missing targets advise refreshing and choosing an available explicit route; metadata conflicts advise refreshing and reselecting the model; ambiguity requires an explicit route; history conflicts require the previous explicit source or a new session. These checks continue to block silent rerouting.

The optional session pricing marker is best effort: a provider retained in a shared model runtime may outlive the extension session that registered its recorder. A failed marker write must not discard a completed response, token usage, an upstream error, or cancellation. Pricing provenance remains attached to the returned message's usage even when that extra session marker cannot be written.

## Magpie's built-in Pi adapter

This extension requires **one configuration owner**: remove the entire `providers.magpie` entry from the standard Pi `models.json`, and stop Magpie's Pi config-sync feature (or use the adapter without this extension). Configure the native extension through `/login magpie` or `MAGPIE_BASE_URL`/`MAGPIE_API_KEY` instead. Back up your configuration first; preserve other providers and settings. The extension checks this file at startup, login, authentication resolution, refresh, and discovery, including live `/model` reloads. It only reads the file and reports an actionable error; it never rewrites it.

All Magpie overlays are blocked, including empty entries, metadata-only `modelOverrides`, headers, compatibility overrides, and API-key fallbacks. Even a metadata-only overlay activates Pi's provider composer, which can bypass Magpie's Anthropic endpoint normalization when a connection change clears the native catalog and discovery fails. A stale selected model could then use a malformed endpoint. Metadata overrides cannot be supported until the host guarantees native delegation independently of the live catalog.

No placeholder models or Pi runtime patches are used. The guard reads `getAgentDir()/models.json` and matches the installed Pi parser's BOM, `//` comments and trailing commas; block comments are not supported. Nonstandard programmatic `ModelRuntime.modelsPath` files are outside this guard's supported configuration.

## Metadata and limitations

- API preference: advertised `/v1/responses`, then `/v1/messages`, otherwise Chat Completions. A group without endpoint metadata uses Responses when all advertised concrete routes with its exact final model name select Responses; explicit group endpoints always take precedence. OpenAI base URLs end in `/v1`; Anthropic uses the origin because its SDK adds `/v1/messages`.
- Chat Completions and Anthropic Messages enable Pi's session-affinity headers, matching Magpie's built-in adapter, so the gateway can associate requests with a Pi session for routing and configured conversation recording. Responses already sends session identity through Pi's delegate. Pi controls these headers (for example, `cacheRetention: "none"` suppresses them).
- Text input is the default; image input is enabled only when advertised. Clearly image/audio-only output models are excluded. No image generation, audio, or classifier integration is provided.
- Missing/invalid limits use **32,768 context tokens** and **4,096 output tokens**. Limits must be positive safe integers, and output is capped at context size. These conservative defaults are not measured model capabilities.
- Prices use a model-name index built from models.dev, ignoring provider identities, gateway route prefixes, owner metadata, and canonical-model metadata. Exact final model-name segments are lookup keys; equal catalog display names connect short and full IDs such as `k3.1-pro` and `kimi-k3.1-pro`. For duplicate entries, the most common complete nonzero rate set wins; ties stay unavailable. Zero-rate entries are considered only when no paid rates exist. Case, dates, versions, and suffixes are never normalized. Cache prices and explicit long-context thresholds are preserved; unsupported pricing tiers stay unavailable. These are **catalog-based API cost estimates**, not gateway invoices or subscription charges. A minimal validated public pricing snapshot is written atomically to `<agentDir>/magpie-prices.json`, reused for **24 hours**, and retained as a stale fallback if public fetching or validation fails. Cache read/write failures are best effort. Names absent from the live or cached snapshot fall back to Pi's bundled Anthropic, OpenAI, DeepSeek, and xAI prices; catalog conflicts and unavailable entries block that fallback. When no usable public source exists, bundled pricing is used. A group named after a known model receives that model's estimate; this does not assert equivalence of its members. Pi requires numeric rates, so unpriced models carry zero placeholders plus explicit unavailable-pricing metadata. The Statusline Footer shows **price unavailable** for these models and sessions containing unpriced usage. `/magpie-refresh` reapplies pricing and fetches the public source when its cache is missing or expired. Earlier usage is not retroactively repriced.
- Explicit reasoning efforts populate every Pi thinking level, with unsupported levels set to `null` and `off` mapped to `none`. Unknown/empty effort lists retain Pi defaults. Claude on native Messages may offer `off` without `none`. Adaptive thinking is enabled only for Claude versions recognized by Magpie's upstream rule (4.6 onward), not for arbitrary Anthropic-compatible models.
- Metadata mapping follows Magpie `internal/gateway/gateway.go:modelObject`, `internal/agent/agents.go:piThinkingLevels`/`piModelJSON`, and `internal/gateway/anthropic.go:AdaptiveThinking`/`ThinksOnlyWhenAsked` (reviewed Magpie commit `1755713`).

The extension itself never writes Magpie files, Pi settings, `models.json`, or credential files; Pi alone persists successful login and logout. No process management, telemetry, or runtime patches are implemented. Streaming message conversion, tools, images, usage, cancellation, and parser behavior remain Pi's responsibility. Gateway compatibility still requires live validation.

Native compaction is bundled and **enabled by default, experimental and unverified live**. With `models` omitted, it automatically allows Magpie Responses models whose final name matches `gpt-*`, `chatgpt-*`, or an o-series name such as `o3`/`o3-mini`, regardless of gateway prefix or `owned_by`. This includes bare names and names such as `my-relay/gpt-6-astra`. The name is an identification heuristic, not proof of backend capability: the remote Magpie provider still requires `compaction=native`. Other names need an explicit verified `models` list, which also matches by model name across discovered Responses routes. Routes selected on Chat Completions or Messages use ordinary compaction. Groups selected on Responses are eligible, but native upstream compaction still depends on Magpie's checks and provider configuration for every group member.

Run `/reload`, open `/model` to refresh, then inspect `/magpie-native-compaction`. An explicit `models` list replaces discovery; remove that key from old `magpie-native-compaction.json` files to restore automatic selection. Existing `enabled: false` and `models: []` remain optouts. Default fallback to ordinary compaction is allowed only before the first native checkpoint, never after. See [Native compaction setup](NATIVE-COMPACTION.md) for configuration, checkpoint safety, and migration from the old experimental recipe. Magpie uses its provider-neutral engine in `extensions/magpie-provider/native-compaction/` and has no runtime dependency on either CLIProxyAPI extension.

## Offline checks

```sh
npm run test:magpie-provider
npm run typecheck
```

Tests cover native login persistence/cancellation, connection precedence/logout, isolated saved-credential startup, URL/auth validation, metadata mapping, bounded discovery, publication and retention, and offline registration. A real Pi SDK regression loads the actual extension in a parent and four concurrent sessions in git worktrees, verifies every request uses the same Claude alias and physical route, then cleans up the children and verifies the parent continues. It covers healthy, failed, and skipped child discovery, plus failed refresh. Catalog tests cover scope isolation, credential changes, authoritative route changes, out-of-order discovery, rejected publication, cancellation, and distinct alias failure causes. A loopback MCP fixture verifies same-session login activation, both real native tool calls, literal bearer forwarding, and tool withdrawal on logout without an MCP configuration file. Real Pi runtime/delegate tests verify stale-model endpoint overrides, secret pairing, request hooks, and session-affinity headers with intercepted HTTP. They do not require a Magpie executable or credentials.

The bundled-loader regression test copies only the Magpie extension directory into a temporary directory without checkout dependencies, then loads the full extension in a separate Node process using the installed Pi package's actual bundled virtual modules. It exercises both streaming methods for all three APIs and checks gateway URLs and credentials with intercepted HTTP. This catches imports that work only because development dependencies are present. Streaming delegates use the loader-supported `@earendil-works/pi-ai/providers/all` entrypoint; the bundled loader does not expose `pi-ai/api/*`. Pi 1.4.0 adds the `pi-ai/models` subpath, which does not replace those streaming delegates. The Magpie CI workflow runs these checks on Linux and macOS with Node 22.19 and 24, including changes to the Pi dependency lockfile. Run the same checks whenever upgrading Pi.
