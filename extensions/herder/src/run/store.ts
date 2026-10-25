import type { Journal } from "../journal/journal.ts";
import type { RunState } from "../journal/fold.ts";
import type { OutputStore } from "../types.ts";
import type { RunPaths } from "./paths.ts";

export interface RunStore {
	readonly runId: string;
	readonly paths: RunPaths;
	readonly journal: Journal;
	readonly outputs: OutputStore;
	state(): RunState;
	/** Re-renders progress.md from the journal. */
	renderProgress(): void;
}

export function createOutputStore(dir: string): OutputStore { throw new Error("not implemented"); }
export function createRun(commonDir: string, init: { title: string; base: string; repo: string; goal?: string; runId?: string }): RunStore { throw new Error("not implemented"); }
/** Throws `nothing to resume` when the run directory or journal is missing. */
export function openRun(commonDir: string, runId: string): RunStore { throw new Error("not implemented"); }
export function listRuns(commonDir: string): string[] { throw new Error("not implemented"); }
