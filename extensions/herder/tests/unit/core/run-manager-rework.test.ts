import { revisionDriver } from "../../../src/core/run-revision.ts";
import { fixtureDependencies } from "../../support/plan-v2.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getExecutionReport } from "../../../src/core/plan-report.ts";
import { captureReworkSnapshot, reworkSnapshotPath } from "../../../src/core/plan-edit.ts";
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { recordUsageRecord } from "../../../src/daemon/execution-store.ts";
import { ensureService, requestManagerOperation, stopService, submitManagerOperation, waitManagerOperation } from "../../../src/client/index.ts";
import { fileURLToPath } from "node:url";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { sha256, stableJson, type ManagerOperationKind } from "../../../src/shared/protocol.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

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
	return fixturePlan({
		id,
		title,
		writePaths: [scope],
		acceptance: "The manager can rework this target without touching siblings.",
		implementation: "Use the declared fixture path only.",
		verificationCommand: "npm run test:herder -- extensions/herder/tests/unit/core/run-manager-rework.test.ts",
	});
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

async function failTargetRounds(service: Service, started: JsonRecord, prefix: string, rounds = 3): Promise<{ reply: JsonRecord; worktree: string }> {
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
		.replace("- **Depends on**: none", "- **Depends on**: 001").replace("Dependencies: none.", fixtureDependencies("001")));
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

// Simulate a pre-upgrade reservation directly. Public begin/confirm is deliberately
// unavailable; these fixtures retain coverage of safe cancellation and tamper refusal.
function legacyReservation(value: Fixture): JsonRecord {
	const store = new RunStore(value.planDirectory);
	try {
		const run = store.getRun()!;
		const existing = store.getPlanEdit(run.runId);
		if (existing) return { edit: existing };
		const plan = store.getPlan(run.runId, "001")!;
		const spec = store.getPlanSpecs(run.runId).find(spec => spec.planId === "001")!;
		const driver = revisionDriver(run);
		const editToken = randomUUID();
		const target = buildGraph(value.planDirectory).plans.find(plan => plan.id === "001")!;
		const snapshot = captureReworkSnapshot(run, "001", editToken, driver.worktreeHead(plan.worktree), driver.worktreeTree(plan.worktree), path.relative(value.planDirectory, target.file), driver.planTransientRefs("001"));
		const edit = store.putPlanEdit({ runId: run.runId, planId: "001", editToken, state: "reserved", baseGraphSha256: run.graphSha256, basePlanFingerprint: spec.planFingerprint });
		store.recordPlanEditSnapshot(run.runId, editToken, "001", snapshot.sha256);
		return { edit };
	} finally { store.close(); }
}

test("cancelling rework before finish leaves execution untouched", { timeout: 60_000 }, async () => withFixture("cancel", async (service, value) => {
		fs.writeFileSync(path.join(value.planDirectory, "CONTEXT.md"), "# Herder Plan-Set Context\n\n## Objective\n\nPreserve exact shared context during rework cancellation.\n");
		const started = await startRun(service, value);
		const exhausted = await failTargetRounds(service, started, "rework-cancel");
		const begun = legacyReservation(value);
		const again = legacyReservation(value);
		assert.equal(object(again.edit).editToken, object(begun.edit).editToken);
		const editToken = String(object(begun.edit).editToken);
		const original = new Map(["README.md", "CONTEXT.md", "001-target.md", "002-sibling.md"].map((name) => {
			const candidate = path.join(value.planDirectory, name);
			return [name, { bytes: fs.readFileSync(candidate), mode: fs.statSync(candidate).mode & 0o7777 }];
		}));
		rewriteTarget(value);
		await assert.rejects(requestManagerOperation(service, "edit", { operation: "prepare", editToken }), /user-invoked.*herder-revise/);
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
			assert.equal(store.getPlan(run.runId, "001")?.round, 3);
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
	const begun = legacyReservation(value);
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
	fs.writeFileSync(sentinelPath, originalSnapshotBytes, { mode: 0o600 });
	fs.chmodSync(sentinelPath, 0o600);
	const vectors: Array<{ name: string; tamper: () => void; expectedError: RegExp; symlink?: boolean }> = [
		{
			name: "invalid-json",
			expectedError: /Plan edit snapshot is not valid JSON/,
			tamper: () => {
				fs.writeFileSync(snapshotPath, originalSnapshotBytes.subarray(0, originalSnapshotBytes.length - 1));
				fs.chmodSync(snapshotPath, 0o600);
			},
		},
		{
			name: "non-canonical-json",
			expectedError: /Plan edit snapshot identity is invalid/,
			tamper: () => {
				fs.writeFileSync(snapshotPath, `${JSON.stringify(originalSnapshot, null, 2)}\n`);
				fs.chmodSync(snapshotPath, 0o600);
			},
		},
		{
			name: "exposed-mode",
			expectedError: /Plan edit snapshot must have private mode 0600/,
			tamper: () => fs.chmodSync(snapshotPath, 0o644),
		},
		{
			name: "snapshot-symlink",
			expectedError: /plan edit snapshot must be a regular file/i,
			symlink: true,
			tamper: () => {
				fs.unlinkSync(snapshotPath);
				fs.symlinkSync(sentinelPath, snapshotPath);
			},
		},
		{
			name: "mismatched-plan-id",
			expectedError: /Plan edit snapshot identity is invalid/,
			tamper: canonicalTamper((snapshot) => { snapshot.planId = "002"; }),
		},
		{
			name: "changed-content-with-old-hash",
			expectedError: /Plan edit snapshot evidence .* is missing or changed/,
			tamper: canonicalTamper((snapshot) => replaceTargetContent(snapshot, Buffer.from("tampered snapshot content\n").toString("base64"))),
		},
		{
			name: "invalid-content-base64",
			expectedError: /Plan edit snapshot entry .* is invalid/,
			tamper: canonicalTamper((snapshot) => replaceTargetContent(snapshot, "not-base64!")),
		},
		{
			name: "missing-target-file",
			expectedError: /Plan edit snapshot target file is missing/,
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
			vector.expectedError,
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
		const begun = legacyReservation(value);
		fs.appendFileSync(target, "\nInterview-only nested change.\n");
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: String(object(begun.edit).editToken) });
		assert.deepEqual(fs.readFileSync(target), original);

		const alternateDirectory = path.join(value.planDirectory, "alternate");
		fs.mkdirSync(alternateDirectory);
		const alternate = path.join(alternateDirectory, "001-target.md");
		fs.copyFileSync(target, alternate);
		let retry = legacyReservation(value);
		let retryToken = String(object(retry.edit).editToken);
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("[001](nested/001-target.md)", "[001](alternate/001-target.md)"));
		await assert.rejects(() => requestManagerOperation(service!, "edit", { operation: "prepare", editToken: retryToken }), /user-invoked.*herder-revise/);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: retryToken });

		retry = legacyReservation(value);
		retryToken = String(object(retry.edit).editToken);
		fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("# Plan 001: Blocked target", "# Plan 001: Rewritten nested target"));
		await assert.rejects(prepareAndConfirm(service, retryToken), /user-invoked.*herder-revise/);
		await assert.rejects(requestManagerOperation(service, "edit", { operation: "finish", editToken: retryToken }), /user-invoked.*herder-revise/);
		await requestManagerOperation(service, "edit", { operation: "cancel", editToken: retryToken });
		const store = new RunStore(value.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(store.getPlan(run.runId, "001")?.generation, 1);
			assert.doesNotMatch(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "001")?.assignment.planText || "", /Rewritten nested target/);
		} finally { store.close(); }
	}));


for (const lifecycle of ["running", "paused"] as const) {
	test(`public rework cannot reset ${lifecycle} execution, history, patches or budgets`, { timeout: 30_000 }, async () => withFixture(lifecycle, async (service, value) => {
		await startRun(service, value);
		const store = new RunStore(value.planDirectory);
		try {
			store.updateRun({ status: lifecycle });
			const run = store.getRun()!;
			const plans = store.getPlans(run.runId);
			const specs = store.getPlanSpecs(run.runId);
			const actions = store.getActions(run.runId);
			const budget = store.getBudget(run.runId);
			const graph = captureGraph(value);
			const patch = path.join(plans[0]!.worktree, "preserved.txt");
			fs.writeFileSync(patch, "preserve unreviewed work\n");
			for (const operation of ["begin", "prepare", "confirm", "finish"]) {
				await assert.rejects(requestManagerOperation(service, "edit", { operation, planId: "001", intent: "rework", editToken: randomUUID(), confirmed: true }), /user-invoked.*herder-revise/);
			}
			assert.deepEqual(store.getRun(), run);
			assert.deepEqual(store.getPlans(run.runId), plans);
			assert.deepEqual(store.getPlanSpecs(run.runId), specs);
			assert.deepEqual(store.getActions(run.runId), actions);
			assert.deepEqual(store.getBudget(run.runId), budget);
			assert.deepEqual(captureGraph(value), graph);
			assert.equal(fs.readFileSync(patch, "utf8"), "preserve unreviewed work\n");
			assert.equal(store.getPlanEdit(run.runId), null);
		} finally { store.close(); }
	}));
}
