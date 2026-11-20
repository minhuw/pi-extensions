import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	parseAgentDefinition,
	parseAgentFrontmatter,
} from "../../subagents/src/agent-definitions.ts";
import councilExtension, {
	assertCouncilModelsAvailable,
	buildRound1Prompt,
	buildRound2Prompt,
	COUNCIL_MEMBERS,
	COUNCIL_MENTION_RE,
	formatCouncilReport,
	resolveCouncilMembers,
	rotatePeersForMember,
	type CouncilMemberId,
	type CouncilModelRegistry,
} from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const agentsDir = path.resolve(__dirname, "../agents");

function createDispatchingBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		emitted,
		on(channel: string, handler: (data: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const current = handlers.get(channel) ?? [];
				handlers.set(
					channel,
					current.filter((h) => h !== handler),
				);
			};
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) {
				handler(data);
			}
		},
	};
}

const DEFAULT_COUNCIL_MODELS = [
	"magpie/gemini-4-carbon",
	"magpie/gpt-6.2-astra",
	"magpie/claude-fable-5-2",
] as const;

interface HarnessOptions {
	minimalPi?: boolean;
	pingVersion?: number | null;
	availableModels?: readonly string[] | null;
	unauthenticatedModels?: readonly string[];
	round1Handler?: (req: {
		id: string;
		type: string;
		prompt: string;
		options: Record<string, unknown>;
	}) => { event: "completed" | "failed"; result?: string; error?: string; status?: string } | "hang";
	round2Handler?: (req: {
		agentId: string;
		type: string;
		text: string;
	}) =>
		| {
				rpcError?: string;
				event?: "completed" | "failed";
				result?: string;
				error?: string;
				status?: string;
		  }
		| "hang";
	/** Return true to hold the spawn RPC reply until manually resolved via `deferredSpawns`. */
	deferSpawn?: (req: { id: string; type: string }) => boolean;
	/** Return true to hold the send RPC reply until manually resolved via `deferredSends`. */
	deferSend?: (req: { agentId: string; type: string }) => boolean;
}

function bootCouncilHarness(opts: HarnessOptions = {}) {
	const bus = createDispatchingBus();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sendUserMessage = vi.fn();

	const spawns: Array<{
		requestId: string;
		id: string;
		type: string;
		prompt: string;
		options: Record<string, unknown>;
	}> = [];
	const sends: Array<{
		requestId: string;
		agentId: string;
		type: string;
		text: string;
	}> = [];
	const stops: Array<{ requestId: string; agentId: string }> = [];
	const releases: Array<{ requestId: string; agentId: string }> = [];
	const deferredSpawns: Array<{
		id: string;
		type: string;
		requestId: string;
		resolve: (reply?: { success: boolean; data?: { id: string }; error?: string }) => void;
	}> = [];
	const deferredSends: Array<{
		agentId: string;
		type: string;
		requestId: string;
		resolve: (reply?: { success: boolean; data?: { delivery: string }; error?: string }) => void;
	}> = [];
	const consumes: Array<{
		requestId: string;
		agentId: string;
		settledSynchronously: boolean;
	}> = [];

	const agentTypesById = new Map<string, string>();
	let currentlySettlingAgentId: string | undefined;
	let agentSeq = 0;

	if (opts.pingVersion !== null) {
		bus.on("subagents:rpc:ping", (raw: any) => {
			bus.emit(`subagents:rpc:ping:reply:${raw.requestId}`, {
				success: true,
				data: { version: opts.pingVersion ?? 3 },
			});
		});
	}

	bus.on("subagents:rpc:consume", (raw: any) => {
		consumes.push({
			requestId: raw.requestId,
			agentId: raw.agentId,
			settledSynchronously: currentlySettlingAgentId === raw.agentId,
		});
		bus.emit(`subagents:rpc:consume:reply:${raw.requestId}`, { success: true });
	});

	bus.on("subagents:rpc:stop", (raw: any) => {
		stops.push({ requestId: raw.requestId, agentId: raw.agentId });
		bus.emit(`subagents:rpc:stop:reply:${raw.requestId}`, { success: true });
	});

	bus.on("subagents:rpc:release", (raw: any) => {
		releases.push({ requestId: raw.requestId, agentId: raw.agentId });
		bus.emit(`subagents:rpc:release:reply:${raw.requestId}`, { success: true });
	});

	bus.on("subagents:rpc:spawn", (raw: any) => {
		const id = `council-agent-${++agentSeq}`;
		agentTypesById.set(id, raw.type);
		spawns.push({
			requestId: raw.requestId,
			id,
			type: raw.type,
			prompt: raw.prompt,
			options: raw.options ?? {},
		});

		if (opts.deferSpawn?.({ id, type: raw.type })) {
			deferredSpawns.push({
				id,
				type: raw.type,
				requestId: raw.requestId,
				resolve: (reply = { success: true, data: { id } }) => {
					if (reply.success && reply.data?.id) {
						bus.emit("subagents:started", {
							id: reply.data.id,
							type: raw.type,
							description: raw.options?.description ?? "",
						});
					}
					bus.emit(`subagents:rpc:spawn:reply:${raw.requestId}`, reply);
				},
			});
			return;
		}

		bus.emit("subagents:started", {
			id,
			type: raw.type,
			description: raw.options?.description ?? "",
		});
		bus.emit(`subagents:rpc:spawn:reply:${raw.requestId}`, {
			success: true,
			data: { id },
		});

		const outcome = opts.round1Handler
			? opts.round1Handler({ id, type: raw.type, prompt: raw.prompt, options: raw.options ?? {} })
			: {
					event: "completed" as const,
					status: "completed",
					result: `### 1. Proposed Design / API Contract\nProposal from ${raw.type} citing \`src/index.ts:10\`.\n\n### 2. Key Tradeoffs & Assumptions\nTradeoffs for ${raw.type}.\n\n### 3. Edge Cases & Failure Modes\nEdge cases for ${raw.type}.`,
				};

		if (outcome === "hang") return;

		queueMicrotask(() => {
			currentlySettlingAgentId = id;
			try {
				bus.emit(`subagents:${outcome.event}`, {
					id,
					type: raw.type,
					description: raw.options?.description ?? "",
					status: outcome.status ?? (outcome.event === "completed" ? "completed" : "error"),
					result: outcome.result,
					error: outcome.error,
					toolUses: 2,
					runToolUses: 2,
					durationMs: 120,
				});
			} finally {
				currentlySettlingAgentId = undefined;
			}
		});
	});

	bus.on("subagents:rpc:send", (raw: any) => {
		const type = agentTypesById.get(raw.agentId) ?? "unknown";
		sends.push({
			requestId: raw.requestId,
			agentId: raw.agentId,
			type,
			text: raw.text,
		});

		if (opts.deferSend?.({ agentId: raw.agentId, type })) {
			deferredSends.push({
				agentId: raw.agentId,
				type,
				requestId: raw.requestId,
				resolve: (reply = { success: true, data: { delivery: "resumed" } }) => {
					bus.emit(`subagents:rpc:send:reply:${raw.requestId}`, reply);
				},
			});
			return;
		}

		const outcome = opts.round2Handler
			? opts.round2Handler({ agentId: raw.agentId, type, text: raw.text })
			: {
					event: "completed" as const,
					status: "completed",
					result: `### 1. Adopt\nAdopt boundary checks from Peer A.\n\n### 2. Critique\nPeer B misses retry backoff at \`src/retry.ts:42\`.\n\n### 3. Revised Design & Verdict\n- **Stance:** \`converged\`\n- **Revised Design:** Unified design from ${type}.`,
				};

		if (outcome !== "hang" && outcome.rpcError) {
			bus.emit(`subagents:rpc:send:reply:${raw.requestId}`, {
				success: false,
				error: outcome.rpcError,
			});
			return;
		}

		bus.emit(`subagents:rpc:send:reply:${raw.requestId}`, {
			success: true,
			data: { delivery: "resumed" },
		});

		if (outcome === "hang") return;

		queueMicrotask(() => {
			const event = outcome.event ?? "completed";
			currentlySettlingAgentId = raw.agentId;
			try {
				bus.emit(`subagents:${event}`, {
					id: raw.agentId,
					type,
					status: outcome.status ?? (event === "completed" ? "completed" : "error"),
					result: outcome.result,
					error: outcome.error,
					toolUses: 3,
					runToolUses: 1,
					durationMs: 95,
				});
			} finally {
				currentlySettlingAgentId = undefined;
			}
		});
	});

	let activeTools = ["bash"];
	const eventHandlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const getActiveTools = vi.fn(() => [...activeTools]);
	const setActiveTools = vi.fn((next: string[]) => {
		activeTools = [...next];
	});
	const on = vi.fn((event: string, handler: (...args: any[]) => unknown) => {
		const list = eventHandlers.get(event) ?? [];
		list.push(handler);
		eventHandlers.set(event, list);
	});

	const pi = (
		opts.minimalPi
			? {
					events: bus,
					registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
					registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
					appendEntry: vi.fn(),
					sendUserMessage,
				}
			: {
					events: bus,
					on,
					getActiveTools,
					setActiveTools,
					registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
					registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
					appendEntry: vi.fn(),
					sendUserMessage,
				}
	) as unknown as ExtensionAPI;

	councilExtension(pi);

	let ctx: ExtensionContext;
	if (opts.availableModels === null) {
		ctx = {} as ExtensionContext;
	} else {
		const registeredKeys = opts.availableModels ?? DEFAULT_COUNCIL_MODELS;
		const unauthSet = new Set(opts.unauthenticatedModels ?? []);
		const registeredMap = new Map<string, { provider: string; id: string }>();
		for (const fullId of [...registeredKeys, ...(opts.unauthenticatedModels ?? [])]) {
			const slashIdx = fullId.indexOf("/");
			if (slashIdx > 0 && slashIdx < fullId.length - 1) {
				const provider = fullId.slice(0, slashIdx);
				const id = fullId.slice(slashIdx + 1);
				registeredMap.set(`${provider}/${id}`, { provider, id });
			}
		}
		const modelRegistry: CouncilModelRegistry = {
			find(provider: string, id: string) {
				return registeredMap.get(`${provider}/${id}`);
			},
			getAvailable() {
				return [...registeredMap.values()].filter((m) => !unauthSet.has(`${m.provider}/${m.id}`));
			},
			hasConfiguredAuth(model: { provider: string; id: string }) {
				const key = `${model.provider}/${model.id}`;
				return registeredMap.has(key) && !unauthSet.has(key);
			},
		};
		ctx = { modelRegistry } as unknown as ExtensionContext;
	}

	return {
		pi,
		bus,
		ctx,
		tool: tools.get("council")!,
		command: commands.get("council")!,
		spawns,
		sends,
		stops,
		releases,
		deferredSpawns,
		deferredSends,
		consumes,
		sendUserMessage,
		on,
		getActiveTools,
		setActiveTools,
		get activeTools() {
			return [...activeTools];
		},
	};
}

describe("council agent definitions in extensions/council/agents/", () => {
	it.each([
		["council-caspar", "magpie/gemini-4-carbon", "high"],
		["council-melchior", "magpie/gpt-6.2-astra", "xhigh"],
		["council-balthasar", "magpie/claude-fable-5-2", "high"],
	] as const)("validates %s frontmatter and read-only deliberation sections", async (name, model, thinking) => {
		const filePath = path.join(agentsDir, `${name}.md`);
		const raw = await readFile(filePath, "utf8");
		const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>(raw);
		const parsed = parseAgentDefinition(frontmatter, body, {
			filename: name,
			sourcePath: filePath,
			source: "project",
		});

		expect(parsed).toBeDefined();
		expect(parsed?.name).toBe(name);
		expect(parsed?.model).toBe(model);
		expect(parsed?.thinking).toBe(thinking);
		expect(parsed?.modelVisible).toBe(false);
		expect(parsed?.isolation).toBe("off");
		expect(parsed?.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
		expect(parsed?.requireToolUse).toBeUndefined();
		expect(body).toContain("Round 1");
		expect(body).toContain("Round 2");
		expect(body).toContain("### 1. Adopt");
		expect(body).toContain("### 2. Critique");
		expect(body).toContain("### 3. Revised Design & Verdict");
	});
});

describe("pure council helpers", () => {
	it("resolveCouncilMembers defaults to caspar, melchior, balthasar and rejects invalid inputs", () => {
		expect(resolveCouncilMembers().map((m) => m.id)).toEqual(["caspar", "melchior", "balthasar"]);
		expect(resolveCouncilMembers(["balthasar", "caspar"]).map((m) => m.id)).toEqual(["balthasar", "caspar"]);

		expect(() => resolveCouncilMembers(["caspar"])).toThrow(/at least 2 distinct members/i);
		expect(() => resolveCouncilMembers([])).toThrow(/at least 2 distinct members/i);
		expect(() => resolveCouncilMembers(["caspar", "caspar"])).toThrow(/Duplicate council member "caspar"/i);
		expect(() => resolveCouncilMembers(["caspar", "unknown"])).toThrow(/Unknown council member "unknown"/i);
	});

	it("assertCouncilModelsAvailable validates registered models and optional auth/availability hooks", () => {
		const allSpecs = resolveCouncilMembers();
		expect(() => assertCouncilModelsAvailable(allSpecs, undefined)).toThrow(
			/model registry is unavailable/i,
		);
		expect(() => assertCouncilModelsAvailable(allSpecs, {} as CouncilModelRegistry)).toThrow(
			/model registry is unavailable/i,
		);

		// Registry with find() only (no getAvailable / hasConfiguredAuth) succeeds when all models are found
		const findOnlyRegistry: CouncilModelRegistry = {
			find(provider, id) {
				return { provider, id };
			},
		};
		expect(() => assertCouncilModelsAvailable(allSpecs, findOnlyRegistry)).not.toThrow();

		// hasConfiguredAuth returning false fails even without getAvailable()
		const noAuthMelchior: CouncilModelRegistry = {
			find(provider, id) {
				return { provider, id };
			},
			hasConfiguredAuth(model) {
				return model.id !== "gpt-6.2-astra";
			},
		};
		expect(() => assertCouncilModelsAvailable(allSpecs, noAuthMelchior)).toThrow(
			/melchior \(magpie\/gpt-6\.2-astra: model unavailable or missing credentials\)/i,
		);

		// getAvailable() omitting a model fails even when hasConfiguredAuth is omitted
		const missingFromAvailable: CouncilModelRegistry = {
			find(provider, id) {
				return { provider, id };
			},
			getAvailable() {
				return [
					{ provider: "magpie", id: "gemini-4-carbon" },
					{ provider: "magpie", id: "gpt-6.2-astra" },
				];
			},
		};
		expect(() => assertCouncilModelsAvailable(allSpecs, missingFromAvailable)).toThrow(
			/balthasar \(magpie\/claude-fable-5-2: model unavailable or missing credentials\)/i,
		);
	});

	it("rotatePeersForMember counterbalances Peer A and Peer B positions across 3 members and 2 members", () => {
		const proposals: Array<{ member: CouncilMemberId; proposal: string }> = [
			{ member: "caspar", proposal: "Caspar proposal" },
			{ member: "melchior", proposal: "Melchior proposal" },
			{ member: "balthasar", proposal: "Balthasar proposal" },
		];

		// selfIndex = 0 (caspar) -> Peer A = melchior, Peer B = balthasar
		expect(rotatePeersForMember(proposals, 0)).toEqual([
			{ label: "Peer A", member: "melchior", proposal: "Melchior proposal" },
			{ label: "Peer B", member: "balthasar", proposal: "Balthasar proposal" },
		]);

		// selfIndex = 1 (melchior) -> Peer A = balthasar, Peer B = caspar
		expect(rotatePeersForMember(proposals, 1)).toEqual([
			{ label: "Peer A", member: "balthasar", proposal: "Balthasar proposal" },
			{ label: "Peer B", member: "caspar", proposal: "Caspar proposal" },
		]);

		// selfIndex = 2 (balthasar) -> Peer A = caspar, Peer B = melchior
		expect(rotatePeersForMember(proposals, 2)).toEqual([
			{ label: "Peer A", member: "caspar", proposal: "Caspar proposal" },
			{ label: "Peer B", member: "melchior", proposal: "Melchior proposal" },
		]);

		// 2-member panel
		const pair = proposals.slice(0, 2);
		expect(rotatePeersForMember(pair, 0)).toEqual([
			{ label: "Peer A", member: "melchior", proposal: "Melchior proposal" },
		]);
		expect(rotatePeersForMember(pair, 1)).toEqual([
			{ label: "Peer A", member: "caspar", proposal: "Caspar proposal" },
		]);
	});

	it("buildRound1Prompt and buildRound2Prompt include required rubrics and scrub leaked advisor identities", () => {
		const r1 = buildRound1Prompt({
			topic: "Design the event journal",
			paths: ["src/journal.ts", "src/types.ts"],
		});
		expect(r1).toContain("Design the event journal");
		expect(r1).toContain("`src/journal.ts`");
		expect(r1).toContain("`src/types.ts`");
		expect(r1).toContain("### 1. Proposed Design / API Contract");
		expect(r1).toContain("### 2. Key Tradeoffs & Assumptions");
		expect(r1).toContain("### 3. Edge Cases & Failure Modes");

		const r2 = buildRound2Prompt({
			topic: "Design the event journal",
			peers: [
				{
					label: "Peer A",
					text: "Proposal from council-melchior on magpie/gpt-6.2-astra: append-only log at `src/journal.ts:12`.",
				},
				{
					label: "Peer B",
					text: "Proposal from council-balthasar on magpie/claude-fable-5-2: WAL snapshots at `src/journal.ts:88`.",
				},
			],
		});
		expect(r2).toContain("## Peer A");
		expect(r2).toContain("## Peer B");
		expect(r2).toContain("Evaluation Rubric (Bias & Verbosity Normalization)");
		expect(r2).toContain("Ignore response length, formatting polish, and rhetorical confidence");
		expect(r2).toContain("Do not herd toward majority opinion");
		expect(r2).toContain("### 1. Adopt");
		expect(r2).toContain("### 2. Critique");
		expect(r2).toContain("### 3. Revised Design & Verdict");
		expect(r2).toContain("`converged`");
		expect(r2).toContain("`tradeoff`");
		expect(r2).not.toMatch(/caspar|melchior|balthasar|gemini|gpt|claude/i);
	});
});

describe("council tool execution and RPC deliberation", () => {
	it("runs a 2-round deliberation in parallel, counterbalances anonymized peers, and consumes every settle synchronously", async () => {
		const harness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				const tag = type.replace("council-", "").toUpperCase();
				return {
					event: "completed",
					status: "completed",
					result: `R1_PROPOSAL_${tag}_CONTENT citing \`src/${tag.toLowerCase()}.ts:1\``,
				};
			},
		});

		const result = await harness.tool.execute(
			"tc-council-1",
			{
				topic: "Evaluate state machine transition guards",
				paths: ["src/state.ts"],
			},
			undefined,
			undefined,
			harness.ctx,
		);

		expect(harness.spawns).toHaveLength(3);
		expect(harness.spawns.map((s) => s.type)).toEqual([
			"council-caspar",
			"council-melchior",
			"council-balthasar",
		]);
		for (const spawn of harness.spawns) {
			expect(spawn.options.notifyParent).toBe(false);
			expect(spawn.options.retain).toBe(true);
			expect(spawn.options.isBackground).toBe(true);
			expect(spawn.options.bypassQueue).toBe(true);
			expect(spawn.options.model).toBeUndefined();
			expect(spawn.prompt).toContain("`src/state.ts`");
		}

		expect(harness.sends).toHaveLength(3);
		const sendByType = new Map(harness.sends.map((s) => [s.type, s.text]));

		// caspar (index 0) gets Peer A = melchior, Peer B = balthasar
		const casparR2 = sendByType.get("council-caspar")!;
		expect(casparR2.indexOf("## Peer A")).toBeLessThan(casparR2.indexOf("R1_PROPOSAL_MELCHIOR_CONTENT"));
		expect(casparR2.indexOf("R1_PROPOSAL_MELCHIOR_CONTENT")).toBeLessThan(casparR2.indexOf("## Peer B"));
		expect(casparR2.indexOf("## Peer B")).toBeLessThan(casparR2.indexOf("R1_PROPOSAL_BALTHASAR_CONTENT"));
		expect(casparR2).not.toContain("R1_PROPOSAL_CASPAR_CONTENT");

		// melchior (index 1) gets Peer A = balthasar, Peer B = caspar
		const melchiorR2 = sendByType.get("council-melchior")!;
		expect(melchiorR2.indexOf("## Peer A")).toBeLessThan(melchiorR2.indexOf("R1_PROPOSAL_BALTHASAR_CONTENT"));
		expect(melchiorR2.indexOf("R1_PROPOSAL_BALTHASAR_CONTENT")).toBeLessThan(melchiorR2.indexOf("## Peer B"));
		expect(melchiorR2.indexOf("## Peer B")).toBeLessThan(melchiorR2.indexOf("R1_PROPOSAL_CASPAR_CONTENT"));
		expect(melchiorR2).not.toContain("R1_PROPOSAL_MELCHIOR_CONTENT");

		// balthasar (index 2) gets Peer A = caspar, Peer B = melchior
		const balthasarR2 = sendByType.get("council-balthasar")!;
		expect(balthasarR2.indexOf("## Peer A")).toBeLessThan(balthasarR2.indexOf("R1_PROPOSAL_CASPAR_CONTENT"));
		expect(balthasarR2.indexOf("R1_PROPOSAL_CASPAR_CONTENT")).toBeLessThan(balthasarR2.indexOf("## Peer B"));
		expect(balthasarR2.indexOf("## Peer B")).toBeLessThan(balthasarR2.indexOf("R1_PROPOSAL_MELCHIOR_CONTENT"));
		expect(balthasarR2).not.toContain("R1_PROPOSAL_BALTHASAR_CONTENT");

		// Ensure no model or advisor brand names leaked into any Round 2 prompt
		for (const send of harness.sends) {
			const strippedPlaceholder = send.text
				.replaceAll("R1_PROPOSAL_CASPAR_CONTENT", "P0")
				.replaceAll("R1_PROPOSAL_MELCHIOR_CONTENT", "P1")
				.replaceAll("R1_PROPOSAL_BALTHASAR_CONTENT", "P2")
				.replaceAll("src/caspar.ts", "src/p0.ts")
				.replaceAll("src/melchior.ts", "src/p1.ts")
				.replaceAll("src/balthasar.ts", "src/p2.ts");
			expect(strippedPlaceholder).not.toMatch(/caspar|melchior|balthasar|gemini|gpt|claude/i);
		}

		// 3 settles in Round 1 + 3 settles in Round 2 = 6 synchronous consumes
		expect(harness.consumes).toHaveLength(6);
		expect(harness.consumes.every((c) => c.settledSynchronously)).toBe(true);

		const text = result.content[0].text as string;
		expect(text).toContain("# Council Deliberation Report");
		expect(text).toContain("## Round 1 — Independent Proposals");
		expect(text).toContain("## Round 2 — Cross-Examination & Revised Designs");
		expect(text).toContain("## Stake-Free Parent Synthesis Instructions");
		expect(text).toContain(COUNCIL_MEMBERS.caspar.label);
		expect(text).toContain(COUNCIL_MEMBERS.melchior.label);
		expect(text).toContain(COUNCIL_MEMBERS.balthasar.label);
		expect(result.details.round1).toHaveLength(3);
		expect(result.details.round2).toHaveLength(3);
		expect(result.details.failures).toEqual([]);
	});

	it("supports rounds: 1 without sending Round 2 or retaining sessions", async () => {
		const harness = bootCouncilHarness();
		const result = await harness.tool.execute(
			"tc-council-r1",
			{
				topic: "Single-round design check",
				rounds: 1,
				members: ["caspar", "balthasar"],
			},
			undefined,
			undefined,
			harness.ctx,
		);

		expect(harness.spawns).toHaveLength(2);
		expect(harness.spawns.map((s) => s.type)).toEqual(["council-caspar", "council-balthasar"]);
		for (const spawn of harness.spawns) {
			expect(spawn.options.retain).toBe(false);
			expect(spawn.options.notifyParent).toBe(false);
		}
		expect(harness.sends).toHaveLength(0);
		expect(harness.consumes).toHaveLength(2);
		expect(result.details.round1).toHaveLength(2);
		expect(result.details.round2).toHaveLength(0);
	});

	it("rejects raw model overrides, invalid member lists, empty topics, and missing RPC v3 support", async () => {
		const harness = bootCouncilHarness();

		await expect(
			harness.tool.execute(
				"tc-err-model",
				{ topic: "Valid topic", model: "openai/gpt-5" } as any,
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow("Model overrides are not permitted on council; members use pinned council agent definitions.");

		await expect(
			harness.tool.execute(
				"tc-err-topic",
				{ topic: "   " },
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow(/Council topic must not be empty/i);

		await expect(
			harness.tool.execute(
				"tc-err-members-1",
				{ topic: "Valid topic", members: ["caspar"] as any },
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow(/at least 2 distinct members/i);

		await expect(
			harness.tool.execute(
				"tc-err-members-dup",
				{ topic: "Valid topic", members: ["melchior", "melchior"] as any },
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow(/Duplicate council member/i);

		const oldProtocolHarness = bootCouncilHarness({ pingVersion: 2 });
		await expect(
			oldProtocolHarness.tool.execute(
				"tc-err-v2",
				{ topic: "Valid topic" },
				undefined,
				undefined,
				oldProtocolHarness.ctx,
			),
		).rejects.toThrow(/RPC protocol >= 3/i);
	});

	it("fails fast before spawning any subagent when any selected pinned model is unavailable, and allows an available 2-member subset", async () => {
		// 1 of 3 pinned models unregistered (melchior / magpie/gpt-6.2-astra missing)
		const missingMelchiorHarness = bootCouncilHarness({
			availableModels: ["magpie/gemini-4-carbon", "magpie/claude-fable-5-2"],
		});
		await expect(
			missingMelchiorHarness.tool.execute(
				"tc-unregistered-1",
				{ topic: "Preflight unregistered model check" },
				undefined,
				undefined,
				missingMelchiorHarness.ctx,
			),
		).rejects.toThrow(/pinned council model\(s\) unavailable.*melchior.*magpie\/gpt-6\.2-astra/i);
		expect(missingMelchiorHarness.spawns).toHaveLength(0);

		// Explicit 2-member subset whose pinned models ARE available succeeds even when unselected 3rd is unavailable
		const subsetResult = await missingMelchiorHarness.tool.execute(
			"tc-subset-ok",
			{
				topic: "Two-member subset with available models",
				members: ["caspar", "balthasar"],
			},
			undefined,
			undefined,
			missingMelchiorHarness.ctx,
		);
		expect(missingMelchiorHarness.spawns).toHaveLength(2);
		expect(missingMelchiorHarness.spawns.map((s) => s.type)).toEqual([
			"council-caspar",
			"council-balthasar",
		]);
		expect(subsetResult.details.round1).toHaveLength(2);
		expect(subsetResult.details.round2).toHaveLength(2);

		// 1 of 3 pinned models registered in find() but missing credentials
		const unauthMelchiorHarness = bootCouncilHarness({
			unauthenticatedModels: ["magpie/gpt-6.2-astra"],
		});
		await expect(
			unauthMelchiorHarness.tool.execute(
				"tc-unauth-1",
				{ topic: "Preflight unauthenticated model check" },
				undefined,
				undefined,
				unauthMelchiorHarness.ctx,
			),
		).rejects.toThrow(
			/pinned council model\(s\) unavailable.*melchior \(magpie\/gpt-6\.2-astra: model unavailable or missing credentials\)/i,
		);
		expect(unauthMelchiorHarness.spawns).toHaveLength(0);

		// All 3 pinned models unavailable -> lists every unavailable selected member in one error
		const noneAvailableHarness = bootCouncilHarness({
			availableModels: ["magpie/gemini-4-carbon"],
			unauthenticatedModels: ["magpie/gemini-4-carbon"],
		});
		let allFailedMessage = "";
		try {
			await noneAvailableHarness.tool.execute(
				"tc-all-unavailable",
				{ topic: "All models unavailable check" },
				undefined,
				undefined,
				noneAvailableHarness.ctx,
			);
		} catch (err) {
			allFailedMessage = err instanceof Error ? err.message : String(err);
		}
		expect(allFailedMessage).toMatch(/pinned council model\(s\) unavailable/i);
		expect(allFailedMessage).toContain("caspar (magpie/gemini-4-carbon: model unavailable or missing credentials)");
		expect(allFailedMessage).toContain("melchior (magpie/gpt-6.2-astra: model not registered)");
		expect(allFailedMessage).toContain("balthasar (magpie/claude-fable-5-2: model not registered)");
		expect(noneAvailableHarness.spawns).toHaveLength(0);

		// Missing ctx.modelRegistry ({} as ExtensionContext)
		const missingRegistryHarness = bootCouncilHarness({ availableModels: null });
		await expect(
			missingRegistryHarness.tool.execute(
				"tc-no-registry",
				{ topic: "Missing model registry check" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/model registry is unavailable/i);
		expect(missingRegistryHarness.spawns).toHaveLength(0);
	});

	it("completes deliberation when 1 of 3 members fails in Round 1 or Round 2, and throws when 2 of 3 fail in Round 1", async () => {
		const r1PartialHarness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				if (type === "council-melchior") {
					return { event: "failed", status: "error", error: "Gateway timeout on melchior" };
				}
				return {
					event: "completed",
					status: "completed",
					result: `Proposal from ${type}`,
				};
			},
		});

		const r1PartialResult = await r1PartialHarness.tool.execute(
			"tc-partial-r1",
			{ topic: "Resilience check" },
			undefined,
			undefined,
			r1PartialHarness.ctx,
		);

		expect(r1PartialResult.details.round1).toHaveLength(2);
		expect(r1PartialResult.details.round2).toHaveLength(2);
		expect(r1PartialResult.details.failures).toEqual([
			{
				member: "melchior",
				agentType: "council-melchior",
				model: "magpie/gpt-6.2-astra",
				round: 1,
				error: "Gateway timeout on melchior",
			},
		]);
		expect(r1PartialResult.content[0].text).toContain("## Member Failures");
		expect(r1PartialResult.content[0].text).toContain("Gateway timeout on melchior");

		const r2PartialHarness = bootCouncilHarness({
			round2Handler: ({ type }) => {
				if (type === "council-balthasar") {
					return { event: "failed", status: "error", error: "Balthasar R2 rate limit" };
				}
				return {
					event: "completed",
					status: "completed",
					result: `R2 revision from ${type}`,
				};
			},
		});

		const r2PartialResult = await r2PartialHarness.tool.execute(
			"tc-partial-r2",
			{ topic: "R2 partial failure check" },
			undefined,
			undefined,
			r2PartialHarness.ctx,
		);

		expect(r2PartialResult.details.round1).toHaveLength(3);
		expect(r2PartialResult.details.round2).toHaveLength(2);
		expect(r2PartialResult.details.failures).toEqual([
			{
				member: "balthasar",
				agentType: "council-balthasar",
				model: "magpie/claude-fable-5-2",
				round: 2,
				error: "Balthasar R2 rate limit",
			},
		]);

		const r1TwoFailedHarness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				if (type !== "council-caspar") {
					return { event: "failed", status: "error", error: `${type} unavailable` };
				}
				return { event: "completed", status: "completed", result: "Caspar proposal" };
			},
		});

		await expect(
			r1TwoFailedHarness.tool.execute(
				"tc-two-failed",
				{ topic: "Majority failure check" },
				undefined,
				undefined,
				r1TwoFailedHarness.ctx,
			),
		).rejects.toThrow(/at least 2 members must succeed in Round 1/i);
	});

	it("emits subagents:rpc:stop and subagents:rpc:release for all active council subagents when AbortSignal aborts", async () => {
		const harness = bootCouncilHarness({
			round1Handler: () => "hang",
		});

		const controller = new AbortController();
		const promise = harness.tool.execute(
			"tc-abort",
			{ topic: "Abort while Round 1 is running" },
			controller.signal,
			undefined,
			harness.ctx,
		);

		await vi.waitFor(() => expect(harness.spawns).toHaveLength(3));
		controller.abort();

		await expect(promise).rejects.toThrow(/aborted/i);
		const expectedIds = harness.spawns.map((s) => s.id).sort();
		expect(harness.stops.map((s) => s.agentId).sort()).toEqual(expectedIds);
		expect(harness.releases.map((r) => r.agentId).sort()).toEqual(expectedIds);
	});

	it("releases retained sessions across normal 2-round completion, Round 1 failure, and Round 2 failure", async () => {
		const mockCtx = {
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
			},
		} as unknown as ExtensionContext;

		// 1. Normal 2-round completion
		const normalHarness = bootCouncilHarness();
		await normalHarness.tool.execute(
			"tc-rel-normal",
			{ topic: "Normal 2-round release check" },
			undefined,
			undefined,
			mockCtx,
		);
		expect(normalHarness.releases.map((r) => r.agentId).sort()).toEqual(
			normalHarness.spawns.map((s) => s.id).sort(),
		);

		// 2. Round 1 fatal failure (< 2 succeeded)
		const r1FailHarness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				if (type !== "council-caspar") {
					return { event: "failed", status: "error", error: `${type} failed` };
				}
				return { event: "completed", status: "completed", result: "Caspar proposal" };
			},
		});
		await expect(
			r1FailHarness.tool.execute(
				"tc-rel-r1-fail",
				{ topic: "Round 1 failure release check" },
				undefined,
				undefined,
				mockCtx,
			),
		).rejects.toThrow(/at least 2 members must succeed/i);
		expect(r1FailHarness.releases.map((r) => r.agentId).sort()).toEqual(
			r1FailHarness.spawns.map((s) => s.id).sort(),
		);

		// 3. Round 2 failure (send RPC error + failed settle)
		const r2FailHarness = bootCouncilHarness({
			round2Handler: ({ type }) => {
				if (type === "council-melchior") return { rpcError: "session unavailable" };
				if (type === "council-balthasar") {
					return { event: "failed", status: "error", error: "provider error" };
				}
				return { event: "completed", status: "completed", result: "Caspar R2" };
			},
		});
		await r2FailHarness.tool.execute(
			"tc-rel-r2-fail",
			{ topic: "Round 2 failure release check" },
			undefined,
			undefined,
			mockCtx,
		);
		expect(r2FailHarness.releases.map((r) => r.agentId).sort()).toEqual(
			r2FailHarness.spawns.map((s) => s.id).sort(),
		);
	});

	it("stops and releases late-returning advisor agents when cancelled while spawn RPC is still in-flight", async () => {
		const harness = bootCouncilHarness({
			deferSpawn: ({ type }) => type === "council-balthasar",
			round1Handler: () => "hang",
		});

		const mockCtx = {
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
			},
		} as unknown as ExtensionContext;

		const controller = new AbortController();
		const promise = harness.tool.execute(
			"tc-abort-inflight-spawn",
			{ topic: "Abort while balthasar spawn is in flight" },
			controller.signal,
			undefined,
			mockCtx,
		);

		await vi.waitFor(() => expect(harness.spawns).toHaveLength(3));
		expect(harness.deferredSpawns).toHaveLength(1);
		const lateSpawn = harness.deferredSpawns[0]!;

		controller.abort();
		await expect(promise).rejects.toThrow(/aborted/i);

		// Already-spawned advisors were stopped and released before the late spawn replied.
		const earlyIds = harness.spawns
			.filter((s) => s.id !== lateSpawn.id)
			.map((s) => s.id)
			.sort();
		expect(harness.stops.map((s) => s.agentId).sort()).toEqual(earlyIds);
		expect(harness.releases.map((r) => r.agentId).sort()).toEqual(earlyIds);

		// Now the late spawn RPC resolves after cancellation and finally cleanup.
		lateSpawn.resolve();
		await vi.waitFor(() => expect(harness.stops.map((s) => s.agentId)).toContain(lateSpawn.id));
		await vi.waitFor(() => expect(harness.releases.map((r) => r.agentId)).toContain(lateSpawn.id));

		const allIds = harness.spawns.map((s) => s.id).sort();
		expect(harness.stops.map((s) => s.agentId).sort()).toEqual(allIds);
		expect(harness.releases.map((r) => r.agentId).sort()).toEqual(allIds);
	});

	it("stops and releases all advisors when cancelled while all spawn RPCs are still in-flight", async () => {
		const harness = bootCouncilHarness({
			deferSpawn: () => true,
		});

		const mockCtx = {
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
			},
		} as unknown as ExtensionContext;

		const controller = new AbortController();
		const promise = harness.tool.execute(
			"tc-abort-all-inflight-spawns",
			{ topic: "Abort while all spawns are in flight", members: ["caspar", "melchior"] },
			controller.signal,
			undefined,
			mockCtx,
		);

		await vi.waitFor(() => expect(harness.deferredSpawns).toHaveLength(2));
		controller.abort();
		await expect(promise).rejects.toThrow(/aborted/i);
		expect(harness.stops).toHaveLength(0);

		for (const deferred of harness.deferredSpawns) {
			deferred.resolve();
		}

		const allIds = harness.spawns.map((s) => s.id).sort();
		await vi.waitFor(() => expect(harness.stops.map((s) => s.agentId).sort()).toEqual(allIds));
		await vi.waitFor(() => expect(harness.releases.map((r) => r.agentId).sort()).toEqual(allIds));
	});

	it("stops and releases late-returning advisor agents when cancelled while Round 2 send RPC is in-flight", async () => {
		const harness = bootCouncilHarness({
			deferSend: ({ type }) => type === "council-melchior",
			round2Handler: () => "hang",
		});

		const mockCtx = {
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
			},
		} as unknown as ExtensionContext;

		const controller = new AbortController();
		const promise = harness.tool.execute(
			"tc-abort-inflight-send",
			{ topic: "Abort while Round 2 send is in flight", members: ["caspar", "melchior"] },
			controller.signal,
			undefined,
			mockCtx,
		);

		await vi.waitFor(() => expect(harness.sends).toHaveLength(2));
		expect(harness.deferredSends).toHaveLength(1);
		const lateSend = harness.deferredSends[0]!;
		const earlyR2Id = harness.sends.find((s) => s.agentId !== lateSend.agentId)!.agentId;

		controller.abort();
		await expect(promise).rejects.toThrow(/aborted/i);

		// Early Round 2 advisor was stopped immediately; all owned agents released in finally.
		expect(harness.stops.map((s) => s.agentId)).toEqual([earlyR2Id]);
		expect(new Set(harness.releases.map((r) => r.agentId))).toEqual(
			new Set(harness.spawns.map((s) => s.id)),
		);

		// Late Round 2 send resolves after abort/finally: must immediately stop and re-release.
		const releasesBeforeLateSend = harness.releases.filter((r) => r.agentId === lateSend.agentId).length;
		lateSend.resolve({ success: true, data: { delivery: "resumed" } });

		await vi.waitFor(() => expect(harness.stops.map((s) => s.agentId)).toContain(lateSend.agentId));
		await vi.waitFor(() =>
			expect(harness.releases.filter((r) => r.agentId === lateSend.agentId).length).toBeGreaterThan(
				releasesBeforeLateSend,
			),
		);
	});
});

describe("/council command and package contracts", () => {
	it("registers council with defaultActive: false, tolerates minimal mock pi objects, notifies usage without activating on empty/help/status, and activates before sending topic prompts", async () => {
		const minimalHarness = bootCouncilHarness({ minimalPi: true });
		expect(minimalHarness.tool.defaultActive).toBe(false);
		await minimalHarness.command.handler("Topic on minimal mock pi", {
			ui: { notify: vi.fn() },
			isIdle: () => true,
		} as unknown as ExtensionContext);
		expect(minimalHarness.sendUserMessage).toHaveBeenCalledTimes(1);

		const harness = bootCouncilHarness();
		expect(harness.tool.defaultActive).toBe(false);
		expect(harness.activeTools).toEqual(["bash"]);
		const notify = vi.fn();
		const ctx = {
			ui: { notify },
			isIdle: () => true,
		} as unknown as ExtensionContext;

		await harness.command.handler("", ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("/council <topic or design question>");
		expect(notify.mock.calls[0][0]).toContain("magpie/gemini-4-carbon");
		expect(notify.mock.calls[0][0]).toContain("magpie/gpt-6.2-astra");
		expect(notify.mock.calls[0][0]).toContain("magpie/claude-fable-5-2");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.activeTools).toEqual(["bash"]);

		await harness.command.handler("help", ctx);
		await harness.command.handler("status", ctx);
		expect(notify).toHaveBeenCalledTimes(3);
		expect(harness.activeTools).toEqual(["bash"]);

		await harness.command.handler("Design the distributed lock lease renewal protocol", ctx);
		expect(harness.activeTools).toEqual(["bash", "council"]);
		expect(harness.setActiveTools).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage.mock.calls[0][0]).toContain("`council` tool");
		expect(harness.sendUserMessage.mock.calls[0][0]).toContain(
			"Design the distributed lock lease renewal protocol",
		);
		expect(harness.sendUserMessage.mock.calls[0][0]).toContain("stake-free judge");

		const busyCtx = {
			ui: { notify },
			isIdle: () => false,
		} as unknown as ExtensionContext;
		await harness.command.handler("Follow-up council topic", busyCtx);
		expect(harness.setActiveTools).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendUserMessage.mock.calls[1][1]).toEqual({ deliverAs: "followUp" });
	});

	it("matches explicit council mentions via COUNCIL_MENTION_RE without false positives", () => {
		expect(COUNCIL_MENTION_RE.test("Convene the council on lock leases")).toBe(true);
		expect(COUNCIL_MENTION_RE.test("Inspect @extensions/council/ before changing prompts")).toBe(true);
		expect(COUNCIL_MENTION_RE.test("Ask council-caspar and council-melchior")).toBe(true);
		expect(COUNCIL_MENTION_RE.test("Check COUNCIL-BALTHASAR config")).toBe(true);

		expect(COUNCIL_MENTION_RE.test("Compare SQLite WAL vs rollback journal tradeoffs")).toBe(false);
		expect(COUNCIL_MENTION_RE.test("Reconcile councilor notes")).toBe(false);
	});

	it("registers council in package.json after subagents and before workspace/pika, wires test:council, and documents council", async () => {
		const [pkgRaw, councilReadme, rootReadme, agentsMd, configMd, delegationMd] = await Promise.all([
			readFile(path.join(repoRoot, "package.json"), "utf8"),
			readFile(path.join(repoRoot, "extensions/council/README.md"), "utf8"),
			readFile(path.join(repoRoot, "README.md"), "utf8"),
			readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
			readFile(path.join(repoRoot, "docs/configuration.md"), "utf8"),
			readFile(path.join(repoRoot, "docs/guides/delegation.md"), "utf8"),
		]);

		const manifest = JSON.parse(pkgRaw) as {
			scripts: Record<string, string>;
			pi: { extensions: string[]; prompts: string[] };
		};

		expect(manifest.scripts["test:council"]).toBe("vitest run extensions/council");
		const testSteps = manifest.scripts.test.split(" && ");
		expect(testSteps).toContain("npm run test:subagents");
		const vitestTargets = testSteps.find((step) => step.startsWith("vitest run "))?.split(/\s+/) ?? [];
		expect(vitestTargets).toEqual(
			expect.arrayContaining(["extensions/council", "extensions/molt", "extensions/language", "extensions/soul", "extensions/spokesman"]),
		);

		const exts = manifest.pi.extensions;
		const subagentsIdx = exts.indexOf("./extensions/subagents/src/index.ts");
		const councilIdx = exts.indexOf("./extensions/council/index.ts");
		const workspaceIdx = exts.indexOf("./extensions/workspace/index.ts");
		const processesIdx = exts.indexOf("./extensions/processes/index.ts");
		const pikaIdx = exts.indexOf("./extensions/pika/index.ts");

		expect(councilIdx).toBe(subagentsIdx + 1);
		expect(workspaceIdx).toBe(processesIdx - 1);
		expect(processesIdx).toBe(pikaIdx - 1);
		expect(exts.at(-1)).toBe("./extensions/pika/index.ts");
		expect(manifest.pi.prompts.some((p) => p.includes("council"))).toBe(false);

		expect(councilReadme).toContain("council-caspar");
		expect(councilReadme).toContain("council-melchior");
		expect(councilReadme).toContain("council-balthasar");
		expect(councilReadme).toContain("rotatePeersForMember");
		expect(councilReadme).toContain("defaultActive: false");

		expect(rootReadme).toContain("[Council](extensions/council/README.md)");
		expect(agentsMd).toContain("`extensions/council/`");
		expect(agentsMd).toContain("`npm run test:council`");
		expect(configMd).toContain("[Council](../extensions/council/README.md)");
		expect(delegationMd).toContain("[Council](../../extensions/council/README.md)");

		// formatCouncilReport smoke test
		const formatted = formatCouncilReport({
			topic: "Test topic",
			rounds: 1,
			members: ["caspar", "melchior"],
			round1: [],
			round2: [],
			failures: [],
		});
		expect(formatted).toContain("Stake-Free Parent Synthesis Instructions");
	});
});

function extractPromptSection(systemPrompt: string, tag: "tools" | "rules"): string {
	const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n<\\/${tag}>`).exec(systemPrompt);
	expect(match).not.toBeNull();
	return match![1]!;
}

async function createCouncilAgentSession(
	options: { sessionManager?: SessionManager; magpieModels?: Array<{ id: string }> } = {},
) {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-council-runtime-"));
	let session: AgentSession | undefined;
	const cleanup = async () => {
		try {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};

	try {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			api: "council-runtime-api",
			provider: "council-runtime",
			models: [{ id: "test" }],
		});
		const magpieModels = options.magpieModels ?? [
			{ id: "gemini-4-carbon" },
			{ id: "gpt-6.2-astra" },
			{ id: "claude-fable-5-2" },
		];
		const magpieFaux =
			magpieModels.length > 0
				? fauxProvider({
						api: "council-magpie-api",
						provider: "magpie",
						models: magpieModels,
					})
				: undefined;
		let spawnSeq = 0;
		const resources = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					if (magpieFaux) {
						pi.registerProvider(magpieFaux.provider);
					}
					pi.events.on("subagents:rpc:ping", (raw: any) => {
						pi.events.emit(`subagents:rpc:ping:reply:${raw.requestId}`, {
							success: true,
							data: { version: 3 },
						});
					});
					pi.events.on("subagents:rpc:consume", (raw: any) => {
						pi.events.emit(`subagents:rpc:consume:reply:${raw.requestId}`, { success: true });
					});
					pi.events.on("subagents:rpc:spawn", (raw: any) => {
						const id = `runtime-council-${++spawnSeq}`;
						pi.events.emit("subagents:started", { id, type: raw.type });
						pi.events.emit(`subagents:rpc:spawn:reply:${raw.requestId}`, {
							success: true,
							data: { id },
						});
						queueMicrotask(() => {
							pi.events.emit("subagents:completed", {
								id,
								type: raw.type,
								status: "completed",
								result: `Proposal from ${raw.type} citing \`src/retry.ts:1\`.`,
								toolUses: 1,
								runToolUses: 1,
								durationMs: 25,
							});
						});
					});
					councilExtension(pi);
				},
			],
		});
		await resources.reload();
		expect(resources.getExtensions().errors).toEqual([]);

		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model: faux.getModel("test")!,
			resourceLoader: resources,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"], retry: { enabled: false } }),
		}));

		const errors: unknown[] = [];
		await session.bindExtensions({
			mode: "rpc",
			onError: (err) => {
				errors.push(err);
			},
		});

		const current = session;
		const runPrompt = async (text: string) => {
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = current.subscribe((event) => {
					if (event.type === "agent_settled") {
						unsubscribe();
						resolve();
					}
				});
			});
			await current.prompt(text);
			await settled;
		};

		return {
			directory,
			session: current,
			faux,
			errors,
			get spawnCount() {
				return spawnSeq;
			},
			runPrompt,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

describe("council tool activation in real AgentSession + fauxProvider", () => {
	it("omits council from active tools, tool schemas, <tools>, and <rules> on startup and ordinary architecture prompts", async () => {
		const h = await createCouncilAgentSession();
		const requests: Array<{ tools: string[]; systemPrompt: string }> = [];
		const inspect = (message: AssistantMessage): FauxResponseFactory => (context) => {
			requests.push({
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				systemPrompt: getCurrentSystemPrompt(context.messages),
			});
			return message;
		};

		try {
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);
			expect(h.session.getActiveToolNames()).not.toContain("council");

			h.faux.setResponses([inspect(fauxAssistantMessage("SQLite WAL favors concurrent readers."))]);
			await h.runPrompt("Compare SQLite WAL vs rollback journal tradeoffs");

			expect(requests).toHaveLength(1);
			expect(requests[0]!.tools).toEqual(["bash"]);
			expect(requests[0]!.tools).not.toContain("council");
			expect(extractPromptSection(requests[0]!.systemPrompt, "tools")).not.toContain("council");
			expect(extractPromptSection(requests[0]!.systemPrompt, "rules")).not.toContain("council");
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);

			await h.session.prompt("/council");
			await h.session.prompt("/council help");
			await h.session.prompt("/council status");
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);
			expect(h.faux.state.callCount).toBe(1);
			expect(h.errors).toEqual([]);
		} finally {
			await h.cleanup();
		}
	}, 15_000);

	it.each([
		{
			label: "/council <topic>",
			input: "/council Design the retry contract",
			callTool: true,
		},
		{
			label: "explicit council mention",
			input: "Convene the council on lock leases",
			callTool: false,
		},
	])("activates council (tool schema, <tools>, and <rules>) before Turn 1 on $label", async ({ input, callTool }) => {
		const h = await createCouncilAgentSession();
		const requests: Array<{ tools: string[]; systemPrompt: string }> = [];
		const inspect = (message: AssistantMessage): FauxResponseFactory => (context) => {
			requests.push({
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				systemPrompt: getCurrentSystemPrompt(context.messages),
			});
			return message;
		};

		try {
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);

			if (callTool) {
				h.faux.setResponses([
					inspect(
						fauxAssistantMessage([
							fauxToolCall("council", {
								topic: "Design the retry contract",
								rounds: 1,
								members: ["caspar", "melchior"],
							}),
						]),
					),
					inspect(fauxAssistantMessage("Synthesized retry contract.")),
				]);
			} else {
				h.faux.setResponses([inspect(fauxAssistantMessage("Ready to convene council advisors."))]);
			}

			await h.runPrompt(input);

			expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));
			expect(requests.length).toBeGreaterThanOrEqual(1);
			const turn1 = requests[0]!;
			expect(turn1.tools).toEqual(expect.arrayContaining(["bash", "council"]));
			expect(extractPromptSection(turn1.systemPrompt, "tools")).toContain(
				"- council: Convene the 3-model read-only technical council",
			);
			const rules = extractPromptSection(turn1.systemPrompt, "rules");
			expect(rules).toContain("Use `council` when the user invokes `/council`");
			expect(rules).toContain("Never pass a `model` override to `council`");
			expect(h.errors).toEqual([]);
		} finally {
			await h.cleanup();
		}
	}, 15_000);

	it("deactivates and re-activates council across navigateTree between pre-council and post-council leaves and restores on session_start", async () => {
		const dirForManager = await mkdtemp(path.join(tmpdir(), "pi-council-session-store-"));
		const manager = SessionManager.create(dirForManager, dirForManager);
		const h = await createCouncilAgentSession({ sessionManager: manager });
		let resumed: Awaited<ReturnType<typeof createCouncilAgentSession>> | undefined;

		try {
			h.faux.setResponses([fauxAssistantMessage("Ordinary architecture answer.")]);
			await h.runPrompt("Compare SQLite WAL vs rollback journal tradeoffs");
			const preCouncilLeafId = h.session.sessionManager.getLeafId()!;
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);

			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("council", {
						topic: "Design the retry contract",
						rounds: 1,
						members: ["caspar", "melchior"],
					}),
				]),
				fauxAssistantMessage("Synthesized retry design."),
			]);
			await h.runPrompt("Convene the council on lock leases");
			const postCouncilLeafId = h.session.sessionManager.getLeafId()!;
			expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));

			// Navigating back to the pre-council leaf deactivates council.
			await h.session.navigateTree(preCouncilLeafId);
			expect(h.session.getActiveToolNames()).toEqual(["bash"]);
			expect(h.session.getActiveToolNames()).not.toContain("council");

			// Navigating forward to the post-council leaf re-activates council.
			await h.session.navigateTree(postCouncilLeafId);
			expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));

			// Even if manually cleared before reload or navigated across branches, branch state restores council.
			const sessionFile = manager.getSessionFile()!;
			expect(sessionFile).toBeTruthy();
			resumed = await createCouncilAgentSession({
				sessionManager: SessionManager.open(sessionFile, dirForManager),
			});
			expect(resumed.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));
			resumed.session.setActiveToolsByName(["bash"]);
			expect(resumed.session.getActiveToolNames()).toEqual(["bash"]);
			await resumed.session.reload();
			expect(resumed.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));

			await resumed.session.navigateTree(preCouncilLeafId);
			expect(resumed.session.getActiveToolNames()).toEqual(["bash"]);
			await resumed.session.navigateTree(postCouncilLeafId);
			expect(resumed.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "council"]));

			// Also verify session_start + session_tree restoration when branch only has pi-extensions.command
			// (no SystemMessage tool patch yet).
			const commandBranchManager = SessionManager.inMemory(dirForManager);
			commandBranchManager.appendCustomEntry("pi-extensions.command", {
				command: "council",
				kind: "extension",
				extension: "council",
			});
			const fromCommandEntry = await createCouncilAgentSession({
				sessionManager: commandBranchManager,
			});
			try {
				expect(fromCommandEntry.session.getActiveToolNames()).toEqual(
					expect.arrayContaining(["bash", "council"]),
				);
				expect(fromCommandEntry.errors).toEqual([]);
			} finally {
				await fromCommandEntry.cleanup();
			}

			expect(h.errors).toEqual([]);
			expect(resumed.errors).toEqual([]);
		} finally {
			try {
				if (resumed) await resumed.cleanup();
				await h.cleanup();
			} finally {
				await rm(dirForManager, { recursive: true, force: true });
			}
		}
	}, 20_000);

	it("fails fast with isError toolResult and zero subagent spawns when a selected pinned model is missing from ModelRegistry", async () => {
		const h = await createCouncilAgentSession({
			magpieModels: [{ id: "gemini-4-carbon" }, { id: "claude-fable-5-2" }],
		});

		try {
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("council", {
						topic: "Design lock leases",
					}),
				]),
				fauxAssistantMessage("Council could not convene because magpie/gpt-6.2-astra is unavailable."),
			]);

			await h.runPrompt("Convene the council on lock leases");

			expect(h.spawnCount).toBe(0);
			expect(h.errors).toEqual([]);

			const toolResults = h.session.sessionManager
				.getBranch()
				.filter(
					(entry): entry is Extract<typeof entry, { type: "message" }> =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "council",
				);
			expect(toolResults).toHaveLength(1);
			const toolResultMsg = toolResults[0]!.message;
			expect(toolResultMsg.role).toBe("toolResult");
			if (toolResultMsg.role === "toolResult") {
				expect(toolResultMsg.isError).toBe(true);
				const resultText = toolResultMsg.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				expect(resultText).toMatch(/pinned council model\(s\) unavailable/i);
				expect(resultText).toContain("magpie/gpt-6.2-astra");
			}
		} finally {
			await h.cleanup();
		}
	}, 15_000);
});
