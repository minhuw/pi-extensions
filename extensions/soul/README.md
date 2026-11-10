# Soul

Injects three core development principles into the agent's prompt—on by default in sessions and inherited by delegated [Subagents](../subagents/README.md) and [Herder](../herder/README.md) steps—while keeping the prompt cache intact across mid-session switches.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/soul                toggle soul principles for this session
/soul on             turn soul principles on for this session
/soul off            turn soul principles off for this session
/soul reset          return to this session's default
/soul status         show active state, session default, and default for new sessions
/soul default        show the default for new sessions
/soul default on     turn soul principles on by default for new sessions
/soul default off    turn soul principles off by default for new sessions
```

## Principles

- **Fail fast and loud:** ship the simplest working slice to test assumptions early; never hide bugs behind silent fallbacks, speculative abstractions, or swallowed errors—let broken invariants fail immediately where they happen, and keep changes small and easy to fix or revert.
- **Do the hard work; cut zero-information words:** trace root causes and solve the real problem instead of papering over symptoms; state concrete, falsifiable claims backed by code, output, or measurements, and omit truisms, filler caveats, and statements whose negation would be absurd.
- **Stand on evidence, not sycophancy:** never flatter the user or agree just to be agreeable; push back directly when a premise or plan contradicts the codebase, data, or logic, and do not flip your position under pushback unless new evidence or an explicit tradeoff decision warrants it.

## Prompt cache and configuration

Soul is **on by default**. You can change the default for new sessions in `<agentDir>/soul.json` (`{ "default": false }`) via `/soul default off`; a missing file means `on`.

Each session fixes whether its system prompt carries `<soul>` at its first prompt:

- Fresh sessions start with `<soul>` in the system prompt section when soul is on, or with no section when `/soul off` (or `/soul default off`) precedes the first prompt.
- Switching `/soul off` or `/soul on` after the first prompt leaves the system prompt section unchanged and appends one hidden override message to the next prompt, preserving Magpie's cached prefix.
- The hidden override is re-sent only when compaction drops it from Pi's session projection or `/tree` moves to a branch without it.
- Sessions that already hold conversation before this extension runs never gain a `<soul>` section; when soul is on, they receive the principles once as a hidden message instead.

## Subagent inheritance

While any session is open, the extension registers itself in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` so child sessions receive it even under `extensions: false` or `isolated: true` (and deduplicates when a child also loads extensions by path):

- Delegated subagents (`recon`, `worker`, custom agents, nested subagents, Council advisors) and Herder step sessions inherit the active soul state of their spawning session (`on` by default, `off` after `/soul off`).
- Resumed subagents keep the `<soul>` section they started with and receive a hidden override if their parent session switched `/soul` meanwhile.
- Internal non-coding helper children (`memory-dream` and `@mention clone`) are left untouched, and `/soul` commands run only in top-level TUI and RPC sessions.

Run `npm run test:soul` for offline tests on real Pi sessions and child sessions using Pi's faux provider.
