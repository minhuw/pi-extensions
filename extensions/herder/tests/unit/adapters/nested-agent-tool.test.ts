import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { HerderNestedAgentScope, type NestedWorkerSession } from "../../../adapters/nested-agent-executor.ts";
import { createNestedAgentTool } from "../../../adapters/nested-agent-tool.ts";

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
	private readonly limited: boolean;

	constructor(id: string, limited = false) {
		this.sessionId = id;
		this.limited = limited;
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
	turnLimitReached(): boolean { return this.limited; }
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
		subagent_type: "reviewer",
		...overrides,
	};
}

function resultText(result: Awaited<ReturnType<ReturnType<typeof createNestedAgentTool>["execute"]>>): string {
	const item = result.content[0];
	assert.equal(item?.type, "text");
	return item.type === "text" ? item.text : "";
}

test("nested Agent runs one package-owned foreground child with inherited action binding", async () => {
	const { value, sessions } = scope();
	const tool = createNestedAgentTool(action(), value);
	const result = await tool.execute("call", params({ max_turns: 4 }), undefined, undefined, undefined as never);
	assert.match(resultText(result), /^Agent completed \(↻1≤4 · 1 tool · 16t · /);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]!.disposed, true);
	const snapshot = value.snapshots()[0]!;
	assert.equal(snapshot.model, "proxy/parent");
	assert.equal(snapshot.effort, "high");
	assert.equal(snapshot.status, "completed");
	assert.deepEqual(snapshot.activeTools, []);
});

test("a gracefully bounded child preserves partial output with an explicit limited status", async () => {
	const session = new FakeNestedSession("limited-child", true);
	const value = new HerderNestedAgentScope({
		action: action(),
		agentRoot,
		createSession: async () => session,
	});
	const tool = createNestedAgentTool(action(), value);
	const result = await tool.execute("limited", params({ max_turns: 1 }), undefined, undefined, undefined as never);
	assert.match(resultText(result), /^Agent reached the turn limit; output may be partial \(↻1≤1/);
	assert.match(resultText(result), /Child result$/);
	assert.equal(value.snapshots()[0]!.status, "limited");
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
