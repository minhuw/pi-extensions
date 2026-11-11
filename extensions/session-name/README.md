# Session Name

Names an unnamed session after its first answered prompt, so the session selector and pika show a short, searchable title instead of the first message. The title says concretely what the task is, in the language of your prompt, in at most about 60 characters.

The collection loads this extension automatically; use `/reload` after installing or updating it.

## Behavior

- After the first completed run of a top-level TUI or RPC session, if the session has no name, the extension sends the first prompt and the first final answer (each cut to 4000 characters) to the naming model and calls `pi.setSessionName` with the reply's first line, stripped of quotes and markdown and cut to 80 characters. An empty reply names nothing.
- A name already set by `/name`, `--name`, or an earlier run is never replaced, including one you set while the title is being generated. A resumed session that already has a name is left alone; a resumed unnamed session is named after its next run.
- It runs once per session load in the background: the agent loop and your input never wait for it, and nothing is added to the conversation or the system prompt.
- Child sessions (subagents, Herder steps, council advisors, pika dreams) and print mode are skipped.
- Session shutdown aborts a pending request.

## Model

The naming model is the recon subagent's: the `recon` entry of `<agentDir>/subagent-models.json` (for example `{ "recon": "magpie/claude-haiku-5-5" }`), as set by the Subagents extension. Without that file or entry, or with `"inherit"`, it is the session's current model.

A missing model, missing credentials, an unreadable `subagent-models.json`, or a failed request shows one warning with the reason and leaves the session unnamed. There are no commands or settings; name a session yourself with `/name`.
