import type { IntegrateOptions, IntegrateResult, StepResult } from "../types.ts";

export interface Integrator { integrate(source: StepResult | string, opts: IntegrateOptions): Promise<IntegrateResult> }

export function createIntegrator(deps: unknown): Integrator { throw new Error("not implemented"); }
