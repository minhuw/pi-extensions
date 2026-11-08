# Pika Relay for Codex

A Codex plugin that puts Codex desktop threads on [pika relay](../../extensions/pika/README.md#relay), so they can exchange messages with Pi sessions and with each other. A Pi session can ask a Codex thread to make an image with gpt-image or build slides, and get the result back as a relay message.

The plugin speaks the same relay protocol as Pi ([`services/pika/docs/RELAY.md`](../../services/pika/docs/RELAY.md)) and needs no server changes.

## Install

1. Log in to pika from Pi first (`/pika login`). The plugin reads Pi's `pika.json`; see [Credentials](#credentials).
2. Add this repository as a Codex marketplace:

   ```bash
   codex plugin marketplace add /absolute/path/to/pi-extensions
   ```

   The desktop app bundles the CLI at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` when `codex` is not on your `PATH`.

3. In the ChatGPT desktop app, open the **Plugins** directory, find **Pika Relay** under the `pi-extensions` marketplace, and install it.
4. Open **Settings > Hooks** and trust the plugin's hooks. Codex runs no plugin hook before you review it, and asks again after an update changes a hook.
5. Restart the desktop app so running threads load the MCP server and hooks.

Codex installs a copy of the plugin directory into its cache, keyed by the `version` in `.codex-plugin/plugin.json`; after pulling a new version, update or reinstall the plugin from the Plugins directory. The plugin runs from the committed `dist/` with plain `node` 22 or newer and has no npm dependencies.

## What it adds

- **Tools** (MCP server `pika_relay`): `relay_list`, `relay_send`, `relay_status`, and `relay_room` take the same parameters and give the same results as Pi's [relay tools](../../extensions/pika/README.md#tools). `relay_wait { timeoutSeconds? }` waits for messages (default 600 s, at most 3300 s; `0` only checks).
- **Hooks**, which deliver incoming messages:
  - `SessionStart` puts the thread on the relay and tells the model its relay name and id.
  - `UserPromptSubmit` marks the thread busy and adds messages that arrived while it was idle to the prompt's context.
  - `PostToolUse` adds messages that arrived during the turn, after the next tool call (like Pi's steering).
  - `Stop` continues the turn with waiting messages as a new prompt (like Pi's follow-ups), or marks the thread idle.
  - `SessionEnd` takes the thread offline.
- **Skill** `pika-relay`: how to treat messages from other agents, how to stand by, and how to address sessions and chatrooms.

A thread's relay session id is its Codex thread id, and its name is `codex-<first 8 characters of the id>`. Its title is its first prompt (at most 80 characters), else its working directory's folder name; its project is the git repository's name, as in Pi.

## Delegating to Pi

To have a running Pi session do work for you (a `council`, subagents, a Herder run), ask in the Codex thread, for example:

> Ask the pi session in project pi-extensions to run a council on whether the relay broker should be per-thread, and wait for its answer.

Codex finds the session with `relay_list`, sends a self-contained request, and calls `relay_wait` until the reply arrives; Pi starts a turn for the message even when idle. If you keep working instead, the reply is kept and arrives with your next prompt in that thread.

## Standing by

Codex cannot start a turn on an idle thread: no hook or external process can wake it. An idle thread gets its messages with your next prompt. To have a thread handle requests from Pi on its own, ask it to stand by:

> Stand by on pika relay and handle requests from Pi agents.

The model then calls `relay_wait` in a loop, handles each request, and answers with `relay_send`. While it waits, the thread shows as running in the desktop app and as idle on the relay. Interrupt it to stop standing by.

## Credentials

The plugin uses the device token Pi saved in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pika.json`, so Codex threads appear on the relay as sessions of the same device. `PIKA_URL`, `PIKA_TOKEN`, and `PIKA_DISABLED=1` work as in Pi (set them in the environment the desktop app starts with), and so does the `exclude` list: a thread whose working directory it covers stays offline. The plugin never pairs a device; pairing again would replace Pi's token and disconnect Pi.

## How it works

Codex starts one MCP server per loaded thread and a new process for every hook, so neither can hold a relay connection. Both talk to a per-user **broker** on a Unix socket; the first one that needs it starts it in the background.

- The broker keeps one relay connection per online thread, writes received messages to the thread's inbox file, and then acknowledges them, so a message is never lost between the server and a hook.
- A thread goes online at its first hook or tool call, and offline at `SessionEnd`, when the MCP server that served it closes (or 2 minutes after its last hook, if one ran more recently), or after 24 hours without activity.
- The broker exits after 10 minutes without online threads or connected clients.
- Hop counts follow Pi: a prompt you type resets them; a turn continued for relay messages, or handling messages from `relay_wait`, continues from their count.

State lives in `${CODEX_HOME:-~/.codex}/pika-relay/` (override with `PIKA_RELAY_CODEX_DIR`):

| Path | Contents |
| --- | --- |
| `broker.sock`, `broker.pid` | The running broker's socket and process id. |
| `broker.log` | The broker's log: threads going online and offline, connection problems. Truncated when it passes 1 MB at a broker start. |
| `inbox/<thread>.jsonl` | Messages and delivery notices waiting for a thread. They survive a broker restart. |
| `pending/<thread>` | Exists while the thread's inbox is not empty, so `PostToolUse` skips the broker otherwise. |

## Limits

- An idle thread is reached only through `relay_wait`, or with your next prompt.
- A message that arrives during a turn reaches the model after the next tool call or when the turn would end, never in the middle of a model response.
- `relay_status` covers messages sent since the broker started.
- Each hook gives the broker 1.5 s; when it does not answer in time, the hook does nothing and the messages wait for the next hook.
- Hook behavior was built against the Codex hooks documentation and a ChatGPT desktop build from late 2026; Codex may change it.

## Troubleshooting

- **Thread not in `relay_list` from Pi:** check that pika is logged in (`/pika` in Pi), that the plugin's hooks are trusted in **Settings > Hooks**, and the thread's lines in `broker.log`.
- **Tools say Codex did not name the thread:** the Codex build does not send `_meta.threadId` with tool calls; update the desktop app.
- **Restart the broker:** `kill $(cat ~/.codex/pika-relay/broker.pid)`; the next hook or tool call starts a new one, and threads come back online at their next hook or tool call.

## Development

Sources are in `src/`; `scripts/build.mjs` transpiles them and the shared Pi relay modules (`extensions/pika/{config,repository}.ts`, `extensions/pika/relay/{protocol,connection}.ts`) into `dist/` with TypeScript's `transpileModule`. Rebuild and commit `dist/` after changing either:

```bash
npm run build:codex-relay
npm run typecheck
npm run test:codex-relay
```

The tests run the built `dist/` against the in-memory relay server of the Pi relay tests, and fail when `dist/` is stale.
