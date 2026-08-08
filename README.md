# Pi extensions

A collection of extensions for [Pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| --- | --- |
| [Herder](extensions/herder/README.md) | Deterministic multi-agent implementation and independent review over isolated Git worktrees. |
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

Installing the package loads all three extensions and Herder's planning skills. See each extension's README for setup, activation conditions, and usage.

## Development

```bash
npm ci
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
