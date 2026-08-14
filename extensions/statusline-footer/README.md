# Statusline Footer

A rich, theme-aware Pi footer. The metrics come from this extension; the visual language follows [pikit](https://github.com/adrianapan/pikit)'s status bar: left/right justified rows, a positional gradient context bar, per-level thinking color, a hairline rule, and Nerd Font icons with ASCII fallbacks.

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

Full mode is three content rows plus a hairline under the identity row. Primary facts sit on the left; capacity, cost, and path sit on the right:

```text
  ●  k3  HIGH  FAST  (moonshot)              2×  ▉▉▉▉▉▉▉▉░░░░░░░░░░  8.2%  78.9k/1.05M
  ────────────────────────────────────────────────────────────────────────────────
  # 13  ⏱ 1h 28m  μ 4.2s ⇄ 1.8s » 28.9 tok/s     $0.75  ↑ 65.2k ↓ 31.4k ⚡120k  12.1k think  96%
  ⎇ main  +42 −17  ↑2 ↓1                              ▤ 5 touched  ⌂ ~/code/my-project
```

| Row | Left | Right |
| --- | --- | --- |
| 1 | Live pulse, queued chip, model, thinking, non-standard service tier, provider | Compactions, gradient bar, percent, used/window |
| 2 | Turns, elapsed, TTFT, TTFB, throughput, tool calls, errors | Cost, input / output / cached-input tokens, reasoning tokens, cache hit rate |
| 3 | Git branch, working-tree diff, ahead/behind, extension statuses | Files touched, current directory |

Thinking levels are colored: dim off, amber low, green medium, lilac high, and a rainbow wash at `xhigh`/`max`. The context bar interpolates success → warning → error across its width and uses the same `▉` block for filled and empty cells so the unused portion stays a quiet charcoal instead of a checkerboard. Segments are separated by space, not mid-dots.

Compact mode keeps identity on the left and the bar, cost, and elapsed time on the right.

## Commands

| Command | Effect |
| --- | --- |
| `/footer` | Toggle the custom footer on or off. |
| `/footer full` | Use the multi-line layout. |
| `/footer compact` | Use the one-row layout. |
| `/footer off` | Restore Pi's default footer. |
| `/footer debug` | Show metric-collection diagnostics for provider latency. |

## Features

- A live context-window bar uses a positional RGB gradient (theme success/warning/error when the theme is 24-bit, otherwise a warm fallback).
- Thinking effort is a first-class CAPS label with per-level color, including a rainbow wash at `xhigh` and `max`.
- Rows are left/right justified so identity stays put while capacity and cost hug the right edge.
- Nerd Font icons are used on Ghostty, WezTerm, Kitty, iTerm2, Alacritty, Foot, Rio, and Contour. Everything else falls back to ASCII. Override with `STATUSLINE_NERD_FONTS=1` or `0`.
- Streaming metrics are measured passively from Pi's provider and message events rather than estimated.
- Telemetry is scoped to the interactive TUI session, so programmatic child sessions such as `@tintinweb/pi-subagents` cannot reset or contaminate parent TTFT and token-throughput samples.
- TTFB and TTFT are shown separately to distinguish connection latency from a silent or buffered stream.
- Session cost, cost per turn, cache hit ratio, input/output totals, turns, compactions, tool calls, and errors come from session history.
- Git branch and working-tree additions/deletions refresh asynchronously in the background.
- Session statistics are cached by the current branch leaf, keeping streaming renders inexpensive.
- Icons and semantic colors follow the active Pi theme.

## Requirements

- A current version of Pi.
- Icons look best with a [Nerd Font](https://www.nerdfonts.com/). Without one, the footer automatically uses ASCII/Unicode fallbacks.

## Metric sources

- Context usage comes from Pi's context API; cost, turns, cache usage, compactions, errors, and touched files are derived from the active session branch.
- TTFT spans the provider request marker to the first streamed content event, with `message_start` as a fallback for providers that hide HTTP events.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput uses exact output-token usage over measured stream time; the displayed average is token-weighted.
- Git branch comes from Pi's footer data. Working-tree state uses a throttled `git status --porcelain=v1 --untracked-files=normal`: a successful empty result is `clean`, any output is `dirty`, and a failed or pending status is shown as `git ?` or `git …`. Optional `git diff --shortstat HEAD` supplies additions/deletions, while `git rev-list --left-right --count @{upstream}...HEAD` supplies ahead/behind; either auxiliary query can fail without changing the authoritative status.
- Service tier is sniffed from the last `before_provider_request` payload and shown only when it is not `standard`/`default`/`auto`. `priority` displays as `FAST`.

## License

[MIT](../../LICENSE)
