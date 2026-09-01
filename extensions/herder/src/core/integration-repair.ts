import { randomUUID } from "node:crypto";
import { gitValue, type GitDriver } from "../daemon/git-driver.ts";
import {
	integrationRepairCapabilityDigest,
	integrationRepairCapabilityToken,
	INTEGRATION_REPAIR_CLASSIFICATIONS,
	normalizeIntegrationRepairInput,
	normalizeIntegrationRepairRefSnapshotEvidence,
	sha256,
	stableJson,
	validateIntegrationRepairInput,
	type IntegrationRepairClassification,
	type IntegrationRepairInput,
	type IntegrationRepairRef,
	type IntegrationRepairRequest,
	type ManagerReply,
	type VerificationManifest,
} from "../shared/protocol.ts";
import {
	RunStore,
	type StoredIntegrationRepair,
	type StoredRun,
	type StoredVerification,
} from "../daemon/run-store.ts";
import {
	createVerificationRequest,
	normalizeIntegrationRepairGates,
	normalizeVerificationGates,
	normalizeVerificationManifest,
	normalizeVerificationRationale,
} from "./verification.ts";

export type IntegrationRepairDependencies = {
	store: RunStore;
	driver: (run: StoredRun) => GitDriver;
	reply: () => ManagerReply;
	verification: (manifest: VerificationManifest) => Promise<ManagerReply>;
	updateRun: (input: { status?: StoredRun["status"]; terminalDetail?: string | null }) => void;
};

type PreparedRepairGateProgram = {
	gates: VerificationManifest["gates"];
	rationale: string;
};

const REPAIR_CLASSIFICATION_ALIASES: Record<string, IntegrationRepairClassification> = {
	code: "code_defect",
	code_defect: "code_defect",
	integrated_code_defect: "code_defect",
	integrated_code_test_defect: "code_defect",
	test_defect: "code_defect",
	transient: "transient",
	manifest: "manifest_error",
	manifest_error: "manifest_error",
	design: "design_ambiguity",
	design_ambiguity: "design_ambiguity",
	scope: "scope_ambiguity",
	scope_ambiguity: "scope_ambiguity",
	credential: "credential",
	product: "product_ambiguity",
	product_ambiguity: "product_ambiguity",
};

function normalizeIntegrationRepairClassification(value: unknown): IntegrationRepairClassification {
	const normalized = String(value ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
	const classification = REPAIR_CLASSIFICATION_ALIASES[normalized];
	if (!classification || !INTEGRATION_REPAIR_CLASSIFICATIONS.includes(classification)) throw new Error("Integration repair classification is invalid");
	return classification;
}

function validateRepairSession(value: string | undefined, expected: string | null): void {
	if (!value || !expected || value !== expected) throw new Error("Integration repair owner session does not match the request-bound capability");
}

function repairAuditEvidence(input: IntegrationRepairInput): Record<string, unknown> {
	const { capabilityToken, ...rest } = input;
	return { ...rest, capabilityTokenSha256: integrationRepairCapabilityDigest(capabilityToken) };
}

function repairInputHash(input: IntegrationRepairInput): string {
	return sha256(stableJson(repairAuditEvidence(input)));
}

export function repairBeginRefSnapshot(repair: StoredIntegrationRepair): IntegrationRepairRef[] {
	if (!repair.beginRefSnapshot || !repair.beginRefSnapshotSha256) {
		throw new Error("Integration repair begin namespace evidence is unavailable; cancel and restart the repair");
	}
	return normalizeIntegrationRepairRefSnapshotEvidence(repair.beginRefSnapshot, repair.beginRefSnapshotSha256).refs;
}

export function integrationRepairForVerification(store: RunStore, verification: StoredVerification): StoredIntegrationRepair | null {
		const byRequest = store.getIntegrationRepairForRequest(verification.request.requestId);
		if (byRequest) return byRequest;
		const candidate = store.getIntegrationRepairForRun(verification.request.runId, verification.request.generation);
		if (!candidate) return null;
		return [candidate.requestId, candidate.successorRequestId, candidate.episodeRequestId].includes(verification.request.requestId)
			? candidate
			: null;
	}

export function validateDurableRepairSuccessor(
	store: RunStore,
		repair: StoredIntegrationRepair | null,
	): { verification: StoredVerification; manifest: VerificationManifest; manifestSha256: string } {
		if (!repair
			|| !repair.successorRequestId
			|| !repair.successorRequestSha256
			|| !repair.successorManifest
			|| !repair.successorManifestSha256) {
			throw new Error("Verification request is not bound to its durable integration repair successor");
		}
		const verification = store.getVerificationByRequestId(repair.successorRequestId);
		if (!verification
			|| verification.request.requestId !== repair.successorRequestId
			|| verification.request.runId !== repair.runId
			|| verification.request.generation !== repair.generation
			|| verification.request.repairId !== repair.repairId
			|| verification.request.requestSha256 !== repair.successorRequestSha256) {
			throw new Error("Verification request is not bound to its durable integration repair successor");
		}
		let durable: { manifest: VerificationManifest; manifestSha256: string };
		try {
			durable = normalizeVerificationManifest(verification.request, repair.successorManifest);
		} catch (error) {
			throw new Error(`Durable integration repair successor manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (durable.manifestSha256 !== repair.successorManifestSha256) {
			throw new Error("Durable integration repair successor manifest does not match its persisted hash");
		}
		return { verification, manifest: durable.manifest, manifestSha256: durable.manifestSha256 };
	}

export function validateRepairSuccessorManifest(
	store: RunStore,
		request: StoredVerification["request"],
		incomingManifestSha256: string,
		repair: StoredIntegrationRepair | null,
	): void {
		if (!request.repairId) return;
		const durable = validateDurableRepairSuccessor(store, repair);
		if (durable.verification.request.requestId !== request.requestId
			|| durable.verification.request.requestSha256 !== request.requestSha256
			|| durable.verification.request.runId !== request.runId
			|| durable.verification.request.generation !== request.generation
			|| durable.verification.request.repairId !== request.repairId) {
			throw new Error("Verification request is not bound to its durable integration repair successor");
		}
		if (incomingManifestSha256 !== durable.manifestSha256) {
			throw new Error("Verification manifest does not match the persisted integration repair successor manifest");
		}
	}

export function integrationRepairRequest(verification: StoredVerification, repair: StoredIntegrationRepair | null): IntegrationRepairRequest {
		const requestId = verification.request.requestId;
		const capabilityToken = integrationRepairCapabilityToken(requestId);
		const currentEpisode = repair && repair.episodeRequestId === requestId ? repair : null;
		const canonicalGates = repair?.effectiveGates ?? verification.manifest?.gates ?? [];
		const state = repair
			? repair.state
			: "available";
		return {
			schemaVersion: 1,
			...(repair ? { repairId: repair.repairId } : {}),
			requestId,
			requestSha256: verification.request.requestSha256,
			runId: verification.request.runId,
			generation: verification.request.generation,
			state,
			...(currentEpisode?.classification ? { classification: currentEpisode.classification } : {}),
			...(currentEpisode ? { episodeState: currentEpisode.episodeClassification ? currentEpisode.episodeState ?? currentEpisode.state : "unclassified" } : {}),
			...(currentEpisode?.episodeRequestSha256 ? { episodeRequestSha256: currentEpisode.episodeRequestSha256 } : {}),
			...(currentEpisode?.episodeIntegrationHead ? { episodeIntegrationHead: currentEpisode.episodeIntegrationHead } : {}),
			...(currentEpisode?.episodeIntegrationTree ? { episodeIntegrationTree: currentEpisode.episodeIntegrationTree } : {}),
			...(currentEpisode?.episodeCanonicalGatesSha256 ? { episodeCanonicalGatesSha256: currentEpisode.episodeCanonicalGatesSha256 } : {}),
			...(currentEpisode?.episodeId ? { episodeId: currentEpisode.episodeId } : {}),
			round: repair?.round ?? 1,
			maxRounds: 3,
			...(repair ? { acceptedCodeRounds: repair.acceptedCodeRounds, transientRetryUsed: repair.transientRetryUsed } : {}),
			...(repair?.ownerSessionId ? { ownerSessionId: repair.ownerSessionId } : {}),
			capabilityToken,
			capabilityTokenSha256: integrationRepairCapabilityDigest(capabilityToken),
			integrationBranch: verification.request.integrationBranch,
			integrationWorktree: verification.request.integrationWorktree,
			parentCommit: repair?.parentCommit ?? verification.request.integrationHead,
			...(repair?.currentCommit ? { currentCommit: repair.currentCommit } : {}),
			...(repair?.currentTree ? { currentTree: repair.currentTree } : {}),
			failedGates: verification.manifest?.gates ?? [],
			canonicalGates,
			...(repair?.beginRefSnapshot && repair.beginRefSnapshotSha256 ? {
				beginRefSnapshot: repairBeginRefSnapshot(repair),
				beginRefSnapshotSha256: repair.beginRefSnapshotSha256,
			} : {}),
			...(repair?.successorRequestId ? { successorRequestId: repair.successorRequestId } : {}),
			...(repair?.successorRequestSha256 ? { successorRequestSha256: repair.successorRequestSha256 } : {}),
			supersededCommits: repair?.supersededCommits ?? [],
			...(repair?.detail ? { detail: repair.detail } : {}),
		};
	}

function repairVerificationForInput(store: RunStore, input: IntegrationRepairInput): StoredVerification {
		const verification = store.getVerificationByRequestId(input.requestId);
		if (!verification) throw new Error(`Unknown integration repair verification request ${input.requestId}`);
		if (verification.request.requestSha256 !== input.requestSha256) throw new Error("Integration repair request evidence changed");
		const run = store.getRun();
		if (!run || verification.request.runId !== run.runId || verification.request.generation !== run.currentGeneration) throw new Error("Integration repair request is not bound to the current run generation");
		if (verification.request.integrationBranch !== run.integrationBranch || verification.request.integrationWorktree !== run.integrationWorktree) {
			throw new Error("Integration repair verification namespace does not match the recorded run");
		}
		if (input.runId !== undefined && input.runId !== run.runId) throw new Error("Integration repair runId does not match the current run");
		if (input.generation !== undefined && input.generation !== run.currentGeneration) throw new Error("Integration repair generation does not match the current run");
		return verification;
	}

function repairBeginAuditMatches(store: RunStore, repair: StoredIntegrationRepair, operationId: string, payloadSha256: string): boolean {
		return store.getIntegrationRepairAudits(repair.repairId).some((audit) =>
			audit.action === "begin" && audit.operationId === operationId && audit.payloadSha256 === payloadSha256);
	}

function validateRepairBeginAdmission(
	store: RunStore,
		run: StoredRun,
		verification: StoredVerification,
		input: IntegrationRepairInput,
		repair: StoredIntegrationRepair | null,
	): void {
		if (run.status === "stopped" || run.status === "complete") throw new Error(`Integration repair begin is not allowed after the run is ${run.status}`);
		if (store.getPlan(run.runId, "RUN")) throw new Error("Integration repair begin is not allowed after final RUN completion");
		const latest = store.getVerification(run.runId, run.currentGeneration);
		if (!latest || latest.state !== "failed" || latest.request.requestId !== verification.request.requestId) {
			throw new Error("Integration repair begin must target the latest failed verification request");
		}
		if (repair) {
			if (repair.runId !== run.runId || repair.generation !== run.currentGeneration) throw new Error("Integration repair identity belongs to another run generation");
			if (![repair.requestId, repair.successorRequestId].includes(input.requestId)) throw new Error("Integration repair request is not bound to the selected repair identity");
			if (input.repairId && repair.repairId !== input.repairId) throw new Error("Integration repair ID does not match durable evidence");
			if (!repair.episodeId || repair.episodeRequestId !== verification.request.requestId
				|| repair.episodeRequestSha256 !== verification.request.requestSha256
				|| repair.episodeIntegrationHead !== verification.request.integrationHead
				|| repair.episodeIntegrationTree !== verification.request.integrationTree
				|| (verification.manifest && repair.episodeCanonicalGatesSha256 !== sha256(stableJson(verification.manifest.gates)))) {
				throw new Error("Integration repair classification episode is not bound to the failed verification evidence");
			}
		} else if (store.getIntegrationRepairForRun(run.runId, run.currentGeneration)) {
			throw new Error("A conflicting integration repair already exists for the current run generation");
		}
	}

export function isProvableInitialRepair(
	store: RunStore,
		verification: StoredVerification,
		repair: StoredIntegrationRepair,
	): boolean {
		const request = verification.request;
		if (verification.state !== "failed"
			|| request.predecessorRequestId !== undefined
			|| request.repairId !== undefined
			|| request.repairRound !== undefined) return false;
		// A replacement verification can omit predecessor metadata; another durable
		// repair row in this run generation still proves that this is not the first failure.
		if (store.hasOtherIntegrationRepairForGeneration(request.runId, request.generation, repair.repairId)) return false;
		const episodes = store.getIntegrationRepairEpisodes(repair.repairId);
		if (episodes.length !== 1 || store.getIntegrationRepairAudits(repair.repairId).length !== 0) return false;
		const [episode] = episodes;
		if (!episode) return false;
		const canonicalGates = verification.manifest?.gates ?? [];
		const canonicalGatesSha256 = sha256(stableJson(canonicalGates));
		const sameIdentity = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
		return repair.runId === request.runId
			&& repair.generation === request.generation
			&& repair.requestId === request.requestId
			&& sameIdentity(repair.requestSha256, request.requestSha256)
			&& sameIdentity(repair.parentCommit, request.integrationHead)
			&& repair.currentCommit === null
			&& repair.currentTree === null
			&& repair.beginRefSnapshot === null
			&& repair.beginRefSnapshotSha256 === null
			&& repair.ownerSessionId === null
			&& repair.capabilityDigest === null
			&& repair.classification === null
			&& repair.state === "failed"
			&& repair.round === 1
			&& repair.acceptedCodeRounds === 0
			&& repair.supersededCommits.length === 0
			&& repair.successorRequestId === null
			&& repair.successorRequestSha256 === null
			&& repair.successorManifest === null
			&& repair.successorManifestSha256 === null
			&& repair.operationId === null
			&& repair.operationPayloadSha256 === null
			&& sameIdentity(repair.canonicalGatesSha256, canonicalGatesSha256)
			&& stableJson(repair.canonicalGates) === stableJson(canonicalGates)
			&& stableJson(repair.effectiveGates) === stableJson(canonicalGates)
			&& repair.episodeId === episode.episodeId
			&& episode.repairId === repair.repairId
			&& episode.requestId === request.requestId
			&& sameIdentity(episode.requestSha256, request.requestSha256)
			&& sameIdentity(episode.integrationHead, request.integrationHead)
			&& sameIdentity(episode.integrationTree, request.integrationTree)
			&& sameIdentity(episode.canonicalGatesSha256, canonicalGatesSha256)
			&& stableJson(episode.canonicalGates) === stableJson(canonicalGates)
			&& episode.classification === null
			&& episode.state === "failed"
			&& episode.operationId === null
			&& episode.operationPayloadSha256 === null
			&& episode.transientUsed === false
			&& episode.transientUseEvidenceSha256 === null
			&& episode.closedAt === null
			&& repair.episodeRequestId === episode.requestId
			&& repair.episodeRequestSha256 !== null
			&& sameIdentity(repair.episodeRequestSha256, episode.requestSha256)
			&& repair.episodeIntegrationHead !== null
			&& sameIdentity(repair.episodeIntegrationHead, episode.integrationHead)
			&& repair.episodeIntegrationTree !== null
			&& sameIdentity(repair.episodeIntegrationTree, episode.integrationTree)
			&& repair.episodeCanonicalGatesSha256 !== null
			&& sameIdentity(repair.episodeCanonicalGatesSha256, episode.canonicalGatesSha256)
			&& stableJson(repair.episodeCanonicalGates) === stableJson(episode.canonicalGates)
			&& repair.episodeState === episode.state
			&& repair.episodeClassification === null;
	}

async function validateFreshRepairBeginGitIdentity(
	deps: IntegrationRepairDependencies,
		run: StoredRun,
		verification: StoredVerification,
		repair: StoredIntegrationRepair | null,
	): Promise<void> {
		const driver = deps.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const expectedHead = verification.request.integrationHead.toLowerCase();
		const expectedTree = verification.request.integrationTree.toLowerCase();
		if (repair?.currentCommit && repair.currentCommit.toLowerCase() !== expectedHead) {
			throw new Error(`Integration repair begin failed head changed: durable current ${repair.currentCommit}, expected ${verification.request.integrationHead}`);
		}
		if (repair?.currentTree && repair.currentTree.toLowerCase() !== expectedTree) {
			throw new Error(`Integration repair begin failed tree changed: durable current ${repair.currentTree}, expected ${verification.request.integrationTree}`);
		}
		const symbolicBranch = gitValue(run.integrationWorktree, "symbolic-ref", "--short", "HEAD");
		if (symbolicBranch !== run.integrationBranch) throw new Error(`Integration repair begin worktree is not on ${run.integrationBranch}`);
		if (driver.worktreeStatus(run.integrationWorktree)) throw new Error("Integration repair begin worktree must be clean");
		const branchHead = driver.branchHead(run.integrationBranch).toLowerCase();
		if (branchHead !== expectedHead) {
			throw new Error(`Integration repair begin integration branch changed: expected ${verification.request.integrationHead}, found ${branchHead}`);
		}
		const worktreeHead = driver.worktreeHead(run.integrationWorktree).toLowerCase();
		if (worktreeHead !== expectedHead) {
			throw new Error(`Integration repair begin integration worktree changed: expected ${verification.request.integrationHead}, found ${worktreeHead}`);
		}
		const worktreeTree = driver.worktreeTree(run.integrationWorktree).toLowerCase();
		if (worktreeTree !== expectedTree) {
			throw new Error(`Integration repair begin integration tree changed: expected ${verification.request.integrationTree}, found ${worktreeTree}`);
		}
		if (repair) {
			if (repair.beginRefSnapshot === null && repair.beginRefSnapshotSha256 === null) {
				if (!isProvableInitialRepair(deps.store, verification, repair)) repairBeginRefSnapshot(repair);
			} else {
				const beginRefSnapshot = repairBeginRefSnapshot(repair);
				driver.validateIntegrationRepairNamespace({
					beginRefSnapshot,
					beginRefSnapshotSha256: repair.beginRefSnapshotSha256!,
					expectedIntegrationHead: expectedHead,
					expectedWorktreeHead: expectedHead,
				});
			}
		}
	}

function prepareRepairGateProgram(
		verification: StoredVerification,
		repair: StoredIntegrationRepair,
		input: IntegrationRepairInput,
	): PreparedRepairGateProgram {
		const classification = repair.classification;
		if (!classification) throw new Error("Integration repair has no durable classification");
		const retained = repair.effectiveGates;
		if (classification === "manifest_error" && input.gates === undefined) throw new Error("Manifest-error recovery requires a replacement gate array");
		if (classification !== "manifest_error" && input.gates !== undefined && input.gateAdditions === undefined && input.gates.length > retained.length) {
			throw new Error("Integration repair gate additions must be explicitly recorded");
		}
		let candidate = input.gates;
		if (candidate === undefined && input.gateAdditions !== undefined) candidate = [...retained, ...input.gateAdditions];
		if (candidate === undefined) candidate = retained;
		const normalizedCandidate = normalizeVerificationGates(verification.request.integrationWorktree, candidate);
		if (classification === "transient" && stableJson(normalizedCandidate) !== stableJson(retained)) {
			throw new Error("Transient verification recovery must retain the exact gate program");
		}
		if (classification === "transient" && input.gateAdditions !== undefined && input.gateAdditions.length > 0) {
			throw new Error("Transient verification recovery cannot add gates");
		}
		let recordedAdditions: VerificationManifest["gates"] | undefined;
		if (input.gateAdditions !== undefined) {
			recordedAdditions = normalizeVerificationGates(verification.request.integrationWorktree, input.gateAdditions);
		}
		const gates = normalizeIntegrationRepairGates({
			classification,
			retainedGates: retained,
			candidateGates: normalizedCandidate,
			recordedAdditions,
		});
		const rationale = normalizeVerificationRationale(input.rationale?.trim() || `Authoritative verification after integration repair round ${repair.round}.`);
		return { gates, rationale };
	}

function repairGateManifest(
		verification: StoredVerification,
		repair: StoredIntegrationRepair,
		prepared: PreparedRepairGateProgram,
		head: string,
		tree: string,
	): { request: ReturnType<typeof createVerificationRequest>; manifest: VerificationManifest; gates: VerificationManifest["gates"]; manifestSha256: string } {
		const request = createVerificationRequest({
			requestId: repair.successorRequestId || randomUUID(),
			runId: verification.request.runId,
			generation: verification.request.generation,
			graphSha256: verification.request.graphSha256,
			runAssignmentPath: verification.request.runAssignmentPath,
			runAssignmentSha256: verification.request.runAssignmentSha256,
			integrationBranch: verification.request.integrationBranch,
			integrationWorktree: verification.request.integrationWorktree,
			integrationHead: head,
			integrationTree: tree,
			requestedAt: new Date().toISOString(),
			predecessorRequestId: verification.request.requestId,
			repairId: repair.repairId,
			repairRound: repair.round,
		});
		const { manifest, manifestSha256 } = normalizeVerificationManifest(request, {
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: prepared.rationale,
			gates: prepared.gates,
		});
		return { request, manifest, gates: prepared.gates, manifestSha256 };
	}

export async function runIntegrationRepair(
	deps: IntegrationRepairDependencies,
	wireInput: IntegrationRepairInput,
): Promise<ManagerReply> {
		validateIntegrationRepairInput(wireInput);
		const input = normalizeIntegrationRepairInput(wireInput);
		const operationId = input.operationId || `integration-repair:${input.operation}:${input.requestId}`;
		const inputHash = repairInputHash(input);
		const verification = repairVerificationForInput(deps.store, input);
		const repairForRequest = deps.store.getIntegrationRepairForRequest(input.requestId);
		let repair = input.repairId ? deps.store.getIntegrationRepair(input.repairId) : repairForRequest;
		if (input.repairId && !repair && repairForRequest) throw new Error("Integration repair ID does not match durable evidence");
		if (repair && input.repairId && repair.repairId !== input.repairId) throw new Error("Integration repair ID does not match durable evidence");
		const run = deps.store.getRun()!;
		const historicalFinishReplay = Boolean(repair && input.operation === "finish" && ["failed", "paused", "passed"].includes(repair.state)
			&& deps.store.getIntegrationRepairAudits(repair.repairId).some((audit) =>
				audit.operationId === operationId && audit.payloadSha256 === inputHash && ["finish-intent", "successor", "commit"].includes(audit.action)));
		const beginNamespaceEvidence = (expectedHead: string): { snapshot: string; sha256: string } => {
			const driver = deps.driver(run);
			const evidence = driver.readIntegrationRepairNamespace();
			const integrationRef = `refs/heads/${run.integrationBranch}`;
			const capturedIntegration = evidence.refs.find((entry) => entry.ref === integrationRef);
			if (!capturedIntegration || capturedIntegration.target !== expectedHead.toLowerCase()) {
				throw new Error(`Integration repair begin integration branch changed before authorization: expected ${expectedHead}`);
			}
			return { snapshot: evidence.snapshot, sha256: evidence.sha256 };
		};
		if (input.operation === "begin") {
			const classification = normalizeIntegrationRepairClassification(input.classification);
			const decisionOnly = ["design_ambiguity", "scope_ambiguity", "credential", "product_ambiguity"].includes(classification);
			if (!decisionOnly && !["code_defect", "transient", "manifest_error"].includes(classification)) throw new Error("Integration repair classification is not an automatic recovery path");
			if (verification.state !== "failed") throw new Error("Integration repair begin requires a failed verification attempt");
			const ownerSessionId = input.ownerSessionId;
			const currentClassification = repair?.episodeClassification ?? null;
			if (currentClassification && currentClassification !== classification) throw new Error("Integration repair classification cannot change within a classification episode");
			if (repair && repairBeginAuditMatches(deps.store, repair, operationId, inputHash)) {
				validateRepairBeginAdmission(deps.store, run, verification, input, repair);
				if (repair.ownerSessionId !== ownerSessionId || currentClassification !== classification) throw new Error("Integration repair begin was replayed with different durable evidence");
				if (!repair.beginRefSnapshot || !repair.beginRefSnapshotSha256) throw new Error("Integration repair begin namespace evidence is unavailable; cancel and restart the repair");
				if (["active", "committing"].includes(repair.state) && run.status !== "stopped" && run.status !== "complete") {
					deps.store.transaction(() => {
						deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "begin", inputHash, repairAuditEvidence(input));
						deps.updateRun({ status: "paused", terminalDetail: `Integration repair round ${repair!.round} is authorized for the owning main session.` });
					});
				}
				return deps.reply();
			}
			const detail = input.detail?.trim() || input.rationale?.trim();
			if (decisionOnly && !detail) throw new Error("Ambiguity classification requires a rationale or detail for the user decision");
			validateRepairBeginAdmission(deps.store, run, verification, input, repair);
			if (repair) {
				if (repair.state === "interrupted") throw new Error("Integration repair evidence is interrupted and requires explicit user choice");
				if (repair.ownerSessionId && repair.ownerSessionId !== ownerSessionId) throw new Error("Integration repair belongs to another main session");
				if (repair.state === "passed" || repair.state === "cancelled") throw new Error("Integration repair is already terminal; user choice is required");
				if (repair.state === "active" || repair.state === "committing" || repair.state === "committed" || repair.state === "verifying") {
					if (repair.operationId && repair.operationId !== operationId) throw new Error("Integration repair begin was replayed with a different operation");
					if (repair.operationPayloadSha256 && repair.operationPayloadSha256 !== inputHash) throw new Error("Integration repair begin was replayed with different evidence");
				}
				if (classification === "code_defect" && repair.acceptedCodeRounds >= 3) {
					deps.store.updateIntegrationRepair(repair.repairId, { state: "paused", detail: "Three accepted code-repair commits exhausted the bounded code-repair budget." });
					throw new Error("Integration repair code-round limit reached; user choice is required");
				}
				if (classification === "transient" && deps.store.hasIntegrationRepairTransientUse(repair.repairId, {
					integrationHead: verification.request.integrationHead,
					integrationTree: verification.request.integrationTree,
					canonicalGatesSha256: sha256(stableJson(repair.effectiveGates)),
				})) throw new Error("Transient verification recovery allows one unchanged retry for this evidence chain");
				if ((repair.state === "failed" || repair.state === "paused") && currentClassification) {
					throw new Error("Integration repair classification episode is already selected; a new failed successor must open a new episode");
				}
				if (repair.state === "failed" || repair.state === "paused") {
					if (!repair.episodeId || repair.episodeRequestId !== verification.request.requestId) throw new Error("Integration repair classification episode is stale");
				}
			}
			await validateFreshRepairBeginGitIdentity(deps, run, verification, repair);
			const beginEvidence = repair?.beginRefSnapshot && repair.beginRefSnapshotSha256
				? { snapshot: repair.beginRefSnapshot, sha256: repair.beginRefSnapshotSha256 }
				: beginNamespaceEvidence(verification.request.integrationHead);
			const round = classification === "code_defect" ? Math.max(1, (repair?.acceptedCodeRounds ?? 0) + 1) : (repair?.round ?? 1);
			deps.store.transaction(() => {
				if (!repair) {
					repair = deps.store.putIntegrationRepair({
						repairId: input.repairId || randomUUID(),
						runId: run.runId,
						generation: run.currentGeneration,
						requestId: input.requestId,
						requestSha256: input.requestSha256,
						ownerSessionId,
						capabilityDigest: integrationRepairCapabilityDigest(input.capabilityToken),
						beginRefSnapshot: beginEvidence.snapshot,
						beginRefSnapshotSha256: beginEvidence.sha256,
						classification,
						state: decisionOnly ? "paused" : "active",
						round,
						parentCommit: verification.request.integrationHead,
						currentTree: verification.request.integrationTree,
						canonicalGates: verification.manifest?.gates ?? [],
						canonicalGatesSha256: sha256(stableJson(verification.manifest?.gates ?? [])),
						effectiveGates: verification.manifest?.gates ?? [],
						operationId,
						operationPayloadSha256: inputHash,
						detail: detail ?? null,
						episode: {
							integrationHead: verification.request.integrationHead,
							integrationTree: verification.request.integrationTree,
							canonicalGates: verification.manifest?.gates ?? [],
							canonicalGatesSha256: sha256(stableJson(verification.manifest?.gates ?? [])),
						},
					});
				} else {
					repair = deps.store.updateIntegrationRepair(repair.repairId, {
						requestId: input.requestId,
						requestSha256: input.requestSha256,
						ownerSessionId,
						capabilityDigest: integrationRepairCapabilityDigest(input.capabilityToken),
						beginRefSnapshot: beginEvidence.snapshot,
						beginRefSnapshotSha256: beginEvidence.sha256,
						state: decisionOnly ? "paused" : "active",
						round,
						successorRequestId: null,
						successorRequestSha256: null,
						successorManifest: null,
						successorManifestSha256: null,
						operationId,
						operationPayloadSha256: inputHash,
						detail: detail ?? null,
					});
					repair = deps.store.selectIntegrationRepairEpisode(repair.repairId, {
						classification,
						operationId,
						operationPayloadSha256: inputHash,
						state: decisionOnly ? "paused" : "active",
					});
				}
				deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "begin", inputHash, repairAuditEvidence(input));
				deps.updateRun({
					status: "paused",
					terminalDetail: decisionOnly
						? `Integration repair classification ${classification} is recorded; awaiting an explicit user decision.`
						: `Integration repair round ${repair!.round} is authorized for the owning main session.`,
				});
			});
			return deps.reply();
		}

		if (!repair) throw new Error("Integration repair begin must precede finish or cancel");
		validateRepairSession(input.ownerSessionId, repair.ownerSessionId);
		if (![repair.requestId, repair.successorRequestId].includes(input.requestId) && !historicalFinishReplay) throw new Error("Integration repair request is not the active transaction request");
		const finishRepair = repair;
		const validateFinishReplayNamespace = async (): Promise<void> => {
			const replayDriver = deps.driver(run);
			await replayDriver.verifyCheckout(run.checkoutStateToken);
			const replayBeginRefSnapshot = repairBeginRefSnapshot(finishRepair);
			const expectedCommit = (finishRepair.currentCommit ?? finishRepair.parentCommit).toLowerCase();
			if (!input.observedCommit || input.observedCommit.toLowerCase() !== expectedCommit) {
				throw new Error(`Integration repair replay observed commit changed: expected ${expectedCommit}`);
			}
			replayDriver.validateIntegrationRepairNamespace({
				beginRefSnapshot: replayBeginRefSnapshot,
				beginRefSnapshotSha256: finishRepair.beginRefSnapshotSha256!,
				expectedIntegrationHead: expectedCommit,
				expectedWorktreeHead: expectedCommit,
			});
			if (finishRepair.currentTree && replayDriver.worktreeTree(run.integrationWorktree) !== finishRepair.currentTree) {
				throw new Error(`Integration repair replay tree changed: expected ${finishRepair.currentTree}`);
			}
			if (finishRepair.classification === "code_defect") {
				if (!input.allowedPaths || input.allowedPaths.length === 0) throw new Error("Code-defect integration repair replay requires recorded failure-related paths");
				replayDriver.validateIntegrationRepairCommit({
					parent: finishRepair.parentCommit,
					round: finishRepair.round,
					currentHead: finishRepair.round > 1 ? finishRepair.supersededCommits.at(-1) ?? null : null,
					replayHead: expectedCommit,
					supersededCommits: finishRepair.supersededCommits,
					observedCommit: input.observedCommit,
					allowedPaths: input.allowedPaths,
					beginRefSnapshot: replayBeginRefSnapshot,
					beginRefSnapshotSha256: finishRepair.beginRefSnapshotSha256!,
				});
			} else if (replayDriver.worktreeStatus(run.integrationWorktree)) {
				throw new Error("Manifest or transient integration repair replay requires the assigned worktree to be clean");
			}
		};
		if (input.operation === "finish" && finishRepair.state === "passed") {
			if (finishRepair.operationId !== operationId || finishRepair.operationPayloadSha256 !== inputHash) {
				throw new Error("Integration repair finish was replayed with different durable evidence");
			}
			await validateFinishReplayNamespace();
		}
		if (repair.state === "passed" || repair.state === "cancelled") return deps.reply();
		if (input.operation === "cancel") {
			if (!["active", "committing", "committed", "verifying", "failed", "paused", "interrupted"].includes(repair.state)) return deps.reply();
			const driver = deps.driver(run);
			await driver.verifyCheckout(run.checkoutStateToken);
			const expectedHead = repair.currentCommit ?? repair.parentCommit;
			if (driver.branchHead(run.integrationBranch) !== expectedHead || driver.worktreeHead(run.integrationWorktree) !== expectedHead || driver.worktreeStatus(run.integrationWorktree)) {
				throw new Error("Integration repair cannot be cancelled after the assigned worktree changed");
			}
			deps.store.transaction(() => {
				deps.store.updateIntegrationRepair(repair!.repairId, { state: "cancelled", detail: input.detail ?? "Integration repair cancelled by the owning main session." });
				deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "cancel", repairInputHash(input), repairAuditEvidence(input));
				deps.updateRun({ status: "paused", terminalDetail: input.detail ?? "Integration repair cancelled; awaiting user choice." });
			});
			return deps.reply();
		}

		const beginRefSnapshot = repairBeginRefSnapshot(repair);
		const beginRefSnapshotSha256 = repair.beginRefSnapshotSha256!;
		if (!["active", "committing", "committed", "verifying", "failed", "paused", "interrupted"].includes(repair.state)) return deps.reply();
		if (["failed", "paused", "interrupted"].includes(repair.state)) {
			if (historicalFinishReplay) {
				await validateFinishReplayNamespace();
				return deps.reply();
			}
			if (repair.operationId === operationId) {
				if (input.operation === "finish") {
					if (repair.operationPayloadSha256 !== inputHash) throw new Error("Integration repair finish was replayed with different durable evidence");
					await validateFinishReplayNamespace();
				}
				return deps.reply();
			}
			throw new Error("Integration repair finish requires a new begin transition after a failed round");
		}
		if (repair.state === "verifying" || repair.state === "committed") {
			// A committed successor is already the durable recovery boundary. Never
			// rebuild one from a finish caller when any part of its evidence is absent.
			const successor = validateDurableRepairSuccessor(deps.store, repair);
			if (repair.operationId && (repair.operationId !== operationId || repair.operationPayloadSha256 !== inputHash)) {
				throw new Error("Integration repair finish was replayed with different durable evidence");
			}
			await validateFinishReplayNamespace();
			if (successor.verification.state === "passed" || successor.verification.state === "failed") return deps.reply();
			if (repair.state === "committed") deps.store.updateIntegrationRepair(repair.repairId, { state: "verifying" });
			await deps.verification(successor.manifest);
			return deps.reply();
		}
		const classification = repair.classification;
		if (!classification) throw new Error("Integration repair has no durable classification");
		if (!input.observedCommit) throw new Error("Integration repair finish requires the observed integration commit identity");
		if (classification === "code_defect" && (!input.allowedPaths || input.allowedPaths.length === 0)) {
			throw new Error("Code-defect integration repair finish requires recorded failure-related paths");
		}
		if (repair.state === "committing"
			&& (repair.operationId !== operationId || repair.operationPayloadSha256 !== inputHash)) {
			throw new Error("Integration repair finish was replayed with different durable evidence");
		}
		// Normalize every input-dependent part of the successor and validate the
		// already-authored commit before recording finish intent or changing repair state.
		const preparedGateProgram = prepareRepairGateProgram(verification, repair, input);
		const driver = deps.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		driver.validateIntegrationRepairNamespace({ beginRefSnapshot, beginRefSnapshotSha256 });
		let head = repair.currentCommit ?? repair.parentCommit;
		let tree = repair.currentTree ?? verification.request.integrationTree;
		let superseded = [...repair.supersededCommits];
		if (classification === "code_defect") {
			const replayHead = null;
			const durableCurrentHead = repair.round > 1
				? (replayHead ? repair.supersededCommits.at(-1) ?? null : repair.currentCommit)
				: null;
			const commit = driver.validateIntegrationRepairCommit({
				parent: repair.parentCommit,
				round: repair.round,
				currentHead: durableCurrentHead,
				replayHead,
				supersededCommits: repair.supersededCommits,
				observedCommit: input.observedCommit,
				allowedPaths: input.allowedPaths,
				beginRefSnapshot,
				beginRefSnapshotSha256,
			});
			head = commit.head;
			tree = commit.tree;
			if (commit.supersededHead && !superseded.includes(commit.supersededHead)) superseded.push(commit.supersededHead);
		} else {
			const expectedHead = (repair.currentCommit ?? repair.parentCommit).toLowerCase();
			if (input.observedCommit.toLowerCase() !== expectedHead || driver.branchHead(run.integrationBranch).toLowerCase() !== expectedHead || driver.worktreeHead(run.integrationWorktree).toLowerCase() !== expectedHead || driver.worktreeStatus(run.integrationWorktree)) {
				throw new Error(`${classification} recovery cannot mutate the frozen integration tree`);
			}
			head = repair.currentCommit ?? repair.parentCommit;
			tree = driver.worktreeTree(run.integrationWorktree);
		}
		const acceptedCodeRounds = classification === "code_defect"
			? Math.max(repair.acceptedCodeRounds, repair.round)
			: repair.acceptedCodeRounds;
		const transientEvidenceSha256 = sha256(stableJson({
			integrationHead: repair.episodeIntegrationHead ?? verification.request.integrationHead,
			integrationTree: repair.episodeIntegrationTree ?? verification.request.integrationTree,
			canonicalGatesSha256: repair.episodeCanonicalGatesSha256 ?? sha256(stableJson(preparedGateProgram.gates)),
		}));
		deps.store.transaction(() => {
			deps.store.updateIntegrationRepair(repair!.repairId, { state: "committing", operationId, operationPayloadSha256: inputHash });
			deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "finish-intent", inputHash, repairAuditEvidence(input));
		});
		const gateManifest = repairGateManifest(verification, repair, preparedGateProgram, head, tree);
		// Commit lineage and the canonical successor are one durable transition.
		// A restart can therefore observe either the pre-commit active state or a
		// verifying repair that already has exactly one successor request.
		deps.store.transaction(() => {
			deps.store.putVerificationRequest(gateManifest.request);
			deps.store.updateIntegrationRepair(repair!.repairId, {
				state: "verifying",
				currentCommit: head,
				currentTree: tree,
				acceptedCodeRounds,
				supersededCommits: superseded,
				effectiveGates: gateManifest.gates,
				successorRequestId: gateManifest.request.requestId,
				successorRequestSha256: gateManifest.request.requestSha256,
				successorManifest: gateManifest.manifest,
				successorManifestSha256: gateManifest.manifestSha256,
				detail: "Accepted repair commit; replaying the retained ordered verification program.",
			});
			if (classification === "transient") {
				deps.store.markIntegrationRepairEpisodeTransientUsed(repair!.repairId, repair!.episodeId!, transientEvidenceSha256);
			}
			deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "commit", inputHash, { head, tree, parent: repair!.parentCommit, supersededCommits: superseded });
			deps.store.recordIntegrationRepairAudit(repair!.repairId, operationId, "successor", inputHash, {
				requestId: gateManifest.request.requestId,
				requestSha256: gateManifest.request.requestSha256,
				manifestSha256: gateManifest.manifestSha256,
				gates: gateManifest.gates,
			});
			deps.updateRun({ status: "paused", terminalDetail: "Executing the authoritative verification program after integration repair." });
		});
		const result = await deps.verification(gateManifest.manifest);
		const successor = deps.store.getVerificationByRequestId(gateManifest.request.requestId);
		if (successor?.state === "passed") {
			deps.store.updateIntegrationRepair(repair.repairId, { state: "passed", detail: "Successor verification passed." });
		} else if (successor?.state === "failed") {
			const paused = classification === "code_defect" && acceptedCodeRounds >= 3;
			deps.store.updateIntegrationRepair(repair.repairId, { state: paused ? "paused" : "failed", detail: paused ? "Three accepted code-repair commits exhausted the bounded code-repair budget; awaiting explicit user choice." : successor.terminalDetail });
		}
		return deps.reply();
	}

export function recordIntegrationRepairVerificationOutcome(store: RunStore, requestId: string, state: "passed" | "failed", detail: string | null): void {
		let repair = store.getIntegrationRepairForRequest(requestId);
		if (!repair) {
			if (state !== "failed") return;
			const verification = store.getVerificationByRequestId(requestId);
			if (!verification) return;
			// Record the failed request and its exact verification evidence before
			// any session claims a repair. Owner and begin-namespace authority stay
			// unbound until an authenticated begin operation supplies them.
			store.recordInitialIntegrationRepairFailure(verification, detail);
			return;
		}
		if (state === "passed") {
			store.updateIntegrationRepair(repair.repairId, { state: "passed", detail: "Successor verification passed." });
			return;
		}
		const verification = store.getVerificationByRequestId(requestId);
		const codeBudgetExhausted = repair.classification === "code_defect" && repair.acceptedCodeRounds >= 3;
		const lineageState: StoredIntegrationRepair["state"] = codeBudgetExhausted ? "paused" : "failed";
		const detailText = codeBudgetExhausted
			? "Three accepted code-repair commits exhausted the bounded code-repair budget; awaiting explicit user choice."
			: detail;
		if (repair.episodeId) store.closeIntegrationRepairEpisode(repair.repairId, repair.episodeId, "failed");
		if (verification) {
			const canonicalGates = verification.manifest?.gates ?? repair.effectiveGates;
			store.openIntegrationRepairEpisode({
				repairId: repair.repairId,
				requestId: verification.request.requestId,
				requestSha256: verification.request.requestSha256,
				integrationHead: verification.request.integrationHead,
				integrationTree: verification.request.integrationTree,
				canonicalGates,
				canonicalGatesSha256: sha256(stableJson(canonicalGates)),
				state: lineageState,
				round: repair.round,
				detail: detailText,
			});
		} else {
			store.updateIntegrationRepair(repair.repairId, { state: lineageState, detail: detailText });
		}
	}
