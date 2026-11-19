# Agent Desktop

Native desktop GUI automation (computer use) on macOS, Linux, and Windows for Pi sessions through [`agent-desktop`](https://github.com/vercel-labs/agent-desktop): a portable `agent-desktop` skill (`skills/agent-desktop/SKILL.md`), the model-callable `agent_desktop` tool with per-session snapshot isolation, `headed` gating, `stdin` piping, and inline screenshot capture, and the `/agent-desktop` command.

The collection loads this extension and skill automatically; use `/reload` after installing or updating it.

```text
/agent-desktop                                    show default session namespace and active tracked sessions
/agent-desktop status                             show default session namespace and active tracked sessions
/agent-desktop close                              end tracked sessions (`agent-desktop --session <id> session end`) and clear status
/agent-desktop permissions [--guide | --request]  check or guide OS Accessibility / Screen Recording grants
/agent-desktop doctor                             run `agent-desktop status` and display adapter health, permissions, and supported surfaces
```

## Bundled binary and permissions

Native `agent-desktop` (`1.3.1`) binaries and platform helpers for macOS, Linux, and Windows (`x64` and `arm64`) ship inside the collection's `agent-desktop` dependency (`node_modules/agent-desktop/bin/`) and are resolved automatically—no separate global CLI or Python install is needed.

Set `AGENT_DESKTOP_BIN` to an absolute binary path to override the bundled binary (or supply a test double).

- **macOS:** grant Accessibility (and Screen Recording for `screenshot`) to the terminal running Pi, or run `/agent-desktop permissions --guide`.
- **Linux:** run inside a graphical desktop session with an active AT-SPI2 bus.

## Bundled `agent-desktop` skill

Pi discovers `extensions/agent-desktop/skills/agent-desktop/SKILL.md` through `package.json` `pi.skills`. When a task genuinely requires native desktop GUI inspection or interaction (rather than filesystem tools, dedicated CLIs, HTTP, or `agent_browser`), the skill instructs the agent to:

1. Check adapter health (`agent_desktop({ argv: ["status"] })`) and load the CLI's version-matched workflow and platform guides via `agent_desktop({ argv: ["skills", "get", "desktop"] })` and `agent_desktop({ argv: ["skills", "get", "platform"] })` (or `agent-desktop skills get desktop` / `agent-desktop skills get platform`, plus on-demand references `commands-observation`, `commands-interaction`, `commands-system`, and `workflows`).
2. Follow the **observe → act → verify** loop:
   - `list-apps` / `list-windows` — discover running desktop applications and windows
   - `snapshot --app <App> -i --compact` — inspect interactive accessibility-tree elements (`--skeleton`, `--root @<snap>:eN`, or `--max-depth` for dense or Electron/Chromium apps; `find` when target role and name are known)
   - `click @<snap>:eN` / `type @<snap>:eN --stdin` — interact through snapshot-qualified refs (re-running `snapshot` on `STALE_REF`, using `--wait-for` or `wait` instead of sleeps)
   - `get` / `is` / `snapshot` / `screenshot` — verify state and inspect captured PNGs inline as image blocks
3. Keep actions headless by default and opt into `headed: true` only when physical cursor/keyboard delivery or foreground focus is explicitly needed.

## The `agent_desktop` tool

The `agent_desktop` tool runs `agent-desktop` directly (`shell: false`) with bounded output (`2000` lines / `50 KiB`) and wall-clock timeouts:

```ts
agent_desktop({
  argv: ["type", "@s8f3k2p9:e9", "--stdin"],
  stdin: "text to type",
  headed: false,
  session: "optional-custom-session",
  cwd: "optional/subdir",
  timeoutMs: 120000
})
```

| Parameter | Accepts |
| --- | --- |
| `argv` | Non-empty string array of CLI arguments (`["status"]`, `["snapshot", "--app", "Notes", "-i", "--compact"]`, `["click", "@s8f3k2p9:e8"]`, `["screenshot", "--app", "Notes"]`, etc.). Never pass `--headed` inside `argv`. |
| `headed` | Optional boolean (default `false`). Appends `--headed` when `true` for actions requiring physical cursor/keyboard delivery (`double-click`, `hover`, `drag`, `mouse-*`) or foreground focus. |
| `stdin` | Optional string piped to the child process's standard input (pair with `--stdin` on `type`, `set-value`, or `clipboard-set`). |
| `session` | Optional session namespace override. Defaults to a deterministic Pi-session-scoped ID (`pi-<sessionId>`), passed via `AGENT_DESKTOP_SESSION`. |
| `cwd` | Optional working directory (resolved relative to the Pi session's `cwd`). |
| `timeoutMs` | Optional wall-clock timeout in milliseconds (`1000`–`600000`, default `120000`). |

A call settles at most `100` ms after the `agent-desktop` process exits or is terminated on timeout or abort. It does not wait for a descendant process that still holds stdout or stderr open.

### Headless default and `headed: true` gate

Actions execute through headless semantic OS accessibility calls by default (no cursor movement, no focus stealing). Passing `--headed` inside `argv` is rejected so physical input delivery and foreground focus are gated explicitly through `headed: true`.

### `--stdin` piping

When `stdin` is supplied, `agent_desktop` writes the string directly to the spawned process's standard input and closes the stream. Pairing `stdin` with `--stdin` on `type`, `set-value`, or `clipboard-set` keeps multiline or sensitive text out of process arguments.

### Inline screenshots

When `agent_desktop` runs a `screenshot` command (`argv: ["screenshot", "--app", "Notes"]` or `argv: ["screenshot", "path/to/shot.png", "--app", "Notes"]`) that exits `0`:

- If no output file path is passed in `argv`, the extension creates a temporary `.png` path, appends it to the spawned `argv`, reads the image bytes, and deletes the temporary directory in `finally`.
- If an explicit file path is passed in `argv`, the extension keeps the file on disk and reads it from `cwd`.
- In both cases, the tool returns an inline `{ type: "image", data, mimeType }` content block alongside the text output so multimodal models can inspect the rendered window or screen immediately.

## Session isolation, UI status, and lifecycle cleanup

- **Deterministic session IDs:** Unless `session` or `--session` is explicitly provided, `AGENT_DESKTOP_SESSION` defaults to `pi-<sessionId>` (derived from `ctx.sessionManager.getSessionId()`). Concurrent Pi sessions keep separate snapshot namespaces without colliding.
- **Status bar:** While one or more desktop sessions are active in a Pi session, the extension publishes `ctx.ui.setStatus("agent-desktop", "desktop: <session>")` (or `desktop: <first> (+N)`).
- **Automatic cleanup:** Ending a session (`session end` via `agent_desktop` or `/agent-desktop close`), switching sessions (`session_before_switch`), or shutting down the session (`session_shutdown`) invokes `agent-desktop --session <id> session end` for each tracked session and clears the `agent-desktop` status entry.
- **Child-session propagation:** While active, the extension registers itself in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` so delegated child sessions also receive `agent_desktop`.

## Development

```bash
npm run test:agent-desktop
npm run typecheck
```

The offline Vitest suite tests skill discovery via `DefaultResourceLoader`, direct `argv` execution against an executable fake `agent-desktop` binary, `AGENT_DESKTOP_SESSION` isolation, `--headed` rejection and `headed: true` gating, `stdin` piping, call settlement while a descendant holds stdout and stderr open, inline screenshot capture and temp-file cleanup, UI status publishing and `session end` cleanup across session switches and shutdowns, child-session hook propagation, and `/agent-desktop` commands.
