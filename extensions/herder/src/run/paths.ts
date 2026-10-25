// Paths under <git-common-dir>/herder/ and refs under refs/herder/ (§4).
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { HERDER_DIR, REF_ROOT } from "../config.ts";
import { isStepKey } from "../journal/keys.ts";

export interface RunPaths { root: string; dir: string; goal: string; plan: string; progress: string; notes: string; scripts: string; journal: string; outputs: string; lock: string; sessions: string; worktrees: string }

const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const SLOT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function isRunId(value: string): boolean { return RUN_ID.test(value); }

function assertRunId(runId: string): void {
	if (!isRunId(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
}

export function herderRoot(commonDir: string): string { return join(resolve(commonDir), HERDER_DIR); }
export function runsDir(commonDir: string): string { return join(herderRoot(commonDir), "runs"); }

export function runPaths(commonDir: string, runId: string): RunPaths {
	assertRunId(runId);
	const root = herderRoot(commonDir);
	const dir = join(root, "runs", runId);
	return {
		root, dir,
		goal: join(dir, "goal.md"), plan: join(dir, "plan.md"), progress: join(dir, "progress.md"), notes: join(dir, "notes.md"),
		scripts: join(dir, "scripts"), journal: join(dir, "journal.jsonl"), outputs: join(dir, "outputs"), lock: join(dir, "lock"),
		sessions: join(dir, "sessions"),
		worktrees: join(root, "worktrees", runId),
	};
}

/** Slots are step keys or fixed names such as `integration`; anything that could escape the directory is rejected. */
export function worktreePath(commonDir: string, runId: string, slot: string): string {
	if (!SLOT.test(slot) || slot.includes("..")) throw new Error(`invalid worktree slot: ${JSON.stringify(slot)}`);
	return join(runPaths(commonDir, runId).worktrees, slot);
}

/** `YYYYMMDD-HHMMSS-<4 hex>` in UTC. */
export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** `refs/herder/<runId>` (no trailing slash); every ref of the run lives below it. */
export function refPrefix(runId: string): string {
	assertRunId(runId);
	return `${REF_ROOT}/${runId}`;
}
export function baseRef(runId: string): string { return `${refPrefix(runId)}/base`; }
export function integrationRef(runId: string): string { return `${refPrefix(runId)}/integration`; }
export function stepRef(runId: string, key: string): string {
	if (!isStepKey(key)) throw new Error(`invalid step key: ${JSON.stringify(key)}`);
	return `${refPrefix(runId)}/steps/${key}`;
}
