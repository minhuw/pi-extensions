import type { CheckResult, CheckSpec, OutputStore } from "../types.ts";

export interface CheckRunOptions { cwd: string; commit: string; outputs: OutputStore; signal?: AbortSignal }

export async function runCheck(spec: CheckSpec, options: CheckRunOptions): Promise<CheckResult> { throw new Error("not implemented"); }
/** Runs every check in order (no short-circuit). */
export async function runChecks(specs: readonly CheckSpec[], options: CheckRunOptions): Promise<CheckResult[]> { throw new Error("not implemented"); }
/** Last 40 lines plus up to 20 lines matching /error|fail/i (§10). */
export function summarizeOutput(output: string): string { throw new Error("not implemented"); }
