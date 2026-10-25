export interface ScriptProblem { message: string; line?: number; column?: number }
export interface ValidationContext { roles: readonly string[]; checks: readonly string[] }

/** Compiles and checks a script without running agents. */
export async function validateScript(source: string, context: ValidationContext): Promise<ScriptProblem[]> { throw new Error("not implemented"); }
