# Superagent design

Superagent makes a top-level Pi session a router. The main session talks with the user, answers questions from
read-only tools, and turns every piece of work into a **ticket**. Depending on the repository's **workspace mode**, each
ticket runs in its own git worktree and branch (`worktree`, the default) or directly in the main checkout's working
tree (`shared`), with a long-lived **ticket agent**: a Subagents agent of the embedded `ticket` type, driven over Subagents'
cross-extension RPC, whose session persists across Pi restarts. Tickets run in parallel, report back asynchronously
(their reports start main-session turns), and are merged into the user's branch (or, in shared mode, marked done) only
when the user asks.

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

- Direct mode is the default. Superagent mode is opt-in with `/superagent on` or `enabled: true` in settings for a
  top-level session (`ctx.mode` is `tui` or `rpc`) whose cwd is inside a git repository with at least one commit. Child sessions (Subagents agents, ticket agents
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
- `git_read` (below), the router ticket tools, `relay_list`, `relay_send`, `relay_status`, `recall_search`,
  `recall_read`, every `herder_*` tool (Herder is an explicit orchestration mode with its own worktrees and
  confirmation), and `loop_schedule`, `loop_stop`;
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
non-displayed custom message `superagent-tickets` with the workspace mode (`Workspace mode: <mode>.`) and the open
tickets: `#id [state] title`, a pending question, the branch (shared: the shared working tree and how many files it
touched), the `after` tickets a queued one waits for, `mergeWhenReady`, and the files several shared tickets changed. The instructions say:

- You are the router of this repository. You talk with the user and route work; ticket agents do the work. Here you
  cannot edit files or run commands.
- The workspace mode, named in the tickets message: in worktree mode each ticket works in its own worktree and branch,
  and merging fast-forwards it; in shared mode tickets work in the user's working tree and leave their changes
  uncommitted, nothing needs merging, and `ticket_merge` only marks a ticket done. Only the user switches modes.
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

## Workspace modes

The workspace mode is per repository, never per ticket mix: every open ticket of a repository runs in the same mode.

- **`worktree`** (default): every ticket gets its own worktree and branch from the main checkout's `HEAD`, commits there,
  and is merged by rebase and fast-forward (see "Merging").
- **`shared`**: a ticket has no worktree and no branch. Its agent's cwd is the main checkout's top level; it sees and edits
  the working tree as it is, uncommitted changes included, in parallel with other tickets and the user, and leaves its
  changes uncommitted. "Merging" marks it `done`.

The mode is stored in `<git-common-dir>/superagent/workspace.json` as `{ mode, changedAt, changedBy }` (atomic write:
temp file + rename; `changedBy` is the switching session's id). Without the file, the `workspace` setting decides
(`"worktree"` by default). `src/workspace.ts` reads it at every use, so every session of the repository sees a switch.

- `/superagent workspace` shows the mode, and when and by which session it was switched.
- `/superagent workspace shared|worktree` switches it. The switch is refused while any ticket of the repository is open,
  from any session: `The workspace mode cannot be switched while tickets are open:` followed by one `#N [state] title` line
  per open ticket and `Merge or close them first (/merge N, /tickets close N).`. Switching to `worktree` while the main
  checkout is dirty succeeds with the warning "The main checkout has uncommitted changes: new tickets will be refused until
  they are committed or stashed.".
- The router has no tool to switch modes; only the user does.
- `/superagent status`, the footer (`superagent: on · shared · 1 working`), the board widget's header line
  (`tickets · shared workspace`), and the router's `superagent-tickets` message (`Workspace mode: shared.`) show the mode.

### Dirty-workspace refusal (worktree mode)

In worktree mode a ticket starts from the last commit, so the user's uncommitted work would be invisible to it. `create`
therefore runs `git status --porcelain` in the main checkout first (untracked files count, ignored files do not), before
anything is allocated: no ticket id, branch, or worktree. When it lists anything, `create` throws a `DirtyWorkspaceError`
(a `DispatchError`):

```text
Ticket not created: the workspace has uncommitted changes (<up to 5 porcelain lines, then "and N more">). In worktree mode tickets start from the last commit, so commit or stash these first, or switch with /superagent workspace shared.
```

`ticket_create` returns it as a tool error and also shows it to the user with `ctx.ui.notify(..., "warning")`.

### Shared workspace

A shared ticket (`workspace: "shared"` on the ticket; an absent field means `worktree`, which covers tickets from before
the mode existed) records `worktree` = the main checkout's top level and `branch` = the main checkout's branch at
creation (`HEAD` on a detached HEAD); both are informational, for reports and pika's badge. `base` is `HEAD` at
creation. `touched` lists the repo-relative paths the agent and its delegates changed with `edit`/`write`.

Safety: no code path removes a worktree, deletes a branch, rebases, or fast-forwards for a shared ticket: merge (it marks
the ticket `done` instead, and `mergeTicket` refuses shared tickets on its own), close, `dropped`, cleanup, and resume.
`git.removeWorktree` also refuses the main checkout's path, and `git.deleteBranch` the main checkout's current branch.

Shared mode trades isolation for seeing the real working tree. Its risks, and what superagent does about them:

- **Concurrent edits.** Tickets and the user edit the same files at the same time. The ticket hook's `write` guard (below)
  refuses to overwrite a file the session has not read since its last change, and the prompt asks for `edit` and a
  re-read before every further change.
- **Overlap.** After a successful `edit`/`write`, the tool result notes every other open shared ticket that changed the
  same path (`Note: ticket #M also changed <path>; make sure you are not undoing its change.`); the board lists the files
  more than one open ticket changed.
- **Checks see other work.** Tests and builds run on the shared tree, with other tickets' unfinished changes in it. A
  ticket reports a failure in code it did not touch instead of fixing it.
- **Editor buffers.** The user's editor may hold unsaved buffers of files a ticket changes; saving them overwrites the
  ticket's change. Superagent cannot see editor buffers.
- **`bash` bypasses the guards.** The `write` guard and touched-file tracking see only the `write` and `edit` tools; a
  `bash` command (`sed -i`, a formatter, a code generator) changes files unseen. The git block is a best-effort parse of
  the command string, not a sandbox.

## Tickets

Store root: `<git-common-dir>/superagent/`, shared by every checkout and worktree of the repository.

```
superagent/
  tickets/<id>/ticket.json    current state (atomic write: temp file + rename)
  tickets/<id>/events.jsonl   append-only history: { at, type, ... }
  tickets/<id>/lock           { pid, sessionId, heartbeat } while a process runs the ticket agent
  workspace.json              { mode, changedAt, changedBy }: the workspace mode, once switched
  sessions/                   unused: Subagents persists ticket sessions with its other child sessions
  worktrees/<id>-<slug>/      the ticket's worktree (worktree mode)
```

Ids are positive integers per repository, allocated by creating `tickets/<id>` with `mkdir` (atomic; retry the next
number on `EEXIST`). The slug is the title lowercased, non-alphanumerics collapsed to `-`, trimmed, at most 40
characters, `ticket` when empty. The branch is `pi/<id>-<slug>`; if it exists, `pi/<id>-<slug>-2`, and so on (worktree
mode; a shared ticket has none of its own).

`Ticket` (see `src/types.ts`) records the request verbatim, the user message it came from, the base commit and target
branch at creation, branch, worktree, the ticket agent's session file and Subagents `agentId` (of the process that last
ran it), state, last report, pending question, `after`, merge fields (`mergeRequested`, `mergeWhenReady`, ...), and for
shared tickets `workspace: "shared"` and `touched`.

States:

| State | Meaning | Next |
| --- | --- | --- |
| `queued` | Waiting for an agent slot, or for its `after` tickets to be merged or done | `working`; `failed` when an `after` ticket is closed |
| `working` | The ticket agent runs | any report state, `waiting`, `failed`, `interrupted` |
| `waiting` | The agent ended its run without a final report; its last text is shown | `working` on a message |
| `question` | The agent asked the user something; it may still be working | `working` on a message or a later report |
| `ready` | Committed and verified; mergeable (shared: done and verified, uncommitted) | `working` on a message, `merged`, `done` |
| `blocked` | Cannot go on without the user | `working` on a message |
| `failed` | Cannot be done, or the run failed | `working` on a message |
| `interrupted` | Pi stopped while it was queued or running | `working` on a message or `/tickets resume N` |
| `merged` | Fast-forwarded into the target branch; worktree and branch removed | final |
| `done` | Shared mode: marked finished by the user; its changes stay uncommitted in the working tree | final |
| `closed` | Abandoned by the user; worktree removed, branch kept (shared: changes stay in the working tree) | final |

A ticket is **open** unless it is `merged`, `done`, or `closed` (`FINAL_STATES`). `dropped` is a report, not a state: it closes the ticket with
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
your worktree before repeating anything, then continue."; for a shared ticket: "Pi restarted while you were working. The
working tree is shared with other tickets and the user: check `git status` and `git diff`, and read the files you were
changing again, before repeating anything; then continue.") followed by the message.

## Ticket agents

A ticket agent is a Subagents agent of the embedded `ticket` type (Subagents' `src/default-agents.ts`): not visible to
models, all built-in tools, extensions and skills on, context files from its cwd up to the worktree root,
`allowedSubagents` `recon`, `worker`, `reviewer`, `expert`, `requireToolUse`, Pi's normal system prompt with a generic,
mode-neutral ticket role appended (it owns one long-running task; where it works, whether it commits, and how it reports
come from the extension that started it), and no model or thinking of its own unless the user sets them in the type's frontmatter
(`/agents`), else the main session's model. `src/subagents-host.ts` implements the dispatcher's `WorkerHost` over the
`pi.events` RPC bus: a request on `subagents:rpc:<verb>` with a unique `requestId`, the reply `{ success, data?,
error? }` on `subagents:rpc:<verb>:reply:<requestId>`, with a timeout (10 s; 60 s for spawn and reopen, which wait for
the agent to start).

- **Protocol.** At first use the host pings (`subagents:rpc:ping`); a missing reply or a `version` below 3 fails the
  start with "Subagents with RPC protocol 3 is required to run tickets: …" (the ticket becomes `failed`). A failed
  check is retried at the next use.
- **Start.** `subagents:rpc:spawn` `{ type: "ticket", prompt, options: { cwd: <worktree, or the main checkout for a shared ticket>, description: "#<id> <title>",
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
removes it when it stops it. Its `sessions` map holds session id → ticket key for every active ticket session and every
descendant session of a shared ticket.

In every child session Subagents creates, the hook's `session_start` reads the session link. It activates only when the
link has `agentType: "ticket"` and an integer `superagent.ticketId`, and the session's repository (its cwd's git common
dir) with that id is in the registry. There it:

- registers the session's id in the registry's `sessions`;
- registers `ticket_report` and forwards each report to the owning dispatcher;
- reports the session file (`ctx.sessionManager.getSessionFile()`), recorded as the ticket's `sessionFile`;
- appends the ticket's instructions (`src/worker-prompt.ts`) to the system prompt in `before_agent_start`, under
  `# Your ticket`;
- blocks `herder_*` and `impeccable_question` calls with the reason `"<tool> is not available in a ticket session:
  ask the user through ticket_report (state "progress" with a question, or "blocked") instead."`

Nested agents a ticket agent starts (`worker` and the others) inherit its cwd and are not ticket sessions. In shared
mode they are part of the ticket, though: a child session whose link has a `parentSessionId` in the registry's `sessions`
(the ticket session itself, or a descendant registered the same way, so grandchildren are found too) belongs to that
ticket when the ticket is shared. Such a descendant registers its own session id, gets a short `# Shared working tree`
section in its system prompt, and the shared guards below; it gets no `ticket_report` and no `herder_*` block. Descendants
of a worktree ticket are left alone. Entries are removed at `session_shutdown`.

In a shared ticket's session and its descendants the hook also:

- **Blocks git state commands.** A `bash` call is parsed heuristically (`src/shared-guard.ts`): the command string is
  split into simple commands on `;`, `&`, `|`, newlines, parentheses, `$(`, and backticks, with quotes handled; leading
  variable assignments and wrappers (`sudo`, `env`, `command`, `exec`, `time`, `nohup`, `nice`, `xargs`, ...) are
  skipped, and `sh`/`bash`/`zsh -c '<command>'` is parsed recursively. For each `git` (or `…/git`) invocation, global
  options (`-C <dir>`, `-c k=v`, `--git-dir`, `--work-tree`, `--no-pager`, any other `-…`) are skipped, and the subcommand
  `add`, `commit`, `checkout`, `switch`, `restore`, `reset`, `stash`, `clean`, `rebase`, `merge`, `cherry-pick`,
  `revert`, `am`, `pull`, `push`, `rm`, `mv`, `worktree`, `branch`, or `tag` is blocked, except listing-only forms
  (`git branch`/`git tag` with only listing options such as `-a`, `-r`, `-v`, `--list <pattern>`, `--contains`,
  `--sort=…`, and `git worktree list`). The reason: "`git <sub>` is blocked in a shared-workspace ticket: the working
  tree is shared with other tickets and the user, so your changes must stay uncommitted and git state (index, HEAD,
  branches, tags, stash, worktrees, remotes) must not change. Read-only git such as `git status`, `git diff`, and
  `git log` works." This is best effort, not a sandbox: a script, an alias, or a quoted command it does not parse runs.
- **Guards `write`.** A `write` to an existing file is blocked unless this session last read, edited, or wrote that file
  (recorded from successful `read`/`edit`/`write` tool results) and its mtime and size are unchanged since: "write to
  `<path>` is blocked: the file changed since you last read it, or you never read it; another ticket or the user may have
  edited it. Read it again and use `edit`." Creating a new file is allowed.
- **Records touched files.** After a successful `edit`/`write` inside the main checkout, the repo-relative path is added
  to the ticket's `touched` through the owning dispatcher (persisted, with a `touched` event). When another open shared
  ticket touched the same path, the tool result gets `Note: ticket #M also changed <path>; make sure you are not undoing
  its change.`
- **Blocks `Agent` with `isolation: "worktree"`**: "Agent with isolation "worktree" is not available in a shared-workspace
  ticket: delegates work in the shared working tree too. Run it without isolation."

Everywhere else it does nothing.

`ticket_report({ state, summary, question?, tests? })`, `state` one of `progress`, `ready`, `blocked`, `failed`,
`dropped`. `progress` with a `question` asks the user without stopping; `progress` alone is a silent note. The tool
returns at once with `"Reported."`.

The ticket section of the system prompt (`src/worker-prompt.ts`) depends on the ticket's mode; the `ticket` type only
gives the generic role. In worktree mode it says, with the ticket's values filled in:

- You are the agent for ticket #N, "<title>", in your own git worktree `<path>` on branch `<branch>`, created from
  `<base>` of `<target>`. Work only inside this worktree. Never touch the main checkout, other checkouts, other
  branches, or remotes, and never push.
- The user's request, verbatim, is your first message. Derive what to do from it and the repository, not from the
  title. A routing note, when present, carries facts, not requirements.
- Investigate, implement, run the relevant checks, and commit on your branch with normal `git commit`
  (hooks on, never `--no-verify`), following the repository's commit conventions.
- Prove the change by running it, not by rereading it: add or update tests that exercise it (for a bug, one that
  fails without the fix) and run them with the repository's type checker and linters. Extra effort goes to stronger
  tests and static checks, not to reviewing its own diff, and working code is not changed for a problem it cannot
  demonstrate.
- You may delegate to recon, worker, reviewer, and expert agents; they work in your worktree. A delegate's
  `isolation: "worktree"` branch must be merged into yours by you.
- Report with `ticket_report`: `ready` once the change is committed and verified; `progress` with a `question` for one
  concrete decision only the user can make; `blocked`; `failed`; `dropped` when there is nothing to do. Do not report
  `ready` for a draft or while a check you need is still running.
- Messages from the user may arrive while you work; they are part of this ticket.
- Ask the user through `ticket_report`; `herder_*` and `impeccable_question` are not available in a ticket.

In shared mode it says instead:

- You are the agent for ticket #N, "<title>". You work directly in the user's working tree `<path>` (branch
  `<branch>`), shared with other tickets and with the user, who may edit files at the same time.
- The request and routing note, as above.
- Leave all your changes uncommitted, and never change git state; read-only git is fine; such commands are blocked.
- Change existing files with `edit`, and read a file again before changing it again; a `write` to an existing file you
  have not just read is refused.
- Do not revert or "fix" changes you did not make. When a check fails in code you did not touch, say so in your report
  instead of fixing it.
- Investigate, implement, and run the relevant checks; other tickets' unfinished changes may be in the tree.
- Prove the change by running it, as above.
- Delegates work in this same tree under the same rules and must not use `isolation: "worktree"`.
- Report `ready` when your part is done and verified; the other report states, messages, and asking as above.

### Run outcomes

When a ticket agent's run ends (`subagents:completed` or `subagents:failed`), the dispatcher decides:

1. The run ended with a provider error or was aborted: `failed` (or `interrupted` during shutdown), with the error.
2. The ticket's first run, on its request, called no tool at all: `failed` with "the worker finished without calling
   any tool; the model may not have received its tool definitions. Retry with a message, or check the model route."
   Its text is kept as `lastText`. Later runs may answer a message in text alone; they fall under 4. (The `ticket`
   type's `requireToolUse` makes this rare; the rule stays as a fallback.)
3. The run called `ticket_report` with a final state (`ready`, `blocked`, `failed`, `dropped`): that state stands. A
   `ready` ticket with `mergeRequested` or `mergeWhenReady` is merged (shared: marked done) now; the outcome is its
   report.
4. Otherwise: `waiting`, with the last assistant text (cut to 2,000 characters) as `lastText`.

## Reports to the main session

The owner session receives a `superagent-report` custom message (`display: true`, rendered by a message renderer)
when a ticket becomes `question`, `ready`, `blocked`, `failed`, `waiting`, `merged`, `done`, or `closed` by a `dropped`
report, and when a merge is handed to the agent (`merge-handed`) or refused on a re-run (`merge-refused`). Progress
without a question is silent. Each report's text starts with `#<id> <kind> · <title>`, then the state when it differs,
the summary or question, and for `ready` the branch, commits ahead of the target, and changed files. A shared ticket's
reports never compare branches: they name the shared working tree and list `touched` instead. A `done` report ends with
"Ticket #N is done; its changes stay uncommitted in your working tree." `details` is
`ReportDetails` (`src/render.ts`); several reports delivered together are one message whose `details` is
`{ batch: ReportDetails[] }` and whose content is their texts joined by blank lines.

Delivery (`src/outbox.ts`):

- Reports that need attention (`question`, `ready`, `blocked`, `failed`, `waiting`, `merge-handed`, `merge-refused`)
  start a main-session turn. While the session is idle they wait 200 ms (collecting what arrives meanwhile), then go
  out as one message with `triggerTurn: true`. While it is busy they wait for the next `turn_end` and go out as one
  message with `deliverAs: "steer"`, `triggerTurn: true`; what is left at `agent_end` goes out after the hold. A run
  that starts during the hold takes the reports at its next turn end.
- `merged`, `done`, and `dropped` are shown without a turn: appended at once when idle, `deliverAs: "followUp"` with
  `triggerTurn: false` while busy.
- Setting `react: "none"` shows every report that way.

The footer status (`ctx.ui.setStatus("superagent", ...)`) shows the session mode, the workspace mode, and counts of
working tickets and tickets waiting for the user (`superagent: on · shared · 2 working · 1 for you`). In the TUI, the
board widget (`ctx.ui.setWidget("superagent", lines)`) starts with the header `tickets · <mode> workspace` and groups the
repository's open tickets, one line per non-empty group: `needs you` (`question`, `blocked`, `failed`, `waiting`,
`interrupted`, with the state), `ready to merge` (worktree tickets), `ready` (shared tickets), `working`, and `queued`
(with `after #N` while it waits for other tickets), then one `overlap: <path> (#M, #N)` line per file more than one open
shared ticket changed. It is hidden when no ticket is open and refreshed on every ticket change.

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

- `ticket_create({ ..., after: number[] })`: the ticket stays `queued` until every listed ticket is `merged` or `done`.
  Unknown or closed tickets are refused at creation; tickets already merged or done are dropped from the list. When a listed ticket is
  closed later, the waiting ticket becomes `failed` ("ticket #M, which this ticket starts after, was closed (…), so it
  will never be merged. Send a message to start this ticket anyway, or close it."), is reported, and its `after` is
  cleared. Queued tickets are checked whenever the queue drains (after a merge, a close, a run end, a creation).
- `ticket_create({ ..., mergeWhenReady: true })` and `ticket_merge({ id, whenReady: true })` set `mergeWhenReady`: the
  ticket's `ready` report produces no `ready` message; when that run ends the merge runs, as for a re-run after a
  hand-off, and its outcome (`merged`, `merge-handed`, `merge-refused`) is the report. `ticket_merge` with `whenReady`
  on a ticket that is `ready` and idle merges at once. `mergeWhenReady` is persisted before that attempt too, so a dirty
  worktree hand-off retries after the agent commits or discards its changes and reports ready again. The immediate
  result includes the current ticket after the attempt.
- Bare `/merge` snapshots `dispatcher.list()` (open tickets only), sorts by ascending id, and sequentially requests
  `mergeWhenReady` for each. Ready, idle tickets merge immediately (shared: become done); all others keep their state
  and are scheduled for their next ready run end. Scheduling does not resume blocked, failed, or interrupted agents;
  these and other attention states are shown in the response. New tickets are outside the snapshot. Each immediate
  outcome uses the same response as `/merge N`; scheduled responses say merge (shared: done) when ready. Per-ticket
  errors, including foreign live ownership, are reported and processing continues. Refresh the host after the batch,
  even if some requests failed. With no open tickets, report `No open tickets.`.

## Merging

All dispatcher merge calls, including explicit requests and run-end retries, share a per-dispatcher promise queue.
Only one merge mutates the main checkout at a time within a Pi session. Each queued attempt revalidates that the ticket
is open, takes ownership, and checks shutdown when it starts; a rejected attempt does not poison the queue. After
awaiting any pending start, automatic attempts from `mergeWhenReady` and run-end retries also recheck `ready` and
`!running` immediately before merging or marking done. A stale attempt skips without an outcome or `merge-refused`
report and preserves `mergeRequested`/`mergeWhenReady` for the next ready run end; `mergeWhenReady` returns the current
ticket so callers report its scheduled state. Explicit `/merge N` can still merge an idle ticket in another state. Queued
merges are tracked by `idle()`, while shutdown sets the closing guard without waiting for the merge queue. The queue
is released when `mergeTicket` returns, including a hand-off to a worker; it never waits for the worker's whole
conflict-resolution run. Initial batch requests are ascending by id, but tickets that are not ready finish as their
agents report ready; there is no strict batch completion order or cross-session merge queue.

`/merge N` or `ticket_merge({ id })`, only on the user's request. For a **shared ticket** it runs no git command at all:
it is refused while the agent runs; otherwise the ticket becomes `done` (with a `done` event), its agent is stopped and
forgotten, its lock released, a `done` report is shown without a turn, and tickets waiting for it start. `mergeWhenReady`
marks a shared ticket done once it reports ready. For a **worktree ticket**:

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
`closed`. For a shared ticket it only stops the agent and says that its changes stay in the working tree.

## Commands

- `/tickets` lists open tickets of the repository (`/tickets all` includes merged, done, and closed); `/tickets N` shows one
  (state, title, branch, worktree, commits ahead, changed files, last report or text, question; for a shared ticket the
  main checkout and `touched` instead of a branch diff).
- `/tickets resume N`, `/tickets close N`.
- `/merge [N]`: without an id, request the current open-ticket snapshot in ascending id order, merging ready idle
  tickets now and scheduling the rest for ready. With an id, keep the immediate single-ticket merge behavior.
  Malformed explicit arguments report `Usage: /merge [N]`.
- `/superagent [on|off|status]`, `/superagent workspace [shared|worktree]`.

## Settings

`<agentDir>/superagent.json`, read at `session_start`; invalid values are reported once and ignored:

```json
{ "enabled": false, "maxWorkers": 4, "routerTools": [], "routerAgents": ["recon", "reviewer", "expert"], "react": "attention", "workspace": "worktree" }
```

`workspace` (`"worktree"` or `"shared"`) is the workspace mode of repositories without a `workspace.json`.
`enabled` defaults to `false`; `enabled: true` starts new eligible sessions in superagent mode. A saved session choice
takes precedence over settings; `PI_SUPERAGENT_DISABLED=1` forces direct mode even for a saved opt-in. `maxWorkers` (1–16, default
4) bounds running ticket agents per session; further tickets stay `queued` and start in creation order. `routerTools`
adds tool names to the router set; `routerAgents` lists the Subagents types the router may run with `Agent` (`[]`
removes `Agent`); `react` is `attention` (default) or `none` (see "Reports to the main session").

The earlier `workerModel` and `workerThinking` keys are no longer read and are reported as such: the `ticket` agent
type's frontmatter (`model`, `thinking`) decides, else the main session's model.
