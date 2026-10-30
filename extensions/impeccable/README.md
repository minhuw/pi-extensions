# Impeccable for Pi

[Impeccable](https://github.com/pbakaus/impeccable) provides design workflows for new interfaces, replacement visual identities, refinement, critique, design-system documentation and extraction on web, iOS and Android. This collection vendors the complete `skill-v4.8.0` distribution at commit `414603bf14c7a344edb466bb1f85690c77ce8b7d`, plus the four canonical roles, with managed engine **0.1.18**. Vendored material is [Apache-2.0](LICENSE), with [attribution](NOTICE.md).

The [feature and evidence map](FEATURES.md) covers every command, role and native auxiliary. [LOCAL-PATCHES.md](LOCAL-PATCHES.md) records adaptation history; [upstream.json](upstream.json) records provenance.

## Install and start

Use Node >=22.19.0 and Pi >=1.3.0. Development and real-session tests use SDK 1.4.0.

```bash
pi install git:github.com/minhuw/pi-extensions
# Or install an editable checkout:
pi install /absolute/path/to/pi-extensions
```

Reload an existing Pi session after installation. The collection exposes the `impeccable` skill for normal discovery, `/impeccable`, its `/design` alias, and 24 `/design-<command>` prompts. Arguments use Pi's native prompt expansion. Existing Writer `/polish`, Quality `/review`, `/simplify`, `/verify`, `/deslop` and `/commit` retain their identities.

```text
/impeccable
/impeccable redesign this app with a replacement visual identity; keep its product facts and behavior
/design-shape the onboarding flow
/design-critique src/settings.tsx
/design-polish src/settings.tsx
/design-document
/impeccable doctor
/impeccable hooks status
```

With no arguments, the skill offers a context-aware menu. These are skill/playbook entries; the 24 names are not all native engine verbs. `/design-init` captures product context, whereas native engine `init` has its own CLI meaning. Ask through `/impeccable` or the named design prompt to run a playbook.

Activation only registers tools and lifecycle handlers. It does not download an engine or browser, spawn processes, ask questions, or write project files. Normal `npm ci` and the safe collection tests do not download either runtime.

## Create a new or replacement visual system

State whether you want to preserve, extend or replace the incumbent identity. Missing `DESIGN.md` alone does not make existing UI greenfield. Refinement preserves the incumbent world; replacement keeps product truth, content, function, native affordances and constraints while choosing a new visual authority through [new-work](skills/impeccable/reference/new-work.md).

`PRODUCT.md` owns product truth. If it is missing for new work, the skill runs the [init playbook](skills/impeccable/reference/init.md) first. `DESIGN.md` owns durable visual decisions; a surface brief owns route or artifact strategy, visitor mode and the chosen direction contract. A replacement system is documented from the finished build, including token-bearing `DESIGN.md` and `.impeccable/design.json`. Ordinary extensions preserve the incumbent system unless a durable change is approved.

The workflow confirms the surface's purpose and constraints, explores directions, runs native `concept-seed`, and presents a genuine choice through the native decision page. User-pinned constraints remain binding. Catalog challengers, steering, re-rolls and the conventional standing exit retain their upstream paths. A direction page closing unanswered is not approval: supported Pi TUI/RPC select/input dialogs preserve actual answers, partial answers, dismissal and cancellation; unresolved material choices go to chat and wait. No unattended answer is invented.

The chosen direction goes into a development-only surface brief, never delivered source or hidden DOM. Persuade/Experience surfaces use the configured `buildPath`, defaulting to comp-led when image generation exists. Operate/Read surfaces are code-led. The page toggle can change the current round; the playbook governs when a standing preference is recorded. Shared `.impeccable/config.json` stores `buildPath` as `"comp"` or `"code"`; private `.impeccable/config.local.json` overrides it on one machine. Ask `/impeccable` to change the standing default without replacing unrelated config.

Comp-led work generates and approves compositions before implementation, keeps prompt sidecars, and follows native build-phase, comp-spec and comp-diff gates. Code-led work carries ambition in the selected sketch, first-viewport contract and interaction/motion grammar, with rendered review. With no image capability, code-led is the disclosed path; a required comp is never silently skipped. Comp-led fidelity work needs an appropriately capable model; the skill discloses model limits before directions rather than promising unmet gates. `shape` returns a confirmed brief and stops before persistence or implementation.

Web work inspects rendered responsive sizes and interactions. Native `ios`, `android` and `adaptive` work follows the shipped platform references and simulator/emulator evidence; a web detector skip is inapplicable, never a clean native audit. Finish review and documentation remain part of completion.

## Runtime, configuration and privacy

`impeccable_run` accepts a direct `argv` array, optional `cwd` and `timeoutMs`. It reports success, detector findings (native `detect` exit 2), errors and unavailable prerequisites distinctly. Cancellation/timeouts stop its child; truncated output is not a complete success. Installed resources resolve independently of project cwd.

On the first operation needing it, the runner lazily downloads the official pinned engine, checks its asset checksum/version and caches it under `~/.impeccable`. `IMPECCABLE_HOME` selects a writable cache root; `IMPECCABLE_DOWNLOAD_BASE` overrides the release-download base (default `https://github.com/pbakaus/impeccable/releases/download`). Managed assets cover macOS arm64/x64, Linux arm64/x64 and Windows x64, including upstream's Windows ARM fallback. Unsupported platforms and missing checksums fail explicitly. **`IMPECCABLE_BIN` is a deliberate trusted, unverified executable override**; it bypasses managed verification and is reported as such. Ambient PATH binaries are never automatically selected. No native binaries are committed.

Automatic design checks default **off**. Opt in per project:

```text
/impeccable hooks on
/impeccable hooks status
/impeccable hooks off
/impeccable hooks reset
```

Enablement and machine-local consent use shared `.impeccable/config.json` and private `.impeccable/config.local.json`. Controls preserve unrelated keys and formatting. Local settings receive a narrow Git `info/exclude` entry before writing; tracked local configs, conflicting ignore rules, invalid JSON, ambiguous targets and unsafe paths are refused. An exclusion cannot hide already tracked secrets. Use `--target <existing-app-path>` for workspace selection. Read-only doctor/context preserve native reporting; `doctor --fix` validates scope before native artifact repairs and reports actual results. Reset disables automatic checks and clears hook runtime controls/detector ignores while retaining product and visual settings.

`hooks ignore-rule|ignore-file|ignore-value` and native `ignores` CRUD retain upstream validation; see [hooks](skills/impeccable/reference/hooks.md) for arguments and config. `IMPECCABLE_HOOK_DISABLED`, `IMPECCABLE_HOOK_QUIET` and `IMPECCABLE_HOOK_LOG` retain upstream behavior. A deliberately configured audit-log destination persists. Normal session hook caches and claims are private temporary state, cleaned by their owner.

Checks observe successful native/nested Pi edit/write events, not arbitrary shell/custom mutations. Upstream owns detector rules, deduplication, ignores and preview suppression. Feedback is bounded to one corrective continuation per invocation, 24 scans, four projects, 20 primary files/project, 10 seconds/process and 12 KiB displayed output. Silent output alone does not prove clean coverage; detector errors and native-platform skips are disclosed.

Config/prompt writes use the public native mutation queue and physical-path process locks. Busy/stale locks or concurrent changes refuse writes; locks are not stolen. Multi-file cancellation may leave reported committed paths: inspect `integration.partial` and `integration.committed` before retrying. No rollback overwrites another writer.

## Browser, image and catalog prerequisites

A working project/dev server and an available browser inspection/capture tool are needed for browser verification. `impeccable_capabilities` inspects tool metadata only: a candidate is not a successful operation and no match means unknown, including indirect codemode image tools. Use discovery/schema help and actual operation results. If the app cannot run, the skill can inspect verified, fresh committed screenshots/goldens, disclosing the missing interaction evidence. Native apps need their platform build/simulator/emulator tooling. The test browser driver does not install a production browser or image service for your sessions.

Prefer an available harness-native image tool. If none is usable, native `generate-image` requires **`OPENAI_API_KEY`** and calls **`https://api.openai.com/v1`**. Missing that key does not establish that Pi lacks native image capability. Image calls may incur service costs. `IMPECCABLE_IMAGE_GEN_FAKE` is synthetic test-only output, never real generation evidence. Keep prompt provenance, reference-image handling and missing-capability disclosures from the [visualize playbook](skills/impeccable/reference/visualize.md).

Catalog directions use network access to `https://impeccable.style/api` (cards at `https://impeccable.style/api/cards`); board/image resources may come from `https://impeccable.style/worlds/cards`. Network failure follows native degraded guidance, with unavailable challengers/assets disclosed. It does not authorize fabricated catalog evidence or approval.

Upstream catalog telemetry defaults on. Opt out with `DO_NOT_TRACK=1` or `IMPECCABLE_NO_TELEMETRY=1` (nonempty values other than `0`/`false` also opt out), or `"telemetry": false` in user `~/.impeccable/config.json`, project shared config or project local config. **Off anywhere wins.** Through `/impeccable telemetry off|on|status`, native CLI off/on changes the **user** config's telemetry setting while preserving other keys; on cannot override another opt-out. Opt-out still requests a catalog roll with no-record instructions and sends no choice event. Default fields include seed key, scope, mode, round, pool revision, card kind, catalog ID and client version; upstream states it never sends project names or code. See [upstream privacy](https://impeccable.style/privacy). These are controls to choose deliberately, not steps required to use offline workflows.

## Delegation and questions

`impeccable_question` accepts 1–5 related questions with stable IDs and optional choices/free text. It uses supported TUI/RPC dialogs with a two-minute timeout, returning actual answers and pending questions without assumed defaults. Visual boards and component-review pages remain available where the playbook calls for them.

`impeccable_delegate` supplies the complete adapted asset-producer, documenter, finish-reviewer or manual-edit-applier role through existing Subagents `Agent` capabilities. Worker/reviewer mapping, packets and evidence are detailed in [FEATURES.md](FEATURES.md#roles-and-independent-assessments). It does not install a global fleet, enable scripted workflows, or override configured models/tiers. Agent execution policies remain authoritative. Fresh context uses `inherit_context:false`, `isolated:false` to retain tools; independent assessments never receive sibling conclusions. Parallel writers need distinct output boundaries and must finish before verification.

Role ceilings are 24/30/30/12 turns; assessments use 30. Agent's own `max_turns` is soft; the adapter cancels foreground progress at its ceiling before another tool turn. A boundary answer may conservatively remain partial. `wrapped-up` means soft-limit steering ended the child and still requires evidence inspection; executed errors/policy substitutions are partial, never permission to replay a whole role inline. `active` background work must be retrieved or managed through `get_subagent_result` or `/agents`; unresolved outcomes require establishing termination before dependent or duplicate work. A user-stopped child stays cancelled. Missing callable Agent, nested child-safe APIs and unguardable continuations return a main-session handoff. Only established no-child unavailability permits the named upstream degraded fallback; inline review is disclosed and never called independent.

SDK 1.4 is tested. Pi >=1.3 remains supported through capability checks: missing callable Agent yields handoff, missing native mutation queue refuses management writes, and missing actionable boundaries requires manual detector/live controls. These fallbacks do not promise the newer API's automation.

## Live ownership, stop and recovery

`/design-live` opens browser selection; `/design-generate 2 bolder the hero` targets variants directly. Follow [live setup](skills/impeccable/reference/live-setup.md) for app files, injection/CSP and browser prerequisites. `impeccable_live` owns `start|generate|status|reply|resume|stop`; start/generate return promptly while native work waits in the background. Do not start a competing Bash `live-poll` loop. Raw owner-only boot/poll/helper/completion requests through `impeccable_run` hand off to this owner.

Immediate human controls do not require a model turn:

```text
/impeccable-live status
/impeccable-live stop
/impeccable-live resume
```

Each delivery carries an exact ID/token; replies require the matching native business acknowledgement. Accept/discard source verification is separate from publication and terminal journal acknowledgement. Native journals/source application remain authoritative; production never edits journals. Full event handling includes generation, steering, accept/discard, manual apply, prefetch, mount failure, timeout, exit and carbonize cleanup.

Abort, queued user input, unresolved settlement, reload, session switch, fork, branch navigation and shutdown invalidate deliveries and pause owned work. Stop preserves pending source/journal state for explicit recovery. Resume checks the exact persisted session and active branch against native status/journal without another Go; another session cannot adopt it. Only a proven-dead process from that same session can release its stale live lease. An owned replacement helper refreshes native injection authentication; reused helpers stay intact. Cleanup stops only owned polling/helpers, leaving borrowed helpers, app servers and unrelated sessions alive. Older peers pause for explicit status/resume rather than claiming automatic event delivery. See [Pi runtime reference](skills/impeccable/reference/pi-runtime.md) for exact reply schemas and partial-state handling.

## Checks and evidence

From the repository root, install locked dependencies with `npm ci --no-audit --no-fund`. The six release checks are:

```bash
npm run test:impeccable:contracts
npm run test:impeccable
npm run test:impeccable:e2e
npm run test:impeccable:package
npm run typecheck
npm test
```

Contracts, scoped runtime, package, typecheck and `npm test` are safe offline checks. The scoped runtime includes contracts; the collection includes the scoped runtime. The package check creates a real npm tarball, verifies all 63 pristine hashes and extracted bytes/resources, and loads/expands prompts in relocated Pi subprocesses guarded against network/process/write/source-tree fallback. Its executable relocation uses a **trusted local double**, not a managed engine.

**E2E is explicitly opt-in network/browser work.** It requires Git, official release-download access on first use, and Chromium system libraries. It acquires the checksum-verified engine and managed Chromium headless shell through pinned dev-only Playwright Core 1.56.1 into private OS-temporary caches; profiles/projects/homes are isolated. Node 26 POSIX acquisition also needs `unzip` for the test-only extraction workaround; Node 22/24 use the bundled extractor. Missing prerequisites, missing phases and skipped tests fail. Receipts/screenshots are printed in private OS-temporary artifact directories. It performs no paid model/image calls.

For narrower explicit checks:

```bash
npm run test:impeccable:engine              # native management parity and live protocol; no browser
npm run test:impeccable:visual-foundations  # native detector, direction decision and Chromium
```

The combined E2E gate has six tests: two native engine smokes, three visual foundations and one actual live-browser flow. Observed browser evidence uses engine 0.1.18 on macOS arm64 and Chromium 141.0.7390.37. It includes actual opt-in detector findings/dedup/one correction, native direction page/DOM choice/ANSWER and real Pi context writes with PRODUCT bytes preserved. Live evidence covers actual Go, two source variants, cycling/accept, exact-session reload/recovery without another Go, stale-token refusal, complete acknowledgement/journal, a second Go/discard, source preservation and owned-process cleanup with app/browser/borrowed-helper survival.

Catalog/model responses and variants are **SIMULATED**; native transactions and browser actions are real. Remaining platform/framework/event paths have inherited playbook and/or offline adapter coverage, not equivalent browser proof. Local static HTML accept/discard recovery is tested; paid images, aesthetic quality and all operating systems/frameworks are not certified. The [map](FEATURES.md#evidence-key) distinguishes these evidence levels.

## Repository-managed upgrades

Runtime `install`, `update`, `link` and corresponding skill-distribution requests point here instead of installing foreign harness manifests. Maintain the complete upstream feature set:

1. Fetch the intended upstream tag/commit into isolated storage; use `upstream.json` to identify every Pi distribution and canonical role source path. Current pin: skill 4.8.0, commit `414603bf14c7a344edb466bb1f85690c77ce8b7d`, engine 0.1.18.
2. Import the pristine distribution and all four role sources under `vendor/impeccable-<version>/`; regenerate the sorted per-file `MANIFEST.sha256` (currently 63 pristine files). Preserve Apache-2.0 license/notice and file provenance.
3. Update `upstream.json`, engine version in `src/resources.ts`, VERSION/checksum resources and all command metadata together. Review every upstream command and role, supporting script and reference; do not reduce the set.
4. Update anchored deterministic adaptations in `scripts/transform.mjs` and `scripts/pi-runtime.mjs`, and record changes/reasons in `LOCAL-PATCHES.md`. Run `node extensions/impeccable/scripts/transform.mjs`; never hand-edit generated skills/prompts. Contracts must reproduce them exactly.
5. Run **all six checks above**, including actual E2E, tarball relocation, strict typecheck and full safe collection tests. Reassess prerequisite/evidence claims and this feature map. Commit no native engine, browser, runtime cache, credentials or generated test artifacts.
