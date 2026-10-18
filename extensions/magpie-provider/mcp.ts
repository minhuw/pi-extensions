import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

export const MAGPIE_SEARCH_SERVER = "magpie-web-search";
export interface MagpieSearchConnection { origin: string; apiKey: string }

/** Accepts a validated gateway connection; credentials stay in the runtime registration only. */
export function magpieSearchConfig(connection: MagpieSearchConnection): McpServerConfig {
	const authorization = `Bearer ${connection.apiKey}`;
	try { new Headers({ Authorization: authorization }); }
	catch { throw new Error("Magpie MCP authorization header is invalid; check the saved API key."); }
	return {
		url: `${connection.origin}/mcp/magpie/web-search`,
		// Native config values expand $ templates. Keep this key literal and paired with its origin,
		// rather than resolving the provider's latest key for requests to an old connection.
		headers: { Authorization: authorization.replaceAll("$", "$$$$") },
		exposure: "hidden",
		toolExposure: { web_search: "direct", web_fetch: "direct" },
	};
}
