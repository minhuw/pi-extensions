import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import {
	applyServiceTier,
	finalAssistantResult,
	PiWorkerEngine,
	type PiWorkerRequest,
	type PiWorkerSessionFactory,
	type PiWorkerTerminal,
} from "../../../adapters/worker-engine.ts";

function action(id = "action-1", planId = "001"): ManagerAction {
	return {
		actionId: id,
		attemptId: `attempt-${id}`,
		runId: "run-1",
		planId,
		generation: 1,
		round: 1,
		role: "plan-implementer",
		agentType: "herder.plan-implementer",
		model: "grok-4.5",
		effort: "high",
		workerMode: "INITIAL",
		taskName: `implement_${planId}`,
		worktree: `/tmp/worktree-${planId}`,
		branch: `herder/plans/${planId}`,
		assignmentPath: `/tmp/worktree-${planId}/herder-plans/${planId}.md`,
		assignmentSha256: "a".repeat(64),
		leaseReason: `lease-${planId}`,
		prompt: `Implement ${planId}`,
	};
}

class FakeSession {
	readonly sessionId: string;
	readonly messages: unknown[];
	readonly sessionFile = "/tmp/session.jsonl";
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	disposed = false;
	aborted = false;
	prompted = false;
	private readonly gate?: Promise<void>;

	constructor(sessionId: string, inherited: unknown[] = [], gate?: Promise<void>) {
		this.sessionId = sessionId;
		this.messages = [...inherited];
		this.gate = gate;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(): Promise<void> {
		this.prompted = true;
		await this.gate;
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		this.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
		this.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "STATUS: COMPLETE\nCOMMITS: abcdef1\nCHECKS: pass\nFILES CHANGED: a\nDISCOVERED_PATHS: none\nNOTES: done\nUSAGE: source=test" }],
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
		};
		this.messages.push(message);
		this.emit({ type: "message_end", message: message as never });
		this.emit({ type: "agent_end", messages: this.messages as never[], willRetry: false });
		this.emit({ type: "agent_settled" });
	}

	async abort(): Promise<void> { this.aborted = true; }
	dispose(): void { this.disposed = true; }
	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages: this.prompted ? 1 : 0,
			assistantMessages: this.prompted ? 1 : 0,
			toolCalls: this.prompted ? 1 : 0,
			toolResults: this.prompted ? 1 : 0,
			totalMessages: this.messages.length,
			tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 16 },
			cost: 0,
		};
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeFactory implements PiWorkerSessionFactory {
	readonly sessions: FakeSession[] = [];
	private readonly inherited: unknown[];
	private readonly gate?: Promise<void>;
	constructor(inherited: unknown[] = [], gate?: Promise<void>) {
		this.inherited = inherited;
		this.gate = gate;
	}
	async availableModels() { return [{ provider: "proxy", id: "grok-4.5" }]; }
	async create(_request: PiWorkerRequest): Promise<FakeSession> {
		const session = new FakeSession(`session-${this.sessions.length + 1}`, this.inherited, this.gate);
		this.sessions.push(session);
		return session;
	}
}

test("applyServiceTier pins every stream request and final provider payload", async () => {
	const seen: unknown[] = [];
	const session = {
		agent: {
			streamFunction: (_model: unknown, _context: unknown, options?: unknown) => {
				seen.push(options);
				return "stream";
			},
		},
	};
	applyServiceTier(session as never, "fast");
	const result = session.agent.streamFunction("model", "context", {
		reasoning: "max",
		onPayload: (payload: unknown) => ({ ...(payload as object), service_tier: "default", transformed: true }),
	});
	assert.equal(result, "stream");
	const first = seen[0] as { reasoning: string; serviceTier: string; onPayload: (payload: unknown, model: unknown) => Promise<unknown> };
	assert.equal(first.reasoning, "max");
	assert.equal(first.serviceTier, "priority");
	assert.deepEqual(await first.onPayload({ model: "gpt-5.6-luna" }, "model"), {
		model: "gpt-5.6-luna",
		service_tier: "priority",
		transformed: true,
	});
	session.agent.streamFunction("model", "context");
	const second = seen[1] as { serviceTier: string; onPayload: (payload: unknown, model: unknown) => Promise<unknown> };
	assert.equal(second.serviceTier, "priority");
	assert.deepEqual(await second.onPayload({ model: "gpt-5.6-luna" }, "model"), {
		model: "gpt-5.6-luna",
		service_tier: "priority",
	});
	await assert.rejects(() => second.onPayload("invalid", "model"), /non-object provider payload/);
	assert.throws(() => applyServiceTier(session as never, "flex"), /Unknown Herder service tier/);
});

test("built-in Pi engine starts an exact clean worker and reports its terminal directly", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	assert.equal(handle, "pi-worker:session-1");
	assert.equal(factory.sessions[0]!.messages.length, 0);
	assert.equal(engine.snapshots()[0]!.status, "prepared");
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.actionId, "action-1");
	assert.match(result.response || "", /^STATUS: COMPLETE/);
	assert.equal(result.interrupted, undefined);
	assert.equal(result.usage.inputTokens, 10);
	assert.equal(result.usage.reasoningTokens, 3);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(factory.sessions[0]!.disposed, true);
	assert.deepEqual(engine.snapshots(), []);
});

test("built-in Pi engine fails closed if a session contains inherited history", async () => {
	const inherited = [{ role: "assistant", content: [{ type: "text", text: "parent" }] }];
	const factory = new FakeFactory(inherited);
	const engine = new PiWorkerEngine(factory);
	await assert.rejects(() => engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" }), /zero inherited messages/);
	assert.equal(factory.sessions[0]!.disposed, true);
});

test("built-in Pi engine starts every manager-admitted worker without a private queue", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const factory = new FakeFactory([], gate);
	const engine = new PiWorkerEngine(factory);
	const handles = await Promise.all([
		engine.prepare({ action: action("action-1", "001"), planDirectory: "/tmp/repo/herder-plans" }),
		engine.prepare({ action: action("action-2", "002"), planDirectory: "/tmp/repo/herder-plans" }),
	]);
	for (const handle of handles) engine.start(handle);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(factory.sessions.every((session) => session.prompted), true);
	assert.equal(engine.snapshots().filter((worker) => worker.status === "running").length, 2);
	release();
	while (engine.snapshots().length > 0) await new Promise((resolve) => setImmediate(resolve));
});

test("worker terminals retain transport and provider diagnostics", async () => {
	class FailingSession extends FakeSession {
		override async prompt(): Promise<void> {
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text: "  partial output  \n" }],
				stopReason: "error",
				errorMessage: "provider failed",
			});
			throw new Error("transport failed");
		}
	}
	const session = new FailingSession("session-failed");
	const factory: PiWorkerSessionFactory = {
		async availableModels() { return [{ provider: "proxy", id: "grok-4.5" }]; },
		async create() { return session; },
	};
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.response, "  partial output  \n");
	assert.equal(result.error, "transport failed\nprovider failed");
});

test("assistant extraction uses only the exact final child response", () => {
	assert.deepEqual(finalAssistantResult([
		{ role: "assistant", content: [{ type: "text", text: "draft" }], stopReason: "toolUse" },
		{ role: "toolResult", content: [{ type: "text", text: "result" }] },
		{ role: "assistant", content: [{ type: "text", text: "  VERDICT: APPROVE  \n" }], stopReason: "stop" },
	]), { text: "  VERDICT: APPROVE  \n", failed: false });
});
