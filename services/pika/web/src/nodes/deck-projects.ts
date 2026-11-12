/**
 * The pika server's side of Deck's projects (SPEC.md, "Deck"): the project key of each checkout, asked for in batches
 * and kept for the page, and how the owner presents each project (a name, folded or not), kept on the server.
 */
import type { DeckKeyItem, DeckProjectRow } from "../lib/api";
import type { Checkout } from "./contract";

/** The most items one `POST deck/project-keys` takes. */
export const KEYS_BATCH = 1_024;
/** How long a batch that failed waits before its items are asked again. */
export const KEYS_RETRY_MS = 30_000;

/** What a checkout's key is computed from. */
export function keyItemOf(node: string, checkout: Pick<Checkout, "repository" | "project">): DeckKeyItem {
	return { ...(checkout.repository ? { repository: checkout.repository } : {}), project: checkout.project, node };
}

const itemId = (item: DeckKeyItem): string => JSON.stringify([item.repository ?? "", item.project ?? "", item.node]);

/**
 * Project keys, one `POST deck/project-keys` per batch of new items: every `want` made before the next task joins one
 * request (split at 1,024 items). An answered key never changes, so it is kept for the page. A failed batch is
 * reported in `error` and asked again by a `want` after `KEYS_RETRY_MS`.
 */
export class ProjectKeys {
	#fetch: (items: DeckKeyItem[]) => Promise<(string | null)[]>;
	#now: () => number;
	#keys = new Map<string, string | null>();
	#queued = new Map<string, DeckKeyItem>();
	#inFlight = new Set<string>();
	#failedAt = new Map<string, number>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#version = 0;
	#error: string | undefined;
	#listeners = new Set<() => void>();

	constructor(fetchKeys: (items: DeckKeyItem[]) => Promise<(string | null)[]>, options: { now?: () => number } = {}) {
		this.#fetch = fetchKeys;
		this.#now = options.now ?? Date.now;
	}

	/** The key, `null` for none, or undefined while it is not known. */
	keyOf(item: DeckKeyItem): string | null | undefined {
		return this.#keys.get(itemId(item));
	}

	get error(): string | undefined {
		return this.#error;
	}

	/** Asks for the keys not known yet (and not asked for already), in the next batch. */
	want(items: Iterable<DeckKeyItem>): void {
		const now = this.#now();
		for (const item of items) {
			const id = itemId(item);
			if (this.#keys.has(id) || this.#queued.has(id) || this.#inFlight.has(id)) continue;
			const failed = this.#failedAt.get(id);
			if (failed !== undefined && now - failed < KEYS_RETRY_MS) continue;
			this.#queued.set(id, item);
		}
		if (this.#queued.size > 0 && this.#timer === undefined) this.#timer = setTimeout(() => this.#flush(), 0);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Changes whenever a key is learned or a batch fails. */
	getVersion = (): number => this.#version;

	dispose(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#listeners.clear();
	}

	#flush(): void {
		this.#timer = undefined;
		const batch = [...this.#queued.entries()];
		this.#queued.clear();
		for (let start = 0; start < batch.length; start += KEYS_BATCH) void this.#ask(batch.slice(start, start + KEYS_BATCH));
	}

	async #ask(batch: [string, DeckKeyItem][]): Promise<void> {
		for (const [id] of batch) this.#inFlight.add(id);
		try {
			const keys = await this.#fetch(batch.map(([, item]) => item));
			if (keys.length !== batch.length) throw new Error(`deck/project-keys answered ${keys.length} keys for ${batch.length} items`);
			batch.forEach(([id], index) => {
				this.#keys.set(id, keys[index] ?? null);
				this.#failedAt.delete(id);
			});
			this.#error = undefined;
		} catch (error) {
			const at = this.#now();
			for (const [id] of batch) this.#failedAt.set(id, at);
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			for (const [id] of batch) this.#inFlight.delete(id);
		}
		this.#emit();
	}

	#emit(): void {
		this.#version++;
		for (const listener of [...this.#listeners]) listener();
	}
}

/**
 * A valid project name (SPEC.md, "Project publishing"): nonempty, at most 1,024 bytes, no control characters or path
 * separators, and neither `.` nor `..`. A Deck project's display name must be one.
 */
export function validProjectName(name: string): boolean {
	return (
		name.length > 0 && new TextEncoder().encode(name).length <= 1_024 && !/[\u0000-\u001f\u007f-\u009f/\\]/.test(name) && name !== "." && name !== ".."
	);
}

export interface DeckProjectsApi {
	list: () => Promise<{ projects: DeckProjectRow[] }>;
	patch: (key: string, body: { name?: string | null; collapsed?: boolean }) => Promise<DeckProjectRow>;
	remove: (key: string) => Promise<{ deleted: boolean }>;
}

export interface DeckProjectsSnapshot {
	rows: ReadonlyMap<string, DeckProjectRow>;
	/** `GET deck/projects` has answered (or failed): rows are what the server keeps. */
	loaded: boolean;
	error?: string;
}

/**
 * How the owner presents each project, as the server keeps it (`GET/PATCH/DELETE deck/projects`). A change shows at
 * once and goes back if the server refuses it; a row back at the defaults (no name, not folded) is deleted rather than
 * kept.
 */
export class DeckProjects {
	#api: DeckProjectsApi;
	#rows = new Map<string, DeckProjectRow>();
	#loaded = false;
	#error: string | undefined;
	#snapshot: DeckProjectsSnapshot = { rows: new Map(), loaded: false };
	#listeners = new Set<() => void>();

	constructor(api: DeckProjectsApi) {
		this.#api = api;
	}

	async load(): Promise<void> {
		try {
			const { projects } = await this.#api.list();
			this.#rows = new Map(projects.map((row) => [row.key, row]));
			this.#error = undefined;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.#loaded = true;
		this.#emit();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): DeckProjectsSnapshot => this.#snapshot;

	row(key: string): DeckProjectRow | undefined {
		return this.#rows.get(key);
	}

	/** The name every browser shows for the project; null (or blank) goes back to the first checkout's name. */
	rename(key: string, name: string | null): Promise<void> {
		const trimmed = name?.trim() || null;
		if (trimmed !== null && !validProjectName(trimmed)) return Promise.reject(new Error(`“${trimmed}” cannot name a project: no slashes, control characters, “.” or “..”`));
		return this.#change(key, { name: trimmed });
	}

	setCollapsed(key: string, collapsed: boolean): Promise<void> {
		return this.#change(key, { collapsed });
	}

	async #change(key: string, change: { name?: string | null; collapsed?: boolean }): Promise<void> {
		const before = this.#rows.get(key);
		const next: DeckProjectRow = { key, name: null, collapsed: false, updatedAt: new Date().toISOString(), ...before, ...change };
		const atDefaults = next.name === null && !next.collapsed;
		if (atDefaults) this.#rows.delete(key);
		else this.#rows.set(key, next);
		this.#emit();
		try {
			if (atDefaults) {
				if (before) await this.#api.remove(key);
			} else {
				const row = await this.#api.patch(key, change);
				// A later change of the same row may have landed while this one was in flight.
				if (this.#rows.get(key) === next) this.#rows.set(key, row);
			}
		} catch (error) {
			if (before) this.#rows.set(key, before);
			else this.#rows.delete(key);
			this.#emit();
			throw error;
		}
		this.#emit();
	}

	#emit(): void {
		this.#snapshot = { rows: new Map(this.#rows), loaded: this.#loaded, ...(this.#error ? { error: this.#error } : {}) };
		for (const listener of [...this.#listeners]) listener();
	}
}
