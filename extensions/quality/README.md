# Quality

Three native Pi prompt templates for cleaning up, reviewing, and verifying code changes. Each command runs independently in the current session using normal tools. No Quality runtime, custom parser, or automatic pipeline is installed.

## Commands

| Command | Purpose | Edits |
| --- | --- | --- |
| `/simplify` | Review reuse, quality, and efficiency, then apply minimal justified cleanup. | Behavior-preserving fixes within scope. |
| `/review` | Find correctness bugs, security issues, and regressions. | Findings and suggested fixes only. |
| `/verify` | Execute checks and exercise changed behavior against acceptance criteria. | No repairs; disposable fixtures and ordinary build/test artifacts are allowed. |

```text
/simplify
/simplify focus on error handling
/simplify src/auth
/review
/review main...HEAD
/review src/auth
/verify
/verify src/auth
/verify confirm that /simplify loads and arguments expand correctly
```

Pi expands the [prompt templates](prompts) and passes optional instructions through native `$ARGUMENTS`. These instructions apply only to the invocation. A typical sequence is implementation, `/simplify`, `/review`, fixing any findings, `/verify`, then `/commit`; no command starts the others automatically.

## Scope and behavior

All three commands default to staged and unstaged changes versus HEAD plus relevant nonignored untracked source files. Arguments can select paths or a comparison, or focus attention without widening the default scope. Review and Verify also accept a commit/range. Repository-wide searches supply context rather than permission for unrelated cleanup. With no changes or explicit target, the agent uses relevant files clearly identified by the current session, or reports no target. Outside Git, explicit paths are supported.

**Simplify** requests three parallel read-only reviewers for reuse, quality, and efficiency through `Agent` when available. All receive the same scope and context. The main session waits, verifies and deduplicates findings, then applies only minimal behavior-preserving fixes. Behavior-changing bugs are reported separately.

**Review** requests one independent read-only `reviewer` subagent when `Agent` is available. The main session verifies findings against callers and contracts, reports concrete failure scenarios in severity order, and does not apply fixes. It can run focused non-mutating checks to investigate a suspected issue.

Reviewers use the model configured for their agent type, or inherit the current session model when none is configured. With no `Agent`, the main session performs the reviews itself. Failed or incomplete reviewer coverage is completed in the main session and disclosed. Neither command launches scripted workflows or Herder. Herder's `/herder-simplify` remains its separate planning workflow.

**Verify** runs in the main session. It establishes acceptance criteria, runs relevant existing checks, and exercises the affected behavior where feasible. Its report maps criteria to observations and marks them passed, failed, or not verified. It preserves source and the index, does not repair failures or install dependencies, and reports missing prerequisites. Scratch processes and files are cleaned up; remaining generated artifacts are disclosed. Historical revisions are checked in a disposable copy when feasible, never by resetting or switching the user's checkout.

Tests passing, a clean review, and runtime evidence answer different questions. For agent prompts, loading and expansion tests establish integration; assertions about instruction text do not prove model compliance. An actual observed invocation is needed to report live behavior, and one successful run is not a guarantee.

These are **instruction-based behaviors, not a sandbox or automatic enforcement**. Review resulting changes. None of the commands stages, commits, resets, or stashes work.

## Installation and migration

Collection users: update the package, then `/reload`. The command name `/simplify` and its behavior are unchanged; its template moved from `extensions/simplify/prompts/simplify.md` to `extensions/quality/prompts/simplify.md`.

If you load the old file directly or filter package prompts by path, update the path. For all three commands, select:

```text
extensions/quality/prompts/simplify.md
extensions/quality/prompts/review.md
extensions/quality/prompts/verify.md
```

If package filters disable prompts or use `autoload: false`, enable these prompt resources. Remove old explicit paths and any other conflicting `/review` or `/verify` template or extension command. Package registration contains each Quality prompt once; no legacy Simplify alias is loaded.

For standalone use:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/simplify.md \
   --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/review.md \
   --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/verify.md
```

Run `npm run test:quality` for native loading, expansion, documentation, and instruction-contract tests. The former `npm run test:simplify` remains an alias for that suite. These offline tests do not run live model invocations.

## Inspiration

Inspired by the cleanup, review, and verification workflows described in the [Claude Code local review documentation](https://code.claude.com/docs/en/code-review-local). These are independently written Pi prompts, with no claim of copied implementation or feature parity.
