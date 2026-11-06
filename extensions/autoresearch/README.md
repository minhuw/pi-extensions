# Autoresearch

A native, main-session optimization workflow with baseline review before autonomous experiments. Start with one command:

```text
/autoresearch optimize compilation speed --max 20
```

## Baseline first, optimization after approval

The command starts a setup pass in the current conversation. The agent inspects the project, understands what you want to optimize, implements a repeatable measurement harness, and calls `autoresearch_baseline` to run it.

For compilation speed, the methodology should explain:

- Which inputs and build command are measured.
- Whether this is a clean build or incremental build, and how caches and build outputs are handled.
- Which setup work is excluded, such as dependency installation or warmup.
- The primary metric, units, repetition count, and aggregation.
- What implementation changes are in scope and which correctness checks must continue to pass.

The extension runs the command through Pi's `bash` tool, parses its metrics, runs any configured correctness check, and records the baseline. By default it runs three repetitions and uses the median. The agent presents the methodology, individual samples, and initial results, asks whether they match your intent, and stops.

**Optimization does not start until you run:**

```text
/autoresearch approve
```

Approval is a user command, with no model-callable equivalent. A conversational reply such as “yes” does not itself enable scheduling; the agent should direct you to the approval command.

If the proposed workload or measurement is wrong:

```text
/autoresearch revise measure incremental compilation after editing one source file
```

This returns to setup, creates a fresh comparison, measures the revised baseline, and requires approval again.

After approval, the extension schedules bounded experiment passes in the same Pi session. Each pass chooses a hypothesis, makes a focused change, measures it using the approved benchmark, reports its findings, and retains or undoes its own edits based on the evidence. Code changes and undo decisions are performed by the agent; the extension does not automatically commit, reset, or clean the repository.

## Commands

| Command | Effect |
| --- | --- |
| `/autoresearch <target> [--max N]` | Understand the target, implement the harness, measure the baseline, and request review. |
| `/autoresearch approve` | Approve the pending measured baseline and start optimization. |
| `/autoresearch revise <feedback>` | Return to setup with feedback; discard the previous approval and require a new one. |
| `/autoresearch status` | Show the methodology, samples, per-metric ranges, baseline measurement time, metric table, and campaign state as a transcript entry in TUI or a notification in RPC, outside model context. |
| `/autoresearch pause` | Pause scheduling and abort an owned active pass. |
| `/autoresearch resume` | Resume a paused campaign. An unapproved baseline still needs approval; its proposal is shown again for review, like `/autoresearch status`. An approved campaign at its iteration or lifetime limit is marked complete instead, so `/autoresearch <target>` can start a new one; otherwise its pinned harness is re-checked before any pass is scheduled. |
| `/autoresearch stop` | Stop the campaign and abort an owned active pass. Preserve reports and working files. |
| `/autoresearch help` | Show syntax and limits. |
| `/research-report` or `/research-report results` | Show the current report, displayed like `/autoresearch status`. |
| `/research-report clear` | Clear a stopped/completed campaign or standalone report. Stop an active campaign first. |

The default is 25 optimization passes; `--max` accepts 1–1,000 and must appear at the end of the start command. Campaigns have a six-hour lifetime after approval. Reaching the iteration limit completes the campaign; reaching the lifetime pauses it, and `/autoresearch resume` then marks it complete. Each optimization pass has a 15-minute timeout; initial setup has 30 minutes. The setup and iteration prompts state these pass limits. Because each iteration must fit a focused edit plus one full `autoresearch_measure` (every repetition plus the correctness check), the setup prompt asks the agent to size the workload and repetitions so that one measurement takes well under half the iteration limit. Timeouts and interrupted/unmeasured passes pause for explicit recovery. A failed latest measurement cannot be masked by an earlier successful measurement in the same pass.

## Measurement tools

During setup, the agent constructs the harness and calls a tool like:

```ts
autoresearch_baseline({
  methodology: "Clean compilation of the fixed inputs. Remove build outputs before each run; dependency installation is excluded. Measure elapsed milliseconds, three repetitions, median. Preserve the existing correctness suite.",
  command: "bash .autoresearch/measure.sh",
  checkCommand: "npm test",
  files: [".autoresearch/measure.sh"],
  repetitions: 3,
  timeoutSeconds: 120,
  metrics: [
    { name: "compile_ms", label: "Compile", unit: "ms", direction: "lower", role: "objective" },
    { name: "peak_memory", label: "Memory", unit: "MB", direction: "lower", role: "constraint" }
  ]
})
```

Each benchmark invocation must print exactly one line per declared metric:

```text
METRIC compile_ms=213
METRIC peak_memory=94
```

The measurement schema allows 1–8 metrics with unique names and exactly one objective. The first metric defaults to the objective when no explicit objective is given. Other unspecified roles default to informational. Directions are `lower` or `higher`. Missing, duplicate, or non-finite metric values fail measurement. A constraint's role is descriptive; enforce required acceptance criteria in the correctness check.

`repetitions` accepts 1–10 and defaults to 3. `timeoutSeconds` applies separately to each benchmark/check command, accepts 1–1,800, and defaults to 120. The outer pass timeout still applies. Correctness-check runtime is excluded from the benchmark's reported metrics.

`autoresearch_baseline` also records the wall time of the whole baseline measurement, every repetition plus the correctness check. The baseline proposal, `/autoresearch status`, and every iteration prompt show it with the pass limits:

```text
Baseline measurement time: 2m 10s (every repetition plus the correctness check); pass limits: 30 minutes for setup, 15 minutes per optimization iteration.
```

When the baseline measurement takes more than half of the 15-minute iteration limit, a warning follows: iterations will likely time out and pause the campaign, so use fewer repetitions or a smaller workload via `/autoresearch revise <feedback>`. Campaigns saved before this time was recorded show no timing line.

The working directory, iteration limit, benchmark/check commands, methodology, metric definitions, baseline, and SHA-256 fingerprints of the declared harness files are bound to the approval. List every measurement/check harness file in `files` (1–16 project-relative files, each at most 4 MiB). Paths and symlinks escaping the project are rejected. Harness content is checked before and after measurement, before approval, and before resuming an approved campaign. A changed harness requires a revised baseline and fresh approval; a resume that finds one keeps the campaign paused and schedules nothing.

During an approved iteration, the agent calls `autoresearch_measure({})`. It accepts no replacement command or metric values, uses the approved configuration, and records the measured samples and medians. Both measurement tools invoke nested `bash` calls through Pi's normal tool hooks and permissions.

The agent communicates with the user using:

```ts
autoresearch_update({
  phase: "editing",
  message: "Testing whether caching parsed inputs reduces incremental compilation time."
})
```

Phases are `planning`, `editing`, `measuring`, `checking`, `paused`, and `complete`. Paused/complete updates end automatic continuation. After `autoresearch_baseline`, the setup pass may still post progress messages until it ends, but a paused or complete update is rejected because the measured baseline awaits `/autoresearch approve`; the campaign and its approval are unchanged. Campaign metric values come exclusively from the measurement tools; `autoresearch_update` cannot replace them. Before a campaign exists, the reporting tool still supports standalone model-reported tables for compatibility with the first version.

## Presentation

The footer uses Pi's `ctx.ui.setStatus("autoresearch", ...)` API:

```text
research · preparing
research · awaiting approval · measured · Compile 213 ms (0%)
research · run 3/20 · measured · Compile 182 ms (-14.554%)
```

The tool response and report command display the agent's message and all metrics. Status and report displays never enter model context: in TUI they appear as transcript entries, and in RPC as notifications. Negative change means the number decreased; direction determines whether that is desirable. The extension computes arithmetic and distinguishes tool-measured numbers from standalone model-reported numbers. Parsing a measurement does not establish that the methodology is appropriate or that an improvement is statistically significant; reviewing the baseline is part of the workflow.

The baseline proposal and `/autoresearch status` show each metric's baseline median, min–max range, and sample count:

```text
Compile: baseline 100 ms (range 90–110 ms, n=3)
```

Each `autoresearch_measure` result adds the latest median, range, and count for every metric, and a noise verdict for the objective:

```text
Compile: baseline 100 ms (range 90–110 ms, n=3); latest 80 ms (range 75–85 ms, n=3)
Noise check for Compile (objective): outside noise.
```

The verdict is `within noise` when the baseline and latest ranges overlap, including ranges that only touch; that is no measurable difference. It is `outside noise` when the ranges do not overlap, and `noise unknown` when either side has fewer than 2 samples. The iteration prompt tells the agent that a result within noise is not an improvement. This is a coarse check, not a significance test: with 3 independent samples per side, two identical versions produce non-overlapping ranges by chance about 1 time in 10.

[Statusline Footer](../statusline-footer/README.md) displays research status on the Git row in full mode and prioritizes it over Loop in compact mode. Clearing the report restores Loop's summary. Model identity and context percentage take priority at narrow widths. Pi's default footer can also display the status.

## Session lifecycle

Campaigns and reports are stored together in versioned custom session entries, outside model context. They survive compaction and follow the selected conversation branch. Status and report displays are separate transcript entries in TUI and notifications in RPC, also outside model context; restoration reads only the latest snapshot. Earlier standalone reporting snapshots are supported. Each new pass receives a checkpoint reconstructed from stored methodology and measurements, without replacing Pi/Magpie compaction.

The scheduler waits outside Pi's queue until the session is idle, no user messages are pending, and no extension dialog is open. Only one pass is owned at a time. User input, aborts, unrelated prompts taking over a pass, or tree navigation prevent silent continuation. Stale queued passes are canceled before a provider request. Results arriving after ownership is lost are rejected.

Reloads, resumed sessions, forks, and tree navigation restore unfinished running/setup campaigns as paused; explicitly resume them. Proposals awaiting approval remain awaiting approval and never start on restoration. A malformed latest snapshot fails closed instead of resurrecting older data. Clear it explicitly to recover. Timers are removed on shutdown.

If a scheduler snapshot write fails, the extension clears timers and ownership and attempts to abort its active pass independently of whether the state can be saved. Once storage is available, `/autoresearch stop` or `/research-report clear` recovers the invalid runtime without requiring a reload. Explicit pause/stop also aborts owned execution before attempting persistence.

Automatic workflows run in TUI and RPC sessions. Print/headless child sessions cannot start campaigns. Standalone reporting remains usable in headless sessions without publishing into the parent's UI. No provider-backed tests or live experiments run merely by loading this extension.

## Installation and migration

The extension collection loads Autoresearch automatically. Run `/reload` after updating.

This native workflow owns `/autoresearch`. Disable or remove `npm:pi-autoresearch` from your Pi profile before using it; loading both creates a command collision. Existing `.auto/` files are preserved. The native workflow uses session storage and does not automatically import or execute old campaign data.

For a standalone local load:

```sh
pi -e ./extensions/autoresearch/index.ts
```

## Development

```sh
npm run test:autoresearch
npm run test:benchmark
npm run test:statusline
npm run test:loop
npm run typecheck
```

Offline tests cover baseline approval, revisions, pinned harnesses, median metrics and checks, ranges and noise verdicts, interruption and late results, limits, persistence failure, branch/reload recovery, child isolation, footer coexistence, and a real Pi session using a local faux model plus the real `bash` tool. No provider credentials are required.
