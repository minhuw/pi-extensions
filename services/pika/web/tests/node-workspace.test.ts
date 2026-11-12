import { describe, expect, it } from "vitest";
import { dropZone, zonePreview } from "../src/nodes/workspace/drop-zone";
import { buildSplit, leaves, parseTree, placeBeside, removeLeaf, setRatio, siblingOf, type GroupTree } from "../src/nodes/workspace/layout-tree";
import {
	activate,
	activeTab,
	addTab,
	closeOthers,
	closeTab,
	createWorkspace,
	diffTab,
	fileTab,
	groupOf,
	groupOrder,
	moveTab,
	pruneTerminals,
	reopenClosed,
	restoreWorkspace,
	setPanes,
	setPinned,
	splitTab,
	storeWorkspace,
	terminalTab,
	type Workspace,
} from "../src/nodes/workspace/model";
import { menuItems } from "../src/nodes/deck/Menu";
import { placeOpen } from "../src/nodes/workspace/placement";
import { tabMenuItems, type WorkspaceActions } from "../src/nodes/workspace/WorkspaceView";
import { placeKey } from "../src/nodes/workspace/places";
import { NodeWorkspaces, WORKSPACE_KEY_PREFIX } from "../src/nodes/workspace/store";

const split = (direction: "row" | "column", first: GroupTree, second: GroupTree, ratio = 0.5): GroupTree => ({ type: "split", direction, ratio, first, second });
const leaf = (groupId: string): GroupTree => ({ type: "leaf", groupId });

/** A workspace with tabs `ids` (terminal tabs `term:<id>` on terminal `<id>`, files given as paths). */
function workspace(...ids: string[]): Workspace {
	let ws = createWorkspace("g1");
	for (const id of ids) ws = addTab(ws, id.startsWith("/") ? fileTab(id) : terminalTab(id, `term:${id}`));
	return ws;
}

const order = (ws: Workspace, groupId = ws.activeGroupId) => ws.groups[groupId]!.tabOrder;

describe("the group tree", () => {
	it("splits a group to any side, and promotes the sibling when a group goes", () => {
		expect(buildSplit("a", "b", "right")).toEqual(split("row", leaf("a"), leaf("b")));
		expect(buildSplit("a", "b", "up")).toEqual(split("column", leaf("b"), leaf("a")));
		const tree = placeBeside(placeBeside(leaf("a"), "b", "a", "right"), "c", "b", "down");
		expect(tree).toEqual(split("row", leaf("a"), split("column", leaf("b"), leaf("c"))));
		expect(leaves(tree)).toEqual(["a", "b", "c"]);
		expect(siblingOf(tree, "b")).toBe("c");
		expect(siblingOf(tree, "a")).toBe("b");
		expect(removeLeaf(tree, "b")).toEqual(split("row", leaf("a"), leaf("c")));
		expect(removeLeaf(leaf("a"), "a")).toBeNull();
		// Moving a group that is already in the tree takes it out of its old place.
		expect(placeBeside(tree, "a", "c", "down")).toEqual(split("column", leaf("b"), split("column", leaf("c"), leaf("a"))));
	});

	it("clamps ratios to 0.15–0.85 and reads back only well-formed trees", () => {
		const tree = split("row", leaf("a"), split("column", leaf("b"), leaf("c")));
		expect(setRatio(tree, ["second"], 0.99)).toEqual(split("row", leaf("a"), split("column", leaf("b"), leaf("c"), 0.85)));
		expect(setRatio(tree, [], 0.01)).toMatchObject({ ratio: 0.15 });
		expect(parseTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
		expect(parseTree(split("row", leaf("a"), leaf("a")))).toBeUndefined();
		expect(parseTree({ type: "split", direction: "diagonal", ratio: 0.5, first: leaf("a"), second: leaf("b") })).toBeUndefined();
		expect(parseTree({ type: "split", direction: "row", ratio: 3, first: leaf("a"), second: leaf("b") })).toMatchObject({ ratio: 0.85 });
	});
});

describe("drop zones", () => {
	const group = { left: 100, top: 50, width: 400, height: 336 };
	// The body is 300 high under a 36 px strip: its bands are 80 px across and 60 px down.
	it("reorders on the strip, splits in the body's outer 20%, and moves in the centre", () => {
		expect(dropZone(group, { x: 300, y: 60 })).toBe("strip");
		expect(dropZone(group, { x: 105, y: 60 })).toBe("strip");
		expect(dropZone(group, { x: 179, y: 200 })).toBe("left");
		expect(dropZone(group, { x: 421, y: 200 })).toBe("right");
		expect(dropZone(group, { x: 300, y: 86 + 59 })).toBe("up");
		expect(dropZone(group, { x: 300, y: 86 + 241 })).toBe("down");
		expect(dropZone(group, { x: 300, y: 200 })).toBe("center");
		expect(dropZone(group, { x: 181, y: 147 })).toBe("center");
		expect(dropZone(group, { x: 99, y: 200 })).toBeUndefined();
		expect(dropZone(group, { x: 300, y: 400 })).toBeUndefined();
	});

	it("previews the half of the body a split fills", () => {
		expect(zonePreview("right", group)).toEqual({ left: 200, top: 36, width: 200, height: 150 * 2 });
		expect(zonePreview("down", group)).toEqual({ left: 0, top: 36 + 150, width: 400, height: 150 });
		expect(zonePreview("center", group)).toEqual({ left: 0, top: 36, width: 400, height: 300 });
	});
});

describe("tabs", () => {
	it("insert after the active tab, and closing one shows the most recently used", () => {
		let ws = workspace("a", "b", "c");
		expect(order(ws)).toEqual(["term:a", "term:b", "term:c"]);
		ws = activate(ws, "term:a");
		ws = addTab(ws, fileTab("/x"));
		expect(order(ws)).toEqual(["term:a", "file:/x", "term:b", "term:c"]);
		ws = activate(ws, "term:c");
		ws = activate(ws, "file:/x");
		ws = closeTab(ws, "file:/x");
		expect(activeTab(ws)?.id).toBe("term:c");
		ws = closeTab(ws, "term:c");
		expect(activeTab(ws)?.id).toBe("term:a");
	});

	it("keep pinned tabs at the left, through pins, inserts, and moves", () => {
		let ws = workspace("a", "b", "c");
		ws = setPinned(ws, "term:c", true);
		expect(order(ws)).toEqual(["term:c", "term:a", "term:b"]);
		ws = activate(ws, "term:c");
		ws = addTab(ws, fileTab("/x"));
		expect(order(ws)).toEqual(["term:c", "file:/x", "term:a", "term:b"]);
		ws = moveTab(ws, "term:b", "g1", 0);
		expect(order(ws)).toEqual(["term:c", "term:b", "file:/x", "term:a"]);
		ws = setPinned(ws, "term:c", false);
		expect(order(ws)).toEqual(["term:c", "term:b", "file:/x", "term:a"]);
		ws = setPinned(ws, "term:a", true);
		expect(order(ws)[0]).toBe("term:a");
		// Close others keeps pinned tabs.
		ws = closeOthers(ws, "file:/x");
		expect(order(ws)).toEqual(["term:a", "file:/x"]);
	});

	it("replace the group's preview with the next preview, and keep a preview opened for good", () => {
		let ws = workspace("a");
		ws = addTab(ws, fileTab("/one", true));
		ws = addTab(ws, fileTab("/two", true));
		expect(order(ws)).toEqual(["term:a", "file:/two"]);
		expect(ws.tabs["file:/one"]).toBeUndefined();
		ws = addTab(ws, fileTab("/two", false));
		expect(ws.tabs["file:/two"]).toMatchObject({ preview: false });
		ws = addTab(ws, fileTab("/three", true));
		expect(order(ws)).toEqual(["term:a", "file:/two", "file:/three"]);
		// A pinned preview is kept too.
		ws = setPinned(ws, "file:/three", true);
		expect(ws.tabs["file:/three"]).toMatchObject({ preview: false, pinned: true });
	});

	it("reopen a closed tab at its old place, passing over ones that cannot come back", () => {
		let ws = workspace("a", "b", "c");
		ws = closeTab(ws, "term:b");
		ws = closeTab(ws, "term:c");
		ws = reopenClosed(ws, (tab) => tab.id !== "term:c");
		expect(order(ws)).toEqual(["term:a", "term:b"]);
		expect(activeTab(ws)?.id).toBe("term:b");
		expect(ws.closed).toEqual([]);
		expect(reopenClosed(ws)).toBe(ws);
	});

	it("split into a new group on any side, and an emptied group goes unless it is the last", () => {
		let ws = workspace("a", "b");
		ws = splitTab(ws, "term:b", "g1", "right", "g2");
		expect(ws.root).toEqual(split("row", leaf("g1"), leaf("g2")));
		expect(order(ws, "g2")).toEqual(["term:b"]);
		expect(ws.activeGroupId).toBe("g2");
		// A group's only tab dropped on its own edge stays.
		expect(splitTab(ws, "term:b", "g2", "down", "g3")).toBe(ws);
		ws = splitTab(ws, "term:a", "g2", "down", "g3");
		expect(ws.groups.g1).toBeUndefined();
		expect(ws.root).toEqual(split("column", leaf("g2"), leaf("g3")));
		ws = closeTab(ws, "term:a");
		expect(ws.root).toEqual(leaf("g2"));
		ws = closeTab(ws, "term:b");
		expect(ws.root).toEqual(leaf("g2"));
		expect(order(ws, "g2")).toEqual([]);
		// Reopening goes back to the group when it is still there, else to the active group.
		ws = reopenClosed(ws);
		expect(order(ws, "g2")).toEqual(["term:b"]);
		ws = reopenClosed(ws);
		expect(order(ws, "g2")).toEqual(["term:b", "term:a"]);
	});

	it("move between groups, and leave a terminal tab when its last pane goes", () => {
		let ws = splitTab(workspace("a", "b", "c"), "term:c", "g1", "down", "g2");
		ws = moveTab(ws, "term:a", "g2", 0);
		expect(order(ws, "g2")).toEqual(["term:a", "term:c"]);
		expect(groupOf(ws, "term:a")?.id).toBe("g2");
		ws = moveTab(ws, "term:b", "g2");
		expect(ws.groups.g1).toBeUndefined();
		ws = setPanes(ws, "term:a", null);
		expect(ws.tabs["term:a"]).toBeUndefined();
		expect(ws.closed).toEqual([]);
		ws = pruneTerminals(ws, (id) => id !== "c");
		expect(Object.keys(ws.tabs)).toEqual(["term:b"]);
	});
});

describe("restoring a workspace", () => {
	it("keeps the layout and tabs, drops diffs, and repairs what does not add up", () => {
		let ws = workspace("a", "/notes.md");
		ws = addTab(ws, diffTab("/notes.md", "worktree"));
		ws = splitTab(ws, "term:a", "g1", "right", "g2");
		ws = splitTab(ws, "diff:worktree:/notes.md", "g1", "down", "g3");
		const stored = JSON.parse(JSON.stringify(storeWorkspace(ws)));
		const back = restoreWorkspace(stored)!;
		expect(back.root).toEqual(split("row", leaf("g1"), leaf("g2")));
		expect(groupOrder(back).map((group) => group.tabOrder)).toEqual([["file:/notes.md"], ["term:a"]]);
		expect(back.tabs["diff:worktree:/notes.md"]).toBeUndefined();
		expect(restoreWorkspace({ ...stored, root: leaf("nowhere") })).toBeUndefined();
		// A terminal in two tabs is kept once.
		const twice = { ...stored, tabs: [...stored.tabs, { ...stored.tabs.find((tab: { kind: string }) => tab.kind === "terminal"), id: "term:again" }] };
		twice.groups[0].tabOrder.push("term:again");
		expect(Object.keys(restoreWorkspace(twice)!.tabs).sort()).toEqual(["file:/notes.md", "term:a"]);
	});
});

describe("opening a file beside its source", () => {
	it("goes to the group that has it, an editor group itself, an adjacent editor, a neighbour, or a split", () => {
		let ws = workspace("a");
		expect(placeOpen(ws, "g1", "file:/x")).toEqual({ splitRightOf: "g1" });
		ws = addTab(ws, fileTab("/y"));
		expect(placeOpen(ws, "g1", "file:/x")).toEqual({ groupId: "g1" });
		ws = activate(ws, "term:a");
		// g1 | (g2 over g3); g3 shows an editor, g2 a terminal.
		ws = addTab(ws, terminalTab("b", "term:b"));
		ws = splitTab(ws, "term:b", "g1", "right", "g2");
		ws = splitTab(ws, "file:/y", "g2", "down", "g3");
		ws = activate(ws, "term:a");
		expect(placeOpen(ws, "g1", "file:/x")).toEqual({ groupId: "g3" });
		expect(placeOpen(ws, "g2", "file:/x")).toEqual({ groupId: "g3" });
		expect(placeOpen(ws, "g1", "file:/y")).toEqual({ groupId: "g3" });
		ws = addTab(ws, terminalTab("c", "term:c"), { groupId: "g3" });
		// No editor anywhere next to g1: the right one, then the top one.
		expect(placeOpen(ws, "g1", "file:/x")).toEqual({ groupId: "g2" });
	});
});

class MemoryStorage {
	items = new Map<string, string>();
	getItem = (key: string) => this.items.get(key) ?? null;
	setItem = (key: string, value: string) => void this.items.set(key, value);
	removeItem = (key: string) => void this.items.delete(key);
}

describe("a node's workspaces", () => {
	// Places: a worktree of a checkout (`placeKey`).
	const P = placeKey("a".repeat(32), "/p");
	const Q = placeKey("b".repeat(32), "/q");

	it("drops the layouts of version 1, which were keyed by project path", () => {
		const storage = new MemoryStorage();
		storage.setItem(`${WORKSPACE_KEY_PREFIX}n1`, JSON.stringify({ version: 1, active: "/p", known: ["t1"], layouts: { "/p": storeWorkspace(workspace("t1")) } }));
		const store = new NodeWorkspaces("n1", { storage });
		expect(store.getSnapshot().layouts.size).toBe(0);
		expect(store.active).toBeUndefined();
		// The terminal is new to this layout, so it gets a tab in its place.
		store.reconcile([{ terminalId: "t1", place: P }], true);
		expect(store.placeOf("t1")).toBe(P);
		expect(JSON.parse(storage.getItem(`${WORKSPACE_KEY_PREFIX}n1`)!)).toMatchObject({ version: 2, layouts: { [P]: expect.anything() } });
	});


	it("give new terminals a tab in their place, once, and drop gone ones once listed", () => {
		const storage = new MemoryStorage();
		const store = new NodeWorkspaces("n1", { storage });
		store.reconcile([{ terminalId: "t2", place: P }, { terminalId: "t1", place: P }, { terminalId: "t3", place: Q }], false);
		expect(store.getSnapshot().layouts.size).toBe(0);
		store.reconcile([{ terminalId: "t2", place: P }, { terminalId: "t1", place: P }, { terminalId: "t3", place: Q }], true);
		const p = store.layout(P);
		expect(order(p).map((id) => p.tabs[id]!.kind === "terminal" && (p.tabs[id] as { focused: string }).focused)).toEqual(["t1", "t2"]);
		expect(activeTab(p)?.id).toBe(order(p)[0]);
		// A closed tab does not come back by itself; a terminal that is gone leaves.
		store.update(P, (ws) => closeTab(ws, order(ws)[0]!));
		store.reconcile([{ terminalId: "t2", place: P }, { terminalId: "t1", place: P }], true);
		expect(order(store.layout(P))).toHaveLength(1);
		expect(order(store.layout(Q))).toEqual([]);
		// It reads back from storage.
		const again = new NodeWorkspaces("n1", { storage });
		again.reconcile([{ terminalId: "t2", place: P }, { terminalId: "t1", place: P }], true);
		expect(order(again.layout(P))).toHaveLength(1);
		expect(JSON.parse(storage.getItem(`${WORKSPACE_KEY_PREFIX}n1`)!).version).toBe(2);
	});

	it("waits for a terminal it is creating, and moves a revealed terminal between places", () => {
		const store = new NodeWorkspaces("n1", { storage: new MemoryStorage() });
		const release = store.holdNewTerminals();
		store.reconcile([{ terminalId: "t1", place: P }], true);
		expect(store.placeOf("t1")).toBeUndefined();
		store.reveal(P, "t1");
		release();
		store.reconcile([{ terminalId: "t1", place: P }], true);
		expect(order(store.layout(P))).toHaveLength(1);
		expect(store.getSnapshot().focus).toMatchObject({ place: P, terminalId: "t1" });
		store.reveal(Q, "t1");
		expect(store.placeOf("t1")).toBe(Q);
		expect(order(store.layout(P))).toEqual([]);
		expect(store.active).toBe(Q);
	});

	it("opens files by the placement rule, focusing them only when asked, and forgets restored files that fail", () => {
		const storage = new MemoryStorage();
		const store = new NodeWorkspaces("n1", { storage });
		store.reveal(P, "t1");
		const focusBefore = store.getSnapshot().focus;
		const group = store.openEditor(P, fileTab("/p/a.ts"));
		const ws = store.layout(P);
		expect(leaves(ws.root)).toHaveLength(2);
		expect(order(ws, group)).toEqual(["file:/p/a.ts"]);
		// The terminal's group keeps focus and still shows the terminal.
		expect(ws.activeGroupId).not.toBe(group);
		expect(activeTab(ws)?.kind).toBe("terminal");
		expect(store.getSnapshot().focus).toBe(focusBefore);
		store.openEditor(P, fileTab("/p/b.ts", true), { focus: true });
		expect(order(store.layout(P), group)).toEqual(["file:/p/a.ts", "file:/p/b.ts"]);
		expect(store.getSnapshot().focus).toMatchObject({ tabId: "file:/p/b.ts" });
		expect([...store.editorKeys()].sort()).toEqual(["file:/p/a.ts", "file:/p/b.ts"]);

		const again = new NodeWorkspaces("n1", { storage });
		expect([...again.restoredFiles()].sort()).toEqual(["file:/p/a.ts", "file:/p/b.ts"]);
		again.opened("file:/p/a.ts");
		again.failedToOpen("file:/p/a.ts");
		again.failedToOpen("file:/p/b.ts");
		// a.ts opened before its failure was reported, so it stays; b.ts never opened and goes.
		const kept = Object.values(again.layout(P).tabs).map((tab) => tab.kind === "terminal" ? `terminal:${tab.focused}` : tab.id);
		expect(kept.sort()).toEqual(["file:/p/a.ts", "terminal:t1"]);
	});
});

describe("a tab's menu", () => {
	const ids = (ws: Workspace, tabId: string) => tabMenuItems(ws, tabId, {} as WorkspaceActions).map((entry) => (entry === "separator" ? "|" : "id" in entry ? entry.id : "?"));

	it("leaves out splits for a group's only tab and Close Others with nothing else to close, rather than disabling them", () => {
		const one = workspace("a");
		expect(ids(one, Object.keys(one.tabs)[0]!)).toEqual(["pin", "|", "close"]);
		const two = workspace("a", "/src/x.ts");
		const [terminal, file] = Object.keys(two.tabs) as [string, string];
		expect(ids(two, file)).toEqual(["split-right", "split-left", "split-down", "split-up", "|", "pin", "copy-path", "|", "close", "close-others"]);
		expect(menuItems(tabMenuItems(two, terminal, {} as WorkspaceActions)).every((entry) => !entry.disabled)).toBe(true);
		// Pinned neighbours are not closed by Close Others.
		const pinned = setPinned(two, file, true);
		expect(ids(pinned, terminal)).not.toContain("close-others");
	});
});
