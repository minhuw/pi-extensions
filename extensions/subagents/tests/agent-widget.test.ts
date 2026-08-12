import { describe, expect, it } from "vitest";
import {
  buildInvocationTags,
  buildRecordInvocation,
  buildResumedInvocation,
  formatAgentIdentity,
  formatModelName,
  getAgentStatsParts,
} from "../src/ui/agent-widget.js";

describe("foreground agent metadata", () => {
  it("always formats the exact effective model name", () => {
    expect(formatModelName({ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" })).toBe("openai/gpt-5.6-luna");
    expect(formatModelName({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" })).toBe("anthropic/claude-sonnet-4-6");
    expect(formatModelName({ id: "custom-model" })).toBe("custom-model");
  });

  it("formats compact model · thinking · tier identity", () => {
    expect(formatAgentIdentity({
      modelName: "openai/gpt-5.6-luna",
      thinking: "xhigh",
      serviceTier: "fast",
    })).toBe("openai/gpt-5.6-luna · xhigh · fast");
    expect(formatAgentIdentity({
      modelName: "openai/gpt-5.6-luna",
      thinking: "max",
    })).toBe("openai/gpt-5.6-luna · max");
    expect(formatAgentIdentity({
      modelName: "openai/gpt-5.6-luna",
    })).toBe("openai/gpt-5.6-luna");
    expect(formatAgentIdentity({})).toBeUndefined();
  });

  it("uses the resumed session metadata when no invocation snapshot exists", () => {
    expect(buildResumedInvocation({
      session: {
        model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        thinkingLevel: "xhigh",
      },
      serviceTier: "fast",
      maxTurns: 30,
      isBackground: true,
    })).toEqual({
      modelName: "openai/gpt-5.6-luna",
      thinking: "xhigh",
      serviceTier: "fast",
      maxTurns: 30,
      runInBackground: true,
    });
  });

  it("recovers exact invocation metadata from any agent record", () => {
    expect(buildRecordInvocation({
      invocation: undefined,
      session: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "max" },
      model: "openai/stale-model",
      thinking: "high",
      serviceTier: "fast",
      maxTurns: 12,
      isBackground: true,
      worktree: undefined,
    } as any)).toEqual({
      modelName: "openai/gpt-5.6-luna",
      thinking: "max",
      serviceTier: "fast",
      maxTurns: 12,
      runInBackground: true,
      isolation: undefined,
    });
  });

  it("keeps an inherited model visible next to the name, leaves flags as tags, and avoids duplicating max turns", () => {
    const parentModel = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    const invocation = buildInvocationTags({
      modelName: formatModelName(parentModel),
      serviceTier: "fast",
      thinking: "xhigh",
      maxTurns: 30,
      isolation: "worktree",
    });

    expect(invocation).toEqual({
      modelName: "openai/gpt-5.6-luna",
      identity: "openai/gpt-5.6-luna · xhigh · fast",
      tags: ["worktree"],
    });

    expect(getAgentStatsParts({
      displayName: "Worker",
      description: "Draft dashboard read plan",
      subagentType: "worker",
      modelName: invocation.modelName,
      thinking: "xhigh",
      serviceTier: "fast",
      identity: invocation.identity,
      tags: invocation.tags,
      toolUses: 54,
      tokens: "146.1k token",
      durationMs: 0,
      status: "running",
      turnCount: 13,
      maxTurns: 30,
    })).toEqual([
      "openai/gpt-5.6-luna · xhigh · fast",
      "worktree",
      "↻13≤30",
      " 54",
      " 146.1k",
    ]);
  });
});
