import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import bridge from "../index.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Factory = (api: ExtensionAPI) => void;
const keys = ["__orcaPiSubagents", "__orcaPiStatusPostQueue"];
let oldEnv: NodeJS.ProcessEnv;
let descriptors: Array<PropertyDescriptor | undefined>;
let registry: PropertyDescriptor | undefined;
const ownerKey = Symbol.for("pi-extensions.orca-bridge.owners");
let root: string;
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
beforeEach(() => {
	oldEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_")) delete process.env[key];
	Object.assign(process.env, { ORCA_PANE_KEY: "compat-pane", ORCA_AGENT_HOOK_PORT: "12345", ORCA_AGENT_HOOK_TOKEN: "fixture-token" });
	descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
	registry = Object.getOwnPropertyDescriptor(globalThis, ownerKey);
	for (const key of [...keys, ownerKey]) Reflect.deleteProperty(globalThis, key);
	root = mkdtempSync(join(tmpdir(), "orca-managed-compat-"));
	vi.useFakeTimers();
});
afterEach(async () => {
	await flush();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
	Object.assign(process.env, oldEnv);
	keys.forEach((key, index) => {
		const descriptor = descriptors[index];
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	});
	if (registry) Object.defineProperty(globalThis, ownerKey, registry);
	else Reflect.deleteProperty(globalThis, ownerKey);
	rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("cooperates with Orca v1.4.230's actual managed reporter (bridge first=%s)", async bridgeFirst => {
	const request = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { createJiti } = request("jiti") as { createJiti: (filename: string, options: { moduleCache: boolean }) => { import: (path: string) => Promise<{ default: Factory }> } };
	const filename = join(root, "orca-agent-status.ts");
	writeFileSync(filename, readFileSync(new URL("./fixtures/orca-v1.4.230-status.ts.txt", import.meta.url)));
	const managed = (await createJiti(filename, { moduleCache: false }).import(filename)).default;
	const handlers = new Map<string, Set<Handler>>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emit = (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); };
	const api = (): ExtensionAPI => ({
		events: {
			emit,
			on(channel: string, fn: (data: unknown) => void) {
				if (!listeners.has(channel)) listeners.set(channel, new Set());
				listeners.get(channel)!.add(fn);
				return () => { listeners.get(channel)?.delete(fn); };
			},
		},
		on(name: string, fn: Handler) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(fn);
			return () => { handlers.get(name)?.delete(fn); };
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	let idle = true;
	const ctx = { mode: "tui", cwd: root, isIdle: () => idle, ui: { setTitle: vi.fn() }, sessionManager: { getSessionId: () => "compat-session", getSessionFile: () => undefined } } as unknown as ExtensionContext;
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	if (bridgeFirst) { bridge(api()); managed(api()); }
	else { managed(api()); bridge(api()); }
	const fire = async (name: string) => { for (const fn of [...handlers.get(name) ?? []]) await fn({}, ctx); await flush(); };
	const snapshot = (source: string, ids: string[]) => emit("pi-extensions:activity", { source, activities: ids.map(id => ({ id, label: id })) });
	const events = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload.hook_event_name as string);
	try {
		await fire("session_start");
		idle = false;
		await fire("agent_start");
		snapshot("herder", ["run"]);
		snapshot("subagents", ["workflow"]);
		await fire("agent_end");
		idle = true;
		await fire("agent_settled");
		expect(events()).not.toContain("agent_end");
		snapshot("herder", []);
		await flush();
		expect(events()).not.toContain("agent_end");
		snapshot("subagents", []);
		await flush();
		expect(events().filter(event => event === "agent_end")).toHaveLength(1);
		expect(events().at(-1)).toBe("agent_end");
	} finally {
		await fire("session_shutdown");
	}
});
