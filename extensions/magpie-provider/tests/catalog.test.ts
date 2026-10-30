import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeContext, type ModelsPublication, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { sharedMagpieCatalogs } from "../catalog.ts";
import { createMagpieProvider } from "../index.ts";

const name = "claude-opus-5-5";
const source = { id: `contabo/claude/${name}`, owned_by: "contabo", native_endpoints: ["/v1/messages"] };
const env = { MAGPIE_BASE_URL: "http://127.0.0.1:3425", MAGPIE_API_KEY: "fixture-key" };
const context = (overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
	allowNetwork: true, signal: new AbortController().signal,
	publish: async ({ update }: ModelsPublication) => { update?.(); return true; }, ...overrides,
});
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "magpie-catalog-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [source] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const provider = (scope = directory, connection = env) => createMagpieProvider(connection, undefined, undefined, undefined, sharedMagpieCatalogs(scope));

it("shares only same-scope catalog data and retains it across failed discovery and offline startup", async () => {
	const parent = provider();
	await parent.refreshModels!(context());
	const previous = parent.getModels();
	const child = provider();
	expect(child).not.toBe(parent);
	expect(child.getModels()).toBe(previous);
	await child.refreshModels!(context({ allowNetwork: false }));
	vi.mocked(fetch).mockRejectedValue(new Error("offline"));
	await expect(child.refreshModels!(context())).rejects.toThrow("discovery failed");
	expect(parent.getModels()).toBe(previous);
	expect(child.getModels()).toBe(previous);
	expect(provider(join(directory, "other-agent")).getModels()).toEqual([]);
	expect(provider(directory, { ...env, MAGPIE_API_KEY: "other-key" }).getModels()).toEqual([]);
	expect(provider(directory, { ...env, MAGPIE_BASE_URL: "http://127.0.0.1:4000" }).getModels()).toEqual([]);
	// Direct programmatic factories remain isolated unless given a catalog scope.
	expect(createMagpieProvider(env).getModels()).toEqual([]);
});

it("detaches changed raw credentials without clearing other sessions or trusting ambient auth as saved login", async () => {
	const parent = provider();
	await parent.refreshModels!(context());
	const previous = parent.getModels();
	const child = provider();
	const credential = { type: "api_key" as const, key: env.MAGPIE_API_KEY };
	await child.refreshModels!(context({ allowNetwork: false, credential }));
	expect(child.getModels()).toEqual([]);
	expect(parent.getModels()).toBe(previous);
	await child.refreshModels!(context({ credential }));
	const saved = child.getModels();
	expect(saved).not.toBe(previous);
	const another = provider();
	await another.refreshModels!(context({ allowNetwork: false, credential }));
	expect(another.getModels()).toBe(saved);
	await child.refreshModels!(context({ allowNetwork: false, credential: { ...credential, key: "rotated" } }));
	expect(child.getModels()).toEqual([]);
	expect(another.getModels()).toBe(saved);
	expect(parent.getModels()).toBe(previous);
});

it.each([
	{ rows: [{ id: "unrelated" }], reason: /target is missing/ },
	{ rows: [{ ...source, owned_by: "other" }], reason: /metadata conflicts/ },
	{ rows: [source, { ...source, id: `other/${name}`, owned_by: "other" }], reason: /competing sources/ },
])("publishes authoritative route changes across instances: $reason", async ({ rows, reason }) => {
	const parent = provider();
	await parent.refreshModels!(context());
	const alias = parent.getModels().find(model => model.id === name)!;
	const child = provider();
	vi.mocked(fetch).mockResolvedValue(Response.json({ data: rows }));
	await child.refreshModels!(context());
	for (const instance of [parent, child]) for (const method of ["stream", "streamSimple"] as const) {
		expect(() => instance[method](alias, normalizeContext({ messages: [] }))).toThrow(reason);
	}
	expect(parent.getModels()).toBe(child.getModels());
});

it.each(["success", "failure"] as const)("a late discovery cannot override a newer %s from another instance", async latest => {
	const parent = provider();
	await parent.refreshModels!(context());
	const previous = parent.getModels();
	const child = provider();
	let release!: (response: Response) => void;
	vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
	const stale = parent.refreshModels!(context());
	if (latest === "success") {
		vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [{ id: "new-model" }] }));
		await child.refreshModels!(context());
	} else {
		vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
		await expect(child.refreshModels!(context())).rejects.toThrow("discovery failed");
	}
	release(Response.json({ data: [{ id: "stale-model" }] }));
	await stale;
	expect(parent.getModels()).toBe(child.getModels());
	if (latest === "success") expect(parent.getModels().map(model => model.id)).toEqual(["new-model"]);
	else expect(parent.getModels()).toBe(previous);
});

it("refused publication and cancellation cannot replace the shared catalog", async () => {
	const parent = provider();
	await parent.refreshModels!(context());
	const previous = parent.getModels();
	const child = provider();
	vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [{ id: "rejected-model" }] }));
	await child.refreshModels!(context({ publish: async () => false }));
	expect(parent.getModels()).toBe(previous);
	let release!: (response: Response) => void;
	vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
	const controller = new AbortController();
	const cancelled = child.refreshModels!(context({ signal: controller.signal }));
	controller.abort();
	release(Response.json({ data: [{ id: "cancelled-model" }] }));
	await expect(cancelled).rejects.toThrow("cancelled");
	expect(parent.getModels()).toBe(previous);
	expect(child.getModels()).toBe(previous);
});

it("a connection change prevents an in-flight response from attaching to the new scope", async () => {
	const parent = provider();
	await parent.refreshModels!(context());
	const previous = parent.getModels();
	const child = provider();
	let release!: (response: Response) => void;
	vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
	const stale = child.refreshModels!(context());
	await child.refreshModels!(context({ allowNetwork: false, credential: { type: "api_key", key: "changed-key" } }));
	release(Response.json({ data: [{ id: "stale-model" }] }));
	await stale;
	expect(child.getModels()).toEqual([]);
	expect(parent.getModels()).toBe(previous);
});
