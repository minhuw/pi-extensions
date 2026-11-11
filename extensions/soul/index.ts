import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type CustomEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

const ENTRY = "soul";
export const SESSION_LINK_TYPE = "pi-extensions.session-link";
export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const SOUL_SHARED_KEY = Symbol.for("pi-extensions.soul");
const LOAD_PROBE_EVENT = "pi-extensions.soul.load-probe";

export const SOUL_PRINCIPLES = [
	"- Fail fast and loud: ship the simplest working slice to test assumptions early. Never hide bugs behind silent fallbacks, speculative abstractions, or swallowed errors—let broken invariants fail immediately where they happen, and keep changes small and easy to fix or revert.",
	"- Do the hard work; cut zero-information words: trace root causes and solve the real problem instead of papering over symptoms. State concrete, falsifiable claims backed by code, output, or measurements; omit truisms, filler caveats, and statements whose negation would be absurd.",
	"- Stand on evidence, not sycophancy: never flatter the user or agree just to be agreeable. Push back directly when a premise or plan contradicts the codebase, data, or logic, and do not flip your position under pushback unless new evidence or an explicit tradeoff decision warrants it.",
].join("\n");

export const ON_PREFIX = "Soul principles are on";
export const OFF_PREFIX = "Soul principles are off";
export const SECTION_TEXT = `Core development principles (a later soul message overrides this):\n${SOUL_PRINCIPLES}`;
export const ON_TEXT = `${ON_PREFIX}:\n${SOUL_PRINCIPLES}`;
export const OFF_TEXT = `${OFF_PREFIX}. Ignore earlier soul instructions for the rest of this branch unless turned back on.`;

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

export interface SoulSharedState {
	openInstances: Set<object>;
	ownerBySession: Map<string, object>;
	topLevelSessions: Set<string>;
	activeBySession: Map<string, boolean>;
	sessionByFile: Map<string, string>;
	parentBySession: Map<string, string>;
	hook?: ChildSessionHook;
}

interface SessionLinkData {
	kind?: unknown;
	agentType?: unknown;
	description?: unknown;
	parentSessionId?: unknown;
	parentSessionFile?: unknown;
}

type SoulPin = { base: boolean; fallback?: boolean };
/** The pin, written once at a branch's first run, or a switch (`null` resets to the session's default). */
type SoulEntry = SoulPin | { active: boolean | null };

interface SoulBranchState {
	/** Whether `<soul>` is in the session's system prompt; undefined until the session's first run. */
	base: boolean | undefined;
	/** Default for a pre-existing session that can never gain a system prompt section. */
	fallback: boolean | undefined;
	/** Whether the current branch holds the pin (`/tree` can land before it). */
	pinned: boolean;
	/** Latest unreset switch on the branch, if any. */
	explicitActive: boolean | undefined;
}

const boundApis = new WeakSet<ExtensionAPI>();

const configPath = () => join(getAgentDir(), "soul.json");
const hidden = (content: string) => ({ message: { customType: ENTRY, content, display: false } });
const isPin = (entry: SessionEntry): entry is CustomEntry<SoulPin> =>
	entry.type === "custom" && entry.customType === ENTRY && typeof (entry.data as Partial<SoulPin> | undefined)?.base === "boolean";
const sessionDefault = ({ base, fallback }: Pick<SoulBranchState, "base" | "fallback">): boolean | undefined =>
	base === undefined ? undefined : (fallback ?? base);
const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

function getSharedState(): SoulSharedState {
	const g = globalThis as Record<symbol, unknown>;
	let state = g[SOUL_SHARED_KEY] as SoulSharedState | undefined;
	if (!state) {
		state = {
			openInstances: new Set<object>(),
			ownerBySession: new Map<string, object>(),
			topLevelSessions: new Set<string>(),
			activeBySession: new Map<string, boolean>(),
			sessionByFile: new Map<string, string>(),
			parentBySession: new Map<string, string>(),
		};
		g[SOUL_SHARED_KEY] = state;
	}
	return state;
}

function getChildHooksSet(): Set<ChildSessionHook> {
	const g = globalThis as Record<symbol, unknown>;
	let hooks = g[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
	if (!(hooks instanceof Set)) {
		hooks = new Set<ChildSessionHook>();
		g[CHILD_SESSION_HOOKS] = hooks;
	}
	return hooks;
}

function syncChildSessionHook(): void {
	const state = getSharedState();
	state.hook ??= { name: ENTRY, extensionFactory: soulExtension };
	const hooks = getChildHooksSet();
	for (const item of [...hooks]) {
		if (item.name === ENTRY && item !== state.hook) hooks.delete(item);
	}
	if (state.openInstances.size > 0) hooks.add(state.hook);
	else hooks.delete(state.hook);
}

function sessionLinks(ctx: ExtensionContext): SessionLinkData[] {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	const links: SessionLinkData[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === SESSION_LINK_TYPE && entry.data && typeof entry.data === "object") {
			links.push(entry.data as SessionLinkData);
		}
	}
	return links;
}

/**
 * Internal helper sessions that must keep their exact prompt untouched:
 * - `memory-dream`: pika's background memory consolidation session with its own fixed prompt contract.
 * - `@mention clone`: Subagents' one-turn router clone that reuses the parent's rendered prompt and branch verbatim.
 */
function isExcludedHelperChild(ctx: ExtensionContext): boolean {
	return sessionLinks(ctx).some((link) => link.agentType === "memory-dream" || link.description === "@mention clone");
}

/** Top-level TUI and RPC sessions (never linked children, even if bound with a UI context). */
export function isTopLevelSession(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return sessionLinks(ctx).length === 0;
}

function directParentIds(ctx: ExtensionContext, allowHeaderParent: boolean): string[] {
	const state = getSharedState();
	const parents = new Set<string>();
	for (const link of sessionLinks(ctx)) {
		if (typeof link.parentSessionId === "string" && link.parentSessionId) {
			parents.add(link.parentSessionId);
		}
		if (typeof link.parentSessionFile === "string" && link.parentSessionFile) {
			const mapped = state.sessionByFile.get(link.parentSessionFile);
			if (mapped) parents.add(mapped);
		}
	}
	if (allowHeaderParent) {
		const headerParent = ctx.sessionManager?.getHeader?.()?.parentSession;
		if (typeof headerParent === "string" && headerParent) {
			if (state.activeBySession.has(headerParent)) parents.add(headerParent);
			const mapped = state.sessionByFile.get(headerParent);
			if (mapped) parents.add(mapped);
		}
	}
	return [...parents];
}

/**
 * Whether `ctx` is a delegated child session rather than a top-level session:
 * persisted Subagents and Herder steps carry a `pi-extensions.session-link` entry; unlinked in-memory
 * children bind without `tui`/`rpc` while a parent session is open in this process.
 */
export function isChildSession(ctx: ExtensionContext): boolean {
	if (sessionLinks(ctx).length > 0) return true;
	if (ctx.mode === "tui" || ctx.mode === "rpc") return false;
	if (directParentIds(ctx, true).length > 0) return true;
	const selfId = ctx.sessionManager?.getSessionId?.();
	const topLevel = getSharedState().topLevelSessions;
	return [...topLevel].some((id) => id !== selfId);
}

/** Walk the parent chain to inherit the active `soul` state of the spawning session, if known in this process. */
function resolveInheritedActive(ctx: ExtensionContext): boolean | undefined {
	const state = getSharedState();
	const selfId = ctx.sessionManager?.getSessionId?.();
	const visited = new Set<string>(selfId ? [selfId] : []);
	const queue = directParentIds(ctx, true);

	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const active = state.activeBySession.get(id);
		if (active !== undefined) return active;
		const nextParent = state.parentBySession.get(id);
		if (nextParent && !visited.has(nextParent)) queue.push(nextParent);
	}

	// Unlinked in-memory child spawned while top-level sessions are open (e.g. an in-memory step runner):
	// inherit when all open top-level sessions agree on their active state.
	const candidates = [...state.topLevelSessions]
		.filter((id) => id !== selfId)
		.map((id) => state.activeBySession.get(id))
		.filter((value): value is boolean => value !== undefined);
	if (candidates.length > 0 && candidates.every((value) => value === candidates[0])) {
		return candidates[0];
	}
	return undefined;
}

function recordSessionState(ctx: ExtensionContext, active: boolean, child: boolean, owner: object): void {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (!sessionId) return;
	const state = getSharedState();
	state.ownerBySession.set(sessionId, owner);
	state.activeBySession.set(sessionId, active);
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionFile) state.sessionByFile.set(sessionFile, sessionId);
	if (child) {
		const [parentId] = directParentIds(ctx, true);
		if (parentId) state.parentBySession.set(sessionId, parentId);
	} else if (isTopLevelSession(ctx)) {
		state.topLevelSessions.add(sessionId);
	}
}

function clearSessionState(ctx: ExtensionContext, owner: object): void {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (!sessionId) return;
	const state = getSharedState();
	if (state.ownerBySession.get(sessionId) !== owner) return;
	state.ownerBySession.delete(sessionId);
	state.topLevelSessions.delete(sessionId);
	state.activeBySession.delete(sessionId);
	state.parentBySession.delete(sessionId);
	for (const [file, id] of state.sessionByFile) {
		if (id === sessionId) state.sessionByFile.delete(file);
	}
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	try { ctx.ui?.notify?.(message, type); } catch {}
}

/** The default for new sessions (`true` when unconfigured). Invalid files warn and fall back to `true`. */
async function readDefault(ctx?: ExtensionContext, warn = false): Promise<boolean> {
	const path = configPath();
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { default?: unknown } | null;
		if (typeof parsed?.default === "boolean") return parsed.default;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
	}
	if (warn && ctx) {
		notify(ctx, `Ignoring ${path}: expected { "default": true } or { "default": false }. Using on.`, "warning");
	}
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

function readBranch(ctx: ExtensionContext): SoulBranchState {
	let branchPin: SoulPin | undefined;
	let explicitActive: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as SoulEntry;
		if ("base" in data) branchPin = data;
		else explicitActive = data.active ?? undefined;
	}
	// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
	const pin = branchPin ?? ctx.sessionManager.getEntries().find(isPin)?.data;
	return {
		base: pin?.base,
		fallback: pin?.fallback,
		pinned: branchPin !== undefined,
		explicitActive,
	};
}

const stateOf = (content: unknown): boolean | undefined =>
	typeof content !== "string" ? undefined
		: content.startsWith(ON_PREFIX) ? true : content.startsWith(OFF_PREFIX) ? false : undefined;

/**
 * What the model sees on the next request: the latest `soul` message in Pi's session projection, else `base`.
 * Compaction or context edits can drop an earlier switch message from the projection; undefined on Pi 1.3 and 1.4.
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

/** What the model was last told on the branch, whether compacted away or not (for Pi 1.3 and 1.4). */
function readTold(ctx: ExtensionContext, base: boolean): boolean {
	let told: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === ENTRY) told = stateOf(entry.content) ?? told;
	}
	return told ?? base;
}

function parseBoolArg(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	return undefined;
}

/**
 * `/soul`: core development principles, on by default in sessions and inherited by delegated subagents,
 * pinned in `<soul>` from a fresh session's start and switched by hidden messages thereafter so the prompt cache holds.
 */
export default function soulExtension(pi: ExtensionAPI): void {
	if (boundApis.has(pi)) return;
	boundApis.add(pi);

	// Deduplicate when a child session loads `soul` both by discovered path and via `CHILD_SESSION_HOOKS`.
	let inLoadPass = true;
	if (pi.events && typeof pi.events.emit === "function" && typeof pi.events.on === "function") {
		const probe = { alreadyLoaded: false };
		pi.events.emit(LOAD_PROBE_EVENT, probe);
		if (probe.alreadyLoaded) return;
		pi.events.on(LOAD_PROBE_EVENT, (data) => {
			if (inLoadPass && data && typeof data === "object") {
				(data as { alreadyLoaded: boolean }).alreadyLoaded = true;
			}
		});
	}

	const instanceToken = {};

	async function effectiveTopLevelActive(state: SoulBranchState, ctx: ExtensionContext, warnConfig = false): Promise<boolean> {
		if (state.explicitActive !== undefined) return state.explicitActive;
		const pinnedDefault = sessionDefault(state);
		if (pinnedDefault !== undefined) return pinnedDefault;
		return readDefault(ctx, warnConfig);
	}

	async function syncSession(_event: unknown, ctx: ExtensionContext, warnConfig = false): Promise<void> {
		if (isExcludedHelperChild(ctx)) return;
		const child = isChildSession(ctx);
		const state = readBranch(ctx);
		const active = child
			? (resolveInheritedActive(ctx) ?? sessionDefault(state) ?? await readDefault(ctx, false))
			: await effectiveTopLevelActive(state, ctx, warnConfig);
		recordSessionState(ctx, active, child, instanceToken);
	}

	function writePin(state: SoulBranchState, desiredDefault: boolean, desiredActive: boolean, ctx: ExtensionContext): void {
		if (state.base !== undefined) {
			pi.appendEntry<SoulEntry>(ENTRY, state.fallback !== undefined ? { base: state.base, fallback: state.fallback } : { base: state.base });
			return;
		}
		// A session with existing conversation may have its prefix cached already, so it never gains a `<soul>` section.
		if (!ctx.sessionManager.getEntries().some(isConversation)) {
			pi.appendEntry<SoulEntry>(ENTRY, { base: desiredActive });
			return;
		}
		pi.appendEntry<SoulEntry>(ENTRY, desiredDefault ? { base: false, fallback: true } : { base: false });
	}

	pi.on("session_start", async (event, ctx) => {
		inLoadPass = false;
		getSharedState().openInstances.add(instanceToken);
		syncChildSessionHook();
		await syncSession(event, ctx, isTopLevelSession(ctx));
	});

	pi.on("session_tree", async (event, ctx) => {
		await syncSession(event, ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const shared = getSharedState();
		shared.openInstances.delete(instanceToken);
		clearSessionState(ctx, instanceToken);
		syncChildSessionHook();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isExcludedHelperChild(ctx)) return undefined;
		// Guard against duplicating `<soul>` if a caller manually copied an already-rendered system prompt.
		if (event.systemPromptOptions.customPrompt?.includes("<soul>\n")) return undefined;

		const child = isChildSession(ctx);
		let state = readBranch(ctx);

		if (child) {
			const inherited = resolveInheritedActive(ctx);
			const active = inherited ?? sessionDefault(state) ?? await readDefault(ctx, false);
			if (!state.pinned) {
				writePin(state, active, active, ctx);
				state = readBranch(ctx);
			}
			recordSessionState(ctx, active, true, instanceToken);
			if (state.base) event.systemPromptOptions.sections.soul = SECTION_TEXT;
			const base = state.base ?? false;
			const seen = readSeen(ctx, base);
			const send = seen === undefined ? active !== base || readTold(ctx, base) !== active : seen !== active;
			return send ? hidden(active ? ON_TEXT : OFF_TEXT) : undefined;
		}

		// Standalone print/json sessions without a pin still honor the configured default; top-level UI sessions warn on bad config once.
		const configured = state.base === undefined ? await readDefault(ctx, false) : undefined;
		const desiredDefault = sessionDefault(state) ?? configured ?? true;
		const desiredActive = state.explicitActive ?? desiredDefault;
		if (!state.pinned) {
			writePin(state, desiredDefault, desiredActive, ctx);
			state = readBranch(ctx);
		}
		const active = state.explicitActive ?? sessionDefault(state) ?? false;
		recordSessionState(ctx, active, false, instanceToken);

		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections.soul = SECTION_TEXT;
		const base = state.base ?? false;
		const seen = readSeen(ctx, base);
		const send = seen === undefined ? active !== base || readTold(ctx, base) !== active : seen !== active;
		return send ? hidden(active ? ON_TEXT : OFF_TEXT) : undefined;
	});

	pi.registerCommand("soul", {
		description: "Toggle or configure core soul principles (inherited by subagents): /soul [on | off | reset | status | default [on | off]]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "soul", kind: "extension", extension: "soul" });
			if (!isTopLevelSession(ctx)) {
				notify(ctx, "/soul works only in top-level TUI and RPC sessions.", "warning");
				return;
			}
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			const defaultMatch = /^default(?:\s+([\s\S]+))?$/i.exec(trimmed);
			if (defaultMatch) {
				const raw = defaultMatch[1]?.trim();
				if (!raw) {
					const configured = await readDefault(ctx, true);
					notify(ctx, `Default for new sessions: ${configured ? "on" : "off"}.`);
					return;
				}
				const nextDefault = parseBoolArg(raw);
				if (nextDefault === undefined) {
					notify(ctx, "Usage: /soul default [on | off]", "warning");
					return;
				}
				await writeDefault(nextDefault);
				const updated = readBranch(ctx);
				const active = await effectiveTopLevelActive(updated, ctx, false);
				recordSessionState(ctx, active, false, instanceToken);
				notify(
					ctx,
					`Default for new sessions: ${nextDefault ? "on" : "off"}. Sessions that have had a first run keep their soul setting.`,
				);
				return;
			}

			const configured = await readDefault(ctx, true);
			const state = readBranch(ctx);
			const defaultActive = sessionDefault(state) ?? configured;
			const active = state.explicitActive ?? defaultActive;

			if (lower === "status") {
				const pinned = state.base === undefined ? "not pinned yet" : (sessionDefault(state) ? "on" : "off");
				notify(
					ctx,
					`Active soul: ${active ? "on" : "off"}\nSession default: ${pinned}\nDefault for new sessions: ${configured ? "on" : "off"}\nSubagents: inherit active session state`,
				);
				return;
			}

			if (lower === "reset") {
				if (state.explicitActive === undefined || (state.base !== undefined && active === defaultActive)) {
					notify(ctx, "No soul override is active.");
					return;
				}
				pi.appendEntry<SoulEntry>(ENTRY, { active: null });
				recordSessionState(ctx, defaultActive, false, instanceToken);
				notify(ctx, `Soul principles reset to ${defaultActive ? "on" : "off"}. Takes effect with the next prompt.`);
				return;
			}

			if (lower !== "" && lower !== "on" && lower !== "off") {
				notify(ctx, "Usage: /soul [on | off | reset | status | default [on | off]]", "warning");
				return;
			}

			const next = lower === "" ? !active : lower === "on";
			if (next === active) {
				notify(ctx, next ? "Soul principles are already on." : "Soul principles are already off.");
				return;
			}

			// Returning to the pinned session default records a reset (`active: null`) so `/soul status` and `/soul reset` stay clean.
			if (state.base !== undefined && next === defaultActive) {
				pi.appendEntry<SoulEntry>(ENTRY, { active: null });
			} else {
				pi.appendEntry<SoulEntry>(ENTRY, { active: next });
			}
			recordSessionState(ctx, next, false, instanceToken);
			notify(
				ctx,
				next
					? "Soul principles on (inherited by subagents). Takes effect with the next prompt."
					: "Soul principles off (including newly spawned subagents). Takes effect with the next prompt.",
			);
		},
	});
}
