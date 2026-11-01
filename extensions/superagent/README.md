# Superagent

Turn a top-level Pi session into a router. The main session talks with you and answers questions from read-only tools. Every change becomes a **ticket**: a long-lived Subagents agent of the `ticket` type that runs in its own git worktree and branch, keeps its conversation across Pi restarts, and reports back as a message. Tickets run in parallel. One is merged into your branch only when you ask (or when you asked up front). The collection loads this extension automatically; use `/reload` after installing or updating it.

Superagent needs the **Subagents** extension of this collection (cross-extension RPC protocol 3 with the embedded `ticket` agent type). Without it, tickets fail with "Subagents with RPC protocol 3 is required to run tickets".

```text
fix the flaky login test, and add a --json flag to the export command
#2 use snake_case for the field names
/tickets
/tickets 1
/merge 1
/superagent off
```

The design and its contracts are in [DESIGN.md](DESIGN.md).

## Modes

A session is in **superagent mode** or **direct mode**.

- **Superagent mode** is the default for a top-level TUI or RPC session whose working directory is in a git repository with at least one commit. The session keeps only read-only tools (`read`, `grep`, `find`, `ls`, `ffgrep`/`fffind` when installed, tools annotated read-only that do not call other tools, and `git_read`), plus the ticket tools, Relay's tools, Herder's `herder_*` tools, `loop_schedule`/`loop_stop`, Subagents' `get_subagent_result`/`steer_subagent`, and `Agent` for the types in `routerAgents` (default `recon`, `reviewer`, `expert`). `edit`, `write`, `bash`, `codemode`, and every other tool are deactivated. A model-issued call to one of them is blocked with `"<tool> is not available in superagent mode: create a ticket with ticket_create for changes, or switch to direct mode with /superagent off."`; an `Agent` call naming another type, or resuming a ticket's agent, is blocked with its own reason. Your own `!` shell commands still work.
- **Direct mode** gives the session back the tools it had before. Ticket commands and `#N` keep working.
- Child sessions (Subagents agents, ticket agents included, and Herder steps), `print`/`json` runs, and directories outside git are always direct, and get no ticket tools.

`/superagent off` and `/superagent on` switch modes. The choice is recorded in the session and survives `/reload` and `/resume`.

In superagent mode the model gets router instructions: answer questions itself; turn each independent piece of work into a ticket, passing your words verbatim; forward follow-ups only when they clearly point at one ticket; act on a report only when it can (answer a ticket's question from what you already said, pass a fact between tickets, merge when you asked), otherwise reply in at most one short line; never restate a report, never wait or poll. When the open tickets have changed since the model last saw them, it gets a short hidden list of them (number, state, title, pending question, branch, what a queued one waits for).

## Tickets

| Tool | What it does |
| --- | --- |
| `ticket_create({ title, request, note?, after?, mergeWhenReady? })` | Creates a ticket: a branch `pi/<id>-<slug>` and a worktree from the main checkout's `HEAD`, then its agent. `request` is your words verbatim; the whole message it came from is kept too. `after` lists tickets that must be merged first; `mergeWhenReady` merges it as soon as it reports ready. |
| `ticket_message({ id, text })` | Forwards a follow-up to one ticket. |
| `ticket_status({ id?, all? })` | Lists the open tickets, or shows one in detail. |
| `ticket_merge({ id, whenReady? })` | Merges a ticket, only on your request; `whenReady` merges it once it reports ready. |
| `ticket_close({ id, reason })` | Abandons a ticket, only on your request. Its worktree is removed and its branch kept. |
| `git_read({ args })` | Runs a read-only git command (`status`, `diff`, `log`, `show`, `blame`, listing `branch`/`tag`, ...) in the main checkout, without a shell. |

A ticket agent reads the code, makes the change, runs the relevant checks, commits on its branch with normal hooks, and calls `ticket_report`. It may delegate to `recon`, `worker`, `reviewer`, and `expert` agents, which work in its worktree. It cannot call `herder_*` tools or `impeccable_question`; it asks you through `ticket_report` instead. Its model and thinking level come from the `ticket` agent type's frontmatter (edit it with `/agents`), else the main session's model. Ticket agents appear in Subagents' widget and `/agents` list like any background agent, and pika uploads them as children of the main session with a `superagent` link (`ticketId`, `branch`, `title`).

States: `queued` (waiting for an agent slot, or for its `after` tickets), `working`, `question` (the agent asked something and may still be working), `waiting` (the run ended without a report; its last text is shown), `ready` (committed and verified), `blocked`, `failed`, `interrupted` (Pi stopped while it ran), and the final `merged` and `closed`. An agent that finds nothing to do drops the ticket, which closes it. A ticket whose `after` ticket is closed fails; send it a message to start it anyway.

Ticket state lives under `<git-common-dir>/superagent/`, so every checkout and worktree of the repository sees the same tickets. Only the session that created a ticket, or last resumed it, runs its agent and receives its reports. Other sessions list it read-only.

## Reports

You get a report message in the main session when a ticket asks a question or becomes `ready`, `blocked`, `failed`, or `waiting`; when it is merged or dropped; and when a merge goes back to the agent for a rebase or is refused. Each starts with `#<id> <kind> · <title>`; a `ready` report names the branch, its commits ahead of your branch, and the changed files.

Reports that need attention start a turn of the main session, so the router can act on them: while the session is idle after a 200 ms hold (reports arriving meanwhile are delivered together), while it is busy at the end of its current turn, steered into the run as one message. `merged` and `dropped` are only shown. With `"react": "none"` no report starts a turn.

The footer shows the mode and how many tickets are working, queued, or waiting for you, and in the TUI a board above the editor groups the open tickets:

```text
superagent: on · 2 working · 1 for you

needs you: #3 Fix login (question)
ready to merge: #2 Export --json
working: #4 Snake case fields
queued: #5 Release notes (after #2)
```

## Follow-ups with `#N`

Start a message with `#N` to send it straight to ticket N, without a turn of the main session. A notification confirms delivery. A running agent is steered, an idle one continues in a new run of the same conversation, an interrupted one (or one whose agent record is gone) is reopened from its session file, with a note to check `git status` and `git log` first after an interruption, and a queued one gets the message with its first prompt. `#N` alone shows the ticket. A merged or closed ticket is refused. When there is no ticket N, the message goes to the main session as usual, since `#12` may be an issue number. This works in both modes.

## Merging

`/merge N` (or `ticket_merge` when you ask the model) merges a ticket into the branch the main checkout is on:

1. It refuses while the agent is running, while the worktree has uncommitted changes (the agent is asked to commit them), when the branch has no commits, or when the main checkout is on a detached HEAD.
2. If your branch moved, the ticket branch is rebased onto it. On conflicts the rebase is aborted and the agent is asked to rebase and resolve them; the merge runs again when it reports `ready`.
3. The main checkout is fast-forwarded with `git merge --ff-only`. If git refuses, for example because uncommitted changes would be overwritten, its message is reported and the ticket stays `ready`.
4. The worktree and the branch are removed, and the ticket becomes `merged`. Tickets waiting for it start.

## Commands

| Command | Behavior |
| --- | --- |
| `/tickets` | List the repository's open tickets. `/tickets all` includes merged and closed ones. |
| `/tickets N` | Show one ticket: state, title, branch, worktree, commits ahead, changed files, last report or text, and question. |
| `/tickets resume N` | Take over a ticket in this session and continue an interrupted one. |
| `/tickets close N [reason]` | Stop the agent, remove the worktree, keep the branch. |
| `/merge N` | Merge a ticket, as above. |
| `/superagent [on\|off\|status]` | Switch the session's mode, or show it with the router tools. |

## Restarts

Each ticket has a lock that its session refreshes every 30 seconds. A lock goes stale after 120 seconds without a heartbeat, or when its process is gone. When a session ends, it stops its ticket agents, marks their tickets `interrupted`, and releases its locks. When a session starts, open tickets that were working or queued and have no live lock become `interrupted`. Send one a message, or run `/tickets resume N`, to continue it in the same conversation: Subagents reopens the ticket's session file.

## Settings

`<agentDir>/superagent.json` (normally `~/.pi/agent/superagent.json`) is read when a session starts. Invalid values are reported once and ignored.

```json
{ "enabled": true, "maxWorkers": 4, "routerTools": [], "routerAgents": ["recon", "reviewer", "expert"], "react": "attention" }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` starts sessions in direct mode; `/superagent on` still switches one. `PI_SUPERAGENT_DISABLED=1` keeps every session direct. |
| `maxWorkers` | `4` | Running ticket agents per session, 1–16. Further tickets stay `queued` and start in creation order. Follow-ups to existing agents are not limited. |
| `routerTools` | `[]` | More tool names to keep active in superagent mode. |
| `routerAgents` | `["recon", "reviewer", "expert"]` | Subagents types the router may run with `Agent`; `[]` removes `Agent`. |
| `react` | `"attention"` | `attention`: reports that need you start a main-session turn; `none`: reports are only shown. |

`workerModel` and `workerThinking` are no longer read (a warning names them): set `model` and `thinking` in the `ticket` agent type's frontmatter instead.

## How it relates to the other extensions

- **Subagents** runs every ticket agent: superagent spawns, messages, reopens, and stops them over Subagents' `subagents:rpc:*` bus verbs and follows their runs through `subagents:started`/`completed`/`failed`. It imports nothing from Subagents.
- **Herder** runs one planned, verified, multi-step orchestration with its own worktrees and delivery confirmation. Its tools stay available to the router, so the main session can start a Herder run when you ask for one; ticket agents cannot.
- **pika** uploads ticket sessions as children of the main session, nested under the `ticket_create` call that created them. Superagent imports neither pika nor Relay.

## Development

```bash
npx vitest run extensions/superagent
npm run typecheck
```

The dispatcher, outbox, and Subagents host tests use in-memory fakes (the host a fake RPC bus). The hook and router tests run real Pi sessions on the faux provider in a temporary git repository. `tests/integration.test.ts` loads the real Subagents extension next to superagent and runs ticket agents end to end; it is skipped while Subagents' `PROTOCOL_VERSION` is below 3.
