import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getAgentDir,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatBoard, isCoordinator, pruneSettled, sessionModes, swarmBoards, type SwarmBoard } from "./board.ts";

const NAME = "swarm";
const STATUS = "🐝 swarm";
const USAGE = "Usage: /swarm [on | off | status | board [clear] | default [on | off]]";
const ON_PREFIX = "Swarm mode 🐝 is on";
const ON_TEXT = `${ON_PREFIX}: the user explicitly opts in to background agents, so this session stays free to answer them and other pi sessions that message it through pika relay, which reach it only between turns. `
	+ "Work as the coordinator: run each development task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in background agents (Agent with run_in_background: true; worker for changes and verification, recon for research), "
	+ "split into independent pieces launched together in one message, each with a self-contained prompt or inherit_context: true that names the files it owns, the files it must not touch, and the command that shows it is done. "
	+ "Track the pieces on swarm_board when it is available; agents read it and post their progress and blockers there. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Then end your turn at once, telling the user what is running; do not wait, sleep, or poll. An agent's completion notification starts a new turn. "
	+ "Between them, answer the user and relay messages yourself, use steer_subagent to redirect a running agent and get_subagent_result for its details. "
	+ "Keep direct tools for answers, short lookups, and small edits. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_PREFIX = "Swarm mode is off";
const OFF_TEXT = `${OFF_PREFIX}. Ignore earlier swarm mode instructions: long tasks no longer have to run in background agents, and the standard subagent guidance applies unless another mode says otherwise.`;
const SECTION_TEXT = `${ON_TEXT} A later swarm mode message overrides this.`;
const NOTES = {
	isOn: "Swarm mode 🐝 is on.",
	isOff: "Swarm mode is off.",
	on: "Swarm mode 🐝 on: the model runs long tasks in background agents and ends its turns, so it answers you and relay messages meanwhile. Takes effect with the next prompt; usage may increase.",
	off: "Swarm mode off. Takes effect with the next prompt.",
	alreadyOn: "Swarm mode 🐝 is already on.",
	alreadyOff: "Swarm mode is already off.",
} as const;

/** The pin, written once at a branch's first run, or a switch. */
type SwarmEntry = { base: boolean } | { active: boolean };

interface SwarmState {
	/** The pin: undefined until the session's first run, true when the section carries swarm mode. */
	base: boolean | undefined;
	/** Whether the current branch holds the pin. `/tree` can move to before it. */
	pinned: boolean;
	active: boolean;
}

const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

const isPin = (entry: SessionEntry): entry is CustomEntry<{ base: boolean }> =>
	entry.type === "custom" && entry.customType === NAME && "base" in (entry.data as SwarmEntry);

const hidden = (content: string) => ({ message: { customType: NAME, content, display: false } });

/**
 * What a swarm message says: true for on, false for off, undefined when it says neither. The readers below take what
 * the latest message said, not which switch it followed: a run already starting can land its message after a later switch.
 */
const stateOf = (content: unknown) => typeof content !== "string" ? undefined
	: content.startsWith(ON_PREFIX) ? true : content.startsWith(OFF_PREFIX) ? false : undefined;

/**
 * The state the model sees: what the latest swarm message in the context Pi builds from the branch says, else the
 * section's. Pi's projection leaves out what the latest compaction replaced with its summary (the entries before its
 * kept range) and what a context edit omits, so a message on the branch can be gone from it. Undefined in Pi 1.3 and
 * 1.4, which have no projection.
 */
function readSeen(ctx: ExtensionContext, base: boolean): boolean | undefined {
	if (typeof ctx.sessionManager.buildSessionProjection !== "function") return undefined;
	let seen: boolean | undefined;
	for (const { sourceEntry, messages } of ctx.sessionManager.buildSessionProjection().entries) {
		if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== NAME) continue;
		for (const message of messages) seen = stateOf("content" in message ? message.content : undefined) ?? seen;
	}
	return seen ?? base;
}

/** What the model was last told on the branch, whether it still sees it or not: the latest swarm message, else the section. */
function readTold(ctx: ExtensionContext, base: boolean): boolean {
	let told: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === NAME) told = stateOf(entry.content) ?? told;
	}
	return told ?? base;
}

const configPath = () => join(getAgentDir(), "swarm.json");

/** The default for fresh sessions (`true` when unconfigured). An invalid file falls back to `true`, with a warning when `ctx` is given. */
async function readDefault(ctx?: ExtensionContext): Promise<boolean> {
	const path = configPath();
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { default?: unknown } | null;
		if (typeof parsed?.default === "boolean") return parsed.default;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
	}
	try { ctx?.ui.notify(`Ignoring ${path}: expected { "default": true } or { "default": false }. Using on.`, "warning"); } catch {}
	return true;
}

async function writeDefault(enabled: boolean): Promise<void> {
	const path = configPath();
	const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(getAgentDir(), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify({ default: enabled })}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Keep "swarm" in the session's set exactly while the mode is on, and tell every listener about a change. */
function publish(sessionId: string, active: boolean): void {
	const registry = sessionModes();
	const modes = registry.modes.get(sessionId);
	if (active === (modes?.has(NAME) ?? false)) return;
	if (active) {
		if (modes) modes.add(NAME);
		else registry.modes.set(sessionId, new Set([NAME]));
	} else if (modes) {
		modes.delete(NAME);
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

function formatSwarmStatus(sessionId: string, active: boolean): string | undefined {
	if (!active) return undefined;
	const board = swarmBoards().boards.get(sessionId);
	const blocked = board?.cards.filter((card) => card.status === "blocked").length ?? 0;
	return blocked > 0 ? `${STATUS} · ${blocked} blocked` : STATUS;
}

function handleBoard(rest: string, ctx: ExtensionContext, active: boolean): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const board = swarmBoards().boards.get(sessionId);
	if (rest === "") {
		if (!active && !board?.cards.length) {
			ctx.ui.notify("Swarm mode is off and the swarm board has no cards.", "info");
			return;
		}
		ctx.ui.notify(formatBoard(board), "info");
		return;
	}
	if (rest === "clear") {
		const { removed } = pruneSettled(sessionId);
		if (removed === 0) {
			ctx.ui.notify("No settled cards to clear.", "info");
			return;
		}
		ctx.ui.notify(`Cleared ${removed} settled ${removed === 1 ? "card" : "cards"}.`, "info");
		return;
	}
	ctx.ui.notify(USAGE, "warning");
}

/**
 * `/swarm`, on by default in fresh sessions: the session coordinates background agents and stays free for its user and
 * relay messages, published in the session modes registry for relay. Goes in the `<swarm>` system prompt section from a
 * session's start, or by hidden per-run messages after it so the cached prefix holds. Returns whether swarm mode applies
 * to a context's session and branch.
 */
export function registerSwarm(pi: ExtensionAPI): (ctx: ExtensionContext) => boolean {
	/** The configured default, read at each session start and before a session's first run. */
	let configured = false;
	let currentCtx: ExtensionContext | undefined;
	const refreshDefault = async () => { configured = await readDefault(); };

	/** Swarm mode's state on the current branch. */
	function readBranch(ctx: ExtensionContext): SwarmState {
		let pin: boolean | undefined;
		let active: boolean | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== NAME) continue;
			const data = entry.data as SwarmEntry;
			if ("base" in data) pin = data.base;
			else active = data.active;
		}
		// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
		const base = pin ?? ctx.sessionManager.getEntries().find(isPin)?.data?.base;
		// Before the first run, a fresh session follows the default, and a session with earlier conversation stays off.
		const unpinned = () => configured && !ctx.sessionManager.getEntries().some(isConversation);
		return { base, pinned: pin !== undefined, active: active ?? base ?? unpinned() };
	}

	function setStatus(ctx: ExtensionContext, active: boolean): void {
		try { ctx.ui.setStatus(NAME, formatSwarmStatus(ctx.sessionManager.getSessionId(), active)); } catch {}
	}

	function writePin({ base, active }: SwarmState, ctx: ExtensionContext): void {
		// The pin holds across the session, so conversation on any branch counts: such a prefix may be cached and never gains a section.
		const pinned = base ?? (active && !ctx.sessionManager.getEntries().some(isConversation));
		pi.appendEntry<SwarmEntry>(NAME, { base: pinned });
	}

	const onBoard = (board: SwarmBoard) => {
		if (!currentCtx) return;
		try {
			if (board.sessionId !== currentCtx.sessionManager.getSessionId()) return;
			const { active } = readBranch(currentCtx);
			if (!active) return;
			setStatus(currentCtx, active);
		} catch {}
	};

	function applyState(ctx: ExtensionContext, active: boolean): void {
		currentCtx = ctx;
		setStatus(ctx, active);
		publish(ctx.sessionManager.getSessionId(), active);
		swarmBoards().listeners.add(onBoard);
	}

	function showBranch(ctx: ExtensionContext): void {
		applyState(ctx, readBranch(ctx).active);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!isCoordinator(ctx)) return;
		await refreshDefault();
		showBranch(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => { if (isCoordinator(ctx)) showBranch(ctx); });

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isCoordinator(ctx)) return undefined;
		if (readBranch(ctx).base === undefined) await refreshDefault();
		let state = readBranch(ctx);
		if (!state.pinned) {
			writePin(state, ctx);
			state = readBranch(ctx);
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections[NAME] = SECTION_TEXT;
		const base = state.base ?? false;
		const seen = readSeen(ctx, base);
		// Sent once, and again only after a compaction or `/tree` takes it out of what the model sees: each copy stays in the context.
		// Without a projection, repeated while the switch differs from the section, so a compaction cannot drop it for long.
		const send = seen === undefined ? state.active !== base || readTold(ctx, base) !== state.active : seen !== state.active;
		if (send) return hidden(state.active ? ON_TEXT : OFF_TEXT);
		return undefined;
	});

	// Only eligible sessions are ever published, so any other has nothing to remove.
	pi.on("session_shutdown", async (_event, ctx) => {
		swarmBoards().listeners.delete(onBoard);
		currentCtx = undefined;
		publish(ctx.sessionManager.getSessionId(), false);
	});

	pi.registerCommand(NAME, {
		description: "Toggle swarm mode 🐝, background agents so the session keeps answering: /swarm [on | off | status | board [clear] | default [on | off]]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: NAME, kind: "extension", extension: "delegation" });
			if (!isCoordinator(ctx)) {
				ctx.ui.notify(`/${NAME} works only in top-level TUI and RPC sessions.`, "warning");
				return;
			}
			const action = args.trim().toLowerCase().replace(/\s+/g, " ");
			if (action === "default" || action.startsWith("default ")) {
				const value = action.slice("default".length).trim();
				if (value === "") {
					const on = await readDefault(ctx);
					ctx.ui.notify(`Default for new sessions: ${on ? "on" : "off"}.`, "info");
					return;
				}
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(USAGE, "warning");
					return;
				}
				await writeDefault(value === "on");
				configured = value === "on";
				// A session before its first run follows the new default unless switched.
				showBranch(ctx);
				ctx.ui.notify(`Default for new sessions: ${value}. Sessions that have had a first run keep their ${NAME} setting.`, "info");
				return;
			}
			const { active } = readBranch(ctx);
			if (action === "status") {
				ctx.ui.notify(active ? NOTES.isOn : NOTES.isOff, "info");
				return;
			}
			if (action === "board" || action.startsWith("board ")) {
				handleBoard(action.slice("board".length).trim(), ctx, active);
				return;
			}
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const next = action === "" ? !active : action === "on";
			if (next !== active) pi.appendEntry<SwarmEntry>(NAME, { active: next });
			applyState(ctx, next);
			if (next === active) ctx.ui.notify(next ? NOTES.alreadyOn : NOTES.alreadyOff, "info");
			else ctx.ui.notify(next ? NOTES.on : NOTES.off, "info");
		},
	});

	return (ctx) => isCoordinator(ctx) && readBranch(ctx).active;
}
