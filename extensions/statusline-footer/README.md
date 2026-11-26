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

Full mode picks one of three tiers from the terminal width alone, so the row count never jitters while a response streams or Git state settles. On the desk tier, up to two routine activity/collaboration items fold into the workspace row to stay stably at 3 rows; an attention/problem status, more than two items, or a crowded workspace row opens a dedicated activity row immediately below the bar. On the laptop tier, any activity or collaboration item opens the activity row. The examples use ASCII/Unicode icons; on a themed band, the bar's groups sit on colored bands.

**Desk** (175 columns or more): the bar, optional attention/overflow activity row, one telemetry row, and the workspace row. The desk keeps every metric:

```text
 ✻ claude-opus-5-5  ∴ HIGH  (anthropic)               ── ◦ ready ──               English  swarm 2/5 · 1 doing  selfdrive 2h13m  ━━━━━━━╸──────▕───  42.5%  43k/100k  +12k
 ├ herder: T2 verify blocked · 3/5 tasks                                                                                                                                      rep #dev
 ├ # 2  ◷ 1h 00m  │  ⚙ 2  ✕ 1 (50.0%)  │  ⏱ 300ms (400ms)  » 133 tok/s (150)          $1.95  $0.975/turn  ($1.20 sub)  │  ↑ 65k  ↓ 31k  ⚡ 120k 65% +18k wr · 3m12s  │  ~450 memory  │  12k think
 ╰ ⎇ main wt  +42 −17 ●1 ?2  ↑ 2  ↓ 1                                                                                                           ✎ 2 edited  │  ⌂ ~/code/my-project  │  #a1b2c3d4
```

**Laptop** (72 to 174 columns): the bar, the optional activity row, and one essentials row:

```text
 ✻ claude-opus-5-5  ∴ HIGH  (anthropic)                                              English  ━━━━━━━╸──────▕───  42.5%  43k/100k
 ├ herder: T2 verify blocked · 3/5 tasks                                                                                       rep #dev
 ╰ ⎇ main  +42 −17 ●1 ?2  ↑ 2  ↓ 1  │  $0.750  │  # 2  ◷ 1h 00m  │  ✕ 1 (50.0%)      ⏱ 300ms  » 133 tok/s  │  ⚡ 65% · 3m12s  │  ⌂ ~/code/my-project
```

**Phone** (71 columns or fewer, such as Orca's iPhone companion): exactly one row of plain text, without Nerd Font glyphs (whatever `STATUSLINE_NERD_FONTS` says), bands, or caps:

```text
 opus-5-5 · HIGH · 42.5% · $0.750 · herder blocked
```

| Row | Left | Right |
| --- | --- | --- |
| Identity (desk, laptop) | Model, requested speed or service tier, thinking level, provider, spokesman (falls back to left `●` live pulse and `queued` chip only when the bar is too narrow for the centered pill); horizontal middle shows a centered state pill lightly tinted by phase on truecolor themes (neutral `◦ ready`, warm amber `◔ queued` / `◑ waiting`, soft lavender `✦ thinking`, soft mint `✎ writing`, soft sky-blue tool icon + name, with elapsed seconds). When no other custom editor is installed, the input box keeps Pi's native top rule in quiet `borderMuted` (preserving `bashMode` color in bash mode), suppresses Pi's redundant generic `Working...` indicator while keeping compaction/retry/branch-summary and custom `setWorkingMessage()` notices on the top-left, shows a muted session title on the top-right border, and omits the redundant bottom rule on laptop/desk widths so the Powerline bar serves as the input box's single bottom edge (restoring the bottom rule for `↓ N more` scroll overflow, autocomplete menus, or phone width). | Response language, swarm (with live board progress), selfdrive, compactions (hidden at 0), gradient track bar with compaction notch, percent, used/window, last-turn context delta (desk, ≥ 5k) |
| Activity (desk: attention/overflow; laptop: optional) | Magpie quota wait, Research, Herder, Goal, background processes, subagents, then other extension statuses | Representative role, joined relay rooms, messages received and sent |
| Telemetry (desk) | Turns and elapsed time (`◷` in ASCII); tool calls (hidden at 0), errors and error rate (hidden at 0); average (last) TTFT, diagnostic TTFB (`⇄` in ASCII, `md-server-network` in Nerd Fonts, shown when `>= 1s` or `TTFT − TTFB >= 2s`), average (last) throughput (hidden before first sample) | Cost, cost per turn (shown after turn 1), and subagent cost share (`($X sub)` when `>= $0.005`); input / output / cached-input tokens, cache hit rate, cache writes (`+Nk wr`), and cache warmth countdown; Pika memory's context share; reasoning tokens |
| Workspace (desk, last) | Git branch (with `wt` badge in linked worktrees), porcelain working-tree status (`✕ N conflict(s)`, `+N −M`, `●N` staged, `?N` untracked, `~N` unstaged), ahead/behind; plus folded routine activity when ≤ 2 items fit | Folded routine collaboration when ≤ 2 items fit; files edited (`edit`/`write`), current directory (prefixed with `host:` over SSH), short 8-char session ID (`#abcd1234`, drops first) |
| Essentials (laptop, last) | Git branch (`wt` in linked worktrees), porcelain working-tree status, ahead/behind; cost; turns and elapsed time; tool errors and error rate, only when a tool call failed | Average TTFT and average throughput (hidden before first sample); cache hit rate and warmth countdown; current directory (with `host:` prefix over SSH) |
| Phone | Live indicator (`●` / `● 12s`) when busy, `queued` when messages are pending, model without vendor prefix (`claude-opus-5-5` reads `opus-5-5`), thinking level in its color, context percentage, cost (`price?` when unpriced), then attention and problem statuses | — |

A laptop leaves out diagnostic TTFB, parenthetical last-request values, cost per turn, subagent cost share, token counts, cache writes, memory, reasoning, edited files, short session ID, and the tool count when no call failed. The phone row shows an extension status only when it needs the user, as its leading word and severity marker, problems first: `herder blocked`, `quota awaiting`, `bg 1 failed`. The phone row uses a plain thinking label and omits the speed and tier badge, routine statuses, collaboration, language, spokesman, and modes.

The collaboration side of the activity row shows the representative role followed by joined [Pika](../pika/README.md) chatrooms and message counts (`rep #dev  │  ⇌ #ops · 3 in · 2 out`, with a monochrome Nerd Font bullhorn icon when Nerd Fonts are enabled). Pika publishes live membership through `ctx.ui.setStatus("relay-rooms", "#dev #ops")`: a plain string of sorted, sanitized room labels, cleared with `undefined` when no rooms are joined. The footer reads that status on every render, including when no messages have been exchanged or no workflow is active. Clearing it removes the room labels immediately. A room already present as an exact whitespace-delimited token in a plain representative status appears only once; `#dev` and `#dev-old` remain separate. Other joined rooms stay visible. Publisher-styled representative text keeps its own ANSI formatting.

The counts tally relay messages received and sent on the current session branch, read from Pika relay's `relay-received` and `relay-sent` session entries. A side with no messages is left out; without joined rooms, the group keeps its count-only form (`⇌ 2 out`). The group disappears only when there are neither rooms nor messages. Compact mode includes the representative role and additional room labels as an optional tail when space allows, with the same room deduplication; it omits the message counts.

The `~2.4k memory` group on the desk's telemetry row shows how much of the context [Pika](../pika/README.md) memory uses: its memory section pinned in the system prompt, plus the `memory_read`, `memory_save`, and `memory_forget` results still in context, estimated at four characters per token. The footer reads the section's index from Pika memory's `pika-memory` session entry and the tool results from the current session branch; results that a compaction summarized away stop counting. The group disappears at zero, and the laptop, phone, and compact layouts do not show it.

The model name starts with its vendor's mark in the vendor's color. These are the OpenAI and Claude logos (Nerd Fonts 3.5 or later), the Google logo for Gemini, and related symbols for Kimi, DeepSeek, Grok, Llama, Mistral, and Qwen; with `STATUSLINE_NERD_FONTS=0`, Unicode marks such as `✻` (Claude), `⊛` (OpenAI), `✦` (Gemini), and `☾` (Kimi) take their place. The model id is matched before the provider, so Claude served through Vertex or Magpie still gets the Claude mark; an unrecognized model has none.

The full and compact bars use the Nerd Font `mdi-brain` icon for thinking on reasoning models and `mdi-flash` for the requested speed or service tier. Their Unicode fallbacks are `∴` and `ϟ`. Both icons use a single space before their label, as in `ϟ OFF  ∴ XHIGH`.

Thinking levels use `dim` for `off`, `warning` for `low`, `success` for `medium`, the theme's `thinkingHigh` token (falling back to `accent`) for `high`, normal theme text for `xhigh`, and a rainbow for `max`. The context bar renders a horizontal track at 2× sub-cell precision (`━` filled, `╸` half-filled, `─` unfilled) interpolating `success` → `warning` → `error` across its width, with a compaction-threshold notch (`▕`, turning `warning` within 5% of compaction) whenever the bar is at least 8 cells wide. On a themed powerline band, the unfilled track is calibrated against the band's surface so it stays understated instead of being contrast-lifted.

Compact mode shows one bar. Workflow and background-process summaries follow the model details on the left. Cost, elapsed time, and optional collaboration follow context on the right.

```text
 ⊛ gpt-6.1-terra  ϟ OFF  last FLEX  ∴ XHIGH  goal: finish the migration            English  swarm  ━━━━╸───▕─  42.5%  43k/100k  ~$0.750  1h 00m
```

While Herder or Goal is active, Magpie quota, research, Herder, Goal, and background-process statuses fit individually, in that display order. Problem statuses take priority over attention statuses, which take priority over routine statuses; Herder wins ties at the same severity; Goal takes precedence over routine Research in compact mode. Quota attention and problem statuses can fall back to a concise marker such as `quota awaiting` before routine work is considered. If a status cannot fit even by itself beside the model and context percentage, shorter statuses can still appear.

To make room for concurrent activity, compact mode can omit Herder's trailing task count and abbreviate long operations or multi-step updates, keeping a prefix and a problem or attention marker when present. It can also abbreviate Goal and shorten a routine research summary to its current phase. Full details and publisher styling return as space becomes available. Attention and problem details in research statuses remain intact. Without Herder or Goal, the existing single-workflow slot selects `magpie-quota`, then `autoresearch`, with background processes alongside it when they fit.

Goal publishes `ctx.ui.setStatus("goal", text)` with a plain summary such as `goal: finish the migration`, and clears it with `undefined`. The footer reads the current status on every render.

Magpie publishes `ctx.ui.setStatus("magpie-quota", text)` while checking quota, waiting to continue automatically, or paused. For example, `quota awaiting · retry in 2h 10m · Nov 12, 14:30` shows the countdown and retry time. Magpie refreshes the minute-level countdown at least every 30 seconds and clears the status with `undefined` on continuation or cancellation; the footer reads the current text on every render without a quota timer. `awaiting` and `paused` use the existing warning styling.

Full mode shows workflow and process statuses together on the left of the activity row, ordered as Magpie quota wait, research, Herder, Goal, background processes, subagents, then unknown extensions. Collaboration sits on the right. When the row is crowded, Herder outlasts routine activity and collaboration, and Goal outlasts routine research and collaboration. Goal can shorten to a useful prefix; attention and problem statuses still take precedence. If an attention or problem Herder status cannot fit alone, a same-severity extension or representative status that fits takes priority. Clearing a status removes it immediately; the row disappears when neither side has content.

At narrow widths, every layout preserves the model and context percentage. In compact mode and on a laptop's bar, workflow summaries and secondary details drop out, and the context bar shrinks or disappears before the model is truncated. The phone row drops from its end, the thinking level last, and truncates the model before it would drop the context percentage.

In full and compact bars, the active response language starts the right band, immediately before swarm, selfdrive, and context. With both modes off, language sits directly before context. Spokesman stays on the left after the provider in full mode and after any workflow or process summaries in compact mode. The phone row omits both language and spokesman. See [Language](../language/README.md) and [Spokesman](../spokesman/README.md).

As space narrows, the provider, token counts, and compact cost and elapsed time give way before spokesman and language. Spokesman and language each drop as a whole, spokesman first. Compact mode keeps workflow and process summaries as long as they fit. Its optional collaboration tail gives way before cost and elapsed time.

Swarm and selfdrive outlast the other bar statuses and drop out together when they no longer fit beside the model and context percentage. Plain `swarm`, `selfdrive`, and `representative` statuses strip leading color emojis and use monochrome Nerd Font icons (`md-hexagon-multiple`, `md-rocket-launch`, `md-bullhorn-outline`; plain text when `STATUSLINE_NERD_FONTS=0`). When the session has an active swarm board, `swarm` displays live card counts (such as `swarm 2/5 · 1 doing` or `swarm 1/4 · 1 blocked`) and repaints automatically on board changes. The representative role belongs to collaboration on the full activity row and the optional compact tail. See [Delegation](../delegation/README.md), [Selfdrive](../selfdrive/README.md), and [Pika representatives](../pika/README.md#representatives).

### The bar

- The model opens the bar as a chip in its vendor's color (Claude orange, OpenAI green, and so on; the theme accent for other vendors), with near-black or white ink, whichever contrasts more. The chip carries the vendor mark, and adds the live `●` dot when the bar is too narrow for the centered state pill.
- The rest of each group sits on a band of the theme's `toolPendingBg` surface. Bands end in powerline arrows with Nerd Fonts and in square ends without them, and a rule in the theme's `borderMuted` color joins the two bands across the gap. When the gap fits, a rounded state pill (`◦ ready`, `◔ queued`, `◑ waiting`, `✦ thinking`, `✎ writing`, or the active tool with elapsed time), lightly tinted by phase on truecolor themes, floats centered on the rule.
- Theme colors are chosen for the terminal background, so a truecolor color with less than 3:1 contrast against the band is moved toward black or white until it reaches 3:1, keeping its hue; faint text is drawn at full intensity. Sequences that set their own background alongside a foreground (such as the calibrated unfilled track of the context bar) keep their intended contrast. On a light band, `dim` details darken instead of fading out. Resets inside the band, including those in an extension status that carries its own ANSI colors, reopen the band instead of ending it.
- In a 256-color theme the bar keeps its bands, caps, and rule but draws the model without a chip, because vendor colors need truecolor. Truecolor details, such as the thinking level and the context gradient, are still lifted against the band's xterm color; the theme's 256-color text is left as the theme set it.
- A theme whose `toolPendingBg` is the terminal default has no band to draw, so the bar's groups sit on the terminal background, without chip or caps, above the same rows. The bar follows `/theme` and theme-file edits on the next render.

### The rows below

- The activity row and the tier's rows hang from the bar on a `├`/`╰` rail in the theme's `borderMuted` color. The last row, workspace at a desk and essentials on a laptop, always closes it with `╰`, whether the optional activity row is present or absent. The rows are not filled, so the bar leads.
- Each row's facts come in groups, separated by `│` dividers in `borderMuted`. On a crowded metric row, the dividers can use one space on each side. The telemetry row puts turn/time, tool activity, and latency and throughput on the left, and cost, tokens, memory, and reasoning on the right.
- Both font modes use one space between a metric icon and its value and two spaces between adjacent metrics in a group. Icons carry the color and values stay `muted`, with the cost in `text` so it reads first. Input/output token counters stay calm and neutral (`dim`/`muted`), reserving error and warning tones for failures, slow TTFT, cache anomalies, near-compaction, and large context deltas (`>= 20k`). Zero-value clutter (0 compactions, 0 tool calls/errors, 1-turn cost/turn, and pre-sample latency placeholders) is omitted.
- A row that does not fit drops whole groups, least important first, and never adds a row. The desk's telemetry row drops memory, then reasoning, tokens, latency and throughput, and turn/time before cost; the tool count goes right after reasoning, but once a tool call has failed it outlasts everything except cost. The laptop's essentials row drops the cache rate, then latency and throughput, turn/time, the path, and cost before Git; failed tool calls outlast everything except Git. On the activity row, problem statuses outlast attention statuses, which outlast routine ones. Herder outlasts routine collaboration and other routine activity, and Goal outlasts routine collaboration and research; otherwise collaboration outlasts routine summaries, and ties among extension summaries keep their established order. Priority reads only published status text and leaves each status's familiar identity color intact. Relay rooms and counts form one optional group. The path shortens from the middle (`~/…/project`, preserving any SSH `host:` prefix) before other groups drop; on the workspace row the short session ID drops first, then the edited-file count, before Git or the path. Every layout continues to protect the model and context percentage.

Each extension status keeps one identity color, drawn from the theme's link, syntax, success, and border colors, for its icon and its first segment (split at ` · ` and `, `); the details stay `muted`. The footer never picks a red hue or one close to the theme's error or warning colors, so a routine status cannot look like a failure. Known extensions keep fixed colors; others get a stable color from their key. The activity row also gives each status an icon: a clock for Magpie quota waits, a flask for research, a sheep for Herder, a target for Goal, a console for background processes, a robot for subagents, and a puzzle piece for other extensions. The language and spokesman get translate and voice icons in the bar in both modes, because a bare name does not say what it is. A status that starts with its own symbol, such as a publisher’s own `↻`, gets no second icon, and compact mode shows no other status icons. Only the segments that report a problem stand out, and none of them in red: `failed`, `stuck`, `error`, `blocked`, or `not_met` use bold `warning`, and `paused`, `awaiting`, `stopping`, `killed`, or `for you` use `warning`; for example, in `bg 2 running · 1 failed` only `1 failed` turns amber. Matching is whole-word, so a status named `fix-errors` stays calm. A status that already contains ANSI colors keeps them.

See [Autoresearch](../autoresearch/README.md) for baseline review, approved iterations, and the reporting tool, and [Herder](../herder/README.md) for verified orchestration runs.

## Background processes

The footer optionally integrates with [`@aliou/pi-processes`](https://github.com/aliou/pi-processes). Install it separately:

```bash
pi install npm:@aliou/pi-processes
```

Restart Pi, or use `/reload` to load both extensions. No fork or additional footer dependency is required. Compatibility is based on the package's in-process request/event protocol, verified against version 0.13.2.

The footer shows a summary such as `bg 2 running · 1 failed · 3 done`. Full mode places it on the activity row after the Magpie quota wait, research, Herder, and Goal; a problem or attention state takes priority over routine statuses when space is tight. Compact mode includes it alongside workflow summaries when the model and context percentage still fit. Stopping, stuck (termination timed out), and killed processes have separate counts. Finished counts remain until pi-processes clears or expires those entries; `/ps:clear` clears finished entries.

Process changes update the summary through Pi's event bus. While jobs are live, a lightweight metadata refresh every two seconds also catches termination states that upstream does not broadcast; this does not invoke the model. Without pi-processes, nothing is displayed and no refresh timer runs. The adapter only reads process metadata; process execution, completion notifications, cancellation, and logs remain owned by pi-processes. `/ps` and `/ps:logs` continue to work. `/footer off` leaves the summary available through Pi's default footer.

For a single status display, leave pi-processes' **status widget** disabled in `/ps:settings` (its default), and use `/ps:dock close` if its log dock is open. Set its dock default to closed in `/ps:settings` to keep it closed on subsequent sessions. The footer does not change upstream UI settings or hide its panels.

## Commands

| Command | Effect |
| --- | --- |
| `/footer` | Toggle the custom footer on or off for the current session. |
| `/footer full` | Use the multi-line layout, which adapts to the width: desk, laptop, or phone tier. |
| `/footer compact` | Use the one-row layout at any width for the current session. |
| `/footer off` | Restore Pi's default footer for the current session. |
| `/footer default [full\|compact\|off]` | Show or save the default mode for new sessions (`<agentDir>/statusline-footer.json`). |
| `/footer debug` | Show metric-collection diagnostics for provider latency. |
| `/cache` | Open the interactive prefix KV cache inspector overlay (or show the summary notification when overlays are unavailable). |
| `/cache anomalies` | Open the cache inspector filtered to anomalous calls (or notify). |
| `/cache reset` | Clear in-memory prefix cache diagnostics for the current session. |

## Features

- A live context-window bar uses a positional RGB gradient (theme success/warning/error when the theme is 24-bit, otherwise a warm fallback).
- Thinking effort appears in uppercase, with normal theme text at `XHIGH` and a rainbow at `MAX`.
- Rows are left/right justified so identity stays put while capacity and cost hug the right edge.
- Nerd Font icons are assumed in every terminal; the Claude and OpenAI logos need Nerd Fonts 3.5 or later. Orca needs no setup, because its terminal font list falls back to a bundled Nerd Font symbols font and then to an installed `Symbols Nerd Font Mono`. Set `STATUSLINE_NERD_FONTS=0` (or `FOOTER_NERD_FONTS=0`) for ASCII/Unicode icons in a terminal without a Nerd Font.
- Streaming metrics are measured passively from Pi's provider and message events rather than estimated. Completed samples survive `/reload` through a small session custom entry; a new, resumed, or restarted session starts fresh streaming metrics.
- Telemetry is scoped to the interactive TUI session, so programmatic child sessions such as `@tintinweb/pi-subagents` cannot reset or contaminate parent TTFT and token-throughput samples.
- TTFB appears on the desk telemetry row only when diagnostic (`>= 1s` or `TTFT − TTFB >= 2s`) to distinguish connection latency from a silent or buffered stream without adding noise on healthy calls.
- Session cost, cost per turn, cache hit ratio, input/output totals, turns, compactions, tool calls, and errors come from session history. Magpie costs use upstream API estimates, displayed with `~$`. An unpriced selected Magpie model or any unpriced session usage shows **price unavailable** in both layouts (`price?` on the phone row) and hides the dollar-per-turn average. Earlier Magpie messages with tokens but zero recorded cost remain unpriced; historical costs are not recalculated. Explicitly priced zero-cost usage and free models from other providers still display zero. ASCII mode shows a single dollar sign.
- Git branch and working-tree additions/deletions refresh asynchronously in the background.
- Session statistics are cached by the current branch leaf, keeping streaming renders inexpensive.
- Icons and semantic colors follow the active Pi theme.

## Requirements

- A current version of Pi.
- Icons need a [Nerd Font](https://www.nerdfonts.com/) as the terminal font or a fallback font, such as the standalone Symbols Nerd Font. Without one, set `STATUSLINE_NERD_FONTS=0`.

## Metric sources

- Context usage comes from Pi's context API; cost (including subagent cost share from `toolResult.usage`), turns, cache usage (`cacheRead` and `cacheWrite`), compactions, errors, edited files (`edit`/`write` tool calls), relay message counts, and the memory estimate are derived from the active session branch.
- The memory estimate counts the index in Pika memory's `pika-memory` entry plus the fixed text Pika and Pi wrap around it in the system prompt, and the text of memory tool results that the latest compaction kept in context or that came after it. The characters are divided by four and rounded up, the heuristic Pi's compaction uses. The section's size mirrors Pika's section text rather than reading the system prompt, so it is approximate.
- TTFT spans the provider request marker to the first nonempty streamed content, with `message_start` as a fallback request marker for providers that hide HTTP events. Empty block starts and empty deltas do not count as tokens.
- TTFB uses Pi's provider-response event when the provider exposes it.
- Token throughput divides exact output-token usage by the duration of the whole call, from the request marker to the last token. Requests without observed content, failed or aborted requests, and calls under 50 ms are excluded. The displayed average is total output tokens divided by total call time. Including the time to first token avoids inflated rates when responses arrive in a single burst or include hidden reasoning tokens. This measures whole-call throughput and reads lower than pure decoding speed.
- Cache hit rate is cached-read tokens divided by all input tokens: uncached input + cache reads + cache writes.
- Prefix KV cache forensics observe outgoing `before_provider_request` payloads and finalized assistant usage in memory (never mutating payloads or persisting prompt text across reloads). When a prompt cache TTL is warm and healthy, the desk and laptop cache slot (`⚡`) shows a live countdown (such as `· 3m12s`, turning `warning` under 60s) and hides it once expired. When the latest call suffers a cache-miss anomaly, the slot appends a compact root-cause tag — `(!sys)` for system prompt mutation, `(!tools)` for tool schema changes, `(!strict)` for strict-tool retry fallbacks, `(!hist)` for rewritten or compacted history, `(!ttl)` for elapsed cache TTL expiry, `(!model)` for model switches, `(!route)` for intact-prefix routing misses, or `(!drop)` for unexplained drops. Use `/cache` or `/cache anomalies` to open the interactive overlay (or notification fallback) with sparklines, exact offsets (`char@`/`byte@`), tool diffs, and divergent item indices.
- Git branch comes from Pi's footer data. Linked worktrees are detected without spawning a subprocess by inspecting `.git` files pointing to `worktrees/`. Working-tree state uses a throttled `git --no-optional-locks status --porcelain=v1 --untracked-files=normal`: an empty result is `clean`, non-empty output is parsed into conflicts (`✕ N conflict(s)`), staged (`●N`), untracked (`?N`), and unstaged (`~N` fallback) counts, and a failed or pending status is shown as `git ?` or `git …`. Optional `git diff --shortstat HEAD` supplies additions/deletions, while `git rev-list --left-right --count @{upstream}...HEAD` supplies ahead/behind; either auxiliary query can fail without changing the authoritative status. Completing an `edit`, `write`, or `bash` tool call invalidates the throttle so the diff refreshes immediately.
- Footer refresh adapts to activity: a single unref'd timer ticks every 1s while a request/tool is running or the prompt cache countdown is warm, and relaxes to 30s when idle. Session mode changes survive `/reload`, while `/footer default [full|compact|off]` saves the startup default to `statusline-footer.json` in Pi's agent directory.

### Requested speed and service tier

The badge after the model reports request settings. The provider determines which capacity actually serves the request. The footer reads the latest outgoing payload from `before_provider_request`. Omitted settings and values such as `standard`, `default`, or `auto` add no label. A model change clears the previous request's labels.

- On a Magpie Responses model advertising `priority`, `ϟ ON` or `ϟ OFF` shows the current session branch’s `/fast` switch even before the first request. If a request specifies a different nonstandard tier, the badge appends its value, as in `ϟ OFF  last FLEX`.
- For other models, the badge shows the requested tier in uppercase. For example, `service_tier` values `priority`, `flex`, and `fast` appear as `ϟ PRIORITY`, `ϟ FLEX`, and `ϟ FAST`, respectively. [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- Anthropic Messages handles speed and capacity independently. `speed: "fast"` shows `ϟ FAST`, and `service_tier: "standard_only"` shows `ϟ STANDARD_ONLY`. An explicit request for both shows `ϟ FAST · STANDARD_ONLY`. [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)

## License

[MIT](../../LICENSE)
