import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseAgentDefinition,
	parseAgentFrontmatter,
} from "../../subagents/src/agent-definitions.ts";
import councilExtension, {
	buildRound1Prompt,
	buildRound2Prompt,
	COUNCIL_MEMBERS,
	formatCouncilReport,
	resolveCouncilMembers,
	rotatePeersForMember,
	type CouncilMemberId,
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

interface HarnessOptions {
	pingVersion?: number | null;
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

	const pi = {
		events: bus,
		registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
		registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
		sendUserMessage,
	} as unknown as ExtensionAPI;

	councilExtension(pi);

	return {
		pi,
		bus,
		tool: tools.get("council")!,
		command: commands.get("council")!,
		spawns,
		sends,
		stops,
		consumes,
		sendUserMessage,
	};
}

describe("council agent definitions in extensions/council/agents/", () => {
	it.each([
		["council-argon", "magpie/gemini-4-argon", "high"],
		["council-astra", "magpie/gpt-6-astra", "xhigh"],
		["council-opus", "magpie/claude-opus-5-5", "high"],
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
	it("resolveCouncilMembers defaults to argon, astra, opus and rejects invalid inputs", () => {
		expect(resolveCouncilMembers().map((m) => m.id)).toEqual(["argon", "astra", "opus"]);
		expect(resolveCouncilMembers(["opus", "argon"]).map((m) => m.id)).toEqual(["opus", "argon"]);

		expect(() => resolveCouncilMembers(["argon"])).toThrow(/at least 2 distinct members/i);
		expect(() => resolveCouncilMembers([])).toThrow(/at least 2 distinct members/i);
		expect(() => resolveCouncilMembers(["argon", "argon"])).toThrow(/Duplicate council member "argon"/i);
		expect(() => resolveCouncilMembers(["argon", "unknown"])).toThrow(/Unknown council member "unknown"/i);
	});

	it("rotatePeersForMember counterbalances Peer A and Peer B positions across 3 members and 2 members", () => {
		const proposals: Array<{ member: CouncilMemberId; proposal: string }> = [
			{ member: "argon", proposal: "Argon proposal" },
			{ member: "astra", proposal: "Astra proposal" },
			{ member: "opus", proposal: "Opus proposal" },
		];

		// selfIndex = 0 (argon) -> Peer A = astra, Peer B = opus
		expect(rotatePeersForMember(proposals, 0)).toEqual([
			{ label: "Peer A", member: "astra", proposal: "Astra proposal" },
			{ label: "Peer B", member: "opus", proposal: "Opus proposal" },
		]);

		// selfIndex = 1 (astra) -> Peer A = opus, Peer B = argon
		expect(rotatePeersForMember(proposals, 1)).toEqual([
			{ label: "Peer A", member: "opus", proposal: "Opus proposal" },
			{ label: "Peer B", member: "argon", proposal: "Argon proposal" },
		]);

		// selfIndex = 2 (opus) -> Peer A = argon, Peer B = astra
		expect(rotatePeersForMember(proposals, 2)).toEqual([
			{ label: "Peer A", member: "argon", proposal: "Argon proposal" },
			{ label: "Peer B", member: "astra", proposal: "Astra proposal" },
		]);

		// 2-member panel
		const pair = proposals.slice(0, 2);
		expect(rotatePeersForMember(pair, 0)).toEqual([
			{ label: "Peer A", member: "astra", proposal: "Astra proposal" },
		]);
		expect(rotatePeersForMember(pair, 1)).toEqual([
			{ label: "Peer A", member: "argon", proposal: "Argon proposal" },
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
					text: "Proposal from council-astra on magpie/gpt-6-astra: append-only log at `src/journal.ts:12`.",
				},
				{
					label: "Peer B",
					text: "Proposal from council-opus on magpie/claude-opus-5-5: WAL snapshots at `src/journal.ts:88`.",
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
		expect(r2).not.toMatch(/argon|astra|opus|gemini|gpt|claude/i);
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
			{} as ExtensionContext,
		);

		expect(harness.spawns).toHaveLength(3);
		expect(harness.spawns.map((s) => s.type)).toEqual([
			"council-argon",
			"council-astra",
			"council-opus",
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

		// argon (index 0) gets Peer A = astra, Peer B = opus
		const argonR2 = sendByType.get("council-argon")!;
		expect(argonR2.indexOf("## Peer A")).toBeLessThan(argonR2.indexOf("R1_PROPOSAL_ASTRA_CONTENT"));
		expect(argonR2.indexOf("R1_PROPOSAL_ASTRA_CONTENT")).toBeLessThan(argonR2.indexOf("## Peer B"));
		expect(argonR2.indexOf("## Peer B")).toBeLessThan(argonR2.indexOf("R1_PROPOSAL_OPUS_CONTENT"));
		expect(argonR2).not.toContain("R1_PROPOSAL_ARGON_CONTENT");

		// astra (index 1) gets Peer A = opus, Peer B = argon
		const astraR2 = sendByType.get("council-astra")!;
		expect(astraR2.indexOf("## Peer A")).toBeLessThan(astraR2.indexOf("R1_PROPOSAL_OPUS_CONTENT"));
		expect(astraR2.indexOf("R1_PROPOSAL_OPUS_CONTENT")).toBeLessThan(astraR2.indexOf("## Peer B"));
		expect(astraR2.indexOf("## Peer B")).toBeLessThan(astraR2.indexOf("R1_PROPOSAL_ARGON_CONTENT"));
		expect(astraR2).not.toContain("R1_PROPOSAL_ASTRA_CONTENT");

		// opus (index 2) gets Peer A = argon, Peer B = astra
		const opusR2 = sendByType.get("council-opus")!;
		expect(opusR2.indexOf("## Peer A")).toBeLessThan(opusR2.indexOf("R1_PROPOSAL_ARGON_CONTENT"));
		expect(opusR2.indexOf("R1_PROPOSAL_ARGON_CONTENT")).toBeLessThan(opusR2.indexOf("## Peer B"));
		expect(opusR2.indexOf("## Peer B")).toBeLessThan(opusR2.indexOf("R1_PROPOSAL_ASTRA_CONTENT"));
		expect(opusR2).not.toContain("R1_PROPOSAL_OPUS_CONTENT");

		// Ensure no model or advisor brand names leaked into any Round 2 prompt
		for (const send of harness.sends) {
			const strippedPlaceholder = send.text
				.replaceAll("R1_PROPOSAL_ARGON_CONTENT", "P0")
				.replaceAll("R1_PROPOSAL_ASTRA_CONTENT", "P1")
				.replaceAll("R1_PROPOSAL_OPUS_CONTENT", "P2")
				.replaceAll("src/argon.ts", "src/p0.ts")
				.replaceAll("src/astra.ts", "src/p1.ts")
				.replaceAll("src/opus.ts", "src/p2.ts");
			expect(strippedPlaceholder).not.toMatch(/argon|astra|opus|gemini|gpt|claude/i);
		}

		// 3 settles in Round 1 + 3 settles in Round 2 = 6 synchronous consumes
		expect(harness.consumes).toHaveLength(6);
		expect(harness.consumes.every((c) => c.settledSynchronously)).toBe(true);

		const text = result.content[0].text as string;
		expect(text).toContain("# Council Deliberation Report");
		expect(text).toContain("## Round 1 — Independent Proposals");
		expect(text).toContain("## Round 2 — Cross-Examination & Revised Designs");
		expect(text).toContain("## Stake-Free Parent Synthesis Instructions");
		expect(text).toContain(COUNCIL_MEMBERS.argon.label);
		expect(text).toContain(COUNCIL_MEMBERS.astra.label);
		expect(text).toContain(COUNCIL_MEMBERS.opus.label);
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
				members: ["argon", "opus"],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(harness.spawns).toHaveLength(2);
		expect(harness.spawns.map((s) => s.type)).toEqual(["council-argon", "council-opus"]);
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
				{} as ExtensionContext,
			),
		).rejects.toThrow("Model overrides are not permitted on council; members use pinned council agent definitions.");

		await expect(
			harness.tool.execute(
				"tc-err-topic",
				{ topic: "   " },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Council topic must not be empty/i);

		await expect(
			harness.tool.execute(
				"tc-err-members-1",
				{ topic: "Valid topic", members: ["argon"] as any },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/at least 2 distinct members/i);

		await expect(
			harness.tool.execute(
				"tc-err-members-dup",
				{ topic: "Valid topic", members: ["astra", "astra"] as any },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Duplicate council member/i);

		const oldProtocolHarness = bootCouncilHarness({ pingVersion: 2 });
		await expect(
			oldProtocolHarness.tool.execute(
				"tc-err-v2",
				{ topic: "Valid topic" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/RPC protocol >= 3/i);
	});

	it("completes deliberation when 1 of 3 members fails in Round 1 or Round 2, and throws when 2 of 3 fail in Round 1", async () => {
		const r1PartialHarness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				if (type === "council-astra") {
					return { event: "failed", status: "error", error: "Gateway timeout on astra" };
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
			{} as ExtensionContext,
		);

		expect(r1PartialResult.details.round1).toHaveLength(2);
		expect(r1PartialResult.details.round2).toHaveLength(2);
		expect(r1PartialResult.details.failures).toEqual([
			{
				member: "astra",
				agentType: "council-astra",
				model: "magpie/gpt-6-astra",
				round: 1,
				error: "Gateway timeout on astra",
			},
		]);
		expect(r1PartialResult.content[0].text).toContain("## Member Failures");
		expect(r1PartialResult.content[0].text).toContain("Gateway timeout on astra");

		const r2PartialHarness = bootCouncilHarness({
			round2Handler: ({ type }) => {
				if (type === "council-opus") {
					return { event: "failed", status: "error", error: "Opus R2 rate limit" };
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
			{} as ExtensionContext,
		);

		expect(r2PartialResult.details.round1).toHaveLength(3);
		expect(r2PartialResult.details.round2).toHaveLength(2);
		expect(r2PartialResult.details.failures).toEqual([
			{
				member: "opus",
				agentType: "council-opus",
				model: "magpie/claude-opus-5-5",
				round: 2,
				error: "Opus R2 rate limit",
			},
		]);

		const r1TwoFailedHarness = bootCouncilHarness({
			round1Handler: ({ type }) => {
				if (type !== "council-argon") {
					return { event: "failed", status: "error", error: `${type} unavailable` };
				}
				return { event: "completed", status: "completed", result: "Argon proposal" };
			},
		});

		await expect(
			r1TwoFailedHarness.tool.execute(
				"tc-two-failed",
				{ topic: "Majority failure check" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/at least 2 members must succeed in Round 1/i);
	});

	it("emits subagents:rpc:stop for all active council subagents when AbortSignal aborts", async () => {
		const harness = bootCouncilHarness({
			round1Handler: () => "hang",
		});

		const controller = new AbortController();
		const promise = harness.tool.execute(
			"tc-abort",
			{ topic: "Abort while Round 1 is running" },
			controller.signal,
			undefined,
			{} as ExtensionContext,
		);

		await vi.waitFor(() => expect(harness.spawns).toHaveLength(3));
		controller.abort();

		await expect(promise).rejects.toThrow(/aborted/i);
		expect(harness.stops.map((s) => s.agentId).sort()).toEqual(
			harness.spawns.map((s) => s.id).sort(),
		);
	});
});

describe("/council command and package contracts", () => {
	it("notifies usage and pinned members when called without arguments, and sends a user message with a topic", async () => {
		const harness = bootCouncilHarness();
		const notify = vi.fn();
		const ctx = {
			ui: { notify },
			isIdle: () => true,
		} as unknown as ExtensionContext;

		await harness.command.handler("", ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("/council <topic or design question>");
		expect(notify.mock.calls[0][0]).toContain("magpie/gemini-4-argon");
		expect(notify.mock.calls[0][0]).toContain("magpie/gpt-6-astra");
		expect(notify.mock.calls[0][0]).toContain("magpie/claude-opus-5-5");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();

		await harness.command.handler("help", ctx);
		await harness.command.handler("status", ctx);
		expect(notify).toHaveBeenCalledTimes(3);

		await harness.command.handler("Design the distributed lock lease renewal protocol", ctx);
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
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendUserMessage.mock.calls[1][1]).toEqual({ deliverAs: "followUp" });
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
		expect(manifest.scripts.test).toContain("npm run test:subagents && npm run test:council &&");
		expect(manifest.scripts.test).toContain("npm run test:molt && npm run test:language && npm run test:spokesman &&");

		const exts = manifest.pi.extensions;
		const subagentsIdx = exts.indexOf("./extensions/subagents/src/index.ts");
		const councilIdx = exts.indexOf("./extensions/council/index.ts");
		const workspaceIdx = exts.indexOf("./extensions/workspace/index.ts");
		const pikaIdx = exts.indexOf("./extensions/pika/index.ts");

		expect(councilIdx).toBe(subagentsIdx + 1);
		expect(workspaceIdx).toBe(pikaIdx - 1);
		expect(exts.at(-1)).toBe("./extensions/pika/index.ts");
		expect(manifest.pi.prompts.some((p) => p.includes("council"))).toBe(false);

		expect(councilReadme).toContain("council-argon");
		expect(councilReadme).toContain("council-astra");
		expect(councilReadme).toContain("council-opus");
		expect(councilReadme).toContain("rotatePeersForMember");

		expect(rootReadme).toContain("[Council](extensions/council/README.md)");
		expect(agentsMd).toContain("`extensions/council/`");
		expect(agentsMd).toContain("`npm run test:council`");
		expect(configMd).toContain("[Council](../extensions/council/README.md)");
		expect(delegationMd).toContain("[Council](../../extensions/council/README.md)");

		// formatCouncilReport smoke test
		const formatted = formatCouncilReport({
			topic: "Test topic",
			rounds: 1,
			members: ["argon", "astra"],
			round1: [],
			round2: [],
			failures: [],
		});
		expect(formatted).toContain("Stake-Free Parent Synthesis Instructions");
	});
});
