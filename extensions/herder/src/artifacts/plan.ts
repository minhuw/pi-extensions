import type { Gap } from "../types.ts";

export interface PlanTask { id: string; criteria: string[]; text: string; line: number }

export function parsePlanTasks(text: string): PlanTask[] { throw new Error("not implemented"); }
/** Appends `## Convergence N`; the bytes above it are unchanged. */
export function appendConvergence(text: string, gaps: readonly Gap[]): { text: string; n: number } { throw new Error("not implemented"); }
