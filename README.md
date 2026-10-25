# Pi extensions

A collection of extensions for [Pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| --- | --- |
| [Commit](extensions/commit/README.md) | A lightweight native prompt for committing current changes as a self-contained patch series. |
| [Quality](extensions/quality/README.md) | Native `/simplify`, `/review`, `/verify`, and `/deslop` prompts for cleanup, bug review, evidence-based verification, and AI-slop removal. |
| [Writer](extensions/writer/README.md) | Eight native academic writing prompt templates for top-tier CS conference papers, ported from claude-writer. |
| [Herder](extensions/herder/README.md) | Deterministic multi-agent implementation and independent review over isolated Git worktrees. |
| [Subagents](extensions/subagents/README.md) | Vendored autonomous subagents (`@tintinweb/pi-subagents` v0.22.0), with a local fleet and integrations; scripted workflows are disabled by default pending reliability fixes. |
| [Orca Bridge](extensions/orca-bridge/README.md) | Orca pane activity, prompt-aware titles, background-work tracking, file/diff navigation, and `/orca-status` diagnostics. |
| [Autoresearch](extensions/autoresearch/README.md) | Main-session baseline design and measurement, explicit user approval, bounded optimization passes, and integrated metric reporting. |
| [Loop](extensions/loop/README.md) | Session-owned recurring prompts with fixed, cron, or model-paced scheduling, bounded execution, and footer status. |
| [Statusline Footer](extensions/statusline-footer/README.md) | A rich, theme-aware footer for model, context, performance, cost, and Git telemetry. |
| [Magpie Provider](extensions/magpie-provider/README.md) | Live gateway model discovery, native Pi streaming APIs, and automatic native-compaction attempts for OpenAI/Codex Responses models; Magpie manages upstream accounts and routing. |

## Themes

| Theme | Description |
| --- | --- |
| `material-bloom` | Material You light palette: cream surfaces, rose primary, teal secondary, lilac tertiary. |

Select it with `/settings` or `"theme": "material-bloom"` in `~/.pi/agent/settings.json`. Best on a light terminal background.

## Install

Node >=22.19.0 and Pi >=1.3.0 are required. With Pi already installed, install the collection:

```bash
pi install git:github.com/minhuw/pi-extensions
```

- Pi's built-in `grep` and `find` tools provide Herder's repository search.
- Herder's nested Searcher uses Magpie's `web_search` and `web_fetch` through Pi's native MCP support, with no extra npm extension. Start Magpie and run `/login magpie` to register it automatically, or configure a user-level server as described in [Herder setup](extensions/herder/README.md#magpie-web-search).
- Herder includes pinned FFF file/content search (`fffind` and `ffgrep`) for every role and nested agent. Standalone Subagents inherit `npm:@ff-labs/pi-fff` when it is installed in the Pi profile; explicit agent extension/tool exclusions and isolation still apply.

For a local checkout:

```bash
pi install /absolute/path/to/pi-extensions
```

Installing the collection loads all registered extensions, `/commit`, the Quality prompts (`/simplify`, `/review`, `/verify`, `/deslop`), the eight Writer prompts, and themes. Quality commands run independently: `/simplify` applies bounded cleanup, `/review` reports bugs without fixes, `/verify` executes checks without repairs, and `/deslop` removes AI code slop with evidence-gated fixes. Herder’s `/herder-simplify` remains a planning workflow. Subagents exposes its `Agent` tools; scripted workflows (`SubagentWorkflow`) are disabled by default pending reliability fixes. An existing explicit `workflowsEnabled: true` setting still enables them; set it to `false` and reload to disable that opt-in. Herder retains its own execution policy and loads its command-owned planning instructions on demand. Subagents is a vendored pin of `@tintinweb/pi-subagents` — do not also install the npm package in the same Pi profile. See each extension's README for setup, activation conditions, and usage.

The CLIProxyAPI provider and native-compaction extensions are no longer bundled. Remove any explicit references to their old paths from your Pi settings; this change does not remove saved credentials or legacy configuration files.

Orca Bridge activates inside Orca panes and combines the main Pi turn with Herder, agents, and workflows. It cooperates with Orca's installed status extension when available and provides standalone hook delivery otherwise. Use `/orca-status` to inspect activity and delivery, `/orca-open <path> --line <n>` to open a file or review report, and `/orca-diff <path> --staged` for a staged diff; add `--focus` to switch view. Background tracking currently applies to Orca's terminal view; stock Orca's native-chat adapter does not expose the corresponding extension activity integration. See its [setup and compatibility guide](extensions/orca-bridge/README.md).

The native `/autoresearch <target>` workflow prepares and measures a baseline, then waits for `/autoresearch approve` before optimizing. Disable `npm:pi-autoresearch` when loading this collection to avoid duplicate `/autoresearch` commands. Existing `.auto/` data is preserved. See [Autoresearch](extensions/autoresearch/README.md).

Magpie Provider connects to a separately running Magpie gateway (default `http://127.0.0.1:3425`). Use `/login magpie` to save its URL and gateway key and automatically expose its search/fetch MCP tools, or configure model access through environment variables. It does not install Magpie or change your selected model. See its [setup guide](extensions/magpie-provider/README.md) for remote keys, model discovery, and coexistence with Magpie's built-in Pi configuration adapter.

## Development

Development uses Node >=22.19.0 for supported Pi versions, built-in `node:sqlite`, and native TypeScript execution. Development dependencies and the lockfile target Pi SDK 1.4.0; the supported runtime minimum remains Pi 1.3.0. Run the offline suite after upgrading the host to check its extension loader, provider delegates, and session/tool lifecycle.

```bash
npm ci
npm test        # full suite; includes the full TypeScript check
# or, for a quick standalone check: npm run typecheck
```

For editable provider development, install the local checkout as above and edit `extensions/magpie-provider/`, not `node_modules`. Pi loads the local TypeScript on extension load; current sessions are not automatically reloaded after edits. Run `npm run test:magpie-provider` for the offline provider and native-compaction checks.

## License

[MIT](LICENSE)
