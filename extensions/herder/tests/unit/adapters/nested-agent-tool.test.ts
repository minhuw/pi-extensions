import assert from "node:assert/strict";
import path from "node:path";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { resolvePiProfile } from "../../../src/core/profile-registry.ts";
import {
	HerderNestedAgentScope,
	RECON_TIMEOUT_MS,
	RESULT_WAIT_TIMEOUT_MS,
	type NestedSessionCreateRequest,
	type PiNestedAgentSnapshot,
	type NestedWorkerSession,
} from "../../../adapters/nested-agent-executor.ts";
import { createNestedAgentTools } from "../../../adapters/nested-agent-tool.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/roles/pi");

function action(role: ManagerAction["role"] = "plan-implementer"): ManagerAction {
	return {
		actionId: "action-1",
		attemptId: "attempt-1",
		runId: "run-1",
		planId: "001",
		generation: 1,
		round: 1,
		role,
		agentType: `herder.${role}`,
		model: "proxy/parent",
		effort: "high",
		workerMode: "INITIAL",
		taskName: "nested-test",
		worktree: "/tmp/stable-worktree",
		branch: "herder/plans/001",
		assignmentPath: "/tmp/stable-worktree/assignment.md",
		assignmentSha256: "a".repeat(64),
		leaseReason: "test",
		prompt: "test",
	};
}

class FakeNestedSession implements NestedWorkerSession {
	readonly sessionId: string;
	readonly messages: unknown[] = [];
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	aborted = false;
	disposed = false;
	constructor(id: string) {
		this.sessionId = id;
	}
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(): Promise<void> {
		this.emit({ type: "turn_start" });
		this.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
		this.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Child result" }],
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
		};
		this.messages.push(message);
		this.emit({ type: "message_end", message: message as never });
	}
	async abort(): Promise<void> { this.aborted = true; }
	dispose(): void { this.disposed = true; }
	getSessionStats(): SessionStats {
		return {
			sessionFile: undefined,
			sessionId: this.sessionId,
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: this.messages.length,
			tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 16 },
			cost: 0,
			contextUsage: { tokens: 25_000, contextWindow: 100_000, percent: 25 },
		};
	}
	get listenerCount(): number { return this.listeners.size; }
	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class BlockingNestedSession extends FakeNestedSession {
	private release!: () => void;
	private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
	override async prompt(): Promise<void> { await this.gate; }
	override async abort(): Promise<void> {
		await super.abort();
		this.release();
	}
}

function scope(role: ManagerAction["role"] = "plan-implementer") {
	const sessions: FakeNestedSession[] = [];
	const value = new HerderNestedAgentScope({
		action: action(role),
		agentRoot,
		createSession: async ({ id }) => {
			const session = new FakeNestedSession(id);
			sessions.push(session);
			return session;
		},
	});
	return { value, sessions };
}

function params(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "Inspect the bounded change",
		description: "inspect bounded change",
		subagent_type: "recon",
		...overrides,
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const item = result.content[0];
	assert.equal(item?.type, "text");
	return item.type === "text" ? item.text ?? "" : "";
}

test("nested Agent runs one package-owned foreground recon child with the scout binding", async () => {
	const { value, sessions } = scope();
	const [tool] = createNestedAgentTools(value);
	const result = await tool.execute("call", params(), undefined, undefined, undefined as never);
	assert.match(resultText(result), /^Agent completed \(↻1 · 1 tool · 16t · /);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]!.disposed, true);
	const snapshot = value.snapshots()[0]!;
	assert.equal(snapshot.model, "gpt-5.6-luna");
	assert.equal(snapshot.effort, "max");
	assert.equal(snapshot.serviceTier, "fast");
	assert.equal(snapshot.status, "completed");
	assert.deepEqual(snapshot.activeTools, []);
});

test("universe dispatches Searcher on Astra and only Recon on Luna", async () => {
	const profile = resolvePiProfile("universe");
	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"] as const) {
		const mapping = role === "plan-implementer" ? profile.rescue! : profile.roles[role];
		const created: NestedSessionCreateRequest[] = [];
		const value = new HerderNestedAgentScope({
			action: { ...action(role), model: mapping.model, effort: mapping.effort, searcherBinding: profile.searcher },
			agentRoot,
			createSession: async (request) => {
				created.push(request);
				return new FakeNestedSession(request.id);
			},
		});
		const types = role === "plan-implementer" ? ["searcher", "recon", "worker"] as const
			: role === "plan-reviewer" ? ["searcher", "recon", "reviewer"] as const : ["searcher", "recon"] as const;
		for (const type of types) {
			const result = await value.run({ type, prompt: "Bounded lookup", description: "inspect model binding" });
			assert.equal(result.status, "completed");
		}
		assert.deepEqual(created[0]!.binding, { model: "gpt-6-astra", effort: "medium" });
		assert.deepEqual(created[1]!.binding, { model: "gpt-5.6-luna", effort: "max", serviceTier: "fast" });
		if (created[2]) assert.deepEqual(created[2].binding, { model: mapping.model, effort: mapping.effort });
		assert.deepEqual(value.snapshots().filter((child) => child.model === "gpt-5.6-luna").map((child) => child.type), ["recon"]);
		await value.stop("test complete");
	}
});

test("nested results keep a distinct no-result diagnostic and complete empty content", async () => {
	class CaseSession extends FakeNestedSession {
		private readonly message?: unknown;
		constructor(id: string, message?: unknown) {
			super(id);
			this.message = message;
		}
		override async prompt(): Promise<void> {
			if (this.message !== undefined) this.messages.push(this.message);
		}
	}
	async function run(message: unknown, id: string) {
		const value = new HerderNestedAgentScope({
			action: action(),
			agentRoot,
			createSession: async () => new CaseSession(id, message),
		});
		return await value.run({ type: "recon", prompt: "Inspect", description: "inspect" });
	}
	const missing = await run(undefined, "missing");
	assert.equal(missing.status, "error");
	assert.equal(missing.error, "Nested Herder agent returned no assistant result.");
	const empty = await run({ role: "assistant", content: [{ type: "text", text: "  \n" }], stopReason: "stop" }, "empty");
	assert.equal(empty.status, "completed");
	assert.equal(empty.output, "");
	const noTextBlock = await run({ role: "assistant", content: [{ type: "image", data: "ignored" }], stopReason: "stop" }, "no-text-block");
	assert.equal(noTextBlock.status, "completed");
	assert.equal(noTextBlock.output, "");
	const zeroLength = await run({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" }, "zero-length");
	assert.equal(zeroLength.status, "completed");
	assert.equal(zeroLength.output, "");
	const padded = await run({ role: "assistant", content: [{ type: "text", text: "  padded child  " }], stopReason: "stop" }, "padded");
	assert.equal(padded.status, "completed");
	assert.equal(padded.output, "  padded child  ");
	const provider = await run({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "provider failed" }, "provider");
	assert.equal(provider.status, "error");
	assert.equal(provider.error, "provider failed");
});

test("background children return IDs and must be collected through the scoped result tool", async () => {
	const { value } = scope();
	const [agentTool, resultTool] = createNestedAgentTools(value);
	assert.equal(agentTool.executionMode, "parallel");
	assert.equal(resultTool.executionMode, "parallel");
	const launched = await agentTool.execute("background", params({ run_in_background: true }), undefined, undefined, undefined as never);
	const agentId = (launched.details as { agentId: string }).agentId;
	assert.match(resultText(launched), new RegExp(`Agent started in background: ${agentId}`));
	assert.deepEqual(value.uncollectedBackgroundIds(), [agentId]);
	const collected = await resultTool.execute("collect", { agent_id: agentId, wait: true }, undefined, undefined, undefined as never);
	assert.match(resultText(collected), /^Agent completed/);
	assert.deepEqual(value.uncollectedBackgroundIds(), []);
});

test("each role may run four children concurrently and rejects a fifth", async () => {
	const sessions: BlockingNestedSession[] = [];
	const value = new HerderNestedAgentScope({
		action: action(),
		agentRoot,
		createSession: async ({ id }) => {
			const session = new BlockingNestedSession(id);
			sessions.push(session);
			return session;
		},
	});
	const [agentTool] = createNestedAgentTools(value);
	for (let index = 0; index < 4; index += 1) {
		await agentTool.execute(`background-${index}`, params({ run_in_background: true }), undefined, undefined, undefined as never);
	}
	assert.equal(value.activeCount(), 4);
	await assert.rejects(
		() => agentTool.execute("background-5", params({ run_in_background: true }), undefined, undefined, undefined as never),
		/may run at most 4 nested agents concurrently/,
	);
	await value.stop("test complete");
	assert.equal(sessions.length, 4);
	assert.equal(sessions.every((session) => session.aborted && session.disposed), true);
});

test("closing a parent action aborts, settles, and disposes an in-flight child", async () => {
	const session = new BlockingNestedSession("blocking-child");
	let markCreated!: () => void;
	const created = new Promise<void>((resolve) => { markCreated = resolve; });
	const value = new HerderNestedAgentScope({
		action: action(),
		agentRoot,
		createSession: async () => {
			markCreated();
			return session;
		},
	});
	const running = value.run({ type: "recon", prompt: "Wait", description: "wait for stop" });
	await created;
	await value.stop("parent completed");
	const result = await running;
	assert.equal(result.status, "stopped");
	assert.equal(session.aborted, true);
	assert.equal(session.disposed, true);
});

test("nested worker inherits the parent action binding", async () => {
	const { value } = scope();
	const [tool] = createNestedAgentTools(value);
	await tool.execute("call", params({ subagent_type: "worker" }), undefined, undefined, undefined as never);
	const snapshot = value.snapshots()[0]!;
	assert.equal(snapshot.type, "worker");
	assert.equal(snapshot.model, "proxy/parent");
	assert.equal(snapshot.effort, "high");
	assert.equal(snapshot.serviceTier, undefined);
});

test("Reviewer and Judge reject the mutation-capable package worker", async () => {
	for (const role of ["plan-reviewer", "plan-judge"] as const) {
		const { value } = scope(role);
		const [tool] = createNestedAgentTools(value);
		await assert.rejects(
			() => tool.execute("call", params({ subagent_type: "worker" }), undefined, undefined, undefined as never),
			/may delegate only to package-owned read-only nested agent types/,
		);
	}
});

test("nested Agent rejects unknown types and enforces the per-worker call cap", async () => {
	const { value, sessions } = scope();
	const [tool] = createNestedAgentTools(value);
	await assert.rejects(
		() => tool.execute("unknown", params({ subagent_type: "foreign" }), undefined, undefined, undefined as never),
		/Unknown Herder nested agent type/,
	);
	for (let index = 0; index < 8; index += 1) {
		await tool.execute(`call-${index}`, params(), undefined, undefined, undefined as never);
	}
	await assert.rejects(
		() => createNestedAgentTools(value)[0].execute("call-9", params(), undefined, undefined, undefined as never),
		/at most 8 times/,
	);
	assert.equal(sessions.length, 8);
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

class ControlledNestedSession extends FakeNestedSession {
	readonly started = deferred<void>();
	readonly completion = deferred<void>();
	override async prompt(): Promise<void> {
		this.started.resolve();
		await this.completion.promise;
		await super.prompt();
	}
	override async abort(): Promise<void> {
		await super.abort();
		this.completion.resolve();
	}
}

const reconRequest = { type: "recon", prompt: "Inspect", description: "inspect" } as const;
const reviewerRequest = { ...reconRequest, type: "reviewer" } as const;

test("reviewer scopes inherit bindings, isolate scout limits and direct-child collection, and propagate hierarchy", async () => {
	const requests: NestedSessionCreateRequest[] = [];
	const sessions = new Map<string, ControlledNestedSession>();
	const parentAction = { ...action("plan-reviewer"), serviceTier: "fast" as const };
	const value = new HerderNestedAgentScope({
		action: parentAction, agentRoot,
		createSession: async (request) => {
			requests.push(request);
			const session = new ControlledNestedSession(request.id);
			sessions.set(request.id, session);
			return session;
		},
	});
	const updates: PiNestedAgentSnapshot[][] = [];
	value.onUpdate((snapshots) => updates.push([...snapshots]));
	try {
		const parents = await Promise.all(Array.from({ length: 4 }, () => value.spawnBackground(reviewerRequest)));
		for (const parent of parents) {
			await sessions.get(parent.id)!.started.promise;
			const request = requests.find((item) => item.id === parent.id)!;
			assert.deepEqual(request.binding, { model: parentAction.model, effort: "high", serviceTier: "fast" });
			assert.equal(request.nestedScope!.maxConcurrency, 1);
			assert.equal(request.nestedScope!.maxCalls, 2);
			assert.deepEqual(request.nestedScope!.allowedTypes, ["recon"]);
			for (const type of ["reviewer", "worker", "searcher"] as const) {
				await assert.rejects(request.nestedScope!.spawnBackground({ ...reconRequest, type }), /forbidden|mutation-capable/);
			}
			const scout = await request.nestedScope!.spawnBackground(reconRequest);
			await sessions.get(scout.id)!.started.promise;
			assert.equal(requests.find((item) => item.id === scout.id)!.nestedScope, undefined);
			await assert.rejects(request.nestedScope!.spawnBackground(reconRequest), /at most 1 nested agents concurrently/);
			await assert.rejects(value.result(scout.id, false), /Unknown Herder nested agent/);
			await assert.rejects(request.nestedScope!.result(parent.id, false), /Unknown Herder nested agent/);
		}
		assert.equal(value.activeCount(), 4);
		assert.equal(value.snapshots().length, 4);
		assert.equal(value.treeSnapshots().length, 8);
		assert.equal(updates.at(-1)!.length, 8);
		assert.equal(await value.resultAny(false), undefined);
		for (const parent of parents) {
			const nested = requests.find((item) => item.id === parent.id)!.nestedScope!;
			const scout = nested.snapshots()[0]!;
			assert.equal(scout.parentAgentId, parent.id);
			sessions.get(scout.agentId)!.completion.resolve();
			assert.equal((await nested.resultAny(true))!.result!.status, "completed");
			assert.equal(await value.resultAny(false), undefined, "root cannot collect completed grandchildren");
		}
		// Collecting a first scout releases the local slot before a second launch.
		const nested = requests[0]!.nestedScope!;
		const second = await nested.spawnBackground(reconRequest);
		await sessions.get(second.id)!.started.promise;
		sessions.get(second.id)!.completion.resolve();
		await nested.result(second.id, true);
		await assert.rejects(createNestedAgentTools(nested)[0].execute("third", params(), undefined, undefined, undefined as never), /at most 2 times/);
		for (const parent of parents) sessions.get(parent.id)!.completion.resolve();
		for (let index = 0; index < 4; index += 1) assert.equal((await value.resultAny(true))!.result!.status, "completed");
		await value.stop();
		const slices = value.usageSlices();
		assert.deepEqual(slices.map(({ type, count, inputTokens }) => ({ type, count, inputTokens })), [
			{ type: "recon", count: 5, inputTokens: 50 },
			{ type: "reviewer", count: 4, inputTokens: 40 },
		]);
		assert.deepEqual(value.usageSlices(), slices, "aggregation must not mutate or double-count descendant slices");
		assert.equal(value.treeSnapshots().every((item) => item.status === "completed"), true);
	} finally { await value.stop(); }
	for (const role of ["plan-implementer", "plan-judge"] as const) {
		await assert.rejects(scope(role).value.run(reviewerRequest), /reviewer is forbidden/);
	}
});

test("a reviewer fails closed for uncollected grandchildren and root stops cascade through blocked reviewers", async () => {
	for (const mode of ["running", "completed", "stop"] as const) {
		const stopRoot = mode === "stop";
		const sessions: ControlledNestedSession[] = [];
		let nested!: HerderNestedAgentScope;
		const value = new HerderNestedAgentScope({
			action: action("plan-reviewer"), agentRoot,
			createSession: async ({ id, nestedScope }) => {
				if (nestedScope) nested = nestedScope;
				const session = new ControlledNestedSession(id);
				sessions.push(session);
				return session;
			},
		});
		const parent = await value.spawnBackground(reviewerRequest);
		await sessions[0]!.started.promise;
		const scout = await nested.spawnBackground(reconRequest);
		await sessions[1]!.started.promise;
		if (mode === "completed") {
			sessions[1]!.completion.resolve();
			await nextTurn();
			assert.equal(nested.snapshots()[0]!.status, "completed");
			await createNestedAgentTools(nested)[1].execute("list", {}, undefined, undefined, undefined as never);
			assert.deepEqual(nested.uncollectedBackgroundIds(), [scout.id], "listing a terminal child must not collect it");
		}
		if (stopRoot) await value.stop("cascade");
		else sessions[0]!.completion.resolve();
		const result = (await value.resultAny(true))!.result!;
		assert.equal(result.id, parent.id);
		assert.equal(result.status, stopRoot ? "stopped" : "error");
		if (!stopRoot) assert.match(result.error!, /without collecting background nested agents/);
		assert.equal((await nested.result(scout.id, false)).result!.status, mode === "completed" ? "completed" : "stopped");
		assert.equal(sessions[1]!.aborted, mode !== "completed");
		assert.equal(sessions.every((item) => item.disposed && item.listenerCount === 0), true);
		assert.equal(result.nestedUsage![0]!.count, 1);
		assert.equal(value.usageSlices().reduce((total, slice) => total + slice.count, 0), 2);
		await assert.rejects(nested.spawnBackground(reconRequest), /scope is closed/);
		await value.stop();
	}
});

test("wait-any collects a ready sibling, never lists-to-collect or collects a result twice", async () => {
	const sessions: ControlledNestedSession[] = [];
	const value = new HerderNestedAgentScope({
		action: action(), agentRoot,
		createSession: async ({ id }) => {
			const session = new ControlledNestedSession(id);
			sessions.push(session);
			return session;
		},
	});
	const [, tool] = createNestedAgentTools(value);
	try {
		assert.equal(await value.resultAny(true), undefined);
		const blocked = await value.spawnBackground(reconRequest);
		const ready = await value.spawnBackground({ ...reconRequest, description: "ready sibling shard" });
		await sessions[1]!.started.promise;
		const collecting = tool.execute("any", { wait_any: true }, undefined, undefined, undefined as never);
		sessions[1]!.completion.resolve();
		const completed = await collecting;
		assert.equal((completed.details as { agent: PiNestedAgentSnapshot }).agent.agentId, ready.id);
		assert.match(resultText(completed), new RegExp(`Collected agent ${ready.id} · recon · ready sibling shard`));
		assert.match(resultText(completed), new RegExp(`Uncollected background IDs: ${blocked.id}`));
		assert.deepEqual(value.uncollectedBackgroundIds(), [blocked.id]);
		assert.equal(sessions[0]!.aborted, false);
		await tool.execute("list", {}, undefined, undefined, undefined as never);
		assert.deepEqual(value.uncollectedBackgroundIds(), [blocked.id]);
		assert.equal(await value.resultAny(false), undefined);
		for (const wait_any of [true, false]) {
			await assert.rejects(tool.execute("invalid", { agent_id: ready.id, wait_any }, undefined, undefined, undefined as never), /mutually exclusive/);
		}
		const waits = [value.resultAny(true), value.resultAny(true)];
		sessions[0]!.completion.reject(new Error("provider failure"));
		const results = await Promise.all(waits);
		assert.equal(results.filter(Boolean).length, 1);
		assert.equal(results.find(Boolean)!.result!.status, "error");
		assert.deepEqual(value.uncollectedBackgroundIds(), []);
		assert.equal(await value.resultAny(true), undefined);
	} finally { await value.stop(); }
});

test("60-second collection deadlines preserve children and foreground runs keep waiting", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const sessions: ControlledNestedSession[] = [];
	const value = new HerderNestedAgentScope({
		action: action(), agentRoot,
		createSession: async ({ id }) => {
			const session = new ControlledNestedSession(id);
			sessions.push(session);
			return session;
		},
	});
	const [, tool] = createNestedAgentTools(value);
	try {
		const child = await value.spawnBackground(reconRequest);
		await sessions[0]!.started.promise;
		const foreground = value.run(reconRequest);
		// Let the role definition read and prompt setup complete without advancing mocked time.
		while (sessions.length < 2) await nextTurn();
		await sessions[1]!.started.promise;
		let foregroundDone = false;
		void foreground.then(() => { foregroundDone = true; });
		const specific = tool.execute("id", { agent_id: child.id }, undefined, undefined, undefined as never);
		const any = tool.execute("any", { wait_any: true }, undefined, undefined, undefined as never);
		t.mock.timers.tick(RESULT_WAIT_TIMEOUT_MS - 1);
		await nextTurn();
		assert.equal(foregroundDone, false);
		t.mock.timers.tick(1);
		assert.match(resultText(await specific), /Agent still running/);
		assert.match(resultText(await any), /Agents still running/);
		assert.equal(foregroundDone, false);
		assert.equal(sessions.every((item) => !item.aborted && !item.disposed), true);
		assert.deepEqual(value.uncollectedBackgroundIds(), [child.id]);
		sessions[1]!.completion.resolve();
		assert.equal((await foreground).status, "completed");
		sessions[0]!.completion.resolve();
		assert.equal((await value.resultAny(true))!.result!.status, "completed");
	} finally { await value.stop(); }
});

test("aborting collection waits detaches listeners without cancelling or collecting children", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const session = new ControlledNestedSession("waiting");
	const value = new HerderNestedAgentScope({ action: action(), agentRoot, createSession: async () => session });
	try {
		const child = await value.spawnBackground(reconRequest);
		await session.started.promise;
		for (const any of [false, true]) {
			const controller = new AbortController();
			const waiting = any ? value.resultAny(true, controller.signal) : value.result(child.id, true, controller.signal);
			assert.equal(getEventListeners(controller.signal, "abort").length, 1);
			controller.abort(new Error("cancel wait"));
			await assert.rejects(waiting, /cancel wait/);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			await assert.rejects(value.resultAny(true, controller.signal), /cancel wait/);
		}
		t.mock.timers.tick(RESULT_WAIT_TIMEOUT_MS);
		assert.equal(session.aborted, false);
		assert.deepEqual(value.uncollectedBackgroundIds(), [child.id]);
		session.completion.resolve();
		assert.equal((await value.resultAny(true))!.result!.status, "completed");
		assert.equal(session.listenerCount, 0);
	} finally { await value.stop(); }
});

class UncooperativeNestedSession extends ControlledNestedSession {
	readonly abortDone = deferred<void>();
	readonly shutdownDone = deferred<void>();
	shutdownStarted = false;
	override async abort(): Promise<void> {
		this.aborted = true;
		await this.abortDone.promise;
	}
	async shutdown(): Promise<void> {
		this.shutdownStarted = true;
		await this.shutdownDone.promise;
	}
}

test("recon hits its fixed launch deadline despite setup delay, activity, compaction and retry events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const session = new UncooperativeNestedSession("timed-out");
	const creation = deferred<NestedWorkerSession>();
	let createRequest!: NestedSessionCreateRequest;
	let creates = 0;
	const controller = new AbortController();
	const value = new HerderNestedAgentScope({
		action: action(), agentRoot,
		createSession: async (request) => { createRequest = request; creates += 1; return await creation.promise; },
	});
	const launch = await value.spawnBackground(reconRequest, controller.signal);
	t.mock.timers.tick(600_000);
	creation.resolve(session);
	await session.started.promise;
	for (let index = 0; index < 4; index += 1) {
		t.mock.timers.tick(600_000);
		session.emit({ type: "turn_start" });
		session.emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		session.emit({ type: "auto_retry_start", attempt: index + 1 } as AgentSessionEvent);
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial " } } as AgentSessionEvent);
	}
	t.mock.timers.tick(RECON_TIMEOUT_MS - Date.now() - 1);
	assert.equal(session.aborted, false);
	t.mock.timers.tick(1);
	await nextTurn();
	assert.equal(createRequest.signal.aborted, true);
	assert.equal(session.aborted, true);
	assert.equal(session.shutdownStarted, true);
	assert.equal(session.listenerCount, 0);
	const collected = value.resultAny(true);
	t.mock.timers.tick(5_000);
	const result = (await collected)!.result!;
	assert.equal(result.id, launch.id);
	assert.equal(result.status, "timed_out");
	assert.match(result.error!, /one-hour deadline/);
	assert.equal(result.output, "partial partial partial partial ");
	assert.equal(result.startedAt, 0);
	assert.equal(result.completedAt, RECON_TIMEOUT_MS + 5_000);
	assert.equal(session.disposed, true);
	assert.equal(value.activeCount(), 0);
	assert.equal(creates, 1, "never automatically relaunch after timeout");
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(getEventListeners(createRequest.signal, "abort").length, 0);
	const snapshots = value.treeSnapshots();
	session.emit({ type: "turn_start" });
	// Late rejections from abandoned SDK operations are consumed.
	session.completion.reject(new Error("late prompt failure"));
	session.abortDone.reject(new Error("late abort failure"));
	session.shutdownDone.reject(new Error("late shutdown failure"));
	await nextTurn();
	t.mock.timers.tick(RECON_TIMEOUT_MS);
	assert.deepEqual(value.treeSnapshots(), snapshots);
	await value.stop();
});

test("hung setup settles on timeout or parent cancellation and late-created sessions are cleaned up", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	for (const mode of ["timeout", "stop", "abort"] as const) {
		const timeout = mode === "timeout";
		const controller = new AbortController();
		const creation = deferred<NestedWorkerSession>();
		const session = new UncooperativeNestedSession("late");
		let createRequest!: NestedSessionCreateRequest;
		const value = new HerderNestedAgentScope({
			action: action(), agentRoot,
			createSession: async (request) => { createRequest = request; return await creation.promise; },
		});
		const launch = await value.spawnBackground(reconRequest, controller.signal);
		if (timeout) { t.mock.timers.tick(RECON_TIMEOUT_MS); await nextTurn(); }
		else if (mode === "stop") await value.stop();
		else { controller.abort(); await nextTurn(); }
		assert.equal(createRequest.signal.aborted, true);
		assert.equal(getEventListeners(createRequest.signal, "abort").length, 0);
		const result = (await value.result(launch.id, true)).result!;
		assert.equal(result.status, timeout ? "timed_out" : mode === "stop" ? "stopped" : "aborted");
		assert.equal(value.activeCount(), 0);
		creation.resolve(session);
		await nextTurn();
		assert.equal(session.aborted, true);
		assert.equal(session.shutdownStarted, true);
		assert.equal(session.listenerCount, 0);
		t.mock.timers.tick(5_000);
		await nextTurn();
		assert.equal(session.disposed, true);
		assert.equal(value.snapshots()[0]!.sessionId, undefined, "late sessions cannot revive a terminal child");
		await value.stop();
	}
});

test("normal completion and root cancellation both bound uncooperative cleanup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const cancel of [false, true]) {
		const session = new UncooperativeNestedSession("cleanup");
		const value = new HerderNestedAgentScope({ action: action(), agentRoot, createSession: async () => session });
		const running = value.run(reconRequest);
		await session.started.promise;
		if (!cancel) session.completion.resolve();
		const stopped = cancel ? value.stop() : undefined;
		await nextTurn();
		assert.equal(session.shutdownStarted, true);
		t.mock.timers.tick(5_000);
		await stopped;
		assert.equal((await running).status, cancel ? "stopped" : "completed");
		assert.equal(session.disposed, true);
		assert.equal(session.listenerCount, 0);
		assert.equal(value.activeCount(), 0);
		await value.stop();
	}
});

test("cascading stop bounds scout cleanup while retaining a Bash-capable reviewer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const sessions: UncooperativeNestedSession[] = [];
	let nested!: HerderNestedAgentScope;
	const value = new HerderNestedAgentScope({
		action: action("plan-reviewer"), agentRoot,
		createSession: async ({ id, nestedScope }) => {
			if (nestedScope) nested = nestedScope;
			const session = new UncooperativeNestedSession(id);
			sessions.push(session);
			return session;
		},
	});
	await value.spawnBackground(reviewerRequest);
	await sessions[0]!.started.promise;
	await nested.spawnBackground(reconRequest);
	await sessions[1]!.started.promise;
	let settled = false;
	const stopped = value.stop().then(() => { settled = true; });
	await nextTurn();
	assert.equal(sessions.every((item) => item.aborted), true);
	assert.equal(sessions[1]!.shutdownStarted, true);
	t.mock.timers.tick(5_000);
	await nextTurn();
	assert.equal(sessions[1]!.disposed, true);
	assert.equal(sessions[0]!.disposed, false);
	assert.equal(settled, false, "reviewer commands must settle before worktree release");
	sessions[0]!.completion.resolve();
	await nextTurn();
	assert.equal(sessions[0]!.shutdownStarted, true);
	sessions[0]!.abortDone.resolve();
	sessions[0]!.shutdownDone.resolve();
	await stopped;
	assert.equal(sessions.every((item) => item.disposed && item.listenerCount === 0), true);
	assert.equal(value.treeSnapshots().every((item) => item.status === "stopped"), true);
	assert.equal(value.usageSlices().reduce((count, slice) => count + slice.count, 0), 2);
});

test("stopped mutation workers retain worktree ownership through setup, mutation, and cleanup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const duringSetup of [false, true]) {
		class MutationSession extends UncooperativeNestedSession {
			mutationFinished = false;
			override async prompt(): Promise<void> {
				await super.prompt();
				this.mutationFinished = true;
			}
		}
		const session = new MutationSession("mutating-worker");
		const creation = deferred<NestedWorkerSession>();
		const value = new HerderNestedAgentScope({ action: action(), agentRoot, createSession: async () => creation.promise });
		const launch = await value.spawnBackground({ ...reconRequest, type: "worker" });
		if (!duringSetup) {
			creation.resolve(session);
			await session.started.promise;
		}
		let settled = false;
		const stopping = value.stop().then(() => { settled = true; });
		await nextTurn();
		t.mock.timers.tick(5_001);
		await nextTurn();
		assert.equal(settled, false);
		assert.equal(value.activeCount(), 1);
		assert.equal(session.disposed, false);
		if (duringSetup) creation.resolve(session);
		else session.completion.resolve();
		await nextTurn();
		assert.equal(session.aborted, true);
		assert.equal(session.shutdownStarted, true);
		assert.equal(session.mutationFinished, !duringSetup);
		t.mock.timers.tick(5_001);
		await nextTurn();
		assert.equal(settled, false, "cleanup still owns the worktree after the scout grace period");
		assert.equal(value.activeCount(), 1);
		session.abortDone.resolve();
		session.shutdownDone.resolve();
		await stopping;
		assert.equal((await value.result(launch.id, false)).result!.status, "stopped");
		assert.equal(session.disposed, true);
		assert.equal(session.listenerCount, 0);
		assert.equal(value.activeCount(), 0);
	}
});

test("rejected setup and cleanup promises cannot suppress a collectable terminal result", async () => {
	class ThrowingCleanupSession extends FakeNestedSession {
		async shutdown(): Promise<void> { throw new Error("shutdown failure"); }
		override dispose(): void { super.dispose(); throw new Error("dispose failure"); }
	}
	let creates = 0;
	const value = new HerderNestedAgentScope({
		action: action(), agentRoot,
		createSession: async ({ id }) => {
			creates += 1;
			if (creates === 1) throw new Error("creation failure");
			return new ThrowingCleanupSession(id);
		},
	});
	await value.spawnBackground(reconRequest);
	assert.match((await value.resultAny(true))!.result!.error!, /creation failure/);
	await value.spawnBackground(reconRequest);
	assert.equal((await value.resultAny(true))!.result!.status, "completed");
	await value.stop();
	assert.equal(value.activeCount(), 0);
});
