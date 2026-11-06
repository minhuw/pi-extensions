# Language

`/language` sets the language the model responds in. You can set a default for new sessions and switch the current session at any time. The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/language                  show the active language, this session's default, and the default for new sessions
/language <name>           switch this session to <name>
/language reset            return to this session's default
/language default          show the default for new sessions
/language default <name>   set the default for new sessions
/language default off      remove the default for new sessions
```

A name is any text the model understands, such as `English` or `Simplified Chinese`, up to 40 characters. It cannot contain control characters or be `reset` or `default`. Naming the session's default is the same as `/language reset`.

The default reaches the model through a system prompt section, fixed at the session's first prompt. A switch reaches it as a hidden message sent with each prompt, and the system prompt stays as it was. Both tell the model to leave code, identifiers, commands, and file paths unchanged. A reset sends one hidden message with the next prompt, telling the model to ignore earlier switches and use the session's default, or the user's language if there is none.

The split is there for the prompt cache. On Magpie, a changed section rewrites the system prompt at the head of the context, so the whole context is cached again. A message at the end of the conversation leaves the cached prefix alone.

The default for new sessions lives in `<agentDir>/language.json` as `{ "default": "English" }`, and `<agentDir>` is usually `~/.pi/agent`. With no file there is no default. A file that cannot be used counts as no default and shows a warning.

Behavior worth knowing:

- Changing the default only affects new sessions. A session that has not had its first prompt yet counts as new, so the change can reach the current one; a session that has keeps its language.
- A switch takes effect with the next prompt, not a response in progress.
- A session that already has conversation at its first prompt, such as one from before this extension, never gains a section. Its default is sent as a hidden message with each prompt instead, like a switch, and `/language reset` returns to that default. A session with no default at its first prompt does not pick up one configured later.
- The language is stored in the session file, so it survives `/reload` and resuming. Switches follow the branch: `/tree` and forks take the language of the point they land on.
- Subagents, Herder steps, and print and JSON modes are not affected, and `/language` only shows a warning there.
- If compaction drops the hidden message during a long run, the rest of that run may fall back to the default until the next prompt.

[Statusline Footer](../statusline-footer/README.md) shows the active language in its bar. Before a session's first prompt, it shows the default that prompt will use.

Run `npm run test:language` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
