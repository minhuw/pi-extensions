import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import statuslineFooter from "../index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type FooterComponent = { dispose?: () => void };

function createHarness(sessionId: string, mode: "tui" | "print") {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const notifications: string[] = [];
	const requestRender = vi.fn();
	let footer: FooterComponent | undefined;

	const tui = { requestRender };
	const footerData = {
		onBranchChange: () => vi.fn(),
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
	};
	const theme = {};

	const ui = {
		setFooter: vi.fn((factory: unknown) => {
			footer?.dispose?.();
			footer = typeof factory === "function"
				? (factory as (tui: unknown, theme: unknown, footerData: unknown) => FooterComponent)(
						tui,
						theme,
						footerData,
					)
				: undefined;
		}),
		notify: vi.fn((message: string) => notifications.push(message)),
	};

	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: process.cwd(),
		sessionManager: {
			getSessionId: () => sessionId,
		},
		ui,
	} as unknown as ExtensionContext;

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		notifications,
		requestRender,
		getFooter: () => footer,
		async emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		async runCommand(name: string, args: string) {
			const command = commands.get(name);
			if (!command) throw new Error(`Command not registered: ${name}`);
			await command.handler(args, ctx);
		},
	};
}

function assistantEnd(output: number) {
	return {
		message: {
			role: "assistant",
			usage: { output },
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("statusline footer session isolation", () => {
	it("ignores overlapping pi-subagents streams and shutdowns", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const root = createHarness("root-session", "tui");
		const child = createHarness("child-session", "print");
		statuslineFooter(root.pi);
		statuslineFooter(child.pi);

		await root.emit("session_start", { type: "session_start", reason: "startup" });
		expect(root.getFooter()).toBeDefined();

		now = 1_000;
		await root.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_200;
		await root.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "root" },
		});

		await child.emit("session_start", { type: "session_start", reason: "startup" });
		now = 1_300;
		await child.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_800;
		await child.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "child" },
		});
		now = 1_900;
		await child.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		now = 2_200;
		await root.emit("message_end", assistantEnd(10));
		await root.runCommand("footer", "debug");

		const debug = root.notifications.at(-1);
		expect(debug).toContain("requests=1");
		expect(debug).toContain("avgTtft=200");
		expect(debug).toContain("lastTtft=200");
		expect(debug).toContain("lastTok/s=10.0");
		expect(root.requestRender).toHaveBeenCalledTimes(1);

		root.getFooter()?.dispose?.();
		await root.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	it("preserves streaming metrics across reload", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const beforeReload = createHarness("reload-session", "tui");
		statuslineFooter(beforeReload.pi);
		await beforeReload.emit("session_start", { type: "session_start", reason: "startup" });

		now = 5_000;
		await beforeReload.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 5_250;
		await beforeReload.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		now = 6_250;
		await beforeReload.emit("message_end", assistantEnd(20));
		beforeReload.getFooter()?.dispose?.();
		await beforeReload.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

		const afterReload = createHarness("reload-session", "tui");
		statuslineFooter(afterReload.pi);
		await afterReload.emit("session_start", { type: "session_start", reason: "reload" });
		await afterReload.runCommand("footer", "debug");

		const debug = afterReload.notifications.at(-1);
		expect(debug).toContain("requests=1");
		expect(debug).toContain("avgTtft=250");
		expect(debug).toContain("lastTok/s=20.0");

		afterReload.getFooter()?.dispose?.();
		await afterReload.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
