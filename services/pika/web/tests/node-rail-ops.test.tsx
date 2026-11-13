import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeView } from "../src/nodes/client";
import { cleanTerminal, paneLabel } from "../src/nodes/client";
import type { PaneView, TerminalInfo } from "../src/nodes/contract";
import { AddCheckoutDialog, completionParts, expandHome, matchFolders, UNDO_MS, UndoToast } from "../src/nodes/deck/RailDialogs";
import { buildKeymap, focusOf, resolveKey, type PageCommands } from "../src/nodes/keys";
import { AgentRail, agentMatches, railAgents, useInbox, type RailOps } from "../src/nodes/workspace/AgentRail";
import { menuItems, type MenuEntry } from "../src/nodes/deck/Menu";
import { placeKey, placeOfTerminal, placeWords, type RailNode } from "../src/nodes/workspace/places";
import { addMenu, agentMenu, checkoutMenu, nodeMenu, otherMenu, projectMenu, worktreeMenu, type AddMenuState } from "../src/nodes/workspace/rail-menus";
import { OTHER } from "../src/nodes/workspace/store";
import { folderCheckout, gitCheckout, rail, worktree } from "./support/checkouts";

const pane = (id: string, status?: Partial<PaneView>, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
	terminalId: id,
	title: id,
	cwd: "/home/me/repo",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: ["pi"],
	...placedAt(extra.cwd ?? "/home/me/repo"),
	...(status ? { status: { state: "idle", bridgeConnected: false, unread: false, ...status } } : {}),
	...extra,
});

const node = (id: string, terminals: TerminalInfo[]): NodeView =>
	({
		info: { id, name: id, online: true },
		pin: { node: id, fingerprint: "f".repeat(64), publicKey: "k", name: id, pinnedAt: 0 },
		link: { kind: "ready", welcome: { home: "/home/me" } },
		terminals,
		listed: true,
		epoch: 1,
	}) as unknown as NodeView;

// One repository with a linked worktree on branch fix.
const REPO = gitCheckout("a", "/home/me/repo", { linked: [worktree("/home/me/repo-fix", "fix")] });
const RAIL = rail("mac", [REPO]);
const MAIN = placeKey(REPO.id, "/home/me/repo");
const FIX = placeKey(REPO.id, "/home/me/repo-fix");

/** The node places terminals by their cwd here: the fix worktree, the main one, else nowhere. */
const placedAt = (cwd: string): Partial<TerminalInfo> =>
	cwd.startsWith("/home/me/repo-fix") ? { checkoutId: REPO.id, worktreePath: "/home/me/repo-fix" } : cwd.startsWith("/home/me/repo") ? { checkoutId: REPO.id, worktreePath: "/home/me/repo" } : {};

type Calls = Record<string, unknown[][]>;

function makeOps(calls: Calls, capabilities: readonly string[]): RailOps {
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			(calls[name] ??= []).push(args);
		};
	return {
		can: (_node, capability) => capabilities.includes(capability),
		connected: () => true,
		fingerprint: () => "f".repeat(64),
		newTerminal: record("newTerminal"),
		addCheckout: record("addCheckout"),
		newWorktree: record("newWorktree"),
		revealPlace: record("revealPlace"),
		renameProject: record("renameProject"),
		setCollapsed: record("setCollapsed"),
		renameCheckout: record("renameCheckout"),
		checkoutSettings: record("checkoutSettings"),
		keepCheckout: record("keepCheckout"),
		hideCheckout: record("hideCheckout"),
		removeWorktree: record("removeWorktree"),
		renameAgent: record("renameAgent"),
		markRead: record("markRead"),
		markUnread: record("markUnread"),
		split: record("split"),
		restart: record("restart"),
		repair: record("repair"),
	};
}

const ALL = ["checkouts", "term.rename", "pane.unread"];

function Harness({ nodes, calls, capabilities = ALL, railNode = RAIL, place = MAIN }: { nodes: NodeView[]; calls: Calls; capabilities?: readonly string[]; railNode?: RailNode; place?: string }) {
	const [hovering, setHovering] = useState(false);
	const agents = useMemo(() => railAgents(nodes, (_node, terminal) => placeOfTerminal(railNode.places, terminal), (_node, at) => placeWords(railNode.places.get(at))), [nodes, railNode]);
	const map = useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
	const inbox = useInbox(agents, undefined, hovering);
	const commands = useRef<PageCommands>({});
	return (
		<aside data-agent-list="">
			<AgentRail
				nodes={nodes}
				agents={map}
				inbox={inbox}
				currentNode="mac"
				currentPlace={place}
				railNodeOf={() => railNode}
				homeOf={() => "/home/me"}
				onHover={setHovering}
				onAgent={(key) => (calls.agent ??= []).push([key])}
				onNode={() => {}}
				onPlace={(node, at) => (calls.place ??= []).push([node, at])}
				canClosePane={(key) => !key.endsWith("gone")}
				onClosePane={(key) => (calls.closePane ??= []).push([key])}
				onKill={(key, confirm) => (calls.kill ??= []).push([key, confirm])}
				header={<h1>Agents</h1>}
				ops={makeOps(calls, capabilities)}
				commands={commands}
			/>
			<button
				type="button"
				data-run-command=""
				onClick={(event) => {
					const action = (event.currentTarget as HTMLElement).dataset.action as keyof PageCommands;
					commands.current[action]?.();
				}}
			/>
		</aside>
	);
}

/** Runs a page command the way the key dispatcher does, with focus where it is. */
function runCommand(container: HTMLElement, action: string) {
	const run = container.querySelector<HTMLElement>("[data-run-command]")!;
	run.dataset.action = action;
	fireEvent.click(run);
}

const menuFor = (attribute: string, value: string) => [...document.querySelectorAll(`[${attribute}]`)].find((element) => element.getAttribute(attribute) === value)!;
const items = (menu: Element) => [...menu.querySelectorAll("[data-menu-item]")].map((item) => item.getAttribute("data-menu-item"));
/** A right click: a press, then the context menu at the pointer. */
const openMenu = (row: Element) => {
	fireEvent.pointerDown(row, { button: 2 });
	fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
};

describe("the rail's menus as data", () => {
	const noop = () => {};
	const agentRun = { focus: noop, rename: noop, markRead: noop, markUnread: noop, split: noop, restart: noop, copyCwd: noop, copySessionId: noop, closePane: noop, kill: noop, remove: noop };
	/** Items by id, separators as "|", headers as "#label", notes as "!text". */
	const ids = (entries: readonly MenuEntry[]) =>
		entries.map((entry) => (entry === "separator" ? "|" : "kind" in entry ? (entry.kind === "header" ? `#${entry.label}` : `!${entry.text}`) : entry.id));
	const find = (entries: readonly MenuEntry[], id: string) => menuItems(entries).find((entry) => entry.id === id);

	it("offers a live agent focus, rename, unread, splits, copies, close and kill; an exited one restart and remove", () => {
		const live = { nodeName: "mac", exited: false, hasPane: true, unread: false, section: "working" as const, sessionId: "s1", connected: true, canRename: true, canUnread: true };
		expect(ids(agentMenu(live, agentRun))).toEqual(["focus", "rename", "mark-unread", "|", "split-right", "split-down", "|", "copy-cwd", "copy-session", "|", "close-pane", "kill"]);
		const kill = find(agentMenu(live, agentRun), "kill");
		expect(kill).toMatchObject({ label: "Kill…", danger: true });
		const idle = find(agentMenu({ ...live, section: "quiet" }, agentRun), "kill");
		expect(idle).toMatchObject({ label: "Kill" });
		expect(ids(agentMenu({ ...live, unread: true }, agentRun))).toContain("mark-read");
		const exited = { ...live, exited: true, hasPane: false, sessionId: undefined };
		delete (exited as { sessionId?: string }).sessionId;
		expect(ids(agentMenu(exited, agentRun))).toEqual(["focus", "rename", "|", "restart", "|", "copy-cwd", "|", "remove"]);
	});

	const checkoutRun = { rename: noop, settings: noop, reveal: noop, copyPath: noop, keep: noop, hide: noop };
	const worktreeRun = { newTerminal: noop, newAgent: noop, reveal: noop, copyPath: noop, copyBranch: noop, remove: noop };
	const projectRun = { newWorktree: noop, rename: noop, fold: noop, copyRepository: noop };
	const repo = gitCheckout("a", "/home/me/repo");
	const clone = gitCheckout("b", "/home/me/src/repo");
	/** A bare repository: git, but no main worktree to branch from (its linked worktrees are not one). */
	const bare = gitCheckout("c", "/srv/repo.git", { worktrees: [worktree("/srv/repo-fix", "fix")] });
	const notes = folderCheckout("d", "/home/me/notes");
	const checkoutState = { nodeName: "mac", connected: true, canCheckouts: true, checkout: repo, configured: false };
	const projectState = { nodeName: "mac", connected: true, canCheckouts: true, persisted: true, collapsed: false, repository: "https://github.com/me/repo", worktreeFrom: [{ checkout: repo, label: "~/repo" }] };

	it("gives a project heading its worktree, rename, folding, and repository URL; with one checkout, the checkout's items too", () => {
		expect(ids(projectMenu(projectState, projectRun))).toEqual(["new-worktree", "|", "rename", "fold", "|", "copy-repository"]);
		expect(find(projectMenu(projectState, projectRun), "rename")).toMatchObject({ label: "Rename Project…" });
		// A project the server has no key for keeps no name: no rename; a folder makes no worktrees and has no URL.
		expect(ids(projectMenu({ ...projectState, persisted: false, repository: undefined, worktreeFrom: [] }, projectRun))).toEqual(["fold"]);
		const single = projectMenu({ ...projectState, checkout: checkoutState }, { ...projectRun, checkout: checkoutRun });
		expect(ids(single)).toEqual(["new-worktree", "|", "rename", "rename-checkout", "settings", "fold", "|", "reveal", "copy-path", "copy-repository", "|", "keep", "hide"]);
		expect(find(single, "rename-checkout")).toMatchObject({ label: "Rename on mac…" });
		expect(find(single, "hide")).toMatchObject({ label: "Remove from Deck", danger: true });
		// Two checkouts that make worktrees: New Worktree asks which.
		const made: string[] = [];
		const two = projectMenu({ ...projectState, worktreeFrom: [{ checkout: repo, label: "~/repo" }, { checkout: clone, label: "~/src/repo" }] }, { ...projectRun, newWorktree: (id) => made.push(id) });
		const submenu = find(two, "new-worktree")!.submenu!;
		expect(ids(submenu)).toEqual([`new-worktree:${repo.id}`, `new-worktree:${clone.id}`]);
		menuItems(submenu)[1]!.run!();
		expect(made).toEqual([clone.id]);
	});

	it("hides New Worktree and Worktree Settings for a folder or a bare repository, which cannot make worktrees", () => {
		for (const checkout of [notes, bare]) {
			const alone = projectMenu({ ...projectState, worktreeFrom: [{ checkout, label: "~/x" }], checkout: { ...checkoutState, checkout } }, { ...projectRun, checkout: checkoutRun });
			expect(ids(alone)).not.toContain("new-worktree");
			expect(ids(alone)).not.toContain("settings");
			expect(ids(checkoutMenu({ ...checkoutState, checkout }, checkoutRun))).not.toContain("settings");
		}
		// Beside one that can, only that one is offered, without asking which.
		const made: string[] = [];
		const mixed = projectMenu({ ...projectState, worktreeFrom: [{ checkout: bare, label: "/srv/repo.git" }, { checkout: repo, label: "~/repo" }, { checkout: notes, label: "~/notes" }] }, { ...projectRun, newWorktree: (id) => made.push(id) });
		expect(find(mixed, "new-worktree")).toMatchObject({ label: "New Worktree…" });
		expect(find(mixed, "new-worktree")!.submenu).toBeUndefined();
		find(mixed, "new-worktree")!.run!();
		expect(made).toEqual([repo.id]);
		// The "+" on a folder's or a bare repository's place offers no worktree either.
		const plusRun = { newTerminal: noop, addCheckout: noop, newWorktree: noop, pair: noop };
		const mac = { id: "m", name: "mac", canCheckouts: true };
		for (const checkout of [notes, bare]) {
			const menu = addMenu({ nodes: [mac], offline: [], unpaired: [], current: { node: "m", place: { place: `${checkout.id}:${checkout.path}`, name: "x", checkout } } }, plusRun);
			expect(menuItems(menu).map((entry) => entry.id)).toEqual(["new-terminal", "new-agent", "add-checkout"]);
		}
	});

	it("gives a checkout its names, settings, place, and Keep or Remove from Deck; a folder has no settings", () => {
		expect(ids(checkoutMenu(checkoutState, checkoutRun))).toEqual(["rename-checkout", "settings", "|", "reveal", "copy-path", "|", "keep", "hide"]);
		// One added by hand is kept already.
		expect(ids(checkoutMenu({ ...checkoutState, checkout: notes, configured: true }, checkoutRun))).toEqual(["rename-checkout", "|", "reveal", "copy-path", "|", "hide"]);
	});

	it("gives a worktree card terminals, its path and branch, and removal only for a linked worktree", () => {
		const linked = { nodeName: "mac", connected: true, canCheckouts: true, linked: true, branch: "fix", prunable: false };
		expect(ids(worktreeMenu(linked, worktreeRun))).toEqual(["new-terminal", "new-agent", "|", "reveal", "copy-path", "copy-branch", "|", "remove-worktree"]);
		expect(find(worktreeMenu(linked, worktreeRun), "remove-worktree")).toMatchObject({ label: "Remove Worktree…", danger: true });
		const main = { ...linked, linked: false };
		expect(ids(worktreeMenu(main, worktreeRun))).toEqual(["new-terminal", "new-agent", "|", "reveal", "copy-path", "copy-branch"]);
		// A detached worktree has no branch to copy; a prunable one has no folder to start in.
		const { branch: _branch, ...detached } = linked;
		expect(ids(worktreeMenu({ ...detached, prunable: true }, worktreeRun))).toEqual(["copy-path", "|", "remove-worktree"]);
		expect(ids(otherMenu({ nodeName: "mac", connected: true, folded: false }, { newTerminal: noop, newAgent: noop, fold: noop }))).toEqual(["new-terminal", "new-agent", "|", "fold"]);
	});

	it("disables what an older pika-node cannot do, saying why once", () => {
		const old = { nodeName: "node01", exited: false, hasPane: true, unread: false, section: "quiet" as const, connected: true, canRename: false, canUnread: false };
		expect(find(agentMenu(old, agentRun), "rename")).toMatchObject({ disabled: true, reason: "Update pika-node on node01 to use this" });
		expect(find(agentMenu(old, agentRun), "rename")).not.toHaveProperty("detail");
		const nodeRun = { newTerminal: noop, addCheckout: noop, copyFingerprint: noop, repair: noop, fold: noop };
		const node = nodeMenu({ nodeName: "node01", connected: true, canCheckouts: false, pinned: true, foldable: false, folded: false }, nodeRun);
		expect(find(node, "add-checkout")).toMatchObject({ disabled: true, reason: "Update pika-node on node01 to use this" });
		expect(find(node, "new-terminal")).not.toHaveProperty("disabled");
	});

	it("leaves out what a node that is not connected cannot do, and says so once", () => {
		const offline = { nodeName: "node01", exited: false, hasPane: true, unread: false, section: "working" as const, sessionId: "s1", connected: false, canRename: true, canUnread: true };
		expect(ids(agentMenu(offline, agentRun))).toEqual(["focus", "|", "copy-cwd", "copy-session", "|", "!node01 is not connected"]);
		expect(ids(projectMenu({ ...projectState, nodeName: "node01", connected: false, checkout: { ...checkoutState, connected: false } }, { ...projectRun, checkout: checkoutRun }))).toEqual([
			"rename",
			"fold",
			"|",
			"copy-path",
			"copy-repository",
			"|",
			"!node01 is not connected",
		]);
		expect(ids(worktreeMenu({ nodeName: "node01", connected: false, canCheckouts: true, linked: true, branch: "fix", prunable: false }, worktreeRun))).toEqual([
			"copy-path",
			"copy-branch",
			"|",
			"!node01 is not connected",
		]);
		const nodeRun = { newTerminal: noop, addCheckout: noop, copyFingerprint: noop, repair: noop, fold: noop };
		expect(ids(nodeMenu({ nodeName: "node01", connected: false, canCheckouts: true, pinned: true, foldable: false, folded: false }, nodeRun))).toEqual(["repair", "|", "!node01 is not connected"]);
		// No menu anywhere offers an item disabled only because the node is offline.
		for (const menu of [agentMenu(offline, agentRun), nodeMenu({ nodeName: "x", connected: false, canCheckouts: true, pinned: true, foldable: true, folded: false }, nodeRun), checkoutMenu({ ...checkoutState, connected: false }, checkoutRun)]) {
			expect(menuItems(menu).filter((entry) => entry.disabled)).toEqual([]);
		}
	});

	it("gives a node's menu its terminal, Add Repository, fingerprint, and re-pair", () => {
		const nodeRun = { newTerminal: noop, addCheckout: noop, copyFingerprint: noop, repair: noop, fold: noop };
		const menu = nodeMenu({ nodeName: "mac", connected: true, canCheckouts: true, fingerprint: "ab", pinned: true, foldable: true, folded: false }, nodeRun);
		expect(ids(menu)).toEqual(["new-terminal", "add-checkout", "|", "copy-fingerprint", "repair", "|", "fold"]);
		// A node this browser never pinned has no fingerprint to copy: the item is left out, not disabled.
		expect(ids(nodeMenu({ nodeName: "mac", connected: true, canCheckouts: true, pinned: false, foldable: false, folded: false }, nodeRun))).toEqual(["new-terminal", "add-checkout"]);
	});
});

describe("the rail's + menu", () => {
	const made: unknown[][] = [];
	const run = {
		newTerminal: (...args: unknown[]) => void made.push(["terminal", ...args]),
		addCheckout: (...args: unknown[]) => void made.push(["add", ...args]),
		newWorktree: (...args: unknown[]) => void made.push(["worktree", ...args]),
		pair: (...args: unknown[]) => void made.push(["pair", ...args]),
	};
	const mac = { id: "m", name: "mac", canCheckouts: true };
	const node01 = { id: "n", name: "node01", canCheckouts: true };
	const ids = (entries: readonly MenuEntry[]) =>
		entries.map((entry) => (entry === "separator" ? "|" : "kind" in entry ? (entry.kind === "header" ? `#${entry.label}` : `!${entry.text}`) : entry.submenu ? `${entry.id}>` : entry.id));
	const plus = (state: Partial<AddMenuState>) => addMenu({ nodes: [], offline: [], unpaired: [], ...state }, run);
	beforeEach(() => void made.splice(0));

	it("uses the only connected node without asking, and makes things in its home", () => {
		const menu = plus({ nodes: [mac] });
		expect(ids(menu)).toEqual(["new-terminal", "new-agent", "|", "add-checkout"]);
		menuItems(menu)[0]!.run!();
		expect(made).toEqual([["terminal", "m", undefined, false]]);
	});

	it("defaults to the worktree on screen, names where things land, and offers a new worktree of its checkout", () => {
		const menu = plus({ nodes: [mac], current: { node: "m", place: { place: "c:/p/atlas", name: "atlas · main", checkout: { ...gitCheckout("c", "/p/atlas"), id: "c" } } } });
		expect(ids(menu)).toEqual(["#atlas · main · mac", "new-terminal", "new-agent", "new-worktree", "|", "add-checkout"]);
		menuItems(menu).find((entry) => entry.id === "new-agent")!.run!();
		menuItems(menu).find((entry) => entry.id === "new-worktree")!.run!();
		expect(made).toEqual([
			["terminal", "m", "c:/p/atlas", true],
			["worktree", "m", "c"],
		]);
		// A folder makes no worktrees.
		expect(ids(plus({ nodes: [mac], current: { node: "m", place: { place: "f:/p/notes", name: "notes", checkout: folderCheckout("f", "/p/notes") } } }))).not.toContain("new-worktree");
	});

	it("groups several connected nodes under their names when none is on screen, so one choice picks both", () => {
		const menu = plus({ nodes: [mac, node01] });
		expect(ids(menu)).toEqual(["#mac", "m:new-terminal", "m:new-agent", "m:add-checkout", "|", "#node01", "n:new-terminal", "n:new-agent", "n:add-checkout"]);
		menuItems(menu).find((entry) => entry.id === "n:add-checkout")!.run!();
		expect(made).toEqual([["add", "n"]]);
		// Many nodes become one submenu each.
		const many = plus({ nodes: ["a", "b", "c", "d", "e"].map((id) => ({ ...mac, id, name: id })) });
		expect(ids(many)).toEqual(["node:a>", "node:b>", "node:c>", "node:d>", "node:e>"]);
	});

	it("puts the node on screen first and the other connected nodes in submenus", () => {
		const menu = plus({ nodes: [mac, node01], current: { node: "n" } });
		expect(ids(menu)).toEqual(["#node01", "new-terminal", "new-agent", "|", "add-checkout", "|", "#Other nodes", "node:m>"]);
		const other = menuItems(menu).find((entry) => entry.id === "node:m")!;
		expect(ids(other.submenu!)).toEqual(["new-terminal", "new-agent", "|", "add-checkout"]);
		menuItems(other.submenu!)[1]!.run!();
		expect(made).toEqual([["terminal", "m", undefined, true]]);
	});

	it("offers pairing, or says why, when no node is connected", () => {
		expect(ids(plus({ unpaired: [{ id: "m", name: "mac" }] }))).toEqual(["!No node is paired with this browser yet", "|", "pair:m"]);
		expect(ids(plus({ offline: ["mac", "node01"] }))).toEqual(["!mac and node01 are not connected"]);
		expect(ids(plus({}))).toEqual(["!No node is connected"]);
		menuItems(plus({ unpaired: [{ id: "m", name: "mac" }] }))[0]!.run!();
		expect(made).toEqual([["pair", "m"]]);
	});

	it("is never a list of disabled items, and gives each disabled one its own reason", () => {
		const old = { ...mac, canCheckouts: false };
		const states: Partial<AddMenuState>[] = [
			{},
			{ offline: ["mac"] },
			{ unpaired: [{ id: "m", name: "mac" }] },
			{ nodes: [old] },
			{ nodes: [old], current: { node: "m", place: { place: "c:/p", name: "p", checkout: gitCheckout("c", "/p") } } },
			{ nodes: [old, node01] },
			{ nodes: [old, node01], current: { node: "m" } },
		];
		for (const state of states) {
			const items = menuItems(plus(state));
			if (items.length) expect(items.some((entry) => !entry.disabled), JSON.stringify(state)).toBe(true);
			for (const entry of items.filter((entry) => entry.disabled)) expect(entry.reason).toBe("Update pika-node on mac to use this");
		}
	});
});

describe("the rail's operations", () => {
	let calls: Calls;
	beforeEach(() => {
		localStorage.clear();
		Element.prototype.scrollIntoView = () => {};
		calls = {};
	});
	afterEach(() => vi.useRealTimers());

	const projectsView = () => fireEvent.click(screen.getByRole("button", { name: "Projects" }));

	it("opens an agent's menu in both views and runs its items", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("busy", { state: "busy" }), pane("gone", { state: "idle", unread: true }, { exited: { code: 0, signal: null } })])]} calls={calls} />);
		openMenu(container.querySelector("[data-agent-row='busy']")!);
		const menu = menuFor("data-agent-menu", "mac\nbusy")!;
		expect(items(menu)).toEqual(["focus", "rename", "mark-unread", "split-right", "split-down", "copy-cwd", "close-pane", "kill"]);
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /Split Down/ }));
		expect(calls.split).toEqual([["mac\nbusy", "column"]]);
		openMenu(container.querySelector("[data-agent-row='busy']")!);
		fireEvent.click(within(document.querySelector("[data-agent-menu]") as HTMLElement).getByRole("menuitem", { name: /Kill/ }));
		// Working: Kill asks first.
		expect(calls.kill).toEqual([["mac\nbusy", true]]);

		projectsView();
		openMenu(container.querySelector("[data-agent-row='gone']")!);
		const exited = menuFor("data-agent-menu", "mac\ngone")!;
		expect(items(exited)).toEqual(["focus", "rename", "mark-read", "restart", "copy-cwd", "remove"]);
		fireEvent.click(within(exited as HTMLElement).getByRole("menuitem", { name: /Restart/ }));
		expect(calls.restart).toEqual([["mac\ngone"]]);
		openMenu(container.querySelector("[data-agent-row='gone']")!);
		fireEvent.click(within(document.querySelector("[data-agent-menu]") as HTMLElement).getByRole("menuitem", { name: /Mark as Read/ }));
		expect(calls.markRead).toEqual([["mac\ngone"]]);
	});

	it("renames an agent in place: Enter commits, Escape gives up", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("busy", { state: "busy" })])]} calls={calls} />);
		const row = container.querySelector<HTMLElement>("[data-agent-row='busy']")!;
		row.focus();
		const keymap = buildKeymap(undefined, true);
		expect(resolveKey(keymap, { key: "F2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, focusOf(row))).toBe("rail.rename");
		// The page runs the command F2 resolves to; it acts on the row with focus (a click does not move focus in jsdom).
		runCommand(container, "rail.rename");
		const field = container.querySelector<HTMLInputElement>("[data-inline-rename]")!;
		expect(field.value).toBe("busy");
		fireEvent.change(field, { target: { value: "Reviewer" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(calls.renameAgent).toEqual([["mac\nbusy", "Reviewer"]]);
		expect(container.querySelector("[data-inline-rename]")).toBeNull();

		openMenu(row);
		fireEvent.click(within(document.querySelector("[data-agent-menu]") as HTMLElement).getByRole("menuitem", { name: /Rename/ }));
		const again = container.querySelector<HTMLInputElement>("[data-inline-rename]")!;
		fireEvent.change(again, { target: { value: "Other" } });
		fireEvent.keyDown(again, { key: "Escape" });
		expect(calls.renameAgent).toHaveLength(1);
	});

	const HEADING = `project:mac\nrepo:${REPO.repository}`;
	const card = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`[data-worktree-card='${path}'] [data-worktree-open]`)!;

	it("nests project, worktree cards (main first, branch as meta), and agents; a card opens its place", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy" }), pane("w", { state: "idle" }, { cwd: "/home/me/repo-fix" })])]} calls={calls} />);
		projectsView();
		const project = container.querySelector<HTMLElement>("[data-project]")!;
		expect(project.querySelector("[data-project-name]")!.textContent).toBe("repo");
		// One checkout of the project on the node: the heading stands for it, with its path; no checkout row.
		expect(project.querySelector("[data-project-heading]")!.textContent).toContain("~/repo");
		expect(project.querySelector("[data-checkout-row]")).toBeNull();
		const cards = [...project.querySelectorAll("[data-worktree-card]")];
		expect(cards.map((item) => item.getAttribute("data-worktree-card"))).toEqual(["/home/me/repo", "/home/me/repo-fix"]);
		expect(cards.map((item) => item.querySelector("[data-worktree-meta]")?.textContent)).toEqual(["main", "fix"]);
		expect(cards[0]!.querySelector("[data-worktree-open]")!.hasAttribute("data-main")).toBe(true);
		expect([...cards[1]!.querySelectorAll("[data-agent-row]")].map((row) => row.getAttribute("data-agent-row"))).toEqual(["w"]);
		expect(card(container, "/home/me/repo").getAttribute("aria-current")).toBe("true");
		fireEvent.click(card(container, "/home/me/repo-fix"));
		expect(calls.place).toEqual([["mac", FIX]]);
		// The heading folds the project on the server (the page's operation).
		fireEvent.click(project.querySelector("[data-project-heading]")!);
		expect(calls.setCollapsed).toEqual([[RAIL.projects[0], true]]);
	});

	it("gives the project heading, worktree cards, and Other their menus; F2 renames, Delete removes", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy" }), pane("x", { state: "idle" }, { cwd: "/srv" })])]} calls={calls} />);
		projectsView();
		const heading = container.querySelector<HTMLElement>("[data-project-heading]")!;
		openMenu(heading);
		const menu = menuFor("data-project-menu", HEADING)!;
		expect(items(menu)).toEqual(["new-worktree", "rename", "rename-checkout", "settings", "fold", "reveal", "copy-path", "copy-repository", "keep", "hide"]);
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /New Worktree/ }));
		expect(calls.newWorktree).toEqual([["mac", REPO.id]]);
		fireEvent.click(container.querySelector<HTMLElement>("[data-project] [data-card-more]")!);
		fireEvent.click(within(document.querySelector("[data-project-menu]") as HTMLElement).getByRole("menuitem", { name: /Worktree Settings/ }));
		expect(calls.checkoutSettings).toEqual([["mac", REPO]]);

		// The linked worktree offers its removal; the main one does not.
		openMenu(card(container, "/home/me/repo-fix"));
		const fixMenu = menuFor("data-worktree-menu", `place:mac\n${FIX}`)!;
		expect(items(fixMenu)).toEqual(["new-terminal", "new-agent", "reveal", "copy-path", "copy-branch", "remove-worktree"]);
		fireEvent.click(within(fixMenu as HTMLElement).getByRole("menuitem", { name: /New pi Agent/ }));
		expect(calls.newTerminal).toEqual([["mac", FIX, true]]);
		openMenu(card(container, "/home/me/repo"));
		expect(items(menuFor("data-worktree-menu", `place:mac\n${MAIN}`)!)).not.toContain("remove-worktree");
		fireEvent.keyDown(document.querySelector("[data-worktree-menu]")!, { key: "Escape" });

		// A terminal in no listed worktree is under Other.
		const other = container.querySelector<HTMLElement>(`[data-worktree-card='${OTHER}']`)!;
		expect([...other.querySelectorAll("[data-agent-row]")].map((row) => row.getAttribute("data-agent-row"))).toEqual(["x"]);
		openMenu(other.querySelector("[data-worktree-open]")!);
		expect(items(menuFor("data-worktree-menu", `place:mac\n${OTHER}`)!)).toEqual(["new-terminal", "new-agent", "fold"]);
		fireEvent.keyDown(document.querySelector("[data-worktree-menu]")!, { key: "Escape" });

		// Keys on the focused row.
		card(container, "/home/me/repo-fix").focus();
		runCommand(container, "rail.remove");
		expect(calls.removeWorktree).toHaveLength(1);
		expect(calls.removeWorktree![0]!.slice(0, 2)).toEqual(["mac", REPO]);
		expect((calls.removeWorktree![0]![2] as { path: string }).path).toBe("/home/me/repo-fix");
		heading.focus();
		runCommand(container, "rail.remove");
		expect(calls.hideCheckout).toEqual([["mac", REPO]]);
		const renameKey = { key: "F2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
		expect(resolveKey(buildKeymap(undefined, true), renameKey, focusOf(heading))).toBe("rail.rename");
		runCommand(container, "rail.rename");
		const field = container.querySelector<HTMLInputElement>("[data-inline-rename]")!;
		expect(field.value).toBe("repo");
		fireEvent.change(field, { target: { value: "Atlas" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(calls.renameProject).toEqual([[RAIL.projects[0], "Atlas"]]);

		// Rename on the node, from the heading's menu.
		openMenu(container.querySelector("[data-project-heading]")!);
		fireEvent.click(within(document.querySelector("[data-project-menu]") as HTMLElement).getByRole("menuitem", { name: /Rename on mac/ }));
		const onNode = container.querySelector<HTMLInputElement>("[data-inline-rename]")!;
		fireEvent.change(onNode, { target: { value: "repo (mac)" } });
		fireEvent.blur(onNode);
		expect(calls.renameCheckout).toEqual([["mac", REPO, "repo (mac)"]]);
	});

	it("shows each checkout's path when two checkouts share a project, and git's markers on cards", () => {
		const clone = gitCheckout("b", "/home/me/src/repo", {
			source: "configured",
			linked: [worktree("/home/me/src/repo-old", undefined, { locked: true }), worktree("/home/me/src/repo-gone", "gone", { prunable: true })],
		});
		const two = rail("mac", [REPO, clone]);
		expect(two.projects).toHaveLength(1);
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy" })])]} calls={calls} railNode={two} />);
		projectsView();
		const rows = [...container.querySelectorAll("[data-checkout-row]")];
		expect(rows.map((row) => row.querySelector("[data-checkout-path]")!.textContent)).toEqual(["~/repo", "~/src/repo"]);
		expect(container.querySelector("[data-project-heading]")!.textContent).not.toContain("~/");
		const old = container.querySelector("[data-worktree-card='/home/me/src/repo-old']")!;
		expect([...old.querySelectorAll("[data-worktree-mark]")].map((mark) => mark.getAttribute("data-worktree-mark"))).toEqual(["detached", "locked"]);
		expect(old.querySelector("[data-worktree-meta]")!.textContent).toBe("0123456");
		expect(container.querySelector("[data-worktree-card='/home/me/src/repo-gone'] [data-worktree-mark='prunable']")).not.toBeNull();
		openMenu(rows[1]!);
		const menu = menuFor("data-checkout-menu", `checkout:mac\n${clone.id}`)!;
		// Added by hand: nothing to keep.
		expect(items(menu)).toEqual(["rename-checkout", "settings", "reveal", "copy-path", "hide"]);
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /Remove from Deck/ }));
		expect(calls.hideCheckout).toEqual([["mac", clone]]);
		// With two checkouts the heading's New Worktree asks which.
		openMenu(container.querySelector("[data-project-heading]")!);
		const heading = menuFor("data-project-menu", HEADING)!;
		expect(items(heading)).toEqual(["new-worktree", "rename", "fold", "copy-repository"]);
	});

	it("filters by name, worktree and project, node, and folder; Escape clears", () => {
		const nodes = [node("mac", [pane("alpha", { state: "busy" }), pane("beta", { state: "waiting" }, { cwd: "/srv/data" })]), node("node01", [pane("gamma", { state: "busy" }, { cwd: "/home/me/repo" })])];
		const { container } = render(<Harness nodes={nodes} calls={calls} />);
		const filter = container.querySelector<HTMLInputElement>("[data-rail-filter]")!;
		const shown = () => [...container.querySelectorAll("[data-agent-row]")].map((row) => row.getAttribute("data-agent-row")).sort();
		fireEvent.change(filter, { target: { value: "alp" } });
		expect(shown()).toEqual(["alpha"]);
		fireEvent.change(filter, { target: { value: "node01" } });
		expect(shown()).toEqual(["gamma"]);
		fireEvent.change(filter, { target: { value: "/srv" } });
		expect(shown()).toEqual(["beta"]);
		fireEvent.change(filter, { target: { value: "repo" } });
		expect(shown()).toEqual(["alpha", "gamma"]);
		fireEvent.change(filter, { target: { value: "zzz" } });
		expect(container.querySelector("[data-no-matches]")!.textContent).toContain("zzz");
		fireEvent.keyDown(filter, { key: "Escape" });
		expect(filter.value).toBe("");
		expect(shown()).toEqual(["alpha", "beta", "gamma"]);
		// The filter is a text field: "/" is typed there, not taken.
		expect(resolveKey(buildKeymap(undefined, true), { key: "/", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, focusOf(filter))).toBeUndefined();
		const row = container.querySelector<HTMLElement>("[data-agent-row]")!;
		expect(resolveKey(buildKeymap(undefined, true), { key: "/", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, focusOf(row))).toBe("rail.find");
		const agent = { key: "k", node: nodes[0]!, terminal: { ...nodes[0]!.terminals[0]!, cwd: "/x" }, place: MAIN, where: "main · repo" };
		expect(agentMatches(agent, "REPO")).toBe(true);
		expect(agentMatches(agent, "MAIN ·")).toBe(true);
		// The project's name finds the project, with all its agents.
		fireEvent.change(filter, { target: { value: "fix" } });
		projectsView();
		expect(container.querySelector("[data-worktree-card='/home/me/repo-fix']")).not.toBeNull();
	});

	it("offers New and Add Repository from the + menu, and Add Repository in a node with none", () => {
		const { container, unmount } = render(<Harness nodes={[node("mac", [])]} calls={calls} />);
		fireEvent.click(container.querySelector<HTMLElement>("[data-rail-add]")!);
		const menu = document.querySelector("[data-add-menu]")!;
		expect(items(menu)).toEqual(["new-terminal", "new-agent", "new-worktree", "add-checkout"]);
		expect(menu.querySelector("[data-menu-header]")!.textContent).toBe("repo · main · mac");
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /New Worktree/ }));
		expect(calls.newWorktree).toEqual([["mac", REPO.id]]);
		unmount();
		const empty = render(<Harness nodes={[node("mac", [])]} calls={calls} railNode={rail("mac", [])} place={OTHER} />);
		fireEvent.click(empty.container.querySelector<HTMLElement>("[data-rail-add]")!);
		const plain = document.querySelector("[data-add-menu]")!;
		expect(items(plain)).toEqual(["new-terminal", "new-agent", "add-checkout"]);
		fireEvent.click(within(plain as HTMLElement).getByRole("menuitem", { name: /Add Repository/ }));
		expect(calls.addCheckout).toEqual([["mac"]]);
		const container2 = empty.container;
		projectsView();
		fireEvent.click(container2.querySelector<HTMLElement>("[data-empty-add-checkout]")!);
		expect(calls.addCheckout).toHaveLength(2);
		openMenu(container2.querySelector("[data-node-projects='mac'] [data-node]")!);
		expect(items(document.querySelector("[data-node-menu]")!)).toEqual(["new-terminal", "add-checkout", "copy-fingerprint", "repair", "fold"]);
	});

	it("shows an older daemon's items disabled, with the reason beside the menu while highlighted", async () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("busy", { state: "busy" })])]} calls={calls} capabilities={[]} />);
		openMenu(container.querySelector("[data-agent-row='busy']")!);
		const menu = document.querySelector<HTMLElement>("[data-agent-menu]")!;
		const rename = menu.querySelector<HTMLButtonElement>("[data-menu-item='rename']")!;
		expect(rename.getAttribute("aria-disabled")).toBe("true");
		// Once, not as a line under the item; assistive technology reads it as the item's description.
		expect(rename.textContent).not.toContain("Update pika-node");
		expect(document.getElementById(rename.getAttribute("aria-describedby")!)!.textContent).toBe("Update pika-node on mac to use this");
		expect(document.querySelector("[data-menu-reason]")).toBeNull();
		// Opened by the pointer, nothing is highlighted: the first ArrowDown takes Focus, the next the disabled Rename.
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.getAttribute("data-menu-item")).toBe("focus");
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement).toBe(rename);
		await waitFor(() => expect(document.querySelector("[data-menu-reason]")!.textContent).toBe("Update pika-node on mac to use this"));
		fireEvent.click(rename);
		expect(calls.renameAgent).toBeUndefined();
		expect(document.querySelector("[data-agent-menu]")).not.toBeNull();
		// Mark as Unread needs the newer daemon too; Split Right does not.
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.getAttribute("data-menu-item")).toBe("mark-unread");
		expect(document.querySelector("[data-menu-reason]")).not.toBeNull();
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.getAttribute("data-menu-item")).toBe("split-right");
		await waitFor(() => expect(document.querySelector("[data-menu-reason]")).toBeNull());

		// A disabled destructive item (Remove from Deck) is drawn disabled, not red; an enabled one stays red.
		fireEvent.keyDown(menu, { key: "Escape" });
		projectsView();
		openMenu(container.querySelector("[data-project-heading]")!);
		const card = menuFor("data-project-menu", HEADING)!;
		const remove = card.querySelector("[data-menu-item='hide']")!;
		expect(remove.getAttribute("aria-disabled")).toBe("true");
		expect(remove.getAttribute("data-variant")).toBe("default");
		fireEvent.keyDown(card, { key: "Escape" });
		openMenu(container.querySelector("[data-agent-row='busy']")!);
		expect(menuFor("data-agent-menu", "mac\nbusy")!.querySelector("[data-menu-item='kill']")!.getAttribute("data-variant")).toBe("destructive");
	});

});

describe("Add Repository", () => {
	it("splits, expands, and matches typed paths", () => {
		expect(expandHome("~", "/home/me")).toBe("/home/me");
		expect(expandHome("~/src", "/home/me")).toBe("/home/me/src");
		expect(expandHome("/srv", "/home/me")).toBe("/srv");
		expect(expandHome("src", "/home/me")).toBeUndefined();
		expect(completionParts("~/co")).toEqual({ dir: "~/", prefix: "co" });
		expect(completionParts("/")).toEqual({ dir: "/", prefix: "" });
		expect(matchFolders(["Code", ".config", "docs"], "c")).toEqual(["Code"]);
		expect(matchFolders(["Code", ".config", "docs"], ".c")).toEqual([".config"]);
	});

	it("completes folders from the node, adds on Enter, and shows the node's error in place", async () => {
		const listed: string[] = [];
		const added: string[] = [];
		const listFolders = async (dir: string) => {
			listed.push(dir);
			return dir === "/home/me" ? ["Code", "docs", ".cache"] : dir === "/home/me/Code" ? ["pika"] : [];
		};
		const onAdd = async (path: string) => {
			added.push(path);
			if (path.endsWith("missing")) throw new Error("not_found: no directory /home/me/missing");
		};
		render(<AddCheckoutDialog nodeName="mac" home="/home/me" listFolders={listFolders} onAdd={onAdd} onCancel={() => {}} />);
		const field = document.querySelector<HTMLInputElement>("[data-add-checkout-path]")!;
		await waitFor(() => expect(document.querySelectorAll("[data-folder]")).toHaveLength(2));
		expect(listed).toEqual(["/home/me"]);
		fireEvent.change(field, { target: { value: "~/C" } });
		await waitFor(() => expect([...document.querySelectorAll("[data-folder]")].map((item) => item.getAttribute("data-folder"))).toEqual(["Code"]));
		fireEvent.keyDown(field, { key: "Tab" });
		expect(field.value).toBe("~/Code/");
		await waitFor(() => expect(document.querySelector("[data-folder='pika']")).not.toBeNull());
		fireEvent.keyDown(field, { key: "ArrowDown" });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(field.value).toBe("~/Code/pika/");
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(added).toEqual(["/home/me/Code/pika"]));

		fireEvent.change(field, { target: { value: "~/missing" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("no directory"));
		fireEvent.change(field, { target: { value: "relative" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("absolute path"));
	});
});

describe("the undo notice", () => {
	afterEach(() => vi.useRealTimers());

	it("offers Undo for five seconds, held while hovered", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const done = vi.fn();
		const undo = vi.fn();
		render(<UndoToast notice={{ id: 1, message: "Removed repo from Deck", undo }} onDone={done} />);
		const toast = document.querySelector<HTMLElement>("[data-undo-notice]")!;
		expect(toast.textContent).toContain("Removed repo from Deck");
		act(() => vi.advanceTimersByTime(UNDO_MS - 1_000));
		// Base UI holds every toast's timer while the pointer is on their viewport.
		const viewport = toast.closest<HTMLElement>("[data-slot='toast-viewport']")!;
		fireEvent.mouseEnter(viewport);
		act(() => vi.advanceTimersByTime(10_000));
		expect(done).not.toHaveBeenCalled();
		fireEvent.mouseLeave(viewport);
		act(() => vi.advanceTimersByTime(1_100));
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("runs the undo and closes", async () => {
		const done = vi.fn();
		const undo = vi.fn(async () => {});
		render(<UndoToast notice={{ id: 2, message: "Removed", undo }} onDone={done} />);
		fireEvent.click(document.querySelector<HTMLElement>("[data-undo]")!);
		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(undo).toHaveBeenCalledTimes(1);
	});
});

describe("terminal names", () => {
	it("puts the user's name first and cleans it", () => {
		const named = cleanTerminal(pane("t", { state: "idle", bridgeConnected: true, bridge: { state: "idle", activities: [], activityCount: 0, session: { id: "s", name: "session", cwd: "/" }, updatedAt: 1 } }, { label: "Mine\u001b[31m" }));
		expect(named.label).toBe("Mine");
		expect(paneLabel(named)).toBe("Mine");
		expect(paneLabel(cleanTerminal({ ...named, label: "" }))).toBe("session");
	});
});
