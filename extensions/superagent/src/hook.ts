// The child-session hook of ticket agents; see DESIGN.md "Ticket sessions". Subagents loads every member of the
// `pi-extensions.child-session-hooks` Set into every child session it creates; this one stays inert unless the session
// is a ticket agent's whose ticket a live superagent instance of this process runs, or (shared workspace) a nested
// agent such a ticket agent started.
import { statSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGit } from "./git.ts";
import { CHILD_SESSION_HOOKS, LINK_KEY, REPORT_TOOL, SESSION_LINK_TYPE, SUPERAGENT_REGISTRY, TICKET_AGENT_TYPE, type Ticket, type TicketReport } from "./types.ts";
import { AGENT_ISOLATION_BLOCK_REASON, blockedGitCommands, canonical, gitBlockReason, overlapNote, repoRelative, toolPath, writeBlockReason } from "./shared-guard.ts";
import { ticketSystemPrompt } from "./worker-prompt.ts";

/** What the owning superagent instance hears from its ticket's session. */
export interface TicketHookTarget {
	/** The ticket as it is now (for the system-prompt section); undefined once it is gone. */
	ticket(): Ticket | undefined;
	report(report: TicketReport): void;
	/** The ticket session started; its persisted file, when it has one. */
	session(sessionFile: string | undefined): void;
	/**
	 * A shared ticket's session (or a descendant) changed `path` (repo-relative): recorded in the ticket's `touched`.
	 * Returns the other open shared tickets that changed it too.
	 */
	touch?(path: string): number[];
}

export interface ChildSessionHook { name: string; extensionFactory: ExtensionFactory }

interface Registry {
	/** `ticketKey(commonDir, id)` → the owning instance's callbacks. */
	readonly tickets: Map<string, TicketHookTarget>;
	/**
	 * Session id → ticket key, for every active ticket session and every descendant session of a shared ticket: a
	 * child whose link's `parentSessionId` is here belongs to that ticket.
	 */
	readonly sessions: Map<string, string>;
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
	if (existing && existing.tickets instanceof Map && typeof existing.hook?.extensionFactory === "function") {
		if (!(existing.sessions instanceof Map)) (existing as { sessions: Map<string, string> }).sessions = new Map();
		return existing;
	}
	const created: Registry = { tickets: new Map(), sessions: new Map(), users: 0, hook: { name: HOOK_NAME, extensionFactory: ticketSessionExtension } };
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

/** The session link's `parentSessionId`, when the session has a link naming one. */
export function linkParent(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_LINK_TYPE) continue;
		const parent = (entry.data as { parentSessionId?: unknown } | undefined)?.parentSessionId;
		return typeof parent === "string" && parent ? parent : undefined;
	}
	return undefined;
}

/** The ticket key a session belongs to through its parent chain in the registry (a direct parent, or further up). */
export function ticketOfParent(parentSessionId: string | undefined): string | undefined {
	const { sessions } = superagentRegistry();
	return parentSessionId === undefined ? undefined : sessions.get(parentSessionId);
}

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

const SHARED_DESCENDANT_PROMPT = [
	"You work for a ticket in the user's shared working tree, together with other tickets and the user, who may edit files at the same time.",
	"- Leave all changes uncommitted and never change git state (no add, commit, checkout, switch, restore, reset, stash, clean, rebase, merge, pull, push, or branch and tag changes); such commands are blocked.",
	"- Change existing files with `edit`, and read a file again before changing it again. Do not revert or \"fix\" changes you did not make.",
	"- Do not start agents with `isolation: \"worktree\"`.",
].join("\n");

/** The hook's extension factory: inert until `session_start` finds a ticket this process runs. */
export function ticketSessionExtension(pi: ExtensionAPI): void {
	/** The ticket of this session: its own (a ticket session) or its ancestor's (a shared ticket's descendant). */
	let target: TicketHookTarget | undefined;
	/** This session is the ticket agent's own (not a descendant). */
	let own = false;
	let sessionId: string | undefined;
	let key: string | undefined;
	let registered = false;
	/** Shared mode: absolute path → mtime and size after this session last read, edited, or wrote it. */
	const seen = new Map<string, { mtimeMs: number; size: number }>();

	const ticket = () => target?.ticket();
	const shared = () => ticket()?.workspace === "shared";

	function forget(): void {
		const { sessions } = superagentRegistry();
		if (sessionId !== undefined && key !== undefined && sessions.get(sessionId) === key) sessions.delete(sessionId);
		target = undefined;
		own = false;
		sessionId = undefined;
		key = undefined;
		seen.clear();
	}

	pi.on("session_start", async (_event, ctx) => {
		forget();
		const registry = superagentRegistry();
		const link = ticketLink(ctx);
		if (link) {
			const repo = await createGit().open(ctx.sessionManager.getCwd() || ctx.cwd).catch(() => undefined);
			if (!repo) return;
			const found = registry.tickets.get(ticketKey(repo.commonDir, link.ticketId));
			if (!found) return;
			target = found;
			own = true;
			key = ticketKey(repo.commonDir, link.ticketId);
		} else {
			// A nested agent: part of a shared ticket when its parent chain reaches that ticket's session.
			const parentKey = ticketOfParent(linkParent(ctx));
			const found = parentKey !== undefined ? registry.tickets.get(parentKey) : undefined;
			if (!found || found.ticket()?.workspace !== "shared") return;
			target = found;
			key = parentKey;
		}
		sessionId = ctx.sessionManager.getSessionId();
		registry.sessions.set(sessionId, key!);
		if (!own) return;
		if (!registered) {
			registered = true;
			pi.registerTool({
				name: REPORT_TOOL,
				label: "Ticket Report",
				description: "Report the ticket's state to the user: ready, progress (optionally with a question), blocked, failed, or dropped. Returns at once.",
				promptSnippet: "Report the ticket's state to the user",
				parameters: ReportParameters,
				async execute(_id, params) {
					if (!target || !own) throw new Error("This session is not a ticket agent's session any more.");
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
		const current = ticket();
		if (!current) return undefined;
		if (!own) return current.workspace === "shared" ? { systemPrompt: `${event.systemPrompt}\n\n# Shared working tree\n\n${SHARED_DESCENDANT_PROMPT}` } : undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n# Your ticket\n\n${ticketSystemPrompt(current)}` };
	});

	pi.on("tool_call", (event, ctx) => {
		if (!target) return undefined;
		if (own && blockedInTicket(event.toolName)) return { block: true, reason: ticketBlockReason(event.toolName) };
		if (!shared()) return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "bash" && typeof input.command === "string") {
			const commands = blockedGitCommands(input.command);
			if (commands.length) return { block: true, reason: gitBlockReason(commands) };
		}
		if (event.toolName === "write" && typeof input.path === "string") {
			const path = toolPath(input.path, ctx.cwd);
			let stat: { mtimeMs: number; size: number; isFile(): boolean } | undefined;
			try { stat = statSync(path); } catch {}
			if (stat?.isFile()) {
				const last = seen.get(path);
				if (!last || last.mtimeMs !== stat.mtimeMs || last.size !== stat.size) return { block: true, reason: writeBlockReason(input.path) };
			}
		}
		if (event.toolName === "Agent" && input.isolation === "worktree") return { block: true, reason: AGENT_ISOLATION_BLOCK_REASON };
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!target || !shared() || event.isError) return undefined;
		if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string") return undefined;
		const path = toolPath(raw, ctx.cwd);
		try { const stat = statSync(path); seen.set(path, { mtimeMs: stat.mtimeMs, size: stat.size }); } catch {}
		if (event.toolName === "read") return undefined;
		const root = ticket()?.worktree;
		const rel = root ? repoRelative(canonical(root), path) : undefined;
		if (rel === undefined) return undefined;
		let others: number[] = [];
		try { others = target.touch?.(rel) ?? []; } catch {}
		if (!others.length) return undefined;
		return { content: [...event.content, { type: "text" as const, text: `\n${others.map((id) => overlapNote(id, rel)).join("\n")}` }] };
	});

	pi.on("session_shutdown", () => { forget(); });
}
