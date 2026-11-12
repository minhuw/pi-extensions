import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Icon } from "../components/icons";
import { ModelMark } from "../components/ModelName";
import { BUTTON, Callout, ConfirmDialog, cx, EmptyState } from "../components/ui";
import { useApi } from "../lib/api";
import { withBase } from "../lib/base";
import { copyText } from "../lib/clipboard";
import { shortUserAgent } from "../lib/devices";
import { bareModelOf } from "../lib/model";
import { useHealth } from "../lib/relay";
import { useAppliedTheme } from "../lib/theme";
import { countedTitle, paneCounts, PaneAlerts } from "../nodes/alerts";
import { changeMode, ChangesStore, type Change } from "../nodes/changes";
import { homePath, liveBridge, NodesClient, paneLabel, paneSession, type NodesSnapshot, type NodeView } from "../nodes/client";
import { displayFingerprint, type NodeEvent, type Project, type TerminalInfo } from "../nodes/contract";
import { EditorStore, isDirty, type EditorSnapshot } from "../nodes/editor";
import { ChangesPanel, diffControlAt, Explorer, useChanges, usePageVisible } from "../nodes/FilePanel";
import { IndexedDbKeyStore } from "../nodes/identity";
import { actionShortcut, currentKeymap, focusOf, resolveKey, type ActionId, type PageCommands } from "../nodes/keys";
import { KeysHelp } from "../nodes/KeysHelp";
import { clampWidth, LAYOUT_BOUNDS, loadLayout, saveLayout, type NodesLayout } from "../nodes/layout";
import { ClosedPanes, closePane, paneEvent, splitPane, type PaneHost } from "../nodes/panes/actions";
import { focusNext, focusPrevious } from "../nodes/panes/pane-tree";
import { QuickOpen } from "../nodes/QuickOpen";
import { nodeSocketUrl } from "../nodes/socket";
import { Splitter } from "../nodes/Splitter";
import { WORKBENCH_ROOT } from "../nodes/workbench/tokens";
import { AgentRail, InboxBadge, railAgents, useInbox } from "../nodes/workspace/AgentRail";
import { flatLayout, inboxBadge, inboxKey, nextNeeding, splitKey, stepKey } from "../nodes/workspace/inbox";
import { markLabel, paneMark, StatusGlyph, type PaneMark } from "../nodes/workspace/status";
import {
	activate,
	activeTab,
	addTab,
	closeOthers,
	closeTab,
	diffTab,
	fileTab,
	focusGroup,
	focusPane,
	groupOf,
	moveTab,
	promote,
	reopenClosed,
	setPanes,
	setPinned,
	setSplitRatio,
	splitTab,
	tabOfTerminal,
	tabTerminals,
	terminalTab,
	type DiffTab as DiffTabSpec,
	type FileTab as FileTabSpec,
	type Workspace,
	type WorkspaceTab,
} from "../nodes/workspace/model";
import { paneLeaves } from "../nodes/workspace/panes";
import { projectName, projectOfTerminal } from "../nodes/workspace/projects";
import { RecentTerminals } from "../nodes/workspace/recent";
import { SlotRegistry } from "../nodes/workspace/slots";
import { OTHER, WorkspaceHub, type NodeWorkspaces } from "../nodes/workspace/store";
import { layerKey, TerminalLayer, type LayerTerminal } from "../nodes/workspace/TerminalLayer";
import { WorkspaceView, type WorkspaceActions } from "../nodes/workspace/WorkspaceView";

/** The command that moves this browser's pending entry into the node's allowlist (NODE.md, "Enrolment"). */
export const enrolCommand = (clientFingerprint: string): string => `pika-node clients add ${clientFingerprint.slice(0, 32)}`;

const EMPTY: NodesSnapshot = { status: "loading", nodes: [] };

function useNodesClient(): NodesClient | null {
	const api = useApi();
	const [client, setClient] = useState<NodesClient | null>(null);
	useEffect(() => {
		const next = new NodesClient({
			socketUrl: nodeSocketUrl(withBase(api.base, "api/v1/node/connect")),
			store: new IndexedDbKeyStore(),
			label: shortUserAgent(navigator.userAgent).slice(0, 64),
		});
		setClient(next);
		void next.start();
		return () => {
			next.dispose();
			setClient(null);
		};
	}, [api.base]);
	return client;
}

const noop = () => () => {};

function useSnapshot(client: NodesClient | null): NodesSnapshot {
	return useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? (() => EMPTY));
}

export function NodesPage() {
	const health = useHealth();
	if (health.isPending) return <div className="p-8 text-muted" role="status">Loading…</div>;
	if (!health.data?.features?.includes("nodes")) {
		return (
			<EmptyState title="Nodes are off on this server">
				Start pika with <code className="code-chip">PIKA_NODES=on</code> to reach terminals on your machines.
			</EmptyState>
		);
	}
	return <NodesWorkspace />;
}

/** The page's pane sizes: state while dragging, stored when a drag or key ends. */
function useLayout(): [NodesLayout, (change: Partial<NodesLayout>, commit?: boolean) => void] {
	const [layout, setLayout] = useState(loadLayout);
	const update = useCallback((change: Partial<NodesLayout>, commit = true) => {
		setLayout((current) => {
			const next = { ...current, ...change };
			if (commit) saveLayout(next);
			return next;
		});
	}, []);
	return [layout, update];
}

/** One editor store per node, kept while the page is open: the content of every file and diff tab on that node. */
function useEditors(client: NodesClient | null, snapshot: NodesSnapshot): (node: string) => EditorStore {
	const editors = useRef(new Map<string, EditorStore>());
	const latestClient = useRef(client);
	latestClient.current = client;
	const editorFor = useCallback((node: string) => {
		let store = editors.current.get(node);
		if (!store) {
			store = new EditorStore();
			// A store first asked for on a route change, with no new snapshot to run the effect below, has its files now.
			store.setFiles(latestClient.current?.files(node));
			editors.current.set(node, store);
		}
		return store;
	}, []);
	// Each store follows its node's channel: undefined while disconnected, a new file layer on each new channel.
	useEffect(() => {
		for (const [node, store] of editors.current) store.setFiles(client?.files(node));
	}, [client, snapshot]);
	useEffect(() => {
		const stores = editors.current;
		return () => {
			for (const store of stores.values()) store.dispose();
			stores.clear();
		};
	}, []);
	return editorFor;
}

/** The projects each ready node lists, asked again when its terminals change (a new terminal's cwd may add one). */
function useProjects(client: NodesClient | null, snapshot: NodesSnapshot): ReadonlyMap<string, Project[]> {
	const [projects, setProjects] = useState<ReadonlyMap<string, Project[]>>(new Map());
	const asked = useRef(new Map<string, string>());
	useEffect(() => {
		if (!client) return;
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const view of snapshot.nodes) {
			const node = view.info.id;
			if (view.link.kind !== "ready" || !view.listed) continue;
			const key = `${view.epoch}\n${view.terminals.map((item) => item.terminalId).join(" ")}`;
			if (asked.current.get(node) === key) continue;
			const first = !asked.current.has(node) || !asked.current.get(node)!.startsWith(`${view.epoch}\n`);
			asked.current.set(node, key);
			const files = client.files(node);
			if (!files) continue;
			const run = () =>
				files.request("projects.list", {}).then(
					(result) => setProjects((current) => new Map(current).set(node, result.projects)),
					// A node that cannot list projects still shows its terminals, all in "Other".
					() => setProjects((current) => (current.has(node) ? current : new Map(current).set(node, []))),
				);
			if (first) void run();
			else timers.push(setTimeout(() => void run(), 500));
		}
		return () => timers.forEach(clearTimeout);
	}, [client, snapshot]);
	return projects;
}

/**
 * The page's shortcuts (`nodes/keys.ts`): one listener on the window, ahead of the terminal and Monaco, that runs the
 * action a key resolves to with focus where it is. Nothing runs while a dialog is open.
 */
function useKeyDispatch(commands: MutableRefObject<PageCommands>) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			if (document.querySelector("[aria-modal='true']")) return;
			const action = resolveKey(currentKeymap(), event, focusOf(event.target));
			const run = action && commands.current[action];
			if (!run || run() === false) return;
			event.preventDefault();
			event.stopPropagation();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [commands]);
}

/** A button's title with its action's shortcut, when it has one. */
const withShortcut = (label: string, action: ActionId): string => {
	const shortcut = actionShortcut(action);
	return shortcut ? `${label} (${shortcut})` : label;
};

const shown = (element: Element | null | undefined): element is HTMLElement => element instanceof HTMLElement && element.getClientRects().length > 0;

/** Focuses the first element `selectors` names that is on screen; false when none is. */
function focusFirst(...selectors: string[]): boolean {
	for (const selector of selectors) {
		const element = [...document.querySelectorAll<HTMLElement>(selector)].find(shown);
		if (element) {
			element.focus();
			return true;
		}
	}
	return false;
}

/**
 * Focuses what `find` returns once it is on screen (a terminal placed next frame, Monaco loading), for up to 2 s;
 * then what `fallback` returns, if anything.
 */
function focusWhenShown(find: () => Element | null | undefined, fallback?: () => Element | null | undefined): () => void {
	let tries = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const step = () => {
		const element = find();
		if (shown(element)) element.focus();
		else if (++tries < 40) timer = setTimeout(step, 50);
		else {
			const other = fallback?.();
			if (shown(other)) other.focus();
		}
	};
	const frame = requestAnimationFrame(step);
	return () => {
		cancelAnimationFrame(frame);
		clearTimeout(timer);
	};
}

const byData = (attribute: string, value: string): HTMLElement | undefined =>
	[...document.querySelectorAll<HTMLElement>(`[${attribute}]`)].find((element) => element.getAttribute(attribute) === value);

const FOCUS_FILES = [
	"[data-file-panel] [data-changes] [aria-current='true']",
	"[data-file-panel] [data-changes] button[data-change]:not(:disabled)",
	"[data-file-panel] [data-file-tree] [aria-selected='true']",
	"[data-file-panel] [data-file-tree] [role='treeitem']",
	"[data-file-panel] [data-changes] button",
	// Nothing listed (not a repository, an empty folder): the panel's switch.
	"[data-file-panel] [data-activity][aria-pressed='true']",
];

type Permission = NotificationPermission | "unsupported";

/** The page's notification permission; asked for only from `request`, which a click calls. */
function useNotificationPermission(): [Permission, () => void] {
	const supported = typeof Notification !== "undefined";
	const [permission, setPermission] = useState<Permission>(supported ? Notification.permission : "unsupported");
	const request = useCallback(() => {
		if (supported) void Notification.requestPermission().then(setPermission);
	}, [supported]);
	return [permission, request];
}

/**
 * Browser notifications for panes that start waiting or finish while the page is hidden or shows another pane; a
 * click brings the page forward on that pane. The tab's title counts waiting and finished panes on every node.
 */
function usePaneAlerts(snapshot: NodesSnapshot, nodeId: string | undefined, terminalId: string | undefined, show: (node: string, terminalId: string) => void, working: number) {
	const alerts = useRef(new PaneAlerts());
	const notifications = useRef(new Map<string, Notification>());
	const baseTitle = useRef(document.title);
	const showRef = useRef(show);
	showRef.current = show;

	useEffect(() => {
		const visible = document.visibilityState === "visible";
		const fired = alerts.current.update(snapshot.nodes, { node: nodeId, terminalId, visible });
		const onScreen = nodeId && terminalId ? `${nodeId}\n${terminalId}` : undefined;
		// Looking at the pane answers its notification.
		if (visible && onScreen) {
			notifications.current.get(onScreen)?.close();
			notifications.current.delete(onScreen);
		}
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		for (const alert of fired) {
			const key = `${alert.node}\n${alert.terminalId}`;
			let notification: Notification;
			try {
				notification = new Notification(alert.title, { body: alert.body, tag: `pika-node:${key}` });
			} catch (error) {
				// Android's Chrome allows notifications only from a service worker.
				console.warn("pika: a notification could not be shown", error);
				return;
			}
			notifications.current.get(key)?.close();
			notifications.current.set(key, notification);
			notification.onclick = () => {
				window.focus();
				showRef.current(alert.node, alert.terminalId);
				notification.close();
			};
			notification.onclose = () => {
				if (notifications.current.get(key) === notification) notifications.current.delete(key);
			};
		}
	}, [snapshot, nodeId, terminalId]);

	useEffect(() => {
		document.title = countedTitle(baseTitle.current, paneCounts(snapshot.nodes), working);
	}, [snapshot, working]);

	useEffect(() => {
		const open = notifications.current;
		const base = baseTitle.current;
		return () => {
			document.title = base;
			for (const notification of open.values()) notification.close();
			open.clear();
		};
	}, []);
}

const EMPTY_EDITORS: EditorSnapshot = { tabs: [] };

/** The project a node shows: the one picked last, else the first with a terminal, else "Other". */
function shownProject(ws: NodeWorkspaces, view: NodeView, projects: readonly Project[] | undefined): string {
	if (ws.active) return ws.active;
	const first = view.terminals[0];
	if (!first) return projects?.[0]?.path ?? OTHER;
	return ws.projectOf(first.terminalId) ?? (projects ? projectOfTerminal(projects, first) : OTHER);
}

/** The pane that has focus in a workspace: the focused group's terminal tab's focused pane. */
function focusedTerminal(ws: Workspace | undefined): string | undefined {
	const tab = ws && activeTab(ws);
	return tab?.kind === "terminal" ? tab.focused : undefined;
}

interface Killing {
	node: string;
	terminal: TerminalInfo;
}

interface Closing {
	node: string;
	project: string;
	tabId: string;
	name: string;
}

function NodesWorkspace() {
	const client = useNodesClient();
	const snapshot = useSnapshot(client);
	const navigate = useNavigate();
	const theme = useAppliedTheme();
	const { node: nodeId, terminal: routeTerminal } = useParams();
	const selected = snapshot.nodes.find((item) => item.info.id === nodeId);
	const [layout, setLayout] = useLayout();
	const editorFor = useEditors(client, snapshot);
	const hub = useMemo(() => new WorkspaceHub(), []);
	const hubVersion = useSyncExternalStore(hub.subscribe, hub.getVersion);
	const registry = useMemo(() => new SlotRegistry(), []);
	const recentTerminals = useMemo(() => new RecentTerminals(), []);
	const projects = useProjects(client, snapshot);
	const [quickOpen, setQuickOpen] = useState(false);
	const [help, setHelp] = useState(false);
	const [killing, setKilling] = useState<Killing | null>(null);
	const [closing, setClosing] = useState<Closing | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [permission, requestPermission] = useNotificationPermission();
	const commands = useRef<PageCommands>({});
	useKeyDispatch(commands);
	const latest = useRef({ snapshot, projects, nodeId });
	latest.current = { snapshot, projects, nodeId };

	const viewOf = useCallback((node: string) => latest.current.snapshot.nodes.find((item) => item.info.id === node), []);
	const terminalOf = useCallback((node: string, terminalId: string) => viewOf(node)?.terminals.find((item) => item.terminalId === terminalId), [viewOf]);
	/** Where a terminal goes: the project whose workspace shows it, else the one its cwd is in. */
	const projectFor = useCallback(
		(node: string, terminal: TerminalInfo) => hub.get(node).projectOf(terminal.terminalId) ?? projectOfTerminal(latest.current.projects.get(node) ?? [], terminal),
		[hub],
	);
	const projectShown = useCallback(
		(node: string) => {
			const view = viewOf(node);
			return view ? shownProject(hub.get(node), view, latest.current.projects.get(node)) : (hub.get(node).active ?? OTHER);
		},
		[hub, viewOf],
	);

	// --- Placing terminals and opening files ------------------------------------------------------------------

	const revealed = useRef<string | undefined>(undefined);
	/** Shows a pane: its project, its tab, and focus in it; the address follows. */
	const showPane = useCallback(
		(node: string, terminalId: string, project?: string) => {
			const terminal = terminalOf(node, terminalId);
			if (!terminal) return;
			hub.get(node).reveal(project ?? projectFor(node, terminal), terminalId);
			revealed.current = `${node}\n${terminalId}`;
			navigate(`/nodes/${encodeURIComponent(node)}/${encodeURIComponent(terminalId)}`);
		},
		[hub, navigate, projectFor, terminalOf],
	);

	// A pane named in the address (a link, a notification, a reload) shows once the node lists it.
	useEffect(() => {
		if (!nodeId || !routeTerminal || !selected?.listed || !projects.has(nodeId)) return;
		const key = `${nodeId}\n${routeTerminal}`;
		if (revealed.current === key) return;
		const terminal = selected.terminals.find((item) => item.terminalId === routeTerminal);
		if (!terminal) return;
		revealed.current = key;
		hub.get(nodeId).reveal(projectFor(nodeId, terminal), routeTerminal);
	}, [nodeId, routeTerminal, selected, projects, hub, projectFor]);

	// Each listed node's terminals in its workspaces: gone ones leave, new ones get a tab in their project.
	useEffect(() => {
		for (const view of snapshot.nodes) {
			const list = projects.get(view.info.id);
			if (view.link.kind !== "ready" || !list) continue;
			const ws = hub.get(view.info.id);
			ws.reconcile(
				view.terminals.map((terminal) => ({ terminalId: terminal.terminalId, project: ws.projectOf(terminal.terminalId) ?? projectOfTerminal(list, terminal), exited: Boolean(terminal.exited) })),
				view.listed,
			);
		}
	}, [snapshot, projects, hub]);

	// Every file and diff tab's content in its node's editor store; restored files that cannot be read go.
	useEffect(() => {
		if (!client) return;
		for (const view of snapshot.nodes) {
			const node = view.info.id;
			const files = client.files(node);
			if (!files) continue;
			const store = editorFor(node);
			store.setFiles(files);
			const ws = hub.get(node);
			const wanted = new Map<string, FileTabSpec | DiffTabSpec>();
			for (const layoutOf of ws.getSnapshot().layouts.values()) for (const tab of Object.values(layoutOf.tabs)) if (tab.kind !== "terminal") wanted.set(tab.id, tab);
			for (const [key, tab] of wanted) {
				if (store.tab(key)) continue;
				if (tab.kind === "diff") {
					void store.openDiff(tab.path, tab.mode, tab.from);
					continue;
				}
				void store.open(tab.path).then(() => {
					if (!ws.restoredFiles().has(key)) return;
					const body = store.tab(key);
					if (body?.kind === "file" && (body.body.kind === "missing" || body.body.kind === "failed")) ws.failedToOpen(key);
					else ws.opened(key);
				});
			}
			for (const tab of store.getSnapshot().tabs) if (!wanted.has(tab.key)) store.close(tab.key);
		}
	}, [client, snapshot, hub, hubVersion, editorFor]);

	/**
	 * Opens a file or diff tab by the placement rule: beside the terminal it came from (`source`), else beside the
	 * focused group. Focus moves to it only when `focus` says so.
	 */
	const openEditor = useCallback(
		(node: string, tab: FileTabSpec | DiffTabSpec, options: { source?: string; focus?: boolean; at?: { line: number; column?: number } } = {}): string => {
			const ws = hub.get(node);
			const project = (options.source && ws.projectOf(options.source)) || projectShown(node);
			const layoutOf = ws.layout(project);
			const sourceTab = options.source ? tabOfTerminal(layoutOf, options.source) : undefined;
			const sourceGroupId = sourceTab ? groupOf(layoutOf, sourceTab.id)?.id : undefined;
			ws.openEditor(project, tab, { ...(sourceGroupId ? { sourceGroupId } : {}), ...(options.focus ? { focus: true } : {}) });
			const store = editorFor(node);
			store.setFiles(client?.files(node));
			if (tab.kind === "file") void store.open(tab.path, options.at);
			else void store.openDiff(tab.path, tab.mode, tab.from);
			return project;
		},
		[client, editorFor, hub, projectShown],
	);

	const openChange = useCallback(
		(node: string, change: Change) => {
			if (change.submodule) return;
			const mode = changeMode(change);
			openEditor(node, mode ? diffTab(change.path, mode, change.from) : fileTab(change.path));
		},
		[openEditor],
	);

	// The bridge's /pika-open and /pika-diff open beside the pane that asked, which comes on screen. A tab in the
	// background ignores them (NODE.md, "Requests from the bridge"). A pane whose terminal ends loses its leaf.
	const onNodeEvent = useRef<(node: string, event: NodeEvent) => void>(() => {});
	useEffect(() => {
		if (!client) return;
		return client.onEvent((node, event) => onNodeEvent.current(node, event));
	}, [client]);
	// Terminals hung up by closing their pane leave the node's list once they exit.
	const closedPanes = useMemo(() => client && new ClosedPanes(client, (error) => setActionError(error instanceof Error ? error.message : String(error))), [client]);

	// --- Panes -----------------------------------------------------------------------------------------------

	/** The `PaneHost` for one terminal tab, read fresh each time; `focus` sends focus to the pane it leaves focused. */
	const paneHost = useCallback(
		(node: string, project: string, tabId: string, focus = true): PaneHost | undefined => {
			if (!client || !closedPanes) return undefined;
			const ws = hub.get(node);
			return {
				client,
				node,
				closed: closedPanes,
				read: () => {
					const tab = ws.layout(project).tabs[tabId];
					return tab?.kind === "terminal" ? { tree: tab.panes, focused: tab.focused } : undefined;
				},
				write: (tab) => {
					for (const id of paneLeaves(tab.tree)) ws.know(id);
					ws.update(project, (current) => setPanes(current, tabId, tab.tree, tab.focused), focus ? { tabId, terminalId: tab.focused } : undefined);
				},
				closeTab: () => ws.update(project, (current) => closeTab(current, tabId, { forget: true })),
				terminal: (id) => terminalOf(node, id),
			};
		},
		[client, closedPanes, hub, terminalOf],
	);

	const run = useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		setActionError(null);
		try {
			await action();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, []);

	onNodeEvent.current = (node, event) => {
		if (event.type === "term.exit" || event.type === "term.removed") {
			closedPanes?.event(node, event);
			const ws = hub.get(node);
			const project = ws.projectOf(event.terminalId);
			const tab = project ? tabOfTerminal(ws.layout(project), event.terminalId) : undefined;
			const host = project && tab ? paneHost(node, project, tab.id, false) : undefined;
			if (host) paneEvent(host, event);
			return;
		}
		if (event.type !== "pane.open" && event.type !== "pane.diff") return;
		if (document.visibilityState !== "visible") return;
		const tab = event.type === "pane.open" ? fileTab(event.path) : diffTab(event.path, event.staged ? "staged" : "worktree");
		const at = event.type === "pane.open" && event.line ? { line: event.line, ...(event.column ? { column: event.column } : {}) } : undefined;
		const project = openEditor(node, tab, { source: event.terminalId, ...(at ? { at } : {}) });
		const ws = hub.get(node);
		if (ws.active !== project) ws.setActive(project);
		if (latest.current.nodeId !== node) navigate(`/nodes/${encodeURIComponent(node)}/${encodeURIComponent(event.terminalId)}`);
	};

	/** A new terminal in `project`'s root, in `groupId` (the focused group by default), with focus. */
	const newTerminal = useCallback(
		(node: string, project: string, groupId?: string) =>
			void run(async () => {
				if (!client) return;
				const ws = hub.get(node);
				const release = ws.holdNewTerminals();
				try {
					const created = await client.createTerminal(node, { cols: 80, rows: 24 }, project === OTHER ? undefined : project);
					ws.know(created.terminalId);
					const tab = terminalTab(created.terminalId);
					ws.update(project, (current) => addTab(current, tab, groupId ? { groupId } : {}), { tabId: tab.id, terminalId: created.terminalId });
					if (ws.active !== project) ws.setActive(project);
				} finally {
					release();
				}
			}),
		[client, hub, run],
	);

	const splitFocused = (node: string, project: string, tabId: string, direction: "row" | "column") =>
		void run(async () => {
			const host = paneHost(node, project, tabId);
			if (!host) return;
			const release = hub.get(node).holdNewTerminals();
			try {
				await splitPane(host, direction);
			} finally {
				release();
			}
		});

	const closePaneOf = (node: string, project: string, tabId: string, terminalId: string) =>
		void run(async () => {
			const host = paneHost(node, project, tabId);
			if (host) await closePane(host, terminalId);
		});

	/** Closes a tab, asking first when its file has unsaved edits. A terminal tab's terminals keep running. */
	const requestClose = (node: string, project: string, tabId: string) => {
		const ws = hub.get(node);
		const tab = ws.layout(project).tabs[tabId];
		if (!tab) return;
		const editor = tab.kind === "file" ? editorFor(node).tab(tabId) : undefined;
		if (editor && isDirty(editor)) {
			setClosing({ node, project, tabId, name: editor.name });
			return;
		}
		ws.update(project, (current) => closeTab(current, tabId));
	};

	// --- What is on screen -----------------------------------------------------------------------------------

	const ready = client && selected && selected.link.kind === "ready" ? selected : undefined;
	const home = ready?.link.kind === "ready" ? ready.link.welcome.home : "/";
	const ws = ready ? hub.get(ready.info.id) : undefined;
	const nodeProjects = ready ? projects.get(ready.info.id) : undefined;
	const project = ready && ws ? shownProject(ws, ready, nodeProjects) : undefined;
	const workspace = ws && project ? ws.layout(project) : undefined;
	const onScreen = focusedTerminal(workspace);
	const onScreenInfo = ready && onScreen ? ready.terminals.find((item) => item.terminalId === onScreen) : undefined;
	// The header's session: the pane on screen, else (an editor or diff in focus) the project's last focused pane.
	const headerInfo = ready && project ? recentTerminals.shown(ready.info.id, project, onScreen, ready.terminals) : undefined;
	const editors = ready ? editorFor(ready.info.id) : undefined;
	const editorSnapshot = useSyncExternalStore(editors?.subscribe ?? noop, editors?.getSnapshot ?? (() => EMPTY_EDITORS));
	const readyFiles = ready && client?.files(ready.info.id);
	// The rail's inbox: every agent on every node, by what the user has to do; held still while the pointer is on it.
	const [hovering, setHovering] = useState(false);
	const agents = useMemo(() => railAgents(snapshot.nodes, projectFor), [snapshot, projects, hubVersion, projectFor]);
	const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
	const selectedKey = ready && onScreen ? inboxKey(ready.info.id, onScreen) : undefined;
	const inbox = useInbox(agents, selectedKey, hovering);
	const badge = inboxBadge(inbox.layout);
	usePaneAlerts(snapshot, ready?.info.id, onScreen, showPane, inbox.layout.working.length);

	// The explorer's folder: the project on screen ("Other": the focused pane's), or one picked by hand until the
	// project changes.
	const [picked, setPicked] = useState<{ key: string; root: string }>();
	const rootKey = `${ready?.info.id}\n${project}`;
	const projectRoot = project === OTHER || !project ? (onScreenInfo ? paneSession(onScreenInfo).cwd : home) : project;
	const root = picked?.key === rootKey ? picked.root : projectRoot;

	// git's changes for the folder, polled while the list or a diff of this node shows.
	const changes = useMemo(() => (readyFiles && editors ? new ChangesStore(readyFiles, root, { onChanged: (paths) => editors.refreshDiffs(paths) }) : undefined), [readyFiles, editors, root]);
	useEffect(() => () => changes?.dispose(), [changes]);
	const changesView = useChanges(changes);
	const visible = usePageVisible();
	const diffOpen = editorSnapshot.tabs.some((tab) => tab.kind === "diff");
	useEffect(() => changes?.setActive(visible && ((layout.filesOpen && layout.sidebar === "changes") || diffOpen)), [changes, visible, layout.filesOpen, layout.sidebar, diffOpen]);

	// Unsaved edits ask before the page goes.
	const dirty = editorSnapshot.tabs.some(isDirty);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	// Focus asked for by the workspace (a revealed pane, a new terminal, a file opened from the explorer).
	const focus = ws?.getSnapshot().focus;
	useEffect(() => {
		if (!focus || !ready || focus.project !== project) return;
		const node = ready.info.id;
		if (focus.terminalId) {
			const id = focus.terminalId;
			return focusWhenShown(() => byData("data-layer-terminal", layerKey(node, id))?.querySelector(".xterm-helper-textarea"));
		}
		// The editor once Monaco has drawn it (in a diff, the modified side); its tab when there is none (a binary file).
		return focusWhenShown(
			() => [...(byData("data-tab-body", focus.tabId)?.querySelectorAll(".monaco-editor textarea") ?? [])].filter(shown).at(-1),
			() => byData("data-tab-id", focus.tabId)?.querySelector("[role='tab']"),
		);
		// Each request once, by its serial.
	}, [focus?.serial]);

	// Every terminal a workspace on a ready node shows, drawn once by the layer.
	const layerTerminals = useMemo(() => {
		const out: LayerTerminal[] = [];
		if (!client) return out;
		for (const view of snapshot.nodes) {
			const channel = client.channel(view.info.id);
			if (view.link.kind !== "ready" || !channel) continue;
			const placed = new Set<string>();
			for (const layoutOf of hub.get(view.info.id).getSnapshot().layouts.values()) for (const tab of Object.values(layoutOf.tabs)) for (const id of tabTerminals(tab)) placed.add(id);
			for (const terminal of view.terminals) {
				if (placed.has(terminal.terminalId)) out.push({ node: view.info.id, epoch: view.epoch, channel, terminal, home: view.link.welcome.home });
			}
		}
		return out;
		// hubVersion: a tab placed or closed changes what is drawn.
	}, [client, snapshot, hub, hubVersion]);

	const onLayerFocus = useCallback(
		(node: string, terminalId: string) => {
			const nodeWs = hub.get(node);
			const owner = nodeWs.projectOf(terminalId);
			if (owner) nodeWs.update(owner, (current) => focusPane(current, terminalId));
		},
		[hub],
	);
	const onLayerKill = useCallback((node: string, terminal: TerminalInfo) => setKilling({ node, terminal }), []);
	const onLayerOpen = useCallback(
		(node: string, terminalId: string, path: string, at?: { line: number; column?: number }) => void openEditor(node, fileTab(path), { source: terminalId, ...(at ? { at } : {}) }),
		[openEditor],
	);
	const onSeen = useCallback((node: string, terminalId: string) => client?.seen(node, terminalId), [client]);
	const slots = useMemo(() => (ready ? registry.forNode(ready.info.id) : undefined), [registry, ready]);
	const onLayout = useCallback(() => registry.layoutChanged(), [registry]);

	// --- Commands --------------------------------------------------------------------------------------------

	const actions: WorkspaceActions | undefined =
		ready && ws && project && slots
			? {
					activate: (tabId) => ws.update(project, (current) => activate(current, tabId)),
					focusGroup: (groupId) => ws.update(project, (current) => focusGroup(current, groupId)),
					close: (tabId) => requestClose(ready.info.id, project, tabId),
					closeOthers: (tabId) => {
						const current = ws.layout(project);
						const group = groupOf(current, tabId);
						const dirtyOther = group?.tabOrder.find((id) => id !== tabId && !current.tabs[id]?.pinned && editors?.tab(id) && isDirty(editors.tab(id)!));
						if (dirtyOther) return requestClose(ready.info.id, project, dirtyOther);
						ws.update(project, (next) => closeOthers(next, tabId));
					},
					setPinned: (tabId, pinned) => ws.update(project, (current) => setPinned(current, tabId, pinned)),
					move: (tabId, groupId, index) => ws.update(project, (current) => moveTab(current, tabId, groupId, index)),
					split: (tabId, groupId, side) => ws.update(project, (current) => splitTab(current, tabId, groupId, side)),
					setRatio: (path, ratio) => ws.update(project, (current) => setSplitRatio(current, path, ratio)),
					setPanes: (tabId, tree) => ws.update(project, (current) => setPanes(current, tabId, tree)),
					focusPane: (tabId, terminalId) => ws.update(project, (current) => focusPane(current, terminalId), { tabId, terminalId }),
					splitPane: (tabId, direction) => splitFocused(ready.info.id, project, tabId, direction),
					closePane: (tabId, terminalId) => closePaneOf(ready.info.id, project, tabId, terminalId),
					newTerminal: (groupId) => newTerminal(ready.info.id, project, groupId),
					promote: (tabId) => {
						const tab = ws.layout(project).tabs[tabId];
						if (tab?.kind === "file" && tab.preview) ws.update(project, (current) => promote(current, tabId));
					},
					resizeEnd: () => slots.resizeEnd(),
				}
			: undefined;

	const page = commands.current;
	const tabsOf = () => (workspace ? (workspace.groups[workspace.activeGroupId]?.tabOrder ?? []) : []);
	const activeId = workspace ? activeTab(workspace)?.id : undefined;
	const stepTab = (step: 1 | -1) => {
		const order = tabsOf();
		if (!actions || order.length === 0) return false;
		const at = activeId ? order.indexOf(activeId) : -1;
		const next = order[(at + step + order.length) % order.length]!;
		actions.activate(next);
		ws!.requestFocus(project!, next, ws!.layout(project!).tabs[next]?.kind === "terminal" ? (ws!.layout(project!).tabs[next] as { focused: string }).focused : undefined);
	};
	const goKey = (key: string | undefined) => {
		if (!key) return false;
		const { node, terminalId } = splitKey(key);
		showPane(node, terminalId);
	};
	page.help = () => setHelp(true);
	// Taken even when there is nothing to open, so the browser's print dialog never shows on this page.
	page.quickOpen = () => {
		if (readyFiles) setQuickOpen(true);
	};
	// Agents in the rail's order, attention first.
	page["pane.next"] = () => goKey(stepKey(flatLayout(inbox.layout), selectedKey, 1));
	page["pane.previous"] = () => goKey(stepKey(flatLayout(inbox.layout), selectedKey, -1));
	page["pane.waiting"] = () => goKey(nextNeeding(inbox.layout, selectedKey));
	page["terminal.new"] = () => (ready && project && !busy ? newTerminal(ready.info.id, project) : false);
	page["tab.next"] = () => stepTab(1);
	page["tab.previous"] = () => stepTab(-1);
	for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
		page[`tab.${n}`] = () => {
			const order = tabsOf();
			const id = n === 9 ? order.at(-1) : order[n - 1];
			if (!id || !actions) return false;
			actions.activate(id);
			const tab = workspace!.tabs[id];
			ws!.requestFocus(project!, id, tab?.kind === "terminal" ? tab.focused : undefined);
		};
	}
	page["tab.close"] = () => (actions && activeId ? actions.close(activeId) : false);
	page["tab.reopen"] = () => {
		if (!ws || !project || !ready) return false;
		const live = new Set(ready.terminals.filter((item) => !item.exited).map((item) => item.terminalId));
		const usable = (tab: WorkspaceTab) => tabTerminals(tab).every((id) => live.has(id) && !ws.projectOf(id));
		ws.update(project, (current) => reopenClosed(current, usable));
		const reopened = activeTab(ws.layout(project));
		if (reopened) ws.requestFocus(project, reopened.id, reopened.kind === "terminal" ? reopened.focused : undefined);
	};
	page["sidebar.left"] = () => setLayout({ railOpen: !layout.railOpen });
	page["files.toggle"] = () => (ready ? setLayout({ filesOpen: !layout.filesOpen }) : false);
	/** The terminal tab focus is in, with its pane. */
	const focusedPane = () => {
		if (!workspace) return undefined;
		const tab = activeTab(workspace);
		return tab?.kind === "terminal" ? tab : undefined;
	};
	page["split.right"] = () => {
		const tab = focusedPane();
		if (!tab || !actions) return false;
		actions.splitPane(tab.id, "row");
	};
	page["split.down"] = () => {
		const tab = focusedPane();
		if (!tab || !actions) return false;
		actions.splitPane(tab.id, "column");
	};
	page["split.focusNext"] = () => {
		const tab = focusedPane();
		if (!tab || tab.panes.type === "leaf" || !actions) return false;
		actions.focusPane(tab.id, focusNext(tab.panes, tab.focused));
	};
	page["split.focusPrevious"] = () => {
		const tab = focusedPane();
		if (!tab || tab.panes.type === "leaf" || !actions) return false;
		actions.focusPane(tab.id, focusPrevious(tab.panes, tab.focused));
	};
	page["split.close"] = () => {
		const tab = focusedPane();
		if (!tab || !actions) return false;
		actions.closePane(tab.id, tab.focused);
	};
	page["focus.terminal"] = () => {
		const id = onScreen;
		if (ready && id) {
			const textarea = byData("data-layer-terminal", layerKey(ready.info.id, id))?.querySelector<HTMLElement>(".xterm-helper-textarea");
			if (textarea && shown(textarea.closest("[data-layer-terminal]"))) return void textarea.focus();
		}
		return focusFirst("[data-layer-terminal][data-visible] .xterm-helper-textarea");
	};
	page["focus.files"] = () => {
		if (!ready) return false;
		if (focusFirst(...FOCUS_FILES)) return;
		// The sidebar is hidden: show it, then focus once it has drawn and listed something (or given up, after a second).
		setLayout({ filesOpen: true });
		let tries = 0;
		const retry = () => {
			if (!focusFirst(...FOCUS_FILES.slice(0, -1)) && ++tries < 20) setTimeout(retry, 50);
			else if (tries >= 20) focusFirst(...FOCUS_FILES);
		};
		setTimeout(retry, 0);
	};
	page["focus.editor"] = () => {
		const group = workspace && document.querySelector(`[data-group-id="${CSS.escape(workspace.activeGroupId)}"]`);
		const inGroup = [...(group?.querySelectorAll(".monaco-editor textarea") ?? [])].filter(shown);
		// In a diff, the right-hand (modified) side.
		const editor = inGroup.at(-1) ?? [...document.querySelectorAll("[data-workspace] .monaco-editor textarea")].filter(shown).at(-1);
		if (editor) return void editor.focus();
		return false;
	};
	page["diff.next"] = () => {
		const control = diffControlAt(document.activeElement);
		return control ? control.go("next") : false;
	};
	page["diff.previous"] = () => {
		const control = diffControlAt(document.activeElement);
		return control ? control.go("previous") : false;
	};

	/** The workspace tab and project an agent's pane is in, when it has one on a ready node. */
	const paneTabOf = (key: string) => {
		const { node, terminalId } = splitKey(key);
		if (viewOf(node)?.link.kind !== "ready") return undefined;
		const nodeWs = hub.get(node);
		const owner = nodeWs.projectOf(terminalId);
		const tab = owner ? tabOfTerminal(nodeWs.layout(owner), terminalId) : undefined;
		return owner && tab ? { node, project: owner, tabId: tab.id, terminalId } : undefined;
	};

	// --- Drawing ---------------------------------------------------------------------------------------------

	if (snapshot.status === "insecure") {
		return (
			<div className="p-8">
				<Callout tone="red" title="Nodes need a secure context">
					This page reached pika over plain http, where browsers offer no WebCrypto. Open pika over https (or on localhost) to
					use nodes.
				</Callout>
			</div>
		);
	}
	if (snapshot.status === "failed") {
		return (
			<div className="p-8">
				<Callout tone="red" title="This browser's node key could not be loaded">
					{snapshot.failure}
				</Callout>
			</div>
		);
	}

	const filesShown = Boolean(ready && layout.filesOpen);

	return (
		// Narrow windows shrink the sidebars to their least widths first, then scroll.
		<div className="flex h-full min-h-0 overflow-x-auto" data-nodes-page="" {...WORKBENCH_ROOT}>
			{layout.railOpen && (
				<>
					<aside className="flex min-w-[220px] flex-col bg-sidebar" style={{ flex: `0 1 ${layout.rail}px` }} aria-label="Agents" data-agent-list="">
						<AgentRail
							nodes={snapshot.nodes}
							agents={agentMap}
							inbox={inbox}
							{...(selectedKey ? { selected: selectedKey } : {})}
							{...(nodeId ? { currentNode: nodeId } : {})}
							{...(project ? { currentProject: project } : {})}
							projectsOf={(node) => projects.get(node)}
							homeOf={(node) => {
								const link = viewOf(node)?.link;
								return link?.kind === "ready" ? link.welcome.home : "/";
							}}
							onHover={setHovering}
							onAgent={(key) => {
								const { node, terminalId } = splitKey(key);
								showPane(node, terminalId, agentMap.get(key)?.project);
							}}
							onNode={(node) => navigate(`/nodes/${encodeURIComponent(node)}`)}
							onProject={(node, next) => {
								hub.get(node).setActive(next);
								revealed.current = undefined;
								navigate(`/nodes/${encodeURIComponent(node)}`);
							}}
							canClosePane={(key) => paneTabOf(key) !== undefined}
							onClosePane={(key) => {
								const found = paneTabOf(key);
								if (found) closePaneOf(found.node, found.project, found.tabId, found.terminalId);
							}}
							onKill={(key) => {
								const agent = agentMap.get(key);
								if (agent) setKilling({ node: agent.node.info.id, terminal: agent.terminal });
							}}
							header={<RailHeader status={snapshot.status} onHelp={() => setHelp(true)} />}
						/>
						{permission === "default" && snapshot.nodes.length > 0 && (
							<div className="shrink-0 border-t border-line px-4 py-2">
								<button type="button" className={cx(BUTTON.quiet, "-mx-2 h-7 px-2")} onClick={requestPermission} data-notify-enable="">
									Notify me when a pane waits or finishes
								</button>
							</div>
						)}
					</aside>
					<Splitter
						name="rail"
						label="Resize the agent list"
						side="left"
						value={layout.rail}
						min={LAYOUT_BOUNDS.rail[0]}
						max={LAYOUT_BOUNDS.rail[1]}
						onChange={(rail) => setLayout({ rail }, false)}
						onCommit={(rail) => setLayout({ rail })}
					/>
				</>
			)}
			<section className="flex min-w-[360px] flex-1 flex-col" aria-label="Workspace">
				{ready && project && (
					<WorkspaceHeader
						view={ready}
						home={home}
						project={project}
						projects={nodeProjects ?? []}
						terminal={onScreenInfo}
						session={headerInfo}
						busy={busy}
						railOpen={layout.railOpen}
						filesOpen={layout.filesOpen}
						onNew={() => newTerminal(ready.info.id, project)}
						onRail={() => setLayout({ railOpen: !layout.railOpen })}
						onFiles={() => setLayout({ filesOpen: !layout.filesOpen })}
						badge={badge}
					/>
				)}
				{(actionError || ready?.error) && (
					<div className="shrink-0 px-3 pt-2">
						<Callout tone="red">
							{actionError ?? ready?.error}
							{actionError && (
								<button type="button" className={cx(BUTTON.quiet, "ml-2 h-6 px-1.5")} onClick={() => setActionError(null)}>
									Dismiss
								</button>
							)}
						</Callout>
					</div>
				)}
				{/* The terminal layer lives here whatever shows, so no terminal is built again for a node or project switch. */}
				<div className="relative flex min-h-0 flex-1">
					{ready && workspace && editors && slots && actions ? (
						<WorkspaceView
							node={ready.info.id}
							nodeName={ready.info.name}
							home={home}
							ws={workspace}
							terminals={new Map(ready.terminals.map((item) => [item.terminalId, item]))}
							editors={editors}
							editorSnapshot={editorSnapshot}
							editorKeys={editorSnapshot.tabs.map((tab) => tab.key)}
							slots={slots}
							theme={theme}
							diffInline={layout.diffInline}
							onDiffInline={(diffInline) => setLayout({ diffInline })}
							actions={actions}
							onLayout={onLayout}
						/>
					) : client && selected ? (
						<NodeGate client={client} view={selected} fingerprint={snapshot.fingerprint} />
					) : (
						<div className="flex flex-1">
							<EmptyState title={snapshot.nodes.length ? "Pick a node" : snapshot.status === "open" ? "No nodes yet" : "Connecting…"}>
								{snapshot.nodes.length === 0 && snapshot.status === "open" && (
									<>
										Create a node credential with <code className="code-chip">pika node create &lt;name&gt;</code> and start pika-node with it.
									</>
								)}
							</EmptyState>
						</div>
					)}
					<TerminalLayer registry={registry} terminals={layerTerminals} theme={theme} onFocus={onLayerFocus} onKill={onLayerKill} onOpenFile={onLayerOpen} onSeen={onSeen} />
				</div>
			</section>
			{filesShown && ready && editors && (
				<>
					<Splitter
						name="files"
						label="Resize the explorer"
						side="right"
						value={layout.files}
						min={LAYOUT_BOUNDS.files[0]}
						max={LAYOUT_BOUNDS.files[1]}
						onChange={(files) => setLayout({ files }, false)}
						onCommit={(files) => setLayout({ files: clampWidth("files", files) })}
					/>
					<aside className="flex min-h-0 min-w-[200px] flex-col bg-sidebar" style={{ flex: `0 1 ${layout.files}px` }} aria-label="Files" data-file-panel="">
						<div className="flex h-9 shrink-0 items-stretch border-b border-line" role="toolbar" aria-label="Sidebar">
							<ActivityButton active={layout.sidebar === "files"} onClick={() => setLayout({ sidebar: "files" })} id="files">
								<Icon name="file" size={13} />
								Explorer
							</ActivityButton>
							<ActivityButton active={layout.sidebar === "changes"} onClick={() => setLayout({ sidebar: "changes" })} id="changes">
								<Icon name="branch" size={13} />
								{changesView.status === "ready" && changesView.count > 0 ? `Changes ${changesView.count.toLocaleString("en")}` : "Changes"}
							</ActivityButton>
							<button
								type="button"
								className="ml-auto flex w-8 items-center justify-center text-muted hover:text-ink"
								title={withShortcut("Hide the sidebar", "files.toggle")}
								onClick={() => setLayout({ filesOpen: false })}
								data-collapse-files=""
							>
								<Icon name="sidebar" size={14} />
								<span className="sr-only">Hide the sidebar</span>
							</button>
						</div>
						{layout.sidebar === "changes" ? (
							<ChangesPanel
								connected={Boolean(readyFiles)}
								root={root}
								view={changesView}
								home={home}
								{...(activeId ? { activeKey: activeId } : {})}
								onOpen={(change) => openChange(ready.info.id, change)}
								onRefresh={() => void changes?.refresh()}
							/>
						) : (
							<Explorer
								files={readyFiles || undefined}
								home={home}
								root={root}
								projects={nodeProjects ?? []}
								onRoot={(next) => setPicked({ key: rootKey, root: next })}
								hidden={layout.hidden}
								onHidden={(hidden) => setLayout({ hidden })}
								{...(workspace && activeTab(workspace)?.kind === "file" ? { activePath: (activeTab(workspace) as FileTabSpec).path } : {})}
								onOpenFile={(path, how) => openEditor(ready.info.id, fileTab(path, how === "preview"), { focus: true })}
							/>
						)}
					</aside>
				</>
			)}
			{help && <KeysHelp onClose={() => setHelp(false)} />}
			{quickOpen && ready && readyFiles && (
				<QuickOpen
					key={ready.info.id}
					files={readyFiles}
					{...(onScreenInfo ? { terminal: onScreenInfo } : {})}
					{...(project && project !== OTHER ? { root: project } : {})}
					home={home}
					onClose={() => setQuickOpen(false)}
					onPick={(path) => {
						setQuickOpen(false);
						openEditor(ready.info.id, fileTab(path), { focus: true });
					}}
				/>
			)}
			{killing && (
				<ConfirmDialog
					title={killing.terminal.exited ? "Remove this terminal?" : "Kill this terminal?"}
					confirmLabel={killing.terminal.exited ? "Remove" : "Kill"}
					busy={busy}
					onCancel={() => setKilling(null)}
					onConfirm={() =>
						void run(async () => {
							await client?.killTerminal(killing.node, killing.terminal.terminalId);
							setKilling(null);
						})
					}
				>
					{killing.terminal.exited
						? "Its last screen goes away."
						: `Sends SIGTERM to ${paneLabel(killing.terminal)} (pid ${killing.terminal.pid}) on ${viewOf(killing.node)?.info.name ?? "the node"}. Anything running in it stops.`}
				</ConfirmDialog>
			)}
			{closing && (
				<ConfirmDialog
					title={`Close ${closing.name}?`}
					confirmLabel="Close without saving"
					onCancel={() => setClosing(null)}
					onConfirm={() => {
						hub.get(closing.node).update(closing.project, (current) => closeTab(current, closing.tabId));
						setClosing(null);
					}}
				>
					Its edits are not saved on {viewOf(closing.node)?.info.name ?? "the node"}.
				</ConfirmDialog>
			)}
		</div>
	);
}

function ActivityButton({ active, onClick, id, children }: { active: boolean; onClick: () => void; id: string; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			className={cx("flex items-center gap-1.5 px-3 text-[12.5px]", active ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--wb-accent)]" : "text-muted hover:text-ink")}
			onClick={onClick}
			data-activity={id}
		>
			{children}
		</button>
	);
}

function RailHeader({ status, onHelp }: { status: NodesSnapshot["status"]; onHelp: () => void }) {
	return (
		<>
			<h1 className="text-[13px] font-semibold">Nodes</h1>
			{status !== "open" && (
				<span className="truncate text-[12px] text-wb-ink-3" role="status" data-socket-status={status}>
					{status === "closed" ? "Reconnecting…" : "Connecting…"}
				</span>
			)}
			<button type="button" className={cx(BUTTON.quiet, "h-6 shrink-0 px-1.5 text-[12px]")} title={withShortcut("Keyboard shortcuts", "help")} onClick={onHelp} data-keys-open="">
				?<span className="sr-only">Keyboard shortcuts</span>
			</button>
		</>
	);
}

/** Above the workspace: the project, the focused pane's session and status, and New terminal. */
function WorkspaceHeader({
	view,
	home,
	project,
	projects,
	terminal,
	session,
	busy,
	railOpen,
	filesOpen,
	onNew,
	onRail,
	onFiles,
	badge,
}: {
	view: NodeView;
	home: string;
	project: string;
	projects: readonly Project[];
	/** The pane on screen, for its status. */
	terminal?: TerminalInfo;
	/** The pane whose session the heading shows (`RecentTerminals`). */
	session?: TerminalInfo;
	busy: boolean;
	railOpen: boolean;
	filesOpen: boolean;
	onNew: () => void;
	onRail: () => void;
	onFiles: () => void;
	/** The rail's badge, shown on its button while it is hidden. */
	badge: ReturnType<typeof inboxBadge>;
}) {
	return (
		<header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3" data-workspace-header={project}>
			{!railOpen && (
				<button type="button" className={cx(BUTTON.quiet, "h-7 shrink-0 px-1.5")} onClick={onRail} title={withShortcut("Show the agent list", "sidebar.left")} data-show-rail="">
					<Icon name="sidebar" size={14} />
					<InboxBadge badge={badge} />
					<span className="sr-only">Show the agent list</span>
				</button>
			)}
			<span className="shrink-0 text-[13.5px] font-medium" title={project === OTHER ? undefined : project} data-workspace-project={project}>
				{projectName([...projects], project)}
			</span>
			<span className="shrink-0 text-muted" aria-hidden="true">
				·
			</span>
			<PaneHeading node={view.info.name} terminal={session} home={home} />
			{terminal && <PaneDetail terminal={terminal} />}
			<button type="button" className={cx(BUTTON.quiet, "ml-auto h-7 shrink-0 border border-wb-line-strong text-wb-ink")} disabled={busy} onClick={onNew} title={withShortcut("New terminal", "terminal.new")} data-new-terminal="">
				<Icon name="plus" size={13} />
				New terminal
			</button>
			{!filesOpen && (
				<button type="button" className={cx(BUTTON.quiet, "h-7 shrink-0 px-2")} onClick={onFiles} title={withShortcut("Show the explorer", "files.toggle")} data-show-files="">
					<Icon name="folder" size={13} />
					Files
				</button>
			)}
		</header>
	);
}

/** The focused pane's state in the header: its glyph and what it means, in the state's own ink. */
function PaneBadge({ terminal }: { terminal: TerminalInfo }) {
	const mark = paneMark(terminal);
	if (mark === "idle") return null;
	const kind = terminal.status?.program?.kind;
	const label = mark === "waiting" ? (kind === "permission" ? "Needs permission" : kind === "auth" ? "Needs login" : "Waiting") : markLabel(mark);
	const ink: Partial<Record<PaneMark, string>> = { waiting: "text-wb-needs-ink", error: "text-wb-failed-ink", done: "text-wb-done-ink", working: "text-wb-working-ink" };
	return (
		<span className={cx("inline-flex items-center gap-1 text-[12px] font-medium", ink[mark] ?? "text-wb-ink-2")} title={terminal.status?.program?.message} data-pane-badge={mark}>
			<StatusGlyph mark={mark} size={11} />
			{label}
		</span>
	);
}

function Fingerprint({ label, value, attr }: { label: string; value: string; attr: string }) {
	return (
		<div className="mt-2" {...{ [`data-${attr}`]: value }}>
			<div className="text-[12px] text-muted">{label}</div>
			<div className="font-mono text-[14px] tracking-[0.02em] select-all">{displayFingerprint(value)}</div>
		</div>
	);
}

function CommandLine({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="mt-2 flex items-stretch rounded-sm border border-line bg-code" data-enrol-command={command}>
			<code className="min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-[13px] whitespace-nowrap select-all">{command}</code>
			<button type="button" className="shrink-0 border-l border-line px-3 text-[12.5px] text-muted hover:text-ink" onClick={() => void copyText(command).then(setCopied)}>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

function Panel({ children }: { children: ReactNode }) {
	return <div className="w-full max-w-[640px] overflow-y-auto px-8 pt-8 pb-10 text-[14px] max-sm:px-4">{children}</div>;
}

/** A node that is not ready: pairing, confirming its key, a changed key, or why its channel is closed. */
function NodeGate({ client, view, fingerprint }: { client: NodesClient; view: NodeView; fingerprint?: string }) {
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const name = view.info.name;
	const link = view.link;

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setActionError(null);
		try {
			await action();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	if (link.kind === "closed" && link.code === "node_key_changed") {
		return (
			<Panel>
				<Callout tone="red" title={`${name}'s key changed`}>
					<p>
						The node answered with a different key than the one this browser pinned, so the channel was closed before anything was
						sent. If you reinstalled pika-node or reset its identity on {name}, forget the pin and pair again. Otherwise, something
						between you and the node may be impersonating it.
					</p>
					{link.pinnedFingerprint && <Fingerprint label="Pinned key" value={link.pinnedFingerprint} attr="pinned-fingerprint" />}
					{link.nodeFingerprint && <Fingerprint label="Key it presented" value={link.nodeFingerprint} attr="presented-fingerprint" />}
					<button type="button" className={cx(BUTTON.secondary, "mt-4")} disabled={busy} onClick={() => void run(() => client.forgetPin(view.info.id))}>
						Forget the pin
					</button>
				</Callout>
			</Panel>
		);
	}

	if (link.kind === "enrol" && fingerprint) {
		return (
			<Panel>
				<h2 className="text-[18px] font-semibold">Allow this browser on {name}</h2>
				<p className="mt-2 text-muted">{name} does not know this browser's key yet. On {name}, run:</p>
				<CommandLine command={enrolCommand(link.clientFingerprint)} />
				<p className="mt-4 text-muted">It prints this browser's fingerprint and the node's. Check both against these:</p>
				<Fingerprint label="This browser" value={link.clientFingerprint} attr="enrol-client" />
				<Fingerprint label={name} value={link.nodeFingerprint} attr="enrol-node" />
				<p className="mt-4 text-muted">The request expires 10 minutes after this attempt.</p>
				<button type="button" className={cx(BUTTON.primary, "mt-4")} onClick={() => client.pair(view.info.id)} data-enrol-done="">
					I ran it
				</button>
			</Panel>
		);
	}

	if (link.kind === "confirm") {
		return (
			<Panel>
				<h2 className="text-[18px] font-semibold">Confirm {name}'s key</h2>
				<p className="mt-2 text-muted">
					{name} allows this browser. Before anything is sent to it, confirm that this is the node fingerprint{" "}
					<code className="code-chip">pika-node clients add</code> printed (or <code className="code-chip">pika-node fingerprint</code>{" "}
					prints on {name}):
				</p>
				<Fingerprint label={name} value={link.nodeFingerprint} attr="confirm-node" />
				<div className="mt-5 flex gap-2">
					<button type="button" className={BUTTON.primary} disabled={busy} onClick={() => void run(() => client.confirmPin(view.info.id))} data-confirm-pin="">
						It matches, pin it
					</button>
					<button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => client.rejectPin(view.info.id)}>
						It doesn't match
					</button>
				</div>
				{actionError && <p className="mt-3 text-red">{actionError}</p>}
			</Panel>
		);
	}

	return (
		<Panel>
			<h2 className="text-[18px] font-semibold">{name}</h2>
			<NodeLinkState view={view} client={client} />
		</Panel>
	);
}

const Dot = () => (
	<span className="shrink-0 text-muted" aria-hidden="true">
		·
	</span>
);

/** The node, then the pane's pi session as its bridge reported it: name, cwd under the node's home, and model. */
export function PaneHeading({ node, terminal, home }: { node: string; terminal?: TerminalInfo; home?: string }) {
	const session = terminal && paneSession(terminal);
	const model = bareModelOf(session?.model);
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
			<span className="shrink-0 font-medium">{node}</span>
			{session?.name && (
				<>
					<Dot />
					<span className="min-w-0 truncate font-medium" data-session-name="">
						{session.name}
					</span>
				</>
			)}
			{session && (
				<>
					<Dot />
					<span className="min-w-0 truncate text-muted" title={session.cwd} data-pane-cwd="">
						{homePath(session.cwd, home)}
					</span>
				</>
			)}
			{model && (
				<span className="inline-flex min-w-0 shrink items-center gap-1 text-muted" title={session?.model} data-pane-model="">
					<span className="mono truncate text-[11.5px]">{model}</span>
					<ModelMark model={model} size={12} className="shrink-0" />
				</span>
			)}
			{session?.disconnected && (
				<span className="shrink-0 text-[11.5px] text-muted" title="pi's bridge to pika-node closed; this is the last session it reported" data-bridge-disconnected="">
					Bridge disconnected
				</span>
			)}
		</span>
	);
}

/** The pane status's detail: the dialog's message, and background activities. */
function PaneDetail({ terminal }: { terminal: TerminalInfo }) {
	const status = terminal.status;
	if (!status) return null;
	const message = status.state === "waiting" ? status.program?.message : undefined;
	const activities = liveBridge(status)?.activityCount ?? 0;
	return (
		<span className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
			<span className="shrink-0">
				<PaneBadge terminal={terminal} />
			</span>
			{message && <span className="truncate">{message}</span>}
			{activities > 0 && <span className="shrink-0">{activities === 1 ? "1 background activity" : `${activities} background activities`}</span>}
		</span>
	);
}

function NodeLinkState({ view, client }: { view: NodeView; client: NodesClient }) {
	const link = view.link;
	const id = view.info.id;
	if (!view.info.online) return <p className="mt-2 text-muted">This node is offline. It connects again when pika-node reaches the server.</p>;
	if (link.kind === "opening" || link.kind === "handshaking") return <p className="mt-2 text-muted" role="status">Connecting…</p>;
	if (!view.pin && (link.kind === "idle" || link.kind === "closed")) {
		return (
			<>
				{link.kind === "closed" && link.code === "fingerprint_mismatch" && (
					<div className="mt-3">
						<Callout tone="red" title="Not pinned">
							The fingerprints did not match, so this browser pinned nothing and sent nothing. Check that you ran the command on the
							right machine.
						</Callout>
					</div>
				)}
				<p className="mt-2 text-muted">
					This browser has not been paired with {view.info.name}. Pairing shows a command to run there, then asks you to confirm the
					node's fingerprint.
				</p>
				<button type="button" className={cx(BUTTON.primary, "mt-4")} onClick={() => client.pair(id)} data-pair-node="">
					Pair this browser
				</button>
			</>
		);
	}
	const code = link.kind === "closed" || link.kind === "refused" ? link.code : undefined;
	const reason: Record<string, string> = {
		client_removed: "This browser's key was removed from the node's allowlist.",
		client_not_allowed: "The node does not allow this browser's key.",
		handshake_failed: "The handshake failed.",
		handshake_timeout: "The node did not finish the handshake in time.",
		unsupported_version: "The node speaks another protocol version; update pika-node.",
		too_many_channels: "Too many channels are open to this node or from this browser.",
	};
	return (
		<>
			{code && (
				<div className="mt-3">
					<Callout tone="red" title="The channel closed">
						{reason[code] ?? `Closed with ${code}.`}
						{view.error && <div className="mt-1">{view.error}</div>}
					</Callout>
				</div>
			)}
			<button type="button" className={cx(BUTTON.secondary, "mt-4")} onClick={() => client.retry(id)}>
				Try again
			</button>
		</>
	);
}
