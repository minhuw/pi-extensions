---
description: Measure a performance claim with benchmark_compare and report the verdict with medians, ranges, and run counts
argument-hint: "<change or claim to measure>"
---
Measure the performance claim below and report only what the measurements support. Every number you report comes from `benchmark_compare`.
These instructions apply only to this invocation, not as permanent session rules. Use the current session's normal tools; do not launch scripted workflows or Herder.

## Before measuring
- Write down the claim you expect to make before running anything, for example "B parses the fixture 20% faster than A". Name the two sides, the workload, and the metric that decides it. If the claim changes after you see the results, say so.
- Read the measurement script or benchmark you will run, end to end, and note what it times and what it leaves out: setup, warmup, process start, I/O, caches, and the part that changed.
- Check machine load and core count (`uptime`, and `nproc` or `sysctl -n hw.ncpu`) and note them for the report. `benchmark_compare` alternates the two sides in every round, so drifting load hits both; if the machine is busy, keep the sides alternating and say the result is noisier.

## Build the harness
- Make the harness print one `METRIC name=value` line per metric on every run: the objective (such as `wall_ms`), an errors count (`errors=0` when every operation succeeded), and a work count (operations, items, or bytes actually processed). Declare them as `errorsMetric` and `workMetric`, so failed or skipped work makes the verdict inconclusive instead of fast.
- Run both sides the way production runs them: the same build mode and flags, inputs, configuration, concurrency, and warm or cold state. If one side cannot be tuned like production, call the result inconclusive and say why.
- List the harness files in `files` so they are pinned and cannot change during the measurement.

## Measure
- Measure only with `benchmark_compare`: one command for a single side, two to compare A against B. Use 5 repetitions unless a single run is very slow; then use fewer and say so. Do not time commands yourself or reuse numbers from earlier runs.
- If the tool reports a failed command, missing metrics, or a changed harness, fix the harness and measure again. Do not fill in the gap.

## Check the result
Answer each question in the report:
- What limits the number? Name the bottleneck (CPU, memory bandwidth, I/O, a lock, a syscall, process start) and why it is not twice as fast.
- Does the result break a physical limit, such as more bytes per second than memory or disk can move or more operations than the cores can execute, or does it save more time than the changed part takes in total? Then the measurement is wrong; find out why before reporting it.
- Were errors zero in every run, and does the work count show the work actually ran, equally on both sides?
- Does the difference matter end to end, for the program or request a user runs, not only in this benchmark?

## Report
Lead with the verdict exactly as `benchmark_compare` gave it, then each side's median, min–max range, and run count for the objective, the change in percent, and the machine load and core count. Never report a number the tool did not produce: no estimates, rounded-up speedups, or figures from memory. Say plainly that the verdict compares min–max ranges: it is a coarse check, not a significance test. "no measurable difference" is not an improvement, and "inconclusive" means no conclusion.

What to measure:
$ARGUMENTS
