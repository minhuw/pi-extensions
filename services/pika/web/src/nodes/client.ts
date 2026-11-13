import { ChannelClosed, NodeChannel, NodeRequestError, type ChannelState } from "./channel";
import { sanitize, type BridgeStatus, type Checkout, type CheckoutSettings, type Identity, type NodeEvent, type NodeInfo, type PaneView, type RequestType, type Requests, type Results, type TerminalInfo } from "./contract";
import { NodeFiles } from "./files";
import { clientIdentity, webCryptoAvailable, type KeyStore, type PinnedNode } from "./identity";
import { NodeSocket, OpenRefused, type NodeSocketOptions, type SocketStatus } from "./socket";

/** Channel closes after which the page opens a new channel on its own; any other close waits for the user. */
const TRANSIENT = new Set(["disconnected", "node_offline", "client_gone"]);

export type NodeLink =
	| { kind: "idle" }
	| { kind: "opening" }
	| { kind: "refused"; code: string }
	| ChannelState;

export interface NodeView {
	info: NodeInfo;
	pin?: PinnedNode;
	link: NodeLink;
	/** Newest first, as `term.list` orders them; kept current by `term.created` and `term.removed`. */
	terminals: TerminalInfo[];
	/** The current channel's `term.list` has answered: `terminals` is the node's whole list, not a partial one. */
	listed: boolean;
	/**
	 * The node's checkouts (NODE.md, "Checkouts"), kept current by `checkouts.changed`; the last known ones while it is
	 * not connected. Undefined until a channel lists them; empty from a daemon without the `checkouts` capability.
	 */
	checkouts?: readonly Checkout[];
	/** The node left checkouts (or worktrees) out of the list. */
	checkoutsTruncated?: boolean;
	/** The last `error` event or failed request, for display. */
	error?: string;
	/** The current channel's number, which changes with every new channel: terminal views attach again. */
	epoch: number;
}

export interface NodesSnapshot {
	/** `insecure`: no WebCrypto (not a secure context). `failed`: the client key could not be loaded. */
	status: "loading" | "insecure" | "failed" | SocketStatus;
	failure?: string;
	fingerprint?: string;
	nodes: NodeView[];
}

export interface NodesClientOptions {
	socketUrl: string;
	store: KeyStore;
	label: string;
	socket?: NodeSocketOptions;
}

interface NodeEntry {
	pin?: PinnedNode;
	link: NodeLink;
	channel?: NodeChannel;
	/** The ready channel's file layer, made on first use. */
	files?: NodeFiles;
	terminals: TerminalInfo[];
	/** The channel whose `term.list` answered last. */
	listedBy?: NodeChannel;
	checkouts?: Checkout[];
	checkoutsTruncated?: boolean;
	error?: string;
	epoch: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Untrusted text from a node, cleaned for display (NODE.md, "Untrusted text"). */
export function cleanTerminal(info: TerminalInfo): TerminalInfo {
	const label = sanitize(info.label).trim();
	const { label: _raw, ...rest } = info;
	return { ...rest, title: sanitize(info.title), cwd: sanitize(info.cwd), ...(label ? { label } : {}) };
}

/**
 * Deck's state outside React: the client key, pins, the browser socket, and one channel per pinned node.
 * Channels open on their own only to pinned nodes; an unpinned node gets a channel only from `pair`.
 */
export class NodesClient {
	#options: NodesClientOptions;
	#identity: Identity | undefined;
	#socket: NodeSocket | undefined;
	#entries = new Map<string, NodeEntry>();
	#listeners = new Set<() => void>();
	#eventListeners = new Set<(node: string, event: NodeEvent) => void>();
	#snapshot: NodesSnapshot = { status: "loading", nodes: [] };
	#status: NodesSnapshot["status"] = "loading";
	#failure: string | undefined;
	#disposed = false;

	constructor(options: NodesClientOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		if (!webCryptoAvailable()) {
			this.#status = "insecure";
			this.#emit();
			return;
		}
		try {
			this.#identity = await clientIdentity(this.#options.store);
			for (const pin of await this.#options.store.pins()) this.#entry(pin.node).pin = pin;
		} catch (error) {
			this.#status = "failed";
			this.#failure = messageOf(error);
			this.#emit();
			return;
		}
		if (this.#disposed) return;
		this.#socket = new NodeSocket(this.#options.socketUrl, this.#options.socket);
		this.#socket.subscribe(() => this.#sync());
		this.#sync();
	}

	dispose(): void {
		this.#disposed = true;
		for (const entry of this.#entries.values()) entry.channel?.close("closed");
		this.#socket?.dispose();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): NodesSnapshot => this.#snapshot;

	/** The ready channel to `node`, for terminal views. */
	channel(node: string): NodeChannel | undefined {
		const entry = this.#entries.get(node);
		return entry?.link.kind === "ready" ? entry.channel : undefined;
	}

	/** The ready channel's files (NODE.md §4 "Files"); a new channel gets a new one, its watches gone with the old. */
	files(node: string): NodeFiles | undefined {
		const entry = this.#entries.get(node);
		const channel = this.channel(node);
		if (!entry || !channel) return undefined;
		if (entry.files?.channel !== channel) {
			entry.files?.dispose();
			entry.files = new NodeFiles(channel);
		}
		return entry.files;
	}

	/** Every node event after the client has applied it, for views that act on them (`pane.open`, `pane.diff`). */
	onEvent(listener: (node: string, event: NodeEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** Opens an unpinned channel so the user can enrol this browser or confirm the node's key. */
	pair(node: string): void {
		this.#connect(node);
	}

	/** The user confirmed the node fingerprint shown in `confirm`: pin it, then open a new, pinned channel. */
	async confirmPin(node: string): Promise<void> {
		const entry = this.#entry(node);
		const link = entry.link;
		if (link.kind !== "confirm") throw new Error("There is no node key waiting for confirmation.");
		const pin: PinnedNode = {
			node,
			fingerprint: link.nodeFingerprint,
			publicKey: link.nodeKey,
			name: this.#socket?.nodes.find((item) => item.id === node)?.name ?? node,
			pinnedAt: Date.now(),
		};
		await this.#options.store.pin(pin);
		entry.pin = pin;
		this.#drop(entry, "closed");
		this.#connect(node);
	}

	/** The fingerprints did not match: close without pinning. */
	rejectPin(node: string): void {
		const entry = this.#entry(node);
		this.#drop(entry, "closed");
		entry.link = { kind: "closed", code: "fingerprint_mismatch" };
		this.#emit();
	}

	/** Removes the pin (after `node_key_changed`, when the user knows why the key changed). */
	async forgetPin(node: string): Promise<void> {
		await this.#options.store.unpin(node);
		const entry = this.#entry(node);
		entry.pin = undefined;
		this.#drop(entry, "closed");
		entry.link = { kind: "idle" };
		this.#emit();
	}

	/** Tries a node again after a close that does not reconnect on its own. */
	retry(node: string): void {
		this.#connect(node);
	}

	/**
	 * A new terminal on `node`, its login shell started in `cwd` when given (the node's home otherwise), running `argv`
	 * through it when given.
	 */
	async createTerminal(node: string, size: { cols: number; rows: number }, cwd?: string, argv?: string[]): Promise<TerminalInfo> {
		const { terminal } = await this.#request(node, (channel) => channel.request("term.create", { ...size, ...(cwd ? { cwd } : {}), ...(argv ? { argv } : {}) }));
		this.#added(node, terminal);
		return terminal;
	}

	/** `term.restart`: an exited terminal started again as a new one, which the node lists in its place (`term.removed`). */
	async restartTerminal(node: string, terminalId: string): Promise<TerminalInfo> {
		const { terminal } = await this.#request(node, (channel) => channel.request("term.restart", { terminalId }));
		this.#added(node, terminal);
		return terminal;
	}

	async killTerminal(node: string, terminalId: string): Promise<void> {
		await this.#request(node, (channel) => channel.request("term.kill", { terminalId }));
	}

	/** `pane.seen`: clears the terminal's unread flag on the node, for every client. */
	seen(node: string, terminalId: string): void {
		const channel = this.channel(node);
		channel?.notify({ type: "pane.seen", terminalId }).catch((error: unknown) => this.#fail(node, error));
	}

	/** `pane.unread`: marks the terminal unread on the node, for every client (a daemon with `pane.unread`). */
	markUnread(node: string, terminalId: string): void {
		const channel = this.channel(node);
		channel?.notify({ type: "pane.unread", terminalId }).catch((error: unknown) => this.#fail(node, error));
	}

	/** `term.rename`: the name every client shows for the terminal; null clears it. */
	async renameTerminal(node: string, terminalId: string, label: string | null): Promise<void> {
		const { terminal } = await this.#request(node, (channel) => channel.request("term.rename", { terminalId, label }));
		this.#added(node, terminal);
	}

	/** What the node's daemon offers (`welcome.capabilities`); empty while it is not connected. */
	capabilities(node: string): ReadonlySet<string> {
		const link = this.#entries.get(node)?.link;
		return new Set(link?.kind === "ready" ? link.welcome.capabilities : []);
	}

	/** The one `term.list` per channel; events keep the list current after it. */
	async refreshTerminals(node: string): Promise<void> {
		const channel = this.channel(node);
		const { terminals } = await this.#request(node, (current) => current.request("term.list", {}));
		const entry = this.#entry(node);
		entry.terminals = terminals.map(cleanTerminal);
		if (channel && entry.channel === channel) entry.listedBy = channel;
		this.#emit();
	}

	/** `checkouts.list`, once per channel to a daemon with `checkouts`; `checkouts.changed` keeps the list after it. */
	async refreshCheckouts(node: string): Promise<void> {
		const entry = this.#entry(node);
		if (!this.capabilities(node).has("checkouts")) {
			entry.checkouts = [];
			entry.checkoutsTruncated = false;
			this.#emit();
			return;
		}
		const { checkouts, truncated } = await this.#ask(node, "checkouts.list", {});
		this.#setCheckouts(node, checkouts, truncated);
	}

	/** `checkout.add`: a directory's checkout (its repository's, in a git work tree), kept in the node's list. */
	async addCheckout(node: string, path: string): Promise<Checkout> {
		const { checkout } = await this.#ask(node, "checkout.add", { path });
		this.#upsertCheckout(node, checkout);
		return checkout;
	}

	/** `checkout.hide` ("Remove from Deck"); `unhideCheckout` undoes it. Nothing on disk changes. */
	async hideCheckout(node: string, checkoutId: string): Promise<void> {
		await this.#ask(node, "checkout.hide", { checkoutId });
		const entry = this.#entry(node);
		if (entry.checkouts) entry.checkouts = entry.checkouts.filter((item) => item.id !== checkoutId);
		this.#emit();
	}

	async unhideCheckout(node: string, checkoutId: string): Promise<Checkout> {
		const { checkout } = await this.#ask(node, "checkout.unhide", { checkoutId });
		this.#upsertCheckout(node, checkout);
		return checkout;
	}

	/** `checkout.update`: the node's name for a checkout (null clears it), or its settings, replaced whole. */
	async updateCheckout(node: string, checkoutId: string, change: { name?: string | null; settings?: CheckoutSettings }): Promise<Checkout> {
		const { checkout } = await this.#ask(node, "checkout.update", { checkoutId, ...change });
		this.#upsertCheckout(node, checkout);
		return checkout;
	}

	/** `worktree.create`: a new branch in a new worktree, and the terminal running the setup script when there is one. */
	async createWorktree(node: string, params: Requests["worktree.create"]): Promise<Results["worktree.create"]> {
		const result = await this.#ask(node, "worktree.create", params);
		this.#upsertCheckout(node, result.checkout);
		if (result.setupTerminal) this.#added(node, result.setupTerminal);
		return result;
	}

	/** `worktree.remove`: a linked worktree, and its branch with `deleteBranch`; `force` stops the terminals in it first. */
	async removeWorktree(node: string, params: Requests["worktree.remove"]): Promise<Results["worktree.remove"]> {
		const result = await this.#ask(node, "worktree.remove", params);
		this.#upsertCheckout(node, result.checkout);
		return result;
	}

	/** A request whose failure its caller shows (a dialog, a notice), not the node's error line. */
	async #ask<K extends RequestType>(node: string, type: K, params: Requests[K]): Promise<Results[K]> {
		const channel = this.channel(node);
		if (!channel) throw new Error("The node is not connected.");
		return channel.request(type, params);
	}

	#setCheckouts(node: string, checkouts: Checkout[], truncated: boolean): void {
		const entry = this.#entry(node);
		entry.checkouts = checkouts;
		entry.checkoutsTruncated = truncated;
		this.#emit();
	}

	/** A checkout a reply answered, in its place in the list (by name, case aside, then path), as the node orders it. */
	#upsertCheckout(node: string, checkout: Checkout): void {
		const entry = this.#entry(node);
		const rest = (entry.checkouts ?? []).filter((item) => item.id !== checkout.id);
		entry.checkouts = [...rest, checkout].sort(compareCheckouts);
		this.#emit();
	}

	async #request<T>(node: string, run: (channel: NodeChannel) => Promise<T>): Promise<T> {
		const channel = this.channel(node);
		if (!channel) throw new Error("The node is not connected.");
		try {
			return await run(channel);
		} catch (error) {
			this.#fail(node, error);
			throw error;
		}
	}

	#fail(node: string, error: unknown): void {
		if (error instanceof ChannelClosed) return;
		this.#entry(node).error = error instanceof NodeRequestError ? `${error.code}: ${error.message}` : messageOf(error);
		this.#emit();
	}

	#entry(node: string): NodeEntry {
		let entry = this.#entries.get(node);
		if (!entry) {
			entry = { link: { kind: "idle" }, terminals: [], epoch: 0 };
			this.#entries.set(node, entry);
		}
		return entry;
	}

	/** Opens channels to pinned nodes that are online and not connected, after transient closes too. */
	#sync(): void {
		const socket = this.#socket;
		if (!socket) return;
		this.#status = socket.status;
		if (socket.status === "open") {
			for (const info of socket.nodes) {
				const entry = this.#entry(info.id);
				if (!entry.pin || !info.online) continue;
				const link = entry.link;
				if (link.kind === "idle" || (link.kind === "refused" && TRANSIENT.has(link.code)) || (link.kind === "closed" && TRANSIENT.has(link.code))) {
					this.#connect(info.id);
				}
			}
		}
		this.#emit();
	}

	#connect(node: string): void {
		const socket = this.#socket;
		const identity = this.#identity;
		if (!socket || !identity) return;
		const entry = this.#entry(node);
		this.#drop(entry, "closed");
		entry.link = { kind: "opening" };
		entry.error = undefined;
		const epoch = ++entry.epoch;
		this.#emit();
		socket.open(node).then(
			async (route) => {
				if (entry.epoch !== epoch || this.#disposed) {
					route.close("closed");
					return;
				}
				const channel = new NodeChannel(route, { identity, pinned: entry.pin?.fingerprint, label: this.#options.label });
				entry.channel = channel;
				channel.onState((state) => this.#channelState(node, channel, state));
				channel.onEvent((event) => this.#event(node, event));
				entry.link = channel.state;
				this.#emit();
				try {
					await channel.start();
				} catch (error) {
					channel.close("handshake_failed");
					entry.error = messageOf(error);
					this.#emit();
				}
			},
			(error: unknown) => {
				if (entry.epoch !== epoch) return;
				entry.link = { kind: "refused", code: error instanceof OpenRefused ? error.code : messageOf(error) };
				this.#emit();
			},
		);
	}

	#drop(entry: NodeEntry, code: string): void {
		const channel = entry.channel;
		entry.channel = undefined;
		entry.files?.dispose();
		entry.files = undefined;
		channel?.close(code);
	}

	#channelState(node: string, channel: NodeChannel, state: ChannelState): void {
		const entry = this.#entry(node);
		if (entry.channel !== channel) return;
		entry.link = state;
		if (state.kind === "ready") {
			void this.refreshTerminals(node).catch(() => {});
			void this.refreshCheckouts(node).catch((error: unknown) => this.#fail(node, error));
		}
		if (state.kind === "closed") {
			entry.channel = undefined;
			entry.files?.dispose();
			entry.files = undefined;
			// A transient close reconnects once the node is back; `#sync` does it now if it already is.
			if (TRANSIENT.has(state.code)) queueMicrotask(() => this.#sync());
		}
		this.#emit();
	}

	#event(node: string, event: NodeEvent): void {
		this.#apply(node, event);
		for (const listener of this.#eventListeners) listener(node, event);
	}

	#apply(node: string, event: NodeEvent): void {
		const entry = this.#entry(node);
		const update = (terminalId: string, change: (info: TerminalInfo) => TerminalInfo): void => {
			const index = entry.terminals.findIndex((item) => item.terminalId === terminalId);
			// Unknown before the channel's `term.list` answers, which then includes it.
			if (index < 0) return;
			entry.terminals = entry.terminals.map((item, i) => (i === index ? change(item) : item));
			this.#emit();
		};
		switch (event.type) {
			case "term.created":
				this.#added(node, event.terminal);
				return;
			case "term.removed":
				entry.terminals = entry.terminals.filter((item) => item.terminalId !== event.terminalId);
				this.#emit();
				return;
			case "pane.status": {
				const status: PaneView | undefined = event.status ?? undefined;
				update(event.terminalId, (info) => {
					const next = { ...info };
					if (status) next.status = status;
					else delete next.status;
					return next;
				});
				return;
			}
			case "term.title":
				update(event.terminalId, (info) => ({ ...info, title: sanitize(event.title) }));
				return;
			case "term.renamed":
				update(event.terminalId, (info) => {
					const { label: _old, ...rest } = info;
					return cleanTerminal(event.label === null ? rest : { ...rest, label: event.label });
				});
				return;
			case "term.exit":
				update(event.terminalId, (info) => ({ ...info, exited: { code: event.code, signal: event.signal } }));
				return;
			case "term.placed":
				update(event.terminalId, (info) => {
					const { checkoutId: _checkout, worktreePath: _worktree, ...rest } = info;
					return event.checkoutId && event.worktreePath ? { ...rest, checkoutId: event.checkoutId, worktreePath: event.worktreePath } : rest;
				});
				return;
			case "checkouts.changed":
				this.#setCheckouts(node, event.checkouts, event.truncated);
				return;
			case "term.resized":
				update(event.terminalId, (info) => ({ ...info, cols: event.cols, rows: event.rows }));
				return;
			case "error":
				entry.error = `${event.code}: ${sanitize(event.message)}`;
				this.#emit();
				return;
			default:
				return;
		}
	}

	/** A new terminal goes first (newest first); the creator sees it twice, from its reply and from `term.created`. */
	#added(node: string, terminal: TerminalInfo): void {
		const entry = this.#entry(node);
		const info = cleanTerminal(terminal);
		const index = entry.terminals.findIndex((item) => item.terminalId === info.terminalId);
		entry.terminals = index < 0 ? [info, ...entry.terminals] : entry.terminals.map((item, i) => (i === index ? info : item));
		this.#emit();
	}

	#emit(): void {
		const online = new Map((this.#socket?.nodes ?? []).map((info) => [info.id, info]));
		// Pinned nodes the server no longer lists stay visible, offline, so their pins can be seen and removed.
		for (const [id, entry] of this.#entries) {
			if (!online.has(id) && entry.pin) online.set(id, { id, name: entry.pin.name, online: false });
		}
		this.#snapshot = {
			status: this.#status,
			...(this.#failure ? { failure: this.#failure } : {}),
			...(this.#identity ? { fingerprint: this.#identity.fingerprint } : {}),
			nodes: [...online.values()].map((info) => {
				const entry = this.#entry(info.id);
				return {
					info: { ...info, name: sanitize(info.name), ...(info.host ? { host: sanitize(info.host) } : {}) },
					...(entry.pin ? { pin: entry.pin } : {}),
					link: entry.link,
					terminals: entry.terminals,
					listed: entry.link.kind === "ready" && entry.listedBy !== undefined && entry.listedBy === entry.channel,
					...(entry.checkouts ? { checkouts: entry.checkouts, checkoutsTruncated: Boolean(entry.checkoutsTruncated) } : {}),
					...(entry.error ? { error: entry.error } : {}),
					epoch: entry.epoch,
				};
			}),
		};
		for (const listener of this.#listeners) listener();
	}
}

/** The node's order of checkouts: by name, case aside, then by path. */
export function compareCheckouts(a: Checkout, b: Checkout): number {
	const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
	return byName || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * The bridge's status while its socket is open. A closed bridge's last status stays for its session (NODE.md, "Pane
 * status"), but its activities and model died with that pi.
 */
export function liveBridge(status: PaneView | undefined): BridgeStatus | undefined {
	return status?.bridgeConnected ? status.bridge : undefined;
}

/** A pane's name: the user's name for it, else its pi session's name, else its terminal title, else its program, else "Shell". */
export function paneLabel(terminal: TerminalInfo): string {
	return terminal.label || sanitize(terminal.status?.bridge?.session?.name) || terminal.title || terminal.argv[0] || "Shell";
}

/** `path` with the node's home directory as `~`. */
export function homePath(path: string, home: string | undefined): string {
	if (!home || home === "/") return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export interface PaneSessionView {
	name?: string;
	cwd: string;
	model?: string;
	/** The bridge that reported this session has closed: the session is the last one it saw. */
	disconnected: boolean;
}

/**
 * Where the pane is now, for paths relative to it: pi's session cwd while its bridge is connected, else the shell's
 * directory from `term.cwd` (a `cd` changes it), else, from a daemon without `term.cwd`, where the terminal started.
 */
export async function paneCwd(request: NodeChannel["request"], terminal: TerminalInfo): Promise<string> {
	const started = paneSession(terminal).cwd;
	if (terminal.status?.bridgeConnected && terminal.status.bridge?.session) return started;
	if (terminal.exited) return started;
	try {
		const { cwd } = await request("term.cwd", { terminalId: terminal.terminalId });
		return cwd.startsWith("/") ? cwd : started;
	} catch {
		return started;
	}
}

/** What a pane's header shows of its pi session, cleaned for display; the terminal's cwd without a bridge. */
export function paneSession(terminal: TerminalInfo): PaneSessionView {
	const status = terminal.status;
	const session = status?.bridge?.session;
	const name = sanitize(session?.name);
	const model = sanitize(liveBridge(status)?.model);
	return {
		...(name ? { name } : {}),
		cwd: (session && sanitize(session.cwd)) || terminal.cwd,
		...(model ? { model } : {}),
		disconnected: Boolean(status?.bridge && !status.bridgeConnected && !terminal.exited),
	};
}
