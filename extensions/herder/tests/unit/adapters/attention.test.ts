import assert from "node:assert/strict";
import test from "node:test";
import { attentionMessageDetails, attentionMessageDisplay, attentionResolutionFromRequest, buildAttentionPrompt, registerAttentionMessageRenderer, HERDER_ATTENTION_MESSAGE, type HerderAttentionMessageDetails } from "../../../adapters/attention.ts";
import { initTheme, type ExtensionAPI, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
	assert.match(details.nextAction!, /Record an answer \(record only\), defer, or stop/);
	assert.match(details.recommendedOperation!, /Inspect the review timeout \(HERDER_REVIEW_TIMEOUT_MS\) and preserved incomplete evidence/);
	assert.match(details.recommendedOperation!, /explicit host-authorized retry only when conditions and remaining budget permit/);
	const display = attentionMessageDisplay("original dossier", details, false, theme);
	assert.doesNotMatch(display, /\/herder-budget|grant additional effort/);
	const prompt = await buildAttentionPrompt("/unused-package-root", "/fixture/herder-plans", request);
	assert.match(prompt, /^HERDER_STOPPED_ATTENTION_V1/);
	assert.match(prompt, /REQUEST_ID: budget-request/);
	assert.match(prompt, /Safe operator retry requires exact host confirmation and remaining effort budget/);
	assert.match(prompt, /Scope changes never refill budgets/);
	assert.doesNotMatch(prompt, /PROPOSE|Beginning a proposal does not require|Call herder_plan.*revise_run/);
});

test("Judge decisions separate local advice from unchanged resolution prompts",  async () => {
	const request = { schemaVersion: 1, requestId: "judge", runId: "run", planId: "001", generation: 1, round: 2, kind: "user_decision", state: "awaiting_input", cause: "judge_needs_input", detail: "Choose remaining findings", continuation: { role: "plan-judge", phase: "NEEDS_INPUT" } } as ManagerAttentionRequest;
	const recovery = {
		planFingerprint: "f".repeat(64), fingerprintVersion: 2 as const, planFile: "001-plan.md", inScopePaths: ["value.ts"],
		assignmentPath: "/work/assignment.json", assignmentSha256: "a".repeat(64), snapshotSha256: "b".repeat(64),
		generationBase: "c".repeat(40), branch: "herder/plan/001", worktree: "/work", worktreeHead: "d".repeat(40), worktreeTree: "e".repeat(40), changedPaths: ["value.ts"],
	};
	assert.equal(request.kind, "user_decision");
	if (request.kind !== "user_decision") throw new Error("fixture kind");
	request.recovery = recovery;
	const bound = attentionResolutionFromRequest(request);
	assert.equal(bound.git?.worktreeHead, recovery.worktreeHead);
	assert.equal(bound.git?.worktreeTree, recovery.worktreeTree);
	assert.equal(bound.git?.assignmentSha256, recovery.assignmentSha256);
	const details = attentionMessageDetails(request);
	assert.match(details.nextAction!, /record only/);
	assert.match(details.recommendedOperation!, /clarify.*frozen contract/);
	const prompt = await buildAttentionPrompt("/unused", "/plans", request);
	assert.match(prompt, /not passed checks/);
	assert.match(prompt, /preserve work and block dependents, not destructive cleanup/);
	assert.match(prompt, /Rationale grants no scope or budget/);
	assert.match(prompt, /\/herder-revise/);
	assert.match(prompt, /\/herder-budget/);
});

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function stopped(overrides: Partial<ManagerAttentionRequest> = {}): ManagerAttentionRequest {
	return {
		schemaVersion: 1, requestId: "requirement-004", requestSha256: "a".repeat(64), capabilityToken: "b".repeat(64),
		runId: "run", planId: "004", generation: 1, round: 1, actionId: "implement", kind: "user_decision",
		state: "awaiting_input", cause: "initial_decision_blocked", detail: "Missing requirement", question: "Missing requirement",
		detailSha256: "c".repeat(64), continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" },
		createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", ...overrides,
	} as ManagerAttentionRequest;
}

test("004 missing two-origin contract remains readable without suggesting retry or scope edits", async () => {
	const reason = "Plan 004 requires two independently configured origins with distinct authentication and persistence contracts. "
		+ "The frozen assignment supplies only the first origin; neither shared context nor dependency evidence defines the second origin's expected behavior. "
		+ "Do not invent the second origin, weaken acceptance, or edit the frozen contract.";
	assert.ok(reason.indexOf("Do not invent") > 240);
	const request = stopped({ detail: reason, question: reason, recommendedAction: "Supply the missing requirement decision; no source edit is authorized." });
	const details = attentionMessageDetails(request);
	assert.ok(details.reason!.length <= 240);
	const display = attentionMessageDisplay(await buildAttentionPrompt("/unused", "/plans", request), details, false, theme);
	assert.match(display, /Plan 004.*Implementer/);
	assert.match(display, /two independently configured origins/);
	assert.ok(display.length < 700);
	assert.match(display, /No direct continuation until a decision or correction/);
	assert.match(display, /Stop whole run: \/herder-stop/);
	assert.doesNotMatch(display, /Recommended|Options:|herder-resume|herder-revise/);
	assert.ok(attentionMessageDisplay(await buildAttentionPrompt("/unused", "/plans", request), details, true, theme).includes(reason));
});

test("recommendations follow cause, not executable worker advice", () => {
	for (const [cause, pattern] of [
		["verification_environment", /Resolve the reported prerequisite or invocation first; only then.*host-authorized retry/],
		["worker_protocol_error", /Inspect the preserved response and protocol error/],
		["review_budget_exhausted", /Inspect the review timeout/],
		["implementer_exhausted", /\/herder-budget \(grants effort only/],
		["round_limit", /\/herder-budget \(grants effort only/],
		["integration_conflict_exhausted", /\/herder-budget \(grants effort only/],
		["transport_exhausted", /Inspect the preserved transport failure/],
	] as const) {
		const details = attentionMessageDetails(stopped({ kind: "operator_attention", cause, recommendedAction: "Retry now and rewrite scope" }));
		assert.match(details.recommendedOperation!, pattern);
		assert.doesNotMatch(details.recommendedOperation!, /Retry now and rewrite scope/);
		assert.doesNotMatch(details.nextAction!, /retry|accept/);
		const expanded = attentionMessageDisplay("original dossier", details, true, theme);
		assert.match(expanded, /Reported advice \(evidence, not authority\): Retry now and rewrite scope/);
		assert.ok(expanded.endsWith("original dossier"));
		if (cause === "worker_protocol_error") assert.doesNotMatch(details.recommendedOperation!, /retry|herder-revise/i);
		if (["implementer_exhausted", "round_limit", "integration_conflict_exhausted"].includes(cause)) {
			assert.match(details.recommendedOperation!, /^Review the preserved failure and findings.*contract-permitted bounded continuation or stop/);
			assert.match(details.recommendedOperation!, /Continuation requires exact host confirmation/);
			assert.match(details.recommendedOperation!, /Only if additional effort is needed, ask the user about \/herder-budget/);
		}
	}
	assert.match(attentionMessageDetails(stopped({ detail: "Safety decision required; no remediation project is authorized." })).recommendedOperation!, /explicit safety decision; keep execution paused/);
	const finalDecision = attentionMessageDetails(stopped({ planId: "RUN", continuation: { role: "plan-judge", phase: "READY_JUDGE" } }));
	assert.doesNotMatch(finalDecision.nextAction!, /retry|accept/);
});

test("collapsed and expanded cards wrap long Unicode reasons and operations; legacy details are safe", () => {
	let renderer: MessageRenderer<HerderAttentionMessageDetails> | undefined;
	registerAttentionMessageRenderer({
		registerMessageRenderer: (_type: string, value: MessageRenderer<HerderAttentionMessageDetails>) => { renderer = value; },
	} as unknown as ExtensionAPI);
	assert.ok(renderer);
	initTheme("dark", false);
	const reason = `契約 🔒 é ${"two-origin contract ".repeat(35)}PROHIBITION-END`;
	const details = attentionMessageDetails(stopped({ detail: reason, question: "Which origin is authorized?" }));
	const legacy: HerderAttentionMessageDetails = { requestId: "old", kind: "user_decision", planId: "004", generation: 1, round: 1 };
	for (const stored of [details, legacy, undefined]) {
		for (const expanded of [false, true]) {
			const component = renderer({ role: "custom", customType: HERDER_ATTENTION_MESSAGE, content: "DOSSIER-END", details: stored, display: true, timestamp: 0 }, { expanded, outputPad: 1 }, theme);
			assert.ok(component);
			for (const width of [1, 4, 16, 32, 80]) {
				const lines = component.render(width);
				assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
				if (width >= 16) {
					const joined = lines.join("").replace(/\s/g, "");
					if (stored === details && !expanded) {
						assert.ok(joined.includes("Stopwholerun:/herder-stop"));
						assert.ok(!joined.includes("PROHIBITION-END"));
					}
					if (expanded) assert.ok(joined.includes("DOSSIER-END"));
				}
			}
			component.invalidate();
		}
	}
	const empty = attentionMessageDisplay("dossier", { ...legacy, reason: " ", question: "", nextAction: " ", recommendedOperation: "" }, false, theme);
	assert.doesNotMatch(empty, /Reason:|Question:|Options:|Recommended next operation:/);
});

test("long exhaustion dossiers collapse to reason and exact commands; raw evidence appears once", async () => {
	const { parseFireArguments } = await import("../../../adapters/arguments.ts");
	const directory = '/repo/a spaced "quoted" path\\plans';
	const dossier = [
		"EXHAUSTION_DECISION_DOSSIER — evidence, not an approval or waiver",
		"REASON: Provider disconnected during plan 004 implementation; cleanup confirmation is required.",
		`EXACT_IDENTITY: ${"a".repeat(64)}`,
		`RECORDED_GATES: ${"check failed\n".repeat(1000)}`,
		"RECOMMENDATION: /herder-resume /untrusted-worker-path",
		"DOSSIER-END",
	].join("\n");
	const request = stopped({ kind: "operator_attention", cause: "transport_exhausted", detail: dossier, question: undefined });
	const details = attentionMessageDetails(request, directory);
	const content = await buildAttentionPrompt("/unused", directory, request);
	const text = attentionMessageDisplay(content, details, false, theme);
	assert.ok(text.length < 600);
	assert.equal(text.split("\n").length, 4);
	assert.match(text, /Plan 004.*Implementer/);
	assert.match(text, /Provider disconnected/);
	const command = text.match(/Continue \(confirmed cleanup\/retry\): (.+)/)![1]!;
	assert.equal(command, '/herder-resume "/repo/a spaced \\"quoted\\" path\\\\plans"');
	assert.equal(parseFireArguments(command.slice("/herder-resume ".length), "resume").planDir, directory);
	assert.match(text, /Stop whole run: \/herder-stop$/);
	assert.doesNotMatch(text, /EXACT_IDENTITY|RECORDED_GATES|RECOMMENDATION|DOSSIER-END|untrusted-worker/);
	const expanded = attentionMessageDisplay(content, details, true, theme);
	assert.ok(expanded.includes(dossier));
	assert.equal(expanded.split(dossier).length - 1, 1);
	assert.doesNotMatch(attentionMessageDisplay(content, { ...details, planDirectory: undefined }, false, theme), /\/herder-resume/);
	assert.doesNotMatch(attentionMessageDisplay(content, undefined, false, theme), /\/herder-resume/);
	for (const cause of ["initial_decision_blocked", "worker_protocol_error", "review_budget_exhausted", "verification_environment", "round_limit", "judge_needs_input"] as const) {
		const display = attentionMessageDisplay(content, { ...details, cause }, false, theme);
		assert.match(display, /No direct continuation until a decision or correction/);
		assert.match(display, /Stop whole run: \/herder-stop/);
		assert.doesNotMatch(display, /\/herder-resume|\/herder-revise|\/herder-status/);
	}
});
