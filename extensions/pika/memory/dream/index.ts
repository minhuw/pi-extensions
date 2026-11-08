import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadMemorySettings, type MemorySettings } from "../../config.ts";
import { credentialsRegistry } from "../../credentials.ts";
import { resolveRepository } from "../../repository.ts";
import { MemoryServerError, request } from "../client.ts";
import type { MemoryView } from "../format.ts";
import { cwdOf, where } from "../tools.ts";
import { SESSION_LINK_TYPE, spawnDreamChild } from "./child.ts";
import { kickoffText } from "./prompt.ts";
import { type DreamChild, type DreamMode, DreamRun, dreamLimits, type Grant, type SpawnOptions } from "./run.ts";
import { dreamTools } from "./tools.ts";

export { dreamLimits } from "./run.ts";

/** How dreams spawn their child; tests replace it. */
export const dreamRuntime: { spawn: (options: SpawnOptions) => Promise<DreamChild> } = { spawn: spawnDreamChild };

/** How long the kickoff's index fetch may take. */
const INDEX_TIMEOUT_MS = 5_000;
const STATUS_KEY = "pika-memory";
const USAGE = "Usage: /memory [status|dream|stop]";
const SUBCOMMANDS = ["status", "dream", "stop"];

// One dream per process, whichever module copy started it.
const SHARED = Symbol.for("pi-extensions.pika.memory.dream");
interface Shared {
	/** The running dream. */
	running?: DreamRun;
	/** Set while a dream is being requested, so a second one is not. */
	starting?: object;
	/** The dream that ended last. */
	last?: DreamRun;
}
const shared = (): Shared => (globalThis as { [SHARED]?: Shared })[SHARED] ??= {};

/** The running dream, or the last one; for tests and `/memory status`. */
export const currentDream = (): DreamRun | undefined => shared().running ?? shared().last;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A top-level TUI or RPC session: never a child, which runs without a mode or carries a session link. */
function isTopLevel(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/** Why this session cannot dream, if it cannot: logged out or excluded. */
function credentialsProblem(cwd: string): string | undefined {
	const value = credentialsRegistry().current;
	if (!value) return "pika is not logged in to a server; run /pika login";
	if (value.isExcluded(cwd)) return `pika's exclude list covers ${cwd}`;
	return undefined;
}

type Model = NonNullable<ExtensionContext["model"]>;
/** The dream's model: `memory.dreamModel` when set and found, else the session's, with why. */
function pickModel(ctx: ExtensionContext, settings: MemorySettings): { model?: Model; note?: string } {
	const name = (model: Model | undefined) => model ? `${model.provider}/${model.id}` : "none";
	if (settings.dreamModel) {
		const slash = settings.dreamModel.indexOf("/");
		const found = ctx.modelRegistry.find(settings.dreamModel.slice(0, slash), settings.dreamModel.slice(slash + 1));
		if (found) return { model: found };
		return { model: ctx.model, note: `memory.dreamModel ${settings.dreamModel} was not found; dreams use this session's model, ${name(ctx.model)}` };
	}
	return { model: ctx.model, note: `memory.dreamModel is not set; dreams use this session's model, ${name(ctx.model)}` };
}

/** `ExtensionContext.modelRegistry` wraps the session's `ModelRuntime` without exposing it; undefined if Pi changes that. */
function modelRuntimeOf(registry: unknown): ModelRuntime | undefined {
	const runtime = (registry as { runtime?: { getModel?: unknown } } | undefined)?.runtime;
	return typeof runtime?.getModel === "function" ? runtime as ModelRuntime : undefined;
}

/** Why the server refused a lease. */
function leaseRefusal(error: unknown): string {
	if (!(error instanceof MemoryServerError)) return errorText(error);
	const { status, body } = error;
	const code = typeof body.error === "string" ? body.error : undefined;
	if (status === 409 && code === "dream_busy") return `another dream holds this project's lease${typeof body.expiresAt === "string" ? ` until ${body.expiresAt}` : ""}`;
	if (status === 409 && code === "dream_not_due") {
		const why = body.reason === "cooldown" ? "the last dream finished less than 4 hours ago"
			: body.reason === "quota" ? "3 automatic dreams ran today already"
			: body.reason === "no_activity" ? "no session has new entries" : "it is not due";
		return `${why}${typeof body.retryAt === "string" ? `; next possible at ${body.retryAt}` : ""}`;
	}
	if (status === 404) return "the pika server has no memory dream API (HTTP 404): it needs a newer pika";
	if (status === 400) return `the pika server refused the request: ${typeof body.message === "string" ? body.message : "bad request"}`;
	return error.message;
}

/** Dreams: background child sessions that consolidate memory, started when a session idles or by `/memory dream`. */
export default function dreamExtension(pi: ExtensionAPI): void {
	const self = {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Armed by `agent_settled` and not yet fired or cancelled: one request per settled run at most. */
	let waiting = false;
	/** Open dialogs. */
	let uiDepth = 0;
	/** Counts preemptions, so a dream requested before one does not start. */
	let epoch = 0;
	let settledCtx: ExtensionContext | undefined;

	const cancelIdle = () => {
		clearTimeout(timer);
		timer = undefined;
		waiting = false;
	};

	function arm(ctx: ExtensionContext): void {
		clearTimeout(timer);
		timer = undefined;
		const settings = loadMemorySettings(getAgentDir());
		if (!settings.autoDream) { waiting = false; return; }
		waiting = true;
		settledCtx = ctx;
		timer = setTimeout(() => fire(ctx), settings.dreamIdleMinutes * 60_000);
		timer.unref?.();
	}

	function fire(ctx: ExtensionContext): void {
		timer = undefined;
		if (!waiting) return;
		waiting = false;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages() || uiDepth > 0) return;
			if (!isTopLevel(ctx) || !loadMemorySettings(getAgentDir()).autoDream) return;
			if (credentialsProblem(cwdOf(ctx))) return;
		} catch { return; /* a stale context */ }
		void begin(ctx, "auto").catch(() => {});
	}

	/** Stops this session's dream, without waiting for the server. */
	function preempt(reason: string): void {
		epoch++;
		const run = shared().running;
		if (run?.owner === self) run.stop("aborted", reason);
	}

	/** Requests a lease and starts a dream; the text says why not when it did not start. */
	async function begin(ctx: ExtensionContext, mode: DreamMode): Promise<{ run?: DreamRun; text: string }> {
		const state = shared();
		if (state.running || state.starting) return { text: "a dream is already running in this pi process; /memory stop stops it" };
		const cwd = cwdOf(ctx);
		const problem = credentialsProblem(cwd);
		if (problem) return { text: problem };
		const settings = loadMemorySettings(getAgentDir());
		const { model, note } = pickModel(ctx, settings);
		if (!model) return { text: "this session has no model to dream with; select one, or set memory.dreamModel" };
		state.starting = self;
		const started = epoch;
		try {
			const repository = where(await resolveRepository(cwd));
			if (!repository.project && !repository.repository) return { text: `${cwd} is not in a git repository pika can name, so it has no project memory to dream over` };
			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			let grant: Grant;
			try {
				grant = await request<Grant>(cwd, "POST", "memory/dream/lease", { body: { ...repository, sessionId: parentSessionId, mode } });
			} catch (error) {
				return { text: leaseRefusal(error) };
			}
			if (!grant?.lease?.id) return { text: "the pika server sent no lease" };
			grant.sessions = Array.isArray(grant.sessions) ? grant.sessions : [];
			let index: string | null = null;
			const preempted = () => {
				if (epoch === started) return false;
				void request(cwd, "POST", `memory/dream/${encodeURIComponent(grant.lease.id)}/release`, { body: { outcome: "aborted" } }).catch(() => {});
				return true;
			};
			if (preempted()) return { text: "the session got input meanwhile" };
			try {
				const view = await request<MemoryView>(cwd, "GET", `memory?${new URLSearchParams({ ...repository })}`, { timeoutMs: INDEX_TIMEOUT_MS });
				index = typeof view.index === "string" ? view.index : null;
			} catch { /* the child reads it with memory_read */ }
			if (preempted()) return { text: "the session got input meanwhile" };
			const ui = ctx.hasUI ? { setStatus: (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text), notify: (text: string, type: "info" | "warning" | "error") => ctx.ui.notify(text, type) } : undefined;
			const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
			const modelRuntime = modelRuntimeOf(ctx.modelRegistry);
			const run = new DreamRun({
				owner: self, mode, grant, cwd, repository, parentSessionId, ...(parentSessionFile ? { parentSessionFile } : {}), agentDir: getAgentDir(),
				index, model, ...(note ? { modelNote: note } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), ...(modelRuntime ? { modelRuntime } : {}), ...(ui ? { ui } : {}),
				spawn: (options) => dreamRuntime.spawn(options),
				tools: dreamTools,
				kickoff: (current) => kickoffText(current, index),
				onEnd: (ended) => {
					const now = shared();
					if (now.running === ended) now.running = undefined;
					now.last = ended;
				},
			});
			state.running = run;
			void run.start().catch((error: unknown) => run.stop("failed", errorText(error)));
			const count = grant.sessions.length;
			return { run, text: `dreaming over ${count} session${count === 1 ? "" : "s"} of ${grant.lease.scope?.label ?? "this project"} on ${model.provider}/${model.id}` };
		} finally {
			if (state.starting === self) state.starting = undefined;
		}
	}

	function statusText(ctx: ExtensionContext): string {
		const settings = loadMemorySettings(getAgentDir());
		const { model, note } = pickModel(ctx, settings);
		const lines = [
			`Dreams: automatic dreams ${settings.autoDream ? "on" : "off"} (memory.autoDream), after ${settings.dreamIdleMinutes} idle minute${settings.dreamIdleMinutes === 1 ? "" : "s"} (memory.dreamIdleMinutes).`,
			note ? `Dream model: ${note}.` : `Dream model: ${model ? `${model.provider}/${model.id}` : "none"} (memory.dreamModel).`,
			`Caps: wrap up at ${dreamLimits.wrapUpTurns} turns, stop at ${dreamLimits.abortTurns}, ${dreamLimits.maxTokens} tokens, or ${Math.round(dreamLimits.maxMs / 60_000)} minutes.`,
		];
		const problem = credentialsProblem(cwdOf(ctx));
		if (problem) lines.push(`This session cannot dream: ${problem}.`);
		const dream = currentDream();
		lines.push(dream ? dream.describe() : "No dream has run in this pi process.");
		return lines.join("\n");
	}

	pi.on("session_start", () => { cancelIdle(); uiDepth = 0; });

	pi.on("agent_settled", (_event, ctx) => {
		try {
			if (!isTopLevel(ctx)) return;
			arm(ctx);
		} catch { /* dreams never fail a turn */ }
	});

	pi.on("ui_prompt_start", () => {
		uiDepth++;
		clearTimeout(timer);
		timer = undefined;
	});
	pi.on("ui_prompt_end", () => {
		uiDepth = Math.max(0, uiDepth - 1);
		// The idle wait starts over once the dialog closed.
		if (waiting && uiDepth === 0 && settledCtx) {
			try { arm(settledCtx); } catch { waiting = false; }
		}
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return undefined;
		cancelIdle();
		preempt("the user sent a message");
		return undefined;
	});

	pi.on("before_agent_start", () => {
		cancelIdle();
		preempt("the session started a run");
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		cancelIdle();
		settledCtx = undefined;
		const run = shared().running;
		preempt("the session ended");
		// The child's own shutdown is bounded; the lease's release is never waited for.
		if (run?.owner === self) {
			let wait: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([run.done, new Promise<void>((resolve) => { wait = setTimeout(resolve, dreamLimits.shutdownMs + 1_000); })]);
			clearTimeout(wait);
		}
	});

	pi.registerCommand("memory", {
		description: "Show memory dream status, start a dream now, or stop the running one",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim();
			const items = SUBCOMMANDS.filter((name) => name.startsWith(typed) && name !== typed).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (rest.length) { ctx.ui.notify(USAGE, "error"); return; }
			if (command === "status") ctx.ui.notify(statusText(ctx), "info");
			else if (command === "dream") {
				if (!ctx.isIdle()) { ctx.ui.notify("pika memory: the agent is busy; run /memory dream once it is idle.", "warning"); return; }
				const { run, text } = await begin(ctx, "manual");
				ctx.ui.notify(`pika memory: ${run ? text : `no dream: ${text}`}.`, run ? "info" : "warning");
			} else if (command === "stop") {
				const run = shared().running;
				if (!run) { ctx.ui.notify("pika memory: no dream is running.", "info"); return; }
				run.stop("aborted", "stopped with /memory stop");
			} else ctx.ui.notify(USAGE, "error");
		},
	});
}
