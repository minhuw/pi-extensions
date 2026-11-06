# Pi Activity for Orca

An optional Orca companion to [orca-bridge](../README.md). It adds a native **Pi Activity** sidebar panel and status item showing local Pi terminal sessions, main-agent state, Subagents/Herder activity, elapsed times, and workflow progress. Clicking the status item shows a text summary. The panel uses Orca's own components and follows its theme.

## Setup

Requirements: Pi with this version of `orca-bridge` loaded, and Orca ≥1.4.248. The public schema shipped in v1.4.247 marks hooks and status-bar contributions as requiring 1.4.248; the manifest honors that declaration. Native verification was run on Orca 1.4.251. The bridge's original terminal integration remains independently compatible with the pinned v1.4.230 and v1.4.247 managed reporters.

From this repository's root:

```sh
orca plugin inspect ./extensions/orca-bridge/plugin --json
orca plugin dev load ./extensions/orca-bridge/plugin --json
```

This loads a development folder. Orca then reports `approval_required` and the exact command to rerun with its content fingerprint. Review that access and use the command Orca prints, or approve the folder in **Settings → Plugins → Development folders**. This is a `trusted-worker` plugin: its worker has the current user's Node.js filesystem access, even though it requests no additional Orca capabilities. Pi does not install or approve it automatically.

After approval:

```sh
orca plugin open local.pi-activity --panel activity
```

Open or reload Pi in an Orca terminal with the updated extension. Existing sessions with this bridge already loaded connect without starting another agent turn. Run `/orca-status` in Pi to check `Companion: connected`; new sessions normally appear within about seven seconds. Orca watches the development folder, so approved code edits take effect automatically. No build step is required.

To remove the development plugin:

```sh
orca plugin dev unload ./extensions/orca-bridge/plugin
```

On Linux, use the Orca-provided `orca-ide` launcher if the installation uses that name.

## Scope and state

- The panel includes this user's local Pi terminal sessions across workspaces, rather than following Orca's focused workspace. The session picker changes the panel selection only.
- A session is **Waiting** while Pi has a prompt open or a reported workflow is paused; otherwise it is **Working** while the main agent or background activity is running. An idle main agent can have active background work.
- Subagents publishes one row per top-level agent or workflow; Herder publishes one per active step. Other extensions can publish the [activity protocol](../README.md#activity-protocol). This is a view of reported operations, not a census of every nested agent or Orca's external managed roster. Overflow sentinels count as one operation.
- Elapsed time is wall-clock time since the reported start (or first observation when absent), including time spent paused. Completed operations disappear. The plugin is not a history or transcript viewer.
- After 20 seconds without a heartbeat, a session becomes **Disconnected**. Its last report remains visible for up to five minutes but contributes nothing to active counts. Clean Pi shutdown removes its snapshot immediately.
- RPC/native chat, remote SSH sessions, and WSL sessions on a different filesystem are outside this transport. The plugin does not modify Pi's idle state, native-chat state, prompts, tool calls, or agent commands. The launch hook adds only `PI_ORCA_TERMINAL_ID` and `PI_ORCA_WORKSPACE_ID` for correlation; restored terminals can connect through their existing pane key.

## Local metadata transport

The worker and Pi exchange versioned JSON files in `~/.cache/pi-orca-bridge/v1`. The worker creates the directory and refreshes its presence marker; Pi writes only while a marker is fresh. With no plugin, Pi neither creates the directory nor writes session metadata. No listening port or extra HTTP endpoint is introduced.

Snapshots contain session/pane IDs, title, cwd, model, timestamps, state, and activity labels/progress. Labels can include agent task descriptions, so treat these files as local task metadata. They contain no raw prompt, transcript, tool arguments, tool results, or authentication token. On POSIX, the directory must be user-owned mode `0700` and files mode `0600`; shared directories and file symlinks are refused. Files are opened nonblocking and validated as regular files so FIFOs cannot stall polling. On Windows, access control follows the user's directory ACLs.

Publication is coalesced over 100 ms and heartbeats occur every five seconds. The worker scans every two seconds, posts small invalidation events to open panels, and updates the status item only when its summary changes. An open panel revalidates after 15 seconds without a successful response, covering worker restarts. Shutdown clears timers and removes only that instance's file; stale files are pruned after five minutes.

Each snapshot is at most 24 KiB and includes up to 32 activity details, prioritizing waiting operations. The full accepted operation count is retained, and the panel states when details are omitted. The worker reads at most 512 matching directory entries and returns at most 32 sessions, with waiting/working sessions first among the scanned entries. A truncation notice marks either limit. Malformed, unsupported-version, future-dated, and oversized snapshots are ignored. Reload instances sharing a pane are deduplicated by newest heartbeat.

Configuration is deliberately small:

| Variable | Where | Meaning |
| --- | --- | --- |
| `PI_ORCA_COMPANION=off` | Pi | Disable snapshot publication; existing terminal hooks/navigation still work. |
| `PI_ORCA_COMPANION_DIR` | Both Pi and Orca's worker environment | Optional absolute private directory. Both processes must use the same path. Set it before launching the apps, not just in a child terminal. |

If `/orca-status` stays at `waiting for plugin`, check that the plugin is approved and enabled, both processes use the same local account/path, and the directory is private. `local snapshot unavailable` indicates a filesystem or permissions problem. If the panel reports unavailable, check the plugin's state and retry. `orca plugin logs local.pi-activity` provides static runtime diagnostics without printing snapshot contents.

## Verification

The regular collection suite has no Orca dependency:

```sh
npm run test:orca-bridge
npm run typecheck
```

The plugin's separate tests execute the actual Orca components runtime with mocked host responses. Run these only on code you trust: Orca's local test/check commands are unsandboxed. Use a temporary transport directory so test workers cannot announce themselves to ordinary Pi sessions:

```sh
orca_test_dir="$(mktemp -d)"
trap 'rm -rf "$orca_test_dir"' EXIT
orca plugin validate ./extensions/orca-bridge/plugin --json
PI_ORCA_COMPANION_DIR="$orca_test_dir" orca plugin test ./extensions/orca-bridge/plugin --json
PI_ORCA_COMPANION_DIR="$orca_test_dir" orca plugin check ./extensions/orca-bridge/plugin --json
```

The tests cover empty state, background work after parent settlement, workflow waiting/progress, disconnection, session selection, and request retry. `src/panel.check.ts` supplies `empty`, `working`, `waiting`, `disconnected`, `unavailable`, and `long-labels` scenarios. With Orca's window hidden or minimized, capture a scenario without loading the plugin into the live app:

```sh
PI_ORCA_COMPANION_DIR="$orca_test_dir" orca plugin shot ./extensions/orca-bridge/plugin \
  --scenario long-labels --theme dark --width 280 --out /tmp/pi-activity.png --json
```

Scenario shots render synthetic data separately from the live panel. They verify the actual renderer and theme/layout; they do not prove a live installed worker-to-Pi connection. Bridge tests separately exercise the actual filesystem transport and bridge lifecycle with an in-process host double.

## Upstream types

`types/` contains unmodified public typings from `stablyai/orca` v1.4.247, commit `97b9bb3613a333450a38057d745628323f3ad185`. [`types/upstream.json`](types/upstream.json) records source paths and SHA-256 hashes, checked in the offline suite; [`types/LICENSE`](types/LICENSE) preserves the upstream license. Update these together from an explicit release rather than editing the declarations. The plugin's own code is covered by this repository's MIT license.
