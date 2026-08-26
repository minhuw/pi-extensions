import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	THINKING_EFFORTS,
	WORKER_ROLES,
	sha256,
	stableJson,
	type ResolvedProfile,
	type RoleProfile,
	type ServiceTier,
	type ThinkingEffort,
	type WorkerRole,
} from "../shared/protocol.ts";

const CORE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_CATALOG = path.resolve(CORE_ROOT, "../../assets/profiles/profiles.json");
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;

export interface PiProfileDefinition {
	name: string;
	description: string;
	orchestrator: Omit<RoleProfile, "agent_type">;
	roles: Record<WorkerRole, Omit<RoleProfile, "agent_type">>;
}

export interface PiProfileCatalog {
	schema_version: 1;
	default: string;
	profiles: PiProfileDefinition[];
}

function mapping(value: unknown, label: string): Omit<RoleProfile, "agent_type"> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const record = value as Record<string, unknown>;
	if (typeof record.model !== "string" || !MODEL_PATTERN.test(record.model)) throw new Error(`${label} has an invalid model`);
	if (typeof record.effort !== "string" || !THINKING_EFFORTS.includes(record.effort as ThinkingEffort)) {
		throw new Error(`${label} has an invalid effort`);
	}
	const serviceTier = record.service_tier;
	if (serviceTier !== undefined && serviceTier !== "fast" && serviceTier !== "standard") {
		throw new Error(`${label} has an invalid service tier`);
	}
	const unknown = Object.keys(record).filter((key) => !["model", "effort", "service_tier"].includes(key));
	if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
	return {
		model: record.model,
		effort: record.effort as ThinkingEffort,
		...(serviceTier !== undefined ? { service_tier: serviceTier as ServiceTier } : {}),
	};
}

export function loadPiProfileCatalog(file = DEFAULT_PROFILE_CATALOG): PiProfileCatalog {
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	if (value.schema_version !== 1 || typeof value.default !== "string" || !Array.isArray(value.profiles)) {
		throw new Error("Unsupported Herder Pi profile catalog");
	}
	const unknownCatalog = Object.keys(value).filter((key) => !["schema_version", "default", "profiles"].includes(key));
	if (unknownCatalog.length) throw new Error(`Unknown profile catalog fields: ${unknownCatalog.join(", ")}`);
	const names = new Set<string>();
	const profiles = value.profiles.map((candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Every profile must be an object");
		const profile = candidate as Record<string, unknown>;
		if (typeof profile.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.name) || names.has(profile.name)) {
			throw new Error(`Invalid or duplicate profile name: ${JSON.stringify(profile.name)}`);
		}
		names.add(profile.name);
		if (typeof profile.description !== "string" || !profile.description.trim()) throw new Error(`Profile ${profile.name} has no description`);
		const unknown = Object.keys(profile).filter((key) => !["name", "description", "orchestrator", "roles"].includes(key));
		if (unknown.length) throw new Error(`Profile ${profile.name} has unknown fields: ${unknown.join(", ")}`);
		if (!profile.roles || typeof profile.roles !== "object" || Array.isArray(profile.roles)) throw new Error(`Profile ${profile.name} has no roles`);
		const roleValues = profile.roles as Record<string, unknown>;
		if (Object.keys(roleValues).length !== WORKER_ROLES.length || WORKER_ROLES.some((role) => !(role in roleValues))) {
			throw new Error(`Profile ${profile.name} must define exactly ${WORKER_ROLES.join(", ")}`);
		}
		return {
			name: profile.name,
			description: profile.description.trim(),
			orchestrator: mapping(profile.orchestrator, `${profile.name} orchestrator`),
			roles: Object.fromEntries(WORKER_ROLES.map((role) => [role, mapping(roleValues[role], `${profile.name}/${role}`)])) as PiProfileDefinition["roles"],
		};
	});
	if (!names.has(value.default)) throw new Error(`Unknown default profile ${JSON.stringify(value.default)}`);
	return { schema_version: 1, default: value.default, profiles };
}

export function resolvePiProfile(requested?: string, file = DEFAULT_PROFILE_CATALOG): ResolvedProfile {
	const catalog = loadPiProfileCatalog(file);
	const name = requested || catalog.default;
	const profile = catalog.profiles.find((candidate) => candidate.name === name);
	if (!profile) throw new Error(`Unknown Herder profile ${JSON.stringify(name)}`);
	return {
		schema_version: 1,
		profile: profile.name,
		profile_sha256: sha256(stableJson(profile)),
		host: "pi",
		orchestrator: profile.orchestrator,
		roles: Object.fromEntries(WORKER_ROLES.map((role) => [role, {
			agent_type: `herder.${role}`,
			...profile.roles[role],
		}])) as ResolvedProfile["roles"],
	};
}
