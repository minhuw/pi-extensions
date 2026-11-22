import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export const COUNCIL_MEMBER_IDS = ["caspar", "melchior", "balthasar"] as const;
export type CouncilMemberId = (typeof COUNCIL_MEMBER_IDS)[number];
export const COUNCIL_REPORT_MESSAGE_TYPE = "council-report";

export interface CouncilMemberSpec {
	id: CouncilMemberId;
	agentType: `council-${CouncilMemberId}`;
	model: string;
	thinking: "high" | "xhigh";
	label: string;
}

function defineCouncilMember(
	id: CouncilMemberId,
	displayName: string,
	model: string,
	thinking: "high" | "xhigh",
): CouncilMemberSpec {
	return {
		id,
		agentType: `council-${id}`,
		model,
		thinking,
		label: `${displayName} (${model})`,
	};
}

export const COUNCIL_MEMBERS: Record<CouncilMemberId, CouncilMemberSpec> = {
	caspar: defineCouncilMember("caspar", "Caspar", "magpie/gemini-4-carbon", "high"),
	melchior: defineCouncilMember("melchior", "Melchior", "magpie/gpt-6.2-astra", "xhigh"),
	balthasar: defineCouncilMember("balthasar", "Balthasar", "magpie/claude-fable-5-2", "high"),
};

const COUNCIL_AGENT_TYPES = new Set<string>(Object.values(COUNCIL_MEMBERS).map((m) => m.agentType));

export type PeerLabel = "Peer A" | "Peer B";

export interface CouncilPeerMapping {
	label: PeerLabel;
	member: CouncilMemberId;
	model: string;
}

export interface CouncilRound1Entry {
	member: CouncilMemberId;
	agentType: string;
	model: string;
	label: string;
	agentId: string;
	proposal: string;
	durationMs?: number;
	toolUses?: number;
}

export interface CouncilRound2Entry {
	member: CouncilMemberId;
	agentType: string;
	model: string;
	label: string;
	agentId: string;
	peers: CouncilPeerMapping[];
	response: string;
	durationMs?: number;
	toolUses?: number;
}

export interface CouncilMemberFailure {
	member: CouncilMemberId;
	agentType: string;
	model: string;
	round: 1 | 2;
	error: string;
}

export interface CouncilReportInput {
	councilId?: string;
	topic: string;
	paths?: readonly string[];
	rounds: 1 | 2;
	members: readonly CouncilMemberId[];
	round1: readonly CouncilRound1Entry[];
	round2: readonly CouncilRound2Entry[];
	failures: readonly CouncilMemberFailure[];
}

export const CouncilParameters = Type.Object({
	topic: Type.String({
		minLength: 1,
		description: "The architectural, design, or difficult technical question for the council to deliberate.",
	}),
	paths: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Optional repository file or directory paths for council members to inspect first.",
		}),
	),
	rounds: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(2)], {
			description:
				"Deliberation depth: 1 (independent proposals only) or 2 (independent proposals + anonymized peer cross-examination). Defaults to 2.",
		}),
	),
	members: Type.Optional(
		Type.Array(Type.Union([Type.Literal("caspar"), Type.Literal("melchior"), Type.Literal("balthasar")]), {
			minItems: 2,
			maxItems: 3,
			description: "Distinct council members to convene (minimum 2). Defaults to all three: caspar, melchior, balthasar.",
		}),
	),
});

export interface CouncilModelRegistry {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	getAvailable?(): ReadonlyArray<{ provider: string; id: string }>;
	hasConfiguredAuth?(model: any): boolean;
}

export function assertCouncilModelsAvailable(
	specs: readonly CouncilMemberSpec[],
	modelRegistry: CouncilModelRegistry | undefined,
): void {
	if (!modelRegistry || typeof modelRegistry.find !== "function") {
		throw new Error("Council deliberation failed: model registry is unavailable to verify pinned council models.");
	}

	const availableKeys =
		typeof modelRegistry.getAvailable === "function"
			? new Set(modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`))
			: undefined;

	const unavailable: string[] = [];
	for (const spec of specs) {
		const slashIdx = spec.model.indexOf("/");
		const provider = slashIdx > 0 ? spec.model.slice(0, slashIdx) : "";
		const modelId = slashIdx > 0 ? spec.model.slice(slashIdx + 1) : "";
		const found = slashIdx > 0 && modelId.length > 0 ? modelRegistry.find(provider, modelId) : undefined;

		if (!found) {
			unavailable.push(`${spec.id} (${spec.model}: model not registered)`);
			continue;
		}

		const hasAuth =
			typeof modelRegistry.hasConfiguredAuth === "function" ? modelRegistry.hasConfiguredAuth(found) : undefined;
		const inAvailable = availableKeys ? availableKeys.has(`${provider}/${modelId}`) : undefined;
		if (hasAuth === false || inAvailable === false) {
			unavailable.push(`${spec.id} (${spec.model}: model unavailable or missing credentials)`);
		}
	}

	if (unavailable.length > 0) {
		throw new Error(
			`Council deliberation failed: pinned council model(s) unavailable — ${unavailable.join("; ")}.`,
		);
	}
}

export function resolveCouncilMembers(members?: readonly string[]): CouncilMemberSpec[] {
	const rawList = members === undefined ? [...COUNCIL_MEMBER_IDS] : members;
	if (!Array.isArray(rawList)) {
		throw new Error("Council members must be an array of at least 2 distinct member IDs (caspar, melchior, balthasar).");
	}
	const seen = new Set<CouncilMemberId>();
	const resolved: CouncilMemberSpec[] = [];
	for (const raw of rawList) {
		const id = typeof raw === "string" ? raw.trim() : "";
		if (!Object.prototype.hasOwnProperty.call(COUNCIL_MEMBERS, id)) {
			throw new Error(`Unknown council member "${String(raw)}". Valid members: caspar, melchior, balthasar.`);
		}
		const memberId = id as CouncilMemberId;
		if (seen.has(memberId)) {
			throw new Error(`Duplicate council member "${memberId}". Council members must be distinct.`);
		}
		seen.add(memberId);
		resolved.push(COUNCIL_MEMBERS[memberId]);
	}
	if (resolved.length < 2) {
		throw new Error(`Council deliberation requires at least 2 distinct members (received ${resolved.length}).`);
	}
	if (resolved.length > 3) {
		throw new Error(`Council deliberation supports at most 3 members (received ${resolved.length}).`);
	}
	return resolved;
}

export function rotatePeersForMember<T extends { member: CouncilMemberId }>(
	proposals: readonly T[],
	selfIndex: number,
): Array<T & { label: PeerLabel }> {
	if (proposals.length < 2 || proposals.length > 3) {
		throw new Error(`rotatePeersForMember requires 2 or 3 proposals (received ${proposals.length}).`);
	}
	if (!Number.isInteger(selfIndex) || selfIndex < 0 || selfIndex >= proposals.length) {
		throw new Error(`Invalid selfIndex ${selfIndex} for ${proposals.length} proposals.`);
	}
	const rotated: Array<T & { label: PeerLabel }> = [];
	for (let step = 1; step < proposals.length; step++) {
		const peerIndex = (selfIndex + step) % proposals.length;
		const label: PeerLabel = step === 1 ? "Peer A" : "Peer B";
		rotated.push({
			...proposals[peerIndex]!,
			label,
		});
	}
	return rotated;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildIdentityLeakPatterns(members: readonly CouncilMemberSpec[]): readonly RegExp[] {
	const tokens = [
		...members.map((m) => m.model),
		...members.map((m) => m.agentType),
		...members.flatMap((m) => {
			const slashIdx = m.model.indexOf("/");
			const bareModelId = slashIdx > 0 ? m.model.slice(slashIdx + 1) : "";
			return bareModelId ? [bareModelId] : [];
		}),
	];
	return tokens.map((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "gi"));
}

const IDENTITY_LEAK_PATTERNS: readonly RegExp[] = buildIdentityLeakPatterns(Object.values(COUNCIL_MEMBERS));

function scrubModelIdentity(text: string): string {
	let sanitized = text;
	for (const pattern of IDENTITY_LEAK_PATTERNS) {
		sanitized = sanitized.replace(pattern, "[redacted-advisor]");
	}
	return sanitized;
}

export function buildRound1Prompt(input: { topic: string; paths?: readonly string[] }): string {
	const topic = typeof input.topic === "string" ? input.topic.trim() : "";
	if (!topic) {
		throw new Error("Council topic must not be empty.");
	}
	const paths = (input.paths ?? []).map((p) => p.trim()).filter(Boolean);
	const pathSection =
		paths.length > 0
			? [
					"## Starting Paths",
					...paths.map((p) => `- \`${p}\``),
					"",
					"Inspect the listed paths (and any relevant callers, types, and tests) using read-only tools before formulating your proposal.",
				]
			: [
					"## Codebase Inspection",
					"Locate and inspect the relevant files, types, interfaces, and call sites using read-only tools before formulating your proposal.",
				];

	return [
		"# Council Deliberation — Round 1 (Independent Proposal)",
		"",
		"## Topic",
		topic,
		"",
		...pathSection,
		"",
		"## Instructions",
		"- Ground every claim in concrete `file:line` codebase evidence. Distinguish observed facts from assumptions.",
		"- Keep your proposal concise, structured, and high-signal; avoid filler or unnecessary verbosity.",
		"- Respond using these exact sections:",
		"",
		"### 1. Proposed Design / API Contract",
		"Concrete architecture, boundaries, data flow, and type/function signatures.",
		"",
		"### 2. Key Tradeoffs & Assumptions",
		"Why this design beats realistic alternatives, and what assumptions it relies on.",
		"",
		"### 3. Edge Cases & Failure Modes",
		"Critical edge cases, failure handling, and how the design should be verified.",
	].join("\n");
}

export function buildRound2Prompt(input: {
	topic: string;
	peers: readonly { label: string; text: string }[];
}): string {
	const topic = typeof input.topic === "string" ? input.topic.trim() : "";
	if (!topic) {
		throw new Error("Council topic must not be empty.");
	}
	if (!Array.isArray(input.peers) || input.peers.length === 0) {
		throw new Error("Round 2 requires at least one peer proposal.");
	}

	const peerBlocks = input.peers.flatMap((peer) => [
		`## ${peer.label}`,
		scrubModelIdentity(peer.text.trim()),
		"",
	]);

	return [
		"# Council Deliberation — Round 2 (Anonymized Peer Cross-Examination)",
		"",
		"## Original Topic",
		topic,
		"",
		"## Anonymized Peer Proposals",
		"Peer identities and presentation order have been randomized and anonymized.",
		"",
		...peerBlocks,
		"## Evaluation Rubric (Bias & Verbosity Normalization)",
		"- Evaluate each peer proposal strictly on technical soundness, simplicity, and verifiable `file:line` codebase evidence.",
		"- Ignore response length, formatting polish, and rhetorical confidence: a shorter, evidence-backed design is superior to a longer, speculative one.",
		"- Do not herd toward majority opinion if codebase evidence contradicts it. Verify disputed claims with read-only tools when needed.",
		"- Do not speculate about which advisor authored any peer proposal.",
		"",
		"## Required Output Sections",
		"Respond using these exact sections:",
		"",
		"### 1. Adopt",
		"Specific ideas, invariants, or edge-case protections from `Peer A` or `Peer B` that strengthen your design.",
		"",
		"### 2. Critique",
		"Concrete technical flaws, over-engineering, unverified assumptions, or failure modes in `Peer A` or `Peer B`, citing `file:line` evidence.",
		"",
		"### 3. Revised Design & Verdict",
		"- **Stance:** `converged` (a clear best synthesis exists) or `tradeoff` (a genuine architectural fork requires a user decision).",
		"- **Revised Design:** Your updated, self-contained recommendation incorporating the strongest insights, or a crisp characterization of the remaining tradeoff.",
	].join("\n");
}

function formatCouncilReportHeader(input: {
	title: string;
	councilIdBullet?: string;
	topic: string;
	paths?: readonly string[];
	rounds: 1 | 2;
	members: readonly CouncilMemberId[];
	error?: string;
	failures: readonly CouncilMemberFailure[];
}): string[] {
	const lines: string[] = [
		input.title,
		"",
		...(input.councilIdBullet ? [`- **Council ID:** \`${input.councilIdBullet}\``] : []),
		`- **Topic:** ${input.topic}`,
		...(input.paths && input.paths.length > 0
			? [`- **Paths:** ${input.paths.map((p) => `\`${p}\``).join(", ")}`]
			: []),
		`- **Rounds:** ${input.rounds}`,
		`- **Panel:** ${input.members.map((id) => COUNCIL_MEMBERS[id].label).join(", ")}`,
		...(input.error !== undefined ? [`- **Error:** ${input.error}`] : []),
	];

	if (input.failures.length > 0) {
		lines.push("", "## Member Failures");
		for (const failure of input.failures) {
			lines.push(
				`- **${COUNCIL_MEMBERS[failure.member].label}** (Round ${failure.round}): ${failure.error}`,
			);
		}
	}

	return lines;
}

export function formatCouncilReport(input: CouncilReportInput): string {
	const lines = formatCouncilReportHeader({
		title: "# Council Deliberation Report",
		councilIdBullet: input.councilId,
		topic: input.topic,
		paths: input.paths,
		rounds: input.rounds,
		members: input.members,
		failures: input.failures,
	});

	lines.push("", "## Round 1 — Independent Proposals");
	for (const entry of input.round1) {
		lines.push("", `### ${entry.label}`, "", entry.proposal.trim());
	}

	if (input.rounds === 2 && input.round2.length > 0) {
		lines.push("", "## Round 2 — Cross-Examination & Revised Designs");
		for (const entry of input.round2) {
			const mapping = entry.peers
				.map((p) => `${p.label} = ${COUNCIL_MEMBERS[p.member].label}`)
				.join(", ");
			lines.push(
				"",
				`### ${entry.label}`,
				`_Anonymized peer mapping: ${mapping}_`,
				"",
				entry.response.trim(),
			);
		}
	}

	lines.push(
		"",
		"## Stake-Free Parent Synthesis Instructions",
		"You did not author any of the proposals above. Act as a stake-free judge:",
		"1. **Convergence:** Identify where the council advisors converged after cross-examination.",
		"2. **Evidence over verbosity:** Resolve disagreements using cited `file:line` codebase evidence and architectural simplicity, discounting response length or rhetorical confidence.",
		"3. **Recommendation:** Present the synthesized design (or surface any genuine `tradeoff` fork that requires a user decision) and outline concrete next steps.",
	);

	return lines.join("\n");
}

interface RpcReply<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
}

interface LifecycleSettlePayload {
	id: string;
	type?: string;
	description?: string;
	result?: string;
	error?: string;
	status?: string;
	toolUses?: number;
	runToolUses?: number;
	durationMs?: number;
}

const DEFAULT_PING_TIMEOUT_MS = 1000;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatCouncilFailure(input: {
	councilId: string;
	topic: string;
	paths?: readonly string[];
	rounds: 1 | 2;
	members: readonly CouncilMemberId[];
	failures: readonly CouncilMemberFailure[];
	error: string;
}): string {
	return formatCouncilReportHeader({
		title: `# Council Deliberation Failed (\`${input.councilId}\`)`,
		topic: input.topic,
		paths: input.paths,
		rounds: input.rounds,
		members: input.members,
		error: input.error,
		failures: input.failures,
	}).join("\n");
}

interface ActiveCouncilRun {
	councilId: string;
	topic: string;
	shortTopic: string;
	rounds: 1 | 2;
	members: CouncilMemberId[];
	phase: 1 | 2;
	completedInPhase: number;
	totalInPhase: number;
	startedAt: number;
	cancel: (reason: string) => void;
}

export const COUNCIL_USAGE = [
	"Usage:",
	"  /council <topic or design question>   start a background council deliberation",
	"  /council status                        show active council deliberations",
	"  /council stop [councilId]              cancel active council deliberation(s)",
	"Pinned council members:",
	`  - caspar: ${COUNCIL_MEMBERS.caspar.agentType} (${COUNCIL_MEMBERS.caspar.model}, thinking: ${COUNCIL_MEMBERS.caspar.thinking})`,
	`  - melchior: ${COUNCIL_MEMBERS.melchior.agentType} (${COUNCIL_MEMBERS.melchior.model}, thinking: ${COUNCIL_MEMBERS.melchior.thinking})`,
	`  - balthasar:  ${COUNCIL_MEMBERS.balthasar.agentType} (${COUNCIL_MEMBERS.balthasar.model}, thinking: ${COUNCIL_MEMBERS.balthasar.thinking})`,
].join("\n");

export const COUNCIL_MENTION_RE = /\bcouncil(?:-(?:caspar|melchior|balthasar))?\b/i;

function hasCouncilBranchState(branch: readonly SessionEntry[] | undefined): boolean {
	if (!branch) return false;
	return branch.some(
		(entry) =>
			(entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "council") ||
			(entry.type === "custom" &&
				entry.customType === "pi-extensions.command" &&
				(entry.data as { command?: unknown } | undefined)?.command === "council"),
	);
}

export default function councilExtension(pi: ExtensionAPI): void {
	const activeRuns = new Map<string, ActiveCouncilRun>();
	const globalOwnedAgentIds = new Set<string>();
	let statusSetter: ((key: string, text: string | undefined) => void) | undefined;

	function refreshStatus(overrideSetter?: (key: string, text: string | undefined) => void): void {
		if (overrideSetter) {
			statusSetter = overrideSetter;
		}
		if (!statusSetter) return;
		let nextText: string | undefined;
		if (activeRuns.size === 1) {
			const run = activeRuns.values().next().value!;
			nextText = `council R${run.phase} (${run.completedInPhase}/${run.totalInPhase})`;
		} else if (activeRuns.size > 1) {
			nextText = `council ×${activeRuns.size}`;
		}
		try {
			statusSetter("council", nextText);
		} catch {
			// Ignore stale/disposed UI handles during shutdown or session switch.
		}
	}

	function cancelAllActiveRuns(reason: string): string[] {
		const runs = [...activeRuns.values()];
		const stoppedIds: string[] = [];
		for (const run of runs) {
			stoppedIds.push(run.councilId);
			run.cancel(reason);
		}
		return stoppedIds;
	}

	function activateCouncilTool(): void {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const active = pi.getActiveTools();
		if (!active.includes("council")) pi.setActiveTools([...active, "council"]);
	}

	if (typeof pi.on === "function") {
		const restoreFromBranch = (
			_event: unknown,
			ctx: { sessionManager?: { getBranch?: () => SessionEntry[] } },
		) => {
			if (hasCouncilBranchState(ctx.sessionManager?.getBranch?.())) {
				activateCouncilTool();
			}
		};

		pi.on("session_start", restoreFromBranch);
		pi.on("session_tree", restoreFromBranch);
		pi.on("session_shutdown", () => {
			cancelAllActiveRuns("Council deliberation cancelled: session shutdown.");
		});
		pi.on("session_before_switch", () => {
			cancelAllActiveRuns("Council deliberation cancelled: session switched.");
		});
		pi.on("before_agent_start", (event) => {
			if (
				event.messageType === "user" &&
				typeof event.prompt === "string" &&
				COUNCIL_MENTION_RE.test(event.prompt)
			) {
				activateCouncilTool();
			}
		});
	}
	const callRpc = <T = unknown>(
		channel: string,
		payload: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<RpcReply<T>> => {
		const requestId = randomUUID();
		const replyChannel = `subagents:rpc:${channel}:reply:${requestId}`;
		return new Promise<RpcReply<T>>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsub = pi.events.on(replyChannel, (raw: unknown) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				unsub?.();
				resolve(raw as RpcReply<T>);
			});
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					unsub?.();
					reject(
						new Error(
							`Timed out waiting for subagents:rpc:${channel} reply. Ensure the subagents extension (RPC protocol >= 3) is active.`,
						),
					);
				}, timeoutMs);
				timer.unref?.();
			}
			pi.events.emit(`subagents:rpc:${channel}`, { requestId, ...payload });
		});
	};

	pi.registerTool({
		name: "council",
		label: "Council",
		defaultActive: false,
		description: `Convene a 3-model read-only technical council (Caspar on ${COUNCIL_MEMBERS.caspar.model}, Melchior on ${COUNCIL_MEMBERS.melchior.model}, Balthasar on ${COUNCIL_MEMBERS.balthasar.model}) asynchronously for a 2-round deliberation on difficult architecture, design, or tradeoff questions. Returns immediately with a launch receipt once Round 1 advisors are spawned; Round 1 independent proposals and Round 2 anonymized, position-swapped peer cross-examination (Peer A, Peer B) run in the background, and the completed report arrives automatically as a follow-up message for stake-free synthesis. After calling this tool, end your turn and wait for the follow-up report — do not poll, sleep, or re-invoke council to wait for it.`,
		promptSnippet:
			"Convene the 3-model read-only technical council (Caspar, Melchior, Balthasar) asynchronously for 2-round architectural deliberation (returns immediately; report arrives as a follow-up message)",
		promptGuidelines: [
			"Use `council` when the user invokes `/council`, asks for the council, or faces a high-stakes architectural or design tradeoff that benefits from multi-model deliberation.",
			"Never pass a `model` override to `council`; council advisors are pinned to their dedicated agent definitions.",
			"`council` runs asynchronously in the background and returns a launch receipt immediately. End your turn and wait for the `council-report` follow-up message — never poll, sleep, or call `council` again to wait for an in-flight deliberation.",
		],
		parameters: CouncilParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if ((params as Record<string, unknown>).model !== undefined) {
				throw new Error(
					"Model overrides are not permitted on council; members use pinned council agent definitions.",
				);
			}

			const topic = typeof params.topic === "string" ? params.topic.trim() : "";
			if (!topic) {
				throw new Error("Council topic must not be empty.");
			}
			const rounds: 1 | 2 = params.rounds ?? 2;
			if (rounds !== 1 && rounds !== 2) {
				throw new Error("Council rounds must be 1 or 2.");
			}
			const specs = resolveCouncilMembers(params.members);
			const paths = params.paths?.map((p) => p.trim()).filter(Boolean);

			if (signal?.aborted) {
				throw new Error("Council deliberation aborted.");
			}

			const pingReply = await callRpc<{ version?: number }>("ping", {}, DEFAULT_PING_TIMEOUT_MS);
			if (signal?.aborted) {
				throw new Error("Council deliberation aborted.");
			}
			if (!pingReply?.success || typeof pingReply.data?.version !== "number" || pingReply.data.version < 3) {
				const reason = !pingReply?.success
					? pingReply?.error ?? "ping failed"
					: `unsupported protocol version ${String(pingReply.data?.version)}`;
				throw new Error(`Council requires pi-subagents RPC protocol >= 3 (${reason}).`);
			}

			assertCouncilModelsAvailable(specs, ctx?.modelRegistry);

			const councilId = `council-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
			const memberIds = specs.map((s) => s.id);
			const selectedAgentTypes = new Set<string>(specs.map((s) => s.agentType));
			const shortTopic = topic.replace(/\s+/g, " ").slice(0, 60);
			const expectedSpawnDescriptions = new Set<string>(
				specs.map((spec) => `Council R1 (${spec.id}): ${shortTopic}`),
			);
			const runStatusSetter =
				typeof ctx?.ui?.setStatus === "function" ? ctx.ui.setStatus.bind(ctx.ui) : undefined;

			const ownedAgentIds = new Set<string>();
			const activeAgentIds = new Set<string>();
			const settledAgents = new Set<string>();
			const round1StoppedIds = new Set<string>();
			const releasedAgentIds = new Set<string>();
			const pendingWaiters = new Map<
				string,
				(outcome: { event: "completed" | "failed"; data: LifecycleSettlePayload }) => void
			>();
			const earlySettles = new Map<
				string,
				{ event: "completed" | "failed"; data: LifecycleSettlePayload }
			>();
			const cancelWaiters = new Set<(err: Error) => void>();

			let inFlightSpawns = 0;
			let inRound2 = false;
			let cancelled = false;
			let cancelReason = "Council deliberation aborted.";
			let cleanedUp = false;
			let registeredInActiveRuns = false;

			const isCancelledOrDone = () => cancelled || cleanedUp;

			const claimAgent = (agentId: string) => {
				ownedAgentIds.add(agentId);
				if (!cleanedUp) {
					globalOwnedAgentIds.add(agentId);
				}
			};

			const stopAgent = (agentId: string) => {
				activeAgentIds.delete(agentId);
				if (!inRound2) {
					round1StoppedIds.add(agentId);
				}
				pi.events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId });
			};

			const releaseAgent = (agentId: string, force = false) => {
				if (!force && releasedAgentIds.has(agentId)) return;
				releasedAgentIds.add(agentId);
				pi.events.emit("subagents:rpc:release", { requestId: randomUUID(), agentId });
			};

			const stopActiveAgents = () => {
				for (const agentId of [...activeAgentIds]) {
					stopAgent(agentId);
				}
			};

			const releaseOwnedAgents = () => {
				for (const agentId of ownedAgentIds) {
					releaseAgent(agentId);
				}
			};

			let unsubStarted: (() => void) | undefined;
			let unsubCompleted: (() => void) | undefined;
			let unsubFailed: (() => void) | undefined;

			const cleanup = () => {
				if (cleanedUp) return;
				cleanedUp = true;
				stopActiveAgents();
				releaseOwnedAgents();
				signal?.removeEventListener("abort", onLaunchAbort);
				unsubStarted?.();
				unsubCompleted?.();
				unsubFailed?.();
				unsubStarted = undefined;
				unsubCompleted = undefined;
				unsubFailed = undefined;
				pendingWaiters.clear();
				earlySettles.clear();
				cancelWaiters.clear();
				for (const agentId of ownedAgentIds) {
					globalOwnedAgentIds.delete(agentId);
				}
				if (registeredInActiveRuns) {
					activeRuns.delete(councilId);
					refreshStatus();
				}
			};

			const cancel = (reason: string) => {
				if (cancelled) return;
				cancelled = true;
				cancelReason = reason;
				const cancelError = new Error(reason);
				for (const rejectWaiter of [...cancelWaiters]) {
					rejectWaiter(cancelError);
				}
				cancelWaiters.clear();
				cleanup();
			};

			const onLaunchAbort = () => {
				cancel("Council deliberation aborted.");
			};

			const cancelPromise = new Promise<never>((_resolve, reject) => {
				if (cancelled || signal?.aborted) {
					reject(new Error(cancelReason));
					return;
				}
				cancelWaiters.add(reject);
			});
			cancelPromise.catch(() => {});

			signal?.addEventListener("abort", onLaunchAbort, { once: true });

			const matchesInFlightSpawn = (data: {
				id?: string;
				type?: string;
				description?: string;
			}): boolean =>
				Boolean(data.id) &&
				!globalOwnedAgentIds.has(data.id!) &&
				inFlightSpawns > 0 &&
				typeof data.type === "string" &&
				selectedAgentTypes.has(data.type) &&
				COUNCIL_AGENT_TYPES.has(data.type) &&
				(!data.description || expectedSpawnDescriptions.has(data.description));

			const handleSettle = (event: "completed" | "failed", raw: unknown) => {
				const data = raw as LifecycleSettlePayload | undefined;
				const agentId = data?.id;
				if (!agentId) return;

				const isKnownCouncilAgent =
					ownedAgentIds.has(agentId) || matchesInFlightSpawn(data);
				if (!isKnownCouncilAgent) return;

				claimAgent(agentId);
				activeAgentIds.delete(agentId);
				settledAgents.add(agentId);

				// Synchronously consume completion so pi-subagents never schedules a parent notification.
				pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });

				const outcome = { event, data };
				const waiter = pendingWaiters.get(agentId);
				if (waiter) {
					pendingWaiters.delete(agentId);
					waiter(outcome);
				} else {
					earlySettles.set(agentId, outcome);
				}
			};

			unsubStarted = pi.events.on("subagents:started", (raw: unknown) => {
				const data = raw as { id?: string; type?: string; description?: string } | undefined;
				if (!data?.id) return;
				if (ownedAgentIds.has(data.id) || matchesInFlightSpawn(data)) {
					claimAgent(data.id);
					if (isCancelledOrDone()) {
						if (inRound2 || !round1StoppedIds.has(data.id)) {
							stopAgent(data.id);
						}
						releaseAgent(data.id, inRound2);
					} else {
						activeAgentIds.add(data.id);
					}
				}
			});
			unsubCompleted = pi.events.on("subagents:completed", (raw: unknown) =>
				handleSettle("completed", raw),
			);
			unsubFailed = pi.events.on("subagents:failed", (raw: unknown) =>
				handleSettle("failed", raw),
			);

			const waitForAgentSettle = (
				agentId: string,
			): Promise<{ event: "completed" | "failed"; data: LifecycleSettlePayload }> => {
				if (cancelled) {
					return Promise.reject(new Error(cancelReason));
				}
				const early = earlySettles.get(agentId);
				if (early) {
					earlySettles.delete(agentId);
					return Promise.resolve(early);
				}
				return new Promise((resolve, reject) => {
					const onWaitCancel = (err: Error) => {
						pendingWaiters.delete(agentId);
						cancelWaiters.delete(onWaitCancel);
						reject(err);
					};
					cancelWaiters.add(onWaitCancel);
					pendingWaiters.set(agentId, (outcome) => {
						cancelWaiters.delete(onWaitCancel);
						resolve(outcome);
					});
				});
			};

			const pushMemberFailure = (
				target: CouncilMemberFailure[],
				source: CouncilMemberSpec | Pick<CouncilRound1Entry, "member" | "agentType" | "model">,
				round: 1 | 2,
				error: string,
			) => {
				target.push({
					member: "member" in source ? source.member : source.id,
					agentType: source.agentType,
					model: source.model,
					round,
					error,
				});
			};

			let spawned: Array<{ spec: CouncilMemberSpec; agentId: string }>;
			let launchFailures: CouncilMemberFailure[];

			try {
				const round1Prompt = buildRound1Prompt({ topic, paths });
				const spawnResults = await Promise.all(
					specs.map(async (spec) => {
						inFlightSpawns++;
						let handledLateSpawn = false;
						const stopAndReleaseLateSpawn = (agentId: string) => {
							if (handledLateSpawn) return;
							handledLateSpawn = true;
							ownedAgentIds.add(agentId);
							if (!settledAgents.has(agentId) && !round1StoppedIds.has(agentId)) {
								stopAgent(agentId);
							}
							releaseAgent(agentId);
						};

						const spawnPromise = callRpc<{ id: string }>("spawn", {
							type: spec.agentType,
							prompt: round1Prompt,
							options: {
								description: `Council R1 (${spec.id}): ${shortTopic}`,
								notifyParent: false,
								retain: rounds === 2,
								isBackground: true,
								bypassQueue: true,
							},
						});

						// Keep observing in-flight spawns even if Promise.race rejects early
						// on abort/failure so late-returning advisors are stopped and released.
						const lateSpawnCleanup = spawnPromise
							.then((reply) => {
								inFlightSpawns--;
								if (isCancelledOrDone() && reply?.success && reply.data?.id) {
									stopAndReleaseLateSpawn(reply.data.id);
								}
								return reply;
							})
							.catch((err) => {
								inFlightSpawns--;
								throw err;
							});
						lateSpawnCleanup.catch(() => {});

						const spawnReply = await Promise.race([lateSpawnCleanup, cancelPromise]);

						if (!spawnReply?.success || !spawnReply.data?.id) {
							return {
								spec,
								ok: false as const,
								error: spawnReply?.error ?? `Failed to spawn ${spec.agentType}`,
							};
						}

						const agentId = spawnReply.data.id;
						claimAgent(agentId);
						if (isCancelledOrDone() || signal?.aborted) {
							stopAndReleaseLateSpawn(agentId);
							cancel("Council deliberation aborted.");
							throw new Error("Council deliberation aborted.");
						}
						if (!settledAgents.has(agentId)) {
							activeAgentIds.add(agentId);
						}

						return {
							spec,
							ok: true as const,
							agentId,
						};
					}),
				);

				if (cancelled || signal?.aborted) {
					cancel("Council deliberation aborted.");
					throw new Error("Council deliberation aborted.");
				}

				spawned = [];
				launchFailures = [];
				for (const outcome of spawnResults) {
					if (outcome.ok) {
						spawned.push({ spec: outcome.spec, agentId: outcome.agentId });
					} else {
						pushMemberFailure(launchFailures, outcome.spec, 1, outcome.error);
					}
				}

				if (spawned.length < 2) {
					const detail = launchFailures.map((f) => `${f.member} (${f.error})`).join("; ");
					throw new Error(
						`Council deliberation failed: at least 2 members must succeed in Round 1, but only ${spawned.length} succeeded. Failures: ${detail}`,
					);
				}
			} catch (err) {
				cleanup();
				throw err;
			}

			// Launch succeeded: detach from tool call's AbortSignal and hand off to background orchestration.
			signal?.removeEventListener("abort", onLaunchAbort);

			const phaseSettledIds = new Set<string>(
				spawned.filter((s) => settledAgents.has(s.agentId)).map((s) => s.agentId),
			);
			const activeRun: ActiveCouncilRun = {
				councilId,
				topic,
				shortTopic,
				rounds,
				members: memberIds,
				phase: 1,
				completedInPhase: phaseSettledIds.size,
				totalInPhase: spawned.length,
				startedAt: Date.now(),
				cancel,
			};
			registeredInActiveRuns = true;
			activeRuns.set(councilId, activeRun);
			refreshStatus(runStatusSetter);

			const recordPhaseSettle = (agentId: string) => {
				phaseSettledIds.add(agentId);
				activeRun.completedInPhase = phaseSettledIds.size;
				if (!isCancelledOrDone()) refreshStatus();
			};

			const parseSettledOutcome = (
				settled: { event: "completed" | "failed"; data: LifecycleSettlePayload },
				emptyError: string,
			):
				| { ok: true; text: string; durationMs?: number; toolUses?: number }
				| { ok: false; error: string } => {
				const status = settled.data.status;
				const isSuccessStatus =
					settled.event === "completed" &&
					(status === undefined || status === "completed" || status === "steered");
				const text = typeof settled.data.result === "string" ? settled.data.result.trim() : "";

				if (!isSuccessStatus || !text) {
					return {
						ok: false,
						error: settled.data.error ?? (!text ? emptyError : `status ${String(status)}`),
					};
				}

				return {
					ok: true,
					text,
					durationMs: settled.data.durationMs,
					toolUses: settled.data.runToolUses ?? settled.data.toolUses,
				};
			};

			void (async () => {
				const round1: CouncilRound1Entry[] = [];
				const round2: CouncilRound2Entry[] = [];
				const failures: CouncilMemberFailure[] = [...launchFailures];

				const deliverReport = (content: string, details: Record<string, unknown>) => {
					if (cancelled) return;
					try {
						pi.sendMessage?.(
							{
								customType: COUNCIL_REPORT_MESSAGE_TYPE,
								content,
								display: true,
								details,
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					} catch {
						// Ignore stale/disposed session handles if shutdown raced with delivery.
					}
				};

				try {
					const round1Outcomes = await Promise.all(
						spawned.map(async ({ spec, agentId }) => {
							const settled = await waitForAgentSettle(agentId);
							recordPhaseSettle(agentId);

							const parsed = parseSettledOutcome(
								settled,
								`${spec.agentType} returned an empty proposal`,
							);
							if (!parsed.ok) {
								return {
									spec,
									ok: false as const,
									error: parsed.error,
								};
							}

							return {
								spec,
								ok: true as const,
								entry: {
									member: spec.id,
									agentType: spec.agentType,
									model: spec.model,
									label: spec.label,
									agentId,
									proposal: parsed.text,
									durationMs: parsed.durationMs,
									toolUses: parsed.toolUses,
								} satisfies CouncilRound1Entry,
							};
						}),
					);

					if (cancelled) return;

					for (const outcome of round1Outcomes) {
						if (outcome.ok) {
							round1.push(outcome.entry);
						} else {
							pushMemberFailure(failures, outcome.spec, 1, outcome.error);
						}
					}

					if (round1.length < 2) {
						const detail = failures.map((f) => `${f.member} (${f.error})`).join("; ");
						const errorMessage = `Council deliberation failed: at least 2 members must succeed in Round 1, but only ${round1.length} succeeded. Failures: ${detail}`;
						throw new Error(errorMessage);
					}

					if (rounds === 2) {
						inRound2 = true;
						activeRun.phase = 2;
						phaseSettledIds.clear();
						activeRun.completedInPhase = 0;
						activeRun.totalInPhase = round1.length;
						if (!isCancelledOrDone()) refreshStatus();

						const round2Outcomes = await Promise.all(
							round1.map(async (r1Entry, index) => {
								const rotatedPeers = rotatePeersForMember(round1, index);
								const round2Prompt = buildRound2Prompt({
									topic,
									peers: rotatedPeers.map((peer) => ({
										label: peer.label,
										text: peer.proposal,
									})),
								});

								earlySettles.delete(r1Entry.agentId);
								settledAgents.delete(r1Entry.agentId);
								const settlePromise = waitForAgentSettle(r1Entry.agentId);
								// Suppress unhandled rejection if Promise.race rejects or send fails
								settlePromise.catch(() => {});

								let handledLateSend = false;
								const stopAndReleaseLateSend = (reply: RpcReply<{ delivery?: string }> | undefined) => {
									if (handledLateSend) return;
									handledLateSend = true;
									activeAgentIds.delete(r1Entry.agentId);
									pendingWaiters.delete(r1Entry.agentId);
									if (reply?.success) {
										if (!settledAgents.has(r1Entry.agentId)) {
											stopAgent(r1Entry.agentId);
										}
										// Force re-emit release so a newly resumed late Round 2 run
										// is guaranteed to tear down on settle even if cleanup ran first.
										releaseAgent(r1Entry.agentId, true);
									} else {
										releaseAgent(r1Entry.agentId);
									}
								};

								const sendPromise = callRpc<{ delivery?: string }>("send", {
									agentId: r1Entry.agentId,
									text: round2Prompt,
								});
								const lateSendCleanup = sendPromise.then((reply) => {
									if (isCancelledOrDone()) {
										stopAndReleaseLateSend(reply);
									}
									return reply;
								});
								lateSendCleanup.catch(() => {});

								const sendReply = await Promise.race([lateSendCleanup, cancelPromise]);

								if (!sendReply?.success) {
									activeAgentIds.delete(r1Entry.agentId);
									pendingWaiters.delete(r1Entry.agentId);
									recordPhaseSettle(r1Entry.agentId);
									return {
										r1Entry,
										ok: false as const,
										error: sendReply?.error ?? `Failed to resume ${r1Entry.agentType} for Round 2`,
									};
								}

								if (isCancelledOrDone()) {
									stopAndReleaseLateSend(sendReply);
									throw new Error(cancelReason);
								}
								if (!settledAgents.has(r1Entry.agentId)) {
									activeAgentIds.add(r1Entry.agentId);
								}

								const settled = await settlePromise;
								recordPhaseSettle(r1Entry.agentId);

								const parsed = parseSettledOutcome(
									settled,
									`${r1Entry.agentType} returned an empty Round 2 response`,
								);
								if (!parsed.ok) {
									return {
										r1Entry,
										ok: false as const,
										error: parsed.error,
									};
								}

								return {
									r1Entry,
									ok: true as const,
									entry: {
										member: r1Entry.member,
										agentType: r1Entry.agentType,
										model: r1Entry.model,
										label: r1Entry.label,
										agentId: r1Entry.agentId,
										peers: rotatedPeers.map((peer) => ({
											label: peer.label,
											member: peer.member,
											model: peer.model,
										})),
										response: parsed.text,
										durationMs: parsed.durationMs,
										toolUses: parsed.toolUses,
									} satisfies CouncilRound2Entry,
								};
							}),
						);

						if (cancelled) return;

						for (const outcome of round2Outcomes) {
							if (outcome.ok) {
								round2.push(outcome.entry);
							} else {
								pushMemberFailure(failures, outcome.r1Entry, 2, outcome.error);
							}
						}
					}

					const report = formatCouncilReport({
						councilId,
						topic,
						paths,
						rounds,
						members: memberIds,
						round1,
						round2,
						failures,
					});

					cleanup();
					deliverReport(report, {
						councilId,
						status: "completed",
						topic,
						paths,
						rounds,
						members: memberIds,
						round1,
						round2,
						failures,
					});
				} catch (err) {
					cleanup();
					if (!cancelled) {
						const errorMessage = err instanceof Error ? err.message : String(err);
						deliverReport(
							formatCouncilFailure({
								councilId,
								topic,
								paths,
								rounds,
								members: memberIds,
								failures,
								error: errorMessage,
							}),
							{
								councilId,
								status: "failed",
								topic,
								paths,
								rounds,
								members: memberIds,
								round1,
								round2: [],
								failures,
								error: errorMessage,
							},
						);
					}
				} finally {
					cleanup();
				}
			})();

			const spawnedAgentIds = spawned.map((s) => s.agentId);
			const panelText = memberIds.map((id) => COUNCIL_MEMBERS[id].label).join(", ");
			const receiptLines = [
				`Council deliberation started in the background (\`${councilId}\`).`,
				`- **Topic:** ${shortTopic}`,
				`- **Rounds:** ${rounds}`,
				`- **Panel:** ${panelText}`,
				...(launchFailures.length > 0
					? [
							`- **Launch failures:** ${launchFailures.map((f) => `${f.member} (${f.error})`).join("; ")}`,
						]
					: []),
				"",
				"End your turn now and wait for the completion report — it will arrive automatically as a follow-up message. Do not poll, sleep, or call `council` again to wait for it.",
			];

			return {
				content: [{ type: "text", text: receiptLines.join("\n") }],
				details: {
					councilId,
					status: "running" as const,
					topic,
					paths,
					rounds,
					members: memberIds,
					agentIds: spawnedAgentIds,
					...(launchFailures.length > 0 ? { failures: launchFailures } : {}),
				},
			};
		},
	});

	pi.registerCommand("council", {
		description:
			"Convene the 3-model technical council (caspar, melchior, balthasar) asynchronously: /council <topic>, /council status, or /council stop [councilId]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "council", kind: "extension", extension: "council" });
			const trimmed = (args ?? "").trim();
			const lower = trimmed.toLowerCase();
			if (!trimmed || lower === "help") {
				ctx.ui.notify(COUNCIL_USAGE, "info");
				return;
			}

			if (lower === "status") {
				if (activeRuns.size === 0) {
					ctx.ui.notify(COUNCIL_USAGE, "info");
					return;
				}
				const now = Date.now();
				const activeLines = [...activeRuns.values()].map(
					(run) =>
						`  - ${run.councilId}: R${run.phase} (${run.completedInPhase}/${run.totalInPhase}), elapsed ${formatElapsed(now - run.startedAt)}, topic: ${run.shortTopic}`,
				);
				ctx.ui.notify(
					[
						`Active council deliberations (${activeRuns.size}):`,
						...activeLines,
						"Use `/council stop` or `/council stop <councilId>` to cancel.",
						"",
						COUNCIL_USAGE,
					].join("\n"),
					"info",
				);
				return;
			}

			const stopMatch = /^stop(?:\s+(\S+))?$/i.exec(trimmed);
			if (stopMatch) {
				const targetId = stopMatch[1];
				if (targetId) {
					const target = activeRuns.get(targetId);
					if (!target) {
						const activeHint =
							activeRuns.size > 0
								? ` Active: ${[...activeRuns.keys()].join(", ")}.`
								: " No council deliberations are currently active.";
						ctx.ui.notify(`Unknown council ID "${targetId}".${activeHint}`, "warning");
						return;
					}
					target.cancel("Council deliberation stopped by user.");
					ctx.ui.notify(`Stopped council deliberation ${targetId}.`, "info");
					return;
				}
				if (activeRuns.size === 0) {
					ctx.ui.notify("No active council deliberations to stop.", "info");
					return;
				}
				const stoppedIds = cancelAllActiveRuns("Council deliberation stopped by user.");
				ctx.ui.notify(
					`Stopped ${stoppedIds.length} active council deliberation(s): ${stoppedIds.join(", ")}.`,
					"info",
				);
				return;
			}

			const userPrompt = [
				"Convene the technical council on the following topic by calling the `council` tool:",
				"",
				trimmed,
				"",
				"Pass any relevant repository `paths` if identified. Once the `council` tool starts the deliberation in the background, end your turn and wait for the Round 1 and Round 2 report to arrive as a follow-up message; then synthesize the consensus, tradeoffs, and recommended design as a stake-free judge.",
			].join("\n");

			activateCouncilTool();

			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				pi.sendUserMessage(userPrompt, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(userPrompt);
			}
		},
	});
}
