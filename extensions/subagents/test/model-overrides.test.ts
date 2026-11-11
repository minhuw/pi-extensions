import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRegistry,
  getAgentConfig,
  getAgentConfigIn,
  registerAgents,
  setDefaultsDisabled,
} from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import {
  applyModelOverridesToRegistry,
  clearAgentModelOverride,
  clearSessionModelOverrides,
  getActiveModelOverride,
  getPersistentModelOverrides,
  getSessionModelOverrides,
  SUBAGENT_MODELS_FILENAME,
  setAgentModelOverride,
} from "../src/model-overrides.js";
import { COUNCIL_AGENT_NAMES, type AgentConfig } from "../src/types.js";

function makeCustomAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "auditor",
    description: "Custom auditor",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "Audit code.",
    promptMode: "replace",
    ...overrides,
  };
}

describe("model-overrides", () => {
  let tempAgentDir: string;
  let extraDirs: string[];
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    tempAgentDir = mkdtempSync(join(tmpdir(), "pi-subagent-models-"));
    extraDirs = [];
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    clearSessionModelOverrides();
    setDefaultsDisabled(false);
    registerAgents(new Map());
  });

  afterEach(() => {
    clearSessionModelOverrides();
    setDefaultsDisabled(false);
    registerAgents(new Map());
    vi.restoreAllMocks();

    if (prevAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }

    rmSync(tempAgentDir, { recursive: true, force: true });
    for (const dir of extraDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("persistent read/write/clear and on-disk format", () => {
    it("returns {} when subagent-models.json does not exist", () => {
      expect(getPersistentModelOverrides()).toEqual({});
      expect(getActiveModelOverride("recon")).toBeUndefined();
    });

    it("writes plain JSON object on disk, normalizes names, and leaves no temp files", () => {
      setAgentModelOverride("  Recon ", { mode: "model", model: "  magpie/deepseek-v3.2  " });
      setAgentModelOverride("WORKER", { mode: "inherit" });
      setAgentModelOverride("nested-id", { mode: "model", model: "magpie/codex/gpt-6-luna" });

      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);
      expect(existsSync(filePath)).toBe(true);
      expect(readdirSync(tempAgentDir)).toEqual([SUBAGENT_MODELS_FILENAME]);

      const rawDisk = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(rawDisk).toEqual({
        recon: "magpie/deepseek-v3.2",
        worker: "inherit",
        "nested-id": "magpie/codex/gpt-6-luna",
      });

      expect(getPersistentModelOverrides()).toEqual({
        recon: { mode: "model", model: "magpie/deepseek-v3.2" },
        worker: { mode: "inherit" },
        "nested-id": { mode: "model", model: "magpie/codex/gpt-6-luna" },
      });
    });

    it("removes subagent-models.json when clearing leaves persistent map empty", () => {
      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);
      setAgentModelOverride("recon", { mode: "model", model: "magpie/deepseek-v3.2" });
      setAgentModelOverride("worker", { mode: "inherit" });
      expect(existsSync(filePath)).toBe(true);

      expect(clearAgentModelOverride("recon", "persistent")).toBe(true);
      expect(existsSync(filePath)).toBe(true);
      expect(getPersistentModelOverrides()).toEqual({
        worker: { mode: "inherit" },
      });

      expect(clearAgentModelOverride("WORKER", "persistent")).toBe(true);
      expect(existsSync(filePath)).toBe(false);
      expect(getPersistentModelOverrides()).toEqual({});

      // Clearing again when nothing is set returns false without creating files
      expect(clearAgentModelOverride("worker", "persistent")).toBe(false);
      expect(existsSync(filePath)).toBe(false);
    });

    it("resolves PI_CODING_AGENT_DIR dynamically on each call and honors explicit agentDir", () => {
      const secondDir = mkdtempSync(join(tmpdir(), "pi-subagent-models-alt-"));
      extraDirs.push(secondDir);

      setAgentModelOverride("recon", { mode: "model", model: "anthropic/claude-sonnet-4-5" });
      process.env.PI_CODING_AGENT_DIR = secondDir;

      expect(getPersistentModelOverrides()).toEqual({});
      setAgentModelOverride("recon", { mode: "inherit" });

      expect(getPersistentModelOverrides()).toEqual({
        recon: { mode: "inherit" },
      });
      expect(getPersistentModelOverrides(tempAgentDir)).toEqual({
        recon: { mode: "model", model: "anthropic/claude-sonnet-4-5" },
      });
    });

    it("validates agent name and model string strictly on setAgentModelOverride", () => {
      expect(() => setAgentModelOverride("", { mode: "inherit" })).toThrow(/empty/i);
      expect(() => setAgentModelOverride("   ", { mode: "inherit" })).toThrow(/empty/i);

      for (const badModel of ["", "   ", "gpt-5", "inherit", "/gpt-5", "openai/", "openai/   ", "  /gpt-5", "openai///"]) {
        expect(() => setAgentModelOverride("worker", { mode: "model", model: badModel })).toThrow(/provider\/model/i);
      }
    });
  });

  describe("session scope and precedence", () => {
    it("prioritizes session override over persistent override without touching disk", () => {
      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);

      setAgentModelOverride("recon", { mode: "model", model: "magpie/deepseek-v3.2" }, "persistent");
      setAgentModelOverride("recon", { mode: "inherit" }, "session");

      expect(getSessionModelOverrides()).toEqual({
        recon: { mode: "inherit" },
      });
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({
        recon: "magpie/deepseek-v3.2",
      });
      expect(getActiveModelOverride("RECON")).toEqual({
        scope: "session",
        value: { mode: "inherit" },
      });

      // Clearing session reveals persistent override
      expect(clearAgentModelOverride("recon", "session")).toBe(true);
      expect(getActiveModelOverride("recon")).toEqual({
        scope: "persistent",
        value: { mode: "model", model: "magpie/deepseek-v3.2" },
      });
    });

    it("setting a persistent override clears any stale session override for that same agent", () => {
      setAgentModelOverride("recon", { mode: "model", model: "magpie/claude-haiku-4-5" }, "session");
      setAgentModelOverride("worker", { mode: "model", model: "openai/gpt-5" }, "session");
      expect(getAgentConfig("recon")?.model).toBe("magpie/claude-haiku-4-5");

      // User now chooses a persistent override for recon — must take effect immediately
      setAgentModelOverride("RECON", { mode: "model", model: "magpie/deepseek-v3.2" }, "persistent");

      expect(getSessionModelOverrides()).toEqual({
        worker: { mode: "model", model: "openai/gpt-5" },
      });
      expect(getActiveModelOverride("recon")).toEqual({
        scope: "persistent",
        value: { mode: "model", model: "magpie/deepseek-v3.2" },
      });
      expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
      expect(getAgentConfig("worker")?.model).toBe("openai/gpt-5");
    });

    it("caches subagent-models.json by (path, mtimeMs, size) and picks up external edits immediately", () => {
      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);
      const parseSpy = vi.spyOn(JSON, "parse");

      // Missing file is cached without touching JSON.parse
      expect(getAgentConfig("recon")?.model).toBe(DEFAULT_AGENTS.get("recon")?.model);
      expect(getAgentConfig("recon")?.model).toBe(DEFAULT_AGENTS.get("recon")?.model);
      expect(parseSpy).toHaveBeenCalledTimes(0);

      // External creation (e.g. from another Pi window) is picked up immediately and parsed once
      writeFileSync(filePath, JSON.stringify({ recon: "magpie/deepseek-v3.2" }), "utf-8");
      expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
      expect(parseSpy).toHaveBeenCalledTimes(1);

      // Repeated lookups hit the stat cache with zero additional JSON.parse calls
      for (let i = 0; i < 5; i++) {
        expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
        expect(getActiveModelOverride("recon")).toEqual({
          scope: "persistent",
          value: { mode: "model", model: "magpie/deepseek-v3.2" },
        });
      }
      expect(parseSpy).toHaveBeenCalledTimes(1);

      // Mutating a returned snapshot never corrupts the cached map
      const snapshot = getPersistentModelOverrides();
      snapshot.recon = { mode: "inherit" };
      expect(getAgentConfig("recon")?.model).toBe("magpie/deepseek-v3.2");
      expect(parseSpy).toHaveBeenCalledTimes(1);

      // External edit changing file size is picked up immediately
      writeFileSync(filePath, JSON.stringify({ recon: "anthropic/claude-sonnet-4-5" }), "utf-8");
      expect(getAgentConfig("recon")?.model).toBe("anthropic/claude-sonnet-4-5");
      expect(parseSpy).toHaveBeenCalledTimes(2);
      expect(getAgentConfig("recon")?.model).toBe("anthropic/claude-sonnet-4-5");
      expect(parseSpy).toHaveBeenCalledTimes(2);

      // External edit with identical byte size ("anthropic/claude-sonnet-4-5" -> "anthropic/claude-haiku-4-51")
      // and updated mtime is also picked up immediately
      writeFileSync(filePath, JSON.stringify({ recon: "anthropic/claude-haiku-4-51" }), "utf-8");
      const bumpedTime = new Date(Date.now() + 2_000);
      utimesSync(filePath, bumpedTime, bumpedTime);
      expect(getAgentConfig("recon")?.model).toBe("anthropic/claude-haiku-4-51");
      expect(parseSpy).toHaveBeenCalledTimes(3);

      // In-process setAgentModelOverride updates the cache directly without needing another JSON.parse
      setAgentModelOverride("recon", { mode: "inherit" }, "persistent");
      expect(getAgentConfig("recon")?.model).toBeUndefined();
      expect(parseSpy).toHaveBeenCalledTimes(3);

      // External deletion restores the default model immediately
      rmSync(filePath, { force: true });
      expect(getAgentConfig("recon")?.model).toBe(DEFAULT_AGENTS.get("recon")?.model);
      expect(getActiveModelOverride("recon")).toBeUndefined();
    });

    it("default clear scope ('all') clears both session and persistent overrides", () => {
      setAgentModelOverride("worker", { mode: "model", model: "openai/gpt-5" }, "persistent");
      setAgentModelOverride("worker", { mode: "inherit" }, "session");

      expect(clearAgentModelOverride("worker")).toBe(true);
      expect(getActiveModelOverride("worker")).toBeUndefined();
      expect(getSessionModelOverrides()).toEqual({});
      expect(getPersistentModelOverrides()).toEqual({});
      expect(existsSync(join(tempAgentDir, SUBAGENT_MODELS_FILENAME))).toBe(false);
    });

    it("clearSessionModelOverrides clears session state while preserving persistent overrides", () => {
      setAgentModelOverride("recon", { mode: "model", model: "magpie/deepseek-v3.2" }, "persistent");
      setAgentModelOverride("recon", { mode: "inherit" }, "session");
      setAgentModelOverride("worker", { mode: "model", model: "openai/gpt-5" }, "session");

      clearSessionModelOverrides();

      expect(getSessionModelOverrides()).toEqual({});
      expect(getActiveModelOverride("worker")).toBeUndefined();
      expect(getActiveModelOverride("recon")).toEqual({
        scope: "persistent",
        value: { mode: "model", model: "magpie/deepseek-v3.2" },
      });
    });
  });

  describe("council advisor protection and malformed file resilience", () => {
    it.each(COUNCIL_AGENT_NAMES)("rejects overriding pinned council advisor %s in any scope", advisor => {
      const expectedMsg = `Council advisor "${advisor}" has a pinned model and cannot be overridden.`;
      expect(() => setAgentModelOverride(advisor, { mode: "inherit" }, "persistent")).toThrow(expectedMsg);
      expect(() =>
        setAgentModelOverride(advisor.toUpperCase(), { mode: "model", model: "openai/gpt-5" }, "session"),
      ).toThrow(expectedMsg);
    });

    it("ignores malformed entries and council keys in hand-edited subagent-models.json", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);

      writeFileSync(
        filePath,
        JSON.stringify({
          recon: "magpie/deepseek-v3.2",
          worker: "inherit",
          "council-argon": "openai/gpt-5",
          "COUNCIL-ASTRA": "inherit",
          "council-opus": "anthropic/claude-haiku-4-5",
          badNoSlash: "gpt-5",
          badEmptyProvider: "/gpt-5",
          badEmptyModel: "openai/",
          badNumber: 42,
          badObject: { mode: "inherit" },
          "   ": "openai/gpt-5",
        }),
        "utf-8",
      );

      expect(getPersistentModelOverrides()).toEqual({
        recon: { mode: "model", model: "magpie/deepseek-v3.2" },
        worker: { mode: "inherit" },
      });

      for (const advisor of COUNCIL_AGENT_NAMES) {
        const defaultModel = DEFAULT_AGENTS.get(advisor)?.model;
        expect(defaultModel).toBeDefined();
        expect(getActiveModelOverride(advisor)).toBeUndefined();
        expect(getAgentConfig(advisor)?.model).toBe(defaultModel);
      }

      const registry = buildAgentRegistry(new Map());
      for (const advisor of COUNCIL_AGENT_NAMES) {
        expect(registry.get(advisor)?.model).toBe(DEFAULT_AGENTS.get(advisor)?.model);
      }
    });

    it("recovers gracefully when subagent-models.json contains invalid JSON or non-objects", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const filePath = join(tempAgentDir, SUBAGENT_MODELS_FILENAME);

      writeFileSync(filePath, "{broken json", "utf-8");
      expect(getPersistentModelOverrides()).toEqual({});

      writeFileSync(filePath, JSON.stringify(["not", "an", "object"]), "utf-8");
      expect(getPersistentModelOverrides()).toEqual({});

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("agent-types registry integration and immutability", () => {
    it("updates getAgentConfig and buildAgentRegistry immediately without mutating DEFAULT_AGENTS or custom configs", () => {
      const originalRecon = DEFAULT_AGENTS.get("recon")!;
      const originalReconModel = originalRecon.model;
      const originalWorker = DEFAULT_AGENTS.get("worker")!;
      const originalWorkerModel = originalWorker.model;

      const auditor = makeCustomAgent({ name: "auditor", model: "custom/base-model" });
      registerAgents(new Map([["auditor", auditor]]));

      // Without overrides, exact references are preserved
      expect(getAgentConfig("auditor")).toBe(auditor);
      expect(getAgentConfig("recon")?.model).toBe(originalReconModel);

      // Persistent override beats .md custom config and DEFAULT_AGENTS immediately (no re-register needed)
      setAgentModelOverride("auditor", { mode: "model", model: "magpie/persistent-model" }, "persistent");
      setAgentModelOverride("recon", { mode: "inherit" }, "persistent");
      setAgentModelOverride("worker", { mode: "model", model: "magpie/worker-model" }, "persistent");

      expect(getAgentConfig("auditor")?.model).toBe("magpie/persistent-model");
      expect(getAgentConfig("recon")?.model).toBeUndefined();
      expect(getAgentConfig("worker")?.model).toBe("magpie/worker-model");

      // Session override beats persistent immediately
      setAgentModelOverride("auditor", { mode: "inherit" }, "session");
      setAgentModelOverride("recon", { mode: "model", model: "magpie/session-recon" }, "session");
      expect(getAgentConfig("auditor")?.model).toBeUndefined();
      expect(getAgentConfig("recon")?.model).toBe("magpie/session-recon");

      // buildAgentRegistry (used by nested-tools) sees the same precedence and does not add unknown agents
      setAgentModelOverride("nonexistent-agent", { mode: "model", model: "openai/gpt-5" }, "session");
      const built = buildAgentRegistry(new Map([["auditor", auditor]]));
      expect(getAgentConfigIn(built, "auditor")?.model).toBeUndefined();
      expect(getAgentConfigIn(built, "recon")?.model).toBe("magpie/session-recon");
      expect(getAgentConfigIn(built, "worker")?.model).toBe("magpie/worker-model");
      expect(built.has("nonexistent-agent")).toBe(false);

      // Applying applyModelOverridesToRegistry twice is idempotent
      const secondPass = applyModelOverridesToRegistry(built);
      expect(secondPass).toBe(built);
      expect(getAgentConfigIn(secondPass, "auditor")?.model).toBeUndefined();
      expect(getAgentConfigIn(secondPass, "recon")?.model).toBe("magpie/session-recon");
      expect(getAgentConfigIn(secondPass, "worker")?.model).toBe("magpie/worker-model");

      // Clearing overrides immediately restores persistent -> custom .md / DEFAULT_AGENTS without re-registering
      clearSessionModelOverrides();
      expect(getAgentConfig("auditor")?.model).toBe("magpie/persistent-model");
      expect(getAgentConfig("recon")?.model).toBeUndefined();

      clearAgentModelOverride("auditor", "persistent");
      clearAgentModelOverride("recon", "persistent");
      clearAgentModelOverride("worker", "persistent");

      expect(getAgentConfig("auditor")).toBe(auditor);
      expect(getAgentConfig("auditor")?.model).toBe("custom/base-model");
      expect(getAgentConfig("recon")?.model).toBe(originalReconModel);
      expect(getAgentConfig("worker")?.model).toBe(originalWorkerModel);

      // DEFAULT_AGENTS and custom objects were never mutated in place
      expect(originalRecon.model).toBe(originalReconModel);
      expect(originalWorker.model).toBe(originalWorkerModel);
      expect(auditor.model).toBe("custom/base-model");
    });
  });
});
