# Testing Herder

Run the collection suite from the `pi-extensions` repository root:

```sh
npm test
```

This runs the existing extension tests, strict TypeScript checks, Herder's profile/plan/Git/dashboard integration fixtures, Pi adapter tests, deterministic manager tests, and clean worker-engine tests.

Run only Herder's deterministic suite with:

```sh
npm run test:herder
```

The live Pi/Offcut fixture requires the configured models and provider endpoint:

```sh
npm run test:e2e:herder
```

The live test starts Pi with extension discovery disabled and explicitly loads this checkout's Herder entrypoint. It verifies one Implementer followed by two independent Reviewer approvals, exact model bindings and usage records, a clean unchanged user checkout, the integrated result, dashboard health, and parentless Pi worker trajectories.
