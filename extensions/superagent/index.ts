// superagent: the main session routes work to ticket agents (Subagents' `ticket` type) in their own worktrees; see DESIGN.md.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./src/commands.ts";
import { createDispatcher, type Dispatcher, type NotifyExtra, type NotifyKind } from "./src/dispatcher.ts";
import { createGit } from "./src/git.ts";
import { acquireHook } from "./src/hook.ts";
import { mergeTicket } from "./src/merge.ts";
import { Outbox } from "./src/outbox.ts";
import { boardLines, footerText, registerRenderer, reportDetails } from "./src/render.ts";
import { ineligibleReason, Router } from "./src/router.ts";
import { DEFAULT_SETTINGS, loadSettings } from "./src/settings.ts";
import { branchCandidates, openStore } from "./src/store.ts";
import { createSubagentsHost } from "./src/subagents-host.ts";
import { registerTools } from "./src/tools.ts";
import { STATUS_KEY, WIDGET_KEY, type DispatchSettings, type Repo, type Ticket, type TicketStore } from "./src/types.ts";
import { RECOVERY_NOTE, requestPrompt } from "./src/worker-prompt.ts";

/** Settings problems already shown in this process. */
const reported = new Set<string>();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The store, telling `changed` after every write. */
function observed(store: TicketStore, changed: () => void): TicketStore {
	return new Proxy(store, {
		get(target, name, receiver) {
			const value = Reflect.get(target, name, receiver);
			if (typeof value !== "function") return value;
			if (name !== "create" && name !== "update") return value.bind(target);
			return (...args: unknown[]) => { const result = value.apply(target, args); try { changed(); } catch {} return result; };
		},
	});
}

export default function superagentExtension(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let settings: DispatchSettings = { ...DEFAULT_SETTINGS };
	let repo: Repo | undefined;
	let dispatcher: Dispatcher | undefined;
	let toolsRegistered = false;
	let closed = false;
	let footer: string | undefined;
	let board: string | undefined;
	let releaseHook: (() => void) | undefined;

	/** The board widget (TUI only): open tickets grouped by what they wait for; hidden without open tickets. */
	function refreshBoard(context: ExtensionContext): void {
		if (context.mode !== "tui") return;
		const current = dispatcher;
		const open = current?.list() ?? [];
		const lines = boardLines(open, (ticket) => (ticket.after ?? []).filter((dep) => current?.get(dep)?.state !== "merged"));
		const key = lines.join("\n");
		if (key === board) return;
		board = key;
		try { context.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined); } catch {}
	}

	const changed = () => {
		if (closed || !ctx || router.reason) return;
		refreshBoard(ctx);
		const text = footerText(router.mode, dispatcher?.summary());
		if (text === footer) return;
		footer = text;
		try { ctx.ui.setStatus(STATUS_KEY, text); } catch {}
	};
	const router = new Router(pi, { dispatcher: () => dispatcher, settings: () => settings, changed });
	router.register();
	registerRenderer(pi);
	registerCommands(pi, { dispatcher: () => dispatcher, router, changed });

	const outbox = new Outbox({
		send: (message, options) => pi.sendMessage(message, options),
		isIdle: () => ctx?.isIdle() ?? true,
		react: () => settings.react,
	});
	pi.on("turn_end", () => { outbox.turnEnd(); });
	pi.on("agent_end", () => { outbox.agentEnd(); });

	function deliver(ticket: Ticket, kind: NotifyKind, extra?: NotifyExtra): void {
		if (closed || !ctx) return;
		outbox.push(reportDetails(ticket, kind, extra));
		changed();
	}

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		closed = false;
		outbox.reset();
		const agentDir = getAgentDir();
		const loaded = loadSettings(agentDir);
		settings = loaded.settings;
		for (const problem of loaded.problems) {
			if (reported.has(problem)) continue;
			reported.add(problem);
			if (context.hasUI) context.ui.notify(`superagent: ${problem}`, "warning");
		}
		let reason = ineligibleReason(context);
		if (!reason) {
			try {
				repo = await createGit().open(context.sessionManager.getCwd() || context.cwd);
			} catch {
				repo = undefined;
			}
			if (!repo) reason = "the working directory is not in a git repository with at least one commit";
		}
		if (closed) return;
		if (!reason && repo) {
			try {
				const current = repo;
				const store = observed(openStore(current.commonDir), changed);
				const sessionId = context.sessionManager.getSessionId();
				const sessionFile = context.sessionManager.getSessionFile();
				dispatcher = createDispatcher({
					store, git: createGit(), repo: current, mergeTicket, branchCandidates, requestPrompt, recoveryNote: RECOVERY_NOTE,
					settings: () => settings, sessionId, ...(sessionFile !== undefined ? { sessionFile } : {}),
					notify: deliver,
					createWorkerHost: (onEvent) => createSubagentsHost({
						events: pi.events, commonDir: current.commonDir, ticket: (id) => store.get(id), onEvent,
					}),
				});
				dispatcher.startup();
				// Child sessions of this process find their tickets through the hook from now on.
				releaseHook ??= acquireHook();
			} catch (error) {
				dispatcher = undefined;
				reason = `the ticket store could not be opened: ${errorText(error)}`;
				if (context.hasUI) context.ui.notify(`superagent: ${reason}`, "error");
			}
		}
		if (!reason && !toolsRegistered) {
			toolsRegistered = true;
			registerTools(pi, { dispatcher: () => dispatcher, repo: () => repo, changed });
		}
		router.start(context, reason);
		// A session that can never route to tickets shows no footer and no board.
		if (reason) {
			try { context.ui.setStatus(STATUS_KEY, undefined); } catch {}
			footer = undefined;
		}
	});

	pi.on("session_shutdown", async () => {
		if (closed) return;
		closed = true;
		outbox.dispose();
		// Restores the session's tools first, so a reload starts from them rather than from the router set.
		try { router.leave(); } catch {}
		const current = dispatcher;
		dispatcher = undefined;
		try { await current?.shutdown(); } catch {}
		releaseHook?.();
		releaseHook = undefined;
		try { ctx?.ui.setStatus(STATUS_KEY, undefined); } catch {}
		if (board !== undefined) { try { ctx?.ui.setWidget(WIDGET_KEY, undefined); } catch {} }
		footer = undefined;
		board = undefined;
		ctx = undefined;
	});
}
