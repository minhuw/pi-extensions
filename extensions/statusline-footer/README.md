# Statusline Footer

A rich, theme-aware Pi footer. The metrics come from this extension; the visual language follows [pikit](https://github.com/adrianapan/pikit)'s status bar: left/right justified rows, a positional gradient context bar, per-level thinking color, and Nerd Font icons, with an ASCII opt-out. The identity row is a powerline bar, and the rows below hang from it on a rail.

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

Full mode is the bar and two rows that hang from it, plus a status row while any extension status other than the language is set. Primary facts sit on the left; capacity, cost, and path sit on the right. Shown with ASCII icons; the bar's groups sit on colored bands:

```text
 ● ☾ k3   HIGH  (moonshot)  English  ──────────────────────────────  × 2×  ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉  8.2%  79k/1.1M
 ├ # 13  ⏱ 1h 28m  │  ⏱ 302ms ↺ 301ms  » 92 tok/s ↺ 91 tok/s      $0.750  $0.058/turn  │  ↑ 65k  ↓ 31k  ⚡ 120k 65%
 ├ ⎇ main  +42 −17  ↑2 ↓1                                                     ▤ 5 touched  │  ⌂ ~/code/my-project
 ╰ herder: T2 integrate · 3/5 tasks  │  ↻ build · next 4m  │  bg 1 running
```

| Row | Left | Right |
| --- | --- | --- |
| 1 | Live pulse, queued chip, model, thinking, non-standard service tier, provider, language | Compactions, gradient bar, percent, used/window |
| 2 | Turns and elapsed time; TTFT, TTFB, and throughput; tool calls and errors | Cost and cost per turn; input / output / cached-input tokens and cache hit rate; reasoning tokens |
| 3 | Git branch, working-tree diff, ahead/behind | Files touched, current directory |
| 4 | Extension statuses except the language: research, Herder, Loop, background processes, then the rest; shown only while one of these is set | |

The model name starts with its vendor's mark in the vendor's color. These are the OpenAI and Claude logos (Nerd Fonts 3.5 or later), the Google logo for Gemini, and related symbols for Kimi, DeepSeek, Grok, Llama, Mistral, and Qwen; with `STATUSLINE_NERD_FONTS=0`, Unicode marks such as `✻` (Claude), `⊛` (OpenAI), `✦` (Gemini), and `☾` (Kimi) take their place. The model id is matched before the provider, so Claude served through Vertex or Magpie still gets the Claude mark; an unrecognized model has none.

Thinking levels are colored: dim off, amber low, green medium, lilac high, and a rainbow wash at `xhigh`/`max`. The context bar interpolates success → warning → error across its width and uses the same `▉` block for filled and empty cells so the unused portion stays a quiet charcoal instead of a checkerboard.

Compact mode is the bar alone, with cost and elapsed time added on the right. When another extension publishes `ctx.ui.setStatus("autoresearch", ...)`, `ctx.ui.setStatus("herder", ...)`, or `ctx.ui.setStatus("loop", ...)`, compact mode also shows a workflow summary when there is room. Research reports take priority over Herder, and Herder over Loop, because a loop that starts a run is less specific than the run itself; clearing a higher-priority status restores the next one. Full mode shows each once on its own status row below the Git row, in the order research, Herder, Loop, background processes, then other extension statuses except the language; the row disappears when none of these is set. At narrow widths, both layouts prioritize the model and context percentage: workflow summaries and other secondary details drop out and the bar shrinks or disappears before the model is truncated. Clearing a status removes it from the footer.

The `language` status from [Language](../language/README.md) shows in the bar in both compact and full modes, never on the status row: it is nearly always set and would keep that row open. It follows the provider in full mode and any workflow summary in compact mode. At narrow widths it is the first status to go: it needs room beside the model and context percentage, and once that runs out it drops out whole, while compact mode keeps the workflow summary and background processes as long as they fit. The provider, token counts, and compact mode's cost and elapsed time give way before it.

### The bar

- The model opens the bar as a chip in its vendor's color (Claude orange, OpenAI green, and so on; the theme accent for other vendors), with near-black or white ink, whichever contrasts more. The chip carries the live dot and the vendor mark.
- The rest of each group sits on a band of the theme's `toolPendingBg` surface. Bands end in powerline arrows with Nerd Fonts and in square ends without them, and a rule in the theme's `borderMuted` color joins the two bands across the gap.
- Theme colors are chosen for the terminal background, so a truecolor color with less than 3:1 contrast against the band is moved toward black or white until it reaches 3:1, keeping its hue; faint text is drawn at full intensity. On a light band, `dim` details darken instead of fading out. Resets inside the band, including those in an extension status that carries its own ANSI colors, reopen the band instead of ending it.
- In a 256-color theme the bar keeps its bands, caps, and rule but draws the model without a chip, because vendor colors need truecolor. Truecolor details, such as the thinking level and the context gradient, are still lifted against the band's xterm color; the theme's 256-color text is left as the theme set it.
- A theme whose `toolPendingBg` is the terminal default has no band to draw, so the bar's groups sit on the terminal background, without chip or caps, above the same rows. The bar follows `/theme` and theme-file edits on the next render.

### The rows below

- The telemetry, Git, and status rows hang from the bar on a `├`/`╰` rail in the theme's `borderMuted` color, the last row closing it. They are not filled, so the bar leads.
- Each row's facts come in groups: activity, latency, and tools on the left of the telemetry row, cost, tokens, and reasoning on its right. Thin chevrons in `borderMuted` separate the groups and point the way the bar's arrows do; without Nerd Fonts they are `│`.
- Icons carry the color and values stay `muted`, with the cost in `text` so it reads first. A value turns colored only to report a state: a first token slower than two seconds, failed tool calls, or the cache hit rate. The cache hit rate sits beside the cached-token count.
- A row that does not fit drops whole groups, least important first, instead of cutting text: reasoning tokens, then tools, activity, token counts, and latency, keeping the cost. On the Git row the path shortens from the middle (`~/…/project`), keeping as many trailing directories as fit; the touched-file count gives way before the path would drop below twelve columns. The status row drops statuses from the end.

Each extension status keeps one identity color, drawn from the theme's link, syntax, success, and border colors, for its icon and its first segment (split at ` · ` and `, `); the details stay `muted`. The footer never picks a red hue or one close to the theme's error or warning colors, so a routine status cannot look like a failure. Known extensions keep fixed colors; others get a stable color from their key. The status row also gives each status an icon: a flask for research, a sheep for Herder, a console for background processes, a robot for subagents, a palette for Impeccable, and a puzzle piece for other extensions. The language gets a translate icon in the bar in both modes, because a bare name does not say what it is. A status that starts with its own symbol, such as Loop's `↻`, gets no second icon, and compact mode shows no other status icons. Only the segments that report a problem stand out, and none of them in red: `failed`, `stuck`, `error`, `blocked`, or `not_met` use bold `warning`, and `paused`, `awaiting`, `stopping`, `killed`, or `for you` use `warning`; for example, in `bg 2 running · 1 failed` only `1 failed` turns amber. Matching is whole-word, so a loop named `fix-errors` stays calm. A status that already contains ANSI colors keeps them.

See [Autoresearch](../autoresearch/README.md) for baseline review, approved iterations, and the reporting tool, and [Herder](../herder/README.md) for verified orchestration runs.

## Background processes

The footer optionally integrates with [`@aliou/pi-processes`](https://github.com/aliou/pi-processes). Install it separately:

```bash
pi install npm:@aliou/pi-processes
```

Restart Pi, or use `/reload` to load both extensions. No fork or additional footer dependency is required. Compatibility is based on the package's in-process request/event protocol, verified against version 0.13.2.

The footer shows a summary such as `bg 2 running · 1 failed · 3 done`. Full mode places it on the status row after research, Herder, and Loop. Compact mode includes it alongside the selected workflow summary when the model and context percentage still fit. Stopping, stuck (termination timed out), and killed processes have separate counts. Finished counts remain until pi-processes clears or expires those entries; `/ps:clear` clears finished entries.

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
- Nerd Font icons are assumed in every terminal; the Claude and OpenAI logos need Nerd Fonts 3.5 or later. Orca needs no setup, because its terminal font list falls back to a bundled Nerd Font symbols font and then to an installed `Symbols Nerd Font Mono`. Set `STATUSLINE_NERD_FONTS=0` (or `FOOTER_NERD_FONTS=0`) for ASCII/Unicode icons in a terminal without a Nerd Font.
- Streaming metrics are measured passively from Pi's provider and message events rather than estimated. Completed samples survive `/reload` through a small session custom entry; a new, resumed, or restarted session starts fresh streaming metrics.
- Telemetry is scoped to the interactive TUI session, so programmatic child sessions such as `@tintinweb/pi-subagents` cannot reset or contaminate parent TTFT and token-throughput samples.
- TTFB and TTFT are shown separately to distinguish connection latency from a silent or buffered stream.
- Session cost, cost per turn, cache hit ratio, input/output totals, turns, compactions, tool calls, and errors come from session history. Magpie costs use upstream API estimates, displayed with `~$`. An unpriced selected Magpie model or any unpriced session usage shows **price unavailable** in both layouts and hides the dollar-per-turn average. Earlier Magpie messages with tokens but zero recorded cost remain unpriced; historical costs are not recalculated. Explicitly priced zero-cost usage and free models from other providers still display zero. ASCII mode shows a single dollar sign.
- Git branch and working-tree additions/deletions refresh asynchronously in the background.
- Session statistics are cached by the current branch leaf, keeping streaming renders inexpensive.
- Icons and semantic colors follow the active Pi theme.

## Requirements

- A current version of Pi.
- Icons need a [Nerd Font](https://www.nerdfonts.com/) as the terminal font or a fallback font, such as the standalone Symbols Nerd Font. Without one, set `STATUSLINE_NERD_FONTS=0`.

## Metric sources

- Context usage comes from Pi's context API; cost, turns, cache usage, compactions, errors, and touched files are derived from the active session branch.
- TTFT spans the provider request marker to the first nonempty streamed content, with `message_start` as a fallback request marker for providers that hide HTTP events. Empty block starts and empty deltas do not count as tokens.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput uses exact output-token usage over each whole call, from the request marker to the last token; requests without observed content, failed and aborted requests, and calls under 50 ms are excluded. The displayed average is total output tokens divided by total call time. The time after the first token is not used: many responses arrive in one burst once the model has finished, and hidden reasoning counts in output tokens without streaming, so it read as thousands of tokens per second. Throughput therefore includes the time to first token and reads lower than pure decoding speed.
- Cache hit rate is cached-read tokens divided by all input tokens: uncached input + cache reads + cache writes.
- Git branch comes from Pi's footer data. Working-tree state uses a throttled `git --no-optional-locks status --porcelain=v1 --untracked-files=normal`: a successful empty result is `clean`, any output is `dirty`, and a failed or pending status is shown as `git ?` or `git …`. Optional `git diff --shortstat HEAD` supplies additions/deletions, while `git rev-list --left-right --count @{upstream}...HEAD` supplies ahead/behind; either auxiliary query can fail without changing the authoritative status.
- Service tier is sniffed from the last `before_provider_request` payload and shown only when it is not `standard`/`default`/`auto`. `priority` displays as `FAST`; a request without a tier or a model change clears the previous badge.

## License

[MIT](../../LICENSE)
