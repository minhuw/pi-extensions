# Molt

Use `/molt` to start an empty session with the current model and thinking level. It carries those choices into the new session without changing your saved defaults.

Use `/handoff [task]` to continue the work in a clean session: the model writes a handover, and Pi starts a new session with the same model and thinking level and sends the handover as its first message. No handover file is written.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/model           pick a model for this session
/thinking high
/molt            fresh session, same model, thinking high
/handoff         hand the current work to a fresh session
/handoff run the benchmark on the new build
                 hand off with the next session's task
```

## `/molt`

Pi's built-in `/new` initializes a session from your launch flags (`--model`, `--thinking`) and saved defaults (`defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`). A choice made only for the current session is reset by `/new`. Use `/molt` when you want to keep that choice; `/new` itself is unchanged.

The command records the model and thinking level, then starts a session through Pi's normal `/new` lifecycle. Other extensions can still cancel the switch. Like `/new`, it aborts a response in progress.

When the new session starts, Molt selects the recorded model if it differs, applies the thinking level clamped to what the model supports, and shows a notification. If the model is no longer available or lacks credentials, the session keeps the model Pi selected at startup and shows a warning.

## `/handoff`

`/handoff` sends a handover request to the current session, so the model writes it with the full conversation and the prompt cache, and can use tools to check facts that may have changed, such as git status or running jobs. The request asks for the goal, the user's constraints, the current state with exact paths, commits, and commands, decisions and rejected approaches, risks, and ordered next steps. The text after `/handoff` becomes the new session's task; without it, the new session continues the current work.

When the reply is complete, Pi starts the new session the way `/molt` does and submits the handover, followed by a line naming the previous session id, so the new agent starts working at once. The old session keeps the request and the handover as its last turn.

- Run it when the agent is idle; it refuses while a response or compaction is running, and in a session without a conversation.
- Press Escape during the handover to cancel; Pi stays in the current session. A handover that ends in an error also stays.
- If another extension cancels the switch, the handover remains the last reply of the current session.
- The new session has no `parentSession` header, so pika records it as a standalone session rather than a child of the old one.
- Spokesman may rewrite the handover in the old session's transcript; the new session receives the model's original text.

Run `npm run test:molt` for offline tests that drive a real Pi session runtime with a local faux provider.
