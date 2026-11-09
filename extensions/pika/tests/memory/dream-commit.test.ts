import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { timing } from "../../memory/client.ts";
import { currentDream } from "../../memory/dream/index.ts";
import type { CommitBody } from "../../memory/dream/run.ts";
import { type Answer, FakePika, type Recorded } from "./support/pika-server.ts";
import { batch, fakeSpawner, type FakeChild, LEASE_ID, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES = [{ sessionId: "s-past-1", seq: 7 }];
const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: SOURCES };
const OTHER = { ...SAVE, title: "Preference", hook: "short commit messages" };

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
let h: Harness;

beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika);
	setCredentials(pika.url);
	resetDreams();
	ui = new RecordingUI();
	h = await startSession({ workspace, ui: ui.context() });
});
afterEach(async () => {
	vi.useRealTimers();
	currentDream()?.stop("stopped", "the test ended");
	await currentDream()?.done;
	await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (check()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`timed out waiting for ${what}`);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const commits = () => pika.requestsTo(`memory/dream/${LEASE_ID}/commit`);
const bodyOf = (request: Recorded) => request.body as CommitBody;

async function dream(): Promise<FakeChild> {
	const spawner = fakeSpawner();
	await h.session.prompt("/memory dream");
	await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
	return spawner.children[0]!;
}

/**
 * A commit route that writes each commitId once, as pika does: a repeated commitId gets the first answer and writes
 * nothing. `answer(n)` may delay or replace the answer to the n-th request (1-based).
 */
function idempotentCommits(answer: (n: number) => Partial<Answer> = () => ({})) {
	const written = new Map<string, Answer>();
	const record = { writes: 0, requests: 0 };
	pika.routes.set(`POST memory/dream/${LEASE_ID}/commit`, (request) => {
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
		const child = await dream();
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
		await h.session.prompt("/memory status");
		expect(ui.notes.at(-1)!.message).toContain("1 change staged (1 from a commit whose outcome is unknown)");

		// The server wrote it after all.
		await sleep(600);
		timing.httpTimeoutMs = 15_000;
		const retry = await child.call("dream_commit", { sessions: ["s-past-1"] });
		expect(retry.isError).toBe(false);
		expect(retry.text).toMatch(/^Committed batch batch-0001: 1 note changed, 1 session consolidated\./);
		expect(commits()).toHaveLength(2);
		expect(bodyOf(commits()[0]!).commitId).toMatch(UUID);
		// The retry is the first commit again, byte for byte.
		expect(commits()[1]!.body).toEqual(commits()[0]!.body);
		expect(commits()[0]!.body).toMatchObject({ summary: "the upload fix", sessions: ["s-past-1"], changes: [{ op: "save", ...SAVE }] });
		expect(server.writes).toBe(1);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 0, failedCommits: 0 });
		expect(currentDream()!.pending).toBeUndefined();

		child.finish();
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["completed"]);
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream finished: 1 batch committed, 1 note changed.");
	});

	it.each([500, 502, 504])("treats HTTP %i as an unknown outcome", async (status) => {
		idempotentCommits((n) => n === 1 ? { status, body: { error: "upstream" } } : {});
		const child = await dream();
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: [] });
		expect(result.text).toMatch(new RegExp(`^unexpected HTTP ${status} \\(upstream\\) from the pika server at .*\\. The outcome of this commit \\(1 change\\) is unknown`));
		expect(currentDream()!.staged).toHaveLength(1);
		expect(currentDream()!.discarded).toBe(0);
	});

	it("is resent as it was before the changes staged after it, which get their own commitId", async () => {
		const server = idempotentCommits((n) => n === 1 ? { status: 502, body: {} } : {});
		const child = await dream();
		await child.call("dream_save", SAVE);
		expect((await child.call("dream_commit", { sessions: ["s-past-1"], summary: "first" })).details).toMatchObject({ unknown: true });
		expect((await child.call("dream_save", OTHER)).text).toMatch(/^Staged change 2 \(new note\)/);
		const result = await child.call("dream_commit", { sessions: ["s-past-1"], summary: "second" });
		expect(result.isError).toBe(false);
		expect(result.text).toMatch(/^Committed batch batch-0001: 1 note changed, 1 session consolidated\.[\s\S]*\n\nCommitted batch batch-0002: 1 note changed\./);
		expect(commits()).toHaveLength(3);
		expect(commits()[1]!.body).toEqual(commits()[0]!.body);
		const last = bodyOf(commits()[2]!);
		expect(last.commitId).toMatch(UUID);
		expect(last.commitId).not.toBe(bodyOf(commits()[0]!).commitId);
		// The session went with the first commit; the second carries only the change staged after it.
		expect(last).toMatchObject({ summary: "second", sessions: [], changes: [{ op: "save", ...OTHER }] });
		expect(server.writes).toBe(2);
		expect(currentDream()).toMatchObject({ staged: [], discarded: 0 });
		expect(currentDream()!.batches.map((written) => written.id)).toEqual(["batch-0001", "batch-0002"]);
	});

	it("a definite refusal of the resent commit discards only its own changes", async () => {
		idempotentCommits((n) => n === 1 ? { status: 503 } : n === 2 ? { status: 400, body: { error: "bad_request", message: "a save needs 1 to 20 sources" } } : {});
		const child = await dream();
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
		const child = await dream();
		await child.call("dream_save", SAVE);
		await child.call("dream_save", OTHER);
		await child.call("dream_commit", { sessions: ["s-past-1"] });
		await h.session.prompt("/memory stop");
		await until(() => releases(pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", discarded: 0, uncertain: 2 });
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, stopped with /memory stop: 0 batches committed, 0 notes changed; the outcome of a commit of 2 changes is unknown, so the server may have written it.");
		await h.session.prompt("/memory status");
		expect(ui.notes.at(-1)!.message).toContain("0 batches committed, 0 notes changed, and the outcome of a commit of 2 changes is unknown.");
	});
});

describe("sessions", () => {
	it("dream_commit refuses a session the lease does not list, sends nothing, and keeps the staged changes", async () => {
		const child = await dream();
		await child.call("dream_save", SAVE);
		const result = await child.call("dream_commit", { sessions: ["s-past-1", "s-elsewhere"] });
		expect(result).toMatchObject({ isError: true, text: "s-elsewhere is not one of this dream's sessions (s-past-1). Nothing was sent, and the 1 staged change is still staged: name only sessions the task message lists, and commit again." });
		expect(commits()).toEqual([]);
		expect(currentDream()).toMatchObject({ staged: [{ op: "save", ...SAVE }], discarded: 0, failedCommits: 0 });
		expect((await child.call("dream_commit", { sessions: ["s-past-1", "s-past-1"] })).isError).toBe(false);
		expect(commits()[0]!.body).toMatchObject({ sessions: ["s-past-1"] });
	});
});

describe("changes staged while a commit runs", () => {
	it("dream_commit runs alone", async () => {
		const child = await dream();
		expect(child.tool("dream_commit").executionMode).toBe("sequential");
	});

	it("survive its refusal, and its answer says so", async () => {
		serveDreams(pika, { commit: { status: 400, delayMs: 300, body: { error: "bad_request", message: "nope" } } });
		const child = await dream();
		await child.call("dream_save", SAVE);
		const committing = child.call("dream_commit", { sessions: [] });
		await until(() => commits().length === 1, "the commit request");
		expect((await child.call("dream_save", OTHER)).isError).toBe(false);
		const result = await committing;
		expect(result.text).toBe("the pika server refused the commit (HTTP 400 bad_request): nope. Nothing was written, and the 1 staged change was discarded. 1 other staged change is still staged.");
		expect(currentDream()).toMatchObject({ staged: [{ op: "save", ...OTHER }], discarded: 1 });
	});

	it("never happen in a real child: an answer with dream_commit runs its tool calls one by one", async () => {
		const stagedAtCommit: number[] = [];
		const route = pika.routes.get(`POST memory/dream/${LEASE_ID}/commit`)!;
		pika.routes.set(`POST memory/dream/${LEASE_ID}/commit`, (request) => {
			stagedAtCommit.push(currentDream()!.staged.length);
			return { ...(typeof route === "function" ? route(request) : route), delayMs: 100 };
		});
		h.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("dream_save", SAVE)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("dream_commit", { sessions: ["s-past-1"] }), fauxToolCall("dream_save", OTHER)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("dream_commit", { sessions: [] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Saved two notes."),
		]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release", 10_000);
		expect(stagedAtCommit).toEqual([0, 0]);
		expect(commits().map((request) => bodyOf(request).changes)).toEqual([[{ op: "save", ...SAVE }], [{ op: "save", ...OTHER }]]);
		expect(releases(pika)).toEqual(["completed"]);
	});
});

describe("a commit in flight when the dream is stopped", () => {
	it("is not aborted: its batch is recorded, never counted as discarded, and the lease is released after its answer", async () => {
		serveDreams(pika, { commit: { delayMs: 400, body: { batch: batch(), index: "", indexBytes: 0, indexLines: 0 } } });
		let batchesAtRelease: number | undefined;
		const release = pika.routes.get(`POST memory/dream/${LEASE_ID}/release`)!;
		pika.routes.set(`POST memory/dream/${LEASE_ID}/release`, (request) => {
			batchesAtRelease = currentDream()?.batches.length;
			return typeof release === "function" ? release(request) : release;
		});
		const child = await dream();
		await child.call("dream_save", SAVE);
		// The real child aborts its running tools' signal when it is aborted.
		const signal = new AbortController();
		const pending = child.tool("dream_commit").execute("call-1", { sessions: ["s-past-1"] }, signal.signal, undefined, undefined as never);
		await until(() => commits().length === 1, "the commit request");
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		signal.abort();
		expect(currentDream()).toMatchObject({ ended: true });
		expect(currentDream()!.outcome).toBeUndefined();
		await h.session.prompt("/memory status");
		expect(ui.notes.at(-1)!.message).toContain("Dream of my-project (manual) stopping, the user sent a message: waiting for its commit's answer.");
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toMatch(/^Committed batch batch-0001/);
		await until(() => releases(pika).length === 1, "the release");
		expect(batchesAtRelease).toBe(1);
		expect(releases(pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ outcome: "aborted", discarded: 0, reason: "the user sent a message" });
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, the user sent a message: 1 batch committed, 1 note changed.");
	});
});
