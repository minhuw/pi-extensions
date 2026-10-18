# Testing Herder

Run the collection suite from the `pi-extensions` repository root with Node >=22.19.0 and `ripgrep` (`rg`) installed on `PATH`:

```sh
npm test
```

This runs the existing extension tests, strict TypeScript checks, Herder's profile/plan/Git/dashboard integration fixtures, Pi adapter tests, durable operation submit/poll tests, exact-tree verification-manifest validation, deterministic manager tests, and clean worker-engine tests.

Run only Herder's deterministic suite with:

```sh
npm run test:herder
```

### Run one file

```sh
npm run test:herder -- extensions/herder/tests/unit/core/verification.test.ts
npm run test:herder -- extensions/herder/tests/integration/architecture.test.ts
```

Focused runs execute only the named test files and skip typecheck. Recon search tests, including worker-engine tests that launch Recon children, require `rg`; the runtime deliberately does not download it. On Ubuntu, install it with `sudo apt-get update && sudo apt-get install --yes ripgrep`, as the deterministic CI workflow does.

Manager/adapter lifecycle tests reuse `tests/support/plan-v2.ts::fixturePlan` for valid plan setup, with scenario-specific facts at the call site. Parser and assignment-contract tests keep independent literal fixtures. Prefer assertions on registered tools, dispatched sessions, delivered messages, and durable outcomes over regexes matching TypeScript implementation spelling; retain explicit checks for package assets and model-facing prompt contracts.

Integration tests are strict TypeScript files discovered in sorted path order. The smoke runner fails closed and prints any legacy integration `.mjs` paths, then runs the discovered files with Node's `--test-concurrency=2`; each file keeps its scenarios sequential. Unit tests run in a separate phase with the same two-file concurrency limit; these also launch Git/SQLite-backed fixtures, so unbounded file concurrency can exhaust their deadlines. To exercise dashboard server mode directly, run `node --experimental-strip-types extensions/herder/tests/integration/dashboard/dashboard.test.ts --serve`; the URL is printed as `HERDER_DASHBOARD_URL`, and SIGINT/SIGTERM shuts the server and fixture down.

## Plan V2 and verification ownership

Plan fixtures use the breaking seven-section [canonical format](skills/plans/references/plan-format.md), not old headings or a legacy fallback. A/V references are reciprocal and every criterion needs acceptance-phase proof; development diagnostics and final-only checks cannot replace prerequisite acceptance. T definitions are unique across local/shared context and identify canonical owner/cwd/prerequisites/probe/evidence. Baseline observations must not fabricate expected dependency code; suggested routes are not extra binding acceptance requirements. Equal unordered write paths prevent shape readiness. Parser coverage establishes structure, not semantic executability.

Discover actual commands through repository scripts, pyproject/uv or Nix declarations where applicable, lockfiles, CI, and instructions—not `which`. In this checkout `package.json`, `package-lock.json`, and `AGENTS.md` declare Node >=22.19.0 and npm scripts; `npm ci` is setup, not a passed test. Focused Herder runs skip typecheck; the full Herder suite already includes it, so avoid redundant final gates without distinct coverage.

Phase owners are explicit: producers/Validate inspect sources and cold-read compiled snapshots without setup writes; Implementers may perform repository-declared locked dependency restoration, pinned assets, and prescribed setup before probes/checks; independent Reviewers/Judges reuse that state and may repeat only source-preserving declared restoration before checks. Dependency selection or tracked manifest/lock changes require explicit assignment scope. The main session selects final direct-argv gates and the manager executes them on the frozen integrated tree. No automatic manager per-plan gate/preflight phase or new preflight role is added. Agent `SETUP` and `CHECKS` are separate self-report evidence, never manager-executed proof; unrun/blocked checks stay unrun/blocked.

Existing final GitDriver preparation is npm-only and locked: a direct npm/npx gate with declared dependencies, no node_modules, and an npm lockfile temporarily receives `npm ci --ignore-scripts --no-audit --no-fund`; created modules are removed afterward or on preparation failure. This is not a universal preparer or permission for undeclared/unpinned npx installs. For a pinned browser/tool asset under isolated HOME/cache, select only a tracked repository-owned setup-and-check script as one gate; its setup and check share the fresh private state and report distinct log evidence, then that state is removed. A prep-only gate cannot seed a later gate, and Herder does not assume Playwright or add generic cache infrastructure. Preparation failures may precede any check evidence. See [Final verification environment](adapters/README.md#final-verification-environment).

Worker STOPPED/FAILED, Reviewer BLOCK, and Judge NEEDS_INPUT/BLOCKED can optionally report BLOCKER_KIND ENVIRONMENT/INVOCATION/REQUIREMENT/SAFETY. Ordinary code results and success omit it. Environment/invocation evidence enters same-role/ready-phase, same-round operator attention without automatic retry or guessed source repair. Attention triggers one read-only main-session diagnosis without resolving attention or automatically proposing revisions; safe retries/clarifications need exact host approval and remaining budget. In-assignment SAFETY pauses without remediation authority; unrelated pre-existing out-of-scope safety concerns are notify-only. Integrity checks still precede handling, and dirty/unreviewed changes cannot be accepted. Final `environment` classification is non-mutating and consumes no code round; its verification successor still consumes the run budget. Wrong argv/manager/cwd is `manifest_error`.

Gate outcomes `passed`, `command_failed`, `unavailable`, `timed_out`, and `runner_error`, plus error/timedOut/signal metadata, are process evidence only. A launched uv/Nix wrapper missing a nested tool may be `command_failed`; exit 127 or log text alone is not a source-defect diagnosis. Inspect the declared invocation and prerequisites, report exact manager/command/cwd/error, and never rewrite missing setup as a passed check.

## YOLO adapter regression coverage

Run the focused, provider-free argument and display-state checks:

```sh
npm run test:herder -- extensions/herder/tests/unit/adapters/arguments.test.ts extensions/herder/tests/unit/adapters/state.test.ts
```

They cover fire-only standalone `--yolo`, rejection on resume/revise/attach and of duplicate/value-form flags, unchanged normal defaults, and restoration of boolean display hints with legacy entries remaining normal. Backend lifecycle coverage must additionally establish zero Reviewer/Judge dispatches (including final audit), Implementer COMPLETE plus mechanical integrity/scope checks, mandatory passed exact-tree final gates, immutable mode recovery, and unchanged budgets. Adapter checks alone do not prove those backend guarantees or semantic review quality.

Schema 21 additively persists `yolo`, defaulting existing runs to `false`, without losing schema-20 budget accounting. Schema-19 migration must still preserve the applied contract/history/worktrees, reconstruct conservative consumption, and pause ambiguous recovery for explicit authorization. Test migrations only on isolated synthetic records, never real user executions. Normal review calibration below remains normal-mode coverage, not a YOLO approval claim.

## Bounded execution regression coverage

`tests/unit/core/budgets.test.ts` exercises transactional admission and stop persistence, replay, task limits across generations/internal reset, explicit reset clearing all four budget tables and restoring fresh defaults, unallocated renamed tasks, explicit grants, final verification, and conservative schema-19 migration. `review-findings.test.ts` validates approved obligation references, concrete causal evidence, advisory findings, and Judge bindings. `run-manager-environment.test.ts` covers quiet stops, safe host recovery, preserved mutations, stale dispatches, late terminals, and unknown verification results. `run-manager.test.ts` requires actual final approval instead of completion-plus-successor. All use isolated synthetic records/repositories; do not migrate or inspect real user executions for these checks.

## Whole-run revision regression coverage

`tests/unit/core/run-revision.test.ts` covers upstream integrated-in-run work plus a blocked dependent, graph-wide replacement, selective generation adoption, abandoned execution, confirmation dismissal, invalid graph and changed-checkout refusal, durable finish replay, and actual adapter tool/worker settlement. `tests/integration/reset.test.ts` covers destructive namespace ownership, reset of already-merged execution without changing the user branch, interrupted deletion, revised graph topology, and repeat reset/Fire cycles with default budgets. Completed legacy reset receipts clear retained budgets on replay without touching a successor run; internal revision resets and resume preserve accounting. All use temporary local Git repositories; no provider or live execution is required.

Check the complete sequence, not merely prompt strings: `revise_run` withholds all workers; edits affect only graph Markdown; exact host approval precedes cleanup; changed plans and their old/new downstream closure restart with fresh assignments, while unrelated proof-backed DONE plans retain their source changes and original evidence. Check independent completions both before and after an invalidated integration, dependency rewiring/removal, shared-context invalidation, conflict refusal, repeated revisions, and crash replay across integration publication and generation adoption. Include affected staged, unstaged, untracked, ignored, and committed work: exact approval permits discarding it, while same-path content changes after preview/approval must stop cleanup. Unaffected unfinished work and its unresolved attention must survive adoption, including lifecycle and later request-bound recovery. Approval and finish replay must dispatch no workers or replenish budgets; execution requires an explicit subsequent operation. Legacy revision records must never inherit new destructive authority. Final verification must bind the new exact tree; stale requests must not mutate a later generation. An invalid or dismissed proposal preserves old execution without restarting it. Test restart-time Markdown/lifecycle tampering and recovered-session tool restrictions. Normal `/herder-reset` must remain usable after prior successful resets and during unfinished revisions: include dirty work, changed/invalid draft Markdown, malformed legacy revision records, and partially applied selective cleanup. Verify stale revision/attention grants are removed, current plan content survives, dismissal is non-mutating, and fresh Fire/replay cannot resurrect old authority. Keep worker settlement, foreign-worktree, current-checkout, and identity guards intact.

## Scope-controlled rounds and progress

Run `npm run test:herder -- extensions/herder/tests/unit/core/round-progress.test.ts` for deterministic helper coverage: persisted terminal grouping/order and delivery identity, actual self-reported setup/checks, interrupted/missing evidence, Judge-only bounded repair contracts, stable-ID cumulative exclusions and validated reopening, plan/generation/run isolation, and YOLO Implementer-only reporting. These tests use synthetic action records, not real `.herder` state, providers, or a new database.

Backend lifecycle checks must establish Reviewer → Judge after every completed normal review (including approval, round 3, and final RUN audit); three attempts with no fourth automatic mutation; new-run default `9 × N + 12` with no automatic increase to existing allocations; and unchanged YOLO skips plus mandatory exact-tree final gates. Excluded findings require different explicit Reviewer evidence and Judge confirmation of an introduced/worsened regression before reopening; NEW relabeling, stale evidence, pre-existing unrelated safety/design concerns, and advisory findings grant no repair authority. Explicit existing-bug assignments remain in scope. Malformed/operational/interrupted reports remain honest stops or unknown evidence.

Verify separately that authorized next-round repairs are exact and bounded with scope/budget approval distinct; accept-as-is records exceptions rather than check success; drop preserves the patch and leaves dependents blocked. Worker NOTES/RATIONALE stay short (done/checks/remaining), with no mandatory SUMMARY field. Helper and prompt tests alone do not prove manager enforcement or semantic review quality.

## Bounded review policy and calibration

The focused package-contract check is deterministic and uses no provider:

```sh
npm run test:herder -- extensions/herder/tests/integration/pi-package.test.ts
```

Plan `DISCOVERY` uses Plan V2 Risk **LOW = 1, MED = 2, HIGH = 4** as a floor; missing risk means HIGH. Actual authorization/authentication, persistence, concurrency, public-boundary, or executable Markdown/prompt-policy risk may escalate; diff/file size or documentation extension never justifies a downgrade. First discovery in any later round uses the same rule. `FINAL_AUDIT` still uses four reviewers with full aggregate coverage. `VERIFICATION` defaults to one scoped child, scaling only for distinct risky repair boundaries up to four. All four lenses and owned-hunk/cross-boundary coverage remain required within the review scope. These are prompt policy counts, not changes to hard runtime caps (eight root calls, four concurrent direct children) or model bindings.

Contract checks cover materiality before expensive proof, optional rather than mandatory second opinions, zero-findings validity, separate unresolved mandatory coverage gaps/material concerns versus rejected speculation, stable IDs, partial-report omissions not resolving findings, and incomplete serious concerns/required checks never implying approval. Automatic Reignite drafting is disabled. Final P0/P1 `BLOCKING` `PLAN_REQUIREMENT`/`PATCH_REGRESSION` findings keep the original run incomplete; advisories remain reports, not executable scope. Static contracts do not demonstrate live reviewer quality.

`HERDER_REVIEW_TIMEOUT_MS` is opt-in: a positive integer no greater than 2147483647, unset disabled pending calibration. One deadline starts at root Reviewer start and includes SDK compaction/retries and all descendants. Exhaustion enters same-round operator attention with no automatic retry or approval. Safe Bash cleanup/settlement may exceed the deadline; measure that tail separately from the configured budget. This is separate from the live fixture's overall/stall limits below.

Before selecting a default budget or claiming improvements, compare approximately 30 representative historical changes under the old and bounded policies, with model bindings held constant. Include LOW/MED/HIGH risks, risky small and executable-policy diffs, repairs, and final audits. Human-audit material defects and misses (including serious unresolved coverage), not raw finding counts. Record latency, total tokens including descendants, and human triage effort/dispositions for material blockers, advisories, and rejected speculation. Report timeout/cleanup tails and quality-cost tradeoffs; do not hide misses behind faster runs. This is a calibration plan, not a completed benchmark; no live tests or benchmark are run as part of this policy update.

Separately authorize representative comparisons of direct review versus bounded Recon candidate scouting, holding model bindings constant. Measure total parent+descendant tokens and cost, end-to-end wall time and waiting-for-scout time, and human-validated material findings, false positives, and misses—not candidate counts alone. No improvement is claimed, no live benchmark runs automatically, and no new benchmark framework, scripts, or configuration are introduced.

## Local live Pi/Poorman setup

The live fixture is provider-backed and can spend model credits. Run it intentionally after the safe preflight below; it is not a normal repository test gate.

Use Node >=22.19.0 and npm from the repository root. Install the locked dependencies and register this checkout (including the native Magpie provider) in Pi's user package store:

```sh
set -eu
node --version
npm --version
npm ci

pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$PWD/extensions/magpie-provider/index.ts}"
herder_entry="$PWD/extensions/herder/adapters/index.ts"
test -x "$pi_bin"
test -f "$herder_entry"
"$pi_bin" install "$PWD" --approve
test -f "$provider_extension"
export HERDER_PI_BIN="$pi_bin"
export HERDER_PI_PROVIDER_EXTENSION="$provider_extension"
```

The default provider extension is this checkout's `extensions/magpie-provider/index.ts`. Use one configuration owner: remove any `providers.magpie` overlay from Pi's `models.json` and disable Magpie's Pi config-sync before using this extension (back up configuration first). Saved `/login magpie` values take precedence over environment values; ensure they identify the intended gateway. Set `HERDER_PI_BIN` or `HERDER_PI_PROVIDER_EXTENSION` before running the setup when using a different binary or provider extension. Keep those exports in the shell used for the preflight and test. The fixture disables extension discovery and explicitly loads both the provider extension and this checkout's `extensions/herder/adapters/index.ts`, so it does not depend on a globally discovered Herder copy.

Web research additionally requires a running Magpie with its search backend and a `magpie-web-search` MCP registration, via saved `/login magpie` or a user-level entry described in [Magpie setup](README.md#magpie-web-search). Environment-only provider setup does not automatically enable web MCP. This code-only live fixture and its CI workflow do not provision Magpie/search or establish live search compatibility. Searcher calls without that setup return an explicit failure, not a fallback to `pi-web-access`.

The deterministic worker-engine tests exercise real native FFF file/content search and pagination against temporary local worktrees, including direct Recon and reviewer scouts, without a model provider. All role tool sets include `fffind`/`ffgrep`; ambient extensions remain excluded. The FFF adapter checks restricted paths and output evidence, rejects cross-session cursors, and refuses unsafe ignore-file initialization while preserving built-in scoped tools.

The deterministic worker-engine tests exercise native MCP discovery and tool calls against a temporary local fixture, without contacting Magpie or a search provider. Check that only Searcher connects, both allowed tools appear before its first model request, unrelated/project servers stay untouched, credentials are not included in diagnostics, and missing/disabled/broken servers cannot produce a successful research session. Keep the local find/grep boundary and session cancellation/cleanup coverage.

### Provider variables and secret-safe preflight

Provider runtime, CI repository secrets, and artifact redaction all use the same names:

| Variable | Meaning |
| --- | --- |
| `MAGPIE_API_KEY` | Bearer credential; required for remote gateways. The provider defaults to `magpie-pi` only on loopback, but this preflight and CI require an explicit key. |
| `MAGPIE_BASE_URL` | HTTP(S) gateway origin, optionally ending in `/`, `/v1`, or `/v1/`. The provider defaults to `http://127.0.0.1:3425`; this preflight and CI require an explicit URL. |

Set these through the shell or a secret manager without putting values in a repository file or command output. Do not use shell tracing or print the environment. Magpie canonicalizes to the URL origin, removing the optional `/v1`; `/backend-api`, other paths, userinfo, queries, fragments, and non-HTTP(S) protocols are rejected. Use HTTPS remotely: explicit HTTP sends credentials without encryption. See the [Magpie provider README](../magpie-provider/README.md) for connection precedence and URL rules.

This intentionally networked preflight uses the provider's parser, rejects redirects, and never prints credentials, URLs, response bodies, or raw network errors:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import { readConfig } from "./extensions/magpie-provider/index.ts";
try {
  if (!process.env.MAGPIE_API_KEY?.trim() || !process.env.MAGPIE_BASE_URL?.trim()) {
    throw new Error("Missing configuration");
  }
  const { origin, apiKey } = readConfig();
  const response = await fetch(`${origin}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Unsuccessful response");
} catch {
  console.error("Magpie preflight failed: check MAGPIE_API_KEY, MAGPIE_BASE_URL, and gateway availability. Redirects are not allowed.");
  process.exitCode = 1;
}
NODE
```

The probe checks authorization and endpoint reachability without writing a response body. Then verify the provider extension and the model IDs required by the `poorman` profile and Recon:

```sh
set -eu
pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$PWD/extensions/magpie-provider/index.ts}"
test -x "$pi_bin"
test -f "$provider_extension"
models=$("$pi_bin" --no-extensions --extension "$provider_extension" --list-models magpie)
for required_model_id in \
  'gpt-6-luna' \
  'deepseek/deepseek-flash'
do
  if ! printf '%s\n' "$models" | grep -Fq -- "$required_model_id"; then
    printf 'Required model is not listed: %s\n' "$required_model_id" >&2
    exit 1
  fi
done
```

`--list-models` emits provider model IDs without Herder's effort suffixes, so this check intentionally validates IDs only. It does not prove the exact effort mappings. Herder validates the exact `poorman` bindings from `assets/profiles/profiles.json` before dispatch. The Implementer and Recon both use `deepseek/deepseek-flash`; preserve this gateway model ID rather than substituting an unavailable alias. Successful discovery/preflight does not guarantee a live run succeeds.

## Run, limits, and artifacts

Run the provider-backed fixture only after the preflight succeeds:

```sh
npm run test:e2e:herder
```

The command starts Pi in RPC mode with `magpie`, the `poorman` profile, and the explicit provider and Herder extensions. It verifies the Implementer, independent reviews, manager-executed evidence, exact model bindings and usage, an unchanged user checkout, the integrated result, dashboard health, and parentless Pi worker trajectories. It does not belong in the ordinary `npm test` gate because it spends model time.

The local defaults and overrides are:

| Limit | Default | Override |
| --- | --- | --- |
| Overall run | 30 minutes | `HERDER_E2E_TIMEOUT_MS` (milliseconds) |
| No observable manager progress | 8 minutes | `HERDER_E2E_STALL_TIMEOUT_MS` (milliseconds) |

For a deliberately slower diagnostic run, set either or both variables on the command invocation, for example:

```sh
HERDER_E2E_STALL_TIMEOUT_MS=600000 HERDER_E2E_TIMEOUT_MS=2400000 npm run test:e2e:herder
```

Set `HERDER_KEEP_E2E=1` to retain a successful fixture for inspection; without it, a successful run is cleaned up after the service-stop attempt. A failed run retains its workspace and includes the fixture path in the error. The test also attempts to stop the Herder service after verification and again during cleanup.

The fixture reads Pi's RPC failures and error notifications and stops immediately with that diagnostic; unattended interactive dialogs also fail instead of hanging. The artifact collector preserves logs and valid execution databases even when startup failed before a service credential existed.

Each run creates a temporary workspace named `$TMPDIR/herder-pi-live-*` (or the platform temporary directory when `TMPDIR` is unset). It contains:

- `pi.log`, the Pi RPC, stdout, and stderr log named in the test output.
- `fixture.json`, which identifies the synthetic repository and its plan directory.
- The synthetic repository and its Herder-owned worktrees under `herder-plans/.herder/worktrees/`.
- `herder-plans/.herder`, including execution SQLite state, service logs, assignments, session diagnostics, gate evidence, and worktrees.

After inspecting a retained run, delete the exact fixture path printed by the test; do not delete unrelated temporary directories. Retained local diagnostics may contain endpoint or runtime data, so review them before sharing. CI's artifact collector redacts configured CI secret values and records its work in a manifest, but uploaded diagnostics still deserve review.

## Live CI

`.github/workflows/herder-live-e2e.yml` runs the Pi/Poorman fixture after Herder-, Magpie-, or shared-extension-related pushes to `master` and through manual dispatch. It uses Node 22.19.0, `npm ci`, loads this checkout's native Magpie provider, probes the configured endpoint before spending model time, and uploads redacted fixture diagnostics even when the run fails.

CI sets `HERDER_E2E_TIMEOUT_MS` to 2,400,000 ms (40 minutes) while the job has a 45-minute workflow timeout. It sets `HERDER_KEEP_E2E=1` so diagnostics remain available, passes the `MAGPIE_API_KEY` and `MAGPIE_BASE_URL` repository secrets unchanged to the provider and artifact collector. Preflight validates the URL with Magpie's existing parser and probes `/v1/models` without redirects; the provider canonicalizes the same URL itself. Never place credential values in workflow files, logs, fixtures, committed environment files, or documentation.

## Troubleshooting

- **Missing Pi binary or provider extension:** confirm `test -x "$pi_bin"` and `test -f "$provider_extension"`, rerun `npm ci` and verify the Magpie provider exists in this checkout, or set `HERDER_PI_BIN`/`HERDER_PI_PROVIDER_EXTENSION` to the intended paths. The fixture must use the explicit provider extension and this checkout's Herder entrypoint.
- **Endpoint authorization or normalization:** check `MAGPIE_API_KEY` and `MAGPIE_BASE_URL` without printing them, use an origin or optional `/v1` suffix (not `/backend-api`), and rerun the body-free Node preflight. Redirects are rejected. Check for saved-login precedence or a conflicting `providers.magpie` overlay if CLI discovery differs from the environment-only probe.
- **Missing model or effort:** rerun the explicit `--list-models` check and compare the exact poorman IDs (`gpt-6-luna` and `deepseek/deepseek-flash`, also used by Recon). A listed model is not proof of its required effort; Herder's profile validation must accept the `poorman` bindings before dispatch.
- **Early RPC exit:** inspect `pi.log` and verify the provider install, `--no-extensions`, the explicit provider extension, and the checkout's `extensions/herder/adapters/index.ts`. Treat logs as potentially sensitive before copying or uploading them.
- **Stalls:** inspect the printed progress, `pi.log`, and the retained `.herder` diagnostics. Increase `HERDER_E2E_STALL_TIMEOUT_MS` or `HERDER_E2E_TIMEOUT_MS` only for a diagnosed slow provider, remembering that a longer overall limit can increase model spend.
