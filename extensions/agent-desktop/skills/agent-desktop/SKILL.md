---
name: agent-desktop
description: Native desktop GUI automation (computer use) on macOS, Linux, and Windows through OS accessibility trees using agent-desktop (headless semantic @snapshot:eN refs, clicks, typing, window control, and inline screenshots). Use when the user asks to inspect or operate a native desktop app, click UI controls, fill desktop forms, read dialogs/menus, manage windows, or capture desktop screenshots.
---

# Desktop GUI Automation with `agent-desktop`

Drive native macOS, Linux, and Windows desktop applications through OS accessibility trees using snapshot-qualified element refs (`@<snapshot_id>:e<N>`) and headless semantic actions.

## When to Use & Tool Preference

1. **Prefer programmatic paths first:** Use filesystem tools, git, HTTP clients, dedicated CLIs, or `agent_browser` (for web apps) whenever they can complete the task directly. Use `agent_desktop` when a task genuinely requires inspecting or operating a desktop GUI.
2. **Prefer the `agent_desktop` tool** (`argv: [...]`, optional `headed`, `stdin`, `session`, `cwd`, `timeoutMs`) when available in the current Pi session:
   - Executes `agent-desktop` directly without a shell (`shell: false`).
   - Isolates snapshot and ref namespaces per Pi session via `AGENT_DESKTOP_SESSION` (`pi-<sessionId>`).
   - Pipes text via `stdin` when provided, keeping multiline or sensitive strings out of process arguments.
   - Reads `screenshot` captures and returns them inline as PNG image content blocks.
   - Ends tracked sessions automatically on session switch or shutdown.
   - Fall back to running `agent-desktop` via `bash` only if the `agent_desktop` tool is unavailable.

## First Step — Load Version-Matched CLI Guides

1. **Check adapter health and OS permissions:**
   ```json
   { "argv": ["status"] }
   ```
2. **Load the compiled guides matching the installed `agent-desktop` binary before acting:**
   ```json
   { "argv": ["skills", "get", "desktop"] }
   ```
   ```json
   { "argv": ["skills", "get", "platform"] }
   ```
   Or via CLI: `agent-desktop skills get desktop` and `agent-desktop skills get platform`.
   Load narrower reference sections on demand when needed:
   - `{ "argv": ["skills", "get", "desktop", "commands-observation"] }`
   - `{ "argv": ["skills", "get", "desktop", "commands-interaction"] }`
   - `{ "argv": ["skills", "get", "desktop", "commands-system"] }`
   - `{ "argv": ["skills", "get", "desktop", "workflows"] }`

## Core Workflow Loop (`observe -> act -> verify`)

1. **Discover apps and windows:**
   ```json
   { "argv": ["list-apps"] }
   ```
   ```json
   { "argv": ["list-windows"] }
   ```
2. **Observe the accessibility tree (`snapshot` / `find`):**
   ```json
   { "argv": ["snapshot", "--app", "Notes", "-i", "--compact"] }
   ```
   - For dense UIs or Electron/Chromium apps (Slack, VS Code), map structure first with `--skeleton`, then drill into a subtree with `--root @<snap>:eN` or bound depth with `--max-depth 3`:
     ```json
     { "argv": ["snapshot", "--skeleton", "--app", "Slack", "-i", "--compact"] }
     ```
   - When the target role and label are already known, query directly with `find`:
     ```json
     { "argv": ["find", "--app", "Calculator", "--role", "button", "--name", "7", "--exact", "--first"] }
     ```
3. **Act on snapshot-qualified refs (`@<snapshot_id>:e<N>`):**
   Refs include the snapshot ID (e.g. `@s8f3k2p9:e8`); bare `@e8` is rejected. Re-run `snapshot` after UI changes if `STALE_REF` is returned.
   ```json
   { "argv": ["click", "@s8f3k2p9:e8"] }
   ```
   Pipe text via `stdin` with `--stdin` (also supported by `set-value` and `clipboard-set`):
   ```json
   { "argv": ["type", "@s8f3k2p9:e9", "--stdin"], "stdin": "text to type" }
   ```
   Use post-action state waits (`--wait-for "role:text"` or `wait`) instead of fixed sleeps.
4. **Verify state and capture screenshots:**
   Confirm outcomes with `get`, `is`, or a fresh `snapshot`. Capture visual state inline as a PNG image block:
   ```json
   { "argv": ["screenshot", "--app", "Notes"] }
   ```
   Or save to an explicit path while also receiving the inline image block:
   ```json
   { "argv": ["screenshot", "artifacts/notes.png", "--app", "Notes"] }
   ```

## Headless Default vs `headed: true`

- Actions use headless semantic accessibility calls by default (no physical cursor movement, no focus stealing).
- Never pass `--headed` inside `argv`. Pass `headed: true` on the `agent_desktop` tool call only when physical cursor/keyboard delivery (`double-click`, `hover`, `drag`, `mouse-*`) or foreground focus is explicitly needed.
- Never switch to `headed: true` merely to paper over a semantic error without checking permissions (`status` / `permissions`) and UI state first.

## Permissions

`agent-desktop` ships bundled with the extension—the `agent_desktop` tool invokes the bundled native binary directly with no separate global install needed.

On macOS, run `/agent-desktop permissions --guide` (or `{ "argv": ["permissions", "--guide"] }`) if Accessibility or Screen Recording permission is not yet granted.
