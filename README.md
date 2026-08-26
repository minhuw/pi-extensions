# Pi extensions

A collection of extensions for [Pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| --- | --- |
| [Commit](extensions/commit/README.md) | Create polished, self-contained Linux-style commits from the current dirty worktree. |
| [Writer](extensions/writer/README.md) | Academic writing workflows for top-tier CS conference papers, ported from claude-writer. |
| [Herder](extensions/herder/README.md) | Deterministic multi-agent implementation and independent review over isolated Git worktrees. |
| [Subagents](extensions/subagents/README.md) | Vendored Claude Code–style autonomous sub-agents (`@tintinweb/pi-subagents` v0.14.3). |
| [Statusline Footer](extensions/statusline-footer/README.md) | A rich, theme-aware footer for model, context, performance, cost, and Git telemetry. |
| [CLIProxyAPI Native Compaction](extensions/cliproxyapi-native-compaction/README.md) | OpenAI Responses native compaction for genuine OpenAI models routed through CLIProxyAPI. |

## Themes

| Theme | Description |
| --- | --- |
| `material-bloom` | Material You light palette: cream surfaces, rose primary, teal secondary, lilac tertiary. |

Select it with `/settings` or `"theme": "material-bloom"` in `~/.pi/agent/settings.json`. Best on a light terminal background.

## Install

Node >=22.19.0 is required. With Pi already installed, this block sets up the collection and every external extension used by Herder's isolated workers:

```bash
pi install git:github.com/minhuw/pi-extensions
pi install git:github.com/DietrichGebert/ponytail
pi install npm:@ff-labs/pi-fff
pi install npm:pi-web-access
```

- Ponytail keeps Herder implementers and nested workers focused on minimal changes.
- `pi-fff` provides the FFF-backed file and content search used by Herder roles and children.
- `pi-web-access` provides remote research tools to Herder's nested searcher.

For a local checkout, replace only the first command:

```bash
pi install /absolute/path/to/pi-extensions
pi install git:github.com/DietrichGebert/ponytail
pi install npm:@ff-labs/pi-fff
pi install npm:pi-web-access
```

Installing the collection loads all registered extensions. Herder's command-owned planning workflows load their packaged instructions on demand. Subagents is a vendored pin of `@tintinweb/pi-subagents` — do not also install the npm package in the same Pi profile. See each extension's README for setup, activation conditions, and usage.

## Development

Development uses Node >=22.19.0 for supported Pi versions, built-in `node:sqlite`, and native TypeScript execution.

```bash
npm ci
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
