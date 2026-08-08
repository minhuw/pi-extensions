# Statusline Footer

A rich, theme-aware Pi footer inspired by [claude-tui](https://github.com/slima4/claude-tui)'s Claude Code statusline. It keeps model state, context pressure, streaming performance, session economics, and local Git state visible without adding work to the render hot path.

## Install

Install the extension collection:

```bash
pi install git:github.com/minhuw/pi-extensions
```

To load only this extension from a local checkout:

```bash
pi -e ./extensions/statusline-footer/index.ts
```

Full mode is enabled by default when Pi starts.

## Layout

Full mode renders three rows, with one theme per row:

```text
  k3 (moonshot) │   ███░░░░░░░░░░░░░░ 8% 78.9k/1.05M │   1x │   1h 32m   9 │  65.2k   31.4k │   96% │   $0.75 (~$0.058/turn)
  μ 4.2s    2.1s │   1.8s │   μ 28.9 tok/s    31.2 │   42 │   2 (4.8%)
  main │ +42 −17 in 3 │   5 touched │   ~/code/my-project
```

| Row | Theme | Contents |
| --- | --- | --- |
| 1 | Model state | Model and provider, context-window bar, compactions, elapsed time, turns, token totals, cache ratio, and session cost. |
| 2 | Performance | Mean and latest time to first token, time to first byte, token throughput, tool calls, and error rate. |
| 3 | Local state | Git branch, working-tree diff, files touched during the session, and current directory. |

Compact mode renders the essential model, context, cost, time, turn, throughput, and compaction data on one line.

## Commands

| Command | Effect |
| --- | --- |
| `/footer` | Toggle the custom footer on or off. |
| `/footer full` | Use the three-row layout. |
| `/footer compact` | Use the one-row layout. |
| `/footer off` | Restore Pi's default footer. |
| `/footer debug` | Show metric-collection diagnostics for provider latency. |

## Features

- A live context-window bar changes from green to yellow to red as usage approaches the model limit.
- Streaming metrics are measured passively from Pi's provider and message events rather than estimated.
- TTFB and TTFT are shown separately to distinguish connection latency from a silent or buffered stream.
- Session cost, cost per turn, cache hit ratio, input/output totals, turns, compactions, tool calls, and errors come from session history.
- Git branch and working-tree additions/deletions refresh asynchronously in the background.
- Session statistics are cached by the current branch leaf, keeping streaming renders inexpensive.
- Icons and semantic colors follow the active Pi theme.

## Requirements

- A current version of Pi.
- A terminal font patched with [Nerd Font](https://www.nerdfonts.com/) glyphs for the icons. Without one, the footer still works but icons may render as boxes.

## Metric sources

- Context usage comes from Pi's context API; cost, turns, cache usage, compactions, errors, and touched files are derived from the active session branch.
- TTFT spans the provider request marker to the first streamed content event, with `message_start` as a fallback for providers that hide HTTP events.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput uses exact output-token usage over measured stream time; the displayed average is token-weighted.
- Git branch comes from Pi's footer data, while diff statistics use a throttled background `git diff --shortstat HEAD` call.

## License

[MIT](../../LICENSE)
