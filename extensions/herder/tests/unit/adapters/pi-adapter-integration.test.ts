import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ManagerAction, ManagerReply } from "../../../src/shared/protocol.ts";
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts";
import { appendIndependentPlan } from "../../support/independent-plan.ts";
import { compileGraphIdentity } from "../../../src/core/run-manager.ts";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { ensureService, requestManagerOperation,
	requestService, stopService } from "../../../src/client/index.ts";
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
import {
	agentRoot,
	BaseSession,
	CapturedExtensionAPI,
	CapturedUI,
	Deferred,
	availableModels,
	initFixtureRepo,
	object,
	withDeadline as harnessWithDeadline,
} from "./helpers/harness.ts";

const withDeadline = <T>(operation: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> =>
	harnessWithDeadline(operation, label, timeoutMs);

interface Fixture {
	root: string;
	repo: string;
	planDirectory: string;
	originalHead: string;
}

function writeFixture(root: string): Fixture {
	const { repo, originalHead } = initFixtureRepo(root, {
		name: "Pi adapter integration test",
		email: "pi-adapter-integration@example.invalid",
		files: {
			"package.json": `${JSON.stringify({
				name: "pi-adapter-integration-fixture",
				private: true,
				type: "module",
				scripts: { test: "node --test" },
			}, null, 2)}\n`,
			"src/value.mjs": "export const value = 1\n",
			"test/value.test.mjs": `import assert from "node:assert/strict"
import test from "node:test"
import { value } from "../src/value.mjs"

test("exports the fixture value", () => assert.equal(value, 1))
`,
		},
	});

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
		thinkingLevel: "xhigh",
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

class ControlledSession extends BaseSession {
	readonly started = new Deferred<void>();
	readonly settled = new Deferred<void>();
	readonly action: ManagerAction;
	promptText = "";
	prompted = false;
	aborted = false;
	finalReviewResponse?: string;
	private readonly gate?: Deferred<void>;

	constructor(sessionId: string, action: ManagerAction) {
		super(sessionId);
		this.action = action;
		if (action.role === "plan-implementer" || action.workerMode === "FINAL_AUDIT") this.gate = new Deferred<void>();
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
		else if (this.action.workerMode === "FINAL_AUDIT" && this.finalReviewResponse) this.addAssistantMessage(this.finalReviewResponse);
		this.finishLifecycle();
	}

	release(): void {
		this.gate?.resolve();
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.gate?.resolve();
	}

	getSessionStats(): SessionStats {
		return {
			sessionFile: undefined,
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

function fieldValue(prompt: string, name: string): string {
	const match = prompt.match(new RegExp(`^${name}: (.+)$`, "m"));
	if (!match) throw new Error(`Prompt did not contain ${name}`);
	return match[1]!;
}

function writeAdapterFollowUpPlan(directory: string, fixture: Fixture): string {
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-follow-up.md) | Follow up residual work | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(
		path.join(directory, "001-follow-up.md"),
		fs.readFileSync(path.join(fixture.planDirectory, "001-update-value.md"), "utf8")
			.replaceAll("Plan 001: Update the fixture value", "Plan 001: Follow up residual work")
			.replaceAll("Update the fixture value", "Follow up residual work"),
	);
	return compileGraphIdentity(buildGraph(directory));
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

test("integration repair rejects commitMessage at the adapter boundary", async () => {
	const api = new CapturedExtensionAPI();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, new CapturedWorkerFactory());
	await assert.rejects(
		() => api.tool("herder_integration_repair").execute(
			"legacy-commit-message",
			{ commitMessage: "manager-authored" },
			undefined,
			undefined,
			undefined,
		),
		/commitMessage is not accepted/,
	);
	assert.deepEqual(api.execCalls, []);
});

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

		assert.deepEqual(api.tools.map((tool) => String((tool as { name: string }).name)).sort(), ["herder_integration_repair", "herder_plan", "herder_reignite", "herder_verification"]);
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
		assert.ok(stateEntries.every((state) => !Object.hasOwn(state, "asyncDir") && !Object.hasOwn(state, "dashboardEnabled")));

		implementer.release();
		const reviewer = await withDeadline(
			factory.waitForSession((session) => session.action.role === "plan-reviewer" && session.action.workerMode === "DISCOVERY"),
			"reviewer creation",
		);
		await withDeadline(reviewer.settled.promise, "reviewer approval");
		const verificationPrompt = (await withDeadline(api.waitForUserMessage(), "verification delegation")).content;
		assert.match(verificationPrompt, /^HERDER_MAIN_SESSION_VERIFICATION_V1/m);
		assert.match(verificationPrompt, /PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot/);
		assert.match(verificationPrompt, /never put literal newlines inside a shell script argument/);
		assert.match(verificationPrompt, /join multiple shell statements with && or semicolons/);
		assert.match(verificationPrompt, /REQUEST_ID: /);
		assert.equal(factory.providerCalls, 0);

		const firstRequestId = verificationRequestId(verificationPrompt);
		const failedVerification = await withDeadline(
			api.tool("herder_verification").execute(
				"verification",
				{
					planDirectory: "herder-plans",
					requestId: firstRequestId,
					rationale: "Exercise durable failure and resume before selecting the passing fixture gate.",
					gates: [{
						gateId: "intentional-failure",
						label: "intentional failure",
						cwd: ".",
						argv: [process.execPath, "-e", "process.exit(7)"],
						rationale: "Creates terminal evidence for the replacement-manifest recovery path.",
					}],
				},
				undefined,
				undefined,
				context,
			),
			"failing herder_verification submission",
		);
		assert.equal(object(failedVerification).terminate, true);
		assert.match(toolText(failedVerification), /Verification manifest accepted/);
		assert.match(String(ui.statuses.at(-1)?.value), /Herder running/i);
		await withDeadline(
			api.command("herder-status").handler("herder-plans", context),
			"verification status refresh",
		);
		assert.ok(ui.notifications.some((notification) => notification.level === "info"
			&& notification.message.startsWith("RUNNING · Executing final verification gates in the background.")));
		assert.match(String(ui.statuses.at(-1)?.value), /Herder running/i);
		await withDeadline((async () => {
			while (readVerification(fixture!).state !== "failed") await new Promise((resolve) => setTimeout(resolve, 50));
			while (!ui.notifications.some((notification) => notification.message.startsWith("Herder final verification failed:"))) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		})(), "durable verification failure");
		assert.ok(ui.notifications.some((notification) => notification.level === "error" && notification.message.includes("Use /herder-resume")));
		const failurePrompt = (await withDeadline(
			api.waitForUserMessage(0, "HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1"),
			"verification failure handoff",
		)).content;
		assert.match(failurePrompt, /^HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1/m);
		assert.match(failurePrompt, /intentional-failure/);
		assert.match(failurePrompt, /LOG_PATH: .*intentional-failure/);
		assert.match(failurePrompt, /explain the concrete failure to the user/);
		assert.match(failurePrompt, /\/herder-resume/);
		assert.match(failurePrompt, /corrective plan followed by \/herder-revise/);
		assert.match(failurePrompt, /Do not edit the frozen integration worktree/);
		const failureFollowUpCount = api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1")).length;
		await withDeadline(
			api.command("herder-status").handler("herder-plans", context),
			"failed verification status refresh",
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(
			api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1")).length,
			failureFollowUpCount,
			"durable failure refresh injected a duplicate main-session handoff",
		);
		assert.equal(factory.sessions.some((session) => session.action.workerMode === "FINAL_AUDIT"), false);
		const messageCountBeforeResume = api.userMessages.length;
		await withDeadline(
			api.command("herder-resume").handler("herder-plans", context),
			"/herder-resume verification replacement",
		);
		const replacementPrompt = (await withDeadline(api.waitForUserMessage(messageCountBeforeResume), "replacement verification delegation")).content;
		const replacementRequestId = verificationRequestId(replacementPrompt);
		assert.notEqual(replacementRequestId, firstRequestId);
		assert.equal(readVerification(fixture).state, "awaiting_manifest");

		const verification = await withDeadline(
			api.tool("herder_verification").execute(
				"verification",
				{
					planDirectory: "herder-plans",
					requestId: replacementRequestId,
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
			"replacement herder_verification submission",
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
			thinkingLevel: "xhigh",
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

test("request-bound integration repair edits only after begin and automatically reverifies", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-repair-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "repair session_start");
		await withDeadline(api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", context), "repair fire");
		const implementer = await withDeadline(factory.waitForSession((session) => session.action.role === "plan-implementer"), "repair implementer");
		await withDeadline(implementer.started.promise, "repair implementer start");
		implementer.release();
		const reviewer = await withDeadline(factory.waitForSession((session) => session.action.role === "plan-reviewer" && session.action.workerMode === "DISCOVERY"), "repair reviewer");
		await withDeadline(reviewer.settled.promise, "repair reviewer settle");
		const verificationPrompt = (await withDeadline(api.waitForUserMessage(), "repair verification prompt")).content;
		const requestId = verificationRequestId(verificationPrompt);
		await withDeadline(api.tool("herder_verification").execute(
			"verification",
			{
				planDirectory: "herder-plans",
				requestId,
				rationale: "The value gate reproduces an integrated code defect before repair.",
				gates: [{
					gateId: "value-defect",
					label: "value defect reproduction",
					cwd: ".",
					argv: [process.execPath, "-e", "const fs=require('node:fs'); if (fs.readFileSync('src/value.mjs','utf8').includes('2')) process.exit(7)"],
					rationale: "Reproduces the integrated value defect.",
				}],
			}, undefined, undefined, context), "repair failing verification");
		const recoveryPrompt = (await withDeadline(api.waitForUserMessage(0, "HERDER_MAIN_SESSION_VERIFICATION_RECOVERY_V1"), "repair recovery prompt")).content;
		assert.equal(fieldValue(recoveryPrompt, "REQUEST_ID"), requestId);
		assert.doesNotMatch(recoveryPrompt, /preserve the recorded classification exactly|RECORDED_CLASSIFICATION/);
		const ownerSessionId = fieldValue(recoveryPrompt, "MAIN_SESSION_ID");
		const repairArgs = {
			planDirectory: "herder-plans",
			requestId,
			requestSha256: fieldValue(recoveryPrompt, "REQUEST_SHA256"),
			capabilityToken: fieldValue(recoveryPrompt, "CAPABILITY_TOKEN"),
			ownerSessionId,
		};
		await assert.rejects(
			() => api!.tool("herder_integration_repair").execute("repair", { ...repairArgs, operation: "finish", observedCommit: "0".repeat(40) }, undefined, undefined, context),
			/repair finish requires the observed integration commit identity|Code-defect integration repair finish requires recorded failure-related paths|not bound|must be clean|worktree/i,
		);
		const begin = await withDeadline(api.tool("herder_integration_repair").execute(
			"repair-begin",
			{ ...repairArgs, operation: "begin", classification: "code_defect" }, undefined, undefined, context), "repair begin");
		assert.equal(object(begin).terminate, false);
		const integrationWorktree = fieldValue(recoveryPrompt, "INTEGRATION_WORKTREE");
		fs.writeFileSync(path.join(integrationWorktree, "src", "value.mjs"), "export const value = 3\n");
		git(integrationWorktree, ["add", "--", "src/value.mjs"]);
		git(integrationWorktree, ["commit", "-q", "-m", "fix: repair integrated verification defect"]);
		const observedCommit = git(integrationWorktree, ["rev-parse", "HEAD"]).stdout.trim();
		assert.equal(git(integrationWorktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "");
		const finish = await withDeadline(api.tool("herder_integration_repair").execute(
			"repair-finish",
			{
				...repairArgs,
				operation: "finish",
				observedCommit,
				allowedPaths: ["src/value.mjs"],
				detail: "The authorized integration worktree now contains the bounded fix.",
			}, undefined, undefined, context), "repair finish");
		assert.equal(object(finish).terminate, true);
		await withDeadline(factory.waitForSession((session) => session.action.workerMode === "FINAL_AUDIT"), "repair final audit");
		assert.equal(readVerification(fixture).state, "passed");
		const repaired = new RunStore(fixture.planDirectory);
		try {
			const run = repaired.getRun()!;
			const repair = repaired.getIntegrationRepairForRun(run.runId, run.currentGeneration);
			assert.equal(repair?.state, "passed");
			assert.equal(repair?.round, 1);
		} finally { repaired.close(); }
		await withDeadline(api.invoke("session_shutdown", context), "repair session_shutdown");
		shutdown = true;
	} finally {
		if (api && context && !shutdown) await withDeadline(api.invoke("session_shutdown", context), "repair cleanup session_shutdown", 5_000).catch(() => {});
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failed repaired verification replays through manager deduplication", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-repair-replay-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "repair replay session_start");
		await withDeadline(api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", context), "repair replay fire");
		const implementer = await withDeadline(factory.waitForSession((session) => session.action.role === "plan-implementer"), "repair replay implementer");
		await withDeadline(implementer.started.promise, "repair replay implementer start");
		implementer.release();
		const reviewer = await withDeadline(factory.waitForSession((session) => session.action.role === "plan-reviewer" && session.action.workerMode === "DISCOVERY"), "repair replay reviewer");
		await withDeadline(reviewer.settled.promise, "repair replay reviewer settle");
		const verificationPrompt = (await withDeadline(api.waitForUserMessage(), "repair replay verification prompt")).content;
		const requestId = verificationRequestId(verificationPrompt);
		await withDeadline(api.tool("herder_verification").execute(
			"verification",
			{
				planDirectory: "herder-plans",
				requestId,
				rationale: "The inherited gate intentionally remains failing to exercise a durable repair replay.",
				gates: [{
					gateId: "always-failing",
					label: "always failing inherited gate",
					cwd: ".",
					argv: [process.execPath, "-e", "process.exit(7)"],
					rationale: "Keeps the repaired successor in a durable failed state.",
				}],
			}, undefined, undefined, context), "repair replay failing verification");
		const recoveryPrompt = (await withDeadline(api.waitForUserMessage(0, "HERDER_MAIN_SESSION_VERIFICATION_RECOVERY_V1"), "repair replay recovery prompt")).content;
		const ownerSessionId = fieldValue(recoveryPrompt, "MAIN_SESSION_ID");
		const repairArgs = {
			planDirectory: "herder-plans",
			requestId,
			requestSha256: fieldValue(recoveryPrompt, "REQUEST_SHA256"),
			capabilityToken: fieldValue(recoveryPrompt, "CAPABILITY_TOKEN"),
			ownerSessionId,
		};
		await withDeadline(api.tool("herder_integration_repair").execute(
			"repair-replay-begin",
			{ ...repairArgs, operation: "begin", classification: "code_defect" }, undefined, undefined, context), "repair replay begin");
		const integrationWorktree = fieldValue(recoveryPrompt, "INTEGRATION_WORKTREE");
		fs.writeFileSync(path.join(integrationWorktree, "src", "value.mjs"), "export const value = 3\n");
		git(integrationWorktree, ["add", "--", "src/value.mjs"]);
		git(integrationWorktree, ["commit", "-q", "-m", "fix: repair integrated verification defect"]);
		const observedCommit = git(integrationWorktree, ["rev-parse", "HEAD"]).stdout.trim();
		assert.equal(git(integrationWorktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "");
		const finishArgs = {
			...repairArgs,
			operation: "finish",
			operationId: "repair-finish-replay-001",
			observedCommit,
			allowedPaths: ["src/value.mjs"],
			detail: "The authorized integration worktree contains the bounded fix.",
		};
		const firstFinish = await withDeadline(api.tool("herder_integration_repair").execute("repair-replay-finish", finishArgs, undefined, undefined, context), "repair replay finish");
		assert.equal(object(firstFinish).terminate, true);
		const failedRepair = new RunStore(fixture.planDirectory);
		try {
			const run = failedRepair.getRun()!;
			const repair = failedRepair.getIntegrationRepairForRun(run.runId, run.currentGeneration);
			assert.equal(repair?.state, "failed");
			assert.ok(repair?.currentCommit);
		} finally { failedRepair.close(); }

		const replay = await withDeadline(api.tool("herder_integration_repair").execute("repair-replay-finish", finishArgs, undefined, undefined, context), "repair replay exact finish");
		assert.equal(object(replay).terminate, true);
		assert.equal(object(object(replay).details).operationId, "repair-finish-replay-001");
		await assert.rejects(
			() => api!.tool("herder_integration_repair").execute(
				"repair-replay-divergent",
				{ ...finishArgs, detail: "divergent replay evidence" },
				undefined,
				undefined,
				context,
			),
			/replayed with different payload/,
		);
		await withDeadline(api.invoke("session_shutdown", context), "repair replay session_shutdown");
		shutdown = true;
	} finally {
		if (api && context && !shutdown) await withDeadline(api.invoke("session_shutdown", context), "repair replay cleanup session_shutdown", 5_000).catch(() => {});
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function fireThroughPassingVerification(
	api: CapturedExtensionAPI,
	factory: CapturedWorkerFactory,
	context: ExtensionContext,
): Promise<ControlledSession> {
	await withDeadline(
		api.command("herder-fire").handler("herder-plans --profile eclipse --max-parallel 1", context),
		"/herder-fire dispatch",
	);
	const implementer = await withDeadline(
		factory.waitForSession((session) => session.action.role === "plan-implementer"),
		"implementer creation",
	);
	await withDeadline(implementer.started.promise, "implementer start");
	implementer.release();
	await withDeadline(
		factory.waitForSession((session) => session.action.role === "plan-reviewer" && session.action.workerMode === "DISCOVERY"),
		"reviewer creation",
	);
	const verificationPrompt = (await withDeadline(api.waitForUserMessage(), "verification delegation")).content;
	const requestId = verificationRequestId(verificationPrompt);
	await withDeadline(
		api.tool("herder_verification").execute(
			"verification",
			{
				planDirectory: "herder-plans",
				requestId,
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
		"passing herder_verification submission",
	);
	return await withDeadline(
		factory.waitForSession((session) => session.action.workerMode === "FINAL_AUDIT"),
		"final audit dispatch",
	);
}

test("complete pending reignite injects one write prompt and ack does not dispatch workers", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-reignite-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "captured session_start");
		const finalAudit = await fireThroughPassingVerification(api, factory, context);
		finalAudit.finalReviewResponse = `VERDICT: REVISE
FINDINGS: [fr-1][P1][BLOCKING][PLAN_REQUIREMENT] residual audit finding
FIX_GUIDANCE: Write a sibling follow-up plan set.
DISCOVERED_PATHS: none
SCOPE: PASS
CHECKS: npm test — passed
RATIONALE: Residual requirement belongs in a follow-up plan set.
USAGE: input_tokens=12; cached_input_tokens=2; output_tokens=6; reasoning_tokens=2; source=provider-free-test`;
		const beforeReignite = api.userMessages.length;
		finalAudit.release();
		const reignitePrompt = (await withDeadline(
			api.waitForUserMessage(beforeReignite, "HERDER_MAIN_SESSION_REIGNITE_V1"),
			"reignite delegation",
		)).content;
		assert.match(reignitePrompt, /^HERDER_MAIN_SESSION_REIGNITE_V1/m);
		assert.match(reignitePrompt, /SOURCE_PLAN_DIRECTORY: /);
		assert.match(reignitePrompt, /ALLOCATED_PLAN_DIRECTORY: /);
		assert.match(reignitePrompt, /Pass SOURCE_PLAN_DIRECTORY as planDirectory/);
		assert.match(reignitePrompt, /allocated sibling is also accepted/);
		assert.match(reignitePrompt, /Do not call \/herder-fire/);
		assert.equal(factory.sessions.some((session) => session.action.role === "plan-implementer" && session.action.planId !== "001"), false);
		const firstCount = api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_REIGNITE_V1")).length;
		assert.equal(firstCount, 1);
		await withDeadline(api.command("herder-status").handler("herder-plans", context), "reignite status refresh");
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(
			api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_REIGNITE_V1")).length,
			firstCount,
			"status refresh injected a duplicate reignite prompt",
		);
		const messageCountBeforeResume = api.userMessages.length;
		await withDeadline(api.command("herder-resume").handler("herder-plans", context), "/herder-resume pending reignite");
		const resumedPrompt = (await withDeadline(
			api.waitForUserMessage(messageCountBeforeResume, "HERDER_MAIN_SESSION_REIGNITE_V1"),
			"reignite re-injection",
		)).content;
		assert.match(resumedPrompt, /^HERDER_MAIN_SESSION_REIGNITE_V1/m);
		assert.equal(fieldValue(resumedPrompt, "REQUEST_ID"), fieldValue(reignitePrompt, "REQUEST_ID"));
		const allocated = fieldValue(resumedPrompt, "ALLOCATED_PLAN_DIRECTORY");
		writeAdapterFollowUpPlan(allocated, fixture);
		const validated = object(await invokeHerderTool("herder_plan", {
			operation: "validate",
			planDirectory: allocated,
		}));
		const graphSha256 = String(validated.graphSha256);
		const workersBeforeAck = factory.sessions.length;
		const ackArgs = {
			requestId: fieldValue(resumedPrompt, "REQUEST_ID"),
			requestSha256: fieldValue(resumedPrompt, "REQUEST_SHA256"),
			state: "written" as const,
			graphSha256,
		};
		await assert.rejects(
			() => api!.tool("herder_reignite").execute(
				"reignite-wrong-dir",
				{ ...ackArgs, planDirectory: "src" },
				undefined,
				undefined,
				context,
			),
			/must be the source run/,
		);
		const ack = await withDeadline(
			api.tool("herder_reignite").execute(
				"reignite",
				{ ...ackArgs, planDirectory: allocated },
				undefined,
				undefined,
				context,
			),
			"herder_reignite written ack against allocated directory",
		);
		assert.equal(object(ack).terminate, true);
		assert.match(toolText(ack), /original run remains complete/i);
		assert.equal(factory.sessions.length, workersBeforeAck, "reignite ack dispatched workers");
		const store = new RunStore(fixture.planDirectory);
		try {
			const run = store.getRun()!;
			assert.equal(run.status, "complete");
			assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "written");
		} finally { store.close(); }
		await withDeadline(api.invoke("session_shutdown", context), "reignite session_shutdown");
		shutdown = true;
	} finally {
		if (api && context && !shutdown) {
			await withDeadline(api.invoke("session_shutdown", context), "reignite cleanup session_shutdown", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stale complete snapshots do not inject a reignite prompt after the source run pauses", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-reignite-stale-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "captured session_start");
		const finalAudit = await fireThroughPassingVerification(api, factory, context);
		finalAudit.finalReviewResponse = `VERDICT: REVISE
FINDINGS: [fr-stale][P1][BLOCKING][PLAN_REQUIREMENT] residual audit finding
FIX_GUIDANCE: Write a sibling follow-up plan set.
DISCOVERED_PATHS: none
SCOPE: PASS
CHECKS: npm test — passed
RATIONALE: Residual requirement belongs in a follow-up plan set.
USAGE: input_tokens=12; cached_input_tokens=2; output_tokens=6; reasoning_tokens=2; source=provider-free-test`;
		const beforeReignite = api.userMessages.length;
		finalAudit.release();
		await withDeadline(
			api.waitForUserMessage(beforeReignite, "HERDER_MAIN_SESSION_REIGNITE_V1"),
			"reignite delegation",
		);
		const firstCount = api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_REIGNITE_V1")).length;
		assert.equal(firstCount, 1);
		const service = await ensureService(fixture.planDirectory);
		const completeStatus = object(await requestService(service, "/v1/status"));
		const completeReply = object(completeStatus.reply) as unknown as ManagerReply;
		assert.equal(completeReply.status, "complete");
		assert.equal(completeReply.reigniteRequest?.state, "pending");
		appendIndependentPlan(fixture);
		await requestManagerOperation(service, "event", {
			eventId: "adapter-reignite-stale-drift",
			kind: "terminals",
			terminals: [],
		});
		const paused = object(object(await requestService(service, "/v1/status")).reply);
		assert.equal(paused.status, "paused");
		assert.equal(paused.reigniteRequest, undefined);
		await withDeadline(api.command("herder-resume").handler("herder-plans", context), "/herder-resume after pause");
		const store = new RunStore(fixture.planDirectory);
		try {
			store.putSnapshot(completeReply);
		} finally { store.close(); }
		await withDeadline(api.command("herder-status").handler("herder-plans", context), "stale complete status refresh");
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(
			api.userMessages.filter((entry) => entry.content.includes("HERDER_MAIN_SESSION_REIGNITE_V1")).length,
			firstCount,
			"stale complete snapshot injected a reignite prompt after pause",
		);
		await withDeadline(api.invoke("session_shutdown", context), "stale reignite session_shutdown");
		shutdown = true;
	} finally {
		if (api && context && !shutdown) {
			await withDeadline(api.invoke("session_shutdown", context), "stale reignite cleanup session_shutdown", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("skipped reignite dossier does not inject a write prompt", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-pi-adapter-reignite-skip-"));
	let fixture: Fixture | undefined;
	let api: CapturedExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let shutdown = false;
	try {
		fixture = writeFixture(root);
		api = new CapturedExtensionAPI();
		const factory = new CapturedWorkerFactory();
		registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, factory);
		const ui = new CapturedUI();
		context = contextFor(fixture, ui);
		await withDeadline(api.invoke("session_start", context), "captured session_start");
		const finalAudit = await fireThroughPassingVerification(api, factory, context);
		finalAudit.finalReviewResponse = `VERDICT: APPROVE
FINDINGS: none
FIX_GUIDANCE: none
DISCOVERED_PATHS: none
SCOPE: PASS
CHECKS: npm test — passed
RATIONALE: Aggregate review found no residual requirements.
USAGE: input_tokens=12; cached_input_tokens=2; output_tokens=6; reasoning_tokens=2; source=provider-free-test`;
		const before = api.userMessages.length;
		finalAudit.release();
		await withDeadline(finalAudit.settled.promise, "final audit settlement");
		await withDeadline((async () => {
			for (;;) {
				const store = new RunStore(fixture.planDirectory);
				try {
					const run = store.getRun();
					if (run?.status === "complete") {
						assert.equal(store.getReigniteRequest(run.runId, run.currentGeneration)?.state, "skipped");
						return;
					}
				} finally { store.close(); }
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		})(), "skipped dossier completion");
		assert.equal(
			api.userMessages.slice(before).some((entry) => entry.content.includes("HERDER_MAIN_SESSION_REIGNITE_V1")),
			false,
		);
		await withDeadline(api.invoke("session_shutdown", context), "skipped reignite session_shutdown");
		shutdown = true;
	} finally {
		if (api && context && !shutdown) {
			await withDeadline(api.invoke("session_shutdown", context), "skipped reignite cleanup session_shutdown", 5_000).catch(() => {});
		}
		if (fixture) {
			await stopService(fixture.planDirectory).catch(() => {});
			fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
