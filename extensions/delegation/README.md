# Delegation

Swarm mode 🐝 for top-level TUI and RPC sessions: the session coordinates background [Subagents](../subagents/README.md) and keeps its own turns short, so it stays free to answer you and the sessions that message it through [relay](../pika/README.md#relay).

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/swarm [on | off | status]   toggle, set, or show swarm mode for this session
/swarm default [on | off]    show or set the default for new sessions
```

## Swarm mode

Swarm mode is on by default. A session whose first prompt starts with no earlier conversation takes the default from `<agentDir>/swarm.json` (`{ "default": true }` or `{ "default": false }`; a missing file means on, an invalid one warns on `/swarm default` and means on). Before that first prompt, the footer shows the state the session will start with, and `/swarm default` changes it. A session that already contains conversation when the extension first handles it starts off until you turn it on; earlier `boom` and `alwayson` entries are ignored. `/swarm default` never changes a session that has had its first prompt.

With swarm mode on, the model:

- runs each task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in background agents, `worker` for changes and verification and `recon` for research, split into independent pieces launched together;
- gives each agent a self-contained prompt or `inherit_context: true` that names the files it owns, the files it must not touch, and the command that shows it is done;
- tracks the pieces on `swarm_board` when it is available;
- gives concurrent writers `isolation: "worktree"` when their files could overlap and applies the branches they report;
- ends its turn right after launching, without waiting or polling; an agent's completion notification starts a new turn;
- answers you and relay messages meanwhile, redirecting agents with `steer_subagent` and reading them with `get_subagent_result`;
- keeps direct tools for answers, short lookups, and small edits, and checks agents' changes before reporting them.

Swarm mode overrides the more conservative default guidance of the `Agent` tool. It does not opt in to `SubagentWorkflow`. Each subagent pays for its own context and cache, so the mode trades tokens for responsiveness.

The extension lists each session with swarm mode on in a registry other extensions in the Pi process read (`Symbol.for("pi-extensions.session-modes")`): [relay](../pika/README.md#relay) accepts only such a session as a room's representative.

## Coach

While swarm mode is on, `coach.ts` sends hidden `swarm-coach` messages:

- **Context.** Once the context is half full, it asks the model to delegate the remaining work to background agents and keep only their summaries. It joins a request the run makes anyway, never starts a turn, and repeats only after a compaction.
- **Stalled agents.** It follows the session's own top-level agents through pi-subagents' `subagents:telemetry` events. An agent is stalled when it is running, has no active tool, and has sent no telemetry for 10 minutes. The coach sends one message naming the stalled agents (id, type, description, minutes idle) and asking the model to check, steer, or relaunch them. The message starts a turn in an idle session and steers a running one. It names an agent again only after new telemetry from it; completed agents are forgotten.

## Board

While swarm mode is on, the session and its subagents share a kanban board through the `swarm_board` tool. The session's model lists, adds, updates, and drops cards, and links one to a launched agent with `agentId`. Agents get cards on their own: an agent that starts opens a `doing` card titled after its description. An agent that finishes moves its card to `done`, or to `failed` after an error, abort, or stop. A card the coordinator marked `blocked` stays blocked when its agent ends normally, and cards already done, failed, or dropped are left alone. Off swarm mode the tool refuses.

Subagents get the board through the child-session hook, and only subagents of a session that has one. Each sees a short system prompt section at its first run: the open cards, its own card, and the rule to read the board before editing files another card may own. A subagent can list the board, post progress on its own card with `note` (`doing`, or `blocked` with the reason when it needs the coordinator), and `add` `todo` cards for follow-up work it finds. It cannot drop or retitle cards or touch other agents' cards. Nested subagents share their root session's board. Herder steps get no board, and neither do agents whose `extensions:` leave out `swarm-board`, such as `recon`.

The session stores the board as `swarm-board` entries, writing a snapshot after its own changes and, batched, after its subagents' changes. The board survives `/reload` and resuming, and follows the branch on `/tree` and forks. Other extensions in the Pi process read live boards in `globalThis[Symbol.for("pi-extensions.swarm-boards")]` (contract in `board.ts`), which [pika](../pika/README.md) uploads and shows in a room's Board view.

## The prompt cache

Each session decides at its first prompt whether its system prompt carries swarm mode:

- On at the first prompt (the default for a fresh session, or `/swarm on` before it) puts the instructions in a system prompt section from the start.
- Turning it on after the first prompt sends the instructions as a hidden message with the next prompt and leaves the section alone.
- Turning it off in a session whose section carries it sends a hidden "mode is off" message with the next prompt.
- Returning to the section's state sends one hidden message that cancels the earlier ones.

Appending a message leaves Magpie's cached prefix intact; changing a section would require caching the context again. Each hidden message is sent once and again only when the model can no longer see it: after a compaction drops it, or after `/tree` or a fork moves to a branch that does not hold it. Pi 1.3 and 1.4 cannot show the extension what a compaction dropped, so there the message goes with every prompt while the switch differs from the section.

- A switch takes effect with the next prompt.
- The state is stored in the session file, so it survives `/reload` and resuming. `/tree` and forks take the state of the point they land on.
- Subagents, Herder steps, and print and JSON modes are not affected; `/swarm` only warns there.

While swarm mode is on, [Statusline Footer](../statusline-footer/README.md) shows `🐝 swarm` in its bar, just before the compaction count.

Run `npm run test:delegation` for offline tests that drive real Pi sessions on a local faux provider and check what the provider receives.
