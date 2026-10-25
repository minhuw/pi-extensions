# Molt

`/molt` sheds the conversation and keeps the creature: it starts a new, empty session that keeps the current model and thinking level. The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/model           pick a model for this session
/thinking high
/molt            fresh session, same model, thinking high
```

Pi's built-in `/new` builds the new session from your launch flags (`--model`, `--thinking`) and saved defaults (`defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`). Choosing a model or thinking level without saving it as the default changes only the current session, so `/new` resets it. `/molt` carries the session's current choices over instead, without changing saved defaults. `/new` itself is unchanged.

The command records the model and thinking level, then starts a new session through Pi's normal `/new` lifecycle, so other extensions can still cancel the switch. When the new session starts, the extension selects the recorded model if it differs and applies the thinking level, clamped to what the model supports. It then shows a notification. If the model is no longer available or has no credentials, the new session keeps Pi's default model and the notification is a warning. Like `/new`, it aborts a response in progress.

Run `npm run test:molt` for offline tests that drive a real Pi session runtime with a local faux provider.
