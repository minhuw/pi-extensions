import { afterEach, describe, expect, it, vi } from "vitest";
import { PikaApi, type DeckKeyItem, type DeckProjectRow } from "../src/lib/api";
import { DeckProjects, KEYS_BATCH, KEYS_RETRY_MS, keyItemOf, ProjectKeys, validProjectName } from "../src/nodes/deck-projects";
import { fakeKey, folderCheckout, gitCheckout } from "./support/checkouts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("project keys", () => {
	afterEach(() => vi.useRealTimers());

	it("are asked from a checkout's repository and project name, on its node", () => {
		expect(keyItemOf("mac", gitCheckout("a", "/home/me/repo"))).toEqual({ repository: "https://github.com/me/repo", project: "repo", node: "mac" });
		expect(keyItemOf("mac", folderCheckout("b", "/home/me/notes"))).toEqual({ project: "notes", node: "mac" });
	});

	it("are asked in one batch for every want before the next task, and kept", async () => {
		const asked: DeckKeyItem[][] = [];
		const keys = new ProjectKeys(async (items) => {
			asked.push(items);
			return items.map(fakeKey);
		});
		const versions: number[] = [];
		keys.subscribe(() => versions.push(keys.getVersion()));
		const a = { repository: "https://github.com/me/a", project: "a", node: "mac" };
		const b = { project: "b", node: "mac" };
		keys.want([a]);
		keys.want([b, a]);
		expect(keys.keyOf(a)).toBeUndefined();
		await tick();
		await tick();
		expect(asked).toEqual([[a, b]]);
		expect(keys.keyOf(a)).toBe("repo:https://github.com/me/a");
		expect(keys.keyOf(b)).toBe("local:b@node:mac");
		expect(versions).toEqual([1]);
		// Known keys are not asked again; the same item on another node is another item.
		keys.want([a, b, { ...b, node: "node01" }]);
		await tick();
		await tick();
		expect(asked).toHaveLength(2);
		expect(asked[1]).toEqual([{ project: "b", node: "node01" }]);
	});

	it("split a batch at 1,024 items, and keep null as an answer", async () => {
		const asked: number[] = [];
		const keys = new ProjectKeys(async (items) => {
			asked.push(items.length);
			return items.map(() => null);
		});
		const items = Array.from({ length: KEYS_BATCH + 1 }, (_, index) => ({ project: `p${index}`, node: "mac" }));
		keys.want(items);
		await tick();
		await tick();
		expect(asked).toEqual([KEYS_BATCH, 1]);
		expect(keys.keyOf(items[KEYS_BATCH]!)).toBeNull();
		keys.want(items);
		await tick();
		expect(asked).toHaveLength(2);
	});

	it("report a failed batch and ask again after a while", async () => {
		let now = 1_000;
		let fail = true;
		const asked: number[] = [];
		const keys = new ProjectKeys(
			async (items) => {
				asked.push(items.length);
				if (fail) throw new Error("404 nodes_disabled");
				return items.map(fakeKey);
			},
			{ now: () => now },
		);
		const item = { project: "a", node: "mac" };
		keys.want([item]);
		await tick();
		await tick();
		expect(keys.error).toBe("404 nodes_disabled");
		expect(keys.keyOf(item)).toBeUndefined();
		keys.want([item]);
		await tick();
		expect(asked).toEqual([1]);
		now += KEYS_RETRY_MS;
		fail = false;
		keys.want([item]);
		await tick();
		await tick();
		expect(asked).toEqual([1, 1]);
		expect(keys.keyOf(item)).toBe("local:a@node:mac");
		expect(keys.error).toBeUndefined();
	});

	it("fail loudly when the server answers the wrong number of keys", async () => {
		const keys = new ProjectKeys(async () => ["only one"]);
		keys.want([{ project: "a", node: "mac" }, { project: "b", node: "mac" }]);
		await tick();
		await tick();
		expect(keys.error).toMatch(/answered 1 keys for 2 items/);
	});
});

describe("project names", () => {
	it("are valid project names: no slashes, control characters, . or ..", () => {
		expect(validProjectName("Atlas web")).toBe(true);
		for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0007", "x".repeat(1_025)]) expect(validProjectName(bad), bad).toBe(false);
	});
});

describe("Deck's project presentation", () => {
	const at = "2026-11-12T00:00:00Z";
	function fakeApi(rows: DeckProjectRow[] = []) {
		const calls: string[] = [];
		let refuse: Error | undefined;
		return {
			calls,
			refuseNext: (error: Error) => void (refuse = error),
			api: {
				list: async () => ({ projects: rows }),
				patch: async (key: string, body: { name?: string | null; collapsed?: boolean }) => {
					calls.push(`PATCH ${key} ${JSON.stringify(body)}`);
					if (refuse) {
						const error = refuse;
						refuse = undefined;
						throw error;
					}
					const before = rows.find((item) => item.key === key);
					return { key, name: null, collapsed: false, ...before, ...body, updatedAt: "2026-11-12T01:00:00Z" };
				},
				remove: async (key: string) => {
					calls.push(`DELETE ${key}`);
					return { deleted: true };
				},
			},
		};
	}

	it("loads the rows, names and folds with PATCH, shows a change at once, and goes back when refused", async () => {
		const fake = fakeApi([{ key: "repo:https://github.com/me/a", name: "Atlas", collapsed: false, updatedAt: at }]);
		const store = new DeckProjects(fake.api);
		expect(store.getSnapshot().loaded).toBe(false);
		await store.load();
		expect(store.getSnapshot()).toMatchObject({ loaded: true });
		expect(store.row("repo:https://github.com/me/a")?.name).toBe("Atlas");

		const folding = store.setCollapsed("repo:https://github.com/me/a", true);
		expect(store.row("repo:https://github.com/me/a")?.collapsed).toBe(true);
		await folding;
		expect(store.row("repo:https://github.com/me/a")?.updatedAt).toBe("2026-11-12T01:00:00Z");

		fake.refuseNext(new Error("invalid"));
		const renaming = store.rename("local:b@node:mac", " Beta ");
		expect(store.row("local:b@node:mac")?.name).toBe("Beta");
		await expect(renaming).rejects.toThrow("invalid");
		expect(store.row("local:b@node:mac")).toBeUndefined();
		expect(fake.calls).toEqual(['PATCH repo:https://github.com/me/a {"collapsed":true}', 'PATCH local:b@node:mac {"name":"Beta"}']);
	});

	it("refuses a name that is no valid project name without asking, and deletes a row back at the defaults", async () => {
		const fake = fakeApi([{ key: "local:b@node:mac", name: "Beta", collapsed: false, updatedAt: at }]);
		const store = new DeckProjects(fake.api);
		await store.load();
		await expect(store.rename("local:b@node:mac", "a/b")).rejects.toThrow(/cannot name a project/);
		await store.rename("local:b@node:mac", "  ");
		expect(store.row("local:b@node:mac")).toBeUndefined();
		// Folding a project without a row makes one; unfolding it deletes it again.
		await store.setCollapsed("local:c@node:mac", true);
		await store.setCollapsed("local:c@node:mac", false);
		expect(fake.calls).toEqual(["DELETE local:b@node:mac", 'PATCH local:c@node:mac {"collapsed":true}', "DELETE local:c@node:mac"]);
	});

	it("keeps no rows from a server without the routes, and says why", async () => {
		const store = new DeckProjects({ ...fakeApi().api, list: async () => Promise.reject(new Error("404 nodes_disabled")) });
		await store.load();
		expect(store.getSnapshot()).toMatchObject({ loaded: true, error: "404 nodes_disabled" });
		expect(store.getSnapshot().rows.size).toBe(0);
	});

	it("goes to {base}/api/v1/deck/…, the key one percent-encoded path segment, writes as JSON", async () => {
		const requests: { url: string; method: string; body?: string }[] = [];
		const api = new PikaApi("/pika", async (url, init) => {
			requests.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
			const body = String(url).endsWith("project-keys") ? { keys: [null] } : String(url).endsWith("deck/projects") ? { projects: [] } : { key: "k", name: null, collapsed: true, updatedAt: at };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		expect(await api.deckProjectKeys([{ project: "a", node: "mac" }])).toEqual({ keys: [null] });
		await api.deckProjects();
		await api.patchDeckProject("repo:https://github.com/me/a", { collapsed: true });
		await api.deleteDeckProject("local:a@node:mac");
		expect(requests).toEqual([
			{ url: "/pika/api/v1/deck/project-keys", method: "POST", body: '{"items":[{"project":"a","node":"mac"}]}' },
			{ url: "/pika/api/v1/deck/projects", method: "GET" },
			{ url: "/pika/api/v1/deck/projects/repo%3Ahttps%3A%2F%2Fgithub.com%2Fme%2Fa", method: "PATCH", body: '{"collapsed":true}' },
			{ url: "/pika/api/v1/deck/projects/local%3Aa%40node%3Amac", method: "DELETE" },
		]);
	});
});
