# Agent Browser

Browser automation and web testing for Pi sessions through [`agent-browser`](https://github.com/vercel-labs/agent-browser): a portable `agent-browser` skill (`skills/agent-browser/SKILL.md`), the model-callable `agent_browser` tool with per-session daemon isolation and inline screenshot capture, and the `/agent-browser` command.

The collection loads this extension and skill automatically; use `/reload` after installing or updating it.

```text
/agent-browser            show the current Pi session's default browser session ID and active daemons
/agent-browser status     show the current Pi session's default browser session ID and active daemons
/agent-browser close      close all browser daemons owned by this Pi session and clear status
/agent-browser doctor     run `agent-browser doctor` and display the diagnostic result
```

## Prerequisites

Install the `agent-browser` CLI and its Chromium runtime on the host machine:

```bash
npm install -g agent-browser && agent-browser install
```

By default, the extension invokes `agent-browser` from `PATH`. Set `AGENT_BROWSER_BIN` to an absolute binary path to use a custom installation or test double. When the binary is missing (`ENOENT`), `agent_browser` and `/agent-browser doctor` return the exact setup instruction above.

## Bundled `agent-browser` skill

Pi discovers `extensions/agent-browser/skills/agent-browser/SKILL.md` through `package.json` `pi.skills`. When a prompt involves opening a website, testing a web app, clicking or filling UI elements, capturing screenshots, or running exploratory QA, the skill instructs the agent to:

1. Load the CLI's version-matched workflow reference first via `agent_browser({ argv: ["skills", "get", "core"] })` (or `agent-browser skills get core`).
2. Follow the ref-based browser loop:
   - `open <url>` — navigate to the page
   - `snapshot -i` — inspect interactive elements with `@e1`, `@e2` accessibility-tree refs
   - `click @e1` / `fill @e2 "value"` — interact using refs from the latest snapshot (re-running `snapshot -i` after navigation or DOM changes)
   - `screenshot` — capture the viewport inline as an image block
   - `close` — close the session daemon when finished
3. Load specialized CLI skills on demand with `skills list` and `skills get <name>` (`dogfood`, `electron`, `slack`, `derive-client`).

## The `agent_browser` tool

The `agent_browser` tool runs `agent-browser` directly (`shell: false`) with bounded output (`2000` lines / `50 KiB`) and wall-clock timeouts:

```ts
agent_browser({
  argv: ["open", "https://example.com"],
  session: "optional-custom-session",
  cwd: "optional/subdir",
  timeoutMs: 120000
})
```

| Parameter | Accepts |
| --- | --- |
| `argv` | Non-empty string array of CLI arguments (`["open", "https://example.com"]`, `["snapshot", "-i"]`, `["click", "@e1"]`, `["screenshot"]`, `["close"]`, etc.). |
| `session` | Optional browser session name override. Defaults to a deterministic Pi-session-scoped ID (`pi-<sessionId>`), passed via `AGENT_BROWSER_SESSION`. |
| `cwd` | Optional working directory (resolved relative to the Pi session's `cwd`). |
| `timeoutMs` | Optional wall-clock timeout in milliseconds (`1000`–`600000`, default `120000`). |

A call settles at most `100` ms after the `agent-browser` process exits or is terminated on timeout or abort. It does not wait for a descendant, such as the browser daemon, that still holds the process's stdout or stderr open.

### Inline screenshots

When `agent_browser` runs a `screenshot` command (`argv: ["screenshot"]` or `argv: ["screenshot", "path/to/shot.png"]`) that exits `0`:

- If no output file path (and no `--base64` flag) is passed in `argv`, the extension creates a temporary `.png` path, appends it to the spawned `argv`, reads the image bytes, and deletes the temporary directory in `finally`.
- If an explicit file path is passed in `argv`, the extension keeps the file on disk and reads it from `cwd`.
- In both cases, the tool returns an inline `{ type: "image", data, mimeType }` content block alongside the text output so multimodal models can inspect the rendered page immediately.

### Impeccable integration

`impeccable_capabilities` inspects registered tools and recognizes `agent_browser` as an active browser candidate (`report.browser.state === "candidate"`).

## Session isolation, UI status, and lifecycle cleanup

- **Deterministic session IDs:** Unless `session` or `--session` / `-s` is explicitly provided, `AGENT_BROWSER_SESSION` defaults to `pi-<sessionId>` (derived from `ctx.sessionManager.getSessionId()`). Concurrent Pi sessions control separate browser daemons without colliding.
- **Status bar:** While one or more browser sessions are active in a Pi session, the extension publishes `ctx.ui.setStatus("agent-browser", "browser: <session>")` (or `browser: <first> (+N)`).
- **Automatic cleanup:** Running `close` (via `agent_browser` or `/agent-browser close`), switching sessions (`session_before_switch`), or shutting down the session (`session_shutdown`) invokes `agent-browser --session <session> close` for each tracked browser session and clears the `agent-browser` status entry.
- **Child-session propagation:** While active, the extension registers itself in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` so delegated child sessions also receive `agent_browser`.

## Development

```bash
npm run test:agent-browser
npm run typecheck
```

The offline Vitest suite tests skill discovery via `DefaultResourceLoader`, direct `argv` execution against an executable fake `agent-browser` binary, session isolation, call settlement while a descendant holds stdout and stderr open, inline screenshot capture and temp-file cleanup, `impeccable_capabilities` detection, UI status publishing and daemon cleanup across session switches and shutdowns, child-session hook propagation, and `/agent-browser` commands.
