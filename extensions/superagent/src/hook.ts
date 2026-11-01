// The child-session hook of ticket agents; see DESIGN.md "Ticket sessions". Subagents loads every member of the
// `pi-extensions.child-session-hooks` Set into every child session it creates; this one stays inert unless the session
// is a ticket agent's whose ticket a live superagent instance of this process runs.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGit } from "./git.ts";
import { CHILD_SESSION_HOOKS, LINK_KEY, REPORT_TOOL, SESSION_LINK_TYPE, SUPERAGENT_REGISTRY, TICKET_AGENT_TYPE, type Ticket, type TicketReport } from "./types.ts";
import { ticketSystemPrompt } from "./worker-prompt.ts";

/** What the owning superagent instance hears from its ticket's session. */
export interface TicketHookTarget {
	/** The ticket as it is now (for the system-prompt section); undefined once it is gone. */
	ticket(): Ticket | undefined;
	report(report: TicketReport): void;
	/** The ticket session started; its persisted file, when it has one. */
	session(sessionFile: string | undefined): void;
}

export interface ChildSessionHook { name: string; extensionFactory: ExtensionFactory }

interface Registry {
	/** `ticketKey(commonDir, id)` → the owning instance's callbacks. */
	readonly tickets: Map<string, TicketHookTarget>;
	/** Live instances that registered the hook. */
	users: number;
	readonly hook: ChildSessionHook;
}

export const HOOK_NAME = "superagent-ticket";
const REGISTRY_KEY = Symbol.for(SUPERAGENT_REGISTRY);
const HOOKS_KEY = Symbol.for(CHILD_SESSION_HOOKS);

export const ticketKey = (commonDir: string, ticketId: number) => `${commonDir}#${ticketId}`;

/** The process-global registry; one hook object for every instance, so a child session loads it once. */
export function superagentRegistry(): Registry {
	const shared = globalThis as Record<symbol, unknown>;
	const existing = shared[REGISTRY_KEY] as Registry | undefined;
	if (existing && existing.tickets instanceof Map && typeof existing.hook?.extensionFactory === "function") return existing;
	const created: Registry = { tickets: new Map(), users: 0, hook: { name: HOOK_NAME, extensionFactory: ticketSessionExtension } };
	shared[REGISTRY_KEY] = created;
	return created;
}

function hookSet(): Set<unknown> {
	const shared = globalThis as Record<symbol, unknown>;
	const existing = shared[HOOKS_KEY];
	if (existing instanceof Set) return existing;
	const created = new Set<unknown>();
	shared[HOOKS_KEY] = created;
	return created;
}

/** Puts the hook in the child-session hook Set while at least one instance can run tickets; call the result to release. */
export function acquireHook(): () => void {
	const registry = superagentRegistry();
	registry.users++;
	hookSet().add(registry.hook);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		registry.users = Math.max(0, registry.users - 1);
		if (registry.users === 0) hookSet().delete(registry.hook);
	};
}

/** Makes a ticket known to child sessions; call the result to forget it (only if it still maps to `target`). */
export function registerTicket(key: string, target: TicketHookTarget): () => void {
	const { tickets } = superagentRegistry();
	tickets.set(key, target);
	return () => { if (tickets.get(key) === target) tickets.delete(key); };
}

/** Tools a ticket agent may not call: the user is asked through `ticket_report`. */
export function blockedInTicket(toolName: string): boolean {
	return toolName.startsWith("herder_") || toolName === "impeccable_question";
}

export const ticketBlockReason = (toolName: string) =>
	`${toolName} is not available in a ticket session: ask the user through ${REPORT_TOOL} (state "progress" with a question, or "blocked") instead.`;

/** The session-link's ticket data when the session is a ticket agent's. */
export function ticketLink(ctx: Pick<ExtensionContext, "sessionManager">): { ticketId: number; branch?: string; title?: string } | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_LINK_TYPE) continue;
		const data = entry.data as { agentType?: unknown; [LINK_KEY]?: { ticketId?: unknown; branch?: unknown; title?: unknown } } | undefined;
		if (data?.agentType !== TICKET_AGENT_TYPE) return undefined;
		const link = data[LINK_KEY];
		if (typeof link?.ticketId !== "number" || !Number.isInteger(link.ticketId)) return undefined;
		return {
			ticketId: link.ticketId,
			...(typeof link.branch === "string" ? { branch: link.branch } : {}),
			...(typeof link.title === "string" ? { title: link.title } : {}),
		};
	}
	return undefined;
}

const ReportParameters = Type.Object({
	state: StringEnum(["progress", "ready", "blocked", "failed", "dropped"] as const, {
		description: "ready: committed and verified; progress: a note, or a question with `question`; blocked: cannot continue without the user; failed: cannot be done; dropped: nothing to do.",
	}),
	summary: Type.String({ description: "What changed or what happened, for the user." }),
	question: Type.Optional(Type.String({ description: "One concrete decision only the user can make." })),
	tests: Type.Optional(Type.String({ description: "The checks you ran and their results." })),
});

/** The hook's extension factory: inert until `session_start` finds a ticket this process runs. */
export function ticketSessionExtension(pi: ExtensionAPI): void {
	let target: TicketHookTarget | undefined;
	let registered = false;

	pi.on("session_start", async (_event, ctx) => {
		target = undefined;
		const link = ticketLink(ctx);
		if (!link) return;
		const repo = await createGit().open(ctx.sessionManager.getCwd() || ctx.cwd).catch(() => undefined);
		if (!repo) return;
		const found = superagentRegistry().tickets.get(ticketKey(repo.commonDir, link.ticketId));
		if (!found) return;
		target = found;
		if (!registered) {
			registered = true;
			pi.registerTool({
				name: REPORT_TOOL,
				label: "Ticket Report",
				description: "Report the ticket's state to the user: ready, progress (optionally with a question), blocked, failed, or dropped. Returns at once.",
				promptSnippet: "Report the ticket's state to the user",
				parameters: ReportParameters,
				async execute(_id, params) {
					if (!target) throw new Error("This session is not a ticket agent's session any more.");
					const report: TicketReport = { state: params.state, summary: params.summary, at: Date.now() };
					if (params.question !== undefined) report.question = params.question;
					if (params.tests !== undefined) report.tests = params.tests;
					target.report(report);
					return { content: [{ type: "text", text: "Reported." }], details: {} };
				},
			});
		}
		try { target.session(ctx.sessionManager.getSessionFile()); } catch {}
	});

	pi.on("before_agent_start", (event) => {
		const ticket = target?.ticket();
		if (!ticket) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n# Your ticket\n\n${ticketSystemPrompt(ticket)}` };
	});

	pi.on("tool_call", (event) => {
		if (!target || !blockedInTicket(event.toolName)) return undefined;
		return { block: true, reason: ticketBlockReason(event.toolName) };
	});

	pi.on("session_shutdown", () => { target = undefined; });
}
