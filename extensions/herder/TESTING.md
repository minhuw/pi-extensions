# Testing Herder

Run the collection suite from the `pi-extensions` repository root:

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

Focused runs execute only the named test files and skip typecheck.

Manager/adapter lifecycle tests reuse `tests/support/plan-v2.ts::fixturePlan` for valid plan setup, with scenario-specific facts at the call site. Parser and assignment-contract tests keep independent literal fixtures. Prefer assertions on registered tools, dispatched sessions, delivered messages, and durable outcomes over regexes matching TypeScript implementation spelling; retain explicit checks for package assets and model-facing prompt contracts.

Integration tests are strict TypeScript files discovered in sorted path order. The smoke runner fails closed and prints any legacy integration `.mjs` paths, then runs the discovered files with Node's `--test-concurrency=2`; each file keeps its scenarios sequential. Unit tests run in a separate phase. To exercise dashboard server mode directly, run `node --experimental-strip-types extensions/herder/tests/integration/dashboard/dashboard.test.ts --serve`; the URL is printed as `HERDER_DASHBOARD_URL`, and SIGINT/SIGTERM shuts the server and fixture down.

## Plan V2 and verification ownership

Plan fixtures use the breaking seven-section [canonical format](skills/plans/references/plan-format.md), not old headings or a legacy fallback. A/V references are reciprocal and every criterion needs acceptance-phase proof; development diagnostics and final-only checks cannot replace prerequisite acceptance. T definitions are unique across local/shared context and identify canonical owner/cwd/prerequisites/probe/evidence. Baseline observations must not fabricate expected dependency code; suggested routes are not extra binding acceptance requirements. Equal unordered write paths prevent shape readiness. Parser coverage establishes structure, not semantic executability.

Discover actual commands through repository scripts, pyproject/uv or Nix declarations where applicable, lockfiles, CI, and instructions—not `which`. In this checkout `package.json`, `package-lock.json`, and `AGENTS.md` declare Node >=22.19.0 and npm scripts; `npm ci` is setup, not a passed test. Focused Herder runs skip typecheck; the full Herder suite already includes it, so avoid redundant final gates without distinct coverage.

Phase owners are explicit: producers/Validate inspect sources and cold-read compiled snapshots without setup writes; Implementers may perform repository-declared locked dependency restoration, pinned assets, and prescribed setup before probes/checks; independent Reviewers/Judges reuse that state and may repeat only source-preserving declared restoration before checks. Dependency selection or tracked manifest/lock changes require explicit assignment scope. The main session selects final direct-argv gates and the manager executes them on the frozen integrated tree. No automatic manager per-plan gate/preflight phase or new preflight role is added. Agent `SETUP` and `CHECKS` are separate self-report evidence, never manager-executed proof; unrun/blocked checks stay unrun/blocked.

Existing final GitDriver preparation is npm-only and locked: a direct npm/npx gate with declared dependencies, no node_modules, and an npm lockfile temporarily receives `npm ci --ignore-scripts --no-audit --no-fund`; created modules are removed afterward or on preparation failure. This is not a universal preparer or permission for undeclared/unpinned npx installs. For a pinned browser/tool asset under isolated HOME/cache, select only a tracked repository-owned setup-and-check script as one gate; its setup and check share the fresh private state and report distinct log evidence, then that state is removed. A prep-only gate cannot seed a later gate, and Herder does not assume Playwright or add generic cache infrastructure. Preparation failures may precede any check evidence. See [Final verification environment](adapters/README.md#final-verification-environment).

Worker STOPPED/FAILED, Reviewer BLOCK, and Judge NEEDS_INPUT/BLOCKED can optionally report BLOCKER_KIND ENVIRONMENT/INVOCATION/REQUIREMENT. Ordinary code results and success omit it. Environment/invocation evidence enters same-role/ready-phase, same-round operator attention without automatic retry or guessed source repair; integrity checks still precede handling, and dirty/unreviewed changes cannot be accepted. Final `environment` classification is non-mutating and consumes no code round; wrong argv/manager/cwd is `manifest_error`.

Gate outcomes `passed`, `command_failed`, `unavailable`, `timed_out`, and `runner_error`, plus error/timedOut/signal metadata, are process evidence only. A launched uv/Nix wrapper missing a nested tool may be `command_failed`; exit 127 or log text alone is not a source-defect diagnosis. Inspect the declared invocation and prerequisites, report exact manager/command/cwd/error, and never rewrite missing setup as a passed check.

## Bounded review policy and calibration

The focused package-contract check is deterministic and uses no provider:

```sh
npm run test:herder -- extensions/herder/tests/integration/pi-package.test.ts
```

Plan `DISCOVERY` uses Plan V2 Risk **LOW = 1, MED = 2, HIGH = 4** as a floor; missing risk means HIGH. Actual authorization/authentication, persistence, concurrency, public-boundary, or executable Markdown/prompt-policy risk may escalate; diff/file size or documentation extension never justifies a downgrade. First discovery in any later round uses the same rule. `FINAL_AUDIT` still uses four reviewers with full aggregate coverage. `VERIFICATION` defaults to one scoped child, scaling only for distinct risky repair boundaries up to four. All four lenses and owned-hunk/cross-boundary coverage remain required within the review scope. These are prompt policy counts, not changes to hard runtime caps (eight root calls, four concurrent direct children) or model bindings.

Contract checks cover materiality before expensive proof, optional rather than mandatory second opinions, zero-findings validity, separate unresolved mandatory coverage gaps/material concerns versus rejected speculation, stable IDs, partial-report omissions not resolving findings, and incomplete serious concerns/required checks never implying approval. Automatic Reignite drafting is limited to eligible P0/P1 `BLOCKING` `PLAN_REQUIREMENT`/`PATCH_REGRESSION` material blockers; advisories remain reports, not executable scope. Static contracts do not demonstrate live reviewer quality.

`HERDER_REVIEW_TIMEOUT_MS` is opt-in: a positive integer no greater than 2147483647, unset disabled pending calibration. One deadline starts at root Reviewer start and includes SDK compaction/retries and all descendants. Exhaustion enters same-round operator attention with no automatic retry or approval. Safe Bash cleanup/settlement may exceed the deadline; measure that tail separately from the configured budget. This is separate from the live fixture's overall/stall limits below.

Before selecting a default budget or claiming improvements, compare approximately 30 representative historical changes under the old and bounded policies, with model bindings held constant. Include LOW/MED/HIGH risks, risky small and executable-policy diffs, repairs, and final audits. Human-audit material defects and misses (including serious unresolved coverage), not raw finding counts. Record latency, total tokens including descendants, and human triage effort/dispositions for material blockers, advisories, and rejected speculation. Report timeout/cleanup tails and quality-cost tradeoffs; do not hide misses behind faster runs. This is a calibration plan, not a completed benchmark; no live tests or benchmark are run as part of this policy update.

Separately authorize representative comparisons of direct review versus bounded Recon candidate scouting, holding model bindings constant. Measure total parent+descendant tokens and cost, end-to-end wall time and waiting-for-scout time, and human-validated material findings, false positives, and misses—not candidate counts alone. No improvement is claimed, no live benchmark runs automatically, and no new benchmark framework, scripts, or configuration are introduced.

## Local live Pi/Poorman setup

The live fixture is provider-backed and can spend model credits. Run it intentionally after the safe preflight below; it is not a normal repository test gate.

Use Node >=22.19.0 and npm from the repository root. Install the locked dependencies and this checkout, which includes the vendored Pi provider:

```sh
set -eu
node --version
npm --version
npm ci

pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$PWD/extensions/cliproxyapi-provider/index.ts}"
herder_entry="$PWD/extensions/herder/adapters/index.ts"
test -x "$pi_bin"
test -f "$herder_entry"
"$pi_bin" install "$PWD" --approve
test -f "$provider_extension"
export HERDER_PI_BIN="$pi_bin"
export HERDER_PI_PROVIDER_EXTENSION="$provider_extension"
```

The default provider extension is this checkout's `extensions/cliproxyapi-provider/index.ts`. Do not also install the upstream npm provider. Set `HERDER_PI_BIN` or `HERDER_PI_PROVIDER_EXTENSION` before running the setup when using a different binary or provider extension. Keep those exports in the shell used for the preflight and test. The fixture disables extension discovery and explicitly loads both the provider extension and this checkout's `extensions/herder/adapters/index.ts`, so it does not depend on a globally discovered Herder copy.

### Provider variables and secret-safe preflight

Provider runtime variables and CI/artifact-redaction variables have different names:

| Use | Variables | Meaning |
| --- | --- | --- |
| Provider runtime | `CLIPROXYAPI_API_KEY`, `CLIPROXYAPI_BASE_URL` | Credentials and the normalized root URL read by the Pi provider. |
| CI and artifact redaction | `CLIPROXY_API_KEY`, `CLIPROXY_BASE_URL` | Workflow secret names and the values supplied to the diagnostic redactor; they are not the provider's runtime variable names. |

Set the runtime variables through the shell or a secret manager without putting their values in this file, a repository file, or command output. Do not use shell tracing or commands that print the environment. Normalize a configured URL by removing its trailing slash, then a trailing `/backend-api` or `/v1`, before using it as the provider root:

```sh
set -eu
: "${CLIPROXYAPI_API_KEY:?Set CLIPROXYAPI_API_KEY in the environment}"
: "${CLIPROXYAPI_BASE_URL:?Set CLIPROXYAPI_BASE_URL in the environment}"

proxy_root="${CLIPROXYAPI_BASE_URL%/}"
proxy_root="${proxy_root%/backend-api}"
proxy_root="${proxy_root%/v1}"
export CLIPROXYAPI_BASE_URL="$proxy_root"

curl --fail --silent --show-error --max-time 30 \
  --header "Authorization: Bearer $CLIPROXYAPI_API_KEY" \
  "$proxy_root/v1/models?client_version=herder-ci" \
  --output /dev/null
```

The probe checks authorization and endpoint reachability without writing a response body. Then verify the provider extension and every model/effort binding required by the `poorman` profile:

```sh
set -eu
pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$PWD/extensions/cliproxyapi-provider/index.ts}"
test -x "$pi_bin"
test -f "$provider_extension"
models=$("$pi_bin" --no-extensions --extension "$provider_extension" --list-models cliproxyapi)
for required_model_id in \
  'gpt-5.6-luna' \
  'deepseek-v4-flash'
do
  if ! printf '%s\n' "$models" | grep -Fq -- "$required_model_id"; then
    printf 'Required model is not listed: %s\n' "$required_model_id" >&2
    exit 1
  fi
done
```

`--list-models` emits provider model IDs without Herder's effort suffixes, so this check intentionally validates IDs only. It does not prove the exact effort mappings. Herder validates the exact `poorman` bindings from `assets/profiles/profiles.json` before dispatch.

## Run, limits, and artifacts

Run the provider-backed fixture only after the preflight succeeds:

```sh
npm run test:e2e:herder
```

The command starts Pi in RPC mode with `cliproxyapi`, the `poorman` profile, and the explicit provider and Herder extensions. It verifies the Implementer, independent reviews, manager-executed evidence, exact model bindings and usage, an unchanged user checkout, the integrated result, dashboard health, and parentless Pi worker trajectories. It does not belong in the ordinary `npm test` gate because it spends model time.

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

Each run creates a temporary workspace named `$TMPDIR/herder-pi-live-*` (or the platform temporary directory when `TMPDIR` is unset). It contains:

- `pi.log`, the Pi RPC, stdout, and stderr log named in the test output.
- `fixture.json`, which identifies the synthetic repository and its plan directory.
- The synthetic repository and its Herder-owned worktrees under `herder-plans/.herder/worktrees/`.
- `herder-plans/.herder`, including execution SQLite state, service logs, assignments, session diagnostics, gate evidence, and worktrees.

After inspecting a retained run, delete the exact fixture path printed by the test; do not delete unrelated temporary directories. Retained local diagnostics may contain endpoint or runtime data, so review them before sharing. CI's artifact collector redacts configured CI secret values and records its work in a manifest, but uploaded diagnostics still deserve review.

## Live CI

`.github/workflows/herder-live-e2e.yml` runs the Pi/Poorman fixture after Herder- or provider-related pushes to `master` and through manual dispatch. It uses Node 22.19.0, `npm ci`, loads this checkout's vendored CLIProxyAPI provider, probes the configured endpoint before spending model time, and uploads redacted fixture diagnostics even when the run fails.

CI sets `HERDER_E2E_TIMEOUT_MS` to 2,400,000 ms (40 minutes) while the job has a 45-minute workflow timeout. It sets `HERDER_KEEP_E2E=1` so diagnostics remain available, maps the `CLIPROXY_API_KEY` and `CLIPROXY_BASE_URL` repository secrets to the provider's `CLIPROXYAPI_API_KEY` and `CLIPROXYAPI_BASE_URL` variables, and passes the normalized root to the provider. Never place credential values in workflow files, logs, fixtures, committed environment files, or documentation.

## Troubleshooting

- **Missing Pi binary or provider extension:** confirm `test -x "$pi_bin"` and `test -f "$provider_extension"`, rerun `npm ci` and verify the vendored provider exists in this checkout, or set `HERDER_PI_BIN`/`HERDER_PI_PROVIDER_EXTENSION` to the intended paths. The fixture must use the explicit provider extension and this checkout's Herder entrypoint.
- **Endpoint authorization or normalization:** check that the runtime variables are set without printing them, apply the trailing-slash/`/backend-api`/`/v1` normalization, and rerun the body-free `curl` probe. Do not substitute the CI/artifact variable names for the provider runtime names.
- **Missing model or effort:** rerun the explicit `--list-models` check and compare both exact IDs (gpt-5.6-luna and deepseek-v4-flash). A listed model is not proof of its required effort; Herder's profile validation must accept the `poorman` bindings before dispatch.
- **Early RPC exit:** inspect `pi.log` and verify the provider install, `--no-extensions`, the explicit provider extension, and the checkout's `extensions/herder/adapters/index.ts`. Treat logs as potentially sensitive before copying or uploading them.
- **Stalls:** inspect the printed progress, `pi.log`, and the retained `.herder` diagnostics. Increase `HERDER_E2E_STALL_TIMEOUT_MS` or `HERDER_E2E_TIMEOUT_MS` only for a diagnosed slow provider, remembering that a longer overall limit can increase model spend.
