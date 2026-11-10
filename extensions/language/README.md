# Language

Use `/language` to choose the model's response language in top-level TUI and RPC sessions. Set a default for new sessions or switch the current session for its next prompt.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/language                  show the active language, this session's default, and the default for new sessions
/language <name>           switch this session to <name>
/language reset            return to this session's default
/language default          show the default for new sessions
/language default <name>   set the default for new sessions
/language default off      remove the default for new sessions
```

A name is any text the model understands, such as `English` or `Simplified Chinese`, up to 40 characters. It cannot contain control characters or be `reset` or `default`. Naming the session's default is the same as `/language reset`.

The session's default is fixed at its first prompt and supplied through a system prompt section. A switch adds a hidden message with each prompt, leaving that section unchanged. Both instructions tell the model to leave code, identifiers, commands, and file paths unchanged.

Resetting an active switch sends one hidden message with the next prompt. It tells the model to ignore earlier switches and return to the session's default, or the user's language if there is none.

When a run is about to end, the extension checks that its final answer is in the run's language: the switch if one is active, else the session's default. Only languages with a distinctive script are checked: Chinese, Japanese, Korean, Russian, Ukrainian, Bulgarian, Serbian (Cyrillic), Greek, Arabic, Persian, Hebrew, Thai, and Hindi, by English or native name such as `简体中文`. Latin-script languages such as English or German are never checked. Code blocks, inline code, URLs, link targets, and paths are ignored. An answer with at least 40 letters left fails the check when under 30% of them are in the language's script. The extension then adds one hidden message asking the model to write the answer again in that language, and the run continues. It corrects at most once per run and accepts the rewrite. Aborted, failed, and truncated answers are not checked. The check makes no model call, so an answer in the right language costs nothing.

Hidden messages preserve the prompt cache. On Magpie, changing a system prompt section rewrites the head of the context and requires the context to be cached again. Appending a message leaves the cached prefix intact.

The default for new sessions lives in `<agentDir>/language.json` as `{ "default": "English" }`. `<agentDir>` is usually `~/.pi/agent`. A missing file means no default; an unreadable or invalid file also means no default and produces a warning.

Behavior worth knowing:

- Changing the default affects sessions that have not yet had their first prompt, including the current session if it has not started. Sessions that have already started keep their language.
- A switch takes effect with the next prompt, not a response in progress.
- If a session already contains conversation when this extension handles its first prompt, the extension adds no system prompt section. This includes sessions created before the extension was installed. Their default is sent as a hidden message with each prompt, and `/language reset` returns to it. A session with no default at its first prompt does not pick up one configured later.
- The language is stored in the session file, so it survives `/reload` and resuming. Switches follow the branch: `/tree` and forks take the language of the point they land on.
- Subagents, Herder steps, and print and JSON modes are not affected, and `/language` only shows a warning there.
- If compaction drops the hidden message during a long run, the rest of that run may fall back to the default until the next prompt.

[Statusline Footer](../statusline-footer/README.md) shows the active language in its bar. Before a session's first prompt, it shows the default that prompt will use.

Run `npm run test:language` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
