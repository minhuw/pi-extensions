import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts";
import { ensureService, stopService } from "../../../src/client/index.ts";
import { git, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { HERDER_STATE_ENTRY } from "../../../adapters/state.ts";
import { HERDER_CLEANUP_ENTRY } from "../../../adapters/cleanup-transcript.ts";
import {
	HERDER_WORKER_INPUT_ENTRY,
	HERDER_WORKER_OUTPUT_ENTRY,
} from "../../../adapters/worker-transcript.ts";
import { HerderNestedAgentScope } from "../../../adapters/nested-agent-executor.ts";
import {
	registerHerderPiWithWorkerFactory,
} from "../../../adapters/index.ts";
import type {
	PiWorkerRequest,
	PiWorkerSessionFactory,
} from "../../../adapters/worker-engine.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/roles/pi");

class Deferred<T = void> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

async function withDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
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

interface Fixture {
	root: string;
	repo: string;
	planDirectory: string;
	originalHead: string;
}

function writeFixture(root: string): Fixture {
	const repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.mkdirSync(path.join(repo, "test"), { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Pi adapter integration test"]);
	git(repo, ["config", "user.email", "pi-adapter-integration@example.invalid"]);
	fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
		name: "pi-adapter-integration-fixture",
		private: true,
		type: "module",
		scripts: { test: "node --test" },
	}, null, 2)}\n`);
	fs.writeFileSync(path.join(repo, "src", "value.mjs"), "export const value = 1\n");
	fs.writeFileSync(path.join(repo, "test", "value.test.mjs"), `import assert from "node:assert/strict"
import test from "node:test"
import { value } from "../src/value.mjs"

test("exports the fixture value", () => assert.equal(value, 1))
`);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: create adapter fixture"]);
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

> **Executor instructions**: Follow this plan exactly. Do not edit the plan index; the deterministic Run Manager owns lifecycle state.
>
> **Drift check (run first)**: \`git diff --stat ${originalHead}..HEAD -- src/value.mjs test/value.test.mjs\`
> Stop if either file drifted from the Current state below.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${originalHead.slice(0, 12)}\`, 2026-08-10
- **Kind**: behavioral
- **Parent objective**: Prove a provider-free Pi adapter registration and lifecycle run.

## Why this matters

This dependency-free fixture exercises the complete adapter route without a provider, credential, or external Pi process.

## Current state

- \`src/value.mjs\` exports \`value\` with the numeric value \`1\`.
- \`test/value.test.mjs\` asserts the initial value and becomes the local verification proof after implementation.
- The repository uses dependency-free ESM and Node's built-in test runner.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 with one passing test |

## Dependency contract

- **Consumes**: none.
- **Provides**: \`value\` equals two and its focused test enforces that behavior.
- **Safe intermediate state**: both source and focused coverage change in one commit.

## Scope

**In scope**:

- \`src/value.mjs\`
- \`test/value.test.mjs\`

**Out of scope**:

- Package metadata, dependencies, providers, credentials, and external host processes.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.
- Do not push or merge into the user's branch.

## Steps

### Step 1: Update the fixture behavior

Change the exported value and its focused assertion from one to two without changing the module interface.

**Verify**: \`npm test\` exits 0 with one passing test.

## Test plan

- Run \`npm test\` and require the focused fixture assertion to pass.
- Inspect the diff and require exactly the two intended files to change.

## Review map

- **Outcome**: \`value\` is two and the focused test passes.
- **Modified symbols**: the value initializer and its assertion.
- **Direct contracts**: ESM import/export and strict equality.
- **Expected unchanged behavior**: filenames, module format, and export name.
- **Proof**: \`npm test\` and the two-file diff.

## Done criteria

- [ ] \`npm test\` exits 0.
- [ ] \`src/value.mjs\` exports \`value\` as \`2\`.
- [ ] \`test/value.test.mjs\` asserts that \`value\` equals \`2\`.
- [ ] No file outside the two declared paths changes.

## STOP conditions

Stop if either owned file has drifted, if a dependency appears necessary, or if any file outside the two declared paths must change.

## Maintenance notes

Keep this fixture deliberately small so provider and transport failures remain distinguishable from implementation complexity.
`);
	const graph = buildGraph(planDirectory);
	assert.equal(graph.shapeReady, true);
	assert.deepEqual(graph.ready, ["001"]);
	return { root, repo, planDirectory, originalHead };
}

interface CapturedEntry {
	customType: string;
	data: unknown;
}

interface CapturedNotification {
	message: string;
	level: string;
}

interface CapturedUserMessage {
	content: string;
	options?: unknown;
}

interface CapturedCustomMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
	options?: unknown;
}

class CapturedExtensionAPI {
	readonly commands = new Map<string, unknown>();
	readonly tools: unknown[] = [];
	readonly handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	readonly renderers: string[] = [];
	readonly appendedEntries: CapturedEntry[] = [];
	readonly userMessages: CapturedUserMessage[] = [];
	readonly customMessages: CapturedCustomMessage[] = [];
	readonly execCalls: Array<{ command: string; args: string[] }> = [];
	private readonly userMessageWaiters: Array<Deferred<CapturedUserMessage>> = [];
	private readonly customMessageWaiters: Array<Deferred<CapturedCustomMessage>> = [];

	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
		this.handlers.set(event, handler);
	}

	registerCommand(name: string, options: unknown): void {
		this.commands.set(name, options);
	}

	registerTool(tool: unknown): void {
		this.tools.push(tool);
	}

	registerEntryRenderer(customType: string, _renderer: unknown): void {
		this.renderers.push(customType);
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	sendUserMessage(content: string, options?: unknown): void {
		const message = { content, ...(options === undefined ? {} : { options }) };
		this.userMessages.push(message);
		while (this.userMessageWaiters.length) this.userMessageWaiters.shift()!.resolve(message);
	}

	sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: unknown): void {
		const captured = { ...message, ...(options === undefined ? {} : { options }) };
		this.customMessages.push(captured);
		while (this.customMessageWaiters.length) this.customMessageWaiters.shift()!.resolve(captured);
	}

	async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		this.execCalls.push({ command, args: [...args] });
		const result = runCommand(command, args, { allowFailure: true });
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
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

	async waitForUserMessage(): Promise<CapturedUserMessage> {
		const existing = this.userMessages.find((message) => message.content.includes("HERDER_MAIN_SESSION_VERIFICATION_V1"));
		if (existing) return existing;
		const deferred = new Deferred<CapturedUserMessage>();
		this.userMessageWaiters.push(deferred);
		return deferred.promise;
	}

	async waitForAttentionMessage(): Promise<CapturedCustomMessage> {
		const existing = this.customMessages.find((message) => message.customType === "herder-attention-v1");
		if (existing) return existing;
		const deferred = new Deferred<CapturedCustomMessage>();
		this.customMessageWaiters.push(deferred);
		return deferred.promise;
	}
}

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

class CapturedUI {
	readonly notifications: CapturedNotification[] = [];
	readonly statuses: Array<{ id: string; value: unknown }> = [];
	readonly widgets: Array<{ id: string; value: unknown }> = [];
	readonly theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	};

	notify(message: string, level: string): void {
		this.notifications.push({ message, level });
	}

	setStatus(id: string, value: unknown): void {
		this.statuses.push({ id, value });
	}

	setWidget(id: string, value: unknown): void {
		this.widgets.push({ id, value });
	}

	async confirm(): Promise<boolean> {
		return true;
	}
}

function contextFor(fixture: Fixture, ui: CapturedUI): ExtensionContext {
	const sessionEntries: unknown[] = [];
	const sessionManager = {
		getEntries: () => sessionEntries,
		getSessionId: () => "main-session-011",
	};
	const modelRegistry = {
		getAvailable: () => [...availableModels],
	};
	return {
		ui,
		mode: "rpc",
		hasUI: true,
		cwd: fixture.repo,
		sessionManager,
		modelRegistry,
		model: availableModels[0],
		thinkingLevel: "max",
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		waitForIdle: async () => {},
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

class ControlledSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/pi-adapter-integration-session.jsonl";
	readonly messages: unknown[] = [];
	readonly started = new Deferred<void>();
	readonly settled = new Deferred<void>();
	readonly action: ManagerAction;
	promptText = "";
	prompted = false;
	aborted = false;
	disposed = false;
	private readonly gate?: Deferred<void>;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(sessionId: string, action: ManagerAction) {
		this.sessionId = sessionId;
		this.action = action;
		if (action.role === "plan-implementer" || action.workerMode === "FINAL_AUDIT") this.gate = new Deferred<void>();
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.promptText = text;
		this.prompted = true;
		this.started.resolve();
		this.emit({ type: "agent_start" });
		if (this.gate) await this.gate.promise;
		if (this.aborted) {
			this.finishLifecycle();
			return;
		}
		if (this.action.role === "plan-implementer") this.completeImplementation();
		else if (this.action.role === "plan-reviewer" && this.action.workerMode !== "FINAL_AUDIT") this.completeReview();
		this.finishLifecycle();
	}

	release(): void {
		this.gate?.resolve();
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.gate?.resolve();
	}

	dispose(): void {
		this.disposed = true;
	}

	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages: this.prompted ? 1 : 0,
			assistantMessages: this.messages.length ? 1 : 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: this.messages.length,
			tokens: { input: 20, output: 10, cacheRead: 3, cacheWrite: 0, total: 33 },
			cost: 0,
			contextUsage: { tokens: 1_000, contextWindow: 100_000, percent: 1 },
		};
	}

	private completeImplementation(): void {
		fs.writeFileSync(path.join(this.action.worktree, "src", "value.mjs"), "export const value = 2\n");
		fs.writeFileSync(path.join(this.action.worktree, "test", "value.test.mjs"), `import assert from "node:assert/strict"
import test from "node:test"
import { value } from "../src/value.mjs"

test("exports the fixture value", () => assert.equal(value, 2))
`);
		runCommand("npm", ["test"], { cwd: this.action.worktree });
		git(this.action.worktree, ["add", "src/value.mjs", "test/value.test.mjs"]);
		git(this.action.worktree, ["commit", "-q", "-m", "test: update fixture value"]);
		const commit = git(this.action.worktree, ["rev-parse", "HEAD"]).stdout.trim();
		this.addAssistantMessage(`STATUS: COMPLETE
COMMITS: ${commit}
ADDRESSED: none
CHECKS: npm test — passed
FILES CHANGED: src/value.mjs, test/value.test.mjs
DISCOVERED_PATHS: none
NOTES: Updated the fixture through the controlled clean worker session.
USAGE: input_tokens=20; cached_input_tokens=3; output_tokens=10; reasoning_tokens=4; source=provider-free-test`);
	}

	private completeReview(): void {
		runCommand("npm", ["test"], { cwd: this.action.worktree });
		this.addAssistantMessage(`VERDICT: APPROVE
FINDINGS: none
FIX_GUIDANCE: none
DISCOVERED_PATHS: none
SCOPE: PASS
CHECKS: npm test — passed
RATIONALE: The controlled reviewer confirms the committed fixture outcome.
USAGE: input_tokens=18; cached_input_tokens=2; output_tokens=9; reasoning_tokens=3; source=provider-free-test`);
	}

	private addAssistantMessage(text: string): void {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			usage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 0, reasoning: 4 },
		};
		this.messages.push(message);
		this.emit({ type: "message_end", message: message as never });
	}

	private finishLifecycle(): void {
		this.emit({ type: "agent_end", messages: this.messages as never[], willRetry: false });
		this.emit({ type: "agent_settled" });
		this.settled.resolve();
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class CapturedWorkerFactory implements PiWorkerSessionFactory {
	readonly sessions: ControlledSession[] = [];
	readonly boundRegistries: ModelRegistry[] = [];
	providerCalls = 0;
	private readonly waiters: Array<{ predicate: (session: ControlledSession) => boolean; deferred: Deferred<ControlledSession> }> = [];

	bindModelRegistry(registry: ModelRegistry): void {
		this.boundRegistries.push(registry);
	}

	async availableModels() {
		return availableModels;
	}

	async create(request: PiWorkerRequest) {
		const session = new ControlledSession(`pi-test-session-${this.sessions.length + 1}`, request.action);
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot,
			createSession: async () => { throw new Error("Nested sessions are not used by this provider-free adapter test."); },
		});
		this.sessions.push(session);
		for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.waiters[index]!;
			if (!waiter.predicate(session)) continue;
			this.waiters.splice(index, 1);
			waiter.deferred.resolve(session);
		}
		return { session, nested };
	}

	waitForSession(predicate: (session: ControlledSession) => boolean): Promise<ControlledSession> {
		const existing = this.sessions.find(predicate);
		if (existing) return Promise.resolve(existing);
		const deferred = new Deferred<ControlledSession>();
		this.waiters.push({ predicate, deferred });
		return deferred.promise;
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

function toolText(value: unknown): string {
	const result = object(value);
	const content = result.content;
	if (!Array.isArray(content) || !content[0] || typeof content[0] !== "object") throw new Error("Tool returned no text content");
	return String((content[0] as Record<string, unknown>).text || "");
}

function verificationRequestId(prompt: string): string {
	const match = prompt.match(/^REQUEST_ID: (.+)$/m);
	if (!match) throw new Error("Verification prompt did not contain REQUEST_ID");
	return match[1]!;
}

function readVerification(fixture: Fixture): { runId: string; state: string; manifest: Record<string, unknown> | null } {
	const store = new RunStore(fixture.planDirectory);
	try {
		const run = store.getRun();
		if (!run) throw new Error("Fixture has no manager run");
		const verification = store.getVerification(run.runId, run.currentGeneration);
		if (!verification) throw new Error("Fixture has no durable verification");
		return { runId: run.runId, state: verification.state, manifest: verification.manifest as Record<string, unknown> | null };
	} finally {
		store.close();
	}
}

function durableFinalAction(fixture: Fixture, runId: string): { state: string; workerMode: string; hostHandle: string | null } {
	const store = new RunStore(fixture.planDirectory);
	try {
		const action = store.getActions(runId).find((candidate) => candidate.workerMode === "FINAL_AUDIT");
		if (!action) throw new Error("Fixture has no final audit action");
		return { state: action.state, workerMode: action.workerMode, hostHandle: action.hostHandle };
	} finally {
		store.close();
	}
}

test("complete Pi adapter wiring is provider-free and shutdown-safe", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-integration-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);

		assert.deepEqual([...api.commands.keys()].sort(), [
			"herder-cleanup",
			"herder-dashboard",
			"herder-fire",
			"herder-grill",
			"herder-improve",
			"herder-plans",
			"herder-simplify",
			"herder-resume",
			"herder-revise",
			"herder-status",
			"herder-stop",
			"herder-validate",
		].sort());
		assert.deepEqual(api.tools.map((tool) => String((tool as { name: string }).name)).sort(), ["herder_plan", "herder_verification"]);
		assert.deepEqual([...api.handlers.keys()].sort(), ["agent_settled", "session_shutdown", "session_start"]);
		assert.deepEqual([...api.renderers].sort(), [HERDER_CLEANUP_ENTRY, HERDER_WORKER_INPUT_ENTRY, HERDER_WORKER_OUTPUT_ENTRY].sort());

		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "captured session_start");
		assert.equal(factory.boundRegistries.length, 1);

		await withDeadline(
			api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", context),
			"/herder-fire dispatch",
		);
		const implementer = await withDeadline(
			factory.waitForSession((session) => session.action.role === "plan-implementer"),
			"implementer creation",
		);
		await withDeadline(implementer.started.promise, "implementer start");
		assert.match(implementer.promptText, /HERDER_MANAGER_WORKER_V1/);
		assert.match(implementer.promptText, /ROLE_CONTRACT_PATH: .*plan-implementer\.md/);
		assert.equal(implementer.messages.length, 0, "worker session inherited root history");
		assert.equal(factory.providerCalls, 0);

		await withDeadline(
			api.command("herder-status").handler("herder-plans", context),
			"herder status command",
		);
		assert.ok(ui.notifications.some((notification) => notification.level === "info" && notification.message.startsWith("Herder fire started")));
		assert.ok(ui.notifications.some((notification) => notification.level === "info" && notification.message.startsWith("RUNNING · ")));
		assert.equal(ui.notifications.some((notification) => notification.level === "error"), false);
		assert.ok(api.execCalls.some((call) => call.command === "git" && call.args.includes("rev-parse")));
		const stateEntries = api.appendedEntries.filter((entry) => entry.customType === HERDER_STATE_ENTRY).map((entry) => object(entry.data));
		assert.ok(stateEntries.some((state) => state.status === "running" && state.profile === "eclipse" && state.maxParallel === 1));

		implementer.release();
		const reviewer = await withDeadline(
			factory.waitForSession((session) => session.action.role === "plan-reviewer" && session.action.workerMode === "DISCOVERY"),
			"reviewer creation",
		);
		await withDeadline(reviewer.settled.promise, "reviewer approval");
		const verificationPrompt = (await withDeadline(api.waitForUserMessage(), "verification delegation")).content;
		assert.match(verificationPrompt, /^HERDER_MAIN_SESSION_VERIFICATION_V1/m);
		assert.match(verificationPrompt, /PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot/);
		assert.match(verificationPrompt, /REQUEST_ID: /);
		assert.equal(factory.providerCalls, 0);

		const verification = await withDeadline(
			api.tool("herder_verification").execute(
				"verification",
				{
					planDirectory: "herder-plans",
					requestId: verificationRequestId(verificationPrompt),
					rationale: "The dependency-free fixture test is the smallest complete local proof.",
					gates: [{
						gateId: "local-npm-test",
						label: "local fixture tests",
						cwd: ".",
						argv: ["npm", "test"],
						rationale: "Runs the integrated fixture without provider access.",
					}],
				},
				undefined,
				undefined,
				context,
			),
			"herder_verification submission",
		);
		assert.equal(object(verification).terminate, true);
		assert.match(toolText(verification), /Verification manifest accepted/);

		const finalAudit = await withDeadline(
			factory.waitForSession((session) => session.action.workerMode === "FINAL_AUDIT"),
			"final audit dispatch",
		);
		await withDeadline(finalAudit.started.promise, "final audit start");
		const durableVerification = readVerification(fixture);
		assert.equal(durableVerification.state, "passed");
		const manifest = durableVerification.manifest;
		assert.ok(manifest);
		assert.deepEqual(manifest.selector, {
			model: "fake/gpt-5.6-sol",
			thinkingLevel: "max",
			sessionId: "main-session-011",
		});
		assert.deepEqual(manifest.gates, [{
			gateId: "local-npm-test",
			label: "local fixture tests",
			cwd: ".",
			argv: ["npm", "test"],
			timeoutMs: 1_800_000,
			rationale: "Runs the integrated fixture without provider access.",
		}]);
		assert.equal(factory.providerCalls, 0);

		const inputEntries = api.appendedEntries
			.filter((entry) => entry.customType === HERDER_WORKER_INPUT_ENTRY)
			.map((entry) => object(entry.data));
		assert.deepEqual(inputEntries.map((entry) => entry.workerMode), ["INITIAL", "DISCOVERY", "FINAL_AUDIT"]);
		assert.ok(inputEntries.every((entry) => typeof entry.prompt === "string" && String(entry.prompt).includes("HERDER_MANAGER_WORKER_V1")));
		const returnedOutputs = api.appendedEntries
			.filter((entry) => entry.customType === HERDER_WORKER_OUTPUT_ENTRY)
			.map((entry) => object(entry.data));
		assert.equal(returnedOutputs.length, 2);
		assert.ok(returnedOutputs.every((entry) => entry.status === "returned"));

		const entriesBeforeShutdown = api.appendedEntries.length;
		await withDeadline(api.invoke("session_shutdown", context), "captured session_shutdown");
		shutdown = true;
		await withDeadline(finalAudit.settled.promise, "final audit settlement");
		assert.equal(finalAudit.aborted, true);
		assert.equal(finalAudit.disposed, true);
		assert.equal(factory.sessions.every((session) => session.disposed), true);
		const interruptedOutputs = api.appendedEntries
			.filter((entry) => entry.customType === HERDER_WORKER_OUTPUT_ENTRY)
			.map((entry) => object(entry.data));
		assert.equal(interruptedOutputs.length, 3);
		assert.equal(interruptedOutputs[2]!.status, "interrupted");
		assert.equal(api.appendedEntries.length > entriesBeforeShutdown, true);
		assert.equal(ui.widgets.at(-1)?.value, undefined, "shutdown did not dispose the Herder widget");
		assert.equal(durableFinalAction(fixture, durableVerification.runId).state, "dispatched", "shutdown reported a terminal to the manager");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(api.appendedEntries.length, entriesBeforeShutdown + 1, "worker continued after session shutdown");
		assert.equal(factory.providerCalls, 0);
	} finally {
		if (api && context && !shutdown) {
			await withDeadline(api.invoke("session_shutdown", context), "integration cleanup session_shutdown", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
