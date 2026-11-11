# Pi extensions

Extensions, prompts, skills, and a theme for the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

## Documentation

The [pika server](services/pika/README.md) serves this documentation publicly at `/docs` under its configured base path. The site uses the same Markdown files as this repository:

- [Installation](docs/installation.md), [Configuration](docs/configuration.md), and [Development](docs/development.md).
- Guides to [performance work](docs/guides/performance.md), [delegation](docs/guides/delegation.md), and [code review and cleanup](docs/guides/code-review.md).
- The extension READMEs linked below remain the reference for commands, defaults, and behavior.

## Extensions

| Extension | What it does |
| --- | --- |
| [Commit](extensions/commit/README.md) | `/commit` commits your current changes as a series of self-contained patches. |
| [Continue Session](extensions/continue-session/README.md) | `/continue-session <session ID> [instructions]` reads a pika-recorded session and continues its work here. |
| [Recap](extensions/recap/README.md) | `/recap` summarizes the current session's goal, recent progress, and where to pick up after a break. |
| [Quality](extensions/quality/README.md) | `/simplify` cleans up code, `/review` reports bugs without fixing them, `/verify` runs checks without repairing anything, and `/deslop` removes AI slop. |
| [Writer](extensions/writer/README.md) | Eight prompts for writing CS conference papers, ported from [claude-writer](https://github.com/minhuw/claude-writer). |
| [Impeccable](extensions/impeccable/README.md) | The Impeccable design skill, with `/impeccable`, `/design`, and 24 `/design-*` prompts for building, refining, and critiquing interfaces. |
| [Agent Browser](extensions/agent-browser/README.md) | Browser automation and web testing through `agent-browser`, with the `agent-browser` skill, the `agent_browser` tool (isolated per-session daemons and inline screenshots), and `/agent-browser`. |
| [Subagents](extensions/subagents/README.md) | Delegates bounded tasks to a local agent fleet (`recon`, `worker`), using a maintained fork of `@tintinweb/pi-subagents` v0.23.1. |
| [Council](extensions/council/README.md) | `/council <topic>` and the `council` tool convene three pinned read-only advisors (`carbon`, `astra`, `fable`) for a two-round, identity-blinded deliberation on difficult architectural and design questions. |
| [Herder](extensions/herder/README.md) | `/herder <goal>` runs a coding task in disposable git worktrees, checks the result against the goal, and delivers it to your branch after you confirm. `/herder-improve` and `/herder-simplify` audit the repository and start a run for the findings you pick. |
| [Orca Bridge](extensions/orca-bridge/README.md) | Shows Pi activity in Orca panes, opens files and diffs, and offers an optional native activity panel and status bar. |
| [Autoresearch](extensions/autoresearch/README.md) | `/autoresearch <target>` measures a baseline, waits for your approval, then runs a bounded number of optimization passes. |
| [Benchmark](extensions/benchmark/README.md) | `/benchmark <what>` measures a performance claim. Its `benchmark_compare` tool runs one command, or two alternately, and reports medians, ranges, run counts, and a verdict. |
| [Loop](extensions/loop/README.md) | Repeats a prompt on a fixed interval, a cron schedule, or a delay the model picks. |
| [Molt](extensions/molt/README.md) | `/molt` starts a new session with the current model and thinking level; `/handoff [task]` has the model write a handover and continues in a new session that starts from it. |
| [Language](extensions/language/README.md) | `/language` sets the language the model responds in, with a default for new sessions and switches that leave the cached prompt alone. |
| [Soul](extensions/soul/README.md) | Injects core development principles by default into sessions and delegated subagents, with `/soul` switches that leave the cached prompt alone. |
| [Spokesman](extensions/spokesman/README.md) | `/spokesman` rewrites dense or cryptic model replies with a secondary communicator model, folding the original response and showing the rewrite below a model separator. |
| [Boom](extensions/boom/README.md) | `/boom` turns on boom mode 💥 for the session: the model fans work out to parallel subagents, background agents included, to develop faster, without disturbing the cached prompt. |
| [Always-on](extensions/alwayson/README.md) | `/alwayson` turns on always-on mode 📡 for the session: the model runs long tasks in background subagents and ends its turns, so it keeps answering you and relay messages, without disturbing the cached prompt. |
| [Selfdrive](extensions/selfdrive/README.md) | `/selfdrive` turns on self-driving mode 🚗 while you are away: the session keeps working on its own on things you would likely want, through background subagents and Herder runs it may approve, and leaves the results as proposals for you to accept or discard when you return. |
| [Workspace](extensions/workspace/README.md) | Keeps file writes inside the current project, manages isolated side workspaces under `.pi/workspaces/<name>`, prompts before writes outside the project, and cleans up unused workspaces with `/workspace gc`. |
| [AGENTS.md](extensions/agents-md/README.md) | Shows you every agent edit to an AGENTS.md or CLAUDE.md file for review before it is applied. The `agents_md_lint` tool reports dead paths, scripts, and links, duplicate lines, and oversized files, and `/agents-md [focus]` audits the files against the code and moves standing rules from project memory into them. |
| [Statusline Footer](extensions/statusline-footer/README.md) | A footer for model, context, performance, cost, and Git status. |
| [pika](extensions/pika/README.md) | Uploads sessions, model requests, subagent sessions, and Herder journals to a self-hosted [pika server](services/pika/README.md), where you can search and read them. Through the same server, [relay](extensions/pika/README.md#relay) lets Pi sessions on your machines send messages to each other, and [recall](extensions/pika/README.md#recall) lets the agent search and read your past sessions from every machine and project. |
| [Magpie Provider](extensions/magpie-provider/README.md) | Adds the models of a Magpie gateway, with native compaction for OpenAI/Codex Responses models. |

### Codex plugin

| Plugin | What it does |
| --- | --- |
| [Pika Relay for Codex](plugins/pika-relay/README.md) | Puts Codex desktop threads on pika relay, so Pi sessions and Codex threads can message each other; `relay_wait` lets a Codex thread stand by for requests from Pi. Install it from this repository's Codex marketplace (`codex plugin marketplace add /path/to/pi-extensions`). |

## Install

You need Node 22.19.0 or newer and Pi 1.3.0 or newer. Herder also needs git 2.38 or newer.

```bash
pi install git:github.com/minhuw/pi-extensions

# or from a local checkout
pi install /absolute/path/to/pi-extensions
```

This installs all the extensions above, their prompts and skills, and the theme. Check these setup requirements before using them:

- **Subagents:** don't also install `@tintinweb/pi-subagents` from npm in the same Pi profile. Scripted workflows (`SubagentWorkflow`) are off by default; set `workflowsEnabled: true` to turn them on.
- **Autoresearch:** remove `npm:pi-autoresearch` if you have it, because both register `/autoresearch`. Existing `.auto/` data is kept.
- **Impeccable:** the design engine (0.1.19) is downloaded and verified the first time it is needed. Live browser work needs an app it can run. Writer keeps `/polish` for prose; use `/design-polish` for UI.
- **Agent Browser:** needs the `agent-browser` CLI and its Chromium runtime on `PATH` (or `AGENT_BROWSER_BIN`): `npm install -g agent-browser && agent-browser install`.
- **Herder:** run state lives in the git directory (`<git-common-dir>/herder/` and `refs/herder/`), not in the working tree. Approving a goal and confirming delivery need an interactive session (TUI or RPC).
- **Orca Bridge:** activates only inside Orca panes. The optional [Pi Activity plugin](extensions/orca-bridge/plugin/README.md) shows local terminal sessions, agents, and workflow progress in Orca's sidebar and status bar. Native-chat background tracking is unavailable. `/orca-status` shows bridge and companion readiness.
- **Magpie Provider:** needs a running Magpie gateway (default `http://127.0.0.1:3425`). `/login magpie` saves its URL and key.
- **pika:** stays inactive until a server URL and token are configured, normally through `/pika login`. Uploads include file contents and command output, so use only a server you control. Relay needs a pika server 0.3.0 or newer. Recall needs a pika server with the agent read API. Every device may read by default; turn off "Agents can read" on the server's Devices page, or run `pika token read-access <device> off`, to revoke a device’s read access.

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

Development dependencies target Pi SDK 1.5.0. Runtime compatibility starts at Pi 1.3.0. [AGENTS.md](AGENTS.md) lists the test command for each extension.

To work on an extension, install your local checkout as shown above and edit it in place. Pi loads the TypeScript directly; run `/reload` to pick up changes.

Impeccable has opt-in checks that download its engine and Chromium: `npm run test:impeccable:engine`, `npm run test:impeccable:visual-foundations`, and `npm run test:impeccable:e2e`. They make no paid model calls. See [checks and evidence](extensions/impeccable/README.md#checks-and-evidence).

The pika server (Rust) and its web UI have their own toolchains, and `npm test` doesn't cover them. See [Development](services/pika/README.md#development) in the pika server README.

## License

[MIT](LICENSE) for this collection's own code. The vendored Impeccable skill keeps its [Apache-2.0 license](extensions/impeccable/LICENSE) and [notice](extensions/impeccable/NOTICE.md); its changes are listed in [LOCAL-PATCHES.md](extensions/impeccable/LOCAL-PATCHES.md).
