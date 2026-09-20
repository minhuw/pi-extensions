import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSyntheticSourceInfo, wrapRegisteredTool, initTheme, type ExtensionRunner, type ToolDefinition, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { runAgentLoop, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { parseGrillPlanTarget } from "../../../adapters/arguments.ts";
import { assertActiveFireGrillTarget, noDeterministicRunMessage } from "../../../adapters/run-guidance.ts";
import { attentionCapabilityToken, validateAttentionResolution } from "../../../src/shared/protocol.ts";
import { attentionResolutionFromArgs } from "../../../src/application/tools.ts";
import {
	HERDER_ATTENTION_MESSAGE,
	attentionMessageDetails,
	attentionMessageDisplay,
	attentionResolutionFromRequest,
	buildAttentionPrompt,
	confirmPlanAcceptance,
	registerAttentionMessageRenderer,
	type HerderAttentionMessageDetails,
} from "../../../adapters/attention.ts";
import {
	buildPlanningSkillPrompt,
	executePiPlanCommand,
	formatPlanCommandResult,
	launchPlanningWorkflow,
	registerPiPlanningWorkflows,
} from "../../../adapters/planning-workflows.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

test("active Fire rejects explicit Grill splitting before target reservation", () => {
	assert.doesNotThrow(() => assertActiveFireGrillTarget(parseGrillPlanTarget("--plan 7")));
	assert.throws(
		() => assertActiveFireGrillTarget(parseGrillPlanTarget("--plan 7 --split")),
		/error|split cannot run during active Herder Fire|target-local/i,
	);
});

test("no-run guidance is specific to Revise", () => {
	const revise = noDeterministicRunMessage("revise", "/repo/herder-plans");
	assert.match(revise, /revise only adopts a validated graph generation into an existing deterministic run/);
	assert.match(revise, /herder-grill --plan <id-or-path> --split --plan-dir <plan-dir>/);
	const resume = noDeterministicRunMessage("resume", "/repo/herder-plans");
	assert.equal(resume, "No deterministic Herder run exists in /repo/herder-plans.");
	assert.doesNotMatch(resume, /herder-grill|split/);
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-planning-"));
	for (const skill of [
		{ directory: "improve", name: "herder-improve", title: "Improve", instruction: "Read [the playbook](references/playbook.md), then audit." },
		{ directory: "simplify", name: "herder-simplify", title: "Simplify", instruction: "Read [the simplification playbook](references/simplification-playbook.md), then reduce." },
	]) {
		const directory = path.join(root, "skills", skill.directory);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "SKILL.md"), `---
name: ${skill.name}
description: Audit a repository.
---

# ${skill.title}

${skill.instruction}
`);
	}
	return root;
}

test("final RUN attention prompts retain their separate request bindings and actions", async () => {
	const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const common = {
		schemaVersion: 1 as const,
		requestId: "request-001",
		runId: "run-001",
		planId: "RUN",
		generation: 1,
		round: 2,
		actionId: "action-001",
		requestSha256: "a".repeat(64),
		state: "awaiting_input" as const,
		cause: "judge_needs_input" as const,
		detail: "A bounded decision is required.",
		detailSha256: "b".repeat(64),
		continuation: { role: "plan-judge" as const, phase: "READY_JUDGE" as const },
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-12T00:00:00.000Z",
		capabilityToken: "c".repeat(64),
	};
	const userPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", {
		...common,
		kind: "user_decision",
		question: "Which recorded decision should the Judge use?",
	} as ManagerAttentionRequest);
	assert.match(userPrompt, /^HERDER_STOPPED_ATTENTION_V1/m);
	assert.match(userPrompt, /next round \(retry\)/);
	assert.match(userPrompt, /accept as-is \(accept\)/);
	assert.match(userPrompt, /answer_and_resume requires exact host confirmation/);
	assert.match(userPrompt, /without scope, acceptance, permission or dependency changes/);
	assert.match(userPrompt, /Scope changes never refill budgets/);

	assert.match(userPrompt, /QUESTION: Which recorded decision should the Judge use\?/);
	assert.match(userPrompt, /PLAN_DIRECTORY: \/repo\/herder-plans/);
	assert.match(userPrompt, /REQUEST_ID: request-001/);
	assert.match(userPrompt, /PLAN_ID: RUN/);
	assert.match(userPrompt, /GENERATION: 1/);
	assert.match(userPrompt, /ROUND: 2/);
	assert.match(userPrompt, /CONTINUATION_ROLE: plan-judge/);
	assert.match(userPrompt, /CAUSE: judge_needs_input/);
	assert.doesNotMatch(userPrompt, /SCHEMA_VERSION|schemaVersion|REQUEST_SHA256|CAPABILITY_TOKEN|RUN_ID|DETAIL_SHA256/);
	assert.doesNotMatch(userPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);

	const operatorPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", {
		...common,
		requestId: "request-002",
		kind: "operator_attention",
		cause: "transport_exhausted",
		question: "Retry the recorded role or stop it?",
	} as ManagerAttentionRequest);
	assert.match(operatorPrompt, /^HERDER_STOPPED_ATTENTION_V1/m);
	assert.match(operatorPrompt, /REQUEST_ID: request-002/);
	assert.match(operatorPrompt, /PLAN_ID: RUN/);
	assert.match(operatorPrompt, /GENERATION: 1/);
	assert.match(operatorPrompt, /ROUND: 2/);
	assert.match(operatorPrompt, /Safe operator retry requires exact host confirmation/);
	assert.doesNotMatch(operatorPrompt, /SCHEMA_VERSION|schemaVersion|REQUEST_SHA256|CAPABILITY_TOKEN|RUN_ID|DETAIL_SHA256/);
	assert.doesNotMatch(operatorPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);

	const recoveryPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", {
		...common,
		requestId: "request-003",
		kind: "plan_recovery",
		cause: "reviewer_blocked",
		state: "pending",
		recovery: {
			planFingerprint: "d".repeat(64),
			fingerprintVersion: 2,
			planFile: "001-plan.md",
			inScopePaths: ["src/value.mjs"],
			inScopePathCount: 1,
			inScopePathsSha256: "e".repeat(64),
			assignmentPath: "/repo/herder-plans/.herder/assignment.json",
			assignmentSha256: "f".repeat(64),
			snapshotSha256: "1".repeat(64),
			generationBase: "2".repeat(40),
			branch: "herder/herder-plans/001",
			worktree: "/repo/herder-plans/.herder/worktrees/001",
			worktreeHead: "3".repeat(40),
			worktreeTree: "4".repeat(40),
			changedPaths: ["src/value.mjs"],
			changedPathCount: 1,
			changedPathsSha256: "5".repeat(64),
		},
	} as ManagerAttentionRequest);
	assert.match(recoveryPrompt, /^HERDER_STOPPED_ATTENTION_V1/m);
	assert.doesNotMatch(recoveryPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);
	assert.match(recoveryPrompt, /REQUEST_ID: request-003/);
	assert.match(recoveryPrompt, /PLAN_ID: RUN/);
	assert.match(recoveryPrompt, /GENERATION: 1/);
	assert.match(recoveryPrompt, /ROUND: 2/);
	assert.match(recoveryPrompt, /CONTINUATION_ROLE: plan-judge/);
	assert.match(recoveryPrompt, /CAUSE: reviewer_blocked/);
	assert.match(recoveryPrompt, /ALLOWED_ACTIONS: next round \(retry\)/);
	assert.match(recoveryPrompt, /001-plan\.md/);
	assert.match(recoveryPrompt, /"changedPaths":/);
	assert.doesNotMatch(recoveryPrompt, /SCHEMA_VERSION|schemaVersion|REQUEST_SHA256|CAPABILITY_TOKEN|RUN_ID|DETAIL_SHA256|RECOVERY_GIT_IDENTITY/);
});

test("attention messages render a compact card while preserving the full prompt", async () => {
	const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const request = {
		schemaVersion: 1 as const,
		requestId: "request-card",
		runId: "run-card",
		planId: "017",
		generation: 2,
		round: 2,
		actionId: "action-card",
		requestSha256: "a".repeat(64),
		state: "awaiting_input" as const,
		kind: "user_decision" as const,
		cause: "judge_needs_input" as const,
		detail: "The Judge needs a bounded product decision.",
		detailSha256: "b".repeat(64),
		continuation: { role: "plan-judge" as const, phase: "READY_JUDGE" as const },
		question: "Should the optional compatibility alias remain in scope?",
		recommendedAction: "Answer the Judge question.",
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-12T00:00:00.000Z",
		capabilityToken: "secret-capability-token",
	} satisfies ManagerAttentionRequest;
	const prompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", request);
	const details = attentionMessageDetails(request);
	assert.deepEqual(details, {
		requestId: "request-card",
		kind: "user_decision",
		planId: "017",
		generation: 2,
		round: 2,
		cause: "judge_needs_input",
		role: "plan-judge",
		phase: "READY_JUDGE",
		reason: "Should the optional compatibility alias remain in scope?",
		nextAction: "Next round (retry), accept as-is (accept), or drop plan (reject). /herder-revise changes scope; /herder-budget grants effort separately.",
	});
	assert.doesNotMatch(JSON.stringify(details), /secret-capability-token/);
	const operatorDetails = attentionMessageDetails({
		...request,
		kind: "operator_attention",
		cause: "transport_exhausted",
		question: undefined,
	});
	assert.equal(operatorDetails.reason, "Transport exhausted");
	assert.equal(operatorDetails.nextAction, "Record an answer, defer, or stop. Scope and effort changes require separate user authorization.");
	for (const blocker of ["ENVIRONMENT", "INVOCATION"]) {
		const explanation = "Chromium executable unavailable; prepare the pinned browser before retrying.";
		const environmentRequest = {
			...request,
			kind: "operator_attention" as const,
			cause: "verification_environment" as const,
			question: undefined,
			detail: [
				`WORKER_SELF_REPORT: ${blocker}; role=plan-implementer; mode=INITIAL; round=2`,
				`WORKTREE: /repo/${"long-directory/".repeat(30)}001`,
				explanation,
				"CHECKS (worker evidence, not authoritative verification):",
				"npm run test:e2e — blocked",
			].join("\n"),
		};
		assert.ok(attentionMessageDetails(environmentRequest).reason?.startsWith(explanation));
		const environmentPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", environmentRequest);
		assert.ok(environmentPrompt.includes(environmentRequest.detail), "display compaction must not change the dossier");
		assert.equal(attentionMessageDetails({ ...environmentRequest, detail: explanation }).reason, explanation);
	}

	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const collapsed = attentionMessageDisplay(prompt, details, false, theme, "ctrl+o for full dossier");
	assert.match(collapsed, /Herder attention  Plan 017 · Judge · round 2/);
	assert.match(collapsed, /Reason: Should the optional compatibility alias remain in scope\?/);
	assert.match(collapsed, /Next: Next round \(retry\), accept as-is \(accept\), or drop plan \(reject\)/);
	assert.match(collapsed, /ctrl\+o for full dossier/);
	assert.doesNotMatch(collapsed, /HERDER_MAIN_SESSION|REQUEST_ID|secret-capability-token/);

	const expanded = attentionMessageDisplay(prompt, details, true, theme);
	assert.match(expanded, /generation 2 · phase READY_JUDGE · request request-card/);
	assert.ok(expanded.endsWith(prompt), "expanded display retains the exact model-facing prompt");

	let capturedRenderer: MessageRenderer<HerderAttentionMessageDetails> | undefined;
	registerAttentionMessageRenderer({
		registerMessageRenderer: (customType: string, renderer: MessageRenderer<HerderAttentionMessageDetails>) => {
			assert.equal(customType, HERDER_ATTENTION_MESSAGE);
			capturedRenderer = renderer;
		},
	} as unknown as ExtensionAPI);
	const renderer = capturedRenderer;
	assert.ok(renderer);
	initTheme("dark", false);
	const message = {
		role: "custom" as const,
		customType: HERDER_ATTENTION_MESSAGE,
		content: prompt,
		display: true,
		details,
		timestamp: 0,
	};
	for (const expandedView of [false, true]) {
		for (const width of [1, 4, 16, 40, 80]) {
			const component = renderer(message, { expanded: expandedView, outputPad: 1 }, theme);
			assert.ok(component);
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
		}
	}
	const compactComponent = renderer(message, { expanded: false, outputPad: 1 }, theme);
	assert.ok(compactComponent);
	assert.equal(compactComponent.render(80).length, 6, "collapsed card stays four content lines plus padding");

	const legacy = attentionMessageDisplay(prompt, {
		requestId: details.requestId,
		kind: details.kind,
		planId: details.planId,
		generation: details.generation,
		round: details.round,
	}, false, theme, "ctrl+o for full dossier");
	assert.match(legacy, /Plan 017 · round 2/);
	assert.doesNotMatch(legacy, /HERDER_MAIN_SESSION/);
	assert.ok(attentionMessageDisplay(prompt, undefined, true, theme).endsWith(prompt));
});

test("adapter binds complete attention evidence, including recovery Git identity", async () => {
	const base = {
		requestId: "request-001",
		runId: "run-001",
		planId: "001",
		generation: 1,
		round: 2,
		actionId: null,
		requestSha256: "a".repeat(64),
		state: "awaiting_input" as const,
		cause: "judge_needs_input" as const,
		detail: "A bounded decision is required.",
		detailSha256: "b".repeat(64),
		continuation: { role: "plan-judge" as const, phase: "READY_JUDGE" as const },
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-12T00:00:00.000Z",
	};
	const expectedBinding = {
		schemaVersion: 1 as const,
		requestId: base.requestId,
		requestSha256: base.requestSha256,
		capabilityToken: attentionCapabilityToken(base.requestId),
		runId: base.runId,
		planId: base.planId,
		generation: base.generation,
		round: base.round,
		continuation: base.continuation,
	};
	const userBinding = attentionResolutionFromRequest({
		...base,
		kind: "user_decision",
		question: "Which decision?",
	} as ManagerAttentionRequest);
	assert.deepEqual(userBinding, expectedBinding);
	validateAttentionResolution({ ...userBinding, action: "answer", answer: "Use the evidence." });

	const operatorBinding = attentionResolutionFromRequest({
		...base,
		requestId: "request-002",
		kind: "operator_attention",
		question: "Retry or stop?",
	} as ManagerAttentionRequest);
	assert.deepEqual(operatorBinding, {
		...expectedBinding,
		requestId: "request-002",
		capabilityToken: attentionCapabilityToken("request-002"),
	});
	validateAttentionResolution({ ...operatorBinding, action: "retry" });

	const recovery = {
		planFingerprint: "d".repeat(64),
		fingerprintVersion: 2 as const,
		planFile: "001-plan.md",
		inScopePaths: ["src/value.mjs"],
		assignmentPath: "/repo/herder-plans/.herder/assignment.json",
		assignmentSha256: "f".repeat(64),
		snapshotSha256: "1".repeat(64),
		generationBase: "2".repeat(40),
		branch: "herder/herder-plans/001",
		worktree: "/repo/herder-plans/.herder/worktrees/001",
		worktreeHead: "3".repeat(40),
		worktreeTree: "4".repeat(40),
		changedPaths: ["src/value.mjs"],
	};
	const recoveryRequest = { ...base, schemaVersion: 1 as const, kind: "plan_recovery" as const, recovery };
	const recoveryBinding = attentionResolutionFromRequest(recoveryRequest);
	assert.deepEqual(recoveryBinding, {
		...expectedBinding,
		git: {
			assignmentPath: recovery.assignmentPath,
			assignmentSha256: recovery.assignmentSha256,
			snapshotSha256: recovery.snapshotSha256,
			generationBase: recovery.generationBase,
			branch: recovery.branch,
			worktree: recovery.worktree,
			worktreeHead: recovery.worktreeHead,
			worktreeTree: recovery.worktreeTree,
		},
	});
	validateAttentionResolution({ ...recoveryBinding, action: "defer" });

	const exhausted = { ...recoveryRequest, round: 3 };
	const choice = { answer: "Accept the missing optional export; retain its failed check.", rationale: "The user accepts the reduced scope." };
	const confirmations: string[] = [];
	const ctx = { hasUI: true, ui: { confirm: async (_title: string, text: string) => { confirmations.push(text); return true; } } } as Pick<ExtensionContext, "hasUI" | "ui">;
	await confirmPlanAcceptance(exhausted, choice, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!, /Generation 1, round 3/);
	assert.ok(confirmations[0]!.includes(recovery.worktreeHead));
	assert.ok(confirmations[0]!.includes(recovery.worktreeTree));
	assert.ok(confirmations[0]!.includes(choice.answer));
	assert.match(confirmations[0]!, /Failed checks remain recorded as failed/);
	await assert.rejects(confirmPlanAcceptance(exhausted, choice, { ...ctx, hasUI: false }), /interactive user confirmation/);
	await assert.rejects(confirmPlanAcceptance(exhausted, { ...choice, answer: " " }, ctx), /explicit accepted gaps/);
	await assert.rejects(confirmPlanAcceptance(exhausted, { ...choice, rationale: " " }, ctx), /non-empty rationale/);
	await assert.rejects(confirmPlanAcceptance(recoveryRequest, choice, ctx), /exhausted-plan recovery/);
	await assert.rejects(confirmPlanAcceptance({ ...exhausted, state: "resolved" }, choice, ctx), /unresolved/);
	assert.equal(confirmations.length, 1, "invalid requests never prompt for confirmation");
	await assert.rejects(confirmPlanAcceptance(exhausted, choice, {
		...ctx, ui: { ...ctx.ui, confirm: async () => false },
	}), /Acceptance declined/);

	const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const prompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", exhausted);
	assert.match(prompt, /ALLOWED_ACTIONS: next round \(retry\)/);
	assert.match(prompt, /accept as-is \(accept\).*not passed checks/);
	assert.match(prompt, /drop plan \(reject\).*not destructive cleanup/);
	assert.ok(prompt.includes(recovery.worktreeHead));
	assert.ok(prompt.includes(recovery.worktreeTree));
	assert.match(prompt, /Only the user may invoke \/herder-revise/);
	assert.match(prompt, /No automatic retry, plan rewrite, cleanup or successor work/);
	assert.doesNotMatch(prompt, /PROPOSE|ALLOWED_ACTIONS: revise_run|Beginning a proposal does not require/);
});

test("attention tool inputs round-trip with the fixed resolution schema", () => {
	const resolution = attentionResolutionFromArgs({
		planDirectory: "/repo/herder-plans",
		operation: "attention",
		kind: "attention",
		requestId: "request-001",
		requestSha256: "a".repeat(64),
		capabilityToken: "c".repeat(64),
		runId: "run-001",
		planId: "001",
		generation: 1,
		round: 2,
		action: "answer",
		answer: "Use the recorded evidence.",
	});
	validateAttentionResolution(resolution);
	assert.equal(resolution.schemaVersion, 1);
	assert.equal(resolution.requestId, "request-001");
	assert.equal(resolution.action, "answer");
});

test("attention schema is minimal and normalizes legacy stored calls", () => {
	const tools: Array<{
		name?: string;
		parameters?: unknown;
		prepareArguments?: (input: unknown) => unknown;
	}> = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: { name?: string; parameters?: unknown; prepareArguments?: (input: unknown) => unknown }) => { tools.push(tool); },
	} as unknown as ExtensionAPI;
	registerPiPlanningWorkflows(pi, "/repo/herder", async () => "/repo", { assertMutationAllowed: () => {} });
	const tool = tools.find((candidate) => candidate.name === "herder_plan");
	assert.ok(tool?.parameters);
	const actionDescription = (tool.parameters as { properties: { action: { description: string } } }).properties.action.description;
	assert.match(actionDescription, /answer records only; defer or stop preserves evidence/);
	assert.match(actionDescription, /Safe operator retry requires host confirmation/);
	assert.match(actionDescription, /never initiated by this tool/);
	assert.ok(tool.prepareArguments);
	const minimal = {
		operation: "attention",
		planDirectory: "/repo/herder-plans",
		requestId: "request-001",
		action: "defer",
	};
	assert.equal(Check(tool.parameters as never, minimal), true);
	assert.equal(Check(tool.parameters as never, { ...minimal, requestSha256: "a".repeat(64) }), false);
	assert.equal(Check(tool.parameters as never, { ...minimal, confirmed: true }), false);
	const prepared = tool.prepareArguments!({
		...minimal,
		planId: "caller-controlled-plan",
		schemaVersion: 99,
		requestSha256: "0".repeat(64),
		capabilityToken: "0".repeat(64),
		runId: "caller-controlled-run",
		generation: 99,
		round: 6,
		confirmed: true,
		continuation: { role: "plan-judge", phase: "JUDGING" },
		git: { branch: "caller-controlled-branch" },
	}) as Record<string, unknown>;
	assert.deepEqual(prepared, {
		...minimal,
		planId: "caller-controlled-plan",
	});
	const nonAttention = { operation: "status", planDirectory: "/repo/herder-plans", requestSha256: "legacy" };
	assert.equal(tool.prepareArguments!(nonAttention), nonAttention);
});

test("rework finish handled by the ownership hook is not submitted twice", async () => {
	const root = await fixture();
	const tools: Array<{ name?: string; executionMode?: string; parameters?: unknown; execute?: (...args: any[]) => Promise<unknown> }> = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: { name?: string; executionMode?: string; parameters?: unknown; execute?: (...args: any[]) => Promise<unknown> }) => { tools.push(tool); },
	} as unknown as ExtensionAPI;
	let handled = 0;
	try {
		registerPiPlanningWorkflows(pi, root, async () => path.dirname(root), {
			assertMutationAllowed: () => {},
			beforePlanOperation: async () => {
				handled += 1;
				return { handled: true, result: { edit: { planId: "001", state: "barrier" }, reply: { status: "running" } } };
			},
		});
		const tool = tools.find((candidate) => candidate.name === "herder_plan");
		assert.ok(tool?.execute);
		assert.equal(tool.executionMode, "sequential");
		assert.doesNotMatch(JSON.stringify(tool.parameters), /"intent"/);
		assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false);
		assert.equal(Check(tool.parameters as never, {
			operation: "begin_edit",
			planDirectory: root,
			planId: "001",
			intent: "rework",
		}), false);
		const result = await tool.execute(
			"finish",
			{ operation: "finish_edit", planDirectory: root, editToken: "00000000-0000-0000-0000-000000000001" },
			undefined,
			undefined,
			{ isProjectTrusted: () => true } as ExtensionCommandContext,
		) as { isError?: boolean; details?: { result?: unknown } };
		assert.equal(result.isError, undefined);
		assert.equal(handled, 1);
		assert.deepEqual(result.details?.result, { edit: { planId: "001", state: "barrier" }, reply: { status: "running" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("attention authorization runs before the deterministic manager mutation", async () => {
	const root = await fixture();
	const tools: Array<{ name?: string; execute?: (...args: any[]) => Promise<unknown> }> = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: { name?: string; execute?: (...args: any[]) => Promise<unknown> }) => { tools.push(tool); },
	} as unknown as ExtensionAPI;
	let authorizationChecks = 0;
	try {
		registerPiPlanningWorkflows(pi, root, async () => path.dirname(root), {
			assertMutationAllowed: () => {},
			bindAttention: async (input, ctx) => {
				await Promise.resolve();
				authorizationChecks += 1;
				assert.equal(input.action, "defer");
				assert.equal("confirmed" in input, false);
				assert.equal(ctx.isProjectTrusted(), true);
				throw new Error("This Pi session does not own the attention request.");
			},
		});
		const tool = tools.find((candidate) => candidate.name === "herder_plan");
		assert.ok(tool?.execute);
		await assert.rejects(() => tool.execute!(
			"attention",
			{
				operation: "attention",
				planDirectory: root,
				requestId: "request-001",
				action: "defer",
				confirmed: true,
			},
			undefined,
			undefined,
			{ isProjectTrusted: () => true } as ExtensionCommandContext,
		), /does not own/);
		assert.equal(authorizationChecks, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("registered herder_plan failures and handled success cross the real SDK boundary", async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const planDirectory = await realpath(root);
	const rawResult = { edit: { planId: "001", state: "barrier" }, reply: { status: "running" } };
	for (const scenario of [
		{ name: "trust rejection", trusted: false, operation: "init", diagnostic: "Trust this project before using Herder plan operations.", reachesHook: false },
		{ name: "invalid presentation", trusted: true, operation: "init", view: "full", diagnostic: "view, offset, and responseSha256 are supported only for validate, shape, and snapshot.", reachesHook: false },
		{ name: "runtime Error", trusted: true, operation: "finish_edit", rejection: new Error("ownership hook failed"), diagnostic: "ownership hook failed", reachesHook: true },
		{ name: "runtime non-Error", trusted: true, operation: "finish_edit", rejection: { reason: "ownership hook failed" }, diagnostic: "[object Object]", reachesHook: true },
		{ name: "handled finish", trusted: true, operation: "finish_edit", reachesHook: true },
	]) {
		await t.test(scenario.name, async () => {
			let definition: ToolDefinition | undefined;
			let repositoryReads = 0;
			let hookCalls = 0;
			let managerReplies = 0;
			const ctx = { isProjectTrusted: () => scenario.trusted } as ExtensionContext;
			registerPiPlanningWorkflows({
				registerCommand: () => {},
				registerTool: (tool: ToolDefinition) => { definition = tool; },
			} as unknown as ExtensionAPI, "/repo/herder", async () => {
				repositoryReads += 1;
				assert.equal(scenario.reachesHook, true, "rejection must precede repository access");
				return path.dirname(planDirectory);
			}, {
				assertMutationAllowed: () => { assert.fail("rejection must precede mutation"); },
				beforePlanOperation: async (operation, params, context) => {
					hookCalls += 1;
					assert.equal(operation, "finish_edit");
					assert.equal(params.planDirectory, planDirectory);
					assert.equal(context, ctx);
					if (scenario.rejection !== undefined) throw scenario.rejection;
					return { handled: true, result: rawResult };
				},
				handleManagerReply: async () => { managerReplies += 1; },
			});
			assert.ok(definition);
			assert.equal(definition.name, "herder_plan");
			const tool = wrapRegisteredTool({
				definition,
				sourceInfo: createSyntheticSourceInfo(import.meta.filename, { source: "test" }),
			}, {
				createContext: () => ctx,
				getActiveTools: () => ["herder_plan"],
			} as unknown as ExtensionRunner);
			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage(fauxToolCall("herder_plan", {
				operation: scenario.operation,
				planDirectory,
				...(scenario.view ? { view: scenario.view } : {}),
				...(scenario.operation === "finish_edit" ? { editToken: "00000000-0000-0000-0000-000000000001" } : {}),
			}, { id: "plan-call" }), { stopReason: "toolUse" })]);
			const events: AgentEvent[] = [];
			const messages = await runAgentLoop(
				[{ role: "user", content: "Run the plan operation", timestamp: 0 }],
				{ systemPrompt: "Test", messages: [], tools: [tool] },
				{
					model: faux.getModel(),
					convertToLlm: (messages) => messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
					shouldStopAfterTurn: () => true,
				},
				(event) => { events.push(event); }, undefined, faux.streamSimple,
			);
			const results = messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 1);
			const result = results[0]!;
			assert.equal(result.toolCallId, "plan-call");
			assert.equal(result.isError, scenario.diagnostic !== undefined);
			assert.deepEqual(result.content, [{ type: "text", text: scenario.diagnostic ?? JSON.stringify(rawResult, null, 2) }]);
			if (!scenario.diagnostic) assert.deepEqual(result.details, { result: rawResult });
			const ends = events.filter((event) => event.type === "tool_execution_end");
			assert.equal(ends.length, 1);
			assert.equal(ends[0]!.isError, result.isError);
			assert.equal(repositoryReads, Number(scenario.reachesHook));
			assert.equal(hookCalls, Number(scenario.reachesHook));
			assert.equal(managerReplies, 0, "handled finish must not submit the manager reply twice");
			assert.equal(faux.state.callCount, 1);
			if (scenario.rejection !== undefined) {
				await assert.rejects(() => definition!.execute("direct", {
					operation: "finish_edit", planDirectory,
				}, undefined, undefined, ctx), { name: "Error", message: scenario.diagnostic });
			}
		});
	}
});

test("Pi planning prompt preserves the exact packaged skill and arguments", async () => {
	const root = await fixture();
	try {
		const prompt = await buildPlanningSkillPrompt(root, "improve", 'quick security --lang "Traditional Chinese"', "HERDER_ACTIVE_PLAN_EDIT_V1\nPLAN_ID: 002");
		assert.match(prompt, /^<skill name="herder-improve" location=".*SKILL\.md">/);
		assert.match(prompt, /References are relative to .*skills\/improve\./);
		assert.match(prompt, /# Improve/);
		assert.doesNotMatch(prompt, /description: Audit/);
		assert.match(prompt, /<herder-runtime>\nHERDER_ACTIVE_PLAN_EDIT_V1\nPLAN_ID: 002\n<\/herder-runtime>/);
		assert.match(prompt, /\n\nquick security --lang "Traditional Chinese"$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi simplification prompt preserves the exact packaged skill and arguments", async () => {
	const root = await fixture();
	try {
		const prompt = await buildPlanningSkillPrompt(root, "simplify", "deep duplication --lang zh-CN");
		assert.match(prompt, /^<skill name="herder-simplify" location=".*SKILL\.md">/);
		assert.match(prompt, /References are relative to .*skills\/simplify\./);
		assert.match(prompt, /# Simplify/);
		assert.match(prompt, /references\/simplification-playbook\.md/);
		assert.doesNotMatch(prompt, /description: Audit/);
		assert.match(prompt, /\n\ndeep duplication --lang zh-CN$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi agentic planning commands inject the packaged skill into the current session", async () => {
	const root = await fixture();
	let waited = false;
	let submitted = "";
	const pi = {
		sendUserMessage: (content: string | unknown[]) => { submitted = String(content); },
	} as Pick<ExtensionAPI, "sendUserMessage">;
	const context = {
		isProjectTrusted: () => true,
		waitForIdle: async () => { waited = true; },
	} as unknown as ExtensionCommandContext;
	try {
		const result = await launchPlanningWorkflow(pi, context, root, "simplify", "quick deletion");
		assert.deepEqual(result, { submitted: true });
		assert.equal(waited, true);
		assert.match(submitted, /^<skill name="herder-simplify"/);
		assert.match(submitted, /\n\nquick deletion$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("planning launch failures cannot strand a prepared workflow", async () => {
	const root = await fixture();
	let prepared = false;
	let rolledBack = false;
	try {
		await assert.rejects(() => launchPlanningWorkflow(
			{ sendUserMessage: () => {} },
			{ isProjectTrusted: () => true, waitForIdle: async () => { throw new Error("idle wait failed"); } } as unknown as ExtensionCommandContext,
			root,
			"simplify",
			"",
			async () => { prepared = true; return {}; },
		), /idle wait failed/);
		assert.equal(prepared, false);

		await assert.rejects(() => launchPlanningWorkflow(
			{ sendUserMessage: () => { throw new Error("prompt send failed"); } },
			{ isProjectTrusted: () => true, waitForIdle: async () => {} } as unknown as ExtensionCommandContext,
			root,
			"simplify",
			"",
			async () => ({ rollback: async () => { rolledBack = true; } }),
		), /prompt send failed/);
		assert.equal(rolledBack, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi plan command results are concise native notifications", () => {
	assert.equal(
		formatPlanCommandResult(
			{ operation: "ready", planDir: "/repo/herder-plans" },
			{ ready: ["001", "003"], inProgress: ["002"], blocked: [], waiting: [{ id: "004" }], complete: false },
		),
		"Herder readiness: 001, 003 · 1 in progress · 0 blocked · 1 waiting.",
	);
	assert.equal(
		formatPlanCommandResult(
			{ operation: "snapshot", planDir: "/repo/herder-plans", planId: "1" },
			{ plan: { id: "001", title: "Native command" }, snapshotSha256: "abc123" },
		),
		"Herder snapshot 001: Native command · sha256 abc123.",
	);
});

test("Pi plan commands call the deterministic application without a model session", async () => {
	const repository = await mkdtemp(path.join(os.tmpdir(), "herder-pi-plan-command-"));
	try {
		const initializedGit = spawnSync("git", ["init", "-q", repository], { encoding: "utf8" });
		assert.equal(initializedGit.status, 0, initializedGit.stderr);
		let mutationChecks = 0;
		const initialized = await executePiPlanCommand("init", repository, () => { mutationChecks += 1; });
		assert.equal(mutationChecks, 1);
		assert.match(initialized.message, /Herder plans initialized/);
		assert.equal((initialized.result as { tracking: string }).tracking, "local");

		const readiness = await executePiPlanCommand("ready", repository, () => { mutationChecks += 1; });
		assert.equal(mutationChecks, 1);
		assert.match(readiness.message, /no ready plans/);
	} finally {
		await rm(repository, { recursive: true, force: true });
	}
});

test("active Fire protection runs before current-session prompt injection", async () => {
	const root = await fixture();
	let submitted = false;
	const pi = {
		sendUserMessage: () => { submitted = true; },
	} as Pick<ExtensionAPI, "sendUserMessage">;
	const context = {
		isProjectTrusted: () => true,
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;
	try {
		await assert.rejects(
			() => launchPlanningWorkflow(pi, context, root, "simplify", "", async () => { throw new Error("Fire is active"); }),
			/Fire is active/,
		);
		assert.equal(submitted, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
