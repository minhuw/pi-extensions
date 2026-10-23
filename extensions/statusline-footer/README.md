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
| 3 | Git branch, working-tree diff, ahead/behind, extension statuses (including research and loop) | Files touched, current directory |

Thinking levels are colored: dim off, amber low, green medium, lilac high, and a rainbow wash at `xhigh`/`max`. The context bar interpolates success → warning → error across its width and uses the same `▉` block for filled and empty cells so the unused portion stays a quiet charcoal instead of a checkerboard. Segments are separated by space, not mid-dots.

Compact mode keeps identity on the left and the bar, cost, and elapsed time on the right. When another extension publishes `ctx.ui.setStatus("autoresearch", ...)` or `ctx.ui.setStatus("loop", ...)`, compact mode also shows a workflow summary when there is room. Research reports take priority over Loop; clearing the research report restores the Loop summary. Full mode shows both once on the Git row alongside other extension statuses, with research first. A long directory path yields space to workflow statuses. At narrow widths, both layouts prioritize the model and context percentage: workflow summaries and other secondary details drop out and the bar shrinks or disappears before the model is truncated. Clearing a status removes it from the footer. See [Autoresearch](../autoresearch/README.md) for baseline review, approved iterations, and the reporting tool.

## Background processes

The footer optionally integrates with [`@aliou/pi-processes`](https://github.com/aliou/pi-processes). Install it separately:

```bash
pi install npm:@aliou/pi-processes
```

Restart Pi, or use `/reload` to load both extensions. No fork or additional footer dependency is required. Compatibility is based on the package's in-process request/event protocol, verified against version 0.13.2.

The footer shows a summary such as `bg 2 running · 1 failed · 3 done`. Full mode places it on the Git/status row after research and Loop, reserving space before a long directory path. Compact mode includes it alongside the selected workflow summary when the model and context percentage still fit. Stopping, stuck (termination timed out), and killed processes have separate counts. Finished counts remain until pi-processes clears or expires those entries; `/ps:clear` clears finished entries.

Process changes update the summary through Pi's event bus. While jobs are live, a lightweight metadata refresh every two seconds also catches termination states that upstream does not broadcast; this does not invoke the model. Without pi-processes, nothing is displayed and no refresh timer runs. The adapter only reads process metadata; process execution, completion notifications, cancellation, and logs remain owned by pi-processes. `/ps` and `/ps:logs` continue to work. `/footer off` leaves the summary available through Pi's default footer.

For a single status display, leave pi-processes' **status widget** disabled in `/ps:settings` (its default), and use `/ps:dock close` if its log dock is open. Set its dock default to closed in `/ps:settings` to keep it closed on subsequent sessions. The footer does not change upstream UI settings or hide its panels.

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
- Streaming metrics are measured passively from Pi's provider and message events rather than estimated. Completed samples survive `/reload` through a small session custom entry; a new, resumed, or restarted session starts fresh streaming metrics.
- Telemetry is scoped to the interactive TUI session, so programmatic child sessions such as `@tintinweb/pi-subagents` cannot reset or contaminate parent TTFT and token-throughput samples.
- TTFB and TTFT are shown separately to distinguish connection latency from a silent or buffered stream.
- Session cost, cost per turn, cache hit ratio, input/output totals, turns, compactions, tool calls, and errors come from session history. Magpie costs use upstream API estimates, displayed with `~$`. An unpriced selected Magpie model or any unpriced session usage shows **price unavailable** in both layouts and hides the dollar-per-turn average. Earlier Magpie messages with tokens but zero recorded cost remain unpriced; historical costs are not recalculated. Explicitly priced zero-cost usage and free models from other providers still display zero. ASCII mode shows a single dollar sign.
- Git branch and working-tree additions/deletions refresh asynchronously in the background.
- Session statistics are cached by the current branch leaf, keeping streaming renders inexpensive.
- Icons and semantic colors follow the active Pi theme.

## Requirements

- A current version of Pi.
- Icons look best with a [Nerd Font](https://www.nerdfonts.com/). Without one, the footer automatically uses ASCII/Unicode fallbacks.

## Metric sources

- Context usage comes from Pi's context API; cost, turns, cache usage, compactions, errors, and touched files are derived from the active session branch.
- TTFT spans the provider request marker to the first nonempty streamed content, with `message_start` as a fallback request marker for providers that hide HTTP events. Empty block starts and empty deltas do not count as tokens.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput uses exact output-token usage over measured stream time; requests without observed content are excluded. The displayed average is total output tokens divided by total measured stream time.
- Cache hit rate is cached-read tokens divided by all input tokens: uncached input + cache reads + cache writes.
- Git branch comes from Pi's footer data. Working-tree state uses a throttled `git --no-optional-locks status --porcelain=v1 --untracked-files=normal`: a successful empty result is `clean`, any output is `dirty`, and a failed or pending status is shown as `git ?` or `git …`. Optional `git diff --shortstat HEAD` supplies additions/deletions, while `git rev-list --left-right --count @{upstream}...HEAD` supplies ahead/behind; either auxiliary query can fail without changing the authoritative status.
- Service tier is sniffed from the last `before_provider_request` payload and shown only when it is not `standard`/`default`/`auto`. `priority` displays as `FAST`; a request without a tier or a model change clears the previous badge.

## License

[MIT](../../LICENSE)
