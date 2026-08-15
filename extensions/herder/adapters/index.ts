import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	attentionCapabilityToken,
	type IntegrationRepairRequest,
	type ManagerAttentionRequest,
	type ManagerReply,
	type ReigniteRequest,
	type TerminalEvent,
	type VerificationManifest,
	type VerificationRequest,
} from "../src/shared/protocol.ts";
import {
	invokeHerderTool,
	prepareHerderVerificationManifest,
	readLiveRunFreshness,
	submitHerderIntegrationRepair,
	submitHerderReignite,
	submitHerderVerification,
	waitHerderOperation,
} from "../src/application/tools.ts";
import {
	parseAttachArguments,
	parseCleanupArguments,
	parseFireArguments,
	parseGrillPlanTarget,
	parsePlanDirArguments,
	parseResetArguments,
	type AttachOptions,
	type FireOptions,
} from "./arguments.ts";
import { assertActiveFireGrillTarget, noDeterministicRunMessage } from "./run-guidance.ts";
import { runCleanupCommand } from "./cleanup-command.ts";
import { runResetCommand } from "./reset-command.ts";
import { HERDER_CLEANUP_ENTRY, registerCleanupTranscriptRenderer } from "./cleanup-transcript.ts";
import {
	activeModelMatches,
	loadPiProfile,
	unavailableProfileModels,
	type ResolvedPiProfile,
} from "./profile.ts";
import { HERDER_ATTENTION_MESSAGE, attentionMessageDetails, buildAttentionPrompt } from "./attention.ts";
import { HERDER_STATE_ENTRY, restoreLastRun, sameHerderRunState, type HerderRunState } from "./state.ts";
import { resolvePlanDirectory, resolvePlanDirectoryTarget } from "./paths.ts";
import { registerPiPlanningWorkflows } from "./planning-workflows.ts";
import { validateHerderRoleAgents } from "./role-config.ts";
import { interruptedPiWorkers } from "./recovery.ts";
import {
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
	bindAdapterOwnershipRun,
	registerAdapterOwnershipRetirement,
	releaseAdapterOwnership,
	waitForAdapterOwnershipRetirement,
	type AdapterOwnership,
} from "./ownership.ts";
import { DefaultPiWorkerSessionFactory, PiWorkerEngine, type PiWorkerSessionFactory, type PiWorkerTerminal } from "./worker-engine.ts";
import { HerderWidget } from "./worker-fleet.ts";
import { orcaBusy } from "../../shared/orca-busy.ts";
import {
	createWorkerInputEntry,
	createWorkerOutputEntry,
	HERDER_WORKER_INPUT_ENTRY,
	HERDER_WORKER_OUTPUT_ENTRY,
	registerWorkerTranscriptRenderers,
	type HerderWorkerInputEntry,
} from "./worker-transcript.ts";

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_ROOT, "..");
const PROFILE_CATALOG = path.join(PACKAGE_ROOT, "assets/profiles/profiles.json");
const PI_AGENT_ROOT = path.join(PACKAGE_ROOT, "assets/roles/pi");
interface PlanSummary {
	counts?: { total?: number; done?: number; rejected?: number; actionable?: number };
	inProgress?: number;
	blocked?: number;
}

interface WorkerBinding {
	actionId: string;
	handle: string;
	managerRunId: string;
	planDir: string;
	sessionEpoch: number;
	transcript?: HerderWorkerInputEntry;
}

interface IntegrationRepairBinding {
	request: IntegrationRepairRequest;
	planDirectory: string;
	sessionEpoch: number;
	verification?: VerificationRequest;
}

interface PendingVerificationFailure {
	key: string;
	runId: string;
	planDirectory: string;
	detail: string;
	sessionId?: string;
	repair?: IntegrationRepairRequest;
}

type HerderPiWorkerFactory = PiWorkerSessionFactory & {
	bindModelRegistry?: (registry: ModelRegistry) => void;
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameResolvedDirectory(left: string, right: string | undefined): boolean {
	if (!right) return false;
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	if (resolvedLeft === resolvedRight) return true;
	try {
		return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
	} catch {
		return false;
	}
}

function optionalResolvedPlanDirectory(repoRoot: string, input: string | undefined): string | undefined {
	if (!input) return undefined;
	try {
		return resolvePlanDirectory(repoRoot, input);
	} catch {
		return undefined;
	}
}

function rejectLegacyIntegrationRepairCommitMessage(value: unknown): void {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "commitMessage")) {
		throw new Error("Integration repair commitMessage is not accepted; the owning session must author the commit");
	}
}

function activeModelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function summaryLine(summary: PlanSummary | undefined): string | undefined {
	if (!summary?.counts || typeof summary.counts.total !== "number") return undefined;
	return `${summary.counts.done ?? 0}/${summary.counts.total} done · ${summary.inProgress ?? 0} in progress · ${summary.counts.rejected ?? 0} rejected`;
}

function unwrapReply(value: Record<string, unknown>): ManagerReply {
	const reply = value.reply;
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Herder service returned no manager reply.");
	return reply as unknown as ManagerReply;
}

export default function registerHerderPi(pi: ExtensionAPI): void {
	const sessionFactory = new DefaultPiWorkerSessionFactory(PI_AGENT_ROOT);
	registerHerderPiWithWorkerFactory(pi, sessionFactory);
}

export function registerHerderPiWithWorkerFactory(pi: ExtensionAPI, sessionFactory: HerderPiWorkerFactory): void {
	registerWorkerTranscriptRenderers(pi);
	registerCleanupTranscriptRenderer(pi);
	const engine = new PiWorkerEngine(sessionFactory);
	const widget = new HerderWidget();
	const workers = new Map<string, WorkerBinding>();
	let currentState: HerderRunState | undefined;
	let lastPersistedState: HerderRunState | undefined;
	let lastContext: ExtensionContext | undefined;
	let lastSummary: PlanSummary | undefined;
	let lastManagerMessage: string | undefined;
	let currentAttention: ManagerAttentionRequest | undefined;
	let attentionHint: string | undefined;
	let attentionDrain = Promise.resolve();
	const deferredAttention = new Set<string>();
	let managerQueue = Promise.resolve();
	let admittedManagerTasks = 0;
	let releaseOwnershipAfterManagerDrain = false;
	let sessionEpoch = 0;
	let shuttingDown = false;
	let ownership: AdapterOwnership | undefined;
	let ownershipEpoch = 0;
	const fallbackPiSessionId = `fallback-${randomUUID()}`;
	const verificationRequests = new Map<string, VerificationRequest>();
	const promptedVerifications = new Set<string>();
	const integrationRepairRequests = new Map<string, IntegrationRepairBinding>();
	const reigniteRequests = new Map<string, ReigniteRequest>();
	const promptedReignites = new Set<string>();
	const verificationMonitors = new Map<string, number>();
	const notifiedVerificationFailures = new Set<string>();
	const deliveredVerificationFailureFollowUps = new Set<string>();
	let pendingVerificationFailure: PendingVerificationFailure | undefined;
	let sendingVerificationFailure = false;

	const persist = (state: HerderRunState) => {
		currentState = state;
		if (lastPersistedState && sameHerderRunState(lastPersistedState, state)) return;
		try {
			pi.appendEntry(HERDER_STATE_ENTRY, state);
			lastPersistedState = state;
		} catch { /* The durable manager remains authoritative; retry on the next reply. */ }
	};

	const appendWorkerEntry = <T>(customType: string, data: T): void => {
		if (!lastContext) return;
		try { pi.appendEntry(customType, data); }
		catch { /* Transcript rendering is best-effort and must never block manager progress. */ }
	};

	const render = (ctx = lastContext) => {
		if (!ctx?.hasUI) return;
		if (!currentState) {
			ctx.ui.setStatus("herder", undefined);
			widget.update(ctx, undefined);
			orcaBusy.set("herder", false, ctx);
			return;
		}
		const statusColor = currentState.status === "complete"
			? "success"
			: currentState.status === "failed"
				? "error"
				: ["needs_input", "paused"].includes(currentState.status)
					? "warning"
					: "accent";
		ctx.ui.setStatus("herder", ctx.ui.theme.fg(statusColor, `Herder ${currentState.status}`));
		const summary = summaryLine(lastSummary);
		widget.update(ctx, {
			status: currentState.status,
			profile: currentState.profile,
			maxParallel: currentState.maxParallel,
			planName: path.basename(currentState.planDir),
			...(summary ? { summaryLine: summary } : {}),
			...(currentState.dashboardUrl ? { dashboardUrl: currentState.dashboardUrl } : {}),
			...(lastManagerMessage ? { idleDetail: lastManagerMessage } : {}),
			workers: engine.snapshots(),
		});
		orcaBusy.set("herder", !["complete", "failed", "stopped"].includes(currentState.status), ctx);
	};

	const renderLaunching = (ctx: ExtensionContext, planDir: string, profile: string, maxParallel: number) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("herder", ctx.ui.theme.fg("accent", "Herder initializing"));
		widget.update(ctx, {
			status: "initializing",
			profile,
			maxParallel,
			planName: path.basename(planDir),
			workers: [],
		});
		orcaBusy.set("herder", true, ctx);
	};

	const repositoryRoot = async (ctx: ExtensionContext): Promise<string> => {
		const result = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
		if (result.code !== 0 || !result.stdout.trim()) throw new Error("Herder requires a Git worktree.");
		return path.resolve(result.stdout.trim());
	};

	const piSessionId = (ctx: ExtensionContext): string => {
		try {
			const getter = (ctx.sessionManager as { getSessionId?: () => unknown }).getSessionId;
			const value = typeof getter === "function" ? getter.call(ctx.sessionManager) : undefined;
			if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
		} catch {}
		return fallbackPiSessionId;
	};

	const ownsRun = (planDir: string, runId: string): boolean => Boolean(
		ownership
		&& ownership.lockPath === adapterOwnershipLockPath(planDir)
		&& ownership.record.runId === runId,
	);

	const claimOwnership = async (planDir: string, runId: string, ctx: ExtensionContext, epoch: number): Promise<AdapterOwnership | undefined> => {
		assertSessionActive(epoch);
		if (ownership) {
			if (ownsRun(planDir, runId)) {
				const inherited = ownershipEpoch !== epoch;
				ownershipEpoch = epoch;
				releaseOwnershipAfterManagerDrain = false;
				return inherited ? ownership : undefined;
			}
			throw new Error(`This Pi session already owns Herder run ${ownership.record.runId}; stop it before controlling ${runId}.`);
		}
		await waitForAdapterOwnershipRetirement(planDir);
		assertSessionActive(epoch);
		ownership = acquireAdapterOwnership(planDir, runId, piSessionId(ctx));
		ownershipEpoch = epoch;
		releaseOwnershipAfterManagerDrain = false;
		return ownership;
	};

	const assertOwnership = (planDir: string, runId: string): void => {
		if (!ownsRun(planDir, runId)) {
			throw new Error(`This Pi session does not own Herder run ${runId}; attach or resume it before making changes.`);
		}
	};

	const releaseOwnership = (): void => {
		if (!ownership) return;
		const held = ownership;
		ownership = undefined;
		ownershipEpoch = 0;
		releaseAdapterOwnership(held);
	};

	const clearCurrentStateForPlanDirectory = async (planDir: string, ctx: ExtensionContext): Promise<void> => {
		if (!currentState || path.resolve(currentState.planDir) !== path.resolve(planDir)) return;
		sessionEpoch += 1;
		const activeWorkers = [...workers.values()];
		workers.clear();
		await Promise.all(activeWorkers.map((worker) => engine.stop(worker.handle).catch(() => {})));
		currentState = undefined;
		currentAttention = undefined;
		attentionHint = undefined;
		deferredAttention.clear();
		lastSummary = undefined;
		lastManagerMessage = undefined;
		pendingVerificationFailure = undefined;
		verificationRequests.clear();
		promptedVerifications.clear();
		integrationRepairRequests.clear();
		reigniteRequests.clear();
		promptedReignites.clear();
		verificationMonitors.clear();
		notifiedVerificationFailures.clear();
		deliveredVerificationFailureFollowUps.clear();
		releaseOwnership();
		render(ctx);
	};

	const releaseNewOwnership = (acquired: AdapterOwnership | undefined, epoch: number): void => {
		if (acquired && ownership === acquired && epoch === sessionEpoch) releaseOwnership();
	};

	const sessionActive = (epoch: number): boolean => epoch === sessionEpoch && !shuttingDown;

	const assertSessionActive = (epoch: number): void => {
		if (!sessionActive(epoch)) throw new Error("Herder operation was cancelled because the Pi session changed or shut down.");
	};

	const resolveProfile = async (ctx: ExtensionContext, requested?: string): Promise<ResolvedPiProfile> => {
		const profile = await loadPiProfile(PROFILE_CATALOG, requested);
		const unavailable = unavailableProfileModels(profile, ctx.modelRegistry.getAvailable());
		if (unavailable.length) throw new Error(`Profile ${profile.profile} cannot start because Pi has no available model matching: ${unavailable.join(", ")}.`);
		if (!activeModelMatches(profile, ctx.model) || ctx.thinkingLevel !== profile.orchestrator.effort) {
			throw new Error(`Profile ${profile.profile} requires root ${profile.orchestrator.model}:${profile.orchestrator.effort}; current Pi model is ${activeModelLabel(ctx)}:${ctx.thinkingLevel || "unknown"}.`);
		}
		return profile;
	};

	const preflight = async (_ctx: ExtensionContext, profile: ResolvedPiProfile) => {
		sessionFactory.bindModelRegistry?.(_ctx.modelRegistry);
		await validateHerderRoleAgents(PI_AGENT_ROOT, profile, await engine.availableModels());
	};

	const bindIntegrationRepair = (reply: ManagerReply): IntegrationRepairBinding | undefined => {
		const request = reply.integrationRepair;
		if (!request || !ownsRun(reply.planDirectory, reply.runId)) return undefined;
		const binding: IntegrationRepairBinding = {
			request,
			planDirectory: reply.planDirectory,
			sessionEpoch,
			verification: verificationRequests.get(request.requestId),
		};
		integrationRepairRequests.set(request.requestId, binding);
		return binding;
	};

	const mergeDurableIntegrationRepair = (
		binding: IntegrationRepairBinding,
		durable: IntegrationRepairRequest,
	): IntegrationRepairBinding => ({
		...binding,
		request: {
			...binding.request,
			repairId: durable.repairId ?? binding.request.repairId,
			episodeId: durable.episodeId ?? binding.request.episodeId,
			state: durable.state,
			classification: durable.episodeId && durable.episodeId !== binding.request.episodeId
				? durable.classification
				: durable.classification ?? binding.request.classification,
			episodeState: durable.episodeId && durable.episodeId !== binding.request.episodeId
				? durable.episodeState
				: durable.episodeState ?? binding.request.episodeState,
			episodeRequestSha256: durable.episodeRequestSha256 ?? binding.request.episodeRequestSha256,
			episodeIntegrationHead: durable.episodeIntegrationHead ?? binding.request.episodeIntegrationHead,
			episodeIntegrationTree: durable.episodeIntegrationTree ?? binding.request.episodeIntegrationTree,
			episodeCanonicalGatesSha256: durable.episodeCanonicalGatesSha256 ?? binding.request.episodeCanonicalGatesSha256,
			round: durable.round,
			maxRounds: durable.maxRounds,
			acceptedCodeRounds: durable.acceptedCodeRounds ?? binding.request.acceptedCodeRounds,
			transientRetryUsed: durable.transientRetryUsed ?? binding.request.transientRetryUsed,
			ownerSessionId: durable.ownerSessionId ?? binding.request.ownerSessionId,
			integrationBranch: durable.integrationBranch || binding.request.integrationBranch,
			integrationWorktree: durable.integrationWorktree || binding.request.integrationWorktree,
			parentCommit: durable.parentCommit,
			currentCommit: durable.currentCommit,
			currentTree: durable.currentTree,
			failedGates: durable.failedGates,
			canonicalGates: durable.canonicalGates,
			successorRequestId: durable.successorRequestId,
			successorRequestSha256: durable.successorRequestSha256,
			supersededCommits: durable.supersededCommits,
			detail: durable.detail,
		},
	});

	const delegateVerification = (reply: ManagerReply, retryDetail?: string) => {
		if (shuttingDown || !ownsRun(reply.planDirectory, reply.runId)) return;
		const request = reply.verificationRequest;
		if (!request) return;
		verificationRequests.set(request.requestId, request);
		if ((reply.operations ?? []).some((operation) => operation.kind === "verification" && operation.operationId.startsWith(`verification:${request.requestId}:`))) return;
		if (promptedVerifications.has(request.requestId) || !lastContext) return;
		promptedVerifications.add(request.requestId);
		const repairVerification = Boolean(request.repairId);
		const prompt = [
			repairVerification ? "HERDER_MAIN_SESSION_VERIFICATION_REPAIR_V1" : "HERDER_MAIN_SESSION_VERIFICATION_V1",
			...(repairVerification ? ["HERDER_MAIN_SESSION_VERIFICATION_V1"] : []),
			repairVerification
				? "Herder accepted the bounded integration repair and needs a fresh authoritative verification selection for the repaired frozen tree."
				: "Herder has finished integrating the ordinary plans and needs this main Pi session to select final verification semantically.",
			"Inspect the exact frozen integration worktree and assignment below. You may use read-only inspection commands, but do not edit files, move Git refs, update Herder state, or execute the verification commands yourself.",
			...(repairVerification ? [
				"Retain the inherited ordered gate prefix exactly. Add a gate only when it directly covers a newly touched path, and explain every addition. This selection is still authoritative Herder verification, not a local diagnostic.",
			] : []),
			"Choose the smallest non-redundant set of commands that adequately verifies the integrated change. Distinguish setup/examples from actual checks; prefer one comprehensive check over duplicated focused checks when it subsumes them.",
			"Represent every command as direct argv. Every argv element must be one non-empty line: never put literal newlines inside a shell script argument. Use [\"/bin/sh\", \"-lc\", \"single-line script\"] only when shell syntax is genuinely required; join multiple shell statements with && or semicolons.",
			"PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot for inspection only. Each gate cwd is TreeRelative: use '.' for the worktree root or a relative path such as 'pkg'. Absolute paths in cwd are invalid; never copy INTEGRATION_WORKTREE into cwd.",
			'EXAMPLE_GATE: {"gateId":"unit","label":"unit tests","cwd":".","argv":["npm","test"],"rationale":"Covers the integrated change."}',
			...(retryDetail ? [`PREVIOUS_MANIFEST_ERROR: ${retryDetail.replace(/\s+/g, " ").slice(0, 1_000)}`, "Correct the rejected manifest and submit it again."] : []),
			"As your final action, call herder_verification exactly once. Do not provide a prose-only answer.",
			`REQUEST_ID: ${request.requestId}`,
			`REQUEST_SHA256: ${request.requestSha256}`,
			`RUN_ID: ${request.runId}`,
			`PLAN_DIRECTORY: ${reply.planDirectory}`,
			`GENERATION: ${request.generation}`,
			`GRAPH_SHA256: ${request.graphSha256}`,
			`RUN_ASSIGNMENT: ${request.runAssignmentPath}`,
			`RUN_ASSIGNMENT_SHA256: ${request.runAssignmentSha256}`,
			`INTEGRATION_WORKTREE: ${request.integrationWorktree}`,
			`INTEGRATION_BRANCH: ${request.integrationBranch}`,
			`INTEGRATION_HEAD: ${request.integrationHead}`,
			`INTEGRATION_TREE: ${request.integrationTree}`,
			...(request.predecessorRequestId ? [`PREDECESSOR_REQUEST_ID: ${request.predecessorRequestId}`] : []),
			...(request.repairId ? [`REPAIR_ID: ${request.repairId}`, `REPAIR_ROUND: ${request.repairRound ?? 1}`] : []),
		].join("\n");
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			promptedVerifications.delete(request.requestId);
			lastContext.ui.notify(`Herder could not delegate final verification: ${message(error)}`, "warning");
		}
	};

	const pendingStatusChangingOperations = (reply: ManagerReply, requestId: string): boolean =>
		(reply.operations ?? []).some((operation) => {
			if (!["accepted", "running"].includes(operation.state)) return false;
			if (operation.kind === "reignite" && operation.operationId.startsWith(`reignite:${requestId}:`)) return false;
			return true;
		});

	const delegateReignite = (reply: ManagerReply) => {
		if (shuttingDown || !ownsRun(reply.planDirectory, reply.runId) || reply.status !== "complete") return;
		const request = reply.reigniteRequest;
		if (!request || request.state !== "pending") return;
		if (pendingStatusChangingOperations(reply, request.requestId)) return;
		const live = readLiveRunFreshness(reply.planDirectory);
		if (!live || live.runId !== reply.runId || live.status !== "complete") return;
		if (live.pendingOperations > 0) return;
		reigniteRequests.set(request.requestId, request);
		if ((reply.operations ?? []).some((operation) => operation.kind === "reignite" && operation.operationId.startsWith(`reignite:${request.requestId}:`))) return;
		if (promptedReignites.has(request.requestId) || !lastContext) return;
		promptedReignites.add(request.requestId);
		const findings = request.findings.length > 0 ? request.findings.map((finding) => `- ${finding}`).join("\n") : "none";
		const guidance = request.fixGuidance.length > 0 ? request.fixGuidance.map((item) => `- ${item}`).join("\n") : "none";
		const prompt = [
			"HERDER_MAIN_SESSION_REIGNITE_V1",
			"The original Herder run is complete. Residual PLAN_REQUIREMENT and PATCH_REGRESSION findings must become a new fireable sibling plan directory in one shot.",
			"Write only in the allocated directory. Do not edit the source plan tree, the frozen integration worktree, or manager SQLite. Do not call /herder-fire.",
			"Use herder_plan init with local tracking, write the plan files, then shape and validate. Each PLAN_REQUIREMENT or PATCH_REGRESSION finding becomes TODO or BLOCKED. FOLLOWUP and INVALID findings may go in leak/ only.",
			"As your final action, call herder_reignite exactly once with written or failed. Pass SOURCE_PLAN_DIRECTORY as planDirectory; the allocated sibling is also accepted. Acknowledgement always targets the source run. For written, pass the graphSha256 returned by herder_plan validate of the allocated directory; do not reuse GRAPH_SHA256 from this prompt.",
			`REQUEST_ID: ${request.requestId}`,
			`REQUEST_SHA256: ${request.requestSha256}`,
			`RUN_ID: ${request.runId}`,
			`SOURCE_PLAN_DIRECTORY: ${request.sourcePlanDirectory}`,
			`ALLOCATED_PLAN_DIRECTORY: ${request.allocatedPlanDirectory ?? "unallocated"}`,
			`GENERATION: ${request.generation}`,
			`GRAPH_SHA256: ${request.graphSha256}`,
			`INTEGRATION_BRANCH: ${request.integrationBranch}`,
			`INTEGRATION_HEAD: ${request.integrationHead}`,
			`INTEGRATION_TREE: ${request.integrationTree}`,
			`VERDICT: ${request.verdict}`,
			`SCOPE: ${request.scope}`,
			"FINDINGS:",
			findings,
			"FIX_GUIDANCE:",
			guidance,
			...(request.detail ? [`PREVIOUS_WRITE_ERROR: ${request.detail.replace(/\s+/g, " ").slice(0, 1_000)}`] : []),
		].join("\n");
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			promptedReignites.delete(request.requestId);
			lastContext.ui.notify(`Herder could not delegate the reignite write: ${message(error)}`, "warning");
		}
	};

	const drainAttention = async (): Promise<void> => {
		if (shuttingDown || !lastContext || !currentAttention || !currentState) return;
		const request = currentAttention;
		if (request.state === "resolved" || deferredAttention.has(request.requestId) || attentionHint === request.requestId) return;
		const requestId = request.requestId;
		const epoch = sessionEpoch;
		try {
			const prompt = await buildAttentionPrompt(PACKAGE_ROOT, currentState.planDir, request);
			if (!sessionActive(epoch) || !lastContext || !currentAttention || currentAttention.requestId !== requestId) return;
			pi.sendMessage({
				customType: HERDER_ATTENTION_MESSAGE,
				content: prompt,
				display: true,
				details: attentionMessageDetails(request),
			}, { deliverAs: "followUp", triggerTurn: true });
			// A successful injection is the only acknowledgement held by the adapter.
			// SQLite remains authoritative, so a replacement session can re-expose the
			// request when this hint was not persisted before shutdown.
			attentionHint = requestId;
			persist({ ...currentState, attentionRequestId: requestId, updatedAt: Date.now() });
		} catch (error) {
			lastContext?.ui.notify(`Herder could not delegate attention request ${requestId}: ${message(error)}`, "warning");
		}
	};

	const requestAttentionDrain = (): Promise<void> => {
		const next = attentionDrain.then(drainAttention, drainAttention);
		attentionDrain = next.then(() => undefined, () => undefined);
		return next;
	};

	const drainVerificationFailure = (): void => {
		if (shuttingDown || sendingVerificationFailure || !lastContext || !pendingVerificationFailure) return;
		const failure = pendingVerificationFailure;
		const deliveryKey = `${sessionEpoch}:${failure.key}`;
		if (deliveredVerificationFailureFollowUps.has(deliveryKey)) {
			pendingVerificationFailure = undefined;
			return;
		}
		const repair = failure.repair;
		const currentMainSessionId = lastContext ? piSessionId(lastContext) : "";
		const strandedRepair = Boolean(repair && ["active", "committing", "committed", "interrupted"].includes(repair.state));
		const ownerMismatch = Boolean(repair && (
			(repair.ownerSessionId && repair.ownerSessionId !== currentMainSessionId)
			|| (strandedRepair && !repair.ownerSessionId)
		));
		const ambiguityDecision = Boolean(repair && ["design_ambiguity", "scope_ambiguity", "credential", "product_ambiguity"].includes(repair.classification || ""));
		const roundLimitReached = Boolean(repair && (
			(repair.classification === "code_defect" && (repair.acceptedCodeRounds ?? repair.round) >= repair.maxRounds)
			|| (repair.classification === "transient" && repair.transientRetryUsed && ["available", "failed"].includes(repair.state))
		));
		const logPath = failure.detail.match(/\(log ([^)]+)\)/)?.[1] || "the verification failure detail";
		const verification = repair ? verificationRequests.get(repair.requestId) : undefined;
		const integrationWorktree = repair?.integrationWorktree || verification?.integrationWorktree || "unavailable: manager did not provide the recorded integration worktree";
		const integrationBranch = repair?.integrationBranch || verification?.integrationBranch || "unavailable: manager did not provide the recorded integration branch";
		const integrationHead = repair ? repair.currentCommit || repair.parentCommit : "unknown";
		const integrationTree = repair?.currentTree || verification?.integrationTree || "unknown";
		const gateJson = (repair?.canonicalGates || repair?.failedGates || []).map((gate) => JSON.stringify(gate)).join("\n");
		const prompt = ownerMismatch
			? [
				"HERDER_MAIN_SESSION_VERIFICATION_REPAIR_OWNER_V1",
				"The recorded integration-repair capability belongs to a different main Pi session and cannot be used by this session.",
				`RUN_ID: ${failure.runId}`,
				`OWNER_SESSION_ID: ${repair!.ownerSessionId}`,
				`CURRENT_MAIN_SESSION_ID: ${currentMainSessionId}`,
				`REQUEST_ID: ${repair!.requestId}`,
				`REPAIR_ID: ${repair!.repairId || "unknown"}`,
				...(repair!.episodeId ? [`EPISODE_ID: ${repair!.episodeId}`, `EPISODE_STATE: ${repair!.episodeState || "unclassified"}`] : []),
				`REPAIR_STATE: ${repair!.state}`,
				`FAILURE_DETAIL: ${failure.detail}`,
				`LOG_PATH: ${logPath}`,
				"Do not call herder_integration_repair, edit the integration worktree, or claim recovery. Ask the user to recover the former session or choose an explicit operator/corrective-plan path.",
			].join("\n")
			: roundLimitReached || ambiguityDecision
			? [
				"HERDER_MAIN_SESSION_VERIFICATION_REPAIR_DECISION_V1",
				ambiguityDecision
					? `The authoritative failure is durably classified as ${repair!.classification}. No writable repair capability was opened; an explicit user decision is required.`
					: "The bounded automatic verification-recovery allowance has been exhausted. Herder has paused the run for an explicit user decision and will not open another automatic capability for this failure.",
				`RUN_ID: ${failure.runId}`,
				`REQUEST_ID: ${repair!.requestId}`,
				`REPAIR_ID: ${repair!.repairId || "unknown"}`,
				...(repair!.episodeId ? [`EPISODE_ID: ${repair!.episodeId}`, `EPISODE_STATE: ${repair!.episodeState || "unclassified"}`] : []),
				`REPAIR_ROUND: ${repair!.round}`,
				`CODE_REPAIR_ROUNDS: ${repair!.acceptedCodeRounds ?? repair!.round}/${repair!.maxRounds}`,
				`MAX_ROUNDS: ${repair!.maxRounds}`,
				`FAILURE_DETAIL: ${failure.detail}`,
				`LOG_PATH: ${logPath}`,
				"Read the recorded log and ask the user whether to stop, defer, or continue through an explicitly revised/corrective plan. Do not call herder_integration_repair begin again, do not claim success, and do not execute Herder verification commands yourself.",
				"/herder-resume remains operator recovery for a durable paused run; ordinary deterministic defects no longer require graph revision before the bounded rounds are exhausted, but this exhausted state requires the user's choice.",
			].join("\n")
			: repair
				? [
					"HERDER_MAIN_SESSION_VERIFICATION_RECOVERY_V1",
					"HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1",
					"Herder authoritative final verification failed and has issued one request-bound recovery capability to the owning main Pi session.",
					"Use read-only inspection commands to read the exact failure log, explain the concrete failure to the user, then classify exactly one recovery path. Do not claim success, silently retry, or execute Herder's authoritative verification commands yourself.",
					`RUN_ID: ${failure.runId}`,
					`MAIN_SESSION_ID: ${failure.sessionId || "unknown"}`,
					`OWNER_SESSION_ID: ${repair.ownerSessionId || failure.sessionId || "unknown"}`,
					`ADAPTER_EPOCH: ${sessionEpoch}`,
					`REQUEST_ID: ${repair.requestId}`,
					`REQUEST_SHA256: ${repair.requestSha256}`,
					...(repair.episodeId ? [
						`EPISODE_ID: ${repair.episodeId}`,
						`EPISODE_REQUEST_SHA256: ${repair.episodeRequestSha256 || repair.requestSha256}`,
						`EPISODE_INTEGRATION_HEAD: ${repair.episodeIntegrationHead || integrationHead}`,
						`EPISODE_INTEGRATION_TREE: ${repair.episodeIntegrationTree || integrationTree}`,
						`EPISODE_CANONICAL_GATES_SHA256: ${repair.episodeCanonicalGatesSha256 || "unknown"}`,
					] : []),
					`CAPABILITY_TOKEN: ${repair.capabilityToken}`,
					`GENERATION: ${repair.generation}`,
					`REPAIR_ID: ${repair.repairId || "none"}`,
					...(repair.episodeId ? [`EPISODE_ID: ${repair.episodeId}`, `EPISODE_STATE: ${repair.episodeState || "unclassified"}`] : []),
					`REPAIR_ROUND: ${repair.round}`,
					`CODE_REPAIR_ROUNDS: ${repair.acceptedCodeRounds ?? repair.round}/${repair.maxRounds}`,
					`TRANSIENT_RETRY_USED: ${repair.transientRetryUsed ? "yes" : "no"}`,
					`MAX_ROUNDS: ${repair.maxRounds}`,
					`REPAIR_STATE: ${repair.state}`,
					`PARENT_COMMIT: ${repair.parentCommit}`,
					`FAILED_HEAD: ${repair.parentCommit}`,
					`CURRENT_COMMIT: ${repair.currentCommit || repair.parentCommit}`,
					`CURRENT_TREE: ${integrationTree}`,
					`FAILED_TREE: ${integrationTree}`,
					`INTEGRATION_WORKTREE: ${integrationWorktree}`,
					`INTEGRATION_BRANCH: ${integrationBranch}`,
					`INTEGRATION_HEAD: ${integrationHead}`,
					`FAILURE_DETAIL: ${failure.detail}`,
					`LOG_PATH: ${logPath}`,
					"CLASSIFICATIONS: manifest_error | transient | code_defect | design_ambiguity | scope_ambiguity | credential | product_ambiguity",
					...(repair.episodeId ? [
						`CLASSIFICATION_EPISODE: ${repair.episodeId}`,
						"A classification is immutable only inside this episode. Every newly failed successor opens a fresh unclassified episode; classify the current evidence and do not carry forward a prior episode's classification.",
					] : []),
					...(repair.transientRetryUsed ? ["TRANSIENT_BUDGET: The unchanged transient retry for this exact head/tree/gate program is already consumed; select a different evidence-supported path."] : []),
					"For manifest_error, call herder_integration_repair begin once, then finish with a corrected complete gate array; do not edit the integration worktree.",
					"For transient, call begin once, then finish once with the inherited gates unchanged; this is the one unchanged retry and must not edit the integration worktree.",
					"For code_defect, call begin once before editing. Only after begin may you edit failure-related paths in INTEGRATION_WORKTREE and run optional local diagnostics. Then stage the allowed changes, create the next bounded code-repair commit or amend the existing repair commit while retaining the fixed parent, confirm git status is clean, and pass allowedPaths plus observedCommit from git rev-parse HEAD. The owning session authors the commit; Herder only validates it and reruns the authoritative gates. Local tests are optional and non-authoritative; do not run the final Herder gates directly.",
					"For design_ambiguity, scope_ambiguity, credential, or product_ambiguity, call herder_integration_repair exactly once with operation begin, the selected classification, and a concrete rationale or detail. This records a non-mutating user-decision outcome; it does not open edit authority. A corrective plan followed by /herder-revise remains available when the user chooses it.",
					"Before begin, do not edit the frozen integration worktree, move Git refs, update SQLite, or mutate manager state. If a started code repair cannot be completed safely, restore the assigned worktree to its recorded clean head and call cancel.",
					"Do not edit the frozen integration worktree before the begin transition binds writable authority to this main session.",
					"Before finish, stage and create or amend the session-authored repair commit in the assigned worktree, confirm git status --porcelain is empty, and pass observedCommit equal to git rev-parse HEAD. Herder never stages, creates, or amends commits; it validates the clean commit and reruns the retained authoritative gates, then either proceeds to the existing final audit or presents the next bounded recovery request. /herder-resume remains operator recovery, not the ordinary path.",
					"FAILED_OR_INHERITED_GATES:",
					gateJson || "none",
				].join("\n")
				: [
					"HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1",
					"Herder final verification failed in the active main Pi session.",
					`RUN_ID: ${failure.runId}`,
					`MAIN_SESSION_ID: ${failure.sessionId || "unknown"}`,
					`FAILURE_DETAIL: ${failure.detail}`,
					`LOG_PATH: ${logPath}`,
					"Inspect the log using read-only commands and explain the concrete failure to the user. Do not claim success, silently retry, or execute verification commands yourself.",
					"Use /herder-resume for a fresh verification request after correcting a manifest or transient operational failure; for an integrated code defect, propose a corrective plan followed by /herder-revise.",
					"Do not edit the frozen integration worktree, move Git refs, or mutate manager state.",
				].join("\n");
		sendingVerificationFailure = true;
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			deliveredVerificationFailureFollowUps.add(deliveryKey);
			pendingVerificationFailure = undefined;
		} catch (error) {
			// Keep the pending failure so agent_settled or the next durable status
			// refresh retries delivery to this session.
			lastContext.ui.notify(`Herder could not deliver final verification recovery to the main session: ${message(error)}`, "warning");
		} finally {
			sendingVerificationFailure = false;
		}
	};

	const activeVerificationOperation = (reply: ManagerReply) => (reply.operations ?? []).find(
		(operation) => operation.kind === "verification" && ["accepted", "running"].includes(operation.state),
	);

	const displayedReply = (reply: ManagerReply): { status: Exclude<ManagerReply["status"], "idle">; message: string } => {
		if (activeVerificationOperation(reply)) {
			return { status: "running", message: "Executing final verification gates in the background." };
		}
		return { status: reply.status as Exclude<ManagerReply["status"], "idle">, message: reply.message };
	};

	const updateFromReply = (
		reply: ManagerReply,
		profile?: string,
		mode?: "fire" | "resume" | "revise" | "attach",
		verificationRetryDetail?: string,
		repoRoot?: string,
	) => {
		if (reply.status === "idle") {
			currentState = undefined;
			pendingVerificationFailure = undefined;
			currentAttention = undefined;
			attentionHint = undefined;
			deferredAttention.clear();
			lastSummary = undefined;
			lastManagerMessage = undefined;
			verificationRequests.clear();
			promptedVerifications.clear();
			integrationRepairRequests.clear();
			reigniteRequests.clear();
			promptedReignites.clear();
			notifiedVerificationFailures.clear();
			render();
			return;
		}
		currentAttention = ownsRun(reply.planDirectory, reply.runId) ? reply.attention : undefined;
		if (!currentAttention || attentionHint !== currentAttention.requestId) attentionHint = undefined;
		const previous = currentState;
		const now = Date.now();
		const displayed = displayedReply(reply);
		persist({
			version: 1,
			mode: mode ?? previous?.mode ?? "resume",
			status: displayed.status,
			runId: reply.runId,
			repoRoot: repoRoot ?? previous?.repoRoot ?? "",
			planDir: reply.planDirectory,
			profile: profile ?? reply.profileName ?? previous?.profile ?? "unknown",
			maxParallel: reply.maxParallel,
			dashboardEnabled: true,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
			...(attentionHint ? { attentionRequestId: attentionHint } : {}),
			...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
		});
		lastSummary = {
			counts: { total: reply.summary.total, done: reply.summary.done, rejected: reply.summary.rejected },
			inProgress: reply.summary.inProgress,
		};
		lastManagerMessage = displayed.message;
		const repairBinding = bindIntegrationRepair(reply);
		const repair = repairBinding?.request;
		const actionableRepair = Boolean(repair && ["available", "failed", "paused"].includes(repair.state));
		const strandedRepair = Boolean(repair && ["active", "committing", "committed", "interrupted"].includes(repair.state));
		const repairOwnerMismatch = Boolean(repair && (
			(repair.ownerSessionId && repair.ownerSessionId !== (lastContext ? piSessionId(lastContext) : ""))
			|| (strandedRepair && !repair.ownerSessionId)
		));
		const repairNeedsDecision = Boolean(repair && ["design_ambiguity", "scope_ambiguity", "credential", "product_ambiguity"].includes(repair.classification || ""));
		const repairAtLimit = Boolean(repair && (
			(repair.classification === "code_defect" && (repair.acceptedCodeRounds ?? repair.round) >= repair.maxRounds)
			|| (repair.classification === "transient" && repair.transientRetryUsed && ["available", "failed"].includes(repair.state))
		));
		const verificationFailure = ( /verification/i.test(displayed.message)
			&& (displayed.status === "failed" || actionableRepair))
			|| Boolean(repair && actionableRepair)
			|| repairOwnerMismatch
			|| repairNeedsDecision;
		if (verificationFailure) {
			const failureKey = `${reply.runId}:${repair?.episodeId || repair?.requestId || displayed.message}:${repair?.round || 0}:${displayed.message}`;
			pendingVerificationFailure = {
				key: failureKey,
				runId: reply.runId,
				planDirectory: reply.planDirectory,
				detail: displayed.message,
				sessionId: lastContext ? piSessionId(lastContext) : undefined,
				...(repair ? { repair } : {}),
			};
			if (!notifiedVerificationFailures.has(failureKey)) {
				notifiedVerificationFailures.add(failureKey);
				lastContext?.ui.notify(
					repairOwnerMismatch
						? `Herder final verification recovery belongs to another main session; operator recovery is required.`
						: ((repairAtLimit || repairNeedsDecision)
							? `Herder final verification recovery requires an explicit user decision.`
						: `Herder final verification failed: ${displayed.message}\nAutomatic request-bound recovery is available; Use /herder-resume for operator recovery.`),
					"error",
				);
			}
		} else {
			pendingVerificationFailure = undefined;
		}
		if (ownsRun(reply.planDirectory, reply.runId)) {
			for (const operation of reply.operations ?? []) {
				if (operation.kind !== "verification" || !["accepted", "running"].includes(operation.state)) continue;
				const operationRequestId = operation.operationId.match(/^verification:([^:]+):/)?.[1];
				monitorVerification(operation.operationId, { planDirectory: reply.planDirectory, operationId: operation.operationId }, reply.verificationRequest?.requestId ?? operationRequestId);
			}
		}
		for (const active of reply.active) {
			if (!active.hostHandle || !engine.has(active.hostHandle) || workers.has(active.hostHandle)) continue;
			workers.set(active.hostHandle, {
				actionId: active.actionId,
				handle: active.hostHandle,
				managerRunId: reply.runId,
				planDir: reply.planDirectory,
				sessionEpoch,
			});
		}
		render();
		delegateVerification(reply, verificationRetryDetail);
		delegateReignite(reply);
		drainVerificationFailure();
		void requestAttentionDrain();
	};

	const postEvent = async (planDir: string, input: unknown): Promise<ManagerReply> => {
		const event = input as Record<string, unknown>;
		return unwrapReply(await invokeHerderTool("herder_submit", { planDirectory: planDir, ...event }) as Record<string, unknown>);
	};

	const managerTransportRetriable = (error: unknown): boolean => {
		if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return true;
		const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
		if (cause && typeof cause.code === "string" && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(cause.code)) return true;
		return message(error).includes("fetch failed");
	};

	// The manager dedupes events by eventId, so resending the identical payload after a
	// client-side abort or connection drop is safe and recovers replies that would
	// otherwise be lost (a lost reply can strand proposed dispatches forever).
	const postEventReliable = async (planDir: string, input: unknown): Promise<ManagerReply> => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			try { return await postEvent(planDir, input); }
			catch (error) {
				lastError = error;
				if (!managerTransportRetriable(error) || attempt === 5) throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 500)));
			}
		}
		throw lastError;
	};

	const releaseOwnershipIfManagerIdle = (): void => {
		if (!releaseOwnershipAfterManagerDrain || admittedManagerTasks !== 0) return;
		releaseOwnershipAfterManagerDrain = false;
		releaseOwnership();
	};

	const enqueueManager = <T>(task: () => Promise<T>): Promise<T> => {
		admittedManagerTasks += 1;
		const next = managerQueue.then(task, task);
		const tracked = next.finally(() => {
			admittedManagerTasks -= 1;
			releaseOwnershipIfManagerIdle();
		});
		managerQueue = tracked.then(() => undefined, () => undefined);
		return tracked;
	};

	const discardPrepared = async (handles: readonly string[]): Promise<void> => {
		for (const handle of handles) {
			workers.delete(handle);
			await engine.discard(handle).catch(() => {});
		}
	};

	const dispatchReply = async (initial: ManagerReply, epoch: number): Promise<ManagerReply> => {
		let reply = initial;
		assertOwnership(reply.planDirectory, reply.runId);
		while (sessionActive(epoch) && reply.actions.length > 0 && reply.status === "running") {
			const results = [];
			const prepared: string[] = [];
			for (const action of reply.actions) {
				try {
					const handle = await engine.prepare({ action, planDirectory: reply.planDirectory });
					prepared.push(handle);
					workers.set(handle, {
						actionId: action.actionId,
						handle,
						managerRunId: reply.runId,
						planDir: reply.planDirectory,
						sessionEpoch: epoch,
						transcript: createWorkerInputEntry(action, handle),
					});
					results.push({ actionId: action.actionId, accepted: true, hostHandle: handle });
				} catch (error) {
					results.push({ actionId: action.actionId, accepted: false, error: message(error) });
				}
			}
			if (!sessionActive(epoch)) {
				await discardPrepared(prepared);
				throw new Error("Herder dispatch was cancelled before worker handles were accepted because the Pi session changed or shut down.");
			}
			assertOwnership(reply.planDirectory, reply.runId);
			try {
				reply = await postEventReliable(reply.planDirectory, { eventId: randomUUID(), kind: "dispatch_results", dispatchResults: results });
			} catch (error) {
				await discardPrepared(prepared);
				throw error;
			}
			if (!sessionActive(epoch)) {
				for (const handle of prepared) {
					const binding = workers.get(handle);
					if (binding?.transcript) {
						appendWorkerEntry(HERDER_WORKER_INPUT_ENTRY, binding.transcript);
						appendWorkerEntry(HERDER_WORKER_OUTPUT_ENTRY, createWorkerOutputEntry(binding.transcript, {
							actionId: binding.actionId,
							hostHandle: handle,
							interrupted: true,
							error: "Pi session changed or shut down before worker start",
						}));
					}
				}
				await discardPrepared(prepared);
				// Leave accepted handles for the replacement session's deterministic
				// recovery pass without holding shutdown open for manager reconciliation.
				return reply;
			}
			for (const handle of prepared) {
				const binding = workers.get(handle);
				if (binding?.transcript) appendWorkerEntry(HERDER_WORKER_INPUT_ENTRY, binding.transcript);
				engine.start(handle);
			}
			updateFromReply(reply);
		}
		return reply;
	};

	const recoverInterruptedWorkers = async (initial: ManagerReply, epoch: number): Promise<ManagerReply> => {
		assertSessionActive(epoch);
		assertOwnership(initial.planDirectory, initial.runId);
		let reply = initial;
		const interrupted = interruptedPiWorkers(reply.active, (handle) => engine.has(handle));
		if (interrupted.length > 0) {
			reply = await postEventReliable(reply.planDirectory, {
				eventId: randomUUID(),
				kind: "terminals",
				terminals: interrupted,
			});
			assertSessionActive(epoch);
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
		}
		return dispatchReply(reply, epoch);
	};

	function monitorVerification(
		operationId: string,
		pending: Awaited<ReturnType<typeof submitHerderVerification>>,
		requestId?: string,
	): void {
		const epoch = sessionEpoch;
		if (verificationMonitors.get(operationId) === epoch) return;
		verificationMonitors.set(operationId, epoch);
		void waitHerderOperation(pending).then((value) => {
			if (!sessionActive(epoch)) return;
			return enqueueManager(async () => {
				assertSessionActive(epoch);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verification operation returned no manager reply");
				const reply = value as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				await dispatchReply(reply, epoch);
			});
		}).catch(async (error) => {
			if (!sessionActive(epoch)) return;
			const detail = message(error);
			lastContext?.ui.notify(`Herder verification handling failed: ${detail}`, "error");
			if (!requestId) return;
			try {
				await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: pending.planDirectory,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					assertOwnership(reply.planDirectory, reply.runId);
					if (reply.verificationRequest?.requestId === requestId) promptedVerifications.delete(requestId);
					updateFromReply(reply, undefined, undefined, detail);
				});
			} catch (refreshError) {
				if (sessionActive(epoch)) lastContext?.ui.notify(`Herder could not refresh verification state: ${message(refreshError)}`, "error");
			}
		}).finally(() => {
			if (verificationMonitors.get(operationId) === epoch) verificationMonitors.delete(operationId);
		});
	}

	const launch = async (options: FireOptions, ctx: ExtensionContext): Promise<string> => {
		const epoch = sessionEpoch;
		assertSessionActive(epoch);
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting Herder.");
		if (options.mode === "fire" && ownership) {
			throw new Error(`This Pi session already owns Herder run ${ownership.record.runId}; stop it before starting a different run.`);
		}
		const repoRoot = await repositoryRoot(ctx);
		assertSessionActive(epoch);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		if (options.mode === "resume") {
			// Resume is an explicit re-exposure point for durable attention. The hint
			// is not authority and must not suppress the manager's next request.
			attentionHint = undefined;
			currentAttention = undefined;
			deferredAttention.clear();
			promptedReignites.clear();
		}
		let acquired: AdapterOwnership | undefined;
		let before: ManagerReply | undefined;
		try {
			if (options.mode !== "fire") {
				const existingRunMode = options.mode;
				before = await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: planDir,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (reply.status === "idle" || !reply.runId) throw new Error(noDeterministicRunMessage(existingRunMode, planDir));
					acquired = await claimOwnership(planDir, reply.runId, ctx, epoch);
					return reply;
				});
			}
			const profile = await resolveProfile(ctx, options.profile || before?.profileName || (options.mode === "resume" ? currentState?.profile : undefined));
			assertSessionActive(epoch);
			renderLaunching(ctx, planDir, profile.profile, options.maxParallel ?? before?.maxParallel ?? currentState?.maxParallel ?? 5);
			await preflight(ctx, profile);
			assertSessionActive(epoch);
			if (!before) acquired = await claimOwnership(planDir, `pending-fire:${randomUUID()}`, ctx, epoch);
			const reply = await enqueueManager(async () => {
				assertSessionActive(epoch);
				if (before) {
					assertOwnership(planDir, before.runId);
					const fresh = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: planDir,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (fresh.runId !== before.runId) throw new Error(`Herder run changed from ${before.runId} to ${fresh.runId || "idle"} before ${options.mode}; refusing to mutate it.`);
					if (!fresh.profileName || fresh.profileName !== before.profileName) throw new Error(`Herder run ${before.runId} changed its immutable profile before ${options.mode}; refusing to mutate it.`);
				}
				const started = unwrapReply(await invokeHerderTool("herder_run", {
					operation: options.mode,
					repositoryRoot: repoRoot,
					planDirectory: planDir,
					profile: profile.profile,
					...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
					dashboardPort: options.dashboardPort,
				}) as Record<string, unknown>);
				assertSessionActive(epoch);
				if (started.status === "idle") throw new Error("Herder manager did not create a run.");
				if (before && started.runId !== before.runId) throw new Error(`Herder ${options.mode} returned unexpected run ${started.runId}; expected ${before.runId}.`);
				if (!before) {
					if (!ownership || ownership !== acquired) throw new Error("Herder Fire lost its startup ownership before manager creation completed.");
					bindAdapterOwnershipRun(ownership, started.runId);
				}
				assertOwnership(planDir, started.runId);
				const now = Date.now();
				persist({
					version: 1,
					mode: options.mode,
					status: started.status,
					runId: started.runId,
					repoRoot,
					planDir,
					profile: profile.profile,
					maxParallel: started.maxParallel,
					dashboardEnabled: true,
					startedAt: now,
					updatedAt: now,
					...(started.dashboardUrl ? { dashboardUrl: started.dashboardUrl } : {}),
				});
				lastSummary = {
					counts: { total: started.summary.total, done: started.summary.done, rejected: started.summary.rejected },
					inProgress: started.summary.inProgress,
				};
				// Process every start/resume reply before dispatch. A paused verification
				// request has no worker actions, so dispatch alone cannot delegate it.
				updateFromReply(started, profile.profile, options.mode, undefined, repoRoot);
				await dispatchReply(started, epoch);
				assertSessionActive(epoch);
				return started;
			});
			return `Herder ${options.mode} started with deterministic manager ${reply.runId}, profile ${profile.profile}, and max parallel ${reply.maxParallel}. Dashboard: ${reply.dashboardUrl || "unavailable"}`;
		} catch (error) {
			releaseNewOwnership(acquired, epoch);
			render(ctx);
			throw error;
		}
	};

	const attach = async (options: AttachOptions, ctx: ExtensionContext): Promise<string> => {
		const epoch = sessionEpoch;
		assertSessionActive(epoch);
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before attaching to Herder.");
		const repoRoot = await repositoryRoot(ctx);
		assertSessionActive(epoch);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		const snapshot = unwrapReply(await invokeHerderTool("herder_run", {
			operation: "status",
			planDirectory: planDir,
			dashboardPort: options.dashboardPort,
		}) as Record<string, unknown>);
		assertSessionActive(epoch);
		if (snapshot.status === "idle") {
			throw new Error(`No Herder run is recorded in ${planDir}. Use /herder-fire ${options.planDir} to start one.`);
		}
		if (snapshot.status === "complete") {
			throw new Error(`Herder run ${snapshot.runId} is complete and cannot be attached. Finalize or clean up the completed run, then use /herder-fire for new work.`);
		}
		if (["failed", "stopped", "initializing"].includes(snapshot.status)) {
			throw new Error(`Herder run ${snapshot.runId} is ${snapshot.status}. Use /herder-resume ${options.planDir} to recover it before attaching.`);
		}
		if (!["running", "paused", "needs_input"].includes(snapshot.status)) {
			throw new Error(`Herder run ${snapshot.runId} has unsupported attach status ${snapshot.status}.`);
		}
		if (!snapshot.profileName) throw new Error(`Herder run ${snapshot.runId} did not report its immutable profile; restart the manager and retry.`);
		const profile = await resolveProfile(ctx, snapshot.profileName);
		await preflight(ctx, profile);
		assertSessionActive(epoch);
		let acquired: AdapterOwnership | undefined;
		try {
			const fresh = await enqueueManager(async () => {
				assertSessionActive(epoch);
				acquired = await claimOwnership(planDir, snapshot.runId, ctx, epoch);
				const reply = unwrapReply(await invokeHerderTool("herder_run", {
					operation: "status",
					planDirectory: planDir,
					dashboardPort: options.dashboardPort,
				}) as Record<string, unknown>);
				assertSessionActive(epoch);
				if (reply.runId !== snapshot.runId) throw new Error(`Herder run changed from ${snapshot.runId} to ${reply.runId || "idle"} while attaching.`);
				if (!reply.profileName || reply.profileName !== snapshot.profileName) throw new Error(`Herder run ${snapshot.runId} changed its immutable profile while attaching.`);
				if (!["running", "paused", "needs_input"].includes(reply.status)) throw new Error(`Herder run ${reply.runId} changed to ${reply.status} while attaching.`);
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply, profile.profile, "attach", undefined, repoRoot);
				await recoverInterruptedWorkers(reply, epoch);
				assertSessionActive(epoch);
				return reply;
			});
			return `Attached to Herder run ${fresh.runId} without changing its ${fresh.status} lifecycle state, profile ${profile.profile}, and max parallel ${fresh.maxParallel}. Dashboard: ${fresh.dashboardUrl || "unavailable"}`;
		} catch (error) {
			releaseNewOwnership(acquired, epoch);
			throw error;
		}
	};

	const status = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: planDir }) as Record<string, unknown>);
		const statusAttentionId = reply.attention?.requestId;
		const reexposeAttention = Boolean(statusAttentionId
			&& ownsRun(reply.planDirectory, reply.runId)
			&& statusAttentionId === attentionHint);
		updateFromReply(reply);
		if (reexposeAttention && statusAttentionId) {
			attentionHint = undefined;
			deferredAttention.delete(statusAttentionId);
			if (currentState) persist({ ...currentState, attentionRequestId: undefined, updatedAt: Date.now() });
			await requestAttentionDrain();
		}
		render(ctx);
		const displayed = displayedReply(reply);
		return `${displayed.status.toUpperCase()} · ${displayed.message}${reply.dashboardUrl ? `\nDashboard: ${reply.dashboardUrl}` : ""}`;
	};

	const dashboard = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "dashboard", planDirectory: planDir }) as Record<string, unknown>);
		return `Herder dashboard: ${reply.dashboardUrl || "unavailable"}`;
	};

	const cleanup = async (args: string, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Herder cleanup.");
		const parsed = parseCleanupArguments(args);
		const repoRoot = await repositoryRoot(ctx);
		const requested = path.resolve(repoRoot, parsed.planDir);
		const planDir = parsed.force && !existsSync(requested)
			? resolvePlanDirectoryTarget(repoRoot, parsed.planDir)
			: resolvePlanDirectory(repoRoot, parsed.planDir);
		const result = await runCleanupCommand(parsed, {
			repositoryRoot: repoRoot,
			planDirectory: planDir,
			confirm: async (title, body) => ctx.hasUI && await ctx.ui.confirm(title, body),
			appendEntry: (entry) => pi.appendEntry(HERDER_CLEANUP_ENTRY, entry),
		});
		if (result.applied && !result.cancelled) await clearCurrentStateForPlanDirectory(planDir, ctx);
		return result.message;
	};

	const reset = async (args: string, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Herder reset.");
		const parsed = parseResetArguments(args);
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, parsed.planDir);
		const result = await runResetCommand(parsed, {
			repositoryRoot: repoRoot,
			planDirectory: planDir,
			confirm: async (title, body) => ctx.hasUI && await ctx.ui.confirm(title, body),
		});
		// Reset removes the durable run after the service exclusion has stopped its
		// terminal owner. Drop the adapter's matching in-memory ownership/state too,
		// otherwise the next Fire in this Pi session would be blocked by stale state.
		await clearCurrentStateForPlanDirectory(planDir, ctx);
		return result;
	};


	const stop = async (): Promise<string> => {
		if (!currentState) return "No active Herder run.";
		const epoch = sessionEpoch;
		const state = currentState;
		return enqueueManager(async () => {
			assertSessionActive(epoch);
			assertOwnership(state.planDir, state.runId);
			let reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "stop", planDirectory: state.planDir }) as Record<string, unknown>);
			assertSessionActive(epoch);
			const active = [...workers.values()].filter((worker) => worker.sessionEpoch === epoch);
			for (const worker of active) {
				if (worker.transcript) appendWorkerEntry(HERDER_WORKER_OUTPUT_ENTRY, createWorkerOutputEntry(worker.transcript, {
					actionId: worker.actionId,
					hostHandle: worker.handle,
					interrupted: true,
					error: "Pi user requested Herder stop",
				}));
			}
			for (const worker of active) workers.delete(worker.handle);
			await Promise.all(active.map((worker) => engine.stop(worker.handle).catch(() => {})));
			const interrupted: TerminalEvent[] = active.map((worker) => ({
				actionId: worker.actionId,
				hostHandle: worker.handle,
				interrupted: true,
				error: "Pi user requested Herder stop",
			}));
			if (interrupted.length > 0) {
				reply = await postEventReliable(state.planDir, { eventId: randomUUID(), kind: "terminals", terminals: interrupted });
			}
			assertSessionActive(epoch);
			updateFromReply(reply);
			releaseOwnership();
			return `Stop requested for Herder run ${reply.runId}. Repository state was preserved.`;
		});
	};

	const command = (handler: (args: string, ctx: ExtensionContext) => Promise<string>) => async (args: string, ctx: ExtensionContext) => {
		lastContext = ctx;
		try { ctx.ui.notify(await handler(args, ctx), "info"); }
		catch (error) { ctx.ui.notify(message(error), "error"); }
	};

	pi.registerCommand("herder-fire", { description: "Start a deterministic background Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "fire"), ctx)) });
	pi.registerCommand("herder-attach", { description: "Attach this Pi session to an active Herder run after its former session died.", handler: command((args, ctx) => attach(parseAttachArguments(args), ctx)) });
	pi.registerCommand("herder-resume", { description: "Resume a deterministic Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "resume"), ctx)) });
	pi.registerCommand("herder-revise", { description: "Adopt a validated new plan-graph generation.", handler: command((args, ctx) => launch(parseFireArguments(args, "revise"), ctx)) });
	pi.registerCommand("herder-status", { description: "Show Herder manager and plan status.", handler: command((args, ctx) => status(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-dashboard", { description: "Open the manager-hosted Herder dashboard.", handler: command((args, ctx) => dashboard(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-cleanup", { description: "Preview and confirm Herder cleanup. Use --force to destroy a plan set unconditionally.", handler: command(cleanup) });
	pi.registerCommand("herder-reset", { description: "Reset a Herder plan set to its pre-initialized execution state.", handler: command(reset) });
	pi.registerCommand("herder-stop", {
		description: "Stop active Herder workers and preserve repository state.",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop Herder?", "Active workers will stop; repository state remains preserved."))) return;
			try { ctx.ui.notify(await stop(), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	const activeFire = () => Boolean(currentState && !["complete", "failed", "stopped"].includes(currentState.status))
		|| Boolean(currentAttention && currentAttention.state !== "resolved")
		|| workers.size > 0
		|| engine.snapshots().length > 0;
	registerPiPlanningWorkflows(pi, PACKAGE_ROOT, repositoryRoot, {
		assertMutationAllowed: () => {
			if (activeFire()) throw new Error("Finish or stop the active Herder Fire run before changing plan configuration.");
		},
		assertAttentionAllowed: (input) => {
			const request = currentAttention;
			if (!request || request.state === "resolved") throw new Error("No unresolved Herder attention request is bound to this Pi session.");
			assertOwnership(input.planDirectory, request.runId);
			const capabilityToken = request.capabilityToken || attentionCapabilityToken(request.requestId);
			if (input.requestId !== request.requestId
				|| input.requestSha256 !== request.requestSha256
				|| input.capabilityToken !== capabilityToken
				|| input.runId !== request.runId
				|| input.planId !== request.planId
				|| input.generation !== request.generation
				|| input.round !== request.round) {
				throw new Error(`Herder attention request ${input.requestId || "missing"} is not bound to this Pi session.`);
			}
		},
		prepareWorkflow: async (skill, args, ctx) => {
			const target = skill === "grill" ? parseGrillPlanTarget(args) : null;
			if (!activeFire()) return {};
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			if (skill !== "grill") throw new Error("Only /herder-grill --plan <unstarted-plan> may run while Herder Fire is active.");
			assertActiveFireGrillTarget(target);
			const repoRoot = await repositoryRoot(ctx);
			const planDir = resolvePlanDirectory(repoRoot, target.planDir ?? currentState?.planDir ?? "herder-plans");
			if (currentState?.planDir && path.resolve(currentState.planDir) !== planDir) {
				throw new Error(`Active Herder Fire owns ${currentState.planDir}; Grill cannot edit ${planDir}.`);
			}
			if (!currentState) throw new Error("Active Herder state is unavailable for Grill ownership validation.");
			assertOwnership(planDir, currentState.runId);
			const reserved = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(planDir, currentState!.runId);
				return await invokeHerderTool("herder_plan", {
					operation: "begin_edit",
					planDirectory: planDir,
					planId: target.planId,
				}) as Record<string, unknown>;
			});
			assertSessionActive(epoch);
			const edit = reserved.edit as Record<string, unknown> | undefined;
			const editToken = typeof edit?.editToken === "string" ? edit.editToken : "";
			const planId = typeof edit?.planId === "string" ? edit.planId : target.planId;
			if (!editToken) throw new Error("Herder manager did not return a plan edit token.");
			if (reserved.reply && typeof reserved.reply === "object") {
				const reply = reserved.reply as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
			}
			return {
				runtimeContext: [
					"HERDER_ACTIVE_PLAN_EDIT_V1",
					`PLAN_ID: ${planId}`,
					`PLAN_DIRECTORY: ${planDir}`,
					`EDIT_TOKEN: ${editToken}`,
					"The manager has reserved this never-started plan while unrelated Fire workers continue.",
					"Edit only the reserved plan and necessary index fields. Do not add, remove, or change another plan.",
					"After confirmed edits pass shape and validation, call herder_plan with operation finish_edit, this planDirectory, and editToken.",
					"If no files were changed, call herder_plan with operation cancel_edit instead.",
				].join("\n"),
				rollback: async () => {
					if (!sessionActive(epoch) || !currentState || !ownsRun(planDir, currentState.runId)) return;
					const cancelled = await enqueueManager(async () => {
						assertSessionActive(epoch);
						assertOwnership(planDir, currentState!.runId);
						return await invokeHerderTool("herder_plan", {
							operation: "cancel_edit",
							planDirectory: planDir,
							editToken,
						}) as Record<string, unknown>;
					});
					if (cancelled.reply && typeof cancelled.reply === "object") {
						const reply = cancelled.reply as ManagerReply;
						assertOwnership(reply.planDirectory, reply.runId);
						updateFromReply(reply);
					}
				},
			};
		},
		handleManagerReply: async (value, context) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const epoch = sessionEpoch;
			const action = context?.attentionAction?.trim().toLowerCase().replace(/[- ]+/g, "_");
			if (action === "defer") {
				const reply = value as ManagerReply;
				if (reply.attention) deferredAttention.add(reply.attention.requestId);
			} else if (action && currentAttention) {
				deferredAttention.delete(currentAttention.requestId);
			}
			await enqueueManager(async () => {
				assertSessionActive(epoch);
				const reply = value as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				await dispatchReply(reply, epoch);
			});
		},
	});

	const integrationRepairWorktree = (binding: IntegrationRepairBinding): string =>
		binding.request.integrationWorktree || binding.verification?.integrationWorktree || (() => { throw new Error("Integration repair request has no recorded integration worktree"); })();

	const integrationRepairBranch = (binding: IntegrationRepairBinding): string =>
		binding.request.integrationBranch || binding.verification?.integrationBranch || (() => { throw new Error("Integration repair request has no recorded integration branch"); })();

	const readRepairGit = async (worktree: string, args: string[]): Promise<string> => {
		if (!lastContext) throw new Error("Herder integration repair has no active main-session context");
		const result = await pi.exec("git", ["-C", worktree, ...args], { timeout: 5_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `Git command failed: ${args.join(" ")}`);
		return result.stdout.trim();
	};

	const assertRepairCheckout = async (
		binding: IntegrationRepairBinding,
		operation: "begin" | "finish" | "cancel",
		observedCommit?: string,
	): Promise<{ worktree: string; branch: string; head: string; tree: string; dirty: boolean }> => {
		const worktree = integrationRepairWorktree(binding);
		const branch = integrationRepairBranch(binding);
		const actualBranch = await readRepairGit(worktree, ["symbolic-ref", "--short", "HEAD"]);
		if (actualBranch !== branch) throw new Error(`Integration repair worktree is not bound to ${branch}`);
		const head = await readRepairGit(worktree, ["rev-parse", "HEAD"]);
		const tree = await readRepairGit(worktree, ["rev-parse", "HEAD^{tree}"]);
		const dirty = Boolean(await readRepairGit(worktree, ["status", "--porcelain", "--untracked-files=all"]));
		const request = binding.request;
		const expectedHead = request.currentCommit || request.parentCommit;
		if (operation === "begin" || operation === "cancel") {
			if (head !== expectedHead) throw new Error(`Integration repair head changed: expected ${expectedHead}, found ${head}`);
			if (request.currentTree && tree !== request.currentTree) throw new Error(`Integration repair tree changed: expected ${request.currentTree}, found ${tree}`);
			if (dirty) throw new Error("Integration repair requires the assigned worktree to be clean before begin or cancel");
		}
		if (operation === "finish") {
			if (!observedCommit || !/^[0-9a-f]{40,64}$/i.test(observedCommit)) throw new Error("Integration repair finish requires the observed integration commit identity");
			if (head !== observedCommit) throw new Error(`Observed integration commit ${observedCommit} does not match the assigned worktree head ${head}`);
			if (dirty) throw new Error("Integration repair finish requires the assigned worktree to be clean after the owning session commit");
			const durableFinishReplay = ["committed", "verifying", "passed", "failed", "paused"].includes(request.state)
				&& Boolean(request.currentCommit)
				&& head === request.currentCommit;
			if (durableFinishReplay && request.currentTree && tree !== request.currentTree) throw new Error(`Integration repair replay tree changed: expected ${request.currentTree}, found ${tree}`);
			if (request.classification !== "code_defect" && head !== expectedHead) {
				throw new Error("Manifest or transient recovery must leave the frozen integration tree unchanged");
			}
		}
		return { worktree, branch, head, tree, dirty };
	};

	pi.registerTool({
		name: "herder_integration_repair",
		label: "Herder Integration Repair",
		description: "Classify one failed final-verification attempt and perform only the request-bound integration repair begin, finish, or cancel transition.",
		parameters: Type.Object({
			planDirectory: Type.String(),
			operation: Type.Union([Type.Literal("begin"), Type.Literal("finish"), Type.Literal("cancel")]),
			requestId: Type.String(),
			requestSha256: Type.String(),
			capabilityToken: Type.String(),
			ownerSessionId: Type.String(),
			operationId: Type.Optional(Type.String()),
			runId: Type.Optional(Type.String()),
			generation: Type.Optional(Type.Integer({ minimum: 1 })),
			repairId: Type.Optional(Type.String()),
			classification: Type.Optional(Type.Union([
				Type.Literal("code_defect"),
				Type.Literal("transient"),
				Type.Literal("manifest_error"),
				Type.Literal("design_ambiguity"),
				Type.Literal("scope_ambiguity"),
				Type.Literal("credential"),
				Type.Literal("product_ambiguity"),
			])),
			rationale: Type.Optional(Type.String()),
			detail: Type.Optional(Type.String()),
			gates: Type.Optional(Type.Array(Type.Object({
				gateId: Type.String(),
				label: Type.String(),
				cwd: Type.String({ description: "Tree-relative path inside the integration worktree; absolute paths are invalid." }),
				argv: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
				rationale: Type.String(),
			}), { maxItems: 32 })),
			gateAdditions: Type.Optional(Type.Array(Type.Object({
				gateId: Type.String(),
				label: Type.String(),
				cwd: Type.String({ description: "Tree-relative path inside the integration worktree; absolute paths are invalid." }),
				argv: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
				rationale: Type.String(),
			}), { maxItems: 32 })),
			allowedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 256 })),
			observedCommit: Type.Optional(Type.String({ description: "The clean session-authored integration-worktree HEAD observed immediately before finish." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			rejectLegacyIntegrationRepairCommitMessage(params);
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			lastContext = ctx;
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project before submitting an integration repair transition.");
			const repoRoot = await repositoryRoot(ctx);
			assertSessionActive(epoch);
			const planDirectory = resolvePlanDirectory(repoRoot, params.planDirectory);
			let binding = integrationRepairRequests.get(params.requestId);
			if (!binding || params.operation === "finish") {
				const cachedBinding = binding;
				const reply = await enqueueManager(async () => {
					assertSessionActive(epoch);
					return unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory }) as Record<string, unknown>);
				});
				assertSessionActive(epoch);
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				const durable = reply.integrationRepair;
				if (cachedBinding && durable && cachedBinding.request.repairId && durable.repairId === cachedBinding.request.repairId) {
					binding = mergeDurableIntegrationRepair(cachedBinding, durable);
					integrationRepairRequests.set(params.requestId, binding);
				} else {
					binding = integrationRepairRequests.get(params.requestId) || cachedBinding;
				}
			}
			if (!binding || binding.planDirectory !== planDirectory || binding.sessionEpoch !== epoch) {
				throw new Error(`Herder integration repair request ${params.requestId} is not bound to this main session epoch`);
			}
			const request = binding.request;
			if (params.requestId !== request.requestId
				|| params.requestSha256 !== request.requestSha256
				|| params.capabilityToken !== request.capabilityToken
				|| (params.repairId !== undefined && params.repairId !== request.repairId)
				|| (params.runId !== undefined && params.runId !== request.runId)
				|| (params.generation !== undefined && params.generation !== request.generation)
				|| params.ownerSessionId !== piSessionId(ctx)
				|| (request.ownerSessionId !== undefined && request.ownerSessionId !== params.ownerSessionId)) {
				throw new Error(`Herder integration repair request ${request.requestId} is not bound to this main session`);
			}
			assertOwnership(planDirectory, request.runId);
			if (params.operation === "begin" && !params.classification) throw new Error("Integration repair begin requires exactly one classification");
			const classificationOnly = params.operation === "begin"
				&& ["design_ambiguity", "scope_ambiguity", "credential", "product_ambiguity"].includes(params.classification || request.classification || "");
			await resolveProfile(ctx, currentState?.profile || "unknown");
			assertSessionActive(epoch);
			const checkout = await assertRepairCheckout(binding, params.operation, params.observedCommit);
			const operationId = String(params.operationId || `integration-repair:${params.operation}:${request.requestId}:${randomUUID()}`);
			const pending = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(planDirectory, request.runId);
				return await submitHerderIntegrationRepair({
					planDirectory,
					operation: params.operation,
					operationId,
					requestId: request.requestId,
					requestSha256: request.requestSha256,
					capabilityToken: request.capabilityToken,
					runId: request.runId,
					generation: request.generation,
					ownerSessionId: params.ownerSessionId,
					...(request.repairId ? { repairId: request.repairId } : {}),
					...(params.classification === undefined ? {} : { classification: params.classification }),
					...(params.rationale === undefined ? {} : { rationale: params.rationale }),
					...(params.detail === undefined ? {} : { detail: params.detail }),
					...(params.gates === undefined ? {} : { gates: params.gates }),
					...(params.gateAdditions === undefined ? {} : { gateAdditions: params.gateAdditions }),
					...(params.allowedPaths === undefined ? {} : { allowedPaths: params.allowedPaths }),
					observedCommit: params.operation === "finish" ? params.observedCommit : checkout.head,
				});
			});
			const value = await waitHerderOperation(pending);
			assertSessionActive(epoch);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration repair operation returned no manager reply");
			const reply = value as ManagerReply;
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
			await dispatchReply(reply, epoch);
			const repairState = reply.integrationRepair?.state || "completed";
			return {
				content: [{ type: "text" as const, text: classificationOnly
					? `Integration repair classification ${params.classification} was recorded as ${repairState}; no writable repair authority was opened. Ask the user for the next decision.`
					: params.operation === "begin"
						? `Integration repair round ${reply.integrationRepair?.round || request.round} is ${repairState}. The assigned worktree is writable only for this request-bound transaction; finish or cancel it explicitly.`
						: `Integration repair ${params.operation} was accepted as ${repairState}. Herder is retaining the authoritative verification program and will continue the existing final-audit lifecycle.` }],
				details: {
					operationId,
					requestId: request.requestId,
					repairId: reply.integrationRepair?.repairId || request.repairId,
					round: reply.integrationRepair?.round || request.round,
					state: repairState,
					observedCommit: checkout.head,
				},
				terminate: classificationOnly || params.operation !== "begin",
			};
		},
	});

	pi.registerTool({
		name: "herder_verification",
		label: "Herder Verification",
		description: "Submit the main Pi session's structured, exact-tree final verification manifest. Herder executes the gates asynchronously; this tool only selects them.",
		parameters: Type.Object({
			planDirectory: Type.String(),
			requestId: Type.String(),
			rationale: Type.String(),
			gates: Type.Array(Type.Object({
				gateId: Type.String(),
				label: Type.String(),
				cwd: Type.String({ description: "Tree-relative path inside the integration worktree. Use '.' for the worktree root. Absolute paths are invalid." }),
				argv: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
				rationale: Type.String(),
			}), { maxItems: 32 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			lastContext = ctx;
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project before submitting Herder verification.");
			const repoRoot = await repositoryRoot(ctx);
			assertSessionActive(epoch);
			const planDirectory = resolvePlanDirectory(repoRoot, params.planDirectory);
			let request = verificationRequests.get(params.requestId);
			if (!request) {
				const reply = await enqueueManager(async () => {
					assertSessionActive(epoch);
					return unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory }) as Record<string, unknown>);
				});
				assertSessionActive(epoch);
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				request = verificationRequests.get(params.requestId);
			}
			if (!request || request.requestId !== params.requestId || currentState?.runId !== request.runId || currentState.profile === "unknown") {
				throw new Error(`Herder verification request ${params.requestId} is not bound to this main session`);
			}
			assertOwnership(planDirectory, request.runId);
			await resolveProfile(ctx, currentState.profile);
			assertSessionActive(epoch);
			const manifest = prepareHerderVerificationManifest(request, {
				schemaVersion: 1,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
				runId: request.runId,
				generation: request.generation,
				graphSha256: request.graphSha256,
				runAssignmentSha256: request.runAssignmentSha256,
				integrationHead: request.integrationHead,
				integrationTree: request.integrationTree,
				rationale: params.rationale,
				gates: params.gates,
				selector: {
					...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
					sessionId: piSessionId(ctx),
				},
			} satisfies VerificationManifest);
			const operationId = `verification:${request.requestId}:${randomUUID()}`;
			const pending = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(planDirectory, request!.runId);
				const submitted = await submitHerderVerification({ planDirectory, operationId, manifest });
				assertSessionActive(epoch);
				return submitted;
			});
			// Submission is durable, so immediately reflect the background execution
			// instead of leaving the last awaiting-manifest snapshot on screen.
			if (currentState?.runId === request.runId) {
				persist({ ...currentState, status: "running", updatedAt: Date.now() });
				lastManagerMessage = `Executing ${params.gates.length} final verification gate(s) in the background.`;
				render(ctx);
			}
			monitorVerification(operationId, pending, request.requestId);
			return {
				content: [{ type: "text" as const, text: `Verification manifest accepted as ${operationId}. Herder is executing ${params.gates.length} gate(s) in the background.` }],
				details: { operationId, requestId: request.requestId, gates: params.gates.length },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "herder_reignite",
		label: "Herder Reignite",
		description: "Acknowledge the one-shot write of residual final-review findings. planDirectory may be the source run or the allocated herder-reignite[-N] sibling; acknowledgement always targets the source run. The original complete run stays complete. For written, pass graphSha256 from herder_plan validate of the allocated directory.",
		parameters: Type.Object({
			planDirectory: Type.String(),
			requestId: Type.String(),
			requestSha256: Type.String(),
			state: Type.Union([Type.Literal("written"), Type.Literal("failed")]),
			graphSha256: Type.Optional(Type.String()),
			detail: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			lastContext = ctx;
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project before acknowledging a Herder reignite write.");
			const repoRoot = await repositoryRoot(ctx);
			assertSessionActive(epoch);
			const requestedDirectory = resolvePlanDirectory(repoRoot, params.planDirectory);
			let request = reigniteRequests.get(params.requestId);
			if (!request) {
				const refreshDirectories: string[] = [];
				for (const candidate of [currentState?.planDir, requestedDirectory]) {
					const resolved = optionalResolvedPlanDirectory(repoRoot, candidate);
					if (!resolved || refreshDirectories.some((entry) => sameResolvedDirectory(entry, resolved))) continue;
					refreshDirectories.push(resolved);
				}
				for (const directory of refreshDirectories) {
					const reply = await enqueueManager(async () => {
						assertSessionActive(epoch);
						return unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: directory }) as Record<string, unknown>);
					});
					assertSessionActive(epoch);
					if (reply.status === "idle" || !reply.runId) continue;
					assertOwnership(reply.planDirectory, reply.runId);
					updateFromReply(reply);
					request = reigniteRequests.get(params.requestId);
					if (request) break;
				}
			}
			if (!request || request.requestId !== params.requestId || request.requestSha256 !== params.requestSha256 || currentState?.runId !== request.runId || currentState.profile === "unknown") {
				throw new Error(`Herder reignite request ${params.requestId} is not bound to this main session`);
			}
			if (currentState.status !== "complete") {
				throw new Error("Herder reignite can only be acknowledged for a complete source run");
			}
			const sourceDirectory = resolvePlanDirectory(repoRoot, request.sourcePlanDirectory);
			const allocatedDirectory = optionalResolvedPlanDirectory(repoRoot, request.allocatedPlanDirectory);
			if (!sameResolvedDirectory(requestedDirectory, sourceDirectory) && !sameResolvedDirectory(requestedDirectory, allocatedDirectory)) {
				throw new Error(`Herder reignite planDirectory must be the source run (${sourceDirectory}) or its allocated sibling${allocatedDirectory ? ` (${allocatedDirectory})` : ""}.`);
			}
			assertOwnership(sourceDirectory, request.runId);
			await resolveProfile(ctx, currentState.profile);
			assertSessionActive(epoch);
			const operationId = `reignite:${request.requestId}:${randomUUID()}`;
			const pending = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(sourceDirectory, request!.runId);
				const submitted = await submitHerderReignite({
					planDirectory: sourceDirectory,
					operationId,
					requestId: request!.requestId,
					requestSha256: request!.requestSha256,
					state: params.state,
					...(params.graphSha256 === undefined ? {} : { graphSha256: params.graphSha256 }),
					...(params.detail === undefined ? {} : { detail: params.detail }),
				});
				assertSessionActive(epoch);
				return submitted;
			});
			const value = await waitHerderOperation(pending);
			assertSessionActive(epoch);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reignite operation returned no manager reply");
			const reply = value as ManagerReply;
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
			if (params.state === "written") reigniteRequests.delete(request.requestId);
			const written = params.state === "written" && reply.status === "complete" && !reply.reigniteRequest;
			return {
				content: [{ type: "text" as const, text: written
					? `Reignite plan directory written at ${request.allocatedPlanDirectory || "the allocated path"}. The original run remains complete. Fire is a separate command.`
					: `Reignite write was not accepted as complete. The original run remains complete and the dossier is still pending at ${request.allocatedPlanDirectory || "the allocated path"}.` }],
				details: {
					operationId,
					requestId: request.requestId,
					state: params.state,
					allocatedPlanDirectory: request.allocatedPlanDirectory,
					sourceStatus: reply.status,
				},
				terminate: true,
			};
		},
	});

	engine.onUpdate(() => render());
	engine.onTerminal(async (completed: PiWorkerTerminal) => {
		const binding = workers.get(completed.handle);
		if (!binding || binding.actionId !== completed.actionId) return;
		if (binding.transcript) appendWorkerEntry(
			HERDER_WORKER_OUTPUT_ENTRY,
			createWorkerOutputEntry(binding.transcript, completed),
		);
		workers.delete(completed.handle);
		const epoch = binding.sessionEpoch;
		if (!sessionActive(epoch)) return;
		await enqueueManager(async () => {
			assertSessionActive(epoch);
			assertOwnership(binding.planDir, binding.managerRunId);
			const terminal: TerminalEvent = {
				actionId: binding.actionId,
				hostHandle: completed.handle,
				...(completed.response ? { response: completed.response } : {}),
				...(completed.interrupted ? { interrupted: true } : {}),
				...(completed.error ? { error: completed.error } : {}),
				usage: completed.usage,
			};
			const reply = await postEventReliable(binding.planDir, { eventId: randomUUID(), kind: "terminals", terminals: [terminal] });
			assertSessionActive(epoch);
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
			await dispatchReply(reply, epoch);
		}).catch((error) => {
			if (sessionActive(epoch)) lastContext?.ui.notify(`Herder completion handling failed: ${message(error)}`, "error");
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (shuttingDown) return;
		lastContext = ctx;
		drainVerificationFailure();
		await requestAttentionDrain();
		orcaBusy.onParentSettled(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEpoch += 1;
		const epoch = sessionEpoch;
		shuttingDown = false;
		releaseOwnershipAfterManagerDrain = false;
		lastContext = ctx;
		currentAttention = undefined;
		pendingVerificationFailure = undefined;
		sendingVerificationFailure = false;
		deliveredVerificationFailureFollowUps.clear();
		deferredAttention.clear();
		sessionFactory.bindModelRegistry?.(ctx.modelRegistry);
		currentState = restoreLastRun(ctx.sessionManager.getEntries());
		// A persisted hint only records that an earlier session injected a request;
		// it is never an acknowledgement authority across replacement. Re-expose
		// the manager's next durable request after the replacement status read.
		attentionHint = undefined;
		lastPersistedState = currentState;
		if (currentState) {
			const restored = currentState;
			let acquired: AdapterOwnership | undefined;
			try {
				await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: restored.planDir }) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (reply.runId !== restored.runId) {
						throw new Error(`Persisted Herder run ${restored.runId} does not match manager run ${reply.runId || "idle"}; refusing recovery.`);
					}
					const shouldOwn = ["initializing", "running", "paused", "needs_input"].includes(reply.status)
						|| (reply.status === "failed" && (Boolean(reply.attention && reply.attention.state !== "resolved") || /verification/i.test(reply.message)));
					if (shouldOwn) {
						if (!reply.profileName || (restored.profile !== "unknown" && reply.profileName !== restored.profile)) {
							throw new Error(`Persisted Herder profile ${restored.profile} does not match manager profile ${reply.profileName || "missing"}; refusing recovery.`);
						}
						acquired = await claimOwnership(reply.planDirectory, reply.runId, ctx, epoch);
						assertSessionActive(epoch);
						assertOwnership(reply.planDirectory, reply.runId);
						updateFromReply(reply);
						if (["running", "paused", "needs_input"].includes(reply.status)) await recoverInterruptedWorkers(reply, epoch);
						return;
					}
					updateFromReply(reply);
					if (ownership) releaseOwnershipAfterManagerDrain = true;
				});
			} catch (error) {
				releaseNewOwnership(acquired, epoch);
				if (ownership && ownershipEpoch !== epoch) {
					if (admittedManagerTasks === 0) releaseOwnership();
					else releaseOwnershipAfterManagerDrain = true;
				}
				if (sessionActive(epoch)) ctx.ui.notify(`Herder manager recovery failed: ${message(error)}`, "warning");
			}
		} else if (ownership) {
			if (admittedManagerTasks === 0) releaseOwnership();
			else releaseOwnershipAfterManagerDrain = true;
		}
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		sessionEpoch += 1;
		shuttingDown = true;
		const handles = engine.snapshots().map((worker) => worker.handle);
		await Promise.all(handles.map((handle) => engine.stop(handle).catch(() => {})));
		workers.clear();
		if (admittedManagerTasks === 0) releaseOwnership();
		else {
			releaseOwnershipAfterManagerDrain = true;
			if (ownership) registerAdapterOwnershipRetirement(ownership, managerQueue);
		}
		widget.dispose();
		verificationRequests.clear();
		integrationRepairRequests.clear();
		reigniteRequests.clear();
		pendingVerificationFailure = undefined;
		sendingVerificationFailure = false;
		promptedVerifications.clear();
		promptedReignites.clear();
		currentAttention = undefined;
		deferredAttention.clear();
		lastContext = undefined;
	});
}
