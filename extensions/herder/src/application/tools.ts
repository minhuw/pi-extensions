import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	buildGraph,
	getExecutionReport,
	getShapeReport,
	initPlanDir,
	setTracking,
	snapshotPlan,
} from "../core/plans.ts";
import { cleanupRun, type CleanupInput, type CleanupResult } from "../daemon/git/cleanup-run.ts";
import { forceCleanupRun, type ForceCleanupInput } from "../daemon/git/force-cleanup-run.ts";
import { resetHerderPlanSet, type HerderResetInput, type HerderResetResult } from "../daemon/git/reset-plan-set.ts";
import { normalizeVerificationManifest } from "../core/verification.ts";
import { enableDashboardHostAccess } from "../dashboard/dashboard-host.ts";
import type { AttentionResolutionInput, IntegrationRepairInput, VerificationManifest, VerificationRequest } from "../shared/protocol.ts";
import {
	ensureService,
	executeManagerOperation,
	requestService,
	submitManagerOperationReliable,
	waitManagerOperationReliable,
	withServiceExclusion,
} from "../client/index.ts";
import { compileGraphIdentity } from "../core/run-manager.ts";
import { RunStore } from "../daemon/run-store.ts";
import { applyLifecycleToGraph, readPlanLifecycle, readPlanLifecycleGraph } from "../core/workflow.ts";
import { isTerminalRunStatus, sha256, stableJson } from "../shared/protocol.ts";

type JsonObject = Record<string, unknown>;

function requiredString(args: JsonObject, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	return value.trim();
}

function planDirectory(args: JsonObject): string {
	return path.resolve(requiredString(args, "planDirectory"));
}

function withCompiledGraphIdentity<T extends object>(graph: ReturnType<typeof buildGraph>, value: T): T & { graphSha256: string } {
	return { ...value, graphSha256: compileGraphIdentity(graph) };
}

export interface LiveRunFreshness {
	runId: string;
	status: string;
	pendingOperations: number;
}

export function readLiveRunFreshness(planDirectoryInput: string): LiveRunFreshness | null {
	let store: RunStore | undefined;
	try {
		store = new RunStore(path.resolve(planDirectoryInput), { readOnly: true });
		const run = store.getRun();
		if (!run) return null;
		return {
			runId: run.runId,
			status: run.status,
			pendingOperations: store.countPendingOperations(),
		};
	} catch {
		return null;
	} finally {
		store?.close();
	}
}

async function planTool(args: JsonObject): Promise<unknown> {
	const operation = requiredString(args, "operation");
	const directory = planDirectory(args);
	if (operation === "attention") {
		const { operation: _operation, planDirectory: _planDirectory, ...resolution } = args;
		return submitTool({ planDirectory: directory, kind: "attention", ...resolution, schemaVersion: 1 });
	}
	if (["begin_edit", "prepare_edit", "confirm_edit", "finish_edit", "cancel_edit"].includes(operation)) {
		const editOperation = operation.replace(/_edit$/, "") as "begin" | "prepare" | "confirm" | "finish" | "cancel";
		return executeManagerOperation(directory, "edit", {
			operation: editOperation,
			...(editOperation === "begin" ? {
				planId: requiredString(args, "planId"),
				...(args.intent === "rework" ? { intent: "rework", editToken: randomUUID() } : {}),
			} : { editToken: requiredString(args, "editToken") }),
		});
	}
	if (operation === "init") return initPlanDir(directory, { track: args.track === true });
	if (operation === "validate") {
		const graph = buildGraph(directory);
		return withCompiledGraphIdentity(graph, graph);
	}
	if (operation === "status") return readPlanLifecycleGraph(directory);
	if (operation === "shape") {
		const graph = buildGraph(directory);
		return withCompiledGraphIdentity(graph, getShapeReport(directory));
	}
	if (operation === "snapshot") return snapshotPlan(directory, requiredString(args, "planId"));
	if (operation === "report") return getExecutionReport(directory, typeof args.planId === "string" ? args.planId : "RUN");
	if (operation === "track" || operation === "untrack") return setTracking(directory, operation === "track");
	if (operation === "ready") {
		const graph = readPlanLifecycleGraph(directory);
		return {
			planDir: graph.planDir,
			ready: graph.ready,
			inProgress: graph.inProgress,
			blocked: graph.blocked,
			waiting: graph.waiting,
			complete: graph.complete,
		};
	}
	throw new Error(`Unknown plan operation: ${operation}`);
}

async function openDashboard(service: Awaited<ReturnType<typeof ensureService>>): Promise<void> {
	try { await enableDashboardHostAccess({ url: service.dashboardUrl }); }
	catch { /* Host integration is best-effort and must not block manager controls. */ }
}

async function runTool(args: JsonObject): Promise<unknown> {
	const operation = requiredString(args, "operation");
	const directory = planDirectory(args);
	const service = await ensureService(directory, args.dashboardPort === undefined ? {} : { dashboardPort: Number(args.dashboardPort) });
	if (operation === "status") return requestService(service, "/v1/status");
	if (operation === "dashboard") {
		await openDashboard(service);
		return requestService(service, "/v1/status");
	}
	if (operation === "stop") return { ok: true, reply: await executeManagerOperation(directory, "stop", {}) };
	if (!["fire", "resume", "revise"].includes(operation)) throw new Error(`Unknown run operation: ${operation}`);
	await executeManagerOperation(directory, "start", {
		mode: operation,
		repositoryRoot: path.resolve(requiredString(args, "repositoryRoot")),
		planDirectory: directory,
		...(args.planName ? { planName: String(args.planName) } : {}),
		...(args.profile ? { profile: String(args.profile) } : {}),
		...(args.maxParallel === undefined ? {} : { maxParallel: Number(args.maxParallel) }),
	});
	const currentService = await ensureService(directory);
	await openDashboard(currentService);
	return requestService(currentService, "/v1/status");
}

export function attentionResolutionFromArgs(args: JsonObject): AttentionResolutionInput {
	const nested = args.attention;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		return { ...nested, schemaVersion: 1 } as AttentionResolutionInput;
	}
	const { planDirectory: _planDirectory, kind: _kind, eventId: _eventId, operation: _operation, ...resolution } = args;
	return { ...resolution, schemaVersion: 1 } as unknown as AttentionResolutionInput;
}

async function submitTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	const kind = requiredString(args, "kind");
	if (!["dispatch_results", "terminals", "user_input", "attention"].includes(kind)) throw new Error(`Unknown submit kind: ${kind}`);
	const attentionKind = kind === "attention";
	const attentionRequestId = kind === "user_input"
		? requiredString(args, "attentionRequestId")
		: attentionKind ? String((attentionResolutionFromArgs(args) as { requestId?: unknown }).requestId || "") : undefined;
	const resolution = attentionKind ? attentionResolutionFromArgs(args) : undefined;
	const eventId = String(args.eventId || (attentionRequestId ? `attention:${sha256(stableJson(resolution ?? attentionRequestId))}` : randomUUID()));
	return { ok: true, reply: await executeManagerOperation(directory, "event", {
		eventId,
		kind,
		...(kind === "dispatch_results" ? { dispatchResults: args.dispatchResults } : {}),
		...(kind === "terminals" ? { terminals: args.terminals } : {}),
		...(kind === "user_input" ? {
			userInput: args.userInput,
			...(attentionRequestId ? { attentionRequestId } : {}),
		} : {}),
		...(attentionKind ? { attention: resolution } : {}),
	}, `event:${eventId}`) };
}

function integrationRepairPayload(args: JsonObject): IntegrationRepairInput {
	if (Object.prototype.hasOwnProperty.call(args, "commitMessage")) throw new Error("Integration repair commitMessage is not accepted; the owning session must author the commit");
	const operation = requiredString(args, "operation") as IntegrationRepairInput["operation"];
	return {
		schemaVersion: 1,
		operation,
		...(args.operationId === undefined ? {} : { operationId: String(args.operationId) }),
		requestId: requiredString(args, "requestId"),
		requestSha256: requiredString(args, "requestSha256"),
		capabilityToken: requiredString(args, "capabilityToken"),
		...(args.repairId === undefined ? {} : { repairId: String(args.repairId) }),
		...(args.runId === undefined ? {} : { runId: String(args.runId) }),
		...(args.generation === undefined ? {} : { generation: Number(args.generation) }),
		...(args.ownerSessionId === undefined ? {} : { ownerSessionId: String(args.ownerSessionId) }),
		...(args.classification === undefined ? {} : { classification: String(args.classification) }),
		...(args.rationale === undefined ? {} : { rationale: String(args.rationale) }),
		...(args.detail === undefined ? {} : { detail: String(args.detail) }),
		...(args.gates === undefined ? {} : { gates: args.gates as VerificationManifest["gates"] }),
		...(args.gateAdditions === undefined ? {} : { gateAdditions: args.gateAdditions as VerificationManifest["gates"] }),
		...(args.allowedPaths === undefined ? {} : { allowedPaths: args.allowedPaths as string[] }),
		...(args.observedCommit === undefined ? {} : { observedCommit: String(args.observedCommit) }),
	};
}

async function verificationTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	return { ok: true, reply: await executeManagerOperation(directory, "verification", args.manifest) };
}

async function integrationRepairTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	return { ok: true, reply: await executeManagerOperation(directory, "integration_repair", integrationRepairPayload(args)) };
}

function reignitePayload(args: JsonObject): JsonObject {
	return {
		requestId: requiredString(args, "requestId"),
		requestSha256: requiredString(args, "requestSha256"),
		state: requiredString(args, "state"),
		...(args.graphSha256 === undefined ? {} : { graphSha256: String(args.graphSha256) }),
		...(args.detail === undefined ? {} : { detail: String(args.detail) }),
	};
}

async function reigniteTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	return { ok: true, reply: await executeManagerOperation(directory, "reignite", reignitePayload(args)) };
}

export interface PendingHerderOperation {
	planDirectory: string;
	operationId: string;
}

export function prepareHerderVerificationManifest(request: VerificationRequest, manifest: VerificationManifest): VerificationManifest {
	return normalizeVerificationManifest(request, manifest).manifest;
}

export async function submitHerderVerification(args: JsonObject): Promise<PendingHerderOperation> {
	const directory = planDirectory(args);
	const receipt = await submitManagerOperationReliable(directory, "verification", args.manifest, String(args.operationId || randomUUID()));
	return { planDirectory: directory, operationId: receipt.operationId };
}

export async function submitHerderIntegrationRepair(args: JsonObject): Promise<PendingHerderOperation> {
	const directory = planDirectory(args);
	const receipt = await submitManagerOperationReliable(directory, "integration_repair", integrationRepairPayload(args), String(args.operationId || randomUUID()));
	return { planDirectory: directory, operationId: receipt.operationId };
}

export async function submitHerderReignite(args: JsonObject): Promise<PendingHerderOperation> {
	const directory = planDirectory(args);
	const receipt = await submitManagerOperationReliable(directory, "reignite", reignitePayload(args), String(args.operationId || randomUUID()));
	return { planDirectory: directory, operationId: receipt.operationId };
}

export async function waitHerderOperation(pending: PendingHerderOperation): Promise<unknown> {
	return waitManagerOperationReliable(pending.planDirectory, pending.operationId);
}

export type CleanupDurableStatus = "complete" | "failed" | "stopped" | "active" | "missing";

export interface CleanupApplicationRequest {
	repositoryRoot: string;
	planDirectory: string;
	planId?: string;
	includeFailed?: boolean;
	deep?: boolean;
	force?: boolean;
}

export interface CleanupPreviewOutcome {
	planId: string;
	status: "DONE" | "BLOCKED" | "REJECTED" | "UNKNOWN";
	result: CleanupResult;
}

export interface CleanupPreview {
	version: 1;
	durableStatus: CleanupDurableStatus;
	terminal: boolean;
	canApply: boolean;
	force: boolean;
	selectedPlanIds: string[];
	failedPlanIds: string[];
	skippedPlanIds: string[];
	outcomes: CleanupPreviewOutcome[];
	blockers: string[];
	normalizedPreview: string;
}

export interface CleanupApplyResult extends CleanupPreview {
	executed: boolean;
}

export interface CleanupApplicationDependencies {
	cleanupRunner?: (input: CleanupInput) => CleanupResult | Promise<CleanupResult>;
	forceRunner?: (input: ForceCleanupInput) => CleanupResult | Promise<CleanupResult>;
	readStatus?: (planDirectory: string) => CleanupDurableStatus | Promise<CleanupDurableStatus>;
	withExclusion?: <T>(planDirectory: string, callback: () => Promise<T> | T) => Promise<T>;
}

export function readCleanupDurableStatus(planDirectory: string): CleanupDurableStatus {
	let store: RunStore | undefined;
	try {
		store = new RunStore(planDirectory, { readOnly: true });
		const run = store.getRun();
		if (!run) return "missing";
		return isTerminalRunStatus(run.status)
			? run.status as CleanupDurableStatus
			: "active";
	} catch {
		return "missing";
	} finally {
		store?.close();
	}
}

function cleanupPlanId(value: string): string {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid cleanup plan ID: ${value}`);
	const number = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(number)) throw new Error(`Invalid cleanup plan ID: ${value}`);
	return String(number).padStart(3, "0");
}

function graphWithLifecycle(graph: ReturnType<typeof buildGraph>): ReturnType<typeof buildGraph> {
	return applyLifecycleToGraph(graph, readPlanLifecycle(graph.planDir, graph));
}

export function selectCleanupPlanIds(
	graph: ReturnType<typeof buildGraph>,
	request: Pick<CleanupApplicationRequest, "planId" | "includeFailed" | "deep" | "force">,
): { selectedPlanIds: string[]; failedPlanIds: string[] } {
	if (request.force && (request.deep || request.planId !== undefined || request.includeFailed)) {
		throw new Error("--force cannot be combined with --deep, --plan, or --include-failed");
	}
	if (request.deep && request.planId !== undefined) throw new Error("--deep cannot be combined with --plan");
	const requested = request.planId === undefined ? undefined : cleanupPlanId(request.planId);
	if (requested && !graph.plans.some((plan) => plan.id === requested)) {
		throw new Error(`Plan ${requested} is not indexed in ${graph.readme}`);
	}
	const plans = graph.plans;
	if (request.deep) {
		return {
			selectedPlanIds: plans.map((plan) => plan.id),
			failedPlanIds: plans
				.filter((plan) => plan.status === "BLOCKED" || plan.status === "REJECTED")
				.map((plan) => plan.id),
		};
	}
	const selected = plans.filter((plan) => {
		if (requested && plan.id !== requested) return false;
		if (plan.status === "DONE") return true;
		return Boolean(request.includeFailed) && (plan.status === "BLOCKED" || plan.status === "REJECTED");
	});
	return {
		selectedPlanIds: selected.map((plan) => plan.id),
		failedPlanIds: selected.filter((plan) => plan.status === "BLOCKED" || plan.status === "REJECTED").map((plan) => plan.id),
	};
}

function cleanupResultStatus(result: CleanupResult, graph: ReturnType<typeof buildGraph>): CleanupPreviewOutcome["status"] {
	const plan = result.plan ? graph.plans.find((candidate) => candidate.id === result.plan) : undefined;
	if (plan?.status === "DONE" || plan?.status === "BLOCKED" || plan?.status === "REJECTED") return plan.status;
	return "UNKNOWN";
}

function cleanupReasons(preview: CleanupPreviewOutcome[]): string[] {
	const reasons = new Set<string>();
	for (const outcome of preview) {
		for (const item of [...outcome.result.destruction.blockers]) {
			const reason = typeof item.reason === "string" ? item.reason : "cleanup-blocked";
			if (/^[a-z0-9][a-z0-9-]{0,48}$/i.test(reason)) reasons.add(reason.toLowerCase());
		}
	}
	return [...reasons].sort();
}

function cleanupGraphStatusSnapshot(graph: ReturnType<typeof buildGraph>): string {
	return stableJson(graph.plans.map((plan) => ({ planId: plan.id, status: plan.status })));
}

function cleanupExpectedPlanStatuses(
	graph: ReturnType<typeof buildGraph>,
	planIds: string[],
): NonNullable<CleanupInput["expectedPlanStatuses"]> {
	const expected: NonNullable<CleanupInput["expectedPlanStatuses"]> = {};
	const plans = graph.plans;
	for (const planId of planIds) {
		const status = plans.find((plan) => plan.id === planId)?.status;
		if (status !== "DONE" && status !== "BLOCKED" && status !== "REJECTED") {
			throw new Error(`Cleanup plan ${planId} is no longer terminal; cleanup was not applied.`);
		}
		expected[planId] = status;
	}
	return expected;
}

interface CleanupPreviewBuild {
	preview: CleanupPreview;
	graphStatusSnapshot: string;
}

function forcePreviewFromResult(
	durableStatus: CleanupDurableStatus,
	result: CleanupResult,
): CleanupPreviewBuild {
	const selectedPlanIds = [...new Set(result.actions
		.map((item) => typeof item.plan === "string" ? item.plan : "")
		.filter((value): value is string => Boolean(value)))].sort();
	const blockers = [...new Set(result.destruction.blockers
		.map((item) => typeof item.reason === "string" ? item.reason.toLowerCase() : "force-cleanup-blocked")
		.filter((reason) => /^[a-z0-9][a-z0-9-]{0,48}$/i.test(reason)))];
	const preview: CleanupPreview = {
		version: 1,
		durableStatus,
		terminal: isTerminalRunStatus(durableStatus),
		canApply: result.destruction.eligible && blockers.length === 0,
		force: true,
		selectedPlanIds,
		failedPlanIds: [],
		skippedPlanIds: [],
		outcomes: [{ planId: result.plan ?? "RUN", status: "UNKNOWN", result }],
		blockers,
		normalizedPreview: stableJson({
			durableStatus,
			force: true,
			blockers,
			selectedPlanIds,
			result,
		}),
	};
	return { preview, graphStatusSnapshot: "force" };
}

async function buildCleanupPreviewSnapshot(
	request: CleanupApplicationRequest,
	dependencies: CleanupApplicationDependencies,
): Promise<CleanupPreviewBuild> {
	const runner = dependencies.cleanupRunner ?? cleanupRun;
	const durableStatus = await (dependencies.readStatus ?? readCleanupDurableStatus)(request.planDirectory);
	const force = request.force === true;
	if (force) {
		if (request.deep || request.planId !== undefined || request.includeFailed) {
			throw new Error("--force cannot be combined with --deep, --plan, or --include-failed");
		}
		const result = await (dependencies.forceRunner ?? forceCleanupRun)({
			repo: request.repositoryRoot,
			planDir: request.planDirectory,
			dryRun: true,
		});
		return forcePreviewFromResult(durableStatus, result);
	}
	const graph = graphWithLifecycle(buildGraph(request.planDirectory));
	const deep = request.deep === true;
	if (deep && request.planId !== undefined) throw new Error("--deep cannot be combined with --plan");
	const selection = selectCleanupPlanIds(graph, request);
	const outcomes: CleanupPreviewOutcome[] = [];
	const includeFailed = Boolean(request.includeFailed);
	if (deep) {
		const result = await runner({
			repo: request.repositoryRoot,
			planDir: request.planDirectory,
			dryRun: true,
			includeFailed,
			deep: true,
			pretty: false,
		});
		outcomes.push({
			planId: result.plan ?? "RUN",
			status: result.plan ? cleanupResultStatus(result, graph) : "UNKNOWN",
			result,
		});
	} else {
		for (const planId of selection.selectedPlanIds) {
			const status = graph.plans.find((plan) => plan.id === planId)?.status;
			const result = await runner({
				repo: request.repositoryRoot,
				planDir: request.planDirectory,
				plan: planId,
				dryRun: true,
				includeFailed: includeFailed && (status === "BLOCKED" || status === "REJECTED"),
				deep: false,
				pretty: false,
			});
			outcomes.push({ planId, status: status === "DONE" || status === "BLOCKED" || status === "REJECTED" ? status : "UNKNOWN", result });
		}
		if (outcomes.length === 0) {
			const result = await runner({
				repo: request.repositoryRoot,
				planDir: request.planDirectory,
				...(request.planId === undefined ? {} : { plan: cleanupPlanId(request.planId) }),
				dryRun: true,
				includeFailed: false,
				deep: false,
				pretty: false,
			});
			outcomes.push({
				planId: result.plan ?? "RUN",
				status: result.plan ? cleanupResultStatus(result, graph) : "UNKNOWN",
				result,
			});
		}
	}

	const skippedPlanIds = [...new Set(outcomes.flatMap((outcome) => outcome.result.skipped
		.map((item) => typeof item.plan === "string" ? item.plan : "")
		.filter(Boolean)))].sort();
	const failedActionPlanIds = outcomes.flatMap((outcome) => outcome.result.actions
		.filter((item) => item.mode === "failed-evidence" && typeof item.plan === "string")
		.map((item) => String(item.plan)));
	const failedPlanIds = [...new Set([...selection.failedPlanIds, ...failedActionPlanIds])].sort();
	const blockers = cleanupReasons(outcomes);
	if (deep) blockers.push(...outcomes.flatMap((outcome) => outcome.result.destruction.blockers.map((item) => String(item.reason ?? "deep-cleanup-blocked"))));
	if (!isTerminalRunStatus(durableStatus)) blockers.unshift(durableStatus === "missing" ? "run-missing" : "run-not-terminal");
	if (!deep && !includeFailed && failedPlanIds.length > 0) blockers.push("failed-evidence-requires-include-failed");
	const hasActions = outcomes.some((outcome) => outcome.result.actions.length > 0
		|| (deep && (outcome.result.destruction.eligible)));
	if (selection.selectedPlanIds.length > 0 && !hasActions) blockers.push("no-eligible-actions");
	const uniqueBlockers = [...new Set(blockers)];
	const normalizedPreview = stableJson({
		durableStatus,
		deep,
		includeFailed,
		selectedPlanIds: selection.selectedPlanIds,
		failedPlanIds,
		blockers: uniqueBlockers,
		outcomes: outcomes.map((outcome) => ({ planId: outcome.planId, status: outcome.status, result: outcome.result })),
	});
	return {
		preview: {
			version: 1,
			durableStatus,
			terminal: isTerminalRunStatus(durableStatus),
			canApply: isTerminalRunStatus(durableStatus) && hasActions && uniqueBlockers.length === 0,
			force: false,
			selectedPlanIds: selection.selectedPlanIds,
			failedPlanIds,
			skippedPlanIds,
			outcomes,
			blockers: uniqueBlockers,
			normalizedPreview,
		},
		graphStatusSnapshot: cleanupGraphStatusSnapshot(graph),
	};
}

async function buildCleanupPreview(
	request: CleanupApplicationRequest,
	dependencies: CleanupApplicationDependencies,
): Promise<CleanupPreview> {
	return (await buildCleanupPreviewSnapshot(request, dependencies)).preview;
}

export async function previewHerderCleanup(
	request: CleanupApplicationRequest,
	dependencies: CleanupApplicationDependencies = {},
): Promise<CleanupPreview> {
	return buildCleanupPreview(request, dependencies);
}

async function applyForceCleanup(
	request: CleanupApplicationRequest,
	expectedPreview: CleanupPreview,
	dependencies: CleanupApplicationDependencies,
): Promise<CleanupApplyResult> {
	const apply = async (): Promise<CleanupApplyResult> => {
		const result = await (dependencies.forceRunner ?? forceCleanupRun)({
			repo: request.repositoryRoot,
			planDir: request.planDirectory,
			dryRun: false,
		});
		if (!result.destruction.eligible) {
			throw new Error(`Force cleanup refused: ${result.destruction.blockers.map((item) => String(item.reason ?? "blocked")).join(", ")}`);
		}
		const executed = result.removed.length > 0
			|| result.destruction.refsRemoved.length > 0
			|| result.destruction.integrationRemoved
			|| result.destruction.planDirectoryRemoved;
		return {
			...expectedPreview,
			outcomes: [{ planId: result.plan ?? "RUN", status: "UNKNOWN", result }],
			executed,
		};
	};
	const runExclusion = dependencies.withExclusion ?? ((planDirectory, callback) => withServiceExclusion(planDirectory, callback, { purpose: "force" }));
	if (!fs.existsSync(request.planDirectory)) return apply();
	return runExclusion(request.planDirectory, apply);
}

export async function applyHerderCleanup(
	request: CleanupApplicationRequest,
	expectedPreview: CleanupPreview,
	dependencies: CleanupApplicationDependencies = {},
): Promise<CleanupApplyResult> {
	if (!expectedPreview.canApply) return { ...expectedPreview, executed: false };
	if (request.force === true) return applyForceCleanup(request, expectedPreview, dependencies);
	const runExclusion = dependencies.withExclusion ?? withServiceExclusion;
	return runExclusion(request.planDirectory, async () => {
		const freshBuild = await buildCleanupPreviewSnapshot(request, dependencies);
		const fresh = freshBuild.preview;
		if (!fresh.terminal || fresh.durableStatus !== expectedPreview.durableStatus) {
			throw new Error("Cleanup run status changed after confirmation; cleanup was not applied.");
		}
		if (fresh.normalizedPreview !== expectedPreview.normalizedPreview) {
			throw new Error("Cleanup preview changed after confirmation; cleanup was not applied.");
		}
		let graph: ReturnType<typeof buildGraph>;
		let currentSelection: ReturnType<typeof selectCleanupPlanIds>;
		try {
			const currentGraph = buildGraph(request.planDirectory);
			graph = applyLifecycleToGraph(currentGraph, readPlanLifecycle(request.planDirectory, currentGraph));
			currentSelection = selectCleanupPlanIds(graph, request);
		} catch {
			throw new Error("Cleanup plan status or selection changed after confirmation; cleanup was not applied.");
		}
		if (
			freshBuild.graphStatusSnapshot !== cleanupGraphStatusSnapshot(graph)
			|| stableJson(currentSelection) !== stableJson({
				selectedPlanIds: fresh.selectedPlanIds,
				failedPlanIds: fresh.failedPlanIds,
			})
		) {
			throw new Error("Cleanup plan status or selection changed after confirmation; cleanup was not applied.");
		}
		const expectedPlanStatuses = cleanupExpectedPlanStatuses(
			graph,
			request.deep === true ? graph.plans.map((plan) => plan.id) : fresh.selectedPlanIds,
		);
		const runner = dependencies.cleanupRunner ?? cleanupRun;
		const applied: CleanupPreviewOutcome[] = [];
		if (request.deep === true) {
			const result = await runner({
				repo: request.repositoryRoot,
				planDir: request.planDirectory,
				dryRun: false,
				includeFailed: request.deep === true || Boolean(request.includeFailed),
				deep: true,
				expectedPlanStatuses,
				pretty: false,
			});
			const previewOutcome = fresh.outcomes[0];
			applied.push({
				planId: result.plan ?? previewOutcome?.planId ?? "RUN",
				status: previewOutcome?.status ?? "UNKNOWN",
				result,
			});
		} else {
			for (const outcome of fresh.outcomes.filter((candidate) => fresh.selectedPlanIds.includes(candidate.planId))) {
				const status = outcome.status;
				if (status !== "DONE" && status !== "BLOCKED" && status !== "REJECTED") continue;
				const result = await runner({
					repo: request.repositoryRoot,
					planDir: request.planDirectory,
					plan: outcome.planId,
					dryRun: false,
					includeFailed: fresh.failedPlanIds.includes(outcome.planId),
					deep: false,
					expectedPlanStatuses,
					pretty: false,
				});
				applied.push({ ...outcome, result });
			}
		}
		const executed = applied.some((outcome) => outcome.result.removed.length > 0
			|| outcome.result.destruction.refsRemoved.length > 0
			|| outcome.result.destruction.integrationRemoved);
		return { ...fresh, outcomes: applied, executed };
	});
}


export interface ResetApplicationRequest extends HerderResetInput {}

export async function applyHerderReset(
	request: ResetApplicationRequest,
	dependencies: { withExclusion?: <T>(planDirectory: string, callback: () => Promise<T> | T) => Promise<T> } = {},
): Promise<HerderResetResult> {
	const runExclusion = dependencies.withExclusion ?? ((planDirectory, callback) => withServiceExclusion(planDirectory, callback, { purpose: "reset" }));
	return runExclusion(request.planDirectory, () => resetHerderPlanSet(request));
}

export function invokeHerderTool(name: "herder_plan" | "herder_run" | "herder_submit" | "herder_verification" | "herder_integration_repair" | "herder_reignite", args: JsonObject): Promise<unknown>;
export async function invokeHerderTool(name: "herder_plan" | "herder_run" | "herder_submit" | "herder_verification" | "herder_integration_repair" | "herder_reignite", args: JsonObject): Promise<unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} requires an arguments object`);
	if (name === "herder_plan") return planTool(args);
	if (name === "herder_run") return runTool(args);
	if (name === "herder_verification") return verificationTool(args);
	if (name === "herder_integration_repair") return integrationRepairTool(args);
	if (name === "herder_reignite") return reigniteTool(args);
	return submitTool(args);
}
