import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import footerExtension from "../../statusline-footer/index.ts";
import loopExtension from "../index.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

it("publishes real loop state to both footer layouts without overflow or stale status", async () => {
	vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	const entries: any[] = [];
	let idle = true;
	let footer: { render: (width: number) => string[]; dispose: () => void } | undefined;
	const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: vi.fn(() => { idle = false; }),
		events: createEventBus(),
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", hasUI: true, cwd: process.cwd(), model: { id: "test-model", provider: "test", reasoning: false },
		isIdle: () => idle, hasPendingMessages: () => false, getContextUsage: () => ({ percent: 25, tokens: 2500, contextWindow: 10_000 }),
		sessionManager: { getSessionId: () => "footer-integration", getEntries: () => entries, getLeafId: () => "leaf", getBranch: () => [] },
		ui: {
			notify: vi.fn(), setStatus: (key: string, value?: string) => { if (value) statuses.set(key, value); else statuses.delete(key); },
			setFooter: (factory: any) => {
				footer?.dispose();
				footer = factory?.({ requestRender: vi.fn() }, theme, {
					onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => statuses,
				});
			},
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	try {
		footerExtension(pi); loopExtension(pi);
		await emit("session_start", { reason: "startup" });
		await commands.get("loop").handler("5m check CI --name build --wait", ctx);
		for (const mode of ["full", "compact"]) {
			await commands.get("footer").handler(mode, ctx);
			expect(footer!.render(160).join("\n")).toContain("↻ build · next 5m");
			for (const width of [0, 1, 12, 24, 40, 80]) {
				for (const row of footer!.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
		await vi.advanceTimersByTimeAsync(300_000);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(footer!.render(160).join("\n")).toContain("↻ build · run 1/25");
		await commands.get("loop").handler("pause build", ctx);
		expect(footer!.render(160).join("\n")).toContain("↻ build · paused");
		await commands.get("loop").handler("stop build", ctx);
		expect(footer!.render(160).join("\n")).not.toContain("↻ build");
	} finally {
		footer?.dispose(); await emit("session_shutdown", { reason: "quit" });
		expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
	}
});
