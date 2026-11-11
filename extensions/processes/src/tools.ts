// The model-facing tools. Each resolves the shared manager when it runs, tags what it starts with the calling
// session's id, and throws on every failure so the model sees a tool error.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exitDescription, processTable } from "./format.ts";
import { readyKey } from "./notify.ts";
import { sharedState, withRequestedStop } from "./state.ts";
import type { ProcessInfo, ProcessManager, StartOptions } from "./types.ts";

const NOTIFIED = "You will be notified when it becomes ready, prints errors, or exits. Do not sleep or poll; continue other work or end your turn.";

export const StartParameters = Type.Object({
	command: Type.String({ minLength: 1, description: "Shell command line." }),
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Unique name; defaults to the command's first word." })),
	cwd: Type.Optional(Type.String({ description: "Directory relative to the session cwd (inside it or the system temp dir)." })),
	kind: Type.Optional(Type.Union([Type.Literal("service"), Type.Literal("task")], { description: '"service" (default) keeps running; "task" is a one-shot job such as a build.' })),
	ready: Type.Optional(
		Type.Object(
			{
				pattern: Type.Optional(Type.String({ description: "Regex matched against output lines." })),
				port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "127.0.0.1 port that must accept TCP." })),
				url: Type.Optional(Type.String({ description: "URL that must answer below HTTP 500." })),
				timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Default 120." })),
			},
			{ description: "Service readiness; all given criteria must hold. Default: the first local URL it prints accepts TCP." },
		),
	),
	errorPattern: Type.Optional(Type.String({ description: "Regex for output lines reported to you as errors." })),
});

export const NameParameters = Type.Object({ name: Type.String({ minLength: 1, description: "Process name or id." }) });

export const LogsParameters = Type.Object({
	name: Type.String({ minLength: 1, description: "Process name or id." }),
	cursor: Type.Optional(Type.Integer({ minimum: 0, description: "nextCursor of an earlier read: return only newer output." })),
	tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Lines from the end when no cursor is given (default 50)." })),
	filter: Type.Optional(Type.String({ description: "Regex; only matching lines." })),
});

export const WaitParameters = Type.Object({
	name: Type.String({ minLength: 1, description: "Process name or id." }),
	until: Type.Union([Type.Literal("ready"), Type.Literal("exit"), Type.Literal("match")]),
	pattern: Type.Optional(Type.String({ description: 'Regex for "match", tested against new output only.' })),
	timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Default 600." })),
});

/** The real directory `raw` names relative to `cwd`; throws unless it exists inside `cwd` or the system temp dir. */
export function resolveProcessCwd(cwd: string, raw: string | undefined): string {
	const path = resolve(cwd, (raw ?? ".").replace(/^@/, ""));
	let real: string;
	try {
		real = realpathSync.native(path);
	} catch (error) {
		throw new Error(`cwd ${path} does not exist: ${(error as Error).message}`);
	}
	const inside = (root: string) => {
		const rel = relative(realpathSync.native(root), real);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	if (!inside(cwd) && !inside(tmpdir())) throw new Error(`cwd ${real} is outside the session directory ${cwd} and the system temp dir.`);
	return real;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A result that shows the process ready already reports it; the pending "ready" notification is dropped. */
function reported(process: ProcessInfo): ProcessInfo {
	if (process.status === "ready") sharedState().reportedReady.add(readyKey(process));
	return process;
}

function describe(process: ProcessInfo): string {
	const lines = [`${process.name} (${process.id}) pid ${process.pid ?? "-"}, ${process.status}`];
	if (process.urls.length > 0) lines.push(`URLs: ${process.urls.join(" ")}`);
	const exit = exitDescription(process);
	if (exit) lines.push(`Exit: ${exit}`);
	lines.push(`Log: ${process.logPath}`);
	return lines.join("\n");
}

export function registerTools(pi: ExtensionAPI, manager: () => ProcessManager): void {
	const session = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

	pi.registerTool({
		name: "process_start",
		label: "Process Start",
		description:
			'Start a long-running command (dev server, watcher) or a one-shot background job (kind "task", e.g. a build) in its own process group, with output logged. Returns at once; you are notified when it becomes ready, prints errors, or exits. Starting the same name, command, and cwd again reuses the live process.',
		promptSnippet: "Start dev servers, watchers, and long builds in the background with notifications (process_*).",
		promptGuidelines: [
			"Use process_start instead of bash for anything long-running or backgrounded; do not use `&`, nohup, or setsid in bash.",
			"After process_start or process_wait, do not sleep or poll process_logs; continue other work or end your turn until notified.",
		],
		parameters: StartParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const kind = params.kind ?? "service";
			if (kind === "task" && params.ready) throw new Error('ready applies only to kind "service".');
			const options: StartOptions = {
				command: params.command,
				cwd: resolveProcessCwd(ctx.cwd, params.cwd),
				owner: session(ctx),
				...(params.name ? { name: params.name } : {}),
				...(params.errorPattern ? { errorPattern: params.errorPattern } : {}),
				...(kind === "task" ? { ready: false as const } : params.ready ? { ready: params.ready } : {}),
			};
			const { process, reused } = await manager().start(options);
			if (!reused) reported(process);
			const lead = reused ? `${process.name} was already running; reused it.` : `Started ${process.name}.`;
			return { content: text(`${lead}\n${describe(process)}\n${NOTIFIED}`), details: { process, reused } };
		},
	});

	pi.registerTool({
		name: "process_list",
		label: "Process List",
		description: "List managed processes with status, pid, uptime, URLs, and exit code.",
		parameters: Type.Object({}),
		async execute() {
			const processes = manager().list();
			return { content: text(processTable(processes)), details: { processes } };
		},
	});

	pi.registerTool({
		name: "process_logs",
		label: "Process Logs",
		description: "Read a managed process's output: the tail, or with cursor only output newer than an earlier read. Optional regex filter.",
		parameters: LogsParameters,
		async execute(_toolCallId, params) {
			const read = await manager().logs(params.name, {
				...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
				...(params.tail !== undefined ? { tail: params.tail } : {}),
				...(params.filter ? { filter: params.filter } : {}),
			});
			const notes = [`nextCursor: ${read.nextCursor}`];
			if (read.truncated) notes.push("Older output since the cursor was rotated away.");
			if (read.more) notes.push("More output follows; read again with nextCursor.");
			const body = read.lines.length > 0 ? read.lines.join("\n") : "(no output)";
			return { content: text(`${body}\n\n${notes.join("\n")}`), details: read };
		},
	});

	pi.registerTool({
		name: "process_stop",
		label: "Process Stop",
		description: "Stop a managed process: SIGTERM to its process group, then SIGKILL after a grace period.",
		parameters: NameParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = manager().get(params.name);
			const result = await withRequestedStop(target.id, { by: "agent", session: session(ctx) }, () => manager().stop(target.id));
			if (result.outcome === "stuck") throw new Error(`${target.name} (${target.id}) survived SIGKILL; its process group is still alive.`);
			const how = { terminated: "stopped", killed: "killed after the grace period", already: "was not running" }[result.outcome];
			return { content: text(`${result.process.name} ${how}.\n${describe(result.process)}`), details: result };
		},
	});

	pi.registerTool({
		name: "process_restart",
		label: "Process Restart",
		description: "Stop a managed process and start it again with the same command, cwd, and options.",
		parameters: NameParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = manager().get(params.name);
			const process = await withRequestedStop(target.id, { by: "agent", session: session(ctx) }, () => manager().restart(target.id).then(reported));
			return { content: text(`Restarted ${process.name}.\n${describe(process)}\n${NOTIFIED}`), details: { process } };
		},
	});

	pi.registerTool({
		name: "process_wait",
		label: "Process Wait",
		description:
			'Ask to be notified once a managed process is ready, has exited, or prints a line matching pattern ("match"). Returns immediately; the notification arrives as a message.',
		parameters: WaitParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.until === "match" && !params.pattern) throw new Error('until "match" requires pattern.');
			if (params.until !== "match" && params.pattern) throw new Error('pattern applies only to until "match".');
			const target = manager().get(params.name);
			const waitId = manager().wait(target.id, {
				until: params.until,
				...(params.pattern ? { pattern: params.pattern } : {}),
				...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
			});
			// Registered before the next tick, when an already-met condition reports.
			sharedState().waits.set(waitId, session(ctx));
			return {
				content: text(`Waiting for ${target.name} (${params.until}) as ${waitId}. You will be notified when it is done; end your turn if you have nothing else to do.`),
				details: { waitId, process: target, until: params.until },
			};
		},
	});
}
