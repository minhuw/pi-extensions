---
description: "Generate a DESIGN.md file that captures the current visual design system. Auto-extracts colors, typography, spacing, radii, and component patterns from the codebase, then asks the user to confirm descriptive language for atmosphere and color character. Follows the Google Stitch DESIGN.md format so the file is tool-compatible. Use when you need a visual design spec an AI agent can follow to stay on-brand."
---
Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.

1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.
2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.
3. Follow the `document` playbook end-to-end: read `<skill-base-dir>/reference/document.md` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut.
4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.
5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.

document request:
$ARGUMENTS
