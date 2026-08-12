import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { validateAttentionResolution } from "../../../src/shared/protocol.ts";
import { attentionResolutionFromArgs } from "../../../src/application/tools.ts";
import {
	buildAttentionPrompt,
} from "../../../adapters/attention.ts";
import {
	buildPlanningSkillPrompt,
	executePiPlanCommand,
	formatPlanCommandResult,
	launchPlanningWorkflow,
} from "../../../adapters/planning-workflows.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

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

test("typed attention prompts preserve request bindings and route each variant", async () => {
	const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const common = {
		schemaVersion: 1 as const,
		requestId: "request-001",
		runId: "run-001",
		planId: "001",
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
	assert.match(userPrompt, /^HERDER_MAIN_SESSION_USER_DECISION_V1/m);
	assert.match(userPrompt, /QUESTION: Which recorded decision should the Judge use\?/);
	assert.match(userPrompt, /SCHEMA_VERSION: 1/);
	assert.match(userPrompt, /schemaVersion: 1/);
	assert.match(userPrompt, /PLAN_DIRECTORY: \/repo\/herder-plans/);
	assert.match(userPrompt, /CAPABILITY_TOKEN: c{64}/);
	assert.doesNotMatch(userPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);

	const operatorPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", {
		...common,
		requestId: "request-002",
		kind: "operator_attention",
		cause: "transport_exhausted",
		question: "Retry the recorded role or stop it?",
	} as ManagerAttentionRequest);
	assert.match(operatorPrompt, /^HERDER_MAIN_SESSION_OPERATOR_ATTENTION_V1/m);
	assert.match(operatorPrompt, /schemaVersion: 1/);
	assert.match(operatorPrompt, /action "retry"/);
	assert.doesNotMatch(operatorPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);

	const recoveryPrompt = await buildAttentionPrompt(packageRoot, "/repo/herder-plans", {
		...common,
		requestId: "request-003",
		kind: "plan_recovery",
		cause: "reviewer_blocked",
		state: "pending",
		recovery: {
			planFingerprint: "d".repeat(64),
			fingerprintVersion: 1,
			planFile: "001-plan.md",
			inScopePaths: ["src/value.mjs"],
			inScopePathCount: 1,
			inScopePathsSha256: "e".repeat(64),
			assignmentPath: "/repo/herder-plans/.herder/assignment.json",
			assignmentSha256: "f".repeat(64),
			snapshotSha256: "1".repeat(64),
			generationBase: "2".repeat(40),
			branch: "herder/herder-plans/001",
			worktree: "/repo/herder-worktrees/001",
			worktreeHead: "3".repeat(40),
			worktreeTree: "4".repeat(40),
			changedPaths: ["src/value.mjs"],
			changedPathCount: 1,
			changedPathsSha256: "5".repeat(64),
		},
	} as ManagerAttentionRequest);
	assert.match(recoveryPrompt, /^HERDER_MAIN_SESSION_ATTENTION_V1/m);
	assert.match(recoveryPrompt, /HERDER_ACTIVE_PLAN_RECOVERY_V1/);
	assert.match(recoveryPrompt, /RECOVERY_GIT_IDENTITY:/);
	assert.match(recoveryPrompt, /ALLOWED_OPERATIONS: defer, unchanged_retry, revise, reject/);
	assert.match(recoveryPrompt, /schemaVersion: 1/);
	assert.match(recoveryPrompt, /001-plan\.md/);
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

test("Pi planning prompt preserves the exact packaged skill and arguments", async () => {
	const root = await fixture();
	try {
		const prompt = await buildPlanningSkillPrompt(root, "improve", "quick security", "HERDER_ACTIVE_PLAN_EDIT_V1\nPLAN_ID: 002");
		assert.match(prompt, /^<skill name="herder-improve" location=".*SKILL\.md">/);
		assert.match(prompt, /References are relative to .*skills\/improve\./);
		assert.match(prompt, /# Improve/);
		assert.doesNotMatch(prompt, /description: Audit/);
		assert.match(prompt, /<herder-runtime>\nHERDER_ACTIVE_PLAN_EDIT_V1\nPLAN_ID: 002\n<\/herder-runtime>/);
		assert.match(prompt, /\n\nquick security$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi simplification prompt preserves the exact packaged skill and arguments", async () => {
	const root = await fixture();
	try {
		const prompt = await buildPlanningSkillPrompt(root, "simplify", "deep duplication");
		assert.match(prompt, /^<skill name="herder-simplify" location=".*SKILL\.md">/);
		assert.match(prompt, /References are relative to .*skills\/simplify\./);
		assert.match(prompt, /# Simplify/);
		assert.match(prompt, /references\/simplification-playbook\.md/);
		assert.doesNotMatch(prompt, /description: Audit/);
		assert.match(prompt, /\n\ndeep duplication$/);
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
