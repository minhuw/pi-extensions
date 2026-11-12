import { NodeRequestError } from "./channel";
import type { DirEntry } from "./contract";
import { within, type NodeFiles } from "./files";

export interface DirView {
	status: "loading" | "ready" | "failed";
	entries: DirEntry[];
	/** The node listed only the first `maxReadDirEntries` names. */
	truncated: boolean;
	error?: string;
	/** False when the node refused a watch for it: it shows the listing as it was. */
	watched: boolean;
}

export interface TreeSnapshot {
	root: string;
	expanded: ReadonlySet<string>;
	dirs: ReadonlyMap<string, DirView>;
}

/** Watches for directory listings never take more than these of a channel's 64, leaving the rest to open files. */
export const TREE_WATCH_BUDGET = 40;

/**
 * The file tree under one root on one channel: directories load when expanded (`fs.readDir`), refresh on their
 * watch's `fs.changed`, and forget their listing when collapsed.
 */
export class FileTree {
	readonly files: NodeFiles;
	readonly root: string;
	#expanded = new Set<string>();
	#dirs = new Map<string, DirView>();
	#watches = new Map<string, () => void>();
	#loads = new Map<string, number>();
	#listeners = new Set<() => void>();
	#snapshot: TreeSnapshot;
	#disposed = false;

	constructor(files: NodeFiles, root: string, expanded: Iterable<string> = []) {
		this.files = files;
		this.root = root;
		this.#snapshot = { root, expanded: new Set(), dirs: new Map() };
		this.expand(root);
		for (const dir of expanded) if (dir !== root && within(dir, root)) this.expand(dir);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): TreeSnapshot => this.#snapshot;

	toggle(dir: string): void {
		if (this.#expanded.has(dir)) this.collapse(dir);
		else this.expand(dir);
	}

	expand(dir: string): void {
		if (this.#disposed || this.#expanded.has(dir)) return;
		this.#expanded.add(dir);
		this.#dirs.set(dir, { status: "loading", entries: [], truncated: false, watched: false });
		this.#emit();
		if (this.#watches.size < TREE_WATCH_BUDGET) {
			const watch = this.files.watch(dir, (kind) => {
				if (kind === "gone") this.#watches.delete(dir);
				void this.refresh(dir);
			});
			this.#watches.set(dir, watch.stop);
			void watch.ready.then((ok) => this.#update(dir, { watched: ok }));
		}
		void this.refresh(dir);
	}

	/** Collapses `dir` and everything open below it. */
	collapse(dir: string): void {
		for (const open of [...this.#expanded]) {
			if (!within(open, dir)) continue;
			this.#expanded.delete(open);
			this.#dirs.delete(open);
			this.#watches.get(open)?.();
			this.#watches.delete(open);
		}
		this.#emit();
	}

	/** Lists `dir` again; a slower, older listing never replaces a newer one. */
	async refresh(dir: string): Promise<void> {
		if (!this.#expanded.has(dir)) return;
		const load = (this.#loads.get(dir) ?? 0) + 1;
		this.#loads.set(dir, load);
		try {
			const { entries, truncated } = await this.files.readDir(dir);
			if (this.#loads.get(dir) !== load) return;
			// Names stay as the node sent them, so paths built from them name the real files; views sanitize them.
			this.#update(dir, { status: "ready", entries, truncated, error: undefined });
		} catch (error) {
			if (this.#loads.get(dir) !== load) return;
			const message = error instanceof NodeRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
			this.#update(dir, { status: "failed", error: message });
		}
	}

	dispose(): void {
		this.#disposed = true;
		for (const stop of this.#watches.values()) stop();
		this.#watches.clear();
		this.#listeners.clear();
	}

	#update(dir: string, change: Partial<DirView>): void {
		const current = this.#dirs.get(dir);
		if (!current || this.#disposed) return;
		this.#dirs.set(dir, { ...current, ...change });
		this.#emit();
	}

	#emit(): void {
		this.#snapshot = { root: this.root, expanded: new Set(this.#expanded), dirs: new Map(this.#dirs) };
		for (const listener of this.#listeners) listener();
	}
}

/** Directory entries in display order: directories first, then by name; dotfiles only when `hidden`. */
export function visibleEntries(entries: readonly DirEntry[], hidden: boolean): DirEntry[] {
	return entries
		.filter((entry) => hidden || !entry.name.startsWith("."))
		.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
}


/**
 * The tree's root for a pane: the innermost project holding its cwd (its pi session's, else the terminal's), else
 * the cwd itself; without a pane, the first project, else the node's home.
 */
export function rootFor(projects: readonly { path: string }[], cwd: string | undefined, home: string): string {
	if (!cwd) return projects[0]?.path ?? home;
	let best: string | undefined;
	for (const project of projects) if (within(cwd, project.path) && (!best || project.path.length > best.length)) best = project.path;
	return best ?? cwd;
}
