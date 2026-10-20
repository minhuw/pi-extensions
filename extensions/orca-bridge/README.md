# Orca bridge

A dedicated Pi ≥1.3 extension that keeps Orca busy while the main agent or background extension work remains active. It maintains Orca-compatible terminal titles, provides `/orca-status` diagnostics, and adds `/orca-open` and `/orca-diff` navigation commands. It has no runtime dependency on Herder or Subagents.

The collection registers this extension automatically. It activates only inside an Orca pane. Load `extensions/orca-bridge/index.ts` through Pi's extension configuration when using it separately, or try it directly:

```sh
pi --extension ./extensions/orca-bridge/index.ts
```

The factory only registers handlers and the command. Activation, transport, and title animation begin at `session_start`; an idempotent `session_shutdown` handler removes listeners, stops animation, discards pending status, and releases ownership after a bounded final completion attempt.

## Activity protocol

Producers publish complete snapshots through Pi's shared event bus:

```ts
pi.events.emit("pi-extensions:activity", {
  source: "my-extension",
  activities: [
    { id: "build-1", label: "Building project" },
    { id: "review-1", label: "Reviewing changes" },
  ],
});

// Replace only this producer's snapshot with an empty snapshot to finish.
pi.events.emit("pi-extensions:activity", {
  source: "my-extension",
  activities: [],
});
```

IDs are independent across sources. A snapshot replaces the entire source, so a partial finish retains the other activities. Repeating or reordering the same snapshot causes no hook transition. Label changes update background titles without introducing an idle boundary.

Register a replay listener in the producer's factory and emit its current snapshot when the bridge asks:

```ts
pi.events.on("pi-extensions:activity-request", () => {
  pi.events.emit("pi-extensions:activity", currentSnapshot());
});
```

The bridge listens during factory loading, retains early snapshots without starting timers or transport, and requests replay on `session_start`, after all factories have run. Synchronous replay responses are applied together with early snapshots; asynchronous responses are accepted normally. Producers should replay their current state, including an empty snapshot, and publish updates whenever their activity changes. The bridge has no expiry policy: a producer must remove completed activity.

Validation is atomic. Sources are 1–64 ASCII letters, digits, `.`, `_`, or `-`. IDs are nonblank strings of at most 160 characters, and labels are nonblank strings of at most 240 characters. IDs and labels cannot contain C0/C1 control characters. Snapshots allow at most 128 activities, with unique IDs within each source; the bridge permits at most 64 nonempty sources and 1,024 total activities. Producers with larger fleets must publish at most 127 detailed activities plus one stable overflow sentinel whose label gives the number of additional active activities (for example, `{ id: "overflow", label: "23 additional activities" }`). Reserve the sentinel ID within that source, retain it while overflow remains, and remove it when the extra work ends. The sentinel counts as one bridge activity; the bridge does not expand it. Invalid, oversized, accessor-backed, and duplicate-ID snapshots leave the preceding source state intact. Unknown fields are ignored.

## Native chat and Pi RPC

The bridge integrates with unmodified Orca using its released hook and CLI interfaces. Background activity aggregation currently works in terminal panes. Stock Orca v1.4.230's native-chat adapter ignores extension status decorations and derives idle state from Pi's own streaming, compaction, and message queue, so this bridge cannot extend native chat's background indicator through the available interface.

In RPC mode, the bridge leaves Pi's idle state unchanged, sends no custom background-status messages, and disables terminal hooks and title updates. Navigation commands and standard Pi dialogs remain available through the existing RPC interface. Compatibility tests verify these behaviors without claiming native-chat background tracking.

## Ownership and managed Orca compatibility

The bridge detects its mode on `session_start`, after extension factories have run:

- **Managed:** Orca's installed Pi extension owns this PID (`ORCA_PI_STATUS_OWNED`) and exposes `globalThis.__orcaPiSubagents` with an active `Set` and `onEvent` handler. The bridge emits `task:subagent:lifecycle` deltas with IDs `pi-extensions:${source}:${id}`, `status: "started" | "completed"`, `agent` containing the activity label, and a source-qualified description. It adds replacement IDs before completing removed IDs. It never mutates Orca's roster and releases only IDs it announced. Orca remains responsible for root and completion hooks, and for prompts during a held root turn. Child-only runs use the supplemental prompt delivery described below. Managed roster labels are supplied when an ID starts; later label edits affect bridge titles without restarting the child.
- **Standalone:** The bridge reports aggregate root/background status itself and claims its PID in `ORCA_PI_STATUS_OWNED` while active, preventing inherited child processes from taking the pane. Shutdown restores the previous value only if the bridge's own assignment is still present.
- **Inactive:** Missing pane/endpoint configuration, another live owner PID, or a duplicate bridge for the same pane suppresses hooks and titles. A PID probe permits takeover only for `ESRCH`; other probe errors retain suppression. A process-global Symbol registry prevents duplicate activation despite Pi providing a different event-bus wrapper to each extension.

No installed extension, user configuration, or Orca repository is modified. Compatibility is isolated in `compatibility.ts`. It targets the managed **Pi** protocol described above, rather than OMP-specific event-bus properties.

## Supplemental managed prompts

Orca's managed reporter ignores `ui_prompt_start` when no Pi root turn has set its internal turn flag, even though background children have reported `agent_start`. The bridge tracks a root hold from `agent_start` until the parent has settled and all bridge activities and external managed children have ended. Prompts opened during that hold remain entirely with Orca's reporter, including their closing event if the final child finishes while the prompt is open.

When a prompt opens during a child-only run, the bridge sends supplemental `ui_prompt_start` and `ui_prompt_end` HTTP hooks using the same protocol and bounded transport as standalone delivery. Nested prompts share one opening and closing transition. Background work starting under an idle utility dialog also starts supplemental waiting; a dialog without work sends nothing. Activity changes and managed lifecycle notifications reassert `ui_prompt_active: true` while the supplemental dialog remains open, preserving waiting priority over child work/completion hooks. Closing `is_idle` includes both bridge and external managed activity. Shutdown cancels obsolete requests and, if a supplemental prompt remains open, attempts only its matching bounded `ui_prompt_end`; managed mode never sends its own root or `agent_end` hook.

Supplemental delivery neither imports the installed extension nor accesses its private post queue. It serializes its own requests with one active request and one replaceable pending status. Orca's reporter continues to deliver ordinary managed activity hooks independently. The installed modern title spinner owns prompt markers; the bridge stops painting throughout managed prompts.

## Standalone delivery

`agent_start` marks the parent busy. Only `agent_settled` releases the parent; `agent_end` never ends bridge activity because retries, compaction, and queued continuation may follow it. Effective busy state is `parent busy || background count > 0`. Prompt depth gives waiting indicators priority, and `ui_prompt_end.is_idle` includes background work.

The bridge posts `agent_start`, `agent_end`, `ui_prompt_start`, and `ui_prompt_end` to:

```text
POST http://127.0.0.1:<port>/hook/pi
X-Orca-Agent-Hook-Token: <token>
```

The envelope contains `paneKey`, `launchToken`, `tabId`, `worktreeId`, `env`, `version`, and `payload.hook_event_name`. Prompt state accompanies every status. It sends no prompts, tool inputs, assistant text, or tool-name events. Session metadata is included only if a safely obtained absolute `session_file` currently exists as a real file; getters and planned-but-uncreated session paths are tolerated.

`ORCA_PANE_KEY` is required. `ORCA_AGENT_HOOK_ENDPOINT` may point to a small local endpoint file containing either `KEY=value` or Windows `set KEY=value` lines. The port, token, environment, and version are resolved from this file **for every post**, with nonempty file values preferred over the environment:

| Setting | Purpose |
| --- | --- |
| `ORCA_AGENT_HOOK_PORT` | Integer loopback port, 1–65535 |
| `ORCA_AGENT_HOOK_TOKEN` | Required hook authentication token |
| `ORCA_AGENT_HOOK_ENV` | Orca environment identifier |
| `ORCA_AGENT_HOOK_VERSION` | Hook protocol version |
| `ORCA_AGENT_LAUNCH_TOKEN` | Launch identity in the envelope |
| `ORCA_TAB_ID`, `ORCA_WORKTREE_ID` | Optional envelope identity |

Requests are serialized with one active request and one replaceable latest pending status, rather than a growing event queue. Each attempt has a one-second timeout, including fetch implementations that fail to settle after abort. Shutdown aborts obsolete work and attempts one final completion within the same one-second per-request bound. There is no retry loop; subsequent state changes use fresh endpoint coordinates. Delivery failures never reject agent work. `/orca-status` reports readiness, mode/inactive reason, parent/background/prompt counts, activity labels, and a redacted HTTP result; it never prints authentication tokens, response bodies, or exception messages. No diagnostic tool is exposed to the model.

Standalone and supplemental managed prompt transport require Orca to be reachable through the process's own IPv4 loopback. There is no Windows-host curl fallback for WSL or cross-host delivery, and no guarantee of delivery while Orca is unavailable. Ordinary managed activity transport remains delegated to Orca's installed extension.

## Terminal titles

Title painting is restricted to `ctx.mode === "tui"`, with guarded context, UI, session-name, and cwd access. Titles preserve the session name and working directory and use Orca's parsed markers:

- `π ! …` while waiting for user input.
- `⠋ π : …` while working, with rotating spinner frames.
- `π > …` when idle.

Standalone mode paints parent and background activity. Managed mode animates background work after the parent settles; it stops its timer during parent work and prompts so Orca's existing spinner can paint those states. Background titles show the first three bridge labels and the remaining count, plus a count of external managed activities. Every frame reads the managed roster without modifying it, excluding IDs owned by this bridge. External children keep the title busy after the last bridge activity finishes; the timer detects their final completion, paints idle once, and stops even without a new producer snapshot. Timers are unreferenced, cleared on shutdown, and stopped when a stale UI cannot render.

## Navigation

Use these explicit commands to open a file, an existing review report, or a source-control diff in the pane's Orca workspace:

```text
/orca-open <path> [--line N] [--column N] [--focus]
/orca-diff <path> [--staged] [--focus]

/orca-open "Reports/Review Report.md" --line 42 --column 7
/orca-diff "src/Old File.ts" --staged --focus
/orca-open -- "-leading-dash.md"
```

Tabs open without moving your current view by default. Add `--focus` to switch to the opened tab. Diffs default to unstaged changes; `--staged` selects the staged diff and supports deleted paths. Lines and columns are positive safe integers starting at 1; `--column` requires `--line`. Only the options listed for each command are accepted, and duplicate options are errors.

Paths resolve relative to Pi's command working directory, including in folder workspaces without a Git repository. Matching single or double quotes group filenames with spaces; backslashes are literal. Use `--` before a filename beginning with `-`; all subsequent arguments are treated as filenames, so place options before the separator. Arguments are passed directly to the CLI without a shell, expansion, or interpolation.

Navigation always runs `worktree current --json` in Pi's command working directory before opening a file. Orca's CLI resolves the pane on the caller's host, including SSH workspaces that share an ID or path with another host. A valid inherited `ORCA_WORKTREE_ID` must match the returned full ID. The bridge preserves `worktree.identity.key` as an `identity:<key>` selector; older responses without an identity use `id:<returned full ID>`. Invalid inherited IDs are refused before execution. Missing, malformed, ambiguous, stale, or mismatched workspace identity stops the command without opening a file in another workspace. Remote and WSL connections retain the CLI's inherited routing; the bridge adds no host override. Orca validates that the absolute path belongs to the selected workspace; the bridge performs no local filesystem checks.

The commands use an inherited absolute `ORCA_CLI_COMMAND` first. Orca's managed WSL values `orca-ide` and `orca-dev` are resolved beneath the translated absolute `ORCA_WSL_CLI_DIR`. Otherwise the official `ORCA_CLI_BIN_DIR` is joined with `orca` (`orca.cmd` on Windows). Supplied launcher paths, including spaces, are passed as one literal command without shell parsing or interpolation. Invalid supplied paths are refused; failed or stale launchers never trigger a fallback. When neither variable is supplied, the CLI must be on `PATH`: `orca-ide` on Linux, `orca` on macOS and Windows. Linux never falls back to the bare `orca` screen-reader binary. Each CLI invocation has a ten-second timeout. Success requires a valid JSON response confirming the file opened; failures show static advice and recognized error codes without exposing raw CLI output, configuration, or exception text. Failed RPC commands also throw a command error. Pi emits it as an `extension_error` alongside a handled prompt acknowledgement. Stock Orca v1.4.230's native client ignores the associated notifications and may provide limited error feedback; use the terminal view for navigation diagnostics. A headless server reports `renderer_unavailable`; open a connected Orca app window before retrying.

`registerNavigationCommands(pi)` in `navigation.ts` registers only these user commands. Registration starts no processes or timers. Navigation exposes no model tools, generates no review reports, and publishes or shares nothing; `/orca-open` can open an existing report by its path.

## Offline verification

```sh
npx vitest run extensions/orca-bridge
```

The suite uses mocked fetch, fake timers, temporary endpoint/session files, separate event-bus wrappers, and isolated ownership globals/environment. It covers source/ID overlap, modern settlement, partial finishes, early capture/replay, validation limits, prompts and titles, nested/duplicate ownership, managed relaying, endpoint rotation, HTTP/network errors, stalled requests, bounded queue ordering, stale getters, and shutdown/reload cleanup. It also loads the [actual v1.4.230 managed reporter](tests/fixtures/README.md) in both factory orders and launches an isolated real Pi RPC process to check command discovery, unchanged model-idle state while extension work exists, absence of custom bridge status messages, and dialogs without a model call. Navigation tests mock CLI execution. No live Orca or provider requests are made.
