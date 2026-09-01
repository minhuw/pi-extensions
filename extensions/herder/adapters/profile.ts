import { WORKER_ROLES, type ResolvedProfile, type ThinkingEffort } from "../src/shared/protocol.ts";

export type ResolvedPiProfile = ResolvedProfile;
export type { ThinkingEffort };

export interface AvailableModel {
	provider?: string;
	id?: string;
	fullId?: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingEffort, string | null>>;
}

/** Pi-ai provider APIs whose request options accept a service tier. */
export const SERVICE_TIER_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"cliproxyapi-codex-responses",
]);

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

export const HERDER_OWN_NESTED_MODEL = "gpt-5.6-luna";

export function unavailableProfileModels(profile: ResolvedProfile, available: readonly AvailableModel[]): string[] {
	const required = new Set([
		profile.orchestrator.model,
		...WORKER_ROLES.map((role) => profile.roles[role].model),
		HERDER_OWN_NESTED_MODEL,
	]);
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

export function activeModelMatches(profile: ResolvedProfile, active: AvailableModel | undefined): boolean {
	return Boolean(active && modelMatches(profile.orchestrator.model, active));
}
