# Pi extensions

Extensions, prompts, skills, and a theme for the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

## Extensions

| Extension | What it does |
| --- | --- |
| [Commit](extensions/commit/README.md) | `/commit` commits your current changes as a series of self-contained patches. |
| [Quality](extensions/quality/README.md) | `/simplify` cleans up code, `/review` reports bugs without fixing them, `/verify` runs checks without repairing anything, and `/deslop` removes AI slop. |
| [Writer](extensions/writer/README.md) | Eight prompts for writing CS conference papers, ported from [claude-writer](https://github.com/minhuw/claude-writer). |
| [Impeccable](extensions/impeccable/README.md) | The Impeccable design skill, with `/impeccable`, `/design`, and 24 `/design-*` prompts for building, refining, and critiquing interfaces. |
| [Subagents](extensions/subagents/README.md) | A vendored copy of `@tintinweb/pi-subagents` v0.22.0, plus a local agent fleet (`recon`, `worker`, `reviewer`, `expert`). |
| [Superagent](extensions/superagent/README.md) | Makes the main session a router: it answers questions and turns each piece of work into a ticket, run by a long-lived Subagents `ticket` agent, in parallel: each in its own git worktree and branch, or, with `/superagent workspace shared`, all directly in your working tree. Ticket reports arrive as messages and start a turn, `#N` talks to a ticket directly, `after` orders tickets, and `/merge N` brings a ready ticket into your branch (or marks a shared ticket done). Requires Subagents. |
| [Herder](extensions/herder/README.md) | `/herder <goal>` runs a coding task in disposable git worktrees, checks the result against the goal, and delivers it to your branch after you confirm. `/herder-improve` and `/herder-simplify` audit the repository and start a run for the findings you pick. |
| [Orca Bridge](extensions/orca-bridge/README.md) | Shows Pi activity in Orca panes, titles panes from your prompts, and opens files and diffs in Orca. |
| [Autoresearch](extensions/autoresearch/README.md) | `/autoresearch <target>` measures a baseline, waits for your approval, then runs a bounded number of optimization passes. |
| [Benchmark](extensions/benchmark/README.md) | `/benchmark <what>` measures a performance claim. Its `benchmark_compare` tool runs one command, or two alternately, and reports medians, ranges, run counts, and a verdict. |
| [Loop](extensions/loop/README.md) | Repeats a prompt on a fixed interval, a cron schedule, or a delay the model picks. |
| [Molt](extensions/molt/README.md) | `/molt` starts a new session with the current model and thinking level. |
| [Statusline Footer](extensions/statusline-footer/README.md) | A footer for model, context, performance, cost, and Git status. |
| [pika](extensions/pika/README.md) | Uploads sessions, model requests, subagent sessions, and Herder journals to a self-hosted [pika server](services/pika/README.md), where you can search and read them. Through the same server, [relay](extensions/pika/README.md#relay) lets Pi sessions on your machines send messages to each other, and [recall](extensions/pika/README.md#recall) lets the agent search and read your past sessions from every machine and project. |
| [Magpie Provider](extensions/magpie-provider/README.md) | Adds the models of a Magpie gateway, with native compaction for OpenAI/Codex Responses models. |

## Install

You need Node 22.19.0 or newer and Pi 1.3.0 or newer. Herder also needs git 2.38 or newer.

```bash
pi install git:github.com/minhuw/pi-extensions

# or from a local checkout
pi install /absolute/path/to/pi-extensions
```

This installs everything listed above and the theme. Some extensions need a few more steps:

- **Subagents:** don't also install `@tintinweb/pi-subagents` from npm in the same Pi profile. Scripted workflows (`SubagentWorkflow`) are off by default; set `workflowsEnabled: true` to turn them on.
- **Autoresearch:** remove `npm:pi-autoresearch` if you have it, because both register `/autoresearch`. Existing `.auto/` data is kept.
- **Impeccable:** the design engine (0.1.18) is downloaded and verified the first time it is needed. Live browser work needs an app it can run. Writer keeps `/polish` for prose; use `/design-polish` for UI.
- **Herder:** run state lives in the git directory (`<git-common-dir>/herder/` and `refs/herder/`), not in the working tree. Approving a goal and confirming delivery need an interactive session (TUI or RPC).
- **Superagent:** off by default. Enable ticket routing for a session with `/superagent on`, or default new interactive sessions inside a git repository to it with `"enabled": true` in `~/.pi/agent/superagent.json`. In superagent mode the main session loses `edit`, `write`, and `bash` and creates tickets instead. Ticket agents run on Subagents (RPC protocol 3, the embedded `ticket` type), so install both. `/superagent off` returns a session to the usual tools for direct work and Herder planning; `PI_SUPERAGENT_DISABLED=1` forces direct mode everywhere. Tickets live in the git directory (`<git-common-dir>/superagent/`).
- **Orca Bridge:** activates only inside Orca panes. Background activity is tracked in Orca's terminal view, not its native chat. `/orca-status` shows what it sees.
- **Magpie Provider:** needs a running Magpie gateway (default `http://127.0.0.1:3425`). `/login magpie` saves its URL and key.
- **pika:** does nothing until `/pika login` connects it to a server. Uploads include file contents and command output, so use only a server you control. Relay needs a pika server 0.3.0 or newer. Recall needs a pika server with the agent read API. Every device may read by default; turn off "Agents can read" on the server's Devices page, or run `pika token read-access <device> off`, to stop one.

The CLIProxyAPI provider and native-compaction extensions are no longer included. If your Pi settings point to their old paths, remove those entries. Saved credentials and old config files are not touched.

## Themes

| Theme | Description |
| --- | --- |
| `material-bloom` | Material You light palette: cream surfaces, rose primary, teal secondary, lilac tertiary. |

Select it with `/settings` or set `"theme": "material-bloom"` in `~/.pi/agent/settings.json`. It works best on a light terminal background.

## Development

```bash
npm ci
npm test           # offline tests for every extension
npm run typecheck
```

Development dependencies target Pi SDK 1.5.0. The extensions still support Pi 1.3.0. [AGENTS.md](AGENTS.md) lists the test command for each extension.

To work on an extension, install your local checkout as shown above and edit it in place. Pi loads the TypeScript directly; run `/reload` to pick up changes.

Impeccable has opt-in checks that download its engine and Chromium: `npm run test:impeccable:engine`, `npm run test:impeccable:visual-foundations`, and `npm run test:impeccable:e2e`. They make no paid model calls. See [checks and evidence](extensions/impeccable/README.md#checks-and-evidence).

The pika server (Rust) and its web UI have their own toolchains, and `npm test` doesn't cover them. See [Development](services/pika/README.md#development) in the pika server README.

## License

[MIT](LICENSE) for this collection's own code. The vendored Impeccable skill keeps its [Apache-2.0 license](extensions/impeccable/LICENSE) and [notice](extensions/impeccable/NOTICE.md); its changes are listed in [LOCAL-PATCHES.md](extensions/impeccable/LOCAL-PATCHES.md).
