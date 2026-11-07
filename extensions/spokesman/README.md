# Spokesman

Use `/spokesman` to pair a coding or reasoning model (such as `gpt-6-sol`) with a secondary communicator model that rewrites dense, telegraphic, or cryptic final responses into clear technical prose.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/spokesman                              show active spokesman, mode, defaults, and session rewrite usage
/spokesman <model> [auto|always]        switch this session's spokesman to <model> (e.g. openai/gpt-5.4)
/spokesman mode [auto|always]           show or switch rewrite mode for this session
/spokesman auto | /spokesman always     shorthand to switch rewrite mode for this session
/spokesman rewrite [<model>]            manually rewrite the latest completed assistant response now
/spokesman off                          disable spokesman for this session
/spokesman reset                        return to this session's pinned default spokesman and mode
/spokesman default                      show the default spokesman and mode for new sessions
/spokesman default <model> [auto|always] set the default spokesman (and optional mode) for new sessions
/spokesman default mode <auto|always>   set the default rewrite mode for new sessions
/spokesman default off                  remove the default spokesman for new sessions
```

## Rewrite Modes (`auto` vs `always`)

- **`auto` (default)**: Runs a fast, deterministic prose evaluator (`evaluateProseForSpokesman`) after stripping code blocks, inline code, links, URLs, file paths, and tables (`stripNonProse`).
  - Short confirmations (`< 16` prose words without leaked internal tool shorthand) are never rewritten.
  - When the active spokesman model is the same as the main model, spokesman is automatically disabled across `auto`, `always`, and `/spokesman rewrite`, and its footer badge is hidden.
  - Triggers a rewrite when the draft's prose accumulates a score `>= 2` across six signals:
    - `long-sentences` — high average or maximum sentence length
    - `noun-stacks` — chains of consecutive nominalizations / long abstract words or multi-hyphenated modifiers
    - `abstract-density` — high ratio of abstract/nominalized words
    - `telegraphic-compression` — dense semicolons, em-dashes, slash-chains, parentheticals, or arrow chains (`->`, `=>`, `→`)
    - `private-context-leak` — internal tool identifiers (`tool_call`, `exec_command`, `apply_patch`), opaque shorthand IDs (`cfg_`, `idx_`, `R01`, `arXiv:...`), or ungrounded shorthand after multi-step tool work
    - `wall-of-text` — single unbroken paragraph of `>= 90` prose words with no headings or lists
- **`always`**: Rewrites every completed final assistant response (`stopReason === "stop"` with no pending tool calls), regardless of prose length or heuristic score.

## Transcript Display & Context Continuity

When a response is rewritten:

1. **Folded Original Response**: The main model's original prose is collapsed into an expandable `▸ Original response (<model>)... (click to expand)` region (styled like a thinking block). Clicking the header or toggling global expand (`Ctrl+O`) reveals the original markdown. Any native thinking blocks on the assistant message remain intact above it.
2. **Spokesman Separator**: A themed rule `─── 󰗋 Spokesman · <model> ────────────────` marks the transition to the rewritten reply.
3. **Rewritten Markdown**: The spokesman's clear response is rendered below the separator.
4. **Clean Subsequent Context**: On later turns, the `context` hook supplies the clean rewritten text to the provider (without internal markers) so follow-up references by the user match what was displayed in the transcript.

## Configuration & Branch State

- The default for new sessions is stored in `<agentDir>/spokesman.json` as `{ "default": "openai/gpt-5.4", "mode": "auto" }`.
- Like [`language`](../language/README.md), a session pins its default at its first prompt and stores switches on the session branch (`spokesman` custom entries), so `/reload`, session resume, `/tree`, and forks follow the branch state.
- When the `language` extension is active on the branch, `spokesman` automatically instructs the spokesman model to write prose in the active response language while preserving code, identifiers, commands, and file paths.
- Subagents, Herder steps, and print/JSON modes are unaffected.
- [Statusline Footer](../statusline-footer/README.md) displays the active spokesman status (`spokesman` key).
