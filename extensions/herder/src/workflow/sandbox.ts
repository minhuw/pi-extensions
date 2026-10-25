import { Script } from "node:vm";
import { Worker } from "node:worker_threads";
import type { ResourceLimits } from "node:worker_threads";
import { AGENT_OPTION_KEYS, INTEGRATE_OPTION_KEYS } from "../types.ts";
import type { AgentOptions, IntegrateOptions, Limits, StepResult, WorkflowBridge } from "../types.ts";
import { SCRIPT_FILENAME, WORKER_SOURCE } from "./worker-source.ts";

export interface ScriptOutcome { status: "completed" | "failed" | "stopped"; value?: unknown; error?: string; line?: number; column?: number }
export interface ScriptHandle { readonly done: Promise<ScriptOutcome>; stop(reason?: string): void }
export interface ScriptOptions {
	source: string; args: unknown; bridge: WorkflowBridge; limits: Limits;
	/** Resolves whether a call writes (role default unless `write` is given); used for the writer cap. */
	writes(role: string | undefined, write: boolean | undefined): boolean;
	filename?: string;
}
export interface ScriptProblem { message: string; line?: number; column?: number; severity: "error" | "warning" }

export interface CallSite { line: number; column: number }
export type SandboxCall =
	| { method: "agent"; prompt: string; opts: AgentOptions; site?: CallSite }
	| { method: "integrate"; source: StepResult | string; opts: IntegrateOptions; site?: CallSite };
/** What the worker talks to. `runScript` adapts a `WorkflowBridge`; validation supplies a stub. */
export interface SandboxHost {
	call(call: SandboxCall): Promise<unknown>;
	log(message: string): void;
	phase(title: string): void;
	/** Dry runs only: an invalid option reported instead of thrown. */
	problem?(problem: ScriptProblem): void;
}
export interface SandboxOptions {
	source: string; args: unknown; limits: Limits; host: SandboxHost; filename?: string;
	/** Report invalid options through `host.problem` and keep going (validation dry runs). */
	collect?: boolean;
	/** Runs synchronously when the outcome is decided, before the worker is down. */
	onSettle?(): void;
	/** Worker heap limits; a script that exceeds them fails. Defaults to `DEFAULT_RESOURCE_LIMITS`. */
	resourceLimits?: ResourceLimits;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 512 };
const AsyncFunction = (async () => {}).constructor as new (body: string) => unknown;

type WorkerMessage =
	| { type: "call"; callId: number; method: string; payload: Record<string, unknown>; site?: CallSite }
	| { type: "log"; message: string }
	| { type: "phase"; title: string }
	| { type: "problem"; message: string; line?: number; column?: number }
	| { type: "complete"; resultJson?: string }
	| { type: "error"; message: string; line?: number; column?: number };

/** Compiles the script as the worker would, without running it; returns the syntax error, if any. */
export function syntaxProblem(source: string, filename = SCRIPT_FILENAME): ScriptProblem | undefined {
	try {
		new Script(wrap(source), { filename, lineOffset: -1 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error && typeof error.stack === "string" ? error.stack.split("\n") : [];
		const header = /:(\d+)$/.exec(stack[0] ?? "");
		const line = header ? Number(header[1]) : undefined;
		const caret = stack[2]?.indexOf("^") ?? -1;
		return { message: `SyntaxError: ${message}`, severity: "error", ...within(source, line !== undefined && line >= 1 ? line : undefined, caret >= 0 ? caret + 1 : undefined) };
	}
	// The wrapper parses a body that closes it early and reopens it (`}); x; (async () => {`). The AsyncFunction
	// constructor parses the body on its own; it compiles without running and gives no position.
	try {
		new AsyncFunction(source);
	} catch (error) {
		if (!(error instanceof SyntaxError)) return undefined;
		const message = error.message === "Single function literal required" ? "The script closes its own body; check for an unbalanced }." : error.message;
		return { message: `SyntaxError: ${message}`, severity: "error" };
	}
	return undefined;
}

function wrap(source: string): string { return `(async () => {\n${source}\n})()`; }

/** A position clamped to the source: the wrapper's closing line reads as the end of the last line. */
function within(source: string, line: number | undefined, column: number | undefined): { line?: number; column?: number } {
	if (line === undefined) return {};
	const lines = source.split("\n");
	if (line > lines.length) return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
	return column === undefined ? { line } : { line, column };
}

function at(line: number | undefined, column: number | undefined): string {
	return line === undefined ? "" : column === undefined ? ` (line ${line})` : ` (line ${line}:${column})`;
}

/** Runs a script in a worker-thread vm sandbox against `host`. */
export function startSandbox(options: SandboxOptions): ScriptHandle {
	const { host } = options;
	const filename = options.filename ?? SCRIPT_FILENAME;
	let resolveDone!: (outcome: ScriptOutcome) => void;
	const done = new Promise<ScriptOutcome>(resolve => { resolveDone = resolve; });
	let settled = false;
	let worker: Worker | undefined;

	const finish = (outcome: ScriptOutcome) => {
		if (settled) return;
		settled = true;
		try { options.onSettle?.(); } catch { /* the outcome stands */ }
		const settle = () => resolveDone(outcome);
		if (worker) void worker.terminate().then(settle, settle);
		else settle();
	};
	const failed = (message: string, line?: number, column?: number) => {
		const site = within(options.source, line, column);
		finish({ status: "failed", error: message + at(site.line, site.column), ...site });
	};

	const syntax = syntaxProblem(options.source, filename);
	if (syntax) {
		failed(syntax.message, syntax.line, syntax.column);
		return { done, stop() {} };
	}
	let argsJson: string | undefined;
	try {
		argsJson = options.args === undefined ? undefined : JSON.stringify(options.args);
	} catch (error) {
		failed(`Script args are not JSON: ${error instanceof Error ? error.message : String(error)}`);
		return { done, stop() {} };
	}

	const respond = (callId: number, ok: boolean, value?: unknown, error?: string) => {
		if (settled || !worker) return;
		let valueJson: string | undefined;
		if (ok && value !== undefined) {
			try { valueJson = JSON.stringify(value); }
			catch { ok = false; error = "The host returned a value that is not JSON."; }
		}
		worker.postMessage({ type: "response", callId, ok, valueJson, error });
	};

	const dispatch = (message: Extract<WorkerMessage, { type: "call" }>) => {
		const { callId, payload, site } = message;
		let call: SandboxCall;
		if (message.method === "agent") call = { method: "agent", prompt: payload.prompt as string, opts: payload.opts as AgentOptions, ...(site ? { site } : {}) };
		else if (message.method === "integrate") call = { method: "integrate", source: payload.source as StepResult | string, opts: payload.opts as IntegrateOptions, ...(site ? { site } : {}) };
		else return respond(callId, false, undefined, `Unknown host method "${message.method}".`);
		let pending: Promise<unknown>;
		try { pending = Promise.resolve(host.call(call)); }
		catch (error) { pending = Promise.reject(error); }
		pending.then(
			value => respond(callId, true, value),
			(error: unknown) => respond(callId, false, undefined, error instanceof Error ? error.message : String(error)),
		);
	};

	const onMessage = (message: WorkerMessage) => {
		if (settled || !message || typeof message !== "object") return;
		switch (message.type) {
			case "call": return dispatch(message);
			case "log": return host.log(String(message.message));
			case "phase": return host.phase(String(message.title));
			case "problem":
				return host.problem?.({ message: String(message.message), severity: "error", ...(message.line !== undefined ? { line: message.line } : {}), ...(message.column !== undefined ? { column: message.column } : {}) });
			case "complete": {
				let value: unknown;
				try { value = message.resultJson === undefined ? undefined : JSON.parse(message.resultJson); }
				catch { return failed("The script result is not JSON."); }
				return finish({ status: "completed", ...(value !== undefined ? { value } : {}) });
			}
			case "error": return failed(String(message.message), message.line, message.column);
		}
	};

	worker = new Worker(WORKER_SOURCE, {
		eval: true,
		resourceLimits: options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
		workerData: {
			source: options.source, argsJson, filename, collect: options.collect === true,
			limits: { agentsPerLaunch: options.limits.agentsPerLaunch, itemsPerCall: options.limits.itemsPerCall },
			agentKeys: [...AGENT_OPTION_KEYS], integrateKeys: [...INTEGRATE_OPTION_KEYS],
		},
	});
	worker.on("message", (message: WorkerMessage) => {
		// One bad message or a throwing log/phase sink must not take the host down.
		try { onMessage(message); } catch { /* ignored */ }
	});
	worker.on("error", error => failed(error instanceof Error ? error.message : String(error)));
	worker.on("exit", () => failed("The script worker exited before completing."));

	return { done, stop(reason) { finish({ status: "stopped", error: reason ?? "Stopped." }); } };
}

/**
 * Runs a script against a `WorkflowBridge`, holding `agent()` calls in FIFO order (per class) while
 * `limits.concurrentAgents` calls, or `limits.concurrentWriters` writing calls, are in flight.
 */
export function runScript(options: ScriptOptions): ScriptHandle {
	const { bridge, limits } = options;
	const slots = agentSlots(limits);
	return startSandbox({
		source: options.source, args: options.args, limits, ...(options.filename !== undefined ? { filename: options.filename } : {}),
		onSettle: () => slots.close(),
		host: {
			async call(call) {
				if (call.method === "integrate") return bridge.integrate(call.source, call.opts);
				const prepared = bridge.prepare?.(call.prompt, call.opts);
				const release = await slots.acquire(options.writes(call.opts.role, call.opts.write));
				try { return await bridge.agent(call.prompt, call.opts, prepared); }
				finally { release(); }
			},
			log: message => bridge.log(message),
			phase: title => bridge.phase(title),
		},
	});
}

function agentSlots(limits: Limits) {
	let agents = 0, writers = 0, closed = false;
	const waiting: { write: boolean; start(release: () => void): void; cancel(error: Error): void }[] = [];
	const fits = (write: boolean) => agents < limits.concurrentAgents && (!write || writers < limits.concurrentWriters);
	const take = (write: boolean) => {
		agents++;
		if (write) writers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			agents--;
			if (write) writers--;
			pump();
		};
	};
	const pump = () => {
		for (let i = 0; i < waiting.length && !closed;) {
			const entry = waiting[i]!;
			if (!fits(entry.write)) { i++; continue; }
			waiting.splice(i, 1);
			entry.start(take(entry.write));
		}
	};
	return {
		acquire(write: boolean): Promise<() => void> {
			if (closed) return Promise.reject(new Error("The script has settled."));
			if (waiting.length === 0 && fits(write)) return Promise.resolve(take(write));
			return new Promise((start, cancel) => { waiting.push({ write, start, cancel }); pump(); });
		},
		close() {
			closed = true;
			for (const entry of waiting.splice(0)) entry.cancel(new Error("The script has settled."));
		},
	};
}
