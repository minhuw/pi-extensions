import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { inspectCapabilities, registerCapabilities } from "../src/capabilities.ts";

it("reinspects dynamic tool metadata, retains unknown states and makes no credential or service calls", () => {
	let tools = [{ name: "codemode", description: "Execute scripts and discover available models" }];
	let active = ["codemode"];
	const pi = { getAllTools: () => tools, getActiveTools: () => active } as unknown as ExtensionAPI;
	const credentials = vi.fn(() => { throw new Error("must not inspect credentials"); });
	const ctx = { tools: [], hasUI: false, executeTool: credentials, modelRegistry: { getApiKey: credentials } } as unknown as ExtensionToolContext;
	const initial = inspectCapabilities(pi, ctx);
	expect(initial.image.state).toBe("unknown");
	expect(initial.browser.state).toBe("unknown");
	expect(initial.desktop.state).toBe("unknown");
	expect(initial.discovery).toEqual([{ name: "codemode", active: true, callable: false }]);
	expect(initial.guidance.join("\n")).toContain("missing engine API key does not establish native image unavailability");
	tools = [...tools, { name: "native_image", description: "Generate images from text or edit a reference image" }, { name: "mcp_browser", description: "Capture browser screenshots" }];
	active = [...active, "native_image", "Agent"];
	const updated = inspectCapabilities(pi, { ...ctx, hasUI: true, tools: [{ name: "native_image" }, { name: "Agent" }] } as never);
	expect(updated.image).toEqual({ state: "candidate", candidates: [{ name: "native_image", active: true, callable: true }] });
	expect(updated.browser).toEqual({ state: "candidate", candidates: [{ name: "mcp_browser", active: false, callable: false }] });
	expect(updated.desktop).toEqual({ state: "unknown", candidates: [] });
	expect(updated.delegation).toContain("callable Agent");
	expect(updated.questions).toContain("TUI/RPC");
	tools = [];
	expect(inspectCapabilities(pi, ctx).image.state).toBe("unknown");
	expect(credentials).not.toHaveBeenCalled();
});

it("classifies agent_desktop in desktop rather than browser while keeping agent_browser in browser", async () => {
	const agentDesktopTool = {
		name: "agent_desktop",
		description:
			"Run the agent-desktop CLI directly (no shell) to drive native desktop applications headlessly via OS accessibility trees: inspect compact accessibility-tree snapshots with @snapshot:eN element refs, click/type/interact with controls without moving the real cursor, capture inline screenshot images, and manage isolated desktop sessions. Physical cursor/keyboard subcommands require headed: true.",
	};
	const agentBrowserTool = {
		name: "agent_browser",
		description:
			"Run the agent-browser CLI directly (no shell) to drive an isolated headless or headed Chrome/Chromium browser over CDP: open pages, inspect compact accessibility-tree snapshots with @eN element refs, click/fill/interact with elements, capture inline screenshot images, and close the browser session.",
	};
	const playwrightDesktopViewportTool = {
		name: "playwright_capture",
		description: "Capture desktop and mobile viewport screenshots in Playwright",
	};
	const computerUseTool = {
		name: "computer_use",
		description: "Drive native desktop GUI controls and capture screenshots",
	};

	const ctx = {
		tools: [{ name: "agent_desktop" }, { name: "agent_browser" }],
		hasUI: true,
		executeTool: undefined,
	} as unknown as ExtensionToolContext;

	// With only agent_desktop registered, desktop is candidate and browser stays unknown despite "screenshot" in description.
	const desktopOnlyPi = {
		getAllTools: () => [agentDesktopTool],
		getActiveTools: () => ["agent_desktop"],
	} as unknown as ExtensionAPI;
	const desktopOnly = inspectCapabilities(desktopOnlyPi, ctx);
	expect(desktopOnly.desktop).toEqual({
		state: "candidate",
		candidates: [{ name: "agent_desktop", active: true, callable: true }],
	});
	expect(desktopOnly.browser).toEqual({ state: "unknown", candidates: [] });

	// With both browser and desktop tools registered, buckets stay cleanly separated.
	const combinedPi = {
		getAllTools: () => [agentDesktopTool, agentBrowserTool, playwrightDesktopViewportTool, computerUseTool],
		getActiveTools: () => ["agent_desktop", "agent_browser"],
	} as unknown as ExtensionAPI;
	const combined = inspectCapabilities(combinedPi, ctx);
	expect(combined.desktop).toEqual({
		state: "candidate",
		candidates: [
			{ name: "agent_desktop", active: true, callable: true },
			{ name: "computer_use", active: false, callable: false },
		],
	});
	expect(combined.browser).toEqual({
		state: "candidate",
		candidates: [
			{ name: "agent_browser", active: true, callable: true },
			{ name: "playwright_capture", active: false, callable: false },
		],
	});

	// Tool registration enumerates desktop in its description and returns the desktop bucket in JSON output/details.
	let registeredTool: {
		name: string;
		description: string;
		execute: (id: string, params: unknown, signal: unknown, update: unknown, toolCtx: ExtensionToolContext) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	} | undefined;
	registerCapabilities({
		...combinedPi,
		registerTool: (tool: typeof registeredTool) => {
			registeredTool = tool;
		},
	} as unknown as ExtensionAPI);
	expect(registeredTool?.name).toBe("impeccable_capabilities");
	expect(registeredTool?.description).toContain("desktop");
	const result = await registeredTool!.execute("call-1", {}, undefined, undefined, ctx);
	const parsed = JSON.parse(result.content[0]!.text);
	expect(parsed.desktop).toEqual(combined.desktop);
	expect(parsed.browser).toEqual(combined.browser);
	expect(result.details).toEqual(combined);
});
