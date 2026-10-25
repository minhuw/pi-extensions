import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RoleDefinition } from "../types.ts";

export interface RoleSources { builtinDir?: string; overrideDir?: string }

export const BUILTIN_ROLE_DIR = fileURLToPath(new URL("../../agents/", import.meta.url));
export const defaultOverrideDir = () => join(getAgentDir(), "herder", "agents");
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const FIELDS = ["name", "description", "write", "tools", "model", "thinking"];
/** Pi also accepts `*` patterns and `+name`/`-name` modifiers, which could re-enable writers on a read-only role. */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** The tools a session may get: plain names only, and only `READ_ONLY_TOOLS` for a read-only role. */
export const allowedTools = (write: boolean, tools: readonly string[]) =>
	tools.filter((tool) => TOOL_NAME.test(tool) && (write || READ_ONLY_TOOLS.includes(tool)));

/** Hashes the resolved definition; `inherit` stays literal so the hash does not depend on the main session's model. */
export function roleSha256(role: Omit<RoleDefinition, "sha256">): string {
	const { name, description, write, tools, model, thinking, prompt } = role;
	return createHash("sha256").update(JSON.stringify({ name, description, write, tools, model, thinking, prompt })).digest("hex");
}

export function parseRole(text: string, source = "role"): RoleDefinition {
	const fail = (message: string): never => { throw new Error(`Invalid Herder role ${source}: ${message}`); };
	if (!text.replace(/^\uFEFF/, "").startsWith("---")) fail("missing frontmatter");
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try { parsed = parseFrontmatter(text); } catch (error) { return fail(`malformed frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
	const { frontmatter: fm, body } = parsed;
	const unknown = Object.keys(fm).filter((key) => !FIELDS.includes(key));
	if (unknown.length) fail(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
	const string = (key: string) => typeof fm[key] === "string" && fm[key].trim() ? fm[key].trim() : fail(`${key} must be a non-empty string`);
	const name = string("name");
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) fail(`name ${JSON.stringify(name)} must be lowercase letters, digits, "-" or "_"`);
	const description = string("description");
	if (typeof fm.write !== "boolean") fail("write must be true or false");
	const write = fm.write as boolean;
	const tools = fm.tools;
	if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !tool.trim())) fail("tools must be a list of tool names");
	const toolNames = (tools as string[]).map((tool) => tool.trim());
	const unnamed = toolNames.find((tool) => !TOOL_NAME.test(tool));
	if (unnamed !== undefined) fail(`tool ${JSON.stringify(unnamed)} must be a plain tool name (lowercase letters, digits, "_"; no patterns or +/- modifiers)`);
	const denied = write ? [] : toolNames.filter((tool) => !READ_ONLY_TOOLS.includes(tool));
	if (denied.length) fail(`a read-only role (write: false) may only list ${READ_ONLY_TOOLS.join(", ")}; got ${denied.join(", ")}`);
	const model = string("model");
	if (model !== "inherit" && !/^[^/\s]+\/\S+$/.test(model)) fail(`model must be "inherit" or provider/model-id, got ${JSON.stringify(model)}`);
	const thinking = string("thinking");
	if (thinking !== "inherit" && !(THINKING_LEVELS as readonly string[]).includes(thinking)) fail(`thinking must be "inherit" or one of ${THINKING_LEVELS.join("|")}, got ${JSON.stringify(thinking)}`);
	const prompt = body.trim();
	if (!prompt) fail("the role prompt (body) is empty");
	const role = { name, description, write, tools: toolNames, model, thinking, prompt };
	return { ...role, sha256: roleSha256(role) };
}

function readDir(dir: string, into: Map<string, RoleDefinition>): void {
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
		const path = join(dir, file);
		const role = parseRole(readFileSync(path, "utf8"), path);
		if (role.name !== basename(file, ".md")) throw new Error(`Invalid Herder role ${path}: name ${JSON.stringify(role.name)} does not match the file name`);
		into.set(role.name, role);
	}
}

/** Built-in roles, each replaced entirely by an override file of the same name; override dirs may add roles. */
export function loadRoles(sources: RoleSources = {}): Map<string, RoleDefinition> {
	const roles = new Map<string, RoleDefinition>();
	readDir(sources.builtinDir ?? BUILTIN_ROLE_DIR, roles);
	readDir(sources.overrideDir ?? defaultOverrideDir(), roles);
	return roles;
}

export function loadRole(name: string, sources?: RoleSources): RoleDefinition {
	const roles = loadRoles(sources);
	const role = roles.get(name);
	if (!role) throw new Error(`Unknown Herder role ${JSON.stringify(name)}; known roles: ${[...roles.keys()].join(", ") || "none"}`);
	return role;
}
