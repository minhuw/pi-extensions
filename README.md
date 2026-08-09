# Pi extensions

A collection of extensions for [Pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| --- | --- |
| [Herder](extensions/herder/README.md) | Deterministic multi-agent implementation and independent review over isolated Git worktrees. |
| [Subagents](extensions/subagents/README.md) | Vendored Claude Code–style autonomous sub-agents (`@tintinweb/pi-subagents` v0.14.3). |
| [Statusline Footer](extensions/statusline-footer/README.md) | A rich, theme-aware footer for model, context, performance, cost, and Git telemetry. |
| [CLIProxyAPI Native Compaction](extensions/cliproxyapi-native-compaction/README.md) | OpenAI Responses native compaction for genuine OpenAI models routed through CLIProxyAPI. |

## Install

```bash
pi install git:github.com/minhuw/pi-extensions
```

For a local checkout:

```bash
pi install /absolute/path/to/pi-extensions
```

Installing the package loads all registered extensions. Herder's command-owned planning workflows load their packaged instructions on demand. Subagents is a vendored pin of `@tintinweb/pi-subagents` — do not also install the npm package in the same Pi profile. See each extension's README for setup, activation conditions, and usage.

## Development

```bash
npm ci
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
