import {
	activate,
	addTab,
	allTerminals,
	closeTab,
	createWorkspace,
	focusPane,
	pruneTerminals,
	removeTerminal,
	restoreWorkspace,
	splitTab,
	storeWorkspace,
	tabOfTerminal,
	terminalTab,
	type DiffTab,
	type FileTab,
	type Workspace,
} from "./model";
import { placeOpen } from "./placement";

/** The place of a node's terminals that are in none of its listed worktrees (the rail's "Other" card). */
export const OTHER = "other:";

export const WORKSPACE_KEY_PREFIX = "pika.nodes.workspace.";
/** Version 2 keys workspaces by place (`places.ts`); version 1 layouts, by project path, are dropped. */
export const WORKSPACE_VERSION = 2;

/** Something on screen to take focus once it shows: a tab, and in a terminal tab, one pane. */
export interface FocusRequest {
	serial: number;
	place: string;
	tabId: string;
	terminalId?: string;
}

export interface WorkspacesSnapshot {
	/** Each place's workspace, by place (`placeKey`: checkout id and worktree path; or `OTHER`). */
	layouts: ReadonlyMap<string, Workspace>;
	/** The place on screen. */
	active?: string;
	focus?: FocusRequest;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Storage | undefined => {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
};

export interface OpenOptions {
	/** The group it is opened from (the terminal's group, for a link or the bridge); the active group by default. */
	sourceGroupId?: string;
	/** Focus the editor once it shows; otherwise focus stays where it is. */
	focus?: boolean;
}

/**
 * One node's workspaces, one per place (a worktree of a checkout, or "Other"), kept in `localStorage` per node. It
 * also remembers which of the node's terminals it has placed, so a terminal whose tab was closed is not given a new
 * one: only terminals new to this browser get a tab of their own.
 */
export class NodeWorkspaces {
	readonly node: string;
	#layouts = new Map<string, Workspace>();
	#active: string | undefined;
	#known = new Set<string>();
	#focus: FocusRequest | undefined;
	#serial = 0;
	#pending = 0;
	/** Whether the node has listed its terminals since this store was made (restored layouts are pruned then). */
	#listed = false;
	/** File tabs read back from storage that have not opened yet: one that fails to is dropped. */
	#restored = new Set<string>();
	#listeners = new Set<() => void>();
	#snapshot: WorkspacesSnapshot;
	#storage: Storage | undefined;

	constructor(node: string, options: { storage?: Storage } = {}) {
		this.node = node;
		this.#storage = "storage" in options ? options.storage : storage();
		this.#load();
		this.#snapshot = this.#make();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): WorkspacesSnapshot => this.#snapshot;

	get key(): string {
		return `${WORKSPACE_KEY_PREFIX}${this.node}`;
	}

	/** A place's workspace, new and empty the first time. */
	layout(place: string): Workspace {
		return this.#layouts.get(place) ?? createWorkspace();
	}

	get active(): string | undefined {
		return this.#active;
	}

	setActive(place: string): void {
		if (this.#active === place) return;
		this.#active = place;
		this.#commit();
	}

	/** Changes a place's workspace; `focus` asks for a tab (and pane) to take focus once it shows. */
	update(place: string, change: (ws: Workspace) => Workspace, focus?: { tabId: string; terminalId?: string }): void {
		const before = this.layout(place);
		const after = change(before);
		if (after === before && !focus) return;
		this.#layouts.set(place, after);
		if (focus) this.#focus = { serial: ++this.#serial, place, ...focus };
		this.#commit();
	}

	/** Asks for focus on a tab that is already there. */
	requestFocus(place: string, tabId: string, terminalId?: string): void {
		this.#focus = { serial: ++this.#serial, place, tabId, ...(terminalId ? { terminalId } : {}) };
		this.#emit();
	}

	/** While a terminal this window asked for is being created, its arrival does not give it a tab of its own. */
	holdNewTerminals(): () => void {
		this.#pending++;
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.#pending--;
		};
	}

	/** A terminal this window placed itself (a pane it split, or a new terminal it put in a tab). */
	know(terminalId: string): void {
		this.#known.add(terminalId);
	}

	/**
	 * The node's terminals now, each with its place. Once the node has listed them (`listed`), terminals that are
	 * gone leave every workspace (on the first listing, exited ones too, but for those that `keepExited`, a setup
	 * script's: a restored layout keeps live panes only); terminals new to this browser get a tab in their place's
	 * active group, shown only where the group had nothing.
	 */
	reconcile(terminals: readonly { terminalId: string; place: string; exited?: boolean; keepExited?: boolean }[], listed: boolean): void {
		if (!listed) return;
		const first = !this.#listed;
		this.#listed = true;
		const live = new Set(terminals.filter((item) => !(first && item.exited && !item.keepExited)).map((item) => item.terminalId));
		let changed = false;
		for (const [place, ws] of this.#layouts) {
			const pruned = pruneTerminals(ws, (id) => live.has(id));
			if (pruned !== ws) {
				this.#layouts.set(place, pruned);
				changed = true;
			}
		}
		for (const id of [...this.#known]) {
			if (live.has(id)) continue;
			this.#known.delete(id);
			changed = true;
		}
		for (const id of [...this.#layouts.values()].flatMap(allTerminals)) {
			if (this.#known.has(id)) continue;
			this.#known.add(id);
			changed = true;
		}
		if (this.#pending === 0) {
			// Oldest first, so the newest ends up after the others.
			for (const { terminalId, place, exited } of [...terminals].reverse()) {
				if (this.#known.has(terminalId) || exited) continue;
				this.#known.add(terminalId);
				this.#layouts.set(place, addTab(this.layout(place), terminalTab(terminalId), { activate: false }));
				changed = true;
			}
		}
		if (changed) this.#commit();
	}

	/** The place whose workspace shows `terminalId`, if any. */
	placeOf(terminalId: string): string | undefined {
		for (const [place, ws] of this.#layouts) if (tabOfTerminal(ws, terminalId)) return place;
		return undefined;
	}

	/**
	 * Shows `terminalId` in `place`'s workspace: its tab activated and its pane focused, or, when no tab there has
	 * it, a new tab in the active group (taking it out of another place's workspace, as a terminal shows once).
	 */
	reveal(place: string, terminalId: string, { focus = true }: { focus?: boolean } = {}): void {
		this.#known.add(terminalId);
		const elsewhere = this.placeOf(terminalId);
		if (elsewhere && elsewhere !== place) this.#layouts.set(elsewhere, removeTerminal(this.#layouts.get(elsewhere)!, terminalId));
		let tabId = "";
		this.update(place, (ws) => {
			const existing = tabOfTerminal(ws, terminalId);
			if (existing) {
				tabId = existing.id;
				return focusPane(ws, terminalId);
			}
			const tab = terminalTab(terminalId);
			tabId = tab.id;
			return addTab(ws, tab);
		});
		this.#active = place;
		if (focus) this.#focus = { serial: ++this.#serial, place, tabId, terminalId };
		this.#commit();
	}

	/**
	 * Opens a file or diff tab by the placement rule (`placeOpen`) from `sourceGroupId`. A preview tab replaces the
	 * group's preview. Focus goes to it only when `focus` asks.
	 */
	openEditor(place: string, tab: FileTab | DiffTab, options: OpenOptions = {}): string {
		let groupId = "";
		this.update(place, (ws) => {
			const placement = placeOpen(ws, options.sourceGroupId ?? ws.activeGroupId, tab.id);
			const before = ws.activeGroupId;
			let next: Workspace;
			if ("groupId" in placement) next = addTab(ws, tab, { groupId: placement.groupId });
			else {
				// A new group to the right, then the tab into it; focus stays with the source unless asked.
				const added = addTab(ws, tab, { groupId: placement.splitRightOf });
				next = splitTab(added, tab.id, placement.splitRightOf, "right");
				// Its old group shows what it showed.
				const source = ws.groups[placement.splitRightOf]!;
				if (source.activeTabId) next = activate(next, source.activeTabId);
			}
			groupId = Object.values(next.groups).find((group) => group.tabOrder.includes(tab.id))!.id;
			next = activate(next, tab.id);
			return options.focus ? next : { ...next, activeGroupId: ws.groups[before] && next.groups[before] ? before : next.activeGroupId };
		});
		if (options.focus) this.requestFocus(place, tab.id);
		return groupId;
	}

	/** Marks file tabs read back from storage; `opened` and `failedToOpen` settle them. */
	restoredFiles(): ReadonlySet<string> {
		return this.#restored;
	}

	opened(tabId: string): void {
		this.#restored.delete(tabId);
	}

	/** A restored file that could not be opened: its tabs go, unremembered. */
	failedToOpen(tabId: string): void {
		if (!this.#restored.delete(tabId)) return;
		for (const [place, ws] of this.#layouts) {
			if (ws.tabs[tabId]) this.#layouts.set(place, closeTab(ws, tabId, { forget: true }));
		}
		this.#commit();
	}

	/** Every editor store key a workspace on this node shows. */
	editorKeys(): Set<string> {
		const keys = new Set<string>();
		for (const ws of this.#layouts.values()) for (const tab of Object.values(ws.tabs)) if (tab.kind !== "terminal") keys.add(tab.id);
		return keys;
	}

	// ---------------------------------------------------------------------------------------------------------------

	#load(): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.#storage?.getItem(this.key) ?? "null");
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const stored = parsed as Record<string, unknown>;
		// Another version's layout is not read: the page starts afresh.
		if (stored.version !== WORKSPACE_VERSION) return;
		if (stored.layouts && typeof stored.layouts === "object") {
			for (const [place, value] of Object.entries(stored.layouts as Record<string, unknown>)) {
				const ws = restoreWorkspace(value);
				if (!ws) continue;
				this.#layouts.set(place, ws);
				for (const tab of Object.values(ws.tabs)) if (tab.kind === "file") this.#restored.add(tab.id);
			}
		}
		if (Array.isArray(stored.known)) for (const id of stored.known) if (typeof id === "string") this.#known.add(id);
		if (typeof stored.active === "string") this.#active = stored.active;
	}

	#save(): void {
		const layouts: Record<string, unknown> = {};
		for (const [place, ws] of this.#layouts) layouts[place] = storeWorkspace(ws);
		try {
			this.#storage?.setItem(this.key, JSON.stringify({ version: WORKSPACE_VERSION, ...(this.#active ? { active: this.#active } : {}), known: [...this.#known], layouts }));
		} catch {
			// Private browsing or a full quota: the layout lasts for this page only.
		}
	}

	#make(): WorkspacesSnapshot {
		return { layouts: new Map(this.#layouts), ...(this.#active ? { active: this.#active } : {}), ...(this.#focus ? { focus: this.#focus } : {}) };
	}

	#commit(): void {
		this.#save();
		this.#emit();
	}

	#emit(): void {
		this.#snapshot = this.#make();
		for (const listener of this.#listeners) listener();
	}
}

/** Every node's workspaces, made on first use, with one subscription for them all. */
export class WorkspaceHub {
	#stores = new Map<string, NodeWorkspaces>();
	#version = 0;
	#listeners = new Set<() => void>();
	#storage: Storage | undefined;

	constructor(options: { storage?: Storage } = {}) {
		this.#storage = "storage" in options ? options.storage : storage();
	}

	get(node: string): NodeWorkspaces {
		let store = this.#stores.get(node);
		if (!store) {
			store = new NodeWorkspaces(node, { storage: this.#storage });
			store.subscribe(() => {
				this.#version++;
				for (const listener of [...this.#listeners]) listener();
			});
			this.#stores.set(node, store);
		}
		return store;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Changes with every change to any node's workspaces. */
	getVersion = (): number => this.#version;
}
