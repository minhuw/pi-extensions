// `/tickets`, `/merge`, and `/superagent`; see DESIGN.md "Commands".
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DispatchError, isShared, type Dispatcher } from "./dispatcher.ts";
import { ATTENTION_STATES, WORKSPACE_MODES, type MergeOutcome, type WorkspaceMode } from "./types.ts";
import { describeTicket, footerText, ticketLine } from "./render.ts";
import type { Router } from "./router.ts";

export interface CommandsHost {
	dispatcher(): Dispatcher | undefined;
	router: Router;
	changed(): void;
}

export const TICKETS_USAGE = "Usage: /tickets [all|N|resume N|close N [reason]]";
export const MERGE_USAGE = "Usage: /merge [N]";
export const SUPERAGENT_USAGE = "Usage: /superagent [on|off|status|workspace [shared|worktree]]";

const WORKSPACE_TEXT: Record<WorkspaceMode, string> = {
	worktree: "every ticket works in its own git worktree and branch from the last commit; /merge fast-forwards it into your branch",
	shared: "tickets work directly in your working tree and leave their changes uncommitted; /merge marks one done",
};

/** `Workspace: <mode> (…)`, with when and by which session it was last switched. */
export function workspaceLine(dispatcher: Dispatcher): string {
	const mode = dispatcher.workspace();
	const record = dispatcher.workspaceRecord();
	const since = record ? `; switched ${new Date(record.changedAt).toISOString()} by session ${record.changedBy}` : "; from the workspace setting";
	return `Workspace: ${mode} (${WORKSPACE_TEXT[mode]}${since})`;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const ticketId = (word: string | undefined) => word !== undefined && /^#?\d+$/.test(word) ? Number(word.replace(/^#/, "")) : undefined;
const completions = (words: readonly string[]) => (prefix: string) => {
	const typed = prefix.trim();
	const items = words.filter((word) => word.startsWith(typed) && word !== typed).map((word) => ({ value: word, label: word }));
	return items.length ? items : null;
};

export function registerCommands(pi: ExtensionAPI, host: CommandsHost): void {
	const need = (): Dispatcher => {
		const dispatcher = host.dispatcher();
		if (!dispatcher) throw new DispatchError(`Tickets are not available here: ${host.router.reason ?? "the session is not in a git repository with a commit"}.`);
		return dispatcher;
	};
	const run = (fn: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => async (args: string, ctx: ExtensionCommandContext) => {
		try { await fn(args.trim(), ctx); } catch (error) { ctx.ui.notify(errorText(error), "error"); }
	};

	pi.registerCommand("tickets", {
		description: "List this repository's tickets (all: include merged and closed), show one (N), resume or close one",
		getArgumentCompletions: completions(["all", "resume", "close"]),
		handler: run(async (args, ctx) => {
			const dispatcher = need();
			const [first, second, ...rest] = args.split(/\s+/).filter(Boolean);
			if (first === undefined || first === "all") {
				if (second !== undefined) throw new DispatchError(TICKETS_USAGE);
				const tickets = dispatcher.list(first === "all");
				ctx.ui.notify(tickets.length ? tickets.map((ticket) => ticketLine(ticket, dispatcher.sessionId)).join("\n") : first === "all" ? "No tickets in this repository." : "No open tickets.", "info");
				return;
			}
			const shown = ticketId(first);
			if (shown !== undefined && second === undefined) { ctx.ui.notify(describeTicket(await dispatcher.inspect(shown)), "info"); return; }
			const id = ticketId(second);
			if (first === "resume" && id !== undefined && !rest.length) {
				const { ticket, action } = await dispatcher.resume(id);
				host.changed();
				const text = action === "started" ? "its agent continues" : action === "queued" ? "it is queued for an agent slot" : action === "live" ? "its agent is already live in this session" : "this session now receives its reports";
				ctx.ui.notify(`Resumed #${ticket.id} ${ticket.title}: ${text}.`, "info");
				return;
			}
			if (first === "close" && id !== undefined) {
				const ticket = await dispatcher.close(id, rest.join(" ") || "closed with /tickets close");
				host.changed();
				ctx.ui.notify(isShared(ticket)
					? `Closed #${ticket.id} ${ticket.title}; its agent is stopped, and its changes stay in the working tree.`
					: `Closed #${ticket.id} ${ticket.title}; its branch ${ticket.branch} is kept.`, "info");
				return;
			}
			throw new DispatchError(TICKETS_USAGE);
		}),
	});

	pi.registerCommand("merge", {
		description: "Merge open tickets when ready, or merge one now: /merge [N] (shared workspace: mark done)",
		handler: run(async (args, ctx) => {
			const report = (id: number, outcome: MergeOutcome) => {
				if (outcome.kind === "done") ctx.ui.notify(`#${id} is done; its changes stay uncommitted in your working tree.`, "info");
				else if (outcome.kind === "merged") ctx.ui.notify(`Merged #${id} into ${outcome.into} (${outcome.commits} commit${outcome.commits === 1 ? "" : "s"}).`, "info");
				else if (outcome.kind === "handed-to-worker") ctx.ui.notify(`#${id} needs a rebase: ${outcome.reason} The merge runs again when it reports ready.`, "warning");
				else ctx.ui.notify(`#${id} was not merged: ${outcome.reason}`, "error");
			};
			if (!args) {
				const dispatcher = need();
				const tickets = dispatcher.list().sort((a, b) => a.id - b.id);
				if (!tickets.length) { ctx.ui.notify("No open tickets.", "info"); return; }
				try {
					for (const { id } of tickets) {
						try {
							const { ticket, outcome } = await dispatcher.mergeWhenReady(id);
							if (outcome) report(id, outcome);
							else {
								const attention = ATTENTION_STATES.has(ticket.state) && ticket.state !== "ready";
								ctx.ui.notify(`#${id} [${ticket.state}] ${isShared(ticket) ? "will be marked done" : "will merge"} when it reports ready and its run ends.${attention ? " It still needs attention." : ""}`, attention ? "warning" : "info");
							}
						} catch (error) { ctx.ui.notify(`#${id} was not merged: ${errorText(error)}`, "error"); }
					}
				} finally { host.changed(); }
				return;
			}
			const words = args.split(/\s+/).filter(Boolean);
			const id = ticketId(words[0]);
			if (id === undefined || words.length !== 1) throw new DispatchError(MERGE_USAGE);
			const outcome = await need().merge(id);
			host.changed();
			report(id, outcome);
		}),
	});

	pi.registerCommand("superagent", {
		description: "Show or switch this session's mode (on|off|status), or the repository's workspace mode (workspace [shared|worktree])",
		getArgumentCompletions: completions(["on", "off", "status", "workspace", "workspace shared", "workspace worktree"]),
		handler: run(async (args, ctx) => {
			const router = host.router;
			const words = args.split(/\s+/).filter(Boolean);
			if (words[0] === "workspace") {
				const dispatcher = need();
				if (words.length === 1) { ctx.ui.notify(workspaceLine(dispatcher), "info"); return; }
				const mode = words[1] as WorkspaceMode;
				if (words.length !== 2 || !WORKSPACE_MODES.includes(mode)) throw new DispatchError(SUPERAGENT_USAGE);
				const result = await dispatcher.setWorkspace(mode);
				host.changed();
				const head = result.changed ? `Workspace mode: ${mode}: ${WORKSPACE_TEXT[mode]}.` : `The workspace mode is already ${mode}.`;
				ctx.ui.notify(result.warning ? `${head} ${result.warning}` : head, result.warning ? "warning" : "info");
				return;
			}
			if (args === "on" || args === "off") {
				const mode = args === "on" ? "superagent" : "direct";
				if (router.mode === mode) { ctx.ui.notify(`This session is already in ${mode} mode.`, "info"); return; }
				router.setMode(mode);
				ctx.ui.notify(mode === "superagent"
					? "Superagent mode: this session routes changes to tickets and keeps only read-only tools. /superagent off switches back."
					: "Direct mode: the session's tools are back. Ticket commands and #N still work; /superagent on switches back.", "info");
				return;
			}
			if (args && args !== "status") throw new DispatchError(SUPERAGENT_USAGE);
			const summary = host.dispatcher()?.summary();
			const current = host.dispatcher();
			const lines = [
				`Mode: ${router.mode}${router.reason ? ` (${router.reason})` : ""}`,
				...(current ? [workspaceLine(current)] : []),
				footerText(router.mode, summary),
			];
			if (router.mode === "superagent") lines.push(`Router tools: ${[...router.routerSet()].join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		}),
	});
}
