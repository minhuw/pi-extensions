# Code review and cleanup

Use [Quality](../../extensions/quality/README.md) to clean up a change, review it for bugs, or verify its behavior. Use [Commit](../../extensions/commit/README.md) when the work is ready to record. These are independent prompt templates in the current session, not an automatic pipeline.

| Command | Question | Can it edit source? |
| --- | --- | --- |
| `/review` | Does this change introduce a correctness bug, security issue, or regression? | No; findings and suggested fixes only. |
| `/verify` | What evidence shows that the acceptance criteria hold? | No repairs; ordinary build artifacts and disposable fixtures are allowed. |
| `/simplify` | Can this code be simpler, clearer, or more efficient without changing behavior? | Yes, minimal behavior-preserving cleanup. |
| `/deslop` | Did this change add needless narration, defensive code, type escapes, or hollow tests? | Yes, when evidence justifies removal or repair. |
| `/commit` | How should the completed work form self-contained patches? | Records existing in-scope work as commits; does not implement fixes. |

## Set the scope

Quality commands default to staged and unstaged changes against HEAD, plus relevant nonignored untracked source files. Supply a path, comparison, or focus when needed:

```text
/review main...HEAD
/review src/auth
/simplify focus on error handling
/deslop focus on tests
/verify src/auth
```

A focus narrows attention without authorizing unrelated cleanup. Repository-wide searches provide context. When there are no changes and no explicit target, the agent uses relevant files identified in the session or reports that it has no target.

## Clean up, review, then verify

After implementation, choose the cleanup pass that matches the problem:

```text
/simplify src/auth
```

Simplify examines reuse, quality, and efficiency and applies minimal justified changes. Use `/deslop` instead when the concern is unnecessary generated-looking code, such as narration comments, unsupported guards, quiet fallback paths, or tests that cannot fail. With a diff, Deslop targets added or modified lines and follows neighboring conventions. Explicitly selected files with no changes in scope are reviewed in full. It leaves uncertain removals for discussion.

Then inspect for bugs:

```text
/review src/auth
```

Review reports concrete failure scenarios in severity order and verifies findings against callers and contracts. It does not repair them. Ask for the appropriate fixes separately, and then verify the resulting behavior:

```text
/verify confirm that an expired session is rejected and a valid session still succeeds
```

Verify establishes acceptance criteria, runs relevant existing checks, and exercises the behavior where feasible. It reports each criterion as passed, failed, or not verified. It preserves source and the index, does not install dependencies, and reports missing prerequisites. A failed verification needs a separate repair before rerunning the affected checks.

Quality can use individual read-only agents for review when `Agent` is available; it falls back to the main session when needed. These commands do not start scripted workflows or Herder. Their read-only and cleanup boundaries are instructions, not a sandbox, so inspect the resulting changes and evidence.

## Record the completed work

Once the change and its validation are ready:

```text
/commit only the staged authentication changes
```

Invoking Commit authorizes committing that existing work. It groups changes by purpose, keeping implementation with necessary tests and documentation, and preserves meaningful staging. A coherent change can be one commit; larger work can become a series with valid intermediate trees. Commit uses normal Git hooks and signing and does not push, rewrite history, or silently fix code.

At handoff, distinguish review findings, test results, and observed runtime behavior. State which checks ran and what remains unverified. For durable implementation with approval and delivery gates, use the [Delegation guide](delegation.md).
