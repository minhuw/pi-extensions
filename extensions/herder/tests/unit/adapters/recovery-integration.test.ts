import { confirmRunRevision, prepareRunRevision, readRunRevision, writeRunRevision } from "../../../src/core/run-revision.ts";
import { applyHerderReset } from "../../../src/application/tools.ts";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, SessionStats } from "@earendil-works/pi-coding-agent";
import { PiWorkerEngine, type PiWorkerRequest, type PiWorkerSessionFactory } from "../../../adapters/worker-engine.ts";
import { HerderNestedAgentScope } from "../../../adapters/nested-agent-executor.ts";
import { HERDER_STATE_ENTRY } from "../../../adapters/state.ts";
import {
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
	assertAdapterRecoveryEvidence,
	readAdapterRuntimeIdentity,
	markAdapterOwnershipCleanupRequired,
	releaseAdapterOwnership,
	waitForAdapterOwnershipRetirement,
	type AdapterOwnership,
} from "../../../adapters/ownership.ts";
import { registerHerderPiWithWorkerFactory } from "../../../adapters/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";
import { ensureService, requestManagerOperation,
	requestService, stopService, waitManagerOperation } from "../../../src/client/index.ts";
import { GitDriver, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import {
	agentRoot,
	BaseSession,
	CapturedExtensionAPI,
	Deferred,
	availableModels,
	object,
	withDeadline,
} from "./helpers/harness.ts";

interface Fixture {
	root: string;
	repo: string;
	planDirectory: string;
}

interface Warning {
	message: string;
	level: string;
}

function writeFixture(root: string): Fixture {
	const { repo, originalHead } = initFixtureRepo(root, {
		name: "Herder Adapter Recovery Test",
		email: "herder-adapter-recovery@example.invalid",
		files: {
			"package.json": `${JSON.stringify({
				name: "herder-adapter-recovery-fixture",
				private: true,
				type: "module",
				scripts: { test: "node --test" },
			}, null, 2)}\n`,
			"src/value.mjs": "export const value = 1\n",
		},
	});

	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-recover-worker.md"), fixturePlan({
		title: "Recover a lost worker",
		head: originalHead.slice(0, 8),
		plannedAt: "2026-08-10",
		parentObjective: "Prove a replacement Pi session recovers one lost worker without duplicate scheduling.",
		acceptance: "One missing built-in worker produces one same-round retry.",
		implementation: "Leave the fixture source unchanged while the manager exercises worker recovery.",
		verificationCommand: "npm run test:herder -- extensions/herder/tests/unit/adapters/recovery-integration.test.ts",
	}));
	return { root, repo, planDirectory };
}

function writeBlockedAttentionFixture(root: string): Fixture {
	const fixture = writeFixture(root);
	const index = fs.readFileSync(path.join(fixture.planDirectory, "README.md"), "utf8");
	fs.writeFileSync(path.join(fixture.planDirectory, "README.md"), index.replace("| TODO |", "| BLOCKED — needs attention |"));
	return fixture;
}

class PendingSession extends BaseSession {
	readonly started: Promise<void>;
	aborted = false;
	prompted = false;
	private releasePrompt!: () => void;
	private resolveStarted!: () => void;
	private readonly promptReleased: Promise<void>;

	constructor(sessionId: string) {
		super(sessionId);
		this.promptReleased = new Promise<void>((resolve) => { this.releasePrompt = resolve; });
		this.started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
	}

	async prompt(_text: string): Promise<void> {
		this.prompted = true;
		this.resolveStarted();
		await this.promptReleased;
	}

	finish(): void { this.releasePrompt(); }

	async abort(): Promise<void> {
		this.aborted = true;
		this.releasePrompt();
	}

	getSessionStats(): SessionStats {
		return {
			sessionFile: undefined,
			sessionId: this.sessionId,
			userMessages: 1,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: this.messages.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: 0, contextWindow: 100_000, percent: 0 },
		};
	}
}

class PendingWorkerFactory implements PiWorkerSessionFactory {
	readonly requests: PiWorkerRequest[] = [];
	readonly sessions: PendingSession[] = [];

	async availableModels() {
		return [...availableModels];
	}

	async create(request: PiWorkerRequest) {
		return this.createSession(request);
	}

	protected createSession(request: PiWorkerRequest) {
		this.requests.push(request);
		const session = new PendingSession(`replacement-${this.sessions.length + 1}`);
		this.sessions.push(session);
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot,
			createSession: async () => { throw new Error("nested sessions are not used by this recovery test"); },
		});
		return { session, nested };
	}
}

class GatedPrepareWorkerFactory extends PendingWorkerFactory {
	readonly createEntered = new Deferred<void>();
	readonly allowCreate = new Deferred<void>();

	override async create(request: PiWorkerRequest) {
		this.createEntered.resolve();
		await this.allowCreate.promise;
		return this.createSession(request);
	}
}

function restoredContext(fixture: Fixture, runId: string, warnings: Warning[]): ExtensionContext {
	const state = {
		version: 1,
		mode: "fire" as const,
		status: "running" as const,
		runId,
		repoRoot: fixture.repo,
		planDir: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardEnabled: true,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
	const ui = {
		notify(message: string, level: string) { warnings.push({ message, level }); },
		setStatus() {},
		setWidget() {},
	};
	return {
		ui,
		mode: "rpc",
		hasUI: false,
		cwd: fixture.repo,
		sessionManager: { getEntries: () => [{ type: "custom", customType: HERDER_STATE_ENTRY, data: state }] },
		modelRegistry: {} as ModelRegistry,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function freshContext(fixture: Fixture, notifications: Warning[]): ExtensionContext {
	const ui = {
		notify(message: string, level: string) { notifications.push({ message, level }); },
		setStatus() {},
		setWidget() {},
	};
	return {
		ui,
		mode: "rpc",
		hasUI: false,
		cwd: fixture.repo,
		sessionManager: { getEntries: () => [] },
		modelRegistry: { getAvailable: () => [...availableModels] } as unknown as ModelRegistry,
		model: availableModels[0],
		thinkingLevel: "xhigh",
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function evidence(fixture: Fixture): {
	run: ReturnType<RunStore["getRun"]>;
	plan: ReturnType<RunStore["getPlan"]>;
	actions: ReturnType<RunStore["getActions"]>;
	lease: string | null;
} {
	const store = new RunStore(fixture.planDirectory);
	try {
		const run = store.getRun();
		if (!run) throw new Error("Recovery fixture has no manager run");
		const plan = store.getPlan(run.runId, "001");
		if (!plan) throw new Error("Recovery fixture has no plan runtime");
		const actions = store.getActions(run.runId);
		const driver = new GitDriver({
			repoRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			planName: "herder-plans",
			helperRoot: fixture.root,
		});
		return { run, plan, actions, lease: driver.leaseReason(plan.worktree) };
	} finally {
		store.close();
	}
}

async function startFixture(fixture: Fixture, hostHandle: string) {
	const service = await ensureService(fixture.planDirectory);
	const startedBody = await requestManagerOperation(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	});
	const started = object(startedBody.reply);
	const actions = started.actions as unknown[];
	assert.equal(actions.length, 1);
	const implementer = object(actions[0]);
	const actionId = String(implementer.actionId);
	await requestManagerOperation(service, "event", {
		eventId: `dispatch-${hostHandle}`,
		kind: "dispatch_results",
		dispatchResults: [{ actionId, accepted: true, hostHandle }],
	});
	const before = evidence(fixture);
	assert.equal(before.actions.length, 1);
	assert.equal(before.actions[0]!.state, "dispatched");
	return { service, actionId, before };
}

async function pauseFixture(fixture: Fixture) {
	const service = await ensureService(fixture.planDirectory);
	const startedBody = await requestManagerOperation(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	});
	const started = object(startedBody.reply);
	const action = object((started.actions as unknown[])[0]);
	await requestManagerOperation(service, "event", {
		eventId: "pause-dispatch",
		kind: "dispatch_results",
		dispatchResults: [{ actionId: String(action.actionId), accepted: false, error: "deterministic host rejection" }],
	});
	const before = evidence(fixture);
	assert.equal(before.run!.status, "paused");
	return { service, before };
}

test("main-session attention stays quiet on status and refuses obsolete selective rejection", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attention-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeBlockedAttentionFixture(root);
		const indexPath = path.join(fixture.planDirectory, "README.md");
		const firstRow = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | BLOCKED — needs attention |";
		fs.writeFileSync(indexPath, fs.readFileSync(indexPath, "utf8").replace(firstRow, `${firstRow}\n${firstRow.replaceAll("001", "002")}`));
		fs.writeFileSync(path.join(fixture.planDirectory, "002-recover-worker.md"),
			fs.readFileSync(path.join(fixture.planDirectory, "001-recover-worker.md"), "utf8").replaceAll("001", "002").replaceAll("src/value.mjs", "src/other.mjs"));
		const service = await ensureService(fixture.planDirectory);
		const started = object((await requestManagerOperation(service, "start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		})).reply);
		const attention = object(started.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.planId, "001");

		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = capturedContext = restoredContext(fixture, String(started.runId), warnings);
		await withDeadline(api.invoke("session_start", ctx), "attention session_start");
		await withDeadline((async () => {
			while (api.customMessages.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		})(), "attention delivery");
		assert.equal(api.customMessages.length, 1);
		assert.equal(api.customMessages[0]!.customType, "herder-attention-v1");
		assert.match(api.customMessages[0]!.content, /^HERDER_STOPPED_ATTENTION_V1/m);
		assert.match(api.customMessages[0]!.content, /REQUEST_ID:/);
		assert.doesNotMatch(api.customMessages[0]!.content, /REQUEST_SHA256|CAPABILITY_TOKEN|RECOVERY_GIT_IDENTITY|schemaVersion|exact request binding/);
		const messageDetails = object(api.customMessages[0]!.details);
		assert.equal(messageDetails.planId, "001");
		assert.equal(messageDetails.cause, "initial_decision_blocked");
		assert.equal(messageDetails.role, "plan-implementer");
		assert.equal(messageDetails.round, 1);
		assert.equal(messageDetails.nextAction, "Record an answer, defer, or stop. Scope and effort changes require separate user authorization.");
		assert.equal(Object.hasOwn(messageDetails, "capabilityToken"), false);
		assert.deepEqual(api.customMessages[0]!.options, { deliverAs: "followUp", triggerTurn: false });

		await withDeadline(api.invoke("agent_settled", ctx), "attention agent_settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(api.customMessages.length, 1, "passive settled events duplicated the attention request");
		await api.command("herder-status").handler("herder-plans", ctx);
		assert.equal(api.customMessages.length, 1, "status does not prompt another model turn");
		assert.equal(warnings.some((warning) => warning.level === "error"), false);

		await assert.rejects(api.tool("herder_plan").execute(
			"attention",
			{
				operation: "attention",
				planDirectory: "herder-plans",
				requestId: attention.requestId,
				planId: "caller-controlled-plan",
				action: "reject",
				rationale: "Reject the blocked fixture without changing its plan content.",
			},
			undefined,
			undefined,
			ctx,
		), /Stopped attention permits answer, defer, stop, or host-authorized safe operator retry/);
		const unchanged = object((await requestService(service, "/v1/status")).reply);
		assert.equal(object(unchanged.attention).requestId, attention.requestId);
		assert.equal(api.customMessages.length, 1, "no selective action consumes the current request");
		assert.equal(factory.requests.length, 0);

		await withDeadline(api.invoke("session_shutdown", ctx), "attention session_shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "attention cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("exhausted plan attention refuses acceptance even with a forged confirmation and preserves failed evidence", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-acceptance-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let ctx: ExtensionContext | undefined;
	try {
		fixture = writeFixture(root);
		const service = await ensureService(fixture.planDirectory);
		let reply = object((await requestManagerOperation(service, "start", {
			mode: "fire", repositoryRoot: fixture.repo, planDirectory: fixture.planDirectory,
			profile: "eclipse", maxParallel: 1,
		})).reply);
		const complete = async (action: Record<string, unknown>, response: string) => {
			const actionId = String(action.actionId);
			const hostHandle = `pi-worker:${actionId}`;
			await requestManagerOperation(service, "event", {
				eventId: `dispatch-${actionId}`, kind: "dispatch_results", dispatchResults: [{ actionId, accepted: true, hostHandle }],
			});
			return object((await requestManagerOperation(service, "event", {
				eventId: `terminal-${actionId}`, kind: "terminals", terminals: [{ actionId, hostHandle, response }],
			})).reply);
		};
		for (let round = 1; round <= 3; round += 1) {
			const implementer = object((reply.actions as unknown[])[0]);
			assert.equal(implementer.round, round);
			assert.equal(implementer.workerMode, round === 1 ? "INITIAL" : round === 2 ? "GUIDED_REPAIR" : "RESCUE");
			const worktree = String(implementer.worktree);
			fs.writeFileSync(path.join(worktree, "src/value.mjs"), `export const value = ${round + 1}\n`);
			runCommand("git", ["-C", worktree, "add", "--", "src/value.mjs"]);
			runCommand("git", ["-C", worktree, "commit", "-m", `fix(value): advance fixture to ${round + 1}`]);
			reply = await complete(implementer, "STATUS: COMPLETE\nCHECKS: fixture source updated\nFILES CHANGED: src/value.mjs\nNOTES: regression check remains unresolved");
			const reviewer = object((reply.actions as unknown[])[0]);
			reply = await complete(reviewer, "VERDICT: REVISE\nSCOPE: PASS\nFINDINGS: [F1][P1][BLOCKING][PLAN_REQUIREMENT] src/value.mjs:1 — required regression check fails; obligation=A1; evidence=src/value.mjs:1 regression check fails; violation=approved acceptance remains unmet\nFIX_GUIDANCE: [F1] make the regression check pass\nCHECKS: required regression check — FAILED\nRATIONALE: Original acceptance remains unmet");
			if (round === 2) {
				const judge = object((reply.actions as unknown[])[0]);
				assert.equal(judge.role, "plan-judge");
				reply = await complete(judge, "DECISION: REPAIR\nFINDINGS: [F1][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] required check fails; obligation=A1; evidence=src/value.mjs:1 regression check fails; violation=approved acceptance remains unmet\nAUTHORIZED_BLOCKERS: F1\nREPAIR_CONTRACTS: [F1] expected=required regression check passes; constraints=original scope\nPASS_DOCUMENT: Resolve F1, run the required regression check, and preserve original scope. No rejected findings or unresolved decisions.\nCHECKS: required regression check — FAILED\nRATIONALE: One bounded rescue remains");
			}
		}
		const attention = object(reply.attention);
		assert.equal(attention.round, 3);
		assert.equal(attention.cause, "round_limit");
		assert.match(String(attention.detail), /EXHAUSTION_DECISION_DOSSIER/);
		const factory = new PendingWorkerFactory();
		api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const baseContext = restoredContext(fixture, String(reply.runId), []);
		let consent = false;
		let shutdownDuringConfirmation = false;
		const confirmations: string[] = [];
		ctx = { ...baseContext, hasUI: true, ui: { ...baseContext.ui,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: async (_title: string, text: string) => {
				confirmations.push(text);
				if (shutdownDuringConfirmation) await api!.invoke("session_shutdown", ctx!);
				return consent;
			},
		} } as ExtensionContext;
		await api.invoke("session_start", ctx);
		const delivered = await withDeadline(api.waitForAttentionMessage(), "acceptance dossier delivery");
		assert.equal(object(delivered.details).nextAction, "Record an answer, defer, or stop. Scope and effort changes require separate user authorization.");
		const params = {
			operation: "attention", planDirectory: fixture.planDirectory, requestId: attention.requestId,
			action: "accept", answer: "Accept F1 and waive the unmet regression-check requirement for this exact plan tree.",
			rationale: "The user accepts the current implementation with this specific gap.",
			confirmed: true, // Untrusted model input must not bypass a declined host confirmation.
		};
		await assert.rejects(api.tool("herder_plan").execute("decline", params, undefined, undefined, ctx), /Stopped attention permits answer, defer, stop, or host-authorized safe operator retry/);
		assert.equal(object(object((await requestService(service, "/v1/status")).reply).attention).requestId, attention.requestId);
		assert.equal(confirmations.length, 0, "obsolete acceptance never opens a host confirmation");
		const store = new RunStore(fixture.planDirectory);
		try {
			assert.equal(store.getApproval(String(reply.runId), "001", 1), null);
			assert.equal(store.getAttention(String(attention.requestId))?.state === "resolved", false);
			assert.match(store.getPlan(String(reply.runId), "001")!.findings.join("\n"), /required regression check fails/);
		} finally { store.close(); }
		assert.equal(factory.requests.length, 0);

	} finally {
		if (api && ctx) await api.invoke("session_shutdown", ctx).catch(() => {});
		if (fixture) await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("foreign status observers cannot receive or resolve an owned attention request", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attention-owned-"));
	let fixture: Fixture | undefined;
	let held: AdapterOwnership | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeBlockedAttentionFixture(root);
		const service = await ensureService(fixture.planDirectory);
		const started = object((await requestManagerOperation(service, "start", {
			mode: "fire",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		})).reply);
		const attention = object(started.attention);
		held = acquireAdapterOwnership(fixture.planDirectory, String(started.runId), "foreign-attention-owner");

		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, new PendingWorkerFactory());
		const notifications: Warning[] = [];
		const ctx = capturedContext = freshContext(fixture, notifications);
		await withDeadline(api.invoke("session_start", ctx), "foreign attention session_start");
		await withDeadline(api.command("herder-status").handler("herder-plans", ctx), "foreign attention status");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(api.customMessages.length, 0);

		const before = object((await requestService(service, "/v1/status")).reply);
		await assert.rejects(api.tool("herder_plan").execute(
			"attention",
			{
				operation: "attention",
				planDirectory: "herder-plans",
				requestId: attention.requestId,
				action: "defer",
			},
			undefined,
			undefined,
			ctx,
		), /No unresolved Herder attention request|does not own/);
		const after = object((await requestService(service, "/v1/status")).reply);
		assert.equal(object(after.attention).requestId, object(before.attention).requestId);
		assert.equal(object(after.attention).state, object(before.attention).state);
		assert.equal(notifications.some((notification) => notification.level === "error"), false);

		await withDeadline(api.invoke("session_shutdown", ctx), "foreign attention shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "foreign attention cleanup", 5_000).catch(() => {});
		}
		if (held) releaseAdapterOwnership(held);
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replacement Pi session interrupts and retries one lost built-in worker", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-recovery-lost-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const started = await startFixture(fixture, "pi-worker:lost");
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = capturedContext = restoredContext(fixture, String(started.before.run!.runId), warnings);

		await withDeadline(api.invoke("session_start", ctx), "session_start recovery");
		assert.equal(warnings.length, 0);
		assert.equal(factory.requests.length, 1);
		assert.equal(factory.sessions.length, 1);

		const retrySession = factory.sessions[0]!;
		await withDeadline(retrySession.started, "replacement worker start");
		const recovered = evidence(fixture);
		const oldAction = recovered.actions.find((action) => action.actionId === started.actionId);
		assert.ok(oldAction);
		assert.equal(oldAction.state, "terminal");
		const oldResult = object(oldAction.result);
		assert.equal(object(oldResult.terminal).interrupted, true);
		assert.equal(recovered.actions.filter((action) => action.state === "dispatched").length, 1);
		const retry = recovered.actions.find((action) => action.state === "dispatched");
		assert.ok(retry);
		assert.notEqual(retry.actionId, oldAction.actionId);
		assert.equal(retry.hostHandle, `pi-worker:${retrySession.sessionId}`);
		assert.equal(factory.requests[0]!.action.actionId, retry.actionId);
		assert.equal(retry.planId, oldAction.planId);
		assert.equal(retry.generation, oldAction.generation);
		assert.equal(retry.round, oldAction.round);
		assert.equal(recovered.plan!.generation, started.before.plan!.generation);
		assert.equal(recovered.plan!.round, started.before.plan!.round);
		assert.notEqual(retry.leaseReason, oldAction.leaseReason);
		assert.equal(recovered.lease, retry.leaseReason);

		await withDeadline(api.invoke("session_shutdown", ctx), "session_shutdown cleanup");
		shutdown = true;
		assert.equal(retrySession.aborted, true);
		assert.equal(retrySession.disposed, true);
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "session_shutdown recovery cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fresh Pi session attaches, interrupts a stale worker, and dispatches its replacement", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attach-lost-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const started = await startFixture(fixture, "pi-worker:attach-lost");
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const ctx = capturedContext = freshContext(fixture, notifications);

		await withDeadline(api.invoke("session_start", ctx), "fresh attach session_start");
		assert.equal(api.appendedEntries.some((entry) => entry.customType === HERDER_STATE_ENTRY), false);
		await withDeadline(api.command("herder-attach").handler("herder-plans", ctx), "/herder-attach recovery");
		assert.equal(notifications.some((notification) => notification.level === "error"), false);
		assert.equal(factory.requests.length, 1);
		const replacement = factory.sessions[0]!;
		await withDeadline(replacement.started, "attached replacement worker start");

		const recovered = evidence(fixture);
		const stale = recovered.actions.find((action) => action.actionId === started.actionId);
		assert.ok(stale);
		assert.equal(stale.state, "terminal");
		assert.equal(object(object(stale.result).terminal).interrupted, true);
		const dispatched = recovered.actions.filter((action) => action.state === "dispatched");
		assert.equal(dispatched.length, 1);
		assert.equal(dispatched[0]!.hostHandle, `pi-worker:${replacement.sessionId}`);
		assert.notEqual(dispatched[0]!.actionId, stale.actionId);

		const states = api.appendedEntries
			.filter((entry) => entry.customType === HERDER_STATE_ENTRY)
			.map((entry) => object(entry.data));
		assert.ok(states.some((state) => state.mode === "attach"
			&& state.profile === "eclipse"
			&& state.maxParallel === 1
			&& state.repoRoot === fs.realpathSync(fixture!.repo)
			&& state.runId === started.before.run!.runId));

		await withDeadline(api.invoke("session_shutdown", ctx), "attached session_shutdown cleanup");
		shutdown = true;
		assert.equal(replacement.aborted, true);
		assert.equal(replacement.disposed, true);
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "attach recovery cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("attach preserves a paused run without scheduling or changing lease evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attach-paused-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const paused = await pauseFixture(fixture);
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const ctx = capturedContext = freshContext(fixture, notifications);

		await withDeadline(api.invoke("session_start", ctx), "paused attach session_start");
		await withDeadline(api.command("herder-attach").handler("herder-plans", ctx), "paused /herder-attach");
		assert.equal(factory.requests.length, 0);
		assert.ok(notifications.some((notification) => notification.level === "info" && /without changing its paused lifecycle state/.test(notification.message)));
		const after = evidence(fixture);
		assert.equal(after.run!.status, "paused");
		assert.deepEqual(after.actions, paused.before.actions);
		assert.equal(after.lease, paused.before.lease);

		await withDeadline(api.invoke("session_shutdown", ctx), "paused attach shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "paused attach cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Fire publishes startup ownership before another session can attach", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-fire-owned-"));
	let fixture: Fixture | undefined;
	let fireApi: CapturedExtensionAPI | undefined;
	let fireContext: ExtensionContext | undefined;
	let observerApi: CapturedExtensionAPI | undefined;
	let observerContext: ExtensionContext | undefined;
	let fireShutdown = false;
	let observerShutdown = false;
	try {
		fixture = writeFixture(root);
		const fireFactory = new GatedPrepareWorkerFactory();
		fireApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(fireApi as unknown as ExtensionAPI, fireFactory);
		fireContext = freshContext(fixture, []);
		await withDeadline(fireApi.invoke("session_start", fireContext), "Fire ownership session_start");
		const firing = fireApi.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", fireContext);
		await withDeadline(fireFactory.createEntered.promise, "Fire worker preparation");
		const before = evidence(fixture);
		assert.equal(before.run!.status, "running");
		assert.equal(fs.existsSync(adapterOwnershipLockPath(fixture.planDirectory)), true);

		const observerFactory = new PendingWorkerFactory();
		observerApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(observerApi as unknown as ExtensionAPI, observerFactory);
		const notifications: Warning[] = [];
		observerContext = freshContext(fixture, notifications);
		await withDeadline(observerApi.invoke("session_start", observerContext), "Fire observer session_start");
		await withDeadline(observerApi.command("herder-attach").handler("herder-plans", observerContext), "Fire observer attach");
		assert.equal(observerFactory.requests.length, 0);
		assert.ok(notifications.some((notification) => notification.level === "error" && /already owned by live Pi pid/.test(notification.message)));
		const after = evidence(fixture);
		assert.deepEqual(after.actions, before.actions);
		assert.equal(after.lease, before.lease);

		fireFactory.allowCreate.resolve();
		await withDeadline(firing, "Fire ownership completion");
		await withDeadline(fireFactory.sessions[0]!.started, "Fire owned worker start");
		await withDeadline(observerApi.invoke("session_shutdown", observerContext), "Fire observer shutdown");
		observerShutdown = true;
		await withDeadline(fireApi.invoke("session_shutdown", fireContext), "Fire ownership shutdown");
		fireShutdown = true;
	} finally {
		if (observerApi && observerContext && !observerShutdown) {
			await withDeadline(observerApi.invoke("session_shutdown", observerContext), "Fire observer cleanup", 5_000).catch(() => {});
		}
		if (fireApi && fireContext && !fireShutdown) {
			await withDeadline(fireApi.invoke("session_shutdown", fireContext), "Fire ownership cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("live Pi ownership makes attach fail without changing manager evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attach-owned-"));
	let fixture: Fixture | undefined;
	let held: AdapterOwnership | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const started = await startFixture(fixture, "pi-worker:still-owned");
		held = acquireAdapterOwnership(fixture.planDirectory, String(started.before.run!.runId), "foreign-live-session");
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const ctx = capturedContext = freshContext(fixture, notifications);

		await withDeadline(api.invoke("session_start", ctx), "owned attach session_start");
		await withDeadline(api.command("herder-attach").handler("herder-plans", ctx), "owned /herder-attach");
		assert.equal(factory.requests.length, 0);
		assert.ok(notifications.some((notification) => notification.level === "error" && /already owned by live Pi pid/.test(notification.message)));
		const after = evidence(fixture);
		assert.deepEqual(after.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			leaseReason: action.leaseReason,
		})), started.before.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			leaseReason: action.leaseReason,
		})));
		assert.equal(after.lease, started.before.lease);

		await withDeadline(api.invoke("session_shutdown", ctx), "owned attach shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "owned attach cleanup", 5_000).catch(() => {});
		}
		if (held) releaseAdapterOwnership(held);
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("live Pi ownership blocks resume before a paused run changes manager evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-resume-owned-"));
	let fixture: Fixture | undefined;
	let held: AdapterOwnership | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const paused = await pauseFixture(fixture);
		held = acquireAdapterOwnership(fixture.planDirectory, String(paused.before.run!.runId), "foreign-resume-session");
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const ctx = capturedContext = freshContext(fixture, notifications);

		await withDeadline(api.invoke("session_start", ctx), "owned resume session_start");
		await withDeadline(api.command("herder-resume").handler("herder-plans --profile eclipse --max-parallel 1", ctx), "owned /herder-resume");
		assert.equal(factory.requests.length, 0);
		assert.ok(notifications.some((notification) => notification.level === "error" && /already owned by live Pi pid/.test(notification.message)));
		const after = evidence(fixture);
		assert.equal(after.run!.status, "paused");
		assert.deepEqual(after.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			leaseReason: action.leaseReason,
		})), paused.before.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			leaseReason: action.leaseReason,
		})));
		assert.equal(after.lease, paused.before.lease);

		await withDeadline(api.invoke("session_shutdown", ctx), "owned resume shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "owned resume cleanup", 5_000).catch(() => {});
		}
		if (held) releaseAdapterOwnership(held);
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("shutdown during attach dispatch drains ownership and never accepts or starts the stale worker", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attach-shutdown-"));
	let fixture: Fixture | undefined;
	try {
		fixture = writeFixture(root);
		await startFixture(fixture, "pi-worker:shutdown-lost");
		const factory = new GatedPrepareWorkerFactory();
		const api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const ctx = freshContext(fixture, notifications);

		await withDeadline(api.invoke("session_start", ctx), "shutdown attach session_start");
		const attaching = api.command("herder-attach").handler("herder-plans", ctx);
		await withDeadline(factory.createEntered.promise, "attach worker preparation");
		const lockPath = adapterOwnershipLockPath(fixture.planDirectory);
		assert.equal(fs.existsSync(lockPath), true);

		let shutdownSettled = false;
		const shuttingDown = api.invoke("session_shutdown", ctx).then(() => { shutdownSettled = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(shutdownSettled, false, "shutdown must await admitted preparation");
		assert.equal(fs.existsSync(lockPath), true, "ownership released before the admitted manager task drained");
		factory.allowCreate.resolve();
		await withDeadline(Promise.all([attaching, shuttingDown]), "stale attach completion");
		await withDeadline(waitForAdapterOwnershipRetirement(fixture.planDirectory), "stale ownership retirement");
		assert.equal(fs.existsSync(lockPath), false);
		assert.equal(factory.sessions.length, 1);
		assert.equal(factory.sessions[0]!.prompted, false);
		assert.equal(factory.sessions[0]!.disposed, true);
		const after = evidence(fixture);
		const proposed = after.actions.filter((action) => action.state === "proposed");
		assert.equal(proposed.length, 1);
		assert.equal(proposed[0]!.hostHandle, null);
		assert.equal(after.actions.some((action) => action.state === "dispatched"), false);
	} finally {
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a fresh adapter instance waits for same-process ownership retirement before attaching", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attach-handoff-"));
	let fixture: Fixture | undefined;
	let replacementApi: CapturedExtensionAPI | undefined;
	let replacementContext: ExtensionContext | undefined;
	let replacementShutdown = false;
	try {
		fixture = writeFixture(root);
		await startFixture(fixture, "pi-worker:handoff-lost");

		const retiringFactory = new GatedPrepareWorkerFactory();
		const retiringApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(retiringApi as unknown as ExtensionAPI, retiringFactory);
		const retiringContext = freshContext(fixture, []);
		await withDeadline(retiringApi.invoke("session_start", retiringContext), "retiring attach session_start");
		const retiringAttach = retiringApi.command("herder-attach").handler("herder-plans", retiringContext);
		await withDeadline(retiringFactory.createEntered.promise, "retiring worker preparation");
		const lockPath = adapterOwnershipLockPath(fixture.planDirectory);
		assert.equal(fs.existsSync(lockPath), true);
		const retiringShutdown = retiringApi.invoke("session_shutdown", retiringContext);
		assert.equal(fs.existsSync(lockPath), true);

		const replacementFactory = new PendingWorkerFactory();
		const nextApi = replacementApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(nextApi as unknown as ExtensionAPI, replacementFactory);
		const notifications: Warning[] = [];
		const nextContext = replacementContext = freshContext(fixture, notifications);
		await withDeadline(nextApi.invoke("session_start", nextContext), "replacement adapter session_start");
		const replacementAttach = nextApi.command("herder-attach").handler("herder-plans", nextContext);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(replacementFactory.requests.length, 0);
		assert.equal(notifications.some((notification) => /already owned by live Pi pid/.test(notification.message)), false);

		retiringFactory.allowCreate.resolve();
		await withDeadline(Promise.all([retiringAttach, retiringShutdown]), "retiring attach drain");
		await withDeadline(replacementAttach, "replacement attach handoff");
		assert.equal(notifications.some((notification) => notification.level === "error"), false);
		assert.equal(replacementFactory.requests.length, 1);
		await withDeadline(replacementFactory.sessions[0]!.started, "replacement handoff worker start");
		assert.equal(fs.existsSync(lockPath), true);

		await withDeadline(nextApi.invoke("session_shutdown", nextContext), "replacement handoff shutdown");
		replacementShutdown = true;
		assert.equal(fs.existsSync(lockPath), false);
	} finally {
		if (replacementApi && replacementContext && !replacementShutdown) {
			await withDeadline(replacementApi.invoke("session_shutdown", replacementContext), "replacement handoff cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const outcome of ["failed receipt", "lost accepted receipt"] as const) {
	test(`adapter dispatch handles ${outcome} through the durable operation client`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-dispatch-transport-"));
		const originalFetch = globalThis.fetch;
		let fixture: Fixture | undefined;
		let api: CapturedExtensionAPI | undefined;
		let ctx: ExtensionContext | undefined;
		try {
			fixture = writeFixture(root);
			const factory = new PendingWorkerFactory();
			api = new CapturedExtensionAPI();
			registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
			const notifications: Warning[] = [];
			ctx = freshContext(fixture, notifications);
			await api.invoke("session_start", ctx);
			const submissions: Record<string, unknown>[] = [];
			globalThis.fetch = async (input, init) => {
				if (new URL(String(input)).pathname === "/v1/operation" && init?.method === "POST") {
					const body = object(JSON.parse(String(init.body)));
					if (body.kind === "event" && object(body.input).kind === "dispatch_results") {
						submissions.push(body);
						if (outcome === "failed receipt") {
							if (submissions.length > 1) throw new Error("Unexpected retry of failed dispatch receipt");
							return Response.json({ ok: true, operation: {
								operationId: body.operationId, kind: "event", state: "failed",
								error: "fetch failed in the completed manager operation",
							} });
						}
						const response = await originalFetch(input, init);
						if (submissions.length === 1) throw new Error("fetch failed after durable dispatch acceptance");
						return response;
					}
				}
				return originalFetch(input, init);
			};
			await withDeadline(api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx), "dispatch transport");
			assert.equal(factory.sessions.length, 1, "receipt recovery must not create another worker");
			const session = factory.sessions[0]!;
			if (outcome === "failed receipt") {
				assert.equal(submissions.length, 1, "a durable failure is not a transport retry");
				assert.equal(session.prompted, false, "unaccepted workers must not start");
				assert.equal(session.disposed, true, "unaccepted prepared sessions must be disposed");
				assert.ok(notifications.some((entry) => entry.level === "error" && entry.message.includes("fetch failed in the completed manager operation")));
				assert.equal(evidence(fixture).actions.some((action) => action.state === "dispatched"), false);
			} else {
				assert.equal(submissions.length, 2);
				assert.deepEqual(submissions[1], submissions[0], "recovery must retain the operation ID, event ID, and payload");
				assert.equal(submissions[0]!.operationId, `event:${object(submissions[0]!.input).eventId}`);
				await withDeadline(session.started, "accepted worker start");
				const actions = evidence(fixture).actions;
				assert.equal(actions.length, 1);
				assert.equal(actions[0]!.state, "dispatched");
				assert.equal(actions[0]!.hostHandle, `pi-worker:${session.sessionId}`);
				assert.equal(notifications.some((entry) => entry.level === "error"), false);
			}
		} finally {
			globalThis.fetch = originalFetch;
			if (api && ctx) await withDeadline(api.invoke("session_shutdown", ctx), "dispatch transport cleanup").catch(() => {});
			if (fixture) await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("foreign worker handles fail closed without changing manager evidence", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-recovery-foreign-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		const started = await startFixture(fixture, "legacy-worker");
		const factory = new PendingWorkerFactory();
		const api = capturedApi = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = capturedContext = restoredContext(fixture, String(started.before.run!.runId), warnings);

		await withDeadline(api.invoke("session_start", ctx), "foreign-handle session_start");
		assert.equal(factory.requests.length, 0);
		assert.equal(factory.sessions.length, 0);
		assert.equal(warnings.length, 1);
		assert.equal(warnings[0]!.level, "warning");
		assert.match(warnings[0]!.message, /incompatible Pi worker engine/);

		const after = evidence(fixture);
		assert.deepEqual(after.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			generation: action.generation,
			round: action.round,
			leaseReason: action.leaseReason,
		})), started.before.actions.map((action) => ({
			actionId: action.actionId,
			state: action.state,
			hostHandle: action.hostHandle,
			generation: action.generation,
			round: action.round,
			leaseReason: action.leaseReason,
		})));
		assert.equal(after.plan!.generation, started.before.plan!.generation);
		assert.equal(after.plan!.round, started.before.plan!.round);
		assert.equal(after.lease, started.before.lease);
		await withDeadline(api.invoke("session_shutdown", ctx), "foreign-handle session_shutdown");
		shutdown = true;
	} finally {
		if (capturedApi && capturedContext && !shutdown) {
			await withDeadline(capturedApi.invoke("session_shutdown", capturedContext), "foreign-handle cleanup", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("actual planning tool settles every worker, retains dismissed draft, and dispatches fresh whole-run assignments", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-whole-run-"));
	let value: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let ctx: ExtensionContext | undefined;
	try {
		value = writeBlockedAttentionFixture(root);
		const index = path.join(value.planDirectory, "README.md");
		const row = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | BLOCKED — needs attention |";
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(row, `${row}\n| [002](002-active.md) | Active sibling | P1 | S | — | TODO |`));
		fs.writeFileSync(path.join(value.planDirectory, "002-active.md"), fixturePlan({ id: "002", title: "Active sibling", writePaths: ["src/other.mjs"] }));
		const factory = new PendingWorkerFactory();
		api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		let consent = false;
		const confirmations: string[] = [];
		const base = freshContext(value, []);
		ctx = { ...base, hasUI: true, ui: { ...base.ui,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: async (_title: string, text: string) => { confirmations.push(text); return consent; },
		} } as ExtensionContext;
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 2", ctx);
		const message = await withDeadline(api.waitForAttentionMessage(), "whole-run attention delivery");
		assert.match(message.content, /Only the user may invoke \/herder-revise/);
		assert.deepEqual(message.options, { deliverAs: "followUp", triggerTurn: false });
		assert.equal(factory.sessions.length, 1);
		await withDeadline(factory.sessions[0]!.started, "initial sibling started");
		const oldWorktree = factory.requests[0]!.action.worktree;
		const sentinel = path.join(oldWorktree, "old-execution-evidence.txt");
		fs.writeFileSync(sentinel, "keep until final approval");
		const requestId = object(message.details).requestId;
		await assert.rejects(api.tool("herder_plan").execute("revise", { operation: "attention", planDirectory: value.planDirectory, requestId, action: "revise_run", confirmed: true }, undefined, undefined, ctx), /Only a user-invoked/);
		await api.command("herder-revise").handler("herder-plans", ctx);
		assert.equal(readRunRevision(value.planDirectory), null, "declined drafting leaves execution intact");
		assert.equal(factory.sessions[0]!.aborted, false);
		consent = true;
		await api.command("herder-revise").handler("herder-plans", ctx);
		assert.match(api.userMessages.at(-1)!.content, /HERDER_USER_AUTHORIZED_SCOPE_DRAFT_V1/);
		consent = false;
		const record = readRunRevision(value.planDirectory)!;
		assert.equal(factory.sessions[0]!.aborted, true, "begin returns graph authority only after all old workers settle");
		assert.ok(fs.existsSync(sentinel));
		const store = new RunStore(value.planDirectory, { readOnly: true });
		try { assert.equal(store.countActions(record.run.runId, { states: ["proposed", "dispatched"] }), 0); } finally { store.close(); }
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("BLOCKED — needs attention", "TODO"));
		fs.writeFileSync(path.join(value.planDirectory, "001-recover-worker.md"), fixturePlan({ title: "Recover a lost worker", acceptance: "Entire execution uses the revised assignment." }));
		const params = { operation: "finish_edit", planDirectory: value.planDirectory, editToken: record.editToken, confirmed: true };
		await assert.rejects(api.tool("herder_plan").execute("dirty", params, undefined, undefined, ctx), /dirty or unreviewed committed work/);
		assert.equal(fs.readFileSync(sentinel, "utf8"), "keep until final approval");
		assert.equal(confirmations.length, 2, "unreconciled work cannot reach adoption confirmation");
		// Explicitly reconcile the test-created untracked file; production must never discard it.
		fs.unlinkSync(sentinel);
		await assert.rejects(api.tool("herder_plan").execute("dismiss", params, undefined, undefined, ctx), /Confirmation dismissed/);
		assert.ok(fs.existsSync(oldWorktree), "dismissal preserves the old execution worktree");
		assert.equal(factory.requests.length, 1);
		assert.equal(readRunRevision(value.planDirectory)?.state, "prepared");
		consent = true;
		const finished = object(await api.tool("herder_plan").execute("approve", params, undefined, undefined, ctx));
		assert.equal(finished.isError, undefined, JSON.stringify(finished));
		assert.equal(confirmations.length, 4);
		const adoptionConfirmations = confirmations.slice(2);
		assert.ok(adoptionConfirmations.every(body => body.includes(record.run.runId) && body.includes(record.run.baseCommit) && body.includes(String(requestId))));
		assert.equal(fs.existsSync(sentinel), false);
		assert.equal(factory.requests.length, 3);
		assert.ok(factory.requests.slice(1).every(request => request.action.runId === record.run.runId && request.action.generation === record.run.currentGeneration + 1));
		assert.ok(adoptionConfirmations.every(body => /Retain completed plans: none/.test(body) && /Rerun plans: 001, 002/.test(body)));
		assert.ok(adoptionConfirmations.every(body => !/deleting every old execution|no selective reuse/.test(body)));
		assert.ok(factory.requests.slice(1).some(request => fs.readFileSync(request.action.assignmentPath, "utf8").includes("Entire execution uses the revised assignment")));
		assert.equal(readRunRevision(value.planDirectory)?.state, "complete");
	} finally {
		if (api && ctx) await withDeadline(api.invoke("session_shutdown", ctx), "whole-run fixture shutdown").catch(() => {});
		if (value) await stopService(value.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function reserveWholeRunFixture(value: Fixture) {
	const api = new CapturedExtensionAPI();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, new PendingWorkerFactory());
	const notifications: Warning[] = [];
	const base = freshContext(value, notifications);
	const ctx = { ...base, hasUI: true, ui: { ...base.ui, theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text }, confirm: async () => true } } as unknown as ExtensionContext;
	try {
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
		await api.command("herder-revise").handler("herder-plans", ctx);
		assert.ok(readRunRevision(value.planDirectory), JSON.stringify(notifications));
	} finally {
		await api.invoke("session_shutdown", ctx);
		await stopService(value.planDirectory);
	}
	const record = readRunRevision(value.planDirectory)!;
	const index = path.join(value.planDirectory, "README.md");
	fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("BLOCKED — needs attention", "TODO"));
	fs.writeFileSync(path.join(value.planDirectory, "001-recover-worker.md"), fixturePlan({ title: "Recover a lost worker", acceptance: "The replacement executes the revised contract." }));
	return record;
}

async function assertWholeRunHook(api: CapturedExtensionAPI, ctx: ExtensionContext, value: Fixture) {
	const hook = api.handlers.get("tool_call")!;
	for (const event of [
		{ toolName: "bash", input: { command: "npm test" } },
		{ toolName: "write", input: { path: "src/value.mjs", content: "unauthorized" } },
		{ toolName: "edit", input: { path: "src/value.mjs", edits: [] } },
		{ toolName: "write", input: { path: "herder-plans/.herder/run-revision.json", content: "unauthorized" } },
	]) assert.equal(object(await hook(event, ctx)).block, true, JSON.stringify(event));
	assert.equal(await hook({ toolName: "read", input: { path: "src/value.mjs" } }, ctx), undefined);
	assert.equal(fs.readFileSync(path.join(value.repo, "src/value.mjs"), "utf8"), "export const value = 1\n");
}

for (const operation of ["finish_edit", "cancel_edit"]) {
	test(`fresh-session ${operation} keeps whole-run tool restrictions after dismissal/cancellation`, { timeout: 40_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-revision-recover-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const base = freshContext(value, []);
		const ctx = { ...base, hasUI: true, ui: { ...base.ui,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: async () => false,
		} } as unknown as ExtensionContext;
		try {
			const record = await reserveWholeRunFixture(value);
			await api.invoke("session_start", ctx);
			const recovering = api.tool("herder_plan").execute("recover", { operation, planDirectory: value.planDirectory, editToken: record.editToken }, undefined, undefined, ctx);
			if (operation === "finish_edit") await assert.rejects(recovering, /Confirmation dismissed/);
			else {
				const result = object(await recovering);
				assert.equal(result.isError, undefined, JSON.stringify(result));
			}
			assert.equal(readRunRevision(value.planDirectory)?.state, operation === "finish_edit" ? "prepared" : "draft");
			await assertWholeRunHook(api, ctx, value);
			assert.equal(await api.handlers.get("tool_call")!({ toolName: "write", input: { path: "herder-plans/001-recover-worker.md" } }, ctx), undefined);
			// An idle status read clears currentState but must not clear the recovered edit binding.
			initPlanDir(path.join(value.repo, "idle-plans"));
			await api.command("herder-status").handler("idle-plans", ctx);
			await assertWholeRunHook(api, ctx, value);
			assert.equal(factory.requests.length, 0);
		} finally {
			await api.invoke("session_shutdown", ctx);
			await stopService(value.planDirectory).catch(() => {});
			await stopService(path.join(value.repo, "idle-plans")).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const recovery of ["finish_edit", "cancel_edit", "session_start draft", "session_start prepared"] as const) {
	test(`${recovery} restores exact whole-run attention and preserves evidence on user stop without status`, { timeout: 40_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-revision-abandon-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		let ctx: ExtensionContext | undefined;
		try {
			// Keep another durable request queued: recovery must bind the reserved one.
			const index = path.join(value.planDirectory, "README.md");
			const row = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | BLOCKED — needs attention |";
			fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(row, `${row}\n${row.replaceAll("001", "002")}`));
			fs.writeFileSync(path.join(value.planDirectory, "002-recover-worker.md"), fixturePlan({ id: "002", writePaths: ["src/other.mjs"] }));
			const record = await reserveWholeRunFixture(value);
			fs.writeFileSync(index, fs.readFileSync(index, "utf8").replaceAll("BLOCKED — needs attention", "TODO"));
			if (recovery === "session_start prepared") await prepareRunRevision(value.planDirectory, record.editToken);
			const store = new RunStore(value.planDirectory, { readOnly: true });
			let queued;
			try { queued = store.getAttentionRequests(record.run.runId, { unresolvedOnly: true }); }
			finally { store.close(); }
			assert.equal(queued.length, 2);
			assert.equal(queued[0]!.requestId, record.request.requestId);
			const base = recovery.startsWith("session_start") ? restoredContext(value, record.run.runId, []) : freshContext(value, []);
			let consent = false;
			const confirmations: string[] = [];
			ctx = { ...base, hasUI: true, ui: { ...base.ui,
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				confirm: async (title: string, body: string) => { confirmations.push(`${title}\n${body}`); return consent; },
			} } as unknown as ExtensionContext;
			await api.invoke("session_start", ctx);
			if (recovery === "finish_edit" || recovery === "cancel_edit") {
				const recovering = api.tool("herder_plan").execute("recover", { operation: recovery, planDirectory: value.planDirectory, editToken: record.editToken }, undefined, undefined, ctx);
				if (recovery === "finish_edit") await assert.rejects(recovering, /Confirmation dismissed/);
				else {
					const recovered = object(await recovering);
					assert.equal(recovered.isError, undefined, JSON.stringify(recovered));
				}
			}
			await api.invoke("agent_settled", ctx);
			const delivered = await withDeadline(api.waitForAttentionMessage(), "recovered revision attention");
			assert.equal(object(delivered.details).requestId, record.request.requestId);
			assert.ok(api.customMessages.every(message => object(message.details).requestId === record.request.requestId));
			const params = { operation: "attention", planDirectory: value.planDirectory, requestId: record.request.requestId, action: "abandon_run" };
			const count = confirmations.length;
			await assert.rejects(api.tool("herder_plan").execute("wrong-request", { ...params, requestId: queued[1]!.requestId }, undefined, undefined, ctx), /is not bound to this Pi session/);
			assert.equal(confirmations.length, count);
			await assert.rejects(api.tool("herder_plan").execute("model-abandon", params, undefined, undefined, ctx), /Only a user-invoked/);
			assert.equal(confirmations.length, count, "model abandonment cannot open confirmation");
			await api.command("herder-stop").handler("", ctx);
			assert.equal(confirmations.length, count + 1);
			assert.match(confirmations.at(-1)!, /^Stop Herder\?/);
			const pending = new RunStore(value.planDirectory, { readOnly: true });
			try {
				assert.equal(pending.getRun()!.runId, record.run.runId);
				assert.deepEqual(pending.getAttentionRequests(record.run.runId, { unresolvedOnly: true }), queued);
				assert.equal(pending.getActions(record.run.runId).length, 0);
			} finally { pending.close(); }
			assert.equal(factory.requests.length, 0);
			consent = true;
			await api.command("herder-stop").handler("", ctx);
			assert.equal(readRunRevision(value.planDirectory)?.state, recovery === "finish_edit" || recovery === "session_start prepared" ? "prepared" : "draft");
			const after = new RunStore(value.planDirectory, { readOnly: true });
			try {
				assert.equal(after.getRun()!.status, "stopped");
				assert.equal(after.getRun()!.runId, record.run.runId);
				assert.deepEqual(after.getAttentionRequests(record.run.runId, { unresolvedOnly: true }), queued);
			} finally { after.close(); }
			assert.equal(factory.requests.length, 0, "recovery and stop must never resume or dispatch workers");
		} finally {
			if (ctx) await api.invoke("session_shutdown", ctx);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const stale of ["resolved request", "request hash", "current generation"] as const) {
	test(`whole-run attention recovery refuses ${stale} drift without binding or scheduling`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-revision-stale-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		let ctx: ExtensionContext | undefined;
		try {
			const record = await reserveWholeRunFixture(value);
			const store = new RunStore(value.planDirectory);
			try {
				if (stale === "resolved request") store.resolveAttention(record.request.requestId);
				if (stale === "current generation") store.updateRun({ currentGeneration: record.run.currentGeneration + 1 });
			} finally { store.close(); }
			if (stale === "request hash") writeRunRevision(value.planDirectory, { ...record, request: { ...record.request, requestSha256: "0".repeat(64) } }, record);
			const warnings: Warning[] = [];
			ctx = restoredContext(value, record.run.runId, warnings);
			await api.invoke("session_start", ctx);
			assert.ok(warnings.some(warning => /attention no longer matches the current request identity/.test(warning.message)), JSON.stringify(warnings));
			await api.invoke("agent_settled", ctx);
			assert.equal(api.customMessages.length, 0);
			assert.equal(fs.existsSync(adapterOwnershipLockPath(value.planDirectory)), false);
			await assert.rejects(api.tool("herder_plan").execute("stale-abandon", { operation: "attention", planDirectory: value.planDirectory, requestId: record.request.requestId, action: "abandon_run" }, undefined, undefined, ctx), /No unresolved Herder attention request/);
			assert.equal(factory.requests.length, 0);
		} finally {
			if (ctx) await api.invoke("session_shutdown", ctx);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const point of ["after_restarting", "after_restart", "after_complete"]) {
	test(`session startup recovers whole-run record across ${point} instead of rejecting the old run hint`, { timeout: 40_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-revision-startup-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		let ctx: ExtensionContext | undefined;
		try {
			const record = await reserveWholeRunFixture(value);
			await confirmRunRevision(await prepareRunRevision(value.planDirectory, record.editToken));
			const module = new URL("../../../src/application/run-revision.ts", import.meta.url).href;
			const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { finishRunRevision } from ${JSON.stringify(module)}; await finishRunRevision(${JSON.stringify(value.planDirectory)}, ${JSON.stringify(record.editToken)});`], { env: { ...process.env, HERDER_TEST_RUN_REVISION_CRASH_AT: point }, encoding: "utf8", timeout: 25_000 });
			assert.equal(child.signal, "SIGKILL", child.stderr);
			const notifications: Warning[] = [];
			ctx = restoredContext(value, record.run.runId, notifications);
			await api.invoke("session_start", ctx);
			assert.equal(notifications.some(entry => /recovery failed|refusing recovery/.test(entry.message)), false, JSON.stringify(notifications));
			assert.ok(notifications.some(entry => entry.message.includes(record.editToken)));
			const owner = JSON.parse(fs.readFileSync(adapterOwnershipLockPath(value.planDirectory), "utf8"));
			assert.equal(owner.runId, record.run.runId);
			if (point !== "after_complete") await assertWholeRunHook(api, ctx, value);
			assert.equal(factory.requests.length, 0, "startup must not resume workers inside the revision barrier");
			if (point === "after_complete") {
				ctx = { ...freshContext(value, notifications), sessionManager: ctx.sessionManager };
				const finished = object(await api.tool("herder_plan").execute("recover-completed-revision", {
					operation: "finish_edit", planDirectory: value.planDirectory, editToken: record.editToken,
				}, undefined, undefined, ctx));
				assert.equal(finished.isError, undefined, JSON.stringify(finished));
				assert.equal(readRunRevision(value.planDirectory)?.selective?.resumed, true);
				await api.invoke("session_shutdown", ctx);
				const laterNotifications: Warning[] = [];
				ctx = restoredContext(value, record.run.runId, laterNotifications);
				await api.invoke("session_start", ctx);
				assert.equal(laterNotifications.some(entry => /Recovered whole-run revision|recovery failed/.test(entry.message)), false, JSON.stringify(laterNotifications));
			}
		} finally {
			if (ctx) await api.invoke("session_shutdown", ctx);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const phase of ["active worker", "admitted startup"] as const) {
	test(`nuclear reset drains ${phase}, cancellation preserves ownership, fresh Fire succeeds`, { timeout: 45_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-nuclear-reset-"));
		const value = writeFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = phase === "admitted startup" ? new GatedPrepareWorkerFactory() : new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const notifications: Warning[] = [];
		const base = freshContext(value, notifications);
		let consent = false;
		const ctx = { ...base, hasUI: true, ui: { ...base.ui,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: async () => consent,
		} } as unknown as ExtensionContext;
		try {
			await api.invoke("session_start", ctx);
			const firing = api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
			if (factory instanceof GatedPrepareWorkerFactory) await withDeadline(factory.createEntered.promise, "startup admitted");
			else await withDeadline(firing, "Fire");
			const lock = fs.readFileSync(adapterOwnershipLockPath(value.planDirectory), "utf8");
			await api.command("herder-reset").handler("herder-plans", ctx);
			assert.equal(fs.readFileSync(adapterOwnershipLockPath(value.planDirectory), "utf8"), lock);
			assert.ok(factory.sessions.every(session => !session.aborted && !session.disposed));
			consent = true;
			const stopped = new Deferred<void>();
			const allowStop = new Deferred<void>();
			if (!(factory instanceof GatedPrepareWorkerFactory)) {
				const session = factory.sessions[0]!;
				const abort = session.abort.bind(session);
				session.abort = async () => {
					assert.ok(evidence(value).run, "destructive reset must wait for worker abort/disposal");
					assert.ok(fs.existsSync(adapterOwnershipLockPath(value.planDirectory)));
					stopped.resolve(); await allowStop.promise; await abort();
				};
			}
			const resetting = api.command("herder-reset").handler("herder-plans", ctx);
			if (factory instanceof GatedPrepareWorkerFactory) {
				await new Promise(resolve => setTimeout(resolve, 150));
				assert.ok(evidence(value).run, "reset must wait for admitted manager task");
				factory.allowCreate.resolve();
			} else {
				await withDeadline(stopped.promise, "reset worker stop");
				await api.command("herder-fire").handler("herder-plans --profile eclipse", ctx);
				assert.ok(notifications.some(entry => /reset is in progress/.test(entry.message)));
				allowStop.resolve();
			}
			await withDeadline(Promise.all([firing, resetting]), "reset drain and apply", 25_000);
			assert.ok(notifications.some(entry => /Herder reset executed/.test(entry.message)), JSON.stringify(notifications));
			assert.ok(factory.sessions.every(session => session.disposed));
			assert.equal(fs.existsSync(adapterOwnershipLockPath(value.planDirectory)), false);
			await withDeadline(api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx), "fresh Fire");
			assert.ok(fs.existsSync(adapterOwnershipLockPath(value.planDirectory)));
		} finally {
			if (factory instanceof GatedPrepareWorkerFactory) factory.allowCreate.resolve();
			await api.invoke("session_shutdown", ctx);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

function ownershipEvidence(value: Fixture) {
	const lockPath = adapterOwnershipLockPath(value.planDirectory);
	return { lockPath, record: JSON.parse(fs.readFileSync(lockPath, "utf8")), stat: fs.statSync(lockPath) };
}

function assertCleanupMarker(original: ReturnType<typeof ownershipEvidence>) {
	assert.deepEqual(JSON.parse(fs.readFileSync(original.lockPath, "utf8")), { ...original.record, resetCleanupRequired: true });
	const stat = fs.statSync(original.lockPath);
	assert.equal(stat.dev, original.stat.dev);
	assert.equal(stat.ino, original.stat.ino);
	assert.equal(stat.mode, original.stat.mode);
	assert.equal(stat.uid, original.stat.uid);
	assert.equal(stat.gid, original.stat.gid);
}

async function assertDeadOwnerRefused(value: Fixture, original: ReturnType<typeof ownershipEvidence>) {
	assertCleanupMarker(original);
	const marked = fs.readFileSync(original.lockPath, "utf8");
	const kill = process.kill;
	assert.equal(original.record.pid, process.pid);
	try {
		process.kill = ((pid, signal) => {
			if (pid === original.record.pid && signal === 0) throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
			return kill(pid, signal);
		}) as typeof process.kill;
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.throws(() => acquireAdapterOwnership(value.planDirectory, "replacement", "replacement-session", {
				isProcessAlive: () => false,
			}), /manual child-process cleanup/);
			await assert.rejects(() => applyHerderReset({ repoRoot: value.repo, planDirectory: value.planDirectory }, {
				withExclusion: async () => { assert.fail("must refuse before service exclusion"); },
			}), /manual child-process cleanup/);
			assertCleanupMarker(original);
			assert.equal(fs.readFileSync(original.lockPath, "utf8"), marked);
		}
	} finally { process.kill = kill; }
}

for (const resetFirst of [true, false]) {
	for (const failure of ["abort", "disposal"] as const) {
		test(`${resetFirst ? "nuclear reset and session shutdown" : "immediate session shutdown"} retain ownership after ${failure} failure`, { timeout: 30_000 }, async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-reset-cleanup-failure-"));
			const value = writeFixture(root);
			const api = new CapturedExtensionAPI();
			const factory = new PendingWorkerFactory();
			registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
			const notifications: Warning[] = [];
			const base = freshContext(value, notifications);
			const ctx = { ...base, hasUI: true, ui: { ...base.ui,
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				confirm: async () => true,
			} } as unknown as ExtensionContext;
			try {
				await api.invoke("session_start", ctx);
				await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
				const original = ownershipEvidence(value);
				assert.equal(original.record.resetCleanupRequired, undefined);
				const runId = evidence(value).run!.runId;
				const session = factory.sessions[0]!;
				const abort = session.abort.bind(session);
				session.abort = async () => {
					assertCleanupMarker(original);
					await abort();
					if (failure === "abort") throw Error("fixture abort cleanup failed");
				};
				if (failure === "disposal") session.dispose = () => {
					assertCleanupMarker(original);
					throw Error("fixture disposal failed");
				};
				if (resetFirst) {
					for (let attempt = 0; attempt < 2; attempt++) {
						await api.command("herder-reset").handler("herder-plans", ctx);
						assert.equal(evidence(value).run!.runId, runId);
						await assertDeadOwnerRefused(value, original);
					}
					assert.ok(notifications.some(entry => /worker cleanup failed/.test(entry.message)), JSON.stringify(notifications));
					assert.ok(!notifications.some(entry => /Herder reset executed/.test(entry.message)));
					await api.invoke("session_start", ctx);
					assertCleanupMarker(original);
				}
				await assert.rejects(() => api.invoke("session_shutdown", ctx), /worker cleanup failed/);
				await assertDeadOwnerRefused(value, original);
				assert.equal(evidence(value).run!.runId, runId);
			} finally {
				await api.invoke("session_shutdown", ctx).catch(() => {});
				await stopService(value.planDirectory).catch(() => {});
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
}

for (const outcome of ["success", "success with queued recovery", "failure"] as const) {
	const disposalFails = outcome === "failure";
	test(`shutdown ${disposalFails ? "retains" : "releases"} ownership after session replacement and late preparation disposal ${outcome}`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-shutdown-late-cleanup-"));
		const value = writeFixture(root);
		const api = new CapturedExtensionAPI();
		let original: ReturnType<typeof ownershipEvidence>;
		const shutdownEntered = new Deferred<void>();
		const allowShutdown = new Deferred<void>();
		const disposalEntered = new Deferred<void>();
		const allowDisposal = new Deferred<void>();
		const factory = new class extends GatedPrepareWorkerFactory {
			protected override createSession(request: PiWorkerRequest) {
				const created = super.createSession(request);
				if (this.sessions.length !== 1) return created;
				const dispose = created.session.dispose.bind(created.session);
				Object.assign(created.session, { extensionRunner: { emit: async () => {
					assertCleanupMarker(original);
					shutdownEntered.resolve();
					await allowShutdown.promise;
				} } });
				created.session.dispose = async () => {
					assertCleanupMarker(original);
					disposalEntered.resolve();
					await allowDisposal.promise;
					if (disposalFails) throw Error("fixture late disposal failed");
					dispose();
				};
				return created;
			}
		}();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ctx = freshContext(value, []);
		let attaching: Promise<unknown> | undefined;
		try {
			await startFixture(value, "pi-worker:late-cleanup-lost");
			await api.invoke("session_start", ctx);
			attaching = api.command("herder-attach").handler("herder-plans", ctx);
			await withDeadline(factory.createEntered.promise, "late preparation admitted");
			original = ownershipEvidence(value);
			let shutdownSettled = false;
			const shuttingDown = api.invoke("session_shutdown", ctx).finally(() => { shutdownSettled = true; });
			const shutdownResult = disposalFails ? assert.rejects(shuttingDown, /worker cleanup failed/) : shuttingDown;
			assertCleanupMarker(original);
			// A new session schedules idle retirement while the old admitted task is still pending.
			await api.invoke("session_start", ctx);
			const warnings: Warning[] = [];
			const before = evidence(value);
			const freshRecovery = outcome !== "success"
				? api.invoke("session_start", restoredContext(value, original.record.runId, warnings))
				: undefined;
			assert.equal(shutdownSettled, false);
			factory.allowCreate.resolve();
			await withDeadline(shutdownEntered.promise, "late extension shutdown");
			assert.equal(shutdownSettled, false);
			assertCleanupMarker(original);
			assert.deepEqual(evidence(value), before);
			allowShutdown.resolve();
			await withDeadline(disposalEntered.promise, "late disposal");
			assert.equal(shutdownSettled, false);
			assert.equal(factory.sessions.length, 1);
			assertCleanupMarker(original);
			allowDisposal.resolve();
			await withDeadline(shutdownResult, "late local shutdown");
			await withDeadline(attaching, "late attach completion");
			await withDeadline(waitForAdapterOwnershipRetirement(value.planDirectory), "ownership retirement");
			assert.equal(factory.sessions[0]!.prompted, false);
			assert.equal(factory.sessions[0]!.disposed, !disposalFails);
			if (!freshRecovery) {
				assert.equal(factory.sessions.length, 1);
				assert.equal(evidence(value).actions.some(action => action.state === "dispatched"), false);
			}
			if (disposalFails) {
				await withDeadline(freshRecovery!, "failed cleanup refuses queued recovery");
				assert.ok(warnings.some(entry => /manual.*cleanup/i.test(entry.message)), JSON.stringify(warnings));
				assert.equal(factory.sessions.length, 1);
				assert.deepEqual(evidence(value), before);
				await assertDeadOwnerRefused(value, original);
			}
			else {
				if (!freshRecovery) assert.equal(fs.existsSync(original.lockPath), false, "successful retirement must release the marked claim despite session_start");
				await withDeadline(freshRecovery ?? api.invoke("session_start", restoredContext(value, original.record.runId, [])), "fresh session recovery");
				assert.equal(factory.sessions.length, 2, JSON.stringify(warnings));
				await withDeadline(factory.sessions[1]!.started, "fresh session worker start");
				assert.equal(factory.sessions.length, 2, "exactly one replacement");
				assert.equal(evidence(value).actions.filter(action => action.state === "dispatched").length, 1);
				assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
			}
		} finally {
			factory.allowCreate.resolve();
			allowShutdown.resolve();
			allowDisposal.resolve();
			if (attaching) await withDeadline(attaching, "late attach cleanup").catch(() => {});
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("shutdown drains locally while old admitted remote reconciliation retains ownership", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-shutdown-remote-retirement-"));
	const value = writeFixture(root);
	const api = new CapturedExtensionAPI();
	const factory = new PendingWorkerFactory();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
	const ctx = freshContext(value, []);
	const originalFetch = globalThis.fetch;
	const receiptEntered = new Deferred<void>();
	const allowReceipt = new Deferred<void>();
	let attaching: Promise<unknown> | undefined;
	let recovery: Promise<unknown> | undefined;
	try {
		await startFixture(value, "pi-worker:remote-retirement-lost");
		await api.invoke("session_start", ctx);
		let heldReceipt = false;
		globalThis.fetch = async (input, init) => {
			const response = await originalFetch(input, init);
			if (!heldReceipt && new URL(String(input)).pathname === "/v1/operation" && init?.method === "POST") {
				const body = object(JSON.parse(String(init.body)));
				if (body.kind === "event" && object(body.input).kind === "dispatch_results") {
					heldReceipt = true;
					receiptEntered.resolve();
					await allowReceipt.promise;
				}
			}
			return response;
		};
		attaching = api.command("herder-attach").handler("herder-plans", ctx);
		await withDeadline(receiptEntered.promise, "old admitted dispatch receipt");
		const original = ownershipEvidence(value);
		const before = evidence(value);
		let attachSettled = false;
		void attaching.then(() => { attachSettled = true; });
		await withDeadline(api.invoke("session_shutdown", ctx), "local shutdown without remote receipt");
		assert.equal(attachSettled, false);
		assert.equal(factory.sessions[0]!.prompted, false);
		assert.equal(factory.sessions[0]!.disposed, true);
		assertCleanupMarker(original);
		const warnings: Warning[] = [];
		recovery = api.invoke("session_start", restoredContext(value, original.record.runId, warnings));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assertCleanupMarker(original);
		assert.deepEqual(evidence(value), before);
		assert.equal(factory.sessions.length, 1);
		allowReceipt.resolve();
		await withDeadline(Promise.all([attaching, recovery]), "remote retirement and queued recovery");
		assert.equal(warnings.length, 0, JSON.stringify(warnings));
		assert.equal(factory.sessions.length, 1, "second automatic transport recovery must not bypass its persisted limit");
		assert.equal(factory.sessions[0]!.prompted, false, "old epoch never starts its accepted worker");
		const stopped = evidence(value);
		assert.equal(stopped.actions.filter(action => action.state === "dispatched").length, 0);
		assert.equal(stopped.run!.status, "needs_input");
		assert.match(stopped.run!.terminalDetail!, /exhausted the cumulative safe transport recovery/i);
		assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
	} finally {
		allowReceipt.resolve();
		await Promise.all([attaching, recovery].map(task => task && withDeadline(task, "remote retirement cleanup").catch(() => {})));
		globalThis.fetch = originalFetch;
		await api.invoke("session_shutdown", ctx).catch(() => {});
		await stopService(value.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("shutdown marker persistence failure never aborts or disposes workers", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-shutdown-marker-failure-"));
	const value = writeFixture(root);
	const api = new CapturedExtensionAPI();
	const factory = new PendingWorkerFactory();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
	const ctx = freshContext(value, []);
	const fsync = fs.fsyncSync;
	try {
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
		const original = ownershipEvidence(value);
		let attempted = false;
		fs.fsyncSync = descriptor => {
			const stat = fs.fstatSync(descriptor);
			if (stat.dev === original.stat.dev && stat.ino === original.stat.ino) {
				attempted = true;
				throw Error("fixture marker fsync failed");
			}
			fsync(descriptor);
		};
		await assert.rejects(() => api.invoke("session_shutdown", ctx), /fixture marker fsync failed/);
		assert.equal(attempted, true);
		assert.equal(factory.sessions[0]!.aborted, false);
		assert.equal(factory.sessions[0]!.disposed, false);
		const stat = fs.statSync(original.lockPath);
		assert.equal(stat.dev, original.stat.dev);
		assert.equal(stat.ino, original.stat.ino);
		assert.equal(stat.mode, original.stat.mode);
	} finally {
		fs.fsyncSync = fsync;
		await api.invoke("session_shutdown", ctx).catch(() => {});
		await stopService(value.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const duringPreparation of [false, true]) {
	test(`unsafe ${duringPreparation ? "rejected preparation" : "successful-prompt cleanup"} halts locally without success or transport retry`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-unsafe-completion-"));
		const value = writeFixture(root);
		if (!duringPreparation) {
			const index = path.join(value.planDirectory, "README.md");
			const row = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | TODO |";
			fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(row, `${row}\n${row.replaceAll("001", "002")}`));
			fs.writeFileSync(path.join(value.planDirectory, "002-recover-worker.md"), fixturePlan({ id: "002", writePaths: ["src/other.mjs"] }));
		}
		const api = new CapturedExtensionAPI();
		const unsafe = new Deferred<void>();
		const confirming = new Deferred<void>();
		const confirmed = new Deferred<boolean>();
		let cleanup: Promise<unknown> | undefined;
		const notifications: Warning[] = [];
		const factory = new class extends PendingWorkerFactory {
			protected override createSession(request: PiWorkerRequest) {
				const created = super.createSession(request);
				created.session.dispose = () => { throw Error("fixture unsafe disposal"); };
				const stats = created.session.getSessionStats();
				created.session.getSessionStats = () => ({ ...stats, tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 } });
				if (duringPreparation) created.session.messages.push({ role: "user", content: "inherited" });
				return created;
			}
		}();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const base = freshContext(value, notifications);
		const ctx = { ...base, ui: { ...base.ui,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: async () => { confirming.resolve(); return confirmed.promise; }, notify(text: string, level: string) {
			notifications.push({ message: text, level });
			if (/manual.*cleanup/i.test(text)) unsafe.resolve();
		} } } as unknown as ExtensionContext;
		try {
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 2", ctx);
			const original = ownershipEvidence(value);
			if (!duringPreparation) {
				assert.equal(original.record.resetCleanupRequired, undefined);
				const session = factory.sessions[0]!;
				await session.started;
				cleanup = api.command("herder-cleanup").handler("herder-plans --force", { ...ctx, hasUI: true });
				await withDeadline(confirming.promise, "cleanup confirmation");
				session.messages.push({ role: "assistant", content: [{ type: "text", text: "STATUS: COMPLETE\nSUMMARY: implementation complete" }], stopReason: "stop" });
				session.finish();
			}
			await withDeadline(unsafe.promise, "unsafe cleanup signal");
			assertCleanupMarker(original);
			if (cleanup) {
				confirmed.resolve(true);
				await cleanup;
				assert.equal(factory.sessions[1]!.aborted, true, "admitted sibling cancellation requested");
			}
			const before = evidence(value);
			assert.equal(before.actions.length, duringPreparation ? 1 : 2);
			assert.equal(before.actions[0]!.state, duringPreparation ? "proposed" : "dispatched");
			for (const [name, args] of [
				["herder-stop", ""], ["herder-resume", "herder-plans"], ["herder-revise", "herder-plans"],
				["herder-attach", "herder-plans"], ["herder-rework", "001"], ["herder-reset", "herder-plans"],
			] as const) {
				const offset = notifications.length;
				await api.command(name).handler(args, ctx);
				assert.ok(notifications.slice(offset).some(entry => (name === "herder-rework" ? /Active rework has moved to/ : /manual.*cleanup/i).test(entry.message)), name);
			}
			await assert.rejects(api.tool("herder_plan").execute("unsafe-edit", { operation: "finish_edit", planDirectory: value.planDirectory, editToken: "unsafe" }, undefined, undefined, ctx), /manual.*cleanup/i);
			const toolCall = api.handlers.get("tool_call")!;
			assert.equal(object(await toolCall({ toolName: "herder_plan", input: { operation: "begin_edit", planDirectory: value.planDirectory } }, ctx)).block, true);
			assert.equal(await toolCall({ toolName: "herder_plan", input: { operation: "snapshot", planDirectory: value.planDirectory } }, ctx), undefined);
			assert.equal(await toolCall({ toolName: "herder_plan", input: { operation: "init", planDirectory: "unrelated-plans" } }, ctx), undefined);
			await api.command("herder-status").handler("herder-plans", ctx);
			await api.invoke("session_start", restoredContext(value, before.run!.runId, notifications));
			assert.deepEqual(evidence(value).actions, before.actions);
			assert.equal(factory.sessions.length, duringPreparation ? 1 : 2, "no successor or transport retry");
			assertCleanupMarker(original);
			if (!duringPreparation) {
				const outputs = api.appendedEntries.filter(entry => entry.customType === "herder-worker-output-v1");
				const output = outputs.map(entry => object(entry.data)).find(entry => String(entry.response).includes("implementation complete"));
				assert.ok(output, "unsafe root output retained");
				assert.equal(output.status, "interrupted");
				assert.match(String(output.error), /fixture unsafe disposal/);
				assert.equal(object(output.usage).inputTokens, 7);
				assert.equal(object(output.usage).outputTokens, 3);
			}
			const unrelated = path.join(value.repo, "unrelated-plans");
			initPlanDir(unrelated);
			const claim = acquireAdapterOwnership(unrelated, "unrelated", "unrelated-session");
			releaseAdapterOwnership(claim);
		} finally {
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("unsafe shutdown retains the original root output after drain without advancing the manager", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-unsafe-shutdown-output-"));
	const value = writeFixture(root);
	const api = new CapturedExtensionAPI();
	const factory = new PendingWorkerFactory();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
	const notifications: Warning[] = [];
	const ctx = freshContext(value, notifications);
	const abortEntered = new Deferred<void>();
	const releaseAbort = new Deferred<void>();
	let shutdown: Promise<void> | undefined;
	try {
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
		const session = factory.sessions[0]!;
		await withDeadline(session.started, "pending root start");
		const original = ownershipEvidence(value);
		const before = evidence(value);
		assert.equal(original.record.resetCleanupRequired, undefined);
		const input = object(api.appendedEntries.find(entry => entry.customType === "herder-worker-input-v1")!.data);
		const response = "STATUS: COMPLETE\nSUMMARY: response retained through unsafe shutdown";
		session.messages.push({ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" });
		const stats = session.getSessionStats();
		session.getSessionStats = () => ({ ...stats, tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 } });
		const abort = session.abort.bind(session);
		session.abort = async () => {
			assertCleanupMarker(original);
			abortEntered.resolve();
			await releaseAbort.promise;
			await abort();
		};
		session.dispose = () => { throw Error("fixture shutdown disposal failed"); };
		shutdown = assert.rejects(withDeadline(api.invoke("session_shutdown", ctx), "unsafe shutdown drain"), /worker cleanup failed/);
		await withDeadline(abortEntered.promise, "shutdown abort requested");
		assert.deepEqual(evidence(value), before, "shutdown does not advance while abort is unsettled");
		assertCleanupMarker(original);
		releaseAbort.resolve();
		await shutdown;
		assert.equal(session.aborted, true);
		const outputs = () => api.appendedEntries.filter(entry => entry.customType === "herder-worker-output-v1");
		assert.equal(outputs().length, 1, "unsafe root output remains collectable after worker retirement");
		const output = object(outputs()[0]!.data);
		assert.equal(output.actionId, input.actionId);
		assert.equal(output.handle, `pi-worker:${session.sessionId}`);
		assert.equal(output.handle, input.handle);
		assert.equal(output.runId, before.run!.runId);
		assert.equal(output.worktree, input.worktree);
		assert.equal(output.status, "interrupted");
		assert.equal(output.response, response);
		assert.match(String(output.error), /fixture shutdown disposal failed/);
		const usage = object(output.usage);
		assert.equal(usage.inputTokens, 7);
		assert.equal(usage.outputTokens, 3);
		assert.equal(usage.cachedInputTokens, 0);
		assert.equal(usage.source, "herder pi worker session");
		await assertDeadOwnerRefused(value, original);
		await api.command("herder-resume").handler("herder-plans", ctx);
		assert.ok(notifications.some(entry => /session changed or shut down/.test(entry.message)), "shutdown control authority remains invalid");
		await api.invoke("session_start", restoredContext(value, before.run!.runId, notifications));
		assert.ok(notifications.some(entry => /manual.*cleanup/i.test(entry.message)), "recovery remains excluded");
		await assert.rejects(() => api.invoke("session_shutdown", ctx), /worker cleanup failed/);
		assert.equal(outputs().length, 1, "retired terminal is not published twice");
		assert.deepEqual(evidence(value), before, "no success, retryable interruption or manager advancement");
		assert.equal(factory.requests.length, 1, "no successor or replacement");
		assertCleanupMarker(original);
	} finally {
		releaseAbort.resolve();
		await shutdown?.catch(() => {});
		await api.invoke("session_shutdown", ctx).catch(() => {});
		await stopService(value.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const markDuringConfirmation of [false, true]) {
	test(`fresh adapter refuses durable cleanup evidence ${markDuringConfirmation ? "at apply" : "before preview"}`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-durable-cleanup-"));
		const value = writeFixture(root);
		const held = acquireAdapterOwnership(value.planDirectory, "fixture-run", "departed-session");
		const api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, new PendingWorkerFactory());
		const warnings: Warning[] = [];
		const base = freshContext(value, warnings);
		let confirmations = 0;
		const ctx = { ...base, hasUI: true, ui: { ...base.ui,
			confirm: async () => { confirmations++; markAdapterOwnershipCleanupRequired(held); return true; },
		} } as ExtensionContext;
		try {
			if (!markDuringConfirmation) markAdapterOwnershipCleanupRequired(held);
			const before = fs.statSync(held.lockPath);
			await api.command("herder-cleanup").handler("herder-plans --force", ctx);
			assert.ok(warnings.some(warning => /manual.*cleanup/i.test(warning.message)), JSON.stringify(warnings));
			assert.equal(confirmations, markDuringConfirmation ? 1 : 0);
			assert.ok(fs.existsSync(value.planDirectory));
			assert.equal(fs.statSync(held.lockPath).ino, before.ino);
			assert.equal(JSON.parse(fs.readFileSync(held.lockPath, "utf8")).resetCleanupRequired, true);
		} finally {
			releaseAdapterOwnership(held);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const action of ["herder-revise", "herder-stop"] as const) {
	test(`queued ${action} user command cannot mutate after root disposal latches exclusion`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-queued-attention-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const unsafe = new Deferred<void>();
		const queueHeld = new Deferred<void>();
		const releaseQueue = new Deferred<void>();
		const notifications: string[] = [];
		const base = freshContext(value, []);
		const ctx = { ...base, hasUI: true, ui: { ...base.ui, theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text }, confirm: async () => true, notify(text: string) {
			notifications.push(text);
			if (/manual.*cleanup/i.test(text)) unsafe.resolve();
		} } } as unknown as ExtensionContext;
		const originalFetch = globalThis.fetch;
		let attaching: Promise<unknown> | undefined;
		let attention: Promise<unknown> | undefined;
		try {
			const index = path.join(value.planDirectory, "README.md");
			const row = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | BLOCKED — needs attention |";
			fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(row, `${row}\n| [002](002-active.md) | Active sibling | P1 | S | — | TODO |`));
			fs.writeFileSync(path.join(value.planDirectory, "002-active.md"), fixturePlan({ id: "002", title: "Active sibling", writePaths: ["src/other.mjs"] }));
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 2", ctx);
			const message = await withDeadline(api.waitForAttentionMessage(), "queued attention delivery");
			assert.equal(factory.sessions.length, 1);
			const session = factory.sessions[0]!;
			await withDeadline(session.started, "active sibling started");
			const original = ownershipEvidence(value);
			assert.equal(original.record.resetCleanupRequired, undefined);
			const snapshot = () => {
				const store = new RunStore(value.planDirectory, { readOnly: true });
				try {
					const run = store.getRun()!;
					return { run, plans: store.getPlans(run.runId), actions: store.getActions(run.runId), attention: store.getAttentionRequests(run.runId) };
				} finally { store.close(); }
			};
			const before = snapshot();
			assert.equal(before.actions.length, 1);
			assert.equal(before.actions[0]!.state, "dispatched");
			assert.equal(before.actions[0]!.planId, "002");
			assert.equal(readRunRevision(value.planDirectory), null);
			const markdown = fs.readFileSync(index, "utf8");
			// Attach's second status read runs inside managerQueue; hold its response, not the service.
			let statusReads = 0;
			globalThis.fetch = async (input, init) => {
				const response = await originalFetch(input, init);
				if (new URL(String(input)).pathname === "/v1/status" && ++statusReads === 2) {
					queueHeld.resolve();
					await releaseQueue.promise;
				}
				return response;
			};
			attaching = api.command("herder-attach").handler("herder-plans", ctx);
			await withDeadline(queueHeld.promise, "attach holds manager queue");
			let attentionSettled = false;
			attention = api.command(action).handler("herder-plans", ctx).finally(() => { attentionSettled = true; });
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
			assert.equal(attentionSettled, false, "attention is waiting behind attach");
			session.dispose = () => { throw Error("fixture queued attention root disposal failed"); };
			session.messages.push({ role: "assistant", content: [{ type: "text", text: "STATUS: COMPLETE\nSUMMARY: implementation complete" }], stopReason: "stop" });
			session.finish();
			await withDeadline(unsafe.promise, "root disposal exclusion");
			assertCleanupMarker(original);
			assert.deepEqual(snapshot(), before, "failed root cleanup must not advance a terminal");
			releaseQueue.resolve();
			await withDeadline(attaching, "attach releases manager queue");
			await withDeadline(attention, "queued attention rejected");
			assert.ok(notifications.some(text => /manual.*cleanup/i.test(text)));
			assert.equal(readRunRevision(value.planDirectory), null, "queued attention must not reserve a draft before checking exclusion");
			assert.deepEqual(snapshot(), before, "run, plans, actions and attention must remain unchanged");
			assert.equal(fs.readFileSync(index, "utf8"), markdown);
			assert.equal(factory.requests.length, 1, "no successor or transport retry");
			assertCleanupMarker(original);
		} finally {
			releaseQueue.resolve();
			await Promise.all([attaching, attention].map(task => task && withDeadline(task, "queued attention cleanup").catch(() => {})));
			globalThis.fetch = originalFetch;
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

function cleanupContext(value: Fixture, warnings: Warning[], confirm = async () => true): ExtensionContext {
	const base = freshContext(value, warnings);
	return { ...base, hasUI: true, ui: { ...base.ui,
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text }, confirm,
	} } as unknown as ExtensionContext;
}

for (const failure of ["marker persistence", "quarantine replacement", "abort", "disposal", "claim mutation", "none"] as const) {
	test(`force settles before exclusion: ${failure}`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-settlement-"));
		const value = writeFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		let consent = false;
		const ctx = cleanupContext(value, warnings, async () => consent);
		const fetch = globalThis.fetch;
		const truncate = fs.ftruncateSync;
		const abortEntered = new Deferred<void>();
		const releaseAbort = new Deferred<void>();
		let cleaning: Promise<unknown> | undefined;
		let exclusions = 0;
		try {
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
			const original = ownershipEvidence(value);
			const before = evidence(value);
			const lock = fs.readFileSync(original.lockPath, "utf8");
			await api.command("herder-cleanup").handler("herder-plans --force", ctx);
			assert.equal(fs.readFileSync(original.lockPath, "utf8"), lock);
			assert.equal(factory.sessions[0]!.aborted, false);
			assert.deepEqual(evidence(value), before);
			const session = factory.sessions[0]!;
			const abort = session.abort.bind(session);
			session.abort = async () => {
				assertCleanupMarker(original);
				abortEntered.resolve();
				await releaseAbort.promise;
				await abort();
				if (failure === "claim mutation") {
					const record = JSON.parse(fs.readFileSync(original.lockPath, "utf8"));
					fs.writeFileSync(original.lockPath, JSON.stringify({ ...record, piSessionId: "replacement-session" }));
				}
				if (failure === "abort") throw Error("fixture abort failed");
			};
			if (failure === "disposal") session.dispose = () => { throw Error("fixture disposal failed"); };
			if (failure === "marker persistence" || failure === "quarantine replacement") fs.ftruncateSync = (descriptor, length) => {
				if (fs.fstatSync(descriptor).ino === original.stat.ino) {
					if (failure === "marker persistence") throw Error("fixture marker persistence failed");
					fs.renameSync(`${original.lockPath}.cleanup-required`, path.join(root, "old-quarantine"));
					fs.writeFileSync(`${original.lockPath}.cleanup-required`, "replacement evidence");
				}
				truncate(descriptor, length);
			};
			globalThis.fetch = async (input, init) => {
				if (new URL(String(input)).pathname === "/shutdown") {
					exclusions++;
					assert.equal(session.disposed, true, "worker disposal precedes service exclusion");
					assertCleanupMarker(original);
				}
				return fetch(input, init);
			};
			consent = true;
			cleaning = api.command("herder-cleanup").handler("herder-plans --force", ctx);
			if (failure !== "marker persistence" && failure !== "quarantine replacement") {
				await withDeadline(abortEntered.promise, "force abort");
				assert.equal(exclusions, 0);
				assert.deepEqual(evidence(value), before);
				releaseAbort.resolve();
			}
			await withDeadline(cleaning, "force completion");
			if (failure === "none") {
				assert.equal(exclusions, 1);
				assert.equal(fs.existsSync(value.planDirectory), false);
				assert.equal(fs.existsSync(before.plan!.worktree), false);
				assert.equal(fs.existsSync(`${original.lockPath}.cleanup-required`), false);
				assert.equal(fs.existsSync(`${value.planDirectory}.cleanup-required`), false);
				assert.ok(warnings.some(w => /Force cleanup executed/.test(w.message)), JSON.stringify(warnings));
				await api.invoke("session_shutdown", ctx);
				assert.equal(fs.existsSync(value.planDirectory), false);
			} else {
				assert.equal(exclusions, 0);
				assert.deepEqual(evidence(value), before);
				assert.ok(!warnings.some(w => /Force cleanup executed/.test(w.message)));
				assert.equal(fs.existsSync(original.lockPath), true);
				if (failure === "marker persistence") {
					assert.equal(fs.readFileSync(original.lockPath, "utf8"), lock);
					assert.equal(session.aborted, false);
					assert.equal(session.disposed, false);
					assert.equal(fs.statSync(original.lockPath).nlink, 2);
					assert.throws(() => acquireAdapterOwnership(value.planDirectory, "replacement", "replacement", {
						isProcessAlive: () => false,
					}), /manual child-process cleanup/);
				}
				else if (failure === "quarantine replacement") {
					assert.equal(fs.readFileSync(`${original.lockPath}.cleanup-required`, "utf8"), "replacement evidence");
					assert.equal(session.aborted, false);
					assert.equal(session.disposed, false);
					assert.ok(warnings.some(w => /quarantine was replaced/.test(w.message)), JSON.stringify(warnings));
					assertCleanupMarker(original);
				}
				else if (failure === "claim mutation") {
					assert.deepEqual(JSON.parse(fs.readFileSync(original.lockPath, "utf8")), { ...original.record, resetCleanupRequired: true, piSessionId: "replacement-session" });
					assert.ok(warnings.some(w => /evidence changed during settlement/.test(w.message)));
				} else assertCleanupMarker(original);
				await api.command("herder-cleanup").handler("herder-plans --force", ctx);
				assert.equal(exclusions, 0, "failed attempts never authorize a retry");
			}
		} finally {
			releaseAbort.resolve();
			await cleaning?.catch(() => {});
			globalThis.fetch = fetch;
			fs.ftruncateSync = truncate;
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const timing of ["before deletion", "after deletion", "during exclusion", "post deletion", "valid restoration"] as const) {
	test(`distinct adapter terminal recovery ${timing}`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-terminal-recovery-"));
		const value = writeFixture(root);
		const owner = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(owner as unknown as ExtensionAPI, new PendingWorkerFactory());
		const observer = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(observer as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = cleanupContext(value, warnings);
		const fetch = globalThis.fetch;
		const statusEntered = new Deferred<void>();
		const allowStatus = new Deferred<void>();
		const shutdownEntered = new Deferred<void>();
		const allowShutdown = new Deferred<void>();
		let recovery: Promise<unknown> | undefined;
		let cleaning: Promise<unknown> | undefined;
		try {
			const started = await pauseFixture(value);
			const recovered = restoredContext(value, started.before.run!.runId, warnings);
			const statuses: unknown[] = [];
			const recoveryCtx = { ...recovered, hasUI: true, ui: { ...ctx.ui,
				setStatus: (_key: string, text: unknown) => statuses.push(text),
			} } as ExtensionContext;
			let statusReads = ["during exclusion", "post deletion"].includes(timing) ? 1 : 0;
			globalThis.fetch = async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/shutdown") {
					shutdownEntered.resolve(); await allowShutdown.promise;
				}
				const response = await fetch(input, init);
				if (url.pathname === "/v1/status" && statusReads++ === 0) {
					const body = object(await response.json());
					const reply = { ...object(body.reply), status: "complete", actions: [], active: [] };
					statusEntered.resolve(); await allowStatus.promise;
					return Response.json({ ...body, reply });
				}
				return response;
			};
			if (["before deletion", "after deletion", "valid restoration"].includes(timing)) {
				recovery = observer.invoke("session_start", recoveryCtx);
				await withDeadline(statusEntered.promise, "terminal recovery status admitted");
			}
			if (timing !== "valid restoration") {
				cleaning = owner.command("herder-cleanup").handler("herder-plans --force", ctx);
				await withDeadline(shutdownEntered.promise, "force held after final manager drain");
				assert.equal(JSON.parse(fs.readFileSync(adapterOwnershipLockPath(value.planDirectory), "utf8")).resetCleanupRequired, true);
				if (timing === "during exclusion") recovery = observer.invoke("session_start", recoveryCtx);
				if (timing === "before deletion" || timing === "during exclusion") {
					allowStatus.resolve(); await withDeadline(recovery!, "terminal reply before deletion");
					assert.equal(observer.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY).length, 0);
					assert.ok(statuses.every(s => s === undefined));
				}
				allowShutdown.resolve();
				await withDeadline(cleaning, "force deletion");
				assert.equal(fs.existsSync(value.planDirectory), false, JSON.stringify(warnings));
				if (timing === "post deletion") recovery = observer.invoke("session_start", recoveryCtx);
			}
			allowStatus.resolve();
			await withDeadline(recovery!, "terminal recovery settles");
			assert.equal(observer.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY).length, timing === "valid restoration" ? 1 : 0);
			assert.equal(factory.requests.length, 0);
			if (timing !== "valid restoration") {
				assert.ok(statuses.every(s => s === undefined));
				assert.equal(fs.existsSync(value.planDirectory), false, "late callback must not recreate runtime");
			}
		} finally {
			allowStatus.resolve(); allowShutdown.resolve();
			await Promise.all([recovery, cleaning].map(p => p?.catch(() => {})));
			globalThis.fetch = fetch;
			await observer.invoke("session_shutdown", ctx).catch(() => {});
			await owner.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const target of ["distinct", "same"] as const) {
	test(`pre-ownership Fire and ${target}-target force cleanup keep target-specific admission`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-fire-isolation-"));
		const value = writeFixture(root);
		const other = path.join(value.repo, "other-plans");
		initPlanDir(other);
		const preflightEntered = new Deferred<void>();
		const allowPreflight = new Deferred<void>();
		const factory = new class extends PendingWorkerFactory {
			bindings = 0;
			bindModelRegistry() { this.bindings++; }
			override async availableModels() {
				preflightEntered.resolve(); await allowPreflight.promise;
				return super.availableModels();
			}
		}();
		const api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = cleanupContext(value, warnings);
		let firing: Promise<unknown> | undefined;
		try {
			await api.invoke("session_start", ctx);
			firing = api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
			await withDeadline(preflightEntered.promise, "pre-ownership Fire preflight");
			assert.equal(fs.existsSync(adapterOwnershipLockPath(value.planDirectory)), false);
			const bindings = factory.bindings;
			await api.command("herder-cleanup").handler(`${target === "same" ? "herder-plans" : "other-plans"} --force`, ctx);
			assert.equal(factory.bindings, bindings, "cleanup must not rebind another Fire's factory");
			allowPreflight.resolve();
			await withDeadline(firing, "Fire after target cleanup");
			if (target === "same") {
				assert.equal(factory.requests.length, 0);
				assert.equal(fs.existsSync(value.planDirectory), false);
				assert.ok(!warnings.some(w => /fire started/.test(w.message)));
			} else {
				await withDeadline(factory.sessions[0]!.started, "unrelated Fire worker starts");
				assert.equal(fs.existsSync(other), false);
				const durable = evidence(value);
				assert.equal(durable.run!.status, "running");
				assert.equal(durable.actions.filter(a => a.state === "dispatched").length, 1);
				assert.equal(durable.actions[0]!.hostHandle, `pi-worker:${factory.sessions[0]!.sessionId}`);
				assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
			}
		} finally {
			allowPreflight.resolve(); await firing?.catch(() => {});
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			await stopService(other).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("owned Fire A terminal advances its real database while force B awaits shutdown", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-owned-isolation-"));
	const value = writeFixture(root);
	const other = path.join(value.repo, "other-plans");
	initPlanDir(other);
	const api = new CapturedExtensionAPI();
	const factory = new PendingWorkerFactory();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
	const warnings: Warning[] = [];
	const ctx = cleanupContext(value, warnings);
	const fetch = globalThis.fetch;
	const excluding = new Deferred<void>();
	const allowExclusion = new Deferred<void>();
	const terminalAccepted = new Deferred<string>();
	let cleaning: Promise<unknown> | undefined;
	try {
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
		await ensureService(other);
		const serviceA = await ensureService(value.planDirectory);
		const before = evidence(value);
		const owner = ownershipEvidence(value);
		globalThis.fetch = async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/shutdown") { excluding.resolve(); await allowExclusion.promise; }
			const response = await fetch(input, init);
			if (url.pathname === "/v1/operation" && init?.method === "POST") {
				const body = object(JSON.parse(String(init.body)));
				if (body.kind === "event" && object(body.input).kind === "terminals") terminalAccepted.resolve(String(body.operationId));
			}
			return response;
		};
		cleaning = api.command("herder-cleanup").handler("other-plans --force", ctx);
		await withDeadline(excluding.promise, "B exclusion after manager drain");
		assert.equal(factory.sessions[0]!.aborted, false);
		factory.sessions[0]!.finish();
		const terminalId = await withDeadline(terminalAccepted.promise, "A terminal accepted during B exclusion");
		await withDeadline(waitManagerOperation(serviceA, terminalId), "A terminal durably applied");
		assert.notEqual(evidence(value).actions.find(action => action.actionId === before.actions[0]!.actionId)!.state, "dispatched");
		assert.equal(evidence(value).run!.runId, before.run!.runId);
		assert.equal(fs.statSync(owner.lockPath).ino, owner.stat.ino);
		assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
		allowExclusion.resolve();
		await withDeadline(cleaning, "B cleanup");
		assert.equal(fs.existsSync(other), false);
		assert.equal(evidence(value).run!.runId, before.run!.runId);
		assert.ok(!warnings.some(w => /completion handling failed/.test(w.message)), JSON.stringify(warnings));
	} finally {
		allowExclusion.resolve(); await cleaning?.catch(() => {});
		globalThis.fetch = fetch;
		await api.invoke("session_shutdown", ctx).catch(() => {});
		await stopService(value.planDirectory).catch(() => {});
		await stopService(other).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const disposalFails of [false, true]) {
	test(`force drains out-of-queue integration-repair FINAL_AUDIT preparation and disposal (${disposalFails ? "failure" : "success"})`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-final-prepare-"));
		const value = writeFixture(root);
		const createEntered = new Deferred<void>();
		const allowCreate = new Deferred<void>();
		const shutdownEntered = new Deferred<void>();
		const allowShutdown = new Deferred<void>();
		const disposalEntered = new Deferred<void>();
		const allowDisposal = new Deferred<void>();
		const marked = new Deferred<void>();
		let original: ReturnType<typeof ownershipEvidence>;
		const factory = new class extends PendingWorkerFactory {
			override async create(request: PiWorkerRequest) {
				if (request.action.workerMode !== "FINAL_AUDIT") return super.create(request);
				createEntered.resolve(); await allowCreate.promise;
				const created = this.createSession(request);
				Object.assign(created.session, { extensionRunner: { emit: async () => {
					assertCleanupMarker(original);
					shutdownEntered.resolve(); await allowShutdown.promise;
				} } });
				const dispose = created.session.dispose.bind(created.session);
				created.session.dispose = async () => {
					assertCleanupMarker(original);
					disposalEntered.resolve(); await allowDisposal.promise;
					if (disposalFails) throw Error("fixture final-audit disposal failed");
					dispose();
				};
				return created;
			}
		}();
		const api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const base = cleanupContext(value, warnings);
		const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionId: () => "repair-owner" } } as ExtensionContext;
		const fetch = globalThis.fetch;
		const fsync = fs.fsyncSync;
		let repair: Promise<unknown> | undefined;
		let cleaning: Promise<unknown> | undefined;
		let exclusions = 0;
		try {
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
			original = ownershipEvidence(value);
			const before = evidence(value);
			const service = await ensureService(value.planDirectory);
			const body = await requestService(service, "/v1/status");
			const reply = object(body.reply);
			const run = before.run!;
			const worktree = String(run.integrationWorktree);
			const git = (...args: string[]) => runCommand("git", ["-C", worktree, ...args]).stdout.trim();
			const head = git("rev-parse", "HEAD");
			const request = { requestId: "repair-fixture", requestSha256: "a".repeat(64), capabilityToken: "b".repeat(64),
				runId: run.runId, generation: run.currentGeneration, ownerSessionId: "repair-owner", state: "passed",
				classification: "code_defect", round: 1, maxRounds: 3, currentCommit: head, currentTree: git("rev-parse", "HEAD^{tree}"),
				integrationWorktree: worktree, integrationBranch: git("symbolic-ref", "--short", "HEAD"),
			};
			const finalReply = { ...reply, integrationRepair: request, actions: [{ ...factory.requests[0]!.action,
				actionId: "held-final-audit", planId: "RUN", role: "plan-reviewer", workerMode: "FINAL_AUDIT",
			}] };
			globalThis.fetch = async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/shutdown") {
					exclusions++;
					assert.equal(factory.sessions[1]!.disposed, true);
				}
				if (url.pathname === "/v1/status") return Response.json({ ...body, reply: { ...reply, integrationRepair: request, actions: [] } });
				if (url.pathname === "/v1/operation") {
					const posted = init?.method === "POST" ? object(JSON.parse(String(init.body))) : undefined;
					if (posted?.kind === "integration_repair" || url.searchParams.get("id") === "repair-final-fixture") {
						return Response.json({ ok: true, operation: { operationId: "repair-final-fixture", kind: "integration_repair", state: "succeeded", result: finalReply } });
					}
				}
				return fetch(input, init);
			};
			repair = api.tool("herder_integration_repair").execute("repair", {
				planDirectory: "herder-plans", operation: "finish", operationId: "repair-final-fixture",
				requestId: request.requestId, requestSha256: request.requestSha256, capabilityToken: request.capabilityToken,
				ownerSessionId: "repair-owner", observedCommit: head,
			}, undefined, undefined, ctx);
			const repairRejected = assert.rejects(repair, /cleanup|retired/);
			await withDeadline(createEntered.promise, "out-of-queue final-audit preparation");
			fs.fsyncSync = descriptor => {
				fsync(descriptor);
				if (fs.fstatSync(descriptor).ino === original.stat.ino && fs.fstatSync(descriptor).size > 0
					&& JSON.parse(fs.readFileSync(original.lockPath, "utf8")).resetCleanupRequired) marked.resolve();
			};
			let settled = false;
			cleaning = api.command("herder-cleanup").handler("herder-plans --force", ctx).finally(() => { settled = true; });
			await withDeadline(marked.promise, "force marker before final preparation drain");
			assert.equal(settled, false);
			assert.equal(exclusions, 0);
			allowCreate.resolve();
			await withDeadline(shutdownEntered.promise, "late final-audit extension shutdown");
			assert.equal(settled, false);
			assert.deepEqual(evidence(value), before);
			allowShutdown.resolve();
			await withDeadline(disposalEntered.promise, "held final-audit disposal");
			assert.equal(settled, false);
			assert.equal(exclusions, 0);
			assertCleanupMarker(original);
			allowDisposal.resolve();
			await withDeadline(Promise.all([repairRejected, cleaning]), "final-audit settlement before force");
			assert.equal(factory.sessions[1]!.prompted, false);
			assert.equal(exclusions, disposalFails ? 0 : 1);
			assert.equal(fs.existsSync(value.planDirectory), disposalFails);
			if (disposalFails) {
				assertCleanupMarker(original);
				assert.deepEqual(evidence(value), before);
				assert.ok(!warnings.some(w => /Force cleanup executed/.test(w.message)));
			} else assert.ok(warnings.some(w => /Force cleanup executed/.test(w.message)), JSON.stringify(warnings));
		} finally {
			allowCreate.resolve(); allowShutdown.resolve(); allowDisposal.resolve();
			await Promise.all([repair, cleaning].map(p => p?.catch(() => {})));
			globalThis.fetch = fetch; fs.fsyncSync = fsync;
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const operation of ["dashboard", "status"] as const) {
	test(`${operation} refuses marked evidence before starting a service`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-quarantined-dashboard-"));
		const value = writeFixture(root);
		const held = acquireAdapterOwnership(value.planDirectory, "fixture-run", "departed-session");
		const api = new CapturedExtensionAPI();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, new PendingWorkerFactory());
		const warnings: Warning[] = [];
		const ctx = cleanupContext(value, warnings);
		try {
			markAdapterOwnershipCleanupRequired(held);
			const before = fs.readdirSync(path.dirname(held.lockPath)).sort();
			await api.command(`herder-${operation}`).handler("herder-plans", ctx);
			assert.ok(warnings.some(w => /manual child-process cleanup/.test(w.message)), JSON.stringify(warnings));
			assert.deepEqual(fs.readdirSync(path.dirname(held.lockPath)).sort(), before, "no service or dashboard evidence created");
		} finally {
			releaseAdapterOwnership(held);
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of ["preexisting collision", "confirmation collision", "marker persistence", "ordinary dead owner"] as const) {
	test(`fresh context after force owner process exits: ${scenario}`, { timeout: 45_000 }, async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-owner-exit-"));
		const value = writeFixture(root);
		const resultFile = path.join(root, "owner.json");
		const lockPath = adapterOwnershipLockPath(value.planDirectory);
		const quarantine = `${lockPath}.cleanup-required`;
		const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CapturedExtensionAPI, CapturedUI, BaseSession, availableModels, agentRoot } from ${JSON.stringify(new URL("./helpers/harness.ts", import.meta.url).href)};
import { registerHerderPiWithWorkerFactory } from ${JSON.stringify(new URL("../../../adapters/index.ts", import.meta.url).href)};
import { HerderNestedAgentScope } from ${JSON.stringify(new URL("../../../adapters/nested-agent-executor.ts", import.meta.url).href)};
import { RunStore } from ${JSON.stringify(new URL("../../../src/daemon/run-store.ts", import.meta.url).href)};
const value = ${JSON.stringify(value)};
const scenario = ${JSON.stringify(scenario)};
const lockPath = ${JSON.stringify(lockPath)};
const quarantine = lockPath + ".cleanup-required";
const api = new CapturedExtensionAPI();
const ui = new CapturedUI();
const session = new class extends BaseSession {
	async prompt() { await new Promise(() => {}); }
	async abort() { throw Error("Failed marking must not abort workers"); }
}("force-owner-worker");
registerHerderPiWithWorkerFactory(api, {
	availableModels: async () => [...availableModels],
	create: async request => ({ session, nested: new HerderNestedAgentScope({
		action: request.action, agentRoot, createSession: async () => { throw Error("unused"); },
	}) }),
});
const ctx = { cwd: value.repo, hasUI: true, ui,
	sessionManager: { getEntries: () => [], getSessionId: () => "force-owner" },
	modelRegistry: { getAvailable: () => [...availableModels] }, model: availableModels[0], thinkingLevel: "xhigh",
	isProjectTrusted: () => true, isIdle: () => true,
};
await api.invoke("session_start", ctx);
await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
const store = new RunStore(value.planDirectory);
const run = store.getRun();
const plan = store.getPlan(run.runId, "001");
const actions = store.getActions(run.runId);
store.close();
const dashboardUrl = api.appendedEntries.findLast(e => e.data?.dashboardUrl)?.data.dashboardUrl;
assert.ok(dashboardUrl);
const before = { bytes: fs.readFileSync(lockPath, "utf8"), stat: fs.lstatSync(lockPath), runtime: fs.lstatSync(path.dirname(lockPath)), run, plan, actions, dashboardUrl };
fs.writeFileSync(path.join(plan.worktree, "retained-dirty-evidence"), "preserve me");
const refs = await api.exec("git", ["-C", value.repo, "show-ref"]);
let conflictingStat;
const conflict = () => {
	fs.writeFileSync(quarantine, "conflicting evidence", { flag: "wx" });
	conflictingStat = fs.lstatSync(quarantine);
};
if (scenario === "preexisting collision") conflict();
let confirmations = 0;
ui.confirm = async () => { confirmations++; if (scenario === "confirmation collision") conflict(); return true; };
const truncate = fs.ftruncateSync;
if (scenario === "marker persistence") fs.ftruncateSync = (fd, length) => {
	if (fs.fstatSync(fd).ino === before.stat.ino) throw Error("fixture marker persistence failed");
	return truncate(fd, length);
};
if (scenario !== "ordinary dead owner") await api.command("herder-cleanup").handler("herder-plans --force", ctx);
assert.equal(session.disposed, false);
assert.equal(fs.readFileSync(lockPath, "utf8"), before.bytes);
assert.deepEqual(await api.exec("git", ["-C", value.repo, "show-ref"]), refs);
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ before, conflictingStat, confirmations, warnings: ui.notifications }));
// Deliberately exit without session_shutdown or ownership release: the OS closes descriptors only.
process.exit(0);
`;
		const fetch = globalThis.fetch;
		try {
			const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
				encoding: "utf8", timeout: 30_000,
			});
			assert.equal(child.status, 0, child.stderr);
			const { before, conflictingStat, confirmations, warnings } = JSON.parse(fs.readFileSync(resultFile, "utf8"));
			assert.equal(confirmations, scenario === "confirmation collision" || scenario === "marker persistence" ? 1 : 0);
			assert.equal(before.stat.nlink, 1);
			assert.equal(JSON.parse(before.bytes).resetCleanupRequired, undefined);
			assert.equal(fs.readFileSync(lockPath, "utf8"), before.bytes);
			assert.equal(fs.lstatSync(lockPath).ino, before.stat.ino);
			assert.equal(fs.lstatSync(lockPath).dev, before.stat.dev);
			const runtime = fs.lstatSync(path.dirname(lockPath));
			assert.equal(runtime.ino, before.runtime.ino);
			assert.equal(runtime.dev, before.runtime.dev);
			assert.equal(fs.readFileSync(path.join(before.plan.worktree, "retained-dirty-evidence"), "utf8"), "preserve me");
			const durable = evidence(value);
			assert.deepEqual(durable.run, before.run);
			assert.deepEqual(durable.plan, before.plan);
			assert.deepEqual(durable.actions, before.actions);
			if (scenario === "ordinary dead owner") {
				assertAdapterRecoveryEvidence(value.planDirectory, readAdapterRuntimeIdentity(value.planDirectory));
				const replacement = acquireAdapterOwnership(value.planDirectory, "replacement", "replacement");
				try { assert.equal(replacement.record.runId, "replacement"); }
				finally { releaseAdapterOwnership(replacement); }
				assert.equal(fs.existsSync(quarantine), false);
				return;
			}
			assert.ok(warnings.some((w: Warning) => /manual child-process cleanup|fixture marker persistence failed/.test(w.message)), JSON.stringify(warnings));
			assert.ok(!warnings.some((w: Warning) => /Force cleanup executed/.test(w.message)));
			const retained = fs.lstatSync(quarantine);
			if (conflictingStat) {
				assert.equal(retained.ino, conflictingStat.ino);
				assert.equal(retained.dev, conflictingStat.dev);
				assert.equal(fs.readFileSync(quarantine, "utf8"), "conflicting evidence");
			}
			assert.equal(retained.ino === before.stat.ino, scenario === "marker persistence");
			assert.equal(fs.lstatSync(lockPath).nlink, scenario === "marker persistence" ? 2 : 1);
			const retainedBytes = fs.readFileSync(quarantine, "utf8");
			const files = fs.readdirSync(path.dirname(lockPath), { recursive: true }).sort();
			assert.throws(() => readAdapterRuntimeIdentity(value.planDirectory), /manual child-process cleanup/);
			assert.throws(() => assertAdapterRecoveryEvidence(value.planDirectory, runtime), /manual child-process cleanup/);
			assert.throws(() => acquireAdapterOwnership(value.planDirectory, "replacement", "replacement"), /manual child-process cleanup/);
			const api = new CapturedExtensionAPI();
			const factory = new PendingWorkerFactory();
			registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
			const recoveryWarnings: Warning[] = [];
			const restored = restoredContext(value, before.run.runId, recoveryWarnings);
			const statuses: unknown[] = [];
			const widgets: unknown[] = [];
			const ctx = { ...restored, hasUI: true, ui: { ...cleanupContext(value, recoveryWarnings).ui,
				setStatus: (_key: string, text: unknown) => statuses.push(text),
				setWidget: (_key: string, text: unknown) => widgets.push(text),
			} } as ExtensionContext;
			let serviceCalls = 0;
			globalThis.fetch = async (input, init) => {
				if (new URL(String(input)).origin === new URL(before.dashboardUrl).origin) {
					serviceCalls++;
					throw Error("quarantined recovery reached service");
				}
				return fetch(input, init);
			};
			await api.invoke("session_start", ctx);
			await api.invoke("session_shutdown", ctx);
			assert.equal(serviceCalls, 0);
			assert.ok(recoveryWarnings.some(w => /manual child-process cleanup/.test(w.message)), JSON.stringify(recoveryWarnings));
			assert.equal(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY).length, 0);
			assert.ok(statuses.every(s => s === undefined));
			assert.ok(widgets.every(w => w === undefined));
			assert.equal(factory.requests.length, 0);
			assert.deepEqual(fs.readdirSync(path.dirname(lockPath), { recursive: true }).sort(), files);
			assert.equal(fs.lstatSync(quarantine).ino, retained.ino);
			assert.equal(fs.lstatSync(quarantine).dev, retained.dev);
			assert.equal(fs.readFileSync(quarantine, "utf8"), retainedBytes);
			assert.equal(fs.lstatSync(lockPath).ino, before.stat.ino);
			assert.equal(fs.readFileSync(lockPath, "utf8"), before.bytes);
			t.diagnostic(JSON.stringify({ scenario,
				owner: { dev: before.stat.dev, ino: before.stat.ino, nlink: fs.lstatSync(lockPath).nlink },
				quarantine: { dev: retained.dev, ino: retained.ino },
				evidencePreserved: true, replacementRefused: true, recoveryRefused: true, serviceCalls,
			}));
		} finally {
			globalThis.fetch = fetch;
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of ["confirmation collision", "marker persistence", "distinct registration", "cancelled confirmation", "unrelated target"] as const) {
	test(`A8 active Fire terminal after force: ${scenario}`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-late-terminal-"));
		const value = writeFixture(root);
		const other = path.join(value.repo, "other-plans");
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		const cleaner = scenario === "distinct registration" ? new CapturedExtensionAPI() : api;
		const terminalHandled = new Deferred<void>();
		const onTerminal = PiWorkerEngine.prototype.onTerminal;
		const fetch = globalThis.fetch;
		const truncate = fs.ftruncateSync;
		const lockPath = adapterOwnershipLockPath(value.planDirectory);
		const quarantine = `${lockPath}.cleanup-required`;
		const warnings: Warning[] = [];
		let confirmations = 0;
		let terminalSubmissions = 0;
		let exclusions = 0;
		let markerAttempts = 0;
		const refused = scenario === "confirmation collision" || scenario === "marker persistence" || scenario === "distinct registration";
		const ctx = cleanupContext(value, warnings, async () => {
			confirmations++;
			if (scenario === "confirmation collision") {
				fs.writeFileSync(quarantine, "independent cleanup evidence\n", { flag: "wx" });
				assert.notEqual(fs.statSync(quarantine).ino, fs.statSync(lockPath).ino);
			}
			return scenario !== "cancelled confirmation";
		});
		const fileEvidence = (file: string) => {
			if (!fs.existsSync(file)) return null;
			const stat = fs.lstatSync(file);
			return { bytes: fs.readFileSync(file), dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
		};
		const states = () => structuredClone(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY));
		const refs = () => runCommand("git", ["-C", value.repo, "show-ref"]).stdout;
		try {
			// Disposal precedes onTerminal. Wrap the actual adapter listener so even a
			// refused callback must finish (including its manager queue) before assertions.
			PiWorkerEngine.prototype.onTerminal = function (listener) {
				return onTerminal.call(this, async terminal => {
					await listener(terminal);
					if (terminal.actionId === factory.requests[0]?.action.actionId) terminalHandled.resolve();
				});
			};
			registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
			PiWorkerEngine.prototype.onTerminal = onTerminal;
			if (cleaner !== api) registerHerderPiWithWorkerFactory(cleaner as unknown as ExtensionAPI, new PendingWorkerFactory());
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
			const session = factory.sessions[0]!;
			await withDeadline(session.started, "A8 active worker");
			const original = ownershipEvidence(value);
			const before = evidence(value);
			const beforeStates = states();
			const beforeRefs = refs();
			const beforeLock = fileEvidence(lockPath)!;
			const index = fileEvidence(path.join(value.planDirectory, "README.md"));
			const plan = fileEvidence(path.join(value.planDirectory, "001-recover-worker.md"));
			if (scenario === "unrelated target") {
				initPlanDir(other);
				await ensureService(other);
			}
			if (scenario === "marker persistence") fs.ftruncateSync = (fd, length) => {
				if (fs.fstatSync(fd).ino === original.stat.ino) {
					markerAttempts++;
					throw Error("A8 marker persistence failed");
				}
				truncate(fd, length);
			};
			globalThis.fetch = async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/shutdown") exclusions++;
				if (url.pathname === "/v1/operation" && init?.method === "POST") {
					const body = object(JSON.parse(String(init.body)));
					if (body.kind === "event" && object(body.input).kind === "terminals") terminalSubmissions++;
				}
				return fetch(input, init);
			};
			await withDeadline(cleaner.command("herder-cleanup").handler(`${scenario === "unrelated target" ? "other-plans" : "herder-plans"} --force`, ctx), "A8 force decision");
			assert.equal(confirmations, 1, JSON.stringify(warnings));
			assert.equal(session.aborted, false);
			assert.equal(session.disposed, false);
			assert.deepEqual(evidence(value), before);
			assert.equal(exclusions, scenario === "unrelated target" ? 1 : 0);
			if (refused) {
				assert.ok(warnings.some(w => w.level === "error"), JSON.stringify(warnings));
				assert.ok(!warnings.some(w => /Force cleanup executed/.test(w.message)));
			}
			if (scenario === "marker persistence") assert.ok(markerAttempts > 0);
			const retainedLock = fileEvidence(lockPath);
			const retainedQuarantine = fileEvidence(quarantine);
			assert.equal(retainedLock!.ino, original.stat.ino);
			assert.deepEqual(retainedLock!.bytes, beforeLock.bytes);
			if (refused && scenario !== "distinct registration") assert.ok(retainedQuarantine);
			if (scenario === "distinct registration") {
				assert.ok(warnings.some(w => /already owned by live Pi pid/.test(w.message)), JSON.stringify(warnings));
				assert.equal(original.record.pid, process.pid);
				assert.equal(retainedQuarantine, null);
			}
			if (scenario === "confirmation collision") {
				assert.equal(retainedQuarantine!.bytes.toString(), "independent cleanup evidence\n");
				assert.notEqual(retainedQuarantine!.ino, retainedLock!.ino);
			}
			if (scenario === "marker persistence") {
				assert.equal(retainedQuarantine!.ino, retainedLock!.ino);
				assert.equal(retainedLock!.nlink, 2);
			}
			session.finish();
			await withDeadline(terminalHandled.promise, "A8 actual terminal callback completion");
			assert.equal(session.disposed, true);
			if (refused) {
				assert.equal(terminalSubmissions, 0, "no late terminal submission");
				assert.deepEqual(evidence(value), before, "no run, action, plan or lease mutation");
				assert.equal(factory.requests.length, 1, "no successor");
				assert.deepEqual(states(), beforeStates, "no state publication");
				assert.equal(refs(), beforeRefs, "no ref publication");
				assert.deepEqual(fileEvidence(path.join(value.planDirectory, "README.md")), index);
				assert.deepEqual(fileEvidence(path.join(value.planDirectory, "001-recover-worker.md")), plan);
				assert.deepEqual(fileEvidence(lockPath), retainedLock, "ownership must remain held");
				assert.deepEqual(fileEvidence(quarantine), retainedQuarantine, "cleanup evidence must remain intact");
			} else {
				assert.equal(terminalSubmissions, 1, "control terminal reaches the manager");
				assert.equal(evidence(value).actions.find(a => a.actionId === before.actions[0]!.actionId)!.state, "terminal");
				assert.ok(factory.requests.length > 1, "control dispatches its retry");
				assert.equal(fs.statSync(lockPath).ino, original.stat.ino);
				assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
			}
		} finally {
			PiWorkerEngine.prototype.onTerminal = onTerminal;
			globalThis.fetch = fetch;
			fs.ftruncateSync = truncate;
			if (cleaner !== api) await cleaner.invoke("session_shutdown", ctx).catch(() => {});
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			await stopService(other).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("force B settles an admitted A terminal HTTP 500 without attributing A's failure to B", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-terminal-isolation-"));
	const value = writeFixture(root);
	const other = path.join(value.repo, "other-plans");
	initPlanDir(other);
	const otherLock = adapterOwnershipLockPath(other);
	const api = new CapturedExtensionAPI();
	const factory = new PendingWorkerFactory();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
	const warnings: Warning[] = [];
	const ctx = cleanupContext(value, warnings);
	const submitted = new Deferred<void>();
	const releaseResponse = new Deferred<void>();
	const terminalHandled = new Deferred<void>();
	const marked = new Deferred<void>();
	const fetch = globalThis.fetch;
	const fsync = fs.fsyncSync;
	const notify = ctx.ui.notify.bind(ctx.ui);
	ctx.ui.notify = (text, level) => {
		notify(text, level);
		if (/completion handling failed/.test(text)) terminalHandled.resolve();
	};
	let cleaning: Promise<unknown> | undefined;
	let settled = false;
	let exclusions = 0;
	let terminals = 0;
	try {
		await api.invoke("session_start", ctx);
		await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", ctx);
		await withDeadline(factory.sessions[0]!.started, "A worker start");
		await ensureService(other);
		const before = evidence(value);
		const owner = ownershipEvidence(value);
		const ownerBytes = fs.readFileSync(owner.lockPath);
		const states = structuredClone(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY));
		globalThis.fetch = async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/shutdown") exclusions++;
			if (url.pathname === "/v1/operation" && init?.method === "POST") {
				const body = object(JSON.parse(String(init.body)));
				if (body.kind === "event" && object(body.input).kind === "terminals" && ++terminals === 1) {
					submitted.resolve();
					await releaseResponse.promise;
					return Response.json({ ok: false, error: "fixture unrelated A terminal failed" }, { status: 500 });
				}
			}
			return fetch(input, init);
		};
		factory.sessions[0]!.finish();
		await withDeadline(submitted.promise, "A terminal admitted before B settlement snapshot");
		fs.fsyncSync = descriptor => {
			fsync(descriptor);
			try {
				if (fs.fstatSync(descriptor).ino === fs.statSync(otherLock).ino
					&& JSON.parse(fs.readFileSync(otherLock, "utf8")).resetCleanupRequired === true) marked.resolve();
			} catch { /* Other descriptors and the intermediate invalidation are not the durable marker. */ }
		};
		cleaning = api.command("herder-cleanup").handler("other-plans --force", ctx).finally(() => { settled = true; });
		await withDeadline(marked.promise, "B durable marker before A rejection");
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false, "B still waits admitted manager work, even for A");
		assert.equal(exclusions, 0);
		assert.equal(fs.existsSync(other), true);
		releaseResponse.resolve();
		await withDeadline(Promise.all([cleaning, terminalHandled.promise]), "A failure and B cleanup settle");
		assert.equal(exclusions, 1, "A failure must not prevent B service exclusion");
		assert.equal(fs.existsSync(other), false);
		assert.equal(fs.existsSync(`${other}.cleanup-required`), false, "no spurious retained B evidence");
		assert.equal(terminals, 1);
		assert.equal(factory.sessions[0]!.aborted, false, "B must not cancel A");
		assert.deepEqual(evidence(value), before, "A's failed HTTP request cannot mutate its durable run");
		assert.equal(fs.statSync(owner.lockPath).ino, owner.stat.ino);
		assert.equal(fs.statSync(owner.lockPath).dev, owner.stat.dev);
		assert.deepEqual(fs.readFileSync(owner.lockPath), ownerBytes, "B must not mark or release A ownership");
		assert.deepEqual(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY), states);
		assert.equal(warnings.filter(w => /completion handling failed: fixture unrelated A terminal failed/.test(w.message)).length, 1);
		assert.ok(warnings.some(w => /Force cleanup executed/.test(w.message)), JSON.stringify(warnings));
		assert.ok(!warnings.some(w => /settlement failed; ownership retained/.test(w.message)), JSON.stringify(warnings));

		// A keeps its ownership and can legitimately recover its unrecorded terminal.
		await api.command("herder-attach").handler("herder-plans", ctx);
		assert.equal(factory.sessions.length, 2, JSON.stringify(warnings));
		await withDeadline(factory.sessions[1]!.started, "A recovery dispatches its retry after B deletion");
		assert.equal(terminals, 2);
		assert.equal(evidence(value).run!.runId, before.run!.runId);
		assert.equal(evidence(value).actions.find(a => a.actionId === before.actions[0]!.actionId)!.state, "terminal");
		assert.deepEqual(fs.readFileSync(owner.lockPath), ownerBytes);
		assert.ok(warnings.some(w => /Attached to Herder run/.test(w.message)), JSON.stringify(warnings));
		assert.equal(fs.existsSync(other), false, "unrelated progress must not recreate B");
	} finally {
		releaseResponse.resolve();
		await cleaning?.catch(() => {});
		globalThis.fetch = fetch;
		fs.fsyncSync = fsync;
		await api.invoke("session_shutdown", ctx).catch(() => {});
		await stopService(value.planDirectory).catch(() => {});
		await stopService(other).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const first of ["manager", "worker"] as const) {
	test(`force retains marked ownership after admitted terminal HTTP 500 (${first} settles first)`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-force-pending-terminal-"));
		const value = writeFixture(root);
		const index = path.join(value.planDirectory, "README.md");
		const row = "| [001](001-recover-worker.md) | Recover a lost worker | P1 | S | — | TODO |";
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(row, `${row}\n${row.replaceAll("001", "002")}`));
		fs.writeFileSync(path.join(value.planDirectory, "002-recover-worker.md"),
			fs.readFileSync(path.join(value.planDirectory, "001-recover-worker.md"), "utf8").replaceAll("001", "002").replaceAll("src/value.mjs", "src/other.mjs"));
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const warnings: Warning[] = [];
		const ctx = cleanupContext(value, warnings);
		const submitted = new Deferred<void>();
		const releaseResponse = new Deferred<void>();
		const abortEntered = new Deferred<void>();
		const releaseAbort = new Deferred<void>();
		const terminalHandled = new Deferred<void>();
		const workerDisposed = new Deferred<void>();
		const notify = ctx.ui.notify.bind(ctx.ui);
		ctx.ui.notify = (text, level) => {
			notify(text, level);
			if (/completion handling failed/.test(text)) terminalHandled.resolve();
		};
		const fetch = globalThis.fetch;
		let cleaning: Promise<unknown> | undefined;
		let settled = false;
		let exclusions = 0;
		let terminals = 0;
		try {
			await api.invoke("session_start", ctx);
			await api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 2", ctx);
			assert.equal(factory.sessions.length, 2);
			await Promise.all(factory.sessions.map(session => session.started));
			const original = ownershipEvidence(value);
			const before = evidence(value);
			const states = structuredClone(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY));
			const worker = factory.sessions[1]!;
			const abort = worker.abort.bind(worker);
			worker.abort = async () => {
				assertCleanupMarker(original);
				abortEntered.resolve();
				await releaseAbort.promise;
				await abort();
			};
			const dispose = worker.dispose.bind(worker);
			worker.dispose = () => { dispose(); workerDisposed.resolve(); };
			globalThis.fetch = async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/shutdown") exclusions++;
				if (url.pathname === "/v1/operation" && init?.method === "POST") {
					const body = object(JSON.parse(String(init.body)));
					if (body.kind === "event" && object(body.input).kind === "terminals") {
						terminals++;
						submitted.resolve();
						await releaseResponse.promise;
						assertCleanupMarker(original);
						return Response.json({ ok: false, error: "fixture admitted terminal failed" }, { status: 500 });
					}
				}
				return fetch(input, init);
			};
			factory.sessions[0]!.finish();
			await withDeadline(submitted.promise, "terminal submit admitted before force");
			cleaning = api.command("herder-cleanup").handler("herder-plans --force", ctx).finally(() => { settled = true; });
			await withDeadline(abortEntered.promise, "marked force starts worker drain");
			assert.equal(settled, false);
			if (first === "manager") {
				releaseResponse.resolve();
				await withDeadline(terminalHandled.promise, "HTTP failure handled while worker remains pending");
			} else {
				releaseAbort.resolve();
				await withDeadline(workerDisposed.promise, "worker disposed while manager remains pending");
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(settled, false, "force must await both manager and worker settlement, even after rejection");
			assert.equal(exclusions, 0);
			assertCleanupMarker(original);
			assert.deepEqual(evidence(value), before);
			releaseResponse.resolve(); releaseAbort.resolve();
			await withDeadline(Promise.all([cleaning, terminalHandled.promise, workerDisposed.promise]), "failed force settlement");
			assert.ok(factory.sessions.every(session => session.disposed));
			assert.equal(terminals, 1);
			assert.equal(exclusions, 0, "failed admitted manager task forbids service exclusion/deletion");
			assertCleanupMarker(original);
			assert.deepEqual(evidence(value), before);
			assert.deepEqual(api.appendedEntries.filter(e => e.customType === HERDER_STATE_ENTRY), states);
			assert.ok(warnings.some(w => /settlement failed; ownership retained/.test(w.message)), JSON.stringify(warnings));
			assert.ok(!warnings.some(w => /Force cleanup executed/.test(w.message)));
			const offset = warnings.length;
			await api.command("herder-attach").handler("herder-plans", ctx);
			await api.command("herder-cleanup").handler("herder-plans --force", ctx);
			assert.ok(warnings.slice(offset).every(w => w.level === "error" && /force cleanup closed this target/.test(w.message)), JSON.stringify(warnings.slice(offset)));
			assert.equal(warnings.length - offset, 2);
			assert.equal(factory.requests.length, 2, "local exclusion prevents successors and recovery");
			assert.equal(exclusions, 0);
			assertCleanupMarker(original);
		} finally {
			releaseResponse.resolve(); releaseAbort.resolve();
			await cleaning?.catch(() => {});
			globalThis.fetch = fetch;
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
