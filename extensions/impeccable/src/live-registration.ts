import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { LiveOwner, LIVE_MESSAGE, LIVE_SNAPSHOT, type LiveReply, type LiveSaved } from "./live.ts";
import { object } from "./project.ts";

/** Registers lazily: loading the extension never resolves an engine or touches native state. */
export function registerLive(pi: ExtensionAPI) {
	let owner: LiveOwner | undefined;
	let context: ExtensionContext | undefined;
	let episodeUsed = false;
	let disconnect: (() => void) | undefined;
	let lastNotice = "";
	const delivered = new Set<string>();
	const current = (ctx: ExtensionContext) => owner?.sessionId === ctx.sessionManager.getSessionId() ? owner : undefined;
	const valid = (details: unknown, ctx: ExtensionContext) => {
		const live = current(ctx);
		return object(details) && live?.phase === "pending" && details.sessionId === live.sessionId && details.activation === live.activation && details.eventToken === live.pending?.token;
	};
	const packet = (live: LiveOwner) => ({
		customType: LIVE_MESSAGE,
		content: `Impeccable native live event. Read reference/pi-runtime.md and the complete upstream live playbook. Handle this single event, verify artifacts, then use impeccable_live reply with its exact id/eventToken. The parent owns the reply. Never poll in Bash or acknowledge from a delegated role.\n${JSON.stringify(live.view())}`,
		display: true,
		details: { sessionId: live.sessionId, activation: live.activation, eventToken: live.pending!.token },
	});
	const mark = (live: LiveOwner) => {
		delivered.add(live.pending!.token);
		if (delivered.size > 64) delivered.delete(delivered.values().next().value!);
		episodeUsed = true;
	};
	const changed = (live: LiveOwner) => {
		if (owner !== live || !context || current(context) !== live) return;
		const saved = live.saved();
		if (saved) pi.appendEntry(LIVE_SNAPSHOT, saved);
		context.ui.setStatus("impeccable-live", `Impeccable: ${live.phase}${live.pending ? ` (${live.pending.event.type})` : ""}`);
		const notice = `${live.activation}:${live.phase}:${live.message ?? ""}`;
		if (live.phase === "paused" && live.message && notice !== lastNotice) {
			lastNotice = notice;
			context.ui.notify(`Impeccable live paused: ${live.message}. Use /impeccable-live status or explicit resume.`, "info");
		}
		if (live.phase !== "pending" || !live.pending || delivered.has(live.pending.token)) return;
		// Busy delivery uses a supported boundary, never a racing follow-up queue.
		if (context.isIdle() && !context.hasPendingMessages()) {
			mark(live);
			pi.sendMessage(packet(live), { triggerTurn: true });
		}
	};
	const pause = async (reason: string, stop = false) => {
		disconnect?.(); disconnect = undefined;
		await owner?.pause(reason, stop);
	};
	const get = async (ctx: ExtensionContext) => {
		context = ctx;
		if (owner && !current(ctx)) { await pause("Pi session replaced"); owner = undefined; }
		if (!owner) {
			owner = new LiveOwner(ctx.sessionManager.getSessionId(), changed);
			// Only this active branch and exact session may recover; forks inherit entries, not ownership.
			const entry = ctx.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === LIVE_SNAPSHOT);
			if (entry?.type === "custom" && object(entry.data) && entry.data.sessionId === owner.sessionId) await owner.restore(entry.data as unknown as LiveSaved);
		}
		return owner;
	};
	pi.on("session_start", (_event, ctx) => { context = ctx; episodeUsed = false; });
	pi.on("before_agent_start", async (event, ctx) => {
		context = ctx;
		if (event.messageType === "user") {
			if (current(ctx)?.pending && delivered.has(current(ctx)!.pending!.token)) await pause("New user episode interrupted pending work; explicit resume required");
			episodeUsed = false;
		}
	});
	pi.on("input", async (_event, ctx) => {
		context = ctx;
		if (current(ctx) && !["paused", "stopped"].includes(owner!.phase)) await pause("User input interrupted live work; explicit resume required");
	});
	pi.on("turn_start", (_event, ctx) => {
		context = ctx;
		disconnect?.();
		const signal = ctx.signal;
		const abort = () => { void pause("Model episode aborted; native work retained"); };
		if (signal) { signal.addEventListener("abort", abort, { once: true }); disconnect = () => signal.removeEventListener("abort", abort); }
	});
	pi.on("turn_end", async (event, ctx) => {
		context = ctx;
		const live = current(ctx);
		if (!live || live.phase !== "pending" || !live.pending) return;
		if (!event.context) { await pause("This Pi peer lacks actionable boundaries; use explicit status/resume"); return; }
		if (delivered.has(live.pending.token)) return;
		if (event.outcome !== "completed" || ctx.hasPendingMessages()) { await pause("Busy episode interrupted; explicit resume required"); return; }
		if (!episodeUsed) {
			mark(live);
			return { entries: [...event.entries, { type: "custom_message" as const, ...packet(live) }], continue: true };
		}
	});
	pi.on("agent_before_settle", async (_event, ctx) => {
		context = ctx;
		if (current(ctx)?.phase === "pending") await pause("Episode settled with pending native work; inspect status and explicitly resume");
	});
	pi.on("agent_settled", async (event) => {
		disconnect?.(); disconnect = undefined;
		if (event.aborted) await pause("Model episode aborted; native work retained");
	});
	// Validate queued custom messages at the final conversation projection before provider conversion.
	pi.on("context", (event, ctx) => ({ messages: event.messages.filter((m) => m.role !== "custom" || m.customType !== LIVE_MESSAGE || valid(m.details, ctx)) }));
	pi.on("session_before_switch", async () => { await pause("Pi session switch"); });
	pi.on("session_before_fork", async () => { await pause("Pi session fork"); });
	pi.on("session_before_tree", async () => { await pause("Pi branch navigation"); });
	pi.on("session_tree", (_event, ctx) => { owner = undefined; context = ctx; delivered.clear(); episodeUsed = false; });
	pi.on("session_shutdown", async (event) => { await pause(`Pi shutdown: ${event.reason}`); owner = undefined; context = undefined; delivered.clear(); });

	pi.registerTool({
		name: "impeccable_live", label: "Impeccable Live", executionMode: "sequential",
		description: "Own the native Impeccable overlay/helper and recovery journal in this Pi session. start/generate return immediately; native CLI waits in background. status inspects, reply acknowledges exactly one owned event, resume explicitly recovers this branch, stop releases owned resources while preserving work. Native instructions that say poll/reply/complete must use this owner. Never run a second poller. Accept verification is separate from native transport acknowledgement; verified requires evidence, carbonize requires complete after cleanup.",
		parameters: Type.Object({
			action: StringEnum(["start", "generate", "status", "reply", "resume", "stop"] as const),
			argv: Type.Optional(Type.Array(Type.String(), { maxItems: 256 })), cwd: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()), eventToken: Type.Optional(Type.String()),
			status: Type.Optional(StringEnum(["done", "steer_done", "error", "complete", "verified", "read"] as const)),
			file: Type.Optional(Type.String()), data: Type.Optional(Type.Any()), message: Type.Optional(Type.String()),
		}),
		outputSchema: Type.Any(),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const live = await get(ctx);
			let view;
			if (params.action === "start" || params.action === "generate") view = live.start(params.cwd ?? ctx.cwd, params.argv ?? [], params.action === "generate");
			else if (params.action === "resume") view = live.resume();
			else if (params.action === "stop") { await pause("Explicit live stop", true); view = live.view(); }
			else if (params.action === "reply") {
				if (!params.id || !params.eventToken || !params.status) throw new Error("reply requires id, eventToken and status");
				view = await live.reply(params as LiveReply);
			} else view = await live.status();
			return { content: [{ type: "text", text: JSON.stringify(view) }], details: view, structuredContent: JSON.parse(JSON.stringify(view)), isError: !view.ok };
		},
	});
	pi.registerCommand("impeccable-live", {
		description: "Immediate live status, stop or explicit resume (no model call)",
		async handler(args, ctx) {
			const live = await get(ctx);
			const action = args.trim() || "status";
			if (action === "stop") await pause("Human live stop", true);
			else if (action === "resume") live.resume();
			else if (action !== "status") throw new Error("Use /impeccable-live status|stop|resume");
			ctx.ui.notify(JSON.stringify(await live.status()), "info");
		},
	});
}
