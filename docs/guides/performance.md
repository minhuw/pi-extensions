# Performance work

Use Benchmark to test a performance claim, Autoresearch to improve a metric through approved experiments, and Goal to work toward a specific objective.

| Need | Start with | Expected result |
| --- | --- | --- |
| Check whether a change is faster | `/benchmark` | Measurements and a verdict on a stated claim. |
| Improve one metric within a defined scope | `/autoresearch` | A measured baseline for approval, then bounded experiments. |
| Work toward a specific objective | `/goal` | Continued work until the objective is completed, blocked, or paused. |

## Measure a claim

```text
/benchmark the new parser against main on the large fixture
```

[Benchmark](../../extensions/benchmark/README.md) asks the agent to inspect the harness and machine, state the claim, and measure through `benchmark_compare`. Two commands alternate A, B across rounds; five repetitions per side are the usual starting point.

Define the workload before measuring: input files, production execution path, cache state, warmup, and what the timer includes. Have the harness print one `METRIC name=value` line for every declared metric. Include an errors count and a work count, and declare them as `errorsMetric` and `workMetric`. A faster run that skipped inputs or failed requests is not evidence of improvement.

Report the tool's **median**, **min–max range**, and **sample count**, together with its verdict. Errors above zero, differing work counts, or fewer than two samples per side make a comparison inconclusive. Overlapping ranges mean no measurable difference under the tool's rule. Non-overlapping ranges are a coarse check, not a statistical significance test, and do not establish that the harness measures the right workload. Explain whether the observed change matters to the full operation.

## Optimize after reviewing the baseline

```text
/autoresearch optimize compilation speed --max 20
```

[Autoresearch](../../extensions/autoresearch/README.md) first creates a repeatable harness and measures a baseline. Review which build it times, what setup is excluded, which files may change, and which correctness checks must pass. If the workload is wrong, revise it:

```text
/autoresearch revise measure incremental compilation after editing one source file
```

When the workload and baseline match your goal, approve the proposal to start the bounded passes:

```text
/autoresearch approve
/autoresearch status
```

Approval pins the methodology, commands, metric definitions, and declared harness files. Changing the harness requires a new baseline and approval. Each pass tests a focused hypothesis with the approved measurement; the agent retains or undoes its own edits based on evidence. The extension does not automatically commit, reset, or clean the repository.

Autoresearch also reports medians, ranges, and counts. Its range comparison is a noise check, not a significance test. Put required correctness and workload constraints in the check command; marking a metric as a constraint does not enforce a threshold. Keep measurement plus checks short enough to fit within a pass.

```text
/autoresearch pause
/research-report
/autoresearch resume
/autoresearch stop
```

## Work toward an objective

Use Goal for a specific outcome, such as investigating a slow build:

```text
/goal --budget 100000 Investigate the slow build and identify its largest bottleneck with evidence
/goal status
/goal pause
```

Goal continues working toward the objective until it is completed, blocked, or paused. The optional token budget is soft; reaching it pauses the goal. Goal can also wait for external work, and does not schedule periodic monitoring. Include concrete checks in the objective, and use Benchmark to test a performance claim or Autoresearch for a bounded series of measured changes.
