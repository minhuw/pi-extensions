import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MagpieModel } from "./model-aliases.ts";
import { isMagpieQuotaError, queryMagpieQuotaWait, type MagpieConnection } from "./quota.ts";

const ENTRY = "magpie-auto-continue";
const STATUS = "magpie-quota";
const GRACE_MS = 30_000;
const COMMAND = "/magpie-auto-continue";
interface Wait {
	model: string;
	api: string;
	target: string;
	origin: string;
	retryAt: number;
	failedAt: number;
}
interface Snapshot { version: 1; enabled: boolean; wait?: Wait }
interface Runtime {
	ctx: ExtensionContext;
	enabled: boolean;
	wait?: Wait;
	candidate?: Wait;
	/** In-memory only: never persist the key or its fingerprint. */
	authTag?: string;
	last?: AssistantMessage;
	phase?: "checking" | "waiting" | "paused";
	reason?: string;
	lookup?: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	epoch: number;
	uiDepth: number;
	closed: boolean;
	resuming: boolean;
}

function eligible(ctx: ExtensionContext): boolean {
	return (ctx.mode === "tui" || ctx.mode === "rpc") && !ctx.sessionManager.getEntries()
		.some(entry => entry.type === "custom" && entry.customType === "pi-extensions.session-link");
}
function target(model: MagpieModel): string { return model.magpieAliasTarget ?? model.id; }
function matches(ctx: ExtensionContext, wait: Wait): boolean {
	return ctx.model?.provider === "magpie" && ctx.model.id === wait.model && ctx.model.api === wait.api
		&& target(ctx.model) === wait.target;
}
function latestAssistant(ctx: ExtensionContext): AssistantMessage | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}
function sameFailure(ctx: ExtensionContext, wait: Wait): boolean {
	const last = latestAssistant(ctx);
	return last?.provider === "magpie" && last.model === wait.model && last.timestamp === wait.failedAt && last.stopReason === "error";
}
function restore(ctx: ExtensionContext): Snapshot {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as Partial<Snapshot> | undefined;
		if (data?.version !== 1 || typeof data.enabled !== "boolean") break;
		const w = data.wait;
		const valid = w && [w.model, w.api, w.target, w.origin].every(value => typeof value === "string" && value.length > 0)
			&& Number.isFinite(w.retryAt) && Number.isFinite(w.failedAt);
		return { version: 1, enabled: data.enabled, ...(valid ? { wait: w } : {}) };
	}
	return { version: 1, enabled: true };
}
function remaining(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function when(at: number): string {
	return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
async function connection(ctx: ExtensionContext): Promise<MagpieConnection> {
	if (ctx.model?.provider !== "magpie") throw new Error("Select the original Magpie model before resuming.");
	// The registry pairs the effective credential with its endpoint, including
	// runtime auth and a saved login that supersedes a stale selected baseUrl.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model).catch(() => undefined);
	if (!auth?.ok || !auth.apiKey) throw new Error("Magpie credentials are unavailable; check /login magpie.");
	try {
		const url = new URL(auth.baseUrl ?? ctx.model.baseUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
			|| !/^\/(?:v1\/?)?$/.test(url.pathname)) throw new Error();
		return { origin: url.origin, apiKey: auth.apiKey };
	} catch { throw new Error("Magpie gateway configuration is invalid; check /login magpie."); }
}
function authTag(config: MagpieConnection): string {
	return createHash("sha256").update(config.origin).update("\0").update(config.apiKey).digest("hex");
}

/** A quota wait belongs to one interactive session and one failed model call. */
export function registerMagpieAutoContinue(pi: ExtensionAPI): void {
	const runtimes = new Map<string, Runtime>();
	function get(ctx: ExtensionContext): Runtime | undefined {
		const r = runtimes.get(ctx.sessionManager.getSessionId());
		if (r) r.ctx = ctx;
		return r;
	}
	function status(r: Runtime): void {
		let text: string | undefined;
		if (r.phase === "checking") text = "quota · checking reset time";
		else if (r.phase === "paused") text = `quota paused · ${r.reason ?? "resume manually"}`;
		else if (r.phase === "waiting" && r.wait) {
			text = `quota awaiting · ${Date.now() < r.wait.retryAt ? `retry in ${remaining(r.wait.retryAt - Date.now())}` : "waiting for idle"} · ${when(r.wait.retryAt)}`;
		}
		r.ctx.ui.setStatus(STATUS, text);
	}
	function persist(r: Runtime): void {
		pi.appendEntry<Snapshot>(ENTRY, { version: 1, enabled: r.enabled, ...(r.wait ? { wait: { ...r.wait } } : {}) });
	}
	function invalidate(r: Runtime): void {
		r.epoch++;
		r.lookup?.abort(); r.lookup = undefined;
		if (r.timer) clearTimeout(r.timer);
		r.timer = undefined;
		r.resuming = false;
	}
	function clear(r: Runtime, save = true): void {
		const hadState = r.wait || r.candidate || r.phase;
		invalidate(r);
		r.wait = r.candidate = undefined;
		r.authTag = r.reason = r.phase = undefined;
		if (save && hadState) persist(r);
		status(r);
	}
	function pause(r: Runtime, reason: string): void {
		invalidate(r);
		r.candidate = undefined;
		r.phase = "paused"; r.reason = reason;
		persist(r); status(r);
	}
	function ensure(ctx: ExtensionContext): Runtime | undefined {
		if (!eligible(ctx)) return undefined;
		const known = get(ctx);
		if (known && !known.closed) return known;
		const saved = restore(ctx);
		const r: Runtime = { ctx, enabled: saved.enabled, epoch: 0, uiDepth: 0, closed: false, resuming: false };
		if (saved.enabled && saved.wait && matches(ctx, saved.wait) && sameFailure(ctx, saved.wait)) {
			r.wait = saved.wait; r.phase = "paused"; r.reason = `${COMMAND} resume`;
		}
		runtimes.set(ctx.sessionManager.getSessionId(), r);
		status(r);
		return r;
	}
	function arm(r: Runtime): void {
		if (r.timer) clearTimeout(r.timer);
		r.timer = undefined;
		if (r.closed || r.phase !== "waiting" || !r.wait || r.resuming) return;
		const busy = !r.ctx.isIdle() || r.ctx.hasPendingMessages() || r.uiDepth > 0;
		const delay = Math.min(30_000, Math.max(busy ? 1000 : 1, r.wait.retryAt - Date.now()));
		r.timer = setTimeout(() => {
			r.timer = undefined;
			void tick(r).catch(() => {
				if (!r.closed) {
					pause(r, "continuation failed; resume manually");
					r.ctx.ui.notify("Magpie auto-continue paused because continuation failed.", "error");
				}
			});
		}, delay);
		r.timer.unref?.();
	}
	async function tick(r: Runtime): Promise<void> {
		const wait = r.wait;
		if (r.closed || r.phase !== "waiting" || !wait) return;
		if (!matches(r.ctx, wait) || !sameFailure(r.ctx, wait)) { clear(r); return; }
		status(r);
		if (Date.now() < wait.retryAt || !r.ctx.isIdle() || r.ctx.hasPendingMessages() || r.uiDepth) { arm(r); return; }
		r.resuming = true;
		const epoch = r.epoch;
		let config: MagpieConnection;
		try { config = await connection(r.ctx); }
		catch {
			if (r.epoch === epoch && !r.closed) pause(r, "check /login magpie, then resume");
			return;
		}
		if (r.epoch !== epoch || r.closed) return;
		r.resuming = false;
		if (config.origin !== wait.origin || authTag(config) !== r.authTag) { pause(r, "gateway or credentials changed; resume manually"); return; }
		if (!matches(r.ctx, wait) || !sameFailure(r.ctx, wait)) { clear(r); return; }
		if (!r.ctx.isIdle() || r.ctx.hasPendingMessages() || r.uiDepth) { arm(r); return; }
		// Consume before dispatch. A failed send never leaves a recurring timer.
		clear(r);
		pi.sendMessage({
			customType: ENTRY,
			content: "The retry time reported by Magpie's quota data has arrived. Continue the previously interrupted task from the existing conversation. Check completed tool results before repeating any action. If the task is already finished, report that instead.",
			display: true,
			details: { kind: "continue", retryAt: wait.retryAt },
		}, { triggerTurn: true });
	}
	async function inspectFailure(r: Runtime, message: AssistantMessage): Promise<void> {
		const model = r.ctx.model as MagpieModel | undefined;
		if (!r.enabled || r.closed || !model || model.provider !== "magpie" || message.provider !== "magpie"
			|| message.model !== model.id || !isMagpieQuotaError(message.errorMessage ?? "")) return;
		// Keep the first useful observation across Pi's short retries: Magpie's
		// later route can contain no tries because every candidate is now resting.
		if (r.candidate && matches(r.ctx, r.candidate) && r.candidate.retryAt > Date.now()) return;
		invalidate(r);
		const epoch = r.epoch;
		const controller = new AbortController();
		r.lookup = controller;
		const signal = AbortSignal.any([controller.signal, ...(r.ctx.signal ? [r.ctx.signal] : [])]);
		r.phase = "checking"; status(r);
		try {
			const config = await connection(r.ctx);
			if (signal.aborted || r.epoch !== epoch || r.closed) return;
			const physical = target(model);
			const canonical = model.magpieRoute?.canonicalId ?? physical;
			const group = model.magpieRoute?.group || /^(?:auto|group)\//.test(canonical);
			const observation = await queryMagpieQuotaWait(config, {
				sessionId: r.ctx.sessionManager.getSessionId(), modelIds: [...new Set([model.id, physical, canonical])],
				...(!group && canonical.includes("/") ? { directModel: canonical } : {}),
				startedAt: message.timestamp, errorMessage: message.errorMessage ?? "",
			}, signal);
			if (signal.aborted || r.epoch !== epoch || r.closed) return;
			if (observation) {
				r.candidate = { model: model.id, api: model.api, target: physical, origin: config.origin,
					retryAt: observation.dueAt + GRACE_MS, failedAt: message.timestamp };
				r.authTag = authTag(config);
				r.reason = undefined;
			} else r.reason = "reset time unavailable";
		} catch (error) {
			if (signal.aborted || r.epoch !== epoch || r.closed) return;
			// Only quota.ts's own sanitized errors are exposed; credential/runtime
			// failures may contain secrets and get a fixed message instead.
			r.reason = "quota lookup failed";
			if (error instanceof Error && /^Magpie (?:quotas|route) /.test(error.message)) r.reason = error.message;
		} finally {
			if (r.epoch === epoch) r.lookup = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => { ensure(ctx); });
	pi.on("before_agent_start", (_event, ctx) => {
		const r = ensure(ctx);
		if (r) { clear(r); r.last = undefined; }
	});
	pi.on("message_end", async (event, ctx) => {
		const r = get(ctx);
		if (!r || r.closed || event.message.role !== "assistant") return;
		r.last = event.message;
		if (event.message.stopReason !== "error" || event.message.provider !== "magpie"
			|| ctx.model?.provider !== "magpie" || event.message.model !== ctx.model.id
			|| !isMagpieQuotaError(event.message.errorMessage ?? "")) { clear(r); return; }
		await inspectFailure(r, event.message);
	});
	pi.on("agent_settled", (event, ctx) => {
		const r = get(ctx);
		if (!r || r.closed) return;
		if (event.aborted || r.last?.stopReason !== "error" || !r.enabled) { clear(r); return; }
		if (r.candidate && matches(ctx, r.candidate)) {
			r.wait = { ...r.candidate, failedAt: r.last.timestamp };
			r.candidate = undefined; r.phase = "waiting"; r.reason = undefined;
			persist(r); status(r); arm(r);
			ctx.ui.notify(`Magpie quota wait: retry at ${when(r.wait.retryAt)}. ${COMMAND} cancel stops this wait.`, "info");
		} else if (r.reason) {
			pause(r, r.reason);
			ctx.ui.notify(`Magpie auto-continue paused: ${r.reason}. No retry time was guessed.`, "warning");
		} else clear(r);
	});
	pi.on("input", (_event, ctx) => { const r = get(ctx); if (r) clear(r); });
	pi.on("model_select", (_event, ctx) => { const r = get(ctx); if (r) clear(r); });
	pi.on("session_tree", (_event, ctx) => {
		const r = get(ctx);
		if (r) { clear(r, false); r.enabled = restore(ctx).enabled; persist(r); }
	});
	pi.on("session_compact", (_event, ctx) => { const r = get(ctx); if (r) clear(r); });
	pi.on("ui_prompt_start", (_event, ctx) => { const r = get(ctx); if (r) r.uiDepth++; });
	pi.on("ui_prompt_end", (_event, ctx) => {
		const r = get(ctx);
		if (r) { r.uiDepth = Math.max(0, r.uiDepth - 1); arm(r); }
	});
	const leave = (_event: unknown, ctx: ExtensionContext) => { const r = get(ctx); if (r) { clear(r); r.closed = true; } };
	pi.on("session_before_switch", leave);
	pi.on("session_before_fork", leave);
	pi.on("session_shutdown", (_event, ctx) => {
		const r = get(ctx);
		if (!r) return;
		invalidate(r); r.closed = true;
		// Keep the failed-call checkpoint for explicit resume after reload/restart.
		if (r.wait) persist(r);
		ctx.ui.setStatus(STATUS, undefined);
	});
	pi.registerCommand("magpie-auto-continue", {
		description: "Show, disable, cancel, or resume Magpie quota waits",
		async handler(args, ctx) {
			const r = ensure(ctx);
			if (!r) { ctx.ui.notify("Magpie auto-continue requires a top-level TUI or RPC session.", "warning"); return; }
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(!r.enabled ? "Magpie auto-continue is off for this session."
					: r.wait ? `Magpie auto-continue ${r.phase}: retry at ${when(r.wait.retryAt)}. ${r.reason ?? ""}`.trim()
					: r.reason ? `Magpie auto-continue paused: ${r.reason}.` : "Magpie auto-continue is on; no quota wait is pending.", "info");
			} else if (action === "off" || action === "on" || action === "cancel") {
				clear(r, false);
				if (action !== "cancel") r.enabled = action === "on";
				persist(r);
				ctx.ui.notify(action === "cancel" ? "Magpie quota wait cancelled."
					: `Magpie auto-continue is ${action} for this session.`, "info");
			} else if (action === "resume") {
				const wait = r.wait;
				if (!r.enabled || !wait || !matches(ctx, wait) || !sameFailure(ctx, wait)) {
					ctx.ui.notify("No matching quota wait to resume. Send a message to retry the task.", "warning"); return;
				}
				const epoch = r.epoch;
				try {
					const config = await connection(ctx);
					if (r.epoch !== epoch || r.closed || !matches(ctx, wait) || !sameFailure(ctx, wait)) return;
					if (config.origin !== wait.origin) { pause(r, "gateway changed; send a message to retry"); return; }
					r.authTag = authTag(config); r.phase = "waiting"; r.reason = undefined;
					persist(r); status(r); arm(r);
				} catch {
					if (r.epoch === epoch && !r.closed) pause(r, "check /login magpie, then resume");
				}
			} else ctx.ui.notify(`Usage: ${COMMAND} [status|on|off|cancel|resume]`, "warning");
		},
	});
}
