/**
 * A `context_files` agent, through the REAL runner, loader and session (faux
 * model; assertions on the session as constructed):
 * Pi's normal prompt plus the agent text, every extension tool, nested Agent
 * limited to recon/worker/reviewer/expert, context files bounded at the
 * worktree root, and `linkData` / `parentToolCallId` in the session link.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAgentDefinition, parseAgentFrontmatter } from "../src/agent-definitions.js";
import { serializeAgentFile } from "../src/agent-file-toggle.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { SESSION_LINK_CUSTOM_TYPE } from "../src/child-session-hooks.js";
import { loadBoundedContextFiles } from "../src/context-files.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "../test/helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const HOOKS_KEY = Symbol.for("pi-extensions.child-session-hooks");
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const BOUNDED: AgentConfig = {
  name: "bounded", description: "bounded", modelVisible: false, extensions: true, skills: true,
  contextFiles: true, isolation: "off", allowedSubagents: ["recon", "worker", "reviewer", "expert"],
  requireToolUse: true, systemPrompt: "BOUNDED_INSTRUCTIONS", promptMode: "append",
};

const PROBE_EXTENSION = `export default (pi) => {
  const tool = (name, exposure) => pi.registerTool({ name, label: name, description: name, ...(exposure ? { exposure } : {}),
    parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });
  tool("probe_tool");
  tool("mcp__probe__lookup", "codemode");
};`;

describe("context_files agent (real runner)", () => {
  let base: string;
  let repo: string;
  let worktree: string;
  let cwd: string;
  let agentDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "context-files-"));
    // A main checkout with a linked worktree nested inside it.
    repo = join(base, "repo");
    worktree = join(repo, ".worktrees", "t1");
    cwd = join(worktree, "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "ABOVE_REPO_CTX\n");
    writeFileSync(join(repo, "AGENTS.md"), "ROOT_CTX\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "t1")}\n`);
    writeFileSync(join(worktree, "AGENTS.md"), "WORKTREE_CTX\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "PKG_CTX\n");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "probe.js"), PROBE_EXTENSION);
    agentDir = process.env.PI_CODING_AGENT_DIR!;
    writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_CTX\n");
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    registerAgents(new Map([["bounded", BOUNDED]]));
  });

  afterEach(() => {
    faux.unregister();
    delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
    rmSync(join(agentDir, "AGENTS.md"), { force: true });
    rmSync(base, { recursive: true, force: true });
    registerAgents(new Map());
  });

  /** Run `type` through the real runner; capture the session as constructed. */
  async function construct(type: string, extra: Record<string, unknown> = {}) {
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model, getAll: () => [model], getAvailable: () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {}, unregisterProvider: () => {},
    };
    const ctx: any = {
      cwd, model, modelRegistry, isProjectTrusted: () => true,
      getSystemPrompt: () => "PARENT_PROMPT ROOT_CTX",
      sessionManager: { getSessionId: () => "parent-id", getSessionFile: () => "/parent.jsonl" },
    };
    let session: any;
    try {
      await runAgent(ctx, type, "go", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
        model,
        nestedRuntime: { manager: {} as any, parentAgentId: "agent-1", depth: 1 },
        onSessionCreated: (s) => { session = s; },
        ...extra,
      });
    } catch {
      // The faux turn's outcome is irrelevant; the session was captured at construction.
    }
    expect(session).toBeDefined();
    return session;
  }

  /**
   * Pi's own default preamble, from a bare SDK session (no extensions, context
   * files, skills, or prompt overrides): the text before its `<tools>` section.
   * Derived rather than hard-coded, so Pi rewording its prompt breaks nothing.
   */
  async function piDefaultPreamble(): Promise<string> {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir, model: faux.getModel(), settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      const prompt = session.systemPrompt;
      const end = prompt.indexOf("\n\n<tools>");
      expect(end).toBeGreaterThan(0);
      return prompt.slice(0, end);
    } finally {
      session.dispose();
    }
  }

  it("loads context files from its cwd up to the worktree root, plus the global file", () => {
    const files = loadBoundedContextFiles(cwd, agentDir).map(f => f.content.trim());
    expect(files).toEqual(["GLOBAL_CTX", "WORKTREE_CTX", "PKG_CTX"]);
    // The main checkout's root (`.git` directory) bounds a walk started inside it.
    expect(loadBoundedContextFiles(join(repo, ".worktrees"), agentDir).map(f => f.content.trim()))
      .toEqual(["GLOBAL_CTX", "ROOT_CTX"]);
  });

  it("gets Pi's own prompt with its context files, then its text; not the parent's", async () => {
    const session = await construct("bounded");
    const prompt: string = session.systemPrompt;
    // Pi's own default prompt: its preamble first, then its tool and rule sections.
    expect(prompt.startsWith(await piDefaultPreamble())).toBe(true);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<rules>");
    for (const text of ["GLOBAL_CTX", "WORKTREE_CTX", "PKG_CTX"]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("ROOT_CTX");
    expect(prompt).not.toContain("ABOVE_REPO_CTX");
    expect(prompt).not.toContain("PARENT_PROMPT");
    expect(prompt).toContain('<active_agent name="bounded"/>');
    // Its text is appended after Pi's preamble, tool list and rules.
    expect(prompt.indexOf("BOUNDED_INSTRUCTIONS")).toBeGreaterThan(prompt.indexOf("</rules>"));
  });

  it("has every built-in and extension tool, and nested Agent limited to its allowlist", async () => {
    const session = await construct("bounded");
    const active: string[] = session.getActiveToolNames();
    const registered: string[] = session.getAllTools().map((t: any) => t.name);
    for (const name of [...BUILTINS, "probe_tool", "Agent", "get_subagent_result", "steer_subagent"]) {
      expect(active).toContain(name);
    }
    // MCP server tools reach it as codemode-exposure tools, like the parent's.
    expect(registered).toContain("codemode");
    expect(registered).toContain("mcp__probe__lookup");
    const agent = session.getAllTools().find((t: any) => t.name === "Agent");
    const typeDescription = JSON.stringify(agent.parameters);
    expect(typeDescription).toContain("Available: recon, worker, reviewer, expert.");
    expect(typeDescription).not.toMatch(/\bbounded\b/);
  });

  it("leaves context files off by default", async () => {
    registerAgents(new Map([["plain", {
      name: "plain", description: "plain", extensions: false, skills: false,
      systemPrompt: "Plain.", promptMode: "append",
    } as AgentConfig]]));
    const prompt: string = (await construct("plain")).systemPrompt;
    expect(prompt).toContain("PARENT_PROMPT");
    expect(prompt).not.toContain("WORKTREE_CTX");
    expect(prompt).not.toContain("PKG_CTX");
  });

  it("writes parentToolCallId and linkData into the session link", async () => {
    const hooks = ((globalThis as Record<symbol, unknown>)[HOOKS_KEY] ??= new Set()) as Set<unknown>;
    hooks.add({ name: "noop-hook", extensionFactory: () => {} });
    const session = await construct("bounded", {
      agentId: "agent-9", description: "#9 title", parentToolCallId: "call-9",
      linkData: { origin: { id: 9, title: "title" } },
    });
    const link = session.sessionManager.getEntries().find(
      (e: any) => e.type === "custom" && e.customType === SESSION_LINK_CUSTOM_TYPE,
    );
    expect(link?.data).toEqual({
      kind: "subagent", parentSessionId: "parent-id", parentSessionFile: "/parent.jsonl",
      parentToolCallId: "call-9", agentId: "agent-9", agentType: "bounded", description: "#9 title",
      origin: { id: 9, title: "title" },
    });
  });
});

describe("model_visible / context_files frontmatter", () => {
  const parse = (text: string) => {
    const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>(text);
    return parseAgentDefinition(frontmatter, body, { filename: "a", sourcePath: "/a.md", source: "project" })!;
  };

  it("parses both values and leaves them unset when absent", () => {
    expect(parse("---\nmodel_visible: false\ncontext_files: true\n---\nx\n")).toMatchObject({ modelVisible: false, contextFiles: true });
    expect(parse("---\nmodel_visible: true\ncontext_files: false\n---\nx\n")).toMatchObject({ modelVisible: true, contextFiles: false });
    const unset = parse("---\ndescription: a\n---\nx\n");
    expect([unset.modelVisible, unset.contextFiles]).toEqual([undefined, undefined]);
  });

  it("round-trips through eject", () => {
    const text = serializeAgentFile(BOUNDED);
    expect(text).toContain("model_visible: false");
    expect(text).toContain("context_files: true");
    expect(parse(text)).toMatchObject({ modelVisible: false, contextFiles: true, promptMode: "append" });
  });
});
