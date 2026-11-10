# Always-on

Use `/alwayson` to turn on always-on mode 📡 in top-level TUI and RPC sessions. In always-on mode the model runs every long development task in a background [Subagent](../subagents/README.md) and ends its turn, so the session stays free to answer you and the other sessions that message it through [relay](../pika/README.md#relay).

A busy session reads relay messages only between its turns, or after its running tool calls, so a long turn keeps another session waiting. Relay's [side answers](../pika/README.md#side-answers) answer such messages from the conversation so far; always-on mode keeps the turns short instead, so the session itself answers.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/alwayson          toggle always-on mode for this session
/alwayson on       turn always-on mode on
/alwayson off      turn always-on mode off
/alwayson status   show whether always-on mode is on
```

Always-on mode is never on by default: every session starts with it off, and only `/alwayson` turns it on. Turning it on counts as the user's explicit opt-in to background agents. The instructions tell the model to:

- run any task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in a background `worker` or `recon`, with a self-contained prompt or `inherit_context: true`;
- end its turn right after launching it, without waiting, sleeping, or polling; the agent's completion notification starts a new turn;
- answer you and relay messages meanwhile, redirecting running agents with `steer_subagent`;
- give concurrent writers `isolation: "worktree"` when their files could overlap, and apply the branches they report;
- keep direct tools for answers, short lookups, and small edits, and check the agents' changes before reporting them.

These instructions override the more conservative default guidance of the `Agent` tool. It works with [Boom](../boom/README.md) mode on as well. Each subagent pays for its own context and cache, so always-on mode trades tokens for responsiveness.

## The prompt cache

Always-on mode switches the way [Boom](../boom/README.md#the-prompt-cache) does:

- `/alwayson on` before the first prompt puts the instructions in a system prompt section from the start.
- Turning it on after the first prompt adds the instructions as a hidden message with the next prompt and leaves the section alone.
- Turning it off in a session whose section carries it adds a hidden "always-on mode is off" message with the next prompt.
- Returning to the section's state sends one hidden message that cancels the earlier ones.

Each hidden message is sent once, since every copy stays in the context. It is sent again, once, only after a compaction drops it from what the model sees, or after `/tree` moves to a branch that does not hold it. Once a compaction has dropped the earlier messages, returning to the section's state sends none. Pi 1.3 and 1.4 cannot show the extension what a compaction dropped, so there the message goes with every prompt while the switch differs from the section.

A switch takes effect with the next prompt. The state is stored in the session file, survives `/reload` and resuming, and follows the branch through `/tree` and forks. A session that already holds conversation when this extension handles its first prompt never gains a section. Subagents, Herder steps, and print and JSON modes are not affected, and `/alwayson` only shows a warning there. If compaction drops the hidden message during a long run, the rest of that run may fall back to the section's state until the next prompt.

While always-on mode is on, [Statusline Footer](../statusline-footer/README.md) shows `📡 alwayson` in its bar, after boom's status and just before the compaction count. The extension also lists the session in a registry that other extensions in the Pi process read: [relay](../pika/README.md#relay) accepts only such a session as a room's representative.

Run `npm run test:alwayson` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
