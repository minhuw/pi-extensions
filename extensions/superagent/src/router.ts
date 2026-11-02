// Superagent and direct mode: the router tool set, the tool_call gate, the router prompt, and `#N` input; see DESIGN.md "Modes".
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DispatchError, type Dispatcher } from "./dispatcher.ts";
import { describeTicket } from "./render.ts";
import { ROUTER_PROMPT, ticketsContent } from "./router-prompt.ts";
import { disabledByEnv, DISABLED_ENV } from "./settings.ts";
import { MODE_ENTRY, SESSION_LINK_TYPE, TICKETS_MESSAGE, type DispatchSettings } from "./types.ts";

export type Mode = "superagent" | "direct";

/** The superagent router tools, registered by src/tools.ts. */
export const ROUTER_TICKET_TOOLS = ["ticket_create", "ticket_message", "ticket_status", "ticket_merge", "ticket_close", "git_read"] as const;
const READ_BUILTINS = ["read", "grep", "find", "ls", "ffgrep", "fffind"];
/** Subagents tools for the router's own read-only helpers (`Agent` itself is gated by type). */
const SUBAGENT_TOOLS = ["get_subagent_result", "steer_subagent"];
const FIXED_TOOLS = new Set<string>([...READ_BUILTINS, ...ROUTER_TICKET_TOOLS, ...SUBAGENT_TOOLS, "relay_list", "relay_send", "relay_status", "loop_schedule", "loop_stop"]);

export const blockReason = (tool: string) =>
	`${tool} is not available in superagent mode: create a ticket with ticket_create for changes, or switch to direct mode with /superagent off.`;

export const agentTypeBlockReason = (type: unknown, allowed: readonly string[]) =>
	`Agent with subagent_type ${JSON.stringify(type ?? null)} is not available in superagent mode: only ${allowed.length ? allowed.join(", ") : "no types"} may run here (setting routerAgents). Work that changes files goes to a ticket: create one with ticket_create.`;

export const agentResumeBlockReason = (ref: string, ticketId: number) =>
	`Agent resume ${JSON.stringify(ref)} names the agent of ticket #${ticketId}: send it a message with ticket_message instead.`;

/** Why a model-issued `Agent` call is refused in superagent mode; undefined when it may run. */
export function agentCallBlock(input: unknown, allowed: readonly string[], ticketAgents: ReadonlyMap<string, number>): string | undefined {
	const { subagent_type: type, resume } = (input ?? {}) as { subagent_type?: unknown; resume?: unknown };
	if (typeof resume === "string" && resume.trim()) {
		const ref = resume.trim();
		const byId = ticketAgents.get(ref);
		if (byId !== undefined) return agentResumeBlockReason(ref, byId);
		const handle = /^@?ticket-(\d+)$/.exec(ref);
		if (handle) return agentResumeBlockReason(ref, Number(handle[1]));
	}
	if (typeof type !== "string" || !allowed.includes(type)) return agentTypeBlockReason(type, allowed);
	return undefined;
}

/** A child session: its header has `parentSession`, or it has a session-link entry. */
export function isChildSession(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	if (ctx.sessionManager.getHeader()?.parentSession) return true;
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/** The latest `superagent-mode` choice on the current branch. */
export function modeEntry(ctx: Pick<ExtensionContext, "sessionManager">): Mode | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (mode === "superagent" || mode === "direct") return mode;
	}
	return undefined;
}

/** Why the session is always direct; undefined when superagent mode is possible (the repository is checked separately). */
export function ineligibleReason(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): string | undefined {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return `superagent runs only in the TUI and RPC modes, and this session runs in ${ctx.mode} mode`;
	if (isChildSession(ctx)) return "this is a child session (a subagent, Herder step, or ticket agent)";
	return undefined;
}

/** The starting mode of an eligible session: PI_SUPERAGENT_DISABLED=1 wins, then the session's own choice, then the settings. */
export function startMode(ctx: Pick<ExtensionContext, "sessionManager">, settings: DispatchSettings): Mode {
	if (disabledByEnv()) return "direct";
	return modeEntry(ctx) ?? (settings.enabled ? "superagent" : "direct");
}

/** The router set among the registered tools; see DESIGN.md "Tools in superagent mode". `Agent` is in it when some type may run. */
export function routerTools(tools: readonly ToolInfo[], extra: readonly string[] = [], routerAgents: readonly string[] = []): string[] {
	const named = new Set(extra);
	return tools.filter((tool) => tool.exposure !== "hidden" && (
		FIXED_TOOLS.has(tool.name) || tool.name.startsWith("herder_") || named.has(tool.name) || (tool.name === "Agent" && routerAgents.length > 0)
		// Read-only tools Pi declares to the model anyway; `codemode`/`deferred` ones (MCP tools by default) stay undeclared.
		|| (tool.annotations?.readOnlyHint === true && !tool.reachesTools
			&& (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only")))).map((tool) => tool.name);
}

/** The latest `superagent-tickets` content on the branch: what the model was last told. */
function lastTickets(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom_message" && entry.customType === TICKETS_MESSAGE) return typeof entry.content === "string" ? entry.content : undefined;
	}
	return undefined;
}

export interface RouterHost {
	dispatcher(): Dispatcher | undefined;
	settings(): DispatchSettings;
	/** The mode changed or a ticket was touched: refresh the footer. */
	changed(): void;
}

const INPUT = /^#(\d+)(?:\s+([\s\S]*))?$/;

/** The session's mode and tool set. Nothing happens until `start`. */
export class Router {
	mode: Mode = "direct";
	/** Why the session can only be direct; undefined when it may route to tickets. */
	reason: string | undefined = "the session has not started";
	/** Active tools before superagent mode, restored by direct mode. */
	private saved?: string[];
	/** Every tool registered when superagent mode began. */
	private known?: Set<string>;
	private set = new Set<string>();
	private given?: string;

	constructor(private readonly pi: ExtensionAPI, private readonly host: RouterHost) {}

	/** The tool_call gate, the router prompt, and `#N` input; registered once by the factory. */
	register(): void {
		this.pi.on("tool_call", (event) => {
			if (this.mode !== "superagent" || event.parentToolCallId !== undefined) return undefined;
			if (!this.set.has(event.toolName)) return { block: true, reason: blockReason(event.toolName) };
			if (event.toolName === "Agent") {
				const reason = agentCallBlock(event.input, this.host.settings().routerAgents, this.ticketAgents());
				if (reason) return { block: true, reason };
			}
			return undefined;
		});
		this.pi.on("before_agent_start", (event) => {
			if (this.mode !== "superagent") return undefined;
			this.apply();
			event.systemPromptOptions.sections.superagent = ROUTER_PROMPT;
			const dispatcher = this.host.dispatcher();
			if (!dispatcher) return undefined;
			const summary = dispatcher.summary();
			const content = ticketsContent(summary.text, summary.workspace);
			// Nothing to say until a ticket exists; afterwards every change, including the last one closing.
			if (content === this.given || (this.given === undefined && !summary.open.length)) return undefined;
			this.given = content;
			return { message: { customType: TICKETS_MESSAGE, content, display: false } };
		});
		this.pi.on("input", (event, ctx) => {
			if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" as const };
			const match = INPUT.exec(event.text.trim());
			const dispatcher = this.host.dispatcher();
			if (!match || !dispatcher) return { action: "continue" as const };
			// `#12 …` without ticket 12 is ordinary text, such as an issue number: it goes to the model unchanged.
			if (!dispatcher.get(Number(match[1]))) return { action: "continue" as const };
			this.input(ctx, dispatcher, Number(match[1]), match[2]?.trim() ?? "");
			return { action: "handled" as const };
		});
	}

	private input(ctx: ExtensionContext, dispatcher: Dispatcher, id: number, text: string): void {
		const ticket = dispatcher.get(id)!;
		if (!text) {
			void dispatcher.inspect(id).then((info) => ctx.ui.notify(describeTicket(info), "info"), (error) => ctx.ui.notify(String(error instanceof Error ? error.message : error), "error"));
			return;
		}
		if (ticket.state === "merged" || ticket.state === "done" || ticket.state === "closed") { ctx.ui.notify(`Ticket #${id} is ${ticket.state}; it takes no more messages.`, "error"); return; }
		void dispatcher.send(id, text).then(({ delivery }) => {
			ctx.ui.notify(`Sent to #${id} ${ticket.title}: ${DELIVERY_TEXT[delivery]}.`, "info");
			this.host.changed();
		}, (error) => {
			ctx.ui.notify(error instanceof DispatchError ? error.message : `Could not send to #${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	}

	/** Decides the mode at `session_start`; `reason` set means always direct. */
	start(ctx: ExtensionContext, reason: string | undefined): void {
		this.reason = reason;
		this.given = lastTickets(ctx);
		const mode = reason ? "direct" : startMode(ctx, this.host.settings());
		if (mode === "superagent") this.enter();
		else this.mode = "direct";
		this.host.changed();
	}

	/** `/superagent on|off`: records the choice on the branch. Throws when the session cannot route to tickets. */
	setMode(mode: Mode): void {
		if (mode === "superagent" && this.reason) throw new DispatchError(`Superagent mode is not available: ${this.reason}.`);
		if (mode === "superagent" && disabledByEnv()) throw new DispatchError(`Superagent mode is disabled by ${DISABLED_ENV}=1.`);
		this.pi.appendEntry(MODE_ENTRY, { mode });
		if (mode === "superagent") this.enter(); else this.leave();
		this.host.changed();
	}

	/** The tools the model may call in superagent mode. */
	routerSet(): ReadonlySet<string> { return this.set; }

	/** Agent ids of this repository's tickets, recorded on the tickets. */
	private ticketAgents(): Map<string, number> {
		const agents = new Map<string, number>();
		for (const ticket of this.host.dispatcher()?.list(true) ?? []) if (ticket.agentId) agents.set(ticket.agentId, ticket.id);
		return agents;
	}

	private enter(): void {
		if (this.mode !== "superagent") {
			this.saved = this.pi.getActiveTools();
			this.known = new Set(this.pi.getAllTools().map((tool) => tool.name));
			this.mode = "superagent";
		}
		this.apply();
	}

	/** (Re)applies the router set, as other extensions may have changed the active tools. */
	apply(): void {
		if (this.mode !== "superagent") return;
		const settings = this.host.settings();
		const names = routerTools(this.pi.getAllTools(), settings.routerTools, settings.routerAgents);
		this.set = new Set(names);
		const active = this.pi.getActiveTools();
		if (active.length !== names.length || active.some((name) => !this.set.has(name))) this.pi.setActiveTools(names);
	}

	/** Back to the tools active before superagent mode, plus direct tools registered since. */
	leave(): void {
		if (this.mode !== "superagent") return;
		this.mode = "direct";
		const restored = new Set(this.saved ?? []);
		for (const tool of this.pi.getAllTools()) {
			if (!this.known?.has(tool.name) && (tool.exposure === "direct" || tool.exposure === "model-only")) restored.add(tool.name);
		}
		this.saved = undefined;
		this.known = undefined;
		this.set = new Set();
		this.pi.setActiveTools([...restored]);
	}
}

const DELIVERY_TEXT = {
	steered: "steered into its running agent",
	prompted: "its agent started a new run",
	reopened: "its agent's session was reopened",
	started: "its agent started",
	queued: "kept for its first run (the ticket is queued)",
} as const;
