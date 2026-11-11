# Delegation

Two session-only modes for top-level TUI and RPC sessions that hand work to [Subagents](../subagents/README.md): `/boom` for speed, `/alwayson` for responsiveness. They switch independently and can be on together.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/boom [on | off | status]       toggle, set, or show boom mode 💥
/alwayson [on | off | status]   toggle, set, or show always-on mode 📡
```

Neither mode is ever on by default: every session starts with both off, and only the command turns one on. Turning a mode on counts as the user's explicit opt-in to background agents. Both modes override the more conservative default guidance of the `Agent` tool, and both tell the model to give concurrent writers `isolation: "worktree"` when their files could overlap, apply the branches they report, and check the agents' changes before reporting them. Each subagent pays for its own context and cache, so either mode trades tokens for wall-clock time or responsiveness.

## Boom mode

In boom mode 💥 the model works as an orchestrator: it splits tasks into independent pieces and fans them out in parallel, so development goes faster at the cost of more usage. Turning it on also opts in to `SubagentWorkflow` when [`workflowsEnabled`](../subagents/README.md#workflows) makes it available. The instructions tell the model to:

- send lookups beyond one known file to `recon` and implementation, tests, and verification to `worker`;
- keep direct tools for a known target or a short sequential edit.

It helps most when work splits into independent pieces, and it is slower for small sequential edits.

While boom mode is on, a coach steers the model back when it stops delegating. After five direct lookups in a row (`read`, `grep`, `find`, `ls`, `ffgrep`, `fffind`, or `bash`), it sends a hidden message asking the model to hand the rest of the exploration to parallel `recon` agents. A call to `Agent`, `SubagentWorkflow`, `herder_step`, or `herder_workflow` restarts the count. Edits, writes, and calls made inside another tool do not count. Once the context is half full, the coach asks the model, once, to delegate the remaining work to background agents and keep only their summaries; it asks again only after a compaction. Coach messages join a request the run makes anyway, after the model's tool calls, so they never start a turn. The coach makes no model call and sends nothing while the model keeps to the rules.

## Always-on mode

In always-on mode 📡 the model runs every long development task in a background subagent and ends its turn, so the session stays free to answer you and the other sessions that message it through [relay](../pika/README.md#relay). A busy session reads relay messages only between its turns, or after its running tool calls, so a long turn keeps another session waiting. Relay's [side answers](../pika/README.md#side-answers) answer such messages from the conversation so far; always-on mode keeps the turns short instead, so the session itself answers. The instructions tell the model to:

- run any task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in a background `worker` or `recon`, with a self-contained prompt or `inherit_context: true`;
- end its turn right after launching it, without waiting, sleeping, or polling; the agent's completion notification starts a new turn;
- answer you and relay messages meanwhile, redirecting running agents with `steer_subagent`;
- keep direct tools for answers, short lookups, and small edits.

The extension lists each session with always-on mode on in a registry that other extensions in the Pi process read (`Symbol.for("pi-extensions.session-modes")`): [relay](../pika/README.md#relay) accepts only such a session as a room's representative.

## The prompt cache

Both modes switch the same way. Each session decides at its first prompt whether its system prompt carries a mode:

- Turning a mode on before the first prompt puts its instructions in a system prompt section from the start.
- Turning it on after the first prompt sends the instructions as a hidden message with the next prompt and leaves the section alone.
- Turning it off in a session whose section carries it sends a hidden "mode is off" message with the next prompt.
- Returning to the section's state sends one hidden message that cancels the earlier ones.

Hidden messages preserve the prompt cache. On Magpie, changing a system prompt section rewrites the head of the context and requires the context to be cached again. Appending a message leaves the cached prefix intact. Each hidden message is sent once, since every copy stays in the context. It is sent again, once, only when the model can no longer see it: after a compaction drops it, or after `/tree` or a fork moves to a point whose branch does not hold it. Once a compaction has dropped the earlier messages, returning to the section's state sends none. Pi 1.3 and 1.4 cannot show the extension what a compaction dropped, so there the message goes with every prompt while the switch differs from the section, and a switch back sends one cancelling message.

Behavior worth knowing:

- A switch takes effect with the next prompt, not a response in progress.
- If a session already contains conversation when this extension handles its first prompt, it never gains a section, even with the mode turned on before that prompt. This includes sessions created before the extension was installed.
- The state is stored in the session file, so it survives `/reload` and resuming. Switches follow the branch: `/tree` and forks take the state of the point they land on.
- Subagents, Herder steps, and print and JSON modes are not affected, and both commands only show a warning there. Children never fan out further because of these modes.
- If compaction drops the hidden message during a long run, the rest of that run may fall back to the section's state until the next prompt sends the message again.

While a mode is on, [Statusline Footer](../statusline-footer/README.md) shows `💥 boom` or `📡 alwayson` in its bar, in that order, just before the compaction count.

Run `npm run test:delegation` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
