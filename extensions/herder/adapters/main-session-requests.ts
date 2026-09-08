import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HERDER_ATTENTION_MESSAGE,
	attentionMessageDetails,
	buildAttentionPrompt,
} from "./attention.ts";
import {
	type IntegrationRepairRequest,
	type ManagerAttentionRequest,
	type ManagerReply,
	type ReigniteRequest,
	type VerificationRequest,
} from "../src/shared/protocol.ts";
import { readLiveRunFreshness } from "../src/application/tools.ts";
import { classifyVerificationRecovery, verificationRunnerEvidence, ENVIRONMENT_VERIFICATION_RESUME_GUIDANCE, FINAL_VERIFICATION_SELECTION_GUIDANCE } from "./verification-recovery.ts";
import type { HerderRunState } from "./state.ts";

export interface MainSessionPi {
	sendUserMessage(content: string, options?: { deliverAs?: "followUp" }): void;
	sendMessage(content: unknown, options?: { deliverAs?: "followUp"; triggerTurn?: boolean }): void;
}

export interface MainSessionSnapshot {
	context?: Pick<ExtensionContext, "hasUI" | "ui">;
	state?: HerderRunState;
	epoch: number;
	active: boolean;
	sessionId: string;
}

export interface MainSessionRequestsHost {
	pi: MainSessionPi;
	packageRoot: string;
	current(): MainSessionSnapshot;
	ownsRun(planDirectory: string, runId: string): boolean;
	onAttentionHint(hint: string | undefined): void;
}

export interface IntegrationRepairBinding {
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

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class MainSessionRequests {
	private readonly verificationRequestStore = new Map<string, VerificationRequest>();
	private readonly promptedVerifications = new Set<string>();
	private readonly integrationRepairRequestStore = new Map<string, IntegrationRepairBinding>();
	private readonly reigniteRequestStore = new Map<string, ReigniteRequest>();
	private readonly promptedReignites = new Set<string>();
	private currentAttention: ManagerAttentionRequest | undefined;
	private attentionHint: string | undefined;
	private attentionDrain = Promise.resolve();
	private readonly deferredAttention = new Set<string>();
	private readonly notifiedVerificationFailures = new Set<string>();
	private readonly deliveredVerificationFailureFollowUps = new Set<string>();
	private pendingVerificationFailure: PendingVerificationFailure | undefined;
	private sendingVerificationFailure = false;
	private readonly host: MainSessionRequestsHost;

	constructor(host: MainSessionRequestsHost) { this.host = host; }

	private notify = (text: string, level: "warning" | "error"): void => {
		this.host.current().context?.ui.notify(text, level);
	};

	get attention(): ManagerAttentionRequest | undefined { return this.currentAttention; }
	get attentionRequestId(): string | undefined { return this.attentionHint; }
	getVerificationRequest(requestId: string): VerificationRequest | undefined { return this.verificationRequestStore.get(requestId); }
	getIntegrationRepairRequest(requestId: string): IntegrationRepairBinding | undefined { return this.integrationRepairRequestStore.get(requestId); }
	getReigniteRequest(requestId: string): ReigniteRequest | undefined { return this.reigniteRequestStore.get(requestId); }

	reset(mode: "idle" | "cleanup" | "resume" | "session-start" | "shutdown"): void {
		this.currentAttention = undefined;
		this.attentionHint = undefined;
		this.deferredAttention.clear();
		if (mode === "resume") {
			this.promptedReignites.clear();
			return;
		}
		this.pendingVerificationFailure = undefined;
		if (mode === "session-start") {
			this.sendingVerificationFailure = false;
			this.deliveredVerificationFailureFollowUps.clear();
			return;
		}
		this.verificationRequestStore.clear();
		this.promptedVerifications.clear();
		this.integrationRepairRequestStore.clear();
		this.reigniteRequestStore.clear();
		this.promptedReignites.clear();
		if (mode === "idle" || mode === "cleanup") this.notifiedVerificationFailures.clear();
		if (mode === "cleanup") this.deliveredVerificationFailureFollowUps.clear();
		if (mode === "shutdown") this.sendingVerificationFailure = false;
	}

	clearVerificationPrompt(requestId: string): void { this.promptedVerifications.delete(requestId); }
	acknowledgeReignite(requestId: string): void { this.reigniteRequestStore.delete(requestId); }
	deferAttention(requestId: string): void { this.deferredAttention.add(requestId); }
	resumeAttention(requestId: string): void { this.deferredAttention.delete(requestId); }
	reexposeAttention(requestId: string): void {
		if (this.attentionHint === requestId) {
			this.attentionHint = undefined;
			this.host.onAttentionHint(undefined);
		}
		this.deferredAttention.delete(requestId);
	}

	observeReply(reply: ManagerReply, displayed?: { status: string; message: string }): void {
		const owned = this.host.ownsRun(reply.planDirectory, reply.runId);
		this.currentAttention = owned ? reply.attention : undefined;
		if (!this.currentAttention || this.attentionHint !== this.currentAttention.requestId) this.attentionHint = undefined;
		const repair = this.bindIntegrationRepair(reply)?.request;
		if (!displayed) return;
		const recovery = classifyVerificationRecovery(repair, repair?.ownerSessionId && this.host.current().context ? this.host.current().sessionId : "");
		const verificationFailure = (/verification/i.test(displayed.message) && (displayed.status === "failed" || recovery.actionable)) || Boolean(repair && recovery.actionable) || recovery.ownerMismatch || recovery.ambiguity;
		if (!verificationFailure) { this.pendingVerificationFailure = undefined; return; }
		const failureKey = `${reply.runId}:${repair?.episodeId || repair?.requestId || displayed.message}:${repair?.round || 0}:${displayed.message}`;
		this.pendingVerificationFailure = { key: failureKey, runId: reply.runId, planDirectory: reply.planDirectory, detail: displayed.message, sessionId: this.host.current().sessionId, ...(repair ? { repair } : {}) };
		if (!this.notifiedVerificationFailures.has(failureKey)) {
			this.notifiedVerificationFailures.add(failureKey);
			this.notify(recovery.ownerMismatch ? "Herder final verification recovery belongs to another main session; operator recovery is required." : ((recovery.atLimit || recovery.ambiguity) ? "Herder final verification recovery requires an explicit user decision." : `Herder final verification failed: ${displayed.message}\nAutomatic request-bound recovery is available; Use /herder-resume for operator recovery.`), "error");
		}
	}

	deliverReply(reply: ManagerReply, retryDetail?: string): void {
		this.delegateVerification(reply, retryDetail);
		this.delegateReignite(reply);
		this.drainVerificationFailure();
		void this.drainAttentionNow();
	}

	async settled(): Promise<void> {
		this.drainVerificationFailure();
		await this.drainAttentionNow();
	}

	private bindIntegrationRepair = (reply: ManagerReply): IntegrationRepairBinding | undefined => {
		const request = reply.integrationRepair;
		if (!request || !this.host.ownsRun(reply.planDirectory, reply.runId)) return undefined;
		const binding: IntegrationRepairBinding = {
			request,
			planDirectory: reply.planDirectory,
			sessionEpoch: this.host.current().epoch,
			verification: this.verificationRequestStore.get(request.requestId),
		};
		this.integrationRepairRequestStore.set(request.requestId, binding);
		return binding;
	};

	mergeRepair(binding: IntegrationRepairBinding, durable: IntegrationRepairRequest): IntegrationRepairBinding {
		const merged: IntegrationRepairBinding = {
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
		};
		this.integrationRepairRequestStore.set(binding.request.requestId, merged);
		return merged;
	}

	private delegateVerification = (reply: ManagerReply, retryDetail?: string) => {
		if (!this.host.current().active || !this.host.ownsRun(reply.planDirectory, reply.runId)) return;
		const request = reply.verificationRequest;
		if (!request) return;
		this.verificationRequestStore.set(request.requestId, request);
		if ((reply.operations ?? []).some((operation) => operation.kind === "verification" && operation.operationId.startsWith(`verification:${request.requestId}:`))) return;
		if (this.promptedVerifications.has(request.requestId) || !this.host.current().context) return;
		this.promptedVerifications.add(request.requestId);
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
			...FINAL_VERIFICATION_SELECTION_GUIDANCE,
			"Choose the smallest non-redundant set of commands that adequately verifies the integrated change. Distinguish setup/examples from actual checks; prefer one comprehensive check over duplicated focused checks when it subsumes them.",
			"Represent every command as direct argv. Every argv element must be one non-empty line: never put literal newlines inside a shell script argument. Use [\"/bin/sh\", \"-lc\", \"single-line script\"] only when shell syntax is genuinely required; join multiple shell statements with && or semicolons.",
			"PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot for inspection only. Each gate cwd is TreeRelative: use '.' for the worktree root or a relative path such as 'pkg'. Absolute paths in cwd are invalid; never copy INTEGRATION_WORKTREE into cwd.",
			'EXAMPLE_GATE: {"gateId":"unit","label":"unit tests","cwd":".","argv":["npm","test"],"rationale":"Covers the integrated change."}',
			...(retryDetail ? [`PREVIOUS_MANIFEST_ERROR: ${retryDetail.replace(/\s+/g, " ").slice(0, 1_000)}`, "Correct the rejected manifest and submit it again."] : []),
			"Once prerequisites, authority, and gate selection are established, call herder_verification exactly once as your final action. If they are unresolved, report the concrete blocker and ask for the missing prerequisite or decision instead of submitting a known-invalid manifest. A prose-only success claim is never verification evidence.",
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
			this.host.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			this.promptedVerifications.delete(request.requestId);
			this.host.current().context?.ui.notify(`Herder could not delegate final verification: ${message(error)}`, "warning");
		}
	};

	private pendingStatusChangingOperations = (reply: ManagerReply, requestId: string): boolean =>
		(reply.operations ?? []).some((operation) => {
			if (!["accepted", "running"].includes(operation.state)) return false;
			if (operation.kind === "reignite" && operation.operationId.startsWith(`reignite:${requestId}:`)) return false;
			return true;
		});

	private delegateReignite = (reply: ManagerReply) => {
		if (!this.host.current().active || !this.host.ownsRun(reply.planDirectory, reply.runId) || reply.status !== "complete") return;
		const request = reply.reigniteRequest;
		if (!request || request.state !== "pending") return;
		if (this.pendingStatusChangingOperations(reply, request.requestId)) return;
		const live = readLiveRunFreshness(reply.planDirectory);
		if (!live || live.runId !== reply.runId || live.status !== "complete") return;
		if (live.pendingOperations > 0) return;
		this.reigniteRequestStore.set(request.requestId, request);
		if ((reply.operations ?? []).some((operation) => operation.kind === "reignite" && operation.operationId.startsWith(`reignite:${request.requestId}:`))) return;
		if (this.promptedReignites.has(request.requestId) || !this.host.current().context) return;
		this.promptedReignites.add(request.requestId);
		const findings = request.findings.length > 0 ? request.findings.map((finding) => `- ${finding}`).join("\n") : "none";
		const guidance = request.fixGuidance.length > 0 ? request.fixGuidance.map((item) => `- ${item}`).join("\n") : "none";
		const prompt = [
			"HERDER_MAIN_SESSION_REIGNITE_V1",
			"The original Herder run is complete. Turn residual PLAN_REQUIREMENT and PATCH_REGRESSION findings into a new fireable sibling plan directory only when their remediation fits Herder's repository execution boundary.",
			`Before authoring, read ${this.host.packageRoot}/skills/plans/references/plan-format.md and ${this.host.packageRoot}/skills/plans/references/plan-template.md completely, including the execution boundary and Producer self-review.`,
			"Cloud provisioning, deployment/publishing, live migrations, and live restore/undo (including disposable targets) are external operator work, not Herder starting conditions, dependencies, setup, or acceptance/final gates. Local tests, emulators, non-mutating dry-runs, and implementing configuration/scripts/runbooks are allowed. Code completion is not release acceptance.",
			"If a finding requires external operations or changing an existing live acceptance requirement, report the needed operator handoff or confirmed replan and acknowledge failed with that detail. Do not invent a TODO/BLOCKED operational node, silently drop/rephase a criterion, or claim unrun live evidence. The original run remains complete; release approval is separate.",
			"Write only in the allocated directory. Do not edit the source plan tree, the frozen integration worktree, or manager SQLite. Do not call /herder-fire.",
			"For findings within that boundary, use herder_plan init with local tracking, write the plan files, cold-read their compiled snapshots using the Producer self-review, then shape and validate. Each PLAN_REQUIREMENT or PATCH_REGRESSION finding becomes TODO or BLOCKED. FOLLOWUP and INVALID findings may go in leak/ only.",
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
			this.host.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			this.promptedReignites.delete(request.requestId);
			this.host.current().context?.ui.notify(`Herder could not delegate the reignite write: ${message(error)}`, "warning");
		}
	};

	private drainAttention = async (): Promise<void> => {
		if (!this.host.current().active || !this.host.current().context || !this.currentAttention || !this.host.current().state) return;
		const request = this.currentAttention;
		const state = this.host.current().state!;
		if (request.state === "resolved" || this.deferredAttention.has(request.requestId) || this.attentionHint === request.requestId) return;
		const requestId = request.requestId;
		const epoch = this.host.current().epoch;
		try {
			const prompt = await buildAttentionPrompt(this.host.packageRoot, state.planDir, request);
			if (!(this.host.current().active && this.host.current().epoch === epoch) || !this.host.current().context || !this.currentAttention || this.currentAttention.requestId !== requestId) return;
			this.host.pi.sendMessage({
				customType: HERDER_ATTENTION_MESSAGE,
				content: prompt,
				display: true,
				details: attentionMessageDetails(request),
			}, { deliverAs: "followUp", triggerTurn: true });
			// A successful injection is the only acknowledgement held by the adapter.
			// SQLite remains authoritative, so a replacement session can re-expose the
			// request when this hint was not persisted before shutdown.
			this.attentionHint = requestId;
			this.host.onAttentionHint(requestId);
		} catch (error) {
			this.host.current().context?.ui.notify(`Herder could not delegate attention request ${requestId}: ${message(error)}`, "warning");
		}
	};

	drainAttentionNow(): Promise<void> {
		const next = this.attentionDrain.then(this.drainAttention, this.drainAttention);
		this.attentionDrain = next.then(() => undefined, () => undefined);
		return next;
	}

	private drainVerificationFailure = (): void => {
		if (!this.host.current().active || this.sendingVerificationFailure || !this.host.current().context || !this.pendingVerificationFailure) return;
		const failure = this.pendingVerificationFailure;
		const deliveryKey = `${this.host.current().epoch}:${failure.key}`;
		if (this.deliveredVerificationFailureFollowUps.has(deliveryKey)) {
			this.pendingVerificationFailure = undefined;
			return;
		}
		const repair = failure.repair;
		const currentMainSessionId = this.host.current().context ? this.host.current().sessionId : "";
		const recovery = classifyVerificationRecovery(repair, currentMainSessionId);
		const logPath = failure.detail.match(/\(log ([^)]+)\)/)?.[1] || "the verification failure detail";
		const verification = repair ? this.verificationRequestStore.get(repair.requestId) : undefined;
		const integrationWorktree = repair?.integrationWorktree || verification?.integrationWorktree || "unavailable: manager did not provide the recorded integration worktree";
		const integrationBranch = repair?.integrationBranch || verification?.integrationBranch || "unavailable: manager did not provide the recorded integration branch";
		const integrationHead = repair ? repair.currentCommit || repair.parentCommit : "unknown";
		const integrationTree = repair?.currentTree || verification?.integrationTree || "unknown";
		const gateJson = (repair?.canonicalGates || repair?.failedGates || []).map((gate) => JSON.stringify(gate)).join("\n");
		const prompt = recovery.kind === "owner_mismatch"
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
				`RUNNER_EVIDENCE (observations, not defect classifications): ${verificationRunnerEvidence(repair?.verificationResult)}`,
				"Do not call herder_integration_repair, edit the integration worktree, or claim recovery. Ask the user to recover the former session or choose an explicit operator/corrective-plan path.",
			].join("\n")
			: recovery.kind === "decision_required"
			? [
				"HERDER_MAIN_SESSION_VERIFICATION_REPAIR_DECISION_V1",
				recovery.ambiguity
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
				`RUNNER_EVIDENCE (observations, not defect classifications): ${verificationRunnerEvidence(repair?.verificationResult)}`,
				...(repair?.classification === "environment" ? [ENVIRONMENT_VERIFICATION_RESUME_GUIDANCE] : [
					"Read the recorded log and ask the user whether to stop, defer, or continue through an explicitly revised/corrective plan. Do not call herder_integration_repair begin again, do not claim success, and do not execute Herder verification commands yourself.",
					"/herder-resume remains operator recovery for a durable paused run; ordinary deterministic defects no longer require graph revision before the bounded rounds are exhausted, but this exhausted state requires the user's choice.",
				]),
			].join("\n")
			: recovery.kind === "recoverable" && repair
				? [
					"HERDER_MAIN_SESSION_VERIFICATION_RECOVERY_V1",
					"HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1",
					"Herder authoritative final verification failed and has issued one request-bound recovery capability to the owning main Pi session.",
					"Use read-only inspection commands to read the exact failure log, explain the concrete failure to the user, then classify exactly one recovery path. Do not claim success, silently retry, or execute Herder's authoritative verification commands yourself.",
					`RUN_ID: ${failure.runId}`,
					`MAIN_SESSION_ID: ${failure.sessionId || "unknown"}`,
					`OWNER_SESSION_ID: ${repair.ownerSessionId || failure.sessionId || "unknown"}`,
					`ADAPTER_EPOCH: ${this.host.current().epoch}`,
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
					`RUNNER_EVIDENCE (observations, not defect classifications): ${verificationRunnerEvidence(repair?.verificationResult)}`,
					"CLASSIFICATIONS: manifest_error | transient | code_defect | design_ambiguity | scope_ambiguity | credential | environment | product_ambiguity",
					...(repair.episodeId ? [
						`CLASSIFICATION_EPISODE: ${repair.episodeId}`,
						"A classification is immutable only inside this episode. Every newly failed successor opens a fresh unclassified episode; classify the current evidence and do not carry forward a prior episode's classification.",
					] : []),
					...(repair.transientRetryUsed ? ["TRANSIENT_BUDGET: The unchanged transient retry for this exact head/tree/gate program is already consumed; select a different evidence-supported path."] : []),
					"Gate outcomes (passed, command_failed, unavailable, timed_out, runner_error), errors, signals, and timeout flags are runner observations, not defect classifications. Even command_failed from uv/nix/package-manager wrappers may mean missing prerequisites. Inspect the recorded evidence; never infer code_defect from an exit code or log regex alone.",
					"Separate setup from validation. Use repository-declared canonical uv run, nix develop --command, or package-script invocations when specified, not bare tools, global installs, uvx/npx downloads, or ambient HOME substitution. Record exact manager/argv/cwd/error and the required prerequisite.",
					"For manifest_error (wrong argv, cwd, or manager invocation), call herder_integration_repair begin once, then finish with a corrected complete gate array; do not edit the integration worktree. Proven missing environment prerequisites are environment, not source defects or automatic transient retries.",
					"For transient, call begin once, then finish once with the inherited gates unchanged; this is the one unchanged retry and must not edit the integration worktree.",
					"For code_defect, call begin once before editing. Only after begin may you edit failure-related paths in INTEGRATION_WORKTREE and run optional local diagnostics. Then stage the allowed changes, create the next bounded code-repair commit or amend the existing repair commit while retaining the fixed parent, confirm git status is clean, and pass allowedPaths plus observedCommit from git rev-parse HEAD. The owning session authors the commit; Herder only validates it and reruns the authoritative gates. Local tests are optional and non-authoritative; do not run the final Herder gates directly.",
					"For design_ambiguity, scope_ambiguity, credential, environment, or product_ambiguity, call herder_integration_repair exactly once with operation begin, the selected classification, and a concrete rationale or detail. This records a non-mutating user-decision outcome; it does not open edit authority. For environment, the operator may prepare the verified declared prerequisites externally, then explicitly use /herder-resume to replay the exact canonical gates without edits or a budget charge. Other decision classifications may use a corrective plan followed by /herder-revise when the user chooses it.",
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
					`RUNNER_EVIDENCE (observations, not defect classifications): ${verificationRunnerEvidence(repair?.verificationResult)}`,
					"Inspect the log using read-only commands and explain the concrete failure to the user. Do not claim success, silently retry, or execute verification commands yourself.",
					"Use /herder-resume for a fresh verification request after correcting a manifest or transient operational failure; for an integrated code defect, propose a corrective plan followed by /herder-revise.",
					"Do not edit the frozen integration worktree, move Git refs, or mutate manager state.",
				].join("\n");
		this.sendingVerificationFailure = true;
		try {
			this.host.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			this.deliveredVerificationFailureFollowUps.add(deliveryKey);
			this.pendingVerificationFailure = undefined;
		} catch (error) {
			// Keep the pending failure so agent_settled or the next durable status
			// refresh retries delivery to this session.
			this.host.current().context?.ui.notify(`Herder could not deliver final verification recovery to the main session: ${message(error)}`, "warning");
		} finally {
			this.sendingVerificationFailure = false;
		}
	};

}
