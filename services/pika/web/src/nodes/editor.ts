import { NodeRequestError } from "./channel";
import type { Expected, NodeEvent, Stat } from "./contract";
import { baseName, decodeText, type NodeFiles } from "./files";

/**
 * How long after this window saves a file its watch's events are taken for the save's own echo. Orca uses about 3 s
 * for remote files. A change that lands inside the window is not lost: the file is read again when it ends.
 */
export const ECHO_WINDOW_MS = 3_000;

export type TabBody =
	| { kind: "loading" }
	/** `saved` is the content as last read or written, with its `stat`; `text` is the buffer. */
	| { kind: "text"; text: string; saved: string; stat: Stat }
	| { kind: "binary"; size: number }
	| { kind: "too_large" }
	| { kind: "missing" }
	| { kind: "failed"; message: string };

/** The file on the node no longer matches what this tab last read or wrote. */
export type DiskChange =
	/** A save was refused: the file changed since it was read. `stat` is absent when the file is gone. */
	| { kind: "conflict"; stat?: Stat; text?: string }
	/** The watch saw other content while the buffer had edits. */
	| { kind: "changed"; stat: Stat; text?: string }
	| { kind: "deleted" };

export interface Reveal {
	line: number;
	column: number;
	/** Changes with every request, so asking for the same place again reveals it again. */
	serial: number;
}

export interface FileTab {
	kind: "file";
	key: string;
	path: string;
	name: string;
	body: TabBody;
	saving: boolean;
	saveError?: string;
	disk?: DiskChange;
	/** Shows the disk's content beside the buffer (Monaco's diff editor). */
	compare: boolean;
	/** Whether the node watches the file for this tab. */
	watched: boolean;
	reveal?: Reveal;
}

export interface DiffTab {
	kind: "diff";
	key: string;
	path: string;
	name: string;
	staged: boolean;
	status: "loading" | "ready" | "failed";
	original: string;
	modified: string;
	labels: readonly [string, string];
	error?: string;
}

export type EditorTab = FileTab | DiffTab;

export interface EditorSnapshot {
	tabs: readonly EditorTab[];
	active?: string;
}

export type SaveResult = "saved" | "conflict" | "failed" | "skipped";

const fileKey = (path: string): string => `file:${path}`;
const diffKey = (path: string, staged: boolean): string => `diff:${staged ? "staged" : "worktree"}:${path}`;

export const isDirty = (tab: EditorTab): boolean => tab.kind === "file" && tab.body.kind === "text" && tab.body.text !== tab.body.saved;

const messageOf = (error: unknown): string =>
	error instanceof NodeRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);

interface Echo {
	/** Events count as echoes until then; `Infinity` while the write is in flight. */
	until: number;
	missed: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export interface EditorStoreOptions {
	echoWindowMs?: number;
	now?: () => number;
}

/**
 * One node's editor tabs: remote files read with `fs.read`, saved with `fs.write` only if unchanged since (their
 * `mtimeMs` and `size`), and watched with `fs.watch`. A refused save, or a change seen while the buffer has edits, is
 * kept as `disk` for the user to reload, overwrite, or compare. Diff tabs show a file against the index or `HEAD`.
 */
export class EditorStore {
	#files: NodeFiles | undefined;
	#tabs: EditorTab[] = [];
	#active: string | undefined;
	#watches = new Map<string, () => void>();
	#echo = new Map<string, Echo>();
	#serial = 0;
	#listeners = new Set<() => void>();
	#snapshot: EditorSnapshot = { tabs: [] };
	#echoWindowMs: number;
	#now: () => number;

	constructor(options: EditorStoreOptions = {}) {
		this.#echoWindowMs = options.echoWindowMs ?? ECHO_WINDOW_MS;
		this.#now = options.now ?? Date.now;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): EditorSnapshot => this.#snapshot;

	get files(): NodeFiles | undefined {
		return this.#files;
	}

	tab(key: string): EditorTab | undefined {
		return this.#tabs.find((tab) => tab.key === key);
	}

	/**
	 * The channel's file layer, or undefined while disconnected. A new channel watches every open file again and reads
	 * it, so a change made while the page was away shows up like any other.
	 */
	setFiles(files: NodeFiles | undefined): void {
		if (files === this.#files) return;
		for (const stop of this.#watches.values()) stop();
		this.#watches.clear();
		this.#files = files;
		this.#tabs = this.#tabs.map((tab) => (tab.kind === "file" ? { ...tab, watched: false } : tab));
		this.#emit();
		if (!files) return;
		for (const tab of this.#tabs) {
			if (tab.kind !== "file") continue;
			if (tab.body.kind === "text") {
				this.#watch(tab.path);
				void this.#verify(tab.path);
			} else if (tab.body.kind === "loading" || tab.body.kind === "failed") void this.#load(tab.path);
		}
	}

	/** Opens `path` in a tab, or shows its tab, and reveals `at` when given. */
	async open(path: string, at?: { line?: number; column?: number }): Promise<void> {
		const key = fileKey(path);
		const reveal = at?.line ? { line: at.line, column: at.column ?? 1, serial: ++this.#serial } : undefined;
		const existing = this.tab(key);
		this.#active = key;
		if (existing) {
			if (reveal) this.#replace(key, { reveal });
			else this.#emit();
			return;
		}
		this.#tabs = [...this.#tabs, { kind: "file", key, path, name: baseName(path), body: { kind: "loading" }, saving: false, compare: false, watched: false, ...(reveal ? { reveal } : {}) }];
		this.#emit();
		await this.#load(path);
	}

	/** Opens a diff of `path`: the index against the working file, or `HEAD` against the index when `staged`. */
	async openDiff(path: string, staged: boolean): Promise<void> {
		const key = diffKey(path, staged);
		this.#active = key;
		if (!this.tab(key)) {
			const labels = staged ? (["HEAD", "Index"] as const) : (["Index", "Working tree"] as const);
			this.#tabs = [...this.#tabs, { kind: "diff", key, path, name: baseName(path), staged, status: "loading", original: "", modified: "", labels }];
		}
		this.#emit();
		await this.refreshDiff(key);
	}

	async refreshDiff(key: string): Promise<void> {
		const tab = this.tab(key);
		const files = this.#files;
		if (tab?.kind !== "diff") return;
		if (!files) return this.#replace(key, { status: "failed", error: "The node is not connected." });
		this.#replace(key, { status: "loading", error: undefined });
		try {
			const [original, modified] = await Promise.all(
				tab.staged
					? [files.gitText(tab.path, "HEAD"), files.gitText(tab.path, "index")]
					: [files.gitText(tab.path, "index"), this.#readText(files, tab.path)],
			);
			this.#replace(key, { status: "ready", original, modified });
		} catch (error) {
			this.#replace(key, {
				status: "failed",
				error: error instanceof NodeRequestError && error.code === "unsupported" ? "This pika-node has no fs.gitShow; update it to see diffs." : messageOf(error),
			});
		}
	}

	activate(key: string): void {
		if (!this.tab(key)) return;
		this.#active = key;
		this.#emit();
	}

	close(key: string): void {
		const index = this.#tabs.findIndex((tab) => tab.key === key);
		if (index < 0) return;
		const tab = this.#tabs[index]!;
		this.#tabs = this.#tabs.filter((item) => item.key !== key);
		if (tab.kind === "file") this.#unwatch(tab.path);
		if (this.#active === key) this.#active = (this.#tabs[index] ?? this.#tabs[index - 1])?.key;
		this.#emit();
	}

	/** The buffer's content after an edit. */
	edit(key: string, text: string): void {
		const tab = this.tab(key);
		if (tab?.kind !== "file" || tab.body.kind !== "text" || tab.body.text === text) return;
		this.#replace(key, { body: { ...tab.body, text }, saveError: undefined });
	}

	/** Writes the buffer if the file is still as last read or written. */
	async save(key: string): Promise<SaveResult> {
		const tab = this.tab(key);
		if (tab?.kind !== "file" || tab.body.kind !== "text" || tab.saving) return "skipped";
		const expected: Expected = tab.disk?.kind === "deleted" ? { absent: true } : { mtimeMs: tab.body.stat.mtimeMs, size: tab.body.stat.size };
		return this.#write(tab, expected);
	}

	/** Writes the buffer over whatever the file now is. */
	async overwrite(key: string): Promise<SaveResult> {
		const tab = this.tab(key);
		if (tab?.kind !== "file" || tab.body.kind !== "text" || tab.saving) return "skipped";
		const stat = tab.disk && tab.disk.kind !== "deleted" ? tab.disk.stat : undefined;
		return this.#write(tab, stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : tab.disk ? { absent: true } : { mtimeMs: tab.body.stat.mtimeMs, size: tab.body.stat.size });
	}

	/** Drops the buffer's edits and reads the file again. */
	async reload(key: string): Promise<void> {
		const tab = this.tab(key);
		if (tab?.kind !== "file") return;
		this.#replace(key, { disk: undefined, compare: false, saveError: undefined });
		await this.#load(tab.path, true);
	}

	/** Shows or hides the disk's content beside the buffer; reads it when the tab does not have it yet. */
	async compare(key: string, on: boolean): Promise<void> {
		const tab = this.tab(key);
		if (tab?.kind !== "file") return;
		this.#replace(key, { compare: on });
		const disk = tab.disk;
		const files = this.#files;
		if (!on || !files || !disk || disk.kind === "deleted" || disk.text !== undefined) return;
		try {
			const read = await files.read(tab.path);
			this.#replaceDisk(key, { ...disk, stat: read.stat, text: decodeText(read.encoding, read.data) });
		} catch (error) {
			if (error instanceof NodeRequestError && error.code === "not_found") this.#replaceDisk(key, { kind: "deleted" });
			else this.#replace(key, { saveError: messageOf(error) });
		}
	}

	dispose(): void {
		for (const stop of this.#watches.values()) stop();
		this.#watches.clear();
		for (const echo of this.#echo.values()) clearTimeout(echo.timer);
		this.#echo.clear();
		this.#listeners.clear();
	}

	// ---------------------------------------------------------------------------------------------------------------

	async #readText(files: NodeFiles, path: string): Promise<string> {
		try {
			const read = await files.read(path);
			return decodeText(read.encoding, read.data);
		} catch (error) {
			if (error instanceof NodeRequestError && error.code === "not_found") return "";
			throw error;
		}
	}

	async #load(path: string, force = false): Promise<void> {
		const key = fileKey(path);
		const files = this.#files;
		if (!files) {
			if (this.tab(key)) this.#replace(key, { body: { kind: "failed", message: "The node is not connected." } });
			return;
		}
		let body: TabBody;
		try {
			const read = await files.read(path);
			body =
				read.encoding === "utf8"
					? { kind: "text", text: read.data, saved: read.data, stat: read.stat }
					: { kind: "binary", size: read.stat.size };
		} catch (error) {
			const code = error instanceof NodeRequestError ? error.code : undefined;
			body = code === "too_large" ? { kind: "too_large" } : code === "not_found" ? { kind: "missing" } : { kind: "failed", message: messageOf(error) };
		}
		const tab = this.tab(key);
		if (tab?.kind !== "file" || files !== this.#files) return;
		// A reload discards the buffer; a first load never has one.
		if (!force && tab.body.kind === "text") return;
		this.#replace(key, { body });
		if (body.kind === "text") this.#watch(path);
	}

	async #write(tab: FileTab, expected: Expected): Promise<SaveResult> {
		const files = this.#files;
		if (tab.body.kind !== "text") return "skipped";
		if (!files) {
			this.#replace(tab.key, { saveError: "The node is not connected." });
			return "failed";
		}
		const text = tab.body.text;
		this.#replace(tab.key, { saving: true, saveError: undefined });
		this.#startEcho(tab.path);
		try {
			const { stat } = await files.request("fs.write", { path: tab.path, encoding: "utf8", data: text, expected });
			const current = this.tab(tab.key);
			this.#endEcho(tab.path);
			if (current?.kind !== "file" || current.body.kind !== "text") return "saved";
			this.#replace(tab.key, { saving: false, disk: undefined, compare: false, body: { ...current.body, saved: text, stat } });
			if (!this.#watches.has(tab.path)) this.#watch(tab.path);
			return "saved";
		} catch (error) {
			this.#echo.delete(tab.path);
			if (error instanceof NodeRequestError && error.code === "conflict") {
				this.#replace(tab.key, { saving: false, disk: error.current ? { kind: "conflict", stat: error.current } : { kind: "conflict" } });
				return "conflict";
			}
			this.#replace(tab.key, { saving: false, saveError: messageOf(error) });
			return "failed";
		}
	}

	/** Every event from here until the write's reply plus the window is the write's own. */
	#startEcho(path: string): void {
		const old = this.#echo.get(path);
		clearTimeout(old?.timer);
		this.#echo.set(path, { until: Infinity, missed: old?.missed ?? false });
	}

	#endEcho(path: string): void {
		const echo = this.#echo.get(path);
		if (!echo) return;
		echo.until = this.#now() + this.#echoWindowMs;
		echo.timer = setTimeout(() => {
			if (this.#echo.get(path) !== echo) return;
			this.#echo.delete(path);
			// Something changed during the window: the save's echo, or a real change hidden behind it. A read tells.
			if (echo.missed) void this.#verify(path);
		}, this.#echoWindowMs);
	}

	#watch(path: string): void {
		const files = this.#files;
		if (!files || this.#watches.has(path)) return;
		const watch = files.watch(path, (kind) => this.#changed(path, kind));
		this.#watches.set(path, watch.stop);
		void watch.ready.then((ok) => {
			if (this.#files !== files) return;
			if (!ok) this.#watches.delete(path);
			const tab = this.tab(fileKey(path));
			if (tab?.kind === "file") this.#replace(tab.key, { watched: ok });
		});
	}

	#unwatch(path: string): void {
		this.#watches.get(path)?.();
		this.#watches.delete(path);
		clearTimeout(this.#echo.get(path)?.timer);
		this.#echo.delete(path);
	}

	#changed(path: string, kind: "change" | "rename" | "gone"): void {
		if (kind === "gone") {
			this.#watches.delete(path);
			const tab = this.tab(fileKey(path));
			if (tab?.kind === "file") this.#replace(tab.key, { watched: false });
		}
		const echo = this.#echo.get(path);
		if (echo && this.#now() < echo.until) {
			echo.missed = true;
			return;
		}
		void this.#verify(path);
	}

	/** Reads the file and compares it with the tab: the same content adopts the new stat, other content reloads a clean buffer and is kept as `disk` for one with edits. */
	async #verify(path: string): Promise<void> {
		const key = fileKey(path);
		const files = this.#files;
		if (!files) return;
		let read;
		try {
			read = await files.read(path);
		} catch (error) {
			const tab = this.tab(key);
			if (tab?.kind !== "file" || tab.body.kind !== "text") return;
			if (error instanceof NodeRequestError && error.code === "not_found") this.#replace(key, { disk: { kind: "deleted" }, watched: false });
			return;
		}
		const tab = this.tab(key);
		if (tab?.kind !== "file" || tab.body.kind !== "text" || files !== this.#files || tab.saving) return;
		if (read.stat.hash === tab.body.stat.hash) {
			this.#replace(key, { body: { ...tab.body, stat: read.stat }, ...(tab.disk?.kind === "changed" || tab.disk?.kind === "deleted" ? { disk: undefined } : {}) });
			if (!this.#watches.has(path)) this.#watch(path);
			return;
		}
		const text = read.encoding === "utf8" ? read.data : undefined;
		if (!isDirty(tab) && text !== undefined) {
			this.#replace(key, { body: { kind: "text", text, saved: text, stat: read.stat }, disk: undefined, compare: false });
		} else {
			// A refused save stays a conflict: the banner keeps saying the save was not written.
			const kind = tab.disk?.kind === "conflict" ? "conflict" : "changed";
			this.#replace(key, { disk: { kind, stat: read.stat, ...(text !== undefined ? { text } : {}) } });
		}
		if (!this.#watches.has(path)) this.#watch(path);
	}

	#replaceDisk(key: string, disk: DiskChange): void {
		this.#replace(key, { disk });
	}

	#replace(key: string, change: Partial<FileTab> | Partial<DiffTab>): void {
		let found = false;
		this.#tabs = this.#tabs.map((tab) => {
			if (tab.key !== key) return tab;
			found = true;
			const next = { ...tab, ...change } as EditorTab;
			for (const [name, value] of Object.entries(change)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[name];
			return next;
		});
		if (found) this.#emit();
	}

	#emit(): void {
		this.#snapshot = { tabs: this.#tabs, ...(this.#active ? { active: this.#active } : {}) };
		for (const listener of this.#listeners) listener();
	}
}

/** The bridge asked to open a file or a diff (NODE.md, "Requests from the bridge"): the tab it names, shown. */
export function paneRequest(store: EditorStore, event: NodeEvent): Promise<void> | undefined {
	if (event.type === "pane.open") return store.open(event.path, { ...(event.line ? { line: event.line } : {}), ...(event.column ? { column: event.column } : {}) });
	if (event.type === "pane.diff") return store.openDiff(event.path, event.staged);
	return undefined;
}
