import type { NodeChannel } from "./channel";
import { fromBase64Url, LIMITS, type NodeEvent, type Requests, type RequestType, type Results } from "./contract";

export type ChangeKind = "change" | "rename" | "gone";

interface WatchEntry {
	/** Undefined while `fs.watch` is in flight. */
	id?: string;
	listeners: Set<(kind: ChangeKind) => void>;
	ready: Promise<boolean>;
}

/** The part of a channel the file layer uses; `NodeChannel` is one. */
export type FilesChannel = Pick<NodeChannel, "request" | "onEvent">;

/**
 * Files on one node over one channel (NODE.md §4 "Files"): requests, and watches shared by path, so a directory
 * shown in the tree and a file open in an editor tab each cost one of the channel's 64 watches however often they are
 * asked for. Watches end with the channel; a new channel gets a new `NodeFiles`.
 */
export class NodeFiles {
	readonly channel: FilesChannel;
	#watches = new Map<string, WatchEntry>();
	#byId = new Map<string, string>();
	#stop: () => void;

	constructor(channel: FilesChannel) {
		this.channel = channel;
		this.#stop = channel.onEvent((event) => this.#event(event));
	}

	request<K extends RequestType>(type: K, params: Requests[K]): Promise<Results[K]> {
		return this.channel.request(type, params);
	}

	readDir(path: string) {
		return this.request("fs.readDir", { path });
	}

	read(path: string) {
		return this.request("fs.read", { path });
	}

	/** Watches currently held on this channel. */
	get watchCount(): number {
		return this.#watches.size;
	}

	/**
	 * Calls `listener` on every `fs.changed` for `path` until the returned function runs. Resolves false when the node
	 * refused the watch (the 64-watch limit, or the path is gone): the caller then shows that it does not refresh.
	 */
	watch(path: string, listener: (kind: ChangeKind) => void): { ready: Promise<boolean>; stop: () => void } {
		let entry = this.#watches.get(path);
		if (!entry) {
			const created: WatchEntry = { listeners: new Set(), ready: Promise.resolve(false) };
			created.ready = this.request("fs.watch", { path }).then(
				({ watch }) => {
					if (this.#watches.get(path) !== created) {
						void this.request("fs.unwatch", { watch }).catch(() => {});
						return false;
					}
					created.id = watch;
					this.#byId.set(watch, path);
					return true;
				},
				() => {
					if (this.#watches.get(path) === created) this.#watches.delete(path);
					return false;
				},
			);
			this.#watches.set(path, created);
			entry = created;
		}
		const held = entry;
		held.listeners.add(listener);
		let stopped = false;
		return {
			ready: held.ready,
			stop: () => {
				if (stopped) return;
				stopped = true;
				held.listeners.delete(listener);
				if (held.listeners.size > 0 || this.#watches.get(path) !== held) return;
				this.#watches.delete(path);
				if (held.id) {
					this.#byId.delete(held.id);
					void this.request("fs.unwatch", { watch: held.id }).catch(() => {});
				}
			},
		};
	}

	dispose(): void {
		this.#stop();
		this.#watches.clear();
		this.#byId.clear();
	}

	#event(event: NodeEvent): void {
		if (event.type !== "fs.changed") return;
		const path = this.#byId.get(event.watch);
		if (!path) return;
		const entry = this.#watches.get(path);
		if (event.kind === "gone") {
			// The node ended the watch.
			this.#byId.delete(event.watch);
			if (entry?.id === event.watch) this.#watches.delete(path);
		}
		for (const listener of [...(entry?.listeners ?? [])]) listener(event.kind);
	}
}

export function decodeText(encoding: "utf8" | "base64", data: string): string {
	if (encoding === "utf8") return data;
	const bytes = fromBase64Url(data);
	return bytes ? new TextDecoder().decode(bytes) : "";
}

/** The part of a path after its last slash. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/** The directory holding `path` (`/` for a top-level entry). */
export const dirName = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf("/")));

export const joinPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** `child` is `parent` or inside it. */
export const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);

export const READ_LIMIT_LABEL = `${Math.round(LIMITS.maxReadBytes / 1024)} KiB`;
