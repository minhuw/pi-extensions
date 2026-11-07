# Benchmark

Use `/benchmark <what>` to test a performance claim. The prompt guides the agent through preparing a harness and interpreting the results; `benchmark_compare` runs the measurements and reports each metric's median, range, and run count with a verdict. This measures a claim in the current session. For repeated optimization experiments after baseline approval, use Autoresearch.

The collection loads this extension and its prompt automatically; use `/reload` after installing or updating it.

```text
/benchmark the new parser against main on the large fixture
```

## The `/benchmark` prompt

The prompt is a native Pi prompt template (`extensions/benchmark/prompts/benchmark.md`). It tells the agent to:

1. Write down the claim it expects to make before measuring.
2. Read the measurement script and note what it times.
3. Check machine load (`uptime`) and core count, and keep the sides alternating when the machine is busy.
4. Build a harness that prints one `METRIC` line per metric, including an errors count and a work count.
5. Run both sides the way production runs them, or call the result inconclusive.
6. Measure only with `benchmark_compare`, with 5 repetitions unless a run is very slow.
7. Check the result: identify the bottleneck, rule out impossible speedups, confirm zero errors and equal work, and explain whether the difference matters end to end.
8. Report the verdict first, with medians, ranges, and run counts, and never a number the tool did not produce.

## The `benchmark_compare` tool

```ts
benchmark_compare({
  commands: [
    { label: "main", command: "node bench/parse.mjs --impl old" },
    { label: "new", command: "node bench/parse.mjs --impl new" }
  ],
  metrics: [
    { name: "parse_ms", label: "Parse", unit: "ms", direction: "lower" },
    { name: "errors", direction: "lower" },
    { name: "files", direction: "higher" }
  ],
  errorsMetric: "errors",
  workMetric: "files",
  files: ["bench/parse.mjs"]
})
```

| Parameter | Accepts |
| --- | --- |
| `commands` | 1–2 shell commands (up to 2,000 characters), each with an optional single-line `label`. Labels default to `A` and `B` and must differ. |
| `metrics` | 1–8 metrics: `name` (a letter, then up to 47 letters, digits, or underscores), optional `label` and `unit`, `direction` (`lower` or `higher` is better), and optional `role` (`objective` or `informational`). Exactly one metric is the objective; the first one is when none is marked. |
| `errorsMetric` | Optional. The name of a metric that counts failed operations in a run. It must be one of `metrics` and not the objective. |
| `workMetric` | Optional. The name of a metric that counts the work a run did. It must be one of `metrics` and not the objective. |
| `repetitions` | 1–20, default 5. Each command runs this many times. |
| `timeoutSeconds` | 1–1,800, default 120, for each run. |
| `files` | 0–16 project-relative harness files, each at most 4 MiB. |

With one command, the tool runs it `repetitions` times. With two, it runs them alternately, A, B, A, B, for `repetitions` rounds. Alternating exposes both sides to load that drifts during measurement. Every run goes through Pi's `bash` tool and its normal hooks and permissions. A failed command, a missing, duplicate, or non-finite metric, or a timeout fails the whole call. When bash truncates a run's output, the metrics are read from its full output file.

The tool fingerprints the `files` with SHA-256 before the first run and checks them again after the last. It rejects paths and symlinks that escape the project, and a changed file fails the call. The extension adds no persistent report, status, or files of its own; the commands still run through bash.

## The METRIC format

Every run must print exactly one line per declared metric, on its own line:

```text
METRIC parse_ms=213.4
METRIC errors=0
METRIC files=1200
```

Other output is ignored.

## Results and verdict

The result is a Markdown table with each side's median, min–max range, and sample count for every metric, and, for two commands, the change of B's median against A's in percent (the absolute change when A's median is zero), followed by a verdict on the objective:

```text
| Metric | main | new | Change (new vs main) |
| --- | --- | --- | --- |
| Parse (objective, lower is better) | 213 ms (range 208–221 ms, n=5) | 171 ms (range 166–180 ms, n=5) | -19.7183% |

Verdict: new is better than main (Parse, lower is better; ranges do not overlap).
```

Declare `errorsMetric` and `workMetric` to enable the error and equal-work checks. Without them, the tool cannot use those checks to reject misleading results.

For two commands the verdict is:

- `inconclusive`, with its reason, when any run reports errors above zero, when the work metric's values are not all equal across every run of both sides, or when either side has fewer than 2 samples;
- otherwise `no measurable difference` when the objective's two ranges overlap, including ranges that only touch;
- otherwise `<B> is better than <A>` or `<B> is worse than <A>`, by the objective's direction.

For one command the verdict is `inconclusive`, with its reason, when any run reports errors above zero or the work metric's values are not all equal, and `measured` otherwise.

The range-overlap rule is a coarse check, not a significance test. With 5 alternating samples per side, two identical versions get non-overlapping ranges by chance about 2 times in 252. It also says nothing about whether the harness measures the right thing; the `/benchmark` prompt covers that.

## Shared module

`core.ts` is shared with [Autoresearch](../autoresearch/README.md): fingerprinting and verifying harness files, parsing `METRIC` lines, medians, ranges, the noise check, running commands through bash, and the comparison verdict. It registers nothing with Pi; Autoresearch imports only `core.ts`, not this extension.

## Development

```sh
npm run test:benchmark
npm run typecheck
```

The offline tests cover the runner's order and pinned files, the verdict rules, the tool's validation and output with a fake bash, one comparison through the real Pi `bash` tool, and loading and expanding the `/benchmark` prompt with Pi's resource loader. No provider credentials are required.
