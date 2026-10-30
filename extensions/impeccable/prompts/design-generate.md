---
description: "Agent-driven live variant generation. Boots live mode, finds the named element on the open page, scrolls the browser to it, and delivers N variants in the requested direction for the user to cycle and accept. Use for requests that name an element and a direction, like 'generate 3 bold variants of the pricing cards', skipping manual element picking."
argument-hint: "[count] [direction] variants of [element]"
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `generate` playbook end-to-end: read `<skill-base-dir>/reference/generate.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

Use impeccable_live start/generate/status/reply/resume/stop; all native poll, reply, complete and helper lifetime instructions route through the session owner. Retain the full upstream browser and source workflow.
generate request:
$ARGUMENTS
