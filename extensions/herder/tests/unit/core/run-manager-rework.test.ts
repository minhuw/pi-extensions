import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getExecutionReport } from "../../../src/core/plan-report.ts";
import { reworkSnapshotPath } from "../../../src/core/plan-edit.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { recordUsageRecord } from "../../../src/daemon/execution-store.ts";
import { ensureService, requestManagerOperation, stopService, submitManagerOperation, waitManagerOperation } from "../../../src/client/index.ts";
import { fileURLToPath } from "node:url";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { sha256, stableJson, type ManagerOperationKind } from "../../../src/shared/protocol.ts";

type JsonRecord = Record<string, unknown>;
type Fixture = { repo: string; planDirectory: string };
type Service = Awaited<ReturnType<typeof ensureService>>;
type GraphState = Map<string, { bytes: Buffer; mode: number }>;

function captureGraph(value: Fixture): GraphState {
	const names = fs.readdirSync(value.planDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && (entry.name === "README.md" || entry.name === "CONTEXT.md" || /^\d{3,}-.*\.md$/i.test(entry.name)))
		.map((entry) => entry.name)
		.sort();
	return new Map(names.map((name): [string, { bytes: Buffer; mode: number }] => {
		const candidate = path.join(value.planDirectory, name);
		return [name, { bytes: fs.readFileSync(candidate), mode: fs.statSync(candidate).mode & 0o7777 }];
	}));
}

function restoreSnapshot(candidate: string, bytes: Buffer, mode: number): void {
	try { fs.unlinkSync(candidate); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	fs.writeFileSync(candidate, bytes, { mode });
	fs.chmodSync(candidate, mode);
}

function restoreTemporaryFiles(planDirectory: string, editToken: string): string[] {
	const prefix = `.herder-plan-edit-${editToken}-`;
	return fs.readdirSync(planDirectory).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp")).sort();
}

function writeCanonicalSnapshot(candidate: string, snapshot: JsonRecord): void {
	fs.writeFileSync(candidate, stableJson(snapshot));
	fs.chmodSync(candidate, 0o600);
}

function object(value: unknown): JsonRecord {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

function writePlan(id: string, title: string, scope: string): string {
	return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`fixture\`, 2026-08-11
- **Kind**: behavioral
- **Parent objective**: Exercise plan rework.

## Why this matters

The fixture proves rework discards one plan's execution without touching siblings.

## Current state

- The target starts as TODO.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused | \`node --test\` | exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: a bounded rework fixture.
- **Safe intermediate state**: only the declared fixture path changes.

## Scope

**In scope** (declared write paths):
- \`${scope}\`

**Out of scope**:
- Manager state and plan graph files.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.

## Steps

### Step 1: Keep the fixture bounded

Use the declared fixture path only.

**Verify**: \`node --test\` → exits 0.

## Test plan

- Keep this plan independent and deterministic.

## Review map

- **Outcome**: the manager can rework this target.
- **Modified symbols**: the fixture value.
- **Direct contracts**: the manager rework protocol.
- **Expected unchanged behavior**: unrelated plans continue.
- **Proof**: the focused test command.
- **Expected diff**: one fixture path.

## Done criteria

- [ ] The target rework is durable.

## STOP conditions

Stop if rework would touch an unrelated plan or graph edge.

## Maintenance notes

Keep the target-local rework evidence exact.
`;
}

function fixture(root: string): Fixture {
	const { repo } = initFixtureRepo(root, {
		name: "Rework Test",
		email: "rework@example.invalid",
		files: {
			"src/value.mjs": "export const value = 1\n",
			"src/other.mjs": "export const other = 1\n",
		},
	});
	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Rework plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-target.md) | Blocked target | P1 | S | — | TODO |
| [002](002-sibling.md) | Unrelated sibling | P1 | S | — | TODO |

## Dependency notes

The plans are independent.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-target.md"), writePlan("001", "Blocked target", "src/value.mjs"));
	fs.writeFileSync(path.join(planDirectory, "002-sibling.md"), writePlan("002", "Unrelated sibling", "src/other.mjs"));
	return { repo, planDirectory };
}

async function managerReply(service: Service, kind: ManagerOperationKind, input: JsonRecord): Promise<JsonRecord> {
	return object(object(await requestManagerOperation(service, kind, input)).reply);
}

async function withFixture<T>(prefix: string, callback: (service: Service, value: Fixture) => Promise<T>): Promise<T> {
	const previousCrashAt = process.env.HERDER_TEST_REWORK_CRASH_AT;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `herder-rework-${prefix}-`));
	let value: Fixture | undefined;
	try {
		value = fixture(root);
		const service = await ensureService(value.planDirectory);
		return await callback(service, value);
	} finally {
		try {
			if (value) {
				await stopService(value.planDirectory).catch(() => {});
				fs.rmSync(`${value.repo}-herder-worktrees`, { recursive: true, force: true });
			}
			fs.rmSync(root, { recursive: true, force: true });
		} finally {
			if (previousCrashAt === undefined) delete process.env.HERDER_TEST_REWORK_CRASH_AT;
			else process.env.HERDER_TEST_REWORK_CRASH_AT = previousCrashAt;
		}
	}
}

function failedImplementer(hostHandle: string): JsonRecord {
	return {
		actionId: "",
		hostHandle,
		response: "STATUS: FAILED\nCOMMITS: none\nCHECKS: none\nFILES CHANGED: none\nDISCOVERED_PATHS: none\nNOTES: bounded failure\nUSAGE: input_tokens=1; output_tokens=1; source=test-host",
	};
}

async function startRun(service: Service, value: Fixture, maxParallel = 2): Promise<JsonRecord> {
	return managerReply(service, "start", {
		mode: "fire",
		repositoryRoot: value.repo,
		planDirectory: value.planDirectory,
		profile: "eclipse",
		maxParallel,
	});
}

async function failTargetRounds(service: Service, started: JsonRecord, prefix: string, rounds = 6): Promise<{ reply: JsonRecord; worktree: string }> {
	let reply = started;
	let target = object((reply.actions as unknown[]).map(object).find((action) => action.planId === "001"));
	assert.ok(target);
	let worktree = String(target.worktree);
	for (let round = 1; round <= rounds; round += 1) {
		await managerReply(service, "event", {
			eventId: `${prefix}-dispatch-${round}`,
			kind: "dispatch_results",
			dispatchResults: [{ actionId: String(target.actionId), accepted: true, hostHandle: `${prefix}-${round}` }],
		});
		worktree = String(target.worktree);
		if (round === rounds) fs.writeFileSync(path.join(worktree, "discarded-untracked.txt"), "discard me\n");
		reply = await managerReply(service, "event", {
			eventId: `${prefix}-terminal-${round}`,
			kind: "terminals",
			terminals: [{ ...failedImplementer(`${prefix}-${round}`), actionId: String(target.actionId) }],
		});
		if (round < rounds) target = object((reply.actions as unknown[]).map(object).find((action) => action.planId === "001"));
	}
	return { reply, worktree };
}

function markSiblingDoneDownstream(value: Fixture): void {
	const readme = path.join(value.planDirectory, "README.md");
	fs.writeFileSync(readme, fs.readFileSync(readme, "utf8")
		.replace("| [002](002-sibling.md) | Unrelated sibling | P1 | S | — | TODO |", "| [002](002-sibling.md) | Unrelated sibling | P1 | S | 001 | DONE |"));
	const sibling = path.join(value.planDirectory, "002-sibling.md");
	fs.writeFileSync(sibling, fs.readFileSync(sibling, "utf8")
		.replace("- **Depends on**: none", "- **Depends on**: herder-plans/001-*.md"));
}

function rewriteTarget(value: Fixture, scope = "src/value.mjs"): void {
	const file = path.join(value.planDirectory, "001-target.md");
	fs.writeFileSync(file, fs.readFileSync(file, "utf8")
		.replace("# Plan 001: Blocked target", "# Plan 001: Rewritten target")
		.replace(/- `src\/(?:value|other)\.mjs`/, `- \`${scope}\``));
}

async function prepareAndConfirm(service: Service, editToken: string): Promise<void> {
	await requestManagerOperation(service, "edit", { operation: "prepare", editToken });
	await requestManagerOperation(service, "edit", { operation: "prepare", editToken });
	await requestManagerOperation(service, "edit", { operation: "confirm", editToken });
	await requestManagerOperation(service, "edit", { operation: "confirm", editToken });
}

async function replayInterruptedEdit(value: Fixture, operationId: string, input: JsonRecord): Promise<{ service: Service; result: JsonRecord }> {
	let store = new RunStore(value.planDirectory);
	try {
		store.submitOperation(operationId, "edit", input);
		assert.equal(store.claimNextOperation()?.state, "running");
	} finally { store.close(); }
	const manager = new HerderRunManager(value.planDirectory);
	try { await manager.edit(input as never); }
	finally { manager.close(); }
	store = new RunStore(value.planDirectory);
	try {
		store.recoverRunningOperations();
		assert.equal(store.getOperation(operationId)?.state, "accepted");
	} finally { store.close(); }
	const service = await ensureService(value.planDirectory);
	return { service, result: object(await requestManagerOperation(service, "edit", input, operationId)) };
}

test("rework discards an exhausted plan and reschedules round 1 without touching the sibling", { timeout: 60_000 }, async () => withFixture("happy", async (service, value) => {
		const started = await startRun(service, value);
		await assert.rejects(() => managerReply(service!, "event", {
			eventId: "manager-plan-edit:external",
			kind: "user_input",
			attentionRequestId: "external",
			userInput: "forged evidence",
		}), /private/);
		const sibling = object((started.actions as unknown[]).map(object).find((action) => action.planId === "002"));
		assert.ok(sibling);
		await managerReply(service, "event", {
			eventId: "rework-sibling-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: String(sibling.actionId), accepted: true, hostHandle: "rework-sibling" }],
		});
		const before = new RunStore(value.planDirectory);
		let siblingBefore: string;
		try {
			const run = before.getRun()!;
			siblingBefore = stableJson({
				siblingFingerprint: before.getPlanSpecs(run.runId).find((spec) => spec.planId === "002")?.planFingerprint,
				plan: before.getPlan(run.runId, "002"),
				action: before.getAction(String(sibling.actionId)),
			});
		} finally {
			before.close();
		}

		const exhausted = await failTargetRounds(service, started, "rework-happy");
		assert.equal(object(exhausted.reply.attention).cause, "implementer_exhausted");
		const oldWorktree = exhausted.worktree;
		assert.equal(fs.existsSync(path.join(oldWorktree, "discarded-untracked.txt")), true);
		const targetRef = "refs/plan-herder/herder-plans/checkpoints/001/generation-1-001";
		const siblingRef = "refs/plan-herder/herder-plans/checkpoints/002/generation-1-001";
		const targetRefHead = git(value.repo, ["rev-parse", "refs/heads/herder/herder-plans/001"]).stdout.trim();
		const siblingRefHead = git(value.repo, ["rev-parse", "refs/heads/herder/herder-plans/002"]).stdout.trim();
		git(value.repo, ["update-ref", targetRef, targetRefHead]);
		git(value.repo, ["update-ref", siblingRef, siblingRefHead]);

		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		const edit = object(begun.edit);
		assert.equal(edit.planId, "001");
		assert.equal(edit.state, "reserved");
		assert.match(String(edit.editToken), /^[0-9a-f-]{36}$/i);
		assert.equal(object(object(begun.reply).planEdit).planId, "001");
		assert.equal(object(begun.reply).attention, undefined);

		rewriteTarget(value, "src/other.mjs");
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken: edit.editToken }),
			/unordered overlap/,
		);
		rewriteTarget(value);
		await requestManagerOperation(service, "edit", { operation: "prepare", editToken: edit.editToken });
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "finish", editToken: edit.editToken }),
			/must be confirmed/,
		);
		await prepareAndConfirm(service, String(edit.editToken));
		recordUsageRecord(value.planDirectory, {
			attempt: "sibling-preserved",
			plan: "002",
			role: "plan-implementer",
			model: "test",
			effort: "low",
			outcome: "INTERRUPTED",
			source: "test",
			generation: "generation-1",
		});
		const approvalStore = new RunStore(value.planDirectory);
		try {
			const run = approvalStore.getRun()!;
			const targetActions = approvalStore.getActions(run.runId).filter((action) => action.planId === "001");
			const plan = approvalStore.getPlan(run.runId, "001")!;
			approvalStore.putApproval({
				runId: run.runId,
				planId: "001",
				generation: 1,
				round: plan.round,
				reviewerActionId: targetActions[0]!.actionId,
				decisionActionId: targetActions[1]!.actionId,
				decisionRole: "plan-reviewer",
				assignmentSha256: plan.assignmentSha256,
				approvedBase: run.baseCommit,
				approvedHead: run.baseCommit,
				approvedTree: git(value.repo, ["rev-parse", `${run.baseCommit}^{tree}`]).stdout.trim(),
				reviewResultSha256: sha256("historical-review"),
				decisionResultSha256: sha256("historical-decision"),
				proofSha256: sha256("historical-proof"),
			});
		} finally { approvalStore.close(); }
		const finished = object(await requestManagerOperation(service, "edit", { operation: "finish", editToken: edit.editToken }));
		const reply = object(finished.reply);
		assert.equal(reply.status, "running");
		assert.equal(reply.planEdit, undefined);
		assert.equal(fs.existsSync(path.join(oldWorktree, "discarded-untracked.txt")), false);
		assert.equal(git(value.repo, ["show-ref", "--verify", "--quiet", targetRef], true).status, 1);
		assert.equal(git(value.repo, ["rev-parse", siblingRef]).stdout.trim(), siblingRefHead);
		const integrationHead = git(value.repo, ["rev-parse", "refs/heads/herder/herder-plans/integration"]).stdout.trim();
		assert.equal(git(value.repo, ["rev-parse", "refs/heads/herder/herder-plans/001"]).stdout.trim(), integrationHead);

		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.currentGeneration, 2);
			const plan = store.getPlan(run.runId, "001");
			assert.ok(plan);
			assert.equal(plan.round, 1);
			assert.equal(plan.generation, 2);
			assert.equal(plan.phase, "IMPLEMENTING");
			const freshAction = (reply.actions as unknown[]).map(object).find((action) => action.planId === "001" && action.round === 1 && action.role === "plan-implementer");
			assert.ok(freshAction);
			assert.equal(freshAction.generation, plan.generation);
			assert.equal(freshAction.round, plan.round);
			assert.equal(freshAction.branch, plan.branch);
			assert.equal(freshAction.worktree, plan.worktree);
			assert.equal(freshAction.assignmentPath, plan.assignmentPath);
			assert.equal(freshAction.assignmentSha256, plan.assignmentSha256);
			assert.equal(plan.reviewPass, 0);
			assert.deepEqual(plan.findings, []);
			assert.deepEqual(plan.repair, []);
			assert.deepEqual(plan.gates, []);
			assert.equal(plan.approvedBase, null);
			assert.equal(plan.approvedHead, null);
			assert.equal(plan.approvedTree, null);
			assert.equal(plan.rebase, null);
			assert.equal(plan.generationBase, integrationHead);
			const spec = store.getPlanSpecs(run.runId).find((candidate) => candidate.planId === "001");
			assert.ok(spec);
			assert.equal(plan.snapshotSha256, spec.assignment.snapshotSha256);
			const bundle = JSON.parse(fs.readFileSync(plan.assignmentPath, "utf8")) as { snapshotSha256: string; assignment: { branch: string; generationBase: string } };
			assert.equal(sha256(fs.readFileSync(plan.assignmentPath)), plan.assignmentSha256);
			assert.equal(bundle.snapshotSha256, plan.snapshotSha256);
			assert.equal(bundle.assignment.branch, plan.branch);
			assert.equal(bundle.assignment.generationBase, integrationHead);
			assert.match(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "001")?.assignment.planText || "", /Rewritten target/);
			assert.ok(store.getAttentionRequests(run.runId).every((request) => request.planId !== "001" || request.state === "resolved"));
			assert.equal(stableJson({
				siblingFingerprint: store.getPlanSpecs(run.runId).find((spec) => spec.planId === "002")?.planFingerprint,
				plan: store.getPlan(run.runId, "002"),
				action: store.getAction(String(sibling.actionId)),
			}), siblingBefore);
			assert.ok(store.getApproval(run.runId, "001", 1));
			const report = getExecutionReport(value.planDirectory, "001");
			assert.ok(report.supersededAttempts > 0);
			assert.ok(report.attempts >= report.supersededAttempts);
			assert.ok(report.records.every((record) => typeof record.superseded === "boolean"));
			const siblingReport = getExecutionReport(value.planDirectory, "002");
			assert.equal(siblingReport.supersededAttempts, 0);
			assert.equal(siblingReport.records[0]?.superseded, false);
			const runReport = getExecutionReport(value.planDirectory, "RUN");
			assert.equal(runReport.records.find((record) => record.attempt === "sibling-preserved")?.superseded, false);
			assert.ok(runReport.records.some((record) => record.plan === "001" && record.superseded));
			store.putPlan({ ...plan, round: 2, phase: "READY_IMPLEMENTER" });
		} finally {
			store.close();
		}
		const fresh = (reply.actions as unknown[]).map(object).find((action) => action.planId === "001" && action.round === 1 && action.role === "plan-implementer");
		assert.ok(fresh);
		assert.match(String(fresh.attemptId), /-g2-r1-implementer-1$/);
		await assert.doesNotReject(() => requestManagerOperation(service!, "edit", { operation: "finish", editToken: edit.editToken }));
	}));

test("cancelling rework before finish leaves execution untouched", { timeout: 60_000 }, async () => withFixture("cancel", async (service, value) => {
		fs.writeFileSync(path.join(value.planDirectory, "CONTEXT.md"), "# Herder Plan-Set Context\n\n## Objective\n\nPreserve exact shared context during rework cancellation.\n");
		const started = await startRun(service, value);
		const exhausted = await failTargetRounds(service, started, "rework-cancel");
		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		const again = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		assert.equal(object(again.edit).editToken, object(begun.edit).editToken);
		const editToken = String(object(begun.edit).editToken);
		const original = new Map(["README.md", "CONTEXT.md", "001-target.md", "002-sibling.md"].map((name) => {
			const candidate = path.join(value.planDirectory, name);
			return [name, { bytes: fs.readFileSync(candidate), mode: fs.statSync(candidate).mode & 0o7777 }];
		}));
		rewriteTarget(value);
		await requestManagerOperation(service, "edit", { operation: "prepare", editToken });
		fs.chmodSync(path.join(value.planDirectory, "001-target.md"), 0o600);
		fs.appendFileSync(path.join(value.planDirectory, "CONTEXT.md"), "\nInterview-only context.\n");
		fs.chmodSync(path.join(value.planDirectory, "CONTEXT.md"), 0o600);
		fs.writeFileSync(path.join(value.planDirectory, "003-created.md"), writePlan("003", "Created during interview", "src/created.mjs"));
		fs.writeFileSync(path.join(value.planDirectory, "README.md"), "malformed interview index\n");
		await stopService(value.planDirectory);
		const replay = await replayInterruptedEdit(value, "rework-cancel-interrupted", { operation: "cancel", editToken });
		service = replay.service;
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken });
		assert.equal(fs.existsSync(path.join(value.planDirectory, "003-created.md")), false);
		for (const [name, expected] of original) {
			const candidate = path.join(value.planDirectory, name);
			assert.deepEqual(fs.readFileSync(candidate), expected.bytes);
			assert.equal(fs.statSync(candidate).mode & 0o7777, expected.mode);
		}
		assert.equal(fs.existsSync(path.join(exhausted.worktree, "discarded-untracked.txt")), true);
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.currentGeneration, 1);
			assert.equal(store.getPlanEdit(run.runId), null);
			assert.equal(store.getPlan(run.runId, "001")?.round, 6);
			assert.equal(store.getPlan(run.runId, "001")?.phase, "BLOCKED");
		} finally {
			store.close();
		}
	}));

test("rework cancellation rejects tampered snapshots and remains retryable", { timeout: 120_000 }, async () => withFixture("snapshot-tamper", async (service, value) => {
	fs.writeFileSync(path.join(value.planDirectory, "CONTEXT.md"), "# Herder Plan-Set Context\n\n## Objective\n\nProve snapshot tampering cannot mutate the plan graph.\n");
	const started = await startRun(service, value);
	await failTargetRounds(service, started, "rework-snapshot-tamper");
	const beforeBegin = captureGraph(value);
	const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
	const editToken = String(object(begun.edit).editToken);
	const snapshotPath = reworkSnapshotPath(value.planDirectory, editToken);
	const originalSnapshotBytes = fs.readFileSync(snapshotPath);
	const originalSnapshotMode = fs.statSync(snapshotPath).mode & 0o7777;
	assert.equal(originalSnapshotMode, 0o600);
	const originalSnapshot = object(JSON.parse(originalSnapshotBytes.toString("utf8")));
	const targetPlanFile = String(originalSnapshot.targetPlanFile);
	assert.deepEqual(captureGraph(value), beforeBegin);

	rewriteTarget(value, "src/other.mjs");
	fs.appendFileSync(path.join(value.planDirectory, "README.md"), "\nInterview-only README change.\n");
	fs.appendFileSync(path.join(value.planDirectory, "CONTEXT.md"), "\nInterview-only context change.\n");
	fs.writeFileSync(path.join(value.planDirectory, "003-created.md"), writePlan("003", "Interview-only plan", "src/created.mjs"));

	const snapshotFiles = (snapshot: JsonRecord): unknown[] => {
		if (!Array.isArray(snapshot.files)) throw new Error("snapshot files are not an array");
		return snapshot.files;
	};
	const canonicalTamper = (change: (snapshot: JsonRecord) => void): (() => void) => () => {
		const snapshot = JSON.parse(JSON.stringify(originalSnapshot)) as JsonRecord;
		change(snapshot);
		writeCanonicalSnapshot(snapshotPath, snapshot);
	};
	const replaceTargetContent = (snapshot: JsonRecord, contentBase64: string): void => {
		snapshot.files = snapshotFiles(snapshot).map((entry) => {
			const file = object(entry);
			return file.name === targetPlanFile ? { ...file, contentBase64 } : file;
		});
	};
	const sentinelPath = path.join(value.repo, "snapshot-sentinel.txt");
	fs.writeFileSync(sentinelPath, "sentinel must remain unchanged\n", { mode: 0o640 });
	fs.chmodSync(sentinelPath, 0o640);
	const vectors: Array<{ name: string; tamper: () => void; symlink?: boolean }> = [
		{
			name: "invalid-json",
			tamper: () => {
				fs.writeFileSync(snapshotPath, originalSnapshotBytes.subarray(0, originalSnapshotBytes.length - 1));
				fs.chmodSync(snapshotPath, 0o600);
			},
		},
		{
			name: "non-canonical-json",
			tamper: () => {
				fs.writeFileSync(snapshotPath, `${JSON.stringify(originalSnapshot, null, 2)}\n`);
				fs.chmodSync(snapshotPath, 0o600);
			},
		},
		{
			name: "exposed-mode",
			tamper: () => fs.chmodSync(snapshotPath, 0o644),
		},
		{
			name: "snapshot-symlink",
			symlink: true,
			tamper: () => {
				fs.unlinkSync(snapshotPath);
				fs.symlinkSync(sentinelPath, snapshotPath);
			},
		},
		{
			name: "mismatched-plan-id",
			tamper: canonicalTamper((snapshot) => { snapshot.planId = "002"; }),
		},
		{
			name: "changed-content-with-old-hash",
			tamper: canonicalTamper((snapshot) => replaceTargetContent(snapshot, Buffer.from("tampered snapshot content\n").toString("base64"))),
		},
		{
			name: "invalid-content-base64",
			tamper: canonicalTamper((snapshot) => replaceTargetContent(snapshot, "not-base64!")),
		},
		{
			name: "missing-target-file",
			tamper: canonicalTamper((snapshot) => {
				snapshot.files = snapshotFiles(snapshot).filter((entry) => object(entry).name !== targetPlanFile);
			}),
		},
	];

	for (const vector of vectors) {
		restoreSnapshot(snapshotPath, originalSnapshotBytes, originalSnapshotMode);
		vector.tamper();
		const beforeAttempt = captureGraph(value);
		const sentinelBefore = vector.symlink ? { bytes: fs.readFileSync(sentinelPath), mode: fs.statSync(sentinelPath).mode & 0o7777 } : undefined;
		await assert.rejects(
			() => requestManagerOperation(service, "edit", { operation: "cancel", editToken }, `rework-snapshot-tamper-${vector.name}`),
			/plan edit snapshot/i,
		);
		assert.deepEqual(captureGraph(value), beforeAttempt);
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun();
			assert.ok(run);
			const edit = store.getPlanEdit(run.runId);
			assert.ok(edit);
			assert.equal(edit.editToken, editToken);
			assert.equal(edit.state, "reserved");
		} finally { store.close(); }
		assert.deepEqual(restoreTemporaryFiles(value.planDirectory, editToken), []);
		if (vector.symlink) {
			assert.equal(fs.lstatSync(snapshotPath).isSymbolicLink(), true);
			assert.deepEqual(fs.readFileSync(sentinelPath), sentinelBefore!.bytes);
			assert.equal(fs.statSync(sentinelPath).mode & 0o7777, sentinelBefore!.mode);
		}
	}

	restoreSnapshot(snapshotPath, originalSnapshotBytes, originalSnapshotMode);
	await requestManagerOperation(service, "edit", { operation: "cancel", editToken }, "rework-snapshot-tamper-control");
	assert.deepEqual(captureGraph(value), beforeBegin);
	assert.equal(fs.existsSync(path.join(value.planDirectory, "003-created.md")), false);
	assert.deepEqual(restoreTemporaryFiles(value.planDirectory, editToken), []);
	assert.equal(fs.existsSync(snapshotPath), false);
	const store = new RunStore(value.planDirectory);
	try {
		const run = store.getRun();
		assert.ok(run);
		assert.equal(store.getPlanEdit(run.runId), null);
	} finally { store.close(); }
}));

test("cancelling rework restores a nested target plan", { timeout: 60_000 }, async () => withFixture("nested-cancel", async (service, value) => {
		const nested = path.join(value.planDirectory, "nested");
		fs.mkdirSync(nested);
		const target = path.join(nested, "001-target.md");
		fs.renameSync(path.join(value.planDirectory, "001-target.md"), target);
		const readme = path.join(value.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("[001](001-target.md)", "[001](nested/001-target.md)"));
		const started = await startRun(service, value);
		await failTargetRounds(service, started, "rework-nested-cancel");
		const edgeLess = fs.readFileSync(readme, "utf8").split(/\r?\n/).map((line) => line.startsWith("|") ? line.slice(1, -1).trim() : line).join("\r\n");
		fs.writeFileSync(readme, edgeLess);
		const original = fs.readFileSync(target);
		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		fs.appendFileSync(target, "\nInterview-only nested change.\n");
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: String(object(begun.edit).editToken) });
		assert.deepEqual(fs.readFileSync(target), original);

		const alternateDirectory = path.join(value.planDirectory, "alternate");
		fs.mkdirSync(alternateDirectory);
		const alternate = path.join(alternateDirectory, "001-target.md");
		fs.copyFileSync(target, alternate);
		let retry = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		let retryToken = String(object(retry.edit).editToken);
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("[001](nested/001-target.md)", "[001](alternate/001-target.md)"));
		await assert.rejects(() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken: retryToken }), /linked plan file/);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: retryToken });

		retry = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		retryToken = String(object(retry.edit).editToken);
		fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("# Plan 001: Blocked target", "# Plan 001: Rewritten nested target"));
		await prepareAndConfirm(service, retryToken);
		await requestManagerOperation(service, "edit", { operation: "finish", editToken: retryToken });
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlan(run.runId, "001")?.generation, 2);
			assert.match(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "001")?.assignment.planText || "", /Rewritten nested target/);
		} finally { store.close(); }
	}));

test("rework finish without a rewrite and integrated plans fail closed", { timeout: 90_000 }, async () => withFixture("refuse", async (service, value) => {
		const started = await startRun(service, value);
		const exhausted = await failTargetRounds(service, started, "rework-refuse");
		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken: String(object(begun.edit).editToken) }),
			/has not changed/,
		);
		assert.equal(fs.existsSync(path.join(exhausted.worktree, "discarded-untracked.txt")), true);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: String(object(begun.edit).editToken) });

		const sibling = object((started.actions as unknown[]).map(object).find((action) => action.planId === "002"));
		await managerReply(service, "event", {
			eventId: "rework-refuse-sibling-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: String(sibling.actionId), accepted: true, hostHandle: "rework-refuse-sibling" }],
		});
		const siblingTree = String(sibling.worktree);
		fs.writeFileSync(path.join(siblingTree, "src/other.mjs"), "export const other = 2\n");
		git(siblingTree, ["add", "src/other.mjs"]);
		git(siblingTree, ["commit", "-q", "-m", "fix: complete sibling"]);
		const afterSibling = await managerReply(service, "event", {
			eventId: "rework-refuse-sibling-terminal",
			kind: "terminals",
			terminals: [{
				actionId: String(sibling.actionId),
				hostHandle: "rework-refuse-sibling",
				response: `STATUS: COMPLETE\nCOMMITS: ${git(siblingTree, ["rev-parse", "HEAD"]).stdout.trim()}\nCHECKS: node --test — passed\nFILES CHANGED: src/other.mjs\nDISCOVERED_PATHS: none\nNOTES: sibling done\nUSAGE: input_tokens=1; output_tokens=1; source=test-host`,
			}],
		});
		const reviewer = object((afterSibling.actions as unknown[]).map(object).find((action) => action.planId === "002"));
		await managerReply(service, "event", {
			eventId: "rework-refuse-reviewer-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: String(reviewer.actionId), accepted: true, hostHandle: "rework-refuse-reviewer" }],
		});
		await managerReply(service, "event", {
			eventId: "rework-refuse-reviewer-terminal",
			kind: "terminals",
			terminals: [{
				actionId: String(reviewer.actionId),
				hostHandle: "rework-refuse-reviewer",
				response: "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: node --test — passed\nRATIONALE: sibling is complete\nUSAGE: input_tokens=1; output_tokens=1; source=test-host",
			}],
		});
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "begin", planId: "002", intent: "rework", editToken: randomUUID() }),
			/already integrated|corrective plan/,
		);
	}));

test("rework rejects sibling README edits and transient ref drift before deletion", { timeout: 60_000 }, async () => withFixture("drift", async (service, value) => {
		const started = await startRun(service, value);
		const exhausted = await failTargetRounds(service, started, "rework-drift");
		let begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		let editToken = String(object(begun.edit).editToken);
		rewriteTarget(value);
		fs.appendFileSync(path.join(value.planDirectory, "README.md"), "\nUnrelated interview prose.\n");
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken }),
			/outside plan 001|README content/,
		);
		assert.equal(fs.existsSync(exhausted.worktree), true);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken });

		begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		editToken = String(object(begun.edit).editToken);
		rewriteTarget(value);
		const ref = "refs/plan-herder/herder-plans/checkpoints/001/generation-1-999";
		git(value.repo, ["update-ref", ref, git(value.repo, ["rev-parse", "HEAD"]).stdout.trim()]);
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken }),
			/transient refs changed/,
		);
		assert.equal(git(value.repo, ["show-ref", "--verify", "--quiet", ref], true).status, 0);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken });
	}));

test("runtime-less DONE downstream plans refuse rework", { timeout: 60_000 }, async () => withFixture("downstream", async (service, value) => {
		markSiblingDoneDownstream(value);
		const started = await startRun(service, value);
		await failTargetRounds(service, started, "rework-downstream");
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlan(run.runId, "002"), null);
			assert.equal(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "002")?.initialStatus, "DONE");
		} finally { store.close(); }
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }),
			/integrated downstream plan 002/,
		);
	}));

test("transitive integrated downstream plans refuse rework", { timeout: 60_000 }, async () => withFixture("transitive", async (service, value) => {
		const readme = path.join(value.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8")
			.replace("| [002](002-sibling.md) | Unrelated sibling | P1 | S | — | TODO |", "| [002](002-sibling.md) | Unrelated sibling | P1 | S | 001 | BLOCKED — waiting for root |\n| [003](003-downstream.md) | Integrated descendant | P1 | S | 002 | DONE |"));
		fs.writeFileSync(path.join(value.planDirectory, "002-sibling.md"), fs.readFileSync(path.join(value.planDirectory, "002-sibling.md"), "utf8")
			.replace("- **Depends on**: none", "- **Depends on**: herder-plans/001-*.md"));
		fs.writeFileSync(path.join(value.planDirectory, "003-downstream.md"), writePlan("003", "Integrated descendant", "src/other.mjs")
			.replace("- **Depends on**: none", "- **Depends on**: herder-plans/002-*.md"));
		const started = await startRun(service, value);
		await failTargetRounds(service, started, "rework-transitive");
		await assert.rejects(
			() => requestManagerOperation(service!, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }),
			/integrated downstream plan 003/,
		);
	}));

test("rework recreates runtime and supersedes history even when sibling work fills the pool", { timeout: 60_000 }, async () => withFixture("capacity", async (service, value) => {
		const started = await startRun(service, value, 1);
		const exhausted = await failTargetRounds(service, started, "rework-capacity");
		const sibling = object((exhausted.reply.actions as unknown[]).map(object).find((action) => action.planId === "002"));
		assert.ok(sibling);
		await managerReply(service, "event", {
			eventId: "rework-capacity-sibling-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: String(sibling.actionId), accepted: true, hostHandle: "rework-capacity-sibling" }],
		});
		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		const editToken = String(object(begun.edit).editToken);
		rewriteTarget(value);
		await prepareAndConfirm(service, editToken);
		const finished = object(await requestManagerOperation(service, "edit", { operation: "finish", editToken }));
		const reply = object(finished.reply);
		assert.equal((reply.actions as unknown[]).map(object).some((action) => action.planId === "001"), false);
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			const target = store.getPlan(run.runId, "001");
			assert.ok(target);
			assert.equal(target.generation, 2);
			assert.equal(target.round, 1);
			assert.equal(target.phase, "READY_IMPLEMENTER");
			assert.equal(fs.existsSync(target.worktree), true);
			assert.ok(getExecutionReport(value.planDirectory, "001").records.every((record) => record.superseded));
		} finally { store.close(); }
	}));

test("daemon replays rework begin with the same snapshot identity", { timeout: 60_000 }, async () => withFixture("begin-crash", async (service, value) => {
		const started = await startRun(service, value);
		await failTargetRounds(service, started, "rework-begin-crash");
		await stopService(value.planDirectory);
		const editToken = randomUUID();
		const operationId = "rework-begin-crash";
		process.env.HERDER_TEST_REWORK_CRASH_AT = "after_snapshot";
		service = await ensureService(value.planDirectory);
		await submitManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken }, operationId).catch(() => undefined);
		delete process.env.HERDER_TEST_REWORK_CRASH_AT;
		await assert.rejects(() => waitManagerOperation(service!, operationId));
		fs.appendFileSync(path.join(value.planDirectory, "README.md"), "\nPost-crash external change.\n");
		service = await ensureService(value.planDirectory);
		const replayed = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken }, operationId));
		assert.equal(object(replayed.edit).editToken, editToken);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken });
		assert.doesNotMatch(fs.readFileSync(path.join(value.planDirectory, "README.md"), "utf8"), /Post-crash external change/);
	}));

test("daemon crashes replay the original rework finish operation", { timeout: 120_000 }, async () => {
	for (const point of ["after_git_cleanup", "after_adoption"] as const) {
		await withFixture(`daemon-crash-${point}`, async (service, value) => {
			const started = await startRun(service, value);
			await failTargetRounds(service, started, `rework-daemon-${point}`);
			const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
			const editToken = String(object(begun.edit).editToken);
			rewriteTarget(value);
			await prepareAndConfirm(service, editToken);
			await stopService(value.planDirectory);

			process.env.HERDER_TEST_REWORK_CRASH_AT = point;
			service = await ensureService(value.planDirectory);
			const operationId = `rework-daemon-crash-${point}`;
			await submitManagerOperation(service, "edit", { operation: "finish", editToken }, operationId).catch(() => undefined);
			delete process.env.HERDER_TEST_REWORK_CRASH_AT;
			await assert.rejects(() => waitManagerOperation(service!, operationId));

			service = await ensureService(value.planDirectory);
			const replayed = object(await requestManagerOperation(service, "edit", { operation: "finish", editToken }, operationId));
			assert.equal(object(replayed.reply).status, "running");
			const store = new RunStore(value.planDirectory);
			try {
				const run = store.getRun()!;
				assert.equal(run.currentGeneration, 2);
				assert.equal(store.getPlan(run.runId, "001")?.round, 1);
				assert.equal(store.getOperation(operationId)?.state, "succeeded");
			} finally { store.close(); }
		});
	}
});

test("replaying rework finish after Git cleanup evidence completes the transaction", { timeout: 60_000 }, async () => withFixture("replay", async (service, value) => {
		const started = await startRun(service, value);
		const exhausted = await failTargetRounds(service, started, "rework-replay");
		const begun = object(await requestManagerOperation(service, "edit", { operation: "begin", planId: "001", intent: "rework", editToken: randomUUID() }));
		const editToken = String(object(begun.edit).editToken);
		rewriteTarget(value);
		await prepareAndConfirm(service, editToken);
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			const plan = store.getPlan(run.runId, "001")!;
			const edit = store.getPlanEdit(run.runId)!;
			const expectedHead = git(plan.worktree, ["rev-parse", "HEAD"]).stdout.trim();
			const expectedTree = git(plan.worktree, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
			const cleanupIdentity = {
				runId: run.runId,
				requestId: editToken,
				requestSha256: sha256(stableJson({
					kind: "plan_rework",
					editToken,
					planId: "001",
					generation: plan.generation,
					round: plan.round,
					assignmentPath: plan.assignmentPath,
					assignmentSha256: plan.assignmentSha256,
					snapshotSha256: plan.snapshotSha256,
					generationBase: plan.generationBase,
					branch: plan.branch,
					worktree: plan.worktree,
					expectedHead,
					expectedTree,
					transientRefs: [],
				})),
				planId: "001",
				generation: plan.generation,
				round: plan.round,
				assignmentPath: plan.assignmentPath,
				assignmentSha256: plan.assignmentSha256,
				snapshotSha256: plan.snapshotSha256,
				generationBase: plan.generationBase,
				branch: plan.branch,
				worktree: plan.worktree,
				expectedHead,
				expectedTree,
			};
			const driver = new GitDriver({
				repoRoot: run.repositoryRoot,
				planDirectory: run.planDirectory,
				planName: run.planName,
				helperRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/daemon/git"),
				worktreeRoot: path.dirname(run.integrationWorktree),
			});
			driver.resetPlanExecution({
				branch: plan.branch,
				worktree: plan.worktree,
				expectedHead,
				expectedTree,
				cleanupIdentity,
				onPrepare: (step) => store.recordAttentionCleanupStep(cleanupIdentity, step),
				onProgress: (step) => store.recordAttentionCleanupCompletion(cleanupIdentity, step),
				onComplete: (step) => store.recordAttentionCleanupCompletion(cleanupIdentity, step),
			});
			assert.equal(fs.existsSync(exhausted.worktree), false);
		} finally {
			store.close();
		}
		const driftRef = "refs/plan-herder/herder-plans/checkpoints/001/generation-1-777";
		git(value.repo, ["update-ref", driftRef, git(value.repo, ["rev-parse", "refs/heads/herder/herder-plans/integration"]).stdout.trim()]);
		const driftManager = new HerderRunManager(value.planDirectory);
		try {
			await assert.rejects(() => driftManager.edit({ operation: "finish", editToken }), /transient refs changed during rework replay/);
		} finally { driftManager.close(); }
		git(value.repo, ["update-ref", "-d", driftRef]);
		await stopService(value.planDirectory);
		const replay = await replayInterruptedEdit(value, "rework-finish-interrupted", { operation: "finish", editToken });
		service = replay.service;
		const finished = object(replay.result.reply);
		assert.equal(finished.status, "running");
		const after = new RunStore(value.planDirectory);
		try {
			const run = after.getRun()!;
			assert.equal(run.currentGeneration, 2);
			assert.equal(after.getPlan(run.runId, "001")?.round, 1);
			assert.equal(after.getPlanEdit(run.runId), null);
			assert.equal(after.getActions(run.runId, ["proposed", "dispatched"]).filter((action) => action.planId === "001" && action.generation === 2).length, 1);
		} finally {
			after.close();
		}
	}));
