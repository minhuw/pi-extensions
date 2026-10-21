import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Parameters, renderReport, SNAPSHOT, STATUS_KEY, summary, updateReport } from "./report.ts";
import { approvalKey, BaselineParameters, emptyState, fingerprint, ITERATION, measure, measuredReport, prompt, proposal, restoreState, terminal, verifyHarness, type Benchmark, type State } from "./campaign.ts";

const DISPLAY = "autoresearch:display";
const HELP = "/autoresearch <target> [--max 25] prepares and measures a baseline. /autoresearch approve starts iterations after review. Other commands: status, revise <feedback>, pause, resume, stop. Limits: 25 iterations by default, six hours after approval, 15 minutes per iteration (30 minutes for setup).";
interface Active { token: string; kind: "prepare" | "iterate"; dispatchedAt: number; startedAt?: number; measured: boolean; outcome?: string }
interface Runtime {
	ctx: ExtensionContext; state: State; invalid: boolean; closed: boolean; uiDepth: number;
	active?: Active; pending?: "prepare" | "iterate"; timer?: ReturnType<typeof setTimeout>;
}

export default function autoresearchExtension(pi: ExtensionAPI): void {
	const runtimes = new Map<string, Runtime>();
	const get = (ctx: ExtensionContext): Runtime => {
		const runtime = runtimes.get(ctx.sessionManager.getSessionId());
		if (!runtime || runtime.closed) throw new Error("Autoresearch requires an active session.");
		return runtime;
	};
	const publish = (r: Runtime): void => {
		if (r.ctx.mode !== "tui" && r.ctx.mode !== "rpc") return;
		const { campaign: c, report } = r.state;
		const label = c?.state === "awaiting_approval" ? "awaiting approval" : c?.state === "running" ? `run ${c.iterations}/${c.maxIterations}` : c?.state;
		const text = report ? summary(report).replace(`research · ${report.phase}`, `research · ${label ?? report.phase}`) : c ? `research · ${label}` : undefined;
		r.ctx.ui.setStatus(STATUS_KEY, text);
	};
	function save(r: Runtime, next: State): void {
		const snapshot = structuredClone(next);
		try { pi.appendEntry(SNAPSHOT, snapshot); }
		catch (error) {
			// Pi 1.3 advances its branch before I/O and holds this payload by reference.
			// A failed append must restore the prior payload in that in-memory entry.
			Object.assign(snapshot, r.invalid ? { ...emptyState(), version: 0 } : structuredClone(r.state));
			throw error;
		}
		r.state = next;
		publish(r);
	}
	function pause(r: Runtime, reason: string): void {
		r.pending = undefined;
		const next = structuredClone(r.state);
		if (next.campaign && !terminal(next.campaign)) { next.campaign.state = "paused"; next.campaign.reason = reason; }
		if (next.report && next.report.phase !== "complete") next.report.phase = "paused";
		save(r, next);
	}
	function closeTimer(r: Runtime): void { if (r.timer) clearTimeout(r.timer); r.timer = undefined; }
	function haltOwned(r: Runtime): void {
		const active = r.active;
		r.active = undefined; r.pending = undefined; closeTimer(r);
		if (active?.startedAt !== undefined) r.ctx.abort();
	}
	function arm(r: Runtime): void {
		closeTimer(r);
		if (r.closed || r.invalid || (r.ctx.mode !== "tui" && r.ctx.mode !== "rpc") || (!r.pending && !r.active)) return;
		let delay = 1;
		if (r.active) {
			const limit = r.active.startedAt === undefined ? 30_000 : r.active.kind === "prepare" ? 30 * 60_000 : 15 * 60_000;
			delay = Math.max(1, (r.active.startedAt ?? r.active.dispatchedAt) + limit - Date.now());
		} else if (!r.ctx.isIdle() || r.ctx.hasPendingMessages() || r.uiDepth) delay = 1000;
		if (r.state.campaign?.deadline !== undefined && r.state.campaign.state === "running") delay = Math.min(delay, Math.max(1, r.state.campaign.deadline - Date.now()));
		r.timer = setTimeout(() => {
			r.timer = undefined;
			try { tick(r); }
			catch (error) {
				r.invalid = true;
				let abortFailure = "";
				try { haltOwned(r); } catch (abortError) { abortFailure = ` Abort failed: ${String(abortError)}.`; }
				r.ctx.ui.setStatus(STATUS_KEY, "research · paused · state error");
				r.ctx.ui.notify(`Autoresearch stopped after a state error: ${String(error)}.${abortFailure} Recover with /autoresearch stop or /research-report clear.`, "error");
			}
		}, delay);
		r.timer.unref?.();
	}
	function tick(r: Runtime): void {
		if (r.closed) return;
		const c = r.state.campaign;
		if (c?.state === "running" && c.deadline !== undefined && Date.now() >= c.deadline) {
			pause(r, "Six-hour research limit reached.");
			if (r.active?.startedAt !== undefined) r.ctx.abort();
		} else if (r.active) {
			const limit = r.active.startedAt === undefined ? 30_000 : r.active.kind === "prepare" ? 30 * 60_000 : 15 * 60_000;
			if (Date.now() >= (r.active.startedAt ?? r.active.dispatchedAt) + limit) {
				pause(r, "Research pass timed out; resume explicitly to continue.");
				if (r.active.startedAt !== undefined) r.ctx.abort();
				r.active = undefined;
			}
		} else if (r.pending && r.ctx.isIdle() && !r.ctx.hasPendingMessages() && !r.uiDepth) {
			const kind = r.pending;
			if (!c || (kind === "prepare" ? c.state !== "preparing" : c.state !== "running" || c.approved !== approvalKey(r.state))) { r.pending = undefined; return; }
			if (kind === "iterate" && c.iterations >= c.maxIterations) {
				const next = structuredClone(r.state); next.campaign!.state = "complete"; next.campaign!.reason = "Iteration limit reached.";
				if (next.report) next.report.phase = "complete";
				r.pending = undefined; save(r, next); return;
			}
			const next = structuredClone(r.state);
			if (kind === "iterate") next.campaign!.iterations++;
			save(r, next);
			r.pending = undefined;
			const active: Active = { token: randomUUID(), kind, dispatchedAt: Date.now(), measured: false };
			r.active = active;
			pi.sendMessage({ customType: ITERATION, display: true, details: { token: active.token }, content: prompt(r.state, kind) }, { triggerTurn: true, deliverAs: "followUp" });
		}
		arm(r);
	}
	function owner(ctx: ExtensionContext, kind?: "prepare" | "iterate"): { r: Runtime; active: Active; assert: () => void } {
		const r = get(ctx); const active = r.active; const c = r.state.campaign;
		if (r.invalid || !active || active.startedAt === undefined || !c || (kind && active.kind !== kind)
			|| (active.kind === "prepare" ? c.state !== "preparing" : c.state !== "running" || c.approved !== approvalKey(r.state))) throw new Error("This tool requires the currently owned /autoresearch pass.");
		const assert = () => {
			if (r.closed || runtimes.get(ctx.sessionManager.getSessionId()) !== r || r.active !== active
				|| r.state.campaign?.id !== c.id || (active.kind === "prepare" ? r.state.campaign.state !== "preparing" : r.state.campaign.state !== "running")) throw new Error("The research pass was interrupted; no result was recorded.");
		};
		return { r, active, assert };
	}
	function restore(ctx: ExtensionContext): void {
		const previous = runtimes.get(ctx.sessionManager.getSessionId());
		if (previous) { closeTimer(previous); previous.closed = true; }
		const r: Runtime = { ctx, state: emptyState(), invalid: false, closed: false, uiDepth: 0 };
		const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === SNAPSHOT);
		if (entry?.type === "custom") {
			try {
				r.state = restoreState(entry.data);
				if (r.state.report && r.state.report.phase !== "complete") r.state.report.phase = "paused";
				if (r.state.campaign && !terminal(r.state.campaign) && r.state.campaign.state !== "awaiting_approval") {
					r.state.campaign.state = "paused"; r.state.campaign.reason = "Restored; use /autoresearch resume.";
				}
			} catch { r.invalid = true; if (ctx.hasUI) ctx.ui.notify("Saved research state is invalid. Use /research-report clear to reset it.", "warning"); }
		}
		runtimes.set(ctx.sessionManager.getSessionId(), r); publish(r);
	}
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		const r = runtimes.get(ctx.sessionManager.getSessionId()); if (!r) return;
		closeTimer(r); r.closed = true; r.pending = undefined;
		runtimes.delete(ctx.sessionManager.getSessionId());
		if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("ui_prompt_start", (_event, ctx) => { const r = runtimes.get(ctx.sessionManager.getSessionId()); if (r) r.uiDepth++; });
	pi.on("ui_prompt_end", (_event, ctx) => { const r = runtimes.get(ctx.sessionManager.getSessionId()); if (r) { r.uiDepth = Math.max(0, r.uiDepth - 1); arm(r); } });
	pi.on("before_agent_start", (event, ctx) => {
		const r = runtimes.get(ctx.sessionManager.getSessionId()); if (!r) return;
		if (event.messageType === "custom" && event.message.customType === ITERATION) {
			const token = (event.message.details as { token?: string } | undefined)?.token;
			if (!r.active || token !== r.active.token || !["preparing", "running"].includes(r.state.campaign?.state ?? "")) { ctx.abort(); return; }
			r.active.startedAt = Date.now(); arm(r);
		} else if (r.active || r.pending) { r.active = undefined; pause(r, "Another prompt took over; resume explicitly."); arm(r); }
	});
	pi.on("message_start", (event, ctx) => {
		const r = runtimes.get(ctx.sessionManager.getSessionId());
		if (r && event.message.role === "user" && (r.active?.startedAt !== undefined || r.pending)) { r.active = undefined; pause(r, "User input took over; resume explicitly."); arm(r); }
	});
	pi.on("agent_before_settle", (event, ctx) => { const active = runtimes.get(ctx.sessionManager.getSessionId())?.active; if (active) active.outcome = event.outcome; });
	pi.on("agent_settled", (event, ctx) => {
		const r = runtimes.get(ctx.sessionManager.getSessionId()); if (!r || r.closed) return;
		const active = r.active; r.active = undefined;
		const c = r.state.campaign;
		if (active && c && !terminal(c) && c.state !== "awaiting_approval" && c.state !== "paused") {
			if (event.aborted || active.outcome === "error") pause(r, "Research pass aborted or failed; resume explicitly.");
			else if (!active.measured) pause(r, "Pass ended without a successful measurement; review and resume explicitly.");
			else if (c.state === "running") r.pending = "iterate";
		}
		// Settlement is notification-only. A later timer dispatches the next pass.
		arm(r);
	});

	pi.registerTool({
		name: "autoresearch_update", label: "Research Update", executionMode: "sequential",
		description: "Display a concise research progress message. During /autoresearch, metric values come from autoresearch_baseline and autoresearch_measure; omit metrics here. Phase paused or complete ends automatic continuation. Standalone model-reported metric tables remain supported.",
		promptSnippet: "Report the hypothesis and outcome during an explicitly started /autoresearch workflow.",
		parameters: Parameters,
		async execute(_id, params, _signal, _update, ctx) {
			const r = get(ctx); if (r.invalid) throw new Error("Saved report is invalid. Use /research-report clear first.");
			if (r.state.campaign) {
				owner(ctx);
				if (params.metrics) throw new Error("Campaign metrics must come from autoresearch_baseline or autoresearch_measure.");
			}
			const next = structuredClone(r.state);
			next.report = updateReport(next.report, params, randomUUID(), Date.now());
			if (next.campaign && (params.phase === "paused" || params.phase === "complete")) {
				next.campaign.state = params.phase; next.campaign.reason = params.message; r.pending = undefined;
			}
			save(r, next);
			return { content: [{ type: "text", text: renderReport(next.report) }], details: { report: structuredClone(next.report) } };
		},
	});
	pi.registerTool({
		name: "autoresearch_baseline", label: "Research Baseline", executionMode: "sequential", reachesTools: () => ["bash"],
		description: "During /autoresearch setup, register the methodology and metric definitions, execute the baseline command through bash, parse METRIC name=value output, and request user review. This does not approve or start optimization. The user must run /autoresearch approve. List every measurement/check harness file to pin its contents.",
		parameters: BaselineParameters,
		async execute(_id, params, signal, _update, ctx) {
			const { r, active, assert } = owner(ctx, "prepare");
			const definitions = updateReport(null, { phase: "measuring", message: "Preparing the baseline.", metrics: params.metrics }, randomUUID(), Date.now());
			const benchmark: Benchmark = { root: await realpath(ctx.cwd), methodology: params.methodology, command: params.command, checkCommand: params.checkCommand,
				files: await fingerprint(ctx.cwd, params.files), repetitions: params.repetitions ?? 3, timeoutSeconds: params.timeoutSeconds ?? 120 };
			assert();
			const baseline = await measure(ctx, benchmark, definitions.metrics.map(metric => metric.name), signal, assert);
			const next = structuredClone(r.state);
			next.report = measuredReport(definitions, baseline, true);
			Object.assign(next.campaign!, { state: "awaiting_approval", benchmark, baseline, latest: baseline, approved: undefined, reason: undefined });
			save(r, next); active.measured = true;
			return { content: [{ type: "text", text: proposal(next) }], details: { report: next.report, baseline, awaitingApproval: true } };
		},
	});
	pi.registerTool({
		name: "autoresearch_measure", label: "Research Measurement", executionMode: "sequential", reachesTools: () => ["bash"],
		description: "Measure a candidate using the user's approved benchmark command, repetitions, metric definitions, checks, and pinned harness. Only callable during an approved /autoresearch iteration. Records parsed measurements; does not automatically commit or revert code.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) {
			const { r, active, assert } = owner(ctx, "iterate");
			// Continuation requires the latest attempt to succeed, including its checks.
			active.measured = false;
			const measurement = await measure(ctx, r.state.campaign!.benchmark!, r.state.report!.metrics.map(metric => metric.name), signal, assert);
			const next = structuredClone(r.state); next.campaign!.latest = measurement;
			next.report = measuredReport(next.report!, measurement, false);
			save(r, next); active.measured = true;
			return { content: [{ type: "text", text: renderReport(next.report) }], details: { report: next.report, measurement } };
		},
	});
	pi.registerMessageRenderer(ITERATION, (message, { expanded }) => {
		const content = typeof message.content === "string" ? message.content : "Autoresearch";
		return new Markdown(expanded ? content : content.split("\n")[0]!, 0, 0, getMarkdownTheme());
	});
	pi.registerMessageRenderer(DISPLAY, message => new Markdown(typeof message.content === "string" ? message.content : "", 0, 0, getMarkdownTheme()));
	const display = (r: Runtime) => pi.sendMessage({ customType: DISPLAY, display: true, content: r.state.campaign?.benchmark
		? `${proposal(r.state)}\n\nState: ${r.state.campaign.state}${r.state.campaign.reason ? ` — ${r.state.campaign.reason}` : ""}`
		: r.state.report ? renderReport(r.state.report) : r.state.campaign ? `Research target: ${r.state.campaign.goal}\nState: ${r.state.campaign.state}` : "No research report. Start with /autoresearch <target>." }, { triggerTurn: false });
	pi.registerCommand("research-report", {
		description: "Show research methodology and metrics: /research-report [status|results|clear|help]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "help") { ctx.ui.notify(HELP, "info"); return; }
			if (!["", "status", "results", "clear"].includes(action)) throw new Error("Usage: /research-report [status|results|clear|help]");
			const r = get(ctx);
			if (action === "clear") {
				if (!r.invalid && r.state.campaign && !terminal(r.state.campaign)) throw new Error("Use /autoresearch stop before clearing an active campaign.");
				haltOwned(r);
				save(r, emptyState()); r.invalid = false; return;
			}
			if (r.invalid) throw new Error("Saved report is invalid. Use /research-report clear first.");
			display(r);
		},
	});
	pi.registerCommand("autoresearch", {
		description: "Prepare a baseline for review, then optimize after approval: /autoresearch <target> | approve|revise|pause|resume|stop|status",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("/autoresearch requires a TUI or RPC session.");
			const r = get(ctx); const input = args.trim(); const action = input.toLowerCase();
			if (!input || action === "help") { ctx.ui.notify(HELP, "info"); return; }
			if (r.invalid && action !== "stop") throw new Error("Saved research state is invalid. Recover with /autoresearch stop or /research-report clear.");
			if (action === "status") { display(r); return; }
			const c = r.state.campaign;
			if (["pause", "stop"].includes(action)) {
				if (!c && !r.invalid) throw new Error("No research campaign.");
				try {
					// Stop owned execution before persistence; disk failure must not skip abort.
					haltOwned(r);
					if (action === "pause") pause(r, "Paused by user.");
					else {
						const next = structuredClone(r.state);
						if (next.campaign) { next.campaign.state = "stopped"; next.campaign.reason = "Stopped by user."; }
						if (next.report) next.report.phase = "paused";
						save(r, next);
					}
					r.invalid = false;
				} catch (error) { r.invalid = true; throw error; }
				arm(r); return;
			}
			if (action === "approve") {
				if (!c || c.state !== "awaiting_approval" || !c.benchmark || !c.baseline) throw new Error("A measured baseline must be awaiting approval first.");
				if (r.active || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the baseline explanation to finish before approving.");
				await verifyHarness(ctx.cwd, c.benchmark);
				if (get(ctx) !== r || r.state.campaign !== c || c.state !== "awaiting_approval") throw new Error("Research proposal changed while approving.");
				const next = structuredClone(r.state); next.campaign!.approved = approvalKey(next); next.campaign!.state = "running"; next.campaign!.deadline = Date.now() + 6 * 60 * 60_000;
				save(r, next); r.pending = "iterate"; arm(r); return;
			}
			if (action === "resume") {
				if (!c || c.state !== "paused") throw new Error("Research must be paused before resuming.");
				if (r.active) throw new Error("Wait for the previous pass to settle.");
				if (c.baseline && !c.approved) { const next = structuredClone(r.state); next.campaign!.state = "awaiting_approval"; save(r, next); display(r); return; }
				if (c.approved && (c.iterations >= c.maxIterations || (c.deadline ?? 0) <= Date.now())) throw new Error("Research reached its limits. Start a new campaign.");
				const next = structuredClone(r.state); next.campaign!.state = c.approved ? "running" : "preparing";
				save(r, next); r.pending = c.approved ? "iterate" : "prepare"; arm(r); return;
			}
			if (action.startsWith("revise ")) {
				if (!c || terminal(c)) throw new Error("No active research campaign to revise.");
				if (r.active || !ctx.isIdle()) throw new Error("Pause and wait for the current pass before revising.");
				const feedback = input.slice(7).trim(); if (!feedback || feedback.length > 1000) throw new Error("Feedback must be 1–1000 characters.");
				const next = emptyState(); next.campaign = { id: randomUUID(), goal: c.goal, state: "preparing", iterations: 0, maxIterations: c.maxIterations, reason: feedback };
				save(r, next); r.pending = "prepare"; arm(r); return;
			}
			if (c && !terminal(c)) throw new Error("Research already exists. Use /autoresearch status, revise <feedback>, or stop.");
			const match = /\s+--max\s+(\d+)$/.exec(input);
			const maxIterations = match ? Number(match[1]) : 25;
			const goal = (match ? input.slice(0, match.index) : input).trim();
			if (!goal || goal.length > 4000 || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000) throw new Error("Provide a target up to 4000 characters and --max 1–1000.");
			const next = emptyState(); next.campaign = { id: randomUUID(), goal, state: "preparing", iterations: 0, maxIterations };
			save(r, next); r.pending = "prepare"; arm(r);
		},
	});
}
