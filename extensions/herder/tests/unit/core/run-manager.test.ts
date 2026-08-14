import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { ensureService, requestService, stopService, submitManagerOperation, waitManagerOperation } from "../../../src/client/index.ts";
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts";
import { readManagerState } from "../../../src/daemon/execution-store.ts";
import { GitDriver, git, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { allocateUnusedReigniteDirectory, compileGraphIdentity, HerderRunManager } from "../../../src/core/run-manager.ts";
import { integrationRepairCapabilityDigest, sha256, stableJson, type ManagerReply, type VerificationGate } from "../../../src/shared/protocol.ts";

function writeFixture(root: string): { repo: string; planDirectory: string; originalHead: string } {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Herder Runtime Test"]);
	git(repo, ["config", "user.email", "herder-runtime@example.invalid"]);
	fs.mkdirSync(path.join(repo, "src"));
	fs.mkdirSync(path.join(repo, "test"));
	fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "herder-runtime-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
	fs.writeFileSync(path.join(repo, "src/value.mjs"), "export const value = 1\n");
	fs.writeFileSync(path.join(repo, "src/other.mjs"), "export const other = 1\n");
	fs.writeFileSync(path.join(repo, "test/value.test.mjs"), `import assert from "node:assert/strict"\nimport test from "node:test"\nimport { value } from "../src/value.mjs"\ntest("value", () => assert.equal(value, 2))\n`);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: add runtime fixture"]);
	const originalHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-update-value.md) | Update the fixture value | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-update-value.md"), `# Plan 001: Update the fixture value

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${originalHead.slice(0, 8)}\`, 2026-08-07
- **Kind**: behavioral
- **Parent objective**: Prove the deterministic Herder manager executes and integrates one reviewed plan.

## Why this matters

This fixture proves that process discovery, durable action accounting, worker backfilling, independent review, integration, and final audit all advance through the deterministic manager.

## Current state

- \`src/value.mjs\` exports the number one.
- \`test/value.test.mjs\` expects the number two and therefore becomes the focused verification proof after implementation.
- The repository uses dependency-free ESM and Node's built-in test runner.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 with one passing test |

## Dependency contract

- **Consumes**: none.
- **Provides**: the exported fixture value is two and its focused test passes.
- **Safe intermediate state**: this is the only source transition and the repository test command passes after integration.

## Scope

**In scope** (declared write paths):
- \`src/value.mjs\`

**Out of scope**:
- Package metadata, dependencies, and the test contract.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Update the exported value

Change the exported numeric value from one to two without changing the module interface.

**Verify**: \`npm test\` → one passing test.

## Test plan

- Run \`npm test\` and require the existing focused value assertion to pass.
- Keep the \`node:test\` and \`node:assert/strict\` module specifiers; they are not shell commands.
- Do not add dependencies or broaden the test surface.

## Review map

- **Outcome**: the exported value is two.
- **Modified symbols**: \`value\` in \`src/value.mjs\`.
- **Direct contracts**: the existing import and strict equality assertion.
- **Expected unchanged behavior**: module format and export name remain unchanged.
- **Proof**: \`npm test\`.
- **Expected diff**: one numeric literal in \`src/value.mjs\`.

## Done criteria

- [ ] \`npm test\` exits 0.
- [ ] \`src/value.mjs\` continues exporting \`value\` with the number two.
- [ ] No dependency or test contract changes are introduced.

## STOP conditions

Stop if the module no longer matches the stated ESM shape, if the test requires another behavior, or if a dependency would be required.

## Maintenance notes

Keep this fixture deliberately small so control-plane failures remain distinguishable from implementation complexity.
`);
	return { repo, planDirectory, originalHead };
}

function addIndependentPlan(fixture: { planDirectory: string }): void {
	const readmePath = path.join(fixture.planDirectory, "README.md");
	const readme = fs.readFileSync(readmePath, "utf8").replace(
		"| [001](001-update-value.md) | Update the fixture value | P1 | S | — | TODO |",
		"| [001](001-update-value.md) | Update the fixture value | P1 | S | — | TODO |\n| [002](002-update-other.md) | Update the other fixture value | P1 | S | — | TODO |",
	);
	fs.writeFileSync(readmePath, readme);
	const second = fs.readFileSync(path.join(fixture.planDirectory, "001-update-value.md"), "utf8")
		.replaceAll("Plan 001", "Plan 002")
		.replaceAll("fixture value", "other fixture value")
		.replaceAll("src/value.mjs", "src/other.mjs")
		.replaceAll("`value`", "`other`");
	fs.writeFileSync(path.join(fixture.planDirectory, "002-update-other.md"), second);
}

function markFirstPlanBlocked(fixture: { planDirectory: string }): void {
	const readmePath = path.join(fixture.planDirectory, "README.md");
	const readme = fs.readFileSync(readmePath, "utf8").replace(
		"| [001](001-update-value.md) | Update the fixture value | P1 | S | — | TODO |",
		"| [001](001-update-value.md) | Update the fixture value | P1 | S | — | BLOCKED — requires product decision |",
	);
	fs.writeFileSync(readmePath, readme);
}

function appendIndependentPlan(fixture: { planDirectory: string }): void {
	const readmePath = path.join(fixture.planDirectory, "README.md");
	const readme = fs.readFileSync(readmePath, "utf8").replace(
		/(\| \[001\]\(001-update-value\.md\).*\|\n)/,
		"$1| [002](002-update-other.md) | Update the other fixture value | P1 | S | — | TODO |\n",
	);
	fs.writeFileSync(readmePath, readme);
	const second = fs.readFileSync(path.join(fixture.planDirectory, "001-update-value.md"), "utf8")
		.replaceAll("Plan 001", "Plan 002")
		.replaceAll("fixture value", "other fixture value")
		.replaceAll("src/value.mjs", "src/other.mjs")
		.replaceAll("`value`", "`other`");
	fs.writeFileSync(path.join(fixture.planDirectory, "002-update-other.md"), second);
}

function payload(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

type VerificationSubmission = {
	reply: Record<string, unknown>;
	manifest: Record<string, unknown>;
};

async function submitFinalVerification(
	service: Awaited<ReturnType<typeof ensureService>>,
	planDirectory: string,
	reply: Record<string, unknown>,
	prefix: string,
	gates: VerificationGate[] = [{
		gateId: `${prefix}-npm-test`,
		label: "fixture tests",
		cwd: ".",
		argv: ["npm", "test"],
		rationale: "Exercises the integrated fixture.",
	}],
): Promise<VerificationSubmission> {
	const request = payload(reply.verificationRequest);
	assert.equal(reply.status, "paused");
	assert.equal(readManagerState(planDirectory).verification?.state, "awaiting_manifest");
	assert.ok(request.requestId);
	const manifest = {
		schemaVersion: 1,
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		runId: request.runId,
		generation: request.generation,
		graphSha256: request.graphSha256,
		runAssignmentSha256: request.runAssignmentSha256,
		integrationHead: request.integrationHead,
		integrationTree: request.integrationTree,
		rationale: "The fixture has one complete repository test command.",
		gates,
	};
	const response = payload(await requestService(service, "/v1/verification", manifest));
	return { reply: payload(response.reply), manifest };
}

async function prepareSinglePlan(
	service: Awaited<ReturnType<typeof ensureService>>,
	fixture: { repo: string; planDirectory: string },
	prefix: string,
): Promise<Record<string, unknown>> {
	const started = payload(payload(await requestService(service, "/v1/start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	})).reply);
	const implementer = payload((started.actions as unknown[])[0]);
	await requestService(service, "/v1/event", {
		eventId: `${prefix}-dispatch-implementer`, kind: "dispatch_results",
		dispatchResults: [{ actionId: implementer.actionId, accepted: true, hostHandle: `${prefix}-implementer` }],
	});
	const worktree = String(implementer.worktree);
	fs.writeFileSync(path.join(worktree, "src/value.mjs"), "export const value = 2\n");
	git(worktree, ["add", "src/value.mjs"]);
	git(worktree, ["commit", "-q", "-m", "fix: update fixture value"]);
	const afterImplementer = payload(payload(await requestService(service, "/v1/event", {
		eventId: `${prefix}-terminal-implementer`, kind: "terminals",
		terminals: [{
			actionId: implementer.actionId,
			hostHandle: `${prefix}-implementer`,
			response: `STATUS: COMPLETE\nCOMMITS: ${git(worktree, ["rev-parse", "HEAD"]).stdout.trim()}\nADDRESSED: none\nCHECKS: npm test — passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: value updated\nUSAGE: input_tokens=100; cached_input_tokens=20; output_tokens=30; reasoning_tokens=10; source=test-host`,
		}],
	})).reply);
	const reviewer = payload((afterImplementer.actions as unknown[])[0]);
	await requestService(service, "/v1/event", {
		eventId: `${prefix}-dispatch-reviewer`, kind: "dispatch_results",
		dispatchResults: [{ actionId: reviewer.actionId, accepted: true, hostHandle: `${prefix}-reviewer` }],
	});
	return payload(payload(await requestService(service, "/v1/event", {
		eventId: `${prefix}-terminal-reviewer`, kind: "terminals",
		terminals: [{
			actionId: reviewer.actionId,
			hostHandle: `${prefix}-reviewer`,
			response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: focused outcome and gates pass\nUSAGE: input_tokens=80; cached_input_tokens=10; output_tokens=20; reasoning_tokens=5; source=test-host",
		}],
	})).reply);
}

async function completeSinglePlan(
	service: Awaited<ReturnType<typeof ensureService>>,
	fixture: { repo: string; planDirectory: string },
	prefix: string,
): Promise<Record<string, unknown>> {
	return finishFinalReview(service, fixture, prefix, "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: aggregate plan set is coherent\nUSAGE: input_tokens=60; cached_input_tokens=10; output_tokens=15; reasoning_tokens=5; source=test-host");
}

async function finishFinalReview(
	service: Awaited<ReturnType<typeof ensureService>>,
	fixture: { repo: string; planDirectory: string },
	prefix: string,
	response: string,
): Promise<Record<string, unknown>> {
	const afterReviewer = await prepareSinglePlan(service, fixture, prefix);
	const verified = await submitFinalVerification(service, fixture.planDirectory, afterReviewer, prefix);
	const finalReviewer = payload((verified.reply.actions as unknown[])[0]);
	await requestService(service, "/v1/event", {
		eventId: `${prefix}-dispatch-final`, kind: "dispatch_results",
		dispatchResults: [{ actionId: finalReviewer.actionId, accepted: true, hostHandle: `${prefix}-final` }],
	});
	return payload(payload(await requestService(service, "/v1/event", {
		eventId: `${prefix}-terminal-final`, kind: "terminals",
		terminals: [{
			actionId: finalReviewer.actionId,
			hostHandle: `${prefix}-final`,
			response,
		}],
	})).reply);
}

function resolvedRepoPath(repo: string, ...parts: string[]): string {
	return path.join(fs.realpathSync(repo), ...parts);
}

function writeFollowUpPlanDirectory(
	directory: string,
	fixture: { originalHead: string; repo: string },
	options: { shapeReady?: boolean; extraStatus?: "IN PROGRESS" | "DONE" | "REJECTED" } = {},
): string {
	initPlanDir(directory);
	for (const name of fs.readdirSync(directory).filter((entry) => /^\d{3,}-.*\.md$/i.test(entry))) {
		fs.rmSync(path.join(directory, name));
	}
	const extraRow = options.extraStatus
		? `\n| [002](002-follow-up.md) | Follow up extra work | P1 | S | — | ${options.extraStatus} |`
		: "";
	fs.writeFileSync(path.join(directory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-follow-up.md) | Follow up residual work | P1 | S | — | TODO |${extraRow}

## Dependency notes

None.

## Considered and rejected

None.
`);
	let planBody = fs.readFileSync(path.join(fixture.repo, "herder-plans", "001-update-value.md"), "utf8")
		.replaceAll("Plan 001: Update the fixture value", "Plan 001: Follow up residual work")
		.replaceAll("Update the fixture value", "Follow up residual work");
	if (options.shapeReady === false) {
		planBody = planBody.replace(/\n## Review map\n[\s\S]*?(?=\n## )/, "\n");
	}
	fs.writeFileSync(path.join(directory, "001-follow-up.md"), planBody);
	if (options.extraStatus) {
		fs.writeFileSync(
			path.join(directory, "002-follow-up.md"),
			planBody.replaceAll("Plan 001", "Plan 002").replaceAll("Follow up residual work", "Follow up extra work"),
		);
	}
	const graph = buildGraph(directory);
	assert.equal(graph.complete, false);
	assert.ok(graph.plans.some((plan) => plan.status === "TODO"));
	if (options.shapeReady === false) assert.equal(graph.shapeReady, false);
	if (options.extraStatus === "IN PROGRESS") assert.ok(graph.inProgress.includes("002"));
	return compileGraphIdentity(graph);
}

test("fresh runs compile authored DONE as skip and still reject IN PROGRESS", { timeout: 15_000 }, async () => {
	const doneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-done-skip-test-"));
	const doneFixture = writeFixture(doneRoot);
	fs.writeFileSync(
		path.join(doneFixture.planDirectory, "README.md"),
		fs.readFileSync(path.join(doneFixture.planDirectory, "README.md"), "utf8").replace("| TODO |", "| DONE |"),
	);
	try {
		const service = await ensureService(doneFixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: doneFixture.repo,
			planDirectory: doneFixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.notEqual(started.status, "idle");
		const store = new RunStore(doneFixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlanSpecs(run.runId).find((candidate) => candidate.planId === "001")?.initialStatus, "DONE");
		} finally {
			store.close();
		}
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: doneFixture.repo,
			planDirectory: doneFixture.planDirectory,
			profile: "eclipse",
		}), /already exists; use resume/);
	} finally {
		await stopService(doneFixture.planDirectory).catch(() => {});
		fs.rmSync(doneRoot, { recursive: true, force: true });
		fs.rmSync(`${doneFixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}

	const progressRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-in-progress-test-"));
	const progressFixture = writeFixture(progressRoot);
	fs.writeFileSync(
		path.join(progressFixture.planDirectory, "README.md"),
		fs.readFileSync(path.join(progressFixture.planDirectory, "README.md"), "utf8").replace("| TODO |", "| IN PROGRESS |"),
	);
	try {
		const service = await ensureService(progressFixture.planDirectory);
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: progressFixture.repo,
			planDirectory: progressFixture.planDirectory,
			profile: "eclipse",
		}), /cannot adopt prior execution state: 001=IN PROGRESS/);
	} finally {
		await stopService(progressFixture.planDirectory).catch(() => {});
		fs.rmSync(progressRoot, { recursive: true, force: true });
	}
});

test("non-terminal reconcile leaves authored README status unchanged", { timeout: 10_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-readme-stable-"));
	const fixture = writeFixture(root);
	const readme = path.join(fixture.planDirectory, "README.md");
	const before = fs.readFileSync(readme, "utf8");
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		})).reply);
		assert.equal(started.status, "running");
		assert.equal(fs.readFileSync(readme, "utf8"), before);
		assert.match(before, /\| TODO \|/);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("terminal stop snapshots live status and a projection throw leaves the run stopped", { timeout: 15_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-terminal-project-"));
	const fixture = writeFixture(root);
	const readme = path.join(fixture.planDirectory, "README.md");
	try {
		const service = await ensureService(fixture.planDirectory);
		await requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		});
		assert.match(fs.readFileSync(readme, "utf8"), /\| TODO \|/);
		const stopped = payload(payload(await requestService(service, "/v1/stop", {})).reply);
		assert.equal(stopped.status, "stopped");
		assert.match(fs.readFileSync(readme, "utf8"), /\| IN PROGRESS \|/);

		const throwRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-project-throw-"));
		const throwFixture = writeFixture(throwRoot);
		try {
			const throwService = await ensureService(throwFixture.planDirectory);
			await requestService(throwService, "/v1/start", {
				mode: "fire",
				repositoryRoot: throwFixture.repo,
				planDirectory: throwFixture.planDirectory,
				profile: "eclipse",
				maxParallel: 1,
			});
			fs.writeFileSync(path.join(throwFixture.planDirectory, "README.md"), "# not a plan index\n");
			const manager = new HerderRunManager(throwFixture.planDirectory);
			try {
				const reply = manager.stop();
				assert.equal(reply.status, "stopped");
				assert.equal(manager.store.getRun()?.status, "stopped");
			} finally {
				manager.close();
			}
		} finally {
			await stopService(throwFixture.planDirectory).catch(() => {});
			fs.rmSync(throwRoot, { recursive: true, force: true });
			fs.rmSync(`${throwFixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("malformed clean worker envelopes pause after three bounded transport retries", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-malformed-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		let reply = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
			dashboardUrl: service.dashboardUrl,
		})).reply);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const action = payload((reply.actions as unknown[])[0]);
			assert.equal(action.role, "plan-implementer");
			assert.equal(action.round, 1, "clean transport retry consumed a substantive round");
			await requestService(service, "/v1/event", {
				eventId: `malformed-dispatch-${attempt}`,
				kind: "dispatch_results",
				dispatchResults: [{ actionId: action.actionId, accepted: true, hostHandle: `malformed-worker-${attempt}` }],
			});
			reply = payload(payload(await requestService(service, "/v1/event", {
				eventId: `malformed-terminal-${attempt}`,
				kind: "terminals",
				terminals: [{ actionId: action.actionId, hostHandle: `malformed-worker-${attempt}`, response: "not a role envelope" }],
			})).reply);
		}
		assert.equal(reply.status, "needs_input");
		assert.equal((reply.actions as unknown[]).length, 0);
		assert.match(String(reply.message), /transport failed 3 times/);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "operator_attention");
		assert.equal(attention.cause, "transport_exhausted");
		assert.deepEqual(payload(attention.continuation), { role: "plan-implementer", phase: "READY_IMPLEMENTER" });
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getAttentionRequests(run.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "transport_exhausted").length, 1);
		} finally { store.close(); }
		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		assert.equal(resumed.status, "needs_input");
		assert.equal(payload(resumed.attention).requestId, attention.requestId);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("persistent service drives a complete deterministic run and reuses its process", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-test-"));
	const fixture = writeFixture(root);
	try {
		assert.throws(() => new GitDriver({
			repoRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			planName: "herder-plans",
			helperRoot: root,
			worktreeRoot: fixture.repo,
		}), /outside Herder's allowed locations/);
		const [first, second, third] = await Promise.all([
			ensureService(fixture.planDirectory),
			ensureService(fixture.planDirectory),
			ensureService(fixture.planDirectory),
		]);
		assert.equal(second.instanceId, first.instanceId);
		assert.equal(second.pid, first.pid);
		assert.equal(third.instanceId, first.instanceId);
		assert.match(first.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
		assert.equal((await fetch(`${first.dashboardUrl}api/health`)).status, 200);

		const started = payload(await requestService(first, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
			dashboardUrl: "http://127.0.0.1:1/",
		}));
		const startReply = payload(started.reply);
		assert.equal(startReply.status, "running");
		assert.equal(startReply.dashboardUrl, first.dashboardUrl, "service trusted a stale client dashboard URL");
		await assert.rejects(() => requestService(first, "/v1/event", {
			eventId: "invalid-kind",
			kind: "unexpected",
		}), /Unknown manager event kind/);
		const initialImplementer = payload((startReply.actions as unknown[])[0]);
		assert.match(String(initialImplementer.taskName), /^[a-z0-9_]+$/, "task name is not portable across native host adapters");
		assert.equal(
			String(initialImplementer.worktree),
			path.join(fs.realpathSync(fixture.planDirectory), ".herder", "worktrees", "001"),
			"Pi worktree is not in the stable plan-directory namespace",
		);
		assert.match(String(initialImplementer.prompt), /change to the exact absolute REPOSITORY_WORKTREE, verify pwd and EXPECTED_BRANCH/);
		assert.match(String(initialImplementer.prompt), /ROLE_CONTRACT_PATH: .*assets\/roles\/contracts\/plan-implementer\.md/);
		assert.doesNotMatch(String(initialImplementer.prompt), /REVIEW_PROTOCOL_PATH:/);
		await stopService(fixture.planDirectory);
		let service = await ensureService(fixture.planDirectory);
		assert.notEqual(service.instanceId, first.instanceId);
		const restartedHealth = await requestService(service, "/health");
		assert.equal(restartedHealth.dashboardUrl, service.dashboardUrl);
		assert.equal(Object.hasOwn(restartedHealth, "forwardedUrl"), false);
		const midRun = payload(await requestService(service, "/v1/status"));
		assert.equal(payload(midRun.reply).dashboardUrl, service.dashboardUrl);
		const implementer = payload((payload(midRun.reply).actions as unknown[])[0]);
		assert.equal(implementer.actionId, initialImplementer.actionId, "proposed action changed across service restart");
		assert.equal(implementer.role, "plan-implementer");
		assert.match(String(implementer.prompt), /deterministic Herder Run Manager owns/);

		await requestService(service, "/v1/event", {
			eventId: "dispatch-implementer",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: implementer.actionId, accepted: true, hostHandle: "worker-implementer" }],
		});
		await stopService(fixture.planDirectory);
		service = await ensureService(fixture.planDirectory);
		const dispatchedRecovery = payload(await requestService(service, "/v1/status"));
		const recoveredReply = payload(dispatchedRecovery.reply);
		assert.equal((recoveredReply.actions as unknown[]).length, 0);
		assert.equal(payload((recoveredReply.active as unknown[])[0]).hostHandle, "worker-implementer");
		const worktree = String(implementer.worktree);
		fs.writeFileSync(path.join(worktree, "src/value.mjs"), "export const value = 2\n");
		git(worktree, ["add", "src/value.mjs"]);
		git(worktree, ["commit", "-q", "-m", "fix: update fixture value"]);
		const implementerTerminal = payload(await requestService(service, "/v1/event", {
			eventId: "terminal-implementer",
			kind: "terminals",
			terminals: [{
				actionId: implementer.actionId,
				hostHandle: "worker-implementer",
				response: `STATUS: COMPLETE\nCOMMITS: ${git(worktree, ["rev-parse", "HEAD"]).stdout.trim()}\nADDRESSED: none\nCHECKS: npm test — passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: value updated\nUSAGE: input_tokens=100; cached_input_tokens=20; output_tokens=30; reasoning_tokens=10; source=test-host`,
			}],
		}));
		const reviewer = payload((payload(implementerTerminal.reply).actions as unknown[])[0]);
		assert.equal(reviewer.role, "plan-reviewer");
		assert.match(String(reviewer.prompt), /REVIEW_PROTOCOL_PATH: .*assets\/review\/code-review-protocol\.md/);

		await requestService(service, "/v1/event", {
			eventId: "dispatch-reviewer",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: reviewer.actionId, accepted: true, hostHandle: "worker-reviewer" }],
		});
		const reviewerTerminal = payload(await requestService(service, "/v1/event", {
			eventId: "terminal-reviewer",
			kind: "terminals",
			terminals: [{
				actionId: reviewer.actionId,
				hostHandle: "worker-reviewer",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: focused outcome and gates pass\nUSAGE: input_tokens=80; cached_input_tokens=10; output_tokens=20; reasoning_tokens=5; source=test-host",
			}],
		}));
		const verified = await submitFinalVerification(service, fixture.planDirectory, payload(reviewerTerminal.reply), "persistent");
		const finalReviewer = payload((verified.reply.actions as unknown[])[0]);
		assert.equal(finalReviewer.planId, "RUN");
		assert.equal(finalReviewer.workerMode, "FINAL_AUDIT");
		assert.match(String(finalReviewer.prompt), /REVIEW_PROTOCOL_PATH: .*assets\/review\/code-review-protocol\.md/);

		await requestService(service, "/v1/event", {
			eventId: "dispatch-final",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: finalReviewer.actionId, accepted: true, hostHandle: "worker-final" }],
		});
		const complete = payload(await requestService(service, "/v1/event", {
			eventId: "terminal-final",
			kind: "terminals",
			terminals: [{
				actionId: finalReviewer.actionId,
				hostHandle: "worker-final",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: aggregate plan set is coherent\nUSAGE: input_tokens=60; cached_input_tokens=10; output_tokens=15; reasoning_tokens=5; source=test-host",
			}],
		}));
		const finalReply = payload(complete.reply);
		assert.equal(finalReply.status, "complete");
		assert.equal(payload(finalReply.summary).done, 1);
		assert.match(fs.readFileSync(path.join(fixture.planDirectory, "README.md"), "utf8"), /\| DONE \|/);
		assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim(), fixture.originalHead, "user checkout HEAD changed");
		assert.equal(fs.readFileSync(path.join(fixture.repo, "src/value.mjs"), "utf8"), "export const value = 1\n", "user checkout source changed");
		assert.equal(git(fixture.repo, ["show", "herder/herder-plans/integration:src/value.mjs"]).stdout, "export const value = 2\n");

		const replay = payload(await requestService(service, "/v1/event", {
			eventId: "terminal-final",
			kind: "terminals",
			terminals: [{
				actionId: finalReviewer.actionId,
				hostHandle: "worker-final",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: aggregate plan set is coherent\nUSAGE: input_tokens=60; cached_input_tokens=10; output_tokens=15; reasoning_tokens=5; source=test-host",
			}],
		}));
		assert.equal(payload(replay.reply).status, "complete");
		await assert.rejects(() => requestService(service, "/v1/event", {
			eventId: "terminal-final",
			kind: "terminals",
			terminals: [{ actionId: finalReviewer.actionId, hostHandle: "worker-final", interrupted: true }],
		}), /replayed with different payload/);

		await stopService(fixture.planDirectory);
		const restarted = await ensureService(fixture.planDirectory);
		assert.notEqual(restarted.instanceId, service.instanceId);
		assert.notEqual(restarted.pid, service.pid);
		const recovered = payload(await requestService(restarted, "/v1/status"));
		assert.equal(payload(recovered.reply).status, "complete");
		const resumed = payload(await requestService(restarted, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		}));
		assert.equal(payload(resumed.reply).status, "complete");
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("nonzero final verification failure is durable and replay-safe", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-verification-failure-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "verification-failure");
		const submitted = await submitFinalVerification(service, fixture.planDirectory, awaiting, "verification-failure", [{
			gateId: "verification-nonzero",
			label: "nonzero fixture gate",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(7)"],
			rationale: "Proves a nonzero final gate is durable.",
		}]);
		assert.equal(submitted.reply.status, "failed");
		assert.equal((submitted.reply.actions as unknown[]).length, 0);
		assert.equal(submitted.reply.attention, undefined, "verification failure must not create plan attention");
		const summary = readManagerState(fixture.planDirectory);
		assert.equal(summary.run?.status, "failed");
		assert.equal(summary.verification?.state, "failed");
		assert.match(String(summary.verification?.terminalDetail), /Verification gate .* failed \(log .+\)/);

		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			const verification = store.getVerification(run.runId, run.currentGeneration)!;
			assert.equal(verification.state, "failed");
			const evidence = payload(verification.result);
			assert.equal(evidence.passed, false);
			const gates = evidence.gates as unknown[];
			assert.equal(gates.length, 1);
			const gate = payload(gates[0]);
			assert.equal(gate.ok, false);
			assert.equal(gate.exitCode, 7);
			assert.ok(String(gate.logPath));
			assert.equal(fs.existsSync(String(gate.logPath)), true);
			assert.equal(store.getPlan(run.runId, "RUN"), null);
			assert.equal(store.getActions(run.runId).some((action) => action.planId === "RUN" || action.workerMode === "FINAL_AUDIT"), false);
			assert.notEqual(run.status, "complete");
		} finally {
			store.close();
		}

		const replay = payload(await requestService(service, "/v1/verification", submitted.manifest));
		assert.equal(payload(replay.reply).status, "failed");
		assert.equal(readManagerState(fixture.planDirectory).verification?.state, "failed");
		await assert.rejects(() => requestService(service, "/v1/verification", {
			...submitted.manifest,
			rationale: "A divergent replay payload must not replace the failure evidence.",
		}), /replayed with a different manifest/);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("stale verification dispatch rejection cannot cancel an accepted final reviewer", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-verification-dispatch-replay-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "verification-dispatch-replay");
		const submitted = await submitFinalVerification(service, fixture.planDirectory, awaiting, "verification-dispatch-replay", [{
			gateId: "verification-dispatch-replay-success",
			label: "verification dispatch replay success gate",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(0)"],
			rationale: "Creates the final Reviewer proposal used by both durable callers.",
		}]);
		const firstAction = payload((submitted.reply.actions as unknown[])[0]);
		const replay = payload(await requestService(service, "/v1/verification", submitted.manifest));
		const replayAction = payload((payload(replay.reply).actions as unknown[])[0]);
		assert.equal(replayAction.actionId, firstAction.actionId);

		await requestService(service, "/v1/event", {
			eventId: "verification-dispatch-replay-accepted",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: firstAction.actionId, accepted: true, hostHandle: "verification-final-winner" }],
		});
		const stale = payload(payload(await requestService(service, "/v1/event", {
			eventId: "verification-dispatch-replay-stale-rejection",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: replayAction.actionId, accepted: false, error: "duplicate preparation" }],
		})).reply);
		assert.equal(stale.status, "running");
		assert.equal((stale.actions as unknown[]).length, 0);
		assert.equal(payload((stale.active as unknown[])[0]).hostHandle, "verification-final-winner");

		const store = new RunStore(fixture.planDirectory);
		try {
			const action = store.getAction(String(firstAction.actionId))!;
			assert.equal(action.state, "dispatched");
			assert.equal(action.hostHandle, "verification-final-winner");
		} finally {
			store.close();
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("minimum-timeout final verification failure preserves timeout and log evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-verification-timeout-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "verification-timeout");
		const submitted = await submitFinalVerification(service, fixture.planDirectory, awaiting, "verification-timeout", [{
			gateId: "verification-timeout",
			label: "minimum timeout fixture gate",
			cwd: ".",
			argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
			timeoutMs: 1_000,
			rationale: "Proves the minimum accepted timeout is enforced.",
		}]);
		assert.equal(submitted.reply.status, "failed");
		const summary = readManagerState(fixture.planDirectory);
		assert.equal(summary.run?.status, "failed");
		assert.equal(summary.verification?.state, "failed");

		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			const verification = store.getVerification(run.runId, run.currentGeneration)!;
			const evidence = payload(verification.result);
			const gate = payload((evidence.gates as unknown[])[0]);
			assert.equal(verification.state, "failed");
			assert.equal(evidence.passed, false);
			assert.equal(gate.ok, false);
			assert.equal(gate.timeoutMs, 1_000);
			assert.ok(Number(gate.durationMs) >= 900);
			assert.notEqual(gate.exitCode, 0);
			assert.ok(String(gate.logPath));
			assert.equal(fs.existsSync(String(gate.logPath)), true);
			assert.equal("timedOut" in gate, false);
			assert.equal(store.getPlan(run.runId, "RUN"), null);
			assert.equal(store.getActions(run.runId).some((action) => action.planId === "RUN" || action.workerMode === "FINAL_AUDIT"), false);
		} finally {
			store.close();
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("unchanged-tree verification replacement proceeds through final review", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-verification-replacement-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "verification-replacement");
		const failed = await submitFinalVerification(service, fixture.planDirectory, awaiting, "verification-replacement", [{
			gateId: "replacement-failure",
			label: "replacement failure gate",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(9)"],
			rationale: "Creates the failed verification that resume must replace.",
		}]);
		const before = new RunStore(fixture.planDirectory);
		let originalRequest;
		try {
			const run = before.getRun()!;
			const verification = before.getVerification(run.runId, run.currentGeneration)!;
			originalRequest = verification.request;
			assert.equal(verification.state, "failed");
		} finally {
			before.close();
		}

		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "paused");
		const replacementRequest = payload(resumed.verificationRequest);
		assert.notEqual(replacementRequest.requestId, originalRequest.requestId);
		assert.equal(replacementRequest.integrationHead, originalRequest.integrationHead);
		assert.equal(replacementRequest.integrationTree, originalRequest.integrationTree);
		assert.equal(replacementRequest.runAssignmentSha256, originalRequest.runAssignmentSha256);
		assert.equal(readManagerState(fixture.planDirectory).verification?.state, "awaiting_manifest");

		const passed = await submitFinalVerification(service, fixture.planDirectory, resumed, "verification-replacement-pass", [{
			gateId: "replacement-success",
			label: "replacement success gate",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(0)"],
			rationale: "Unchanged-tree replacement completes the final verification.",
		}]);
		assert.equal(passed.reply.status, "running");
		const finalReviewer = payload((passed.reply.actions as unknown[])[0]);
		assert.equal(finalReviewer.planId, "RUN");
		assert.equal(finalReviewer.workerMode, "FINAL_AUDIT");
		await requestService(service, "/v1/event", {
			eventId: "verification-replacement-dispatch-final",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: finalReviewer.actionId, accepted: true, hostHandle: "verification-replacement-final" }],
		});
		const complete = payload(payload(await requestService(service, "/v1/event", {
			eventId: "verification-replacement-terminal-final",
			kind: "terminals",
			terminals: [{
				actionId: finalReviewer.actionId,
				hostHandle: "verification-replacement-final",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: replacement verification is bound to the unchanged tree\nUSAGE: input_tokens=60; cached_input_tokens=10; output_tokens=15; reasoning_tokens=5; source=test-host",
			}],
		})).reply);
		assert.equal(complete.status, "complete");
		assert.equal(payload(complete.summary).done, 1);
		const finalState = readManagerState(fixture.planDirectory);
		assert.equal(finalState.run?.status, "complete");
		assert.equal(finalState.verification?.state, "passed");
		assert.equal(finalState.plans.find((plan) => plan.planId === "RUN")?.phase, "FINAL_APPROVED");
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("final Reviewer residual findings complete the run with a pending reignite dossier", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-final-reviewer-input-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "final-reviewer-input");
		const submitted = await submitFinalVerification(service, fixture.planDirectory, awaiting, "final-reviewer-input");
		const finalReviewer = payload((submitted.reply.actions as unknown[])[0]);
		await requestService(service, "/v1/event", {
			eventId: "final-reviewer-input-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: finalReviewer.actionId, accepted: true, hostHandle: "final-reviewer-input-host" }],
		});
		const finding = "[fr-1][P1][BLOCKING][PLAN_REQUIREMENT] aggregate review needs input";
		const completed = payload(payload(await requestService(service, "/v1/event", {
			eventId: "final-reviewer-input-terminal",
			kind: "terminals",
			terminals: [{
				actionId: finalReviewer.actionId,
				hostHandle: "final-reviewer-input-host",
				response: `VERDICT: REVISE\nFINDINGS: ${finding}\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: The final Reviewer needs a main-session decision.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
			}],
		})).reply);
		assert.equal(completed.status, "complete");
		assert.equal(completed.attention, undefined);
		assert.equal((completed.actions as unknown[]).length, 0);
		const reignite = payload(completed.reigniteRequest);
		assert.equal(reignite.state, "pending");
		assert.equal(reignite.verdict, "REVISE");
		assert.deepEqual(reignite.findings, [finding]);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlan(run.runId, "RUN")?.phase, "FINAL_APPROVED");
			assert.equal(store.getAttentionRequests(run.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "final_reviewer_needs_input").length, 0);
			const dossier = store.getReigniteRequest(run.runId, run.currentGeneration);
			assert.equal(dossier?.state, "pending");
			assert.deepEqual(dossier?.findings, [finding]);
			assert.equal(dossier?.requestId, reignite.requestId);
		} finally { store.close(); }
		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "complete");
		assert.equal(payload(resumed.reigniteRequest).requestId, reignite.requestId);
		assert.equal(payload(resumed.reigniteRequest).state, "pending");
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("complete pending reignite resume re-exposes the dossier after plan-graph drift", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-complete-pending-resume-drift-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const finding = "[fr-drift][P1][BLOCKING][PLAN_REQUIREMENT] residual work after graph drift";
		const completed = await finishFinalReview(
			service,
			fixture,
			"complete-pending-resume-drift",
			`VERDICT: REVISE\nFINDINGS: ${finding}\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual requirement belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
		);
		assert.equal(completed.status, "complete");
		const reignite = payload(completed.reigniteRequest);
		assert.equal(reignite.state, "pending");
		appendIndependentPlan(fixture);
		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "complete");
		assert.equal((resumed.actions as unknown[]).length, 0);
		assert.equal(payload(resumed.reigniteRequest).requestId, reignite.requestId);
		assert.equal(payload(resumed.reigniteRequest).state, "pending");
		assert.deepEqual(payload(resumed.reigniteRequest).findings, [finding]);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "complete");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.requestId, reignite.requestId);
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "pending");
		} finally { store.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("final-review graph drift keeps a pending dossier unexposed until the source is complete", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-incomplete-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const prefix = "reignite-incomplete";
		const awaiting = await prepareSinglePlan(service, fixture, prefix);
		const verified = await submitFinalVerification(service, fixture.planDirectory, awaiting, prefix);
		const finalReviewer = payload((verified.reply.actions as unknown[])[0]);
		await requestService(service, "/v1/event", {
			eventId: `${prefix}-dispatch-final`,
			kind: "dispatch_results",
			dispatchResults: [{ actionId: finalReviewer.actionId, accepted: true, hostHandle: `${prefix}-final` }],
		});
		appendIndependentPlan(fixture);
		const finding = "[fr-incomplete][P1][BLOCKING][PLAN_REQUIREMENT] residual work while drifted";
		const drifted = payload(payload(await requestService(service, "/v1/event", {
			eventId: `${prefix}-terminal-final`,
			kind: "terminals",
			terminals: [{
				actionId: finalReviewer.actionId,
				hostHandle: `${prefix}-final`,
				response: `VERDICT: REVISE\nFINDINGS: ${finding}\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual work arrived during graph drift.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
			}],
		})).reply);
		assert.equal(drifted.status, "paused");
		assert.equal(drifted.reigniteRequest, undefined);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "paused");
			const dossier = store.getReigniteRequest(run.runId, run.currentGeneration);
			assert.equal(dossier?.state, "pending");
			assert.deepEqual(dossier?.findings, [finding]);
			await assert.rejects(() => requestService(service, "/v1/reignite", {
				requestId: dossier!.requestId,
				requestSha256: dossier!.requestSha256,
				state: "written",
				graphSha256: "a".repeat(64),
			}), /complete source run/);
			assert.equal(store.getRun()?.status, "paused");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "pending");
		} finally { store.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("final Reviewer approve with no findings persists a skipped reignite dossier", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-final-reviewer-skip-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const completed = await completeSinglePlan(service, fixture, "final-reviewer-skip");
		assert.equal(completed.status, "complete");
		assert.equal(completed.reigniteRequest, undefined);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlan(run.runId, "RUN")?.phase, "FINAL_APPROVED");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "skipped");
			assert.equal(store.getAttentionRequests(run.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "final_reviewer_needs_input").length, 0);
		} finally { store.close(); }
		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.reigniteRequest, undefined);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("final Reviewer block with a patch regression completes with a pending dossier", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-final-reviewer-block-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const finding = "[fr-2][P1][BLOCKING][PATCH_REGRESSION] integrated patch lost a required check";
		const completed = await finishFinalReview(
			service,
			fixture,
			"final-reviewer-block",
			`VERDICT: BLOCK\nFINDINGS: ${finding}\nFIX_GUIDANCE: Restore the missing check.\nDISCOVERED_PATHS: none\nSCOPE: FAIL\nCHECKS: fixture test — passed\nRATIONALE: Residual regression belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
		);
		assert.equal(completed.status, "complete");
		assert.equal(payload(completed.reigniteRequest).state, "pending");
		assert.equal(payload(completed.reigniteRequest).verdict, "BLOCK");
		assert.deepEqual(payload(completed.reigniteRequest).findings, [finding]);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("final Reviewer follow-up findings persist a skipped reignite dossier", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-final-reviewer-followup-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const completed = await finishFinalReview(
			service,
			fixture,
			"final-reviewer-followup",
			"VERDICT: APPROVE\nFINDINGS: [fu-1][P2][ADVISORY][FOLLOWUP] later cleanup\n[inv-1][P3][ADVISORY][INVALID] out of scope\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Only follow-up and invalid findings remain.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		assert.equal(completed.status, "complete");
		assert.equal(completed.reigniteRequest, undefined);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "skipped");
		} finally { store.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("pending reignite allocation is stable and skips an existing README", { timeout: 30_000 }, async () => {
	const occupiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-occupied-"));
	const occupied = writeFixture(occupiedRoot);
	fs.mkdirSync(path.join(occupied.repo, "herder-reignite"), { recursive: true });
	fs.writeFileSync(path.join(occupied.repo, "herder-reignite", "README.md"), "# foreign\n");
	try {
		const service = await ensureService(occupied.planDirectory);
		const completed = await finishFinalReview(
			service,
			occupied,
			"reignite-occupied",
			"VERDICT: REVISE\nFINDINGS: [alloc-2][P1][BLOCKING][PLAN_REQUIREMENT] residual work\nFIX_GUIDANCE: Open a sibling plan set.\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual work belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		assert.equal(completed.status, "complete");
		assert.equal(payload(completed.reigniteRequest).allocatedPlanDirectory, resolvedRepoPath(occupied.repo, "herder-reignite-2"));
		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: occupied.repo,
			planDirectory: occupied.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "complete");
		assert.equal(payload(resumed.reigniteRequest).allocatedPlanDirectory, resolvedRepoPath(occupied.repo, "herder-reignite-2"));
	} finally {
		await stopService(occupied.planDirectory).catch(() => {});
		fs.rmSync(occupiedRoot, { recursive: true, force: true });
		fs.rmSync(`${occupied.repo}-herder-worktrees`, { recursive: true, force: true });
	}

	const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-empty-"));
	const empty = writeFixture(emptyRoot);
	try {
		const service = await ensureService(empty.planDirectory);
		const completed = await finishFinalReview(
			service,
			empty,
			"reignite-empty",
			"VERDICT: REVISE\nFINDINGS: [alloc-1][P1][BLOCKING][PLAN_REQUIREMENT] residual work\nFIX_GUIDANCE: Open a sibling plan set.\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual work belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		assert.equal(payload(completed.reigniteRequest).allocatedPlanDirectory, resolvedRepoPath(empty.repo, "herder-reignite"));
	} finally {
		await stopService(empty.planDirectory).catch(() => {});
		fs.rmSync(emptyRoot, { recursive: true, force: true });
		fs.rmSync(`${empty.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("reignite allocation reserves distinct sibling paths and skips unsafe candidates", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-reserve-"));
	try {
		const source = path.join(root, "herder-plans");
		fs.mkdirSync(source);
		const first = allocateUnusedReigniteDirectory(root, source, "run-a:req-a");
		const second = allocateUnusedReigniteDirectory(root, source, "run-b:req-b");
		assert.equal(first, path.join(root, "herder-reignite"));
		assert.equal(second, path.join(root, "herder-reignite-2"));
		assert.equal(allocateUnusedReigniteDirectory(root, source, "run-a:req-a"), first);
		assert.notEqual(first, second);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}

	const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-unsafe-"));
	try {
		const source = path.join(blocked, "herder-plans");
		fs.mkdirSync(source);
		fs.writeFileSync(path.join(blocked, "herder-reignite"), "not a directory\n");
		fs.symlinkSync(source, path.join(blocked, "herder-reignite-2"));
		const allocated = allocateUnusedReigniteDirectory(blocked, source, "run-c:req-c");
		assert.equal(allocated, path.join(blocked, "herder-reignite-3"));
		assert.equal(fs.lstatSync(allocated).isDirectory(), true);
	} finally {
		fs.rmSync(blocked, { recursive: true, force: true });
	}
});

test("herder_plan validate and shape expose the graph identity used by written acks", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-validate-hash-"));
	const fixture = writeFixture(root);
	try {
		const allocated = path.join(fixture.repo, "herder-reignite");
		writeFollowUpPlanDirectory(allocated, fixture);
		const validated = payload(await invokeHerderTool("herder_plan", { operation: "validate", planDirectory: allocated }));
		const shaped = payload(await invokeHerderTool("herder_plan", { operation: "shape", planDirectory: allocated }));
		const expected = compileGraphIdentity(buildGraph(allocated));
		assert.equal(validated.graphSha256, expected);
		assert.equal(shaped.graphSha256, expected);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("reignite written ack validates the allocated graph and keeps the source complete", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-written-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const completed = await finishFinalReview(
			service,
			fixture,
			"reignite-written",
			"VERDICT: REVISE\nFINDINGS: [wr-1][P1][BLOCKING][PLAN_REQUIREMENT] residual work\nFIX_GUIDANCE: Open a sibling plan set.\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual work belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		const reignite = payload(completed.reigniteRequest);
		assert.equal(reignite.state, "pending");
		const allocated = String(reignite.allocatedPlanDirectory);
		assert.equal(allocated, resolvedRepoPath(fixture.repo, "herder-reignite"));
		await assert.rejects(() => requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
		}), /requires graphSha256/);
		const unshapedHash = writeFollowUpPlanDirectory(allocated, fixture, { shapeReady: false });
		await assert.rejects(() => requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
			graphSha256: unshapedHash,
		}), /shape-ready/);
		const inProgressHash = writeFollowUpPlanDirectory(allocated, fixture, { extraStatus: "IN PROGRESS" });
		await assert.rejects(() => requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
			graphSha256: inProgressHash,
		}), /in-progress plans/);
		writeFollowUpPlanDirectory(allocated, fixture, { extraStatus: "DONE" });
		const validated = payload(await invokeHerderTool("herder_plan", {
			operation: "validate",
			planDirectory: allocated,
		}));
		const graphSha256 = String(validated.graphSha256);
		assert.match(graphSha256, /^[0-9a-f]{64}$/);
		const written = payload(payload(await requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
			graphSha256,
		})).reply);
		assert.equal(written.status, "complete");
		assert.equal((written.actions as unknown[]).length, 0);
		assert.equal(written.reigniteRequest, undefined);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "complete");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "written");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.allocatedPlanDirectory, allocated);
		} finally { store.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("reignite failed ack and invalid writes leave the source complete and pending", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-failed-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const completed = await finishFinalReview(
			service,
			fixture,
			"reignite-failed",
			"VERDICT: BLOCK\nFINDINGS: [fl-1][P1][BLOCKING][PATCH_REGRESSION] residual regression\nFIX_GUIDANCE: Restore the missing check.\nDISCOVERED_PATHS: none\nSCOPE: FAIL\nCHECKS: fixture test — passed\nRATIONALE: Residual regression belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		const reignite = payload(completed.reigniteRequest);
		const allocated = String(reignite.allocatedPlanDirectory);
		const failed = payload(payload(await requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "failed",
			detail: "Could not shape a follow-up graph.",
		})).reply);
		assert.equal(failed.status, "complete");
		assert.equal(payload(failed.reigniteRequest).state, "pending");
		assert.equal(payload(failed.reigniteRequest).allocatedPlanDirectory, allocated);
		assert.equal(payload(failed.reigniteRequest).detail, "Could not shape a follow-up graph.");

		fs.mkdirSync(allocated, { recursive: true });
		fs.writeFileSync(path.join(allocated, "README.md"), "# foreign readme\n");
		await assert.rejects(() => requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
			graphSha256: "a".repeat(64),
		}), /foreign or invalid README/);

		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "complete");
			store.updateReigniteRequest(String(reignite.requestId), { allocatedPlanDirectory: fixture.planDirectory });
		} finally { store.close(); }
		await assert.rejects(() => requestService(service, "/v1/reignite", {
			requestId: reignite.requestId,
			requestSha256: reignite.requestSha256,
			state: "written",
			graphSha256: "a".repeat(64),
		}), /source plan directory/);

		const resumed = payload(payload(await requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		})).reply);
		assert.equal(resumed.status, "complete");
		assert.equal(payload(resumed.reigniteRequest).requestId, reignite.requestId);
		assert.equal(payload(resumed.reigniteRequest).allocatedPlanDirectory, fixture.planDirectory);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("status snapshots revalidate live complete state before exposing a reignite dossier", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-reignite-stale-status-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const completed = await finishFinalReview(
			service,
			fixture,
			"reignite-stale-status",
			"VERDICT: REVISE\nFINDINGS: [st-1][P1][BLOCKING][PLAN_REQUIREMENT] residual work\nFIX_GUIDANCE: Open a sibling plan set.\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: fixture test — passed\nRATIONALE: Residual work belongs in a follow-up plan set.\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
		);
		assert.equal(completed.status, "complete");
		assert.equal(payload(completed.reigniteRequest).state, "pending");
		appendIndependentPlan(fixture);
		const queued = await submitManagerOperation(service, "event", {
			eventId: "reignite-stale-status-drift",
			kind: "terminals",
			terminals: [],
		});
		const concurrent = payload(await requestService(service, "/v1/status"));
		const concurrentReply = payload(concurrent.reply);
		if (queued.state === "accepted" || queued.state === "running") {
			if (concurrentReply.status === "complete") {
				assert.ok(Array.isArray(concurrent.operations) && (concurrent.operations as unknown[]).length > 0);
			} else {
				assert.notEqual(concurrentReply.status, "complete");
				assert.equal(concurrentReply.reigniteRequest, undefined);
			}
		}
		await waitManagerOperation(service, queued.operationId);
		const after = payload(payload(await requestService(service, "/v1/status")).reply);
		assert.equal(after.status, "paused");
		assert.equal(after.reigniteRequest, undefined);
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "paused");
			store.putSnapshot({
				...completed,
				status: "complete",
				reigniteRequest: completed.reigniteRequest,
			} as unknown as ManagerReply);
		} finally { store.close(); }
		const stale = payload(payload(await requestService(service, "/v1/status")).reply);
		assert.equal(stale.status, "paused");
		assert.equal(stale.reigniteRequest, undefined);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("changed-tree verification resume rejects replacement", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-verification-drift-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const awaiting = await prepareSinglePlan(service, fixture, "verification-drift");
		await submitFinalVerification(service, fixture.planDirectory, awaiting, "verification-drift", [{
			gateId: "drift-failure",
			label: "drift failure gate",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(11)"],
			rationale: "Creates the failed verification before tree drift.",
		}]);
		const failed = new RunStore(fixture.planDirectory);
		let requestId: string;
		let originalIntegrationHead: string;
		let originalIntegrationTree: string;
		let integrationWorktree: string;
		try {
			const run = failed.getRun()!;
			const verification = failed.getVerification(run.runId, run.currentGeneration)!;
			assert.equal(verification.state, "failed");
			requestId = verification.request.requestId;
			originalIntegrationHead = verification.request.integrationHead;
			originalIntegrationTree = verification.request.integrationTree;
			integrationWorktree = run.integrationWorktree;
		} finally {
			failed.close();
		}
		fs.writeFileSync(path.join(integrationWorktree, "src/other.mjs"), "export const other = 2\n");
		git(integrationWorktree, ["add", "src/other.mjs"]);
		git(integrationWorktree, ["commit", "-q", "-m", "test: change integration tree"]);
		const changedHead = git(integrationWorktree, ["rev-parse", "HEAD"]).stdout.trim();
		const changedTree = git(integrationWorktree, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
		assert.notEqual(changedHead, originalIntegrationHead);
		assert.notEqual(changedTree, originalIntegrationTree);
		assert.equal(git(integrationWorktree, ["status", "--porcelain"]).stdout.trim(), "");
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		}), /Cannot retry verification because the frozen integration tree changed/);
		const state = readManagerState(fixture.planDirectory);
		assert.equal(state.run?.status, "failed");
		assert.equal(state.verification?.state, "failed");
		const after = new RunStore(fixture.planDirectory);
		try {
			const run = after.getRun()!;
			const verification = after.getVerification(run.runId, run.currentGeneration)!;
			assert.equal(verification.request.requestId, requestId!);
			assert.equal(after.getPlan(run.runId, "RUN"), null);
		} finally {
			after.close();
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("one manager fills the role-agnostic worker pool across independent plans", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-pool-test-"));
	const fixture = writeFixture(root);
	addIndependentPlan(fixture);
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(await requestService(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
			dashboardUrl: service.dashboardUrl,
		}));
		const reply = payload(started.reply);
		const actions = (reply.actions as unknown[]).map(payload);
		assert.equal(actions.length, 2);
		assert.deepEqual(actions.map((action) => action.planId), ["001", "002"]);
		assert.equal(actions.every((action) => action.role === "plan-implementer"), true);
		assert.equal(payload(reply.summary).available, 0);
		assert.equal(payload(reply.scheduler).workConserving, true);
		assert.equal(payload(reply.scheduler).reason, "saturated");
		const constrained = payload(payload(await requestService(service, "/v1/event", {
			eventId: "capacity-limited-dispatch",
			kind: "dispatch_results",
			dispatchResults: [
				{ actionId: actions[0].actionId, accepted: true, hostHandle: "only-worker-slot" },
				{ actionId: actions[1].actionId, accepted: false, error: "host concurrency limit reached" },
			],
		})).reply);
		assert.equal((constrained.actions as unknown[]).length, 0, "capacity rejection was retried before a worker completed");
		assert.equal((constrained.active as unknown[]).length, 1);
		assert.equal(payload(constrained.scheduler).reason, "host-backpressure");
		assert.equal(constrained.attention, undefined, "capacity backpressure must not create attention");
		assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim(), fixture.originalHead);

		const firstWorktree = String(actions[0].worktree);
		fs.writeFileSync(path.join(firstWorktree, "src/value.mjs"), "export const value = 2\n");
		git(firstWorktree, ["add", "src/value.mjs"]);
		git(firstWorktree, ["commit", "-q", "-m", "fix: complete first concurrent plan"]);
		const mixed = payload(payload(await requestService(service, "/v1/event", {
			eventId: "mixed-terminal-implementer",
			kind: "terminals",
			terminals: [{
				actionId: actions[0].actionId,
				hostHandle: "only-worker-slot",
				response: `STATUS: COMPLETE\nCOMMITS: ${git(firstWorktree, ["rev-parse", "HEAD"]).stdout.trim()}\nADDRESSED: none\nCHECKS: npm test — passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: done\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
			}],
		})).reply);
		const mixedActions = (mixed.actions as unknown[]).map(payload);
		assert.deepEqual(mixedActions.map((action) => [action.planId, action.role]).sort(), [
			["001", "plan-reviewer"],
			["002", "plan-implementer"],
		]);
		const mixedReviewer = mixedActions.find((action) => action.role === "plan-reviewer");
		const mixedImplementer = mixedActions.find((action) => action.role === "plan-implementer");
		assert.ok(mixedReviewer);
		assert.ok(mixedImplementer);
		await requestService(service, "/v1/event", {
			eventId: "mixed-dispatch-review-and-implementation",
			kind: "dispatch_results",
			dispatchResults: [
				{ actionId: mixedReviewer.actionId, accepted: true, hostHandle: "mixed-reviewer" },
				{ actionId: mixedImplementer.actionId, accepted: true, hostHandle: "mixed-implementer" },
			],
		});
		const reviewed = payload(payload(await requestService(service, "/v1/event", {
			eventId: "mixed-terminal-reviewer",
			kind: "terminals",
			terminals: [{
				actionId: mixedReviewer.actionId,
				hostHandle: "mixed-reviewer",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test — passed\nRATIONALE: exact patch approved\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test",
			}],
		})).reply);
		assert.equal(payload(reviewed.summary).done, 1);
		assert.deepEqual((reviewed.active as unknown[]).map((item) => payload(item).planId), ["002"]);
		const store = new RunStore(fixture.planDirectory);
		const run = store.getRun()!;
		const approval = store.getApproval(run.runId, "001", 1);
		assert.ok(approval, "mixed Reviewer/Implementer completion skipped the approval transaction");
		assert.equal(store.getAction(approval.reviewerActionId)?.role, "plan-reviewer");
		assert.equal(store.getPlan(run.runId, "001")?.phase, "DONE");
		store.close();
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stop preserves evidence without creating attention", { timeout: 10_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-stop-attention-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		});
		const stopped = payload(await requestService(service, "/v1/stop", {}));
		const reply = payload(stopped.reply);
		assert.equal(reply.status, "stopped");
		assert.equal(reply.attention, undefined, "stop must not create attention");
		const store = new RunStore(fixture.planDirectory);
		try {
			assert.equal(store.getAttentionRequests(store.getRun()!.runId).length, 0);
		} finally { store.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("pending initial recovery attention does not block unrelated scheduling", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-attention-scheduling-test-"));
	const fixture = writeFixture(root);
	addIndependentPlan(fixture);
	markFirstPlanBlocked(fixture);
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		assert.equal(started.status, "running");
		const attention = payload(started.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "initial_decision_blocked");
		assert.equal(attention.planId, "001");
		assert.deepEqual(payload(attention.continuation), { role: "plan-implementer", phase: "READY_IMPLEMENTER" });
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getAttentionRequests(run.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "initial_decision_blocked").length, 1);
		} finally { store.close(); }
		const actions = (started.actions as unknown[]).map(payload);
		assert.deepEqual(actions.map((candidate) => candidate.planId), ["002"]);
		assert.equal(payload(started.scheduler).reason, "saturated");
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("daemon audit detects and repairs a non-work-conserving scheduler state", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-conservation-test-"));
	const fixture = writeFixture(root);
	addIndependentPlan(fixture);
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 2, dashboardUrl: service.dashboardUrl,
		})).reply);
		const actions = (started.actions as unknown[]).map(payload);
		assert.equal(actions.length, 2);
		await stopService(fixture.planDirectory);

		const store = new RunStore(fixture.planDirectory);
		const run = store.getRun()!;
		const action = store.getAction(String(actions[1].actionId))!;
		const plan = store.getPlan(run.runId, String(actions[1].planId))!;
		store.markCancelled(action.actionId, { error: "injected scheduler test gap" });
		store.putPlan({ ...plan, phase: "READY_IMPLEMENTER" });
		store.close();
		git(fixture.repo, ["worktree", "unlock", String(actions[1].worktree)]);

		const manager = new HerderRunManager(fixture.planDirectory);
		try {
			const stalled = manager.reply();
			assert.equal(stalled.scheduler.workConserving, false);
			assert.equal(stalled.scheduler.reason, "scheduler-stall");
			assert.deepEqual(stalled.scheduler.runnablePlanIds, ["002"]);
			assert.equal(stalled.attention, undefined, "scheduler stalls must not create attention");
			const healed = await manager.auditScheduler({ includeReply: false });
			assert.ok(healed, "scheduler repair must publish a reply");
			assert.equal(healed.scheduler.workConserving, true);
			assert.equal(healed.active.length, 2);
			assert.equal(healed.actions.some((candidate) => candidate.planId === "002"), true);
			assert.equal(healed.attention, undefined, "scheduler repair must not create attention");
		} finally { manager.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stable scheduler audits suppress replies while graph drift remains publishable", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-audit-publication-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		assert.equal((started.actions as unknown[]).length, 1);
		await stopService(fixture.planDirectory);

		const manager = new HerderRunManager(fixture.planDirectory);
		try {
			await manager.auditScheduler();
			assert.equal(await manager.auditScheduler({ includeReply: false }), null);
			assert.ok(await manager.auditScheduler(), "default scheduler audits must remain reply-returning");

			addIndependentPlan(fixture);
			const driftReply = await manager.auditScheduler({ includeReply: false });
			assert.ok(driftReply, "graph-drift pause must publish a reply");
			assert.equal(driftReply.status, "paused");
		} finally { manager.close(); }
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("integration requires an atomic exact approval proof", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-approval-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		let reply = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		const implementer = payload((reply.actions as unknown[])[0]);
		await requestService(service, "/v1/event", {
			eventId: "approval-dispatch-implementer", kind: "dispatch_results",
			dispatchResults: [{ actionId: implementer.actionId, accepted: true, hostHandle: "approval-implementer" }],
		});
		const worktree = String(implementer.worktree);
		fs.writeFileSync(path.join(worktree, "src/value.mjs"), "export const value = 2\n");
		git(worktree, ["add", "src/value.mjs"]);
		git(worktree, ["commit", "-q", "-m", "fix: approval fixture"]);
		reply = payload(payload(await requestService(service, "/v1/event", {
			eventId: "approval-terminal-implementer", kind: "terminals",
			terminals: [{
				actionId: implementer.actionId, hostHandle: "approval-implementer",
				response: `STATUS: COMPLETE\nCOMMITS: ${git(worktree, ["rev-parse", "HEAD"]).stdout.trim()}\nADDRESSED: none\nCHECKS: npm test — passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: done\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test`,
			}],
		})).reply);
		const reviewer = payload((reply.actions as unknown[])[0]);
		await requestService(service, "/v1/event", {
			eventId: "approval-dispatch-reviewer", kind: "dispatch_results",
			dispatchResults: [{ actionId: reviewer.actionId, accepted: true, hostHandle: "approval-reviewer" }],
		});
		const store = new RunStore(fixture.planDirectory);
		const run = store.getRun()!;
		const plan = store.getPlan(run.runId, "001")!;
		store.putPlan({ ...plan, phase: "READY_TO_INTEGRATE" });
		assert.equal(store.getApproval(run.runId, "001", plan.generation), null);
		store.close();
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "resume", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		}), /no durable approval proof/);
		assert.equal(git(fixture.repo, ["show-ref", "--verify", "--quiet", "refs/plan-herder/herder-plans/completed/001"], true).status, 1);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("active Grill rejects started plans and releases unchanged reservations", { timeout: 10_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-plan-edit-guard-test-"));
	const fixture = writeFixture(root);
	addIndependentPlan(fixture);
	try {
		const service = await ensureService(fixture.planDirectory);
		await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		});
		await assert.rejects(() => requestService(service, "/v1/edit", { operation: "begin", planId: "001" }), /execution already started/);
		const begun = payload(await requestService(service, "/v1/edit", { operation: "begin", planId: "2" }));
		const edit = payload(begun.edit);
		const cancelled = payload(await requestService(service, "/v1/edit", { operation: "cancel", editToken: edit.editToken }));
		assert.equal(payload(cancelled.reply).planEdit, undefined);
		const store = new RunStore(fixture.planDirectory);
		assert.equal(store.getPlanEdit(store.getRun()!.runId), null);
		store.close();
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("active Grill reserves an unstarted plan and adopts it after current workers settle", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-plan-edit-test-"));
	const fixture = writeFixture(root);
	addIndependentPlan(fixture);
	try {
		const service = await ensureService(fixture.planDirectory);
		const started = payload(payload(await requestService(service, "/v1/start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		const implementer = payload((started.actions as unknown[])[0]);
		assert.equal(implementer.planId, "001");
		await requestService(service, "/v1/event", {
			eventId: "plan-edit-dispatch-implementer", kind: "dispatch_results",
			dispatchResults: [{ actionId: implementer.actionId, accepted: true, hostHandle: "plan-edit-implementer" }],
		});

		const begun = payload(await requestService(service, "/v1/edit", { operation: "begin", planId: "002-update-other.md" }));
		const edit = payload(begun.edit);
		assert.equal(edit.planId, "002");
		assert.equal(edit.state, "reserved");
		assert.match(String(edit.editToken), /^[0-9a-f-]{36}$/i);
		assert.deepEqual(payload(begun.reply).planEdit, { planId: "002", state: "reserved" });

		fs.appendFileSync(path.join(fixture.planDirectory, "002-update-other.md"), "\nGrill refinement: keep the other export stable and focused.\n");
		const finished = payload(await requestService(service, "/v1/edit", { operation: "finish", editToken: edit.editToken }));
		assert.deepEqual(payload(finished.reply).planEdit, { planId: "002", state: "barrier" });
		assert.equal(payload(payload(finished.reply).scheduler).reason, "revision-barrier");
		const beforeAdoption = new RunStore(fixture.planDirectory);
		assert.equal(beforeAdoption.getRun()!.currentGeneration, 1);
		assert.equal(beforeAdoption.getPlanEdit(beforeAdoption.getRun()!.runId)!.state, "barrier");
		beforeAdoption.close();

		const worktree = String(implementer.worktree);
		fs.writeFileSync(path.join(worktree, "src/value.mjs"), "export const value = 2\n");
		git(worktree, ["add", "src/value.mjs"]);
		git(worktree, ["commit", "-q", "-m", "fix: complete work during grill"]);
		const advanced = payload(payload(await requestService(service, "/v1/event", {
			eventId: "plan-edit-terminal-implementer", kind: "terminals",
			terminals: [{
				actionId: implementer.actionId,
				hostHandle: "plan-edit-implementer",
				response: `STATUS: COMPLETE\nCOMMITS: ${git(worktree, ["rev-parse", "HEAD"]).stdout.trim()}\nCHECKS: npm test — passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: value updated\nUSAGE: input_tokens=10; cached_input_tokens=0; output_tokens=5; reasoning_tokens=0; source=test-host`,
			}],
		})).reply);
		assert.equal(advanced.planEdit, undefined);
		assert.deepEqual((advanced.actions as unknown[]).map((action) => [payload(action).planId, payload(action).role]), [["001", "plan-reviewer"]]);

		const adopted = new RunStore(fixture.planDirectory);
		const run = adopted.getRun()!;
		assert.equal(run.currentGeneration, 2);
		assert.equal(adopted.getPlanEdit(run.runId), null);
		assert.notEqual(
			adopted.getPlanSpecs(run.runId, 1).find((spec) => spec.planId === "002")!.planFingerprint,
			adopted.getPlanSpecs(run.runId, 2).find((spec) => spec.planId === "002")!.planFingerprint,
		);
		assert.equal(adopted.getPlan(run.runId, "001")!.generation, 1);
		adopted.close();
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("plan graph revision adopts additions while preserving exact completed evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-revision-test-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const complete = await completeSinglePlan(service, fixture, "revision");
		assert.equal(complete.status, "complete");
		const firstStore = new RunStore(fixture.planDirectory);
		const firstRun = firstStore.getRun()!;
		const approval = firstStore.getApproval(firstRun.runId, "001", 1);
		assert.ok(approval);
		assert.equal(firstStore.getAction(approval.reviewerActionId)?.state, "terminal");
		firstStore.close();
		const completionRef = "refs/plan-herder/herder-plans/completed/001";
		assert.equal(git(fixture.repo, ["cat-file", "-t", completionRef]).stdout.trim(), "tag");
		assert.match(git(fixture.repo, ["cat-file", "-p", completionRef]).stdout, /HERDER_COMPLETION_V1/);

		appendIndependentPlan(fixture);
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "resume", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		}), /Use revise instead of resume/);
		const revised = payload(payload(await requestService(service, "/v1/start", {
			mode: "revise", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		})).reply);
		assert.equal(payload(revised.summary).total, 2);
		assert.equal(payload(revised.summary).done, 1);
		assert.equal(payload((revised.actions as unknown[])[0]).planId, "002");
		const revisedStore = new RunStore(fixture.planDirectory);
		const revisedRun = revisedStore.getRun()!;
		assert.equal(revisedRun.currentGeneration, 2);
		assert.equal(revisedStore.getGenerations(revisedRun.runId).length, 2);
		assert.match(revisedStore.getGeneration(revisedRun.runId, 2)!.runAssignmentPath, /run-assignment-generation-2\.json$/);
		assert.equal(revisedStore.getPlan(revisedRun.runId, "001")!.generation, 1);
		revisedStore.close();

		const newAction = payload((revised.actions as unknown[])[0]);
		await requestService(service, "/v1/event", {
			eventId: "revision-cancel-new-plan", kind: "dispatch_results",
			dispatchResults: [{ actionId: newAction.actionId, accepted: false, error: "test host unavailable" }],
		});
		fs.appendFileSync(path.join(fixture.planDirectory, "001-update-value.md"), "\nChanged after approval.\n");
		await assert.rejects(() => requestService(service, "/v1/start", {
			mode: "revise", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory, profile: "eclipse", maxParallel: 1,
		}), /changed 001 after execution started/);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("integration repair begin is atomic, request-bound, and terminal-safe", { timeout: 35_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-integration-repair-admission-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const afterReviewer = await prepareSinglePlan(service, fixture, "repair-admission");
		const failed = await submitFinalVerification(service, fixture.planDirectory, afterReviewer, "repair-admission", [{
			gateId: "failing-gate",
			label: "deliberate failure",
			cwd: ".",
			argv: ["node", "-e", "process.exit(1)"],
			rationale: "Proves the repair admission path.",
		}]);
		assert.equal(failed.reply.status, "failed");
		const repair = payload(failed.reply.integrationRepair);
		const token = String(repair.capabilityToken);
		const begin = {
			operation: "begin",
			operationId: "repair-begin-admission",
			requestId: String(repair.requestId),
			requestSha256: String(repair.requestSha256),
			capabilityToken: token,
			runId: String(repair.runId),
			generation: Number(repair.generation),
			ownerSessionId: "main-session",
			classification: "code_defect",
		};
		const begun = payload(payload(await requestService(service, "/v1/integration-repair", begin)).reply);
		assert.equal(begun.status, "paused");
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			const row = store.getIntegrationRepairForRequest(String(repair.requestId))!;
			assert.equal(run.status, "paused");
			assert.equal(store.getIntegrationRepairAudits(row.repairId).length, 1);
			const operationRows = store.database.prepare("SELECT result_json FROM manager_operations WHERE result_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").all() as Array<{ result_json: string }>;
			const snapshotRow = store.database.prepare("SELECT reply_json FROM manager_snapshots WHERE singleton = 1").get() as { reply_json: string };
			assert.equal(operationRows[0]!.result_json.includes(token), false);
			assert.equal(snapshotRow.reply_json.includes(token), false);
			assert.ok(Array.isArray(payload(begun.integrationRepair).beginRefSnapshot));
			assert.ok(String(payload(begun.integrationRepair).beginRefSnapshotSha256));
			assert.equal(row.beginRefSnapshot !== null, true);
			assert.equal(row.beginRefSnapshotSha256 !== null, true);
		} finally {
			store.close();
		}
		const driftRef = "refs/plan-herder/herder-plans/checkpoints/RUN/001";
		git(fixture.repo, ["update-ref", driftRef, String(repair.parentCommit)]);
		const driftFinish = {
			operation: "finish",
			operationId: "repair-finish-namespace-drift",
			requestId: String(repair.requestId),
			requestSha256: String(repair.requestSha256),
			capabilityToken: token,
			runId: String(repair.runId),
			generation: Number(repair.generation),
			ownerSessionId: "main-session",
			allowedPaths: ["src/value.mjs"],
			commitMessage: "fix: reject namespace drift",
		};
		const driftReceipt = await submitManagerOperation(service, "integration_repair", driftFinish, driftFinish.operationId);
		await assert.rejects(() => waitManagerOperation(service, driftReceipt.operationId), /manager-owned Herder ref/);
		git(fixture.repo, ["update-ref", "-d", driftRef]);
		const interrupted = new RunStore(fixture.planDirectory);
		interrupted.updateRun({ status: "failed", terminalDetail: "simulated crash cut" });
		interrupted.close();
		const replayed = payload(payload(await requestService(service, "/v1/integration-repair", begin)).reply);
		assert.equal(replayed.status, "paused");

		await requestService(service, "/v1/stop", {});
		await assert.rejects(
			() => requestService(service, "/v1/integration-repair", { ...begin, operationId: "repair-begin-after-stop" }),
			/not allowed after the run is stopped/,
		);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("integration repair finish replays a crash-created commit", { timeout: 45_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-integration-repair-crash-"));
	const fixture = writeFixture(root);
	try {
		let service = await ensureService(fixture.planDirectory);
		const afterReviewer = await prepareSinglePlan(service, fixture, "repair-finish-crash");
		const failed = await submitFinalVerification(service, fixture.planDirectory, afterReviewer, "repair-finish-crash", [{
			gateId: "failing-gate",
			label: "deliberate failure",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(1)"],
			rationale: "Creates a durable repair transaction for crash replay.",
		}]);
		const repairRequest = payload(failed.reply.integrationRepair);
		const token = String(repairRequest.capabilityToken);
		const begin = {
			operation: "begin",
			operationId: "repair-begin-crash",
			requestId: String(repairRequest.requestId),
			requestSha256: String(repairRequest.requestSha256),
			capabilityToken: token,
			runId: String(repairRequest.runId),
			generation: Number(repairRequest.generation),
			ownerSessionId: "main-session",
			classification: "code_defect",
		};
		await requestService(service, "/v1/integration-repair", begin);
		await stopService(fixture.planDirectory);

		const before = new RunStore(fixture.planDirectory);
		const run = before.getRun()!;
		const repair = before.getIntegrationRepairForRequest(String(repairRequest.requestId))!;
		const finish = {
			operation: "finish",
			operationId: "repair-finish-crash",
			requestId: String(repairRequest.requestId),
			requestSha256: String(repairRequest.requestSha256),
			capabilityToken: token,
			runId: String(repairRequest.runId),
			generation: Number(repairRequest.generation),
			ownerSessionId: "main-session",
			allowedPaths: ["src/value.mjs"],
			commitMessage: "fix: replay crash repair",
		};
		const { capabilityToken: _capabilityToken, ...finishEvidence } = finish;
		const payloadSha256 = sha256(stableJson({ ...finishEvidence, capabilityTokenSha256: integrationRepairCapabilityDigest(token) }));
		const repairMarker = sha256(stableJson({
			repairId: repair.repairId,
			parentCommit: repair.parentCommit,
			round: repair.round,
			operationId: finish.operationId,
			payloadSha256,
		}));
		before.close();

		const crashed = new RunStore(fixture.planDirectory);
		try {
			assert.equal(crashed.claimNextOperation(), null);
			crashed.submitOperation(finish.operationId, "integration_repair", finish);
			assert.equal(crashed.claimNextOperation()?.state, "running");
			crashed.updateIntegrationRepair(repair.repairId, {
				state: "committing",
				operationId: finish.operationId,
				operationPayloadSha256: payloadSha256,
			});
		} finally {
			crashed.close();
		}

		fs.writeFileSync(path.join(run.integrationWorktree, "src/value.mjs"), "export const value = 3\n");
		const driver = new GitDriver({
			repoRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			planName: path.basename(fixture.planDirectory),
			helperRoot: path.resolve("extensions/herder/src/daemon/git"),
		});
		const committed = driver.acceptIntegrationRepairCommit({
			parent: repair.parentCommit,
			round: repair.round,
			repairMarker,
			beginRefSnapshot: repair.beginRefSnapshot!,
			beginRefSnapshotSha256: repair.beginRefSnapshotSha256!,
			allowedPaths: ["src/value.mjs"],
			commitMessage: finish.commitMessage,
		});
		assert.notEqual(committed.head, repair.parentCommit);

		service = await ensureService(fixture.planDirectory);
		await waitManagerOperation(service, finish.operationId);
		const recovered = new RunStore(fixture.planDirectory);
		try {
			const recoveredRepair = recovered.getIntegrationRepair(repair.repairId)!;
			assert.equal(recoveredRepair.currentCommit, committed.head);
			assert.equal(recoveredRepair.supersededCommits.length, 0);
			assert.equal(git(run.integrationWorktree, ["rev-parse", "HEAD"]).stdout.trim(), committed.head);
		} finally {
			recovered.close();
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});

test("invalid successor gates remain retryable after rejected finish", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-integration-repair-gates-"));
	const fixture = writeFixture(root);
	try {
		const service = await ensureService(fixture.planDirectory);
		const afterReviewer = await prepareSinglePlan(service, fixture, "repair-gate-retry");
		const retainedGate: VerificationGate = {
			gateId: "failing-gate",
			label: "wait for the repair value",
			cwd: ".",
			argv: [process.execPath, "-e", "process.exit(require('node:fs').readFileSync('src/value.mjs', 'utf8').includes('value = 3') ? 0 : 1)"],
			rationale: "The gate becomes true only after the repair changes the fixture.",
		};
		const failed = await submitFinalVerification(service, fixture.planDirectory, afterReviewer, "repair-gate-retry", [retainedGate]);
		assert.equal(failed.reply.status, "failed");
		const repairRequest = payload(failed.reply.integrationRepair);
		const token = String(repairRequest.capabilityToken);
		const begin = {
			operation: "begin",
			operationId: "repair-gate-begin",
			requestId: String(repairRequest.requestId),
			requestSha256: String(repairRequest.requestSha256),
			capabilityToken: token,
			runId: String(repairRequest.runId),
			generation: Number(repairRequest.generation),
			ownerSessionId: "main-session",
			classification: "code_defect",
		};
		await requestService(service, "/v1/integration-repair", begin);

		const finishBase = {
			operation: "finish",
			requestId: String(repairRequest.requestId),
			requestSha256: String(repairRequest.requestSha256),
			capabilityToken: token,
			runId: String(repairRequest.runId),
			generation: Number(repairRequest.generation),
			ownerSessionId: "main-session",
			allowedPaths: ["src/value.mjs"],
			commitMessage: "fix: make the repaired fixture pass",
		};
		const rejected = async (input: Record<string, unknown>, expected: RegExp): Promise<void> => {
			await assert.rejects(async () => {
				const receipt = await submitManagerOperation(service, "integration_repair", input, String(input.operationId));
				await waitManagerOperation(service, receipt.operationId);
			}, expected);
		};
		const absolute = { ...finishBase, operationId: "repair-gate-absolute", gates: [{ ...retainedGate, cwd: fixture.repo }] };
		await rejected(absolute, /cwd must be relative/);
		const replay = await submitManagerOperation(service, "integration_repair", absolute, String(absolute.operationId));
		assert.equal(replay.state, "failed");
		assert.match(String(replay.error), /cwd must be relative/);
		await assert.rejects(() => waitManagerOperation(service, replay.operationId), /cwd must be relative/);
		await assert.rejects(
			() => submitManagerOperation(service, "integration_repair", { ...absolute, gates: [retainedGate] }, String(absolute.operationId)),
			/replayed with different payload/,
		);
		await rejected({ ...finishBase, operationId: "repair-gate-missing", gates: [{ ...retainedGate, cwd: "missing-successor-cwd" }] }, /ENOENT|no such file or directory/);
		const duplicate = { ...retainedGate, label: "duplicate gate" };
		await rejected({ ...finishBase, operationId: "repair-gate-duplicate", gates: [retainedGate, duplicate], gateAdditions: [duplicate] }, /gate ID failing-gate is duplicated/);
		await rejected({ ...finishBase, operationId: "repair-gate-prefix", gates: [{ ...retainedGate, label: "changed retained gate" }] }, /changed or was reordered/);

		const store = new RunStore(fixture.planDirectory);
		const before = store.getIntegrationRepairForRequest(String(repairRequest.requestId))!;
		try {
			assert.equal(before.state, "active");
			assert.equal(before.currentCommit, null);
			assert.equal(before.currentTree, null);
			assert.equal(before.successorRequestId, null);
			assert.deepEqual(before.supersededCommits, []);
			assert.deepEqual(store.getIntegrationRepairAudits(before.repairId).map((audit) => audit.action), ["begin"]);
			assert.equal(Number((store.database.prepare("SELECT COUNT(*) AS count FROM manager_verifications").get() as { count: number }).count), 1);
			assert.equal(git(String(repairRequest.integrationWorktree), ["status", "--porcelain"]).stdout.trim(), "");
		} finally {
			store.close();
		}

		fs.writeFileSync(path.join(String(repairRequest.integrationWorktree), "src/value.mjs"), "export const value = 3\n");
		const corrected = { ...finishBase, operationId: "repair-gate-corrected" };
		const correctedReceipt = await submitManagerOperation(service, "integration_repair", corrected, String(corrected.operationId));
		await waitManagerOperation(service, correctedReceipt.operationId);
		const after = new RunStore(fixture.planDirectory);
		try {
			const repaired = after.getIntegrationRepair(before.repairId)!;
			assert.equal(repaired.state, "passed");
			assert.ok(repaired.currentCommit);
			assert.ok(repaired.currentTree);
			assert.ok(repaired.successorRequestId);
			assert.ok(repaired.successorManifest);
			assert.equal(git(String(repairRequest.integrationWorktree), ["rev-parse", "HEAD"]).stdout.trim(), repaired.currentCommit);
			assert.equal(git(String(repairRequest.integrationWorktree), ["rev-parse", "HEAD^{tree}"]).stdout.trim(), repaired.currentTree);
			assert.deepEqual(after.getIntegrationRepairAudits(before.repairId).map((audit) => audit.action), ["begin", "finish-intent", "commit", "successor"]);
			assert.equal(Number((after.database.prepare("SELECT COUNT(*) AS count FROM manager_verifications").get() as { count: number }).count), 2);
			assert.equal(after.getVerificationByRequestId(repaired.successorRequestId)?.state, "passed");
		} finally {
			after.close();
		}
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
});
