import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { isMenuKey, menuAtPointer, menuBelow, useMenu, type MenuEntry } from "../deck/Menu";
import { tip } from "../deck/Tooltips";
import { homePath, paneLabel, paneSession, type NodeView } from "../client";
import { sanitize, type Activity, type Project, type TerminalInfo } from "../contract";
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
import { projectName } from "./projects";
import { installRailTree } from "./rail-tree";
import { markLabel, sectionMark, StatusGlyph, type PaneMark } from "./status";
import { OTHER } from "./store";

/** One agent as the rail lists it: a terminal on some node, in some project. */
export interface RailAgent {
	key: string;
	node: NodeView;
	terminal: TerminalInfo;
	project: string;
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
	/** `node\nproject` cards folded in the Projects view. */
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
	currentProject?: string;
	projectsOf: (node: string) => readonly Project[] | undefined;
	homeOf: (node: string) => string;
	onHover: (hovering: boolean) => void;
	onAgent: (key: string) => void;
	onNode: (node: string) => void;
	onProject: (node: string, project: string) => void;
	/** Closes the agent's pane in its workspace; absent for an agent that has none there. */
	canClosePane: (key: string) => boolean;
	onClosePane: (key: string) => void;
	onKill: (key: string) => void;
	header: ReactNode;
}

/** The left rail: every agent on every node, by what the user has to do (Status), or by node and project (Projects). */
export function AgentRail(props: AgentRailProps) {
	const [prefs, setPrefs] = useRailPrefs();
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => (list.current ? installRailTree(list.current) : undefined), []);
	const rowMenu = useMenu();
	// An agent's context menu, from the shared one; it opens outside the rows, whose containment would trap it.
	const onRowMenu = (key: string, at: { x: number; y: number; flipY?: number }) => {
		const agent = props.agents.get(key);
		if (!agent) return;
		const label = paneLabel(agent.terminal);
		const cwd = paneSession(agent.terminal).cwd;
		const items: MenuEntry[] = [
			{ id: "open", label: "Open", run: () => props.onAgent(key) },
			...(props.canClosePane(key) ? [{ id: "close-pane", label: "Close Pane", run: () => props.onClosePane(key) }] : []),
			"separator",
			{ id: "copy-cwd", label: "Copy Working Directory", run: () => void copyText(cwd) },
			"separator",
			{ id: agent.terminal.exited ? "remove" : "kill", label: agent.terminal.exited ? "Remove…" : "Kill…", danger: true, run: () => props.onKill(key) },
		];
		rowMenu.open({ ...at, items, label: label, attrs: { "data-agent-menu": key } });
	};
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
			</div>
			<div
				ref={list}
				className="min-h-0 flex-1 overflow-y-auto pb-3"
				onPointerEnter={() => props.onHover(true)}
				onPointerLeave={() => props.onHover(false)}
				data-rail-list={prefs.view}
			>
				{prefs.view === "status" ? <StatusView {...props} prefs={prefs} setPrefs={setPrefs} onRowMenu={onRowMenu} /> : <ProjectsView {...props} prefs={prefs} setPrefs={setPrefs} onRowMenu={onRowMenu} />}
			</div>
			{rowMenu.menu}
		</>
	);
}

type ViewProps = AgentRailProps & {
	prefs: RailPrefs;
	setPrefs: (change: Partial<RailPrefs>) => void;
	onRowMenu: (key: string, at: { x: number; y: number; flipY?: number }) => void;
};

function Chevron({ open }: { open: boolean }) {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" className={cx("shrink-0 text-dk-ink-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true">
			<path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** The Status view: the nodes strip, then the sections, attention first. */
function StatusView(props: ViewProps) {
	const { inbox, prefs, setPrefs } = props;
	return (
		<>
			<NodeStrip {...props} />
			{SECTIONS.map((section) => {
				const keys = inbox.layout[section];
				if (keys.length === 0 && section !== "needs") return null;
				const open = !prefs.collapsed.includes(section);
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
function NodeStrip({ nodes, currentNode, onNode }: ViewProps) {
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

/** The Projects view: each node, its project cards (foldable), each card's agents in the inbox's order. */
function ProjectsView(props: ViewProps) {
	const { nodes, agents, inbox, prefs, setPrefs, currentNode, currentProject, onNode, onProject, projectsOf, homeOf } = props;
	const [more, setMore] = useState<string | undefined>();
	const order = useMemo(() => new Map(flatLayout(inbox.layout).map((key, index) => [key, index])), [inbox.layout]);
	return (
		<>
			{nodes.map((view) => {
				const node = view.info.id;
				const state = nodeLinkState(view);
				const projects = projectsOf(node);
				const home = homeOf(node);
				const mine = [...agents.values()].filter((agent) => agent.node.info.id === node).sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
				const byProject = new Map<string, RailAgent[]>();
				for (const agent of mine) byProject.set(agent.project, [...(byProject.get(agent.project) ?? []), agent]);
				const known = projects ?? [];
				const cardOrder = [...known.map((item) => item.path), ...[...byProject.keys()].filter((path) => path !== OTHER && !known.some((item) => item.path === path)), OTHER];
				const active = node === currentNode ? currentProject : undefined;
				const cards = cardOrder.filter((path) => byProject.has(path) || path === active);
				const rest = known.filter((item) => !cards.includes(item.path));
				const nodeRow = `node:${node}`;
				return (
					<section key={node} aria-label={view.info.name} data-node-projects={node}>
						<button
							type="button"
							aria-current={node === currentNode ? "page" : undefined}
							className={cx("flex h-8 w-full items-center gap-2 pr-3 pl-3 text-left hover:bg-dk-hover", state !== "online" && "text-dk-ink-2")}
							onClick={() => onNode(node)}
							data-sidebar-row={nodeRow}
							data-node={node}
							data-node-state={state}
						>
							<NodeGlyph state={state} labelled={state !== "online"} />
							<span className="min-w-0 flex-1 truncate">
								<span className="text-[13px] font-semibold">{view.info.name}</span>
								{view.info.host && <span className="ml-1.5 text-[11.5px] text-dk-ink-3">{view.info.host}</span>}
							</span>
							{state !== "online" && <span className="shrink-0 text-[11.5px] text-dk-ink-3">{NODE_STATE_LABELS[state]}</span>}
						</button>
						{view.link.kind === "ready" && !projects && (
							<p className="py-1 pr-3 pl-8 text-[12px] text-dk-ink-3" role="status">
								Listing projects…
							</p>
						)}
						{cards.map((project) => {
							const cardKey = `${node}\n${project}`;
							const open = !prefs.folded.includes(cardKey);
							const list = byProject.get(project) ?? [];
							const name = projectName(known, project);
							const cardRow = `project:${cardKey}`;
							const strongest = strongestSection(list.map((agent) => inbox.placements.get(agent.key)?.section ?? "quiet"));
							return (
								<section key={project} aria-label={name} data-project-card={project}>
									<div className="group relative flex items-center">
										<button
											type="button"
											tabIndex={-1}
											className="absolute left-3 flex size-4 items-center justify-center rounded-[2px] hover:bg-dk-hover"
											aria-label={open ? `Fold ${name}` : `Unfold ${name}`}
											onClick={() => setPrefs({ folded: toggled(prefs.folded, cardKey) })}
											data-sidebar-action-for={cardRow}
											data-card-fold=""
										>
											<Chevron open={open} />
										</button>
										<button
											type="button"
											aria-current={project === active ? "true" : undefined}
											aria-expanded={list.length > 0 ? open : undefined}
											className={cx(
												"flex h-7 w-full items-center gap-2 pr-3 pl-8 text-left text-[13px] hover:bg-dk-hover",
												project === active && "bg-dk-accent-soft",
											)}
											{...tip(project === OTHER ? "Terminals in no project" : project)}
											onClick={() => onProject(node, project)}
											data-sidebar-row={cardRow}
											data-sidebar-parent={nodeRow}
											data-sidebar-toggle="[data-card-fold]"
											data-project-open=""
										>
											<span className="min-w-0 flex-1 truncate">
												<span className="font-medium">{name}</span>
												{project !== OTHER && <span className="ml-1.5 text-[11.5px] text-dk-ink-3">{homePath(sanitize(project), home)}</span>}
											</span>
											{!open && strongest && <StatusGlyph mark={STRONGEST_MARK[strongest]} size={11} />}
											{list.length > 0 && <span className="shrink-0 text-[11.5px] text-dk-ink-3 tabular-nums">{list.length}</span>}
										</button>
									</div>
									{open && list.length > 0 && (
										<ul aria-label={`Agents in ${name}`}>
											{list.map((agent) => {
												const placement = inbox.placements.get(agent.key);
												return placement ? <AgentRow key={agent.key} agent={agent} placement={placement} parent={cardRow} variant="project" {...props} /> : null;
											})}
										</ul>
									)}
								</section>
							);
						})}
						{rest.length > 0 && (
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
								{more === node &&
									rest.map((project) => (
										<button
											key={project.path}
											type="button"
											className="flex h-7 w-full items-center gap-2 pr-3 pl-8 text-left text-[13px] text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink"
											{...tip(project.path)}
											onClick={() => onProject(node, project.path)}
											data-sidebar-row={`project:${node}\n${project.path}`}
											data-sidebar-parent={nodeRow}
											data-project-open=""
										>
											<span className="min-w-0 flex-1 truncate">
												{sanitize(project.name)}
												<span className="ml-1.5 text-[11.5px] text-dk-ink-3">{homePath(sanitize(project.path), home)}</span>
											</span>
										</button>
									))}
							</>
						)}
					</section>
				);
			})}
		</>
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
	projectsOf,
	homeOf,
	onAgent,
	canClosePane,
	onClosePane,
	onKill,
	onRowMenu,
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
	// A project's name; outside every project, the folder's own name.
	const cwd = paneSession(terminal).cwd;
	const where = agent.project === OTHER ? (cwd === home ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1) || cwd) : projectName(projectsOf(node.info.id) ?? [], agent.project);
	const children = childActivities(terminal);
	const closable = canClosePane(key);
	return (
		<li className="dk-row group relative" data-terminal={terminal.terminalId} data-pane-state={mark} data-section={placement.section}>
			<button
				type="button"
				aria-current={current ? "true" : undefined}
				className={cx(
					"grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-[5px] pr-3 text-left",
					variant === "status" ? "pl-3" : "pl-8",
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
					<span className="min-w-0 truncate">{label}</span>
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
			<span className="invisible absolute top-[3px] right-2 flex gap-0.5 group-focus-within:visible group-hover:visible" data-row-actions="">
				{closable && (
					<RowAction label={`Close ${label}'s pane`} onClick={() => onClosePane(key)} rowKey={key} action="close-pane">
						<path d="M3 3l6 6M9 3l-6 6" />
					</RowAction>
				)}
				<RowAction label={terminal.exited ? `Remove ${label}` : `Kill ${label}`} onClick={() => onKill(key)} rowKey={key} action={terminal.exited ? "remove" : "kill"}>
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
			{children.length > 0 && <ActivityRows activities={children} parentKey={key} parentLabel={label} now={inbox.now} indent={variant === "status" ? 30 : 50} onOpen={() => onAgent(key)} />}
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

/** Every agent the rail lists: each node's terminals, the last known ones for a node that is not connected. */
export function railAgents(nodes: readonly NodeView[], projectOf: (node: string, terminal: TerminalInfo) => string): RailAgent[] {
	return nodes.flatMap((view) => view.terminals.map((terminal) => ({ key: inboxKey(view.info.id, terminal.terminalId), node: view, terminal, project: projectOf(view.info.id, terminal) })));
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
