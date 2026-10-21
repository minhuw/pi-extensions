# Simplify

A native Pi `/simplify` prompt for direct, bounded cleanup of changed code. Invocation authorizes minimal, justified fixes after reviews for reuse, quality, and efficiency. There is no Simplify runtime.

## Usage

```text
/simplify
/simplify focus on error handling
/simplify src/auth
```

Pi expands [prompts/simplify.md](prompts/simplify.md) in the current session, passing optional scope or focus through native `$ARGUMENTS`. Instructions apply only to that invocation.

## Scope and behavior

The agent inspects Git status first. Default scope includes staged and unstaged changes versus HEAD and relevant nonignored untracked source files, including new files. Explicit arguments can select paths or a branch comparison; a concern such as error handling focuses the review without widening its scope. Repository-wide searches help find existing equivalents and callers; they do not authorize unrelated cleanup.

Outside Git, supply explicit paths. With no changes and no explicit target, the agent can use relevant files clearly identified by the current session; otherwise it reports no target. It does not select targets from modification times, the last commit, or a whole-repository cleanup scan.

The main session captures shared scope, diffs, instructions, and context, then requests three parallel read-only reviewers through `Agent` in one message when available. Without `Agent`, it reviews serially with the same lenses. If a reviewer fails or is incomplete, the main session finishes that lens and discloses coverage. Reviewers return evidence and proposed fixes; the main session waits for all reviews, deduplicates and verifies findings, and applies only minimal justified cleanup.

Fixes preserve behavior, APIs, error propagation, cancellation, validation, and preexisting work/index. Behavior-changing bugs are reported separately. The agent runs appropriate existing checks, inspects the final diff, and summarizes actual results and unresolved issues. It does not stage, commit, reset, or stash.

These are **instruction-based behaviors, not a sandbox or automatic enforcement**. Review the resulting changes. The prompt uses normal session tools and does not launch scripted workflows or Herder. Herder's `/herder-simplify` is a planning workflow; `/simplify` performs direct bounded cleanup. No Herder behavior is changed.

## Installation

Collection users: update/install the package, then `/reload`. If package filters disable prompts or use `autoload: false`, enable `prompts` with `extensions/simplify/prompts/simplify.md`.

For standalone use:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/simplify/prompts/simplify.md
```

## Inspiration

Inspired by the reuse, quality, and efficiency review approach described in the [official Claude Code local code review documentation](https://code.claude.com/docs/en/code-review-local). This is an independently written Pi prompt, with no claim of copied implementation or feature parity; both tools and their documentation evolve across versions.
