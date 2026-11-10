import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const ENTRY = "alwayson";
const SESSION_LINK_TYPE = "pi-extensions.session-link";
const SESSION_MODES = Symbol.for("pi-extensions.session-modes");
const STATUS = "📡 alwayson";
const ON_PREFIX = "Always-on mode 📡 is on";
const ON_TEXT = `${ON_PREFIX}: the user wants this session to stay responsive to them and to other pi sessions that message it through pika relay, which reach it only between turns, and explicitly opts in to background agents. `
	+ "Run every development task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in a background agent: Agent with run_in_background: true, worker for changes and verification, recon for research, "
	+ "with a self-contained prompt or inherit_context: true. Then end your turn at once, telling the user what is running; do not wait, sleep, or poll. An agent's completion notification starts a new turn. "
	+ "Between them, answer the user and relay messages yourself, and use steer_subagent to redirect a running agent and get_subagent_result for its details. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Keep direct tools for answers, short lookups, and small edits. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_PREFIX = "Always-on mode is off";
const OFF_TEXT = `${OFF_PREFIX}. Ignore earlier always-on mode instructions: long tasks no longer have to run in background agents, and the standard subagent guidance applies unless another mode says otherwise.`;
const SECTION_TEXT = `${ON_TEXT} A later always-on mode message overrides this.`;

/** The pin, written once at a branch's first run, or a switch. */
type AlwaysOnEntry = { base: boolean } | { active: boolean };

interface AlwaysOnState {
	/** The pin: undefined until the session's first run, true when the section carries always-on mode. */
	base: boolean | undefined;
	/** Whether the current branch holds the pin. `/tree` can move to before it. */
	pinned: boolean;
	active: boolean;
}

/** The modes each top-level session has on, shared in the process: Relay reads it, as a room's representative needs always-on mode. */
interface SessionModesRegistry {
	/** Mode names ("alwayson") active on each top-level session's current branch, by session id. */
	modes: Map<string, Set<string>>;
	/** Called with a session id whenever its set changes. */
	listeners: Set<(sessionId: string) => void>;
}

const hidden = (content: string) => ({ message: { customType: ENTRY, content, display: false } });
const isPin = (entry: SessionEntry): entry is CustomEntry<{ base: boolean }> => entry.type === "custom" && entry.customType === ENTRY && "base" in (entry.data as AlwaysOnEntry);
const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/** The always-on state of the current branch. */
function readBranch(ctx: ExtensionContext): AlwaysOnState {
	let pin: boolean | undefined;
	let active: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as AlwaysOnEntry;
		if ("base" in data) pin = data.base;
		else active = data.active;
	}
	// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
	const base = pin ?? ctx.sessionManager.getEntries().find(isPin)?.data?.base;
	return { base, pinned: pin !== undefined, active: active ?? base ?? false };
}

/**
 * What an always-on message says: true for on, false for off, undefined when it says neither. The readers below take
 * what the latest message said, not which switch it followed: a run already starting can land its message after a later switch.
 */
const stateOf = (content: unknown) => typeof content !== "string" ? undefined
	: content.startsWith(ON_PREFIX) ? true : content.startsWith(OFF_PREFIX) ? false : undefined;

/**
 * The state the model sees: what the latest always-on message in the context Pi builds from the branch says, else the
 * section's. Pi's projection leaves out what the latest compaction replaced with its summary (the entries before its
 * kept range) and what a context edit omits, so a message on the branch can be gone from it. Undefined in Pi 1.3 and
 * 1.4, which have no projection.
 */
function readSeen(ctx: ExtensionContext, base: boolean): boolean | undefined {
	if (typeof ctx.sessionManager.buildSessionProjection !== "function") return undefined;
	let seen: boolean | undefined;
	for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
		if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== ENTRY) continue;
		for (const message of messages) seen = stateOf("content" in message ? message.content : undefined) ?? seen;
	}
	return seen ?? base;
}

/** What the model was last told on the branch, whether it still sees it or not: the latest always-on message, else the section. */
function readTold(ctx: ExtensionContext, base: boolean): boolean {
	let told: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === ENTRY) told = stateOf(entry.content) ?? told;
	}
	return told ?? base;
}

/** The registry, created here unless its reader came first. */
function sessionModes(): SessionModesRegistry {
	const shared = globalThis as Record<symbol, unknown>;
	let registry = shared[SESSION_MODES] as SessionModesRegistry | undefined;
	if (!registry) {
		registry = { modes: new Map(), listeners: new Set() };
		shared[SESSION_MODES] = registry;
	}
	return registry;
}

/** Keep "alwayson" in the session's set exactly while the mode is on, and tell every listener about a change. */
function publish(sessionId: string, active: boolean): void {
	const registry = sessionModes();
	const modes = registry.modes.get(sessionId);
	if (active === (modes?.has(ENTRY) ?? false)) return;
	if (active) {
		if (modes) modes.add(ENTRY);
		else registry.modes.set(sessionId, new Set([ENTRY]));
	} else if (modes) {
		modes.delete(ENTRY);
		if (modes.size === 0) registry.modes.delete(sessionId);
	}
	for (const listener of [...registry.listeners]) {
		try {
			const result: unknown = listener(sessionId);
			// An async listener's rejection would otherwise go unhandled.
			if (result instanceof Promise) result.catch(() => {});
		} catch {}
	}
}

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered. `parentSession` cannot identify a child: Pi
 * also sets it on forks.
 */
function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

function setStatus(ctx: ExtensionContext, active: boolean): void {
	try { ctx.ui.setStatus(ENTRY, active ? STATUS : undefined); } catch {}
}

/**
 * `/alwayson`: long tasks go to background agents so the session stays free for its user and relay messages, in the
 * section from a session's start or by a hidden message after it.
 */
export default function alwaysOnExtension(pi: ExtensionAPI): void {
	function writePin({ base, active }: AlwaysOnState, ctx: ExtensionContext): void {
		// The pin holds across the session, so conversation on any branch counts: such a prefix may be cached and never gains a section.
		const pinned = base ?? (active && !ctx.sessionManager.getEntries().some(isConversation));
		pi.appendEntry<AlwaysOnEntry>(ENTRY, { base: pinned });
	}

	async function showBranch(_event: unknown, ctx: ExtensionContext): Promise<void> {
		if (!isEligible(ctx)) return;
		const { active } = readBranch(ctx);
		setStatus(ctx, active);
		publish(ctx.sessionManager.getSessionId(), active);
	}

	pi.on("session_start", showBranch);
	pi.on("session_tree", showBranch);
	// Only eligible sessions are ever published, so any other has nothing to remove.
	pi.on("session_shutdown", async (_event, ctx) => { publish(ctx.sessionManager.getSessionId(), false); });

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		let state = readBranch(ctx);
		if (!state.pinned) {
			writePin(state, ctx);
			state = readBranch(ctx);
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections.alwayson = SECTION_TEXT;
		const base = state.base ?? false;
		const seen = readSeen(ctx, base);
		// Sent once, and again only after a compaction or `/tree` takes it out of what the model sees: each copy stays in the context.
		// Without a projection, repeated while the switch differs from the section, so a compaction cannot drop it for long.
		const send = seen === undefined ? state.active !== base || readTold(ctx, base) !== state.active : seen !== state.active;
		if (send) return hidden(state.active ? ON_TEXT : OFF_TEXT);
		return undefined;
	});

	pi.registerCommand("alwayson", {
		description: "Toggle always-on mode 📡, long tasks in background agents so the session keeps answering: /alwayson [on | off | status]",
		handler: async (args, ctx) => {
			if (!isEligible(ctx)) {
				ctx.ui.notify("/alwayson works only in top-level TUI and RPC sessions.", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			const { active } = readBranch(ctx);
			if (action === "status") {
				ctx.ui.notify(active ? "Always-on mode 📡 is on." : "Always-on mode is off.", "info");
				return;
			}
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify("Usage: /alwayson [on | off | status]", "warning");
				return;
			}
			const next = action === "" ? !active : action === "on";
			if (next !== active) pi.appendEntry<AlwaysOnEntry>(ENTRY, { active: next });
			setStatus(ctx, next);
			publish(ctx.sessionManager.getSessionId(), next);
			if (next === active) ctx.ui.notify(next ? "Always-on mode 📡 is already on." : "Always-on mode is already off.", "info");
			else ctx.ui.notify(next
				? "Always-on mode 📡 on: the model runs long tasks in background agents and ends its turns, so it answers you and relay messages meanwhile. Takes effect with the next prompt; usage may increase."
				: "Always-on mode off. Takes effect with the next prompt.", "info");
		},
	});
}
