/**
 * One project's workspace on one node: a split tree of tab groups, each group a strip of tabs that mixes terminals,
 * files, and diffs. Every operation here is pure and returns a new workspace (or the same one when nothing changed).
 *
 * The behaviour follows Orca's tab groups (`src/renderer/src/store/slices/tabs/`, MIT, Copyright (c) 2026 Lovecast
 * Inc.; see ORCA-LICENSE): a per-group most-recently-used list picks the tab a close falls back to, pinned tabs stay
 * at the left, new tabs go after the active one, a preview tab is replaced by the next preview, a group whose last
 * tab closes goes away unless it is the only one, and a closed tab reopens where it was. The code is pika's own.
 */

import type { DiffMode } from "../changes";
import { leaf, leaves, parseTree, placeBeside, removeLeaf, setRatio, siblingOf, type GroupTree, type Side, type TreePath } from "./layout-tree";
import { paneLeaf, paneLeaves, parsePanes, removePane, type PaneTree } from "./panes";

export interface TerminalTab {
	kind: "terminal";
	id: string;
	panes: PaneTree;
	/** The pane that has focus inside the tab. */
	focused: string;
	pinned: boolean;
}

export interface FileTab {
	kind: "file";
	/** `file:<path>`, the node's editor store's key for the file. */
	id: string;
	path: string;
	/** A preview tab is replaced by the next preview; opening it for good, or editing it, keeps it. */
	preview: boolean;
	pinned: boolean;
}

export interface DiffTab {
	kind: "diff";
	/** `diff:<mode>:<path>`, the editor store's key. */
	id: string;
	path: string;
	mode: DiffMode;
	from?: string;
	pinned: boolean;
}

export type WorkspaceTab = TerminalTab | FileTab | DiffTab;

export interface Group {
	id: string;
	tabOrder: string[];
	activeTabId?: string;
	/** Tabs in the order they were last active, newest last. */
	mru: string[];
}

export interface ClosedTab {
	tab: WorkspaceTab;
	groupId: string;
	index: number;
}

export interface Workspace {
	root: GroupTree;
	groups: Readonly<Record<string, Group>>;
	tabs: Readonly<Record<string, WorkspaceTab>>;
	activeGroupId: string;
	/** Closed tabs, newest last, for reopening. */
	closed: readonly ClosedTab[];
}

/** How many closed tabs reopening can go back through. */
export const CLOSED_LIMIT = 20;

let counter = 0;
/** A fresh id with `prefix`, unique in this page. */
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const fileTabId = (path: string): string => `file:${path}`;
export const diffTabId = (path: string, mode: DiffMode): string => `diff:${mode}:${path}`;

export function createWorkspace(groupId = newId("g")): Workspace {
	return { root: leaf(groupId), groups: { [groupId]: { id: groupId, tabOrder: [], mru: [] } }, tabs: {}, activeGroupId: groupId, closed: [] };
}

export const terminalTab = (terminalId: string, id = newId("term:")): TerminalTab => ({ kind: "terminal", id, panes: paneLeaf(terminalId), focused: terminalId, pinned: false });
export const fileTab = (path: string, preview = false): FileTab => ({ kind: "file", id: fileTabId(path), path, preview, pinned: false });
export const diffTab = (path: string, mode: DiffMode, from?: string): DiffTab => ({ kind: "diff", id: diffTabId(path, mode), path, mode, ...(from ? { from } : {}), pinned: false });

/** The terminals a tab shows. */
export const tabTerminals = (tab: WorkspaceTab): string[] => (tab.kind === "terminal" ? paneLeaves(tab.panes) : []);

export function groupOf(ws: Workspace, tabId: string): Group | undefined {
	for (const group of Object.values(ws.groups)) if (group.tabOrder.includes(tabId)) return group;
	return undefined;
}

/** The terminal tab showing `terminalId`, if any. */
export function tabOfTerminal(ws: Workspace, terminalId: string): TerminalTab | undefined {
	for (const tab of Object.values(ws.tabs)) if (tab.kind === "terminal" && paneLeaves(tab.panes).includes(terminalId)) return tab;
	return undefined;
}

export function allTerminals(ws: Workspace): string[] {
	return Object.values(ws.tabs).flatMap(tabTerminals);
}

/** The groups in tree order. */
export const groupOrder = (ws: Workspace): Group[] => leaves(ws.root).map((id) => ws.groups[id]!);

export const activeTab = (ws: Workspace, groupId = ws.activeGroupId): WorkspaceTab | undefined => {
	const id = ws.groups[groupId]?.activeTabId;
	return id ? ws.tabs[id] : undefined;
};

const pinnedCount = (ws: Workspace, group: Group): number => group.tabOrder.filter((id) => ws.tabs[id]?.pinned).length;

/** Where a tab may go: pinned ones among the pinned at the left, others after them. */
function clampIndex(ws: Workspace, group: Group, pinned: boolean, index: number): number {
	const pins = pinnedCount(ws, group);
	return pinned ? Math.min(Math.max(0, index), pins) : Math.min(Math.max(pins, index), group.tabOrder.length);
}

const withGroup = (ws: Workspace, group: Group): Workspace => ({ ...ws, groups: { ...ws.groups, [group.id]: group } });

const touch = (mru: readonly string[], tabId: string): string[] => [...mru.filter((id) => id !== tabId), tabId];

export function activate(ws: Workspace, tabId: string): Workspace {
	const group = groupOf(ws, tabId);
	if (!group) return ws;
	if (group.activeTabId === tabId && ws.activeGroupId === group.id && group.mru.at(-1) === tabId) return ws;
	return { ...withGroup(ws, { ...group, activeTabId: tabId, mru: touch(group.mru, tabId) }), activeGroupId: group.id };
}

export function focusGroup(ws: Workspace, groupId: string): Workspace {
	return ws.groups[groupId] && ws.activeGroupId !== groupId ? { ...ws, activeGroupId: groupId } : ws;
}

export interface AddOptions {
	/** The group to add to; the active group by default. */
	groupId?: string;
	/** Make it the group's active tab, and the group the active one. The default. */
	activate?: boolean;
	/** Insert at this index rather than after the active tab. */
	index?: number;
}

/**
 * Adds `tab`, or shows it where it already is: opening a preview of an open file just shows it, opening it for good
 * keeps it (a preview no more). A new preview takes the place of the group's preview tab, if it has one.
 */
export function addTab(ws: Workspace, tab: WorkspaceTab, options: AddOptions = {}): Workspace {
	const existing = ws.tabs[tab.id];
	const shouldActivate = options.activate ?? true;
	if (existing && groupOf(ws, tab.id)) {
		let next = ws;
		if (existing.kind === "file" && existing.preview && tab.kind === "file" && !tab.preview) next = promote(next, tab.id);
		if (existing.kind === "diff" && tab.kind === "diff" && existing.from !== tab.from) next = { ...next, tabs: { ...next.tabs, [tab.id]: { ...existing, ...(tab.from ? { from: tab.from } : {}) } } };
		return shouldActivate ? activate(next, tab.id) : next;
	}
	const group = ws.groups[options.groupId ?? ws.activeGroupId] ?? ws.groups[ws.activeGroupId]!;
	let order = [...group.tabOrder];
	let mru = group.mru;
	const tabs = { ...ws.tabs, [tab.id]: tab };
	let index: number;
	const preview = tab.kind === "file" && tab.preview ? order.find((id) => { const other = ws.tabs[id]; return other?.kind === "file" && other.preview; }) : undefined;
	if (preview) {
		index = order.indexOf(preview);
		order.splice(index, 1);
		mru = mru.filter((id) => id !== preview);
		delete tabs[preview];
	} else {
		const anchor = group.activeTabId ? order.indexOf(group.activeTabId) : -1;
		index = clampIndex(ws, group, tab.pinned, options.index ?? (anchor >= 0 ? anchor + 1 : order.length));
	}
	order.splice(index, 0, tab.id);
	order = [...new Set(order)];
	const activeTabId = shouldActivate || !group.activeTabId || group.activeTabId === preview ? tab.id : group.activeTabId;
	const next: Group = { ...group, tabOrder: order, activeTabId, mru: activeTabId === tab.id ? touch(mru, tab.id) : [tab.id, ...mru] };
	return { ...ws, tabs, groups: { ...ws.groups, [group.id]: next }, activeGroupId: shouldActivate ? group.id : ws.activeGroupId };
}

/** A preview tab, kept for good. */
export function promote(ws: Workspace, tabId: string): Workspace {
	const tab = ws.tabs[tabId];
	if (tab?.kind !== "file" || !tab.preview) return ws;
	return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, preview: false } } };
}

/** `group` without `tabId`, falling back to its most recent other tab. */
function withoutTab(group: Group, tabId: string): Group {
	const order = group.tabOrder.filter((id) => id !== tabId);
	const mru = group.mru.filter((id) => id !== tabId && order.includes(id));
	let activeTabId = group.activeTabId;
	if (activeTabId === tabId) {
		const at = group.tabOrder.indexOf(tabId);
		activeTabId = mru.at(-1) ?? order[at] ?? order[at - 1];
	}
	return { ...group, tabOrder: order, mru, ...(activeTabId ? { activeTabId } : { activeTabId: undefined }) };
}

/** The workspace without the group, when it is empty and not the only one; its sibling takes its place. */
function collapse(ws: Workspace, groupId: string): Workspace {
	const group = ws.groups[groupId];
	if (!group || group.tabOrder.length > 0) return ws;
	const root = removeLeaf(ws.root, groupId);
	if (!root) return ws;
	const sibling = siblingOf(ws.root, groupId);
	const groups = { ...ws.groups };
	delete groups[groupId];
	return { ...ws, root, groups, activeGroupId: ws.activeGroupId === groupId ? (sibling ?? leaves(root)[0]!) : ws.activeGroupId };
}

/** Takes a tab out of its group (and the workspace), collapsing an emptied group; remembered for reopening unless `forget`. */
export function closeTab(ws: Workspace, tabId: string, { forget = false }: { forget?: boolean } = {}): Workspace {
	const group = groupOf(ws, tabId);
	const tab = ws.tabs[tabId];
	if (!group || !tab) return ws;
	const tabs = { ...ws.tabs };
	delete tabs[tabId];
	const closed = forget ? ws.closed : [...ws.closed, { tab, groupId: group.id, index: group.tabOrder.indexOf(tabId) }].slice(-CLOSED_LIMIT);
	return collapse({ ...withGroup(ws, withoutTab(group, tabId)), tabs, closed }, group.id);
}

/** Closes every other unpinned tab of the tab's group. */
export function closeOthers(ws: Workspace, tabId: string): Workspace {
	const group = groupOf(ws, tabId);
	if (!group) return ws;
	let next = activate(ws, tabId);
	for (const id of group.tabOrder) if (id !== tabId && !ws.tabs[id]?.pinned) next = closeTab(next, id);
	return next;
}

/**
 * The newest closed tab that `usable` accepts, back where it was: its group and index when the group is still
 * there, else the active group. Unusable ones (a terminal that is gone) are passed over and forgotten.
 */
export function reopenClosed(ws: Workspace, usable: (tab: WorkspaceTab) => boolean = () => true): Workspace {
	const closed = [...ws.closed];
	while (closed.length > 0) {
		const entry = closed.pop()!;
		if (ws.tabs[entry.tab.id] || !usable(entry.tab)) continue;
		const groupId = ws.groups[entry.groupId] ? entry.groupId : ws.activeGroupId;
		return addTab({ ...ws, closed }, entry.tab, { groupId, index: groupId === entry.groupId ? entry.index : undefined });
	}
	return closed.length === ws.closed.length ? ws : { ...ws, closed };
}

/** Moves a tab to `toGroupId` at `index` (after the target's active tab by default), or within its own group. */
export function moveTab(ws: Workspace, tabId: string, toGroupId: string, index?: number): Workspace {
	const from = groupOf(ws, tabId);
	const tab = ws.tabs[tabId];
	const target = ws.groups[toGroupId];
	if (!from || !tab || !target) return ws;
	if (from.id === toGroupId) {
		const order = from.tabOrder.filter((id) => id !== tabId);
		const rest = { ...from, tabOrder: order };
		const at = clampIndex(ws, rest, tab.pinned, index ?? from.tabOrder.indexOf(tabId));
		order.splice(at, 0, tabId);
		return activate(withGroup(ws, { ...from, tabOrder: order }), tabId);
	}
	let next = withGroup(ws, withoutTab(from, tabId));
	const anchor = target.activeTabId ? target.tabOrder.indexOf(target.activeTabId) + 1 : target.tabOrder.length;
	const order = [...target.tabOrder];
	order.splice(clampIndex(next, target, tab.pinned, index ?? anchor), 0, tabId);
	next = withGroup(next, { ...target, tabOrder: order, activeTabId: tabId, mru: touch(target.mru, tabId) });
	next = { ...next, activeGroupId: toGroupId };
	return collapse(next, from.id);
}

/** Moves a tab into a new group on `side` of `targetGroupId`; a no-op for a group's only tab dropped on its own edge. */
export function splitTab(ws: Workspace, tabId: string, targetGroupId: string, side: Side, groupId = newId("g")): Workspace {
	const from = groupOf(ws, tabId);
	if (!from || !ws.groups[targetGroupId]) return ws;
	if (from.id === targetGroupId && from.tabOrder.length === 1) return ws;
	const placed: Workspace = {
		...ws,
		root: placeBeside(ws.root, groupId, targetGroupId, side),
		groups: { ...ws.groups, [groupId]: { id: groupId, tabOrder: [], mru: [] } },
	};
	return moveTab(placed, tabId, groupId, 0);
}

/** Pins a tab (to the end of the pinned ones) or unpins it (to just after them). Pinning a preview keeps it. */
export function setPinned(ws: Workspace, tabId: string, pinned: boolean): Workspace {
	const tab = ws.tabs[tabId];
	const group = groupOf(ws, tabId);
	if (!tab || !group || tab.pinned === pinned) return ws;
	const changed = { ...tab, pinned, ...(tab.kind === "file" && pinned ? { preview: false } : {}) } as WorkspaceTab;
	const next = { ...ws, tabs: { ...ws.tabs, [tabId]: changed } };
	const order = group.tabOrder.filter((id) => id !== tabId);
	const pins = order.filter((id) => next.tabs[id]?.pinned).length;
	order.splice(pins, 0, tabId);
	return withGroup(next, { ...group, tabOrder: order });
}

export function setSplitRatio(ws: Workspace, path: TreePath, ratio: number): Workspace {
	return { ...ws, root: setRatio(ws.root, path, ratio) };
}

/** A terminal tab's new pane tree; a tree without panes closes the tab. */
export function setPanes(ws: Workspace, tabId: string, panes: PaneTree | null, focused?: string): Workspace {
	const tab = ws.tabs[tabId];
	if (tab?.kind !== "terminal") return ws;
	if (!panes) return closeTab(ws, tabId, { forget: true });
	const ids = paneLeaves(panes);
	const focus = focused && ids.includes(focused) ? focused : ids.includes(tab.focused) ? tab.focused : ids[0]!;
	return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, panes, focused: focus } } };
}

/** Focuses a pane inside its tab, and the tab in its group. */
export function focusPane(ws: Workspace, terminalId: string): Workspace {
	const tab = tabOfTerminal(ws, terminalId);
	if (!tab) return ws;
	const next = tab.focused === terminalId ? ws : { ...ws, tabs: { ...ws.tabs, [tab.id]: { ...tab, focused: terminalId } } };
	return activate(next, tab.id);
}

/** Takes a terminal out of whichever tab shows it; the tab closes with its last pane. */
export function removeTerminal(ws: Workspace, terminalId: string): Workspace {
	const tab = tabOfTerminal(ws, terminalId);
	if (!tab) return ws;
	const rest = removePane(tab.panes, terminalId);
	if (!rest) return setPanes(ws, tab.id, null);
	return setPanes(ws, tab.id, rest.tree, tab.focused === terminalId ? rest.successor : tab.focused);
}

/** Drops terminals `exists` denies, from tabs and from the closed list. */
export function pruneTerminals(ws: Workspace, exists: (terminalId: string) => boolean): Workspace {
	let next = ws;
	for (const id of allTerminals(ws)) if (!exists(id)) next = removeTerminal(next, id);
	const closed = next.closed.filter((entry) => tabTerminals(entry.tab).every(exists));
	return closed.length === next.closed.length ? next : { ...next, closed };
}

/** Closes, without remembering, every tab `drop` picks. */
export function dropTabs(ws: Workspace, drop: (tab: WorkspaceTab) => boolean): Workspace {
	let next = ws;
	for (const tab of Object.values(ws.tabs)) if (drop(tab)) next = closeTab(next, tab.id, { forget: true });
	return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

export interface StoredWorkspace {
	root: GroupTree;
	groups: Group[];
	tabs: WorkspaceTab[];
	activeGroupId: string;
}

/** What is kept: the layout and its tabs, diffs dropped (they are transient), the closed list not kept at all. */
export function storeWorkspace(ws: Workspace): StoredWorkspace {
	const kept = dropTabs(ws, (tab) => tab.kind === "diff");
	return { root: kept.root, groups: groupOrder(kept), tabs: Object.values(kept.tabs), activeGroupId: kept.activeGroupId };
}

function parseTab(value: unknown): WorkspaceTab | undefined {
	if (!value || typeof value !== "object") return undefined;
	const tab = value as Record<string, unknown>;
	const pinned = tab.pinned === true;
	if (tab.kind === "terminal" && typeof tab.id === "string") {
		const panes = parsePanes(tab.panes);
		if (!panes) return undefined;
		const ids = paneLeaves(panes);
		return { kind: "terminal", id: tab.id, panes, focused: typeof tab.focused === "string" && ids.includes(tab.focused) ? tab.focused : ids[0]!, pinned };
	}
	if (tab.kind === "file" && typeof tab.path === "string" && tab.path.startsWith("/")) return { ...fileTab(tab.path, tab.preview === true), pinned };
	return undefined;
}

/** A stored workspace, checked and repaired where it can be; undefined when it is beyond that. */
export function restoreWorkspace(value: unknown): Workspace | undefined {
	if (!value || typeof value !== "object") return undefined;
	const stored = value as Record<string, unknown>;
	const root = parseTree(stored.root);
	if (!root || !Array.isArray(stored.groups) || !Array.isArray(stored.tabs)) return undefined;
	const tabs: Record<string, WorkspaceTab> = {};
	const terminals = new Set<string>();
	for (const item of stored.tabs) {
		const tab = parseTab(item);
		// A tab twice, or a terminal in two tabs, is not kept twice.
		if (!tab || tabs[tab.id] || tabTerminals(tab).some((id) => terminals.has(id))) continue;
		for (const id of tabTerminals(tab)) terminals.add(id);
		tabs[tab.id] = tab;
	}
	const groups: Record<string, Group> = {};
	const placed = new Set<string>();
	for (const item of stored.groups as unknown[]) {
		if (!item || typeof item !== "object") continue;
		const group = item as Record<string, unknown>;
		if (typeof group.id !== "string" || !Array.isArray(group.tabOrder)) continue;
		const order = (group.tabOrder as unknown[]).filter((id): id is string => typeof id === "string" && Boolean(tabs[id]) && !placed.has(id));
		for (const id of order) placed.add(id);
		const pinnedFirst = [...order.filter((id) => tabs[id]!.pinned), ...order.filter((id) => !tabs[id]!.pinned)];
		const mru = Array.isArray(group.mru) ? (group.mru as unknown[]).filter((id): id is string => typeof id === "string" && pinnedFirst.includes(id)) : [];
		const active = typeof group.activeTabId === "string" && pinnedFirst.includes(group.activeTabId) ? group.activeTabId : (mru.at(-1) ?? pinnedFirst[0]);
		groups[group.id] = { id: group.id, tabOrder: pinnedFirst, mru, ...(active ? { activeTabId: active } : {}) };
	}
	for (const id of Object.keys(tabs)) if (!placed.has(id)) delete tabs[id];
	if (leaves(root).some((id) => !groups[id])) return undefined;
	for (const id of Object.keys(groups)) if (!leaves(root).includes(id)) delete groups[id];
	let ws: Workspace = {
		root,
		groups,
		tabs,
		activeGroupId: typeof stored.activeGroupId === "string" && groups[stored.activeGroupId] ? stored.activeGroupId : leaves(root)[0]!,
		closed: [],
	};
	for (const id of leaves(root)) ws = collapse(ws, id);
	return ws;
}
