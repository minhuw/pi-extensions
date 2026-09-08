import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type SessionStats } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import { HerderNestedAgentScope, type NestedSessionCreator, type NestedWorkerSession } from "../../../adapters/nested-agent-executor.ts";
import { Deferred } from "./helpers/harness.ts";
import {
	applyNestedAbortSignal,
	applySearcherToolPolicy,
	applyServiceTier,
	DefaultPiWorkerSessionFactory,
	finalAssistantResult,
	PiWorkerEngine,
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

test("searcher policy confines built-in local searches to the assigned worktree", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-searcher-policy-"));
	try {
		const worktree = path.join(root, "worktree");
		const sibling = path.join(root, "sibling");
		await mkdir(path.join(worktree, "src"), { recursive: true });
		await mkdir(sibling);
		await symlink(sibling, path.join(worktree, "escape"), "dir");
		await symlink(sibling, path.join(worktree, "escape "), "dir");
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
		for (const tool of ["find", "grep"]) {
			const local = { path: "src", workflow: "unchanged" };
			assert.equal(applySearcherToolPolicy(tool, local, worktree), undefined);
			assert.equal(local.workflow, "unchanged");
			for (const escaped of ["..", "../sibling", sibling, "~/secret", "escape/secret", "escape\u00A0/secret", "@../sibling", `@${sibling}`, `file://${sibling}`]) {
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

test("npm extensions resolve only from their exact trusted user package paths", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-npm-extension-"));
	try {
		const agentDir = path.join(root, "agent");
		const web = path.join(agentDir, "npm/node_modules/pi-web-access");
		await mkdir(web, { recursive: true });
		assert.equal(trustedNestedExtensionPath(agentDir, web, "npm:pi-web-access"), await realpath(web));
		assert.throws(
			() => trustedNestedExtensionPath(agentDir, web, "npm:untrusted-extension"),
			/Herder npm extension npm:untrusted-extension is not allowed/,
		);

		const sibling = path.join(agentDir, "npm/node_modules/shadow");
		await mkdir(sibling);
		assert.throws(
			() => trustedNestedExtensionPath(agentDir, sibling, "npm:pi-web-access"),
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

test("production factory loads exact role and nested extensions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-role-extension-runtime-"));
	try {
		const agentDir = path.join(root, "agent");
		const ponytail = path.join(agentDir, "git/github.com/DietrichGebert/ponytail/pi-extension/index.js");
		const web = path.join(agentDir, "npm/node_modules/pi-web-access");
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
		await mkdir(web, { recursive: true });
		await writeFile(path.join(web, "package.json"), JSON.stringify({
			name: "pi-web-access",
			type: "module",
			pi: { extensions: ["./index.js"] },
		}));
		await writeFile(path.join(web, "index.js"), `import { appendFileSync } from "node:fs";
const parameters = { type: "object", properties: {} };
export default function (pi) {
	for (const name of ["web_search", "source_check", "fetch_content", "get_search_content", "unexpected_web_tool"]) pi.registerTool({
		name,
		label: name,
		description: name,
		parameters,
		async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
	});
	pi.on("session_start", () => appendFileSync(${JSON.stringify(events)}, "web-start\\n"));
	pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(events)}, "web-shutdown\\n"));
}
`);
		await writeFile(events, "");
		const eventLines = async () => (await readFile(events, "utf8")).split("\n").filter(Boolean);
		const worktree = path.join(root, "worktree");
		const planDirectory = path.join(worktree, "herder-plans");
		await mkdir(planDirectory, { recursive: true });
		const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
		const faux = fauxProvider({
			api: "openai-responses",
			provider: "test",
			models: [{ id: "test-model", reasoning: true }, { id: "gpt-5.6-luna", reasoning: true }],
		});
		Object.assign(faux.getModel("gpt-5.6-luna")!, {
			thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		});
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
			const beforeRole = await eventLines();
			const prepared = await factory.create({ action: roleAction(role), planDirectory });
			const session = prepared.session as AgentSession;
			assert.equal(session.messages.length, 0);
			const hasPonytail = session.extensionRunner.hasHandlers("before_agent_start");
			assert.equal(hasPonytail, role === "plan-implementer");
			assert.deepEqual(
				session.agent.state.tools.map((tool) => tool.name).sort(),
				(role === "plan-implementer"
					? ["read", "edit", "write", "bash", "grep", "find", "ls", "Agent", "get_subagent_result"]
					: ["read", "bash", "grep", "find", "ls", "Agent", "get_subagent_result"]).sort(),
			);
			if (role === "plan-implementer") {
				const injected = await session.extensionRunner.emitBeforeAgentStart("task", undefined, "BASE", {} as never);
				assert.match(injected?.systemPrompt ?? "", /BASE\nPONYTAIL_TEST/);
			}
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await prepared.nested.stop("test cleanup");
			const afterRole = await eventLines();
			assert.deepEqual(
				afterRole.slice(beforeRole.length).sort(),
				role === "plan-implementer" ? ["ponytail-before", "ponytail-shutdown", "ponytail-start"] : [],
			);
		}

		const beforeDiscard = await eventLines();
		const engine = new PiWorkerEngine(factory);
		const handle = await engine.prepare({ action: roleAction("plan-implementer"), planDirectory });
		await engine.discard(handle);
		const afterDiscard = await eventLines();
		assert.deepEqual(afterDiscard.slice(beforeDiscard.length).sort(), ["ponytail-shutdown", "ponytail-start"]);

		// Exercise the production override, not just advertised tool names, at both Recon depths.
		await mkdir(path.join(worktree, "src"));
		await mkdir(path.join(worktree, ".herder"), { recursive: true });
		await writeFile(path.join(worktree, "src/probe.ts"), "RECON_PROBE allowed source\n");
		await writeFile(path.join(worktree, ".herder/transcript.jsonl"), "RECON_PROBE forbidden transcript\n");
		await writeFile(path.join(root, "outside-secret"), "forbidden coordinator\n");
		const probeCalls = [
			fauxToolCall("read", { path: "../outside-secret" }),
			fauxToolCall("read", { path: "src/probe.ts" }),
			fauxToolCall("grep", { pattern: "RECON_PROBE", glob: "**/*" }),
		];
		const prepared = await factory.create({ action: roleAction("plan-implementer"), planDirectory });
		const nestedCases = [
			{ type: "recon", tools: ["read", "grep", "find", "ls"], events: [] },
			{ type: "searcher", tools: ["web_search", "source_check", "fetch_content", "get_search_content", "find", "grep"], events: ["web-shutdown", "web-start"] },
			{ type: "worker", tools: ["read", "edit", "write", "bash", "grep", "find", "ls"], events: ["ponytail-before", "ponytail-shutdown", "ponytail-start"] },
		] as const;
		for (const nestedCase of nestedCases) {
			const beforeNested = await eventLines();
			let providerTools: string[] = [];
			const respond: Parameters<typeof faux.setResponses>[0][number] = (context) => {
				providerTools = (context.tools ?? []).map((tool) => tool.name).sort();
				if (nestedCase.type === "recon") {
					const results = context.messages.filter((entry) => entry.role === "toolResult");
					if (results.length === 0) return fauxAssistantMessage(probeCalls, { stopReason: "toolUse" });
					assert.equal(results.length, 3);
					assert.equal(results[0]!.isError, true);
					assert.match(JSON.stringify(results[0]!.content), /Recon filesystem scope denied/);
					assert.equal(results[1]!.isError, false);
					assert.match(JSON.stringify(results[1]!.content), /allowed source/);
					assert.equal(results[2]!.isError, false);
					assert.match(JSON.stringify(results[2]!.content), /probe.ts:1:/);
					assert.doesNotMatch(JSON.stringify(results[2]!.content), /forbidden/);
				}
				return fauxAssistantMessage(`Nested ${nestedCase.type} result`);
			};
			faux.setResponses([respond, respond]);
			const nestedResult = await prepared.nested.run({
				type: nestedCase.type,
				prompt: `Run the bounded ${nestedCase.type} task`,
				description: `${nestedCase.type} child task`,
			});
			assert.equal(nestedResult.status, "completed");
			assert.equal(nestedResult.output, `Nested ${nestedCase.type} result`);
			assert.deepEqual(providerTools, [...nestedCase.tools].sort());
			const afterNested = await eventLines();
			assert.deepEqual(afterNested.slice(beforeNested.length).sort(), [...nestedCase.events].sort());
		}
		const parent = prepared.session as AgentSession;
		await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		parent.dispose();
		await prepared.nested.stop("test cleanup");

		const beforeReview = await eventLines();
		const review = await factory.create({ action: { ...roleAction("plan-reviewer"), serviceTier: "fast" }, planDirectory });
		try {
			const observedModels: string[] = [];
			const respond: Parameters<typeof faux.setResponses>[0][number] = (context, options, _state, model) => {
				observedModels.push(model.id);
				const tools = (context.tools ?? []).map((tool) => tool.name).sort();
				assert.equal((options as { serviceTier?: string } | undefined)?.serviceTier, "priority");
				if (model.id === "gpt-5.6-luna") {
					assert.deepEqual(tools, ["read", "grep", "find", "ls"].sort());
					assert.equal(options?.reasoning, "max");
					const results = context.messages.filter((entry) => entry.role === "toolResult");
					if (results.length === 0) {
						assert.equal(context.messages.length, 1, "scout starts with its own task only");
						return fauxAssistantMessage(probeCalls, { stopReason: "toolUse" });
					}
					assert.equal(results.length, 3);
					assert.equal(results[0]!.isError, true);
					assert.match(JSON.stringify(results[0]!.content), /Recon filesystem scope denied/);
					assert.equal(results[1]!.isError, false);
					assert.match(JSON.stringify(results[1]!.content), /allowed source/);
					assert.equal(results[2]!.isError, false);
					assert.match(JSON.stringify(results[2]!.content), /probe.ts:1:/);
					assert.doesNotMatch(JSON.stringify(results[2]!.content), /forbidden/);
					return fauxAssistantMessage("STATUS: ANSWERED\nANSWER: source trace\nEVIDENCE: src/probe.ts:1\nREMAINING: none");
				}
				assert.equal(model.id, "test-model");
				assert.equal(options?.reasoning, "high");
				assert.deepEqual(tools, ["read", "bash", "grep", "find", "ls", "Agent", "get_subagent_result"].sort());
				const results = context.messages.filter((entry) => entry.role === "toolResult");
				if (results.length === 0) {
					assert.equal(context.messages.length, 1, "reviewer starts with its own task only");
					return fauxAssistantMessage(fauxToolCall("Agent", {
						subagent_type: "recon", prompt: "Trace the exported symbol", description: "trace exported symbol",
					}), { stopReason: "toolUse" });
				}
				if (results.length === 1) {
					assert.notEqual(results[0]!.isError, true);
					return fauxAssistantMessage([
						fauxToolCall("bash", { command: "printf herder-review-check", timeout: 5 }),
						fauxToolCall("Agent", { subagent_type: "reviewer", prompt: "Review", description: "reject deeper reviewer" }),
						fauxToolCall("Agent", { subagent_type: "worker", prompt: "Edit", description: "reject mutation worker" }),
					], { stopReason: "toolUse" });
				}
				assert.equal(results.length, 4);
				const shell = results.find((entry) => entry.toolName === "bash")!;
				assert.ok(shell.content.some((part) => part.type === "text" && part.text.includes("herder-review-check")));
				assert.equal(results.filter((entry) => entry.isError).length, 2, "reviewer scope rejects wider delegation");
				return fauxAssistantMessage("Review complete with source and runtime evidence");
			};
			faux.setResponses(Array.from({ length: 20 }, () => respond));
			const results = await Promise.all(Array.from({ length: 4 }, (_, index) => review.nested.run({
				type: "reviewer", prompt: `Review shard ${index}`, description: `review shard ${index}`,
			})));
			for (const result of results) assert.equal(result.status, "completed", result.error ?? result.output);
			assert.equal(observedModels.filter((model) => model === "test-model").length, 12);
			assert.equal(observedModels.filter((model) => model === "gpt-5.6-luna").length, 8);
			const snapshots = review.nested.treeSnapshots();
			assert.equal(snapshots.length, 8);
			for (const result of results) {
				assert.equal(result.model, "test/test-model");
				assert.equal(result.effort, "high");
				assert.equal(result.serviceTier, "fast");
				assert.equal(snapshots.filter((child) => child.parentAgentId === result.id).length, 1);
			}
			assert.deepEqual(review.nested.usageSlices().map(({ type, count }) => ({ type, count })), [
				{ type: "recon", count: 4 }, { type: "reviewer", count: 4 },
			]);
		} finally {
			await review.nested.stop("test cleanup");
			const reviewSession = review.session as AgentSession;
			await reviewSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			reviewSession.dispose();
		}
		assert.deepEqual((await eventLines()).slice(beforeReview.length), []);

		await rm(web, { recursive: true, force: true });
		const missingWebParent = await factory.create({ action: roleAction("plan-reviewer"), planDirectory });
		try {
			const missingWeb = await missingWebParent.nested.run({
				type: "searcher",
				prompt: "Find external documentation",
				description: "find external documentation",
			});
			assert.equal(missingWeb.status, "error");
			assert.match(
				missingWeb.error ?? "",
				/Herder nested extension npm:pi-web-access is not installed.*pi install npm:pi-web-access/,
			);
		} finally {
			const missingWebSession = missingWebParent.session as AgentSession;
			await missingWebSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			missingWebSession.dispose();
			await missingWebParent.nested.stop("test cleanup");
		}

		const missingPonytailParent = await factory.create({ action: roleAction("plan-implementer"), planDirectory });
		await rm(path.dirname(path.dirname(ponytail)), { recursive: true, force: true });
		try {
			const missingPonytail = await missingPonytailParent.nested.run({
				type: "worker",
				prompt: "Implement the bounded child task",
				description: "implement child task",
			});
			assert.equal(missingPonytail.status, "error");
			assert.match(
				missingPonytail.error ?? "",
				/Herder nested extension git:github\.com\/DietrichGebert\/ponytail is not installed.*pi install git:github\.com\/DietrichGebert\/ponytail/,
			);
		} finally {
			const missingPonytailSession = missingPonytailParent.session as AgentSession;
			await missingPonytailSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			missingPonytailSession.dispose();
			await missingPonytailParent.nested.stop("test cleanup");
		}
		await assert.rejects(
			() => factory.create({ action: roleAction("plan-implementer"), planDirectory }),
			/Herder role extension git:github\.com\/DietrichGebert\/ponytail is not installed.*pi install git:github\.com\/DietrichGebert\/ponytail/,
		);

		const beforeExtensionless = await eventLines();
		const extensionlessReviewer = await factory.create({ action: roleAction("plan-reviewer"), planDirectory });
		try {
			faux.setResponses([() => fauxAssistantMessage("Extensionless recon result")]);
			const recon = await extensionlessReviewer.nested.run({
				type: "recon",
				prompt: "Inspect built-in search",
				description: "inspect built-in search",
			});
			assert.equal(recon.status, "completed");
			assert.equal(recon.output, "Extensionless recon result");
		} finally {
			const reviewerSession = extensionlessReviewer.session as AgentSession;
			await reviewerSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			reviewerSession.dispose();
			await extensionlessReviewer.nested.stop("test cleanup");
		}
		assert.deepEqual((await eventLines()).slice(beforeExtensionless.length), []);
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

class BudgetSession extends FakeSession {
	readonly started = new Deferred<void>();
	readonly promptDone = new Deferred<void>();
	readonly abortDone = new Deferred<void>();
	readonly shutdownDone = new Deferred<void>();
	promptText = "";
	promptOptions?: unknown;
	promptError?: string;
	providerError?: string;
	abortError?: string;
	abortCalls = 0;
	holdShutdown = false;
	shutdownStarted = false;
	override readonly extensionRunner = {
		emit: async () => this.shutdown(),
	} as unknown as AgentSession["extensionRunner"];
	override async prompt(text = "", options?: unknown): Promise<void> {
		this.prompted = true;
		this.promptText = text;
		this.promptOptions = options;
		this.started.resolve();
		await this.promptDone.promise;
		this.messages.push({
			role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE\nSCOPE: PASS" }],
			stopReason: this.providerError ? "error" : "stop", errorMessage: this.providerError,
		});
		if (this.promptError) throw new Error(this.promptError);
	}
	override async abort(): Promise<void> {
		this.aborted = true;
		this.abortCalls += 1;
		await this.abortDone.promise;
		if (this.abortError) throw new Error(this.abortError);
	}
	async shutdown(): Promise<void> {
		this.shutdownStarted = true;
		if (this.holdShutdown) await this.shutdownDone.promise;
	}
}

function reviewerAction(planId = "001"): ManagerAction {
	return { ...action("review", planId), role: "plan-reviewer", agentType: "herder.plan-reviewer", workerMode: planId === "RUN" ? "FINAL_AUDIT" : "DISCOVERY" };
}

function budgetFixture(timeoutMs?: number, parent = reviewerAction(), createSession: NestedSessionCreator = async () => { throw new Error("unused child"); }) {
	const session = new BudgetSession("budget-root");
	const nested = new HerderNestedAgentScope({ action: parent, agentRoot, createSession });
	const factory: PiWorkerSessionFactory = {
		availableModels: async () => [],
		create: async () => ({ session, nested }),
	};
	const engine = new PiWorkerEngine(factory, timeoutMs);
	const terminals: PiWorkerTerminal[] = [];
	const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal((result) => { terminals.push(result); resolve(result); }));
	return { session, nested, engine, terminals, terminal, request: { action: parent, planDirectory: "/tmp/budget-plans" } };
}

const reviewChild = { type: "reviewer", prompt: "Check a shard", description: "review shard" } as const;
const scoutChild = { ...reviewChild, type: "recon" } as const;

test("review timeout configuration is opt-in and rejects malformed environment or numeric overrides", () => {
	const original = process.env.HERDER_REVIEW_TIMEOUT_MS;
	try {
		for (const value of ["", " ", " 100", "100 ", "-1", "0", "1.5", "NaN", "Infinity", "1e3", "0x10", "100ms", "2147483648", "9007199254740992"]) {
			process.env.HERDER_REVIEW_TIMEOUT_MS = value;
			assert.throws(() => budgetFixture(), /HERDER_REVIEW_TIMEOUT_MS.*positive safe integer.*2147483647/);
		}
		for (const value of [NaN, Infinity, -1, 0, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => budgetFixture(value), /HERDER_REVIEW_TIMEOUT_MS/);
		}
		assert.doesNotThrow(() => budgetFixture(100), "numeric injection overrides the environment");
		for (const value of ["1", "2147483647"]) {
			process.env.HERDER_REVIEW_TIMEOUT_MS = value;
			assert.doesNotThrow(() => budgetFixture());
		}
		delete process.env.HERDER_REVIEW_TIMEOUT_MS;
		assert.doesNotThrow(() => budgetFixture());
	} finally {
		if (original === undefined) delete process.env.HERDER_REVIEW_TIMEOUT_MS;
		else process.env.HERDER_REVIEW_TIMEOUT_MS = original;
	}
});

for (const [planId, phase] of [["001", "retry"], ["RUN", "compaction"]] as const) {
	test(`root ${planId} reviewer deadline includes active SDK ${phase} and waits for prompt, abort and shutdown`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { engine, session, nested, terminal, terminals, request } = budgetFixture(100, reviewerAction(planId));
		session.holdShutdown = true;
		if (phase === "retry") session.abortError = "late abort rejection";
		const handle = await engine.prepare(request);
		t.mock.timers.tick(50_000);
		assert.equal(session.aborted, false, "prepare does not spend the review budget");
		const originalAction = structuredClone(request.action);
		engine.start(handle);
		engine.start(handle);
		assert.equal(engine.snapshots()[0]!.startedAt, 0, "preserve prepared-time telemetry independently of the review deadline");
		assert.deepEqual(request.action, originalAction, "budget notice must not mutate assignment identity");
		assert.ok(session.promptText.startsWith(originalAction.prompt));
		assert.match(session.promptText, /100ms total wall-clock; deadline 1970-01-01T00:00:50.100Z; 100ms remaining/);
		assert.match(session.promptText, /Reserve time.*synthesize/);
		assert.deepEqual(session.promptOptions, { expandPromptTemplates: false, source: "extension" });
		t.mock.timers.tick(50);
		session.emit({ type: "agent_end", messages: [], willRetry: true });
		session.emit(phase === "retry"
			? { type: "auto_retry_start", attempt: 1 } as AgentSessionEvent
			: { type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
		t.mock.timers.tick(49);
		assert.equal(session.aborted, false);
		t.mock.timers.tick(1);
		await assert.rejects(nested.spawnBackground(reviewChild), /scope is closed/);
		await nextTurn();
		assert.equal(session.aborted, true);
		assert.equal(engine.snapshots()[0]!.status, "stopping");
		session.emit({ type: "agent_start" });
		assert.equal(engine.snapshots()[0]!.status, "stopping", "late SDK events cannot restart a stopped worker");
		session.abortDone.resolve();
		await nextTurn();
		assert.equal(terminals.length, 0, "root prompt still owns the worker after abort settles");
		assert.equal(session.disposed, false);
		session.promptDone.resolve();
		await nextTurn();
		assert.equal(session.shutdownStarted, true);
		t.mock.timers.tick(5_001);
		assert.equal(terminals.length, 0, "root shutdown must settle before manager terminal/release");
		assert.equal(engine.has(handle), true);
		session.shutdownDone.resolve();
		const result = await terminal;
		assert.equal(result.failureKind, "review_budget_exhausted");
		assert.equal(result.interrupted, true);
		assert.match(result.response!, /VERDICT: APPROVE/, "partial approval cannot override host exhaustion");
		assert.match(result.error!, /wall-clock budget exhausted/);
		await nextTurn();
		t.mock.timers.tick(100_000);
		assert.equal(session.abortCalls, 2, "late agent_start needs a fresh abort, even when the first abort rejects");
		assert.equal(terminals.length, 1);
		assert.equal(session.disposed, true);
		assert.equal(engine.has(handle), false);
	});
}

test("reviewer timeout cascades to late descendants without releasing Bash-capable children early", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const child = new BudgetSession("nested-reviewer");
	const scout = new BudgetSession("grandchild-scout");
	child.holdShutdown = scout.holdShutdown = true;
	let childScope!: HerderNestedAgentScope;
	const { session, nested, engine, terminal, terminals, request } = budgetFixture(100, reviewerAction(), async ({ nestedScope }) => {
		if (nestedScope) { childScope = nestedScope; return child; }
		return scout;
	});
	const handle = await engine.prepare(request);
	engine.start(handle);
	t.mock.timers.tick(75);
	const launched = await nested.spawnBackground(reviewChild);
	await child.started.promise;
	t.mock.timers.tick(15);
	await childScope.spawnBackground(scoutChild);
	await scout.started.promise;
	t.mock.timers.tick(10);
	await nextTurn();
	assert.equal([session, child, scout].every((item) => item.aborted), true);
	await assert.rejects(childScope.spawnBackground(scoutChild), /scope is closed/);
	session.promptDone.resolve();
	await nextTurn();
	assert.equal(terminals.length, 0);
	session.abortDone.resolve();
	t.mock.timers.tick(5_000);
	await nextTurn();
	assert.equal(scout.disposed, true, "preserve recon's bounded cleanup guarantee");
	assert.equal(child.disposed, false);
	assert.equal(nested.activeCount(), 1);
	assert.equal(terminals.length, 0);
	assert.equal(engine.has(handle), true);
	child.promptDone.resolve();
	await nextTurn();
	assert.equal(child.shutdownStarted, true);
	child.abortDone.resolve();
	t.mock.timers.tick(10_000);
	await nextTurn();
	assert.equal(terminals.length, 0, "Bash-capable child shutdown is not bounded by the scout grace period");
	child.shutdownDone.resolve();
	assert.equal((await terminal).failureKind, "review_budget_exhausted");
	await nextTurn();
	assert.equal((await nested.result(launched.id, false)).result!.status, "stopped");
	assert.equal([session, child, scout].every((item) => item.disposed), true);
	assert.equal(engine.has(handle), false);
	// Abandoned scout SDK work is still observed; it cannot revive the worker.
	scout.promptDone.resolve(); scout.abortDone.resolve(); scout.shutdownDone.resolve();
	await nextTurn();
	assert.equal(terminals.length, 1);
});

test("reviewer deadline retains pending Bash-capable child creation until late cleanup settles", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const creation = new Deferred<NestedWorkerSession>();
	const child = new BudgetSession("late-reviewer");
	child.holdShutdown = true;
	const { session, nested, engine, terminal, terminals, request } = budgetFixture(100, reviewerAction(), async () => creation.promise);
	const handle = await engine.prepare(request);
	engine.start(handle);
	await nested.spawnBackground(reviewChild);
	t.mock.timers.tick(100);
	await nextTurn();
	session.promptDone.resolve(); session.abortDone.resolve();
	t.mock.timers.tick(10_000);
	await nextTurn();
	assert.equal(terminals.length, 0);
	assert.equal(engine.has(handle), true);
	creation.resolve(child);
	await nextTurn();
	assert.equal(child.prompted, false);
	assert.equal(child.aborted, true);
	assert.equal(child.shutdownStarted, true);
	child.abortDone.resolve();
	await nextTurn();
	assert.equal(terminals.length, 0);
	child.shutdownDone.resolve();
	assert.equal((await terminal).failureKind, "review_budget_exhausted");
	assert.equal(child.disposed, true);
});

test("one reviewer deadline remains active while successful prompt completion cleans up descendants", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const child = new BudgetSession("cleanup-reviewer");
	child.holdShutdown = true;
	const { session, nested, engine, terminal, request } = budgetFixture(100, reviewerAction(), async () => child);
	const handle = await engine.prepare(request);
	engine.start(handle);
	const runningChild = nested.run(reviewChild);
	await child.started.promise;
	session.promptDone.resolve();
	child.promptDone.resolve(); child.abortDone.resolve();
	await nextTurn();
	assert.equal(child.shutdownStarted, true);
	t.mock.timers.tick(100);
	await nextTurn();
	assert.equal(session.aborted, true);
	child.shutdownDone.resolve();
	await runningChild;
	await nextTurn();
	assert.equal(engine.has(handle), true, "root abort must settle even after the child is disposed");
	session.abortDone.resolve();
	assert.equal((await terminal).failureKind, "review_budget_exhausted");
});

test("explicit reviewer stop clears the deadline, shares abort and waits for terminal listeners", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const { engine, session, terminals, request } = budgetFixture(100);
	const listenerDone = new Deferred<void>();
	engine.onTerminal(async () => listenerDone.promise);
	const handle = await engine.prepare(request);
	engine.start(handle);
	const stops = [engine.stop(handle), engine.stop(handle)];
	let stopped = false;
	void Promise.all(stops).then(() => { stopped = true; });
	session.promptDone.resolve();
	await nextTurn();
	t.mock.timers.tick(1_000);
	assert.equal(terminals.length, 0, "root abort still owns the worker even though prompt settled");
	assert.equal(stopped, false);
	session.abortDone.resolve();
	await nextTurn();
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0]!.failureKind, undefined);
	assert.equal(terminals[0]!.interrupted, true);
	assert.equal(session.abortCalls, 1);
	assert.equal(stopped, false);
	listenerDone.resolve();
	await Promise.all(stops);
	assert.equal(engine.has(handle), false);
});

test("transport and provider failure before the deadline retain their classification during slow cleanup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	for (const kind of ["promptError", "providerError", "uncollected"] as const) {
		const child = new BudgetSession("failure-cleanup");
		const { engine, session, nested, terminal, request } = budgetFixture(100, reviewerAction(), async () => child);
		if (kind !== "uncollected") session[kind] = `${kind} failed`;
		const handle = await engine.prepare(request);
		engine.start(handle);
		const childResult = kind === "uncollected" ? nested.spawnBackground(reviewChild) : nested.run(reviewChild);
		await child.started.promise;
		session.promptDone.resolve();
		await nextTurn();
		t.mock.timers.tick(1_000);
		assert.equal(session.aborted, false);
		child.promptDone.resolve(); child.abortDone.resolve();
		await childResult;
		const result = await terminal;
		assert.equal(result.failureKind, undefined);
		assert.equal(result.interrupted, true);
		assert.match(result.error!, kind === "uncollected" ? /without collecting background nested agents/ : new RegExp(`${kind} failed`));
	}
});

test("normal reviewer completion, prepared discard and prepared stop leave no deadline behind", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	for (const mode of ["complete", "discard", "stop"] as const) {
		const { engine, session, terminal, terminals, request } = budgetFixture(100);
		const handle = await engine.prepare(request);
		if (mode === "complete") {
			engine.start(handle);
			session.promptDone.resolve();
			assert.equal((await terminal).interrupted, undefined);
			await nextTurn();
		} else await engine[mode](handle);
		t.mock.timers.tick(1_000);
		await nextTurn();
		assert.equal(session.abortCalls, 0);
		assert.equal(terminals.length, mode === "complete" ? 1 : 0);
		assert.equal(session.disposed, true);
		assert.equal(engine.has(handle), false);
	}
});

test("unset review budget and configured nonreview roles leave their prompt and lifetime unchanged", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const original = process.env.HERDER_REVIEW_TIMEOUT_MS;
	delete process.env.HERDER_REVIEW_TIMEOUT_MS;
	try {
		for (const role of ["plan-reviewer", "plan-implementer", "plan-judge"] as const) {
			const { engine, session, terminal, request } = budgetFixture(role === "plan-reviewer" ? undefined : 100, { ...action(), role, agentType: `herder.${role}` });
			const handle = await engine.prepare(request);
			engine.start(handle);
			t.mock.timers.tick(10_000);
			assert.equal(session.aborted, false);
			assert.equal(session.promptText, request.action.prompt);
			session.promptDone.resolve();
			assert.equal((await terminal).failureKind, undefined);
		}
	} finally {
		if (original === undefined) delete process.env.HERDER_REVIEW_TIMEOUT_MS;
		else process.env.HERDER_REVIEW_TIMEOUT_MS = original;
	}
});

test("all roles retain snapshots through root shutdown and terminal listeners, including a stop during shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	for (const role of ["plan-reviewer", "plan-implementer", "plan-judge"] as const) {
		const { engine, session, terminals, request } = budgetFixture(100, { ...action(), role, agentType: `herder.${role}` });
		session.holdShutdown = true;
		const listenerDone = new Deferred<void>();
		let inListener = false;
		const handle = await engine.prepare(request);
		engine.onTerminal(async () => {
			assert.equal(session.disposed, true);
			assert.equal(engine.has(handle), true);
			inListener = true;
			await listenerDone.promise;
		});
		engine.start(handle);
		session.promptDone.resolve();
		await nextTurn();
		assert.equal(session.shutdownStarted, true);
		assert.equal(terminals.length, 0);
		const stopping = engine.stop(handle);
		session.shutdownDone.resolve();
		await nextTurn();
		t.mock.timers.tick(10_000);
		assert.equal(inListener, false, "stop during shutdown still waits for SDK abort");
		assert.equal(engine.has(handle), true);
		session.abortDone.resolve();
		await nextTurn();
		assert.equal(terminals[0]!.interrupted, true);
		assert.equal(terminals[0]!.failureKind, undefined);
		assert.equal(inListener, true);
		listenerDone.resolve();
		await stopping;
		assert.equal(engine.has(handle), false);
	}
});

async function budgetSdkFixture(compaction: boolean) {
	const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
	const faux = fauxProvider({ models: [{ id: "budget-model", contextWindow: 512 }] });
	runtime.registerNativeProvider(faux.provider);
	const settings = SettingsManager.inMemory({
		retry: { enabled: true, baseDelayMs: 10_000, maxRetries: 3 },
		compaction: { enabled: compaction, reserveTokens: 32, keepRecentTokens: 1 },
	});
	const loader = new DefaultResourceLoader({
		cwd: os.tmpdir(), agentDir: os.tmpdir(), settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPromptOverride: () => "Review the assignment.",
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: os.tmpdir(), modelRuntime: runtime, model: faux.getModel(),
		resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(), tools: [],
	});
	return { runtime, faux, session };
}

for (const phase of ["retry", "compaction"] as const) {
	test(`review deadline cancels the real SDK's active ${phase} with a provider-free session`, async (t) => {
		const { faux, session } = await budgetSdkFixture(phase === "compaction");
		const active = new Deferred<void>();
		let compactionSignal: AbortSignal | undefined;
		session.subscribe((event) => { if (event.type === "auto_retry_start") active.resolve(); });
		faux.setResponses(phase === "retry" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" })] : [
			fauxAssistantMessage("VERDICT: APPROVE\nSCOPE: PASS"),
			async (_context, options) => {
				compactionSignal = options!.signal!;
				active.resolve();
				await new Promise<void>((resolve) => compactionSignal!.addEventListener("abort", () => resolve(), { once: true }));
				return fauxAssistantMessage("summary cancelled");
			},
		]);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const parent = { ...reviewerAction(), prompt: `Review this evidence: ${"evidence ".repeat(400)}` };
		const nested = new HerderNestedAgentScope({ action: parent, agentRoot, createSession: async () => { throw new Error("unused"); } });
		const engine = new PiWorkerEngine({ availableModels: async () => [], create: async () => ({ session, nested }) }, 100);
		const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal(resolve));
		const handle = await engine.prepare({ action: parent, planDirectory: os.tmpdir() });
		try {
			engine.start(handle);
			await Promise.race([active.promise, terminal.then(() => { throw new Error(`SDK completed without entering ${phase}`); })]);
			assert.equal(phase === "retry" ? session.isRetrying : session.isCompacting, true);
			t.mock.timers.tick(100);
			await nextTurn();
			if (phase === "compaction") assert.equal(compactionSignal!.aborted, true, "SDK abort alone does not cancel compaction");
			const result = await terminal;
			assert.equal(result.failureKind, "review_budget_exhausted");
			assert.equal(result.interrupted, true);
			assert.equal(session.isRetrying, false);
			assert.equal(session.isCompacting, false);
			assert.equal(faux.state.callCount, phase === "retry" ? 1 : 2, "exhaustion cannot start another SDK attempt");
		} finally {
			session.abortCompaction();
			await engine.stop(handle);
		}
	});
}

for (const owner of ["root", "reviewer", "recon"] as const) {
	for (const phase of ["compaction", "agent"] as const) {
		test(`${owner} cancellation survives pending ${phase} auth and the late SDK phase start`, async (t) => {
			const { runtime, faux, session } = await budgetSdkFixture(phase === "compaction");
			const authStarted = new Deferred<void>();
			const authResume = new Deferred<void>();
			const providerRelease = new Deferred<void>();
			const authGate = async () => { authStarted.resolve(); await authResume.promise; };
			if (phase === "compaction") {
				// The SDK awaits this before emitting compaction_start/installing its controller.
				const internals = session as unknown as {
					_getSummarizationRequestAuth(model: NonNullable<AgentSession["model"]>): Promise<unknown>;
				};
				const getAuth = internals._getSummarizationRequestAuth.bind(session);
				t.mock.method(internals, "_getSummarizationRequestAuth", async (model: NonNullable<AgentSession["model"]>) => {
					await authGate();
					return getAuth(model);
				});
			} else {
				// Prompt preflight can finish auth after an idle session.abort() already resolved.
				const checkAuth = runtime.checkAuth.bind(runtime);
				t.mock.method(runtime, "hasConfiguredAuth", () => false);
				t.mock.method(runtime, "checkAuth", async (...args: Parameters<ModelRuntime["checkAuth"]>) => {
					await authGate();
					return checkAuth(...args);
				});
			}
			const providerSignals: AbortSignal[] = [];
			const abortedOnAdmission: boolean[] = [];
			faux.setResponses([
				...(phase === "compaction" ? [fauxAssistantMessage("VERDICT: APPROVE\nSCOPE: PASS")] : []),
				async (_context, options) => {
					const signal = options!.signal!;
					providerSignals.push(signal);
					abortedOnAdmission.push(signal.aborted);
					let detach = () => {};
					try {
						await Promise.race([
							new Promise<void>((resolve) => {
								if (signal.aborted) resolve();
								else {
									const aborted = () => resolve();
									signal.addEventListener("abort", aborted, { once: true });
									detach = () => signal.removeEventListener("abort", aborted);
								}
							}),
							providerRelease.promise,
						]);
					} finally { detach(); }
					return fauxAssistantMessage("cancelled", { stopReason: signal.aborted ? "aborted" : "stop" });
				},
			]);
			const evidence = "evidence ".repeat(400);
			let prompting: Promise<void> | undefined;
			let disposed = false;
			const wrap = (): NestedWorkerSession => ({
				get sessionId() { return session.sessionId; },
				get messages() { return session.messages; },
				subscribe: (listener) => session.subscribe(listener),
				prompt: (text, options) => prompting = session.prompt(text, options),
				abort: () => { session.abortCompaction(); return session.abort(); },
				dispose: () => { disposed = true; session.dispose(); },
				getSessionStats: () => session.getSessionStats(),
			});
			// Exercise unrestricted subscriptions without the extra production stream guard.
			// Read-only leaves need that guard even after bounded disposal removes listeners.
			const fixture = owner === "root" ? undefined : budgetFixture(100, reviewerAction(), async ({ signal }) => {
				if (owner === "recon") applyNestedAbortSignal(session, signal);
				return wrap();
			});
			const parent = { ...reviewerAction(), prompt: evidence };
			const nested = fixture?.nested ?? new HerderNestedAgentScope({ action: parent, agentRoot, createSession: async () => { throw new Error("unused"); } });
			const engine = fixture?.engine ?? new PiWorkerEngine({ availableModels: async () => [], create: async () => ({ session: wrap(), nested }) }, 100);
			let terminalResult: PiWorkerTerminal | undefined;
			const terminal = new Promise<PiWorkerTerminal>((resolve) => engine.onTerminal((result) => { terminalResult = result; resolve(result); }));
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
			const handle = await engine.prepare({ action: parent, planDirectory: os.tmpdir() });
			try {
				engine.start(handle);
				if (owner !== "root") await nested.spawnBackground({ type: owner, prompt: evidence, description: "pending auth child" });
				await Promise.race([authStarted.promise, terminal.then(() => { throw new Error("SDK completed without entering auth"); })]);
				t.mock.timers.tick(100);
				await nextTurn();
				assert.equal(engine.snapshots()[0]!.status, "stopping");
				assert.equal(session.isCompacting, false, "no compaction controller exists during auth");
				fixture?.session.promptDone.resolve();
				fixture?.session.abortDone.resolve();
				await nextTurn();
				t.mock.timers.tick(5_001);
				await nextTurn();
				assert.equal(disposed, owner === "recon", "only read-only leaves may finish bounded cleanup with auth pending");
				assert.equal(engine.has(handle), owner !== "recon", "root/reviewer retain ownership while auth is pending");
				authResume.resolve();
				await nextTurn();
				assert.ok(providerSignals.every((signal) => signal.aborted), `late request stayed live (aborted on admission: ${abortedOnAdmission})`);
				assert.equal(session.isCompacting, false, "compaction must settle without manually completing the provider response");
				assert.equal(session.isStreaming, false, "late normal agent runs must also settle");
				assert.ok(terminalResult, "deadline must reach terminal without manually completing the provider response");
				assert.equal((await terminal).failureKind, "review_budget_exhausted");
				assert.equal(terminalResult.interrupted, true);
				assert.equal(disposed, true);
				assert.equal(faux.state.callCount, (phase === "compaction" ? 1 : 0) + providerSignals.length);
				if (owner === "recon") assert.equal(providerSignals.length, 0, "disposed leaves must reject new provider admission");
				else assert.ok(providerSignals.length <= 1);
			} finally {
				// Release both barriers on assertion failure so this regression cannot hang the suite.
				authResume.resolve();
				providerRelease.resolve();
				fixture?.session.promptDone.resolve();
				fixture?.session.abortDone.resolve();
				session.abortCompaction();
				await Promise.allSettled([prompting, engine.stop(handle)]);
				session.dispose();
			}
		});
	}
}
