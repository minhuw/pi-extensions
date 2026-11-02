// The router tools of superagent mode; see DESIGN.md "Tools in superagent mode", "Follow-ups", and "Merging".
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DirtyWorkspaceError, isShared, type Dispatcher } from "./dispatcher.ts";
import { checkGitReadArgs, runGitRead } from "./git-read.ts";
import { describeTicket, ticketLine } from "./render.ts";
import type { Repo } from "./types.ts";

export interface ToolsHost {
	dispatcher(): Dispatcher | undefined;
	repo(): Repo | undefined;
	/** A ticket changed: refresh the footer. */
	changed(): void;
}

const reply = <D>(text: string, details: D) => ({ content: [{ type: "text" as const, text }], details });
const ID = Type.Integer({ minimum: 1, description: "The ticket number (#N)" });

/** The text of the latest user message on the session's branch. */
export function latestUserText(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (text.trim()) return text;
	}
	return undefined;
}

export function registerTools(pi: ExtensionAPI, host: ToolsHost): void {
	const dispatcher = (): Dispatcher => {
		const current = host.dispatcher();
		if (!current) throw new Error("Tickets are not available in this session: it is not a top-level session in a git repository with a commit.");
		return current;
	};

	pi.registerTool({
		name: "ticket_create", label: "Create Ticket",
		description: "Turn one independent piece of work into a ticket: a ticket agent makes the change (worktree mode: in its own git worktree and branch, committed; shared mode: directly in the user's working tree, uncommitted), runs the checks, and reports back as a message later. "
			+ "Use it for anything that changes files or needs builds, tests, or other commands. One ticket per independent piece of work; split a message holding several. "
			+ "`request` is the user's words verbatim, never a plan or a checklist of yours. `note` (at most 30 words) carries routing facts only, such as a constraint the user stated earlier. "
			+ "`after` lists tickets that must be merged (or done) before this one starts; `mergeWhenReady` merges it as soon as it reports ready (only when the user asked for that). "
			+ "It returns at once; never wait or poll for the result.",
		promptSnippet: "Create a ticket: a ticket agent makes a change and reports back",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 120, description: "A short title, a few words" }),
			request: Type.String({ minLength: 1, description: "The user's request, verbatim" }),
			note: Type.Optional(Type.String({ description: "Routing facts only, at most 30 words" })),
			after: Type.Optional(Type.Array(ID, { description: "Start once these tickets are merged; a closed one fails this ticket" })),
			mergeWhenReady: Type.Optional(Type.Boolean({ description: "Merge as soon as it reports ready; only when the user asked for it" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const note = params.note?.trim();
			if (note && note.split(/\s+/).length > 30) throw new Error("note has more than 30 words: keep only routing facts, and put the user's words in request.");
			let ticket;
			try {
				ticket = await dispatcher().create({
					title: params.title, request: params.request, source: latestUserText(ctx) ?? params.request, ...(note ? { note } : {}),
					...(params.after?.length ? { after: params.after } : {}), ...(params.mergeWhenReady ? { mergeWhenReady: true } : {}),
					parentToolCallId: toolCallId,
				});
			} catch (error) {
				// The user hears it directly too: the router may not repeat a tool error.
				if (error instanceof DirtyWorkspaceError) { try { ctx.ui.notify(error.message, "warning"); } catch {} }
				throw error;
			}
			host.changed();
			const shared = isShared(ticket);
			const waits = ticket.after?.length ? `queued until ${ticket.after.map((dep) => `#${dep}`).join(", ")} ${ticket.after.length === 1 ? "is" : "are"} ${shared ? "done" : "merged"}` : undefined;
			const where = ticket.state === "queued" ? waits ?? "queued until an agent slot is free"
				: ticket.state === "failed" ? `failed: ${ticket.error ?? "see its report"}`
				: shared ? `${ticket.state} in the shared working tree` : `${ticket.state} on branch ${ticket.branch}`;
			return reply(`Created ticket #${ticket.id} "${ticket.title}": ${where}. Its report arrives as a message; end your turn after confirming it to the user.`, { ticket });
		},
	});

	pi.registerTool({
		name: "ticket_message", label: "Message Ticket",
		description: "Forward a follow-up from the user to one ticket's agent. Use it only when the user's message points at that ticket explicitly: its number, its title, or \"what you just did\" when exactly one ticket fits; a similar subject is a new ticket instead. "
			+ "Answers to a ticket's question go here, and facts one ticket needs from another. A running agent gets the text at once; an idle or interrupted one continues with it.",
		promptSnippet: "Forward a user follow-up to one ticket's agent",
		parameters: Type.Object({ id: ID, text: Type.String({ minLength: 1, description: "The user's words, verbatim" }) }),
		async execute(_id, params) {
			const { ticket, delivery } = await dispatcher().send(params.id, params.text);
			host.changed();
			return reply(`Sent to ticket #${ticket.id} (${delivery}). Its next report arrives as a message.`, { ticket, delivery });
		},
	});

	pi.registerTool({
		name: "ticket_status", label: "Ticket Status",
		description: "Show the repository's open tickets, one line each, or one ticket in detail (`id`): state, branch, worktree (or, in shared mode, the files it touched), commits ahead, changed files, last report, and pending question. "
			+ "Reports arrive as messages on their own: do not call this to wait for one.",
		parameters: Type.Object({ id: Type.Optional(ID), all: Type.Optional(Type.Boolean({ description: "Include merged and closed tickets" })) }),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const current = dispatcher();
			if (params.id !== undefined) {
				const info = await current.inspect(params.id);
				return reply<Record<string, unknown>>(describeTicket(info), { ticket: info.ticket, ahead: info.ahead, files: info.files });
			}
			const tickets = current.list(params.all === true);
			const text = tickets.length ? tickets.map((ticket) => ticketLine(ticket, current.sessionId)).join("\n") : params.all ? "No tickets in this repository." : "No open tickets.";
			return reply<Record<string, unknown>>(text, { tickets: tickets.map(({ id, state, title, branch, question }) => ({ id, state, title, branch, question })) });
		},
	});

	pi.registerTool({
		name: "ticket_merge", label: "Merge Ticket",
		description: "Worktree mode: fast-forward a ready ticket's branch into the main checkout's current branch, rebasing it first when needed (conflicts go back to the ticket agent). "
			+ "Shared mode: mark the ticket done; its changes stay uncommitted in the working tree, and nothing is merged. Refused while its agent runs. "
			+ "`whenReady: true` merges a ticket that is not ready yet as soon as it reports ready. "
			+ "Call it only when the user explicitly asks to merge that ticket; never on your own after a report.",
		parameters: Type.Object({ id: ID, whenReady: Type.Optional(Type.Boolean({ description: "Merge once it reports ready, if it is not ready now" })) }),
		async execute(_id, params) {
			let outcome;
			if (params.whenReady) {
				const scheduled = await dispatcher().mergeWhenReady(params.id);
				host.changed();
				if (!scheduled.outcome) return reply<Record<string, unknown>>(`Ticket #${params.id} merges as soon as it reports ready.`, { ticket: scheduled.ticket });
				outcome = scheduled.outcome;
			} else {
				outcome = await dispatcher().merge(params.id);
				host.changed();
			}
			const text = outcome.kind === "merged" ? `Merged ticket #${params.id} into ${outcome.into} (${outcome.commits} commit${outcome.commits === 1 ? "" : "s"}).`
				: outcome.kind === "done" ? `Ticket #${params.id} is done; its changes stay uncommitted in the user's working tree.`
				: outcome.kind === "handed-to-worker" ? `Ticket #${params.id} needs a rebase first: ${outcome.reason} Its agent resolves it, and the merge runs again when it reports ready.`
				: `Ticket #${params.id} was not merged: ${outcome.reason}`;
			if (outcome.kind === "refused") throw new Error(text);
			return reply<Record<string, unknown>>(text, { outcome });
		},
	});

	pi.registerTool({
		name: "ticket_close", label: "Close Ticket",
		description: "Abandon a ticket: stop its agent. Worktree mode: its worktree is removed and its branch kept. Shared mode: its changes stay in the working tree. Call it only when the user explicitly asks to close or abandon that ticket.",
		parameters: Type.Object({ id: ID, reason: Type.String({ minLength: 1, description: "Why, in the user's words" }) }),
		async execute(_id, params) {
			const ticket = await dispatcher().close(params.id, params.reason);
			host.changed();
			return reply(isShared(ticket)
				? `Closed ticket #${ticket.id}; its agent is stopped, and its changes stay in the working tree.`
				: `Closed ticket #${ticket.id}; its branch ${ticket.branch} is kept.`, { ticket });
		},
	});

	pi.registerTool({
		name: "git_read", label: "Git (read-only)",
		description: "Run a read-only git command in the main checkout, without a shell: `args` are git's arguments, for example [\"log\", \"--oneline\", \"-20\"] or [\"diff\", \"main...pi/3-fix-login\"]. "
			+ "Allowed subcommands: status, diff, log, show, blame, shortlog, branch and tag (listing only), rev-parse, ls-files, grep, describe, merge-base, worktree list. Output is cut to 50 KB.",
		promptSnippet: "Run a read-only git command (status, diff, log, show, blame, …) in the main checkout",
		parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1, description: "git arguments, starting with the subcommand" }) }),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const repo = host.repo();
			if (!repo) throw new Error("git_read needs a git repository.");
			const checked = checkGitReadArgs(params.args);
			if (!checked.ok) throw new Error(`git_read refused: ${checked.reason}`);
			// runGitRead checks the raw arguments again and adds --no-pager and the diff options itself.
			const result = await runGitRead(repo.topLevel, params.args);
			const text = result.output || "(no output)";
			if (result.exitCode !== 0) throw new Error(`git exited with ${result.exitCode}:\n${text}`);
			return reply(text, { exitCode: result.exitCode, truncated: result.truncated });
		},
	});
}
