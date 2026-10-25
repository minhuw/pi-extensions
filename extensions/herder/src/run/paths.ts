// Paths under <git-common-dir>/herder/ and refs under refs/herder/ (§4).

export interface RunPaths { root: string; dir: string; goal: string; plan: string; progress: string; notes: string; scripts: string; journal: string; outputs: string; lock: string; worktrees: string }

export function herderRoot(commonDir: string): string { throw new Error("not implemented"); }
export function runPaths(commonDir: string, runId: string): RunPaths { throw new Error("not implemented"); }
export function worktreePath(commonDir: string, runId: string, slot: string): string { throw new Error("not implemented"); }
/** `YYYYMMDD-HHMMSS-<4 hex>` in UTC. */
export function newRunId(now?: Date): string { throw new Error("not implemented"); }
export function isRunId(value: string): boolean { throw new Error("not implemented"); }
export function refPrefix(runId: string): string { throw new Error("not implemented"); }
export function baseRef(runId: string): string { throw new Error("not implemented"); }
export function integrationRef(runId: string): string { throw new Error("not implemented"); }
export function stepRef(runId: string, key: string): string { throw new Error("not implemented"); }
