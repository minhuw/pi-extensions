import assert from "node:assert/strict";
import test from "node:test";
import { MainSessionRequests, type MainSessionRequestsHost } from "../../../adapters/main-session-requests.ts";
import type { ManagerAttentionRequest, ManagerReply, VerificationRequest } from "../../../src/shared/protocol.ts";

function harness() {
	let epoch = 1;
	let state = { version: 1 as const, mode: "resume" as const, status: "running" as const, runId: "run", repoRoot: "/repo", planDir: "/repo/herder-plans", profile: "default", maxParallel: 1, startedAt: 1, updatedAt: 1 };
	const userMessages: string[] = [];
	const customMessages: unknown[] = [];
	const messageOptions: unknown[] = [];
	const hints: (string | undefined)[] = [];
	let failUserMessage = false;
	const host: MainSessionRequestsHost = {
		packageRoot: "/repo",
		pi: {
			sendUserMessage(message) {
				if (failUserMessage) { failUserMessage = false; throw new Error("temporary delivery failure"); }
				userMessages.push(message);
			},
			sendMessage(message, options) { customMessages.push(message); messageOptions.push(options); },
		},
		current: () => ({ epoch, state, active: true, sessionId: "session", context: { hasUI: false, ui: { notify() {} } as never } }),
		ownsRun: (planDirectory, runId) => planDirectory === state.planDir && runId === state.runId,
		onAttentionHint: (hint) => hints.push(hint),
	};
	return { host, requests: new MainSessionRequests(host), userMessages, customMessages, messageOptions, hints, setEpoch: (value: number) => { epoch = value; }, setState: (value: typeof state) => { state = value; }, fail: () => { failUserMessage = true; } };
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


test("stopped attention is displayed once without triggering a model turn; old Reignite stays backlog", async () => {
	const h = harness();
	const value = reply({ status: "paused", attention, reigniteRequest: { state: "pending", requestId: "old-reignite" } as never });
	for (let index = 0; index < 3; index++) {
		h.requests.observeReply(value);
		h.requests.deliverReply(value);
		await h.requests.settled();
	}
	assert.equal(h.customMessages.length, 1);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: false }]);
	assert.deepEqual(h.userMessages, []);
	const complete = reply({ status: "complete", reigniteRequest: value.reigniteRequest });
	h.requests.deliverReply(complete);
	await h.requests.settled();
	assert.deepEqual(h.userMessages, []);
});


test("durable displayed hint suppresses the same report on session restoration", async () => {
	const h = harness();
	h.requests.observeReply(reply({ attention }));
	await h.requests.settled();
	h.requests.reset("session-start");
	h.requests.restoreAttentionHint(attention.requestId);
	h.requests.observeReply(reply({ status: "paused", attention }));
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
});

test("stopped verification requests never trigger a selector model turn", async () => {
	const h = harness();
	const paused = reply({ status: "stopped", verificationRequest: verification });
	h.requests.observeReply(paused);
	h.requests.deliverReply(paused);
	await h.requests.settled();
	assert.deepEqual(h.userMessages, []);
});


test("budget stop clears cached verification failure even without displayed status", async () => {
	const h = harness();
	const failed = reply({ status: "failed", message: "verification failed" });
	h.requests.observeReply(failed, { status: "failed", message: failed.message });
	const stopped = reply({ status: "paused", verificationRequest: verification, executionBudget: { stopReason: "Spent" } as never });
	h.requests.observeReply(stopped);
	h.requests.deliverReply(stopped);
	await h.requests.settled();
	assert.deepEqual(h.userMessages, []);
});

test("round progress is concise, durable-id deduplicated across resume and session restoration, and never triggers a turn", () => {
	const h = harness();
	const progress = { runId: "run", planId: "PLAN", generation: 1, round: 1, reportId: "judge-action", implementer: { actionId: "implementation", summary: "Updated\nfixture", outcome: "complete", interrupted: false, setup: [], checks: ["unit: passed"] }, fixNext: ["F1: exact repair"], notIntendedToFix: ["F2: excluded"], outcome: "needs input" };
	const value = reply({ status: "stopped", roundProgress: [progress] });
	h.requests.deliverReply(value);
	h.requests.reset("resume");
	h.requests.deliverReply(value);
	assert.equal(h.customMessages.length, 1);
	assert.equal(h.userMessages.length, 0);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: false }]);
	const sent = h.customMessages[0] as { content: string };
	assert.equal(sent.content, "Herder · PLAN · generation 1 · round 1\ndone: implementer: Updated fixture (complete)\nchecks: unit: passed\nfixNext: F1: exact repair\nnotIntendedToFix: F2: excluded\noutcome: needs input");
	const resumed = new MainSessionRequests(h.host);
	resumed.restoreRoundProgress([{ type: "custom_message", ...h.customMessages[0] as object }]);
	resumed.deliverReply(value);
	assert.equal(h.customMessages.length, 1);
	resumed.deliverReply(reply({ roundProgress: [{ ...progress, reportId: "next-terminal-action" }] }));
	assert.equal(h.customMessages.length, 2);
	resumed.deliverReply(reply({ runId: "foreign", roundProgress: [{ ...progress, reportId: "foreign" }] }));
	assert.equal(h.customMessages.length, 2);
});

test("round delivery failure does not acknowledge evidence or create a model turn", () => {
	const h = harness();
	const send = h.host.pi.sendMessage;
	h.host.pi.sendMessage = () => { throw new Error("delivery unavailable"); };
	const value = reply({ roundProgress: [{ runId: "run", planId: "PLAN", generation: 1, round: 1, reportId: "terminal", fixNext: [], notIntendedToFix: [], outcome: "recorded" }] });
	h.requests.deliverReply(value);
	assert.equal(h.customMessages.length, 0);
	h.host.pi.sendMessage = send;
	h.requests.deliverReply(value);
	assert.equal(h.customMessages.length, 1);
	assert.equal(h.userMessages.length, 0);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: false }]);
});
