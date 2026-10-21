import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import footerExtension from "../../statusline-footer/index.ts";
import extension from "../index.ts";
import { change, renderReport, restoreReport, SNAPSHOT, summary, updateReport, type Update } from "../report.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const baseline: Update = {
	phase: "measuring", message: "Testing cached lookups.", metrics: [
		{ name: "lookup", label: "Lookup", unit: "ms", direction: "lower", baseline: 213, value: 182 },
		{ name: "memory", label: "Memory", unit: "MB", direction: "lower", role: "constraint", baseline: 94, value: 96 },
	],
};
function first() { return updateReport(null, baseline, "report-1", 1); }

it("keeps definitions and baselines stable across partial metric updates, and labels unverified numbers", () => {
	const initial = first();
	const next = updateReport(initial, { phase: "checking", message: "Checking memory usage.", metrics: [{ name: "memory", value: 95 }] }, "unused", 2);
	expect(next.id).toBe(initial.id);
	expect(next.metrics[0]).toEqual(initial.metrics[0]);
	expect(next.metrics[1]).toMatchObject({ value: 95, baseline: 94, role: "constraint" });
	expect(initial.metrics[1]!.value).toBe(96);
	expect(renderReport(next)).toContain("model-reported");
	expect(summary(next)).toContain("Lookup 182 ms (-14.554%)");
	expect(renderReport(next)).toContain("| Memory | constraint | lower | 94 MB | 95 MB | +1.06383% |");
});

it("registers metrics without measurements and establishes the baseline on the first value", () => {
	const planning = updateReport(null, { phase: "planning", message: "Preparing a baseline." }, "report-2", 1);
	const registered = updateReport(planning, { phase: "measuring", message: "Running baseline.", metrics: [{ name: "score", direction: "higher" }] }, "unused", 2);
	expect(summary(registered)).toContain("score —");
	const measured = updateReport(registered, { phase: "checking", message: "Baseline collected.", metrics: [{ name: "score", value: 0 }] }, "unused", 3);
	expect(measured.metrics[0]).toMatchObject({ baseline: 0, value: 0 });
});

it.each([
	{ metrics: [{ name: "lookup", direction: "higher" }] },
	{ metrics: [{ name: "lookup", unit: "s" }] },
	{ metrics: [{ name: "lookup", baseline: 100 }] },
	{ metrics: [{ name: "lookup", role: "constraint" }] },
	{ metrics: [{ name: "other", value: 1 }] },
	{ metrics: [{ name: "lookup", value: 1 }, { name: "lookup", value: 2 }] },
	{ metrics: [{ name: "lookup", value: Infinity }] },
	{ metrics: [{ name: "lookup", value: NaN }] },
	{ message: "fake\x1b[31m" },
	{ message: "two\nlines" },
])("rejects invalid or incomparable updates atomically: %j", input => {
	const previous = first(); const original = structuredClone(previous);
	expect(() => updateReport(previous, { phase: "measuring", message: "Update", ...input } as Update, "unused", 2)).toThrow();
	expect(previous).toEqual(original);
});

it("requires exactly one objective and complete initial definitions", () => {
	for (const metrics of [
		[{ name: "x" }],
		[{ name: "x", direction: "lower", role: "constraint" }],
		[{ name: "x", direction: "lower", role: "objective" }, { name: "y", direction: "higher", role: "objective" }],
	]) expect(() => updateReport(null, { phase: "planning", message: "Start", metrics } as Update, "r", 1)).toThrow();
});

it("handles zero, negative and overflowing baselines without inventing relative improvement", () => {
	const metric = first().metrics[0]!;
	expect(change({ ...metric, baseline: 0, value: 2 })).toBe("+2 ms (absolute)");
	expect(change({ ...metric, baseline: -10, value: -5 })).toBe("+50%");
	expect(change({ ...metric, baseline: 0, value: 0 })).toBe("0%");
	expect(change({ ...metric, baseline: -Number.MAX_VALUE, value: Number.MAX_VALUE })).toBe("—");
});

it("validates durable snapshots and escapes metric table cells", () => {
	expect(restoreReport({ version: 1, report: first() })).toEqual(first());
	expect(restoreReport({ version: 1, report: null })).toBeNull();
	for (const data of [{ version: 2, report: first() }, { version: 1 }, { version: 1, report: { ...first(), metrics: [{ name: "broken" }] } }]) {
		expect(() => restoreReport(data)).toThrow();
	}
	const report = first(); report.metrics[0]!.label = "Lookup | <x>";
	expect(renderReport(report)).toContain("Lookup \\| &lt;x&gt;");
});

function harness(mode: "tui" | "rpc" | "print" = "tui") {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, any>(); const commands = new Map<string, any>();
	const entries: any[] = []; const statuses = new Map<string, string>(); const displays: any[] = [];
	let sessionId = "owner";
	let branch = entries;
	let footer: { render(width: number): string[]; dispose(): void } | undefined;
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) })),
		sendMessage: vi.fn((message: any) => displays.push(message)),
	} as unknown as ExtensionAPI;
	const ctx = {
		mode, hasUI: mode !== "print", cwd: process.cwd(), model: { id: "test-model", provider: "test", reasoning: false },
		isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 25, tokens: 2500, contextWindow: 10_000 }),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => entries, getLeafId: () => `${branch.length}` },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn((key: string, value?: string) => value ? statuses.set(key, value) : statuses.delete(key)),
			setFooter: (factory: any) => {
				footer?.dispose();
				footer = factory?.({ requestRender: vi.fn() }, { fg: (_token: string, text: string) => text, bold: (text: string) => text }, {
					onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => statuses,
				});
			},
		},
	} as unknown as ExtensionContext;
	extension(pi);
	return {
		pi, ctx, entries, statuses, displays, tools, commands,
		setBranch: (next: any[]) => { branch = next; },
		setSession: (id: string) => { sessionId = id; },
		getFooter: () => footer,
		emit: async (name: string, event: unknown = {}, context = ctx) => { for (const handler of handlers.get(name) ?? []) await handler(event, context); },
		update: (params: Update, context = ctx) => tools.get("autoresearch_update").execute("call", params, undefined, undefined, context),
		command: (args: string) => commands.get("research-report").handler(args, ctx),
	};
}

it("persists reports, restores as paused, clears durably, and follows the selected conversation branch", async () => {
	const h = harness(); await h.emit("session_start");
	await h.update(baseline);
	const original = structuredClone(h.entries);
	await h.command("results");
	expect(h.displays[0].content).toContain("Testing cached lookups.");
	expect(h.displays[0].content).toContain("| Metric |");
	expect(h.pi.sendMessage).toHaveBeenLastCalledWith(expect.anything(), { triggerTurn: false });
	await h.emit("session_start", { reason: "reload" });
	expect(h.statuses.get("autoresearch")).toContain("paused");
	await h.command("clear");
	expect(h.statuses.has("autoresearch")).toBe(false);
	await h.emit("session_start", { reason: "reload" });
	expect(h.statuses.has("autoresearch")).toBe(false);
	h.setBranch(original); await h.emit("session_tree");
	expect(h.statuses.get("autoresearch")).toContain("Lookup");
	h.setBranch([]); await h.emit("session_tree");
	expect(h.statuses.has("autoresearch")).toBe(false);
	await h.update({ phase: "planning", message: "A different objective.", metrics: [{ name: "accuracy", direction: "higher" }] });
});

it("preserves completed phase and fails closed on a corrupt latest snapshot", async () => {
	const h = harness(); await h.emit("session_start");
	await h.update({ ...baseline, phase: "complete" });
	await h.emit("session_start"); expect(h.statuses.get("autoresearch")).toContain("complete");
	h.entries.push({ type: "custom", customType: SNAPSHOT, data: { version: 999 } });
	await h.emit("session_start"); expect(h.statuses.has("autoresearch")).toBe(false);
	await expect(h.update(baseline)).rejects.toThrow("invalid");
	await h.command("clear"); await h.update(baseline);
	expect(h.statuses.get("autoresearch")).toContain("measuring");
});

it("does not publish failed persistence or invalid updates", async () => {
	const h = harness(); await h.emit("session_start"); await h.update(baseline);
	const before = h.statuses.get("autoresearch"); const count = h.entries.length;
	await expect(h.update({ phase: "editing", message: "Oops", metrics: [{ name: "unknown", value: 99 }] })).rejects.toThrow();
	expect(h.entries).toHaveLength(count);
	vi.mocked(h.pi.appendEntry).mockImplementationOnce(() => { throw new Error("disk full"); });
	await expect(h.update({ phase: "editing", message: "Not saved" })).rejects.toThrow("disk full");
	expect(h.statuses.get("autoresearch")).toBe(before);
	await h.command("status"); expect(h.displays[0].content).toContain("Testing cached lookups.");
});

it.each(["update", "clear"])("rolls back a failed %s after real Pi has already advanced its in-memory branch", async action => {
	const h = harness();
	const manager = SessionManager.inMemory(process.cwd());
	Object.assign(h.ctx, { sessionManager: manager });
	vi.mocked(h.pi.appendEntry).mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
	await h.emit("session_start"); await h.update(baseline);
	const previousLeaf = manager.getLeafId();
	const persist = vi.spyOn(manager as unknown as { _persist(entry: unknown): void }, "_persist");
	try {
		persist.mockImplementationOnce(() => { throw new Error("disk full"); });
		await expect(action === "clear" ? h.command("clear") : h.update({ phase: "checking", message: "Unsaved result", metrics: [{ name: "lookup", value: 1 }] })).rejects.toThrow("disk full");
		expect(manager.getLeafId()).not.toBe(previousLeaf);
		await h.emit("session_start", { reason: "reload" });
		expect(h.statuses.get("autoresearch")).toContain("Lookup 182 ms");
		await h.command("results");
		expect(h.displays.at(-1).content).toContain("Testing cached lookups.");
		await expect(h.update({ phase: "planning", message: "Changed objective", metrics: [{ name: "other", direction: "higher" }] })).rejects.toThrow("Unknown metric");
	} finally { persist.mockRestore(); }
});

it("isolates child sessions and supports headless reporting without changing the parent's UI", async () => {
	const h = harness(); await h.emit("session_start"); await h.update(baseline);
	const ownerStatus = h.statuses.get("autoresearch");
	const child = { ...h.ctx, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "child", getBranch: () => [] } } as unknown as ExtensionContext;
	await h.emit("session_start", {}, child);
	const result = await h.update({ phase: "planning", message: "Child report" }, child);
	expect(result.details.report.message).toBe("Child report");
	expect(h.statuses.get("autoresearch")).toBe(ownerStatus);
	await h.emit("session_shutdown", {}, child);
	expect(h.statuses.get("autoresearch")).toBe(ownerStatus);
	await h.emit("session_shutdown"); expect(h.statuses.has("autoresearch")).toBe(false);
});

it.each(["tui", "rpc", "print"] as const)("registers native commands and reports in %s mode", async mode => {
	const h = harness(mode); await h.emit("session_start");
	expect(h.commands.has("autoresearch")).toBe(true);
	await h.update(baseline);
	expect(h.ctx.ui.setStatus).toHaveBeenCalledTimes(mode === "print" ? 0 : 2);
	await h.command("help");
	await expect(h.command("surprise")).rejects.toThrow("Usage");
});

it("renders research and Loop together in full mode, prioritizes research in compact mode, and falls back after clear", async () => {
	const h = harness();
	footerExtension(h.pi);
	await h.emit("session_start", { reason: "startup" });
	h.statuses.set("loop", "↻ build · next 4m");
	await h.update(baseline);
	try {
		for (const mode of ["full", "compact"]) {
			await h.commands.get("footer").handler(mode, h.ctx);
			const rendered = h.getFooter()!.render(220).join("\n");
			expect(rendered).toContain("research · measuring · reported");
			expect(rendered.split("research · measuring")).toHaveLength(2);
			if (mode === "full") expect(rendered).toContain("↻ build");
			else expect(rendered).not.toContain("↻ build");
			for (const width of [0, 1, 24, 40, 80, 120]) {
				const lines = h.getFooter()!.render(width);
				for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				if (width >= 40) { expect(lines[0]).toContain("test-model"); expect(lines[0]).toContain("25.0%"); }
			}
		}
		await h.command("clear");
		expect(h.getFooter()!.render(220).join("\n")).toContain("↻ build");
		expect(h.getFooter()!.render(220).join("\n")).not.toContain("research ·");
	} finally { h.getFooter()?.dispose(); await h.emit("session_shutdown", { reason: "quit" }); }
});
