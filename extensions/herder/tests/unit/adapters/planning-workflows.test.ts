import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildPlanningSkillPrompt,
	executePiPlanCommand,
	formatPlanCommandResult,
	launchPlanningWorkflow,
} from "../../../adapters/planning-workflows.ts";

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-planning-"));
	const directory = path.join(root, "skills", "improve");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "SKILL.md"), `---
name: herder-improve
description: Audit a repository.
---

# Improve

Read [the playbook](references/playbook.md), then audit.
`);
	return root;
}

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
		const result = await launchPlanningWorkflow(pi, context, root, "improve", "quick");
		assert.deepEqual(result, { submitted: true });
		assert.equal(waited, true);
		assert.match(submitted, /^<skill name="herder-improve"/);
		assert.match(submitted, /\n\nquick$/);
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
			() => launchPlanningWorkflow(pi, context, root, "improve", "", async () => { throw new Error("Fire is active"); }),
			/Fire is active/,
		);
		assert.equal(submitted, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
