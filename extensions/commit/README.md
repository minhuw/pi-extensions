# Commit

A command-owned Pi workflow that turns the current dirty Git worktree into one or more polished, self-contained commits.

## Usage

```text
/commit
/commit only the staged authentication changes
/commit keep this as one commit if it remains self-contained
```

The command runs in the current Pi session so the agent may use relevant conversational context, but it must re-derive scope and evidence from Git before staging anything.

## Behavior

`/commit`:

- requires a trusted Git project;
- waits for the current agent run to settle;
- exits without a model turn when the worktree is clean;
- performs a local redacting preflight for sensitive paths and high-confidence credential patterns before model dispatch;
- injects an authoritative command-scoped policy and temporarily exposes only extension-owned `commit_list`, `commit_read`, and structured `commit_git` operations;
- derives pageable path listings from Git's tracked/untracked inventory and reads files through identity-checked, no-follow file handles;
- fingerprints dirty state plus symbolic branch identity before model-visible reads and Git operations, rejecting interrupted Git output and same-OID branch switches;
- honors trusted repository clean/process filters during ordinary Git inspection and staging, then reviews and secret-scans the resulting canonical blobs;
- captures staged inspection from an immutable private index snapshot and exposes staged, unstaged, and untracked changes through bounded pages with no fixed total diff limit;
- groups dirty work into the smallest coherent commit series, including very large worktrees;
- runs Git diff checks while reporting repository hooks and arbitrary checks as not run;
- stages explicit initially-dirty files or validated dirty path prefixes with literal pathspec handling, without partial-hunk rewriting;
- requires a complete status summary and exact-tree pageable diff-manifest review, streaming-scans canonical changed blobs after Git attribute conversions, then holds standard index and symbolic-HEAD locks while attaching a validated commit without executing hooks, lazy fetches, signature verifiers, or external signing programs; and
- reports created commits, checks, remaining changes, and that nothing was pushed.

The workflow is commit-only by default. It may reorganize the Git index, but it must not edit or discard working-tree content, push, rewrite existing history, change branches, stash work, or change Git configuration. Tool responses remain bounded to Pi's normal output limit, while continuation cursors let the workflow consume arbitrarily large aggregate listings, statuses, and diffs page by page. Its guard is scoped to one agent run; when clarification is required, the agent stops and asks the user to rerun `/commit` with the missing instruction. If a dispatched turn times out before Pi starts it, `/commit` blocks replacement runs until that delayed turn settles or the session is reloaded, preventing cross-run guard teardown.

## Commit message style

Messages follow the Linux kernel's permanent-changelog style by default:

```text
subsystem: imperative summary

Explain the problem and impact before the solution. Keep the message
self-contained and describe important trade-offs in plain language.
```

When explicit repository instructions require Conventional Commits, use that format instead: `fix(commit): respect repository message rules`. Scoped and unscoped prefixes are accepted, including breaking-change forms such as `feat(api)!: require explicit options` and `feat!: require explicit options`. Do not infer that requirement from incidental history prefixes.

In either format, subjects use an imperative summary, are at most 75 characters, and have no trailing period. A self-contained explanatory body is required; ordinary body lines must be at most 75 characters. `[PATCH]` is not stored in the commit subject, and attribution, sign-off, review, testing, or issue trailers are never invented.

Reference: [Linux kernel patch submission guidance](https://docs.kernel.org/process/submitting-patches.html).
