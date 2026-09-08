import assert from "node:assert/strict";
import test from "node:test";
import { MainSessionRequests, type MainSessionRequestsHost } from "../../../adapters/main-session-requests.ts";
import type { ManagerAttentionRequest, ManagerReply, VerificationRequest } from "../../../src/shared/protocol.ts";

function harness() {
	let epoch = 1;
	let state = { version: 1 as const, mode: "resume" as const, status: "running" as const, runId: "run", repoRoot: "/repo", planDir: "/repo/herder-plans", profile: "default", maxParallel: 1, startedAt: 1, updatedAt: 1 };
	const userMessages: string[] = [];
	const customMessages: unknown[] = [];
	const hints: (string | undefined)[] = [];
	let failUserMessage = false;
	const host: MainSessionRequestsHost = {
		packageRoot: "/repo",
		pi: {
			sendUserMessage(message) {
				if (failUserMessage) { failUserMessage = false; throw new Error("temporary delivery failure"); }
				userMessages.push(message);
			},
			sendMessage(message) { customMessages.push(message); },
		},
		current: () => ({ epoch, state, active: true, sessionId: "session", context: { hasUI: false, ui: { notify() {} } as never } }),
		ownsRun: (planDirectory, runId) => planDirectory === state.planDir && runId === state.runId,
		onAttentionHint: (hint) => hints.push(hint),
	};
	return { host, requests: new MainSessionRequests(host), userMessages, customMessages, hints, setEpoch: (value: number) => { epoch = value; }, setState: (value: typeof state) => { state = value; }, fail: () => { failUserMessage = true; } };
}

function reply(overrides: Partial<ManagerReply> = {}): ManagerReply {
	return {
		protocolVersion: 12, runId: "run", status: "running", profileName: "default", maxParallel: 1,
		planDirectory: "/repo/herder-plans", message: "running", summary: { total: 0, done: 0, rejected: 0, inProgress: 0 },
		actions: [], active: [], operations: [], ...overrides,
	} as ManagerReply;
}

const verification = { requestId: "verification-request", requestSha256: "a".repeat(64), runId: "run", generation: 1, graphSha256: "b".repeat(64), runAssignmentPath: "assignment", runAssignmentSha256: "c".repeat(64), integrationWorktree: "/repo/integration", integrationBranch: "main", integrationHead: "d".repeat(40), integrationTree: "e".repeat(40) } as VerificationRequest;

const attention = { schemaVersion: 1, requestId: "attention-request", requestSha256: "f".repeat(64), capabilityToken: "g".repeat(64), runId: "run", planId: "PLAN", generation: 1, round: 1, actionId: null, kind: "user_decision", cause: "judge_needs_input", state: "pending", detail: "Choose a path", question: "Which path?", continuation: { role: "plan-judge", phase: "NEEDS_INPUT" } } as unknown as ManagerAttentionRequest;

test("failed follow-up delivery remains retryable", async () => {
	const h = harness();
	const failure = reply({ status: "failed", message: "verification failed (log /tmp/failure)" });
	h.requests.observeReply(failure, { status: "failed", message: failure.message });
	h.fail();
	h.requests.deliverReply(failure);
	assert.equal(h.userMessages.length, 0);
	await h.requests.settled();
	assert.equal(h.userMessages.length, 1);
});

test("verification delegation is deduplicated after successful injection", () => {
	const h = harness();
	const value = reply({ verificationRequest: verification });
	h.requests.observeReply(value);
	h.requests.deliverReply(value);
	h.requests.deliverReply(value);
	assert.equal(h.userMessages.length, 1);
});

test("attention can be deferred and explicitly re-exposed", async () => {
	const h = harness();
	const value = reply({ attention });
	h.requests.observeReply(value);
	await h.requests.drainAttentionNow();
	assert.equal(h.customMessages.length, 1);
	h.requests.deferAttention(attention.requestId);
	h.requests.reexposeAttention(attention.requestId);
	await h.requests.drainAttentionNow();
	assert.equal(h.customMessages.length, 2);
	assert.deepEqual(h.hints, [attention.requestId, undefined, attention.requestId]);
});

test("stale attention generation cannot inject after an epoch change", async () => {
	const h = harness();
	const value = reply({ attention });
	h.requests.observeReply(value);
	const pending = h.requests.drainAttentionNow();
	await Promise.resolve();
	h.setEpoch(2);
	await pending;
	assert.equal(h.customMessages.length, 0);
	assert.deepEqual(h.hints, []);
});

test("shutdown reset removes request capabilities", () => {
	const h = harness();
	const value = reply({ verificationRequest: verification, attention });
	h.requests.observeReply(value);
	h.requests.deliverReply(value);
	h.requests.reset("shutdown");
	assert.equal(h.requests.getVerificationRequest(verification.requestId), undefined);
	assert.equal(h.requests.getIntegrationRepairRequest("repair-request"), undefined);
	assert.equal(h.requests.getReigniteRequest("reignite-request"), undefined);
	assert.equal(h.requests.attention, undefined);
});
