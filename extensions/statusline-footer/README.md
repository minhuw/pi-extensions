# Statusline Footer

See the active model, context usage, cost, performance metrics, and Git state in Pi's footer. The extension collects the metrics and adapts to the active theme. Its layout follows [pikit](https://github.com/adrianapan/pikit)'s status bar: left/right justified rows, a gradient context bar, thinking-level colors, and Nerd Font icons with an ASCII/Unicode fallback. The model and context share a powerline bar; detail rows sit below it on a rail.

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

Full mode shows the identity bar, a telemetry row, and a Git row. A fourth row appears while an extension publishes a status other than language or spokesman. Primary facts sit on the left; capacity, cost, and path sit on the right. The example uses ASCII/Unicode icons; the bar's groups sit on colored bands:

```text
 ● ☾ k3   HIGH  (moonshot)  English  ─────────────────────────────────────────────  × 2×  ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉  8.2%  79k/1.1M
 ├ # 13  ⏱ 1h 28m  │  ⏱ 302ms ↺ 301ms  » 92 tok/s ↺ 91 tok/s    $0.750  $0.058/turn  │  ↑ 65k  ↓ 31k  ⚡ 120k 65%  │  ~2.4k memory
 ├ ⎇ main  +42 −17  ↑2 ↓1                                                 ⇌ 3 in · 2 out  │  ▤ 5 touched  │  ⌂ ~/code/my-project
 ╰ herder: T2 integrate · 3/5 tasks  │  ↻ build · next 4m  │  bg 1 running
```

| Row | Left | Right |
| --- | --- | --- |
| 1 | Live pulse, queued chip, model, Fast or non-standard service tier, thinking, provider, language, spokesman | Compactions, gradient bar, percent, used/window |
| 2 | Turns and elapsed time; TTFT, TTFB, and throughput; tool calls and errors | Cost and cost per turn; input / output / cached-input tokens and cache hit rate; Pika memory's context share; reasoning tokens |
| 3 | Git branch, working-tree diff, ahead/behind | Relay messages received and sent, files touched, current directory |
| 4 | Extension statuses except the language and spokesman: research, Herder, Loop, background processes, then the rest; shown only while one of these is set | |

The message counts on the Git row (`⇌ 3 in · 2 out`) tally [Pika](../pika/README.md) relay messages received and sent on the current session branch, read from Pika relay's `relay-received` and `relay-sent` session entries. A side with no messages is left out (`⇌ 2 out`), and the group disappears when both are zero. Compact mode does not show them.

The `~2.4k memory` group on the telemetry row shows how much of the context [Pika](../pika/README.md) memory uses: its memory section pinned in the system prompt, plus the `memory_read`, `memory_save`, and `memory_forget` results still in context, estimated at four characters per token. The footer reads the section's index from Pika memory's `pika-memory` session entry and the tool results from the current session branch; results that a compaction summarized away stop counting. The group disappears at zero, and compact mode does not show it.

The model name starts with its vendor's mark in the vendor's color. These are the OpenAI and Claude logos (Nerd Fonts 3.5 or later), the Google logo for Gemini, and related symbols for Kimi, DeepSeek, Grok, Llama, Mistral, and Qwen; with `STATUSLINE_NERD_FONTS=0`, Unicode marks such as `✻` (Claude), `⊛` (OpenAI), `✦` (Gemini), and `☾` (Kimi) take their place. The model id is matched before the provider, so Claude served through Vertex or Magpie still gets the Claude mark; an unrecognized model has none.

Thinking levels are colored: dim off, amber low, green medium, lilac high, and a rainbow wash at `xhigh`/`max`. The context bar interpolates success → warning → error across its width and uses the same `▉` block for filled and empty cells so the unused portion stays a quiet charcoal instead of a checkerboard.

Compact mode shows only the bar, with cost and elapsed time on the right. It also includes a workflow summary when there is room. Statuses published through `ctx.ui.setStatus("autoresearch", ...)`, `ctx.ui.setStatus("herder", ...)`, and `ctx.ui.setStatus("loop", ...)` compete for that space in this order: research, Herder, then Loop. Clearing a higher-priority status reveals the next one.

Full mode shows these statuses together on one row below Git, ordered as research, Herder, Loop, background processes, then other extensions except language and spokesman. Clearing a status removes it; the row disappears when none remain.

At narrow widths, both layouts preserve the model and context percentage. Workflow summaries and secondary details drop out, and the context bar shrinks or disappears before the model is truncated.

The `language` status from [Language](../language/README.md) and the `spokesman` status from [Spokesman](../spokesman/README.md) stay in the bar in both modes, so they do not keep the status row open. They follow the provider in full mode and any workflow summary in compact mode, with `spokesman` to the right of `language`. The provider, token counts, and compact mode's cost and elapsed time give way before `language` and `spokesman` do. As width narrows further, `spokesman` drops out whole before `language`, and `language` drops out whole when it no longer fits beside the model and context percentage. Compact mode keeps workflow and background-process summaries as long as they fit.

### The bar

- The model opens the bar as a chip in its vendor's color (Claude orange, OpenAI green, and so on; the theme accent for other vendors), with near-black or white ink, whichever contrasts more. The chip carries the live dot and the vendor mark.
- The rest of each group sits on a band of the theme's `toolPendingBg` surface. Bands end in powerline arrows with Nerd Fonts and in square ends without them, and a rule in the theme's `borderMuted` color joins the two bands across the gap.
- Theme colors are chosen for the terminal background, so a truecolor color with less than 3:1 contrast against the band is moved toward black or white until it reaches 3:1, keeping its hue; faint text is drawn at full intensity. On a light band, `dim` details darken instead of fading out. Resets inside the band, including those in an extension status that carries its own ANSI colors, reopen the band instead of ending it.
- In a 256-color theme the bar keeps its bands, caps, and rule but draws the model without a chip, because vendor colors need truecolor. Truecolor details, such as the thinking level and the context gradient, are still lifted against the band's xterm color; the theme's 256-color text is left as the theme set it.
- A theme whose `toolPendingBg` is the terminal default has no band to draw, so the bar's groups sit on the terminal background, without chip or caps, above the same rows. The bar follows `/theme` and theme-file edits on the next render.

### The rows below

- The telemetry, Git, and status rows hang from the bar on a `├`/`╰` rail in the theme's `borderMuted` color, the last row closing it. They are not filled, so the bar leads.
- Each row's facts come in groups: activity, latency, and tools on the left of the telemetry row, cost, tokens, memory, and reasoning on its right. Thin chevrons in `borderMuted` separate the groups and point the way the bar's arrows do; without Nerd Fonts they are `│`.
- Icons carry the color and values stay `muted`, with the cost in `text` so it reads first. A value turns colored only to report a state: a first token slower than two seconds, failed tool calls, or the cache hit rate. The cache hit rate sits beside the cached-token count.
- A row that does not fit drops whole groups, least important first, instead of cutting text: the memory estimate, then reasoning tokens, tools, activity, token counts, and latency, keeping the cost. On the Git row the path shortens from the middle (`~/…/project`), keeping as many trailing directories as fit; the relay message counts give way first, then the touched-file count, before the path would drop below twelve columns. The status row drops statuses from the end.

Each extension status keeps one identity color, drawn from the theme's link, syntax, success, and border colors, for its icon and its first segment (split at ` · ` and `, `); the details stay `muted`. The footer never picks a red hue or one close to the theme's error or warning colors, so a routine status cannot look like a failure. Known extensions keep fixed colors; others get a stable color from their key. The status row also gives each status an icon: a flask for research, a sheep for Herder, a console for background processes, a robot for subagents, a palette for Impeccable, and a puzzle piece for other extensions. The language and spokesman get translate and voice icons in the bar in both modes, because a bare name does not say what it is. A status that starts with its own symbol, such as Loop's `↻`, gets no second icon, and compact mode shows no other status icons. Only the segments that report a problem stand out, and none of them in red: `failed`, `stuck`, `error`, `blocked`, or `not_met` use bold `warning`, and `paused`, `awaiting`, `stopping`, `killed`, or `for you` use `warning`; for example, in `bg 2 running · 1 failed` only `1 failed` turns amber. Matching is whole-word, so a loop named `fix-errors` stays calm. A status that already contains ANSI colors keeps them.

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

- Context usage comes from Pi's context API; cost, turns, cache usage, compactions, errors, touched files, relay message counts, and the memory estimate are derived from the active session branch.
- The memory estimate counts the index in Pika memory's `pika-memory` entry plus the fixed text Pika and Pi wrap around it in the system prompt, and the text of memory tool results that the latest compaction kept in context or that came after it. The characters are divided by four and rounded up, the heuristic Pi's compaction uses. The section's size mirrors Pika's section text rather than reading the system prompt, so it is approximate.
- TTFT spans the provider request marker to the first nonempty streamed content, with `message_start` as a fallback request marker for providers that hide HTTP events. Empty block starts and empty deltas do not count as tokens.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput divides exact output-token usage by the duration of the whole call, from the request marker to the last token. Requests without observed content, failed or aborted requests, and calls under 50 ms are excluded. The displayed average is total output tokens divided by total call time. Including the time to first token avoids inflated rates when responses arrive in a single burst or include hidden reasoning tokens. This measures whole-call throughput and reads lower than pure decoding speed.
- Cache hit rate is cached-read tokens divided by all input tokens: uncached input + cache reads + cache writes.
- Git branch comes from Pi's footer data. Working-tree state uses a throttled `git --no-optional-locks status --porcelain=v1 --untracked-files=normal`: a successful empty result is `clean`, any output is `dirty`, and a failed or pending status is shown as `git ?` or `git …`. Optional `git diff --shortstat HEAD` supplies additions/deletions, while `git rev-list --left-right --count @{upstream}...HEAD` supplies ahead/behind; either auxiliary query can fail without changing the authoritative status.
- For a Magpie Responses model advertising `priority`, `FAST` or `FAST OFF` appears immediately after the model name and reflects the current session branch's `/fast` switch, before any request. The label disappears if the model is no longer eligible. Other non-standard tiers are shown from the last `before_provider_request` payload; on other APIs, a requested `priority` displays as `FAST`. A request without a tier or a model change clears the previous request's badge. These labels describe the switch or request, not the tier delivered upstream.

## License

[MIT](../../LICENSE)
