import { readFile } from "node:fs/promises";
import path from "node:path";
import { createMcpExtension, getAgentDir, type ExtensionAPI, type ExtensionFactory, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { MAGPIE_SEARCH_SERVER } from "../../magpie-provider/mcp.ts";

export { MAGPIE_SEARCH_SERVER };
export const MAGPIE_SEARCH_TOOLS = [
	"mcp__magpie_web_search__web_search",
	"mcp__magpie_web_search__web_fetch",
] as const;
export const SEARCHER_TOOLS = [...MAGPIE_SEARCH_TOOLS, "find", "grep"] as const;

export function isHttpUrlWithoutCredentials(value: unknown): value is string {
	if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** User configuration wins over the host's exact registration; no ambient servers are loaded. */
export function createMagpieSearchExtension(agentDir: string, registeredConfig?: () => McpServerConfig | undefined): ExtensionFactory {
	return async (pi) => {
		// SDK sessions do not inherit the CLI's MCP switch. Honour it before reading or connecting.
		const args = process.argv.slice(2);
		if (args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--no-mcp")) {
			throw new Error("Herder Searcher requires MCP; remove --no-mcp to enable magpie-web-search.");
		}
		const file = path.join(agentDir, "mcp.json");
		const fail = (reason: string): never => {
			throw new Error(`Herder Searcher: ${reason}. Use /login magpie with the Magpie provider loaded, or configure the enabled HTTP(S) server "${MAGPIE_SEARCH_SERVER}" in ${file}; no other server is used.`);
		};
		let raw: unknown = {};
		try {
			raw = JSON.parse(await readFile(file, "utf8"));
		} catch (error) {
			// Only a missing file permits auto-registration; malformed/unreadable files fail closed.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("cannot read valid user MCP JSON");
		}
		const root = object(raw);
		const servers = object(root?.mcpServers);
		if (!root || (root.mcpServers !== undefined && !servers)) return fail("missing or invalid selected server entry");
		if (servers && Object.keys(servers).some((name) => name !== MAGPIE_SEARCH_SERVER && name.replaceAll("-", "_") === MAGPIE_SEARCH_SERVER.replaceAll("-", "_"))) {
			return fail("use the exact selected server name, not a colliding alias");
		}
		let selected: Record<string, unknown> | undefined;
		try {
			selected = object(servers && Object.hasOwn(servers, MAGPIE_SEARCH_SERVER) ? servers[MAGPIE_SEARCH_SERVER] : registeredConfig?.());
		} catch {
			return fail("cannot read the host's registered Magpie server");
		}
		if (!selected) return fail("missing or invalid selected server entry");
		if (selected.enabled === false) return fail("selected server is disabled");
		if ("command" in selected || (selected.type !== undefined && selected.type !== "http" && selected.type !== "streamable-http")) {
			return fail("selected server must use HTTP, not stdio or a command");
		}
		if (!isHttpUrlWithoutCredentials(selected.url)) return fail("selected server requires a valid HTTP(S) URL without embedded credentials");
		try {
			// registerMcpServer performs the public SDK's schema validation on this raw entry.
			pi.registerMcpServer(MAGPIE_SEARCH_SERVER, {
				...selected,
				url: selected.url,
				exposure: "hidden",
				toolExposure: { web_search: "direct", web_fetch: "direct" },
			} as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
		} catch {
			return fail("selected server configuration failed Pi MCP validation; check its field types and authentication settings");
		}
		// shortcut: custom-directory OAuth is refused until Pi exports a scoped credential store.
		// Match native Authorization-key presence semantics; provider auth is explicit too.
		const explicitAuth = object(selected.auth)?.provider
			|| Object.keys(object(selected.headers) ?? {}).some((key) => key.toLowerCase() === "authorization");
		if (path.resolve(agentDir) !== path.resolve(getAgentDir()) && !explicitAuth) {
			return fail("a custom agent directory requires explicit Authorization header or auth.provider; native OAuth requires the process agent directory");
		}
		await createMcpExtension({
			loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
			logPath: path.join(agentDir, "mcp.log"),
		})(pi);
	};
}
