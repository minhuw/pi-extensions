import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import {
	cloneActiveTools,
	cloneSessionSnapshot,
	observeSessionEvent,
	refreshSessionActivity,
	refreshSessionContext,
	type SessionTelemetrySnapshot,
	type SessionTelemetryTarget,
} from "../../../adapters/session-telemetry.ts";

function event(value: object): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function snapshot(): SessionTelemetrySnapshot {
	return {
		turns: 0,
		toolUses: 0,
		lifetimeTokens: 0,
		contextPercent: null,
		compactionCount: 0,
		activeTools: [],
		responseText: "old response",
		activity: "old response",
	};
}

function target(contextPercent = 42): SessionTelemetryTarget {
	const stats = { contextUsage: { percent: contextPercent } } as SessionStats;
	return {
		snapshot: snapshot(),
		activeToolCalls: new Map(),
		session: { getSessionStats: () => stats },
	};
}

test("session telemetry clones active tools and snapshots without sharing arrays", () => {
	const activeTools = ["read"];
	const copy = cloneActiveTools(activeTools);
	copy.push("bash");
	assert.deepEqual(activeTools, ["read"]);

	const original = { ...snapshot(), activeTools };
	const cloned = cloneSessionSnapshot(original);
	cloned.activeTools.push("edit");
	assert.deepEqual(original.activeTools, ["read"]);
});

test("session telemetry refreshes activity from tools or response text and context from stats", () => {
	const value = target(61);
	value.activeToolCalls.set("call-1", "read");
	refreshSessionActivity(value);
	assert.deepEqual(value.snapshot.activeTools, ["read"]);
	assert.equal(value.snapshot.activity, "read");

	value.activeToolCalls.clear();
	value.snapshot.responseText = "\n  explain the change\nmore";
	refreshSessionActivity(value);
	assert.deepEqual(value.snapshot.activeTools, []);
	assert.equal(value.snapshot.activity, "explain the change");

	refreshSessionContext(value);
	assert.equal(value.snapshot.contextPercent, 61);
});

test("session telemetry handles turns, assistant starts, text deltas, tools, and compaction", () => {
	const value = target();
	assert.equal(observeSessionEvent(value, event({ type: "turn_start" })), true);
	assert.equal(value.snapshot.turns, 1);

	assert.equal(observeSessionEvent(value, event({ type: "message_start", message: { role: "assistant" } })), false);
	assert.equal(value.snapshot.responseText, undefined);

	assert.equal(observeSessionEvent(value, event({
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "draft" },
	})), false);
	assert.equal(value.snapshot.responseText, "draft");
	assert.equal(value.snapshot.activity, "draft");

	assert.equal(observeSessionEvent(value, event({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
		args: {},
	})), true);
	assert.equal(value.snapshot.toolUses, 1);
	assert.deepEqual(value.snapshot.activeTools, ["read"]);
	assert.equal(observeSessionEvent(value, event({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "read",
		result: {},
		isError: false,
	})), true);
	assert.deepEqual(value.snapshot.activeTools, []);

	assert.equal(observeSessionEvent(value, event({ type: "compaction_start", reason: "manual" })), true);
	assert.equal(value.snapshot.activity, "compacting");
	assert.equal(observeSessionEvent(value, event({
		type: "compaction_end",
		reason: "manual",
		result: {},
		aborted: false,
		willRetry: false,
	})), true);
	assert.equal(value.snapshot.compactionCount, 1);
	assert.equal(observeSessionEvent(value, event({
		type: "compaction_end",
		reason: "manual",
		result: {},
		aborted: true,
		willRetry: false,
	})), true);
	assert.equal(value.snapshot.compactionCount, 1);
});

test("session telemetry accounts assistant ends, refreshes context, and ignores user ends", () => {
	const value = target(17);
	assert.equal(observeSessionEvent(value, event({
		type: "message_end",
		message: {
			role: "user",
			content: "ignore",
			usage: { input: 100, output: 100 },
		},
	})), false);
	assert.equal(value.snapshot.lifetimeTokens, 0);
	assert.equal(value.snapshot.contextPercent, null);

	assert.equal(observeSessionEvent(value, event({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "final answer" }],
			usage: { input: 10, output: 5, cacheWrite: 2, reasoning: 99 },
		},
	})), true);
	assert.equal(value.snapshot.lifetimeTokens, 17);
	assert.equal(value.snapshot.responseText, "final answer");
	assert.equal(value.snapshot.contextPercent, 17);

	value.session = undefined;
	assert.equal(observeSessionEvent(value, event({ type: "agent_end", messages: [], willRetry: false })), true);
	assert.equal(observeSessionEvent(value, event({ type: "agent_settled" })), true);
});

test("agent_start is parent-hooked and nested observation is a no-op", () => {
	const nested = target();
	assert.equal(observeSessionEvent(nested, event({ type: "agent_start" })), false);

	const parent = target();
	let starts = 0;
	assert.equal(observeSessionEvent(parent, event({ type: "agent_start" }), () => { starts += 1; }), true);
	assert.equal(starts, 1);
});
