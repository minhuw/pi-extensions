import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { timing } from "../../memory/client.ts";
import { currentDream } from "../../memory/dream/index.ts";
import type { CommitBody } from "../../memory/dream/run.ts";
import type { Answer, Recorded } from "../support/pika-server.ts";
import { batch, commits, dream, LEASE_ID, releases, SAVE, serveDreams, until, useDreamEnv } from "./support/dream.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTHER = { ...SAVE, title: "Preference", hook: "short commit messages" };

const env = useDreamEnv({ session: true });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bodyOf = (request: Recorded) => request.body as CommitBody;

/**
 * A commit route that writes each commitId once, as pika does: a repeated commitId gets the first answer and writes
 * nothing. `answer(n)` may delay or replace the answer to the n-th request (1-based).
 */
function idempotentCommits(answer: (n: number) => Partial<Answer> = () => ({})) {
	const written = new Map<string, Answer>();
	const record = { writes: 0, requests: 0 };
	env.pika.routes.set(`POST memory/dream/${LEASE_ID}/commit`, (request) => {
		const body = bodyOf(request);
		const n = ++record.requests;
		const extra = answer(n);
		if (extra.status && extra.status !== 200) return { status: extra.status, body: extra.body ?? {}, ...(extra.delayMs ? { delayMs: extra.delayMs } : {}) };
		const seen = written.get(body.commitId);
		if (seen) return { ...seen, ...(extra.delayMs ? { delayMs: extra.delayMs } : {}) };
		record.writes++;
		const id = `batch-${String(record.writes).padStart(4, "0")}`;
		const changes = body.changes.map((change, i) => ({ noteId: `${String(record.writes).repeat(6)}${String(i).padStart(6, "0")}`, revision: 1, action: change.op, title: change.op === "save" ? change.title : "", created: change.op === "save" && !change.id }));
		const done: Answer = { body: { batch: batch({ id, sessions: body.sessions, changes }), index: "", indexBytes: 0, indexLines: 0 } };
		written.set(body.commitId, done);
		return { ...done, ...(extra.delayMs ? { delayMs: extra.delayMs } : {}) };
	});
	return record;
}

describe("a commit without a definite answer", () => {
	it("keeps its changes staged, says the outcome is unknown, and a retry with the same commitId is written once", async () => {
		timing.httpTimeoutMs = 200;
		const server = idempotentCommits((n) => n === 1 ? { delayMs: 600 } : {});
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const first = await child.call("dream_commit", { sessions: ["s-past-1"], summary: "the upload fix" });
		expect(first.isError).toBe(true);
		expect(first.text).toMatch(/^could not reach the pika server at .*: no answer within 0\.2 s\./);
		expect(first.text).toContain("The outcome of this commit (1 change and 1 session) is unknown: the server may or may not have written it. Its 1 change is still staged, as sent.");
		expect(first.text).toContain("Call dream_commit again to retry it: that is safe");
		expect(first.text).not.toContain("Nothing was written");
		expect(first.details).toMatchObject({ unknown: true });
		expect(currentDream()!.staged).toEqual([{ op: "save", ...SAVE }]);
		expect(currentDream()!.discarded).toBe(0);
		await env.h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("1 change staged (1 from a commit whose outcome is unknown)");

		// The server wrote it after all.
		await sleep(600);
		timing.httpTimeoutMs = 15_000;
		const retry = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(retry.isError).toBe(false);
		expect(retry.text).toMatch(/^Committed batch batch-0001: 1 note changed, 1 session consolidated\./);
		expect(commits(env.pika)).toHaveLength(2);
		expect(bodyOf(commits(env.pika)[0]!).commitId).toMatch(UUID);
		// The retry is the first commit again, byte for byte.
		expect(commits(env.pika)[1]!.body).toEqual(commits(env.pika)[0]!.body);
		expect(commits(env.pika)[0]!.body).toMatchObject({ summary: "the upload fix", sessions: ["s-past-1"], changes: [{ op: "save", ...SAVE }] });
		expect(server.writes).toBe(1);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 0, failedCommits: 0 });
		expect(currentDream()!.pending).toBeUndefined();

		child.finish();
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["completed"]);
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 1 batch committed, 1 note changed.");
	});

	it.each([500, 502, 504])("treats HTTP %i as an unknown outcome", async (status) => {
		idempotentCommits((n) => n === 1 ? { status, body: { error: "upstream" } } : {});
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: [] });
		expect(result.text).toMatch(new RegExp(`^unexpected HTTP ${status} \\(upstream\\) from the pika server at .*\\. The outcome of this commit \\(1 change\\) is unknown`));
		expect(currentDream()!.staged).toHaveLength(1);
		expect(currentDream()!.discarded).toBe(0);
	});

	it("is resent as it was before the changes staged after it, which get their own commitId", async () => {
		const server = idempotentCommits((n) => n === 1 ? { status: 502, body: {} } : {});
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		expect((await child.call("dream_commit", { sessions: ["s-past-1"], summary: "first" })).details).toMatchObject({ unknown: true });
		expect((await child.call("dream_save", OTHER)).text).toMatch(/^Staged change 2 \(new note\)/);
		const result = await child.call("dream_commit", { sessions: ["s-past-1"], summary: "second" });
		expect(result.isError).toBe(false);
		expect(result.text).toMatch(/^Committed batch batch-0001: 1 note changed, 1 session consolidated\.[\s\S]*\n\nCommitted batch batch-0002: 1 note changed\./);
		expect(commits(env.pika)).toHaveLength(3);
		expect(commits(env.pika)[1]!.body).toEqual(commits(env.pika)[0]!.body);
		const last = bodyOf(commits(env.pika)[2]!);
		expect(last.commitId).toMatch(UUID);
		expect(last.commitId).not.toBe(bodyOf(commits(env.pika)[0]!).commitId);
		// The session went with the first commit; the second carries only the change staged after it.
		expect(last).toMatchObject({ summary: "second", sessions: [], changes: [{ op: "save", ...OTHER }] });
		expect(server.writes).toBe(2);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 0 });
		expect(currentDream()!.batches.map((written) => written.id)).toEqual(["batch-0001", "batch-0002"]);
	});

	it("a definite refusal of the resent commit discards only its own changes", async () => {
		idempotentCommits((n) => n === 1 ? { status: 503 } : n === 2 ? { status: 400, body: { error: "bad_request", message: "a save needs 1 to 20 sources" } } : {});
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		await child.call("dream_commit", { sessions: [] });
		await child.call("dream_save", OTHER);
		const result = await child.call("dream_commit", { sessions: [] });
		expect(result.text).toContain("Nothing was written, and the 1 staged change was discarded. 1 other staged change is still staged.");
		expect(currentDream()).toMatchObject({ staged: [{ op: "save", ...OTHER }], discarded: 1 });
		expect(currentDream()!.pending).toBeUndefined();
	});

	it("still unknown when the dream ends, it is reported as unknown, never as discarded", async () => {
		idempotentCommits(() => ({ status: 504 }));
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		await child.call("dream_save", OTHER);
		await child.call("dream_commit", { sessions: ["s-past-1"] });
		await env.h.session.prompt("/memory stop");
		await until(() => releases(env.pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", discarded: 0, uncertain: 2 });
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, stopped with /memory stop: 0 batches committed, 0 notes changed; the outcome of a commit of 2 changes is unknown, so the server may have written it.");
		await env.h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("0 batches committed, 0 notes changed, and the outcome of a commit of 2 changes is unknown.");
	});
});

describe("sessions", () => {
	it("dream_commit refuses a session the lease does not list, sends nothing, and keeps the staged changes", async () => {
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: ["s-past-1", "s-elsewhere"] });
		expect(result).toMatchObject({ isError: true, text: "s-elsewhere is not one of this dream's sessions (s-past-1). Nothing was sent, and the 1 staged change is still staged: name only sessions the task message lists, and commit again." });
		expect(commits(env.pika)).toEqual([]);
		expect(currentDream()).toMatchObject({ staged: [{ op: "save", ...SAVE }], discarded: 0, failedCommits: 0 });
		expect((await child.call("dream_commit", { sessions: ["s-past-1", "s-past-1"] })).isError).toBe(false);
		expect(commits(env.pika)[0]!.body).toMatchObject({ sessions: ["s-past-1"] });
	});
});

describe("changes staged while a commit runs", () => {
	it("dream_commit runs alone", async () => {
		const child = await dream(env);
		expect(child.tool("dream_commit").executionMode).toBe("sequential");
	});

	it("survive its refusal, and its answer says so", async () => {
		serveDreams(env.pika, { commit: { status: 400, delayMs: 300, body: { error: "bad_request", message: "nope" } } });
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		const committing = child.call("dream_commit", { sessions: [] });
		await until(() => commits(env.pika).length === 1, "the commit request");
		expect((await child.call("dream_save", OTHER)).isError).toBe(false);
		const result = await committing;
		expect(result.text).toBe("the pika server refused the commit (HTTP 400 bad_request): nope. Nothing was written, and the 1 staged change was discarded. 1 other staged change is still staged.");
		expect(currentDream()).toMatchObject({ staged: [{ op: "save", ...OTHER }], discarded: 1 });
	});

	it("never happen in a real child: an answer with dream_commit runs its tool calls one by one", async () => {
		const stagedAtCommit: number[] = [];
		const route = env.pika.routes.get(`POST memory/dream/${LEASE_ID}/commit`)!;
		env.pika.routes.set(`POST memory/dream/${LEASE_ID}/commit`, (request) => {
			stagedAtCommit.push(currentDream()!.staged.length);
			return { ...(typeof route === "function" ? route(request) : route), delayMs: 100 };
		});
		env.h.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("dream_save", SAVE)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("dream_commit", { sessions: ["s-past-1"] }), fauxToolCall("dream_save", OTHER)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("dream_commit", { sessions: [] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Saved two notes."),
		]);
		await env.h.session.prompt("/memory dream");
		await until(() => releases(env.pika).length === 1, "the release", 10_000);
		expect(stagedAtCommit).toEqual([0, 0]);
		expect(commits(env.pika).map((request) => bodyOf(request).changes)).toEqual([[{ op: "save", ...SAVE }], [{ op: "save", ...OTHER }]]);
		expect(releases(env.pika)).toEqual(["completed"]);
	});
});

describe("a commit in flight when the dream is stopped", () => {
	it("is not aborted: its batch is recorded, never counted as discarded, and the lease is released after its answer", async () => {
		serveDreams(env.pika, { commit: { delayMs: 400, body: { batch: batch(), index: "", indexBytes: 0, indexLines: 0 } } });
		let batchesAtRelease: number | undefined;
		const release = env.pika.routes.get(`POST memory/dream/${LEASE_ID}/release`)!;
		env.pika.routes.set(`POST memory/dream/${LEASE_ID}/release`, (request) => {
			batchesAtRelease = currentDream()?.batches.length;
			return typeof release === "function" ? release(request) : release;
		});
		const child = await dream(env);
		await child.call("dream_save", SAVE);
		// The real child aborts its running tools' signal when it is aborted.
		const signal = new AbortController();
		const pending = child.tool("dream_commit").execute("call-1", { sessions: ["s-past-1"] }, signal.signal, undefined, undefined as never);
		await until(() => commits(env.pika).length === 1, "the commit request");
		await env.h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		signal.abort();
		expect(currentDream()).toMatchObject({ ended: true });
		expect(currentDream()!.outcome).toBeUndefined();
		await env.h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("Dream of my-project (manual) stopping, the user sent a message: waiting for its commit's answer.");
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toMatch(/^Committed batch batch-0001/);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(batchesAtRelease).toBe(1);
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ outcome: "aborted", discarded: 0, reason: "the user sent a message" });
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, the user sent a message: 1 batch committed, 1 note changed.");
	});
});
