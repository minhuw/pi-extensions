import { confirmRunRevision, prepareRunRevision, readRunRevision, writeRunRevision } from "../../../src/core/run-revision.ts";
import { applyHerderReset } from "../../../src/application/tools.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { PiWorkerRequest, PiWorkerSessionFactory } from "../../../adapters/worker-engine.ts";
import { HerderNestedAgentScope } from "../../../adapters/nested-agent-executor.ts";
import { HERDER_STATE_ENTRY } from "../../../adapters/state.ts";
import {
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
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
	requestService, stopService } from "../../../src/client/index.ts";
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

test("main-session attention re-exposes the current request and refuses obsolete selective rejection", { timeout: 30_000 }, async () => {
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
		assert.match(api.customMessages[0]!.content, /^HERDER_MAIN_SESSION_ATTENTION_V1/m);
		assert.match(api.customMessages[0]!.content, /REQUEST_ID:/);
		assert.doesNotMatch(api.customMessages[0]!.content, /REQUEST_SHA256|CAPABILITY_TOKEN|RECOVERY_GIT_IDENTITY|schemaVersion|exact request binding/);
		const messageDetails = object(api.customMessages[0]!.details);
		assert.equal(messageDetails.planId, "001");
		assert.equal(messageDetails.cause, "initial_decision_blocked");
		assert.equal(messageDetails.role, "plan-implementer");
		assert.equal(messageDetails.round, 1);
		assert.equal(messageDetails.nextAction, "Propose/review a whole-run revision; abandon is available.");
		assert.equal(Object.hasOwn(messageDetails, "capabilityToken"), false);
		assert.deepEqual(api.customMessages[0]!.options, { deliverAs: "followUp", triggerTurn: true });

		await withDeadline(api.invoke("agent_settled", ctx), "attention agent_settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(api.customMessages.length, 1, "passive settled events duplicated the attention request");
		await api.command("herder-status").handler("herder-plans", ctx);
		assert.equal(api.customMessages.length, 2);
		assert.equal(api.customMessages[1]!.content, api.customMessages[0]!.content);
		assert.equal(warnings.some((warning) => warning.level === "error"), false);

		const resolved = object(await api.tool("herder_plan").execute(
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
		));
		assert.equal(resolved.isError, true);
		assert.match(String((resolved.content as Array<{ text: string }>)[0]!.text), /requires revise_run or explicit abandon_run/);
		const unchanged = object((await requestService(service, "/v1/status")).reply);
		assert.equal(object(unchanged.attention).requestId, attention.requestId);
		assert.equal(api.customMessages.length, 2, "no selective action consumes the current request");
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
			reply = await complete(reviewer, "VERDICT: REVISE\nSCOPE: PASS\nFINDINGS: [F1][P1][BLOCKING][PLAN_REQUIREMENT] src/value.mjs:1 — required regression check fails\nFIX_GUIDANCE: [F1] make the regression check pass\nCHECKS: required regression check — FAILED\nRATIONALE: Original acceptance remains unmet");
			if (round === 2) {
				const judge = object((reply.actions as unknown[])[0]);
				assert.equal(judge.role, "plan-judge");
				reply = await complete(judge, "DECISION: REPAIR\nFINDINGS: [F1][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] required check fails\nAUTHORIZED_BLOCKERS: F1\nREPAIR_CONTRACTS: [F1] expected=required regression check passes; constraints=original scope\nPASS_DOCUMENT: Resolve F1, run the required regression check, and preserve original scope. No rejected findings or unresolved decisions.\nCHECKS: required regression check — FAILED\nRATIONALE: One bounded rescue remains");
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
		assert.equal(object(delivered.details).nextAction, "Propose/review a whole-run revision; abandon is available.");
		const params = {
			operation: "attention", planDirectory: fixture.planDirectory, requestId: attention.requestId,
			action: "accept", answer: "Accept F1 and waive the unmet regression-check requirement for this exact plan tree.",
			rationale: "The user accepts the current implementation with this specific gap.",
			confirmed: true, // Untrusted model input must not bypass a declined host confirmation.
		};
		const declined = object(await api.tool("herder_plan").execute("decline", params, undefined, undefined, ctx));
		assert.equal(declined.isError, true);
		assert.match(String((declined.content as Array<{ text: string }>)[0]!.text), /requires revise_run or explicit abandon_run/);
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
		const result = object(await api.tool("herder_plan").execute(
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
		));
		assert.equal(result.isError, true);
		assert.match(String((result.content as Array<{ text?: string }>)[0]?.text), /No unresolved Herder attention request|does not own/);
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

		await withDeadline(api.invoke("session_shutdown", ctx), "shutdown during attach dispatch", 2_000);
		assert.equal(fs.existsSync(lockPath), true, "ownership released before the admitted manager task drained");
		factory.allowCreate.resolve();
		await withDeadline(attaching, "stale attach completion");
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
		await withDeadline(retiringApi.invoke("session_shutdown", retiringContext), "retiring adapter shutdown", 2_000);
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
		await withDeadline(retiringAttach, "retiring attach drain");
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
		assert.match(message.content, /PROPOSE a concrete whole-run graph revision directly/);
		assert.match(message.content, /skills\/plans\/references\/plan-format\.md.*skills\/plans\/references\/plan-template\.md completely/);
		assert.match(message.content, /product\/execution boundary/);
		assert.match(message.content, /cold-read the complete affected plan snapshots/);
		assert.match(message.content, /draft Markdown writes are allowed without execution approval/);
		assert.match(message.content, /Do not run source setup, dependency installation, tests, builds/);
		assert.equal(factory.sessions.length, 1);
		await withDeadline(factory.sessions[0]!.started, "initial sibling started");
		const oldWorktree = factory.requests[0]!.action.worktree;
		const sentinel = path.join(oldWorktree, "old-execution-evidence.txt");
		fs.writeFileSync(sentinel, "keep until final approval");
		const requestId = object(message.details).requestId;
		const opened = object(await api.tool("herder_plan").execute("revise", { operation: "attention", planDirectory: value.planDirectory, requestId, action: "revise_run" }, undefined, undefined, ctx));
		assert.equal(opened.isError, undefined, JSON.stringify(opened));
		const record = readRunRevision(value.planDirectory)!;
		assert.equal(factory.sessions[0]!.aborted, true, "begin returns graph authority only after all old workers settle");
		assert.ok(fs.existsSync(sentinel));
		const store = new RunStore(value.planDirectory, { readOnly: true });
		try { assert.equal(store.countActions(record.run.runId, { states: ["proposed", "dispatched"] }), 0); } finally { store.close(); }
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("BLOCKED — needs attention", "TODO"));
		fs.writeFileSync(path.join(value.planDirectory, "001-recover-worker.md"), fixturePlan({ title: "Recover a lost worker", acceptance: "Entire execution uses the revised assignment." }));
		const params = { operation: "finish_edit", planDirectory: value.planDirectory, editToken: record.editToken, confirmed: true };
		const dismissed = object(await api.tool("herder_plan").execute("dismiss", params, undefined, undefined, ctx));
		assert.equal(dismissed.isError, true);
		assert.match(String((dismissed.content as Array<{ text: string }>)[0]!.text), /Confirmation dismissed/);
		assert.ok(fs.existsSync(sentinel));
		assert.equal(factory.requests.length, 1);
		assert.equal(readRunRevision(value.planDirectory)?.state, "prepared");
		consent = true;
		const finished = object(await api.tool("herder_plan").execute("approve", params, undefined, undefined, ctx));
		assert.equal(finished.isError, undefined, JSON.stringify(finished));
		assert.equal(confirmations.length, 2);
		assert.ok(confirmations.every(body => body.includes(record.run.runId) && body.includes(record.run.baseCommit) && body.includes(String(requestId))));
		assert.equal(fs.existsSync(sentinel), false);
		assert.equal(factory.requests.length, 3);
		assert.ok(factory.requests.slice(1).every(request => request.action.runId === record.run.runId && request.action.generation === record.run.currentGeneration + 1));
		assert.ok(confirmations.every(body => /Retain completed plans: none/.test(body) && /Rerun plans: 001, 002/.test(body)));
		assert.ok(confirmations.every(body => !/deleting every old execution|no selective reuse/.test(body)));
		assert.ok(factory.requests.slice(1).some(request => fs.readFileSync(request.action.assignmentPath, "utf8").includes("Entire execution uses the revised assignment")));
		assert.equal(readRunRevision(value.planDirectory)?.state, "complete");
	} finally {
		if (api && ctx) await withDeadline(api.invoke("session_shutdown", ctx), "whole-run fixture shutdown").catch(() => {});
		if (value) await stopService(value.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function reserveWholeRunFixture(value: Fixture) {
	const manager = new HerderRunManager(value.planDirectory);
	try {
		const reply = await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDirectory, profile: "eclipse", maxParallel: 1 });
		await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(reply.attention!), action: "revise_run" } });
	} finally { manager.close(); }
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
			const result = object(await api.tool("herder_plan").execute("recover", { operation, planDirectory: value.planDirectory, editToken: record.editToken }, undefined, undefined, ctx));
			if (operation === "finish_edit") {
				assert.equal(result.isError, true);
				assert.match(String((result.content as Array<{ text: string }>)[0]!.text), /Confirmation dismissed/);
			} else assert.equal(result.isError, undefined, JSON.stringify(result));
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
	test(`${recovery} restores exact whole-run attention for confirmed abandonment without status`, { timeout: 40_000 }, async () => {
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
				const recovered = object(await api.tool("herder_plan").execute("recover", { operation: recovery, planDirectory: value.planDirectory, editToken: record.editToken }, undefined, undefined, ctx));
				assert.equal(recovered.isError, recovery === "finish_edit" ? true : undefined, JSON.stringify(recovered));
				if (recovery === "finish_edit") assert.match(String((recovered.content as Array<{ text: string }>)[0]!.text), /Confirmation dismissed/);
			}
			await api.invoke("agent_settled", ctx);
			const delivered = await withDeadline(api.waitForAttentionMessage(), "recovered revision attention");
			assert.equal(object(delivered.details).requestId, record.request.requestId);
			assert.ok(api.customMessages.every(message => object(message.details).requestId === record.request.requestId));
			const params = { operation: "attention", planDirectory: value.planDirectory, requestId: record.request.requestId, action: "abandon_run" };
			const count = confirmations.length;
			const wrong = object(await api.tool("herder_plan").execute("wrong-request", { ...params, requestId: queued[1]!.requestId }, undefined, undefined, ctx));
			assert.equal(wrong.isError, true);
			assert.equal(confirmations.length, count);
			const dismissed = object(await api.tool("herder_plan").execute("dismiss-abandon", params, undefined, undefined, ctx));
			assert.equal(dismissed.isError, true);
			assert.match(String((dismissed.content as Array<{ text: string }>)[0]!.text), /Confirmation dismissed/);
			assert.equal(confirmations.length, count + 1);
			assert.match(confirmations.at(-1)!, /^Abandon this entire Herder execution\?/);
			assert.ok(confirmations.at(-1)!.includes(record.request.requestId));
			const pending = new RunStore(value.planDirectory, { readOnly: true });
			try {
				assert.equal(pending.getRun()!.runId, record.run.runId);
				assert.deepEqual(pending.getAttentionRequests(record.run.runId, { unresolvedOnly: true }), queued);
				assert.equal(pending.getActions(record.run.runId).length, 0);
			} finally { pending.close(); }
			assert.equal(factory.requests.length, 0);
			consent = true;
			const abandoned = object(await api.tool("herder_plan").execute("confirm-abandon", params, undefined, undefined, ctx));
			assert.equal(abandoned.isError, undefined, JSON.stringify(abandoned));
			assert.equal(readRunRevision(value.planDirectory)?.state, "abandoned");
			const after = new RunStore(value.planDirectory, { readOnly: true });
			try { assert.equal(after.getRun(), null); } finally { after.close(); }
			assert.equal(factory.requests.length, 0, "recovery and abandonment must never resume or dispatch workers");
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
			const rejected = object(await api.tool("herder_plan").execute("stale-abandon", { operation: "attention", planDirectory: value.planDirectory, requestId: record.request.requestId, action: "abandon_run" }, undefined, undefined, ctx));
			assert.equal(rejected.isError, true);
			assert.match(String((rejected.content as Array<{ text: string }>)[0]!.text), /No unresolved Herder attention request/);
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
		const factory = new class extends GatedPrepareWorkerFactory {
			protected override createSession(request: PiWorkerRequest) {
				const created = super.createSession(request);
				if (this.sessions.length !== 1) return created;
				const dispose = created.session.dispose.bind(created.session);
				created.session.dispose = () => {
					assertCleanupMarker(original);
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
			await withDeadline(api.invoke("session_shutdown", ctx), "shutdown before late preparation", 2_000);
			assertCleanupMarker(original);
			// A new session schedules idle retirement while the old admitted task is still pending.
			await api.invoke("session_start", ctx);
			const freshRecovery = outcome === "success with queued recovery"
				? api.invoke("session_start", restoredContext(value, original.record.runId, []))
				: undefined;
			factory.allowCreate.resolve();
			await withDeadline(attaching, "late attach completion");
			await withDeadline(waitForAdapterOwnershipRetirement(value.planDirectory), "ownership retirement");
			assert.equal(factory.sessions[0]!.prompted, false);
			assert.equal(factory.sessions[0]!.disposed, !disposalFails);
			if (!freshRecovery) {
				assert.equal(factory.sessions.length, 1);
				assert.equal(evidence(value).actions.some(action => action.state === "dispatched"), false);
			}
			if (disposalFails) await assertDeadOwnerRefused(value, original);
			else {
				if (!freshRecovery) assert.equal(fs.existsSync(original.lockPath), false, "successful retirement must release the marked claim despite session_start");
				await withDeadline(freshRecovery ?? api.invoke("session_start", restoredContext(value, original.record.runId, [])), "fresh session recovery");
				await withDeadline(factory.sessions[1]!.started, "fresh session worker start");
				assert.equal(ownershipEvidence(value).record.resetCleanupRequired, undefined);
			}
		} finally {
			factory.allowCreate.resolve();
			if (attaching) await withDeadline(attaching, "late attach cleanup").catch(() => {});
			await api.invoke("session_shutdown", ctx).catch(() => {});
			await stopService(value.planDirectory).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

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
				assert.ok(notifications.slice(offset).some(entry => /manual.*cleanup/i.test(entry.message)), name);
			}
			const result = await api.tool("herder_plan").execute("unsafe-edit", { operation: "finish_edit", planDirectory: value.planDirectory, editToken: "unsafe" }, undefined, undefined, ctx);
			assert.equal(object(result).isError, true);
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

for (const action of ["revise_run", "abandon_run"] as const) {
	test(`queued ${action} attention cannot mutate after root disposal latches exclusion`, { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-queued-attention-"));
		const value = writeBlockedAttentionFixture(root);
		const api = new CapturedExtensionAPI();
		const factory = new PendingWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const unsafe = new Deferred<void>();
		const queueHeld = new Deferred<void>();
		const releaseQueue = new Deferred<void>();
		const bound = new Deferred<void>();
		const base = freshContext(value, []);
		const ctx = { ...base, ui: { ...base.ui, notify(text: string) {
			if (/manual.*cleanup/i.test(text)) unsafe.resolve();
		} } } as ExtensionContext;
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
			let actionReads = 0;
			let attentionSettled = false;
			attention = api.tool("herder_plan").execute("queued-attention", {
				operation: "attention", planDirectory: value.planDirectory, requestId: object(message.details).requestId,
				// The second read builds applicationParams only after bindAttention returned safely.
				get action() { if (++actionReads === 2) bound.resolve(); return action; },
			}, undefined, undefined, ctx).finally(() => { attentionSettled = true; });
			await withDeadline(bound.promise, "attention bound before exclusion");
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
			const result = object(await withDeadline(attention, "queued attention rejected"));
			assert.equal(result.isError, true);
			assert.match(String((result.content as Array<{ text: string }>)[0]!.text), /manual.*cleanup/i);
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
