import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { baseRef, integrationRef, worktreePath } from "../../src/run/paths.ts";
import { createRun, type RunStore } from "../../src/run/store.ts";
import type { CheckSpec, JournalEvent, JournalEventType, Vcs } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import type { GitFixture } from "../support/git-fixture.ts";

/** The Vcs inherits process.env; isolate it from the developer's global and system git configuration. */
export function isolateGitConfig(): void {
	const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
	beforeAll(() => {
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
	});
	afterAll(() => {
		for (const [name, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
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

/** Contents of `file` at `commit`. */
export const show = (run: Run, commit: string, file: string) => run.fixture.git("show", `${commit}:${file}`);
