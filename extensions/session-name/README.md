# Session Name

Names an unnamed session after its first answered prompt, so the session selector and pika show a short, searchable title instead of the first message, and refreshes that name as the session grows. The title says concretely what the task is, in the language of your prompt, in at most about 60 characters.

The collection loads this extension automatically; use `/reload` after installing or updating it.

## Behavior

- After the first completed run of a top-level TUI or RPC session, if the session has no name, the extension sends the first prompt and the first final answer (each cut to 4000 characters) to the naming model and calls `pi.setSessionName` with the reply's first line, stripped of quotes and markdown and cut to 80 characters. An empty reply names nothing.
- A name already set by `/name`, `--name`, or an earlier run is never replaced, including one you set while the title is being generated. A resumed session that already has a name is left alone; a resumed unnamed session is named after its next run.
- Each automatic name is recorded in a `session-name.auto` custom entry with the context size at that time. Custom entries never reach the model, so the prompt cache is unaffected, and the record survives resume and reload.
- After a completed run, if the context has grown by a quarter of the model's context window (at most 256K tokens) since the last automatic naming, the naming model gets the first prompt, the current name, the latest compaction summary, and the newest user and assistant text (about 8000 characters). It replies `KEEP` while the name still fits, or a new title under the same rules; either way a new entry moves the baseline to the current size. A context that compaction shrank below the baseline becomes the new baseline; an unknown context size (right after compaction) skips the check.
- Only a name this extension set is refreshed: once the session's name differs from the latest `session-name.auto` entry (`/name`, `--name`, or a name from before this feature), it is never touched again.
- It runs in the background with at most one request at a time: the agent loop and your input never wait for it, and nothing is added to the conversation or the system prompt. The first naming is tried once per session load.
- Child sessions (subagents, Herder steps, council advisors, pika dreams) and print mode are skipped.
- Session shutdown aborts a pending request.

## Model

The naming model is the recon subagent's: the `recon` entry of `<agentDir>/subagent-models.json` (for example `{ "recon": "magpie/claude-haiku-5-5" }`), as set by the Subagents extension. Without that file or entry, or with `"inherit"`, it is the session's current model.

A missing model, missing credentials, an unreadable `subagent-models.json`, or a failed request shows one warning with the reason and leaves the name as it was. A failed refresh is retried only after another step of context growth, or after a reload. There are no commands or settings; name a session yourself with `/name`.
