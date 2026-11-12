import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode } from "react";
import { Icon } from "../../components/icons";
import { cx } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { isMenuKey, menuAtPointer, menuBelow, useMenu, type MenuAnchor, type MenuEntry } from "../deck/Menu";
import { InlineRename } from "../deck/RailDialogs";
import { tip } from "../deck/Tooltips";
import { homePath, paneLabel, paneSession, type NodeView } from "../client";
import { sanitize, type Activity, type Checkout, type TerminalInfo } from "../contract";
import { actionShortcut, type PageCommands } from "../keys";
import {
	attentionText,
	childActivities,
	clockInterval,
	elapsed,
	emptyLayout,
	flatLayout,
	holdLayout,
	inboxKey,
	InboxTracker,
	layoutInbox,
	NEED_LABELS,
	needKind,
	NODE_STATE_LABELS,
	nodeLinkState,
	SECTION_LABELS,
	SECTIONS,
	shortAgo,
	type InboxLayout,
	type NodeLinkState,
	type Placement,
	type Section,
} from "./inbox";
import { makesWorktrees, placeKey, type RailNode, type RailProject, type RailWorktree } from "./places";
import { addMenu, agentMenu, checkoutMenu, killNeedsConfirm, nodeMenu, otherMenu, projectMenu, worktreeMenu, type CheckoutMenuActions, type CheckoutMenuState } from "./rail-menus";
import { installRailTree } from "./rail-tree";
import { markLabel, sectionMark, StatusGlyph, type PaneMark } from "./status";
import { OTHER } from "./store";

/** One agent as the rail lists it: a terminal on some node, in some place (a worktree of a checkout, or "Other"). */
export interface RailAgent {
	key: string;
	node: NodeView;
	terminal: TerminalInfo;
	place: string;
	/** Its place in words (`branch · project`); absent in "Other". */
	where?: string;
}

export interface Inbox {
	placements: ReadonlyMap<string, Placement>;
	/** The order on screen, held while the pointer is over the rail. */
	layout: InboxLayout;
	/** The clock the rows' times read from. */
	now: number;
}

/**
 * Every agent's section and the rail's order, kept current by the node's events, a shared clock (each second while
 * something works, else every 30 s), and the end of each exit grace. While `hovering`, rows keep their places.
 */
export function useInbox(agents: readonly RailAgent[], selected: string | undefined, hovering: boolean): Inbox {
	const tracker = useRef(new InboxTracker());
	const shown = useRef<InboxLayout>(emptyLayout());
	const [tick, setTick] = useState(0);
	const observed = useMemo(() => {
		const now = Date.now();
		const entries = agents.map((agent) => ({ key: agent.key, terminal: agent.terminal }));
		const { placements, nextAt } = tracker.current.observe(entries, now, selected);
		return { placements, nextAt, layout: layoutInbox(entries, placements), now };
		// tick: the clock, and the end of an exit grace.
	}, [agents, selected, tick]);
	const layout = hovering ? holdLayout(shown.current, observed.layout) : observed.layout;
	shown.current = layout;

	useEffect(() => {
		if (observed.nextAt === undefined) return;
		const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, observed.nextAt - Date.now()) + 5);
		return () => clearTimeout(timer);
	}, [observed.nextAt]);
	const interval = clockInterval(observed.layout);
	useEffect(() => {
		const timer = setInterval(() => setTick((value) => value + 1), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return { placements: observed.placements, layout, now: observed.now };
}

// --- What the rail remembers ----------------------------------------------------------------------------------------

export type RailView = "status" | "projects";

export interface RailPrefs {
	view: RailView;
	/** Status sections the user folded; Quiet starts folded. */
	collapsed: Section[];
	/**
	 * What the Projects view folds in this browser: nodes (by id), `node\n<project id>` for projects the server keeps
	 * nothing for (no key), and `node\nother:` for the "Other" card. The server keeps the rest's folding.
	 */
	folded: string[];
}

export const RAIL_KEY = "pika.nodes.rail";
const RAIL_DEFAULTS: RailPrefs = { view: "status", collapsed: ["quiet"], folded: [] };

export function loadRailPrefs(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): RailPrefs {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(RAIL_KEY) ?? "{}");
		if (!parsed || typeof parsed !== "object") return RAIL_DEFAULTS;
		const stored = parsed as Partial<Record<keyof RailPrefs, unknown>>;
		const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
		return {
			view: stored.view === "projects" ? "projects" : "status",
			collapsed: (strings(stored.collapsed)?.filter((item): item is Section => (SECTIONS as readonly string[]).includes(item)) ?? RAIL_DEFAULTS.collapsed),
			folded: strings(stored.folded) ?? [],
		};
	} catch {
		return RAIL_DEFAULTS;
	}
}

function useRailPrefs(): [RailPrefs, (change: Partial<RailPrefs>) => void] {
	const [prefs, setPrefs] = useState(loadRailPrefs);
	const update = useCallback((change: Partial<RailPrefs>) => {
		setPrefs((current) => {
			const next = { ...current, ...change };
			try {
				globalThis.localStorage?.setItem(RAIL_KEY, JSON.stringify(next));
			} catch {
				// Private browsing or a full quota: this page only.
			}
			return next;
		});
	}, []);
	return [prefs, update];
}

const toggled = <T,>(list: readonly T[], item: T): T[] => (list.includes(item) ? list.filter((value) => value !== item) : [...list, item]);

// --- The rail -------------------------------------------------------------------------------------------------------

export interface AgentRailProps {
	nodes: readonly NodeView[];
	agents: ReadonlyMap<string, RailAgent>;
	inbox: Inbox;
	/** The pane on screen, as `node\nterminalId`. */
	selected?: string;
	currentNode?: string;
	/** The place on screen on `currentNode`. */
	currentPlace?: string;
	/** A node's checkouts as projects; undefined until the node has listed its checkouts. */
	railNodeOf: (node: string) => RailNode | undefined;
	homeOf: (node: string) => string;
	onHover: (hovering: boolean) => void;
	onAgent: (key: string) => void;
	onNode: (node: string) => void;
	/** Shows a place's workspace. */
	onPlace: (node: string, place: string) => void;
	/** Closes the agent's pane in its workspace; absent for an agent that has none there. */
	canClosePane: (key: string) => boolean;
	onClosePane: (key: string) => void;
	/** Kills a live agent's terminal (asking first when `confirm`), or removes an exited one. */
	onKill: (key: string, confirm: boolean) => void;
	header: ReactNode;
	/** What the rail's menus do; without it, rows offer only opening, closing, copying, and killing. */
	ops?: RailOps;
	/** The page's shortcut handlers, where the rail puts its own (`rail.*`) while it shows. */
	commands?: MutableRefObject<PageCommands>;
}

/** The rail's operations on projects, checkouts, worktrees, and agents, which the page runs (dialogs, requests, undo). */
export interface RailOps {
	/** Whether the node's daemon offers a capability (`welcome.capabilities`). */
	can: (node: string, capability: string) => boolean;
	connected: (node: string) => boolean;
	/** The node key this browser pinned. */
	fingerprint: (node: string) => string | undefined;
	/** A terminal in `place`'s worktree (the home directory for "Other"), running pi when `agent`. */
	newTerminal: (node: string, place: string, agent: boolean) => void;
	addCheckout: (node: string) => void;
	newWorktree: (node: string, checkoutId: string) => void;
	/** Shows a place with its folder in the explorer. */
	revealPlace: (node: string, place: string) => void;
	/** The server's name for a project (with a key); null clears it. */
	renameProject: (project: RailProject, name: string | null) => void;
	/** Folds a project with a key, on the server. */
	setCollapsed: (project: RailProject, collapsed: boolean) => void;
	/** The node's name for a checkout; null clears it. */
	renameCheckout: (node: string, checkout: Checkout, name: string | null) => void;
	checkoutSettings: (node: string, checkout: Checkout) => void;
	/** Records a checkout found on its own (`checkout.add`), so it stays listed. */
	keepCheckout: (node: string, checkout: Checkout) => void;
	/** "Remove from Deck" (`checkout.hide`), with an undo. */
	hideCheckout: (node: string, checkout: Checkout) => void;
	removeWorktree: (node: string, checkout: Checkout, worktree: RailWorktree) => void;
	renameAgent: (key: string, label: string | null) => void;
	markRead: (key: string) => void;
	markUnread: (key: string) => void;
	split: (key: string, direction: "row" | "column") => void;
	restart: (key: string) => void;
	repair: (node: string) => void;
}

/** What the filter field matches: an agent's name, where it is (branch and project), node, and folder. */
export function agentMatches(agent: RailAgent, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [paneLabel(agent.terminal), agent.where ?? "Other", agent.node.info.name, paneSession(agent.terminal).cwd].some((text) => text.toLowerCase().includes(needle));
}

/** Whether the filter names a project: its heading, repository, a checkout's name or path, or a worktree's branch or folder. */
export function projectMatches(project: RailProject, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	const texts = [project.name, project.repository ?? ""];
	for (const { checkout, worktrees } of project.checkouts) {
		texts.push(sanitize(checkout.name), sanitize(checkout.path));
		for (const worktree of worktrees) texts.push(worktree.title, worktree.meta ?? "");
	}
	return texts.some((text) => text.toLowerCase().includes(needle));
}

/** Row ids in the Projects view; each names its node and what it is. */
const projectRow = (node: string, project: RailProject) => `project:${node}\n${project.id}`;
const checkoutRow = (node: string, checkout: Checkout) => `checkout:${node}\n${checkout.id}`;
const placeRow = (node: string, place: string) => `place:${node}\n${place}`;
const OTHER_ROW = (node: string) => placeRow(node, OTHER);

/** A row id split into its kind, node, and the rest (a project id, a checkout id, a place). */
function parseRow(id: string): { kind: "project" | "checkout" | "place"; node: string; rest: string } | undefined {
	const match = /^(project|checkout|place):([^\n]*)\n(.*)$/s.exec(id);
	return match ? { kind: match[1] as "project" | "checkout" | "place", node: match[2]!, rest: match[3]! } : undefined;
}

/** The row a rename edits: an agent's key, a project's, or a checkout's row id. */
type Renaming = string | undefined;

/** The left rail: every agent on every node, by what the user has to do (Status), or by node and project (Projects). */
export function AgentRail(props: AgentRailProps) {
	const [prefs, setPrefs] = useRailPrefs();
	const [renaming, setRenaming] = useState<Renaming>();
	const [filter, setFilter] = useState("");
	const list = useRef<HTMLDivElement>(null);
	const filterField = useRef<HTMLInputElement>(null);
	useEffect(() => (list.current ? installRailTree(list.current) : undefined), []);
	const rowMenu = useMenu();
	const { ops } = props;
	const findProject = (node: string, id: string) => props.railNodeOf(node)?.projects.find((project) => project.id === id);
	const findCheckout = (node: string, id: string) => {
		for (const project of props.railNodeOf(node)?.projects ?? []) for (const entry of project.checkouts) if (entry.checkout.id === id) return { project, entry };
		return undefined;
	};
	const nodeName = (node: string) => props.nodes.find((view) => view.info.id === node)?.info.name ?? node;
	const can = (node: string, capability: string) => ops?.can(node, capability) ?? false;
	const connected = (node: string) => ops?.connected(node) ?? false;

	// An agent's context menu, from the shared one; it opens outside the rows, whose containment would trap it.
	const onRowMenu = (key: string, at: MenuAt) => {
		const agent = props.agents.get(key);
		if (!agent) return;
		const label = paneLabel(agent.terminal);
		const cwd = paneSession(agent.terminal).cwd;
		const node = agent.node.info.id;
		const section = props.inbox.placements.get(key)?.section ?? "quiet";
		const sessionId = agent.terminal.status?.bridge?.session?.id;
		const hasPane = props.canClosePane(key);
		const kill = () => props.onKill(key, killNeedsConfirm(section));
		const items: MenuEntry[] = ops
			? agentMenu(
					{
						nodeName: agent.node.info.name,
						exited: Boolean(agent.terminal.exited),
						hasPane,
						unread: Boolean(agent.terminal.status?.unread),
						section,
						...(sessionId ? { sessionId: sanitize(sessionId) } : {}),
						connected: connected(node),
						canRename: can(node, "term.rename"),
						canUnread: can(node, "pane.unread"),
					},
					{
						focus: () => props.onAgent(key),
						rename: () => setRenaming(key),
						markRead: () => ops.markRead(key),
						markUnread: () => ops.markUnread(key),
						split: (direction) => ops.split(key, direction),
						restart: () => ops.restart(key),
						copyCwd: () => void copyText(cwd),
						copySessionId: () => void copyText(sanitize(sessionId)),
						closePane: () => props.onClosePane(key),
						kill,
						remove: () => props.onKill(key, false),
					},
				)
			: [
					{ id: "open", label: "Open", icon: "terminal", run: () => props.onAgent(key) },
					...(hasPane ? [{ id: "close-pane", label: "Close Pane", icon: "close" as const, run: () => props.onClosePane(key) }] : []),
					"separator",
					{ id: "copy-cwd", label: "Copy Working Directory", icon: "copy", run: () => void copyText(cwd) },
					"separator",
					{ id: agent.terminal.exited ? "remove" : "kill", label: agent.terminal.exited ? "Remove…" : "Kill…", icon: agent.terminal.exited ? "trash" : "kill", danger: true, run: () => props.onKill(key, true) },
				];
		rowMenu.open({ ...at, items, label, attrs: { "data-agent-menu": key } });
	};

	const fold = (key: string) => setPrefs({ folded: toggled(prefs.folded, key) });
	/** Whether a project is folded: on the server for one with a key, in this browser for one without. */
	const isCollapsed = (node: string, project: RailProject) => (project.serverKey && ops ? project.collapsed : prefs.folded.includes(`${node}\n${project.id}`));
	const toggleProject = (node: string, project: RailProject) => {
		if (project.serverKey && ops) ops.setCollapsed(project, !project.collapsed);
		else fold(`${node}\n${project.id}`);
	};
	const canCheckouts = (node: string) => can(node, "checkouts");

	const checkoutState = (node: string, checkout: Checkout): CheckoutMenuState => ({
		nodeName: nodeName(node),
		connected: connected(node),
		canCheckouts: canCheckouts(node),
		kind: checkout.kind,
		configured: checkout.source === "configured",
	});
	const checkoutActions = (node: string, checkout: Checkout, renameRow: string): CheckoutMenuActions | undefined =>
		ops && {
			rename: () => setRenaming(renameRow),
			settings: () => ops.checkoutSettings(node, checkout),
			reveal: () => {
				const main = checkout.kind === "folder" ? checkout.path : checkout.worktrees.find((worktree) => worktree.isMain)?.path;
				if (main) ops.revealPlace(node, placeKey(checkout.id, main));
			},
			copyPath: () => void copyText(checkout.path),
			keep: () => ops.keepCheckout(node, checkout),
			hide: () => ops.hideCheckout(node, checkout),
		};

	// A project heading's menu; with one checkout, the heading stands for it and offers its items too.
	const onProjectMenu = (node: string, project: RailProject, at: MenuAt) => {
		if (!ops) return;
		const only = project.checkouts.length === 1 ? project.checkouts[0]!.checkout : undefined;
		const row = projectRow(node, project);
		const actions = only && checkoutActions(node, only, row);
		const items = projectMenu(
			{
				nodeName: nodeName(node),
				connected: connected(node),
				canCheckouts: canCheckouts(node),
				persisted: project.serverKey !== null,
				collapsed: isCollapsed(node, project),
				...(project.repository ? { repository: project.repository } : {}),
				worktreeFrom: project.checkouts.filter(({ checkout }) => makesWorktrees(checkout)).map(({ checkout }) => ({ id: checkout.id, label: homePath(sanitize(checkout.path), props.homeOf(node)) })),
				...(only ? { checkout: checkoutState(node, only) } : {}),
			},
			{
				newWorktree: (checkoutId) => ops.newWorktree(node, checkoutId),
				rename: () => setRenaming(row),
				fold: () => toggleProject(node, project),
				copyRepository: () => void copyText(project.repository ?? ""),
				...(actions ? { checkout: { ...actions, rename: () => setRenaming(`${row}\ncheckout`) } } : {}),
			},
		);
		rowMenu.open({ ...at, items, label: project.name, attrs: { "data-project-menu": row } });
	};

	const onCheckoutMenu = (node: string, checkout: Checkout, at: MenuAt) => {
		const row = checkoutRow(node, checkout);
		const actions = checkoutActions(node, checkout, row);
		if (!actions) return;
		rowMenu.open({ ...at, items: checkoutMenu(checkoutState(node, checkout), actions), label: sanitize(checkout.name), attrs: { "data-checkout-menu": row } });
	};

	const onWorktreeMenu = (node: string, checkout: Checkout, worktree: RailWorktree, at: MenuAt) => {
		if (!ops) return;
		const items = worktreeMenu(
			{
				nodeName: nodeName(node),
				connected: connected(node),
				canCheckouts: canCheckouts(node),
				linked: worktree.linked,
				...(worktree.branch ? { branch: worktree.branch } : {}),
				prunable: worktree.prunable,
			},
			{
				newTerminal: () => ops.newTerminal(node, worktree.place, false),
				newAgent: () => ops.newTerminal(node, worktree.place, true),
				reveal: () => ops.revealPlace(node, worktree.place),
				copyPath: () => void copyText(worktree.path),
				copyBranch: () => void copyText(worktree.branch ?? ""),
				remove: () => ops.removeWorktree(node, checkout, worktree),
			},
		);
		rowMenu.open({ ...at, items, label: worktree.title, attrs: { "data-worktree-menu": placeRow(node, worktree.place) } });
	};

	const onOtherMenu = (node: string, at: MenuAt) => {
		if (!ops) return;
		const key = `${node}\n${OTHER}`;
		const items = otherMenu(
			{ nodeName: nodeName(node), connected: connected(node), folded: prefs.folded.includes(key) },
			{ newTerminal: () => ops.newTerminal(node, OTHER, false), newAgent: () => ops.newTerminal(node, OTHER, true), fold: () => fold(key) },
		);
		rowMenu.open({ ...at, items, label: "Other", attrs: { "data-worktree-menu": OTHER_ROW(node) } });
	};

	const onNodeMenu = (node: string, at: MenuAt, foldable: boolean) => {
		if (!ops) return;
		const view = props.nodes.find((item) => item.info.id === node);
		const fingerprint = ops.fingerprint(node);
		const items = nodeMenu(
			{
				nodeName: nodeName(node),
				connected: connected(node),
				canCheckouts: canCheckouts(node),
				...(fingerprint ? { fingerprint } : {}),
				pinned: Boolean(view?.pin),
				foldable,
				folded: prefs.folded.includes(node),
			},
			{
				newTerminal: () => ops.newTerminal(node, OTHER, false),
				addCheckout: () => ops.addCheckout(node),
				copyFingerprint: () => void copyText(fingerprint ?? ""),
				repair: () => ops.repair(node),
				fold: () => fold(node),
			},
		);
		rowMenu.open({ ...at, items, label: nodeName(node), attrs: { "data-node-menu": node } });
	};

	const onAddMenu = (button: HTMLElement) => {
		if (!ops) return;
		const node = props.currentNode;
		const info = node && props.currentPlace && props.currentPlace !== OTHER ? props.railNodeOf(node)?.places.get(props.currentPlace) : undefined;
		const live = props.nodes.filter((view) => connected(view.info.id));
		const items = addMenu(
			{
				nodes: live.map((view) => ({ id: view.info.id, name: view.info.name, canCheckouts: canCheckouts(view.info.id) })),
				offline: props.nodes.filter((view) => view.pin && !connected(view.info.id)).map((view) => view.info.name),
				unpaired: props.nodes.filter((view) => !view.pin).map((view) => ({ id: view.info.id, name: view.info.name })),
				...(node
					? {
							current: {
								node,
								...(info
									? {
											place: {
												place: info.worktree.place,
												name: info.checkout.checkout.kind === "folder" ? info.project.name : `${info.project.name} · ${info.worktree.label}`,
												...(makesWorktrees(info.checkout.checkout) ? { checkoutId: info.checkout.checkout.id } : {}),
											},
										}
									: {}),
							},
						}
					: {}),
			},
			{
				newTerminal: (target, place, agent) => ops.newTerminal(target, place ?? OTHER, agent),
				addCheckout: (target) => ops.addCheckout(target),
				newWorktree: (target, checkoutId) => ops.newWorktree(target, checkoutId),
				pair: (target) => props.onNode(target),
			},
		);
		rowMenu.open({ ...menuBelow(button), items, label: "New", attrs: { "data-add-menu": "" } });
	};

	/** Commits a rename typed in row `row`: an agent's label, a project's server name, or a checkout's node name. */
	const commitRename = (row: string, name: string | null) => {
		setRenaming(undefined);
		if (!ops) return;
		if (props.agents.has(row)) return ops.renameAgent(row, name);
		const checkoutOfHeading = row.endsWith("\ncheckout");
		const parsed = parseRow(checkoutOfHeading ? row.slice(0, -"\ncheckout".length) : row);
		if (!parsed) return;
		if (parsed.kind === "project") {
			const project = findProject(parsed.node, parsed.rest);
			if (!project) return;
			if (project.serverKey && !checkoutOfHeading) ops.renameProject(project, name);
			else if (project.checkouts.length === 1) ops.renameCheckout(parsed.node, project.checkouts[0]!.checkout, name);
		} else if (parsed.kind === "checkout") {
			const found = findCheckout(parsed.node, parsed.rest);
			if (found) ops.renameCheckout(parsed.node, found.entry.checkout, name);
		}
	};

	// The rail's keys (`rail.*` in keys.ts), on the row with focus.
	const focusedRow = () => (document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-sidebar-row]") : null);
	const latest = useRef({ props, prefs, renaming });
	latest.current = { props, prefs, renaming };
	useEffect(() => {
		const commands = props.commands?.current;
		if (!commands) return;
		const focusFilter = () => {
			filterField.current?.focus();
			filterField.current?.select();
		};
		commands["rail.filter"] = focusFilter;
		commands["rail.find"] = focusFilter;
		commands["rail.rename"] = () => {
			const row = focusedRow();
			const id = row?.dataset.sidebarRow;
			if (!row || !id || !ops) return false;
			if (row.hasAttribute("data-agent-row")) {
				const node = latest.current.props.agents.get(id)?.node.info.id;
				if (!node || !can(node, "term.rename") || !connected(node)) return false;
				setRenaming(id);
				return;
			}
			const parsed = parseRow(id);
			if (!parsed || parsed.kind === "place" || !connected(parsed.node)) return false;
			if (parsed.kind === "project") {
				const project = findProject(parsed.node, parsed.rest);
				if (!project || (!project.serverKey && (project.checkouts.length !== 1 || !canCheckouts(parsed.node)))) return false;
			} else if (!findCheckout(parsed.node, parsed.rest) || !canCheckouts(parsed.node)) return false;
			setRenaming(id);
		};
		commands["rail.remove"] = () => {
			const parsed = parseRow(focusedRow()?.dataset.sidebarRow ?? "");
			if (!ops || !parsed || !canCheckouts(parsed.node) || !connected(parsed.node)) return false;
			if (parsed.kind === "project") {
				const project = findProject(parsed.node, parsed.rest);
				if (project?.checkouts.length !== 1) return false;
				ops.hideCheckout(parsed.node, project.checkouts[0]!.checkout);
			} else if (parsed.kind === "checkout") {
				const found = findCheckout(parsed.node, parsed.rest);
				if (!found) return false;
				ops.hideCheckout(parsed.node, found.entry.checkout);
			} else {
				const info = props.railNodeOf(parsed.node)?.places.get(parsed.rest);
				if (!info?.worktree.linked) return false;
				ops.removeWorktree(parsed.node, info.checkout.checkout, info.worktree);
			}
		};
		return () => {
			for (const action of ["rail.filter", "rail.find", "rail.rename", "rail.remove"] as const) delete commands[action];
		};
	});

	const viewProps = {
		...props,
		prefs,
		setPrefs,
		onRowMenu,
		onProjectMenu,
		onCheckoutMenu,
		onWorktreeMenu,
		onOtherMenu,
		onNodeMenu,
		isCollapsed,
		toggleProject,
		fold,
		commitRename,
		renaming,
		setRenaming,
		filter: filter.trim(),
	};
	const filterShortcut = actionShortcut("rail.filter");
	return (
		<>
			<div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-3">
				{props.header}
				<div className="ml-auto flex h-6 shrink-0 rounded-[3px] border border-dk-line p-px text-[12px]" role="group" aria-label="Group agents by">
					{(["status", "projects"] as const).map((view) => (
						<button
							key={view}
							type="button"
							aria-pressed={prefs.view === view}
							className={cx("rounded-[2px] px-2", prefs.view === view ? "bg-dk-ground font-medium text-dk-ink shadow-[0_0_0_1px_var(--dk-line)]" : "text-dk-ink-2 hover:text-dk-ink")}
							onClick={() => setPrefs({ view })}
							data-rail-view={view}
						>
							{view === "status" ? "Status" : "Projects"}
						</button>
					))}
				</div>
				{ops && (
					<button
						type="button"
						className="flex size-6 shrink-0 items-center justify-center rounded-[3px] text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink"
						aria-label="New terminal, agent, repository, or worktree"
						aria-haspopup="menu"
						aria-expanded={rowMenu.openFor === "New"}
						{...tip("New…")}
						onClick={(event) => (rowMenu.openFor === "New" ? rowMenu.close() : onAddMenu(event.currentTarget))}
						data-rail-add=""
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
							<path d="M6 2v8M2 6h8" />
						</svg>
					</button>
				)}
			</div>
			<div className="shrink-0 px-2 pb-2">
				<input
					ref={filterField}
					type="search"
					className="h-6 w-full rounded-[3px] border border-dk-line bg-dk-ground px-2 text-[12.5px] text-dk-ink outline-none placeholder:text-dk-ink-3 focus:border-dk-accent"
					placeholder={filterShortcut ? `Filter…  ${filterShortcut}` : "Filter…"}
					aria-label="Filter agents"
					value={filter}
					spellCheck={false}
					onChange={(event) => setFilter(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" && filter) {
							event.preventDefault();
							event.stopPropagation();
							setFilter("");
						} else if (event.key === "ArrowDown") {
							event.preventDefault();
							list.current?.querySelector<HTMLElement>("[data-sidebar-row]")?.focus();
						}
					}}
					data-rail-filter=""
				/>
			</div>
			<div
				ref={list}
				className="min-h-0 flex-1 overflow-y-auto pb-3"
				onPointerEnter={() => props.onHover(true)}
				onPointerLeave={() => props.onHover(false)}
				data-rail-list={prefs.view}
			>
				{prefs.view === "status" ? <StatusView {...viewProps} /> : <ProjectsView {...viewProps} />}
			</div>
			{rowMenu.menu}
		</>
	);
}

type MenuAt = { anchor: MenuAnchor };

type ViewProps = AgentRailProps & {
	prefs: RailPrefs;
	setPrefs: (change: Partial<RailPrefs>) => void;
	onRowMenu: (key: string, at: MenuAt) => void;
	onProjectMenu: (node: string, project: RailProject, at: MenuAt) => void;
	onCheckoutMenu: (node: string, checkout: Checkout, at: MenuAt) => void;
	onWorktreeMenu: (node: string, checkout: Checkout, worktree: RailWorktree, at: MenuAt) => void;
	onOtherMenu: (node: string, at: MenuAt) => void;
	onNodeMenu: (node: string, at: MenuAt, foldable: boolean) => void;
	isCollapsed: (node: string, project: RailProject) => boolean;
	toggleProject: (node: string, project: RailProject) => void;
	/** Folds or unfolds a key of `RailPrefs.folded`. */
	fold: (key: string) => void;
	commitRename: (row: string, name: string | null) => void;
	renaming: Renaming;
	setRenaming: (row: Renaming) => void;
	/** The filter field's text, trimmed; empty shows everything. */
	filter: string;
};

function Chevron({ open }: { open: boolean }) {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" className={cx("shrink-0 text-dk-ink-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true">
			<path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** Whether an agent shows under the filter. */
function shownByFilter(props: ViewProps, agent: RailAgent | undefined): boolean {
	if (!agent) return false;
	if (!props.filter) return true;
	return agentMatches(agent, props.filter);
}

/** The Status view: the nodes strip, then the sections, attention first. A filter shows its matches in every section. */
function StatusView(props: ViewProps) {
	const { inbox, prefs, setPrefs, filter } = props;
	const matching = SECTIONS.reduce((count, section) => count + inbox.layout[section].filter((key) => shownByFilter(props, props.agents.get(key))).length, 0);
	return (
		<>
			<NodeStrip {...props} />
			{filter && matching === 0 && (
				<p className="px-3 py-2 text-[12px] text-dk-ink-3" role="status" data-no-matches="">
					No agents match “{filter}”
				</p>
			)}
			{SECTIONS.map((section) => {
				const keys = inbox.layout[section].filter((key) => shownByFilter(props, props.agents.get(key)));
				if (keys.length === 0 && (section !== "needs" || filter)) return null;
				const open = Boolean(filter) || !prefs.collapsed.includes(section);
				const id = `section:${section}`;
				return (
					<section key={section} aria-label={SECTION_LABELS[section]} data-rail-section={section}>
						<button
							type="button"
							className="flex h-7 w-full items-center gap-1.5 pr-3 pl-2.5 text-left text-[12px] font-semibold text-dk-ink-2 hover:text-dk-ink"
							aria-expanded={open}
							onClick={() => setPrefs({ collapsed: toggled(prefs.collapsed, section) })}
							data-sidebar-row={id}
							data-section-toggle={section}
						>
							<Chevron open={open} />
							<span className={cx(section === "needs" && keys.length > 0 && "text-dk-needs-ink")}>{SECTION_LABELS[section]}</span>
							<span className="font-normal text-dk-ink-3 tabular-nums">{keys.length}</span>
						</button>
						{open &&
							(keys.length === 0 ? (
								<p className="pt-0.5 pr-3 pb-2 pl-7 text-[12px] text-dk-ink-3" data-nothing-needs-you="">
									Nothing needs you
								</p>
							) : (
								<ul className="pb-1.5">
									{keys.map((key) => {
										const agent = props.agents.get(key);
										const placement = inbox.placements.get(key);
										return agent && placement ? <AgentRow key={key} agent={agent} placement={placement} parent={id} variant="status" {...props} /> : null;
									})}
								</ul>
							))}
					</section>
				);
			})}
		</>
	);
}

/** Every node in one wrapped line, each marked by its link: the way to a node with no agents, or one to pair. */
function NodeStrip({ nodes, currentNode, onNode, onNodeMenu }: ViewProps) {
	if (nodes.length === 0) return null;
	return (
		<nav className="flex flex-wrap gap-x-1 gap-y-0.5 px-2 pb-2" aria-label="Nodes" data-node-strip="">
			{nodes.map((view) => {
				const state = nodeLinkState(view);
				const current = view.info.id === currentNode;
				return (
					<button
						key={view.info.id}
						type="button"
						aria-current={current ? "page" : undefined}
						className={cx(
							"flex h-6 max-w-full items-center gap-1.5 rounded-[3px] px-1.5 text-[12px]",
							current ? "bg-dk-accent-soft text-dk-ink" : "text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink",
						)}
						{...tip(`${view.info.name}: ${NODE_STATE_LABELS[state]}${view.info.host ? ` (${view.info.host})` : ""}`)}
						onClick={() => onNode(view.info.id)}
						onContextMenu={(event) => {
							event.preventDefault();
							onNodeMenu(view.info.id, menuAtPointer(event), false);
						}}
						onKeyDown={(event) => {
							if (!isMenuKey(event)) return;
							event.preventDefault();
							onNodeMenu(view.info.id, menuBelow(event.currentTarget), false);
						}}
						data-node={view.info.id}
						data-node-state={state}
					>
						<NodeGlyph state={state} labelled={state !== "online" && state !== "offline"} />
						<span className="truncate">{view.info.name}</span>
						{state !== "online" && state !== "offline" && <span className="shrink-0 text-dk-ink-3">{NODE_STATE_LABELS[state]}</span>}
					</button>
				);
			})}
		</nav>
	);
}

/** A node's link (Orca's host header): a solid dot online, a turning ring connecting, an alert, a struck dot offline. */
export function NodeGlyph({ state, labelled = false }: { state: NodeLinkState; labelled?: boolean }) {
	const label = NODE_STATE_LABELS[state];
	// Beside its own words the glyph is decoration; alone it names the state.
	const name = labelled ? { "aria-hidden": true } : { role: "img", "aria-label": label };
	return (
		<span className="inline-flex size-3 shrink-0 items-center justify-center" {...name} data-node-glyph={state}>
			{state === "online" ? (
				<span className="size-[7px] rounded-full bg-dk-ink-2" />
			) : state === "connecting" ? (
				<span className="dk-working-ring block size-[9px] rounded-full border-[1.5px] border-dk-ink-3 border-t-transparent" />
			) : state === "error" ? (
				<svg width="12" height="12" viewBox="0 0 12 12" className="text-dk-failed" aria-hidden="true">
					<path d="M6 1 11.2 10.4H.8z" fill="currentColor" strokeLinejoin="round" />
					<path d="M6 4.6v2.6" stroke="var(--dk-ground)" strokeWidth="1.2" strokeLinecap="round" />
					<circle cx="6" cy="8.75" r=".65" fill="var(--dk-ground)" />
				</svg>
			) : state === "offline" ? (
				<svg width="10" height="10" viewBox="0 0 10 10" className="text-dk-ink-3" aria-hidden="true">
					<circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
					<path d="M1.5 8.5 8.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
				</svg>
			) : (
				<span className="size-[7px] rounded-full border-[1.5px] border-dashed border-dk-ink-3" />
			)}
		</span>
	);
}

/** The "⋯" beside a card, shown on hover or focus, that opens its menu. */
function MoreButton({ label, rowKey, onOpen }: { label: string; rowKey: string; onOpen: (button: HTMLElement) => void }) {
	return (
		<button
			type="button"
			tabIndex={-1}
			className="invisible absolute top-[3px] right-2 flex size-[22px] items-center justify-center rounded-[3px] text-dk-ink-2 group-focus-within:visible group-hover:visible hover:bg-dk-hover hover:text-dk-ink"
			aria-label={label}
			aria-haspopup="menu"
			{...tip(label)}
			onClick={(event) => {
				event.stopPropagation();
				onOpen(event.currentTarget);
			}}
			data-sidebar-action-for={rowKey}
			data-card-more=""
		>
			<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
				<circle cx="2.5" cy="6" r="1.1" />
				<circle cx="6" cy="6" r="1.1" />
				<circle cx="9.5" cy="6" r="1.1" />
			</svg>
		</button>
	);
}

/** Right-click and the menu key open a row's menu. */
const menuEvents = (open: (at: MenuAt) => void) => ({
	onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
		event.preventDefault();
		open(menuAtPointer(event));
	},
	onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
		if (!isMenuKey(event)) return;
		event.preventDefault();
		open(menuBelow(event.currentTarget));
	},
});

/** A worktree card's markers: what git says about it besides its branch. */
function WorktreeMarkers({ worktree }: { worktree: RailWorktree }) {
	const marks = [worktree.detached && "detached", worktree.locked && "locked", worktree.prunable && "prunable"].filter((mark): mark is string => Boolean(mark));
	return (
		<>
			{marks.map((mark) => (
				<span key={mark} className="ml-1.5 rounded-[2px] border border-dk-line px-1 text-[10.5px] text-dk-ink-3" {...tip(MARK_TIPS[mark])} data-worktree-mark={mark}>
					{mark}
				</span>
			))}
		</>
	);
}

const MARK_TIPS: Record<string, string> = {
	detached: "HEAD is detached: no branch is checked out",
	locked: "git worktree lock: git keeps it until unlocked",
	prunable: "Its folder is gone; removing it clears git's record",
};

/**
 * The Projects view (NODE.md, "How the web client builds the rail"): each node; its projects, foldable (on the server
 * for a project with a key); a project's checkouts, each with its path only when there are two or more; each
 * checkout's worktree cards, the main one first, its branch as the meta line; and each card's agents in the inbox's
 * order. Terminals in no listed worktree go under the node's "Other". Projects without agents, not on screen, and not
 * added by hand wait behind "N more projects".
 */
function ProjectsView(props: ViewProps) {
	const { nodes, agents, inbox, prefs, currentNode, currentPlace, onNode, railNodeOf, homeOf, ops, filter, onNodeMenu } = props;
	const [more, setMore] = useState<string | undefined>();
	const order = useMemo(() => new Map(flatLayout(inbox.layout).map((key, index) => [key, index])), [inbox.layout]);
	return (
		<>
			{nodes.map((view) => {
				const node = view.info.id;
				const state = nodeLinkState(view);
				const rail = railNodeOf(node);
				const home = homeOf(node);
				const mine = [...agents.values()].filter((agent) => agent.node.info.id === node).sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
				const byPlace = new Map<string, RailAgent[]>();
				for (const agent of mine) byPlace.set(agent.place, [...(byPlace.get(agent.place) ?? []), agent]);
				const active = node === currentNode ? currentPlace : undefined;
				const agentsOf = (project: RailProject) => project.checkouts.flatMap(({ worktrees }) => worktrees.flatMap((worktree) => byPlace.get(worktree.place) ?? []));
				const holds = (project: RailProject, place: string | undefined) => place !== undefined && project.checkouts.some(({ worktrees }) => worktrees.some((worktree) => worktree.place === place));
				const projects = rail?.projects ?? [];
				const shown = projects.filter((project) =>
					filter
						? projectMatches(project, filter) || agentsOf(project).some((agent) => shownByFilter(props, agent))
						: agentsOf(project).length > 0 || holds(project, active) || project.checkouts.some(({ checkout }) => checkout.source === "configured"),
				);
				const rest = filter ? [] : projects.filter((project) => !shown.includes(project));
				const others = (byPlace.get(OTHER) ?? []).filter((agent) => shownByFilter(props, agent));
				const nodeRow = `node:${node}`;
				const nodeFolded = !filter && prefs.folded.includes(node);
				const ready = view.link.kind === "ready";
				const block = (project: RailProject) => <ProjectBlock key={project.id} {...props} node={node} home={home} project={project} byPlace={byPlace} active={active} parent={nodeRow} />;
				return (
					<section key={node} aria-label={view.info.name} data-node-projects={node}>
						<button
							type="button"
							aria-current={node === currentNode ? "page" : undefined}
							aria-expanded={ops ? !nodeFolded : undefined}
							className={cx("flex h-8 w-full items-center gap-2 pr-3 pl-3 text-left hover:bg-dk-hover", state !== "online" && "text-dk-ink-2")}
							onClick={() => onNode(node)}
							{...(ops ? menuEvents((at) => onNodeMenu(node, at, true)) : {})}
							data-sidebar-row={nodeRow}
							data-node={node}
							data-node-state={state}
						>
							<NodeGlyph state={state} labelled={state !== "online"} />
							<span className="min-w-0 flex-1 truncate">
								<span className="text-[13px] font-semibold">{view.info.name}</span>
								{view.info.host && <span className="ml-1.5 text-[11.5px] text-dk-ink-3">{view.info.host}</span>}
							</span>
							{nodeFolded && <span className="shrink-0 text-[11.5px] text-dk-ink-3">Collapsed</span>}
							{state !== "online" && <span className="shrink-0 text-[11.5px] text-dk-ink-3">{NODE_STATE_LABELS[state]}</span>}
						</button>
						{!nodeFolded && ready && !rail && (
							<p className="py-1 pr-3 pl-8 text-[12px] text-dk-ink-3" role="status">
								Listing repositories…
							</p>
						)}
						{!nodeFolded && ready && rail && projects.length === 0 && !filter && ops && (
							<div className="py-1 pr-3 pl-8 text-[12px] text-dk-ink-3" data-no-projects={node}>
								{ops.can(node, "checkouts") ? (
									<>
										No repositories yet.{" "}
										<button type="button" className="font-medium text-dk-accent hover:underline" onClick={() => ops.addCheckout(node)} data-empty-add-checkout="">
											Add Repository…
										</button>
									</>
								) : (
									<span data-update-node="">Update pika-node on {view.info.name} to see its repositories and worktrees.</span>
								)}
							</div>
						)}
						{!nodeFolded && shown.map(block)}
						{!nodeFolded && (others.length > 0 || (!filter && active === OTHER)) && (
							<OtherCard {...props} node={node} home={home} list={others} byPlace={byPlace} active={active} parent={nodeRow} />
						)}
						{!nodeFolded && rest.length > 0 && (
							<>
								<button
									type="button"
									className="flex h-6 w-full items-center gap-1.5 pr-3 pl-8 text-left text-[12px] text-dk-ink-3 hover:text-dk-ink"
									aria-expanded={more === node}
									onClick={() => setMore(more === node ? undefined : node)}
									data-sidebar-row={`more:${node}`}
									data-sidebar-parent={nodeRow}
									data-more-projects=""
								>
									{more === node ? "Fewer projects" : `${rest.length} more ${rest.length === 1 ? "project" : "projects"}`}
								</button>
								{more === node && rest.map(block)}
							</>
						)}
					</section>
				);
			})}
		</>
	);
}

type BlockProps = ViewProps & {
	node: string;
	home: string;
	byPlace: ReadonlyMap<string, RailAgent[]>;
	active: string | undefined;
	parent: string;
	/** The filter names the project itself: all its agents show. */
	projectHit?: boolean;
};

/** The strongest state of a folded row's agents, and how many there are. */
function FoldedSummary({ list, inbox, open }: { list: readonly RailAgent[]; inbox: Inbox; open: boolean }) {
	const strongest = strongestSection(list.map((agent) => inbox.placements.get(agent.key)?.section ?? "quiet"));
	return (
		<>
			{!open && strongest && <StatusGlyph mark={STRONGEST_MARK[strongest]} size={11} />}
			{list.length > 0 && <span className="shrink-0 text-[11.5px] text-dk-ink-3 tabular-nums group-hover:invisible">{list.length}</span>}
		</>
	);
}

/** One project: its heading, then (unfolded) each checkout's row when it has company, and the worktree cards. */
function ProjectBlock(props: BlockProps & { project: RailProject }) {
	const { node, home, project, byPlace, inbox, filter, ops, renaming, setRenaming, commitRename, isCollapsed, toggleProject, onProjectMenu, parent } = props;
	const row = projectRow(node, project);
	const open = Boolean(filter) || !isCollapsed(node, project);
	const list = project.checkouts.flatMap(({ worktrees }) => worktrees.flatMap((worktree) => byPlace.get(worktree.place) ?? []));
	const only = project.checkouts.length === 1 ? project.checkouts[0]!.checkout : undefined;
	const editing = renaming === row || renaming === `${row}\ncheckout`;
	const hint = only ? homePath(sanitize(only.path), home) : project.repository;
	return (
		<section aria-label={project.name} data-project={project.id}>
			<div className="group relative flex items-center">
				{editing && ops ? (
					<div className="flex h-7 w-full items-center pr-3 pl-8">
						<InlineRename
							initial={renaming === row && project.serverKey ? project.name : sanitize(only?.name ?? project.name)}
							label={`Rename ${project.name}`}
							onCommit={(next) => commitRename(renaming!, next)}
							onCancel={() => setRenaming(undefined)}
						/>
					</div>
				) : (
					<button
						type="button"
						aria-expanded={open}
						className={cx("flex h-7 w-full items-center gap-1.5 pr-3 pl-3 text-left text-[13px] hover:bg-dk-hover", ops && "group-hover:pr-9")}
						{...tip(project.repository ? `${project.name} (${project.repository})` : hint)}
						onClick={() => toggleProject(node, project)}
						{...(ops ? menuEvents((at) => onProjectMenu(node, project, at)) : {})}
						data-sidebar-row={row}
						data-sidebar-parent={parent}
						data-project-heading=""
					>
						<Chevron open={open} />
						<span className="min-w-0 flex-1 truncate">
							<span className="font-semibold" data-project-name="">
								{project.name}
							</span>
							{!project.showPaths && hint && only && <span className="ml-1.5 text-[11.5px] text-dk-ink-3">{hint}</span>}
						</span>
						<FoldedSummary list={list} inbox={inbox} open={open} />
					</button>
				)}
				{ops && !editing && <MoreButton label={`${project.name} actions`} rowKey={row} onOpen={(button) => onProjectMenu(node, project, menuBelow(button))} />}
			</div>
			{open &&
				project.checkouts.map(({ checkout, worktrees }) => (
					<CheckoutBlock key={checkout.id} {...props} checkout={checkout} worktrees={worktrees} showPath={project.showPaths} parent={row} projectHit={Boolean(filter) && projectMatches(project, filter)} />
				))}
		</section>
	);
}

/** A checkout's row (only beside other checkouts of its project), then its worktree cards. */
function CheckoutBlock(props: BlockProps & { checkout: Checkout; worktrees: readonly RailWorktree[]; showPath: boolean }) {
	const { node, home, checkout, worktrees, showPath, ops, renaming, setRenaming, commitRename, onCheckoutMenu, onPlace, parent } = props;
	const row = checkoutRow(node, checkout);
	const path = homePath(sanitize(checkout.path), home);
	const main = worktrees.find((worktree) => worktree.isMain) ?? worktrees[0];
	return (
		<div data-checkout={checkout.id}>
			{showPath && (
				<div className="group relative flex items-center">
					{renaming === row && ops ? (
						<div className="flex h-6 w-full items-center pr-3 pl-6">
							<InlineRename initial={sanitize(checkout.name)} label={`Rename ${sanitize(checkout.name)} on this node`} onCommit={(next) => commitRename(row, next)} onCancel={() => setRenaming(undefined)} />
						</div>
					) : (
						<button
							type="button"
							className={cx("flex h-6 w-full items-center gap-1.5 pr-3 pl-6 text-left text-[12px] text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink", ops && "group-hover:pr-9")}
							{...tip(checkout.path)}
							onClick={() => main && onPlace(node, main.place)}
							onDoubleClick={() => ops?.connected(node) && ops.can(node, "checkouts") && setRenaming(row)}
							{...(ops ? menuEvents((at) => onCheckoutMenu(node, checkout, at)) : {})}
							data-sidebar-row={row}
							data-sidebar-parent={parent}
							data-checkout-row=""
						>
							<Icon name="folder" size={12} className="shrink-0 text-dk-ink-3" />
							<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" data-checkout-path="">
								{path}
							</span>
							{checkout.named && <span className="shrink-0 truncate text-[11.5px]">{sanitize(checkout.name)}</span>}
						</button>
					)}
					{ops && renaming !== row && <MoreButton label={`${path} actions`} rowKey={row} onOpen={(button) => onCheckoutMenu(node, checkout, menuBelow(button))} />}
				</div>
			)}
			{worktrees.map((worktree) => (
				<WorktreeCard key={worktree.place} {...props} checkout={checkout} worktree={worktree} parent={showPath ? row : parent} />
			))}
			{checkout.truncated && <p className="py-0.5 pr-3 pl-8 text-[11.5px] text-dk-ink-3">More worktrees than the node lists</p>}
		</div>
	);
}

/** One worktree: its folder, branch (the meta line) and markers; a click shows its workspace. Its agents follow. */
function WorktreeCard(props: BlockProps & { checkout: Checkout; worktree: RailWorktree }) {
	const { node, home, checkout, worktree, byPlace, active, inbox, filter, projectHit, ops, onPlace, onWorktreeMenu, parent } = props;
	const row = placeRow(node, worktree.place);
	const list = (byPlace.get(worktree.place) ?? []).filter((agent) => !filter || projectHit || shownByFilter(props, agent));
	const current = worktree.place === active;
	return (
		<section aria-label={worktree.title} data-worktree-card={worktree.path}>
			<div className="group relative flex items-center">
				<button
					type="button"
					aria-current={current ? "true" : undefined}
					className={cx(
						"grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 py-[3px] pr-3 pl-8 text-left text-[13px] hover:bg-dk-hover",
						ops && "group-hover:pr-9",
						current && "bg-dk-accent-soft",
						worktree.prunable && "text-dk-ink-3",
					)}
					{...tip(homePath(sanitize(worktree.path), home))}
					onClick={() => onPlace(node, worktree.place)}
					{...(ops ? menuEvents((at) => onWorktreeMenu(node, checkout, worktree, at)) : {})}
					data-sidebar-row={row}
					data-sidebar-parent={parent}
					data-worktree-open=""
					data-main={worktree.isMain ? "" : undefined}
				>
					<span className="min-w-0 truncate">
						<span className="font-medium" data-worktree-title="">
							{worktree.title}
						</span>
						<WorktreeMarkers worktree={worktree} />
					</span>
					<span className="flex shrink-0 items-center gap-1.5">
						<FoldedSummary list={list} inbox={inbox} open />
					</span>
					{worktree.meta && (
						<span className="col-span-2 flex min-w-0 items-center gap-1 text-[11.5px] text-dk-ink-3">
							<Icon name="branch" size={11} className="shrink-0" />
							<span className="min-w-0 truncate font-mono" data-worktree-meta="">
								{worktree.meta}
							</span>
						</span>
					)}
				</button>
				{ops && <MoreButton label={`${worktree.title} actions`} rowKey={row} onOpen={(button) => onWorktreeMenu(node, checkout, worktree, menuBelow(button))} />}
			</div>
			{list.length > 0 && (
				<ul aria-label={`Agents in ${worktree.title}`}>
					{list.map((agent) => {
						const placement = inbox.placements.get(agent.key);
						return placement ? <AgentRow key={agent.key} {...props} agent={agent} placement={placement} parent={row} variant="project" /> : null;
					})}
				</ul>
			)}
		</section>
	);
}

/** The node's "Other" card: terminals in no listed worktree. */
function OtherCard(props: BlockProps & { list: readonly RailAgent[] }) {
	const { node, list, inbox, filter, prefs, fold, ops, onPlace, onOtherMenu, parent } = props;
	const active = props.active === OTHER;
	const row = OTHER_ROW(node);
	const open = Boolean(filter) || !prefs.folded.includes(`${node}\n${OTHER}`);
	return (
		<section aria-label="Other" data-worktree-card={OTHER}>
			<div className="group relative flex items-center">
				<button
					type="button"
					tabIndex={-1}
					className="absolute left-3 flex size-4 items-center justify-center rounded-[2px] hover:bg-dk-hover"
					aria-label={open ? "Fold Other" : "Unfold Other"}
					onClick={() => fold(`${node}\n${OTHER}`)}
					data-sidebar-action-for={row}
					data-card-fold=""
				>
					<Chevron open={open} />
				</button>
				<button
					type="button"
					aria-current={active ? "true" : undefined}
					aria-expanded={list.length > 0 ? open : undefined}
					className={cx("flex h-7 w-full items-center gap-2 pr-3 pl-8 text-left text-[13px] hover:bg-dk-hover", ops && "group-hover:pr-9", active && "bg-dk-accent-soft")}
					{...tip("Terminals in no listed worktree")}
					onClick={() => onPlace(node, OTHER)}
					{...(ops ? menuEvents((at) => onOtherMenu(node, at)) : {})}
					data-sidebar-row={row}
					data-sidebar-parent={parent}
					data-sidebar-toggle="[data-card-fold]"
					data-worktree-open=""
				>
					<span className="min-w-0 flex-1 truncate font-medium">Other</span>
					<FoldedSummary list={list} inbox={inbox} open={open} />
				</button>
				{ops && <MoreButton label="Other actions" rowKey={row} onOpen={(button) => onOtherMenu(node, menuBelow(button))} />}
			</div>
			{open && list.length > 0 && (
				<ul aria-label="Agents in Other">
					{list.map((agent) => {
						const placement = inbox.placements.get(agent.key);
						return placement ? <AgentRow key={agent.key} {...props} agent={agent} placement={placement} parent={row} variant="project" /> : null;
					})}
				</ul>
			)}
		</section>
	);
}

const STRONGEST_MARK: Record<Exclude<Section, "quiet">, PaneMark> = { needs: "waiting", failed: "error", done: "done", working: "working" };

/** The section that says the most of a folded card's agents, for its dot: needs you, failed, done, working. */
export function strongestSection(sections: readonly Section[]): Exclude<Section, "quiet"> | undefined {
	for (const section of ["needs", "failed", "done", "working"] as const) if (sections.includes(section)) return section;
	return undefined;
}

/** A row's right-hand slot: what a waiting agent asks for, and how long ago it came back or how long it has worked. */
function StatusSlot({ agent, placement, now }: { agent: RailAgent; placement: Placement; now: number }) {
	const { terminal } = agent;
	const time = (text: string) => <span className="text-dk-ink-3 tabular-nums">{text}</span>;
	switch (placement.section) {
		case "needs":
			return (
				<>
					<span className="font-medium text-dk-needs-ink">{NEED_LABELS[needKind(terminal)]}</span>
					{time(shortAgo(placement.since, now))}
				</>
			);
		case "working":
			return time(placement.stale ? shortAgo(placement.changedAt, now) : elapsed(placement.since, now));
		case "quiet":
			return terminal.exited ? <span className="text-dk-ink-3">Exited</span> : time(shortAgo(placement.changedAt, now));
		default:
			return time(shortAgo(placement.since, now));
	}
}

const ATTENTION_INK: Partial<Record<Section, string>> = { needs: "text-dk-needs-ink", failed: "text-dk-failed-ink" };

/** One agent: its glyph, name, where it runs, its status slot, the hover actions, and its background activities. */
function AgentRow({
	agent,
	placement,
	parent,
	variant,
	inbox,
	selected,
	homeOf,
	onAgent,
	canClosePane,
	onClosePane,
	onKill,
	onRowMenu,
	ops,
	renaming,
	setRenaming,
}: ViewProps & { agent: RailAgent; placement: Placement; parent: string; variant: "status" | "project" }) {
	const { terminal, node, key } = agent;
	const state = nodeLinkState(node);
	const mark = sectionMark(placement.section, terminal, placement.stale);
	const current = key === selected;
	const unread = placement.section === "done" && !placement.held;
	const quiet = placement.section === "quiet" && !current;
	const label = paneLabel(terminal);
	const attention = attentionText(terminal, placement, inbox.now);
	const home = homeOf(node.info.id);
	// Its worktree's branch and project; outside every listed worktree, the folder's own name.
	const cwd = paneSession(terminal).cwd;
	const where = agent.where ?? (cwd === home ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1) || cwd);
	const children = childActivities(terminal);
	const closable = canClosePane(key);
	return (
		<li className="dk-row group relative" data-terminal={terminal.terminalId} data-pane-state={mark} data-section={placement.section}>
			<button
				type="button"
				aria-current={current ? "true" : undefined}
				className={cx(
					"grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-[5px] pr-3 text-left",
					variant === "status" ? "pl-3" : "pl-11",
					current ? "bg-dk-accent-soft" : "hover:bg-dk-hover",
					state !== "online" && "opacity-60",
				)}
				{...tip(homePath(cwd, home))}
				onClick={() => onAgent(key)}
				onContextMenu={(event) => {
					event.preventDefault();
					onRowMenu(key, menuAtPointer(event));
				}}
				onKeyDown={(event) => {
					if (!isMenuKey(event)) return;
					event.preventDefault();
					onRowMenu(key, menuBelow(event.currentTarget));
				}}
				data-sidebar-row={key}
				data-sidebar-parent={parent}
				data-agent-row={terminal.terminalId}
			>
				<StatusGlyph mark={mark} className="translate-y-[2px] self-start" />
				<span className={cx("flex min-w-0 items-center gap-1.5 text-[13px]", unread || current ? "font-semibold" : quiet ? "text-dk-ink-3" : "font-medium")}>
					<span className={cx("min-w-0 truncate", renaming === key && ops && "invisible")} data-agent-label="">
						{label}
					</span>
					{unread && <span className="size-1.5 shrink-0 rounded-full bg-dk-done" role="img" aria-label="Unread" />}
				</span>
				<span className="flex shrink-0 items-baseline gap-1.5 text-[11.5px] group-focus-within:invisible group-hover:invisible" data-status-slot="">
					<StatusSlot agent={agent} placement={placement} now={inbox.now} />
				</span>
				{variant === "status" && (
					<span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1 text-[11.5px] text-dk-ink-3">
						<span className="min-w-0 truncate">
							{where} · {node.info.name}
						</span>
						{state !== "online" && (
							<span className="flex shrink-0 items-center gap-1" data-row-node-state={state}>
								<NodeGlyph state={state} labelled />
								{NODE_STATE_LABELS[state].toLowerCase()}
							</span>
						)}
					</span>
				)}
				{attention && (
					<span className={cx("col-start-2 col-end-4 truncate text-[11.5px]", ATTENTION_INK[placement.section] ?? "text-dk-ink-3")} {...tip(attention)} data-attention="">
						{attention}
					</span>
				)}
			</button>
			{renaming === key && ops && (
				<div className={cx("absolute top-[2px] right-2 flex", variant === "status" ? "left-[34px]" : "left-[66px]")}>
					<InlineRename
						initial={terminal.label ?? label}
						label={`Rename ${label}`}
						onCommit={(next) => {
							setRenaming(undefined);
							ops.renameAgent(key, next);
						}}
						onCancel={() => setRenaming(undefined)}
					/>
				</div>
			)}
			<span className="invisible absolute top-[3px] right-2 flex gap-0.5 group-focus-within:visible group-hover:visible" data-row-actions="">
				{closable && (
					<RowAction label={`Close ${label}'s pane`} onClick={() => onClosePane(key)} rowKey={key} action="close-pane">
						<path d="M3 3l6 6M9 3l-6 6" />
					</RowAction>
				)}
				<RowAction
					label={terminal.exited ? `Remove ${label}` : `Kill ${label}`}
					onClick={() => onKill(key, ops ? !terminal.exited && killNeedsConfirm(placement.section) : true)}
					rowKey={key}
					action={terminal.exited ? "remove" : "kill"}
				>
					{terminal.exited ? (
						<path d="M2.5 3.5h7M4.5 3.5V2.5h3v1M3.5 3.5l.5 6.5h4l.5-6.5" />
					) : (
						<>
							<circle cx="6" cy="6" r="4.2" />
							<path d="M3.1 8.9l5.8-5.8" />
						</>
					)}
				</RowAction>
			</span>
			{children.length > 0 && <ActivityRows activities={children} parentKey={key} parentLabel={label} now={inbox.now} indent={variant === "status" ? 30 : 62} onOpen={() => onAgent(key)} />}
		</li>
	);
}

function RowAction({ label, onClick, rowKey, action, children }: { label: string; onClick: () => void; rowKey: string; action: string; children: ReactNode }) {
	return (
		<button
			type="button"
			className="flex size-[22px] items-center justify-center rounded-[3px] bg-dk-chrome text-dk-ink-2 shadow-[0_0_0_1px_var(--dk-line)] hover:text-dk-ink"
			aria-label={label}
			{...tip(label)}
			onClick={onClick}
			data-sidebar-action-for={rowKey}
			data-row-action={action}
		>
			<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				{children}
			</svg>
		</button>
	);
}

/** How many of a pane's background activities show as rows; the rest are counted. */
const ACTIVITY_ROWS = 4;

/** A pane's background activities (subagents, Herder steps) under it, indented 18 px; each opens the pane. */
function ActivityRows({ activities, parentKey, parentLabel, now, indent, onOpen }: { activities: Activity[]; parentKey: string; parentLabel: string; now: number; indent: number; onOpen: () => void }) {
	const shown = activities.slice(0, ACTIVITY_ROWS);
	const hidden = activities.length - shown.length;
	return (
		<ul aria-label={`${parentLabel}'s background activities`} data-activities={parentKey}>
			{shown.map((activity) => {
				const mark: PaneMark = activity.state === "waiting" ? "waiting" : "working";
				const progress = activity.progress ? `${activity.progress.completed}/${activity.progress.total}` : undefined;
				return (
					<li key={`${activity.source}\n${activity.id}`}>
						<button
							type="button"
							className="flex h-6 w-full items-center gap-2 pr-3 text-left text-[12px] text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink"
							style={{ paddingLeft: indent }}
							{...tip(`${sanitize(activity.label)} (${markLabel(mark).toLowerCase()})`)}
							onClick={onOpen}
							data-sidebar-row={`${parentKey}\nactivity:${activity.source}\n${activity.id}`}
							data-sidebar-parent={parentKey}
							data-activity-row={activity.id}
						>
							<StatusGlyph mark={mark} size={11} />
							<span className="min-w-0 flex-1 truncate">{sanitize(activity.label)}</span>
							{progress && <span className="shrink-0 text-[11px] text-dk-ink-3 tabular-nums">{progress}</span>}
							{activity.startedAt !== undefined && <span className="shrink-0 text-[11px] text-dk-ink-3 tabular-nums">{elapsed(activity.startedAt, now)}</span>}
						</button>
					</li>
				);
			})}
			{hidden > 0 && (
				<li className="flex h-5 items-center text-[11.5px] text-dk-ink-3" style={{ paddingLeft: indent + 19 }}>
					{hidden} more
				</li>
			)}
		</ul>
	);
}

/**
 * Every agent the rail lists: each node's terminals (the last known ones for a node that is not connected), each in
 * its place (`placeOf`), with that place in words (`whereOf`, nothing for "Other").
 */
export function railAgents(nodes: readonly NodeView[], placeOf: (node: string, terminal: TerminalInfo) => string, whereOf: (node: string, place: string) => string | undefined = () => undefined): RailAgent[] {
	return nodes.flatMap((view) =>
		view.terminals.map((terminal) => {
			const place = placeOf(view.info.id, terminal);
			const where = place === OTHER ? undefined : whereOf(view.info.id, place);
			return { key: inboxKey(view.info.id, terminal.terminalId), node: view, terminal, place, ...(where ? { where } : {}) };
		}),
	);
}

/** The rail's badge, beside the button that shows it while it is hidden. */
export function InboxBadge({ badge }: { badge: { kind: "attention" | "working"; count: number } | undefined }) {
	if (!badge) return null;
	return (
		<span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums" data-inbox-badge={badge.kind}>
			<StatusGlyph mark={badge.kind === "attention" ? "waiting" : "working"} size={11} />
			<span className={badge.kind === "attention" ? "font-medium text-dk-needs-ink" : "text-dk-ink-2"}>{badge.count}</span>
		</span>
	);
}
