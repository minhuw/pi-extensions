import type { ComponentType } from "react";
import type { IconName } from "../../components/icons";
import type { ToolCall } from "../../lib/types";
import { AgentTool, GenericTool } from "./agent";
import { BashTool } from "./bash";
import { CodemodeTool, EditTool, ReadTool, toolPath, WriteTool } from "./files";
import { argString, type ToolRenderProps } from "./shared";
import { WebTool } from "./web";

export interface ToolName {
	/** The name as called, e.g. `mcp__exa__web_search_exa`. */
	full: string;
	/** The tool's own name without an MCP prefix, e.g. `web_search_exa`. */
	base: string;
	/** The MCP server for `mcp__<server>__<tool>` names. */
	server?: string;
}

export function parseToolName(name: string): ToolName {
	const match = /^mcp__(.+?)__(.+)$/.exec(name);
	if (match) return { full: name, base: match[2], server: match[1] };
	return { full: name, base: name };
}

export interface ToolRenderer {
	id: string;
	icon: IconName;
	match: (name: ToolName) => boolean;
	/** Short text beside the tool name in the header. */
	summary?: (call: ToolCall) => string | undefined;
	/** Set when the component shows error results itself instead of the generic error callout. */
	handlesErrors?: boolean;
	Component: ComponentType<ToolRenderProps>;
}

const WEB_TOOLS = new Set(["web_search", "web_fetch", "fetch_content", "websearch", "webfetch"]);
const MCP_WEB_SERVER = /web|search|fetch|crawl|scrape|browse|exa|tavily|brave|firecrawl|perplexity|jina|serp/i;
const MCP_WEB_TOOL = /(^|_)web(_|$)|search|fetch|crawl|scrape|browse|url/i;

function is(...names: string[]) {
	const set = new Set(names);
	return (name: ToolName) => set.has(name.base.toLowerCase());
}

const builtins: ToolRenderer[] = [
	{
		id: "bash",
		icon: "terminal",
		match: is("bash", "shell", "powershell"),
		summary: (call) => argString(call, "command", "cmd")?.split("\n")[0],
		handlesErrors: true,
		Component: BashTool,
	},
	{ id: "read", icon: "file", match: is("read"), summary: toolPath, Component: ReadTool },
	{ id: "edit", icon: "pencil", match: is("edit"), summary: toolPath, Component: EditTool },
	{ id: "write", icon: "pencil", match: is("write"), summary: toolPath, Component: WriteTool },
	{ id: "codemode", icon: "code", match: is("codemode"), Component: CodemodeTool },
	{
		id: "web",
		icon: "globe",
		match: (name) =>
			WEB_TOOLS.has(name.base.toLowerCase()) ||
			(name.server !== undefined && (MCP_WEB_SERVER.test(name.server) || MCP_WEB_TOOL.test(name.base))),
		summary: (call) => argString(call, "query", "q", "url"),
		Component: WebTool,
	},
	{
		id: "agent",
		icon: "agent",
		match: (name) => name.server === undefined && name.base === "Agent",
		summary: (call) => argString(call, "description"),
		Component: AgentTool,
	},
];

const fallback: ToolRenderer = { id: "generic", icon: "tool", match: () => true, Component: GenericTool };

const registered: ToolRenderer[] = [];

/** Adds a renderer that takes precedence over the built-in ones. */
export function registerToolRenderer(renderer: ToolRenderer): () => void {
	registered.unshift(renderer);
	return () => {
		const index = registered.indexOf(renderer);
		if (index >= 0) registered.splice(index, 1);
	};
}

export function findToolRenderer(name: string): ToolRenderer {
	const parsed = parseToolName(name);
	return registered.find((r) => r.match(parsed)) ?? builtins.find((r) => r.match(parsed)) ?? fallback;
}
