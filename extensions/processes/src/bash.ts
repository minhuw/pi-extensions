// Pi's bash tool, executed through the process manager. A command runs attached: the call waits for it and Pi formats
// the result as usual. When it keeps running (the user sends a message, it prints a local URL and stays up, or it runs
// past PROMOTE_AFTER_MS without an explicit timeout) it is detached into a managed process instead of blocking the
// turn, and the result tells the model so; its exit then arrives as a process-event notification.
import { constants } from "node:os";
import { createBashToolDefinition, type BashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessInfo, ProcessManager } from "./types.ts";

export interface BashTiming {
	/** A command without an explicit timeout moves to the background after this long. */
	promoteAfterMs: number;
	/** A command that printed a local URL moves once it is still running this long afterwards. */
	urlSettleMs: number;
	/** A user message promotes commands once they have run at least this long. */
	inputMinRunMs: number;
}

export const DEFAULT_TIMING: BashTiming = { promoteAfterMs: 120_000, urlSettleMs: 2_000, inputMinRunMs: 3_000 };

const STOP_GRACE_MS = 1_000;

interface Foreground {
	startedAt: number;
	promote(reason: string): void;
}

interface Promotion {
	process: ProcessInfo;
	reason: string;
}

function exitCode(process: ProcessInfo): number | null {
	if (process.exitCode !== undefined && process.exitCode !== null) return process.exitCode;
	const signal = process.signal as keyof typeof constants.signals | null | undefined;
	return signal ? 128 + constants.signals[signal] : null;
}

/** Runs commands for one bash call; `promoted` is set when the command was detached instead of finishing. */
function operations(manager: () => ProcessManager, ctx: ExtensionContext, timing: BashTiming, calls: Set<Foreground>, call: { promoted?: Promotion }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) =>
			new Promise((resolve, reject) => {
				const processes = manager();
				const timers: NodeJS.Timeout[] = [];
				const exits = new Map<string, ProcessInfo>();
				let id: string | undefined;
				let settled = false;
				let urlScheduled = false;

				const cleanup = () => {
					settled = true;
					unsubscribe();
					for (const timer of timers) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					calls.delete(foreground);
				};
				const finished = (process: ProcessInfo) => {
					if (settled) return;
					cleanup();
					processes.discard(process.id);
					resolve({ exitCode: exitCode(process) });
				};
				const stopWith = (error: Error) => {
					if (settled || id === undefined) return;
					cleanup();
					const target = id;
					processes.stop(target, STOP_GRACE_MS).then((result) => {
						if (result.outcome === "stuck") reject(new Error(`${error.message}; process group ${result.process.pid} survived SIGKILL`));
						else {
							processes.discard(target);
							reject(error);
						}
					}, reject);
				};
				const foreground: Foreground = {
					startedAt: Date.now(),
					promote(reason) {
						if (settled || id === undefined) return;
						cleanup();
						call.promoted = { process: processes.detach(id), reason };
						resolve({ exitCode: 0 });
					},
				};
				const onAbort = () => stopWith(new Error("aborted"));
				// Output can arrive before start() resolves with the id, so this runs on output and once the id is known.
				const checkUrl = () => {
					if (urlScheduled || settled || id === undefined) return;
					const url = processes.get(id).urls[0];
					if (!url) return;
					urlScheduled = true;
					timers.push(setTimeout(() => foreground.promote(`it printed ${url} and kept running`), timing.urlSettleMs));
				};
				const unsubscribe = processes.subscribe((event) => {
					if (event.type !== "exit") return;
					if (event.process.id === id) finished(event.process);
					else if (id === undefined) exits.set(event.process.id, event.process);
				});

				processes
					.start({
						command,
						cwd,
						env: Object.fromEntries(Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)),
						owner: ctx.sessionManager.getSessionId(),
						ready: false,
						reuse: false,
						attached: true,
						onOutput(chunk) {
							onData(chunk);
							checkUrl();
						},
					})
					.then(({ process }) => {
						id = process.id;
						const early = exits.get(process.id);
						if (early) return finished(early);
						calls.add(foreground);
						if (signal?.aborted) return onAbort();
						signal?.addEventListener("abort", onAbort, { once: true });
						checkUrl();
						if (timeout !== undefined && timeout > 0) {
							timers.push(setTimeout(() => stopWith(new Error(`timeout:${timeout}`)), timeout * 1000));
						} else if (!/^\s*sleep\b/.test(command)) {
							timers.push(setTimeout(() => foreground.promote(`it was still running after ${Math.round(timing.promoteAfterMs / 1000)}s`), timing.promoteAfterMs));
						}
					}, (error) => {
						cleanup();
						reject(error);
					});
			}),
	};
}

function backgroundNotice({ process, reason }: Promotion): string {
	const urls = process.urls.length > 0 ? ` URLs: ${process.urls.join(" ")}.` : "";
	return `Command still running; moved to the background as process ${process.name} (${process.id}) because ${reason}.${urls} You will be notified when it exits. Use process_logs to read its output and process_stop to end it.`;
}

export function registerBash(pi: ExtensionAPI, manager: () => ProcessManager, timing: BashTiming = DEFAULT_TIMING): void {
	const calls = new Set<Foreground>();
	const base = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...base,
		description: `${base.description} A command that keeps running (the user sends a message, it prints a local URL and stays up, or it passes ${Math.round(timing.promoteAfterMs / 1000)}s without a timeout) moves to the background as a managed process; the result says so and you are notified when it exits. An explicit timeout still kills the command.`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const call: { promoted?: Promotion } = {};
			const definition = createBashToolDefinition(ctx.cwd, { operations: operations(manager, ctx, timing, calls, call) });
			const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
			if (!call.promoted) return result;
			const first = result.content[0];
			const output = first?.type === "text" && first.text !== "(no output)" ? first.text : "";
			const { exit_code: _exitCode, ...structured } = (result.structuredContent ?? {}) as Record<string, unknown>;
			return {
				...result,
				content: [{ type: "text", text: `${output ? `${output}\n\n` : ""}${backgroundNotice(call.promoted)}` }],
				structuredContent: { ...structured, process_id: call.promoted.process.id, process_name: call.promoted.process.name, background_reason: call.promoted.reason },
				isError: false,
			};
		},
	});

	pi.on("input", (event) => {
		// Only what the user typed or sent over RPC; extension-sent input is not the user changing course.
		if (event.streamingBehavior === undefined || event.source === "extension") return { action: "continue" as const };
		const now = Date.now();
		for (const call of calls) {
			const wait = call.startedAt + timing.inputMinRunMs - now;
			if (wait <= 0) call.promote("the user sent a new message");
			else setTimeout(() => call.promote("the user sent a new message"), wait).unref();
		}
		return { action: "continue" as const };
	});
}
