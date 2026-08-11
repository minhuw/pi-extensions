import { randomUUID } from "node:crypto";
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
import { normalizeVerificationManifest } from "../core/verification.ts";
import { enableDashboardHostAccess } from "../dashboard/dashboard-host.ts";
import type { VerificationManifest, VerificationRequest } from "../shared/protocol.ts";
import {
	ensureService,
	executeManagerOperation,
	requestService,
	submitManagerOperationReliable,
	waitManagerOperation,
	withServiceExclusion,
} from "../client/index.ts";
import { RunStore } from "../daemon/run-store.ts";
import { stableJson } from "../shared/protocol.ts";

type JsonObject = Record<string, unknown>;

function requiredString(args: JsonObject, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	return value.trim();
}

function planDirectory(args: JsonObject): string {
	return path.resolve(requiredString(args, "planDirectory"));
}

async function planTool(args: JsonObject): Promise<unknown> {
	const operation = requiredString(args, "operation");
	const directory = planDirectory(args);
	if (["begin_edit", "finish_edit", "cancel_edit"].includes(operation)) {
		return executeManagerOperation(directory, "edit", {
			operation: operation === "begin_edit" ? "begin" : operation === "finish_edit" ? "finish" : "cancel",
			...(operation === "begin_edit" ? { planId: requiredString(args, "planId") } : { editToken: requiredString(args, "editToken") }),
		});
	}
	if (operation === "init") return initPlanDir(directory, { track: args.track === true });
	if (operation === "validate" || operation === "status") return buildGraph(directory);
	if (operation === "shape") return getShapeReport(directory);
	if (operation === "snapshot") return snapshotPlan(directory, requiredString(args, "planId"));
	if (operation === "report") return getExecutionReport(directory, typeof args.planId === "string" ? args.planId : "RUN");
	if (operation === "track" || operation === "untrack") return setTracking(directory, operation === "track");
	if (operation === "ready") {
		const graph = buildGraph(directory);
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
	try { await enableDashboardHostAccess({ url: service.forwardedUrl || service.dashboardUrl }); }
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

async function submitTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	const kind = requiredString(args, "kind");
	if (!["dispatch_results", "terminals", "user_input"].includes(kind)) throw new Error(`Unknown submit kind: ${kind}`);
	const eventId = String(args.eventId || randomUUID());
	return { ok: true, reply: await executeManagerOperation(directory, "event", {
		eventId,
		kind,
		...(kind === "dispatch_results" ? { dispatchResults: args.dispatchResults } : {}),
		...(kind === "terminals" ? { terminals: args.terminals } : {}),
		...(kind === "user_input" ? { userInput: args.userInput } : {}),
	}, `event:${eventId}`) };
}

async function verificationTool(args: JsonObject): Promise<unknown> {
	const directory = planDirectory(args);
	return { ok: true, reply: await executeManagerOperation(directory, "verification", args.manifest) };
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

export async function waitHerderOperation(pending: PendingHerderOperation): Promise<unknown> {
	let service = await ensureService(pending.planDirectory);
	for (;;) {
		try { return await waitManagerOperation(service, pending.operationId); }
		catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (!/fetch failed|ECONNREFUSED|ECONNRESET|socket|operation-not-found/i.test(text)) throw error;
			service = await ensureService(pending.planDirectory);
		}
	}
}

export type CleanupDurableStatus = "complete" | "failed" | "stopped" | "active" | "missing";

export interface CleanupApplicationRequest {
	repositoryRoot: string;
	planDirectory: string;
	planId?: string;
	includeFailed?: boolean;
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
	readStatus?: (planDirectory: string) => CleanupDurableStatus | Promise<CleanupDurableStatus>;
	withExclusion?: <T>(planDirectory: string, callback: () => Promise<T> | T) => Promise<T>;
}

const CLEANUP_TERMINAL_STATUSES = new Set<CleanupDurableStatus>(["complete", "failed", "stopped"]);

export function readCleanupDurableStatus(planDirectory: string): CleanupDurableStatus {
	let store: RunStore | undefined;
	try {
		store = new RunStore(planDirectory, { readOnly: true });
		const run = store.getRun();
		if (!run) return "missing";
		return CLEANUP_TERMINAL_STATUSES.has(run.status as CleanupDurableStatus)
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

export function selectCleanupPlanIds(
	graph: ReturnType<typeof buildGraph>,
	request: Pick<CleanupApplicationRequest, "planId" | "includeFailed">,
): { selectedPlanIds: string[]; failedPlanIds: string[] } {
	const requested = request.planId === undefined ? undefined : cleanupPlanId(request.planId);
	if (requested && !graph.plans.some((plan) => plan.id === requested)) {
		throw new Error(`Plan ${requested} is not indexed in ${graph.readme}`);
	}
	const selected = graph.plans.filter((plan) => {
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
		for (const item of outcome.result.finalization.blockers) {
			const reason = typeof item.reason === "string" ? item.reason : "cleanup-blocked";
			if (/^[a-z0-9][a-z0-9-]{0,48}$/i.test(reason)) reasons.add(reason.toLowerCase());
		}
	}
	return [...reasons].sort();
}

async function buildCleanupPreview(
	request: CleanupApplicationRequest,
	dependencies: CleanupApplicationDependencies,
): Promise<CleanupPreview> {
	const runner = dependencies.cleanupRunner ?? cleanupRun;
	const durableStatus = await (dependencies.readStatus ?? readCleanupDurableStatus)(request.planDirectory);
	const graph = buildGraph(request.planDirectory);
	const selection = selectCleanupPlanIds(graph, request);
	const outcomes: CleanupPreviewOutcome[] = [];
	for (const planId of selection.selectedPlanIds) {
		const status = graph.plans.find((plan) => plan.id === planId)?.status;
		const result = await runner({
			repo: request.repositoryRoot,
			planDir: request.planDirectory,
			plan: planId,
			dryRun: true,
			includeFailed: status === "BLOCKED" || status === "REJECTED",
			finalize: false,
			handoffTarget: null,
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
			finalize: false,
			handoffTarget: null,
			pretty: false,
		});
		outcomes.push({
			planId: result.plan ?? "RUN",
			status: result.plan ? cleanupResultStatus(result, graph) : "UNKNOWN",
			result,
		});
	}
	const skippedPlanIds = [...new Set(outcomes.flatMap((outcome) => outcome.result.skipped
		.map((item) => typeof item.plan === "string" ? item.plan : "")
		.filter(Boolean)))].sort();
	const blockers = cleanupReasons(outcomes);
	if (!CLEANUP_TERMINAL_STATUSES.has(durableStatus)) blockers.unshift(durableStatus === "missing" ? "run-missing" : "run-not-terminal");
	const hasActions = outcomes.some((outcome) => outcome.result.actions.length > 0);
	if (selection.selectedPlanIds.length > 0 && !hasActions) blockers.push("no-eligible-actions");
	const normalizedPreview = stableJson({
		durableStatus,
		selectedPlanIds: selection.selectedPlanIds,
		failedPlanIds: selection.failedPlanIds,
		outcomes: outcomes.map((outcome) => ({ planId: outcome.planId, status: outcome.status, result: outcome.result })),
	});
	return {
		version: 1,
		durableStatus,
		terminal: CLEANUP_TERMINAL_STATUSES.has(durableStatus),
		canApply: CLEANUP_TERMINAL_STATUSES.has(durableStatus) && hasActions,
		selectedPlanIds: selection.selectedPlanIds,
		failedPlanIds: selection.failedPlanIds,
		skippedPlanIds,
		outcomes,
		blockers: [...new Set(blockers)],
		normalizedPreview,
	};
}

export async function previewHerderCleanup(
	request: CleanupApplicationRequest,
	dependencies: CleanupApplicationDependencies = {},
): Promise<CleanupPreview> {
	return buildCleanupPreview(request, dependencies);
}

export async function applyHerderCleanup(
	request: CleanupApplicationRequest,
	expectedPreview: CleanupPreview,
	dependencies: CleanupApplicationDependencies = {},
): Promise<CleanupApplyResult> {
	if (!expectedPreview.canApply) return { ...expectedPreview, executed: false };
	const runExclusion = dependencies.withExclusion ?? withServiceExclusion;
	return runExclusion(request.planDirectory, async () => {
		const fresh = await buildCleanupPreview(request, dependencies);
		if (!fresh.terminal || fresh.durableStatus !== expectedPreview.durableStatus) {
			throw new Error("Cleanup run status changed after confirmation; cleanup was not applied.");
		}
		if (fresh.normalizedPreview !== expectedPreview.normalizedPreview) {
			throw new Error("Cleanup preview changed after confirmation; cleanup was not applied.");
		}
		const runner = dependencies.cleanupRunner ?? cleanupRun;
		const graph = buildGraph(request.planDirectory);
		const applied: CleanupPreviewOutcome[] = [];
		for (const outcome of fresh.outcomes.filter((candidate) => fresh.selectedPlanIds.includes(candidate.planId))) {
			const status = graph.plans.find((plan) => plan.id === outcome.planId)?.status;
			if (status !== "DONE" && status !== "BLOCKED" && status !== "REJECTED") continue;
			const result = await runner({
				repo: request.repositoryRoot,
				planDir: request.planDirectory,
				plan: outcome.planId,
				dryRun: false,
				includeFailed: status === "BLOCKED" || status === "REJECTED",
				finalize: false,
				handoffTarget: null,
				pretty: false,
			});
			applied.push({ ...outcome, result });
		}
		return { ...fresh, outcomes: applied, executed: applied.some((outcome) => outcome.result.removed.length > 0) };
	});
}

export const previewCleanup = previewHerderCleanup;
export const applyCleanup = applyHerderCleanup;

export async function invokeHerderTool(name: "herder_plan" | "herder_run" | "herder_submit" | "herder_verification", args: JsonObject): Promise<unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} requires an arguments object`);
	if (name === "herder_plan") return planTool(args);
	if (name === "herder_run") return runTool(args);
	if (name === "herder_verification") return verificationTool(args);
	return submitTool(args);
}
