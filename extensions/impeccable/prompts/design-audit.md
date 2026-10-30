---
description: "Run technical quality checks across accessibility, performance, theming, responsive design, and anti-patterns. Generates a scored report with P0-P3 severity ratings and actionable plan. Use when the user wants an accessibility check, performance audit, or technical quality review."
argument-hint: "[area (feature, page, component...)]"
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `audit` playbook end-to-end: read `<skill-base-dir>/reference/audit.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut. On an iOS or Android target, read and follow `<skill-base-dir>/reference/audit.native.md` as the playbook.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

audit request:
$ARGUMENTS
