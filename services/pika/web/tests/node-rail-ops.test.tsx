import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeView } from "../src/nodes/client";
import { cleanTerminal, paneLabel } from "../src/nodes/client";
import type { PaneView, Project, TerminalInfo } from "../src/nodes/contract";
import { AddProjectDialog, completionParts, expandHome, matchFolders, UNDO_MS, UndoToast } from "../src/nodes/deck/RailDialogs";
import { buildKeymap, focusOf, resolveKey, type PageCommands } from "../src/nodes/keys";
import { AgentRail, agentMatches, railAgents, useInbox, type RailOps } from "../src/nodes/workspace/AgentRail";
import { menuItems, type MenuEntry } from "../src/nodes/deck/Menu";
import { addMenu, agentMenu, nodeMenu, projectMenu, type AddMenuState } from "../src/nodes/workspace/rail-menus";
import { OTHER } from "../src/nodes/workspace/store";

const pane = (id: string, status?: Partial<PaneView>, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
	terminalId: id,
	title: id,
	cwd: "/home/me/repo",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: ["pi"],
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

const PROJECTS: Project[] = [
	{ name: "repo", path: "/home/me/repo" },
	{ name: "repo-fix", path: "/home/me/repo-fix", worktree: "/home/me/repo" },
];

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
		addProject: record("addProject"),
		newWorktree: record("newWorktree"),
		revealProject: record("revealProject"),
		removeProject: record("removeProject"),
		removeWorktree: record("removeWorktree"),
		renameProject: record("renameProject"),
		renameAgent: record("renameAgent"),
		markRead: record("markRead"),
		markUnread: record("markUnread"),
		split: record("split"),
		restart: record("restart"),
		repair: record("repair"),
	};
}

const ALL = ["projects.edit", "git.worktree", "term.rename", "pane.unread"];

function Harness({ nodes, calls, capabilities = ALL, projects = PROJECTS }: { nodes: NodeView[]; calls: Calls; capabilities?: readonly string[]; projects?: Project[] }) {
	const [hovering, setHovering] = useState(false);
	const agents = useMemo(() => railAgents(nodes, (_node, terminal) => (terminal.cwd.startsWith("/home/me/repo-fix") ? "/home/me/repo-fix" : terminal.cwd.startsWith("/home/me/repo") ? "/home/me/repo" : OTHER)), [nodes]);
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
				currentProject="/home/me/repo"
				projectsOf={() => projects}
				homeOf={() => "/home/me"}
				onHover={setHovering}
				onAgent={(key) => (calls.agent ??= []).push([key])}
				onNode={() => {}}
				onProject={() => {}}
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

	it("disables what an older pika-node cannot do, saying why once", () => {
		const old = { nodeName: "node01", exited: false, hasPane: true, unread: false, section: "quiet" as const, connected: true, canRename: false, canUnread: false };
		expect(find(agentMenu(old, agentRun), "rename")).toMatchObject({ disabled: true, reason: "Update pika-node on node01 to use this" });
		expect(find(agentMenu(old, agentRun), "rename")).not.toHaveProperty("detail");
		const projectRun = { newTerminal: noop, newAgent: noop, newWorktree: noop, reveal: noop, copyPath: noop, rename: noop, fold: noop, remove: noop, removeWorktree: noop };
		const card = projectMenu({ nodeName: "node01", other: false, worktree: false, folded: false, connected: true, canEdit: false, canWorktree: false }, projectRun);
		for (const id of ["new-worktree", "rename", "remove"]) expect(find(card, id)).toMatchObject({ disabled: true, reason: "Update pika-node on node01 to use this" });
		expect(find(card, "new-terminal")).not.toHaveProperty("disabled");
	});

	it("leaves out what a node that is not connected cannot do, and says so once", () => {
		const offline = { nodeName: "node01", exited: false, hasPane: true, unread: false, section: "working" as const, sessionId: "s1", connected: false, canRename: true, canUnread: true };
		expect(ids(agentMenu(offline, agentRun))).toEqual(["focus", "|", "copy-cwd", "copy-session", "|", "!node01 is not connected"]);
		const projectRun = { newTerminal: noop, newAgent: noop, newWorktree: noop, reveal: noop, copyPath: noop, rename: noop, fold: noop, remove: noop, removeWorktree: noop };
		expect(ids(projectMenu({ nodeName: "node01", other: false, worktree: false, folded: false, connected: false, canEdit: true, canWorktree: true }, projectRun))).toEqual([
			"copy-path",
			"|",
			"fold",
			"|",
			"!node01 is not connected",
		]);
		const nodeRun = { newTerminal: noop, addProject: noop, copyFingerprint: noop, repair: noop, fold: noop };
		expect(ids(nodeMenu({ nodeName: "node01", connected: false, canEdit: true, pinned: true, foldable: false, folded: false }, nodeRun))).toEqual(["repair", "|", "!node01 is not connected"]);
		// No menu anywhere offers an item disabled only because the node is offline.
		for (const menu of [agentMenu(offline, agentRun), nodeMenu({ nodeName: "x", connected: false, canEdit: true, pinned: true, foldable: true, folded: false }, nodeRun)]) {
			expect(menuItems(menu).filter((entry) => entry.disabled)).toEqual([]);
		}
	});

	it("gives a node's menu its terminal, project, fingerprint, and re-pair; the Other card no rename or removal", () => {
		const nodeRun = { newTerminal: noop, addProject: noop, copyFingerprint: noop, repair: noop, fold: noop };
		const menu = nodeMenu({ nodeName: "mac", connected: true, canEdit: true, fingerprint: "ab", pinned: true, foldable: true, folded: false }, nodeRun);
		expect(ids(menu)).toEqual(["new-terminal", "add-project", "|", "copy-fingerprint", "repair", "|", "fold"]);
		// A node this browser never pinned has no fingerprint to copy: the item is left out, not disabled.
		expect(ids(nodeMenu({ nodeName: "mac", connected: true, canEdit: true, pinned: false, foldable: false, folded: false }, nodeRun))).toEqual(["new-terminal", "add-project"]);
		const projectRun = { newTerminal: noop, newAgent: noop, newWorktree: noop, reveal: noop, copyPath: noop, rename: noop, fold: noop, remove: noop, removeWorktree: noop };
		expect(ids(projectMenu({ nodeName: "mac", other: true, worktree: false, folded: false, connected: true, canEdit: true, canWorktree: true }, projectRun))).toEqual(["new-terminal", "new-agent", "|", "fold"]);
		expect(ids(projectMenu({ nodeName: "mac", other: false, worktree: true, folded: true, connected: true, canEdit: true, canWorktree: true }, projectRun))).toEqual([
			"new-terminal",
			"new-agent",
			"new-worktree",
			"|",
			"reveal",
			"copy-path",
			"|",
			"rename",
			"fold",
			"|",
			"remove-worktree",
		]);
	});
});

describe("the rail's + menu", () => {
	const made: unknown[][] = [];
	const run = {
		newTerminal: (...args: unknown[]) => void made.push(["terminal", ...args]),
		addProject: (...args: unknown[]) => void made.push(["add", ...args]),
		newWorktree: (...args: unknown[]) => void made.push(["worktree", ...args]),
		pair: (...args: unknown[]) => void made.push(["pair", ...args]),
	};
	const mac = { id: "m", name: "mac", canEdit: true, canWorktree: true };
	const node01 = { id: "n", name: "node01", canEdit: true, canWorktree: true };
	const ids = (entries: readonly MenuEntry[]) =>
		entries.map((entry) => (entry === "separator" ? "|" : "kind" in entry ? (entry.kind === "header" ? `#${entry.label}` : `!${entry.text}`) : entry.submenu ? `${entry.id}>` : entry.id));
	const plus = (state: Partial<AddMenuState>) => addMenu({ nodes: [], offline: [], unpaired: [], ...state }, run);
	beforeEach(() => void made.splice(0));

	it("uses the only connected node without asking, and makes things in its home", () => {
		const menu = plus({ nodes: [mac] });
		expect(ids(menu)).toEqual(["new-terminal", "new-agent", "|", "add-project"]);
		menuItems(menu)[0]!.run!();
		expect(made).toEqual([["terminal", "m", undefined, false]]);
	});

	it("defaults to the project on screen, names where things land, and offers its worktree", () => {
		const menu = plus({ nodes: [mac], current: { node: "m", project: { path: "/p/atlas", name: "atlas" } } });
		expect(ids(menu)).toEqual(["#atlas · mac", "new-terminal", "new-agent", "new-worktree", "|", "add-project"]);
		menuItems(menu).find((entry) => entry.id === "new-agent")!.run!();
		menuItems(menu).find((entry) => entry.id === "new-worktree")!.run!();
		expect(made).toEqual([
			["terminal", "m", "/p/atlas", true],
			["worktree", "m", "/p/atlas"],
		]);
	});

	it("groups several connected nodes under their names when none is on screen, so one choice picks both", () => {
		const menu = plus({ nodes: [mac, node01] });
		expect(ids(menu)).toEqual(["#mac", "m:new-terminal", "m:new-agent", "m:add-project", "|", "#node01", "n:new-terminal", "n:new-agent", "n:add-project"]);
		menuItems(menu).find((entry) => entry.id === "n:add-project")!.run!();
		expect(made).toEqual([["add", "n"]]);
		// Many nodes become one submenu each.
		const many = plus({ nodes: ["a", "b", "c", "d", "e"].map((id) => ({ ...mac, id, name: id })) });
		expect(ids(many)).toEqual(["node:a>", "node:b>", "node:c>", "node:d>", "node:e>"]);
	});

	it("puts the node on screen first and the other connected nodes in submenus", () => {
		const menu = plus({ nodes: [mac, node01], current: { node: "n" } });
		expect(ids(menu)).toEqual(["#node01", "new-terminal", "new-agent", "|", "add-project", "|", "#Other nodes", "node:m>"]);
		const other = menuItems(menu).find((entry) => entry.id === "node:m")!;
		expect(ids(other.submenu!)).toEqual(["new-terminal", "new-agent", "|", "add-project"]);
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
		const old = { ...mac, canEdit: false, canWorktree: false };
		const states: Partial<AddMenuState>[] = [
			{},
			{ offline: ["mac"] },
			{ unpaired: [{ id: "m", name: "mac" }] },
			{ nodes: [old] },
			{ nodes: [old], current: { node: "m", project: { path: "/p", name: "p" } } },
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

	it("gives project cards a menu and a ⋯ button; F2 and double-click rename, Delete removes", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy" }), pane("w", { state: "idle" }, { cwd: "/home/me/repo-fix" })])]} calls={calls} />);
		projectsView();
		const card = container.querySelector<HTMLElement>("[data-project-card='/home/me/repo'] [data-project-open]")!;
		openMenu(card);
		const menu = menuFor("data-project-menu", "mac\n/home/me/repo")!;
		expect(items(menu)).toEqual(["new-terminal", "new-agent", "new-worktree", "reveal", "copy-path", "rename", "fold", "remove"]);
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /New pi Agent/ }));
		expect(calls.newTerminal).toEqual([["mac", "/home/me/repo", true]]);

		fireEvent.click(container.querySelector<HTMLElement>("[data-project-card='/home/me/repo'] [data-card-more]")!);
		fireEvent.click(within(document.querySelector("[data-project-menu]") as HTMLElement).getByRole("menuitem", { name: /Remove from Deck/ }));
		expect(calls.removeProject).toEqual([["mac", PROJECTS[0]]]);

		// The worktree card offers removing the worktree, and shows it is one.
		const worktree = container.querySelector<HTMLElement>("[data-project-card='/home/me/repo-fix']")!;
		expect(worktree.querySelector("[data-worktree-badge]")).not.toBeNull();
		openMenu(worktree.querySelector("[data-project-open]")!);
		expect(items(document.querySelector("[data-project-menu]")!)).toContain("remove-worktree");
		fireEvent.keyDown(document.querySelector("[data-project-menu]")!, { key: "Escape" });

		// Keys on the focused card.
		card.focus();
		runCommand(container, "rail.remove");
		expect(calls.removeProject).toEqual([["mac", PROJECTS[0]], ["mac", PROJECTS[0]]]);
		worktree.querySelector<HTMLElement>("[data-project-open]")!.focus();
		runCommand(container, "rail.remove");
		expect(calls.removeWorktree).toEqual([["mac", PROJECTS[1]]]);
		const renameKey = { key: "F2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
		expect(resolveKey(buildKeymap(undefined, true), renameKey, focusOf(card))).toBe("rail.rename");
		expect(resolveKey(buildKeymap(undefined, true), { ...renameKey, key: "Backspace" }, focusOf(card))).toBe("rail.remove");

		fireEvent.doubleClick(card);
		const field = container.querySelector<HTMLInputElement>("[data-inline-rename]")!;
		expect(field.value).toBe("repo");
		fireEvent.change(field, { target: { value: "Main repo" } });
		fireEvent.blur(field);
		expect(calls.renameProject).toEqual([["mac", "/home/me/repo", "Main repo"]]);
	});

	it("filters by name, project, node, and folder; Escape clears", () => {
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
		const agent = { key: "k", node: nodes[0]!, terminal: nodes[0]!.terminals[0]!, project: "/home/me/repo" };
		expect(agentMatches(agent, "REPO", "repo")).toBe(true);
	});

	it("offers New and Add Project from the + menu, and Add Project in a node with no projects", () => {
		const { container } = render(<Harness nodes={[node("mac", [])]} calls={calls} projects={[]} />);
		fireEvent.click(container.querySelector<HTMLElement>("[data-rail-add]")!);
		const menu = document.querySelector("[data-add-menu]")!;
		expect(items(menu)).toEqual(["new-terminal", "new-agent", "new-worktree", "add-project"]);
		expect(menu.querySelector("[data-menu-header]")!.textContent).toBe("repo · mac");
		fireEvent.click(within(menu as HTMLElement).getByRole("menuitem", { name: /Add Project/ }));
		expect(calls.addProject).toEqual([["mac"]]);
		projectsView();
		fireEvent.click(container.querySelector<HTMLElement>("[data-empty-add-project]")!);
		expect(calls.addProject).toHaveLength(2);
		openMenu(container.querySelector("[data-node-projects='mac'] [data-node]")!);
		expect(items(document.querySelector("[data-node-menu]")!)).toEqual(["new-terminal", "add-project", "copy-fingerprint", "repair", "fold"]);
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
		openMenu(container.querySelector("[data-project-card='/home/me/repo'] [data-project-open]")!);
		const card = menuFor("data-project-menu", "mac\n/home/me/repo")!;
		const remove = card.querySelector("[data-menu-item='remove']")!;
		expect(remove.getAttribute("aria-disabled")).toBe("true");
		expect(remove.getAttribute("data-variant")).toBe("default");
		fireEvent.keyDown(card, { key: "Escape" });
		openMenu(container.querySelector("[data-agent-row='busy']")!);
		expect(menuFor("data-agent-menu", "mac\nbusy")!.querySelector("[data-menu-item='kill']")!.getAttribute("data-variant")).toBe("destructive");
	});

});

describe("Add Project", () => {
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
		render(<AddProjectDialog nodeName="mac" home="/home/me" listFolders={listFolders} onAdd={onAdd} onCancel={() => {}} />);
		const field = document.querySelector<HTMLInputElement>("[data-add-project-path]")!;
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
