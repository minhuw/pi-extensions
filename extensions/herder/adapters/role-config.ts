import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	HERDER_ROLES,
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	type AvailableModel,
	type HerderRole,
	type ResolvedPiProfile,
} from "./profile.ts";

export interface HerderPiRoleDefinition {
	role: HerderRole;
	agentType: string;
	description: string;
	tools: string[];
	systemPrompt: string;
}

function stringField(frontmatter: Record<string, unknown>, name: string, file: string): string {
	const value = frontmatter[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`missing ${name} in ${file}`);
	}
	return value.trim();
}

function toolList(value: unknown, file: string): string[] {
	const tools = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: typeof value === "string" ? value.split(",") : [];
	const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
	if (normalized.length === 0) throw new Error(`missing tools in ${file}`);
	if (new Set(normalized).size !== normalized.length) throw new Error(`duplicate tools in ${file}`);
	if (normalized.includes("herder") || normalized.includes("subagent")) {
		throw new Error(`recursive agent tools are forbidden in ${file}`);
	}
	return normalized;
}

export async function loadHerderPiRole(agentRoot: string, role: HerderRole): Promise<HerderPiRoleDefinition> {
	const file = path.join(agentRoot, `${role}.md`);
	const parsed = parseFrontmatter<Record<string, unknown>>(await readFile(file, "utf8"));
	const name = stringField(parsed.frontmatter, "name", file);
	const packageName = stringField(parsed.frontmatter, "package", file);
	if (name !== role || packageName !== "herder") throw new Error(`mismatched name or package metadata in ${file}`);
	if (parsed.body.trim().length === 0) throw new Error(`missing system prompt in ${file}`);
	return {
		role,
		agentType: `herder.${role}`,
		description: stringField(parsed.frontmatter, "description", file),
		tools: toolList(parsed.frontmatter.tools, file),
		systemPrompt: parsed.body.trim(),
	};
}

export async function validateHerderRoleAgents(
	agentRoot: string,
	profile: ResolvedPiProfile,
	availableModels: readonly AvailableModel[],
): Promise<void> {
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
