import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Icon } from "../components/icons";
import { ModelMark } from "../components/ModelName";
import { BUTTON, Callout, ConfirmDialog, cx, EmptyState, Pill } from "../components/ui";
import { useApi } from "../lib/api";
import { withBase } from "../lib/base";
import { copyText } from "../lib/clipboard";
import { shortUserAgent } from "../lib/devices";
import { bareModelOf } from "../lib/model";
import { useHealth } from "../lib/relay";
import { useTheme } from "../lib/theme";
import { homePath, liveBridge, NodesClient, orderTerminals, paneLabel, paneSession, type NodesSnapshot, type NodeView } from "../nodes/client";
import { displayFingerprint, type Project, type TerminalInfo } from "../nodes/contract";
import { EditorStore, paneRequest } from "../nodes/editor";
import { FilePanel } from "../nodes/FilePanel";
import { IndexedDbKeyStore } from "../nodes/identity";
import { clampWidth, LAYOUT_BOUNDS, loadLayout, saveLayout, type NodesLayout } from "../nodes/layout";
import { nodeSocketUrl } from "../nodes/socket";
import { Splitter } from "../nodes/Splitter";
import { TerminalView } from "../nodes/TerminalView";
import { rootFor } from "../nodes/tree";

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

/** One editor store per node, kept while the page is open, so its tabs survive picking another node and reconnects. */
function useEditors(client: NodesClient | null, snapshot: NodesSnapshot): (node: string) => EditorStore {
	const editors = useRef(new Map<string, EditorStore>());
	const editorFor = useCallback((node: string) => {
		let store = editors.current.get(node);
		if (!store) {
			store = new EditorStore();
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

function NodesWorkspace() {
	const client = useNodesClient();
	const snapshot = useSnapshot(client);
	const navigate = useNavigate();
	const { theme } = useTheme();
	const { node: nodeId, terminal: terminalId } = useParams();
	const selected = snapshot.nodes.find((item) => item.info.id === nodeId);
	const [layout, setLayout] = useLayout();
	const editorFor = useEditors(client, snapshot);
	const location = useRef(nodeId);
	location.current = nodeId;

	// The bridge's /pika-open and /pika-diff: shown in the node's editor, on screen. A tab in the background ignores
	// them (NODE.md, "Requests from the bridge"), so only the windows in view open the file.
	useEffect(() => {
		if (!client) return;
		return client.onEvent((node, event) => {
			if (event.type !== "pane.open" && event.type !== "pane.diff") return;
			if (document.visibilityState !== "visible") return;
			const store = editorFor(node);
			store.setFiles(client.files(node));
			void paneRequest(store, event);
			setLayout({ filesOpen: true });
			if (location.current !== node) navigate(`/nodes/${encodeURIComponent(node)}/${encodeURIComponent(event.terminalId)}`);
		});
	}, [client, editorFor, navigate, setLayout]);

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

	const ready = client && selected && selected.link.kind === "ready" ? selected : undefined;
	const filesShown = Boolean(ready && layout.filesOpen);

	return (
		// Narrow windows shrink the side panes to their least widths first, then scroll.
		<div className="flex h-full min-h-0 overflow-x-auto" data-nodes-page="">
			<NodeRail snapshot={snapshot} nodeId={nodeId} terminalId={terminalId} width={layout.rail} />
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
			<section className="flex min-w-[320px] flex-1 flex-col" aria-label="Terminal">
				{client && selected ? (
					<NodeMain
						client={client}
						view={selected}
						terminalId={terminalId}
						fingerprint={snapshot.fingerprint}
						onShowFiles={ready && !layout.filesOpen ? () => setLayout({ filesOpen: true }) : undefined}
					/>
				) : (
					<EmptyState title={snapshot.nodes.length ? "Pick a node" : snapshot.status === "open" ? "No nodes yet" : "Connecting…"}>
						{snapshot.nodes.length === 0 && snapshot.status === "open" && (
							<>
								Create a node credential with <code className="code-chip">pika node create &lt;name&gt;</code> and start pika-node with it.
							</>
						)}
					</EmptyState>
				)}
			</section>
			{filesShown && client && ready && ready.link.kind === "ready" && (
				<>
					<Splitter
						name="files"
						label="Resize the files"
						side="right"
						value={layout.files}
						min={LAYOUT_BOUNDS.files[0]}
						max={LAYOUT_BOUNDS.files[1]}
						onChange={(files) => setLayout({ files }, false)}
						onCommit={(files) => setLayout({ files })}
					/>
					<div className="flex min-h-0 min-w-[300px]" style={{ flex: `0 1 ${layout.files}px` }}>
						<NodeFiles
							key={ready.info.id}
							client={client}
							view={ready}
							home={ready.link.welcome.home}
							terminal={ready.terminals.find((item) => item.terminalId === terminalId)}
							store={editorFor(ready.info.id)}
							theme={theme}
							layout={layout}
							setLayout={setLayout}
						/>
					</div>
				</>
			)}
		</div>
	);
}

/** The file panel for one node: its projects, and the tree's root for the pane on screen. */
function NodeFiles({
	client,
	view,
	home,
	terminal,
	store,
	theme,
	layout,
	setLayout,
}: {
	client: NodesClient;
	view: NodeView;
	home: string;
	terminal?: TerminalInfo;
	store: EditorStore;
	theme: ReturnType<typeof useTheme>["theme"];
	layout: NodesLayout;
	setLayout: (change: Partial<NodesLayout>, commit?: boolean) => void;
}) {
	const files = client.files(view.info.id);
	const [projects, setProjects] = useState<Project[]>([]);
	const [picked, setPicked] = useState<string>();
	const cwd = terminal ? paneSession(terminal).cwd : undefined;

	useEffect(() => {
		if (!files) return;
		let current = true;
		files.request("projects.list", {}).then(
			(result) => current && setProjects(result.projects),
			() => current && setProjects([]),
		);
		return () => {
			current = false;
		};
	}, [files]);

	// Another pane shows its own project; a folder picked by hand lasts until then.
	useEffect(() => setPicked(undefined), [terminal?.terminalId]);

	return (
		<FilePanel
			node={view.info.id}
			nodeName={view.info.name}
			home={home}
			files={files}
			store={store}
			root={picked ?? rootFor(projects, cwd, home)}
			projects={projects}
			onRoot={setPicked}
			theme={theme}
			treeWidth={layout.tree}
			onTreeWidth={(tree, commit) => setLayout({ tree: clampWidth("tree", tree) }, commit)}
			hidden={layout.hidden}
			onHidden={(hidden) => setLayout({ hidden })}
			onCollapse={() => setLayout({ filesOpen: false })}
		/>
	);
}

function SocketStatus({ status }: { status: NodesSnapshot["status"] }) {
	if (status === "open") return null;
	return (
		<span className="text-[12px] text-muted" role="status" data-socket-status={status}>
			{status === "closed" ? "Reconnecting…" : "Connecting…"}
		</span>
	);
}

function PaneBadge({ terminal }: { terminal: TerminalInfo }) {
	if (terminal.exited) return <span className="text-[11.5px] text-muted">Exited</span>;
	const status = terminal.status;
	if (!status) return null;
	if (status.state === "waiting") {
		const kind = status.program?.kind;
		return (
			<Pill tone="yellow" title={status.program?.message}>
				{kind === "permission" ? "Needs permission" : kind === "auth" ? "Needs login" : "Waiting"}
			</Pill>
		);
	}
	if (status.state === "busy") return <Pill>Busy</Pill>;
	if (status.unread)
		return (
			<span className="inline-flex items-center gap-1 text-[11.5px] font-medium" title="Finished since you last looked">
				<span className="size-1.5 rounded-full bg-ink" aria-hidden="true" />
				Done
			</span>
		);
	return null;
}

const paneState = (terminal: TerminalInfo): string =>
	terminal.exited ? "exited" : terminal.status?.state === "idle" && terminal.status.unread ? "unread" : (terminal.status?.state ?? "unknown");

function linkLabel(view: NodeView): ReactNode {
	const link = view.link;
	if (!view.pin && link.kind !== "ready") return <Pill>Not paired</Pill>;
	if (link.kind === "closed" && link.code === "node_key_changed") return <Pill tone="red">Key changed</Pill>;
	if (link.kind === "opening" || link.kind === "handshaking") return <span className="text-[11.5px] text-muted">Connecting…</span>;
	return null;
}

function NodeRail({ snapshot, nodeId, terminalId, width }: { snapshot: NodesSnapshot; nodeId?: string; terminalId?: string; width: number }) {
	return (
		<aside className="flex min-w-[200px] flex-col bg-sidebar" style={{ flex: `0 1 ${width}px` }} aria-label="Nodes" data-agent-list="">
			<div className="flex h-10 shrink-0 items-center gap-2 px-4">
				<h1 className="text-[15px] font-semibold">Nodes</h1>
				<SocketStatus status={snapshot.status} />
			</div>
			<ul className="min-h-0 flex-1 overflow-y-auto pb-3">
				{snapshot.nodes.map((view) => {
					const current = view.info.id === nodeId;
					return (
						<li key={view.info.id} data-node={view.info.id}>
							<Link
								to={`/nodes/${encodeURIComponent(view.info.id)}`}
								aria-current={current && !terminalId ? "page" : undefined}
								className={cx("flex items-center gap-2 px-4 py-1.5 hover:bg-hover", current && "bg-hover")}
							>
								<span
									className={cx("size-2 shrink-0 rounded-full", view.info.online ? "bg-ink" : "border border-muted")}
									aria-hidden="true"
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13.5px] font-medium">{view.info.name}</span>
									<span className="block truncate text-[11.5px] text-muted">
										{view.info.online ? (view.info.host ?? "Online") : "Offline"}
									</span>
								</span>
								{linkLabel(view)}
							</Link>
							{view.link.kind === "ready" && view.terminals.length > 0 && (
								<ul className="mb-1" aria-label={`Terminals on ${view.info.name}`}>
									{orderTerminals(view.terminals).map((terminal) => {
										const open = current && terminal.terminalId === terminalId;
										return (
											<li key={terminal.terminalId} data-terminal={terminal.terminalId} data-pane-state={paneState(terminal)}>
												<Link
													to={`/nodes/${encodeURIComponent(view.info.id)}/${encodeURIComponent(terminal.terminalId)}`}
													aria-current={open ? "page" : undefined}
													className={cx(
														"flex items-center gap-2 py-1 pr-4 pl-8 text-[13px] hover:bg-hover",
														open && "bg-hover font-medium shadow-[inset_3px_0_0_var(--color-ink)]",
														terminal.exited && "text-muted",
													)}
												>
													<Icon name="terminal" size={13} className="shrink-0 text-muted" />
													<span className="min-w-0 flex-1 truncate" title={terminal.cwd}>
														{paneLabel(terminal)}
													</span>
													<PaneBadge terminal={terminal} />
												</Link>
											</li>
										);
									})}
								</ul>
							)}
						</li>
					);
				})}
			</ul>
			{snapshot.fingerprint && (
				<div className="shrink-0 border-t border-line px-4 py-2.5" data-client-fingerprint={snapshot.fingerprint}>
					<div className="text-[11.5px] text-muted">This browser's key</div>
					{/* Two rows of four groups, rather than wherever the rail's width breaks them. */}
					<div className="font-mono text-[11.5px] select-all">
						{displayFingerprint(snapshot.fingerprint)
							.match(/(?:\S+\s?){1,4}/g)
							?.map((row) => (
								<span key={row} className="block">
									{row}
								</span>
							))}
					</div>
				</div>
			)}
		</aside>
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
			<button
				type="button"
				className="shrink-0 border-l border-line px-3 text-[12.5px] text-muted hover:text-ink"
				onClick={() => void copyText(command).then(setCopied)}
			>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

function Panel({ children }: { children: ReactNode }) {
	return <div className="w-full max-w-[640px] px-8 pt-8 pb-10 text-[14px] max-sm:px-4">{children}</div>;
}

function NodeMain({
	client,
	view,
	terminalId,
	fingerprint,
	onShowFiles,
}: {
	client: NodesClient;
	view: NodeView;
	terminalId?: string;
	fingerprint?: string;
	/** Shows the file panel, when it is hidden. */
	onShowFiles?: () => void;
}) {
	const { theme } = useTheme();
	const navigate = useNavigate();
	const [killing, setKilling] = useState<TerminalInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const name = view.info.name;
	const link = view.link;
	const nodePath = `/nodes/${encodeURIComponent(view.info.id)}`;
	const terminal = view.terminals.find((item) => item.terminalId === terminalId);
	const channel = client.channel(view.info.id);
	const unread = terminal?.status?.unread === true;

	// A kill confirmation belongs to the terminal on screen: another selection (such as New terminal's) closes it.
	useEffect(() => setKilling(null), [terminalId]);

	// pane.seen while the terminal is on screen and the tab is visible.
	useEffect(() => {
		if (!unread || !terminalId) return;
		const mark = () => {
			if (document.visibilityState === "visible") client.seen(view.info.id, terminalId);
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [client, unread, view.info.id, terminalId]);

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

	if (link.kind !== "ready" || !channel) {
		return (
			<Panel>
				<h2 className="text-[18px] font-semibold">{name}</h2>
				<NodeLinkState view={view} client={client} />
			</Panel>
		);
	}

	const create = () =>
		void run(async () => {
			const created = await client.createTerminal(view.info.id, { cols: 80, rows: 24 });
			navigate(`${nodePath}/${encodeURIComponent(created.terminalId)}`);
		});

	return (
		<>
			<header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3">
				<PaneHeading node={name} terminal={terminal} home={link.welcome.home} />
				{terminal && <PaneDetail terminal={terminal} />}
				<button type="button" className={cx(BUTTON.secondary, "ml-auto h-7 shrink-0")} disabled={busy} onClick={create} data-new-terminal="">
					<Icon name="plus" size={13} />
					New terminal
				</button>
				{onShowFiles && (
					<button type="button" className={cx(BUTTON.quiet, "h-7 shrink-0 px-2")} onClick={onShowFiles} data-show-files="">
						<Icon name="folder" size={13} />
						Files
					</button>
				)}
			</header>
			{(actionError || view.error) && (
				<div className="shrink-0 px-3 pt-2">
					<Callout tone="red">{actionError ?? view.error}</Callout>
				</div>
			)}
			{terminal ? (
				<TerminalView
					key={`${view.epoch}:${terminal.terminalId}`}
					channel={channel}
					terminal={terminal}
					theme={theme}
					onKill={() => setKilling(terminal)}
				/>
			) : (
				<EmptyState title={view.terminals.length ? "Pick a terminal" : `No terminals on ${name}`}>
					{view.terminals.length === 0 && "New terminal starts your login shell there."}
				</EmptyState>
			)}
			{killing && (
				<ConfirmDialog
					title={killing.exited ? "Remove this terminal?" : "Kill this terminal?"}
					confirmLabel={killing.exited ? "Remove" : "Kill"}
					busy={busy}
					onCancel={() => setKilling(null)}
					onConfirm={() =>
						void run(async () => {
							await client.killTerminal(view.info.id, killing.terminalId);
							setKilling(null);
							navigate(nodePath);
						})
					}
				>
					{killing.exited
						? "Its last screen goes away."
						: `Sends SIGTERM to ${paneLabel(killing)} (pid ${killing.pid}) on ${name}. Anything running in it stops.`}
				</ConfirmDialog>
			)}
		</>
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
				<span
					className="shrink-0 text-[11.5px] text-muted"
					title="pi's bridge to pika-node closed; this is the last session it reported"
					data-bridge-disconnected=""
				>
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

