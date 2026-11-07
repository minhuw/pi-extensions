# Molt

Use `/molt` to start an empty session with the current model and thinking level. It carries those choices into the new session without changing your saved defaults.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/model           pick a model for this session
/thinking high
/molt            fresh session, same model, thinking high
```

Pi's built-in `/new` initializes a session from your launch flags (`--model`, `--thinking`) and saved defaults (`defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`). A choice made only for the current session is reset by `/new`. Use `/molt` when you want to keep that choice; `/new` itself is unchanged.

The command records the model and thinking level, then starts a session through Pi's normal `/new` lifecycle. Other extensions can still cancel the switch. Like `/new`, it aborts a response in progress.

When the new session starts, Molt selects the recorded model if it differs, applies the thinking level clamped to what the model supports, and shows a notification. If the model is no longer available or lacks credentials, the session keeps the model Pi selected at startup and shows a warning.

Run `npm run test:molt` for offline tests that drive a real Pi session runtime with a local faux provider.
