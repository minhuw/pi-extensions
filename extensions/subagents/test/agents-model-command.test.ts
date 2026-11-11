import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import subagentsExtension from "../src/index.js";
import { clearSessionModelOverrides, SUBAGENT_MODELS_FILENAME } from "../src/model-overrides.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const DEFAULT_RECON_MODEL = DEFAULT_AGENTS.get("recon")!.model!;
const RESOLVED_DEFAULT_RECON_MODEL = DEFAULT_RECON_MODEL.includes("/")
  ? DEFAULT_RECON_MODEL
  : `magpie/${DEFAULT_RECON_MODEL}`;

const AVAILABLE_MODELS = [
  { provider: "magpie", id: "deepseek-flash", name: "DeepSeek Flash", api: "openai-completions" },
  { provider: "magpie", id: "codex/gpt-6-luna", name: "GPT-6 Luna", api: "cliproxyapi-codex-responses" },
  { provider: "magpie", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-responses" },
  { provider: "magpie", id: "deepseek-v3.2", name: "DeepSeek V3.2", api: "anthropic-messages" },
  { provider: "magpie", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "anthropic-messages" },
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "anthropic-messages" },
];

const DEEPSEEK_V32_MODEL = AVAILABLE_MODELS.find(m => m.provider === "magpie" && m.id === "deepseek-v3.2")!;
const GPT_SOL_MODEL = AVAILABLE_MODELS.find(m => m.provider === "magpie" && m.id === "gpt-6.1-sol")!;
const CLAUDE_HAIKU_MODEL = AVAILABLE_MODELS.find(m => m.provider === "magpie" && m.id === "claude-haiku-4-5")!;

function makeRegistry(models = AVAILABLE_MODELS) {
  return {
    find: vi.fn((provider: string, id: string) =>
      models.find(
        m => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === id.toLowerCase(),
      ),
    ),
    getAvailable: vi.fn(() => models),
    getAll: vi.fn(() => models),
  };
}

function boot() {
  const booted = makePi();
  subagentsExtension(booted.pi);
  const command = booted.commands.get("agents");
  const agentTool = booted.tools.get("Agent");
  if (!command) throw new Error("expected /agents command to be registered");
  if (!agentTool) throw new Error("expected Agent tool to be registered");
  return { ...booted, command, agentTool };
}

describe("/agents model command & interactive Change model UI", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    initTheme(undefined, false);
    clearSessionModelOverrides();
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    clearSessionModelOverrides();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    delete (globalThis as any)[Symbol.for("pi-subagents:host")];
    registerAgents(new Map());
    hermetic.restore();
    vi.restoreAllMocks();
  });

  it("persists /agents model <agent> <provider/model> without ejecting .md, keeps Agent tool description static, and handles service_tier cleanly", async () => {
    // Write a custom .md agent with service_tier: fast so service_tier behavior is verified deterministically.
    mkdirSync(join(hermetic.dir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(hermetic.dir, ".pi", "agents", "fast-scout.md"),
      [
        "---",
        "description: Fast scout with priority service tier",
        "tools: read, grep",
        "model: magpie/codex/gpt-6-luna",
        "service_tier: fast",
        "---",
        "Inspect code.",
      ].join("\n"),
      "utf-8",
    );

    const { command, agentTool } = boot();
    const initialDescription = agentTool.description;
    const initialSchema = JSON.stringify(agentTool.parameters);
    const notes: Array<{ text: string; level?: string }> = [];
    const registry = makeRegistry();
    const context = ctx({
      model: CLAUDE_HAIKU_MODEL,
      modelRegistry: registry,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    await command.handler("model recon magpie/deepseek-v3.2", context);

    // Persisted to <agentDir>/subagent-models.json without ejecting any .md file
    const overridesPath = join(getAgentDir(), SUBAGENT_MODELS_FILENAME);
    expect(existsSync(overridesPath)).toBe(true);
    expect(JSON.parse(readFileSync(overridesPath, "utf-8"))).toEqual({
      recon: "magpie/deepseek-v3.2",
    });
    expect(existsSync(join(hermetic.dir, ".pi", "agents", "recon.md"))).toBe(false);
    expect(existsSync(join(getAgentDir(), "agents", "recon.md"))).toBe(false);
    expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
    expect(notes.at(-1)).toEqual({
      text: "recon model set to magpie/deepseek-v3.2",
      level: "info",
    });

    // Prompt-cache invariant: Agent tool description & schema are never mutated mid-session
    expect(agentTool.description).toBe(initialDescription);
    expect(JSON.stringify(agentTool.parameters)).toBe(initialSchema);

    // Spawning fast-scout on a non-OpenAI overridden model drops inherited service_tier: fast WITHOUT warning
    await command.handler("model fast-scout magpie/deepseek-v3.2", context);
    notes.length = 0;
    vi.mocked(runAgent).mockImplementation(async (_cwd: any, _type: any, _prompt: any, options: any) => {
      const s = { model: DEEPSEEK_V32_MODEL, thinkingLevel: "high", dispose: vi.fn() };
      options.onSessionCreated?.(s);
      return { responseText: "found it", session: s, aborted: false, steered: false } as never;
    });
    const nonOpenAiResult = await agentTool.execute(
      "tc-deepseek",
      { prompt: "find entry", description: "find entry", subagent_type: "fast-scout", run_in_background: false },
      undefined,
      vi.fn(),
      context,
    );
    expect(notes.filter(n => n.level === "warning")).toEqual([]);
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]?.model).toEqual(DEEPSEEK_V32_MODEL);
    expect(nonOpenAiResult.details.serviceTier).toBeUndefined();

    // Switching fast-scout to an OpenAI Responses model preserves service_tier: fast
    vi.mocked(runAgent).mockClear();
    await command.handler("model fast-scout magpie/gpt-6.1-sol", context);
    vi.mocked(runAgent).mockImplementation(async (_cwd: any, _type: any, _prompt: any, options: any) => {
      const s = { model: GPT_SOL_MODEL, thinkingLevel: "high", dispose: vi.fn() };
      options.onSessionCreated?.(s);
      return { responseText: "found fast", session: s, aborted: false, steered: false } as never;
    });
    const openAiResult = await agentTool.execute(
      "tc-sol",
      { prompt: "find entry", description: "find entry", subagent_type: "fast-scout", run_in_background: false },
      undefined,
      vi.fn(),
      context,
    );
    expect(notes.filter(n => n.level === "warning")).toEqual([]);
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]?.model).toEqual(GPT_SOL_MODEL);
    expect(openAiResult.details.serviceTier).toBe("fast");
  });

  it("applies --session overrides in memory only and clears them on session_start and session_before_switch", async () => {
    const { command, lifecycle } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const context = ctx({
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    await command.handler("model recon magpie/claude-haiku-4-5 --session", context);

    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);
    expect(getAgentConfig("recon")?.model).toBe("magpie/claude-haiku-4-5");
    expect(notes.at(-1)).toEqual({
      text: "recon model set to magpie/claude-haiku-4-5 (this session)",
      level: "info",
    });

    // Resets on session_before_switch
    await lifecycle.get("session_before_switch")?.({ reason: "new" }, context);
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);

    // Re-apply with -s before agent name and verify session_start also clears session overrides
    // while keeping persistent overrides intact.
    await command.handler("model worker magpie/deepseek-v3.2", context);
    await command.handler("model -s recon magpie/claude-haiku-4-5", context);
    expect(getAgentConfig("recon")?.model).toBe("magpie/claude-haiku-4-5");
    expect(getAgentConfig("worker")?.model).toBe("magpie/deepseek-v3.2");

    await lifecycle.get("session_start")?.({ reason: "new" }, context);
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);
    expect(getAgentConfig("worker")?.model).toBe("magpie/deepseek-v3.2");

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("supports inherit and default/reset targets", async () => {
    const { command, agentTool } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const parentModel = CLAUDE_HAIKU_MODEL;
    const context = ctx({
      model: parentModel,
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    await command.handler("model recon inherit", context);
    expect(getAgentConfig("recon")?.model).toBeUndefined();
    expect(notes.at(-1)).toEqual({
      text: "recon model set to inherit parent model (persistent)",
      level: "info",
    });

    // Spawning recon now inherits parent model
    vi.mocked(runAgent).mockImplementation(async (_cwd: any, _type: any, _prompt: any, options: any) => {
      const s = { model: parentModel, thinkingLevel: "high", dispose: vi.fn() };
      options.onSessionCreated?.(s);
      return { responseText: "inherited", session: s, aborted: false, steered: false } as never;
    });
    await agentTool.execute(
      "tc-inherit",
      { prompt: "check", description: "check", subagent_type: "recon", run_in_background: false },
      undefined,
      vi.fn(),
      context,
    );
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]?.model).toBe(parentModel);

    // /agents model recon default restores embedded default and removes empty subagent-models.json
    await command.handler("model recon default", context);
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);
    expect(notes.at(-1)).toEqual({
      text: `recon model reset to default (${DEFAULT_RECON_MODEL})`,
      level: "info",
    });
  });

  it("clears stale --session overrides when setting a persistent override, and reports restored persistent overrides accurately on default --session", async () => {
    const { command } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const context = ctx({
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    // 1. Set a session override first, then set a persistent override -> persistent model takes effect immediately
    await command.handler("model recon magpie/claude-haiku-4-5 --session", context);
    expect(getAgentConfig("recon")?.model).toBe("magpie/claude-haiku-4-5");

    await command.handler("model recon magpie/deepseek-v3.2", context);
    expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
    expect(notes.at(-1)).toEqual({
      text: "recon model set to magpie/deepseek-v3.2",
      level: "info",
    });

    // 2. Layer a new --session override over the persistent override, then clear only --session
    await command.handler("model recon magpie/claude-haiku-4-5 --session", context);
    expect(getAgentConfig("recon")?.model).toBe("magpie/claude-haiku-4-5");

    await command.handler("model recon default --session", context);
    expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(true);
    expect(notes.at(-1)).toEqual({
      text: "recon session model override cleared (now using magpie/deepseek-v3.2)",
      level: "info",
    });

    // 3. When no persistent override exists, default --session still reports reset to default
    await command.handler("model recon default", context);
    await command.handler("model recon magpie/claude-haiku-4-5 --session", context);
    await command.handler("model recon default --session", context);
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);
    expect(notes.at(-1)).toEqual({
      text: `recon model reset to default (${DEFAULT_RECON_MODEL})`,
      level: "info",
    });
  });

  it("rejects council advisors and leaves their pinned models intact", async () => {
    const { command } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const context = ctx({
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    const pinnedBefore = getAgentConfig("council-fable")?.model;
    expect(pinnedBefore).toBe("magpie/claude-fable-5-2");

    await command.handler("model council-fable magpie/deepseek-v3.2", context);

    expect(getAgentConfig("council-fable")?.model).toBe("magpie/claude-fable-5-2");
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);
    expect(notes.at(-1)).toEqual({
      text: 'Council advisor "council-fable" has a pinned model and cannot be overridden.',
      level: "warning",
    });
  });

  it("supports interactive /agents -> Agent types -> recon -> Change model & Reset model override flows", async () => {
    const { command } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const detailMenusSeen: string[][] = [];
    const modelPickersSeen: string[][] = [];
    const renderedAgentLists: string[] = [];

    let phase: "change" | "reset" = "change";
    let rootVisited = false;
    let listVisitInTrip = 0;

    const context = ctx({
      hasUI: true,
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents") {
            if (rootVisited) return undefined;
            rootVisited = true;
            return options.find(opt => opt.startsWith("Agent types ("));
          }
          if (title === "recon") {
            detailMenusSeen.push(options);
            return phase === "change" ? "Change model" : "Reset model override";
          }
          if (title === "Select model for recon") {
            modelPickersSeen.push(options);
            return "magpie/deepseek-v3.2";
          }
          return undefined;
        }),
        custom: vi.fn(async (factory: (...args: any[]) => any) => {
          let selectedId: string | undefined;
          const tui = { requestRender: () => {} };
          const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
          const component = factory(tui, theme, {}, (val: string | undefined) => {
            selectedId = val;
          });
          renderedAgentLists.push(component.render(140).join("\n"));
          listVisitInTrip += 1;
          if (listVisitInTrip === 1) {
            // Highlighted row 0 is "recon" — press Enter to open showAgentDetail("recon")
            component.handleInput("\r");
          } else {
            // Second render after returning from showAgentDetail — press Esc to exit
            component.handleInput("\x1b");
          }
          return selectedId;
        }),
      },
    });

    // Trip 1: /agents -> Agent types -> recon -> Change model -> magpie/deepseek-v3.2
    await command.handler("", context);

    expect(detailMenusSeen[0]).toContain("Change model");
    expect(detailMenusSeen[0]).not.toContain("Reset model override");
    expect(modelPickersSeen[0]?.[0]).toBe(`${RESOLVED_DEFAULT_RECON_MODEL} (current)`);
    expect(modelPickersSeen[0]).toContain("Inherit parent session model");
    expect(modelPickersSeen[0]).not.toContain("Reset to agent default");
    expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
    // Re-rendered Agent types list after Change model shows [override] badge
    expect(renderedAgentLists[1]).toContain("magpie/deepseek-v3.2 [override]");

    // Trip 2: /agents -> Agent types -> recon -> Reset model override
    phase = "reset";
    rootVisited = false;
    listVisitInTrip = 0;
    await command.handler("", context);

    const changeIdx = detailMenusSeen[1]?.indexOf("Change model") ?? -1;
    const resetIdx = detailMenusSeen[1]?.indexOf("Reset model override") ?? -1;
    expect(changeIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBe(changeIdx + 1);
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);
  });

  it("supports interactive /agents model (no args) agent selector + picker", async () => {
    const { command } = boot();
    const seenSelects: Array<{ title: string; options: string[] }> = [];
    const context = ctx({
      hasUI: true,
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
        addAutocompleteProvider: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          seenSelects.push({ title, options });
          if (title === "Select agent to configure model") {
            return options.find(o => o.startsWith("recon — "));
          }
          if (title === "Select model for recon (this session)") {
            return "Inherit parent session model";
          }
          return undefined;
        }),
      },
    });

    await command.handler("model --session", context);

    expect(seenSelects[0]?.title).toBe("Select agent to configure model");
    expect(seenSelects[0]?.options).toContain(`recon — ${DEFAULT_RECON_MODEL}`);
    expect(seenSelects[0]?.options).toContain("worker — inherit");
    expect(seenSelects[0]?.options.some(o => o.startsWith("council-"))).toBe(false);
    expect(getAgentConfig("recon")?.model).toBeUndefined();
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);
  });

  it("fails fast with warnings on unknown models or ambiguous bare model IDs, and resolves unique bare model IDs", async () => {
    const { command } = boot();
    const notes: Array<{ text: string; level?: string }> = [];
    const context = ctx({
      modelRegistry: makeRegistry(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        addAutocompleteProvider: vi.fn(),
      },
    });

    // Typo in provider/model -> warns with substring suggestion and does NOT persist
    await command.handler("model recon magpie/deepseek-v3", context);
    expect(notes.at(-1)?.level).toBe("warning");
    expect(notes.at(-1)?.text).toContain('Model "magpie/deepseek-v3" was not found');
    expect(notes.at(-1)?.text).toContain("magpie/deepseek-v3.2");
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);
    expect(existsSync(join(getAgentDir(), SUBAGENT_MODELS_FILENAME))).toBe(false);

    // Ambiguous bare model ID across multiple providers -> warns listing candidates
    await command.handler("model recon claude-haiku-4-5", context);
    expect(notes.at(-1)?.level).toBe("warning");
    expect(notes.at(-1)?.text).toContain("magpie/claude-haiku-4-5");
    expect(notes.at(-1)?.text).toContain("anthropic/claude-haiku-4-5");
    expect(getAgentConfig("recon")?.model).toBe(DEFAULT_RECON_MODEL);

    // Unique bare model ID -> resolves to canonical provider/model
    await command.handler("model recon deepseek-v3.2", context);
    expect(notes.at(-1)).toEqual({
      text: "recon model set to magpie/deepseek-v3.2",
      level: "info",
    });
    expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
  });

  it("provides Tab argument completions for subcommand, non-council agents, keywords, and models", async () => {
    const { command, lifecycle } = boot();
    const context = ctx({ modelRegistry: makeRegistry() });
    await lifecycle.get("session_start")?.({ reason: "startup" }, context);

    expect(command.getArgumentCompletions("")?.map((i: any) => i.value)).toEqual(["model"]);
    expect(command.getArgumentCompletions("mo")?.map((i: any) => i.value)).toEqual(["model"]);
    expect(command.getArgumentCompletions("model")).toBeNull();

    const agentCompletions = command.getArgumentCompletions("model ")?.map((i: any) => i.label) ?? [];
    expect(agentCompletions).toContain("recon");
    expect(agentCompletions).toContain("worker");
    expect(agentCompletions.some((label: string) => label.startsWith("council-"))).toBe(false);

    const targetCompletions = command.getArgumentCompletions("model recon ")?.map((i: any) => i.label) ?? [];
    expect(targetCompletions).toContain("default");
    expect(targetCompletions).toContain("inherit");
    expect(targetCompletions).toContain("--session");
    expect(targetCompletions).toContain("magpie/deepseek-v3.2");

    expect(command.getArgumentCompletions("model recon deep")?.map((i: any) => i.value)).toEqual([
      "model recon magpie/deepseek-flash",
      "model recon magpie/deepseek-v3.2",
    ]);
    expect(command.getArgumentCompletions("model recon inherit ")?.map((i: any) => i.value)).toEqual([
      "model recon inherit --session",
    ]);

    await lifecycle.get("session_shutdown")?.({}, context);
  });
});
