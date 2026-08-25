import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	HERDER_ROLES,
	THINKING_EFFORTS,
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	type AvailableModel,
	type HerderRole,
	type ResolvedPiProfile,
	type ThinkingEffort,
} from "./profile.ts";
import type { ManagerAction } from "../src/shared/protocol.ts";

export interface HerderPiRoleDefinition {
	role: HerderRole;
	agentType: string;
	description: string;
	tools: string[];
	extensions: string[];
	systemPrompt: string;
}

export const HERDER_NESTED_AGENT_TYPES = ["recon", "searcher", "worker"] as const;
export type HerderNestedAgentType = typeof HERDER_NESTED_AGENT_TYPES[number];
export const HERDER_NESTED_BINDINGS = ["own", "inherit"] as const;
export type HerderNestedBinding = typeof HERDER_NESTED_BINDINGS[number];

export interface NestedAgentModelBinding {
	model: string;
	effort: ThinkingEffort;
	serviceTier?: "fast" | "standard";
}

export interface HerderNestedAgentDefinition {
	name: HerderNestedAgentType;
	description: string;
	tools: string[];
	extensions: string[];
	readOnly: boolean;
	binding: HerderNestedBinding;
	modelBinding?: NestedAgentModelBinding;
	systemPrompt: string;
}

const STRICT_READ_ONLY_NESTED_TOOLS = new Set([
	"read", "ffgrep", "fffind", "ls",
	"web_search", "source_check", "fetch_content", "get_search_content",
]);
export const PONYTAIL_EXTENSION_SOURCE = "git:github.com/DietrichGebert/ponytail";
export const FFF_EXTENSION_SOURCE = "npm:@ff-labs/pi-fff";
export const WEB_ACCESS_EXTENSION_SOURCE = "npm:pi-web-access";
const ROLE_EXTENSION_SOURCES: Record<HerderRole, readonly string[]> = {
	"plan-implementer": [PONYTAIL_EXTENSION_SOURCE, FFF_EXTENSION_SOURCE],
	"plan-reviewer": [FFF_EXTENSION_SOURCE],
	"plan-judge": [FFF_EXTENSION_SOURCE],
};
const NESTED_EXTENSION_SOURCES: Record<HerderNestedAgentType, readonly string[]> = {
	recon: [FFF_EXTENSION_SOURCE],
	searcher: [WEB_ACCESS_EXTENSION_SOURCE, FFF_EXTENSION_SOURCE],
	worker: [PONYTAIL_EXTENSION_SOURCE, FFF_EXTENSION_SOURCE],
};

function stringField(frontmatter: Record<string, unknown>, name: string, file: string): string {
	const value = frontmatter[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`missing ${name} in ${file}`);
	}
	return value.trim();
}

function stringList(value: unknown): string[] {
	const items = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: typeof value === "string" ? value.split(",") : [];
	return items.map((item) => item.trim()).filter(Boolean);
}

function optionalMapping(frontmatter: Record<string, unknown>, file: string): NestedAgentModelBinding | undefined {
	const hasModel = frontmatter.model !== undefined;
	const hasEffort = frontmatter.effort !== undefined;
	const hasTier = frontmatter.service_tier !== undefined;
	if (!hasModel && !hasEffort && !hasTier) return undefined;
	if (typeof frontmatter.model !== "string" || frontmatter.model.trim().length === 0) {
		throw new Error(`missing model in ${file}`);
	}
	if (typeof frontmatter.effort !== "string" || !(THINKING_EFFORTS as readonly string[]).includes(frontmatter.effort)) {
		throw new Error(`invalid effort in ${file}`);
	}
	const serviceTier = frontmatter.service_tier;
	if (hasTier && serviceTier !== "fast" && serviceTier !== "standard") {
		throw new Error(`invalid service_tier in ${file}`);
	}
	return {
		model: frontmatter.model.trim(),
		effort: frontmatter.effort as ThinkingEffort,
		...(serviceTier === "fast" || serviceTier === "standard" ? { serviceTier } : {}),
	};
}

export function resolveNestedBinding(definition: HerderNestedAgentDefinition, action: Pick<ManagerAction, "model" | "effort" | "serviceTier">): NestedAgentModelBinding {
	if (definition.binding === "inherit") {
		return {
			model: action.model,
			effort: action.effort as ThinkingEffort,
			...(action.serviceTier === "fast" || action.serviceTier === "standard" ? { serviceTier: action.serviceTier } : {}),
		};
	}
	if (!definition.modelBinding) throw new Error(`own-model nested agent ${definition.name} is missing a model binding`);
	return definition.modelBinding;
}

function validateOwnBinding(definition: HerderNestedAgentDefinition, availableModels: readonly AvailableModel[]): void {
	if (definition.binding !== "own" || !definition.modelBinding) return;
	const mapping = definition.modelBinding;
	const candidate = availableModels.find((model) => modelMatches(mapping.model, model));
	if (!candidate || !modelSupportsEffort(candidate, mapping.effort)) {
		throw new Error(`Herder nested agent ${definition.name} cannot start because ${mapping.model} does not support thinking ${mapping.effort}.`);
	}
	if (mapping.serviceTier && !modelSupportsServiceTier(candidate)) {
		throw new Error(`Herder nested agent ${definition.name} cannot start because ${mapping.model} (${candidate.api || "unknown api"}) does not support service tier ${mapping.serviceTier}.`);
	}
}

function toolList(value: unknown, file: string, allowedNestedTools: readonly string[] = ["Agent", "get_subagent_result"]): string[] {
	const normalized = stringList(value);
	if (normalized.length === 0) throw new Error(`missing tools in ${file}`);
	if (new Set(normalized).size !== normalized.length) throw new Error(`duplicate tools in ${file}`);
	const orchestrationTools = new Set(["herder", "subagent", "Agent", "get_subagent_result", "steer_subagent"]);
	const allowed = new Set(allowedNestedTools);
	const rejected = normalized.find((tool) => orchestrationTools.has(tool) && !allowed.has(tool));
	if (rejected) throw new Error(`recursive agent tool ${rejected} is forbidden in ${file}`);
	return normalized;
}

export async function loadHerderPiRole(agentRoot: string, role: HerderRole): Promise<HerderPiRoleDefinition> {
	const file = path.join(agentRoot, `${role}.md`);
	const parsed = parseFrontmatter<Record<string, unknown>>(await readFile(file, "utf8"));
	const name = stringField(parsed.frontmatter, "name", file);
	const packageName = stringField(parsed.frontmatter, "package", file);
	if (name !== role || packageName !== "herder") throw new Error(`mismatched name or package metadata in ${file}`);
	if (parsed.body.trim().length === 0) throw new Error(`missing system prompt in ${file}`);
	const extensions = stringList(parsed.frontmatter.extensions);
	if (new Set(extensions).size !== extensions.length) throw new Error(`duplicate extensions in ${file}`);
	const allowedExtensions = ROLE_EXTENSION_SOURCES[role];
	const rejectedExtension = extensions.find((source) => !allowedExtensions.includes(source));
	if (rejectedExtension) throw new Error(`Herder role ${role} requests forbidden extension ${rejectedExtension} in ${file}`);
	return {
		role,
		agentType: `herder.${role}`,
		description: stringField(parsed.frontmatter, "description", file),
		tools: toolList(parsed.frontmatter.tools, file),
		extensions,
		systemPrompt: parsed.body.trim(),
	};
}

export async function loadHerderNestedAgent(agentRoot: string, type: HerderNestedAgentType): Promise<HerderNestedAgentDefinition> {
	const file = path.join(agentRoot, "nested", `${type}.md`);
	const parsed = parseFrontmatter<Record<string, unknown>>(await readFile(file, "utf8"));
	const name = stringField(parsed.frontmatter, "name", file);
	const packageName = stringField(parsed.frontmatter, "package", file);
	const kind = stringField(parsed.frontmatter, "kind", file);
	if (name !== type || packageName !== "herder" || kind !== "nested") {
		throw new Error(`mismatched nested agent metadata in ${file}`);
	}
	if (typeof parsed.frontmatter.readOnly !== "boolean") throw new Error(`missing readOnly in ${file}`);
	if (parsed.body.trim().length === 0) throw new Error(`missing system prompt in ${file}`);
	const binding = stringField(parsed.frontmatter, "binding", file);
	if (!(HERDER_NESTED_BINDINGS as readonly string[]).includes(binding)) {
		throw new Error(`invalid binding in ${file}`);
	}
	const modelBinding = optionalMapping(parsed.frontmatter, file);
	if (binding === "own" && !modelBinding) throw new Error(`own-model nested agent ${type} is missing model/effort in ${file}`);
	if (binding === "inherit" && modelBinding) throw new Error(`inherit nested agent ${type} cannot declare its own model in ${file}`);
	const tools = toolList(parsed.frontmatter.tools, file, []);
	const extensions = stringList(parsed.frontmatter.extensions);
	if (new Set(extensions).size !== extensions.length) throw new Error(`duplicate extensions in ${file}`);
	const allowedExtensions = NESTED_EXTENSION_SOURCES[type];
	const rejectedExtension = extensions.find((source) => !allowedExtensions.includes(source));
	if (rejectedExtension) throw new Error(`nested agent ${type} requests forbidden extension ${rejectedExtension} in ${file}`);
	const readOnly = parsed.frontmatter.readOnly;
	if (readOnly && tools.some((tool) => !STRICT_READ_ONLY_NESTED_TOOLS.has(tool))) {
		throw new Error(`read-only nested agent ${type} requests a mutating or unrestricted tool in ${file}`);
	}
	return {
		name: type,
		description: stringField(parsed.frontmatter, "description", file),
		tools,
		extensions,
		readOnly,
		binding: binding as HerderNestedBinding,
		...(modelBinding ? { modelBinding } : {}),
		systemPrompt: parsed.body.trim(),
	};
}

export async function validateHerderRoleAgents(
	agentRoot: string,
	profile: ResolvedPiProfile,
	availableModels: readonly AvailableModel[],
): Promise<void> {
	const nested = await Promise.all(HERDER_NESTED_AGENT_TYPES.map((type) => loadHerderNestedAgent(agentRoot, type)));
	for (const definition of nested) validateOwnBinding(definition, availableModels);
	for (const role of HERDER_ROLES) {
		const mapping = profile.roles[role];
		const definition = await loadHerderPiRole(agentRoot, role);
		if (mapping.agent_type !== definition.agentType) {
			throw new Error(`Herder role ${role} must use package agent ${definition.agentType}, not ${mapping.agent_type}.`);
		}
		const candidate = availableModels.find((model) => modelMatches(mapping.model, model));
		if (!candidate || !modelSupportsEffort(candidate, mapping.effort)) {
			throw new Error(`Herder role ${definition.agentType} cannot start because ${mapping.model} does not support thinking ${mapping.effort}.`);
		}
		if (mapping.service_tier && !modelSupportsServiceTier(candidate)) {
			throw new Error(`Herder role ${definition.agentType} cannot start because ${mapping.model} (${candidate.api || "unknown api"}) does not support service tier ${mapping.service_tier}.`);
		}
	}
}
