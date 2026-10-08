import assert from "node:assert/strict";
import test from "node:test";
import { MainSessionRequests, type MainSessionRequestsHost } from "../../../adapters/main-session-requests.ts";
import type { IntegrationRepairRequest, ManagerAttentionRequest, ManagerReply, VerificationRequest } from "../../../src/shared/protocol.ts";

function harness() {
	let epoch = 1;
	let state = { version: 1 as const, mode: "resume" as const, status: "running" as const, runId: "run", repoRoot: "/repo", planDir: "/repo/herder-plans", profile: "default", maxParallel: 1, startedAt: 1, updatedAt: 1 };
	const userMessages: string[] = [];
	const customMessages: unknown[] = [];
	const messageOptions: unknown[] = [];
	const hints: (string | undefined)[] = [];
	const warnings: string[] = [];
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
		current: () => ({ epoch, state, active: true, sessionId: "session", context: { hasUI: false, ui: { notify(text: string) { warnings.push(text); } } as never } }),
		ownsRun: (planDirectory, runId) => planDirectory === state.planDir && runId === state.runId,
		onAttentionHint: (hint) => { hints.push(hint); state = { ...state, attentionRequestId: hint } as typeof state; },
	};
	return { host, requests: new MainSessionRequests(host), userMessages, customMessages, messageOptions, hints, warnings, setEpoch: (value: number) => { epoch = value; }, setState: (value: typeof state) => { state = value; }, fail: () => { failUserMessage = true; } };
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


test("stopped attention triggers one diagnosis turn; old Reignite stays backlog", async () => {
	const h = harness();
	const value = reply({ status: "paused", attention, reigniteRequest: { state: "pending", requestId: "old-reignite" } as never });
	for (let index = 0; index < 3; index++) {
		h.requests.observeReply(value);
		h.requests.deliverReply(value);
		await h.requests.settled();
	}
	assert.equal(h.customMessages.length, 1);
	assert.equal((h.customMessages[0] as { display: boolean }).display, false);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
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
	const restored = new MainSessionRequests(h.host);
	restored.restoreAttentionHint(attention.requestId);
	restored.observeReply(reply({ status: "paused", attention }));
	await restored.settled();
	assert.equal(h.customMessages.length, 1);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
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
	for (const evidence of ["PLAN", "Updated fixture", "unit: passed", "F1: exact repair", "F2: excluded", "needs input", "stopped"]) assert.ok(sent.content.includes(evidence), evidence);
	assert.match(sent.content, /Recommended next operation:/);
	assert.doesNotMatch(sent.content, /(?:^|\n)done:|fixNext: none|notIntendedToFix: none/);
	const resumed = new MainSessionRequests(h.host);
	resumed.restoreRoundProgress([{ type: "custom_message", ...h.customMessages[0] as object }]);
	resumed.deliverReply(value);
	assert.equal(h.customMessages.length, 1);
	resumed.deliverReply(reply({ roundProgress: [{ ...progress, reportId: "next-terminal-action" }] }));
	assert.equal(h.customMessages.length, 2);
	resumed.deliverReply(reply({ runId: "foreign", roundProgress: [{ ...progress, reportId: "foreign" }] }));
	assert.equal(h.customMessages.length, 2);
});

test("attempt notification carries the manager pause reason without authorizing a retry", () => {
	const h = harness();
	const stoppedBecause = "V3 browser verification remains incomplete for Scheduler tooltips and private Parquet flows.";
	const pauseReason = "Host worker capacity is unavailable; resume when a child slot is free.";
	const value = reply({ status: "paused", message: pauseReason, roundProgress: [{
		runId: "run", planId: "003", generation: 1, round: 1, reportId: "implementation",
		implementer: { actionId: "implementation", summary: "Implementation committed; worktree clean.", stoppedBecause, commits: ["af558d1"], outcome: "FAILED", interrupted: false, setup: [], checks: ["build passed"] },
		fixNext: [], notIntendedToFix: [], outcome: "FAILED",
	}] });
	h.requests.deliverReply(value);
	const sent = h.customMessages[0] as { content: string };
	for (const fact of [stoppedBecause, pauseReason, "paused", "FAILED", "af558d1"]) assert.ok(sent.content.includes(fact), fact);
	assert.match(sent.content, /Recommended next operation:/);
	assert.doesNotMatch(sent.content, /fixNext: none/);
	assert.deepEqual(h.userMessages, []);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: false }]);
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

test("only matching attention hides progress; all raw evidence and unrelated events survive", async () => {
	const h = harness();
	const progress = {
		runId: "run", planId: "PLAN", generation: 1, round: 1, reportId: "terminal",
		implementer: { actionId: "terminal", outcome: "STOPPED", summary: "Recorded work", stoppedBecause: "Missing second origin", interrupted: false, setup: [], checks: [] },
		fixNext: [], notIntendedToFix: [], outcome: "STOPPED",
	};
	const related = { ...attention, actionId: "terminal" };
	const value = reply({ attention: related, roundProgress: [progress,
		{ ...progress, planId: "OTHER" }, { ...progress, generation: 2 }, { ...progress, round: 2 }, { ...progress, reportId: "different-action" },
	] });
	h.requests.observeReply(value);
	h.requests.deliverReply(value);
	await h.requests.settled();
	const messages = h.customMessages as { customType: string; display: boolean; content: string; details: { collapsed?: string; planDirectory?: string } }[];
	const rounds = messages.filter(message => message.customType === "herder-round-progress-v1");
	assert.deepEqual(rounds.map(message => message.display), [false, true, true, true, true]);
	assert.ok(rounds[0]!.content.includes("Missing second origin"));
	assert.ok(rounds[0]!.details.collapsed!.includes("Missing second origin"));
	assert.equal(messages.filter(message => message.customType === "herder-attention-v1").length, 1);
	assert.equal(messages.at(-1)!.details.planDirectory, "/repo/herder-plans");
	assert.deepEqual(h.userMessages, []);
	const foreign = harness();
	foreign.requests.deliverReply(reply({ attention: { ...related, runId: "foreign" }, roundProgress: [progress] }));
	assert.equal((foreign.customMessages[0] as { display: boolean }).display, true);
	const resolved = harness();
	resolved.requests.deliverReply(reply({ attention: { ...related, state: "resolved" }, roundProgress: [progress] }));
	assert.equal((resolved.customMessages[0] as { display: boolean }).display, true);
});


test("attention delivery failure retries without prematurely persisting its hint", async () => {
	const h = harness();
	const send = h.host.pi.sendMessage;
	h.host.pi.sendMessage = () => { throw new Error("delivery unavailable"); };
	h.requests.observeReply(reply({ attention }));
	await h.requests.settled();
	assert.deepEqual(h.hints, []);
	assert.equal(h.requests.attentionRequestId, undefined);
	h.host.pi.sendMessage = send;
	await h.requests.settled();
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
	assert.deepEqual(h.hints, [attention.requestId]);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
});

for (const transition of ["resolved", "successor", "foreign-run"] as const) {
	test(`queued attention does not deliver after ${transition}`, async () => {
		const h = harness();
		h.requests.observeReply(reply({ attention }));
		const pending = h.requests.drainAttentionNow();
		await Promise.resolve();
		if (transition === "foreign-run") {
			h.setState({ ...h.host.current().state!, runId: "successor-run" } as Parameters<typeof h.setState>[0]);
		} else {
			h.requests.observeReply(reply({ attention: { ...attention,
				...(transition === "resolved" ? { state: "resolved" as const } : { requestId: "successor" }),
			} }));
		}
		await pending;
		assert.deepEqual(h.customMessages, []);
		assert.deepEqual(h.hints, []);
	});
}

const budgetStop = () => reply({ status: "paused", message: "Task 004 implementation budget exhausted",
	executionBudget: { limit: 48, used: 11, remaining: 37, stopReason: "Task 004 implementation budget exhausted" } });

test("budget stop without attention diagnoses once with exact positive grant and resume commands", async () => {
	const h = harness();
	for (let i = 0; i < 3; i++) {
		h.requests.observeReply(budgetStop());
		h.requests.deliverReply(budgetStop());
		await h.requests.settled();
	}
	assert.equal(h.customMessages.length, 1);
	const sent = h.customMessages[0] as { content: string; display: boolean; details: { stopKey: string; requestId?: string } };
	assert.equal(sent.display, false);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
	assert.match(sent.details.stopKey, /^stop:/);
	assert.equal(sent.details.requestId, undefined);
	assert.equal(h.requests.attention, undefined);
	for (const text of ['RUN_ID: run', 'STATUS: paused', 'REASON: Task 004 implementation budget exhausted', '"remaining":37',
		'/herder-budget 1 "/repo/herder-plans" --plan 004 --rounds 1', '/herder-resume "/repo/herder-plans"',
		'one extra total dispatch unit', 'does not promise completion', '/herder-stop', 'read-only', 'Do not edit, run tests']) assert.ok(sent.content.includes(text), text);
	assert.deepEqual(h.userMessages, []);
	assert.deepEqual(h.warnings, []);
});

test("authorized repair begin and in-progress transitions do not diagnose a stop", async () => {
	for (const state of ["active", "committing", "committed", "verifying"] as const) {
		const h = harness();
		const integrationRepair = { ...verification, state, round: 1, maxRounds: 3,
			classification: "code_defect", ownerSessionId: "session", failedGates: [] } as unknown as IntegrationRepairRequest;
		const value = reply({ status: "paused", message: "Integration repair round 1 is authorized for the owning main session.", integrationRepair });
		h.requests.observeReply(value);
		h.requests.deliverReply(value);
		await h.requests.settled();
		assert.deepEqual(h.customMessages, []);
		assert.deepEqual(h.userMessages, []);
		assert.deepEqual(h.hints, []);
		assert.equal(h.requests.getIntegrationRepairRequest(verification.requestId)?.request, integrationRepair);
		// A real budget stop still wins over an in-progress repair.
		h.requests.observeReply({ ...budgetStop(), integrationRepair });
		await h.requests.settled();
		assert.equal(h.customMessages.length, 1);
		assert.match((h.customMessages[0] as { content: string }).content, /^HERDER_STOPPED_DIAGNOSIS_V1/);
	}
});

test("displayed running verification suppresses raw paused stop diagnosis, not budget stops", async () => {
	const h = harness();
	const displayed = { status: "running", message: "Executing final verification gates in the background." };
	const value = reply({ status: "paused", message: "Awaiting final verification",
		operations: [{ kind: "verification", state: "running" }] as ManagerReply["operations"] });
	h.requests.observeReply(value, displayed);
	h.requests.deliverReply(value);
	await h.requests.settled();
	assert.deepEqual(h.customMessages, []);
	assert.deepEqual(h.userMessages, []);
	assert.deepEqual(h.hints, []);
	h.requests.observeReply({ ...value, ...budgetStop() }, displayed);
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
	assert.match((h.customMessages[0] as { content: string }).content, /^HERDER_STOPPED_DIAGNOSIS_V1/);
});

test("stop hints survive polling and restoration, but explicit resume opens another episode", async () => {
	const h = harness();
	h.requests.observeReply(budgetStop());
	await h.requests.settled();
	const hint = h.requests.attentionRequestId!;
	const restored = new MainSessionRequests(h.host);
	restored.restoreAttentionHint(hint);
	restored.observeReply(budgetStop());
	await restored.settled();
	assert.equal(h.customMessages.length, 1);
	restored.reset("resume");
	assert.equal(h.hints.at(-1), undefined);
	restored.observeReply(budgetStop());
	await restored.settled();
	assert.equal(h.customMessages.length, 2);
	restored.observeReply(reply());
	restored.observeReply(reply({ status: "failed", message: "Different failure" }));
	await restored.settled();
	assert.equal(h.customMessages.length, 3);
	assert.notEqual(restored.attentionRequestId, hint);
});

test("generic paused, failed and intentional stops explain without inventing resume", async () => {
	for (const status of ["paused", "failed", "stopped"] as const) {
		const h = harness();
		const value = reply({ status, message: status === "stopped" ? "Stopped by user" : "Unknown failure" });
		h.requests.observeReply(value);
		await h.requests.settled();
		h.requests.observeReply(value);
		await h.requests.settled();
		assert.equal(h.customMessages.length, 1);
		const text = (h.customMessages[0] as { content: string }).content;
		assert.match(text, /do not invent a runnable resume/);
		assert.match(text, /intentional user stop.*do not undo it/);
		assert.doesNotMatch(text, /THEN_USER_COMMAND/);
	}
});

test("stop diagnosis failed delivery retries and only successful injection persists", async () => {
	const h = harness();
	const send = h.host.pi.sendMessage;
	h.host.pi.sendMessage = () => { throw new Error("offline"); };
	h.requests.observeReply(budgetStop());
	await h.requests.settled();
	assert.deepEqual(h.hints, []);
	assert.match(h.warnings[0]!, /could not delegate stop diagnosis/);
	h.host.pi.sendMessage = send;
	await h.requests.settled();
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
	assert.equal(h.hints.length, 1);
});

test("foreign, stale, active revision and successful replies do not diagnose generic stops", async () => {
	for (const value of [reply(), reply({ status: "complete" }), reply({ ...budgetStop(), runId: "foreign" }),
		reply({ ...budgetStop(), runRevision: { editToken: "edit", requestId: "revision", state: "drafting" } }),
		reply({ status: "paused", verificationRequest: verification })]) {
		const h = harness();
		h.requests.observeReply(value);
		await h.requests.settled();
		assert.deepEqual(h.customMessages, []);
	}
	for (const transition of ["epoch", "run", "running"] as const) {
		const h = harness();
		h.requests.observeReply(budgetStop());
		const pending = h.requests.drainAttentionNow();
		if (transition === "epoch") h.setEpoch(2);
		else if (transition === "run") h.setState({ ...h.host.current().state!, runId: "next" } as Parameters<typeof h.setState>[0]);
		else h.requests.observeReply(reply());
		await pending;
		assert.deepEqual(h.customMessages, []);
	}
});

for (const kind of ["decision", "owner"] as const) {
	test(`final verification ${kind} uses one hidden follow-up without duplicate failure notification`, async () => {
		const h = harness();
		const integrationRepair = { ...verification, state: "paused", round: 3, maxRounds: 3,
			classification: "code_defect", ownerSessionId: kind === "owner" ? "foreign" : "session", failedGates: [] } as unknown as IntegrationRepairRequest;
		const value = reply({ status: "paused", message: "Final verification needs a decision", integrationRepair });
		for (let i = 0; i < 2; i++) {
			h.requests.observeReply(value);
			h.requests.deliverReply(value);
			await h.requests.settled();
		}
		assert.equal(h.customMessages.length, 1);
		assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
		const sent = h.customMessages[0] as { content: string; display: boolean };
		assert.equal(sent.display, false);
		assert.ok(sent.content.includes(kind === "owner" ? "VERIFICATION_REPAIR_OWNER_V1" : "VERIFICATION_REPAIR_DECISION_V1"));
		assert.match(sent.content, /First verify the current run\/request/);
		assert.match(sent.content, /\/herder-stop stops the whole active run/);
		assert.deepEqual(h.warnings, []);
		assert.deepEqual(h.userMessages, []);
	});
}


test("live attention takes precedence over budget diagnosis; resolved attention does not", async () => {
	const h = harness();
	h.requests.observeReply({ ...budgetStop(), attention });
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
	assert.match((h.customMessages[0] as { content: string }).content, /^HERDER_STOPPED_ATTENTION_V1/);
	h.requests.observeReply({ ...budgetStop(), attention: { ...attention, state: "resolved" } });
	await h.requests.settled();
	assert.equal(h.customMessages.length, 2);
	assert.match((h.customMessages[1] as { content: string }).content, /^HERDER_STOPPED_DIAGNOSIS_V1/);
});

test("hidden final decision delivery retries without acknowledging a failed send", async () => {
	const h = harness();
	const integrationRepair = { ...verification, state: "paused", round: 3, maxRounds: 3,
		classification: "code_defect", ownerSessionId: "session", failedGates: [] } as unknown as IntegrationRepairRequest;
	const value = reply({ status: "paused", message: "Final verification needs a decision", integrationRepair });
	h.requests.observeReply(value);
	const send = h.host.pi.sendMessage;
	h.host.pi.sendMessage = () => { throw new Error("offline"); };
	await h.requests.settled();
	assert.equal(h.customMessages.length, 0);
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0]!, /could not deliver final verification recovery/);
	h.host.pi.sendMessage = send;
	await h.requests.settled();
	await h.requests.settled();
	assert.equal(h.customMessages.length, 1);
	assert.deepEqual(h.messageOptions, [{ deliverAs: "followUp", triggerTurn: true }]);
});
