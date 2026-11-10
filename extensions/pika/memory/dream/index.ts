import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadMemorySettings, type MemorySettings } from "../../config.ts";
import { credentialsRegistry } from "../../credentials.ts";
import { resolveRepository } from "../../repository.ts";
import { disabledCause, MemoryServerError } from "../client.ts";
import { DREAM_ENTRY, type DreamRecord } from "../entries.ts";
import type { MemoryView, Note } from "../format.ts";
import { memoryLogItems, showMemoryLog } from "../log.ts";
import { cwdOf, where } from "../tools.ts";
import { SESSION_LINK_TYPE, spawnDreamChild } from "./child.ts";
import { kickoffText } from "./prompt.ts";
import { credentialsChange, type DreamChild, type DreamMode, DreamRun, dreamLimits, type Grant, type SpawnOptions } from "./run.ts";
import { type LeaseServer, send } from "./server.ts";
import { dreamTools } from "./tools.ts";

export { dreamLimits } from "./run.ts";

/** How dreams spawn their child; tests replace it. */
export const dreamRuntime: { spawn: (options: SpawnOptions) => Promise<DreamChild> } = { spawn: spawnDreamChild };

/** How long the kickoff's index fetch may take. */
const INDEX_TIMEOUT_MS = 5_000;
/** How long a lease request waits for the last release, which it would otherwise race and find the lease still held. */
const RELEASE_WAIT_MS = 5_000;
const STATUS_KEY = "pika-memory";
const USAGE = "Usage: /memory [status|dream|stop|log]";
const SUBCOMMANDS = ["status", "dream", "stop", "log"];

// One dream per process, whichever module copy started it.
const SHARED = Symbol.for("pi-extensions.pika.memory.dream");
/** A dream being requested; `cancelled` says why it must not start after all. */
interface Starting { owner: object; cancelled?: string }
interface Shared {
	/** The running dream, until its end, which may wait for a commit in flight. */
	running?: DreamRun;
	/** Set while a dream is being requested, so a second one is not. */
	starting?: Starting;
	/** The dream that ended last. */
	last?: DreamRun;
	/** The last lease release sent; a new lease request waits for it a while. */
	released?: Promise<void>;
}
const shared = (): Shared => (globalThis as { [SHARED]?: Shared })[SHARED] ??= {};

/** The running dream, or the last one; for tests and `/memory status`. */
export const currentDream = (): DreamRun | undefined => shared().running ?? shared().last;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Waits for `promise`, at most `ms`; never rejects. */
async function within(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
	if (!promise) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([promise.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
	clearTimeout(timer);
}

/** A top-level TUI or RPC session: never a child, which runs without a mode or carries a session link. */
function isTopLevel(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/** Why this session cannot dream, if it cannot: disabled, logged out, or excluded. */
function credentialsProblem(cwd: string): string | undefined {
	const value = credentialsRegistry().current;
	if (!value) {
		const cause = disabledCause();
		return cause ? `pika is disabled: ${cause}` : "pika is not logged in to a server; run /pika login";
	}
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
	let settledCtx: ExtensionContext | undefined;
	/** Set once this session is being replaced by another (`/new`, `/resume`, `/fork`): a dream it asked for that ends now records nothing. */
	let replaced = false;

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
			// A session kept only in memory (`--no-session`) never dreams by itself.
			if (!ctx.sessionManager.getSessionFile()) return;
			if (credentialsProblem(cwdOf(ctx))) return;
		} catch { return; /* a stale context */ }
		void begin(ctx, "auto").catch(() => {});
	}

	/** Stops this session's dream, or the one it is requesting, without waiting for the server. */
	function preempt(reason: string): void {
		const state = shared();
		if (state.starting?.owner === self) state.starting.cancelled ??= reason;
		if (state.running?.owner === self) state.running.stop("stopped", reason);
	}

	/**
	 * Records how a dream ended in the session that asked for it, while that session is still the current one: never
	 * after the user switched sessions, whose old context is stale then, and never in a child. Never throws.
	 */
	function record(ctx: ExtensionContext, run: DreamRun): void {
		try {
			if (replaced || run.owner !== self || !isTopLevel(ctx) || ctx.sessionManager.getSessionId() !== run.options.parentSessionId) return;
			pi.appendEntry<DreamRecord>(DREAM_ENTRY, run.record());
		} catch { /* a stale context: the session was replaced */ }
	}

	/** Requests a lease and starts a dream; the text says why not when it did not start. */
	async function begin(ctx: ExtensionContext, mode: DreamMode): Promise<{ run?: DreamRun; text: string }> {
		const state = shared();
		if (state.running?.ended) return { text: "the last dream is still waiting for its commit's answer" };
		if (state.running || state.starting) return { text: "a dream is already running in this pi process; /memory stop stops it" };
		const cwd = cwdOf(ctx);
		const problem = credentialsProblem(cwd);
		if (problem) return { text: problem };
		// Every lease request goes to the server and token that granted it, even once pika's credentials change.
		const { url, token } = credentialsRegistry().current!;
		const server: LeaseServer = { url, token };
		const settings = loadMemorySettings(getAgentDir());
		const { model, note } = pickModel(ctx, settings);
		if (!model) return { text: "this session has no model to dream with; select one, or set memory.dreamModel" };
		const starting: Starting = { owner: self };
		state.starting = starting;
		/** Why the dream must not start any more, checked after every wait: stopped, preempted, or pika's credentials changed. */
		const cancelled = () => starting.cancelled ?? credentialsChange(credentialsRegistry().current, server, cwd);
		try {
			await within(state.released, RELEASE_WAIT_MS);
			const repository = where(await resolveRepository(cwd));
			let why = cancelled();
			if (why) return { text: why };
			if (!repository.project && !repository.repository) return { text: `${cwd} is not in a git repository pika can name, so it has no project memory to dream over` };
			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			let grant: Grant;
			try {
				grant = await send<Grant>(server, "POST", "memory/dream/lease", { body: { ...repository, sessionId: parentSessionId, mode } });
			} catch (error) {
				return { text: leaseRefusal(error) };
			}
			if (!grant?.lease?.id) return { text: "the pika server sent no lease" };
			grant.sessions = Array.isArray(grant.sessions) ? grant.sessions : [];
			const release = (reason: string) => {
				state.released = send(server, "POST", `memory/dream/${encodeURIComponent(grant.lease.id)}/release`, { body: { outcome: "aborted" } }).then(() => {}, () => {});
				return { text: reason };
			};
			why = cancelled();
			if (why) return release(why);
			let index: string | null = null;
			let notes: Note[] = [];
			try {
				const view = await send<MemoryView>(server, "GET", `memory?${new URLSearchParams({ ...repository })}`, { timeoutMs: INDEX_TIMEOUT_MS });
				index = typeof view.index === "string" ? view.index : null;
				notes = Array.isArray(view.notes) ? view.notes : [];
			} catch { /* the child reads it with memory_read */ }
			why = cancelled();
			if (why) return release(why);
			const ui = ctx.hasUI ? { setStatus: (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text), notify: (text: string, type: "info" | "warning" | "error") => ctx.ui.notify(text, type) } : undefined;
			const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
			const modelRuntime = modelRuntimeOf(ctx.modelRegistry);
			const run = new DreamRun({
				owner: self, mode, grant, server, cwd, repository, parentSessionId, ...(parentSessionFile ? { parentSessionFile } : {}), agentDir: getAgentDir(),
				index, model, ...(note ? { modelNote: note } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), ...(modelRuntime ? { modelRuntime } : {}), ...(ui ? { ui } : {}),
				spawn: (options) => dreamRuntime.spawn(options),
				tools: dreamTools,
				kickoff: (current) => kickoffText(current, index, notes),
				onEnd: (ended) => {
					const now = shared();
					if (now.running === ended) now.running = undefined;
					now.last = ended;
					now.released = ended.released;
					record(ctx, ended);
				},
			});
			state.running = run;
			void run.start().catch((error: unknown) => run.stop("failed", errorText(error)));
			const count = grant.sessions.length;
			return { run, text: `dreaming over ${count} session${count === 1 ? "" : "s"} of ${grant.lease.scope?.label ?? "this project"} on ${model.provider}/${model.id}` };
		} finally {
			if (state.starting === starting) state.starting = undefined;
		}
	}

	function statusText(ctx: ExtensionContext): string {
		const settings = loadMemorySettings(getAgentDir());
		const { model, note } = pickModel(ctx, settings);
		const lines = [
			`Dreams: automatic dreams ${settings.autoDream ? "on" : "off"} (memory.autoDream), after ${settings.dreamIdleMinutes} idle minute${settings.dreamIdleMinutes === 1 ? "" : "s"} (memory.dreamIdleMinutes).`,
			note ? `Dream model: ${note}.` : `Dream model: ${model ? `${model.provider}/${model.id}` : "none"} (memory.dreamModel).`,
			`Caps: stop past ${dreamLimits.abortTurns} turns, ${dreamLimits.maxTokens} budget tokens (cache reads count a tenth), or ${Math.round(dreamLimits.maxMs / 60_000)} minutes; `
				+ `wrap up at ${dreamLimits.wrapUpTurns} turns, ${Math.round(dreamLimits.wrapUpShare * 100)}% of the tokens or time, or a context past ${dreamLimits.wrapUpContext} tokens.`,
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

	// `!` commands are activity too, though they emit no `input`: the idle wait starts over.
	pi.on("user_bash", () => {
		if (waiting && uiDepth === 0 && settledCtx) {
			try { arm(settledCtx); } catch { waiting = false; }
		}
		return undefined;
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

	pi.on("session_shutdown", async (event) => {
		cancelIdle();
		settledCtx = undefined;
		// Quitting or reloading keeps the session; the others switch to another one.
		if (event.reason !== "quit" && event.reason !== "reload") replaced = true;
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
		description: "Show memory dream status, start a dream now, stop the running one, or browse this branch's memory activity",
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
				const state = shared();
				const run = state.running;
				if (run && !run.ended) run.stop("stopped", "stopped with /memory stop");
				else if (state.starting) {
					state.starting.cancelled ??= "stopped with /memory stop";
					ctx.ui.notify("pika memory: the dream being requested will not start.", "info");
				} else if (run) ctx.ui.notify("pika memory: the dream is stopping; it waits for its commit's answer.", "info");
				else ctx.ui.notify("pika memory: no dream is running.", "info");
			} else if (command === "log") {
				if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/memory log opens only in the interactive TUI.", "info"); return; }
				const items = memoryLogItems(ctx.sessionManager.getBranch());
				if (!items.length) { ctx.ui.notify("No memory activity on this branch.", "info"); return; }
				await showMemoryLog(ctx, items);
			} else ctx.ui.notify(USAGE, "error");
		},
	});
}
