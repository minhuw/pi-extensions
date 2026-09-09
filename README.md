# Pi extensions

A collection of extensions for [Pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| --- | --- |
| [Commit](extensions/commit/README.md) | A lightweight native prompt for committing current changes as a self-contained patch series. |
| [Writer](extensions/writer/README.md) | Academic writing workflows for top-tier CS conference papers, ported from claude-writer. |
| [Herder](extensions/herder/README.md) | Deterministic multi-agent implementation and independent review over isolated Git worktrees. |
| [Subagents](extensions/subagents/README.md) | Vendored Claude Code–style autonomous sub-agents (`@tintinweb/pi-subagents` v0.14.3). |
| [Statusline Footer](extensions/statusline-footer/README.md) | A rich, theme-aware footer for model, context, performance, cost, and Git telemetry. |
| [CLIProxyAPI Provider](extensions/cliproxyapi-provider/README.md) | Editable locally patched 1.4.15 snapshot: dynamic models, catalog protection, and elapsed/TPS telemetry. |
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
pi install npm:pi-web-access
```

- Ponytail keeps Herder implementers and nested workers focused on minimal changes.
- Pi's built-in `grep` and `find` tools provide Herder's repository search.
- `pi-web-access` provides remote research tools to Herder's nested searcher.

For a local checkout, replace only the first command:

```bash
pi install /absolute/path/to/pi-extensions
pi install git:github.com/DietrichGebert/ponytail
pi install npm:pi-web-access
```

Installing the collection loads all registered extensions, the `/commit` prompt template, and themes. Herder's command-owned planning workflows load their packaged instructions on demand. Subagents is a vendored pin of `@tintinweb/pi-subagents` — do not also install the npm package in the same Pi profile. CLIProxyAPI Provider is also vendored from the locally installed patched 1.4.15 snapshot, including TPS — do not also load `npm:@router-for-me/pi-cliproxyapi-provider` in the same Pi profile. Existing `/login` credentials and `cliproxyapi.json` configuration remain compatible. See each extension's README for setup, activation conditions, and usage.

## Development

Development uses Node >=22.19.0 for supported Pi versions, built-in `node:sqlite`, and native TypeScript execution.

```bash
npm ci
npm test        # full suite; includes the full TypeScript check
# or, for a quick standalone check: npm run typecheck
```

For editable provider development, install the local checkout as above and edit `extensions/cliproxyapi-provider/src/`, not `node_modules`. Pi loads the local TypeScript on extension load; current sessions are not automatically reloaded after edits. Run `npm run test:cliproxyapi-provider` for the offline catalog and entrypoint checks.

## License

[MIT](LICENSE)
