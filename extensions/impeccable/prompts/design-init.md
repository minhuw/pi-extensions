---
description: "Sets up a project for impeccable. Runs a multi-round discovery interview when context is missing and writes PRODUCT.md (strategic: users, brand, principles); pre-configures live mode; then recommends the best commands to run next. Every other command reads these files before doing work. Use once per project."
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Resolve `<skill-base-dir>` (the directory containing Impeccable's `SKILL.md`) from the `impeccable:skill-location` context message, an `<available_skills>` entry named `impeccable` if present, or `impeccable_run` with `argv: ["context"]`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `init` playbook end-to-end: read `<skill-base-dir>/reference/init.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

init request:
$ARGUMENTS
