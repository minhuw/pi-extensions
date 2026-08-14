import type { GrillPlanTarget } from "./arguments.ts";

export function noDeterministicRunMessage(mode: "resume" | "revise", planDir: string): string {
	const prefix = `No deterministic Herder run exists in ${planDir}.`;
	if (mode === "revise") {
		return [
			prefix,
			"/herder-revise only adopts a validated graph generation into an existing deterministic run.",
			"To refine or split a standalone plan, use /herder-grill --plan <id-or-path> --split --plan-dir <plan-dir>.",
		].join("\n");
	}
	return prefix;
}

export function assertActiveFireGrillTarget(target: GrillPlanTarget | null): asserts target is GrillPlanTarget {
	if (!target) throw new Error("Active Herder Fire requires /herder-grill --plan <unstarted-plan>.");
	if (target.split) {
		throw new Error("/herder-grill --split cannot run during active Herder Fire because the manager reservation is target-local. Finish or stop Fire, then run /herder-grill --plan <id-or-path> --split [--plan-dir <dir>] standalone.");
	}
}
