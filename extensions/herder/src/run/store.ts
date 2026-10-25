import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HERDER_VERSION } from "../config.ts";
import { fold, type RunOverallStatus, type RunState } from "../journal/fold.ts";
import { Journal } from "../journal/journal.ts";
import { sha256Hex } from "../journal/keys.ts";
import { renderProgress } from "../journal/render.ts";
import type { OutputStore } from "../types.ts";
import { syncDir, writeAtomic, writeSynced } from "./files.ts";
import { isRunId, newRunId, runPaths, runsDir, type RunPaths } from "./paths.ts";

export interface PlanTask { id: string; text: string }

export interface RunStore {
	readonly runId: string;
	readonly paths: RunPaths;
	readonly journal: Journal;
	readonly outputs: OutputStore;
	state(): RunState;
	/** Re-renders progress.md from the journal (atomically). */
	renderProgress(tasks?: readonly PlanTask[]): void;
	/** Stores a launch's script as the immutable `scripts/<n>.js`, with `n` above every existing file and journaled launch. */
	writeScript(source: string): { launch: number; path: string };
}

const FINISHED: ReadonlySet<RunOverallStatus> = new Set(["delivered", "abandoned", "failed"]);
const OUTPUT_REF = /^outputs\/([0-9a-f]{64})\.txt$/;

/** Content-addressed outputs in `dir` (the run's `outputs/`); refs are relative to the run directory. */
export function createOutputStore(dir: string): OutputStore {
	return {
		put(content) {
			const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
			const sha = sha256Hex(bytes);
			const path = join(dir, `${sha}.txt`);
			if (!existsSync(path)) {
				mkdirSync(dir, { recursive: true });
				writeAtomic(path, bytes);
			}
			return `outputs/${sha}.txt`;
		},
		read(ref) {
			const match = OUTPUT_REF.exec(ref);
			if (!match) throw new Error(`invalid output ref: ${JSON.stringify(ref)}`);
			return readFileSync(join(dir, `${match[1]}.txt`), "utf8");
		},
	};
}

function store(runId: string, paths: RunPaths): RunStore {
	const journal = new Journal(paths.journal);
	const self: RunStore = {
		runId, paths, journal, outputs: createOutputStore(paths.outputs),
		state: () => fold(journal.read()),
		renderProgress(tasks) { writeAtomic(paths.progress, renderProgress(self.state(), tasks)); },
		writeScript(source) {
			mkdirSync(paths.scripts, { recursive: true });
			let launch = 1;
			for (const name of readdirSync(paths.scripts)) {
				const match = /^(\d+)\.js$/.exec(name);
				if (match) launch = Math.max(launch, Number(match[1]) + 1);
			}
			for (const number of self.state().launches.keys()) launch = Math.max(launch, number + 1);
			for (;; launch++) {
				const path = join(paths.scripts, `${launch}.js`);
				try {
					writeSynced(path, source, "wx");
					return { launch, path };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
		},
	};
	return self;
}

/** Creates the run layout, journals `run.started`, and renders progress.md. Does not touch git. `sessionId` is the orchestrating Pi session. */
export function createRun(commonDir: string, init: { title: string; base: string; repo: string; goal?: string; runId?: string; sessionId?: string }): RunStore {
	const runId = init.runId ?? newRunId();
	const paths = runPaths(commonDir, runId);
	mkdirSync(join(paths.dir, ".."), { recursive: true });
	mkdirSync(paths.dir); // throws if the run already exists
	mkdirSync(paths.scripts);
	mkdirSync(paths.outputs);
	syncDir(join(paths.dir, ".."));
	writeSynced(paths.goal, init.goal ?? "", "wx");
	writeSynced(paths.plan, "", "wx");
	writeSynced(paths.notes, "", "wx");
	const run = store(runId, paths);
	run.journal.append({ t: "run.started", runId, title: init.title, base: init.base, runtime: HERDER_VERSION, repo: init.repo, sessionId: init.sessionId });
	run.renderProgress();
	return run;
}

/** Throws `nothing to resume` when the run directory or journal is missing. */
export function openRun(commonDir: string, runId: string): RunStore {
	if (!isRunId(runId)) throw new Error(`nothing to resume: invalid run id ${JSON.stringify(runId)}`);
	const paths = runPaths(commonDir, runId);
	if (!existsSync(paths.dir)) throw new Error(`nothing to resume: run ${runId} does not exist`);
	if (!existsSync(paths.journal)) throw new Error(`nothing to resume: run ${runId} has no journal`);
	return store(runId, paths);
}

/** Run ids in chronological order. */
export function listRuns(commonDir: string): string[] {
	const dir = runsDir(commonDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(isRunId).sort();
}

/** The latest started run that is not delivered, abandoned, or failed, or null. Runs whose journal cannot be read are skipped and passed to `onError`. */
export function activeRun(commonDir: string, onError?: (runId: string, error: Error) => void): string | null {
	for (const runId of listRuns(commonDir).reverse()) {
		const paths = runPaths(commonDir, runId);
		if (!existsSync(paths.journal)) continue;
		let state: RunState;
		try {
			state = fold(new Journal(paths.journal).read());
		} catch (error) {
			onError?.(runId, error instanceof Error ? error : new Error(String(error)));
			continue;
		}
		if (state.runId !== undefined && !FINISHED.has(state.status)) return runId;
	}
	return null;
}
