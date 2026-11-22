import { expect, it } from "vitest";
import { currentDream } from "../../memory/dream/index.ts";
import { dreamLimits, outcomeOf } from "../../memory/dream/run.ts";
import type { Answer } from "../support/pika-server.ts";
import { batch, dream, type FakeChild, LEASE_ID, releases, SAVE, until, useDreamEnv } from "./support/dream.ts";
import { note } from "./support/runtime.ts";

const OK: Answer = { body: { batch: batch(), index: "", indexBytes: 0, indexLines: 0 } };
const REFUSED: Answer = { status: 400, body: { error: "bad_request", message: "a source names no entry" } };
const CONFLICT: Answer = { status: 409, body: { error: "revision_conflict", note: note({ id: "aaaaaaaaaaaa", revision: 2 }), change: 0 } };

const env = useDreamEnv({ session: true });

async function commit(child: FakeChild): Promise<boolean> {
	await child.call("dream_save", SAVE);
	return !(await child.call("dream_commit", { sessions: ["s-past-1"] })).isError;
}

async function released(): Promise<string> {
	await until(() => releases(env.pika).length === 1, "the release");
	return releases(env.pika)[0]!;
}

it("a dream that finishes with every commit refused is released as failed", async () => {
	const child = await dream(env, { answers: [REFUSED] });
	expect(await commit(child)).toBe(false);
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("failed");
	expect(currentDream()).toMatchObject({ outcome: "failed", reason: "finished after a failed commit", failedCommits: 2, discarded: 2 });
	expect(env.ui.notes.at(-1)).toEqual({ message: "pika memory: the dream failed, finished after a failed commit: 0 batches committed, 0 notes changed; discarded 2 uncommitted changes.", type: "warning" });
});

it("a refused commit followed by one that is written finishes as completed", async () => {
	const child = await dream(env, { answers: [CONFLICT, OK] });
	expect(await commit(child)).toBe(false);
	expect(await commit(child)).toBe(true);
	child.finish();
	expect(await released()).toBe("completed");
	expect(currentDream()).toMatchObject({ outcome: "completed", reason: "finished", failedCommits: 0 });
});

it("a refused commit after a written one, left unresolved at the end, is released as aborted", async () => {
	const child = await dream(env, { answers: [OK, REFUSED] });
	expect(await commit(child)).toBe(true);
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("aborted");
	expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, finished after a failed commit: 1 batch committed, 1 note changed; discarded 1 uncommitted change.");
});

it("a commit whose outcome is still unknown at the end is a failed commit", async () => {
	const child = await dream(env, { answers: [{ status: 502, body: {} }] });
	expect(await commit(child)).toBe(false);
	child.finish();
	expect(await released()).toBe("failed");
	expect(currentDream()).toMatchObject({ reason: "finished with a commit whose outcome is unknown", discarded: 0, uncertain: 1 });
});

it("a cap hit after a written batch is released as aborted", async () => {
	dreamLimits.abortTurns = 2;
	const child = await dream(env, { answers: [OK] });
	expect(await commit(child)).toBe(true);
	child.emit({ type: "turn_end", toolCalls: true });
	child.emit({ type: "turn_end", toolCalls: true });
	expect(await released()).toBe("aborted");
	expect(currentDream()).toMatchObject({ outcome: "aborted", ending: "limit", reason: "reached its 2-turn limit" });
});

it("a dream stopped by the user is aborted, whatever it wrote", async () => {
	const child = await dream(env, { answers: [REFUSED] });
	expect(await commit(child)).toBe(false);
	await env.h.session.prompt("/memory stop");
	expect(await released()).toBe("aborted");
});

it("a model failure is failed, even after a written batch", async () => {
	const child = await dream(env, { answers: [OK] });
	expect(await commit(child)).toBe(true);
	child.finish({ stopReason: "error", errorMessage: "overloaded" });
	expect(await released()).toBe("failed");
	expect(env.pika.requestsTo(`memory/dream/${LEASE_ID}/commit`)).toHaveLength(1);
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
