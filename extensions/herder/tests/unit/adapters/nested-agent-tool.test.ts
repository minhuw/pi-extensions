import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { createNestedAgentTool } from "../../../adapters/nested-agent-tool.ts";
import { forwardAbortSignal } from "../../../../subagents/src/abort-signal.ts";
import {
	getSubagentHost,
	registerSubagentHost,
	releaseSubagentHost,
	type SubagentHost,
	type SubagentHostResult,
	resolveSubagentHostModel,
	subagentHostModelScopeDecision,
	type SubagentHostSpawnRequest,
} from "../../../../subagents/src/host-registry.ts";

const pi = {} as ExtensionAPI;
const parentModel = { provider: "proxy", id: "parent", name: "Parent" } as Model<any>;
const childModel = { provider: "proxy", id: "child-fast", name: "Child Fast" } as Model<any>;
const ctx = {
	cwd: "/tmp/parent",
	model: parentModel,
	modelRegistry: {
		find: (provider: string, id: string) => [parentModel, childModel].find((model) => model.provider === provider && model.id === id),
		getAvailable: () => [parentModel, childModel],
		getAll: () => [parentModel, childModel],
	},
} as unknown as ExtensionContext;

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

function completed(overrides: Partial<SubagentHostResult> = {}): SubagentHostResult {
	return {
		id: "nested-1",
		status: "completed",
		output: "Child result",
		startedAt: 1_000,
		completedAt: 2_500,
		turnCount: 2,
		maxTurns: 4,
		toolUses: 3,
		lifetimeTokens: 1_200,
		contextPercent: 25,
		compactionCount: 1,
		...overrides,
	};
}

function host(spawnAndWait: SubagentHost["spawnAndWait"], readOnly = true): SubagentHost {
	const descriptor = {
		name: "reviewer",
		displayName: "Reviewer",
		description: "Review code",
		builtinToolNames: readOnly ? ["read", "grep"] : undefined,
		readOnly,
	};
	return {
		describeTypes: () => [descriptor],
		resolveType: (name) => name === "reviewer" ? descriptor : undefined,
		spawnAndWait,
	};
}

async function withHost<T>(value: SubagentHost, run: () => Promise<T>): Promise<T> {
	const token = registerSubagentHost(value);
	assert.ok(token, "test must own the host registry slot");
	try {
		return await run();
	} finally {
		assert.equal(releaseSubagentHost(token), true);
	}
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

test("abort forwarding handles cancellation before listener installation", () => {
	const controller = new AbortController();
	controller.abort(new Error("parent stopped"));
	let abortCalls = 0;
	const cleanup = forwardAbortSignal({ abort: () => { abortCalls += 1; } }, controller.signal);
	assert.equal(abortCalls, 1);
	assert.throws(() => controller.signal.throwIfAborted(), /parent stopped/);
	cleanup();
});

test("subagent host registry is first-wins and releases only by owner token", () => {
	assert.equal(getSubagentHost(), undefined);
	const first = host(async () => completed());
	const second = host(async () => completed({ id: "nested-2" }));
	const firstToken = registerSubagentHost(first);
	assert.ok(firstToken);
	const secondToken = registerSubagentHost(second);
	assert.equal(secondToken, undefined);
	assert.equal(getSubagentHost(), first);
	assert.equal(releaseSubagentHost(secondToken), false);
	assert.equal(releaseSubagentHost(Symbol("foreign")), false);
	assert.equal(getSubagentHost(), first);
	assert.equal(releaseSubagentHost(firstToken), true);
	assert.equal(getSubagentHost(), undefined);
});

test("nested Agent rejects background execution and an unavailable host", async () => {
	const tool = createNestedAgentTool(pi, action());
	await assert.rejects(() => tool.execute("call-1", params({ run_in_background: true }), undefined, undefined, ctx), /foreground-only/);
	await assert.rejects(() => tool.execute("call-2", params(), undefined, undefined, ctx), /subagents host is unavailable/);
});

test("Reviewer and Judge may delegate only to explicitly read-only types", async () => {
	await withHost(host(async () => completed(), false), async () => {
		for (const role of ["plan-reviewer", "plan-judge"] as const) {
			const tool = createNestedAgentTool(pi, action(role));
			await assert.rejects(() => tool.execute("call", params(), undefined, undefined, ctx), /may delegate only to agent types.*read-only/);
		}
	});
});

test("nested Agent passes stable foreground metadata, cwd, isolation, signal, and resolved model", async () => {
	let seenPi: ExtensionAPI | undefined;
	let seenCtx: ExtensionContext | undefined;
	let seenRequest: SubagentHostSpawnRequest | undefined;
	const controller = new AbortController();
	await withHost(host(async (piRef, ctxRef, request) => {
		seenPi = piRef;
		seenCtx = ctxRef;
		seenRequest = request;
		return completed();
	}), async () => {
		const tool = createNestedAgentTool(pi, action());
		const result = await tool.execute("call", params({ model: "child-fast", thinking: "high", max_turns: 4 }), controller.signal, undefined, ctx);
		assert.match(resultText(result), /^Agent completed \(↻2≤4 · 3 tools · 1\.2k · 1\.5s\)\./);
	});
	assert.equal(seenPi, pi);
	assert.equal(seenCtx, ctx);
	assert.equal(seenRequest?.cwd, "/tmp/stable-worktree");
	assert.equal(seenRequest?.isolated, true);
	assert.equal(seenRequest?.signal, controller.signal);
	assert.equal(seenRequest?.resolvedModel, childModel);
	assert.deepEqual(seenRequest?.metadata, { owner: "herder", rootActionId: "action-1", planId: "001" });
});

test("host model resolution and scope policy preserve explicit runtime restrictions", () => {
	const registry = ctx.modelRegistry;
	let resolutions = 0;
	const resolver = (input: string) => {
		resolutions += 1;
		return input === "configured" ? childModel : `Model not found: ${input}`;
	};
	assert.equal(resolveSubagentHostModel(parentModel, "missing/model", childModel, registry, resolver), parentModel);
	assert.equal(resolutions, 0);
	assert.equal(resolveSubagentHostModel(undefined, "configured", parentModel, registry, resolver), childModel);
	assert.throws(() => resolveSubagentHostModel(undefined, "missing/model", parentModel, registry, resolver), /Model not found/);
	assert.equal(resolveSubagentHostModel(undefined, undefined, parentModel, registry, resolver), parentModel);

	const allowed = new Set(["proxy/parent"]);
	assert.equal(subagentHostModelScopeDecision(parentModel, allowed, true), "allow");
	assert.equal(subagentHostModelScopeDecision(childModel, allowed, true), "reject");
	assert.equal(subagentHostModelScopeDecision(childModel, allowed, false), "warn");
	assert.equal(subagentHostModelScopeDecision(childModel, undefined, true), "allow");
});

test("nested Agent distinguishes provider errors and turn-limit wrap-up", async () => {
	await withHost(host(async () => completed({ status: "error", output: "partial evidence", error: "provider failed" })), async () => {
		const tool = createNestedAgentTool(pi, action());
		const result = await tool.execute("call", params(), undefined, undefined, ctx);
		assert.equal(resultText(result), "Agent error: provider failed\n↻2≤4 · 3 tools · 1.2k · 1.5s\n\nPartial output:\npartial evidence");
		assert.equal((result.details as { error?: string }).error, "provider failed");
	});
	await withHost(host(async () => completed({ status: "steered", output: "bounded partial" })), async () => {
		const tool = createNestedAgentTool(pi, action());
		const result = await tool.execute("call", params(), undefined, undefined, ctx);
		assert.match(resultText(result), /^Agent wrapped up at the turn limit; output may be partial/);
	});
});

test("nested Agent enforces the per-worker call cap", async () => {
	let calls = 0;
	await withHost(host(async () => {
		calls += 1;
		return completed({ id: `nested-${calls}` });
	}), async () => {
		const tool = createNestedAgentTool(pi, action());
		for (let index = 0; index < 8; index += 1) {
			await tool.execute(`call-${index}`, params(), undefined, undefined, ctx);
		}
		await assert.rejects(() => tool.execute("call-9", params(), undefined, undefined, ctx), /at most 8 times/);
	});
	assert.equal(calls, 8);
});
