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
import { normalizeVerificationManifest } from "../core/verification.ts";
import { enableDashboardHostAccess } from "../dashboard/dashboard-host.ts";
import type { VerificationManifest, VerificationRequest } from "../shared/protocol.ts";
import {
	ensureService,
	executeManagerOperation,
	requestService,
	submitManagerOperationReliable,
	waitManagerOperation,
} from "../client/index.ts";

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

export async function invokeHerderTool(name: "herder_plan" | "herder_run" | "herder_submit" | "herder_verification", args: JsonObject): Promise<unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} requires an arguments object`);
	if (name === "herder_plan") return planTool(args);
	if (name === "herder_run") return runTool(args);
	if (name === "herder_verification") return verificationTool(args);
	return submitTool(args);
}
