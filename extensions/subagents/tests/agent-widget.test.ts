import { describe, expect, it } from "vitest";
import {
  buildInvocationTags,
  buildResumedInvocation,
  formatModelName,
  getAgentStatsParts,
} from "../src/ui/agent-widget.js";

describe("foreground agent metadata", () => {
  it("always formats the effective model name", () => {
    expect(formatModelName({ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" })).toBe("gpt-5.6 luna");
    expect(formatModelName({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" })).toBe("sonnet 4.6");
    expect(formatModelName({ id: "custom-model" })).toBe("custom-model");
  });

  it("uses the resumed session metadata when no invocation snapshot exists", () => {
    expect(buildResumedInvocation({
      session: {
        model: { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        thinkingLevel: "xhigh",
      },
      serviceTier: "fast",
      maxTurns: 30,
      isBackground: true,
    })).toEqual({
      modelName: "gpt-5.6 luna",
      thinking: "xhigh",
      serviceTier: "fast",
      maxTurns: 30,
      runInBackground: true,
    });
  });

  it("keeps an inherited model visible and places service tier before thinking", () => {
    const parentModel = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    const invocation = buildInvocationTags({
      modelName: formatModelName(parentModel),
      serviceTier: "fast",
      thinking: "xhigh",
    });

    expect(getAgentStatsParts({
      displayName: "Worker",
      description: "Draft dashboard read plan",
      subagentType: "worker",
      modelName: invocation.modelName,
      tags: invocation.tags,
      toolUses: 54,
      tokens: "146.1k token",
      durationMs: 0,
      status: "running",
      turnCount: 13,
    })).toEqual([
      "gpt-5.6 luna",
      "tier: fast",
      "thinking: xhigh",
      "↻13",
      "54 tool uses",
      "146.1k token",
    ]);
  });
});
