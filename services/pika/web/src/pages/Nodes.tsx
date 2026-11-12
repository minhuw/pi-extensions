import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Icon } from "../components/icons";
import { BUTTON, Callout, ConfirmDialog, cx, EmptyState, Pill } from "../components/ui";
import { useApi } from "../lib/api";
import { withBase } from "../lib/base";
import { copyText } from "../lib/clipboard";
import { shortUserAgent } from "../lib/devices";
import { useHealth } from "../lib/relay";
import { useTheme } from "../lib/theme";
import { liveBridge, NodesClient, orderTerminals, type NodesSnapshot, type NodeView } from "../nodes/client";
import { displayFingerprint, type TerminalInfo } from "../nodes/contract";
import { IndexedDbKeyStore } from "../nodes/identity";
import { nodeSocketUrl } from "../nodes/socket";
import { TerminalView } from "../nodes/TerminalView";

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

function NodesWorkspace() {
	const client = useNodesClient();
	const snapshot = useSnapshot(client);
	const { node: nodeId, terminal: terminalId } = useParams();
	const selected = snapshot.nodes.find((item) => item.info.id === nodeId);

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

	return (
		<div className="flex h-full min-h-0" data-nodes-page="">
			<NodeRail snapshot={snapshot} nodeId={nodeId} terminalId={terminalId} />
			<section className="flex min-w-0 flex-1 flex-col" aria-label="Terminal">
				{client && selected ? (
					<NodeMain client={client} view={selected} terminalId={terminalId} fingerprint={snapshot.fingerprint} />
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
			{/* The files pane (file tree, Monaco, diffs, uploads; NODE.md §4 "Files") goes here, right of the terminal. */}
		</div>
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

function terminalLabel(terminal: TerminalInfo): string {
	return liveBridge(terminal.status)?.title || terminal.title || terminal.argv[0] || "Shell";
}

function linkLabel(view: NodeView): ReactNode {
	const link = view.link;
	if (!view.pin && link.kind !== "ready") return <Pill>Not paired</Pill>;
	if (link.kind === "closed" && link.code === "node_key_changed") return <Pill tone="red">Key changed</Pill>;
	if (link.kind === "opening" || link.kind === "handshaking") return <span className="text-[11.5px] text-muted">Connecting…</span>;
	return null;
}

function NodeRail({ snapshot, nodeId, terminalId }: { snapshot: NodesSnapshot; nodeId?: string; terminalId?: string }) {
	return (
		<aside className="flex w-[288px] shrink-0 flex-col border-r border-line bg-sidebar max-md:w-[220px]" aria-label="Nodes">
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
														{terminalLabel(terminal)}
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

function NodeMain({ client, view, terminalId, fingerprint }: { client: NodesClient; view: NodeView; terminalId?: string; fingerprint?: string }) {
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
				<span className="min-w-0 truncate text-[13.5px] font-medium">
					{name}
					{terminal && <span className="font-normal text-muted"> · {terminal.cwd}</span>}
				</span>
				{terminal && <PaneDetail terminal={terminal} />}
				<button type="button" className={cx(BUTTON.secondary, "ml-auto h-7")} disabled={busy} onClick={create} data-new-terminal="">
					<Icon name="plus" size={13} />
					New terminal
				</button>
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
						: `Sends SIGTERM to ${terminalLabel(killing)} (pid ${killing.pid}) on ${name}. Anything running in it stops.`}
				</ConfirmDialog>
			)}
		</>
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
			<PaneBadge terminal={terminal} />
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

