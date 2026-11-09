import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { currentDream, dreamLimits } from "../../memory/dream/index.ts";
import { type Usage, WRAP_UP } from "../../memory/dream/run.ts";
import { FakePika } from "./support/pika-server.ts";
import { fakeSpawner, type FakeChild, LEASE_ID, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const MINUTE = 60_000;
const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: [{ sessionId: "s-past-1", seq: 7 }] };
const usage = (fields: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields });
const TOOL_TURN = { type: "turn_end", toolCalls: true } as const;

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
	currentDream()?.stop("aborted", "the test ended");
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

async function fakeDream(): Promise<FakeChild> {
	const spawner = fakeSpawner();
	await h.session.prompt("/memory dream");
	await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
	return spawner.children[0]!;
}

describe("the token budget", () => {
	it("a dream whose calls re-read a growing cached context runs on, and is told to wrap up once that context passes 120,000 tokens", async () => {
		const child = await fakeDream();
		// Each call re-reads everything before it from the cache: a plain sum passes 300,000 tokens at the sixth call.
		const call = (i: number) => usage({ input: 1_000, output: 1_500, cacheWrite: 4_000, cacheRead: 14_000 * i });
		for (let i = 1; i <= 8; i++) {
			child.emit({ type: "usage", usage: call(i) });
			child.emit(TOOL_TURN);
		}
		expect(currentDream()).toMatchObject({ ended: false, turns: 8, tokens: 8 * 6_500 + 1_400 * 36, context: 117_000 });
		expect(child.steers).toEqual([]);
		child.emit({ type: "usage", usage: call(9) });
		child.emit(TOOL_TURN);
		expect(child.steers).toEqual([WRAP_UP]);
		child.emit({ type: "usage", usage: call(10) });
		child.emit(TOOL_TURN);
		expect(child.steers).toEqual([WRAP_UP]);
		expect(currentDream()).toMatchObject({ ended: false, tokens: 10 * 6_500 + 1_400 * 55, usage: { input: 10_000, output: 15_000, cacheWrite: 40_000, cacheRead: 14_000 * 55 } });
		await h.session.prompt("/memory status");
		expect(ui.notes.at(-1)!.message).toContain("10 of 43 turns, 142000 of 300000 budget tokens");
		expect(ui.notes.at(-1)!.message).toContain("Tokens: 10000 input, 15000 output, 770000 cache read, 40000 cache write; budget tokens count cache reads at a tenth; the latest context had 145000.");
	});

	it("steers a wrap-up once at 70% of the budget tokens, at the next turn that calls tools", async () => {
		const child = await fakeDream();
		// Output only, so the context stays small.
		child.emit({ type: "usage", usage: usage({ output: 209_999 }) });
		child.emit(TOOL_TURN);
		expect(child.steers).toEqual([]);
		child.emit({ type: "usage", usage: usage({ output: 1 }) });
		expect(child.steers).toEqual([]);
		child.emit(TOOL_TURN);
		expect(child.steers).toEqual([WRAP_UP]);
		child.emit({ type: "usage", usage: usage({ output: 10 }) });
		child.emit(TOOL_TURN);
		expect(child.steers).toEqual([WRAP_UP]);
		expect(WRAP_UP).toMatch(/limits \(turns, tokens, context, or time\)/);
	});

	it("does not steer a final answer, which ends the dream anyway", async () => {
		const child = await fakeDream();
		child.emit({ type: "usage", usage: usage({ input: 250_000 }) });
		child.emit({ type: "turn_end", toolCalls: false });
		expect(child.steers).toEqual([]);
		child.finish();
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["completed"]);
	});
});

describe("the time limit", () => {
	it("steers a wrap-up at 7 of its 10 minutes, so a commit after it is kept, before the cap stops the dream", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const child = await fakeDream();
		await child.call("dream_save", SAVE);
		await vi.advanceTimersByTimeAsync(7 * MINUTE - 1_000);
		expect(child.steers).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(child.steers).toEqual([WRAP_UP]);
		expect((await child.call("dream_commit", { sessions: ["s-past-1"] })).isError).toBe(false);
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		await until(() => releases(pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "reached its 10-minute limit", discarded: 0 });
		expect(currentDream()!.batches).toHaveLength(1);
		expect(releases(pika)).toEqual(["aborted"]);
	});
});

describe("the turn limit", () => {
	it("a final answer on the last allowed turn finishes the dream; a turn after it is stopped at its start", async () => {
		dreamLimits.abortTurns = 3;
		const child = await fakeDream();
		child.emit(TOOL_TURN);
		child.emit(TOOL_TURN);
		child.emit({ type: "turn_end", toolCalls: false });
		expect(currentDream()).toMatchObject({ ended: false, turns: 3 });
		// Something (a queued steer) keeps the child going after all.
		child.emit({ type: "turn_start" });
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "reached its 3-turn limit" });
	});

	it("a real child whose final answer lands on the last allowed turn is released as completed", async () => {
		dreamLimits.wrapUpTurns = 100;
		dreamLimits.abortTurns = 3;
		const ls = () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
		h.faux.appendResponses([ls(), ls(), fauxAssistantMessage("All done; nothing to keep.")]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release", 10_000);
		await currentDream()!.done;
		expect(currentDream()).toMatchObject({ outcome: "completed", reason: "finished", turns: 3 });
		expect(releases(pika)).toEqual(["completed"]);
	});

	it("answers that failed and were retried are no turns", async () => {
		await writeFile(join(workspace.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }));
		dreamLimits.wrapUpTurns = 100;
		dreamLimits.abortTurns = 3;
		const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
		h.faux.appendResponses([overloaded(), overloaded(), fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }), fauxAssistantMessage("Nothing to keep.")]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release", 10_000);
		await currentDream()!.done;
		expect(h.faux.getPendingResponseCount()).toBe(0);
		expect(currentDream()).toMatchObject({ outcome: "completed", turns: 2 });
		expect(pika.requestsTo(`memory/dream/${LEASE_ID}/release`)).toHaveLength(1);
	});
});
