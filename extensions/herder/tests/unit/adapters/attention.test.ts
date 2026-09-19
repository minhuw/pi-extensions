import assert from "node:assert/strict";
import test from "node:test";
import { attentionMessageDetails, buildAttentionPrompt } from "../../../adapters/attention.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

test("review-budget operator attention labels partial approval as incomplete diagnostic evidence", async () => {
	const request: ManagerAttentionRequest = {
		schemaVersion: 1, requestId: "budget-request", requestSha256: "a".repeat(64), capabilityToken: "b".repeat(64),
		runId: "run", planId: "RUN", generation: 1, round: 1, actionId: "audit", kind: "operator_attention",
		state: "awaiting_input", cause: "review_budget_exhausted", detail: "PARTIAL_RESPONSE: VERDICT: APPROVE",
		detailSha256: "c".repeat(64), continuation: { role: "plan-reviewer", phase: "READY_REVIEWER" },
		createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
	};
	const details = attentionMessageDetails(request);
	assert.match(details.reason!, /budget exhausted; review incomplete \(not approval or a defect\)/);
	assert.match(details.nextAction!, /Record an answer, defer, or stop/);
	const prompt = await buildAttentionPrompt("/unused-package-root", "/fixture/herder-plans", request);
	assert.match(prompt, /^HERDER_STOPPED_ATTENTION_V1/);
	assert.match(prompt, /REQUEST_ID: budget-request/);
	assert.match(prompt, /Safe operator retry requires exact host confirmation and remaining effort budget/);
	assert.match(prompt, /Scope changes never refill budgets/);
	assert.doesNotMatch(prompt, /PROPOSE|Beginning a proposal does not require|Call herder_plan.*revise_run/);
});
