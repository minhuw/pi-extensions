import type { Run } from "../support/helpers.ts";

export { check, events, type Run, RUN_ID, setupRun, stepCommit } from "../support/helpers.ts";

/** Contents of `file` at `commit`. */
export const show = (run: Run, commit: string, file: string) => run.fixture.git("show", `${commit}:${file}`);
