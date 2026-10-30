import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Metadata only: no model requests, environment inspection, or credential lookup. */
export function inspectCapabilities(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">, ctx: Pick<ExtensionToolContext, "tools" | "executeTool" | "hasUI">) {
	const active = new Set(pi.getActiveTools());
	const callable = new Set(ctx.tools?.map((tool) => tool.name) ?? []);
	const tools = pi.getAllTools().filter((tool) => !tool.name.startsWith("impeccable_"));
	const candidates = (pattern: RegExp) => tools.filter((tool) => pattern.test(`${tool.name} ${tool.description}`)).map((tool) => ({
		name: tool.name, active: active.has(tool.name), callable: callable.has(tool.name),
	}));
	const image = candidates(/image.?gen|generat\w*[^.\n]{0,40}image|image[^.\n]{0,40}generat|text.to.image/i);
	const browser = candidates(/browser|playwright|puppeteer|screenshot|cdp/i);
	const discovery = candidates(/codemode|tool_search|search_tools|list_models/i);
	return {
		questions: ctx.hasUI ? "dialogs available (TUI/RPC)" : "unavailable: ask in chat and wait",
		delegation: typeof ctx.executeTool === "function" && callable.has("Agent") ? "callable Agent; type/configuration availability must be checked in its result" : active.has("Agent") ? "main-session Agent handoff required" : "Agent unavailable; disclose upstream inline fallback",
		image: { state: image.length ? "candidate" : "unknown", candidates: image },
		browser: { state: browser.length ? "candidate" : "unknown", candidates: browser },
		discovery,
		guidance: [
			"Candidates come from tool metadata, not a successful operation. Inspect the current tool schemas/help to establish support, permissions, input images, output files, and browser mutation. Reinspect after tools change.",
			"Codemode can expose image models indirectly: inspect its model/tool discovery and help before declaring native image generation unavailable. Unknown does not mean absent.",
			"Prefer available native image generation/editing. Engine context reports only the generate-image API fallback prerequisites; a missing engine API key does not establish native image unavailability. Never read or print personal credential values.",
			"Retain generate-image fallback, image prompt sidecars, catalog QUALITY BAR references, and serve-question direction boards. If a visual step cannot run, report the concrete blocker and the playbook's supported fallback; skipped is not verified success.",
			"Browser inspection needs an actual successful capture; injection needs mutable evaluation. Native iOS/Android/adaptive targets use device captures and platform references, never the web detector or overlay.",
		],
	};
}

export function registerCapabilities(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "impeccable_capabilities", label: "Impeccable Capabilities",
		description: "Inspect current tool metadata for image/browser candidates, discovery, questions, and Agent availability. Reports unknowns; never probes credentials or calls visual services.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_id, _params, _signal, _update, ctx) {
			const report = inspectCapabilities(pi, ctx);
			return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
		},
	});
}
