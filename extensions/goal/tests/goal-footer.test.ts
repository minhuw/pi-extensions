import { stripVTControlCharacters } from "node:util";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import footerExtension from "../../statusline-footer/index.ts";
import goalExtension from "../index.ts";

// Git telemetry is unrelated to the shared status display.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

it("shows an active goal in both footer layouts and updates it when paused", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	const entries: any[] = [];
	let footer: { render(width: number): string[]; dispose(): void } | undefined;
	const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: vi.fn(),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: vi.fn(),
		events: createEventBus(),
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", hasUI: true, cwd: process.cwd(), model: { id: "test-model", provider: "test", reasoning: false },
		isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 25, tokens: 2500, contextWindow: 10_000 }),
		sessionManager: { getSessionId: () => "goal-footer-integration", getEntries: () => entries, getLeafId: () => "leaf", getBranch: () => [] },
		ui: {
			notify: vi.fn(),
			setStatus: (key: string, value?: string) => { if (value) statuses.set(key, value); else statuses.delete(key); },
			setFooter: (factory: any) => {
				footer?.dispose();
				footer = factory?.({ requestRender: vi.fn() }, theme, {
					onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => statuses,
				});
			},
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	const render = async (mode: "full" | "compact", width: number) => {
		await commands.get("footer").handler(mode, ctx);
		const rows = footer!.render(width);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		return stripVTControlCharacters(rows.join("\n"));
	};
	try {
		footerExtension(pi);
		goalExtension(pi);
		await emit("session_start", { reason: "startup" });
		expect(commands.has("goal")).toBe(true);
		await commands.get("goal").handler("Ship the patch", ctx);
		const active = statuses.get("goal");
		expect(active).toBeTruthy();
		ctx.ui.setStatus("autoresearch", "research 2/5");
		ctx.ui.setStatus("herder", "herder ready");
		for (const mode of ["full", "compact"] as const) {
			for (const width of [80, 160]) {
				const output = await render(mode, width);
				expect(output, `${mode} at ${width} columns`).toContain(stripVTControlCharacters(active!));
				if (mode === "full" && width === 160) expect(output).toMatch(/research 2\/5|herder ready/i);
			}
		}
		await commands.get("goal").handler("pause", ctx);
		expect(statuses.get("goal")).not.toBe(active);
		for (const mode of ["full", "compact"] as const) {
			expect(await render(mode, 160)).not.toContain(stripVTControlCharacters(active!));
		}
	} finally {
		await emit("session_shutdown", { reason: "quit" });
		footer?.dispose();
	}
});
