# Commit

A lightweight native Pi prompt template for committing current changes as the smallest logical, self-contained patch series. No Commit runtime code.

## Usage

```text
/commit
/commit <instructions>
/commit only the staged authentication changes
/commit keep this as one commit if it remains self-contained
```

Pi expands [prompts/commit.md](prompts/commit.md) into the current session using normal tools. Optional instructions are passed through Pi's native `$ARGUMENTS`; no separate agent, custom parser, or session-wide policy is installed.

## Behavior

- Invoking `/commit` authorizes committing existing in-scope work without another confirmation unless there is real ambiguity.
- Group by purpose, keeping code with necessary tests/docs and valid intermediate trees; use one commit when coherent.
- Respect meaningful existing staging and preserve staged-only content when regrouping. Do not implement fixes, discard/stash work, rewrite history, change branches/configuration, or push.
- Inspect staged diffs, run diff checks and feasible focused non-mutating checks, and report what actually ran and what remains.
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
