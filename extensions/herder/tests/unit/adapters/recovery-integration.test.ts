import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ModelRegistry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { PiWorkerRequest, PiWorkerSessionFactory } from "../../../adapters/worker-engine.ts";
import { HerderNestedAgentScope } from "../../../adapters/nested-agent-executor.ts";
import { HERDER_STATE_ENTRY } from "../../../adapters/state.ts";
import {
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
	releaseAdapterOwnership,
	type AdapterOwnership,
} from "../../../adapters/ownership.ts";
import { registerHerderPiWithWorkerFactory } from "../../../adapters/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { ensureService, requestService, stopService } from "../../../src/client/index.ts";
import { GitDriver, git, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/roles/pi");

const availableModels = [
	{
		provider: "fake",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	{
		provider: "fake",
		id: "gpt-5.6-luna",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
] as const;

type JsonObject = Record<string, unknown>;

type CapturedHandler = (event: unknown, ctx: unknown) => unknown;

interface Fixture {
	root: string;
	repo: string;
	planDirectory: string;
}

interface Warning {
	message: string;
	level: string;
}

class Deferred<T = void> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => { this.resolvePromise = resolve; });
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

function object(value: unknown): JsonObject {
	return value as JsonObject;
}

function writeFixture(root: string): Fixture {
	const repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Herder Adapter Recovery Test"]);
	git(repo, ["config", "user.email", "herder-adapter-recovery@example.invalid"]);
	fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
		name: "herder-adapter-recovery-fixture",
		private: true,
		type: "module",
		scripts: { test: "node --test" },
	}, null, 2)}\n`);
	fs.writeFileSync(path.join(repo, "src", "value.mjs"), "export const value = 1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: create recovery fixture"]);
	const originalHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

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
	fs.writeFileSync(path.join(planDirectory, "001-recover-worker.md"), `# Plan 001: Recover a lost worker

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${originalHead.slice(0, 8)}\`, 2026-08-10
- **Kind**: behavioral
- **Parent objective**: Prove a replacement Pi session recovers one lost worker without duplicate scheduling.

## Why this matters

This fixture exercises the adapter and manager lifecycle at the point where an in-process Pi worker disappears.

## Current state

- \`src/value.mjs\` contains the fixture source.
- The manager has one ready plan and no provider or credential dependency.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: one worker recovery transition.
- **Safe intermediate state**: the fixture repository remains unchanged.

## Scope

**In scope**:
- \`src/value.mjs\`

**Out of scope**:
- Package metadata, dependencies, and the test contract.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Hold the worker slot

Leave the fixture source unchanged while the manager exercises worker recovery.

**Verify**: \`npm test\` → exits 0.

## Test plan

- Run \`npm test\`.
- Inspect manager and Git lease evidence.

## Review map

- **Outcome**: one missing built-in worker produces one same-round retry.
- **Modified symbols**: none in the fixture.
- **Proof**: manager recovery assertions.

## Done criteria

- [ ] \`npm test\` exits 0.
- [ ] One same-round retry is dispatched after worker loss.

## STOP conditions

Stop if the manager cannot preserve the plan generation, round, or worktree lease.

## Maintenance notes

Keep the recovery fixture small and provider-free.
`);
	return { root, repo, planDirectory };
}

function writeBlockedAttentionFixture(root: string): Fixture {
	const fixture = writeFixture(root);
	const index = fs.readFileSync(path.join(fixture.planDirectory, "README.md"), "utf8");
	fs.writeFileSync(path.join(fixture.planDirectory, "README.md"), index.replace("| TODO |", "| BLOCKED — needs attention |"));
	return fixture;
}

class CapturedExtensionAPI {
	readonly handlers = new Map<string, CapturedHandler>();
	readonly warnings: Warning[] = [];
	readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];
	readonly messages: Array<{ customType: string; content: string; display: boolean; details?: unknown; options?: unknown }> = [];
	readonly tools: unknown[] = [];
	readonly commands = new Map<string, unknown>();

	on(event: string, handler: CapturedHandler): void {
		this.handlers.set(event, handler);
	}

	registerTool(tool: unknown): void {
		this.tools.push(tool);
	}

	registerCommand(name: string, options: unknown): void {
		this.commands.set(name, options);
	}

	registerEntryRenderer(_customType: string, _renderer: unknown): void {}

	async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const result = runCommand(command, args, { allowFailure: true });
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	sendUserMessage(_content: unknown, _options?: unknown): void {}

	sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: unknown): void {
		this.messages.push({ ...message, ...(options === undefined ? {} : { options }) });
	}

	async invoke(event: string, ctx: ExtensionContext): Promise<unknown> {
		const handler = this.handlers.get(event);
		if (!handler) throw new Error(`No captured ${event} handler`);
		return await handler({}, ctx);
	}

	command(name: string): { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> } {
		const command = this.commands.get(name) as { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> } | undefined;
		if (!command) throw new Error(`No captured ${name} command`);
		return command;
	}

	tool(name: string): { execute: (...args: unknown[]) => Promise<unknown> } {
		const tool = this.tools.find((candidate) => (candidate as { name?: unknown }).name === name) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		if (!tool) throw new Error(`No captured ${name} tool`);
		return tool;
	}
}

class PendingSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/herder-recovery-session.jsonl";
	readonly messages: unknown[] = [];
	readonly started: Promise<void>;
	disposed = false;
	aborted = false;
	prompted = false;
	private releasePrompt!: () => void;
	private resolveStarted!: () => void;
	private readonly promptReleased: Promise<void>;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.promptReleased = new Promise<void>((resolve) => { this.releasePrompt = resolve; });
		this.started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(_text: string): Promise<void> {
		this.prompted = true;
		this.resolveStarted();
		await this.promptReleased;
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.releasePrompt();
	}

	dispose(): void {
		this.disposed = true;
	}

	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
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
		thinkingLevel: "max",
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
	const startedBody = await requestService(service, "/v1/start", {
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
	await requestService(service, "/v1/event", {
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
	const startedBody = await requestService(service, "/v1/start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	});
	const started = object(startedBody.reply);
	const action = object((started.actions as unknown[])[0]);
	await requestService(service, "/v1/event", {
		eventId: "pause-dispatch",
		kind: "dispatch_results",
		dispatchResults: [{ actionId: String(action.actionId), accepted: false, error: "deterministic host rejection" }],
	});
	const before = evidence(fixture);
	assert.equal(before.run!.status, "paused");
	return { service, before };
}

async function withDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("main-session attention is delivered once and explicitly re-exposed after status", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-attention-"));
	let fixture: Fixture | undefined;
	let capturedApi: CapturedExtensionAPI | undefined;
	let capturedContext: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeBlockedAttentionFixture(root);
		const service = await ensureService(fixture.planDirectory);
		const started = object((await requestService(service, "/v1/start", {
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
			while (api.messages.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		})(), "attention delivery");
		assert.equal(api.messages.length, 1);
		assert.equal(api.messages[0]!.customType, "herder-attention-v1");
		assert.match(api.messages[0]!.content, /^HERDER_MAIN_SESSION_ATTENTION_V1/m);
		assert.match(api.messages[0]!.content, /REQUEST_ID:/);
		assert.deepEqual(api.messages[0]!.options, { deliverAs: "followUp", triggerTurn: true });

		await withDeadline(api.invoke("agent_settled", ctx), "attention agent_settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(api.messages.length, 1, "passive settled events duplicated the attention request");
		await api.command("herder-status").handler("herder-plans", ctx);
		assert.equal(api.messages.length, 2);
		assert.equal(api.messages[1]!.content, api.messages[0]!.content);
		assert.equal(warnings.some((warning) => warning.level === "error"), false);

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
		const started = object((await requestService(service, "/v1/start", {
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
		assert.equal(api.messages.length, 0);

		const before = object((await requestService(service, "/v1/status")).reply);
		const result = object(await api.tool("herder_plan").execute(
			"attention",
			{
				operation: "attention",
				planDirectory: "herder-plans",
				schemaVersion: 1,
				requestId: attention.requestId,
				requestSha256: attention.requestSha256,
				capabilityToken: attention.capabilityToken,
				runId: attention.runId,
				planId: attention.planId,
				generation: attention.generation,
				round: attention.round,
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
