import { afterEach, beforeEach, expect, it } from "vitest";
import { currentDream, dreamLimits } from "../../memory/dream/index.ts";
import { outcomeOf } from "../../memory/dream/run.ts";
import { type Answer, FakePika } from "./support/pika-server.ts";
import { batch, fakeSpawner, type FakeChild, LEASE_ID, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, note, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: [{ sessionId: "s-past-1", seq: 7 }] };
const OK: Answer = { body: { batch: batch(), index: "", indexBytes: 0, indexLines: 0 } };
const REFUSED: Answer = { status: 400, body: { error: "bad_request", message: "a source names no entry" } };
const CONFLICT: Answer = { status: 409, body: { error: "revision_conflict", note: note({ id: "aaaaaaaaaaaa", revision: 2 }), change: 0 } };

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
	currentDream()?.stop("stopped", "the test ended");
	await currentDream()?.done;
	await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) {
		if (check()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Starts a dream whose commits get `answers` in turn, the last one repeated. */
async function dream(...answers: Answer[]): Promise<FakeChild> {
	let n = 0;
	serveDreams(pika, { commit: () => answers[Math.min(n++, answers.length - 1)]! });
	const spawner = fakeSpawner();
	await h.session.prompt("/memory dream");
	await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
	return spawner.children[0]!;
}

async function commit(child: FakeChild): Promise<boolean> {
	await child.call("dream_save", SAVE);
	return !(await child.call("dream_commit", { sessions: ["s-past-1"] })).isError;
}

async function released(): Promise<string> {
	await until(() => releases(pika).length === 1, "the release");
	return releases(pika)[0]!;
}

it("a dream that finishes with every commit refused is released as failed", async () => {
	const child = await dream(REFUSED);
	expect(await commit(child)).toBe(false);
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("failed");
	expect(currentDream()).toMatchObject({ outcome: "failed", reason: "finished after a failed commit", failedCommits: 2, discarded: 2 });
	expect(ui.notes.at(-1)).toEqual({ message: "pika memory: the dream failed, finished after a failed commit: 0 batches committed, 0 notes changed; discarded 2 uncommitted changes.", type: "warning" });
});

it("a refused commit followed by one that is written finishes as completed", async () => {
	const child = await dream(CONFLICT, OK);
	expect(await commit(child)).toBe(false);
	expect(await commit(child)).toBe(true);
	child.finish();
	expect(await released()).toBe("completed");
	expect(currentDream()).toMatchObject({ outcome: "completed", reason: "finished", failedCommits: 0 });
});

it("a refused commit after a written one, left unresolved at the end, is released as aborted", async () => {
	const child = await dream(OK, REFUSED);
	expect(await commit(child)).toBe(true);
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("aborted");
	expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, finished after a failed commit: 1 batch committed, 1 note changed; discarded 1 uncommitted change.");
});

it("a commit whose outcome is still unknown at the end is a failed commit", async () => {
	const child = await dream({ status: 502, body: {} });
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("failed");
	expect(currentDream()).toMatchObject({ reason: "finished with a commit whose outcome is unknown", discarded: 0, uncertain: 1 });
});

it("a cap hit after a written batch is released as aborted", async () => {
	dreamLimits.abortTurns = 2;
	const child = await dream(OK);
	expect(await commit(child)).toBe(true);
	child.emit({ type: "turn_end", toolCalls: true });
	child.emit({ type: "turn_end", toolCalls: true });
	expect(await released()).toBe("aborted");
	expect(currentDream()).toMatchObject({ outcome: "aborted", ending: "limit", reason: "reached its 2-turn limit" });
});

it("a dream stopped by the user is aborted, whatever it wrote", async () => {
	const child = await dream(REFUSED);
	expect(await commit(child)).toBe(false);
	await h.session.prompt("/memory stop");
	expect(await released()).toBe("aborted");
});

it("a model failure is failed, even after a written batch", async () => {
	const child = await dream(OK);
	expect(await commit(child)).toBe(true);
	child.finish({ stopReason: "error", errorMessage: "overloaded" });
	expect(await released()).toBe("failed");
	expect(pika.requestsTo(`memory/dream/${LEASE_ID}/commit`)).toHaveLength(1);
});

it("maps every ending to its release outcome", () => {
	expect(outcomeOf("stopped", false, true)).toBe("aborted");
	expect(outcomeOf("failed", true, false)).toBe("failed");
	expect(outcomeOf("limit", true, true)).toBe("aborted");
	expect(outcomeOf("limit", false, false)).toBe("failed");
	expect(outcomeOf("finished", false, false)).toBe("completed");
	expect(outcomeOf("finished", true, false)).toBe("completed");
	expect(outcomeOf("finished", true, true)).toBe("aborted");
	expect(outcomeOf("finished", false, true)).toBe("failed");
});
