import type { CheckSpec } from "../types.ts";

export interface Criterion { id: string; text: string; verify: { kind: "check"; checks: string[] } | { kind: "judge"; rubric: string } }
export interface Goal { title: string; intent: string; criteria: Criterion[]; checks: CheckSpec[]; constraints: string[]; outOfScope: string[]; budget: { maxAgents?: number; maxFixAttempts?: number } }

export class GoalError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) { super(problems.join("\n")); this.name = "GoalError"; this.problems = problems; }
}

/** Parses and validates goal.md; throws `GoalError` listing every problem. */
export function parseGoal(text: string): Goal { throw new Error("not implemented"); }
export function hashGoal(text: string): string { throw new Error("not implemented"); }
export function goalDraft(title: string): string { throw new Error("not implemented"); }
/** `30s`, `10m`, `1h` to milliseconds. */
export function parseDuration(text: string): number { throw new Error("not implemented"); }
