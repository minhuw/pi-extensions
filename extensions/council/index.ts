import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COUNCIL_MEMBER_IDS = ["carbon", "astra", "fable"] as const;
export type CouncilMemberId = (typeof COUNCIL_MEMBER_IDS)[number];

export interface CouncilMemberSpec {
	id: CouncilMemberId;
	agentType: `council-${CouncilMemberId}`;
	model: string;
	thinking: "high" | "xhigh";
	label: string;
}

export const COUNCIL_MEMBERS: Record<CouncilMemberId, CouncilMemberSpec> = {
	carbon: {
		id: "carbon",
		agentType: "council-carbon",
		model: "magpie/gemini-4-carbon",
		thinking: "high",
		label: "Carbon (magpie/gemini-4-carbon)",
	},
	astra: {
		id: "astra",
		agentType: "council-astra",
		model: "magpie/gpt-6-astra",
		thinking: "xhigh",
		label: "Astra (magpie/gpt-6-astra)",
	},
	fable: {
		id: "fable",
		agentType: "council-fable",
		model: "magpie/claude-fable-5-2",
		thinking: "high",
		label: "Fable (magpie/claude-fable-5-2)",
	},
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
		Type.Array(Type.Union([Type.Literal("carbon"), Type.Literal("astra"), Type.Literal("fable")]), {
			minItems: 2,
			maxItems: 3,
			description: "Distinct council members to convene (minimum 2). Defaults to all three: carbon, astra, fable.",
		}),
	),
});

export function resolveCouncilMembers(members?: readonly string[]): CouncilMemberSpec[] {
	const rawList = members === undefined ? [...COUNCIL_MEMBER_IDS] : members;
	if (!Array.isArray(rawList)) {
		throw new Error("Council members must be an array of at least 2 distinct member IDs (carbon, astra, fable).");
	}
	const seen = new Set<CouncilMemberId>();
	const resolved: CouncilMemberSpec[] = [];
	for (const raw of rawList) {
		const id = typeof raw === "string" ? raw.trim() : "";
		if (!Object.prototype.hasOwnProperty.call(COUNCIL_MEMBERS, id)) {
			throw new Error(`Unknown council member "${String(raw)}". Valid members: carbon, astra, fable.`);
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

const IDENTITY_LEAK_PATTERNS: readonly RegExp[] = [
	/\bmagpie\/gemini-4-carbon\b/gi,
	/\bmagpie\/gpt-6-astra\b/gi,
	/\bmagpie\/claude-fable-5-2\b/gi,
	/\bcouncil-carbon\b/gi,
	/\bcouncil-astra\b/gi,
	/\bcouncil-fable\b/gi,
	/\bgemini-4-carbon\b/gi,
	/\bgpt-6-astra\b/gi,
	/\bclaude-fable-5-2\b/gi,
];

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

export function formatCouncilReport(input: CouncilReportInput): string {
	const lines: string[] = [
		"# Council Deliberation Report",
		"",
		`- **Topic:** ${input.topic}`,
		...(input.paths && input.paths.length > 0
			? [`- **Paths:** ${input.paths.map((p) => `\`${p}\``).join(", ")}`]
			: []),
		`- **Rounds:** ${input.rounds}`,
		`- **Panel:** ${input.members.map((id) => COUNCIL_MEMBERS[id].label).join(", ")}`,
	];

	if (input.failures.length > 0) {
		lines.push("", "## Member Failures");
		for (const failure of input.failures) {
			lines.push(
				`- **${COUNCIL_MEMBERS[failure.member].label}** (Round ${failure.round}): ${failure.error}`,
			);
		}
	}

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

export const COUNCIL_USAGE = [
	"Usage: /council <topic or design question>",
	"Pinned council members:",
	`  - carbon: ${COUNCIL_MEMBERS.carbon.agentType} (${COUNCIL_MEMBERS.carbon.model}, thinking: ${COUNCIL_MEMBERS.carbon.thinking})`,
	`  - astra: ${COUNCIL_MEMBERS.astra.agentType} (${COUNCIL_MEMBERS.astra.model}, thinking: ${COUNCIL_MEMBERS.astra.thinking})`,
	`  - fable:  ${COUNCIL_MEMBERS.fable.agentType} (${COUNCIL_MEMBERS.fable.model}, thinking: ${COUNCIL_MEMBERS.fable.thinking})`,
].join("\n");

export default function councilExtension(pi: ExtensionAPI): void {
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
		description:
			"Convene a 3-model read-only technical council (Carbon on magpie/gemini-4-carbon, Astra on magpie/gpt-6-astra, Fable on magpie/claude-fable-5-2) for a 2-round deliberation on difficult architecture, design, or tradeoff questions. Round 1 gathers independent codebase-grounded proposals in parallel; Round 2 resumes each advisor with anonymized, position-swapped peer proposals (Peer A, Peer B) and a verbosity-normalized rubric before returning the full deliberation for stake-free synthesis.",
		promptSnippet:
			"Convene the 3-model read-only technical council (Carbon, Astra, Fable) for 2-round architectural deliberation",
		promptGuidelines: [
			"Use `council` when the user invokes `/council`, asks for the council, or faces a high-stakes architectural or design tradeoff that benefits from multi-model deliberation.",
			"Never pass a `model` override to `council`; council advisors are pinned to their dedicated agent definitions.",
		],
		parameters: CouncilParameters,
		async execute(_toolCallId, params, signal) {
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
			if (!pingReply?.success || typeof pingReply.data?.version !== "number" || pingReply.data.version < 3) {
				const reason = !pingReply?.success
					? pingReply?.error ?? "ping failed"
					: `unsupported protocol version ${String(pingReply.data?.version)}`;
				throw new Error(`Council requires pi-subagents RPC protocol >= 3 (${reason}).`);
			}

			const ownedAgentIds = new Set<string>();
			const activeAgentIds = new Set<string>();
			const pendingWaiters = new Map<string, (outcome: { event: "completed" | "failed"; data: LifecycleSettlePayload }) => void>();
			const earlySettles = new Map<string, { event: "completed" | "failed"; data: LifecycleSettlePayload }>();
			const abortWaiters = new Set<(err: Error) => void>();
			let inFlightSpawns = 0;
			let aborted = false;

			const stopActiveAgents = () => {
				for (const agentId of activeAgentIds) {
					pi.events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId });
				}
				activeAgentIds.clear();
			};

			const onAbort = () => {
				if (aborted) return;
				aborted = true;
				stopActiveAgents();
				const abortError = new Error("Council deliberation aborted.");
				for (const rejectWaiter of abortWaiters) {
					rejectWaiter(abortError);
				}
				abortWaiters.clear();
			};

			signal?.addEventListener("abort", onAbort, { once: true });

			const handleSettle = (event: "completed" | "failed", raw: unknown) => {
				const data = raw as LifecycleSettlePayload | undefined;
				const agentId = data?.id;
				if (!agentId) return;

				const isKnownCouncilAgent =
					ownedAgentIds.has(agentId) ||
					(inFlightSpawns > 0 && typeof data.type === "string" && COUNCIL_AGENT_TYPES.has(data.type));
				if (!isKnownCouncilAgent) return;

				ownedAgentIds.add(agentId);
				activeAgentIds.delete(agentId);

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

			const unsubStarted = pi.events.on("subagents:started", (raw: unknown) => {
				const data = raw as { id?: string; type?: string } | undefined;
				if (
					data?.id &&
					(ownedAgentIds.has(data.id) ||
						(inFlightSpawns > 0 && typeof data.type === "string" && COUNCIL_AGENT_TYPES.has(data.type)))
				) {
					ownedAgentIds.add(data.id);
					if (aborted) {
						pi.events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId: data.id });
					} else {
						activeAgentIds.add(data.id);
					}
				}
			});
			const unsubCompleted = pi.events.on("subagents:completed", (raw: unknown) =>
				handleSettle("completed", raw),
			);
			const unsubFailed = pi.events.on("subagents:failed", (raw: unknown) =>
				handleSettle("failed", raw),
			);

			const waitForAgentSettle = (
				agentId: string,
			): Promise<{ event: "completed" | "failed"; data: LifecycleSettlePayload }> => {
				if (aborted || signal?.aborted) {
					onAbort();
					return Promise.reject(new Error("Council deliberation aborted."));
				}
				const early = earlySettles.get(agentId);
				if (early) {
					earlySettles.delete(agentId);
					return Promise.resolve(early);
				}
				return new Promise((resolve, reject) => {
					const onWaitAbort = (err: Error) => {
						pendingWaiters.delete(agentId);
						abortWaiters.delete(onWaitAbort);
						reject(err);
					};
					abortWaiters.add(onWaitAbort);
					pendingWaiters.set(agentId, (outcome) => {
						abortWaiters.delete(onWaitAbort);
						resolve(outcome);
					});
				});
			};

			try {
				const round1Prompt = buildRound1Prompt({ topic, paths });
				const shortTopic = topic.replace(/\s+/g, " ").slice(0, 60);

				const round1Outcomes = await Promise.all(
					specs.map(async (spec) => {
						inFlightSpawns++;
						let spawnReply: RpcReply<{ id: string }>;
						try {
							spawnReply = await callRpc<{ id: string }>("spawn", {
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
						} finally {
							inFlightSpawns--;
						}

						if (!spawnReply?.success || !spawnReply.data?.id) {
							return {
								spec,
								ok: false as const,
								error: spawnReply?.error ?? `Failed to spawn ${spec.agentType}`,
							};
						}

						const agentId = spawnReply.data.id;
						ownedAgentIds.add(agentId);
						if (!earlySettles.has(agentId)) {
							activeAgentIds.add(agentId);
						}
						if (aborted || signal?.aborted) {
							onAbort();
							throw new Error("Council deliberation aborted.");
						}

						const settled = await waitForAgentSettle(agentId);
						const status = settled.data.status;
						const isSuccessStatus =
							settled.event === "completed" &&
							(status === undefined || status === "completed" || status === "steered");
						const proposal = typeof settled.data.result === "string" ? settled.data.result.trim() : "";

						if (!isSuccessStatus || !proposal) {
							return {
								spec,
								ok: false as const,
								error:
									settled.data.error ??
									(!proposal ? `${spec.agentType} returned an empty proposal` : `status ${String(status)}`),
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
								proposal,
								durationMs: settled.data.durationMs,
								toolUses: settled.data.runToolUses ?? settled.data.toolUses,
							} satisfies CouncilRound1Entry,
						};
					}),
				);

				if (aborted || signal?.aborted) {
					onAbort();
					throw new Error("Council deliberation aborted.");
				}

				const round1: CouncilRound1Entry[] = [];
				const failures: CouncilMemberFailure[] = [];

				for (const outcome of round1Outcomes) {
					if (outcome.ok) {
						round1.push(outcome.entry);
					} else {
						failures.push({
							member: outcome.spec.id,
							agentType: outcome.spec.agentType,
							model: outcome.spec.model,
							round: 1,
							error: outcome.error,
						});
					}
				}

				if (round1.length < 2) {
					const detail = failures.map((f) => `${f.member} (${f.error})`).join("; ");
					throw new Error(
						`Council deliberation failed: at least 2 members must succeed in Round 1, but only ${round1.length} succeeded. Failures: ${detail}`,
					);
				}

				const round2: CouncilRound2Entry[] = [];

				if (rounds === 2) {
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
							activeAgentIds.add(r1Entry.agentId);
							const settlePromise = waitForAgentSettle(r1Entry.agentId);

							const sendReply = await callRpc<{ delivery?: string }>("send", {
								agentId: r1Entry.agentId,
								text: round2Prompt,
							});

							if (!sendReply?.success) {
								activeAgentIds.delete(r1Entry.agentId);
								pendingWaiters.delete(r1Entry.agentId);
								// Suppress unhandled rejection if waitForAgentSettle rejects on abort
								settlePromise.catch(() => {});
								return {
									r1Entry,
									ok: false as const,
									error: sendReply?.error ?? `Failed to resume ${r1Entry.agentType} for Round 2`,
								};
							}

							const settled = await settlePromise;
							const status = settled.data.status;
							const isSuccessStatus =
								settled.event === "completed" &&
								(status === undefined || status === "completed" || status === "steered");
							const response = typeof settled.data.result === "string" ? settled.data.result.trim() : "";

							if (!isSuccessStatus || !response) {
								return {
									r1Entry,
									ok: false as const,
									error:
										settled.data.error ??
										(!response
											? `${r1Entry.agentType} returned an empty Round 2 response`
											: `status ${String(status)}`),
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
									response,
									durationMs: settled.data.durationMs,
									toolUses: settled.data.runToolUses ?? settled.data.toolUses,
								} satisfies CouncilRound2Entry,
							};
						}),
					);

					if (aborted || signal?.aborted) {
						onAbort();
						throw new Error("Council deliberation aborted.");
					}

					for (const outcome of round2Outcomes) {
						if (outcome.ok) {
							round2.push(outcome.entry);
						} else {
							failures.push({
								member: outcome.r1Entry.member,
								agentType: outcome.r1Entry.agentType,
								model: outcome.r1Entry.model,
								round: 2,
								error: outcome.error,
							});
						}
					}
				}

				const memberIds = specs.map((s) => s.id);
				const report = formatCouncilReport({
					topic,
					paths,
					rounds,
					members: memberIds,
					round1,
					round2,
					failures,
				});

				return {
					content: [{ type: "text", text: report }],
					details: {
						topic,
						paths,
						rounds,
						members: memberIds,
						round1,
						round2,
						failures,
					},
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
				unsubStarted?.();
				unsubCompleted?.();
				unsubFailed?.();
			}
		},
	});

	pi.registerCommand("council", {
		description:
			"Convene the 3-model technical council (carbon, astra, fable) for 2-round deliberation: /council <topic or design question>",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const lower = trimmed.toLowerCase();
			if (!trimmed || lower === "help" || lower === "status") {
				ctx.ui.notify(COUNCIL_USAGE, "info");
				return;
			}

			const userPrompt = [
				"Convene the technical council on the following topic by calling the `council` tool:",
				"",
				trimmed,
				"",
				"Pass any relevant repository `paths` if identified. Once the `council` tool returns the Round 1 and Round 2 deliberation report, synthesize the consensus, tradeoffs, and recommended design as a stake-free judge.",
			].join("\n");

			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				pi.sendUserMessage(userPrompt, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(userPrompt);
			}
		},
	});
}
