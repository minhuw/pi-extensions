/**
 * The agent rail's menus, as data: what each kind of row offers (an agent, a project card, a node, the "+" button),
 * enabled or disabled with a reason. The rail draws them with the shared menu (`deck/Menu.tsx`).
 *
 * The items follow Orca's worktree and host menus and T3 Code's thread menu (both MIT; see ORCA-LICENSE and
 * T3-LICENSE): Orca's "Mark Read" / "Mark Unread", "Copy Path", and removing a project from the app rather than from
 * disk; T3's "Rename", "Mark unread", and "Copy path" / "Copy thread id". Destructive items are last and red.
 */
import type { MenuEntry } from "../deck/Menu";
import { actionShortcut } from "../keys";
import type { Section } from "./inbox";

/** Why an item that needs a newer daemon is disabled. */
export const updateNode = (node: string): string => `Update pika-node on ${node} to use this`;
export const NOT_CONNECTED = "The node is not connected";

type Item = Exclude<MenuEntry, "separator">;
const item = (id: string, label: string, run: () => void, options: Partial<Pick<Item, "disabled" | "detail" | "danger" | "shortcut">> = {}): Item => ({ id, label, run, ...options });
/** Disabled with `reason` when there is one. */
const unless = (reason: string | undefined): Partial<Item> => (reason ? { disabled: true, detail: reason } : {});

const shortcut = (action: "rail.rename" | "rail.remove"): Partial<Item> => {
	const text = actionShortcut(action);
	return text ? { shortcut: text } : {};
};

/** Separators between non-empty groups only. */
function groups(...parts: (Item | false | undefined)[][]): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const part of parts) {
		const items = part.filter((entry): entry is Item => Boolean(entry));
		if (items.length === 0) continue;
		if (out.length) out.push("separator");
		out.push(...items);
	}
	return out;
}

// --- An agent row ---------------------------------------------------------------------------------------------------

export interface AgentMenuState {
	nodeName: string;
	exited: boolean;
	/** Its pane is in a workspace (so it can be split or closed). */
	hasPane: boolean;
	unread: boolean;
	section: Section;
	sessionId?: string;
	/** The node is connected (requests can go). */
	connected: boolean;
	canRename: boolean;
	canUnread: boolean;
}

export interface AgentMenuActions {
	focus: () => void;
	rename: () => void;
	markRead: () => void;
	markUnread: () => void;
	split: (direction: "row" | "column") => void;
	restart: () => void;
	copyCwd: () => void;
	copySessionId: () => void;
	closePane: () => void;
	kill: () => void;
	remove: () => void;
}

/** Kill asks first only while the agent is working or waiting for the user: then something would be lost. */
export const killNeedsConfirm = (section: Section): boolean => section === "working" || section === "needs";

export function agentMenu(state: AgentMenuState, run: AgentMenuActions): MenuEntry[] {
	const offline = state.connected ? undefined : NOT_CONNECTED;
	const live = !state.exited;
	return groups(
		[
			item("focus", "Focus", run.focus),
			item("rename", "Rename…", run.rename, unless(offline ?? (state.canRename ? undefined : updateNode(state.nodeName)))),
			state.unread
				? item("mark-read", "Mark as Read", run.markRead, unless(offline))
				: live && item("mark-unread", "Mark as Unread", run.markUnread, unless(offline ?? (state.canUnread ? undefined : updateNode(state.nodeName)))),
		],
		[
			live && state.hasPane && item("split-right", "Split Right", () => run.split("row"), unless(offline)),
			live && state.hasPane && item("split-down", "Split Down", () => run.split("column"), unless(offline)),
			state.exited && item("restart", "Restart", run.restart, unless(offline)),
		],
		[item("copy-cwd", "Copy Working Directory", run.copyCwd), state.sessionId !== undefined && item("copy-session", "Copy Session ID", run.copySessionId)],
		[
			live && state.hasPane && item("close-pane", "Close Pane", run.closePane, unless(offline)),
			live
				? item("kill", killNeedsConfirm(state.section) ? "Kill…" : "Kill", run.kill, { danger: true, ...unless(offline) })
				: item("remove", "Remove", run.remove, { danger: true, ...unless(offline) }),
		],
	);
}

// --- A project card -------------------------------------------------------------------------------------------------

export interface ProjectMenuState {
	nodeName: string;
	/** The node's "Other" card: terminals in no project, started in the home directory. */
	other: boolean;
	/** A linked git worktree: it is removed with git, not just from Deck. */
	worktree: boolean;
	folded: boolean;
	connected: boolean;
	canEdit: boolean;
	canWorktree: boolean;
}

export interface ProjectMenuActions {
	newTerminal: () => void;
	newAgent: () => void;
	newWorktree: () => void;
	reveal: () => void;
	copyPath: () => void;
	rename: () => void;
	fold: () => void;
	remove: () => void;
	removeWorktree: () => void;
}

export function projectMenu(state: ProjectMenuState, run: ProjectMenuActions): MenuEntry[] {
	const offline = state.connected ? undefined : NOT_CONNECTED;
	const edit = offline ?? (state.canEdit ? undefined : updateNode(state.nodeName));
	return groups(
		[
			item("new-terminal", state.other ? "New Terminal in Home" : "New Terminal", run.newTerminal, unless(offline)),
			item("new-agent", "New pi Agent", run.newAgent, unless(offline)),
			!state.other && item("new-worktree", "New Worktree…", run.newWorktree, unless(offline ?? (state.canWorktree ? undefined : updateNode(state.nodeName)))),
		],
		[!state.other && item("reveal", "Reveal in Explorer", run.reveal, unless(offline)), !state.other && item("copy-path", "Copy Path", run.copyPath)],
		[!state.other && item("rename", "Rename…", run.rename, { ...unless(edit), ...shortcut("rail.rename") }), item("fold", state.folded ? "Expand" : "Collapse", run.fold)],
		[
			!state.other &&
				(state.worktree
					? item("remove-worktree", "Remove Worktree…", run.removeWorktree, { danger: true, ...unless(offline ?? (state.canWorktree ? undefined : updateNode(state.nodeName))) })
					: item("remove", "Remove from Deck", run.remove, { danger: true, ...shortcut("rail.remove"), ...unless(edit) })),
		],
	);
}

// --- A node ---------------------------------------------------------------------------------------------------------

export interface NodeMenuState {
	nodeName: string;
	connected: boolean;
	canEdit: boolean;
	/** The pinned key's fingerprint, when this browser pinned one. */
	fingerprint?: string;
	pinned: boolean;
	/** Folding applies (the Projects view). */
	foldable: boolean;
	folded: boolean;
}

export interface NodeMenuActions {
	newTerminal: () => void;
	addProject: () => void;
	copyFingerprint: () => void;
	repair: () => void;
	fold: () => void;
}

export function nodeMenu(state: NodeMenuState, run: NodeMenuActions): MenuEntry[] {
	const offline = state.connected ? undefined : NOT_CONNECTED;
	return groups(
		[
			item("new-terminal", "New Terminal in Home", run.newTerminal, unless(offline)),
			item("add-project", "Add Project…", run.addProject, unless(offline ?? (state.canEdit ? undefined : updateNode(state.nodeName)))),
		],
		[
			item("copy-fingerprint", "Copy Node Fingerprint", run.copyFingerprint, unless(state.fingerprint ? undefined : "This browser has not pinned the node's key")),
			state.pinned && item("repair", "Re-pair…", run.repair, { danger: true }),
		],
		[state.foldable && item("fold", state.folded ? "Expand" : "Collapse", run.fold)],
	);
}

// --- The rail's "+" -------------------------------------------------------------------------------------------------

export interface AddMenuState {
	/** The node on screen, when there is one; its name for reasons. */
	nodeName?: string;
	connected: boolean;
	/** The project on screen is a real project (not "Other"), for a worktree. */
	inProject: boolean;
	canEdit: boolean;
	canWorktree: boolean;
}

export interface AddMenuActions {
	newTerminal: () => void;
	newAgent: () => void;
	addProject: () => void;
	newWorktree: () => void;
}

export function addMenu(state: AddMenuState, run: AddMenuActions): MenuEntry[] {
	const none = state.nodeName === undefined ? "Pick a node first" : state.connected ? undefined : NOT_CONNECTED;
	const name = state.nodeName ?? "the node";
	return groups(
		[item("new-terminal", "New Terminal", run.newTerminal, unless(none)), item("new-agent", "New pi Agent", run.newAgent, unless(none))],
		[
			item("add-project", "Add Project…", run.addProject, unless(none ?? (state.canEdit ? undefined : updateNode(name)))),
			item("new-worktree", "New Worktree…", run.newWorktree, unless(none ?? (!state.inProject ? "Open a project first" : state.canWorktree ? undefined : updateNode(name)))),
		],
	);
}
