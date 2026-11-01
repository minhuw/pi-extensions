# Superagent design

Superagent makes a top-level Pi session a router. The main session talks with the user, answers questions from
read-only tools, and turns every piece of work into a **ticket**. Each ticket runs in its own git worktree and branch,
with a long-lived **ticket agent**: a Subagents agent of the embedded `ticket` type, driven over Subagents'
cross-extension RPC, whose session persists across Pi restarts. Tickets run in parallel, report back asynchronously
(their reports start main-session turns), and are merged into the user's branch only when the user asks.

The design follows the two-layer model of DeepSeek's dsh-superagent prototype (router plus workers, subscription bypass
for follow-ups, structured reports, verbatim requests), without its multi-user authorization, GitHub/Feishu sources,
pull requests, or panel. Its finding that a prompt alone does not make a session delegate reliably is why the main
session loses its editing tools instead of being asked not to use them.

Code lives in `extensions/superagent/` (formerly `extensions/dispatch/`). Shared contracts are in `src/types.ts`; this
document is their specification. Superagent imports no other extension of this collection. It drives Subagents only
over `pi.events` (`subagents:rpc:*`, protocol 3, see `extensions/subagents/docs/rpc.md`) and reaches its ticket
sessions through the child-session hook Set (`Symbol.for("pi-extensions.child-session-hooks")`). pika sees ticket
sessions as Subagents children; their session link carries `superagent: { ticketId, branch, title }`.

## Modes

A session is in **superagent mode** or **direct mode**.

- Superagent mode is the default for a top-level session (`ctx.mode` is `tui` or `rpc`) whose cwd is inside a git
  repository with at least one commit, unless settings disable it. Child sessions (Subagents agents, ticket agents
  included, and Herder steps), `print`/`json` modes, and directories outside git are always direct. Superagent itself
  loads in child sessions through normal extension discovery and stays inert there; the ticket-session hook (below) is
  the only ticket-session behaviour.
- A session is a child when its header has `parentSession` or it has a `pi-extensions.session-link` entry.
- `/superagent off` switches the session to direct mode and `/superagent on` back. The choice is recorded with
  `pi.appendEntry("superagent-mode", { mode })` (`mode` is `"superagent"` or `"direct"`) and restored on
  `session_start` from the current branch.
- Direct mode restores the active tools the session had before superagent mode, and removes no tools; ticket commands
  and `#N` routing still work in it.

### Tools in superagent mode

The main session's active tools become the **router set**:

- the read-only built-ins `read`, `grep`, `find`, `ls`, and `ffgrep`, `fffind` when registered;
- every registered tool whose `annotations.readOnlyHint` is `true` and that has no `reachesTools` (so not `codemode`
  or `tool_search`);
- `git_read` (below), the router ticket tools, `relay_list`, `relay_send`, `relay_status`, every `herder_*` tool
  (Herder is an explicit orchestration mode with its own worktrees and confirmation), and `loop_schedule`, `loop_stop`;
- Subagents' `get_subagent_result` and `steer_subagent`, and `Agent` when the `routerAgents` setting (default
  `["recon", "reviewer", "expert"]`) is not empty;
- the names in the `routerTools` setting.

Everything else (`edit`, `write`, `bash`, `codemode`, ...) is removed with `pi.setActiveTools()`. The set is
reapplied in `before_agent_start`, because other extensions may change active tools. A `tool_call` handler is the
backstop: in superagent mode it blocks every model-issued call (no `parentToolCallId`) to a tool outside the router
set, with the reason `"<tool> is not available in superagent mode: create a ticket with ticket_create for changes, or
switch to direct mode with /superagent off."` It also blocks an `Agent` call whose `subagent_type` is not in
`routerAgents` (`Agent with subagent_type "<type>" is not available in superagent mode: only <types> may run here
(setting routerAgents). Work that changes files goes to a ticket: create one with ticket_create.`), and one whose
`resume` names a ticket's agent, by its recorded `agentId` or its `ticket-<id>` handle (`Agent resume "<ref>" names
the agent of ticket #<id>: send it a message with ticket_message instead.`). User `!` shell commands are not affected.

`git_read({ args: string[] })` runs `git` in the main checkout with `execFile` (no shell), `GIT_TERMINAL_PROMPT=0`,
`--no-pager`, a 15 s timeout, and output cut to 50 KB. The subcommand must be one of `status`, `diff`, `log`, `show`,
`blame`, `shortlog`, `branch`, `tag`, `rev-parse`, `ls-files`, `grep`, `describe`, `merge-base`, `worktree list`
(as `["worktree", "list", ...]`). `diff`, `show`, and `log` always get `--no-ext-diff --no-textconv`. Any argument
starting with `--output`, `--exec`, `-c`, `--config`, `--git-dir`, `--work-tree`, or `-C`, and any `branch`/`tag`
argument that is not a listing option (`--list`, `-l`, `-a`, `-r`, `-v`, `-vv`, `--contains`, `--merged`,
`--no-merged`, `--points-at`, `--sort=…`, `--format=…`, or a pattern after `--list`) is refused.

### Router prompt

`before_agent_start` sets `systemPromptOptions.sections.superagent` to the router instructions (static text, in
`src/router-prompt.ts`). When the ticket summary changed since it was last given to the model, it also returns a
non-displayed custom message `superagent-tickets` listing open tickets: `#id [state] title`, a pending question, the
branch, the `after` tickets a queued one waits for, and `mergeWhenReady`. The instructions say:

- You are the router of this repository. You talk with the user and route work; ticket agents do the work in their
  own worktrees. Here you cannot edit files or run commands.
- Answer questions about the code yourself with the read-only tools, or the `Agent` types allowed for read-only help.
- Anything that changes files, or needs builds, tests, or other commands, becomes a ticket (`ticket_create`), one per
  independent piece of work; split a message holding several. Pass the user's words verbatim as `request`. Do not add
  plans, requirements, acceptance criteria, or checklists; the ticket agent reads the code and decides. A `note` of
  at most 30 words may carry routing facts only. `after` when the user wants work to start once another ticket is
  merged; `mergeWhenReady` only when the user asked for the merge up front.
- Forward a follow-up with `ticket_message` only when it points at one ticket explicitly: its number, its title, or
  "what you just did" when exactly one ticket fits. A similar subject is a new ticket. Messages that start with `#N`
  reach ticket N without you.
- After creating tickets, confirm in one line per ticket (its number and what it will do) and end the turn.
- Ticket reports arrive as messages and start a turn. Act on one only when you can: answer a ticket's question from
  what the user already said, pass a fact one ticket reported to another that needs it, or merge a ready ticket when
  the user asked for that merge or it has `mergeWhenReady`. Otherwise reply with at most one short line, or nothing.
  Never restate a report: the user sees it.
- Never wait or poll for a ticket.
- Merge (`ticket_merge`) and close (`ticket_close`) only when the user asks.
- Do not claim work a ticket has not reported.

## Tickets

Store root: `<git-common-dir>/superagent/`, shared by every checkout and worktree of the repository.

```
superagent/
  tickets/<id>/ticket.json    current state (atomic write: temp file + rename)
  tickets/<id>/events.jsonl   append-only history: { at, type, ... }
  tickets/<id>/lock           { pid, sessionId, heartbeat } while a process runs the ticket agent
  sessions/                   unused: Subagents persists ticket sessions with its other child sessions
  worktrees/<id>-<slug>/      the ticket's worktree
```

Ids are positive integers per repository, allocated by creating `tickets/<id>` with `mkdir` (atomic; retry the next
number on `EEXIST`). The slug is the title lowercased, non-alphanumerics collapsed to `-`, trimmed, at most 40
characters, `ticket` when empty. The branch is `pi/<id>-<slug>`; if it exists, `pi/<id>-<slug>-2`, and so on.

`Ticket` (see `src/types.ts`) records the request verbatim, the user message it came from, the base commit and target
branch at creation, branch, worktree, the ticket agent's session file and Subagents `agentId` (of the process that last
ran it), state, last report, pending question, `after`, and merge fields (`mergeRequested`, `mergeWhenReady`, ...).

States:

| State | Meaning | Next |
| --- | --- | --- |
| `queued` | Waiting for an agent slot, or for its `after` tickets to be merged | `working`; `failed` when an `after` ticket is closed |
| `working` | The ticket agent runs | any report state, `waiting`, `failed`, `interrupted` |
| `waiting` | The agent ended its run without a final report; its last text is shown | `working` on a message |
| `question` | The agent asked the user something; it may still be working | `working` on a message or a later report |
| `ready` | Committed and verified; mergeable | `working` on a message, `merged` |
| `blocked` | Cannot go on without the user | `working` on a message |
| `failed` | Cannot be done, or the run failed | `working` on a message |
| `interrupted` | Pi stopped while it was queued or running | `working` on a message or `/tickets resume N` |
| `merged` | Fast-forwarded into the target branch; worktree and branch removed | final |
| `closed` | Abandoned by the user; worktree removed, branch kept | final |

A ticket is **open** unless it is `merged` or `closed`. `dropped` is a report, not a state: it closes the ticket with
reason `"nothing to do: <summary>"`.

### Ownership and restarts

A process runs a ticket's agent only while it holds the ticket's lock: `lock` is created with `O_EXCL`, refreshed
every 30 s, and stale when its heartbeat is older than 120 s or its pid is not alive (`process.kill(pid, 0)`). A stale
lock may be taken over. The owner is the main session that created or last resumed the ticket; only it receives the
ticket's reports. Other sessions in the same repository list the ticket read-only from disk.

On `session_shutdown`, the session stops its running ticket agents, marks its `working` and `queued` tickets `interrupted`, and
releases its locks. On `session_start`, open tickets in `working` or `queued` without a live lock become
`interrupted`. An interrupted ticket continues when the user sends it a message: its session is reopened from
its file (`subagents:rpc:reopen`) and prompted with a recovery note ("Pi restarted while you were working. Check `git status` and `git log` in
your worktree before repeating anything, then continue.") followed by the message.

## Ticket agents

A ticket agent is a Subagents agent of the embedded `ticket` type (Subagents' `src/default-agents.ts`): not visible to
models, all built-in tools, extensions and skills on, context files from its worktree up to the worktree root,
`allowedSubagents` `recon`, `worker`, `reviewer`, `expert`, `requireToolUse`, Pi's normal system prompt with a generic
ticket role appended, and no model or thinking of its own unless the user sets them in the type's frontmatter
(`/agents`), else the main session's model. `src/subagents-host.ts` implements the dispatcher's `WorkerHost` over the
`pi.events` RPC bus: a request on `subagents:rpc:<verb>` with a unique `requestId`, the reply `{ success, data?,
error? }` on `subagents:rpc:<verb>:reply:<requestId>`, with a timeout (10 s; 60 s for spawn and reopen, which wait for
the agent to start).

- **Protocol.** At first use the host pings (`subagents:rpc:ping`); a missing reply or a `version` below 3 fails the
  start with "Subagents with RPC protocol 3 is required to run tickets: …" (the ticket becomes `failed`). A failed
  check is retried at the next use.
- **Start.** `subagents:rpc:spawn` `{ type: "ticket", prompt, options: { cwd: <worktree>, description: "#<id> <title>",
  name: "ticket-<id>", isBackground: false, notifyParent: false, retain: true, parentToolCallId: <ticket_create call
  id, first start only, when known>, linkData: { superagent: { ticketId, branch, title } } } }` → `{ id }`. The id is
  recorded on the ticket as `agentId`. Subagents writes the session link (`kind: "subagent"`, `agentType: "ticket"`,
  the parent session, `parentToolCallId`, and the `superagent` data) and persists the session; the session file
  reaches the ticket through the hook and the lifecycle events.
- **Restart.** A ticket whose agent this process does not know (after a restart) is started with
  `subagents:rpc:reopen` `{ sessionFile: <ticket.sessionFile>, type: "ticket", prompt, options: { cwd, description,
  name, isBackground: false, notifyParent: false, retain: true } }` → `{ id }`.
- **Follow-ups.** `subagents:rpc:send` `{ agentId, text }` → `{ delivery: "steered" | "resumed" }`: steered into a
  running agent, a new run of a settled one. On the exact error `Unknown agent "<id>"` (the record is gone) the host
  reopens the ticket's session file with the text.
- **Stop.** `subagents:rpc:stop` `{ agentId }` for a running agent; the host waits up to 5 s for it to settle and
  reports no run end for it, then forgets the agent. At shutdown it stops its running agents with a 1 s timeout
  (Subagents also stops every agent at its own shutdown).
- **Runs.** `subagents:started` / `subagents:completed` / `subagents:failed` for the ticket's `agentId` mark it running
  and end its runs: `run_end` with `text` = `result`, `toolCalls` = `runToolUses`, `error` for status `error`, and
  `aborted` for `stopped` or `aborted`. Events for an id whose spawn reply has not arrived yet (Subagents emits
  `started` inside spawn) are kept and replayed once the reply names it. A `sessionFile` in a payload updates the ticket.

Ticket agents notify nobody (`notifyParent: false`): their outcomes reach the main session only as superagent reports.
They are retained (`retain: true`), so their records survive Subagents' completed-agent cleanup until shutdown.

### Ticket sessions

`src/hook.ts` puts one hook object in the child-session hook Set while at least one top-level superagent instance in
the process can run tickets, and removes it when the last one shuts down. The process-global registry
`globalThis[Symbol.for("pi-extensions.superagent")]` maps ticket keys (`<git-common-dir>#<ticket id>`) to the owning
instance's callbacks (`ticket()`, `report()`, `session()`); the host registers a ticket when it starts its agent and
removes it when it stops it.

In every child session Subagents creates, the hook's `session_start` reads the session link. It activates only when the
link has `agentType: "ticket"` and an integer `superagent.ticketId`, and the session's repository (its cwd's git common
dir) with that id is in the registry. There it:

- registers `ticket_report` and forwards each report to the owning dispatcher;
- reports the session file (`ctx.sessionManager.getSessionFile()`), recorded as the ticket's `sessionFile`;
- appends the ticket's instructions (`src/worker-prompt.ts`) to the system prompt in `before_agent_start`, under
  `# Your ticket`;
- blocks `herder_*` and `impeccable_question` calls with the reason `"<tool> is not available in a ticket session:
  ask the user through ticket_report (state "progress" with a question, or "blocked") instead."`

Everywhere else it does nothing. Nested agents a ticket agent starts (`worker` and the others) inherit its worktree as
their cwd and are not ticket sessions.

`ticket_report({ state, summary, question?, tests? })`, `state` one of `progress`, `ready`, `blocked`, `failed`,
`dropped`. `progress` with a `question` asks the user without stopping; `progress` alone is a silent note. The tool
returns at once with `"Reported."`.

The ticket section of the system prompt says, with the ticket's values filled in (the generic role, worktree
discipline, and delegation rules come from the `ticket` type):

- You are the agent for ticket #N, "<title>", in your own git worktree `<path>` on branch `<branch>`, created from
  `<base>` of `<target>`. Work only inside this worktree. Never touch the main checkout, other branches, or remotes,
  and never push.
- The user's request, verbatim, is your first message. Derive what to do from it and the repository, not from the
  title. A routing note, when present, carries facts, not requirements.
- Investigate, implement, run the relevant checks, self-review, and commit on your branch with normal `git commit`
  (hooks on, never `--no-verify`), following the repository's commit conventions.
- Report with `ticket_report`: `ready` once the change is committed and verified; `progress` with a `question` for one
  concrete decision only the user can make; `blocked`; `failed`; `dropped` when there is nothing to do. Do not report
  `ready` for a draft or while a check you need is still running.
- Messages from the user may arrive while you work; they are part of this ticket.
- Ask the user through `ticket_report`; `herder_*` and `impeccable_question` are not available in a ticket.

### Run outcomes

When a ticket agent's run ends (`subagents:completed` or `subagents:failed`), the dispatcher decides:

1. The run ended with a provider error or was aborted: `failed` (or `interrupted` during shutdown), with the error.
2. The ticket's first run, on its request, called no tool at all: `failed` with "the worker finished without calling
   any tool; the model may not have received its tool definitions. Retry with a message, or check the model route."
   Its text is kept as `lastText`. Later runs may answer a message in text alone; they fall under 4. (The `ticket`
   type's `requireToolUse` makes this rare; the rule stays as a fallback.)
3. The run called `ticket_report` with a final state (`ready`, `blocked`, `failed`, `dropped`): that state stands. A
   `ready` ticket with `mergeRequested` or `mergeWhenReady` is merged now; the merge's outcome is its report.
4. Otherwise: `waiting`, with the last assistant text (cut to 2,000 characters) as `lastText`.

## Reports to the main session

The owner session receives a `superagent-report` custom message (`display: true`, rendered by a message renderer)
when a ticket becomes `question`, `ready`, `blocked`, `failed`, `waiting`, `merged`, or `closed` by a `dropped`
report, and when a merge is handed to the agent (`merge-handed`) or refused on a re-run (`merge-refused`). Progress
without a question is silent. Each report's text starts with `#<id> <kind> · <title>`, then the state when it differs,
the summary or question, and for `ready` the branch, commits ahead of the target, and changed files. `details` is
`ReportDetails` (`src/render.ts`); several reports delivered together are one message whose `details` is
`{ batch: ReportDetails[] }` and whose content is their texts joined by blank lines.

Delivery (`src/outbox.ts`):

- Reports that need attention (`question`, `ready`, `blocked`, `failed`, `waiting`, `merge-handed`, `merge-refused`)
  start a main-session turn. While the session is idle they wait 200 ms (collecting what arrives meanwhile), then go
  out as one message with `triggerTurn: true`. While it is busy they wait for the next `turn_end` and go out as one
  message with `deliverAs: "steer"`, `triggerTurn: true`; what is left at `agent_end` goes out after the hold. A run
  that starts during the hold takes the reports at its next turn end.
- `merged` and `dropped` are shown without a turn: appended at once when idle, `deliverAs: "followUp"` with
  `triggerTurn: false` while busy.
- Setting `react: "none"` shows every report that way.

The footer status (`ctx.ui.setStatus("superagent", ...)`) shows the mode and counts of working tickets and tickets
waiting for the user. In the TUI, the board widget (`ctx.ui.setWidget("superagent", lines)`) groups the repository's
open tickets, one line per non-empty group: `needs you` (`question`, `blocked`, `failed`, `waiting`, `interrupted`,
with the state), `ready to merge`, `working`, and `queued` (with `after #N` while it waits for other tickets). It is
hidden when no ticket is open and refreshed on every ticket change.

## Follow-ups

- **`#N text`** typed by the user (the `input` event, sources `interactive` and `rpc`) goes to ticket N and is handled
  without a main-session turn; a notification confirms it. `#N` alone shows the ticket. A final ticket is refused with a
  notification. When ticket N does not exist, the message goes to the model unchanged, since it may name an issue. This
  works in both modes.
- **`ticket_message({ id, text })`** forwards from the router.
- Delivery: a running agent is steered and an idle one known to this process starts a new run (both
  `subagents:rpc:send`; `Unknown agent` reopens the session file); a ticket whose agent this process does not know is
  reopened from its session file (`subagents:rpc:reopen`), with the recovery note first when it was `interrupted`; a
  `queued` ticket keeps the message for its first prompt. Sending makes the ticket `working` and clears its question.

## Ordering and automatic merges

- `ticket_create({ ..., after: number[] })`: the ticket stays `queued` until every listed ticket is `merged`. Unknown
  or closed tickets are refused at creation; tickets already merged are dropped from the list. When a listed ticket is
  closed later, the waiting ticket becomes `failed` ("ticket #M, which this ticket starts after, was closed (…), so it
  will never be merged. Send a message to start this ticket anyway, or close it."), is reported, and its `after` is
  cleared. Queued tickets are checked whenever the queue drains (after a merge, a close, a run end, a creation).
- `ticket_create({ ..., mergeWhenReady: true })` and `ticket_merge({ id, whenReady: true })` set `mergeWhenReady`: the
  ticket's `ready` report produces no `ready` message; when that run ends the merge runs, as for a re-run after a
  hand-off, and its outcome (`merged`, `merge-handed`, `merge-refused`) is the report. `ticket_merge` with `whenReady`
  on a ticket that is `ready` and idle merges at once.

## Merging

`/merge N` or `ticket_merge({ id })`, only on the user's request:

1. Refuse when the ticket is not open, its agent is running, its worktree has uncommitted changes (the agent is asked
   to commit them), it has no commits ahead of its base, or the main checkout is on a detached HEAD.
2. Target: the main checkout's current branch (the checkout superagent runs in). Its tip is `T`.
3. If `T` is not an ancestor of the ticket branch, rebase the branch onto `T` in the worktree. On conflicts, abort the
   rebase, set `mergeRequested`, and send the agent: "Merge requested: your branch no longer applies on top of
   `<target>` (`<T>`). Rebase onto `<T>`, resolve the conflicts keeping both sides' intent, rerun the relevant checks,
   commit, and report ready. Do not modify `<target>` yourself." When it next reports `ready`, the merge runs again
   automatically.
4. Fast-forward the main checkout: `git merge --ff-only <branch>`. If git refuses (for example uncommitted changes in
   the main checkout would be overwritten), report git's message and leave the ticket `ready`.
5. On success: state `merged`, `mergedInto`, `mergedAt`; stop and forget the agent; remove the worktree; delete the
   branch (`git branch -d`); release the lock; report; start tickets waiting for it.

`ticket_close({ id, reason })` or `/tickets close N` stops the agent, removes the worktree, keeps the branch, and sets
`closed`.

## Commands

- `/tickets` lists open tickets of the repository (`/tickets all` includes merged and closed); `/tickets N` shows one
  (state, title, branch, worktree, commits ahead, changed files, last report or text, question).
- `/tickets resume N`, `/tickets close N`.
- `/merge N`.
- `/superagent [on|off|status]`.

## Settings

`<agentDir>/superagent.json`, read at `session_start`; invalid values are reported once and ignored:

```json
{ "enabled": true, "maxWorkers": 4, "routerTools": [], "routerAgents": ["recon", "reviewer", "expert"], "react": "attention" }
```

`enabled: false` (or `PI_SUPERAGENT_DISABLED=1`) makes every session start in direct mode. `maxWorkers` (1–16, default
4) bounds running ticket agents per session; further tickets stay `queued` and start in creation order. `routerTools`
adds tool names to the router set; `routerAgents` lists the Subagents types the router may run with `Agent` (`[]`
removes `Agent`); `react` is `attention` (default) or `none` (see "Reports to the main session").

The earlier `workerModel` and `workerThinking` keys are no longer read and are reported as such: the `ticket` agent
type's frontmatter (`model`, `thinking`) decides, else the main session's model.
