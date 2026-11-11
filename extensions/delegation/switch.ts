import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const SESSION_LINK_TYPE = "pi-extensions.session-link";

/** A session-only mode, switched by `/<name>` without disturbing the cached prompt. */
export interface ModeSpec {
	/** The command, and the key of the mode's entries, hidden messages, system prompt section, and footer status. */
	name: string;
	description: string;
	status: string;
	onPrefix: string;
	onText: string;
	offPrefix: string;
	offText: string;
	sectionText: string;
	/** Replies to `/<name> status`, to a switch, and to a switch to the state the mode is already in. */
	notes: { isOn: string; isOff: string; on: string; off: string; alreadyOn: string; alreadyOff: string };
	/** Called with the branch's state at session start and `/tree`, and with each switch, in eligible sessions only. */
	onState?: (ctx: ExtensionContext, active: boolean) => void;
}

/** The pin, written once at a branch's first run, or a switch. */
type ModeEntry = { base: boolean } | { active: boolean };

interface ModeState {
	/** The pin: undefined until the session's first run, true when the section carries the mode. */
	base: boolean | undefined;
	/** Whether the current branch holds the pin. `/tree` can move to before it. */
	pinned: boolean;
	active: boolean;
}

const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered. `parentSession` cannot identify a child: Pi
 * also sets it on forks.
 */
function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/**
 * Register `/<name>`: the mode goes in the section from a session's start, or by hidden per-run messages after it.
 * Returns whether the mode applies to a context's session and branch.
 */
export function registerMode(pi: ExtensionAPI, mode: ModeSpec): (ctx: ExtensionContext) => boolean {
	const { name, notes } = mode;
	const hidden = (content: string) => ({ message: { customType: name, content, display: false } });
	const isPin = (entry: SessionEntry): entry is CustomEntry<{ base: boolean }> => entry.type === "custom" && entry.customType === name && "base" in (entry.data as ModeEntry);

	/** The mode's state on the current branch. */
	function readBranch(ctx: ExtensionContext): ModeState {
		let pin: boolean | undefined;
		let active: boolean | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== name) continue;
			const data = entry.data as ModeEntry;
			if ("base" in data) pin = data.base;
			else active = data.active;
		}
		// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
		const base = pin ?? ctx.sessionManager.getEntries().find(isPin)?.data?.base;
		return { base, pinned: pin !== undefined, active: active ?? base ?? false };
	}

	/**
	 * What a message of the mode says: true for on, false for off, undefined when it says neither. The readers below take
	 * what the latest message said, not which switch it followed: a run already starting can land its message after a later switch.
	 */
	const stateOf = (content: unknown) => typeof content !== "string" ? undefined
		: content.startsWith(mode.onPrefix) ? true : content.startsWith(mode.offPrefix) ? false : undefined;

	/**
	 * The state the model sees: what the latest message of the mode in the context Pi builds from the branch says, else
	 * the section's. Pi's projection leaves out what the latest compaction replaced with its summary (the entries before
	 * its kept range) and what a context edit omits, so a message on the branch can be gone from it. Undefined in Pi 1.3
	 * and 1.4, which have no projection.
	 */
	function readSeen(ctx: ExtensionContext, base: boolean): boolean | undefined {
		if (typeof ctx.sessionManager.buildSessionProjection !== "function") return undefined;
		let seen: boolean | undefined;
		for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
			if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== name) continue;
			for (const message of messages) seen = stateOf("content" in message ? message.content : undefined) ?? seen;
		}
		return seen ?? base;
	}

	/** What the model was last told on the branch, whether it still sees it or not: the latest message of the mode, else the section. */
	function readTold(ctx: ExtensionContext, base: boolean): boolean {
		let told: boolean | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom_message" && entry.customType === name) told = stateOf(entry.content) ?? told;
		}
		return told ?? base;
	}

	function setStatus(ctx: ExtensionContext, active: boolean): void {
		try { ctx.ui.setStatus(name, active ? mode.status : undefined); } catch {}
	}

	function writePin({ base, active }: ModeState, ctx: ExtensionContext): void {
		// The pin holds across the session, so conversation on any branch counts: such a prefix may be cached and never gains a section.
		const pinned = base ?? (active && !ctx.sessionManager.getEntries().some(isConversation));
		pi.appendEntry<ModeEntry>(name, { base: pinned });
	}

	async function showBranch(_event: unknown, ctx: ExtensionContext): Promise<void> {
		if (!isEligible(ctx)) return;
		const { active } = readBranch(ctx);
		setStatus(ctx, active);
		mode.onState?.(ctx, active);
	}

	pi.on("session_start", showBranch);
	pi.on("session_tree", showBranch);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		let state = readBranch(ctx);
		if (!state.pinned) {
			writePin(state, ctx);
			state = readBranch(ctx);
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections[name] = mode.sectionText;
		const base = state.base ?? false;
		const seen = readSeen(ctx, base);
		// Sent once, and again only after a compaction or `/tree` takes it out of what the model sees: each copy stays in the context.
		// Without a projection, repeated while the switch differs from the section, so a compaction cannot drop it for long.
		const send = seen === undefined ? state.active !== base || readTold(ctx, base) !== state.active : seen !== state.active;
		if (send) return hidden(state.active ? mode.onText : mode.offText);
		return undefined;
	});

	pi.registerCommand(name, {
		description: mode.description,
		handler: async (args, ctx) => {
			if (!isEligible(ctx)) {
				ctx.ui.notify(`/${name} works only in top-level TUI and RPC sessions.`, "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			const { active } = readBranch(ctx);
			if (action === "status") {
				ctx.ui.notify(active ? notes.isOn : notes.isOff, "info");
				return;
			}
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify(`Usage: /${name} [on | off | status]`, "warning");
				return;
			}
			const next = action === "" ? !active : action === "on";
			if (next !== active) pi.appendEntry<ModeEntry>(name, { active: next });
			setStatus(ctx, next);
			mode.onState?.(ctx, next);
			if (next === active) ctx.ui.notify(next ? notes.alreadyOn : notes.alreadyOff, "info");
			else ctx.ui.notify(next ? notes.on : notes.off, "info");
		},
	});

	return (ctx) => isEligible(ctx) && readBranch(ctx).active;
}
