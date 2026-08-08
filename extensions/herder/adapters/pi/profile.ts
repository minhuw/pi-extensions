import { resolvePiProfile, type PiProfileDefinition } from "../../src/core/profile-registry.ts";
import type { ResolvedProfile } from "../../src/shared/protocol.ts";

export const HERDER_ROLES = ["plan-implementer", "plan-reviewer", "plan-judge"] as const;
export type HerderRole = (typeof HERDER_ROLES)[number];
export const THINKING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface RoleMapping {
	agent_type: string;
	model: string;
	effort: ThinkingEffort;
	service_tier?: "fast" | "standard";
}

export type ResolvedPiProfile = Omit<ResolvedProfile, "orchestrator" | "roles"> & {
	host: "pi";
	orchestrator: { model: string; effort: ThinkingEffort };
	roles: Record<HerderRole, RoleMapping>;
};

export async function loadPiProfile(catalogPath: string, requested?: string): Promise<ResolvedPiProfile> {
	return resolvePiProfile(requested, catalogPath) as ResolvedPiProfile;
}

export interface AvailableModel {
	provider?: string;
	id?: string;
	fullId?: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingEffort, string | null>>;
}

/** Pi-ai provider APIs whose request options accept a service tier. */
export const SERVICE_TIER_APIS = new Set(["openai-responses", "openai-codex-responses"]);

const SERVICE_TIER_REQUEST_VALUES: Record<string, string> = {
	fast: "priority",
	standard: "default",
};

/** Maps a Herder profile service tier to the exact provider request value. */
export function serviceTierRequestValue(tier: string): string {
	const value = SERVICE_TIER_REQUEST_VALUES[tier];
	if (!value) throw new Error(`Unknown Herder service tier ${JSON.stringify(tier)}.`);
	return value;
}

export function modelSupportsServiceTier(model: AvailableModel): boolean {
	return Boolean(model.api && SERVICE_TIER_APIS.has(model.api));
}

export function modelMatches(requested: string, candidate: AvailableModel): boolean {
	const id = candidate.id || "";
	const fullId = candidate.fullId || (candidate.provider && id ? `${candidate.provider}/${id}` : "");
	return requested === id || requested === fullId || fullId.endsWith(`/${requested}`);
}

export function unavailableProfileModels(profile: ResolvedPiProfile, available: readonly AvailableModel[]): string[] {
	const required = new Set([profile.orchestrator.model, ...HERDER_ROLES.map((role) => profile.roles[role].model)]);
	return [...required].filter((model) => !available.some((candidate) => modelMatches(model, candidate)));
}

export function modelSupportsEffort(model: AvailableModel, effort: ThinkingEffort): boolean {
	if (model.reasoning === false) return effort === "off";
	if (!model.thinkingLevelMap) return effort !== "max";
	const mapped = model.thinkingLevelMap[effort];
	if (mapped === null) return false;
	if (effort === "xhigh" || effort === "max") return mapped !== undefined;
	return true;
}

export function effectiveModelSupportsEffort(
	effectiveModel: string | undefined,
	effort: ThinkingEffort,
	available: readonly AvailableModel[],
): boolean {
	if (!effectiveModel) return false;
	const suffix = `:${effort}`;
	const fullId = effectiveModel.endsWith(suffix) ? effectiveModel.slice(0, -suffix.length) : effectiveModel;
	const model = available.find((candidate) => {
		const candidateFullId = candidate.fullId || (candidate.provider && candidate.id ? `${candidate.provider}/${candidate.id}` : "");
		return candidateFullId === fullId;
	});
	return Boolean(model && modelSupportsEffort(model, effort));
}

export function activeModelMatches(profile: ResolvedPiProfile, active: AvailableModel | undefined): boolean {
	return Boolean(active && modelMatches(profile.orchestrator.model, active));
}

export type { PiProfileDefinition };
