import { NodeRequestError } from "./channel";
import type { GitRef, GitStatus, GitStatusEntry } from "./contract";
import { joinPath, type NodeFiles } from "./files";

/**
 * A work tree's changes (NODE.md §4 "Files", `git.status`): grouped the way `git status` reads, each opening the diff
 * that shows it, and kept current by polling while someone looks.
 */

/** What a diff tab compares: the index with `HEAD`, the working file with the index, or a new file with nothing. */
export type DiffMode = "staged" | "worktree" | "untracked";

export type ChangeGroup = "conflicts" | "staged" | "unstaged" | "untracked";

export const CHANGE_GROUPS: readonly (readonly [ChangeGroup, string])[] = [
	["conflicts", "Conflicts"],
	["staged", "Staged"],
	["unstaged", "Changes"],
	["untracked", "Untracked"],
];

export interface Change {
	group: ChangeGroup;
	/** Absolute, on the node. */
	path: string;
	/** Relative to the work tree's top level. */
	relative: string;
	/** A staged rename's or copy's source, absolute. */
	from?: string;
	/** The status letter shown: `M`, `A`, `D`, `R`, `C`, `T`, `U`, or `?`. */
	code: string;
	submodule: boolean;
}

/**
 * Sorts a status into groups. A path staged and then changed again is in both Staged and Changes; a conflicted path
 * is only in Conflicts, which opens the file rather than a diff.
 */
export function groupChanges(status: Pick<GitStatus, "top" | "entries">): Record<ChangeGroup, Change[]> {
	const groups: Record<ChangeGroup, Change[]> = { conflicts: [], staged: [], unstaged: [], untracked: [] };
	for (const entry of status.entries) {
		const base = { path: joinPath(status.top, entry.path), relative: entry.path, submodule: entry.submodule === true };
		if (entry.conflict) groups.conflicts.push({ ...base, group: "conflicts", code: "U" });
		else if (entry.x === "?") groups.untracked.push({ ...base, group: "untracked", code: "?" });
		else {
			if (entry.x !== ".") groups.staged.push({ ...base, group: "staged", code: entry.x, ...(entry.from ? { from: joinPath(status.top, entry.from) } : {}) });
			if (entry.y !== ".") groups.unstaged.push({ ...base, group: "unstaged", code: entry.y });
		}
	}
	return groups;
}

/** The diff a change opens; a conflict opens no diff. */
export function changeMode(change: Change): DiffMode | undefined {
	return change.group === "staged" ? "staged" : change.group === "unstaged" ? "worktree" : change.group === "untracked" ? "untracked" : undefined;
}

/** One side of a diff: a file's content at `HEAD`, in the index, on disk, or nothing. */
export type DiffSource = { ref: GitRef | "working"; path: string } | { ref: "none" };

export interface DiffSpec {
	original: DiffSource;
	modified: DiffSource;
	labels: readonly [string, string];
}

/**
 * Where each side of a diff comes from. Staged: `HEAD` (at a rename's source) against the index. Worktree: the index
 * against the file on disk. Untracked: nothing against the file, so every line reads as added.
 */
export function diffSpec(mode: DiffMode, path: string, from?: string): DiffSpec {
	if (mode === "staged") return { original: { ref: "HEAD", path: from ?? path }, modified: { ref: "index", path }, labels: ["HEAD", "Index"] };
	if (mode === "worktree") return { original: { ref: "index", path }, modified: { ref: "working", path }, labels: ["Index", "Working tree"] };
	return { original: { ref: "none" }, modified: { ref: "working", path }, labels: ["Nothing", "Working tree"] };
}

/** What changes when the same path's entry does: a rename, a status letter, or the staged content's object. */
const signature = (entry: GitStatusEntry): string => `${entry.x}${entry.y}\n${entry.from ?? ""}\n${entry.indexHash ?? ""}`;

export type ChangesSnapshot =
	| { status: "loading" }
	| { status: "ready"; top: string; branch?: string; groups: Record<ChangeGroup, Change[]>; count: number; truncated: boolean }
	/** `root` is in no work tree. */
	| { status: "not_repo" }
	/** The node's pika-node predates `git.status`. */
	| { status: "unsupported" }
	| { status: "failed"; error: string };

export const CHANGES_POLL_MS = 3_000;

export interface ChangesOptions {
	pollMs?: number;
	/** Absolute paths whose status entry changed between two polls (appeared, went, or differs): their diffs are stale. */
	onChanged?: (paths: string[]) => void;
}

/**
 * The status of the work tree holding `root` on one channel. While active it asks again `pollMs` after each answer, so
 * one slow `git status` never overlaps the next; `refresh` asks now.
 */
export class ChangesStore {
	readonly root: string;
	#files: NodeFiles;
	#pollMs: number;
	#onChanged?: (paths: string[]) => void;
	#snapshot: ChangesSnapshot = { status: "loading" };
	#listeners = new Set<() => void>();
	#signatures: Map<string, string> | undefined;
	#active = false;
	#inFlight: Promise<void> | undefined;
	#again = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(files: NodeFiles, root: string, options: ChangesOptions = {}) {
		this.#files = files;
		this.root = root;
		this.#pollMs = options.pollMs ?? CHANGES_POLL_MS;
		this.#onChanged = options.onChanged;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): ChangesSnapshot => this.#snapshot;

	/** Polls while true; turning it on asks at once. */
	setActive(active: boolean): void {
		if (active === this.#active || this.#disposed) return;
		this.#active = active;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (active) void this.refresh();
	}

	/** Asks for the status now; a call while one is in flight asks once more after it. */
	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#inFlight) {
			this.#again = true;
			return this.#inFlight;
		}
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#inFlight = this.#ask().finally(() => {
			this.#inFlight = undefined;
			if (this.#disposed) return;
			if (this.#again) {
				this.#again = false;
				void this.refresh();
			} else this.#schedule();
		});
		return this.#inFlight;
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#listeners.clear();
	}

	#schedule(): void {
		if (!this.#active || this.#snapshot.status === "unsupported") return;
		this.#timer = setTimeout(() => void this.refresh(), this.#pollMs);
	}

	async #ask(): Promise<void> {
		let status: GitStatus;
		try {
			status = await this.#files.request("git.status", { root: this.root });
		} catch (error) {
			if (this.#disposed) return;
			const code = error instanceof NodeRequestError ? error.code : undefined;
			this.#signatures = undefined;
			this.#set(
				code === "not_found"
					? { status: "not_repo" }
					: code === "unsupported"
						? { status: "unsupported" }
						: { status: "failed", error: error instanceof Error ? error.message : String(error) },
			);
			return;
		}
		if (this.#disposed) return;
		const signatures = new Map(status.entries.map((entry) => [joinPath(status.top, entry.path), signature(entry)]));
		const previous = this.#signatures;
		this.#signatures = signatures;
		if (previous) {
			const changed = [...new Set([...previous.keys(), ...signatures.keys()])].filter((path) => previous.get(path) !== signatures.get(path));
			if (changed.length) this.#onChanged?.(changed);
		}
		const groups = groupChanges(status);
		this.#set({
			status: "ready",
			top: status.top,
			...(status.branch ? { branch: status.branch } : {}),
			groups,
			count: status.entries.length,
			truncated: status.truncated,
		});
	}

	#set(snapshot: ChangesSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}
