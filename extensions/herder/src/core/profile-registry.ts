#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sha256, stableJson, type ResolvedProfile, type RoleProfile, type WorkerRole } from "../shared/protocol.ts";

const CORE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_CATALOG = path.resolve(CORE_ROOT, "../../assets/profiles/profiles.json");
const ROLES: WorkerRole[] = ["plan-implementer", "plan-reviewer", "plan-judge"];
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;

export interface PiProfileDefinition {
	name: string;
	description: string;
	orchestrator: { model: string; effort: string; service_tier?: string };
	roles: Record<WorkerRole, Omit<RoleProfile, "agent_type">>;
}

export interface PiProfileCatalog {
	schema_version: 1;
	default: string;
	profiles: PiProfileDefinition[];
}

function mapping(value: unknown, label: string): { model: string; effort: string; service_tier?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const record = value as Record<string, unknown>;
	if (typeof record.model !== "string" || !MODEL_PATTERN.test(record.model)) throw new Error(`${label} has an invalid model`);
	if (typeof record.effort !== "string" || !EFFORTS.has(record.effort)) throw new Error(`${label} has an invalid effort`);
	if (record.service_tier !== undefined && !["fast", "standard"].includes(String(record.service_tier))) {
		throw new Error(`${label} has an invalid service tier`);
	}
	const unknown = Object.keys(record).filter((key) => !["model", "effort", "service_tier"].includes(key));
	if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
	return {
		model: record.model,
		effort: record.effort,
		...(record.service_tier ? { service_tier: String(record.service_tier) } : {}),
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
		if (Object.keys(roleValues).length !== ROLES.length || ROLES.some((role) => !(role in roleValues))) {
			throw new Error(`Profile ${profile.name} must define exactly ${ROLES.join(", ")}`);
		}
		return {
			name: profile.name,
			description: profile.description.trim(),
			orchestrator: mapping(profile.orchestrator, `${profile.name} orchestrator`),
			roles: Object.fromEntries(ROLES.map((role) => [role, mapping(roleValues[role], `${profile.name}/${role}`)])) as PiProfileDefinition["roles"],
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
		roles: Object.fromEntries(ROLES.map((role) => [role, {
			agent_type: `herder.${role}`,
			...profile.roles[role],
		}])) as ResolvedProfile["roles"],
	};
}

function runCli(argv: string[]): unknown {
	const command = argv.shift();
	const prettyIndex = argv.indexOf("--pretty");
	const pretty = prettyIndex !== -1;
	if (pretty) argv.splice(prettyIndex, 1);
	const profileIndex = argv.indexOf("--profile");
	const requested = profileIndex === -1 ? undefined : argv[profileIndex + 1];
	if (profileIndex !== -1) argv.splice(profileIndex, 2);
	const hostIndex = argv.indexOf("--host");
	if (hostIndex !== -1) {
		if (argv[hostIndex + 1] !== "pi") throw new Error("Herder now supports only the Pi host");
		argv.splice(hostIndex, 2);
	}
	if (argv.length) throw new Error(`Unknown profile arguments: ${argv.join(" ")}`);
	if (command === "resolve") return { value: resolvePiProfile(requested), pretty };
	const catalog = loadPiProfileCatalog();
	if (command === "check") return { value: { ok: true, profiles: catalog.profiles.length }, pretty };
	if (command === "list") return { value: catalog.profiles.map((profile) => ({ name: profile.name, description: profile.description, sha256: sha256(stableJson(profile)) })), pretty };
	throw new Error("Usage: profile-registry.ts list|check|resolve [--profile name] [--pretty]");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = runCli(process.argv.slice(2)) as { value: unknown; pretty: boolean };
		process.stdout.write(`${JSON.stringify(result.value, null, result.pretty ? 2 : 0)}\n`);
	} catch (error) {
		process.stderr.write(`herder-profile: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
