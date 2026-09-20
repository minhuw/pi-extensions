import { grantHostAttention } from "../../../src/core/run-revision.ts";
import { fixtureDependencies } from "../../support/plan-v2.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureService, requestManagerOperation, stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { sha256, stableJson, type AttentionResolutionInput, type ManagerOperationKind } from "../../../src/shared/protocol.ts";

type JsonRecord = Record<string, unknown>;
type Fixture = { repo: string; planDirectory: string };
type Service = Awaited<ReturnType<typeof ensureService>>;

function object(value: unknown): JsonRecord {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

function writePlan(title: string, status: string, dependency = "none"): string {
	return fixturePlan({
		title,
		dependencies: dependency,
		startingCondition: `The target is intentionally ${status.toLowerCase()}.`,
		acceptance: "The manager can recover this target while preserving unrelated execution.",
		implementation: "Use the declared fixture path only.",
		verificationCommand: "npm run test:herder -- extensions/herder/tests/unit/core/run-manager-recovery.test.ts",
	});
}

function writeUnrelatedPlan(): string {
	return writePlan("Unrelated ready plan", "TODO").replace("# Plan 001:", "# Plan 002:").replaceAll("src/value.mjs", "src/other.mjs");
}

function fixture(root: string, options: { secondBlocked?: boolean } = {}): Fixture {
	const { repo } = initFixtureRepo(root, {
		name: "Recovery Test",
		email: "recovery@example.invalid",
		files: {
			"src/value.mjs": "export const value = 1\n",
		},
	});
	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	const secondStatus = options.secondBlocked ? "BLOCKED — needs attention" : "TODO";
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Recovery plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-blocked.md) | Blocked target | P1 | S | — | BLOCKED — needs attention |
| [002](002-ready.md) | Unrelated ready plan | P1 | S | — | ${secondStatus} |

## Dependency notes

The plans are independent.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-blocked.md"), writePlan("Blocked target", "blocked"));
	fs.writeFileSync(path.join(planDirectory, "002-ready.md"), writeUnrelatedPlan());
	return { repo, planDirectory };
}

function attentionResolution(attention: JsonRecord, runId: string, action: string, rationale: string): AttentionResolutionInput {
	const recovery = object(attention.recovery);
	return {
		schemaVersion: 1,
		requestId: String(attention.requestId),
		requestSha256: String(attention.requestSha256),
		capabilityToken: String(attention.capabilityToken),
		runId,
		planId: String(attention.planId),
		generation: Number(attention.generation),
		round: Number(attention.round),
		action,
		rationale,
		git: recovery as unknown as AttentionResolutionInput["git"],
	};
}

async function managerReply(service: Service, kind: ManagerOperationKind, input: JsonRecord): Promise<JsonRecord> {
	return object(object(await requestManagerOperation(service, kind, input)).reply);
}

function cleanup(fixtureValue: Fixture): void {
	fs.rmSync(`${fixtureValue.repo}-herder-worktrees`, { recursive: true, force: true });
}

function semanticUsage(store: RunStore, attemptId: string): JsonRecord {
	const row = store.database.prepare(`
		SELECT attempt_id, plan_id, role, model, effort, outcome,
			input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, source,
			round_number, generation, harness, service_tier,
			started_at, finished_at, duration_ms, nested_usage_json
		FROM attempts WHERE attempt_id = ?
	`).get(attemptId) as JsonRecord | undefined;
	assert.ok(row);
	return row;
}

test("restart backfills terminal usage without duplicating the attempt", { timeout: 45_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-terminal-usage-recovery-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		const readme = path.join(fixtureValue.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace(
			"| [001](001-blocked.md) | Blocked target | P1 | S | — | BLOCKED — needs attention |",
			"| [001](001-blocked.md) | Blocked target | P1 | S | — | TODO |",
		));
		service = await ensureService(fixtureValue.planDirectory);
		const started = await managerReply(service, "start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		});
		const action = object((started.actions as unknown[])[0]);
		await managerReply(service, "event", {
			eventId: "terminal-usage-dispatch",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: action.actionId, accepted: true, hostHandle: "terminal-usage-worker" }],
		});
		await managerReply(service, "event", {
			eventId: "terminal-usage-terminal",
			kind: "terminals",
			terminals: [{
				actionId: action.actionId,
				hostHandle: "terminal-usage-worker",
				response: "STATUS: FAILED\nCOMMITS: none\nCHECKS: none\nFILES CHANGED: none\nDISCOVERED_PATHS: none\nNOTES: bounded failure\nUSAGE: input_tokens=7; cached_input_tokens=2; output_tokens=3; reasoning_tokens=1; source=test-host",
			}],
		});

		await stopService(fixtureValue.planDirectory);
		service = undefined;
		let expected: JsonRecord;
		let attemptId: string;
		const stoppedStore = new RunStore(fixtureValue.planDirectory);
		try {
			const run = stoppedStore.getRun();
			assert.ok(run);
			const terminal = stoppedStore.getAction(String(action.actionId));
			assert.equal(terminal?.state, "terminal");
			assert.ok(terminal);
			attemptId = terminal.attemptId;
			expected = semanticUsage(stoppedStore, attemptId);
			assert.equal(Number((stoppedStore.database.prepare("SELECT COUNT(*) AS count FROM attempts").get() as JsonRecord).count), 1);
			stoppedStore.database.prepare("DELETE FROM attempts WHERE attempt_id = ?").run(attemptId);
			assert.equal(stoppedStore.database.prepare("SELECT attempt_id FROM attempts WHERE attempt_id = ?").get(attemptId), undefined);
		} finally {
			stoppedStore.close();
		}

		service = await ensureService(fixtureValue.planDirectory);
		const resumed = await managerReply(service, "start", {
			mode: "resume",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		});
		assert.equal(resumed.status, "running");
		const recoveredStore = new RunStore(fixtureValue.planDirectory);
		try {
			assert.deepEqual(semanticUsage(recoveredStore, attemptId), expected);
			assert.equal(Number((recoveredStore.database.prepare("SELECT COUNT(*) AS count FROM attempts").get() as JsonRecord).count), 1);
		} finally {
			recoveredStore.close();
		}

		const reconciled = await managerReply(service, "event", {
			eventId: "terminal-usage-reconcile-again",
			kind: "terminals",
			terminals: [],
		});
		assert.equal(reconciled.status, "running");
		const finalStore = new RunStore(fixtureValue.planDirectory);
		try {
			assert.deepEqual(semanticUsage(finalStore, attemptId), expected);
			assert.equal(Number((finalStore.database.prepare("SELECT COUNT(*) AS count FROM attempts").get() as JsonRecord).count), 1);
		} finally {
			finalStore.close();
		}
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("plan recovery freezes the entire execution and rejects ungranted decisions and retired actions across service restart", { timeout: 45_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-whole-recovery-"));
	const value = fixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(value.planDirectory);
		const started = await managerReply(service, "start", { mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDirectory, profile: "eclipse", maxParallel: 2 });
		const attention = object(started.attention);
		assert.equal(attention.planId, "001");
		const original = (started.actions as unknown[]).map(object);
		assert.deepEqual(original.map(action => action.planId), ["002"]);
		for (const action of ["unchanged_retry", "revise", "reject", "retry", "answer_and_resume", "accept"]) {
			await assert.rejects(managerReply(service, "event", { eventId: `retired-${action}`, kind: "attention", attention: { ...attentionResolution(attention, String(started.runId), action, "Explicit choice"), answer: "Explicit answer", confirmed: true } }), ["retry", "accept", "reject"].includes(action) ? /exact private host grant; confirmed flags are not authorization/ : /Stopped attention permits/);
		}
		const resolution = attentionResolution(attention, String(started.runId), "revise_run", "Propose a replacement for the whole graph.");
		await assert.rejects(managerReply(service, "event", { eventId: "unapproved-scope", kind: "attention", attention: { ...resolution, confirmed: true } }), /private host grant/);
		for (const action of ["answer", "defer", "stop", "cancel"]) {
			const paused = await managerReply(service, "event", { eventId: `quiet-${action}`, kind: "attention", attention: { ...attentionResolution(attention, String(started.runId), action, "Remain stopped"), answer: "Recorded only" } });
			assert.equal(paused.status, "paused"); assert.deepEqual(paused.actions, []);
		}
		const granting = new RunStore(value.planDirectory);
		try { grantHostAttention(granting.getRun()!, resolution); } finally { granting.close(); }
		const opened = await managerReply(service, "event", { eventId: "open-whole-run", kind: "attention", attention: resolution });
		assert.deepEqual(opened.actions, []);
		assert.equal(object(opened.scheduler).reason, "revision-barrier");
		assert.ok(object(opened.runRevision).editToken);
		const store = new RunStore(value.planDirectory);
		try {
			assert.equal(store.getRun()?.currentGeneration, 1);
			assert.equal(store.getAttention(String(attention.requestId))?.state, "pending");
			assert.equal(store.getPlan(String(started.runId), "001"), null, "authored BLOCKED plan needs no runtime to revise the graph");
			assert.ok(store.getAction(String(original[0]!.actionId)), "old execution remains intact before approval");
		} finally { store.close(); }
		await stopService(value.planDirectory);
		service = await ensureService(value.planDirectory);
		const replay = await managerReply(service, "event", { eventId: "open-whole-run", kind: "attention", attention: resolution });
		assert.deepEqual(replay.runRevision, opened.runRevision);
		assert.deepEqual(replay.actions, []);
		await assert.rejects(managerReply(service, "start", { mode: "resume", repositoryRoot: value.repo, planDirectory: value.planDirectory, profile: "eclipse", maxParallel: 2 }), /unchanged resume/);
		await assert.rejects(managerReply(service, "event", { eventId: "stale-dispatch", kind: "dispatch_results", dispatchResults: [{ actionId: original[0]!.actionId, accepted: true, hostHandle: "pi-worker:stale" }] }), /barrier forbids new worker dispatch/);
	} finally {
		if (service) await stopService(value.planDirectory).catch(() => {});
		cleanup(value);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("recovery resolution rejects a mismatched capability or Git identity before mutation", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-binding-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(fixtureValue.planDirectory);
		const started = await managerReply(service, "start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		});
		const attention = object(started.attention);
		const resolution = attentionResolution(attention, String(started.runId), "revise_run", "Revise the whole execution.");
		await assert.rejects(
			() => managerReply(service!, "event", { eventId: "bad-capability", kind: "attention", attention: { ...resolution, capabilityToken: "0".repeat(64) } }),
			/capability token/,
		);
		const store = new RunStore(fixtureValue.planDirectory);
		try {
			assert.equal(store.getAttention(String(attention.requestId))?.state, "pending");
			assert.equal(store.getRun()?.currentGeneration, 1);
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
