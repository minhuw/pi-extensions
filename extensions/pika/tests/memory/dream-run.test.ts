import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDream, dreamLimits, dreamRuntime } from "../../memory/dream/index.ts";
import { type Usage, WRAP_UP } from "../../memory/dream/run.ts";
import { FakePika } from "./support/pika-server.ts";
import { batch, type FakeChild, fakeSpawner, LEASE_ID, RecordingUI, releases, renewals, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, note, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const MINUTE = 60_000;
const usage = (fields: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields });
const SOURCES = [{ sessionId: "s-past-1", seq: 7 }];
const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: SOURCES };

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
let spawner: ReturnType<typeof fakeSpawner>;
let h: Harness;

beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika);
	setCredentials(pika.url);
	resetDreams();
	spawner = fakeSpawner();
	ui = new RecordingUI();
	h = await startSession({ workspace, ui: ui.context() });
});
afterEach(async () => {
	vi.useRealTimers();
	currentDream()?.stop("aborted", "the test ended");
	await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

async function settle(check: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (check()) return true;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return check();
}
async function until(check: () => boolean, what: string): Promise<void> {
	if (!await settle(check)) throw new Error(`timed out waiting for ${what}`);
}
const quiet = () => settle(() => false, 150);

/** Starts a dream with `/memory dream` and returns its child once it has its kickoff. */
async function dream(): Promise<FakeChild> {
	await h.session.prompt("/memory dream");
	await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
	return spawner.children[0]!;
}
const commits = () => pika.requestsTo(`memory/dream/${LEASE_ID}/commit`);

describe("staging and committing", () => {
	it("dream_save and dream_forget only stage; dream_commit sends them once with the sessions it names", async () => {
		const child = await dream();
		const saved = await child.call("dream_save", { ...SAVE, reason: "seen twice" });
		expect(saved.isError).toBe(false);
		expect(saved.text).toMatch(/^Staged change 1 \(new note\) in the project scope: Pitfall — run npm ci first, with 1 source\. 1 change staged\. Nothing is written until dream_commit/);
		const forgot = await child.call("dream_forget", { id: "[cccccccccccc]", expectedRevision: 2, reason: "obsolete" });
		expect(forgot.text).toMatch(/^Staged change 2 \(forget note cccccccccccc at revision 2\)\. 2 changes staged\./);
		const updated = await child.call("dream_save", { ...SAVE, id: "dddddddddddd", expectedRevision: 3, scope: "user", category: "feedback" });
		expect(updated.text).toContain("Staged change 3 (update of note dddddddddddd at revision 3) in the user scope");
		expect(commits()).toEqual([]);
		expect(currentDream()!.staged).toHaveLength(3);

		const committed = await child.call("dream_commit", { sessions: ["s-past-1"], summary: "pitfalls from the upload fix" });
		expect(committed.isError).toBe(false);
		expect(committed.text).toContain("Committed batch batch-0001: 1 note changed, 1 session consolidated.");
		expect(committed.text).toContain("- created [aaaaaaaaaaaa] Pitfall (revision 1)");
		expect(commits()).toHaveLength(1);
		expect(commits()[0]!.body).toEqual({
			dreamSessionId: "dream-child-1", summary: "pitfalls from the upload fix", sessions: ["s-past-1"],
			changes: [
				{ op: "save", ...SAVE, reason: "seen twice" },
				{ op: "forget", id: "cccccccccccc", expectedRevision: 2, reason: "obsolete" },
				{ op: "save", ...SAVE, id: "dddddddddddd", expectedRevision: 3, scope: "user", category: "feedback" },
			],
		});
		expect(currentDream()!.staged).toEqual([]);
		// A commit that only moves checkpoints is allowed; one with nothing is refused locally.
		expect((await child.call("dream_commit", { sessions: ["s-past-1"] })).isError).toBe(false);
		expect(commits()[1]!.body).toEqual({ dreamSessionId: "dream-child-1", sessions: ["s-past-1"], changes: [] });
		expect(await child.call("dream_commit", { sessions: [] })).toMatchObject({ isError: true, text: "nothing to commit: no change is staged and no session is named." });
		expect(commits()).toHaveLength(2);

		child.finish();
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["completed"]);
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 2 batches committed, 2 notes changed.");
	});

	it("a revision conflict returns the conflicting note to the model and discards the staged changes", async () => {
		const stored = note({ id: "cccccccccccc", revision: 5, title: "Stored title", body: "Stored body" });
		serveDreams(pika, { commit: { status: 409, body: { error: "revision_conflict", note: stored, change: 1 } } });
		const child = await dream();
		await child.call("dream_save", SAVE);
		await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 2 });
		const result = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("revision_conflict: change 2 (forget of note cccccccccccc at expected revision 2) no longer matches its note.");
		expect(result.text).toContain("Note cccccccccccc is at revision 5; its current state:");
		expect(result.text).toContain("## [cccccccccccc] Stored title");
		expect(result.text).toContain("Stored body");
		expect(result.text).toContain("Nothing was written, and the 2 staged changes were discarded.");
		expect(result.details).toMatchObject({ discarded: 2, note: stored });
		expect(currentDream()!.staged).toEqual([]);
		expect(currentDream()!.ended).toBe(false);
	});

	it.each([
		["a full index", { status: 422, body: { error: "memory_full", indexBytes: 9000, indexLines: 210, limitBytes: 8192, limitLines: 200 } }, /^memory_full: .* 9000 bytes and 210 lines/],
		["a bad request", { status: 400, body: { error: "bad_request", message: "a save needs 1 to 20 sources" } }, /^the pika server refused the commit \(HTTP 400 bad_request\): a save needs 1 to 20 sources\./],
		["a server error", { status: 500, body: { error: "internal" } }, /^unexpected HTTP 500/],
	])("a commit failing with %s discards the staged changes", async (_name, answer, text) => {
		serveDreams(pika, { commit: answer });
		const child = await dream();
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: [] });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(text);
		expect(result.text).toContain("Nothing was written, and the 1 staged change was discarded.");
		expect(currentDream()!.staged).toEqual([]);
	});

	it("a commit answered lease_lost ends the dream as aborted", async () => {
		serveDreams(pika, { commit: { status: 409, body: { error: "lease_lost" } } });
		const child = await dream();
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(result.text).toMatch(/^lease_lost: this dream no longer holds its lease/);
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "lost its lease" });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
		expect((await child.call("dream_save", SAVE)).text).toBe("the dream has ended (lost its lease); nothing more can be staged.");
	});

	it("refuses saves without sources and more than 50 staged changes", async () => {
		const child = await dream();
		expect(await child.call("dream_save", { ...SAVE, sources: [] })).toMatchObject({ isError: true, text: "dream_save needs 1 to 20 sources." });
		for (let i = 0; i < 50; i++) expect((await child.call("dream_forget", { id: `n${i}`, expectedRevision: 1 })).isError).toBe(false);
		expect((await child.call("dream_save", SAVE)).text).toBe("50 changes are staged already, the most one commit takes; call dream_commit first.");
	});

	it("changes still staged when the dream ends are discarded, never committed", async () => {
		const child = await dream();
		await child.call("dream_save", SAVE);
		await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1 });
		child.finish();
		await until(() => releases(pika).length === 1, "the release");
		expect(commits()).toEqual([]);
		expect(releases(pika)).toEqual(["completed"]);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 2 });
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 0 batches committed, 0 notes changed; discarded 2 uncommitted changes.");
	});
});

describe("outcomes", () => {
	it("releases as failed when the model fails", async () => {
		const child = await dream();
		child.finish({ stopReason: "error", errorMessage: "overloaded" });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["failed"]);
		expect(ui.notes.at(-1)).toEqual({ message: "pika memory: the dream failed, its model failed: overloaded: 0 batches committed, 0 notes changed.", type: "warning" });
		expect(ui.status()).toBeUndefined();
		expect(child.shutdowns).toBe(1);
	});

	it("releases as failed when its session cannot start", async () => {
		dreamRuntime.spawn = async () => { throw new Error("no such model"); };
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["failed"]);
		expect(currentDream()).toMatchObject({ outcome: "failed", reason: "could not start its session: no such model" });
		expect(ui.status()).toBeUndefined();
	});

	it("a dream stopped while its session starts never prompts it", async () => {
		let resolve!: () => void;
		const gate = new Promise<void>((done) => { resolve = done; });
		const spawn = dreamRuntime.spawn;
		dreamRuntime.spawn = async (options) => { await gate; return spawn(options); };
		await h.session.prompt("/memory dream");
		await h.session.prompt("/memory stop");
		resolve();
		await until(() => spawner.children.length === 1 && spawner.children[0]!.shutdowns === 1, "the child's shutdown");
		expect(spawner.children[0]!.prompts).toEqual([]);
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
	});
});

describe("caps and the lease", () => {
	const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

	it("renews the lease every 5 minutes, steers a wrap-up at 7, and aborts at 10 minutes", async () => {
		fakeTimers();
		const child = await dream();
		await vi.advanceTimersByTimeAsync(5 * MINUTE - 1_000);
		await quiet();
		expect(renewals(pika)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		await until(() => renewals(pika).length === 1, "the first renewal");
		expect(renewals(pika)[0]!.body).toEqual({});
		expect(child.steers).toEqual([]);
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		expect(child.steers).toEqual([WRAP_UP]);
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1_000);
		await quiet();
		expect(currentDream()!.ended).toBe(false);
		expect(currentDream()!.lease.expiresAt).toBe("2026-11-08T10:20:00Z");
		await vi.advanceTimersByTimeAsync(1_000);
		await until(() => releases(pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "reached its 10-minute limit" });
		expect(releases(pika)).toEqual(["aborted"]);
		expect(ui.status()).toBeUndefined();
		// No renewals after the end.
		const count = renewals(pika).length;
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await quiet();
		expect(renewals(pika)).toHaveLength(count);
	});

	it("aborts when a renewal answers lease_lost, and keeps going after other failures", async () => {
		fakeTimers();
		serveDreams(pika, { renew: { status: 500, body: { error: "internal" } } });
		dreamLimits.maxMs = 60 * MINUTE;
		const child = await dream();
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		await until(() => renewals(pika).length === 1, "the first renewal");
		await quiet();
		expect(currentDream()!.ended).toBe(false);
		pika.routes.set(`POST memory/dream/${LEASE_ID}/renew`, { status: 409, body: { error: "lease_lost" } });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		await until(() => releases(pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "lost its lease" });
		expect(child.aborts).toBeGreaterThan(0);
	});

	it("steers the child to wrap up at 40 turns and aborts it at 43", async () => {
		const child = await dream();
		const turn = { type: "turn_end", toolCalls: true } as const;
		for (let i = 0; i < 39; i++) child.emit(turn);
		expect(child.steers).toEqual([]);
		child.emit(turn);
		expect(child.steers).toEqual([WRAP_UP]);
		expect(WRAP_UP).toContain("dream_commit");
		child.emit(turn);
		child.emit(turn);
		expect(currentDream()!.ended).toBe(false);
		expect(child.steers).toHaveLength(1);
		child.emit(turn);
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "reached its 43-turn limit", turns: 43 });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
		expect(child.aborts).toBeGreaterThan(0);
	});

	it("aborts past 300,000 budget tokens", async () => {
		const child = await dream();
		child.emit({ type: "usage", usage: usage({ input: 200_000 }) });
		child.emit({ type: "usage", usage: usage({ output: 50_000, cacheWrite: 40_000, cacheRead: 100_000 }) });
		expect(currentDream()).toMatchObject({ ended: false, tokens: 300_000 });
		child.emit({ type: "usage", usage: usage({ output: 1 }) });
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "used more than 300000 budget tokens", tokens: 300_001 });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
	});
});

it("only one dream runs per process", async () => {
	await dream();
	await h.session.prompt("/memory dream");
	expect(ui.notes.at(-1)!.message).toBe("pika memory: no dream: a dream is already running in this pi process; /memory stop stops it.");
	expect(pika.requestsTo("memory/dream/lease")).toHaveLength(1);
	expect(batch().id).toBe("batch-0001");
});
