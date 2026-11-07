# Delegation

Choose delegation by the task’s scope and how long its state needs to last. An individual agent handles one bounded question or change. Scripted workflows coordinate explicitly requested multi-agent work. Herder adds durable state, isolated writing steps, checks, and confirmed delivery.

## Hand off one task

[Subagents](../../extensions/subagents/README.md) exposes the `Agent` tool and a fleet you can inspect with `/agents`. Ask the main session to use a named role and specify what it should return:

| Role | Suitable task | Example request |
| --- | --- | --- |
| `recon` | Read-only exploration and a compact handoff. | “Use recon to trace how an upload reaches storage. Return the entry points and relevant tests.” |
| `worker` | Bounded implementation and verification. | “Use a worker to add the missing invalid-input test in the parser suite. Run that suite and report the result.” |
| `reviewer` | Read-only review ranked by severity. | “Use a reviewer to inspect the parser diff for correctness bugs. Give a failing input for each finding; do not edit.” |

Give each agent a goal, relevant paths, permission to make specific changes, and the evidence it must return. Foreground execution is the default. Custom definitions may override the embedded roles and their models; read-only role instructions are not an operating-system sandbox.

For difficult architectural, design, or tradeoff questions where a single advisor (`expert`) has been retired, convene the three-model [Council](../../extensions/council/README.md) via `/council <topic>` or the `council` tool (`argon` on `magpie/gemini-4-argon`, `astra` on `magpie/gpt-6-astra`, and `opus` on `magpie/claude-opus-5-5`). Council runs an independent proposal round in parallel followed by an anonymized, position-counterbalanced cross-examination round before the main session synthesizes the result.

For a small implementation, start with a worker followed by a reviewer. Wait for the writer before reviewing or testing its result. Keep the main session responsible for resolving findings and checking the final change.

## Coordinate several agents explicitly

Scripted `SubagentWorkflow` execution is **disabled by default**. Enable `workflowsEnabled: true` in the supported global or project `subagents.json`, then reload with no agents running. Configuration alone does not authorize orchestration: request the workflow explicitly.

A bounded request might be:

```text
Use a scripted multi-agent workflow: have recon locate the parser's callers,
then a worker add support for trailing whitespace, then a reviewer inspect
that change. Run the parser tests after the writer finishes.
```

Workflow children share the run's working directory and current files by default. Keep writing scopes disjoint or use a child's `isolation: "worktree"` option when writers would conflict. The [Subagents reference](../../extensions/subagents/README.md#workflows) describes the current reliability limits. Some validation failures return error text without an error flag, and reloads lose the in-memory run records needed for resume. Read the returned text and check actual outputs and test results before accepting a workflow result.

## Keep a run across sessions

Choose [Herder](../../extensions/herder/README.md) when you need to resume work across sessions and keep implementation isolated until delivery:

```text
/herder add a --json flag to the export command
```

Herder needs Git 2.38+, a repository with a commit, and an interactive TUI or RPC session. The main model prepares a goal with acceptance criteria and checks; you approve that goal before implementation begins. Writing steps run in disposable worktrees and return commits on hidden refs. A single writing step plus checks is the default; a workflow script is optional.

```text
/herder status
/herder resume
/herder deliver
```

The journal survives process exits and session changes. Verification runs the goal's checks, with an independent verifier for non-trivial runs, and the runtime determines whether the goal is met. Delivery still requires your confirmation before changes reach your checkout or a delivery branch. See the [delivery modes](../../extensions/herder/README.md#delivery) for a commit series, branch, squash, or uncommitted changes.

Ordinary Agent calls and Subagents workflows do not become Herder runs automatically. Choose Herder at the start when its approval, isolation, recovery, and delivery rules are part of the work you want.
