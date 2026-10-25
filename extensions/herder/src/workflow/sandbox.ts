import type { Limits, WorkflowBridge } from "../types.ts";

export interface ScriptOutcome { status: "completed" | "failed" | "stopped"; value?: unknown; error?: string }
export interface ScriptHandle { readonly done: Promise<ScriptOutcome>; stop(reason?: string): void }
export interface ScriptOptions {
	source: string; args: unknown; bridge: WorkflowBridge; limits: Limits;
	/** Resolves whether a call writes (role default unless `write` is given); used for the writer cap. */
	writes(role: string | undefined, write: boolean | undefined): boolean;
	filename?: string;
}

export function runScript(options: ScriptOptions): ScriptHandle { throw new Error("not implemented"); }
