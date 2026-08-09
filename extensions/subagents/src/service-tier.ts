/**
 * service-tier.ts — Pin OpenAI-style service tiers on subagent requests.
 *
 * User-facing names (frontmatter / Agent tool):
 *   fast | standard
 * Raw provider values also accepted:
 *   priority | default | flex | auto
 *
 * Application: wrap the child session's streamFunction so every request gets
 * the exact tier (mirrors Herder's applyServiceTier). Only APIs that accept
 * serviceTier / service_tier are supported.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Friendly profile names. */
export type ServiceTierProfile = "fast" | "standard";

/** Values accepted in frontmatter / Agent({ service_tier }). */
export type ServiceTierInput = ServiceTierProfile | "priority" | "default" | "flex" | "auto";

/** Provider request value for `service_tier` / stream options.serviceTier. */
export type ServiceTierRequestValue = "priority" | "default" | "flex" | "auto";

/** Pi-ai provider APIs whose request options accept a service tier. */
export const SERVICE_TIER_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "cliproxyapi-codex-responses",
]);

const SERVICE_TIER_REQUEST_VALUES: Record<ServiceTierInput, ServiceTierRequestValue> = {
  fast: "priority",
  standard: "default",
  priority: "priority",
  default: "default",
  flex: "flex",
  auto: "auto",
};

const VALID_INPUTS = new Set(Object.keys(SERVICE_TIER_REQUEST_VALUES));

/** Parse a frontmatter / tool string. Returns undefined if empty/missing. Throws on invalid. */
export function parseServiceTier(input: unknown): ServiceTierInput | undefined {
  if (input == null || input === "") return undefined;
  if (typeof input !== "string") {
    throw new Error(`Invalid service_tier: expected string, got ${typeof input}`);
  }
  const normalized = input.trim().toLowerCase() as ServiceTierInput;
  if (!VALID_INPUTS.has(normalized)) {
    throw new Error(
      `Invalid service_tier: "${input}". Expected one of: ${[...VALID_INPUTS].join(", ")}.`,
    );
  }
  return normalized;
}

/** Map user-facing / raw input to the provider request value. */
export function serviceTierRequestValue(tier: ServiceTierInput | string): ServiceTierRequestValue {
  const key = String(tier).trim().toLowerCase() as ServiceTierInput;
  const value = SERVICE_TIER_REQUEST_VALUES[key];
  if (!value) {
    throw new Error(`Unknown service tier ${JSON.stringify(tier)}.`);
  }
  return value;
}

export function modelSupportsServiceTier(model: { api?: string } | undefined | null): boolean {
  return Boolean(model?.api && SERVICE_TIER_APIS.has(model.api));
}

/**
 * Pin every stream request of a session to the given tier.
 * Caller must only invoke this when the model API supports service tiers.
 */
export function applyServiceTier(session: AgentSession, tier: ServiceTierInput | string): void {
  const serviceTier = serviceTierRequestValue(tier);
  const base = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const previousOnPayload = options?.onPayload;
    return base(model, context, {
      ...options,
      serviceTier,
      onPayload: async (payload: unknown, payloadModel: unknown) => {
        const transformed = await previousOnPayload?.(payload as never, payloadModel as never);
        const finalPayload = transformed === undefined ? payload : transformed;
        if (!finalPayload || typeof finalPayload !== "object" || Array.isArray(finalPayload)) {
          throw new Error("Cannot pin service tier on a non-object provider payload.");
        }
        return { ...(finalPayload as Record<string, unknown>), service_tier: serviceTier };
      },
    } as typeof options);
  };
}

/** Short UI label for tags, e.g. "tier: fast". */
export function serviceTierLabel(tier: ServiceTierInput | string | undefined): string | undefined {
  if (!tier) return undefined;
  return `tier: ${String(tier).toLowerCase()}`;
}
