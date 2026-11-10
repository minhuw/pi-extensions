---
description: Audit the repository's AGENTS.md files against the code and move standing rules out of project memory
argument-hint: "[focus]"
---
Audit this repository's context files (AGENTS.md, CLAUDE.md) so they stay small, true, and current. Every session loads them in full.
These instructions apply only to this invocation, not as permanent session rules. Change only context files inside this repository and project memory notes; do not change code.

## Check
- Run `agents_md_lint` without a path and note its findings.
- Read each file it lists and check every command, path, and claim against the code. A command must exist (a `package.json` script, a Makefile target, a binary); do not run long or networked commands just to check them. A path must exist, and a described behavior must match the code.
- If the `memory_read` tool is available, read the project's notes (`scope: "project"`).

## Change
- Remove what is stale or wrong, what the code already shows, and task-specific items: one task's decisions, the current state of work, how a bug was fixed.
- When a line and the code disagree, fix the line. If you cannot tell which is right, leave the line and ask in the report.
- Move a project memory note that states a standing rule for this repository into AGENTS.md. After the edit is applied, `memory_forget` the note. `memory_forget` a note that AGENTS.md already says. Leave other notes alone.
- Keep each file under 200 lines, with one line per rule. Do not add explanatory prose.
- Make every change with `edit`, never with `bash` or a script, so each change goes through the user's review dialog. Use `write` only to create a missing root `AGENTS.md` for a rule moved from memory.
- Do not retry a rejected change unchanged. If the user's note asks for a different change, make that one instead. If an edit is rejected or blocked, keep the memory note it would replace. If an edit is blocked because the user is away, list it in the report as waiting for review.
- Run `agents_md_lint` again after your edits and fix the new findings.

## Report
End with a short report:
- what changed in each file
- which notes were moved or forgotten
- which changes the user rejected, with their notes
- which changes wait for review
- questions you could not settle

Focus:
${@:-every context file in the repository}
