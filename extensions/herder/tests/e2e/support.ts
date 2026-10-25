// End-to-end helpers: the real extension registration and runtime composition over a git fixture, driven like the
// main model drives it (commands, tool calls, and edits to goal.md/plan.md at the paths the /herder prompt names).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { PROMPT_TYPE } from "../../src/adapter/commands.ts";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { FOLLOW_UP_TYPE } from "../../src/adapter/session.ts";
import { planTasks } from "../../src/adapter/status.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { renderProgress } from "../../src/journal/render.ts";
import type { LockOptions } from "../../src/run/lock.ts";
import { refPrefix } from "../../src/run/paths.ts";
import { openRun, type RunStore } from "../../src/run/store.ts";
import { harness } from "../adapter/harness.ts";
import { FakeRunner, type FakeRule } from "../support/fake-runner.ts";
import type { GitFixture } from "../support/git-fixture.ts";

export type Session = ReturnType<typeof harness>;

export const GOAL = `# Goal: Greet the user

## Intent
Readers of the project want a greeting.

## Acceptance criteria
- AC-1: WHEN greeting.txt is read THE SYSTEM SHALL say hello. verify: check:greeting

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| greeting | grep -q hello greeting.txt | 1m | yes |

## Constraints
- Keep README.md short.

## Out of scope
- Translations.
`;

export const PLAN = `# Plan

- [ ] T1 (AC-1) Add greeting.txt
- [ ] T2 (AC-1) Mention the greeting in the README
`;

export const README = "# fixture\n\nSee greeting.txt.\n";

/** Two serial tasks with explicit ids, each integrated before the next starts. */
export const SCRIPT = `phase("implement");
const t1 = await agent("Create greeting.txt saying hello", { id: "t1", task: "T1", label: "greeting" });
if (t1.status !== "ok") return { failed: "t1", status: t1.status };
const i1 = await integrate(t1, { message: "Add greeting", task: "T1" });
if (i1.status !== "integrated") return { failed: "i1", status: i1.status };
const t2 = await agent("Document the greeting in README.md", { id: "t2", task: "T2", label: "readme" });
if (t2.status !== "ok") return { failed: "t2", status: t2.status };
const i2 = await integrate(t2, { message: "Document greeting", task: "T2" });
if (i2.status !== "integrated") return { failed: "i2", status: i2.status };
return { result: "both tasks integrated", tasks: [t1.key, t2.key] };
`;

export const VERIFIER_REPORT = { criteria: [{ id: "AC-1", status: "met", evidence: "check greeting passed" }], gaps: [], blocked: [] };

/** `hold` makes the T2 writer wait for it (or its abort) before editing. */
export function rules(hold?: Promise<unknown>): FakeRule[] {
	return [
		{ match: () => true, role: "verifier", data: VERIFIER_REPORT, text: "verified" },
		{ match: "Create greeting.txt", files: { "greeting.txt": "hello\n" }, text: "created greeting.txt" },
		{ match: "Document the greeting", files: { "README.md": README }, text: "documented", ...(hold ? { waitFor: hold } : {}) },
	];
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

const NO_OVERRIDES = join(tmpdir(), "herder-e2e-no-role-overrides");

/** A new adapter instance (as a new Pi session would load it) with the real runtime and `runner`. */
export function openSession(fixture: GitFixture, runner: FakeRunner, cleanups: Array<() => Promise<void>>, opts: { sessionId?: string; hasUI?: boolean; lock?: LockOptions } = {}): Session {
	const createRuntime = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: NO_OVERRIDES }) });
	const h = harness({ cwd: fixture.dir, sessionId: opts.sessionId ?? "session-a", hasUI: opts.hasUI ?? true, options: { createRuntime, runner: () => runner, ...(opts.lock ? { lock: opts.lock } : {}) } });
	cleanups.push(h.shutdown);
	return h;
}

export interface Started { runId: string; run: RunStore; goalPath: string; planPath: string; prompt: string }

/** `/herder <goal>`; reads the run id and artifact paths from the prompt sent to the main model. */
export async function startRun(h: Session, fixture: GitFixture, goal = "Greet the user"): Promise<Started> {
	const before = h.sent.length;
	await h.command(goal);
	const message = h.sent.slice(before).find((entry) => entry.customType === PROMPT_TYPE);
	expect(message, h.lastNotice()?.text).toBeDefined();
	const prompt = message.content as string;
	const goalPath = /^- goal\.md: (.+)$/m.exec(prompt)![1]!;
	const planPath = /^- plan\.md: (.+)$/m.exec(prompt)![1]!;
	const runId = message.details.runId as string;
	expect(goalPath.startsWith(fixture.commonDir)).toBe(true);
	return { runId, run: openRun(fixture.commonDir, runId), goalPath, planPath, prompt };
}

/** The model completes goal.md and the user approves it. */
export async function approve(h: Session, started: Started): Promise<void> {
	writeFileSync(started.goalPath, GOAL);
	await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
}

export async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
	for (const end = Date.now() + ms; !condition();) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export const followUps = (h: Session) => h.sent.filter((entry) => entry.customType === FOLLOW_UP_TYPE);

/** Launches `script` and waits for its single follow-up message. */
export async function launchAndWait(h: Session, params: Record<string, unknown> = { script: SCRIPT }): Promise<string> {
	const before = followUps(h).length;
	await h.tool("herder_workflow", { mode: "run", ...params });
	await until(() => followUps(h).length > before, "the launch follow-up");
	// Give a stray second message the chance to arrive before asserting there is exactly one.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(followUps(h)).toHaveLength(before + 1);
	return followUps(h).at(-1)!.content as string;
}

/** The checkout as delivery would find it; invariants 1 and 2 hold while it is unchanged. */
export interface Checkout { head: string; branches: string; index: string }
export const checkout = (fixture: GitFixture): Checkout => ({
	head: fixture.head(),
	branches: fixture.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"),
	index: fixture.git("ls-files", "--stage"),
});

/** Invariants 1 and 2: no write to the working tree, index, or branches, and no file in the working tree. */
export function expectUntouched(fixture: GitFixture, before: Checkout): void {
	expect(fixture.status()).toBe("");
	expect(checkout(fixture)).toEqual(before);
}

/** Invariant 9: progress.md is the runtime's rendering of the journal, and the journal is well formed. */
export function expectRuntimeViews(run: RunStore): void {
	expect(readFileSync(run.paths.progress, "utf8")).toBe(renderProgress(run.state(), planTasks(run)));
	const lines = readFileSync(run.paths.journal, "utf8").split("\n");
	expect(lines.pop()).toBe("");
	for (const line of lines) expect(JSON.parse(line)).toMatchObject({ v: 1, t: expect.any(String), at: expect.any(String) });
}

export const refsOf = (fixture: GitFixture, runId: string) => fixture.git("for-each-ref", "--format=%(refname)", `${refPrefix(runId)}/`);
export const worktrees = (fixture: GitFixture) => fixture.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));

/** No refs, no registered or leftover worktrees of the run. */
export function expectCleanedUp(fixture: GitFixture, run: RunStore): void {
	expect(refsOf(fixture, run.runId)).toBe("");
	expect(worktrees(fixture)).toEqual([`worktree ${fixture.dir}`]);
	expect(existsSync(run.paths.worktrees) ? readdirSync(run.paths.worktrees) : []).toEqual([]);
}
