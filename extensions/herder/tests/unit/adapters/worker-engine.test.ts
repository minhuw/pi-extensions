import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime, type AgentSession, type AgentSessionEvent, type SessionStats } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { HerderNestedAgentScope } from "../../../adapters/nested-agent-executor.ts";
import {
	applySearcherToolPolicy,
	applyServiceTier,
	DefaultPiWorkerSessionFactory,
	finalAssistantResult,
	PiWorkerEngine,
	resolveFffToolNames,
	trustedNestedExtensionPath,
	trustedRoleExtensionEntry,
	type PiWorkerRequest,
	type PiWorkerSessionFactory,
	type PiWorkerTerminal,
} from "../../../adapters/worker-engine.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/roles/pi");

function action(id = "action-1", planId = "001"): ManagerAction {
	return {
		actionId: id,
		attemptId: `attempt-${id}`,
		runId: "run-1",
		planId,
		generation: 1,
		round: 1,
		role: "plan-implementer",
		agentType: "herder.plan-implementer",
		model: "grok-4.5",
		effort: "high",
		workerMode: "INITIAL",
		taskName: `implement_${planId}`,
		worktree: `/tmp/worktree-${planId}`,
		branch: `herder/plans/${planId}`,
		assignmentPath: `/tmp/worktree-${planId}/herder-plans/${planId}.md`,
		assignmentSha256: "a".repeat(64),
		leaseReason: `lease-${planId}`,
		prompt: `Implement ${planId}`,
	};
}

class FakeSession {
	readonly sessionId: string;
	readonly messages: unknown[];
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	disposed = false;
	aborted = false;
	prompted = false;
	shutdowns = 0;
	readonly extensionRunner = {
		emit: async (event: { type: string }) => {
			if (event.type === "session_shutdown") this.shutdowns += 1;
		},
	} as unknown as AgentSession["extensionRunner"];
	private readonly gate?: Promise<void>;

	constructor(sessionId: string, inherited: unknown[] = [], gate?: Promise<void>) {
		this.sessionId = sessionId;
		this.messages = [...inherited];
		this.gate = gate;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(): Promise<void> {
		this.prompted = true;
		await this.gate;
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		this.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
		this.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "STATUS: COMPLETE\nCOMMITS: abcdef1\nCHECKS: pass\nFILES CHANGED: a\nDISCOVERED_PATHS: none\nNOTES: done\nUSAGE: source=test" }],
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
		};
		this.messages.push(message);
		this.emit({ type: "message_end", message: message as never });
		this.emit({ type: "agent_end", messages: this.messages as never[], willRetry: false });
		this.emit({ type: "agent_settled" });
	}

	async abort(): Promise<void> { this.aborted = true; }
	dispose(): void { this.disposed = true; }
	getSessionStats(): SessionStats {
		return {
			sessionFile: undefined,
			sessionId: this.sessionId,
			userMessages: this.prompted ? 1 : 0,
			assistantMessages: this.prompted ? 1 : 0,
			toolCalls: this.prompted ? 1 : 0,
			toolResults: this.prompted ? 1 : 0,
			totalMessages: this.messages.length,
			tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 16 },
			cost: 0,
			contextUsage: { tokens: 61_000, contextWindow: 100_000, percent: 61 },
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeFactory implements PiWorkerSessionFactory {
	readonly sessions: FakeSession[] = [];
	readonly nestedScopes: HerderNestedAgentScope[] = [];
	readonly childSessions: FakeSession[] = [];
	private readonly inherited: unknown[];
	private readonly gate?: Promise<void>;
	constructor(inherited: unknown[] = [], gate?: Promise<void>) {
		this.inherited = inherited;
		this.gate = gate;
	}
	async availableModels() { return [{ provider: "proxy", id: "grok-4.5" }]; }
	async create(request: PiWorkerRequest) {
		const session = new FakeSession(`session-${this.sessions.length + 1}`, this.inherited, this.gate);
		this.sessions.push(session);
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot,
			createSession: async ({ id }) => {
				const child = new FakeSession(`child-${id}`);
				this.childSessions.push(child);
				return child;
			},
		});
		this.nestedScopes.push(nested);
		return { session, nested };
	}
}

test("applyServiceTier pins every stream request and final provider payload", async () => {
	const seen: unknown[] = [];
	const session = {
		agent: {
			streamFunction: (_model: unknown, _context: unknown, options?: unknown) => {
				seen.push(options);
				return "stream";
			},
		},
	};
	applyServiceTier(session as never, "fast");
	const result = session.agent.streamFunction("model", "context", {
		reasoning: "max",
		onPayload: (payload: unknown) => ({ ...(payload as object), service_tier: "default", transformed: true }),
	});
	assert.equal(result, "stream");
	const first = seen[0] as { reasoning: string; serviceTier: string; onPayload: (payload: unknown, model: unknown) => Promise<unknown> };
	assert.equal(first.reasoning, "max");
	assert.equal(first.serviceTier, "priority");
	assert.deepEqual(await first.onPayload({ model: "gpt-5.6-luna" }, "model"), {
		model: "gpt-5.6-luna",
		service_tier: "priority",
		transformed: true,
	});
	session.agent.streamFunction("model", "context");
	const second = seen[1] as { serviceTier: string; onPayload: (payload: unknown, model: unknown) => Promise<unknown> };
	assert.equal(second.serviceTier, "priority");
	assert.deepEqual(await second.onPayload({ model: "gpt-5.6-luna" }, "model"), {
		model: "gpt-5.6-luna",
		service_tier: "priority",
	});
	await assert.rejects(() => second.onPayload("invalid", "model"), /non-object provider payload/);
	assert.throws(() => applyServiceTier(session as never, "flex"), /Unknown Herder service tier/);
});

test("Pi worker admission rejects unknown and mismatched role identities", async () => {
	const factory = new DefaultPiWorkerSessionFactory(agentRoot);
	const unknown = action("unknown-role");
	unknown.agentType = "herder.unknown";
	await assert.rejects(
		() => factory.create({ action: unknown, planDirectory: "/tmp/herder-role-admission" }),
		/Unknown Herder Pi role/,
	);

	const mismatch = action("mismatched-role");
	mismatch.role = "plan-reviewer";
	await assert.rejects(
		() => factory.create({ action: mismatch, planDirectory: "/tmp/herder-role-admission" }),
		/does not match herder\.plan-implementer/,
	);
});

test("searcher policy is name-swap safe and confines local searches to the assigned worktree", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-searcher-policy-"));
	try {
		const worktree = path.join(root, "worktree");
		const sibling = path.join(root, "sibling");
		await mkdir(path.join(worktree, "src"), { recursive: true });
		await mkdir(sibling);
		await symlink(sibling, path.join(worktree, "escape"), "dir");
		const search: { queries: string[]; workflow?: string } = { queries: ["current docs"] };
		assert.equal(applySearcherToolPolicy("fetch_content", search, worktree), undefined);
		assert.equal(search.workflow, "none");
		const remote: { url: string; workflow?: string } = { url: "https://example.com" };
		assert.equal(applySearcherToolPolicy("web_search", remote, worktree), undefined);
		assert.equal(remote.workflow, "none");
		assert.deepEqual(applySearcherToolPolicy("web_search", { url: "file:///tmp/secret" }, worktree), {
			block: true,
			reason: "Herder searcher may fetch only remote URLs.",
		});
		for (const tool of ["fffind", "ffgrep", "find", "grep"]) {
			const local = { path: "src", workflow: "unchanged" };
			assert.equal(applySearcherToolPolicy(tool, local, worktree), undefined);
			assert.equal(local.workflow, "unchanged");
			assert.deepEqual(applySearcherToolPolicy(tool, { cursor: "opaque" }, worktree), {
				block: true,
				reason: "Herder searcher disables cross-call FFF cursors to preserve worktree confinement.",
			});
			for (const escaped of ["..", "../sibling", sibling, "~/secret", "escape/secret"]) {
				assert.deepEqual(applySearcherToolPolicy(tool, { path: escaped }, worktree), {
					block: true,
					reason: "Herder searcher may search only inside its assigned worktree.",
				});
			}
		}
		assert.deepEqual(applySearcherToolPolicy("unexpected", {}, worktree), {
			block: true,
			reason: "Herder searcher cannot call unexpected tool unexpected.",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("FFF tool resolution accepts default and override package modes", () => {
	const tools = ["read", "ffgrep", "fffind"];
	const extension = (names: string[]) => ({ tools: new Map(names.map((name) => [name, {}])) });
	assert.deepEqual(resolveFffToolNames(tools, [extension(["ffgrep", "fffind"])]), tools);
	assert.deepEqual(resolveFffToolNames(tools, [extension(["grep", "find"])]), ["read", "grep", "find"]);
	assert.throws(() => resolveFffToolNames(tools, [extension([])]), /did not register its required find and grep tools/);
});

test("npm extensions resolve only from their exact trusted user package paths", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-npm-extension-"));
	try {
		const agentDir = path.join(root, "agent");
		const web = path.join(agentDir, "npm/node_modules/pi-web-access");
		const fff = path.join(agentDir, "npm/node_modules/@ff-labs/pi-fff");
		await mkdir(web, { recursive: true });
		await mkdir(fff, { recursive: true });
		assert.equal(trustedNestedExtensionPath(agentDir, web, "npm:pi-web-access"), await realpath(web));
		assert.equal(trustedNestedExtensionPath(agentDir, fff, "npm:@ff-labs/pi-fff"), await realpath(fff));

		const sibling = path.join(agentDir, "npm/node_modules/shadow");
		await mkdir(sibling);
		assert.throws(
			() => trustedNestedExtensionPath(agentDir, sibling, "npm:pi-web-access"),
			/does not resolve to its exact trusted package path/,
		);
		assert.throws(
			() => trustedNestedExtensionPath(agentDir, web, "npm:@ff-labs/pi-fff"),
			/does not resolve to its exact trusted package path/,
		);

		const outsidePackage = path.join(root, "outside/pi-web-access");
		await mkdir(outsidePackage, { recursive: true });
		const shadow = path.join(agentDir, "npm/node_modules/outside-shadow");
		await symlink(outsidePackage, shadow, "dir");
		assert.throws(
			() => trustedNestedExtensionPath(agentDir, shadow, "npm:pi-web-access"),
			/resolves outside the trusted user package store/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("role extensions resolve only the exact entry inside the trusted user git package", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-role-extension-"));
	try {
		const agentDir = path.join(root, "agent");
		const installed = path.join(agentDir, "git/github.com/DietrichGebert/ponytail");
		const entry = path.join(installed, "pi-extension/index.js");
		await mkdir(path.dirname(entry), { recursive: true });
		await writeFile(entry, "export default () => {};");
		const source = "git:github.com/DietrichGebert/ponytail";
		assert.equal(trustedRoleExtensionEntry(agentDir, installed, source), await realpath(entry));

		await rm(entry);
		await assert.rejects(
			async () => trustedRoleExtensionEntry(agentDir, installed, source),
			/pi install git:github\.com\/DietrichGebert\/ponytail/,
		);

		const outsideEntry = path.join(root, "outside-index.js");
		await writeFile(outsideEntry, "export default () => {};");
		await symlink(outsideEntry, entry, "file");
		assert.throws(
			() => trustedRoleExtensionEntry(agentDir, installed, source),
			/entry resolves outside the trusted user package/,
		);

		await rm(installed, { recursive: true, force: true });
		const siblingPackage = path.join(agentDir, "git/github.com/example/sibling");
		await mkdir(path.join(siblingPackage, "pi-extension"), { recursive: true });
		await writeFile(path.join(siblingPackage, "pi-extension/index.js"), "export default () => {};");
		await mkdir(path.dirname(installed), { recursive: true });
		await symlink(siblingPackage, installed, "dir");
		assert.throws(
			() => trustedRoleExtensionEntry(agentDir, installed, source),
			/does not resolve to the exact trusted Ponytail package/,
		);

		const outsidePackage = path.join(root, "outside-package");
		await mkdir(path.join(outsidePackage, "pi-extension"), { recursive: true });
		await writeFile(path.join(outsidePackage, "pi-extension/index.js"), "export default () => {};");
		const shadow = path.join(agentDir, "git/github.com/DietrichGebert/shadow");
		await symlink(outsidePackage, shadow, "dir");
		assert.throws(
			() => trustedRoleExtensionEntry(agentDir, shadow, source),
			/resolves outside the trusted user git store/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("production factory loads exact role extensions and nested worker extensions without widening tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-role-extension-runtime-"));
	try {
		const agentDir = path.join(root, "agent");
		const ponytail = path.join(agentDir, "git/github.com/DietrichGebert/ponytail/pi-extension/index.js");
		const fff = path.join(agentDir, "npm/node_modules/@ff-labs/pi-fff");
		const events = path.join(root, "events.log");
		await mkdir(path.dirname(ponytail), { recursive: true });
		await writeFile(ponytail, `import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", () => appendFileSync(${JSON.stringify(events)}, "ponytail-start\\n"));
	pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(events)}, "ponytail-shutdown\\n"));
	pi.on("before_agent_start", (event) => {
		appendFileSync(${JSON.stringify(events)}, "ponytail-before\\n");
		return { systemPrompt: event.systemPrompt + "\\nPONYTAIL_TEST" };
	});
}
`);
		await mkdir(fff, { recursive: true });
		await writeFile(path.join(fff, "package.json"), JSON.stringify({
			name: "@ff-labs/pi-fff",
			type: "module",
			pi: { extensions: ["./index.js"] },
		}));
		await writeFile(path.join(fff, "index.js"), `import { appendFileSync } from "node:fs";
const parameters = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
export default function (pi) {
	pi.on("session_start", () => appendFileSync(${JSON.stringify(events)}, "fff-start\\n"));
	pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(events)}, "fff-shutdown\\n"));
	const names = process.env.PI_FFF_MODE === "override" ? ["find", "grep"] : ["fffind", "ffgrep"];
	for (const name of names) pi.registerTool({
		name,
		label: name,
		description: name,
		parameters,
		async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
	});
}
`);
		const worktree = path.join(root, "worktree");
		const planDirectory = path.join(worktree, "herder-plans");
		await mkdir(planDirectory, { recursive: true });
		const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
		const faux = fauxProvider({ provider: "test", models: [{ id: "test-model", reasoning: true }] });
		runtime.registerNativeProvider(faux.provider);
		const factory = new DefaultPiWorkerSessionFactory(agentRoot, agentDir);
		factory.bindModelRegistry(new ModelRegistry(runtime));
		const roleAction = (role: ManagerAction["role"]): ManagerAction => ({
			...action(),
			role,
			agentType: `herder.${role}`,
			model: "test/test-model",
			effort: "high",
			worktree,
			assignmentPath: path.join(planDirectory, "001.md"),
		});

		for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"] as const) {
			const prepared = await factory.create({ action: roleAction(role), planDirectory });
			const session = prepared.session as AgentSession;
			const hasPonytail = session.extensionRunner.hasHandlers("before_agent_start");
			assert.equal(hasPonytail, role === "plan-implementer");
			assert.deepEqual(
				session.agent.state.tools.map((tool) => tool.name).sort(),
				(role === "plan-implementer"
					? ["read", "edit", "write", "bash", "ffgrep", "fffind", "ls", "Agent", "get_subagent_result"]
					: ["read", "bash", "ffgrep", "fffind", "ls", "Agent", "get_subagent_result"]).sort(),
			);
			if (role === "plan-implementer") {
				const injected = await session.extensionRunner.emitBeforeAgentStart("task", undefined, "BASE", {} as never);
				assert.match(injected?.systemPrompt ?? "", /BASE\nPONYTAIL_TEST/);
			}
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await prepared.nested.stop("test cleanup");
		}

		const beforeDiscard = (await readFile(events, "utf8")).trim().split("\n");
		const engine = new PiWorkerEngine(factory);
		const handle = await engine.prepare({ action: roleAction("plan-implementer"), planDirectory });
		await engine.discard(handle);
		const afterDiscard = (await readFile(events, "utf8")).trim().split("\n");
		assert.deepEqual(afterDiscard.slice(beforeDiscard.length).sort(), ["fff-shutdown", "fff-start", "ponytail-shutdown", "ponytail-start"]);

		const prepared = await factory.create({ action: roleAction("plan-implementer"), planDirectory });
		const beforeNested = (await readFile(events, "utf8")).trim().split("\n");
		faux.setResponses([fauxAssistantMessage("Nested worker result")]);
		const nestedResult = await prepared.nested.run({
			type: "worker",
			prompt: "Implement the bounded child task",
			description: "implement child task",
		});
		assert.equal(nestedResult.status, "completed");
		assert.equal(nestedResult.output, "Nested worker result");
		const afterNested = (await readFile(events, "utf8")).trim().split("\n");
		assert.deepEqual(afterNested.slice(beforeNested.length).sort(), ["fff-shutdown", "fff-start", "ponytail-before", "ponytail-shutdown", "ponytail-start"]);
		const parent = prepared.session as AgentSession;
		await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		parent.dispose();
		await prepared.nested.stop("test cleanup");

		const previousFffMode = process.env.PI_FFF_MODE;
		process.env.PI_FFF_MODE = "override";
		try {
			const overridden = await factory.create({ action: roleAction("plan-reviewer"), planDirectory });
			const overriddenSession = overridden.session as AgentSession;
			assert.deepEqual(
				overriddenSession.agent.state.tools.map((tool) => tool.name).sort(),
				["read", "bash", "grep", "find", "ls", "Agent", "get_subagent_result"].sort(),
			);
			await overriddenSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			overriddenSession.dispose();
			await overridden.nested.stop("test cleanup");
		} finally {
			if (previousFffMode === undefined) delete process.env.PI_FFF_MODE;
			else process.env.PI_FFF_MODE = previousFffMode;
		}

		await rm(fff, { recursive: true, force: true });
		await assert.rejects(
			() => factory.create({ action: roleAction("plan-reviewer"), planDirectory }),
			/Install it explicitly with: pi install npm:@ff-labs\/pi-fff/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("built-in Pi engine starts an exact clean worker and reports its terminal directly", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	assert.equal(handle, "pi-worker:session-1");
	assert.equal(factory.sessions[0]!.messages.length, 0);
	assert.equal(engine.snapshots()[0]!.status, "prepared");
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.actionId, "action-1");
	assert.match(result.response || "", /^STATUS: COMPLETE/);
	assert.equal(result.interrupted, undefined);
	assert.equal(result.usage.inputTokens, 10);
	assert.equal(result.usage.reasoningTokens, 3);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(factory.sessions[0]!.disposed, true);
	assert.deepEqual(engine.snapshots(), []);
});

test("built-in Pi engine fails closed if a session contains inherited history", async () => {
	const inherited = [{ role: "assistant", content: [{ type: "text", text: "parent" }] }];
	const factory = new FakeFactory(inherited);
	const engine = new PiWorkerEngine(factory);
	await assert.rejects(() => engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" }), /zero inherited messages/);
	assert.equal(factory.sessions[0]!.shutdowns, 1);
	assert.equal(factory.sessions[0]!.disposed, true);
});

test("built-in Pi engine starts every manager-admitted worker without a private queue", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const factory = new FakeFactory([], gate);
	const engine = new PiWorkerEngine(factory);
	const handles = await Promise.all([
		engine.prepare({ action: action("action-1", "001"), planDirectory: "/tmp/repo/herder-plans" }),
		engine.prepare({ action: action("action-2", "002"), planDirectory: "/tmp/repo/herder-plans" }),
	]);
	for (const handle of handles) engine.start(handle);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(factory.sessions.every((session) => session.prompted), true);
	assert.equal(engine.snapshots().filter((worker) => worker.status === "running").length, 2);
	release();
	while (engine.snapshots().length > 0) await new Promise((resolve) => setImmediate(resolve));
});

test("stopping a worker waits until its session and terminal listeners settle", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const factory = new FakeFactory([], gate);
	const engine = new PiWorkerEngine(factory);
	let terminalSeen = false;
	engine.onTerminal(async () => {
		await new Promise((resolve) => setImmediate(resolve));
		terminalSeen = true;
	});
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	engine.start(handle);
	const stopping = engine.stop(handle);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(factory.sessions[0]!.aborted, true);
	assert.equal(terminalSeen, false);
	release();
	await stopping;
	assert.equal(terminalSeen, true);
	assert.deepEqual(engine.snapshots(), []);
});

test("worker terminals retain transport and provider diagnostics", async () => {
	class FailingSession extends FakeSession {
		override async prompt(): Promise<void> {
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text: "  partial output  \n" }],
				stopReason: "error",
				errorMessage: "provider failed",
			});
			throw new Error("transport failed");
		}
	}
	const session = new FailingSession("session-failed");
	const factory: PiWorkerSessionFactory = {
		async availableModels() { return [{ provider: "proxy", id: "grok-4.5" }]; },
		async create(request) {
			return {
				session,
				nested: new HerderNestedAgentScope({
					action: request.action,
					agentRoot,
					createSession: async () => { throw new Error("unused"); },
				}),
			};
		},
	};
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.response, "  partial output  \n");
	assert.equal(result.error, "transport failed\nprovider failed");
});

test("worker terminals preserve distinct no-result and empty-content behavior", async () => {
	class CaseSession extends FakeSession {
		private readonly message?: unknown;
		constructor(id: string, message?: unknown) {
			super(id);
			this.message = message;
		}
		override async prompt(): Promise<void> {
			if (this.message !== undefined) this.messages.push(this.message);
		}
	}
	async function run(message: unknown, id: string): Promise<PiWorkerTerminal> {
		const session = new CaseSession(`session-${id}`, message);
		const factory: PiWorkerSessionFactory = {
			async availableModels() { return [{ provider: "proxy", id: "grok-4.5" }]; },
			async create(request) {
				return {
					session,
					nested: new HerderNestedAgentScope({
						action: request.action,
						agentRoot,
						createSession: async () => { throw new Error("unused"); },
					}),
				};
			},
		};
		const engine = new PiWorkerEngine(factory);
		const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
		const handle = await engine.prepare({ action: action(`action-${id}`), planDirectory: "/tmp/repo/herder-plans" });
		engine.start(handle);
		return await terminal;
	}
	const missing = await run(undefined, "missing");
	assert.equal(missing.interrupted, true);
	assert.equal(missing.error, "Pi worker returned no assistant result.");
	const empty = await run({ role: "assistant", content: [{ type: "text", text: "  \n" }], stopReason: "stop" }, "empty");
	assert.equal(empty.interrupted, true);
	assert.equal(empty.error, "Pi worker produced no terminal result");
	const noTextBlock = await run({ role: "assistant", content: [{ type: "image", data: "ignored" }], stopReason: "stop" }, "no-text-block");
	assert.equal(noTextBlock.interrupted, true);
	assert.equal(noTextBlock.error, "Pi worker produced no terminal result");
	const zeroLength = await run({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" }, "zero-length");
	assert.equal(zeroLength.interrupted, true);
	assert.equal(zeroLength.error, "Pi worker produced no terminal result");
	const padded = await run({ role: "assistant", content: [{ type: "text", text: "  padded child  " }], stopReason: "stop" }, "padded");
	assert.equal(padded.response, "  padded child  ");
	const provider = await run({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "provider failed" }, "provider");
	assert.equal(provider.error, "provider failed");
});

test("worker lifetime usage excludes cache reads and compaction usage while context stays current", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	const session = factory.sessions[0]!;
	session.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Checking the tree" }],
			usage: { input: 10, output: 5, cacheRead: 10_000, cacheWrite: 2 },
		} as never,
	});
	session.emit({
		type: "message_end",
		message: { role: "user", content: "ignore", usage: { input: 999, output: 999, cacheWrite: 999 } } as never,
	});
	session.emit({
		type: "compaction_end",
		reason: "threshold",
		aborted: false,
		willRetry: false,
		result: {
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 40_000,
			usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, totalTokens: 185, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	});
	let snapshot = engine.snapshots()[0]!;
	assert.equal(snapshot.lifetimeTokens, 17);
	assert.equal(snapshot.contextPercent, 61);
	assert.equal(snapshot.compactionCount, 1);
	assert.equal(snapshot.responseText, "Checking the tree");

	session.emit({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false, result: undefined });
	snapshot = engine.snapshots()[0]!;
	assert.equal(snapshot.lifetimeTokens, 17);
	assert.equal(snapshot.compactionCount, 1);
});

test("worker snapshots receive flat child state directly from the internal nested scope", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	assert.deepEqual(engine.snapshots()[0]!.children, []);
	const child = await factory.nestedScopes[0]!.run({
		type: "recon",
		prompt: "Inspect code",
		description: "inspect code",
	});
	assert.equal(child.status, "completed");
	const snapshot = engine.snapshots()[0]!.children[0]!;
	assert.equal(snapshot.type, "recon");
	assert.equal(snapshot.status, "completed");
	assert.equal(snapshot.turns, 1);
	assert.equal(snapshot.toolUses, 1);
	assert.equal("children" in snapshot, false);
});

test("worker completion fails closed when a background child was not collected", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	const launch = await factory.nestedScopes[0]!.spawnBackground({ type: "recon", prompt: "Inspect", description: "inspect" });
	assert.deepEqual(factory.nestedScopes[0]!.uncollectedBackgroundIds(), [launch.id]);
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.interrupted, true);
	assert.match(result.error || "", /completed without collecting background nested agents/);
	assert.match(result.error || "", new RegExp(launch.id));
});

test("worker terminal keeps parent usage separate from nested model slices", async () => {
	const factory = new FakeFactory();
	const engine = new PiWorkerEngine(factory);
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
	const handle = await engine.prepare({ action: action(), planDirectory: "/tmp/repo/herder-plans" });
	await factory.nestedScopes[0]!.run({ type: "recon", prompt: "Inspect", description: "inspect" });
	engine.start(handle);
	const result = await terminal;
	assert.equal(result.usage.inputTokens, 10);
	assert.equal(result.usage.cachedInputTokens, 2);
	assert.equal(result.usage.outputTokens, 5);
	assert.equal(result.usage.reasoningTokens, 3);
	assert.equal(result.usage.source, "herder pi worker session");
	assert.deepEqual(result.usage.nested, [{
		type: "recon",
		model: "gpt-5.6-luna",
		effort: "max",
		serviceTier: "fast",
		count: 1,
		inputTokens: 10,
		cachedInputTokens: 2,
		outputTokens: 5,
		reasoningTokens: 3,
		durationMs: result.usage.nested?.[0]?.durationMs,
	}]);
	assert.equal(typeof result.usage.nested?.[0]?.durationMs, "number");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(engine.snapshots(), []);
});

test("assistant extraction uses only the exact final child response", () => {
	assert.deepEqual(finalAssistantResult([
		{ role: "assistant", content: [{ type: "text", text: "draft" }], stopReason: "toolUse" },
		{ role: "toolResult", content: [{ type: "text", text: "result" }] },
		{ role: "assistant", content: [{ type: "text", text: "  VERDICT: APPROVE  \n" }], stopReason: "stop" },
	]), { text: "  VERDICT: APPROVE  \n", failed: false });
});
