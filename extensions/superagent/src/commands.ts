// `/tickets`, `/merge`, and `/superagent`; see DESIGN.md "Commands".
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DispatchError, type Dispatcher } from "./dispatcher.ts";
import { describeTicket, footerText, ticketLine } from "./render.ts";
import type { Router } from "./router.ts";

export interface CommandsHost {
	dispatcher(): Dispatcher | undefined;
	router: Router;
	changed(): void;
}

export const TICKETS_USAGE = "Usage: /tickets [all|N|resume N|close N [reason]]";
export const MERGE_USAGE = "Usage: /merge N";
export const SUPERAGENT_USAGE = "Usage: /superagent [on|off|status]";

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
				ctx.ui.notify(`Closed #${ticket.id} ${ticket.title}; its branch ${ticket.branch} is kept.`, "info");
				return;
			}
			throw new DispatchError(TICKETS_USAGE);
		}),
	});

	pi.registerCommand("merge", {
		description: "Merge a ready ticket into the current branch: /merge N",
		handler: run(async (args, ctx) => {
			const words = args.split(/\s+/).filter(Boolean);
			const id = ticketId(words[0]);
			if (id === undefined || words.length !== 1) throw new DispatchError(MERGE_USAGE);
			const outcome = await need().merge(id);
			host.changed();
			if (outcome.kind === "merged") ctx.ui.notify(`Merged #${id} into ${outcome.into} (${outcome.commits} commit${outcome.commits === 1 ? "" : "s"}).`, "info");
			else if (outcome.kind === "handed-to-worker") ctx.ui.notify(`#${id} needs a rebase: ${outcome.reason} The merge runs again when it reports ready.`, "warning");
			else ctx.ui.notify(`#${id} was not merged: ${outcome.reason}`, "error");
		}),
	});

	pi.registerCommand("superagent", {
		description: "Show or switch this session's mode: superagent (route work to tickets) or direct (/superagent on|off|status)",
		getArgumentCompletions: completions(["on", "off", "status"]),
		handler: run(async (args, ctx) => {
			const router = host.router;
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
			const lines = [
				`Mode: ${router.mode}${router.reason ? ` (${router.reason})` : ""}`,
				footerText(router.mode, summary),
			];
			if (router.mode === "superagent") lines.push(`Router tools: ${[...router.routerSet()].join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		}),
	});
}
