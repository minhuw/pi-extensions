import type { DirEntry } from "./contract";
import { baseName, dirName } from "./files";

/** A path written in terminal output, with the line and column after it (`a.ts:12:5`, as `grep -n` and compilers print). */
export interface PathMatch {
	/** String indices of the link in the line: `[start, end)`, the `:line:col` included. */
	start: number;
	end: number;
	/** The path as written. */
	path: string;
	line?: number;
	column?: number;
}

/** Runs that may hold a path: no whitespace, quotes, or brackets. */
const TOKEN = /[^\s"'`<>()[\]{}|]+/g;
/** `path:line[:col]`, then anything after another colon (grep's matched text). The path has no colon of its own. */
const LOCATION = /^([^:]+):(\d+)(?::(\d+))?(?=:|$)/;
/** Punctuation that ends a sentence, or `ls -F`'s type marks, rather than a path. */
const TRAILING = /[.,;:!?*@]+$/;
const MAX_PATH = 4_096;

/** Paths in one line of terminal output, at most `limit` of them. Whether they exist is for `PathChecker` to say. */
export function findPaths(line: string, limit = 32): PathMatch[] {
	const found: PathMatch[] = [];
	for (const token of line.matchAll(TOKEN)) {
		if (found.length >= limit) break;
		const text = token[0];
		const start = token.index;
		// URLs are xterm's to link (or nobody's); flags are not paths.
		if (text.includes("://") || text.startsWith("-") || text.length > MAX_PATH) continue;
		const located = LOCATION.exec(text);
		if (located) {
			const path = located[1]!;
			if (!plausible(path)) continue;
			const line = Number(located[2]);
			const column = located[3] === undefined ? undefined : Number(located[3]);
			if (line < 1) continue;
			found.push({ start, end: start + located[0].length, path, line, ...(column ? { column } : {}) });
			continue;
		}
		const path = /^\.+$/.test(text) ? text : text.replace(TRAILING, "");
		if (!plausible(path) || path.includes(":")) continue;
		found.push({ start, end: start + path.length, path });
	}
	return found;
}

/** A word that names something: a letter or digit in it, or `~`. */
const plausible = (path: string): boolean => path.length > 0 && (/[\p{L}\p{N}]/u.test(path) || path === "~");

/**
 * An absolute, normalized path for `path` as written in a pane whose working directory is `cwd`: `~` is the node's
 * home, and `.` and `..` segments are resolved. Undefined for `~user` forms, which name another user's home.
 */
export function resolvePath(path: string, cwd: string, home: string): string | undefined {
	let full: string;
	if (path === "~" || path.startsWith("~/")) full = home + path.slice(1);
	else if (path.startsWith("~")) return undefined;
	else if (path.startsWith("/")) full = path;
	else full = `${cwd}/${path}`;
	const parts: string[] = [];
	for (const part of full.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/**
 * Whether paths exist, from listings of their directories (`fs.readDir`, one per directory however many paths in it
 * are asked about), kept for `ttlMs` so a line hovered twice costs one request.
 */
export class PathChecker {
	#readDir: (dir: string) => Promise<readonly DirEntry[]>;
	#ttlMs: number;
	#now: () => number;
	#dirs = new Map<string, { at: number; entries: Promise<ReadonlyMap<string, DirEntry["kind"]> | undefined> }>();

	constructor(readDir: (dir: string) => Promise<readonly DirEntry[]>, options: { ttlMs?: number; now?: () => number } = {}) {
		this.#readDir = readDir;
		this.#ttlMs = options.ttlMs ?? 5_000;
		this.#now = options.now ?? Date.now;
	}

	/** The entry's kind, or undefined when its directory has no such name or cannot be listed. */
	async kind(path: string): Promise<DirEntry["kind"] | undefined> {
		if (path === "/") return "dir";
		const dir = dirName(path);
		const now = this.#now();
		let cached = this.#dirs.get(dir);
		if (!cached || now - cached.at > this.#ttlMs) {
			cached = {
				at: now,
				entries: this.#readDir(dir).then(
					(entries) => new Map(entries.map((entry) => [entry.name, entry.kind])),
					() => undefined,
				),
			};
			this.#dirs.set(dir, cached);
			// An old listing for every hovered directory is not worth keeping.
			if (this.#dirs.size > 64) this.#dirs.delete(this.#dirs.keys().next().value!);
		}
		return (await cached.entries)?.get(baseName(path));
	}
}

/** One terminal line's text, and for each UTF-16 index the buffer cell (0-based) it sits in and that cell's width. */
export interface CellText {
	text: string;
	cells: number[];
	widths: number[];
}

/** The 1-based, inclusive buffer columns of `[start, end)` in a line read as `CellText`. */
export function cellRange(line: CellText, start: number, end: number): { first: number; last: number } {
	const last = end - 1;
	return { first: line.cells[start]! + 1, last: line.cells[last]! + line.widths[last]! };
}
