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

Integration tests are strict TypeScript files discovered in sorted path order. The smoke runner fails closed and prints any legacy integration `.mjs` paths, then runs the discovered files with Node's `--test-concurrency=2`; each file keeps its scenarios sequential. Unit tests run in a separate phase. To exercise dashboard server mode directly, run `node --experimental-strip-types extensions/herder/tests/integration/dashboard/dashboard.test.ts --serve`; the URL is printed as `HERDER_DASHBOARD_URL`, and SIGINT/SIGTERM shuts the server and fixture down.

## Local live Pi/Poorman setup

The live fixture is provider-backed and can spend model credits. Run it intentionally after the safe preflight below; it is not a normal repository test gate.

Use Node >=22.19.0 and npm from the repository root. Install the locked dependencies, the pinned Pi provider, and this checkout:

```sh
set -eu
node --version
npm --version
npm ci

pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$HOME/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts}"
herder_entry="$PWD/extensions/herder/adapters/index.ts"
test -x "$pi_bin"
test -f "$herder_entry"
"$pi_bin" install npm:@router-for-me/pi-cliproxyapi-provider@1.4.13 --approve
"$pi_bin" install "$PWD" --approve
test -f "$provider_extension"
export HERDER_PI_BIN="$pi_bin"
export HERDER_PI_PROVIDER_EXTENSION="$provider_extension"
```

The default installed provider extension path is `$HOME/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts`. Set `HERDER_PI_BIN` or `HERDER_PI_PROVIDER_EXTENSION` before running the setup when using a different binary or installed extension. Keep those exports in the shell used for the preflight and test. The fixture disables extension discovery and explicitly loads both the provider extension and this checkout's `extensions/herder/adapters/index.ts`, so it does not depend on a globally discovered Herder copy.

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
provider_extension="${HERDER_PI_PROVIDER_EXTENSION:-$HOME/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts}"
test -x "$pi_bin"
test -f "$provider_extension"
models=$("$pi_bin" --no-extensions --extension "$provider_extension" --list-models cliproxyapi)
for required_model in \
  'kimi-k3:max' \
  'deepseek-v4-flash:high' \
  'gpt-5.6-luna:max'
do
  if ! printf '%s\n' "$models" | grep -Fq -- "$required_model"; then
    printf 'Required model is not listed: %s\n' "$required_model" >&2
    exit 1
  fi
done
```

`--list-models` confirms that model IDs are available through the provider, but it does not prove the exact effort mappings. Herder validates `kimi-k3` at `max`, `deepseek-v4-flash` at `high`, and `gpt-5.6-luna` at `max` before dispatch.

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
- The synthetic repository and its Herder-owned worktrees.
- `herder-plans/.herder`, including execution SQLite state, service logs, assignments, session diagnostics, and gate evidence.

After inspecting a retained run, delete the exact fixture path printed by the test; do not delete unrelated temporary directories. Retained local diagnostics may contain endpoint or runtime data, so review them before sharing. CI's artifact collector redacts configured CI secret values and records its work in a manifest, but uploaded diagnostics still deserve review.

## Live CI

`.github/workflows/herder-live-e2e.yml` runs the Pi/Poorman fixture after Herder-related pushes to `master` and through manual dispatch. It uses Node 22.19.0, `npm ci`, installs `@router-for-me/pi-cliproxyapi-provider@1.4.13`, probes the configured endpoint before spending model time, and uploads redacted fixture diagnostics even when the run fails.

CI sets `HERDER_E2E_TIMEOUT_MS` to 2,400,000 ms (40 minutes) while the job has a 45-minute workflow timeout. It sets `HERDER_KEEP_E2E=1` so diagnostics remain available, maps the `CLIPROXY_API_KEY` and `CLIPROXY_BASE_URL` repository secrets to the provider's `CLIPROXYAPI_API_KEY` and `CLIPROXYAPI_BASE_URL` variables, and passes the normalized root to the provider. Never place credential values in workflow files, logs, fixtures, committed environment files, or documentation.

## Troubleshooting

- **Missing Pi binary or provider extension:** confirm `test -x "$pi_bin"` and `test -f "$provider_extension"`, rerun the pinned provider install, or set `HERDER_PI_BIN`/`HERDER_PI_PROVIDER_EXTENSION` to the intended paths. The fixture must use the explicit provider extension and this checkout's Herder entrypoint.
- **Endpoint authorization or normalization:** check that the runtime variables are set without printing them, apply the trailing-slash/`/backend-api`/`/v1` normalization, and rerun the body-free `curl` probe. Do not substitute the CI/artifact variable names for the provider runtime names.
- **Missing model or effort:** rerun the explicit `--list-models` check and compare all three exact IDs. A listed model is not proof of its required effort; Herder's profile validation must accept the `poorman` bindings before dispatch.
- **Early RPC exit:** inspect `pi.log` and verify the provider install, `--no-extensions`, the explicit provider extension, and the checkout's `extensions/herder/adapters/index.ts`. Treat logs as potentially sensitive before copying or uploading them.
- **Stalls:** inspect the printed progress, `pi.log`, and the retained `.herder` diagnostics. Increase `HERDER_E2E_STALL_TIMEOUT_MS` or `HERDER_E2E_TIMEOUT_MS` only for a diagnosed slow provider, remembering that a longer overall limit can increase model spend.
