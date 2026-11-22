// Vitest-free test helpers shared across Herder suites and child processes.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRoles } from "../../src/agents/roles.ts";
import { baseRef, integrationRef, worktreePath } from "../../src/run/paths.ts";
import { createRun, type RunStore } from "../../src/run/store.ts";
import type { CheckSpec, JournalEvent, JournalEventType, RoleDefinition, Vcs } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import type { GitFixture } from "./git-fixture.ts";

export interface Deferred<T = void> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export interface UntilOptions {
	what?: string;
	timeoutMs?: number;
	intervalMs?: number;
}

export async function until(
	condition: () => boolean,
	optionsOrWhat?: string | number | UntilOptions,
	timeoutMs?: number,
): Promise<void> {
	const opts: UntilOptions = typeof optionsOrWhat === "string"
		? { what: optionsOrWhat, timeoutMs }
		: typeof optionsOrWhat === "number"
			? { timeoutMs: optionsOrWhat }
			: { ...optionsOrWhat, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
	const ms = opts.timeoutMs ?? (opts.what !== undefined ? 20_000 : 10_000);
	const intervalMs = opts.intervalMs ?? 5;
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(opts.what ? `timed out waiting for ${opts.what}` : `timed out waiting (${ms} ms)`);
		}
		await new Promise((done) => setTimeout(done, intervalMs));
	}
}

const NO_ROLE_OVERRIDES = join(tmpdir(), "herder-no-overrides");

/** Built-in roles only, keeping user override files out of tests without creating temp dirs. */
export function builtinRoles(): Map<string, RoleDefinition> {
	return loadRoles({ overrideDir: NO_ROLE_OVERRIDES });
}

export const RUN_ID = "20260101-000000-abcd";
export const check = (id: string, command: string, integrate = true): CheckSpec => ({ id, command, timeoutMs: 20_000, integrate });

export interface Run { fixture: GitFixture; vcs: Vcs; store: RunStore; base: string; runId: string; checks: CheckSpec[] }

/** A run on the fixture's HEAD with base and integration refs and an approved goal. */
export function setupRun(fixture: GitFixture, checks: CheckSpec[] = [], title = "Add the feature"): Run {
	const vcs = openVcs(fixture.dir);
	const base = fixture.head();
	const store = createRun(fixture.commonDir, { title, base, repo: fixture.dir, runId: RUN_ID });
	store.journal.append({ t: "goal.approved", sha256: "0".repeat(64), checks, approvedBy: "user" });
	vcs.updateRef(baseRef(RUN_ID), base, null);
	vcs.updateRef(integrationRef(RUN_ID), base, null);
	return { fixture, vcs, store, base, runId: RUN_ID, checks };
}

let slots = 0;

/** A step-like commit on `base` with `files` (null deletes), made in a disposable Herder worktree. */
export function stepCommit(run: Run, base: string, files: Record<string, string | null>, message = "herder step s-0\n\nHerder-Step: s-0\n"): string {
	const path = worktreePath(run.vcs.commonDir(), run.runId, `src${slots++}`);
	run.vcs.addWorktree(path, base);
	try {
		for (const [file, content] of Object.entries(files)) {
			if (content === null) run.fixture.git("-C", path, "rm", "-q", file);
			else {
				mkdirSync(dirname(join(path, file)), { recursive: true });
				writeFileSync(join(path, file), content);
			}
		}
		const commit = run.vcs.snapshot(path, message, base);
		if (!commit) throw new Error("stepCommit: no changes");
		return commit;
	} finally {
		run.vcs.removeWorktree(path);
	}
}

export function events<T extends JournalEventType>(store: RunStore, t: T): Extract<JournalEvent, { t: T }>[] {
	return store.journal.read().filter((event): event is Extract<JournalEvent, { t: T }> => event.t === t);
}
