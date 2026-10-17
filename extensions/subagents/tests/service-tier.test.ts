import { describe, expect, it, vi } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import { applyServiceTier, modelSupportsServiceTier, parseServiceTier, serviceTierRequestValue } from "../src/service-tier.js";
import type { AgentConfig } from "../src/types.js";

describe("local service tiers", () => {
  it("gives frontmatter precedence and identifies explicit caller requests", () => {
    expect(resolveAgentInvocationConfig({ serviceTier: "standard" } as AgentConfig, { service_tier: "fast" }))
      .toMatchObject({ serviceTier: "standard", serviceTierFromParams: false });
    expect(resolveAgentInvocationConfig(undefined, { service_tier: "fast" }))
      .toMatchObject({ serviceTier: "fast", serviceTierFromParams: true });
    expect(resolveAgentInvocationConfig(undefined, {}))
      .toMatchObject({ serviceTier: undefined, serviceTierFromParams: false });
  });

  it.each([["fast", "priority"], ["standard", "default"], ["flex", "flex"], ["auto", "auto"]])("maps %s to %s", (input, expected) => {
    expect(serviceTierRequestValue(input)).toBe(expected);
    expect(parseServiceTier(` ${input.toUpperCase()} `)).toBe(input);
  });

  it("rejects malformed values and only supports tier-aware APIs", () => {
    for (const value of [42, {}, "invalid"]) expect(() => parseServiceTier(value)).toThrow();
    expect(parseServiceTier(undefined)).toBeUndefined();
    for (const api of ["openai-responses", "openai-codex-responses", "cliproxyapi-codex-responses"]) {
      expect(modelSupportsServiceTier({ api })).toBe(true);
    }
    expect(modelSupportsServiceTier({ api: "anthropic-messages" })).toBe(false);
    expect(modelSupportsServiceTier(undefined)).toBe(false);
  });

  it("pins each request after an asynchronous payload hook without losing options", async () => {
    const base = vi.fn(() => "stream");
    const session = { agent: { streamFunction: base } };
    applyServiceTier(session as any, "fast");
    const model = { api: "openai-responses" };
    const hook = vi.fn(async () => ({ transformed: true, service_tier: "flex" }));
    for (let i = 0; i < 2; i++) {
      expect(session.agent.streamFunction(model, {}, { temperature: 0, onPayload: hook } as any)).toBe("stream");
      const options = (base.mock.calls.at(-1) as any)[2];
      expect(options).toMatchObject({ temperature: 0, serviceTier: "priority" });
      expect(await options.onPayload({ original: true }, model)).toEqual({ transformed: true, service_tier: "priority" });
    }
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("supports mutating hooks and rejects non-object transformed payloads", async () => {
    const base = vi.fn();
    const session = { agent: { streamFunction: base } };
    applyServiceTier(session as any, "standard");
    session.agent.streamFunction({}, {}, { onPayload: (payload: any) => { payload.kept = true; } } as any);
    const options = (base.mock.calls[0] as any)[2];
    expect(await options.onPayload({ service_tier: "priority" }, {})).toEqual({ kept: true, service_tier: "default" });
    await expect(options.onPayload([], {})).rejects.toThrow("non-object");
  });
});
