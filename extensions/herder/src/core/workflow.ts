import type { PlanPhase, WorkerRole } from "../shared/protocol.ts";
import { RunStore, type StoredPlan, type StoredPlanSpec } from "../daemon/run-store.ts";
import { buildGraph, type PlanGraph, type PlanStatus } from "./plans.ts";

export interface RunOverview {
	total: number;
	done: number;
	rejected: number;
	inProgress: number;
	blocked: string[];
	ready: StoredPlanSpec[];
	complete: boolean;
}

export function roleForPhase(phase: PlanPhase): WorkerRole | null {
	if (phase === "READY_IMPLEMENTER") return "plan-implementer";
	if (phase === "READY_REVIEWER") return "plan-reviewer";
	if (phase === "READY_JUDGE") return "plan-judge";
	return null;
}

export function phaseForRole(role: WorkerRole): PlanPhase {
	if (role === "plan-implementer") return "IMPLEMENTING";
	if (role === "plan-reviewer") return "REVIEWING";
	return "JUDGING";
}

export function readyPhaseForRole(role: string): PlanPhase {
	if (role === "plan-implementer") return "READY_IMPLEMENTER";
	if (role === "plan-reviewer") return "READY_REVIEWER";
	if (role === "plan-judge") return "READY_JUDGE";
	throw new Error(`Unknown worker role ${role}`);
}

export type PlanLifecycleStatus = PlanStatus;

export function lifecycleStatus(spec: StoredPlanSpec, runtime: StoredPlan | null): PlanLifecycleStatus {
	if (!runtime) return spec.initialStatus;
	if (runtime.phase === "DONE" || runtime.phase === "FINAL_APPROVED") return "DONE";
	if (runtime.phase === "BLOCKED" || runtime.phase === "NEEDS_INPUT") return "BLOCKED";
	return "IN PROGRESS";
}

function graphLifecycle(graph: PlanGraph): Map<string, PlanLifecycleStatus> {
	return new Map(graph.plans.map((plan) => [plan.id, plan.status]));
}

export function readPlanLifecycle(planDir: string): Map<string, PlanLifecycleStatus> {
	const graph = buildGraph(planDir);
	let store: RunStore | undefined;
	try {
		store = new RunStore(planDir, { readOnly: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not initialized/.test(message)) return graphLifecycle(graph);
		throw error;
	}
	try {
		const run = store.getRun();
		if (!run) return graphLifecycle(graph);
		const specs = store.getPlanSpecs(run.runId);
		const overlay = new Map<string, PlanLifecycleStatus>();
		for (const spec of specs) {
			overlay.set(spec.planId, lifecycleStatus(spec, store.getPlan(run.runId, spec.planId)));
		}
		return overlay;
	} finally {
		store.close();
	}
}

export function applyLifecycleToGraph(graph: PlanGraph, lifecycle: Map<string, PlanLifecycleStatus>): PlanGraph {
	if (lifecycle.size === 0) return graph;
	const plans = graph.plans.map((plan) => {
		const status = lifecycle.get(plan.id);
		return status && status !== plan.status ? { ...plan, status } : plan;
	});
	const byId = new Map(plans.map((plan) => [plan.id, plan]));
	const ready: string[] = [];
	const waiting: PlanGraph["waiting"] = [];
	for (const plan of plans) {
		if (!["TODO", "IN PROGRESS", "BLOCKED"].includes(plan.status)) continue;
		const unsatisfied = plan.dependencies.filter((id) => byId.get(id)!.status !== "DONE");
		const rejected = unsatisfied.filter((id) => byId.get(id)!.status === "REJECTED");
		if (plan.status === "TODO" && unsatisfied.length === 0) ready.push(plan.id);
		else if (unsatisfied.length > 0) waiting.push({ id: plan.id, unsatisfied, rejected });
	}
	return {
		...graph,
		plans,
		ready,
		inProgress: plans.filter((plan) => plan.status === "IN PROGRESS").map((plan) => plan.id),
		blocked: plans.filter((plan) => plan.status === "BLOCKED").map((plan) => plan.id),
		waiting,
		complete: plans.every((plan) => plan.status === "DONE" || plan.status === "REJECTED"),
		counts: {
			total: plans.length,
			done: plans.filter((plan) => plan.status === "DONE").length,
			rejected: plans.filter((plan) => plan.status === "REJECTED").length,
			actionable: plans.filter((plan) => ["TODO", "IN PROGRESS", "BLOCKED"].includes(plan.status)).length,
		},
	};
}

export function readPlanLifecycleGraph(planDir: string): PlanGraph {
	const graph = buildGraph(planDir);
	return applyLifecycleToGraph(graph, readPlanLifecycle(planDir));
}

export function summarizeRun(specs: StoredPlanSpec[], plans: StoredPlan[]): RunOverview {
	const runtime = new Map(plans.filter((plan) => plan.planId !== "RUN").map((plan) => [plan.planId, plan]));
	const status = new Map(specs.map((spec) => [spec.planId, lifecycleStatus(spec, runtime.get(spec.planId) ?? null)]));
	const ready = specs.filter((spec) =>
		status.get(spec.planId) === "TODO"
		&& spec.dependencies.every((dependency) => status.get(dependency) === "DONE")
	);
	const blocked = specs.filter((spec) => status.get(spec.planId) === "BLOCKED").map((spec) => spec.planId);
	const done = specs.filter((spec) => status.get(spec.planId) === "DONE").length;
	const rejected = specs.filter((spec) => status.get(spec.planId) === "REJECTED").length;
	const inProgress = specs.filter((spec) => status.get(spec.planId) === "IN PROGRESS").length;
	return {
		total: specs.length,
		done,
		rejected,
		inProgress,
		blocked,
		ready,
		complete: done + rejected === specs.length,
	};
}
