# AGENTS.md

Shows you every agent change to a repository's AGENTS.md or CLAUDE.md for review, checks those files against the repository, and moves standing rules from pika's project memory into them.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/agents-md                audit every context file in the repository
/agents-md the herder section
                          audit only what the focus names
```

## Review

When the agent calls `edit` or `write` on a file named `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`, a dialog shows the diff and the lint findings the change adds before the file changes. Choose **Apply**, **Reject**, or **Reject with a note**; the note goes back to the agent. Dismissing the dialog rejects the change.

- Sessions without a UI, subagents, Herder steps, and dreams write without asking.
- While `/selfdrive` holds a standing approval, the change is blocked: the agent describes it in its report so you can review it when you return.
- Changes made through `bash` are not reviewed.

## `agents_md_lint`

The tool checks one context file (`path`), or every context file in the repository, without a model or network:

- more than 200 lines or 25,000 bytes
- backticked paths that name no file or directory in the repository
- `npm run <name>` where the root `package.json` has no such script
- relative Markdown links to missing files
- lines that repeat an earlier line

## `/agents-md [focus]`

The prompt runs `agents_md_lint`, checks each command, path, and claim against the code, and removes what is stale, what the code already shows, and task-specific items. It moves project memory notes that state a standing rule for the repository into AGENTS.md, forgets them once the edit is applied, and forgets notes AGENTS.md already says. Each change is an `edit` you review. It ends with a report of what changed and what you rejected.

Run `npm run test:agents-md` for offline tests.
