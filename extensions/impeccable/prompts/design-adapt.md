---
description: "Adapt designs to work across different screen sizes, devices, contexts, or platforms. Implements breakpoints, fluid layouts, and touch targets. Use when the user mentions responsive design, mobile layouts, breakpoints, viewport adaptation, or cross-device compatibility."
argument-hint: "[target] [context (mobile, tablet, print...)]"
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Resolve `<skill-base-dir>` (the directory containing Impeccable's `SKILL.md`) from the `impeccable:skill-location` context message, an `<available_skills>` entry named `impeccable` if present, or `impeccable_run` with `argv: ["context"]`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `adapt` playbook end-to-end: read `<skill-base-dir>/reference/adapt.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut. On an iOS or Android target, read and follow `<skill-base-dir>/reference/adapt.native.md` as the playbook.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

adapt request:
$ARGUMENTS
