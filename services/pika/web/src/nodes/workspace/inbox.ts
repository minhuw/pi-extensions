import { liveBridge, type NodeView } from "../client";
import { sanitize, type Activity, type TerminalInfo } from "../contract";

/**
 * The agent rail's inbox: every agent on every node, sorted into sections by what the user has to do about it, the
 * ones that need them on top. The sections follow T3 Code's thread inbox (`packages/client-runtime/src/state/
 * threadInbox.ts`) and Orca's attention order (`shared/sidebar-list/smart-attention.ts`): needs you, failed, done
 * (unread), working, quiet.
 */
export type Section = "needs" | "failed" | "done" | "working" | "quiet";

export const SECTIONS: readonly Section[] = ["needs", "failed", "done", "working", "quiet"];

export const SECTION_LABELS: Record<Section, string> = {
	needs: "Needs you",
	failed: "Failed",
	done: "Done",
	working: "Working",
	quiet: "Quiet",
};

/**
 * How long an agent that stopped working still reads as working: pi idles for a moment between a turn and its retry,
 * compaction, or queued message (T3's `WORKING_EXIT_GRACE_MS`).
 */
export const WORKING_EXIT_GRACE_MS = 2_000;

/** A working agent whose status has not changed for this long looks stale (Orca's `agent-status-freshness.ts`). */
export const STALE_MS = 30 * 60_000;

/** The section a terminal's own status puts it in, before the grace and the holds. */
export function rawSection(terminal: TerminalInfo): Section {
	if (terminal.exited) return terminal.exited.code !== null && terminal.exited.code !== 0 ? "failed" : "quiet";
	const status = terminal.status;
	if (status?.state === "waiting") return "needs";
	if (status?.program?.state === "error") return "failed";
	if (status?.state === "busy") return "working";
	if (status?.unread) return "done";
	return "quiet";
}

/** When the node last reported a change of this terminal's status, as far as the status says (node clock). */
function reportedAt(terminal: TerminalInfo): number | undefined {
	const times = [terminal.status?.program?.at, terminal.status?.bridge?.updatedAt].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return times.length ? Math.max(...times) : undefined;
}

/** What of a status counts as a change, for staleness: not the bridge's `updatedAt` alone. */
function signature(terminal: TerminalInfo): string {
	const status = terminal.status;
	const bridge = liveBridge(status);
	return JSON.stringify([
		terminal.exited ?? null,
		status?.state,
		status?.unread,
		status?.program?.state,
		status?.program?.kind,
		status?.program?.message,
		status?.program?.at,
		bridge?.state,
		bridge?.activityCount,
		bridge?.activities.map((activity) => [activity.id, activity.state, activity.progress?.completed]),
	]);
}

export interface InboxEntry {
	/** `node\nterminalId`. */
	key: string;
	terminal: TerminalInfo;
}

export interface Placement {
	section: Section;
	/** When the agent entered `section`: when it came back to the user, or started working (page clock). */
	since: number;
	/** When its status last changed (page clock). */
	changedAt: number;
	/** Kept in `section` by the exit grace or the selection hold, not by its own status. */
	held: boolean;
	/** Working, with no change for `STALE_MS`. */
	stale: boolean;
}

interface Tracked {
	section: Section;
	since: number;
	changedAt: number;
	signature: string;
	/** The end of the working exit grace, while one runs. */
	deadline: number | null;
}

export interface Observed {
	placements: ReadonlyMap<string, Placement>;
	/** When an exit grace ends and the inbox must be observed again; undefined when none runs. */
	nextAt: number | undefined;
}

/**
 * Places each agent in its section, remembering across calls what it can only learn by watching: when an agent came
 * back to the user, how long it has worked, and the 2 s exit grace. Observe it with the whole list on every change
 * and at `nextAt`; `selected` is the agent on screen, which a seen "done" leaves only when the user moves away.
 */
export class InboxTracker {
	#tracked = new Map<string, Tracked>();

	observe(entries: readonly InboxEntry[], now: number, selected?: string): Observed {
		const present = new Set<string>();
		const placements = new Map<string, Placement>();
		let nextAt: number | undefined;
		for (const { key, terminal } of entries) {
			present.add(key);
			const previous = this.#tracked.get(key);
			const raw = rawSection(terminal);
			const sig = signature(terminal);
			// First sight: the status's own time, so a page opened late still shows how long ago things happened.
			const first = Math.min(now, reportedAt(terminal) ?? terminal.createdAt);
			const changedAt = !previous ? first : previous.signature === sig ? previous.changedAt : now;
			let section = raw;
			let held = false;
			let deadline: number | null = null;
			if (previous && previous.section === "working" && (raw === "done" || raw === "quiet") && !terminal.exited) {
				// Only the shelf is held, and only towards done or quiet: needing the user or failing shows at once.
				deadline = previous.deadline ?? now + WORKING_EXIT_GRACE_MS;
				if (deadline > now) {
					section = "working";
					held = true;
					nextAt = Math.min(nextAt ?? deadline, deadline);
				} else deadline = null;
			}
			if (key === selected && previous && previous.section === "done" && section === "quiet") {
				// Seen by opening it: it stays where the user found it until they move to another agent.
				section = "done";
				held = true;
			}
			const since = !previous ? first : previous.section === section ? previous.since : now;
			this.#tracked.set(key, { section, since, changedAt, signature: sig, deadline: section === "working" ? deadline : null });
			placements.set(key, { section, since, changedAt, held, stale: section === "working" && !held && now - changedAt >= STALE_MS });
		}
		for (const key of this.#tracked.keys()) if (!present.has(key)) this.#tracked.delete(key);
		return { placements, nextAt };
	}
}

export type InboxLayout = Record<Section, string[]>;

export const emptyLayout = (): InboxLayout => ({ needs: [], failed: [], done: [], working: [], quiet: [] });

/**
 * The order within each section: the newest return to the user first (T3's `sortInboxThreadsByReturn`), working in
 * the order the terminals were created, so a working list does not shuffle as agents take turns.
 */
export function layoutInbox(entries: readonly InboxEntry[], placements: ReadonlyMap<string, Placement>): InboxLayout {
	const layout = emptyLayout();
	const created = new Map(entries.map((entry) => [entry.key, entry.terminal.createdAt]));
	for (const { key } of entries) {
		const placement = placements.get(key);
		if (placement) layout[placement.section].push(key);
	}
	for (const section of SECTIONS) {
		layout[section].sort((left, right) => {
			const a = placements.get(left)!;
			const b = placements.get(right)!;
			const order = section === "working" ? created.get(left)! - created.get(right)! : b.since - a.since;
			return order || left.localeCompare(right);
		});
	}
	return layout;
}

/**
 * `next` with every row that `previous` placed kept in its place: while the pointer is over the list, no row moves
 * under it. Rows that are gone leave; new rows join the end of their section.
 */
export function holdLayout(previous: InboxLayout, next: InboxLayout): InboxLayout {
	const present = new Set(SECTIONS.flatMap((section) => next[section]));
	const out = emptyLayout();
	const placed = new Set<string>();
	for (const section of SECTIONS) {
		for (const key of previous[section]) {
			if (!present.has(key) || placed.has(key)) continue;
			out[section].push(key);
			placed.add(key);
		}
	}
	for (const section of SECTIONS) for (const key of next[section]) if (!placed.has(key)) out[section].push(key);
	return out;
}

/** The rows in the rail's reading order. */
export const flatLayout = (layout: InboxLayout): string[] => SECTIONS.flatMap((section) => layout[section]);

export const inboxKey = (node: string, terminalId: string): string => `${node}\n${terminalId}`;

export function splitKey(key: string): { node: string; terminalId: string } {
	const at = key.indexOf("\n");
	return { node: key.slice(0, at), terminalId: key.slice(at + 1) };
}

/** The key after (or before) `current` in `order`, wrapping; from none, the first (or last). */
export function stepKey(order: readonly string[], current: string | undefined, step: 1 | -1): string | undefined {
	if (order.length === 0) return undefined;
	const at = current === undefined ? -1 : order.indexOf(current);
	if (at < 0) return step === 1 ? order[0] : order.at(-1);
	return order[(at + step + order.length) % order.length];
}

/** The next agent needing the user after `current`, wrapping; undefined when no other one does. */
export function nextNeeding(layout: InboxLayout, current: string | undefined): string | undefined {
	const order = flatLayout(layout);
	const needing = new Set(layout.needs);
	const at = current === undefined ? -1 : order.indexOf(current);
	for (let offset = 1; offset <= order.length; offset++) {
		const key = order[(at + offset + order.length) % order.length]!;
		if (needing.has(key) && key !== current) return key;
	}
	return undefined;
}

// --- Time ---------------------------------------------------------------------------------------------------------

/**
 * A compact age: now, 5m, 3h, 2d. From Orca, `src/renderer/src/lib/time-format/short-time-ago.ts` (MIT © 2026
 * Lovecast Inc.).
 */
export function shortAgo(at: number, now: number): string {
	const delta = now - at;
	if (delta < 60_000) return "now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** A ticking duration: 14s, 2m14s, 1h05m, 2d3h. */
export function elapsed(from: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - from) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** How long the rail's clock may wait before a row's time reads differently. */
export function clockInterval(layout: InboxLayout): number {
	return layout.working.length > 0 ? 1_000 : 30_000;
}

// --- What a row says ----------------------------------------------------------------------------------------------

/** What a waiting agent asks for, from the dialog's kind or the activity that waits. */
export function needKind(terminal: TerminalInfo): "permission" | "question" | "auth" {
	return terminal.status?.program?.kind ?? "question";
}

export const NEED_LABELS = { permission: "Permission", question: "Question", auth: "Login" } as const;

/**
 * The line under a row's name that says what the user is to do, when there is something: a waiting dialog's message
 * or activity, a failure, or how long a working agent has been silent. Orca's priority (`worktree-card-compact-agent-
 * row.tsx`): attention text, then staleness.
 */
export function attentionText(terminal: TerminalInfo, placement: Placement, now: number): string | undefined {
	const status = terminal.status;
	if (placement.section === "needs") {
		const message = sanitize(status?.program?.message);
		if (message && status?.program?.state === "blocked") return message;
		const activity = liveBridge(status)?.activities.find((item) => item.state === "waiting");
		if (activity) return `${sanitize(activity.label)} is waiting`;
		return message || undefined;
	}
	if (placement.section === "failed") {
		if (terminal.exited) return terminal.exited.code !== null ? `Exited with code ${terminal.exited.code}` : undefined;
		return sanitize(status?.program?.message) || "pi reported an error";
	}
	if (placement.stale) return `No update in ${shortAgo(placement.changedAt, now)}`;
	return undefined;
}

/** The background activities shown under a row: the live bridge's, waiting ones first. */
export function childActivities(terminal: TerminalInfo): Activity[] {
	if (terminal.exited) return [];
	const activities = liveBridge(terminal.status)?.activities ?? [];
	return [...activities.filter((item) => item.state === "waiting"), ...activities.filter((item) => item.state !== "waiting")];
}

// --- Nodes --------------------------------------------------------------------------------------------------------

export type NodeLinkState = "online" | "connecting" | "offline" | "error" | "unpaired";

/** A node's state as the rail marks it (Orca's `HostSectionHeader`: spinner, alert, server-off). */
export function nodeLinkState(view: NodeView): NodeLinkState {
	const link = view.link;
	if (link.kind === "ready") return "online";
	if (!view.info.online) return view.pin ? "offline" : "unpaired";
	if (!view.pin) return "unpaired";
	if (link.kind === "opening" || link.kind === "handshaking" || link.kind === "idle") return "connecting";
	if ((link.kind === "closed" || link.kind === "refused") && ["disconnected", "node_offline", "client_gone"].includes(link.code)) return "connecting";
	return "error";
}

export const NODE_STATE_LABELS: Record<NodeLinkState, string> = {
	online: "Online",
	connecting: "Connecting",
	offline: "Offline",
	error: "Needs attention",
	unpaired: "Not paired",
};

/** The rail's badge when it is hidden, and the tab title: what needs the user, else what works (Orca's activity badge). */
export function inboxBadge(layout: InboxLayout): { kind: "attention" | "working"; count: number } | undefined {
	const attention = layout.needs.length + layout.failed.length;
	if (attention > 0) return { kind: "attention", count: attention };
	if (layout.working.length > 0) return { kind: "working", count: layout.working.length };
	return undefined;
}
