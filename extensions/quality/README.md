# Quality

Four native Pi prompt templates for cleaning up, deslopping, reviewing, and verifying code changes. Each command runs independently in the current session using normal tools. No Quality runtime, custom parser, or automatic pipeline is installed.

## Commands

| Command | Purpose | Edits |
| --- | --- | --- |
| `/simplify` | Review reuse, quality, and efficiency, then apply minimal justified cleanup. | Behavior-preserving fixes within scope. |
| `/review` | Find correctness bugs, security issues, and regressions. | Findings and suggested fixes only. |
| `/verify` | Execute checks and exercise changed behavior against acceptance criteria. | No repairs; disposable fixtures and ordinary build/test artifacts are allowed. |
| `/deslop` | Find and remove AI code slop: narration comments, needless guards, hidden fallbacks, type escapes, and hollow tests. | Evidence-gated fixes within scope. |

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
/deslop
/deslop main...HEAD
/deslop focus on tests
```

Pi expands the [prompt templates](prompts) and passes optional instructions through native `$ARGUMENTS`. These instructions apply only to the invocation. A typical sequence is implementation, `/simplify` or `/deslop`, `/review`, fixing any findings, `/verify`, then `/commit`; no command starts the others automatically.

## Scope and behavior

All four commands default to staged and unstaged changes versus HEAD plus relevant nonignored untracked source files. Arguments can select paths or a comparison, or focus attention without widening the default scope. Review, Verify, and Deslop also accept a commit/range. Repository-wide searches supply context rather than permission for unrelated cleanup. With no changes or explicit target, the agent uses relevant files clearly identified by the current session, or reports no target. Outside Git, explicit paths are supported.

**Simplify** requests three parallel read-only reviewers for reuse, quality, and efficiency through `Agent` when available. All receive the same scope and context. The main session waits, verifies and deduplicates findings, then applies only minimal behavior-preserving fixes. Behavior-changing bugs are reported separately.

**Review** requests one independent read-only `reviewer` subagent when `Agent` is available. The main session verifies findings against callers and contracts, reports concrete failure scenarios in severity order, and does not apply fixes. It can run focused non-mutating checks to investigate a suspected issue.

**Deslop** targets code that looks plausible and passes checks but that a careful maintainer of the codebase would not write. Its catalog has three lenses:

- **Noise and residue:** comments that narrate code or the edit history, placeholders, debug output, and dead code.
- **Defensive and type slop:** guards for cases already excluded by types, callers, or validation; catches that rethrow, swallow, or return quiet defaults; `as any` and unexplained suppressions; shims for code that never shipped; and speculative abstraction.
- **Test slop:** assertions that cannot fail, tests that only check mocks, conditional or swallowed assertions, and duplicates.

When `Agent` is available, it requests one read-only reviewer per applicable lens in parallel. It skips the test lens when no tests are in scope. Slop is judged against local conventions: only lines added or modified by the scoped change are targets, and code that matches how neighboring code handles the same situation is left alone. The main session removes a guard only with evidence that it is unreachable. It keeps validation at trust boundaries and removes swallowed errors only when the change introduced them and nothing depends on them. It strengthens or deletes hollow tests but never weakens assertions or deletes the only test of a changed behavior. Uncertain items are left and listed. The report groups fixes by category.

Reviewers use the model configured for their agent type, or inherit the current session model when none is configured. With no `Agent`, the main session performs the reviews itself. Failed or incomplete reviewer coverage is completed in the main session and disclosed. None of these commands launches scripted workflows or Herder. Herder's `/herder-simplify` remains its separate planning workflow.

**Verify** runs in the main session. It establishes acceptance criteria, runs relevant existing checks, and exercises the affected behavior where feasible. Its report maps criteria to observations and marks them passed, failed, or not verified. It preserves source and the index, does not repair failures or install dependencies, and reports missing prerequisites. Scratch processes and files are cleaned up; remaining generated artifacts are disclosed. Historical revisions are checked in a disposable copy when feasible, never by resetting or switching the user's checkout.

Tests passing, a clean review, and runtime evidence answer different questions. For agent prompts, loading and expansion tests establish integration; assertions about instruction text do not prove model compliance. An actual observed invocation is needed to report live behavior, and one successful run is not a guarantee.

These are **instruction-based behaviors, not a sandbox or automatic enforcement**. Review resulting changes. None of the commands stages, commits, resets, or stashes work.

## Installation and migration

Collection users: update the package, then `/reload`. The command name `/simplify` and its behavior are unchanged; its template moved from `extensions/simplify/prompts/simplify.md` to `extensions/quality/prompts/simplify.md`.

If you load the old file directly or filter package prompts by path, update the path. For all four commands, select:

```text
extensions/quality/prompts/simplify.md
extensions/quality/prompts/review.md
extensions/quality/prompts/verify.md
extensions/quality/prompts/deslop.md
```

If package filters disable prompts or use `autoload: false`, enable these prompt resources. Remove old explicit paths and any other conflicting `/review`, `/verify`, or `/deslop` template or extension command. Package registration contains each Quality prompt once; no legacy Simplify alias is loaded.

For standalone use:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/simplify.md \
   --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/review.md \
   --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/verify.md \
   --prompt-template /absolute/path/to/pi-extensions/extensions/quality/prompts/deslop.md
```

Run `npm run test:quality` for native loading, expansion, documentation, and instruction-contract tests. The former `npm run test:simplify` remains an alias for that suite. These offline tests do not run live model invocations.

## Inspiration

Inspired by the cleanup, review, and verification workflows described in the [Claude Code local review documentation](https://code.claude.com/docs/en/code-review-local). These are independently written Pi prompts, with no claim of copied implementation or feature parity.

The Deslop catalog draws on Eric Zakariasson's [Cursor `/deslop` command](https://www.cursor.tips/command/Remove%20AI%20code%20slop), the overeagerness guidance in Anthropic's [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), the [aislop pattern catalog](https://scanaislop.com/patterns/), Tesbo's [failure modes of AI-written tests](https://www.tesbo.io/insights/roadmap/reviewing-ai-written-tests), and empirical studies of [over-mocking in agent-generated tests](https://arxiv.org/abs/2602.00409) and [test smells in LLM-generated unit tests](https://arxiv.org/abs/2410.10628).
