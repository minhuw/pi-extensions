import type { PlanPhase, WorkerRole } from "../shared/protocol.ts";
import type { StoredPlan, StoredPlanSpec } from "../daemon/run-store.ts";

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

export function lifecycleStatus(spec: StoredPlanSpec, runtime: StoredPlan | null): "TODO" | "IN PROGRESS" | "DONE" | "BLOCKED" | "REJECTED" {
	if (!runtime) return spec.initialStatus;
	if (runtime.phase === "DONE" || runtime.phase === "FINAL_APPROVED") return "DONE";
	if (runtime.phase === "BLOCKED" || runtime.phase === "NEEDS_INPUT") return "BLOCKED";
	return "IN PROGRESS";
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
