import type { AgentOptions, StepResult } from "../types.ts";

export interface StepExecutor { run(prompt: string, opts: AgentOptions): Promise<StepResult> }

export function createStepExecutor(deps: unknown): StepExecutor { throw new Error("not implemented"); }
