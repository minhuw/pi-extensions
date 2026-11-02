import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSettings } from "./types.ts";

export const SETTINGS_FILE = "superagent.json";
export const DISABLED_ENV = "PI_SUPERAGENT_DISABLED";
export const DEFAULT_ROUTER_AGENTS: readonly string[] = ["recon", "reviewer", "expert"];
export const DEFAULT_SETTINGS: DispatchSettings = { enabled: true, maxWorkers: 4, routerTools: [], routerAgents: [...DEFAULT_ROUTER_AGENTS], react: "attention", workspace: "worktree" };
const KNOWN = new Set(["enabled", "maxWorkers", "routerTools", "routerAgents", "react", "workspace"]);
/** Settings of earlier versions: the `ticket` agent type's frontmatter decides the model and thinking now. */
const RETIRED: Record<string, string> = {
	workerModel: "set `model` in the `ticket` agent type's frontmatter instead (`/agents`)",
	workerThinking: "set `thinking` in the `ticket` agent type's frontmatter instead (`/agents`)",
};

/** `PI_SUPERAGENT_DISABLED=1`. */
export const disabledByEnv = () => process.env[DISABLED_ENV] === "1";

/**
 * `<agentDir>/superagent.json`; see DESIGN.md "Settings". A missing file gives the defaults. Every invalid value is
 * named in `problems` and ignored; `PI_SUPERAGENT_DISABLED=1` forces `enabled: false`.
 */
export function loadSettings(agentDir: string): { settings: DispatchSettings; problems: string[] } {
	const settings: DispatchSettings = { ...DEFAULT_SETTINGS, routerTools: [], routerAgents: [...DEFAULT_ROUTER_AGENTS] };
	const problems: string[] = [];
	const path = join(agentDir, SETTINGS_FILE);
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path} could not be read: ${(error as Error).message}`);
	}
	if (raw !== undefined) {
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (error) {
			problems.push(`${path} is not valid JSON: ${(error as Error).message}`);
		}
		if (data !== undefined) {
			if (typeof data !== "object" || data === null || Array.isArray(data)) problems.push(`${path} must hold a JSON object`);
			else apply(data as Record<string, unknown>, settings, problems);
		}
	}
	if (disabledByEnv()) settings.enabled = false;
	return { settings, problems: problems.map((problem) => problem.startsWith(path) ? problem : `${path}: ${problem}`) };
}

function apply(data: Record<string, unknown>, settings: DispatchSettings, problems: string[]): void {
	for (const key of Object.keys(data)) {
		if (RETIRED[key]) problems.push(`"${key}" is no longer supported and is ignored: ${RETIRED[key]}`);
		else if (!KNOWN.has(key)) problems.push(`unknown key "${key}" is ignored`);
	}
	const { enabled, maxWorkers, routerTools, routerAgents, react, workspace } = data;
	if (enabled !== undefined) {
		if (typeof enabled === "boolean") settings.enabled = enabled;
		else problems.push(`"enabled" must be true or false, got ${JSON.stringify(enabled)}`);
	}
	if (maxWorkers !== undefined) {
		if (typeof maxWorkers === "number" && Number.isInteger(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 16) settings.maxWorkers = maxWorkers;
		else problems.push(`"maxWorkers" must be an integer from 1 to 16, got ${JSON.stringify(maxWorkers)}`);
	}
	if (routerTools !== undefined) {
		if (Array.isArray(routerTools) && routerTools.every((name) => typeof name === "string" && name.trim())) settings.routerTools = routerTools.map((name: string) => name.trim());
		else problems.push(`"routerTools" must be an array of tool names, got ${JSON.stringify(routerTools)}`);
	}
	if (routerAgents !== undefined) {
		if (Array.isArray(routerAgents) && routerAgents.every((name) => typeof name === "string" && name.trim())) settings.routerAgents = routerAgents.map((name: string) => name.trim());
		else problems.push(`"routerAgents" must be an array of agent type names, got ${JSON.stringify(routerAgents)}`);
	}
	if (react !== undefined) {
		if (react === "attention" || react === "none") settings.react = react;
		else problems.push(`"react" must be "attention" or "none", got ${JSON.stringify(react)}`);
	}
	if (workspace !== undefined) {
		if (workspace === "worktree" || workspace === "shared") settings.workspace = workspace;
		else problems.push(`"workspace" must be "worktree" or "shared", got ${JSON.stringify(workspace)}`);
	}
}
