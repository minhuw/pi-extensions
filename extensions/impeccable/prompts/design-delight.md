---
description: "Add moments of joy, personality, and unexpected touches that make interfaces memorable and enjoyable to use. Elevates functional to delightful. Use when the user asks to add polish, personality, animations, micro-interactions, delight, or make an interface feel fun or memorable."
argument-hint: "[target]"
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Resolve `<skill-base-dir>` (the directory containing Impeccable's `SKILL.md`) from the `impeccable:skill-location` context message, an `<available_skills>` entry named `impeccable` if present, or `impeccable_run` with `argv: ["context"]`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `delight` playbook end-to-end: read `<skill-base-dir>/reference/delight.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

delight request:
$ARGUMENTS
