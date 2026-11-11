import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const SESSION_LINK_TYPE = "pi-extensions.session-link";

/** A session mode, switched by `/<name>` without disturbing the cached prompt. */
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
	/**
	 * The state of fresh sessions, set by `/<name> default [on | off]`; off when absent. A session gets it when its first
	 * run has no conversation before it; a session with earlier conversation starts off. `read` warns about an invalid
	 * setting when given a context.
	 */
	defaults?: { read(ctx?: ExtensionContext): Promise<boolean>; write(on: boolean): Promise<void> };
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
	const { name, notes, defaults } = mode;
	const usage = `Usage: /${name} [on | off | status${defaults ? " | default [on | off]" : ""}]`;
	/** The configured default, read at each session start and before a session's first run. */
	let configured = false;
	const refreshDefault = async () => { if (defaults) configured = await defaults.read(); };
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
		// Before the first run, a fresh session follows the default, and a session with earlier conversation stays off.
		const unpinned = () => configured && !ctx.sessionManager.getEntries().some(isConversation);
		return { base, pinned: pin !== undefined, active: active ?? base ?? unpinned() };
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

	function showBranch(ctx: ExtensionContext): void {
		const { active } = readBranch(ctx);
		setStatus(ctx, active);
		mode.onState?.(ctx, active);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!isEligible(ctx)) return;
		await refreshDefault();
		showBranch(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => { if (isEligible(ctx)) showBranch(ctx); });

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		if (readBranch(ctx).base === undefined) await refreshDefault();
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
			pi.appendEntry("pi-extensions.command", { command: name, kind: "extension", extension: "delegation" });
			if (!isEligible(ctx)) {
				ctx.ui.notify(`/${name} works only in top-level TUI and RPC sessions.`, "warning");
				return;
			}
			const action = args.trim().toLowerCase().replace(/\s+/g, " ");
			if (defaults && (action === "default" || action.startsWith("default "))) {
				const value = action.slice("default".length).trim();
				if (value === "") {
					const on = await defaults.read(ctx);
					ctx.ui.notify(`Default for new sessions: ${on ? "on" : "off"}.`, "info");
					return;
				}
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(usage, "warning");
					return;
				}
				await defaults.write(value === "on");
				configured = value === "on";
				// A session before its first run follows the new default unless switched.
				showBranch(ctx);
				ctx.ui.notify(`Default for new sessions: ${value}. Sessions that have had a first run keep their ${name} setting.`, "info");
				return;
			}
			const { active } = readBranch(ctx);
			if (action === "status") {
				ctx.ui.notify(active ? notes.isOn : notes.isOff, "info");
				return;
			}
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify(usage, "warning");
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
