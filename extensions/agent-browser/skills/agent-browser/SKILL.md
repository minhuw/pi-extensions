---
name: agent-browser
description: Browser automation and web testing for AI agents using agent-browser (Chrome/Chromium CDP, accessibility-tree snapshots with @eN element refs, inline screenshots, and isolated sessions). Use when the user wants to open a website, test a web app, inspect UI, click buttons, fill forms, take screenshots, scrape data, or run exploratory QA.
---

# Browser Automation with `agent-browser`

Drive a real headless or headed Chrome/Chromium browser through `agent-browser` using compact accessibility-tree snapshots (`@e1`, `@e2`, …) and deterministic ref-based interactions.

## Tool Preference & First Step

1. **Prefer the `agent_browser` tool** (`argv: [...]`) when available in the current Pi session:
   - It executes `agent-browser` directly without a shell (`shell: false`).
   - It automatically scopes `AGENT_BROWSER_SESSION` to the current Pi session (`pi-<sessionId>`) so concurrent sessions never collide.
   - It automatically closes the session's browser daemon when the Pi session switches or shuts down.
   - When you run `screenshot`, `agent_browser` reads the captured image and returns it inline as an image content block so you can inspect the page visually right away.
   - If the `agent_browser` tool is unavailable, fall back to running `agent-browser` via `bash`.

2. **Load the CLI's version-matched core workflow skill before your first browser action:**
   ```json
   { "argv": ["skills", "get", "core"] }
   ```
   Or via CLI:
   ```bash
   agent-browser skills get core
   ```
   This loads the exact commands, flags, and conventions supported by the installed `agent-browser` binary.

## Core Workflow Loop

Follow the **open → snapshot → interact → screenshot/verify → close** loop:

1. **Navigate (`open`):**
   ```json
   { "argv": ["open", "https://example.com"] }
   ```
2. **Inspect interactive elements (`snapshot -i`):**
   ```json
   { "argv": ["snapshot", "-i"] }
   ```
   Returns a compact accessibility tree assigning element refs like `@e1`, `@e2`, `@e3` to interactive elements.
3. **Interact using `@eN` refs (`click`, `fill`, `select`, `press`, `hover`):**
   ```json
   { "argv": ["click", "@e1"] }
   ```
   ```json
   { "argv": ["fill", "@e2", "search query"] }
   ```
   **Important:** Always run `snapshot -i` again after page navigation, form submission, modal open/close, or dynamic DOM updates because `@eN` refs belong to the latest snapshot.
4. **Capture visual state (`screenshot`):**
   ```json
   { "argv": ["screenshot"] }
   ```
   Or save to a specific file path:
   ```json
   { "argv": ["screenshot", "artifacts/homepage.png"] }
   ```
   When called without a file path through `agent_browser`, a temporary `.png` is captured, attached inline as an image block, and cleaned up automatically.
5. **Close the browser when done (`close`):**
   ```json
   { "argv": ["close"] }
   ```

## Specialized Workflow Skills

`agent-browser` bundles additional specialized workflow guides you can load on demand:

- List available skills:
  ```json
  { "argv": ["skills", "list"] }
  ```
- Fetch a specialized skill:
  - `dogfood` — exploratory QA and bug hunting on a live web application (`argv: ["skills", "get", "dogfood"]`)
  - `electron` — automating Electron desktop apps over CDP (`argv: ["skills", "get", "electron"]`)
  - `slack` — automating Slack workspaces (`argv: ["skills", "get", "slack"]`)
  - `derive-client` — inspecting network traffic to derive typed API clients (`argv: ["skills", "get", "derive-client"]`)

## Prerequisite

If `agent-browser` is not installed on the host machine, install the CLI and its browser runtime with:

```bash
npm install -g agent-browser && agent-browser install
```
