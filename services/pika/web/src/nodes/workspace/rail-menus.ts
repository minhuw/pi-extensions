/**
 * The agent rail's menus, as data: what each kind of row offers (an agent, a project heading, a checkout, a worktree
 * card, the "Other" card, a node, the "+" button).
 * The rail draws them with the shared menu (`deck/Menu.tsx`).
 *
 * The rules every builder keeps:
 * - A menu is never a list of disabled items. What cannot apply here is left out; a disabled item stays only when
 *   that teaches something (an older pika-node: "Update pika-node on mac to use this"), and its reason shows once,
 *   beside the menu while it is highlighted.
 * - A node that is not connected leaves out everything that needs it, and the menu says so once, in a note.
 * - New Worktree… and Worktree Settings… show only for a checkout that can make worktrees (`makesWorktrees`: git with
 *   a main worktree), decided here from the checkout's own data: a folder or a bare repository would only fail.
 *
 * The items follow Orca's worktree and host menus and T3 Code's thread menu (both MIT; see ORCA-LICENSE and
 * T3-LICENSE): Orca's "Mark Read" / "Mark Unread", "Copy Path", "Copy Branch Name", removing a repository from the app
 * rather than from disk, and removing a worktree with git; T3's "Rename", "Mark unread", and "Copy path" / "Copy thread id". Destructive items are last and red.
 */
import type { Checkout } from "../contract";
import type { MenuEntry, MenuItem } from "../deck/Menu";
import { actionShortcut } from "../keys";
import type { Section } from "./inbox";
import { makesWorktrees } from "./places";

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

// --- A project heading, a checkout, a worktree card, "Other" ------------------------------------------------------

/** What the menus read of a checkout to decide whether it can make worktrees. */
export type WorktreeSource = Pick<Checkout, "id" | "kind" | "worktrees">;

export interface CheckoutMenuState {
	nodeName: string;
	connected: boolean;
	/** The daemon offers `checkouts` (every checkout and worktree request). */
	canCheckouts: boolean;
	checkout: WorktreeSource;
	/** Added by hand (`checkout.add`): it stays listed without a terminal or a root finding it. */
	configured: boolean;
}

export interface CheckoutMenuActions {
	rename: () => void;
	settings: () => void;
	reveal: () => void;
	copyPath: () => void;
	keep: () => void;
	hide: () => void;
}

/** A checkout's items in three groups (names and settings, where it is, keeping or removing it), for its row or its heading. */
function checkoutParts(state: CheckoutMenuState, run: CheckoutMenuActions): [Part[], Part[], Part[]] {
	const on = state.connected;
	const edit = state.canCheckouts ? undefined : updateNode(state.nodeName);
	return [
		[
			on && item("rename-checkout", `Rename on ${state.nodeName}…`, run.rename, { icon: "pencil", ...unless(edit) }),
			on && makesWorktrees(state.checkout) && item("settings", "Worktree Settings…", run.settings, { icon: "branch", ...unless(edit) }),
		],
		[on && item("reveal", "Reveal in Explorer", run.reveal, { icon: "reveal" }), item("copy-path", "Copy Path", run.copyPath, { icon: "copy" })],
		[
			on && !state.configured && item("keep", "Keep in Deck", run.keep, { icon: "check", ...unless(edit) }),
			on && item("hide", "Remove from Deck", run.hide, { danger: true, icon: "close", ...shortcut("rail.remove"), ...unless(edit) }),
		],
	];
}

/** A checkout's row (shown when a node has two or more checkouts of one project). */
export function checkoutMenu(state: CheckoutMenuState, run: CheckoutMenuActions): MenuEntry[] {
	const [edit, reach, remove] = checkoutParts(state, run);
	return groups(edit, reach, remove, [!state.connected && note(notConnected(state.nodeName))]);
}

export interface ProjectMenuState {
	nodeName: string;
	connected: boolean;
	canCheckouts: boolean;
	/** The server has a key for the project, so it keeps a name and folding for it. */
	persisted: boolean;
	collapsed: boolean;
	repository?: string;
	/** The project's checkouts, each with a label (its path) for choosing; only those that can make worktrees are offered. */
	worktreeFrom: readonly { checkout: WorktreeSource; label: string }[];
	/** The heading stands for the project's only checkout: its items join the heading's. */
	checkout?: CheckoutMenuState;
}

export interface ProjectMenuActions {
	newWorktree: (checkoutId: string) => void;
	rename: () => void;
	fold: () => void;
	copyRepository: () => void;
	checkout?: CheckoutMenuActions;
}

export function projectMenu(state: ProjectMenuState, run: ProjectMenuActions): MenuEntry[] {
	const on = state.connected;
	const worktree = unless(state.canCheckouts ? undefined : updateNode(state.nodeName));
	const from = state.worktreeFrom.filter(({ checkout }) => makesWorktrees(checkout)).map(({ checkout, label }) => ({ id: checkout.id, label }));
	const newWorktree: Part =
		on &&
		from.length > 0 &&
		(from.length === 1
			? item("new-worktree", "New Worktree…", () => run.newWorktree(from[0]!.id), { icon: "branch", ...worktree })
			: item("new-worktree", "New Worktree", () => {}, {
					icon: "branch",
					...worktree,
					submenu: from.map((checkout) => item(`new-worktree:${checkout.id}`, `${checkout.label}…`, () => run.newWorktree(checkout.id), { icon: "folder" })),
				}));
	const [edit, reach, remove] = state.checkout && run.checkout ? checkoutParts(state.checkout, run.checkout) : [[], [], []];
	return groups(
		[newWorktree],
		[state.persisted && item("rename", "Rename Project…", run.rename, { icon: "pencil", ...shortcut("rail.rename") }), ...edit, item("fold", state.collapsed ? "Expand" : "Collapse", run.fold, { icon: "fold" })],
		[...reach, state.repository !== undefined && item("copy-repository", "Copy Repository URL", run.copyRepository, { icon: "copy" })],
		remove,
		[!on && note(notConnected(state.nodeName))],
	);
}

export interface WorktreeMenuState {
	nodeName: string;
	connected: boolean;
	canCheckouts: boolean;
	/** A linked worktree (not the main one, not a folder): it can be removed. */
	linked: boolean;
	branch?: string;
	/** Its directory is gone: nothing can start in it, and removing it prunes git's entry. */
	prunable: boolean;
}

export interface WorktreeMenuActions {
	newTerminal: () => void;
	newAgent: () => void;
	reveal: () => void;
	copyPath: () => void;
	copyBranch: () => void;
	remove: () => void;
}

export function worktreeMenu(state: WorktreeMenuState, run: WorktreeMenuActions): MenuEntry[] {
	const on = state.connected;
	const there = on && !state.prunable;
	return groups(
		[there && item("new-terminal", "New Terminal", run.newTerminal, { icon: "terminal", ...shortcut("terminal.new") }), there && item("new-agent", "New pi Agent", run.newAgent, { icon: "agent" })],
		[
			there && item("reveal", "Reveal in Explorer", run.reveal, { icon: "reveal" }),
			item("copy-path", "Copy Path", run.copyPath, { icon: "copy" }),
			state.branch !== undefined && item("copy-branch", "Copy Branch Name", run.copyBranch, { icon: "copy" }),
		],
		[
			on &&
				state.linked &&
				item("remove-worktree", "Remove Worktree…", run.remove, { danger: true, icon: "trash", ...shortcut("rail.remove"), ...unless(state.canCheckouts ? undefined : updateNode(state.nodeName)) }),
		],
		[!on && note(notConnected(state.nodeName))],
	);
}

export interface OtherMenuActions {
	newTerminal: () => void;
	newAgent: () => void;
	fold: () => void;
}

/** The node's "Other" card: terminals in no listed worktree, new ones started in the home directory. */
export function otherMenu(state: { nodeName: string; connected: boolean; folded: boolean }, run: OtherMenuActions): MenuEntry[] {
	const on = state.connected;
	return groups(
		[on && item("new-terminal", "New Terminal in Home", run.newTerminal, { icon: "terminal" }), on && item("new-agent", "New pi Agent", run.newAgent, { icon: "agent" })],
		[item("fold", state.folded ? "Expand" : "Collapse", run.fold, { icon: "fold" })],
		[!on && note(notConnected(state.nodeName))],
	);
}

// --- A node ---------------------------------------------------------------------------------------------------------

export interface NodeMenuState {
	nodeName: string;
	connected: boolean;
	canCheckouts: boolean;
	/** The pinned key's fingerprint, when this browser pinned one. */
	fingerprint?: string;
	pinned: boolean;
	/** Folding applies (the Projects view). */
	foldable: boolean;
	folded: boolean;
}

export interface NodeMenuActions {
	newTerminal: () => void;
	addCheckout: () => void;
	copyFingerprint: () => void;
	repair: () => void;
	fold: () => void;
}

export function nodeMenu(state: NodeMenuState, run: NodeMenuActions): MenuEntry[] {
	const on = state.connected;
	return groups(
		[
			on && item("new-terminal", "New Terminal in Home", run.newTerminal, { icon: "terminal" }),
			on && item("add-checkout", "Add Repository…", run.addCheckout, { icon: "folder", ...unless(state.canCheckouts ? undefined : updateNode(state.nodeName)) }),
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
	canCheckouts: boolean;
}

export interface AddMenuPlace {
	place: string;
	name: string;
	/** New Worktree… comes from it when it can make worktrees. */
	checkout: WorktreeSource;
}

export interface AddMenuState {
	/** The connected nodes, in the rail's order: the "+" makes things on these. */
	nodes: readonly AddMenuNode[];
	/** Paired nodes that are not connected now, by name. */
	offline: readonly string[];
	/** Nodes this browser has not paired: pairing is the way to them. */
	unpaired: readonly { id: string; name: string }[];
	/** The node on screen, and its place when it is a worktree (not "Other"): its name, and its checkout. */
	current?: { node: string; place?: AddMenuPlace };
}

export interface AddMenuActions {
	/** A terminal (or pi, `agent`) in `place`, or in the node's home without one. */
	newTerminal: (node: string, place: string | undefined, agent: boolean) => void;
	addCheckout: (node: string) => void;
	newWorktree: (node: string, checkoutId: string) => void;
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
	const place = isCurrent ? state.current?.place : undefined;
	const id = (node: AddMenuNode, name: string, prefix: boolean) => (prefix ? `${node.id}:${name}` : name);
	const create = (node: AddMenuNode, prefix: boolean, here?: AddMenuPlace): Part[] => [
		item(id(node, "new-terminal", prefix), "New Terminal", () => run.newTerminal(node.id, here?.place, false), { icon: "terminal", ...(here && isCurrent ? shortcut("terminal.new") : {}) }),
		item(id(node, "new-agent", prefix), "New pi Agent", () => run.newTerminal(node.id, here?.place, true), { icon: "agent" }),
		here !== undefined &&
			makesWorktrees(here.checkout) &&
			item(id(node, "new-worktree", prefix), "New Worktree…", () => run.newWorktree(node.id, here.checkout.id), { icon: "branch", ...unless(node.canCheckouts ? undefined : updateNode(node.name)) }),
	];
	const addCheckout = (node: AddMenuNode, prefix: boolean) =>
		item(id(node, "add-checkout", prefix), "Add Repository…", () => run.addCheckout(node.id), { icon: "folder", ...unless(node.canCheckouts ? undefined : updateNode(node.name)) });
	const asSubmenu = (node: AddMenuNode) => item(`node:${node.id}`, node.name, () => {}, { icon: "node", submenu: groups(create(node, false), [addCheckout(node, false)]) });

	if (target) {
		const others = nodes.filter((node) => node !== target);
		const named = place !== undefined || others.length > 0;
		return groups(
			[named && header(place ? `${place.name} · ${target.name}` : target.name), ...create(target, false, place)],
			[addCheckout(target, false)],
			others.length ? [header("Other nodes"), ...others.map(asSubmenu)] : [],
		);
	}
	if (nodes.length <= NODE_GROUPS) {
		return groups(...nodes.map((node) => [header(node.name), ...create(node, true), addCheckout(node, true)]));
	}
	return groups(nodes.map(asSubmenu));
}
