---
description: "Design a frontend interface with the Impeccable design skill (freeform alias of /impeccable)"
argument-hint: "[request, subcommand, or target]"
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup and Routing sections for the request below. Run the Impeccable engine once per session as its Setup directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback), and follow the directives it prints.
3. Route the request:
   - `pin` or `unpin`: follow the Pin/Unpin section of `<skill-base-dir>/SKILL.md` and run the command it names.
   - `i`: compatibility alias of the Impeccable skill; route its remaining request normally. `craft` remains the upstream craft playbook.
   - `teach`: this is an alias of `init`; read `<skill-base-dir>/reference/init.md` and follow it end-to-end.
   - `doctor`: read `<skill-base-dir>/reference/doctor.md` and follow it end-to-end.
   - `live` or `generate`: use impeccable_live start/generate and the complete native playbook; route every poll/reply/complete/stop instruction through the session owner.
   - `hooks`: read `<skill-base-dir>/reference/hooks.md` and follow it end-to-end.
   - Any command in the skill's Commands table: read the matching reference under `<skill-base-dir>/reference/` and follow it end-to-end (use the `.native.md` variant on iOS or Android targets).
   - With no argument: read `<skill-base-dir>/reference/routing.md` and present its context-aware menu; never auto-run a command.
   - For a new surface or replacement visual world, follow `<skill-base-dir>/reference/new-work.md`.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

Request:
$ARGUMENTS
