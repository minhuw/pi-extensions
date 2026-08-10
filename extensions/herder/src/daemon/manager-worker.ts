import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { HerderRunManager, type EventInput, type PlanEditInput, type StartInput } from "../core/run-manager.ts";
import { buildDashboardStateBody } from "../dashboard/dashboard-state.ts";
import type { VerificationManifest } from "../shared/protocol.ts";

export interface ManagerWorkerCall {
	id: number;
	method: "reply" | "start" | "event" | "edit" | "stop" | "verification" | "auditScheduler" | "dashboardState";
	input?: unknown;
}

export interface ManagerWorkerResult {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const planDirectory = String((workerData as { planDirectory?: unknown } | undefined)?.planDirectory || "");
if (isMainThread || !parentPort || !planDirectory) throw new Error("Herder manager worker requires a plan directory.");
const port = parentPort;

// The manager core intentionally keeps synchronous Git and SQLite semantics
// (atomic transactions interleave with worktree checks). It runs here, off the
// HTTP thread, so the service stays responsive to /health no matter how long a
// reconciliation takes. Keep one manager and SQLite connection for this worker
// lifetime; the service queue serializes calls and run state remains durable.
const manager = new HerderRunManager(planDirectory);
let queue = Promise.resolve();

async function handle(call: ManagerWorkerCall): Promise<void> {
	try {
		let result: unknown;
		if (call.method === "reply") result = manager.reply();
		else if (call.method === "start") result = await manager.start(call.input as StartInput);
		else if (call.method === "event") result = await manager.event(call.input as EventInput);
		else if (call.method === "edit") result = await manager.edit(call.input as PlanEditInput);
		else if (call.method === "stop") result = manager.stop();
		else if (call.method === "verification") result = await manager.verification(call.input as VerificationManifest);
		else if (call.method === "auditScheduler") result = await manager.auditScheduler({ includeReply: false });
		else if (call.method === "dashboardState") result = buildDashboardStateBody({ planDir: planDirectory });
		else throw new Error(`Unknown Herder manager method ${JSON.stringify(call.method)}.`);
		port.postMessage({ id: call.id, ok: true, result } satisfies ManagerWorkerResult);
	} catch (error) {
		port.postMessage({ id: call.id, ok: false, error: message(error) } satisfies ManagerWorkerResult);
	}
}

port.on("message", (call: ManagerWorkerCall) => {
	queue = queue.then(() => handle(call), () => handle(call));
});
port.once("close", () => manager.close());
