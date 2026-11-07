# Configuration

Start with the defaults, then configure the services and workflows you need. Each extension owns its settings; there is no collection-wide configuration file.

| Feature | Default | Optional setup |
| --- | --- | --- |
| Prompts and individual agents | Available after installation; `Agent` runs in the foreground by default. | Use `/agents` to inspect the fleet and settings. |
| Theme | Installing the collection makes `material-bloom` available. | Choose it in `/settings`; it suits a light terminal background. |
| Response language | No configured default. | Use `/language English` for this session or `/language default English` for new sessions. |
| Spokesman model | Off until configured (`auto` mode by default). | Use `/spokesman <model>` for this session or `/spokesman default <model>` for new sessions. |
| Magpie models | Discovers a gateway at `http://127.0.0.1:3425` by default; needs a running gateway. | Run `/login magpie`, then `/model`. |
| pika uploads, relay, and recall | Inactive until configured. | Run `/pika login` and pair with a server you control. |
| Subagents scripted workflows | Disabled; package agent/workflow discovery is also off. | Explicitly set `workflowsEnabled: true` in `subagents.json`, then reload with no agents running. |
| Recurring work and optimization | Installation starts no loops or optimization campaigns. | Start `/loop` explicitly; `/autoresearch` measures a baseline and waits for `/autoresearch approve`. |
| Herder | Starts only when requested. | Requires Git 2.38+, goal approval, and delivery confirmation in TUI or RPC. |

## Appearance and language

Open `/settings` and select `material-bloom`, or set `"theme": "material-bloom"` in `~/.pi/agent/settings.json`.

```text
/language
/language English
/language reset
/language default English
/language default off
```

The [Language extension](../extensions/language/README.md) stores the new-session default in `<agentDir>/language.json`, usually `~/.pi/agent/language.json`. A session switch applies to the next prompt and is saved with that conversation. A session pins its default at its first run. Changing the default afterward does not change that session. Language settings apply to top-level TUI/RPC sessions, not child agents.

## Model gateway

Start Magpie separately, then configure its URL and key through Pi:

```text
/login magpie
/model
```

[Magpie's reference](../extensions/magpie-provider/README.md) documents Pi's credential store, `MAGPIE_BASE_URL`, and `MAGPIE_API_KEY`. Saved fields take precedence over their environment equivalents. Use one configuration owner: the extension conflicts with a `providers.magpie` entry in Pi's `models.json` and with Magpie's Pi config-sync feature. Follow the reference's migration instructions if either is already configured.

## Session storage

Run your [pika server](../services/pika/README.md), then connect from each machine:

```text
/pika login
/pika
```

Login validates the connection and writes `<agentDir>/pika.json`, normally `~/.pi/agent/pika.json`. Include the server's base path in its URL, such as `https://homelab.example/pika`. Pairing approval happens on the server's Devices page. Uploads include file contents and command output; use a server you control.

The [pika extension reference](../extensions/pika/README.md#configuration) documents exclusions and environment overrides. In particular, `PIKA_URL` and `PIKA_TOKEN` override the saved login, and `PIKA_DISABLED=1` keeps uploads off. Relay and recall use the same connection.

## Delegation settings

[Subagents](../extensions/subagents/README.md) reads global and project `subagents.json` settings, with project settings taking precedence; its reference lists the supported locations. Individual `recon`, `worker`, `reviewer`, and `expert` agents do not require scripted workflows. Enabling `workflowsEnabled` only makes the workflow tool available: orchestration still requires an explicit user request. Package discovery and nested delegation have separate opt-ins.

Use the [Delegation guide](guides/delegation.md) to choose between an individual agent, a scripted workflow, and a durable Herder run. The [Performance guide](guides/performance.md) helps you choose between measurement, approved optimization, and recurring prompts.
