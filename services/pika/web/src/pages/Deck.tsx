import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Icon } from "../components/icons";
import { ModelMark } from "../components/ModelName";
import { BUTTON, Callout, cx } from "../components/ui";
import { PortalContainer } from "../components/ui-shadcn/portal";
import { useApi, type PikaApi } from "../lib/api";
import { withBase } from "../lib/base";
import { copyText } from "../lib/clipboard";
import { shortUserAgent } from "../lib/devices";
import { bareModelOf } from "../lib/model";
import { useHealth } from "../lib/relay";
import { useAppliedTheme, useTheme } from "../lib/theme";
import { countedTitle, paneCounts, PaneAlerts } from "../nodes/alerts";
import { changeMode, ChangesStore, type Change } from "../nodes/changes";
import { homePath, liveBridge, NodesClient, paneLabel, paneSession, type NodesClientOptions, type NodesSnapshot, type NodeView } from "../nodes/client";
import { displayFingerprint, sanitize, type Checkout, type NodeEvent, type TerminalInfo } from "../nodes/contract";
import { DeckProjects, keyItemOf, ProjectKeys, type DeckProjectsSnapshot } from "../nodes/deck-projects";
import { EditorStore, isDirty, type EditorSnapshot } from "../nodes/editor";
import { ChangesPanel, diffControlAt, Explorer, useChanges, usePageVisible } from "../nodes/FilePanel";
import { IndexedDbKeyStore } from "../nodes/identity";
import { currentKeymap, focusOf, resolveKey, type PageCommands } from "../nodes/keys";
import { KeysHelp } from "../nodes/KeysHelp";
import { clampWidth, LAYOUT_BOUNDS, loadLayout, saveLayout, type NodesLayout } from "../nodes/layout";
import { ClosedPanes, closePane, paneEvent, splitPane, type PaneHost } from "../nodes/panes/actions";
import { focusNext, focusPrevious, replaceLeaf } from "../nodes/panes/pane-tree";
import { QuickOpen } from "../nodes/QuickOpen";
import { nodeSocketUrl } from "../nodes/socket";
import { Splitter } from "../nodes/Splitter";
import { BAR_BUTTON, DeckAppBar, DeckStatusBar } from "../nodes/deck/Chrome";
import { menuBelow, useMenu, type MenuEntry } from "../nodes/deck/Menu";
import { DECK_ROOT } from "../nodes/deck/tokens";
import { AddCheckoutDialog, CheckoutSettingsDialog, ConfirmDialog, NewWorktreeDialog, RemoveWorktreeDialog, UndoToast, type UndoNotice } from "../nodes/deck/RailDialogs";
import { DeckTooltips, tip } from "../nodes/deck/Tooltips";
import { AgentRail, InboxBadge, railAgents, useInbox, type RailOps } from "../nodes/workspace/AgentRail";
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
import { placeKey, placeOfTerminal, placePath, placeWords, railNode, splitPlace, worktreeCards, type RailNode, type RailProject, type RailWorktree } from "../nodes/workspace/places";
import { RecentTerminals } from "../nodes/workspace/recent";
import { SlotRegistry } from "../nodes/workspace/slots";
import { OTHER, WorkspaceHub, type NodeWorkspaces } from "../nodes/workspace/store";
import { layerKey, TerminalLayer, type LayerTerminal } from "../nodes/workspace/TerminalLayer";
import { WorkspaceView, type WorkspaceActions } from "../nodes/workspace/WorkspaceView";

/** The command that moves this browser's pending entry into the node's allowlist (NODE.md, "Enrolment"). */
export const enrolCommand = (clientFingerprint: string): string => `pika-node clients add ${clientFingerprint.slice(0, 32)}`;

const EMPTY: NodesSnapshot = { status: "loading", nodes: [] };

/** Makes Deck's client; tests give one with an in-memory socket and key store. */
export const NodesClientFactory = createContext<((options: NodesClientOptions) => NodesClient) | null>(null);

function useNodesClient(): NodesClient | null {
	const api = useApi();
	const factory = useContext(NodesClientFactory);
	const [client, setClient] = useState<NodesClient | null>(null);
	useEffect(() => {
		const options: NodesClientOptions = {
			socketUrl: nodeSocketUrl(withBase(api.base, "api/v1/node/connect")),
			store: new IndexedDbKeyStore(),
			label: shortUserAgent(navigator.userAgent).slice(0, 64),
		};
		const next = factory ? factory(options) : new NodesClient(options);
		setClient(next);
		void next.start();
		return () => {
			next.dispose();
			setClient(null);
		};
	}, [api.base, factory]);
	return client;
}

const noop = () => () => {};

function useSnapshot(client: NodesClient | null): NodesSnapshot {
	return useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? (() => EMPTY));
}

export function DeckPage() {
	const health = useHealth();
	const { theme, toggle } = useTheme();
	const [help, setHelp] = useState(false);
	if (health.isPending || !health.data?.features?.includes("nodes")) {
		return (
			<DeckFrame bar={<DeckAppBar theme={theme} onTheme={toggle} onHelp={() => setHelp(true)} />}>
				{health.isPending ? (
					<div className="p-8 text-dk-ink-2" role="status">
						Loading…
					</div>
				) : (
					<DeckEmpty title="Nodes are off on this server">
						Start pika with <code className="code-chip">PIKA_NODES=on</code> to reach terminals on your machines.
					</DeckEmpty>
				)}
				{help && <KeysHelp onClose={() => setHelp(false)} />}
			</DeckFrame>
		);
	}
	return <NodesWorkspace onTheme={toggle} />;
}

/** An empty workspace: what is missing and what to do, centred in the space it leaves. */
function DeckEmpty({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-8" data-empty-state="">
			<div className="max-w-[420px] text-center">
				<h2 className="text-[14px] font-semibold text-dk-ink">{title}</h2>
				{children && <p className="mt-1.5 text-[13px] leading-[1.5] text-dk-ink-2">{children}</p>}
			</div>
		</div>
	);
}

/**
 * Deck's window: the app bar, the body, and the status bar, filling the viewport without a page scroll. The root
 * carries the Deck tokens, its tooltips listen on it, and the primitives' popups (menus, dialogs, toasts) portal into
 * it so they take the tokens too.
 */
function DeckFrame({ bar, status, children }: { bar: ReactNode; status?: ReactNode; children: ReactNode }) {
	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	return (
		<div ref={setRoot} className="flex h-full min-h-0 flex-col overflow-hidden" data-nodes-page="" {...DECK_ROOT}>
			<PortalContainer.Provider value={root}>
				{bar}
				<div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
				{status}
				<DeckTooltips root={root} />
			</PortalContainer.Provider>
		</div>
	);
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

/**
 * Deck's projects on the server (SPEC.md, "Deck"): each node's checkouts' project keys, asked for in batches as
 * checkouts appear, and the owner's presentation of each project. A server without the routes (an older one) leaves
 * every checkout a project of its own, unfolded, under its own name.
 */
function useDeckProjects(api: PikaApi, snapshot: NodesSnapshot): { keys: ProjectKeys; keysVersion: number; presentation: DeckProjects; projects: DeckProjectsSnapshot } {
	const keys = useMemo(() => new ProjectKeys(async (items) => (await api.deckProjectKeys(items)).keys), [api]);
	const presentation = useMemo(
		() => new DeckProjects({ list: () => api.deckProjects(), patch: (key, body) => api.patchDeckProject(key, body), remove: (key) => api.deleteDeckProject(key) }),
		[api],
	);
	useEffect(() => () => keys.dispose(), [keys]);
	useEffect(() => void presentation.load(), [presentation]);
	const keysVersion = useSyncExternalStore(keys.subscribe, keys.getVersion);
	const projects = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot);
	useEffect(() => {
		keys.want(snapshot.nodes.flatMap((view) => (view.checkouts ?? []).map((checkout) => keyItemOf(view.info.id, checkout))));
	}, [keys, snapshot]);
	return { keys, keysVersion, presentation, projects };
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

const NO_PLACES: ReadonlyMap<string, unknown> = new Map();

/**
 * The place a node shows: the one picked last while it is still listed, else the newest terminal's, else the first
 * worktree's, else "Other".
 */
function shownPlace(ws: NodeWorkspaces, view: NodeView, rail: RailNode | undefined): string {
	if (ws.active && (ws.active === OTHER || !rail || rail.places.has(ws.active))) return ws.active;
	const first = view.terminals[0];
	if (first) return ws.placeOf(first.terminalId) ?? placeOfTerminal(rail?.places ?? NO_PLACES, first);
	return rail?.places.keys().next().value ?? OTHER;
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
	place: string;
	tabId: string;
	name: string;
}

interface RemovingWorktree {
	node: string;
	checkout: Checkout;
	worktree: RailWorktree;
}

function NodesWorkspace({ onTheme }: { onTheme: () => void }) {
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
	const api = useApi();
	const { keys, keysVersion, presentation, projects: deckProjects } = useDeckProjects(api, snapshot);
	// Each node's checkouts as projects, worktrees, and places, once it has listed them.
	const railNodes = useMemo(() => {
		const out = new Map<string, RailNode>();
		for (const view of snapshot.nodes) {
			if (view.checkouts) out.set(view.info.id, railNode(view.info.id, view.checkouts, { keyOf: (item) => keys.keyOf(item), rows: deckProjects.rows }));
		}
		return out;
		// keysVersion: a key learned regroups.
	}, [snapshot, keys, keysVersion, deckProjects]);
	const [quickOpen, setQuickOpen] = useState(false);
	const [help, setHelp] = useState(false);
	const [killing, setKilling] = useState<Killing | null>(null);
	const [closing, setClosing] = useState<Closing | null>(null);
	const [addingCheckout, setAddingCheckout] = useState<string | null>(null);
	const [creatingWorktree, setCreatingWorktree] = useState<{ node: string; checkoutId: string } | null>(null);
	const [removingWorktree, setRemovingWorktree] = useState<RemovingWorktree | null>(null);
	const [editingSettings, setEditingSettings] = useState<{ node: string; checkoutId: string } | null>(null);
	const [repairing, setRepairing] = useState<string | null>(null);
	const [notice, setNotice] = useState<UndoNotice | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [permission, requestPermission] = useNotificationPermission();
	const commands = useRef<PageCommands>({});
	useKeyDispatch(commands);
	const latest = useRef({ snapshot, railNodes, nodeId });
	latest.current = { snapshot, railNodes, nodeId };

	const viewOf = useCallback((node: string) => latest.current.snapshot.nodes.find((item) => item.info.id === node), []);
	const terminalOf = useCallback((node: string, terminalId: string) => viewOf(node)?.terminals.find((item) => item.terminalId === terminalId), [viewOf]);
	const checkoutOf = (node: string, checkoutId: string) => viewOf(node)?.checkouts?.find((item) => item.id === checkoutId);
	const homeOf = (node: string) => {
		const link = viewOf(node)?.link;
		return link?.kind === "ready" ? link.welcome.home : "/";
	};
	/**
	 * Where a terminal is: the worktree its node places it in (`checkoutId`, `worktreePath`, following its shell's cwd),
	 * else "Other". A hidden checkout's terminals so fall to "Other" at once, and an undo brings them back.
	 */
	const placeFor = useCallback((node: string, terminal: TerminalInfo) => placeOfTerminal(latest.current.railNodes.get(node)?.places ?? NO_PLACES, terminal), []);
	const placeShown = useCallback(
		(node: string) => {
			const view = viewOf(node);
			return view ? shownPlace(hub.get(node), view, latest.current.railNodes.get(node)) : (hub.get(node).active ?? OTHER);
		},
		[hub, viewOf],
	);
	/** A place in words, for a row's second line: `branch · project`. */
	const whereOf = useCallback((node: string, place: string) => placeWords(latest.current.railNodes.get(node)?.places.get(place)), []);

	// --- Placing terminals and opening files ------------------------------------------------------------------

	const revealed = useRef<string | undefined>(undefined);
	/** Shows a pane: its place, its tab, and focus in it; the address follows. */
	const showPane = useCallback(
		(node: string, terminalId: string, place?: string) => {
			const terminal = terminalOf(node, terminalId);
			if (!terminal) return;
			hub.get(node).reveal(place ?? hub.get(node).placeOf(terminalId) ?? placeFor(node, terminal), terminalId);
			revealed.current = `${node}\n${terminalId}`;
			navigate(`/deck/${encodeURIComponent(node)}/${encodeURIComponent(terminalId)}`);
		},
		[hub, navigate, placeFor, terminalOf],
	);

	// A pane named in the address (a link, a notification, a reload) shows once the node lists it.
	useEffect(() => {
		if (!nodeId || !routeTerminal || !selected?.listed || !railNodes.has(nodeId)) return;
		const key = `${nodeId}\n${routeTerminal}`;
		if (revealed.current === key) return;
		const terminal = selected.terminals.find((item) => item.terminalId === routeTerminal);
		if (!terminal) return;
		revealed.current = key;
		const ws = hub.get(nodeId);
		ws.reveal(ws.placeOf(routeTerminal) ?? placeFor(nodeId, terminal), routeTerminal);
	}, [nodeId, routeTerminal, selected, railNodes, hub, placeFor]);

	// Each listed node's terminals in its workspaces: gone ones leave, new ones get a tab in their place.
	useEffect(() => {
		for (const view of snapshot.nodes) {
			const rail = railNodes.get(view.info.id);
			if (view.link.kind !== "ready" || !rail) continue;
			const ws = hub.get(view.info.id);
			ws.reconcile(
				view.terminals.map((terminal) => ({ terminalId: terminal.terminalId, place: ws.placeOf(terminal.terminalId) ?? placeOfTerminal(rail.places, terminal), exited: Boolean(terminal.exited) })),
				view.listed,
			);
		}
	}, [snapshot, railNodes, hub]);

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
			const place = (options.source && ws.placeOf(options.source)) || placeShown(node);
			const layoutOf = ws.layout(place);
			const sourceTab = options.source ? tabOfTerminal(layoutOf, options.source) : undefined;
			const sourceGroupId = sourceTab ? groupOf(layoutOf, sourceTab.id)?.id : undefined;
			ws.openEditor(place, tab, { ...(sourceGroupId ? { sourceGroupId } : {}), ...(options.focus ? { focus: true } : {}) });
			const store = editorFor(node);
			store.setFiles(client?.files(node));
			if (tab.kind === "file") void store.open(tab.path, options.at);
			else void store.openDiff(tab.path, tab.mode, tab.from);
			return place;
		},
		[client, editorFor, hub, placeShown],
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
		(node: string, place: string, tabId: string, focus = true): PaneHost | undefined => {
			if (!client || !closedPanes) return undefined;
			const ws = hub.get(node);
			return {
				client,
				node,
				closed: closedPanes,
				read: () => {
					const tab = ws.layout(place).tabs[tabId];
					return tab?.kind === "terminal" ? { tree: tab.panes, focused: tab.focused } : undefined;
				},
				write: (tab) => {
					for (const id of paneLeaves(tab.tree)) ws.know(id);
					ws.update(place, (current) => setPanes(current, tabId, tab.tree, tab.focused), focus ? { tabId, terminalId: tab.focused } : undefined);
				},
				closeTab: () => ws.update(place, (current) => closeTab(current, tabId, { forget: true })),
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
			const place = ws.placeOf(event.terminalId);
			const tab = place ? tabOfTerminal(ws.layout(place), event.terminalId) : undefined;
			const host = place && tab ? paneHost(node, place, tab.id, false) : undefined;
			if (host) paneEvent(host, event);
			return;
		}
		if (event.type !== "pane.open" && event.type !== "pane.diff") return;
		if (document.visibilityState !== "visible") return;
		const tab = event.type === "pane.open" ? fileTab(event.path) : diffTab(event.path, event.staged ? "staged" : "worktree");
		const at = event.type === "pane.open" && event.line ? { line: event.line, ...(event.column ? { column: event.column } : {}) } : undefined;
		const place = openEditor(node, tab, { source: event.terminalId, ...(at ? { at } : {}) });
		const ws = hub.get(node);
		if (ws.active !== place) ws.setActive(place);
		if (latest.current.nodeId !== node) navigate(`/deck/${encodeURIComponent(node)}/${encodeURIComponent(event.terminalId)}`);
	};

	/**
	 * A new terminal in `place`'s worktree (the node's home for "Other"), in `groupId` (the focused group by default),
	 * with focus; `argv` runs in it.
	 */
	const newTerminal = useCallback(
		(node: string, place: string, groupId?: string, argv?: string[]) =>
			void run(async () => {
				if (!client) return;
				const ws = hub.get(node);
				const release = ws.holdNewTerminals();
				try {
					const created = await client.createTerminal(node, { cols: 80, rows: 24 }, placePath(place), argv);
					ws.know(created.terminalId);
					const tab = terminalTab(created.terminalId);
					ws.update(place, (current) => addTab(current, tab, groupId ? { groupId } : {}), { tabId: tab.id, terminalId: created.terminalId });
					if (ws.active !== place) ws.setActive(place);
				} finally {
					release();
				}
			}),
		[client, hub, run],
	);

	const splitFocused = (node: string, place: string, tabId: string, direction: "row" | "column") =>
		void run(async () => {
			const host = paneHost(node, place, tabId);
			if (!host) return;
			const release = hub.get(node).holdNewTerminals();
			try {
				await splitPane(host, direction);
			} finally {
				release();
			}
		});

	const closePaneOf = (node: string, place: string, tabId: string, terminalId: string) =>
		void run(async () => {
			const host = paneHost(node, place, tabId);
			if (host) await closePane(host, terminalId);
		});

	/** Closes a tab, asking first when its file has unsaved edits. A terminal tab's terminals keep running. */
	const requestClose = (node: string, place: string, tabId: string) => {
		const ws = hub.get(node);
		const tab = ws.layout(place).tabs[tabId];
		if (!tab) return;
		const editor = tab.kind === "file" ? editorFor(node).tab(tabId) : undefined;
		if (editor && isDirty(editor)) {
			setClosing({ node, place, tabId, name: editor.name });
			return;
		}
		ws.update(place, (current) => closeTab(current, tabId));
	};

	// --- What is on screen -----------------------------------------------------------------------------------

	const ready = client && selected && selected.link.kind === "ready" ? selected : undefined;
	const home = ready?.link.kind === "ready" ? ready.link.welcome.home : "/";
	const ws = ready ? hub.get(ready.info.id) : undefined;
	const rail = ready ? railNodes.get(ready.info.id) : undefined;
	const place = ready && ws ? shownPlace(ws, ready, rail) : undefined;
	const workspace = ws && place ? ws.layout(place) : undefined;
	const onScreen = focusedTerminal(workspace);
	const onScreenInfo = ready && onScreen ? ready.terminals.find((item) => item.terminalId === onScreen) : undefined;
	// The header's session: the pane on screen, else (an editor or diff in focus) the place's last focused pane.
	const headerInfo = ready && place ? recentTerminals.shown(ready.info.id, place, onScreen, ready.terminals) : undefined;
	const editors = ready ? editorFor(ready.info.id) : undefined;
	const editorSnapshot = useSyncExternalStore(editors?.subscribe ?? noop, editors?.getSnapshot ?? (() => EMPTY_EDITORS));
	const readyFiles = ready && client?.files(ready.info.id);
	// The rail's inbox: every agent on every node, by what the user has to do; held still while the pointer is on it.
	const [hovering, setHovering] = useState(false);
	const agents = useMemo(() => railAgents(snapshot.nodes, placeFor, whereOf), [snapshot, railNodes, placeFor, whereOf]);
	const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
	const selectedKey = ready && onScreen ? inboxKey(ready.info.id, onScreen) : undefined;
	const inbox = useInbox(agents, selectedKey, hovering);
	const badge = inboxBadge(inbox.layout);
	usePaneAlerts(snapshot, ready?.info.id, onScreen, showPane, inbox.layout.working.length);

	// The explorer's folder: the worktree on screen ("Other": the focused or last focused pane's), or one picked by hand
	// until the place changes.
	const [picked, setPicked] = useState<{ key: string; root: string }>();
	const rootKey = `${ready?.info.id}\n${place}`;
	// With an editor in focus, the place's last focused pane: opening a file must not move the tree under it.
	const rootPane = onScreenInfo ?? headerInfo;
	const placeRoot = (place && placePath(place)) ?? (rootPane ? paneSession(rootPane).cwd : home);
	const root = picked?.key === rootKey ? picked.root : placeRoot;
	// The node's worktrees, for the explorer's folder menu and quick open.
	const roots = useMemo(() => [...(rail?.places.values() ?? [])].map((info) => ({ path: info.worktree.path, label: placeWords(info) ?? info.worktree.title })), [rail]);

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
		if (!focus || !ready || focus.place !== place) return;
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
			const owner = nodeWs.placeOf(terminalId);
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
		ready && ws && place && slots
			? {
					activate: (tabId) => ws.update(place, (current) => activate(current, tabId)),
					focusGroup: (groupId) => ws.update(place, (current) => focusGroup(current, groupId)),
					close: (tabId) => requestClose(ready.info.id, place, tabId),
					closeOthers: (tabId) => {
						const current = ws.layout(place);
						const group = groupOf(current, tabId);
						const dirtyOther = group?.tabOrder.find((id) => id !== tabId && !current.tabs[id]?.pinned && editors?.tab(id) && isDirty(editors.tab(id)!));
						if (dirtyOther) return requestClose(ready.info.id, place, dirtyOther);
						ws.update(place, (next) => closeOthers(next, tabId));
					},
					setPinned: (tabId, pinned) => ws.update(place, (current) => setPinned(current, tabId, pinned)),
					move: (tabId, groupId, index) => ws.update(place, (current) => moveTab(current, tabId, groupId, index)),
					split: (tabId, groupId, side) => ws.update(place, (current) => splitTab(current, tabId, groupId, side)),
					setRatio: (path, ratio) => ws.update(place, (current) => setSplitRatio(current, path, ratio)),
					setPanes: (tabId, tree) => ws.update(place, (current) => setPanes(current, tabId, tree)),
					focusPane: (tabId, terminalId) => ws.update(place, (current) => focusPane(current, terminalId), { tabId, terminalId }),
					splitPane: (tabId, direction) => splitFocused(ready.info.id, place, tabId, direction),
					closePane: (tabId, terminalId) => closePaneOf(ready.info.id, place, tabId, terminalId),
					newTerminal: (groupId) => newTerminal(ready.info.id, place, groupId),
					promote: (tabId) => {
						const tab = ws.layout(place).tabs[tabId];
						if (tab?.kind === "file" && tab.preview) ws.update(place, (current) => promote(current, tabId));
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
		ws!.requestFocus(place!, next, ws!.layout(place!).tabs[next]?.kind === "terminal" ? (ws!.layout(place!).tabs[next] as { focused: string }).focused : undefined);
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
	page["terminal.new"] = () => (ready && place && !busy ? newTerminal(ready.info.id, place) : false);
	page["tab.next"] = () => stepTab(1);
	page["tab.previous"] = () => stepTab(-1);
	for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
		page[`tab.${n}`] = () => {
			const order = tabsOf();
			const id = n === 9 ? order.at(-1) : order[n - 1];
			if (!id || !actions) return false;
			actions.activate(id);
			const tab = workspace!.tabs[id];
			ws!.requestFocus(place!, id, tab?.kind === "terminal" ? tab.focused : undefined);
		};
	}
	page["tab.close"] = () => (actions && activeId ? actions.close(activeId) : false);
	page["tab.reopen"] = () => {
		if (!ws || !place || !ready) return false;
		const live = new Set(ready.terminals.filter((item) => !item.exited).map((item) => item.terminalId));
		const usable = (tab: WorkspaceTab) => tabTerminals(tab).every((id) => live.has(id) && !ws.placeOf(id));
		ws.update(place, (current) => reopenClosed(current, usable));
		const reopened = activeTab(ws.layout(place));
		if (reopened) ws.requestFocus(place, reopened.id, reopened.kind === "terminal" ? reopened.focused : undefined);
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

	/** The workspace tab and place an agent's pane is in, when it has one on a ready node. */
	const paneTabOf = (key: string) => {
		const { node, terminalId } = splitKey(key);
		if (viewOf(node)?.link.kind !== "ready") return undefined;
		const nodeWs = hub.get(node);
		const owner = nodeWs.placeOf(terminalId);
		const tab = owner ? tabOfTerminal(nodeWs.layout(owner), terminalId) : undefined;
		return owner && tab ? { node, place: owner, tabId: tab.id, terminalId } : undefined;
	};

	// --- The rail's operations ---------------------------------------------------------------------------------

	/** Shows a node's place in the workspace. */
	const openPlace = (node: string, next: string) => {
		hub.get(node).setActive(next);
		revealed.current = undefined;
		if (latest.current.nodeId !== node) navigate(`/deck/${encodeURIComponent(node)}`);
	};
	const nodeFiles = (node: string) => {
		const files = client?.files(node);
		if (!files) throw new Error("The node is not connected.");
		return files;
	};
	const nodeClient = () => {
		if (!client) throw new Error("Deck is not connected.");
		return client;
	};
	/** A change that needs no busy state (folding), its failure shown. */
	const report = (change: Promise<unknown>) => void change.catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
	/** "Remove from Deck": the checkout is hidden at once; Undo unhides it, for five seconds. */
	const hideCheckout = (node: string, checkout: Checkout) =>
		void run(async () => {
			await nodeClient().hideCheckout(node, checkout.id);
			const ws = hub.get(node);
			const wasActive = ws.active && splitPlace(ws.active)?.checkoutId === checkout.id ? ws.active : undefined;
			if (wasActive) ws.setActive(OTHER);
			setNotice({
				id: Date.now(),
				message: `Removed ${sanitize(checkout.name)} from Deck`,
				undo: async () => {
					await nodeClient().unhideCheckout(node, checkout.id);
					if (wasActive) hub.get(node).setActive(wasActive);
				},
			});
		});
	const ops: RailOps = {
		can: (node, capability) => client?.capabilities(node).has(capability) ?? false,
		connected: (node) => Boolean(client?.channel(node)),
		fingerprint: (node) => viewOf(node)?.pin?.fingerprint,
		newTerminal: (node, where, agent) => {
			const listed = where === OTHER || latest.current.railNodes.get(node)?.places.has(where);
			newTerminal(node, listed ? where : OTHER, undefined, agent ? ["pi"] : undefined);
			if (latest.current.nodeId !== node) navigate(`/deck/${encodeURIComponent(node)}`);
		},
		addCheckout: (node) => setAddingCheckout(node),
		newWorktree: (node, checkoutId) => setCreatingWorktree({ node, checkoutId }),
		revealPlace: (node, where) => {
			openPlace(node, where);
			setPicked(undefined);
			setLayout({ filesOpen: true, sidebar: "files" });
		},
		renameProject: (project: RailProject, name) => {
			if (project.serverKey) report(presentation.rename(project.serverKey, name));
		},
		setCollapsed: (project: RailProject, collapsed) => {
			if (project.serverKey) report(presentation.setCollapsed(project.serverKey, collapsed));
		},
		renameCheckout: (node, checkout, name) => void run(() => nodeClient().updateCheckout(node, checkout.id, { name })),
		checkoutSettings: (node, checkout) => setEditingSettings({ node, checkoutId: checkout.id }),
		keepCheckout: (node, checkout) => void run(() => nodeClient().addCheckout(node, checkout.path)),
		hideCheckout,
		removeWorktree: (node, checkout, worktree) => setRemovingWorktree({ node, checkout, worktree }),
		renameAgent: (key, label) =>
			void run(async () => {
				const { node, terminalId } = splitKey(key);
				await client?.renameTerminal(node, terminalId, label);
			}),
		markRead: (key) => {
			const { node, terminalId } = splitKey(key);
			client?.seen(node, terminalId);
		},
		markUnread: (key) => {
			const { node, terminalId } = splitKey(key);
			client?.markUnread(node, terminalId);
		},
		split: (key, direction) => {
			const found = paneTabOf(key);
			if (!found) return;
			hub.get(found.node).update(found.place, (current) => focusPane(current, found.terminalId));
			splitFocused(found.node, found.place, found.tabId, direction);
		},
		restart: (key) =>
			void run(async () => {
				const { node, terminalId } = splitKey(key);
				const old = terminalOf(node, terminalId);
				if (!client || !old?.exited) return;
				const ws = hub.get(node);
				const place = placeFor(node, old);
				const found = paneTabOf(key);
				// A login shell's own argv (`[shell, "-l"]`) is the default: no argv, so it does not run inside another.
				const argv = old.argv.length === 2 && old.argv[1] === "-l" ? undefined : old.argv;
				const release = ws.holdNewTerminals();
				try {
					const created = await client.createTerminal(node, { cols: old.cols, rows: old.rows }, old.cwd, argv);
					ws.know(created.terminalId);
					if (found) {
						ws.update(found.place, (current) => {
							const tab = current.tabs[found.tabId];
							return tab?.kind === "terminal" ? setPanes(current, found.tabId, replaceLeaf(tab.panes, terminalId, created.terminalId), created.terminalId) : current;
						}, { tabId: found.tabId, terminalId: created.terminalId });
					} else {
						ws.reveal(place, created.terminalId);
					}
					if (old.label) await client.renameTerminal(node, created.terminalId, old.label).catch(() => {});
					await client.killTerminal(node, terminalId);
					navigate(`/deck/${encodeURIComponent(node)}/${encodeURIComponent(created.terminalId)}`);
				} finally {
					release();
				}
			}),
		repair: (node) => setRepairing(node),
	};

	// --- Drawing ---------------------------------------------------------------------------------------------

	const filesShown = Boolean(ready && layout.filesOpen);
	const bar = (
		<DeckAppBar
			theme={theme}
			onTheme={onTheme}
			onHelp={() => setHelp(true)}
			{...(readyFiles ? { onQuickOpen: () => setQuickOpen(true) } : {})}
			rail={{ open: layout.railOpen, onToggle: () => setLayout({ railOpen: !layout.railOpen }), badge: <InboxBadge badge={badge} /> }}
			{...(ready ? { files: { open: layout.filesOpen, onToggle: () => setLayout({ filesOpen: !layout.filesOpen }) } } : {})}
		/>
	);
	const status = (
		<DeckStatusBar
			socket={snapshot.status}
			online={snapshot.nodes.filter((view) => view.info.online).length}
			nodes={snapshot.nodes.length}
			needs={inbox.layout.needs.length}
			working={inbox.layout.working.length}
			{...(permission === "default" && snapshot.nodes.length > 0 ? { onNotify: requestPermission } : {})}
		/>
	);

	if (snapshot.status === "insecure" || snapshot.status === "failed") {
		return (
			<DeckFrame bar={<DeckAppBar theme={theme} onTheme={onTheme} onHelp={() => setHelp(true)} />}>
				<div className="p-8">
					{snapshot.status === "insecure" ? (
						<Callout tone="red" title="Nodes need a secure context">
							This page reached pika over plain http, where browsers offer no WebCrypto. Open pika over https (or on localhost) to
							use nodes.
						</Callout>
					) : (
						<Callout tone="red" title="This browser's node key could not be loaded">
							{snapshot.failure}
						</Callout>
					)}
				</div>
				{help && <KeysHelp onClose={() => setHelp(false)} />}
			</DeckFrame>
		);
	}

	return (
		<DeckFrame bar={bar} status={status}>
			{/* Narrow windows shrink the sidebars to their least widths first, then scroll. */}
			<div className="flex min-h-0 flex-1 overflow-x-auto">
			{layout.railOpen && (
				<>
					<aside className="flex min-w-[220px] flex-col bg-sidebar" style={{ flex: `0 1 ${layout.rail}px` }} aria-label="Agents" data-agent-list="">
						<AgentRail
							nodes={snapshot.nodes}
							agents={agentMap}
							inbox={inbox}
							{...(selectedKey ? { selected: selectedKey } : {})}
							{...(nodeId ? { currentNode: nodeId } : {})}
							{...(place ? { currentPlace: place } : {})}
							railNodeOf={(node) => railNodes.get(node)}
							homeOf={homeOf}
							onHover={setHovering}
							onAgent={(key) => {
								const { node, terminalId } = splitKey(key);
								showPane(node, terminalId, agentMap.get(key)?.place);
							}}
							onNode={(node) => navigate(`/deck/${encodeURIComponent(node)}`)}
							onPlace={(node, next) => {
								hub.get(node).setActive(next);
								revealed.current = undefined;
								navigate(`/deck/${encodeURIComponent(node)}`);
							}}
							canClosePane={(key) => paneTabOf(key) !== undefined}
							onClosePane={(key) => {
								const found = paneTabOf(key);
								if (found) closePaneOf(found.node, found.place, found.tabId, found.terminalId);
							}}
							onKill={(key, confirm) => {
								const agent = agentMap.get(key);
								if (!agent) return;
								if (confirm) setKilling({ node: agent.node.info.id, terminal: agent.terminal });
								else void run(() => client!.killTerminal(agent.node.info.id, agent.terminal.terminalId));
							}}
							header={<h1 className="text-[12px] font-semibold text-dk-ink-2">Agents</h1>}
							ops={ops}
							commands={commands}
						/>
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
				{ready && place && (
					<WorkspaceHeader
						view={ready}
						home={home}
						place={place}
						{...(rail ? { rail } : {})}
						terminal={onScreenInfo}
						session={headerInfo}
						busy={busy}
						onNew={() => newTerminal(ready.info.id, place)}
						onPlace={(next) => {
							hub.get(ready.info.id).setActive(next);
							revealed.current = undefined;
						}}
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
				{/* The terminal layer lives here whatever shows, so no terminal is built again for a node or place switch. */}
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
							<DeckEmpty title={snapshot.nodes.length ? "Pick a node" : snapshot.status === "open" ? "No nodes yet" : "Connecting…"}>
								{snapshot.nodes.length > 0 && <>Choose a node at the top of the agent list, or an agent under it, to open its workspace.</>}
								{snapshot.nodes.length === 0 && snapshot.status === "open" && (
									<>
										Create a node credential with <code className="code-chip">pika node create &lt;name&gt;</code> and start pika-node with it.
									</>
								)}
							</DeckEmpty>
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
								roots={roots}
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
			</div>
			{help && <KeysHelp onClose={() => setHelp(false)} />}
			{quickOpen && ready && readyFiles && (
				<QuickOpen
					key={ready.info.id}
					files={readyFiles}
					{...(onScreenInfo ? { terminal: onScreenInfo } : {})}
					{...(place && placePath(place) ? { root: placePath(place)! } : {})}
					roots={roots.map((item) => item.path)}
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
						hub.get(closing.node).update(closing.place, (current) => closeTab(current, closing.tabId));
						setClosing(null);
					}}
				>
					Its edits are not saved on {viewOf(closing.node)?.info.name ?? "the node"}.
				</ConfirmDialog>
			)}
			{addingCheckout && (
				<AddCheckoutDialog
					nodeName={viewOf(addingCheckout)?.info.name ?? addingCheckout}
					home={homeOf(addingCheckout)}
					listFolders={async (dir) => (await nodeFiles(addingCheckout).readDir(dir)).entries.filter((entry) => entry.kind === "dir").map((entry) => entry.name)}
					onAdd={async (path) => {
						const node = addingCheckout;
						const added = await nodeClient().addCheckout(node, path);
						setAddingCheckout(null);
						const first = worktreeCards(added)[0];
						if (first) openPlace(node, first.place);
					}}
					onCancel={() => setAddingCheckout(null)}
				/>
			)}
			{creatingWorktree && checkoutOf(creatingWorktree.node, creatingWorktree.checkoutId) && (
				<NewWorktreeDialog
					projectName={railNodes.get(creatingWorktree.node)?.projects.find((item) => item.checkouts.some((entry) => entry.checkout.id === creatingWorktree.checkoutId))?.name ?? ""}
					checkout={checkoutOf(creatingWorktree.node, creatingWorktree.checkoutId)!}
					home={homeOf(creatingWorktree.node)}
					onCreate={async ({ name, base, startAgent }) => {
						const { node, checkoutId } = creatingWorktree;
						const ws = hub.get(node);
						const release = ws.holdNewTerminals();
						let created: string;
						try {
							const result = await nodeClient().createWorktree(node, { checkoutId, name, base, cols: 80, rows: 24 });
							created = placeKey(result.checkout.id, result.worktree.path);
							setCreatingWorktree(null);
							openPlace(node, created);
							// The setup script's terminal, so its progress shows.
							if (result.setupTerminal) ws.reveal(created, result.setupTerminal.terminalId);
						} finally {
							release();
						}
						if (startAgent) newTerminal(node, created, undefined, ["pi"]);
					}}
					onCancel={() => setCreatingWorktree(null)}
				/>
			)}
			{removingWorktree && (
				<RemoveWorktreeDialog
					nodeName={viewOf(removingWorktree.node)?.info.name ?? "the node"}
					path={sanitize(removingWorktree.worktree.path)}
					home={homeOf(removingWorktree.node)}
					{...(removingWorktree.worktree.branch ? { branch: removingWorktree.worktree.branch } : {})}
					prunable={removingWorktree.worktree.prunable}
					liveTerminals={
						viewOf(removingWorktree.node)?.terminals.filter(
							(terminal) => !terminal.exited && terminal.checkoutId === removingWorktree.checkout.id && terminal.worktreePath === removingWorktree.worktree.path,
						).length ?? 0
					}
					onRemove={async ({ deleteBranch, force }) => {
						const { node, checkout, worktree } = removingWorktree;
						const result = await nodeClient().removeWorktree(node, { checkoutId: checkout.id, path: worktree.path, ...(deleteBranch ? { deleteBranch } : {}), ...(force ? { force } : {}) });
						const ws = hub.get(node);
						if (ws.active === worktree.place) {
							const main = result.checkout.worktrees.find((item) => item.isMain);
							ws.setActive(main ? placeKey(result.checkout.id, main.path) : OTHER);
						}
						setRemovingWorktree(null);
						const branch = result.branch;
						if (branch) {
							const name = sanitize(branch.name);
							setNotice({
								id: Date.now(),
								message: branch.deleted ? `Removed the worktree and the branch ${name}` : `Removed the worktree; kept the branch ${name}: ${sanitize(branch.message ?? "git refused to delete it")}`,
							});
						}
					}}
					onCancel={() => setRemovingWorktree(null)}
				/>
			)}
			{editingSettings && checkoutOf(editingSettings.node, editingSettings.checkoutId) && (
				<CheckoutSettingsDialog
					checkoutName={sanitize(checkoutOf(editingSettings.node, editingSettings.checkoutId)!.name)}
					checkout={checkoutOf(editingSettings.node, editingSettings.checkoutId)!}
					home={homeOf(editingSettings.node)}
					onSave={async (settings) => {
						await nodeClient().updateCheckout(editingSettings.node, editingSettings.checkoutId, { settings });
						setEditingSettings(null);
					}}
					onCancel={() => setEditingSettings(null)}
				/>
			)}
			{repairing && (
				<ConfirmDialog
					title={`Pair ${viewOf(repairing)?.info.name ?? "the node"} again?`}
					confirmLabel="Forget the Key"
					busy={busy}
					onCancel={() => setRepairing(null)}
					onConfirm={() => {
						const node = repairing;
						void run(async () => {
							await client?.forgetPin(node);
							setRepairing(null);
							navigate(`/deck/${encodeURIComponent(node)}`);
						});
					}}
				>
					This browser forgets the node's pinned key and closes its channel. Pairing again shows the fingerprint to check. The node's terminals keep
					running.
				</ConfirmDialog>
			)}
			{notice && <UndoToast key={notice.id} notice={notice} onDone={() => setNotice(null)} />}
		</DeckFrame>
	);
}

function ActivityButton({ active, onClick, id, children }: { active: boolean; onClick: () => void; id: string; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			className={cx("flex items-center gap-1.5 px-3 text-[12.5px]", active ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--dk-accent)]" : "text-muted hover:text-ink")}
			onClick={onClick}
			data-activity={id}
		>
			{children}
		</button>
	);
}

/**
 * Above the workspace, a breadcrumb: the place (a menu of the node's worktrees, by project), the node and the session
 * the header follows, the focused pane's state; New terminal on the right.
 */
function WorkspaceHeader({
	view,
	home,
	place,
	rail,
	terminal,
	session,
	busy,
	onNew,
	onPlace,
}: {
	view: NodeView;
	home: string;
	place: string;
	rail?: RailNode;
	/** The pane on screen, for its status. */
	terminal?: TerminalInfo;
	/** The pane whose session the heading shows (`RecentTerminals`). */
	session?: TerminalInfo;
	busy: boolean;
	onNew: () => void;
	onPlace: (place: string) => void;
}) {
	const { menu, open, close, openFor } = useMenu();
	const info = rail?.places.get(place);
	const choose = (button: HTMLElement) => {
		const items: MenuEntry[] = [];
		for (const project of rail?.projects ?? []) {
			items.push({ kind: "header", label: project.name });
			for (const { worktrees } of project.checkouts) {
				for (const worktree of worktrees) {
					items.push({
						id: `place:${worktree.place}`,
						label: worktree.meta ? `${worktree.title} · ${worktree.meta}` : worktree.title,
						hint: homePath(sanitize(worktree.path), home),
						checked: worktree.place === place,
						run: () => onPlace(worktree.place),
					});
				}
			}
		}
		if (items.length) items.push("separator");
		items.push({ id: `place:${OTHER}`, label: "Other terminals", checked: place === OTHER, run: () => onPlace(OTHER) });
		open({ ...menuBelow(button), items, label: "Worktrees", attrs: { "data-place-menu": "" } });
	};
	const path = placePath(place);
	return (
		<header className="flex h-9 shrink-0 items-center gap-2 border-b border-dk-line px-2" data-workspace-header={place}>
			<button
				type="button"
				className={cx(BAR_BUTTON, "px-2 text-[13px] font-medium text-dk-ink")}
				aria-haspopup="menu"
				aria-expanded={openFor === "Worktrees"}
				onClick={(event) => (openFor === "Worktrees" ? close() : choose(event.currentTarget))}
				{...tip(path ? `${homePath(sanitize(path), home)}: switch worktree` : "Switch worktree")}
				data-workspace-place={place}
			>
				{placeWords(info) ?? (place === OTHER ? "Other" : path ? sanitize(path.slice(path.lastIndexOf("/") + 1)) : "Other")}
				<svg width="9" height="9" viewBox="0 0 10 10" className="text-dk-ink-3" aria-hidden="true">
					<path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			<svg width="8" height="8" viewBox="0 0 10 10" className="shrink-0 text-dk-ink-3" aria-hidden="true">
				<path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
			<PaneHeading node={view.info.name} terminal={session} home={home} />
			{terminal && <PaneDetail terminal={terminal} />}
			<button type="button" className={cx(BAR_BUTTON, "ml-auto")} disabled={busy} onClick={onNew} aria-label="New terminal" {...tip("New terminal", "terminal.new")} data-new-terminal="">
				<Icon name="plus" size={14} />
			</button>
			{menu}
		</header>
	);
}

/** The focused pane's state in the header: its glyph and what it means, in the state's own ink. */
function PaneBadge({ terminal }: { terminal: TerminalInfo }) {
	const mark = paneMark(terminal);
	if (mark === "idle") return null;
	const kind = terminal.status?.program?.kind;
	const label = mark === "waiting" ? (kind === "permission" ? "Needs permission" : kind === "auth" ? "Needs login" : "Waiting") : markLabel(mark);
	const ink: Partial<Record<PaneMark, string>> = { waiting: "text-dk-needs-ink", error: "text-dk-failed-ink", done: "text-dk-done-ink", working: "text-dk-working-ink" };
	return (
		<span className={cx("inline-flex items-center gap-1 text-[12px] font-medium", ink[mark] ?? "text-dk-ink-2")} {...tip(terminal.status?.program?.message)} data-pane-badge={mark}>
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
					<span className="min-w-0 truncate text-muted" {...tip(session.cwd)} data-pane-cwd="">
						{homePath(session.cwd, home)}
					</span>
				</>
			)}
			{model && (
				<span className="inline-flex min-w-0 shrink items-center gap-1 text-muted" {...tip(session?.model)} data-pane-model="">
					<span className="mono truncate text-[11.5px]">{model}</span>
					<ModelMark model={model} size={12} className="shrink-0" />
				</span>
			)}
			{session?.disconnected && (
				<span className="shrink-0 text-[11.5px] text-muted" {...tip("pi's bridge to pika-node closed; this is the last session it reported")} data-bridge-disconnected="">
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
			{message && (
				<span className="truncate" {...tip(message)}>
					{message}
				</span>
			)}
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
