import { randomBytes, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HELP, parseCommand } from "./command.ts";
import { clampDelay, completion, describe, ITERATION, makeLoop, MAX_LOOPS, restore, scheduleNext, SNAPSHOT, summary, terminal, type Loop } from "./state.ts";

interface Active {
	id: string;
	token: string;
	dispatchedAt: number;
	startedAt?: number;
	agentStarted?: boolean;
	text: string;
	outcome?: "completed" | "aborted" | "error";
	delay?: number;
}
interface Runtime {
	ctx: ExtensionContext;
	loops: Loop[];
	active?: Active;
	timer?: ReturnType<typeof setTimeout>;
	closed: boolean;
	uiDepth: number;
	lastStatus?: string;
}

/** Session-owned scheduler. No timers, storage, or processes are created at module load. */
export default function loopExtension(pi: ExtensionAPI): void {
	const runtimes = new Map<string, Runtime>();
	const get = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc"
		? runtimes.get(ctx.sessionManager.getSessionId()) : undefined;
	const persist = (r: Runtime) => pi.appendEntry(SNAPSHOT, { version: 1, loops: structuredClone(r.loops) });
	const activeLoop = (r: Runtime) => r.loops.find((loop) => loop.id === r.active?.id);
	function status(r: Runtime): void {
		const next = summary(r.loops, r.active?.id, Date.now());
		if (next !== r.lastStatus) { r.ctx.ui.setStatus("loop", next); r.lastStatus = next; }
	}
	function finish(r: Runtime, loop: Loop, state: "done" | "failed" | "stopped" | "paused", reason: string): void {
		loop.status = state;
		loop.reason = reason;
		loop.dueAt = null;
		persist(r);
		status(r);
		r.ctx.ui.notify(`Loop ${loop.name}: ${reason}.`, state === "failed" ? "warning" : "info");
	}
	function interrupt(r: Runtime, reason: string): void {
		const loop = activeLoop(r);
		if (loop && !terminal(loop)) finish(r, loop, "paused", reason);
		r.active = undefined;
		status(r);
	}
	function arm(r: Runtime, soon = false): void {
		if (r.timer) clearTimeout(r.timer);
		r.timer = undefined;
		if (r.closed) return;
		const live = r.loops.filter((l) => !terminal(l) && l.status !== "paused");
		if (!live.length && !r.active) return;
		const now = Date.now();
		let delay = 30_000; // Refresh minute-level footer status, including when idle.
		for (const loop of live) {
			delay = Math.min(delay, Math.max(1, loop.deadline - now));
			if (!r.active && loop.dueAt !== null) delay = Math.min(delay, Math.max(1, loop.dueAt - now));
		}
		if (r.active) {
			const loop = activeLoop(r)!;
			const limit = r.active.startedAt === undefined ? 30_000 : loop.timeoutMs;
			// Once paused/stopped, keep the dispatch lock until Pi settles, without re-aborting.
			if (loop.status === "running") delay = Math.min(delay, Math.max(1, (r.active.startedAt ?? r.active.dispatchedAt) + limit - now));
		}
		if (soon) delay = 1;
		// A due loop waits outside Pi's queue, so stop/pause can still cancel it.
		if (!r.active && (!r.ctx.isIdle() || r.ctx.hasPendingMessages() || r.uiDepth)) delay = Math.max(1000, delay);
		r.timer = setTimeout(() => {
			r.timer = undefined;
			try { tick(r); }
			catch (error) {
				// Storage or scheduling errors must never turn into an uncaught timer exception.
				for (const loop of r.loops) if (!terminal(loop)) { loop.status = "paused"; loop.dueAt = null; loop.reason = "scheduler error"; }
				r.ctx.ui.notify(`Loop scheduler paused: ${String(error)}`, "error");
				status(r);
			}
		}, delay);
		r.timer.unref?.();
	}
	function tick(r: Runtime): void {
		if (r.closed) return;
		const now = Date.now();
		for (const loop of r.loops) {
			if (terminal(loop) || loop.status === "paused") continue;
			if (now >= loop.deadline) {
				finish(r, loop, "done", "time limit reached");
				if (r.active?.id === loop.id && r.active.startedAt !== undefined) r.ctx.abort();
			}
		}
		const active = r.active;
		if (active) {
			const loop = r.loops.find((l) => l.id === active.id)!;
			if (loop.status === "running" && now >= (active.startedAt ?? active.dispatchedAt) + (active.startedAt === undefined ? 30_000 : loop.timeoutMs)) {
				finish(r, loop, "paused", active.startedAt === undefined ? "iteration did not start; resume to retry" : "iteration timed out; resume to retry");
				if (active.startedAt !== undefined) r.ctx.abort();
				else r.active = undefined;
			}
		}
		if (!r.active && r.ctx.isIdle() && !r.ctx.hasPendingMessages() && r.uiDepth === 0) {
			const next = r.loops.filter((l) => l.status === "scheduled" && l.dueAt !== null && l.dueAt <= now)
				.sort((a, b) => a.dueAt! - b.dueAt!)[0];
			if (next) {
				if (next.iteration >= next.max) finish(r, next, "done", "iteration limit reached");
				else if ((r.ctx.getContextUsage()?.percent ?? 0) >= 90) finish(r, next, "paused", "context usage reached 90%; compact before resuming");
				else dispatch(r, next);
			}
		}
		status(r);
		arm(r);
	}
	function dispatch(r: Runtime, loop: Loop): void {
		loop.iteration++;
		loop.status = "running";
		loop.dueAt = null;
		loop.reason = undefined;
		const active: Active = { id: loop.id, token: randomUUID(), dispatchedAt: Date.now(), text: "" };
		r.active = active;
		// Record dispatch before delivery: an interrupted iteration is never silently replayed.
		persist(r);
		const pacing = loop.schedule.kind === "dynamic"
			? "If another pass is needed, call loop_schedule with a delay of 60–3600 seconds and a reason. Without it, the next pass defaults to five minutes after settlement."
			: "The extension owns the fixed schedule. Finish this pass and it will schedule the next one; do not sleep or poll inside this turn.";
		pi.sendMessage({ customType: ITERATION, display: true, details: { id: loop.id, token: active.token }, content: [
			`/loop ${loop.name}: iteration ${loop.iteration}/${loop.max}`,
			"Perform one pass of the user's recurring task below. Use the existing session context and report meaningful changes.",
			pacing,
			"Call loop_stop with a reason when the objective is complete, further passes are unhelpful, or a human decision is required. These tools control only this loop. Existing tool permissions and approval rules still apply.",
			loop.until ? `Completion text to report when satisfied: ${JSON.stringify(loop.until)}.` : "",
			"User task:", loop.prompt,
		].filter(Boolean).join("\n\n") }, { triggerTurn: true, deliverAs: "followUp" });
	}
	function requireRuntime(ctx: ExtensionContext): Runtime {
		const r = get(ctx);
		if (!r || r.closed) throw new Error("/loop requires an active TUI or RPC session.");
		return r;
	}
	function owner(ctx: ExtensionContext): { r: Runtime; loop: Loop; active: Active } {
		const r = requireRuntime(ctx);
		const active = r.active;
		const loop = activeLoop(r);
		if (!active || active.startedAt === undefined || !loop || loop.status !== "running") throw new Error("This tool can only control the loop that owns the current iteration.");
		return { r, loop, active };
	}
	const reasonSchema = Type.String({ minLength: 1, maxLength: 1000 });
	pi.registerTool({
		name: "loop_schedule", label: "Loop Schedule", executionMode: "sequential",
		description: "Choose the delay before the next pass of the current model-paced /loop. Only usable inside its own iteration; does not create loops or change fixed schedules.",
		parameters: Type.Object({ delaySeconds: Type.Number(), reason: reasonSchema }),
		async execute(_id, params, _signal, _update, ctx) {
			const { r, loop, active } = owner(ctx);
			if (!Number.isFinite(params.delaySeconds)) throw new Error("Delay must be finite.");
			if (loop.schedule.kind !== "dynamic") throw new Error("This loop has a fixed schedule; its cadence cannot be changed by the model.");
			active.delay = clampDelay(params.delaySeconds);
			loop.reason = params.reason;
			persist(r);
			return { content: [{ type: "text", text: `Next pass ${active.delay}s after this iteration settles: ${params.reason}` }], details: { id: loop.id, delaySeconds: active.delay } };
		},
	});
	pi.registerTool({
		name: "loop_stop", label: "Loop Stop", executionMode: "sequential",
		description: "Finish the /loop that owns this iteration, with a reason. Does not stop other loops or abort the current response.",
		parameters: Type.Object({ reason: reasonSchema }),
		async execute(_id, params, _signal, _update, ctx) {
			const { r, loop } = owner(ctx);
			finish(r, loop, "done", params.reason);
			arm(r);
			return { content: [{ type: "text", text: `Finished loop ${loop.name}: ${params.reason}` }], details: { id: loop.id } };
		},
	});
	pi.registerCommand("loop", {
		description: "Repeat a prompt: /loop [5m] <task> | --cron <expression> <task> | list | pause|resume|stop [name|id|all]",
		handler: async (args, ctx) => {
			try {
				const command = parseCommand(args);
				if (command.action === "help") { ctx.ui.notify(HELP, "info"); return; }
				const r = requireRuntime(ctx);
				if (command.action === "list") {
					const loops = command.target ? r.loops.filter((l) => l.id === command.target || l.name === command.target) : r.loops;
					ctx.ui.notify(loops.length ? loops.map((l) => describe(l, Date.now())).join("\n") : "No loops.", "info");
					return;
				}
				if (command.action === "start") {
					if (r.loops.filter((l) => !terminal(l)).length >= MAX_LOOPS) throw new Error(`At most ${MAX_LOOPS} live loops are supported. Stop one first.`);
					const id = randomBytes(4).toString("hex");
					const loop = makeLoop(command.options, id, Date.now());
					if (r.loops.some((l) => l.id === loop.name || l.name === loop.name || l.name === loop.id || l.id === loop.id)) throw new Error(`Loop name '${loop.name}' is already in use.`);
					// Keep the active record until settlement, even if its loop is terminal.
					if (r.loops.length >= 100) {
						const oldestTerminal = r.loops.findIndex((l) => terminal(l) && l.id !== r.active?.id);
						if (oldestTerminal >= 0) r.loops.splice(oldestTerminal, 1);
					}
					r.loops.push(loop);
					persist(r); status(r); arm(r, true);
					ctx.ui.notify(`Started loop ${loop.name}; ${loop.max} passes maximum. /loop stop ${loop.name} to stop.`, "info");
					return;
				}
				const candidates = r.loops.filter((l) => !terminal(l));
				const chosen = command.target === "all" ? candidates : command.target
					? candidates.filter((l) => l.name === command.target || l.id === command.target)
					: candidates.length === 1 ? candidates : [];
				if (!chosen.length) throw new Error("Specify a loop name or id (or all). Use /loop list.");
				if (command.action === "resume") {
					const blocked = chosen.find((loop) => loop.status === "paused" && (r.active?.id === loop.id || loop.deadline <= Date.now() || loop.iteration >= loop.max));
					if (blocked) throw new Error(r.active?.id === blocked.id ? `Wait for loop ${blocked.name}'s current iteration to settle before resuming.` : `Loop ${blocked.name} reached its limits; start a new loop.`);
				}
				for (const loop of chosen) {
					if (command.action === "resume") {
						if (loop.status !== "paused") continue;
						loop.status = "scheduled"; loop.reason = "resumed by user";
						scheduleNext(loop, Date.now(), 60);
					} else {
						finish(r, loop, command.action === "pause" ? "paused" : "stopped", `${command.action === "pause" ? "paused" : "stopped"} by user`);
						// A later extension may still be awaiting before_agent_start after
						// our ownership check. Abort that prepared run immediately too.
						if (r.active?.id === loop.id && r.active.startedAt !== undefined && !r.active.agentStarted) ctx.abort();
					}
				}
				if (command.action === "resume") persist(r);
				status(r); arm(r, true);
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		const previous = get(ctx);
		if (previous?.timer) clearTimeout(previous.timer);
		if (previous) previous.closed = true;
		const r: Runtime = { ctx, loops: [], closed: false, uiDepth: 0 };
		runtimes.set(ctx.sessionManager.getSessionId(), r);
		// Scheduling is operational session state, independent of transcript tree selection.
		const entry = ctx.sessionManager.getEntries().findLast((e) => e.type === "custom" && e.customType === SNAPSHOT);
		if (entry?.type === "custom") {
			try {
				r.loops = restore(entry.data);
				for (const loop of r.loops) {
					if (terminal(loop)) continue;
					if (loop.status === "running" || event.reason !== "reload") {
						loop.status = "paused"; loop.dueAt = null; loop.reason = "restored; use /loop resume";
					}
				}
				persist(r);
			} catch (error) {
				r.loops = [];
				ctx.ui.notify(`Saved loops could not be restored: ${String(error)}`, "warning");
			}
		}
		status(r); arm(r);
	});
	pi.on("before_agent_start", (event, ctx) => {
		const r = get(ctx);
		if (!r) return;
		if (event.messageType !== "custom" || event.message.customType !== ITERATION) {
			if (r.active) { interrupt(r, "another prompt took over; resume to continue"); arm(r); }
			return;
		}
		const details = event.message.details as { token?: string } | undefined;
		const loop = activeLoop(r);
		// Delivery starts asynchronously. A stop/pause or startup timeout can win
		// while Pi prepares the run: cancel our stale dispatch before any model call.
		if (!r.active || details?.token !== r.active.token || loop?.status !== "running") {
			ctx.abort();
			return;
		}
		r.active.startedAt = Date.now(); arm(r);
	});
	pi.on("agent_start", (_event, ctx) => {
		const active = get(ctx)?.active;
		if (active?.startedAt !== undefined) active.agentStarted = true;
	});
	pi.on("message_start", (event, ctx) => {
		const r = get(ctx);
		if (!r?.active || r.active.startedAt === undefined || event.message.role !== "user") return;
		interrupt(r, "user input interrupted the iteration");
		arm(r);
	});
	pi.on("message_end", (event, ctx) => {
		const active = get(ctx)?.active;
		if (!active || active.startedAt === undefined || event.message.role !== "assistant") return;
		active.text = event.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
	});
	pi.on("agent_before_settle", (event, ctx) => {
		const active = get(ctx)?.active;
		if (active) active.outcome = event.outcome;
	});
	pi.on("agent_settled", (event, ctx) => {
		const r = get(ctx);
		if (!r || r.closed) return;
		const active = r.active;
		const loop = activeLoop(r);
		r.active = undefined;
		if (event.aborted && loop) {
			if (!terminal(loop) && loop.status !== "paused") finish(r, loop, "paused", "agent aborted; resume to continue");
		} else if (active && loop) {
			if (active.startedAt !== undefined && (loop.status === "running" || loop.status === "scheduled")) {
				if (active.outcome === "error") {
					loop.failures++;
					loop.identical = 0; loop.lastHash = undefined;
					if (loop.failures >= 3) finish(r, loop, "failed", "three consecutive failed iterations");
				} else {
					loop.failures = 0;
					const reason = completion(loop, active.text);
					if (reason) finish(r, loop, "done", reason);
				}
				if (!terminal(loop)) {
					if (loop.iteration >= loop.max) finish(r, loop, "done", "iteration limit reached");
					else { loop.status = "scheduled"; scheduleNext(loop, Date.now(), active.delay); persist(r); }
				}
			}
		}
		status(r);
		// Settlement is notification-only: dispatch from a later timer, never this handler.
		arm(r, true);
	});
	pi.on("ui_prompt_start", (_event, ctx) => { const r = get(ctx); if (r) r.uiDepth++; });
	pi.on("ui_prompt_end", (_event, ctx) => { const r = get(ctx); if (r) { r.uiDepth = Math.max(0, r.uiDepth - 1); arm(r, true); } });
	pi.on("session_tree", (_event, ctx) => {
		const r = get(ctx);
		if (!r) return;
		for (const loop of r.loops) if (!terminal(loop)) { loop.status = "paused"; loop.dueAt = null; loop.reason = "conversation branch changed"; }
		r.active = undefined; persist(r); status(r); arm(r);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const r = get(ctx);
		if (!r) return;
		r.closed = true;
		if (r.timer) clearTimeout(r.timer);
		for (const loop of r.loops) if (loop.status === "running") { loop.status = "paused"; loop.dueAt = null; loop.reason = "iteration interrupted by session shutdown"; }
		try { persist(r); } finally {
			ctx.ui.setStatus("loop", undefined);
			runtimes.delete(ctx.sessionManager.getSessionId());
		}
	});
}
