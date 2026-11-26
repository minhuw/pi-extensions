import { describe, expect, it, vi } from "vitest";
import { currentDream, dreamRuntime } from "../../memory/dream/index.ts";
import { dreamLimits, type Usage, WRAP_UP } from "../../memory/dream/run.ts";
import { batch, commits, dream, fakeTimers, LEASE_ID, releases, renewals, SAVE, serveDreams, settle, until, useDreamEnv } from "./support/dream.ts";
import { note } from "./support/runtime.ts";

const MINUTE = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usage = (fields: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields });

const env = useDreamEnv({ session: true, spawner: true });

describe("staging and committing", () => {
	it("dream_save and dream_forget only stage; dream_commit sends them once with the sessions it names", async () => {
		const child = await dream(env);
		const saved = await child.call("dream_save", { ...SAVE, reason: "seen twice" });
		expect(saved.isError).toBe(false);
		expect(saved.text).toMatch(/^Staged change 1 \(new note\) in the project scope: Pitfall — run npm ci first, with 1 source\. 1 change staged\. Nothing is written until dream_commit/);
		const forgot = await child.call("dream_forget", { id: "[cccccccccccc]", expectedRevision: 2, reason: "obsolete" });
		expect(forgot.text).toMatch(/^Staged change 2 \(forget note cccccccccccc at revision 2\)\. 2 changes staged\./);
		const updated = await child.call("dream_save", { ...SAVE, id: "dddddddddddd", expectedRevision: 3, scope: "user", category: "feedback" });
		expect(updated.text).toContain("Staged change 3 (update of note dddddddddddd at revision 3) in the user scope");
		expect(commits(env.pika)).toEqual([]);
		expect(currentDream()!.staged).toHaveLength(3);

		const committed = await child.call("dream_commit", { sessions: ["s-past-1"], summary: "pitfalls from the upload fix" });
		expect(committed.isError).toBe(false);
		expect(committed.text).toContain("Committed batch batch-0001: 1 note changed, 1 session consolidated.");
		expect(committed.text).toContain("- created [aaaaaaaaaaaa] Pitfall (revision 1)");
		expect(commits(env.pika)).toHaveLength(1);
		expect(commits(env.pika)[0]!.body).toEqual({
			commitId: expect.stringMatching(UUID), dreamSessionId: "dream-child-1", summary: "pitfalls from the upload fix", sessions: ["s-past-1"],
			changes: [
				{ op: "save", ...SAVE, reason: "seen twice" },
				{ op: "forget", id: "cccccccccccc", expectedRevision: 2, reason: "obsolete" },
				{ op: "save", ...SAVE, id: "dddddddddddd", expectedRevision: 3, scope: "user", category: "feedback" },
			],
		});
		expect(currentDream()!.staged).toEqual([]);
		// A commit that only moves checkpoints is allowed; one with nothing is refused locally.
		expect((await child.call("dream_commit", { sessions: ["s-past-1"] })).isError).toBe(false);
		expect(commits(env.pika)[1]!.body).toEqual({ commitId: expect.stringMatching(UUID), dreamSessionId: "dream-child-1", sessions: ["s-past-1"], changes: [] });
		// Every commit has its own id.
		expect((commits(env.pika)[1]!.body as { commitId: string }).commitId).not.toBe((commits(env.pika)[0]!.body as { commitId: string }).commitId);
		expect(await child.call("dream_commit", { sessions: [] })).toMatchObject({ isError: true, text: "nothing to commit: no change is staged and no session is named." });
		expect(commits(env.pika)).toHaveLength(2);

		child.finish();
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["completed"]);
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 2 batches committed, 2 notes changed.");
	});

	it("dream_save forwards optional tier (e.g. archival) into staged changes and dream_commit payload", async () => {
		const child = await dream(env);
		const archived = await child.call("dream_save", { ...SAVE, tier: "archival", reason: "cold reference" });
		expect(archived.isError).toBe(false);
		expect(archived.text).toMatch(/^Staged change 1 \(new note \[archival\]\) in the project scope: Pitfall — run npm ci first, with 1 source\./);
		const demoted = await child.call("dream_save", { ...SAVE, id: "dddddddddddd", expectedRevision: 3, tier: "archival" });
		expect(demoted.isError).toBe(false);
		expect(demoted.text).toContain("Staged change 2 (update of note dddddddddddd at revision 3 [archival]) in the project scope");
		expect(currentDream()!.staged).toEqual([
			{ op: "save", ...SAVE, tier: "archival", reason: "cold reference" },
			{ op: "save", ...SAVE, id: "dddddddddddd", expectedRevision: 3, tier: "archival" },
		]);

		const committed = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(committed.isError).toBe(false);
		expect(commits(env.pika)[0]!.body).toMatchObject({
			changes: [
				{ op: "save", ...SAVE, tier: "archival", reason: "cold reference" },
				{ op: "save", ...SAVE, id: "dddddddddddd", expectedRevision: 3, tier: "archival" },
			],
		});
		child.finish();
		await until(() => releases(env.pika).length === 1, "the release");
	});

	it("rejects dream_save tier: archival before staging and omits archival kickoff guidance on a v25 server without tiers: true", async () => {
		const child = await dream(env, { memory: { body: { scopes: [], notes: [], index: "" } } });
		expect(child.prompts[0]).not.toContain("archival");
		const rejected = await child.call("dream_save", { ...SAVE, tier: "archival" });
		expect(rejected).toMatchObject({
			isError: true,
			text: "This pika server does not support tier \"archival\". Keep the note pinned or forget it instead.",
			details: { staged: 0, error: "This pika server does not support tier \"archival\". Keep the note pinned or forget it instead." },
		});
		expect(currentDream()!.staged).toEqual([]);
		// Normal pinned / omitted-tier saves still stage cleanly on v25 servers.
		const ok = await child.call("dream_save", SAVE);
		expect(ok.isError).toBe(false);
		expect(currentDream()!.staged).toHaveLength(1);
	});

	it("a revision conflict returns the conflicting note to the model and discards the staged changes", async () => {
		const stored = note({ id: "cccccccccccc", revision: 5, title: "Stored title", body: "Stored body" });
		serveDreams(env.pika, { commit: { status: 409, body: { error: "revision_conflict", note: stored, change: 1 } } });
		const child = await dream(env);
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
		["a full user scope", { status: 422, body: { error: "memory_full", budget: "per_scope", indexBytes: 9000, indexLines: 210, limitBytes: 8192, limitLines: 200, project: null } }, /^memory_full: with this note the user scope's memory index alone would be 9000 bytes and 210 lines, over its independent limit of 8192 bytes and 200 lines\. Do not downgrade a user-wide rule into the project scope/],
		["a bad request", { status: 400, body: { error: "bad_request", message: "a save needs 1 to 20 sources" } }, /^the pika server refused the commit \(HTTP 400 bad_request\): a save needs 1 to 20 sources\./],
	])("a commit failing with %s discards the staged changes", async (_name, answer, text) => {
		serveDreams(env.pika, { commit: answer });
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: [] });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(text);
		expect(result.text).toContain("Nothing was written, and the 1 staged change was discarded.");
		expect(currentDream()!.staged).toEqual([]);
	});

	it("a commit answered lease_lost ends the dream as aborted", async () => {
		serveDreams(env.pika, { commit: { status: 409, body: { error: "lease_lost" } } });
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(result.text).toMatch(/^lease_lost: this dream no longer holds its lease/);
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "lost its lease" });
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect((await child.call("dream_save", SAVE)).text).toBe("the dream has ended (lost its lease); nothing more can be staged.");
	});

	it("refuses saves without sources and more than 50 staged changes", async () => {
		const child = await dream(env);
		expect(await child.call("dream_save", { ...SAVE, sources: [] })).toMatchObject({ isError: true, text: "dream_save needs 1 to 20 sources." });
		for (let i = 0; i < 50; i++) expect((await child.call("dream_forget", { id: `n${i}`, expectedRevision: 1 })).isError).toBe(false);
		expect((await child.call("dream_save", SAVE)).text).toBe("50 changes are staged already, the most one commit takes; call dream_commit first.");
	});

	it("changes still staged when the dream ends are discarded, never committed", async () => {
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1 });
		child.finish();
		await until(() => releases(env.pika).length === 1, "the release");
		expect(commits(env.pika)).toEqual([]);
		expect(releases(env.pika)).toEqual(["completed"]);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 2 });
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 0 batches committed, 0 notes changed; discarded 2 uncommitted changes.");
	});
});

describe("outcomes", () => {
	it("releases as failed when the model fails", async () => {
		const child = await dream(env);
		child.finish({ stopReason: "error", errorMessage: "overloaded" });
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(env.ui.notes.at(-1)).toEqual({ message: "pika memory: the dream failed, its model failed: overloaded: 0 batches committed, 0 notes changed.", type: "warning" });
		expect(env.ui.status()).toBeUndefined();
		expect(child.shutdowns).toBe(1);
	});

	it("releases as failed when its session cannot start", async () => {
		dreamRuntime.spawn = async () => { throw new Error("no such model"); };
		await env.h.session.prompt("/memory dream");
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(currentDream()).toMatchObject({ outcome: "failed", reason: "could not start its session: no such model" });
		expect(env.ui.status()).toBeUndefined();
	});

	it("a dream stopped while its session starts never prompts it", async () => {
		let resolve!: () => void;
		const gate = new Promise<void>((done) => { resolve = done; });
		const spawn = dreamRuntime.spawn;
		dreamRuntime.spawn = async (options) => { await gate; return spawn(options); };
		await env.h.session.prompt("/memory dream");
		await env.h.session.prompt("/memory stop");
		resolve();
		await until(() => env.spawner.children.length === 1 && env.spawner.children[0]!.shutdowns === 1, "the child's shutdown");
		expect(env.spawner.children[0]!.prompts).toEqual([]);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
	});
});

describe("caps and the lease", () => {
	it("renews the lease every 5 minutes, steers a wrap-up at 7, and stops at 10 minutes, released as failed with nothing committed", async () => {
		fakeTimers();
		const child = await dream(env);
		await vi.advanceTimersByTimeAsync(5 * MINUTE - 1_000);
		await settle();
		expect(renewals(env.pika)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		await until(() => renewals(env.pika).length === 1, "the first renewal");
		expect(renewals(env.pika)[0]!.body).toEqual({});
		expect(child.steers).toEqual([]);
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		expect(child.steers).toEqual([WRAP_UP]);
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1_000);
		await settle();
		expect(currentDream()!.ended).toBe(false);
		expect(currentDream()!.lease.expiresAt).toBe("2026-11-08T10:20:00Z");
		await vi.advanceTimersByTimeAsync(1_000);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "failed", reason: "reached its 10-minute limit" });
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(env.ui.status()).toBeUndefined();
		// No renewals after the end.
		const count = renewals(env.pika).length;
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await settle();
		expect(renewals(env.pika)).toHaveLength(count);
	});

	it("aborts when a renewal answers lease_lost, and keeps going after other failures", async () => {
		fakeTimers();
		serveDreams(env.pika, { renew: { status: 500, body: { error: "internal" } } });
		dreamLimits.maxMs = 60 * MINUTE;
		const child = await dream(env);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		await until(() => renewals(env.pika).length === 1, "the first renewal");
		await settle();
		expect(currentDream()!.ended).toBe(false);
		env.pika.routes.set(`POST memory/dream/${LEASE_ID}/renew`, { status: 409, body: { error: "lease_lost" } });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "lost its lease" });
		expect(child.aborts).toBeGreaterThan(0);
	});

	it("steers the child to wrap up at 40 turns and aborts it at 43, released as failed with nothing committed", async () => {
		const child = await dream(env);
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
		expect(currentDream()).toMatchObject({ ended: true, outcome: "failed", reason: "reached its 43-turn limit", turns: 43 });
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(child.aborts).toBeGreaterThan(0);
	});

	it("aborts past 300,000 budget tokens, released as failed when nothing was committed", async () => {
		const child = await dream(env);
		child.emit({ type: "usage", usage: usage({ input: 200_000 }) });
		child.emit({ type: "usage", usage: usage({ output: 50_000, cacheWrite: 40_000, cacheRead: 100_000 }) });
		expect(currentDream()).toMatchObject({ ended: false, tokens: 300_000 });
		child.emit({ type: "usage", usage: usage({ output: 1 }) });
		expect(currentDream()).toMatchObject({ ended: true, outcome: "failed", reason: "used more than 300000 budget tokens", tokens: 300_001 });
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["failed"]);
	});
});

it("only one dream runs per process", async () => {
	await dream(env);
	await env.h.session.prompt("/memory dream");
	expect(env.ui.notes.at(-1)!.message).toBe("pika memory: no dream: a dream is already running in this pi process; /memory stop stops it.");
	expect(env.pika.requestsTo("memory/dream/lease")).toHaveLength(1);
	expect(batch().id).toBe("batch-0001");
});
