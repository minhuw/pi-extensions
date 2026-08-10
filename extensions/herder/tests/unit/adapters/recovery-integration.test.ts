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
import { registerHerderPiWithWorkerFactory } from "../../../adapters/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { ensureService, requestService, stopService } from "../../../src/client/index.ts";
import { GitDriver, git, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/roles/pi");

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

class CapturedExtensionAPI {
	readonly handlers = new Map<string, CapturedHandler>();
	readonly warnings: Warning[] = [];
	readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];
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

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	sendUserMessage(_content: unknown, _options?: unknown): void {}

	async invoke(event: string, ctx: ExtensionContext): Promise<unknown> {
		const handler = this.handlers.get(event);
		if (!handler) throw new Error(`No captured ${event} handler`);
		return await handler({}, ctx);
	}
}

class PendingSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/herder-recovery-session.jsonl";
	readonly messages: unknown[] = [];
	readonly started: Promise<void>;
	disposed = false;
	aborted = false;
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
		return [{ provider: "fake", id: "fake" }];
	}

	async create(request: PiWorkerRequest) {
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
