/**
 * The agent rail's menus, as data: what each kind of row offers (an agent, a project card, a node, the "+" button).
 * The rail draws them with the shared menu (`deck/Menu.tsx`).
 *
 * The rules every builder keeps:
 * - A menu is never a list of disabled items. What cannot apply here is left out; a disabled item stays only when
 *   that teaches something (an older pika-node: "Update pika-node on mac to use this"), and its reason shows once,
 *   beside the menu while it is highlighted.
 * - A node that is not connected leaves out everything that needs it, and the menu says so once, in a note.
 *
 * The items follow Orca's worktree and host menus and T3 Code's thread menu (both MIT; see ORCA-LICENSE and
 * T3-LICENSE): Orca's "Mark Read" / "Mark Unread", "Copy Path", and removing a project from the app rather than from
 * disk; T3's "Rename", "Mark unread", and "Copy path" / "Copy thread id". Destructive items are last and red.
 */
import type { MenuEntry, MenuItem } from "../deck/Menu";
import { actionShortcut } from "../keys";
import type { Section } from "./inbox";

/** Why an item that needs a newer daemon is disabled. */
export const updateNode = (node: string): string => `Update pika-node on ${node} to use this`;
/** The one note a menu shows for a node that is not connected, in place of what needs it. */
export const notConnected = (node: string): string => `${node} is not connected`;

type Item = MenuItem;
type Options = Partial<Pick<Item, "disabled" | "reason" | "danger" | "shortcut" | "icon" | "hint" | "submenu">>;
const item = (id: string, label: string, run: () => void, options: Options = {}): Item => ({ id, label, run, ...options });
/** Disabled with `reason` when there is one: only for a reason that teaches (an older pika-node). */
const unless = (reason: string | undefined): Partial<Item> => (reason ? { disabled: true, reason } : {});
const note = (text: string): MenuEntry => ({ kind: "note", text });
const header = (label: string): MenuEntry => ({ kind: "header", label });

const shortcut = (action: "rail.rename" | "rail.remove" | "terminal.new"): Partial<Item> => {
	const text = actionShortcut(action);
	return text ? { shortcut: text } : {};
};

type Part = MenuEntry | false | undefined;
/** Separators between non-empty groups only. */
function groups(...parts: Part[][]): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const part of parts) {
		const entries = part.filter((entry): entry is MenuEntry => Boolean(entry));
		if (entries.length === 0) continue;
		if (out.length) out.push("separator");
		out.push(...entries);
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
	const on = state.connected;
	const live = !state.exited;
	const update = updateNode(state.nodeName);
	return groups(
		[
			item("focus", "Focus", run.focus, { icon: "terminal" }),
			on && item("rename", "Rename…", run.rename, { icon: "pencil", ...shortcut("rail.rename"), ...unless(state.canRename ? undefined : update) }),
			on &&
				(state.unread
					? item("mark-read", "Mark as Read", run.markRead, { icon: "check" })
					: live && item("mark-unread", "Mark as Unread", run.markUnread, { icon: "unread", ...unless(state.canUnread ? undefined : update) })),
		],
		[
			on && live && state.hasPane && item("split-right", "Split Right", () => run.split("row"), { icon: "split-right" }),
			on && live && state.hasPane && item("split-down", "Split Down", () => run.split("column"), { icon: "split-down" }),
			on && state.exited && item("restart", "Restart", run.restart, { icon: "restart" }),
		],
		[
			item("copy-cwd", "Copy Working Directory", run.copyCwd, { icon: "copy" }),
			state.sessionId !== undefined && item("copy-session", "Copy Session ID", run.copySessionId, { icon: "copy" }),
		],
		[
			on && live && state.hasPane && item("close-pane", "Close Pane", run.closePane, { icon: "close" }),
			on &&
				(live
					? item("kill", killNeedsConfirm(state.section) ? "Kill…" : "Kill", run.kill, { danger: true, icon: "kill" })
					: item("remove", "Remove", run.remove, { danger: true, icon: "trash" })),
		],
		[!on && note(notConnected(state.nodeName))],
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
	const on = state.connected;
	const project = !state.other;
	const update = updateNode(state.nodeName);
	const edit = state.canEdit ? undefined : update;
	const worktree = state.canWorktree ? undefined : update;
	return groups(
		[
			on && item("new-terminal", project ? "New Terminal" : "New Terminal in Home", run.newTerminal, { icon: "terminal" }),
			on && item("new-agent", "New pi Agent", run.newAgent, { icon: "agent" }),
			on && project && item("new-worktree", "New Worktree…", run.newWorktree, { icon: "branch", ...unless(worktree) }),
		],
		[on && project && item("reveal", "Reveal in Explorer", run.reveal, { icon: "reveal" }), project && item("copy-path", "Copy Path", run.copyPath, { icon: "copy" })],
		[
			on && project && item("rename", "Rename…", run.rename, { icon: "pencil", ...unless(edit), ...shortcut("rail.rename") }),
			item("fold", state.folded ? "Expand" : "Collapse", run.fold, { icon: "fold" }),
		],
		[
			on &&
				project &&
				(state.worktree
					? item("remove-worktree", "Remove Worktree…", run.removeWorktree, { danger: true, icon: "trash", ...unless(worktree) })
					: item("remove", "Remove from Deck", run.remove, { danger: true, icon: "close", ...shortcut("rail.remove"), ...unless(edit) })),
		],
		[!on && note(notConnected(state.nodeName))],
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
	const on = state.connected;
	return groups(
		[
			on && item("new-terminal", "New Terminal in Home", run.newTerminal, { icon: "terminal" }),
			on && item("add-project", "Add Project…", run.addProject, { icon: "folder", ...unless(state.canEdit ? undefined : updateNode(state.nodeName)) }),
		],
		[
			state.fingerprint !== undefined && item("copy-fingerprint", "Copy Node Fingerprint", run.copyFingerprint, { icon: "key" }),
			state.pinned && item("repair", "Re-pair…", run.repair, { danger: true, icon: "restart" }),
		],
		[state.foldable && item("fold", state.folded ? "Expand" : "Collapse", run.fold, { icon: "fold" })],
		[!on && note(notConnected(state.nodeName))],
	);
}

// --- The rail's "+" -------------------------------------------------------------------------------------------------

export interface AddMenuNode {
	id: string;
	name: string;
	canEdit: boolean;
	canWorktree: boolean;
}

export interface AddMenuState {
	/** The connected nodes, in the rail's order: the "+" makes things on these. */
	nodes: readonly AddMenuNode[];
	/** Paired nodes that are not connected now, by name. */
	offline: readonly string[];
	/** Nodes this browser has not paired: pairing is the way to them. */
	unpaired: readonly { id: string; name: string }[];
	/** The node on screen, and its project when it is a real one (not "Other"). */
	current?: { node: string; project?: { path: string; name: string } };
}

export interface AddMenuActions {
	/** A terminal (or pi, `agent`) in `project`, or in the node's home without one. */
	newTerminal: (node: string, project: string | undefined, agent: boolean) => void;
	addProject: (node: string) => void;
	newWorktree: (node: string, project: string) => void;
	pair: (node: string) => void;
}

/** Up to this many connected nodes show as groups under their names; beyond it, each node is a submenu. */
const NODE_GROUPS = 4;

const nameList = (names: readonly string[]): string =>
	names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The "+" menu targets a node. The node on screen, or the only connected one, is chosen without asking: its items
 * come first, under a header naming where they land when that is not obvious. Other connected nodes follow as
 * submenus. With no node on screen and several connected, each node is a group under its name, so one choice picks
 * both node and action. With none connected, the menu offers pairing, or says why it has nothing.
 */
export function addMenu(state: AddMenuState, run: AddMenuActions): MenuEntry[] {
	const { nodes } = state;
	if (nodes.length === 0) {
		const pair = state.unpaired.map((node) => item(`pair:${node.id}`, `Pair ${node.name}…`, () => run.pair(node.id), { icon: "key" }));
		const why = state.offline.length
			? `${nameList(state.offline)} ${state.offline.length === 1 ? "is" : "are"} not connected`
			: pair.length
				? "No node is paired with this browser yet"
				: "No node is connected";
		return groups([note(why)], pair);
	}

	const target = nodes.find((node) => node.id === state.current?.node) ?? (nodes.length === 1 ? nodes[0] : undefined);
	const isCurrent = target !== undefined && target.id === state.current?.node;
	const project = isCurrent ? state.current?.project : undefined;
	const id = (node: AddMenuNode, name: string, prefix: boolean) => (prefix ? `${node.id}:${name}` : name);
	const create = (node: AddMenuNode, prefix: boolean, here?: { path: string; name: string }): Part[] => [
		item(id(node, "new-terminal", prefix), "New Terminal", () => run.newTerminal(node.id, here?.path, false), { icon: "terminal", ...(here && isCurrent ? shortcut("terminal.new") : {}) }),
		item(id(node, "new-agent", prefix), "New pi Agent", () => run.newTerminal(node.id, here?.path, true), { icon: "agent" }),
		here && item(id(node, "new-worktree", prefix), "New Worktree…", () => run.newWorktree(node.id, here.path), { icon: "branch", ...unless(node.canWorktree ? undefined : updateNode(node.name)) }),
	];
	const addProject = (node: AddMenuNode, prefix: boolean) =>
		item(id(node, "add-project", prefix), "Add Project…", () => run.addProject(node.id), { icon: "folder", ...unless(node.canEdit ? undefined : updateNode(node.name)) });
	const asSubmenu = (node: AddMenuNode) => item(`node:${node.id}`, node.name, () => {}, { icon: "node", submenu: groups(create(node, false), [addProject(node, false)]) });

	if (target) {
		const others = nodes.filter((node) => node !== target);
		const named = project !== undefined || others.length > 0;
		return groups(
			[named && header(project ? `${project.name} · ${target.name}` : target.name), ...create(target, false, project)],
			[addProject(target, false)],
			others.length ? [header("Other nodes"), ...others.map(asSubmenu)] : [],
		);
	}
	if (nodes.length <= NODE_GROUPS) {
		return groups(...nodes.map((node) => [header(node.name), ...create(node, true), addProject(node, true)]));
	}
	return groups(nodes.map(asSubmenu));
}
