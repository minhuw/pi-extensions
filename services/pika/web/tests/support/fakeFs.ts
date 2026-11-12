import { createHash } from "node:crypto";
import type { ClientMessage, DirEntry, Expected, GitStatus, NodeMessage, Stat } from "../../src/nodes/contract";
import type { FakeNode } from "./fakeNode";

interface FakeFile {
	data: string;
	mtimeMs: number;
	binary?: boolean;
}

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

/**
 * The daemon's files (NODE.md §4 "Files") in memory, answering a fake node's `fs.*` and `git.status`: a flat map
 * of paths, directories implied by them, watches that report changes, `fs.gitShow` from `head` and `index`, and
 * `git.status` from `status`.
 */
export class FakeFs {
	readonly files = new Map<string, FakeFile>();
	readonly dirs = new Set<string>(["/"]);
	readonly head = new Map<string, string>();
	readonly index = new Map<string, string>();
	/** `HEAD:<path>` or `index:<path>` that `fs.gitShow` answers as binary. */
	readonly binaryRefs = new Set<string>();
	/** `git.status`'s answer; undefined answers `not_found` (no work tree). */
	status: GitStatus | undefined;
	readonly watches = new Map<string, string>();
	readonly writes: { path: string; expected: Expected }[] = [];
	/** `fs.readDir` answers at most this many names, like the daemon's 5,000. */
	maxEntries = 5_000;
	/** Requests that answer `unsupported`, like an older daemon. */
	readonly unsupported = new Set<string>();
	#clock = 1_000;
	#watchIds = 0;
	#node: FakeNode;

	constructor(node: FakeNode) {
		this.#node = node;
		node.onMessage = (message) => this.#answer(message);
	}

	stat(path: string): Stat | undefined {
		const file = this.files.get(path);
		return file && { size: new TextEncoder().encode(file.data).length, mtimeMs: file.mtimeMs, hash: sha(file.data) };
	}

	/** Writes as another program would (a shell, pi): the file changes and its watchers hear of it. */
	put(path: string, data: string, options: { binary?: boolean; silent?: boolean } = {}): void {
		for (let dir = path.slice(0, path.lastIndexOf("/")) || "/"; ; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
			this.dirs.add(dir);
			if (dir === "/") break;
		}
		this.files.set(path, { data, mtimeMs: (this.#clock += 10), ...(options.binary ? { binary: true } : {}) });
		if (!options.silent) this.changed(path);
	}

	remove(path: string): void {
		this.files.delete(path);
		this.changed(path, "gone");
	}

	/** `fs.changed` for every watch on `path` and on its directory. */
	changed(path: string, kind: "change" | "gone" = "change"): void {
		const dir = path.slice(0, path.lastIndexOf("/")) || "/";
		for (const [watch, watched] of this.watches) {
			if (watched === path) {
				void this.#node.send({ type: "fs.changed", watch, path, kind });
				if (kind === "gone") this.watches.delete(watch);
			} else if (watched === dir) void this.#node.send({ type: "fs.changed", watch, path: dir, kind: "change" });
		}
	}

	#reply(id: string, result: object): void {
		void this.#node.send({ type: "reply", id, result } as NodeMessage);
	}

	#error(id: string, code: string, message = code, current?: Stat): void {
		void this.#node.send({ type: "reply", id, error: { code, message, ...(current ? { current } : {}) } });
	}

	#answer(message: ClientMessage): void {
		if (!("id" in message)) return;
		const { id } = message;
		if (this.unsupported.has(message.type)) return this.#error(id, "unsupported");
		switch (message.type) {
			case "fs.readDir": {
				if (!this.dirs.has(message.path)) return this.#error(id, this.files.has(message.path) ? "not_a_directory" : "not_found");
				const prefix = message.path === "/" ? "/" : `${message.path}/`;
				const names = new Map<string, DirEntry>();
				for (const dir of this.dirs) {
					if (dir.startsWith(prefix) && dir !== message.path && !dir.slice(prefix.length).includes("/"))
						names.set(dir.slice(prefix.length), { name: dir.slice(prefix.length), kind: "dir", size: 64, mtimeMs: 1 });
				}
				for (const [path, file] of this.files) {
					if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
						names.set(path.slice(prefix.length), { name: path.slice(prefix.length), kind: "file", size: file.data.length, mtimeMs: file.mtimeMs });
				}
				const sorted = [...names.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
				return this.#reply(id, { entries: sorted.slice(0, this.maxEntries), truncated: sorted.length > this.maxEntries });
			}
			case "fs.read": {
				const file = this.files.get(message.path);
				if (!file) return this.#error(id, this.dirs.has(message.path) ? "is_a_directory" : "not_found");
				if (file.data.length > 512 * 1024) return this.#error(id, "too_large");
				return this.#reply(id, { encoding: file.binary ? "base64" : "utf8", data: file.binary ? "AAEC" : file.data, stat: this.stat(message.path) });
			}
			case "fs.write": {
				this.writes.push({ path: message.path, expected: message.expected });
				const current = this.stat(message.path);
				const expected = message.expected;
				const ok =
					"absent" in expected
						? !current
						: current !== undefined && ("hash" in expected ? current.hash === expected.hash : current.mtimeMs === expected.mtimeMs && current.size === expected.size);
				if (!ok) return this.#error(id, "conflict", `${message.path} changed`, current);
				// The daemon renames a temporary file over the target, which its watch reports as the save's echo.
				this.put(message.path, message.data);
				return this.#reply(id, { stat: this.stat(message.path) });
			}
			case "fs.watch": {
				if (!this.files.has(message.path) && !this.dirs.has(message.path)) return this.#error(id, "not_found");
				if (this.watches.size >= 64) return this.#error(id, "limit");
				const watch = `w${++this.#watchIds}`;
				this.watches.set(watch, message.path);
				return this.#reply(id, { watch });
			}
			case "fs.unwatch":
				if (!this.watches.delete(message.watch)) return this.#error(id, "not_found");
				return this.#reply(id, {});
			case "fs.list": {
				if (!this.dirs.has(message.root)) return this.#error(id, this.files.has(message.root) ? "not_a_directory" : "not_found");
				const prefix = message.root === "/" ? "/" : `${message.root}/`;
				const paths = [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort();
				const limit = message.limit ?? 20_000;
				return this.#reply(id, { paths: paths.slice(0, limit), truncated: paths.length > limit, source: "walk" });
			}
			case "fs.gitShow": {
				const content = (message.ref === "HEAD" ? this.head : this.index).get(message.path);
				if (content === undefined) return this.#error(id, "not_found");
				if (content.length > 512 * 1024) return this.#error(id, "too_large");
				if (this.binaryRefs.has(`${message.ref}:${message.path}`)) return this.#reply(id, { encoding: "base64", data: "AAEC" });
				return this.#reply(id, { encoding: "utf8", data: content });
			}
			case "git.status":
				if (!this.status) return this.#error(id, "not_found", `${message.root} is not in a git work tree`);
				return this.#reply(id, this.status);
			default:
				return this.#error(id, "unsupported");
		}
	}
}
