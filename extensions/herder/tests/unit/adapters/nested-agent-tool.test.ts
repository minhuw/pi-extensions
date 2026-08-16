import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import {
	HerderNestedAgentScope,
	type NestedWorkerSession,
} from "../../../adapters/nested-agent-executor.ts";
import { createNestedAgentTool, createNestedAgentTools } from "../../../adapters/nested-agent-tool.ts";

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
	private emit(event: AgentSessionEvent): void {
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
	const tool = createNestedAgentTool(action(), value);
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
	const [agentTool, resultTool] = createNestedAgentTools(action(), value);
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
	const [agentTool] = createNestedAgentTools(action(), value);
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
	const tool = createNestedAgentTool(action(), value);
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
		const tool = createNestedAgentTool(action(role), value);
		await assert.rejects(
			() => tool.execute("call", params({ subagent_type: "worker" }), undefined, undefined, undefined as never),
			/may delegate only to package-owned read-only nested agent types/,
		);
	}
});

test("nested Agent rejects unknown types and enforces the per-worker call cap", async () => {
	const { value, sessions } = scope();
	const tool = createNestedAgentTool(action(), value);
	await assert.rejects(
		() => tool.execute("unknown", params({ subagent_type: "foreign" }), undefined, undefined, undefined as never),
		/Unknown Herder nested agent type/,
	);
	for (let index = 0; index < 8; index += 1) {
		await tool.execute(`call-${index}`, params(), undefined, undefined, undefined as never);
	}
	await assert.rejects(
		() => tool.execute("call-9", params(), undefined, undefined, undefined as never),
		/at most 8 times/,
	);
	assert.equal(sessions.length, 8);
});
