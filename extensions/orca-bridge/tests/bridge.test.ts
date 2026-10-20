import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bridge from "../index.ts";
import { Activities, parseSnapshot } from "../activity.ts";
import { endpoint, HookTransport } from "../transport.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
class Bus {
	listeners = new Map<string, Set<(value: unknown) => void>>();
	emit(channel: string, value: unknown): void { for (const fn of [...this.listeners.get(channel) ?? []]) fn(value); }
	on(channel: string, fn: (value: unknown) => void): () => void {
		if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
		this.listeners.get(channel)!.add(fn);
		return () => { this.listeners.get(channel)?.delete(fn); };
	}
	// Pi hands each extension a distinct wrapper over the shared bus.
	wrapper() { return { on: this.on.bind(this), emit: this.emit.bind(this) }; }
}
function harness(bus = new Bus(), mode = "tui") {
	const handlers = new Map<string, Set<Handler>>();
	const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
	const setTitle = vi.fn();
	const notify = vi.fn();
	const context = {
		mode, cwd: "/workspace/project", ui: { setTitle, notify },
		sessionManager: { getSessionName: () => "My session", getSessionFile: () => undefined, getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const api = {
		events: bus.wrapper(),
		on(name: string, fn: Handler) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(fn);
			return () => { handlers.get(name)?.delete(fn); };
		},
		registerCommand: (name: string, command: unknown) => commands.set(name, command as never),
	} as unknown as ExtensionAPI;
	bridge(api);
	return {
		bus, api, context, setTitle, notify, handlers,
		async fire(name: string, event: unknown = {}, ctx = context) {
			for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx);
		},
		status: () => commands.get("orca-status")!.handler("", context),
		snapshot(source: string, ...activities: Array<[string, string]>) { bus.emit("pi-extensions:activity", { source, activities: activities.map(([id, label]) => ({ id, label })) }); },
	};
}
type Harness = ReturnType<typeof harness>;
let live: Harness[];
function create(bus?: Bus, mode?: string): Harness { const h = harness(bus, mode); live.push(h); return h; }
const registryKey = Symbol.for("pi-extensions.orca-bridge.owners");
let originalEnv: NodeJS.ProcessEnv;
let originalRoster: PropertyDescriptor | undefined;
let originalRegistry: PropertyDescriptor | undefined;
let directory: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const response = (status = 200) => ({ ok: status >= 200 && status < 300, status }) as Response;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
const events = () => bodies().map(body => body.payload.hook_event_name);

beforeEach(() => {
	vi.useFakeTimers();
	originalEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_")) delete process.env[key];
	Object.assign(process.env, { ORCA_PANE_KEY: "test-pane", ORCA_AGENT_HOOK_PORT: "12345", ORCA_AGENT_HOOK_TOKEN: "secret-test-token" });
	originalRoster = Object.getOwnPropertyDescriptor(globalThis, "__orcaPiSubagents");
	originalRegistry = Object.getOwnPropertyDescriptor(globalThis, registryKey);
	Reflect.deleteProperty(globalThis, "__orcaPiSubagents");
	Reflect.deleteProperty(globalThis, registryKey);
	directory = mkdtempSync(join(tmpdir(), "orca-bridge-test-"));
	fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
	vi.stubGlobal("fetch", fetchMock);
	live = [];
});
afterEach(async () => {
	fetchMock.mockResolvedValue(response());
	for (const h of live) await h.fire("session_shutdown");
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	if (originalRoster) Object.defineProperty(globalThis, "__orcaPiSubagents", originalRoster);
	else Reflect.deleteProperty(globalThis, "__orcaPiSubagents");
	if (originalRegistry) Object.defineProperty(globalThis, registryKey, originalRegistry);
	else Reflect.deleteProperty(globalThis, registryKey);
	rmSync(directory, { recursive: true, force: true });
});

describe("snapshots and lifecycle", () => {
	it("holds overlapping sources and independent IDs through parent settlement and partial finishes", async () => {
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		h.snapshot("herder", ["same", "Build"], ["second", "Review"]);
		h.snapshot("subagents", ["same", "Inspect"]);
		await h.fire("agent_end");
		await h.fire("agent_settled");
		h.snapshot("herder", ["second", "Review"]);
		h.snapshot("subagents");
		await flush();
		expect(events()).toEqual(["agent_start"]);
		h.snapshot("herder");
		await flush();
		expect(events()).toEqual(["agent_start", "agent_end"]);
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("Main: 0; background: 0");
	});

	it("never finishes on agent_end even without background work", async () => {
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await h.fire("agent_end");
		await vi.advanceTimersByTimeAsync(10000);
		expect(events()).toEqual(["agent_start"]);
		await h.fire("agent_settled");
		await flush();
		expect(events()).toEqual(["agent_start", "agent_end"]);
	});

	it("captures early snapshots without resources and requests replay after activation", async () => {
		const bus = new Bus();
		const h = create(bus);
		h.snapshot("herder", ["early", "Old"]);
		expect(vi.getTimerCount()).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const replay = vi.fn(() => {
			expect(process.env.ORCA_PI_STATUS_OWNED).toBe(String(process.pid));
			h.snapshot("herder", ["current", "Current"]);
			h.snapshot("subagents", ["other", "Other"]);
		});
		bus.on("pi-extensions:activity-request", replay);
		await h.fire("session_start");
		await flush();
		expect(replay).toHaveBeenCalledOnce();
		expect(events()).toEqual(["agent_start"]);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("Current · Other");
		expect(h.setTitle.mock.lastCall?.[0]).not.toContain("Old");
		await h.fire("session_start");
		expect(replay).toHaveBeenCalledOnce();
	});

	it("does not transition or repaint for duplicate/reordered snapshots", async () => {
		const h = create();
		await h.fire("session_start");
		h.snapshot("source", ["a", "A"], ["b", "B"]);
		await flush();
		const calls = h.setTitle.mock.calls.length;
		h.snapshot("source", ["b", "B"], ["a", "A"]);
		expect(h.setTitle).toHaveBeenCalledTimes(calls);
		expect(events()).toEqual(["agent_start"]);
		h.snapshot("source", ["a", "Renamed"], ["b", "B"]);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("Renamed");
		expect(events()).toEqual(["agent_start"]);
	});

	it("rejects malformed and oversized updates atomically without invoking getters", () => {
		const activities = new Activities();
		const good = { source: "valid", activities: [{ id: "1", label: "Work" }] };
		expect(activities.update(good)).toBe(true);
		const getter = vi.fn(() => { throw new Error("must not run"); });
		const malicious = Object.defineProperty({}, "source", { get: getter });
		for (const bad of [null, {}, malicious, { ...good, source: "bad:source" }, { ...good, activities: [{}] },
			{ ...good, activities: [good.activities[0], good.activities[0]] }, { ...good, activities: [{ id: "x", label: "\u001btitle" }] },
			{ ...good, activities: Array(129).fill(good.activities[0]) }, { ...good, source: "x".repeat(65) }]) {
			expect(activities.update(bad)).toBe(false);
			expect(activities.size).toBe(1);
		}
		expect(getter).not.toHaveBeenCalled();
		expect(parseSnapshot(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("bad"); } }))).toBeUndefined();
	});

	it("bounds the source count and global activity count while allowing removals", () => {
		const activities = new Activities();
		for (let i = 0; i < 64; i++) activities.update({ source: `s${i}`, activities: [{ id: "x", label: "X" }] });
		expect(activities.update({ source: "overflow", activities: [{ id: "x", label: "X" }] })).toBe(false);
		activities.update({ source: "s0", activities: [] });
		expect(activities.update({ source: "overflow", activities: [{ id: "x", label: "X" }] })).toBe(true);
		activities.clear();
		for (let i = 0; i < 8; i++) activities.update({ source: `s${i}`, activities: Array.from({ length: 128 }, (_, n) => ({ id: `${n}`, label: "X" })) });
		expect(activities.size).toBe(1024);
		expect(activities.update({ source: "ninth", activities: [{ id: "x", label: "X" }] })).toBe(false);
	});
});

describe("prompts and guarded titles", () => {
	it("prioritizes nested prompts and counts background activity in is_idle", async () => {
		const h = create();
		await h.fire("session_start");
		h.snapshot("source", ["1", "Background"]);
		await flush();
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_start");
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π ! My session · Waiting for input - /workspace/project");
		expect(vi.getTimerCount()).toBe(0);
		await h.fire("ui_prompt_end");
		await flush();
		expect(events()).toEqual(["agent_start", "ui_prompt_start"]);
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_end", is_idle: false });
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π : My session · Background");
		h.snapshot("source");
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_end", is_idle: true });
		expect(h.setTitle.mock.lastCall?.[0]).toBe("π > My session - /workspace/project");
	});

	it("keeps waiting priority when parent settles during a prompt", async () => {
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await h.fire("ui_prompt_start");
		await h.fire("agent_settled");
		await flush();
		expect(bodies().at(-1).payload.ui_prompt_active).toBe(true);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π !");
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload.is_idle).toBe(true);
	});

	it("does not access terminal UI outside tui mode", async () => {
		const h = create(undefined, "print");
		Object.defineProperty(h.context, "ui", { get() { throw new Error("not tui"); } });
		await h.fire("session_start");
		h.snapshot("source", ["1", "Work"]);
		await flush();
		expect(events()).toEqual(["agent_start"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains stale UI/context getters and stops their spinner", async () => {
		const h = create();
		await h.fire("session_start");
		h.snapshot("source", ["1", "Work"]);
		await flush();
		expect(vi.getTimerCount()).toBe(1);
		Object.defineProperty(h.context, "ui", { configurable: true, get() { throw new Error("stale secret"); } });
		await vi.advanceTimersByTimeAsync(100);
		expect(vi.getTimerCount()).toBe(0);
		expect(() => h.snapshot("source", ["1", "New"])).not.toThrow();
		await expect(h.status()).resolves.toBeUndefined();
	});

	it("guards session manager, name, cwd and mode getters", async () => {
		const h = create();
		Object.defineProperty(h.context, "sessionManager", { get() { throw new Error("manager"); } });
		Object.defineProperty(h.context, "cwd", { get() { throw new Error("cwd"); } });
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π : Working");
		expect(bodies()[0].payload.session_file).toBeUndefined();
		Object.defineProperty(h.context, "mode", { get() { throw new Error("mode"); } });
		await vi.advanceTimersByTimeAsync(100);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("ownership and managed protocol", () => {
	function managed(bus: Bus, external = ["external-child"]) {
		process.env.ORCA_PI_STATUS_OWNED = String(process.pid);
		const active = new Set(external);
		const onEvent = vi.fn((value: unknown) => {
			const event = value as { id: string; status: string };
			if (event.status === "started") active.add(event.id);
			if (event.status === "completed") active.delete(event.id);
		});
		Reflect.set(globalThis, "__orcaPiSubagents", { active, onEvent });
		bus.on("task:subagent:lifecycle", onEvent);
		return { active, onEvent };
	}
	// Model the installed reporter's lexical turn/prompt state, including the
	// child-only path that reports activity without ever setting its turn flag.
	function managedReporter(h: Harness, roster: ReturnType<typeof managed>) {
		const hooks: Array<{ hook_event_name: string; is_idle?: boolean }> = [];
		let rootHeld = false;
		let settled = true;
		let depth = 0;
		const release = () => { if (settled && !roster.active.size) rootHeld = false; };
		h.api.on("agent_start", () => { rootHeld = true; settled = false; depth = 0; hooks.push({ hook_event_name: "agent_start" }); });
		h.api.on("agent_settled", () => { settled = true; release(); });
		h.bus.on("task:subagent:lifecycle", release);
		h.api.on("ui_prompt_start", () => { if (rootHeld && ++depth === 1) hooks.push({ hook_event_name: "ui_prompt_start" }); });
		h.api.on("ui_prompt_end", () => { if (depth && --depth === 0) hooks.push({ hook_event_name: "ui_prompt_end", is_idle: !rootHeld }); });
		return hooks;
	}
	it("is inert without pane/endpoint and explains why", async () => {
		delete process.env.ORCA_PANE_KEY;
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		h.snapshot("s", ["x", "Work"]);
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("inactive (ORCA_PANE_KEY is absent)");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.setTitle).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		process.env.ORCA_PANE_KEY = "other";
		delete process.env.ORCA_AGENT_HOOK_PORT;
		const second = create();
		await second.fire("session_start");
		await second.status();
		expect(second.notify.mock.lastCall?.[0]).toContain("hook endpoint is not configured");
	});

	it.each([undefined, "EPERM"])("suppresses inherited live owner including probe error %s", async code => {
		process.env.ORCA_PI_STATUS_OWNED = "765432";
		vi.spyOn(process, "kill").mockImplementation(() => { if (code) throw Object.assign(new Error("private"), { code }); return true; });
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		h.snapshot("s", ["1", "Child"]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.setTitle).not.toHaveBeenCalled();
		expect(process.env.ORCA_PI_STATUS_OWNED).toBe("765432");
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("another live process");
	});

	it("allows ESRCH stale owners and releases only its own env assignment", async () => {
		process.env.ORCA_PI_STATUS_OWNED = "765432";
		vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
		const h = create();
		await h.fire("session_start");
		expect(process.env.ORCA_PI_STATUS_OWNED).toBe(String(process.pid));
		await h.fire("agent_start");
		await flush();
		expect(events()).toEqual(["agent_start"]);
		process.env.ORCA_PI_STATUS_OWNED = "new-owner";
		await h.fire("session_shutdown");
		expect(process.env.ORCA_PI_STATUS_OWNED).toBe("new-owner");
	});

	it("suppresses duplicate same-process activation until the original releases", async () => {
		const first = create();
		const second = create();
		await first.fire("session_start");
		await second.fire("session_start");
		await second.fire("agent_start");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(second.setTitle).not.toHaveBeenCalled();
		await second.status();
		expect(second.notify.mock.lastCall?.[0]).toContain("bridge already active");
		await first.fire("session_shutdown");
		expect(process.env.ORCA_PI_STATUS_OWNED).toBeUndefined();
		const reloaded = create();
		await reloaded.fire("session_start");
		await reloaded.fire("agent_start");
		await flush();
		expect(events()).toEqual(["agent_start"]);
	});

	it("detects managed status after factories, relays namespaced deltas and never fetches", async () => {
		const bus = new Bus();
		const h = create(bus);
		h.snapshot("herder", ["same", "Plan"]);
		// Managed factory runs later with a different events wrapper.
		const roster = managed(bus);
		expect(h.api.events).not.toHaveProperty("__orcaPiSubagents");
		await h.fire("session_start");
		h.snapshot("subagents", ["same", "Review"]);
		h.snapshot("herder", ["same", "Plan"]);
		await h.fire("agent_start");
		await h.fire("agent_end");
		await h.fire("agent_settled");
		expect([...roster.active]).toEqual(["external-child", "pi-extensions:herder:same", "pi-extensions:subagents:same"]);
		expect(roster.onEvent.mock.calls.map(call => call[0])).toEqual([
			{ id: "pi-extensions:herder:same", status: "started", agent: "Plan", description: "herder: Plan" },
			{ id: "pi-extensions:subagents:same", status: "started", agent: "Review", description: "subagents: Review" },
		]);
		h.snapshot("herder");
		expect(roster.active.has("pi-extensions:subagents:same")).toBe(true);
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("Orca bridge: managed");
		await h.fire("session_shutdown");
		expect([...roster.active]).toEqual(["external-child"]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(process.env.ORCA_PI_STATUS_OWNED).toBe(String(process.pid));
	});

	it("adds replacements before releasing the last managed child", async () => {
		const bus = new Bus();
		const roster = managed(bus);
		const h = create(bus);
		await h.fire("session_start");
		h.snapshot("s", ["old", "Old"]);
		h.snapshot("s", ["new", "New"]);
		expect(roster.onEvent.mock.calls.map(call => (call[0] as { status: string }).status)).toEqual(["started", "started", "completed"]);
	});

	it("does not mutate the managed roster itself even if the bus receiver is absent", async () => {
		process.env.ORCA_PI_STATUS_OWNED = String(process.pid);
		const active = new Set(["external"]);
		Reflect.set(globalThis, "__orcaPiSubagents", { active, onEvent: vi.fn() });
		const h = create();
		await h.fire("session_start");
		h.snapshot("s", ["child", "Child"]);
		await h.fire("session_shutdown");
		expect([...active]).toEqual(["external"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("only paints settled background titles in managed mode", async () => {
		const bus = new Bus();
		managed(bus);
		const h = create(bus);
		await h.fire("session_start");
		h.setTitle.mockClear(); // The existing external child already has a background title.
		await h.fire("agent_start");
		h.snapshot("s", ["1", "Background"]);
		expect(h.setTitle).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await h.fire("agent_settled");
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π : My session · Background");
		expect(vi.getTimerCount()).toBe(1);
		await h.fire("ui_prompt_start");
		const count = h.setTitle.mock.calls.length;
		await vi.advanceTimersByTimeAsync(500);
		expect(h.setTitle).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
		await h.fire("ui_prompt_end");
		expect(vi.getTimerCount()).toBe(1);
		h.snapshot("s");
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π : My session · 1 external activity");
		expect(vi.getTimerCount()).toBe(1);
	});

	it("keeps foreign children busy after the final bridge child and detects completion on the title timer", async () => {
		const bus = new Bus();
		const roster = managed(bus);
		const h = create(bus);
		await h.fire("session_start");
		h.snapshot("s", ["1", "Background"]);
		h.snapshot("s");
		expect([...roster.active]).toEqual(["external-child"]);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("π : My session · 1 external activity");
		roster.active.add("another-external");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("2 external activities");
		roster.active.clear(); // Simulate completion without any producer or bus notification.
		await vi.advanceTimersByTimeAsync(100);
		expect(h.setTitle.mock.lastCall?.[0]).toBe("π > My session - /workspace/project");
		expect(vi.getTimerCount()).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not paint idle over foreign activity on shutdown", async () => {
		const bus = new Bus();
		const roster = managed(bus);
		const h = create(bus);
		await h.fire("session_start");
		h.snapshot("s", ["1", "Background"]);
		await h.fire("session_shutdown");
		expect([...roster.active]).toEqual(["external-child"]);
		expect(h.setTitle.mock.lastCall?.[0]).toContain("1 external activity");
		expect(h.setTitle.mock.lastCall?.[0]).not.toContain("π >");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("supplements child-only managed prompts with HTTP, including nested prompts and activity changes", async () => {
		const bus = new Bus();
		const roster = managed(bus, []);
		const h = create(bus);
		const managedHooks = managedReporter(h, roster);
		await h.fire("session_start");
		h.snapshot("s", ["1", "Background"]);
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_start");
		await flush();
		expect(events()).toEqual(["ui_prompt_start"]);
		const paints = h.setTitle.mock.calls.length;
		h.snapshot("s", ["2", "Replacement"]);
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_start", ui_prompt_active: true });
		h.snapshot("s");
		await flush();
		expect(bodies().at(-1).payload.ui_prompt_active).toBe(true);
		expect(h.setTitle).toHaveBeenCalledTimes(paints);
		await h.fire("ui_prompt_end");
		await flush();
		expect(events()).not.toContain("ui_prompt_end");
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_end", ui_prompt_active: false, is_idle: true });
		expect(managedHooks).toEqual([]);
		await h.fire("session_shutdown");
		expect(events().every(event => event.startsWith("ui_prompt_"))).toBe(true);
	});

	it("uses foreign activity in supplemental prompt is_idle and reasserts waiting after managed events", async () => {
		const bus = new Bus();
		const h = create(bus); // Bridge listeners register before the managed receiver.
		const roster = managed(bus);
		const managedHooks = managedReporter(h, roster);
		await h.fire("session_start");
		await h.fire("ui_prompt_start");
		await flush();
		bus.emit("task:subagent:lifecycle", { id: "new-external", status: "started" });
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_start", ui_prompt_active: true });
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_end", is_idle: false });
		expect(managedHooks).toEqual([]);
		expect([...roster.active]).toEqual(["external-child", "new-external"]);
	});

	it("starts supplemental waiting if background work begins under an idle utility prompt", async () => {
		const bus = new Bus();
		const roster = managed(bus, []);
		const h = create(bus);
		managedReporter(h, roster);
		await h.fire("session_start");
		await h.fire("ui_prompt_start");
		expect(fetchMock).not.toHaveBeenCalled();
		h.snapshot("s", ["1", "Background"]);
		await flush();
		expect(events()).toEqual(["ui_prompt_start"]);
		await h.fire("ui_prompt_end");
		await flush();
		expect(bodies().at(-1).payload.is_idle).toBe(false);
	});

	it("leaves root-held prompts to the managed reporter through settlement and final child completion", async () => {
		const bus = new Bus();
		const roster = managed(bus);
		const h = create(bus);
		const managedHooks = managedReporter(h, roster);
		await h.fire("session_start");
		await h.fire("agent_start");
		h.snapshot("s", ["1", "Background"]);
		await h.fire("agent_end");
		await h.fire("agent_settled");
		h.snapshot("s");
		await h.fire("ui_prompt_start");
		bus.emit("task:subagent:lifecycle", { id: "external-child", status: "completed" });
		await flush();
		await h.fire("ui_prompt_end");
		await flush();
		expect(managedHooks).toEqual([
			{ hook_event_name: "agent_start" }, { hook_event_name: "ui_prompt_start" }, { hook_event_name: "ui_prompt_end", is_idle: true },
		]);
		expect(fetchMock).not.toHaveBeenCalled();
		// A later child-only run must no longer inherit that settled root hold.
		h.snapshot("s", ["2", "Later background"]);
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_end");
		await flush();
		expect(events()).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		expect(bodies().at(-1).payload.is_idle).toBe(false);
	});

	it.each([true, false])("releases the root hold between synchronous foreign runs (managed receiver first: %s)", async managedFirst => {
		const bus = new Bus();
		const initial = managedFirst ? managed(bus) : undefined;
		const h = create(bus);
		const roster = initial ?? managed(bus);
		const managedHooks = managedReporter(h, roster);
		await h.fire("session_start");
		await h.fire("agent_start");
		await h.fire("agent_settled");
		bus.emit("task:subagent:lifecycle", { id: "external-child", status: "completed" });
		bus.emit("task:subagent:lifecycle", { id: "later-child", status: "started" });
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_end");
		await flush();
		expect(managedHooks).toEqual([{ hook_event_name: "agent_start" }]);
		expect(events()).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		expect(bodies().at(-1).payload.is_idle).toBe(false);
	});

	it("bounds supplemental prompt delivery and cancels managed shutdown without posting agent_end", async () => {
		fetchMock.mockImplementationOnce(() => new Promise(() => {}));
		const bus = new Bus();
		managed(bus);
		const h = create(bus);
		await h.fire("session_start");
		await h.fire("ui_prompt_start");
		for (let i = 0; i < 100; i++) h.snapshot("s", ["1", `Work ${i}`]);
		await h.fire("ui_prompt_end");
		expect(fetchMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		expect(events()).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).not.toContain("secret-test-token");
		await h.fire("ui_prompt_start");
		await h.fire("session_shutdown");
		expect(events()).not.toContain("agent_end");
		expect(bodies().at(-1).payload).toMatchObject({ hook_event_name: "ui_prompt_end", ui_prompt_active: false, is_idle: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closes an open supplemental prompt as idle when shutdown removes the final bridge child", async () => {
		const bus = new Bus();
		managed(bus, []);
		const h = create(bus);
		await h.fire("session_start");
		h.snapshot("s", ["1", "Background"]);
		await h.fire("ui_prompt_start");
		await flush();
		await h.fire("session_shutdown");
		expect(events()).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		expect(bodies().at(-1).payload).toMatchObject({ ui_prompt_active: false, is_idle: true });
	});
});

describe("transport, shutdown and diagnostics", () => {
	it("reads POSIX/Windows endpoint coordinates on each send including env/version rotation", async () => {
		const path = join(directory, "endpoint.cmd");
		process.env.ORCA_AGENT_HOOK_ENDPOINT = path;
		writeFileSync(path, "set ORCA_AGENT_HOOK_PORT=23456\r\nset ORCA_AGENT_HOOK_TOKEN=file-token\r\nset ORCA_AGENT_HOOK_ENV=first\r\nset ORCA_AGENT_HOOK_VERSION=1\r\n");
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:23456/hook/pi");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty("X-Orca-Agent-Hook-Token", "file-token");
		expect(bodies()[0]).toMatchObject({ env: "first", version: "1", paneKey: "test-pane", payload: { hook_event_name: "agent_start" } });
		writeFileSync(path, "ORCA_AGENT_HOOK_PORT=34567\nORCA_AGENT_HOOK_TOKEN=rotated-token\nORCA_AGENT_HOOK_ENV=second\nORCA_AGENT_HOOK_VERSION=2\n");
		await h.fire("agent_settled");
		await flush();
		expect(fetchMock.mock.lastCall?.[0]).toBe("http://127.0.0.1:34567/hook/pi");
		expect(bodies().at(-1)).toMatchObject({ env: "second", version: "2" });
		expect(fetchMock.mock.lastCall?.[1]?.headers).toHaveProperty("X-Orca-Agent-Hook-Token", "rotated-token");
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("ready (127.0.0.1:34567/hook/pi)");
		expect(h.notify.mock.lastCall?.[0]).not.toContain("token");
	});

	it.each(["0", "65536", "12.5", "1e3", "123/evil", "-1", "123 "])("refuses invalid loopback port %s", port => {
		process.env.ORCA_AGENT_HOOK_PORT = port;
		expect(endpoint()).toBeUndefined();
	});

	it("requires a token and falls back to env for missing endpoint fields/files", async () => {
		process.env.ORCA_AGENT_HOOK_ENDPOINT = join(directory, "missing");
		expect(endpoint()?.port).toBe(12345);
		delete process.env.ORCA_AGENT_HOOK_TOKEN;
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("Last HTTP: endpoint unavailable");
	});

	it("includes only real persisted session metadata and no tool input", async () => {
		const h = create();
		const path = join(directory, "session.jsonl");
		Object.assign(h.context.sessionManager, { getSessionFile: () => path });
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		expect(bodies()[0].payload.session_file).toBeUndefined();
		writeFileSync(path, "{}\n");
		await h.fire("tool_execution_start", { toolName: "bash", args: { command: "PRIVATE" } });
		await h.fire("agent_settled");
		await flush();
		expect(bodies().at(-1).payload).toMatchObject({ session_file: path, session_id: "session-1" });
		expect(JSON.stringify(bodies())).not.toContain("PRIVATE");
	});

	it("records HTTP and network errors without exception text or credentials", async () => {
		const h = create();
		fetchMock.mockResolvedValueOnce(response(503));
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("HTTP 503 error");
		fetchMock.mockRejectedValueOnce(new Error("secret-test-token private endpoint response"));
		await h.fire("agent_settled");
		await flush();
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("network error");
		expect(h.notify.mock.calls.map(call => call[0]).join("\n")).not.toMatch(/secret-test-token|private endpoint/);
	});

	it("serializes requests, retains only latest pending status, and times out a fetch ignoring abort", async () => {
		fetchMock.mockImplementationOnce(() => new Promise(() => {}));
		const transport = new HookTransport(() => ({}));
		transport.post({ hook_event_name: "agent_start" });
		for (let n = 0; n < 100; n++) transport.post({ hook_event_name: "ui_prompt_start", discarded: n });
		transport.post({ hook_event_name: "ui_prompt_end", is_idle: true });
		expect(fetchMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(999);
		expect(fetchMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(events()).toEqual(["agent_start", "ui_prompt_end"]);
		expect(bodies()[1].payload).not.toHaveProperty("discarded");
		await transport.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves rotated coordinates when a queued post starts, rather than when queued", async () => {
		const path = join(directory, "queued-endpoint.env");
		process.env.ORCA_AGENT_HOOK_ENDPOINT = path;
		writeFileSync(path, "ORCA_AGENT_HOOK_PORT=23456\nORCA_AGENT_HOOK_TOKEN=old\n");
		let acknowledge: (value: Response) => void = () => {};
		fetchMock.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
		const transport = new HookTransport(() => ({}));
		transport.post({ hook_event_name: "agent_start" });
		transport.post({ hook_event_name: "agent_end" });
		writeFileSync(path, "ORCA_AGENT_HOOK_PORT=34567\nORCA_AGENT_HOOK_TOKEN=new\nORCA_AGENT_HOOK_ENV=restarted\n");
		expect(fetchMock).toHaveBeenCalledOnce();
		acknowledge(response());
		await flush();
		expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["http://127.0.0.1:23456/hook/pi", "http://127.0.0.1:34567/hook/pi"]);
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty("X-Orca-Agent-Hook-Token", "new");
		expect(bodies()[1]).toMatchObject({ env: "restarted", payload: { hook_event_name: "agent_end" } });
		await transport.close();
	});

	it("reports timeout with no retry timer", async () => {
		fetchMock.mockImplementation(() => new Promise(() => {}));
		const transport = new HookTransport(() => ({}));
		transport.post({ hook_event_name: "agent_start" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(transport.lastResult).toBe("timeout");
		expect(vi.getTimerCount()).toBe(0);
		await transport.close();
	});

	it("shuts down idempotently, cancels stale posts, bounds final flush and permits clean reload", async () => {
		fetchMock.mockImplementation(() => new Promise(() => {}));
		const bus = new Bus();
		const h = create(bus);
		await h.fire("session_start");
		await h.fire("agent_start");
		await h.fire("ui_prompt_start"); // pending obsolete prompt
		const shutdownHandler = [...h.handlers.get("session_shutdown")!][0]!;
		const first = shutdownHandler({}, h.context);
		const second = shutdownHandler({}, h.context);
		expect(first).toBe(second);
		await flush();
		expect(events()).toEqual(["agent_start", "agent_end"]);
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(bodies().at(-1).payload.session_boundary).toBe(true);
		expect(bus.listeners.get("pi-extensions:activity")?.size).toBe(0);
		expect([...h.handlers.values()].every(set => set.size === 0)).toBe(true);
		expect(h.setTitle.mock.lastCall?.[0]).toBe("π > My session - /workspace/project");
		const titleCalls = h.setTitle.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		await first;
		expect(vi.getTimerCount()).toBe(0);
		expect(process.env.ORCA_PI_STATUS_OWNED).toBeUndefined();
		expect(Reflect.get(globalThis, registryKey)).toBeUndefined();
		await h.status();
		expect(h.notify.mock.lastCall?.[0]).toContain("Main: 0; background: 0; prompts: 0");
		h.snapshot("s", ["late", "Late"]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.setTitle).toHaveBeenCalledTimes(titleCalls);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		fetchMock.mockResolvedValue(response());
		const reloaded = create(bus);
		await reloaded.fire("session_start");
		reloaded.snapshot("s", ["new", "New"]);
		await flush();
		expect(events()).toEqual(["agent_start", "agent_end", "agent_start"]);
	});

	it("flushes completion even when shutdown interrupts the normal final post", async () => {
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await flush();
		fetchMock.mockImplementationOnce(() => new Promise(() => {}));
		await h.fire("agent_settled");
		await h.fire("session_shutdown");
		expect(events()).toEqual(["agent_start", "agent_end", "agent_end"]);
		expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
		expect(bodies().at(-1).payload.session_boundary).toBe(true);
	});
});
