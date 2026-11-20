import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
  };
});

import { AGENT_RECORD_ENTRY_TYPE } from "../src/agent-record-entry.js";
import { getDefaultMaxTurns, resumeAgent, runAgent, setDefaultMaxTurns } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const OPENAI_MODEL = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
  api: "openai-responses",
} as const;

const SESSION_ID = "optional-params-session";

function makeSession(thinkingLevel = "medium") {
  return {
    model: OPENAI_MODEL,
    thinkingLevel,
    messages: [],
    dispose: vi.fn(),
  };
}

describe("Agent tool optional blank strings and zero numeric limits (AC-12)", () => {
  describe("top-level Agent schema validation (validateToolArguments)", () => {
    it("accepts blank/whitespace-only optional strings and max_turns: 0", () => {
      const hermetic = hermeticDir();
      try {
        const { pi, tools } = makePi();
        subagentsExtension(pi);
        const agentTool = tools.get("Agent");

        const args = {
          prompt: "Inspect files",
          description: "inspect files",
          subagent_type: "worker",
          name: "  ",
          resume: "",
          thinking: " ",
          service_tier: "",
          schedule: "  ",
          isolation: "",
          max_turns: 0,
        };
        expect(() =>
          validateToolArguments(agentTool, { type: "toolCall", id: "tc-1", name: "Agent", arguments: args }),
        ).not.toThrow();

        const whitespaceArgs = {
          prompt: "Inspect files",
          description: "inspect files",
          subagent_type: "worker",
          name: "",
          resume: "   ",
          thinking: "",
          service_tier: "   ",
          schedule: "",
          isolation: "   ",
          max_turns: 0,
        };
        expect(() =>
          validateToolArguments(agentTool, { type: "toolCall", id: "tc-2", name: "Agent", arguments: whitespaceArgs }),
        ).not.toThrow();
      } finally {
        hermetic.restore();
      }
    });

    it.each([
      ["isolation", "bogus"],
      ["thinking", "invalid"],
      ["service_tier", "turbo"],
      ["max_turns", -1],
    ])("rejects invalid %s=%j at schema validation time", (field, value) => {
      const hermetic = hermeticDir();
      try {
        const { pi, tools } = makePi();
        subagentsExtension(pi);
        const agentTool = tools.get("Agent");

        expect(() =>
          validateToolArguments(agentTool, {
            type: "toolCall",
            id: "tc-bad",
            name: "Agent",
            arguments: {
              prompt: "Inspect files",
              description: "inspect files",
              subagent_type: "worker",
              [field]: value,
            },
          }),
        ).toThrow(/Validation failed/);
      } finally {
        hermetic.restore();
      }
    });
  });

  describe("top-level Agent execute()", () => {
    let prevDefaultMaxTurns: number | undefined;

    beforeEach(() => {
      prevDefaultMaxTurns = getDefaultMaxTurns();
      setDefaultMaxTurns(undefined);
      vi.mocked(runAgent).mockReset();
      vi.mocked(resumeAgent).mockReset();
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const session = makeSession(options?.thinkingLevel ?? "medium");
        options?.onSessionCreated?.(session as any);
        return { responseText: "done", session: session as any, aborted: false, steered: false };
      });
      vi.mocked(resumeAgent).mockImplementation(async () => ({
        text: "resumed",
        aborted: false,
        steered: false,
      }));
    });

    afterEach(() => {
      setDefaultMaxTurns(prevDefaultMaxTurns);
    });

    it("treats blank optional strings and max_turns: 0 as omitted when no frontmatter overrides exist", async () => {
      const hermetic = hermeticDir();
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        const result = await tools.get("Agent").execute(
          "tc-blank",
          {
            prompt: "Do work",
            description: "do work",
            subagent_type: "worker",
            name: "  ",
            resume: "",
            thinking: " ",
            service_tier: "  ",
            schedule: "  ",
            isolation: "",
            max_turns: 0,
            run_in_background: false,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toContain("Agent completed");
        expect(runAgent).toHaveBeenCalledTimes(1);
        expect(resumeAgent).not.toHaveBeenCalled();

        const runOpts = vi.mocked(runAgent).mock.calls[0][3];
        expect(runOpts?.thinkingLevel).toBeUndefined();
        expect(runOpts?.serviceTier).toBeUndefined();
        expect(runOpts?.maxTurns).toBeUndefined();
        expect(runOpts?.worktreeBase).toBeUndefined();
        // A blank name must not be assigned a bogus `@agent` alias.
        const savedEntries = pi.appendEntry.mock.calls
          .filter(([type]: [string]) => type === AGENT_RECORD_ENTRY_TYPE)
          .map(([, data]: [string, any]) => data);
        expect(savedEntries).toHaveLength(1);
        expect(savedEntries[0]?.alias).toBeUndefined();

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });

    it("preserves agent frontmatter defaults when caller passes blank strings and max_turns: 0", async () => {
      const hermetic = hermeticDir({
        agentFiles: {
          pinned: [
            "---",
            "description: pinned agent",
            "tools: read",
            "thinking: high",
            "service_tier: fast",
            "max_turns: 7",
            "---",
            "Pinned body",
          ].join("\n"),
        },
      });
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        const result = await tools.get("Agent").execute(
          "tc-frontmatter",
          {
            prompt: "Do pinned work",
            description: "pinned work",
            subagent_type: "pinned",
            name: " ",
            resume: "  ",
            thinking: "  ",
            service_tier: "   ",
            schedule: " ",
            isolation: "  ",
            max_turns: 0,
            run_in_background: false,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(result.isError).not.toBe(true);
        expect(runAgent).toHaveBeenCalledTimes(1);

        const runOpts = vi.mocked(runAgent).mock.calls[0][3];
        expect(runOpts?.thinkingLevel).toBe("high");
        expect(runOpts?.serviceTier).toBe("fast");
        expect(runOpts?.maxTurns).toBe(7);
        // Blank thinking must not show up as an overridden `(asked  )` tag.
        expect(result.details?.identity ?? "").not.toContain("asked");

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });

    it("falls back to the project default maxTurns when frontmatter is unset and max_turns is 0", async () => {
      const hermetic = hermeticDir();
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        setDefaultMaxTurns(12);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        const result = await tools.get("Agent").execute(
          "tc-default-turns",
          {
            prompt: "Do work",
            description: "do work",
            subagent_type: "worker",
            max_turns: 0,
            run_in_background: false,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(result.isError).not.toBe(true);
        expect(vi.mocked(runAgent).mock.calls[0]?.[3]?.maxTurns).toBe(12);

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });

    it("does not trigger a resume/schedule conflict when resume is blank and schedule is set", async () => {
      const hermetic = hermeticDir();
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        const result = await tools.get("Agent").execute(
          "tc-sched-blank-resume",
          {
            prompt: "Nightly check",
            description: "nightly check",
            subagent_type: "worker",
            resume: "   ",
            schedule: " 0 3 * * * * ",
            thinking: " ",
            service_tier: "",
            isolation: "  ",
            max_turns: 0,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toContain("Scheduled");
        const store = new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID));
        expect(store.list()).toHaveLength(1);
        expect(store.list()[0]?.schedule).toBe("0 3 * * * *");

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });

    it("does not trigger a resume/schedule conflict when schedule is blank and resume is set, and treats max_turns: 0 as omitted on resume", async () => {
      const hermetic = hermeticDir({
        agentFiles: {
          capped: "---\ndescription: capped\ntools: read\nmax_turns: 9\n---\ncapped\n",
        },
      });
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        // Spawn once so we have a live completed record with a session.
        const first = await tools.get("Agent").execute(
          "tc-spawn",
          {
            prompt: "Initial pass",
            description: "initial pass",
            subagent_type: "capped",
            run_in_background: false,
          },
          undefined,
          vi.fn(),
          c,
        );
        expect(first.isError).not.toBe(true);
        const agentId = pi.appendEntry.mock.calls
          .filter(([type]: [string]) => type === AGENT_RECORD_ENTRY_TYPE)
          .map(([, data]: [string, any]) => data.id)
          .at(-1);
        expect(typeof agentId).toBe("string");

        const resumed = await tools.get("Agent").execute(
          "tc-resume",
          {
            prompt: "Follow up",
            description: "follow up",
            subagent_type: "capped",
            resume: `  ${agentId}  `,
            schedule: "   ",
            thinking: " ",
            service_tier: " ",
            isolation: " ",
            max_turns: 0,
            run_in_background: false,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(resumed.isError).not.toBe(true);
        expect(textOf(resumed)).toContain("resumed");
        expect(resumeAgent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(resumeAgent).mock.calls[0]?.[2]?.maxTurns).toBe(9);

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });

    it.each([
      ["isolation", "bogus", /Invalid isolation/i],
      ["thinking", "invalid", /Invalid thinking/i],
      ["service_tier", "turbo", /Invalid service_tier/i],
      ["max_turns", -1, /Invalid max_turns/i],
    ])("rejects invalid %s=%j in execute() without spawning", async (field, value, pattern) => {
      const hermetic = hermeticDir();
      const { pi, tools, lifecycle } = makePi();
      try {
        subagentsExtension(pi);
        const c = ctx({
          model: OPENAI_MODEL,
          sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
        });
        await lifecycle.get("session_start")?.({}, c);

        const result = await tools.get("Agent").execute(
          "tc-invalid",
          {
            prompt: "Do work",
            description: "do work",
            subagent_type: "worker",
            [field]: value,
          },
          undefined,
          vi.fn(),
          c,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(pattern);
        expect(runAgent).not.toHaveBeenCalled();
        expect(resumeAgent).not.toHaveBeenCalled();

        await lifecycle.get("session_shutdown")?.();
      } finally {
        hermetic.restore();
      }
    });
  });

  describe("nested Agent schema validation and execute()", () => {
    let cwd: string;
    let records: Map<string, any>;
    let spawn: ReturnType<typeof vi.fn>;
    let spawnAndWait: ReturnType<typeof vi.fn>;
    let resume: ReturnType<typeof vi.fn>;
    let manager: NestedAgentManager;

    function writeAgent(name: string, extra = "") {
      const dir = join(cwd, ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${extra}---\n${name}\n`);
    }

    function makeNestedAgentTool() {
      return createNestedSubagentTools({
        manager,
        pi: {} as any,
        parentAgentId: "parent-1",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: cwd,
      })[0];
    }

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "nested-optional-params-"));
      writeAgent("scout");
      writeAgent("pinned", "thinking: high\nmax_turns: 8\nisolation: worktree\n");
      registerAgents(loadCustomAgents(cwd));
      records = new Map();
      spawn = vi.fn((_pi, _ctx, type, _prompt, options) => {
        const id = `child-${records.size + 1}`;
        records.set(id, { id, type, status: "running", parentAgentId: options.parentAgentId });
        return id;
      });
      spawnAndWait = vi.fn(async (_pi, _ctx, type, _prompt, options) => {
        const id = `child-${records.size + 1}`;
        const record = { id, type, status: "completed", result: "nested done", parentAgentId: options.parentAgentId };
        records.set(id, record);
        return { id, record };
      });
      resume = vi.fn(async (id: string) => ({
        id,
        type: records.get(id)?.type ?? "scout",
        status: "completed",
        result: "nested resumed",
        parentAgentId: "parent-1",
      }));
      manager = {
        spawn,
        spawnAndWait,
        awaitStartup: vi.fn(async () => {}),
        getRecord: (id: string) => records.get(id),
        resume,
      } as any;
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it("accepts blank optional strings and max_turns: 0 in schema validation and rejects invalid values", () => {
      const nestedAgent = makeNestedAgentTool();
      const base = { prompt: "Find files", description: "find files", subagent_type: "scout" };

      expect(() =>
        validateToolArguments(nestedAgent as any, {
          type: "toolCall",
          id: "ntc-1",
          name: "Agent",
          arguments: {
            ...base,
            resume: "  ",
            thinking: " ",
            isolation: "",
            max_turns: 0,
          },
        }),
      ).not.toThrow();

      for (const [field, value] of [
        ["isolation", "bogus"],
        ["thinking", "invalid"],
        ["max_turns", -1],
      ] as const) {
        expect(() =>
          validateToolArguments(nestedAgent as any, {
            type: "toolCall",
            id: "ntc-bad",
            name: "Agent",
            arguments: { ...base, [field]: value },
          }),
        ).toThrow(/Validation failed/);
      }
    });

    it("treats blank optional strings and max_turns: 0 as omitted in nested execute()", async () => {
      const nestedAgent = makeNestedAgentTool();
      const result = await nestedAgent.execute(
        "nc-1",
        {
          prompt: "Find files",
          description: "find files",
          subagent_type: "scout",
          resume: "  ",
          thinking: " ",
          isolation: "  ",
          max_turns: 0,
        },
        undefined,
        undefined,
        ctx({ cwd }),
      );

      expect(result.isError).toBe(false);
      expect(resume).not.toHaveBeenCalled();
      expect(spawnAndWait).toHaveBeenCalledTimes(1);
      const opts = spawnAndWait.mock.calls[0][4];
      expect(opts.thinkingLevel).toBeUndefined();
      expect(opts.isolation).toBeUndefined();
      expect(opts.maxTurns).toBeUndefined();
    });

    it("preserves frontmatter defaults on nested spawn when caller sends blank strings and max_turns: 0", async () => {
      const nestedAgent = makeNestedAgentTool();
      const result = await nestedAgent.execute(
        "nc-2",
        {
          prompt: "Run pinned",
          description: "run pinned",
          subagent_type: "pinned",
          resume: "",
          thinking: "   ",
          isolation: "",
          max_turns: 0,
        },
        undefined,
        undefined,
        ctx({ cwd }),
      );

      expect(result.isError).toBe(false);
      expect(spawnAndWait).toHaveBeenCalledTimes(1);
      const opts = spawnAndWait.mock.calls[0][4];
      expect(opts.thinkingLevel).toBe("high");
      expect(opts.maxTurns).toBe(8);
      expect(opts.isolation).toBe("worktree");
    });

    it("treats max_turns: 0 as omitted on nested resume and trims resume id", async () => {
      const nestedAgent = makeNestedAgentTool();
      records.set("child-scout", { id: "child-scout", type: "scout", status: "completed", parentAgentId: "parent-1" });
      records.set("child-pinned", { id: "child-pinned", type: "pinned", status: "completed", parentAgentId: "parent-1" });

      const r1 = await nestedAgent.execute(
        "nc-r1",
        {
          prompt: "Continue scout",
          description: "continue scout",
          subagent_type: "scout",
          resume: "  child-scout  ",
          max_turns: 0,
          thinking: " ",
          isolation: "",
        },
        undefined,
        undefined,
        ctx({ cwd }),
      );
      expect(r1.isError).toBe(false);
      expect(resume).toHaveBeenCalledWith("child-scout", "Continue scout", undefined, { maxTurns: undefined });

      const r2 = await nestedAgent.execute(
        "nc-r2",
        {
          prompt: "Continue pinned",
          description: "continue pinned",
          subagent_type: "pinned",
          resume: "child-pinned",
          max_turns: 0,
        },
        undefined,
        undefined,
        ctx({ cwd }),
      );
      expect(r2.isError).toBe(false);
      expect(resume).toHaveBeenCalledWith("child-pinned", "Continue pinned", undefined, { maxTurns: 8 });
    });

    it.each([
      ["isolation", "bogus", /Invalid isolation/i],
      ["thinking", "invalid", /Invalid thinking/i],
      ["max_turns", -1, /Invalid max_turns/i],
    ])("rejects invalid %s=%j in nested execute() without spawning or resuming", async (field, value, pattern) => {
      const nestedAgent = makeNestedAgentTool();
      const result = await nestedAgent.execute(
        "nc-bad",
        {
          prompt: "Find files",
          description: "find files",
          subagent_type: "scout",
          [field]: value,
        } as any,
        undefined,
        undefined,
        ctx({ cwd }),
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(pattern);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnAndWait).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });
  });
});
