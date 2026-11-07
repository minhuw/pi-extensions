# Commit

`/commit` organizes existing changes into the smallest logical series of self-contained commits. It is a native Pi prompt template that uses the current session’s tools; it adds no Commit runtime.

## Usage

```text
/commit
/commit <instructions>
/commit only the staged authentication changes
/commit keep this as one commit if it remains self-contained
```

Pi expands [prompts/commit.md](prompts/commit.md) in the current session and passes optional instructions through native `$ARGUMENTS`. The guidance applies to this invocation only; it creates no separate agent, custom parser, or session-wide policy.

## Behavior

- Invoking `/commit` authorizes committing existing in-scope work without another confirmation unless there is real ambiguity.
- Group changes by purpose, keeping code with its necessary tests and documentation. Each commit should leave a valid intermediate tree; use one commit when the work forms a coherent whole.
- Respect meaningful existing staging and preserve staged-only content when regrouping. Do not implement fixes, discard/stash work, rewrite history, change branches/configuration, or push.
- Inspect each complete staged diff and run `git diff --cached --check` for every group. Run feasible focused, non-mutating checks, then report their results and any work left over. A check against the dirty working tree does not prove that an intermediate staged tree passed.
- Use normal Git commits with repository hooks and signing; do not suppress them or bypass failures.
- Default messages are Linux-style `subsystem: imperative summary` with concise subjects (about 75 characters) and self-contained bodies explaining rationale and impact. Explicit repository-required Conventional Commits win. Never invent attribution or references.

## Migration

This replaces the former Commit extension. The custom `commit_git`, `commit_list`, and `commit_read` tools, automatic secret preflight, locking, and lifecycle guards are gone. Safety and grouping are agent instructions, **not a sandbox or automatic enforcement**. Review your changes; the prompt still instructs the agent to stop for suspected credentials, conflicts, or blockers.

- Collection users: update the package, then `/reload`.
- Direct `extensions/commit/index.ts` users: remove that old entry and install the collection, or launch Pi with the new prompt:

  ```bash
  pi --prompt-template /absolute/path/to/pi-extensions/extensions/commit/prompts/commit.md
  ```

- If your package filter disables prompts or uses `autoload: false`, enable `prompts` with `extensions/commit/prompts/commit.md`; `/commit` is no longer an extension resource.
