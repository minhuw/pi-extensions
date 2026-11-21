import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckProjectRow } from "../src/lib/api";
import { DeckProjects } from "../src/nodes/deck-projects";
import { IndexedDbKeyStore, type PinnedNode } from "../src/nodes/identity";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface FakeOpenRequest {
	result: FakeDb | undefined;
	error: Error | null;
	onupgradeneeded: (() => void) | null;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onblocked: (() => void) | null;
}

interface FakeDb {
	objectStoreNames: { contains: (name: string) => boolean };
	createObjectStore: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	onclose: (() => void) | null;
	onversionchange: (() => void) | null;
	transaction: (name: string, mode: IDBTransactionMode) => {
		objectStore: (storeName: string) => {
			getAll: () => IDBRequest<PinnedNode[]>;
		};
	};
}

function makeFakeDb(pins: PinnedNode[]): FakeDb {
	return {
		objectStoreNames: { contains: () => true },
		createObjectStore: vi.fn(),
		close: vi.fn(),
		onclose: null,
		onversionchange: null,
		transaction: () => ({
			objectStore: () => ({
				getAll: () => {
					const req = {
						result: pins,
						error: null,
						onsuccess: null as (() => void) | null,
						onerror: null as (() => void) | null,
					};
					queueMicrotask(() => req.onsuccess?.());
					return req as unknown as IDBRequest<PinnedNode[]>;
				},
			}),
		}),
	};
}

function makeOpenRequest(): FakeOpenRequest {
	return {
		result: undefined,
		error: null,
		onupgradeneeded: null,
		onsuccess: null,
		onerror: null,
		onblocked: null,
	};
}

describe("IndexedDbKeyStore.#open retry cache", () => {
	const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

	afterEach(() => {
		if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
		else Reflect.deleteProperty(globalThis, "indexedDB");
	});

	it("clears the cached promise when open fails via onerror so a subsequent call retries and succeeds", async () => {
		const pin: PinnedNode = { node: "node-1", fingerprint: "fp-1", publicKey: "pk-1", name: "Node 1", pinnedAt: 1 };
		const db = makeFakeDb([pin]);
		let opens = 0;

		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: {
				open: () => {
					opens++;
					const req = makeOpenRequest();
					if (opens === 1) {
						req.error = new Error("transient open failure");
						queueMicrotask(() => req.onerror?.());
					} else {
						req.result = db;
						queueMicrotask(() => req.onsuccess?.());
					}
					return req;
				},
			},
		});

		const store = new IndexedDbKeyStore();
		await expect(store.pins()).rejects.toThrow("transient open failure");
		expect(opens).toBe(1);

		await expect(store.pins()).resolves.toEqual([pin]);
		expect(opens).toBe(2);

		// Once open succeeds, subsequent calls reuse the cached connection.
		await expect(store.pins()).resolves.toEqual([pin]);
		expect(opens).toBe(2);
	});

	it("clears the cached promise on onblocked and closes any late-arriving orphaned connection", async () => {
		const orphanedDb = makeFakeDb([]);
		const freshDb = makeFakeDb([]);
		let firstReq: FakeOpenRequest | undefined;
		let opens = 0;

		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: {
				open: () => {
					opens++;
					const req = makeOpenRequest();
					if (opens === 1) {
						firstReq = req;
						queueMicrotask(() => req.onblocked?.());
					} else {
						req.result = freshDb;
						queueMicrotask(() => req.onsuccess?.());
					}
					return req;
				},
			},
		});

		const store = new IndexedDbKeyStore();
		await expect(store.pins()).rejects.toThrow(/blocked/);

		// Late onsuccess on the abandoned request closes the orphaned DB instead of leaking it.
		firstReq!.result = orphanedDb;
		firstReq!.onsuccess?.();
		expect(orphanedDb.close).toHaveBeenCalledTimes(1);

		await expect(store.pins()).resolves.toEqual([]);
		expect(opens).toBe(2);
	});

	it("clears the cached promise when indexedDB.open throws synchronously", async () => {
		const db = makeFakeDb([]);
		let opens = 0;

		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: {
				open: () => {
					opens++;
					if (opens === 1) throw new Error("storage temporarily unavailable");
					const req = makeOpenRequest();
					req.result = db;
					queueMicrotask(() => req.onsuccess?.());
					return req;
				},
			},
		});

		const store = new IndexedDbKeyStore();
		await expect(store.pins()).rejects.toThrow("storage temporarily unavailable");
		await expect(store.pins()).resolves.toEqual([]);
		expect(opens).toBe(2);
	});

	it("clears the cached promise on db.onclose and db.onversionchange so later calls reopen", async () => {
		const dbs = [makeFakeDb([]), makeFakeDb([]), makeFakeDb([])];
		let opens = 0;

		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: {
				open: () => {
					const req = makeOpenRequest();
					req.result = dbs[opens++]!;
					queueMicrotask(() => req.onsuccess?.());
					return req;
				},
			},
		});

		const store = new IndexedDbKeyStore();
		await store.pins();
		expect(opens).toBe(1);

		dbs[0]!.onclose?.();
		await store.pins();
		expect(opens).toBe(2);

		dbs[1]!.onversionchange?.();
		expect(dbs[1]!.close).toHaveBeenCalledTimes(1);
		await store.pins();
		expect(opens).toBe(3);
	});
});

describe("loadHighlighter retry cache", () => {
	afterEach(() => {
		vi.doUnmock("../src/lib/highlight-languages");
		vi.resetModules();
	});

	it("clears the cached loader when the first import rejects so a subsequent call retries and succeeds", async () => {
		vi.resetModules();
		let attempts = 0;
		const highlightFn = vi.fn((code: string) => `<span class="tok">${code}</span>`);
		vi.doMock("../src/lib/highlight-languages", () => {
			attempts++;
			if (attempts === 1) throw new Error("chunk load failed");
			return {
				default: {
					getLanguage: (lang: string) => (lang === "typescript" ? {} : undefined),
					highlight: (code: string) => ({ value: highlightFn(code) }),
				},
			};
		});

		const { loadHighlighter } = await import("../src/lib/highlight");

		const firstError = await loadHighlighter().catch((error: unknown) => error);
		expect(firstError).toBeInstanceOf(Error);
		expect(String((firstError as Error & { cause?: unknown }).cause ?? firstError)).toContain("chunk load failed");
		expect(attempts).toBe(1);

		const secondPromise = loadHighlighter();
		const highlighter = await secondPromise;
		expect(attempts).toBe(2);
		expect(highlighter("const x = 1", "typescript")).toBe('<span class="tok">const x = 1</span>');
		expect(highlighter("const x = 1", "unknown-lang")).toBeNull();

		// Once loaded, subsequent calls reuse the cached promise without re-importing.
		expect(loadHighlighter()).toBe(secondPromise);
		expect(attempts).toBe(2);
	});
});

describe("DeckProjects.#change optimistic rollback race", () => {
	const key = "repo:https://example.invalid/org/app";
	const initial: DeckProjectRow = { key, name: "Initial", collapsed: false, updatedAt: "2026-11-12T00:00:00Z" };

	it("does not roll back over a newer in-flight optimistic change when an earlier request fails", async () => {
		const reqA = deferred<DeckProjectRow>();
		const reqB = deferred<DeckProjectRow>();
		let patchCount = 0;

		const store = new DeckProjects({
			list: async () => ({ projects: [initial] }),
			patch: () => (++patchCount === 1 ? reqA.promise : reqB.promise),
			remove: async () => ({ deleted: true }),
		});
		await store.load();

		const listener = vi.fn();
		store.subscribe(listener);

		const callA = store.rename(key, "First");
		expect(store.row(key)?.name).toBe("First");

		const callB = store.rename(key, "Second");
		expect(store.row(key)?.name).toBe("Second");

		const notificationsBeforeAFails = listener.mock.calls.length;

		// Request A fails while B is still in flight: B's optimistic state must remain intact.
		reqA.reject(new Error("request A failed"));
		await expect(callA).rejects.toThrow("request A failed");
		expect(store.row(key)?.name).toBe("Second");
		expect(listener).toHaveBeenCalledTimes(notificationsBeforeAFails);

		// Request B then commits cleanly.
		const committedB: DeckProjectRow = { key, name: "Second", collapsed: false, updatedAt: "2026-11-12T02:00:00Z" };
		reqB.resolve(committedB);
		await callB;
		expect(store.row(key)).toEqual(committedB);
	});

	it("does not roll back over a newer already-committed change when an earlier request fails", async () => {
		const reqA = deferred<DeckProjectRow>();
		const reqB = deferred<DeckProjectRow>();
		let patchCount = 0;

		const store = new DeckProjects({
			list: async () => ({ projects: [initial] }),
			patch: () => (++patchCount === 1 ? reqA.promise : reqB.promise),
			remove: async () => ({ deleted: true }),
		});
		await store.load();

		const callA = store.rename(key, "First");
		const callB = store.rename(key, "Second");

		const committedB: DeckProjectRow = { key, name: "Second", collapsed: false, updatedAt: "2026-11-12T02:00:00Z" };
		reqB.resolve(committedB);
		await callB;
		expect(store.row(key)).toEqual(committedB);

		const listener = vi.fn();
		store.subscribe(listener);

		reqA.reject(new Error("stale A failed"));
		await expect(callA).rejects.toThrow("stale A failed");
		expect(store.row(key)).toEqual(committedB);
		expect(listener).not.toHaveBeenCalled();
	});

	it("rolls back a standalone failed patch to the previous row (or deletes if none existed) and notifies listeners", async () => {
		const store = new DeckProjects({
			list: async () => ({ projects: [initial] }),
			patch: async () => {
				throw new Error("server rejected");
			},
			remove: async () => ({ deleted: true }),
		});
		await store.load();

		const listener = vi.fn();
		store.subscribe(listener);

		// Existing row rolls back to `initial`.
		await expect(store.rename(key, "Broken")).rejects.toThrow("server rejected");
		expect(store.row(key)).toEqual(initial);
		expect(listener).toHaveBeenCalledTimes(2); // optimistic + rollback

		// Brand-new row rolls back to deleted.
		listener.mockClear();
		const newKey = "local:fresh@node:mac";
		await expect(store.setCollapsed(newKey, true)).rejects.toThrow("server rejected");
		expect(store.row(newKey)).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("rolls back a standalone failed remove, but does not overwrite a newer change or newer remove", async () => {
		const remA = deferred<{ deleted: boolean }>();
		const patchB = deferred<DeckProjectRow>();
		const remC = deferred<{ deleted: boolean }>();
		let removes = 0;

		const store = new DeckProjects({
			list: async () => ({ projects: [initial] }),
			patch: () => patchB.promise,
			remove: () => (++removes === 1 ? remA.promise : remC.promise),
		});
		await store.load();

		// Standalone failed remove rolls back to `initial`.
		const failingOnly = new DeckProjects({
			list: async () => ({ projects: [initial] }),
			patch: async () => initial,
			remove: async () => {
				throw new Error("remove failed");
			},
		});
		await failingOnly.load();
		const standaloneListener = vi.fn();
		failingOnly.subscribe(standaloneListener);
		await expect(failingOnly.rename(key, null)).rejects.toThrow("remove failed");
		expect(failingOnly.row(key)).toEqual(initial);
		expect(standaloneListener).toHaveBeenCalledTimes(2);

		// A deletes, B renames, C deletes again; then stale A fails -> must NOT restore `initial`.
		const callA = store.rename(key, null);
		expect(store.row(key)).toBeUndefined();

		const callB = store.rename(key, "Reborn");
		expect(store.row(key)?.name).toBe("Reborn");

		const callC = store.rename(key, null);
		expect(store.row(key)).toBeUndefined();

		const listener = vi.fn();
		store.subscribe(listener);

		remA.reject(new Error("stale remove A failed"));
		await expect(callA).rejects.toThrow("stale remove A failed");
		expect(store.row(key)).toBeUndefined();
		expect(listener).not.toHaveBeenCalled();

		patchB.resolve({ key, name: "Reborn", collapsed: false, updatedAt: "2026-11-12T03:00:00Z" });
		await callB;
		// Stale patch B must not overwrite C's deletion either.
		expect(store.row(key)).toBeUndefined();

		remC.resolve({ deleted: true });
		await callC;
		expect(store.row(key)).toBeUndefined();
	});
});
