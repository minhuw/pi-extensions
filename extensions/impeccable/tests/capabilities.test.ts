import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { inspectCapabilities } from "../src/capabilities.ts";

it("reinspects dynamic tool metadata, retains unknown states and makes no credential or service calls", () => {
	let tools = [{ name: "codemode", description: "Execute scripts and discover available models" }];
	let active = ["codemode"];
	const pi = { getAllTools: () => tools, getActiveTools: () => active } as unknown as ExtensionAPI;
	const credentials = vi.fn(() => { throw new Error("must not inspect credentials"); });
	const ctx = { tools: [], hasUI: false, executeTool: credentials, modelRegistry: { getApiKey: credentials } } as unknown as ExtensionToolContext;
	const initial = inspectCapabilities(pi, ctx);
	expect(initial.image.state).toBe("unknown");
	expect(initial.browser.state).toBe("unknown");
	expect(initial.discovery).toEqual([{ name: "codemode", active: true, callable: false }]);
	expect(initial.guidance.join("\n")).toContain("missing engine API key does not establish native image unavailability");
	tools = [...tools, { name: "native_image", description: "Generate images from text or edit a reference image" }, { name: "mcp_browser", description: "Capture browser screenshots" }];
	active = [...active, "native_image", "Agent"];
	const updated = inspectCapabilities(pi, { ...ctx, hasUI: true, tools: [{ name: "native_image" }, { name: "Agent" }] } as never);
	expect(updated.image).toEqual({ state: "candidate", candidates: [{ name: "native_image", active: true, callable: true }] });
	expect(updated.browser).toEqual({ state: "candidate", candidates: [{ name: "mcp_browser", active: false, callable: false }] });
	expect(updated.delegation).toContain("callable Agent");
	expect(updated.questions).toContain("TUI/RPC");
	tools = [];
	expect(inspectCapabilities(pi, ctx).image.state).toBe("unknown");
	expect(credentials).not.toHaveBeenCalled();
});
