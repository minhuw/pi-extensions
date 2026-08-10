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

The live Pi/Poorman fixture requires the configured models and provider endpoint:

```sh
npm run test:e2e:herder
```

The live test starts Pi with extension discovery disabled and explicitly loads this checkout's Herder entrypoint. It verifies an Implementer, independent plan review, main-session final verification selection, manager-executed gate evidence, final aggregate review, exact model bindings and usage records, a clean unchanged user checkout, the integrated result, dashboard health, and parentless Pi worker trajectories. It prints manager-state progress and fails after eight minutes without observable progress instead of silently waiting for the overall deadline. Override the limits with `HERDER_E2E_STALL_TIMEOUT_MS` and `HERDER_E2E_TIMEOUT_MS` when diagnosing an unusually slow provider.

## Live CI

`.github/workflows/herder-live-e2e.yml` runs the Pi/Poorman fixture after Herder-related pushes to `master` and through manual dispatch. It installs the CLIProxyAPI Pi provider, probes the configured endpoint before spending model time, and uploads redacted fixture diagnostics even when the run fails.

The workflow requires the `CLIPROXY_API_KEY` and `CLIPROXY_BASE_URL` repository secrets. Never place their values in workflow files, logs, fixtures, or committed environment files.
