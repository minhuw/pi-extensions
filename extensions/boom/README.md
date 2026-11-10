# Boom

Use `/boom` to turn on boom mode 💥 in top-level TUI and RPC sessions. In boom mode the model works as an orchestrator: it splits tasks into independent pieces and fans them out to [Subagents](../subagents/README.md) in parallel, so development goes faster at the cost of more usage.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/boom          toggle boom mode for this session
/boom on       turn boom mode on
/boom off      turn boom mode off
/boom status   show whether boom mode is on
```

Boom mode is never on by default: every session starts with it off, and only `/boom` turns it on. Turning it on counts as the user's explicit opt-in to background agents and, when [`workflowsEnabled`](../subagents/README.md#workflows) makes it available, `SubagentWorkflow`. The instructions also tell the model to:

- send lookups beyond one known file to `recon` and implementation, tests, and verification to `worker`;
- give concurrent writers `isolation: "worktree"` when their files could overlap, and apply the branches they report;
- keep direct tools for a known target or a short sequential edit;
- check the agents' changes before reporting them.

These instructions override the more conservative default guidance of the `Agent` tool. Each subagent pays for its own context and cache, so boom mode trades tokens for wall-clock time. It helps most when work splits into independent pieces, and it is slower for small sequential edits.

## The prompt cache

Each session decides at its first prompt whether its system prompt carries boom mode:

- `/boom on` before the first prompt puts the instructions in a system prompt section from the start.
- Turning boom mode on after the first prompt adds the instructions as a hidden message with each prompt and leaves the section alone.
- Turning boom mode off in a session whose section carries it adds a hidden "boom mode is off" message with each prompt.
- Returning to the section's state sends one hidden message that cancels the earlier ones, and no more after it.

Hidden messages preserve the prompt cache. On Magpie, changing a system prompt section rewrites the head of the context and requires the context to be cached again. Appending a message leaves the cached prefix intact.

Behavior worth knowing:

- A switch takes effect with the next prompt, not a response in progress.
- If a session already contains conversation when this extension handles its first prompt, it never gains a section, even with `/boom on` used before that prompt. This includes sessions created before the extension was installed.
- The state is stored in the session file, so it survives `/reload` and resuming. Switches follow the branch: `/tree` and forks take the state of the point they land on.
- Subagents, Herder steps, and print and JSON modes are not affected, and `/boom` only shows a warning there. Children never fan out further because of boom mode.
- If compaction drops the hidden message during a long run, the rest of that run may fall back to the section's state until the next prompt.

While boom mode is on, [Statusline Footer](../statusline-footer/README.md) shows `💥 boom` in its bar, just before the compaction count.

Run `npm run test:boom` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
