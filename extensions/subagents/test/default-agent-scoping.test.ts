/**
 * default-agent-scoping.test.ts — End-to-end verification of default `recon` and
 * `worker` extension, tool, child-session hook, and MCP scoping on the real
 * pi-coding-agent loader and session runtime.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type ToolActivity } from "../src/agent-runner.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const HOOKS_KEY = Symbol.for("pi-extensions.child-session-hooks");

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
}

function writeExtension(cwd: string, relFile: string, body: string): void {
  const fullPath = join(cwd, ".pi", "extensions", relFile);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, body);
}

function writeToolExtension(cwd: string, dirOrFile: string, toolNames: string[], startedKey?: string): void {
  const relFile = dirOrFile.endsWith(".js") ? dirOrFile : join(dirOrFile, "index.js");
  const startHook = startedKey
    ? `pi.on("session_start", () => { (globalThis.__startedExts ??= []).push(${JSON.stringify(startedKey)}); });`
    : "";
  writeExtension(
    cwd,
    relFile,
    `export default (pi) => {
      ${startHook}
      for (const name of ${JSON.stringify(toolNames)}) {
        pi.registerTool({
          name,
          label: name,
          description: name,
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: name + ":ok" }] }; },
        });
      }
    };`,
  );
}

function writeMcpConfig(dir: string): string {
  const marker = join(dir, "mcp-server-started");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { probe: { command: "/bin/sh", args: ["-c", `touch '${marker}'`] } } }),
  );
  return marker;
}

async function started(marker: string): Promise<boolean> {
  for (let i = 0; i < 20 && !existsSync(marker); i++) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return existsSync(marker);
}

describe("default recon and worker extension/MCP scoping (real pi runtime)", () => {
  let cwd: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  const openSessions: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-default-scope-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "subagents-default-scope-agent-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete (globalThis as Record<string, unknown>).__startedExts;
    delete (globalThis as Record<string, unknown>).__selfdriveCalls;
    delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
    setDefaultsDisabled(false);
    registerAgents(new Map());
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });

  afterEach(() => {
    for (const session of openSessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // Ignore double-dispose during test cleanup.
      }
    }
    faux.unregister();
    delete (globalThis as Record<string, unknown>).__startedExts;
    delete (globalThis as Record<string, unknown>).__selfdriveCalls;
    delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function makeCtx() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const modelRegistry = Object.assign(backend.modelRegistry, { runtime: backend.modelRuntime });
    return {
      model,
      ctx: {
        cwd,
        getSystemPrompt: () => "PARENT",
        isProjectTrusted: () => true,
        model,
        modelRegistry,
      } as any,
    };
  }

  it.skipIf(process.platform === "win32")(
    "runs default recon cleanly without fff/selfdrive, emits zero extension-error activities, and does not start builtin:mcp",
    async () => {
      const mcpMarker = writeMcpConfig(cwd);
      writeFileSync(join(cwd, "sample.txt"), "hello\n");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ls", {})),
        fauxAssistantMessage(fauxText("recon minimal done")),
      ]);

      const activities: ToolActivity[] = [];
      let activeTools: string[] = [];
      let registeredTools: string[] = [];
      const { ctx, model } = makeCtx();

      const result = await runAgent(ctx, "recon", "Inspect directory", {
        pi: makePi(),
        model,
        onToolActivity: (activity) => activities.push(activity),
        onSessionCreated: (session) => {
          openSessions.push(session);
          activeTools = session.getActiveToolNames();
          registeredTools = session.getAllTools().map((t) => t.name);
        },
      });

      expect(result.failure).toBeUndefined();
      expect(result.responseText).toBe("recon minimal done");
      expect(activeTools).toEqual(["read", "bash", "grep", "find", "ls"]);
      expect(registeredTools).not.toContain("codemode");
      expect(registeredTools).not.toContain("tool_search");
      expect(
        activities.filter((a) => a.toolName.startsWith("extension-error:") || a.toolName.startsWith("tools-error:")),
      ).toEqual([]);
      expect(await started(mcpMarker)).toBe(false);
    },
  );

  it("loads fff + selfdrive in recon, skips top-level extensions and pi-fff, and runs child-session hooks without exposing hook tools", async () => {
    writeToolExtension(cwd, "fff", ["fffind", "ffgrep"], "fff");
    writeExtension(
      cwd,
      "selfdrive/index.js",
      `export default (pi) => {
        pi.on("session_start", () => { (globalThis.__startedExts ??= []).push("selfdrive"); });
        pi.on("tool_call", (event) => { (globalThis.__selfdriveCalls ??= []).push(event.toolName); });
      };`,
    );
    writeToolExtension(cwd, "herder", ["herder_run"], "herder");
    writeToolExtension(cwd, "pika", ["recall_search", "memory_read"], "pika");
    writeToolExtension(cwd, "pi-fff.js", ["legacy_fff"], "pi-fff");

    let hookSessionStarts = 0;
    const hookToolCalls: string[] = [];
    const hooks = ((globalThis as Record<symbol, unknown>)[HOOKS_KEY] = new Set()) as Set<unknown>;
    hooks.add({
      name: "workspace",
      extensionFactory: (pi: ExtensionAPI) => {
        pi.on("session_start", () => {
          hookSessionStarts++;
        });
        pi.on("tool_call", (event) => {
          hookToolCalls.push(event.toolName);
        });
        pi.registerTool({
          name: "workspace",
          label: "workspace",
          description: "create workspace",
          parameters: { type: "object", properties: {} } as any,
          async execute() {
            return { content: [{ type: "text", text: "workspace:ok" }], details: {} };
          },
        });
      },
    });

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fffind", {})),
      fauxAssistantMessage(fauxText("recon fff done")),
    ]);

    const activities: ToolActivity[] = [];
    let activeTools: string[] = [];
    let registeredTools: string[] = [];
    let blockedWorkspaceCall: unknown;
    const { ctx, model } = makeCtx();

    const result = await runAgent(ctx, "recon", "Search repository", {
      pi: makePi(),
      model,
      onToolActivity: (activity) => activities.push(activity),
      onSessionCreated: (session) => {
        openSessions.push(session);
        activeTools = session.getActiveToolNames();
        registeredTools = session.getAllTools().map((t) => t.name);
      },
    });
    blockedWorkspaceCall = await result.session.agent.beforeToolCall?.(
      { toolCall: { id: "tc-ws", name: "workspace", arguments: {} } } as any,
      undefined,
    );

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("recon fff done");
    expect(activeTools).toEqual(expect.arrayContaining(["read", "bash", "grep", "find", "ls", "fffind", "ffgrep"]));
    expect(activeTools).not.toContain("workspace");
    expect(activeTools).not.toContain("herder_run");
    expect(activeTools).not.toContain("recall_search");
    expect(activeTools).not.toContain("memory_read");
    expect(activeTools).not.toContain("legacy_fff");
    expect(registeredTools).not.toContain("herder_run");
    expect(registeredTools).not.toContain("recall_search");
    expect(registeredTools).not.toContain("legacy_fff");

    const startedExts = ((globalThis as Record<string, unknown>).__startedExts as string[] | undefined) ?? [];
    expect(startedExts.sort()).toEqual(["fff", "selfdrive"]);
    expect((globalThis as Record<string, unknown>).__selfdriveCalls).toEqual(["fffind"]);
    expect(hookSessionStarts).toBe(1);
    expect(hookToolCalls).toEqual(["fffind"]);
    expect(blockedWorkspaceCall).toMatchObject({ block: true });
    expect(activities.filter((a) => a.toolName.startsWith("extension-error:"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "excludes pi-fff and top-level host extensions in worker while keeping fff, agents-md, codemode, tool_search, builtin:mcp, and child-session hooks",
    async () => {
      const mcpMarker = writeMcpConfig(cwd);

      // Extensions worker MUST keep:
      writeToolExtension(cwd, "fff", ["fffind", "ffgrep"], "fff");
      writeToolExtension(cwd, "agents-md", ["agents_md_lint"], "agents-md");
      writeExtension(
        cwd,
        "selfdrive/index.js",
        `export default (pi) => {
          pi.on("session_start", () => { (globalThis.__startedExts ??= []).push("selfdrive"); });
          pi.on("tool_call", (event) => { (globalThis.__selfdriveCalls ??= []).push(event.toolName); });
        };`,
      );

      // Extensions worker MUST exclude:
      const excluded: Array<[string, string]> = [
        ["pi-fff.js", "legacy_fff"],
        ["statusline-footer", "statusline_probe"],
        ["orca-bridge", "orca_probe"],
        ["spokesman", "spokesman_probe"],
        ["delegation", "delegation_probe"],
        ["molt", "molt_probe"],
        ["language", "language_probe"],
        ["autoresearch", "autoresearch_measure"],
        ["herder", "herder_run"],
        ["council", "council"],
        ["goal", "goal_update"],
        ["pika", "recall_search"],
      ];
      for (const [extName, toolName] of excluded) {
        writeToolExtension(cwd, extName, [toolName], extName.replace(/\.js$/, ""));
      }

      let pikaChildHookStarts = 0;
      const hooks = ((globalThis as Record<symbol, unknown>)[HOOKS_KEY] = new Set()) as Set<unknown>;
      hooks.add({
        name: "pika-child-session",
        extensionFactory: (pi: ExtensionAPI) => {
          pi.on("session_start", () => {
            pikaChildHookStarts++;
          });
        },
      });

      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("agents_md_lint", {})),
        fauxAssistantMessage(fauxText("worker done")),
      ]);

      const activities: ToolActivity[] = [];
      let activeTools: string[] = [];
      let registeredTools: string[] = [];
      const { ctx, model } = makeCtx();

      const result = await runAgent(ctx, "worker", "Lint context files", {
        pi: makePi(),
        model,
        onToolActivity: (activity) => activities.push(activity),
        onSessionCreated: (session) => {
          openSessions.push(session);
          activeTools = session.getActiveToolNames();
          registeredTools = session.getAllTools().map((t) => t.name);
        },
      });

      expect(result.failure).toBeUndefined();
      expect(result.responseText).toBe("worker done");
      expect(activeTools).toEqual(
        expect.arrayContaining([
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          "fffind",
          "ffgrep",
          "agents_md_lint",
          "codemode",
        ]),
      );
      expect(registeredTools).toContain("codemode");
      expect(registeredTools).toContain("tool_search");
      expect(await started(mcpMarker)).toBe(true);

      for (const [, toolName] of excluded) {
        expect(activeTools).not.toContain(toolName);
        expect(registeredTools).not.toContain(toolName);
      }
      const startedExts = ((globalThis as Record<string, unknown>).__startedExts as string[] | undefined) ?? [];
      expect(startedExts.sort()).toEqual(["agents-md", "fff", "selfdrive"]);
      expect((globalThis as Record<string, unknown>).__selfdriveCalls).toEqual(["agents_md_lint"]);
      expect(pikaChildHookStarts).toBe(1);
      expect(activities.filter((a) => a.toolName.startsWith("extension-error:"))).toEqual([]);
    },
  );

  it("still warns on missing extensions and ext: selectors for custom/ejected non-default agents", async () => {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "recon.md"),
      [
        "---",
        "description: custom recon override",
        "tools: read, ext:missing-ext",
        "extensions: missing-ext",
        "---",
        "Inspect.",
      ].join("\n"),
    );
    registerAgents(loadCustomAgents(cwd));

    writeFileSync(join(cwd, "note.txt"), "ok\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(cwd, "note.txt") })),
      fauxAssistantMessage(fauxText("custom done")),
    ]);

    const activities: ToolActivity[] = [];
    const { ctx, model } = makeCtx();

    const result = await runAgent(ctx, "recon", "Read note", {
      pi: makePi(),
      model,
      onToolActivity: (activity) => activities.push(activity),
      onSessionCreated: (session) => openSessions.push(session),
    });

    expect(result.responseText).toBe("custom done");
    const extErrors = activities
      .map((a) => a.toolName)
      .filter((name) => name.startsWith("extension-error:"));
    expect(extErrors).toEqual([
      'extension-error:extension "missing-ext" requested by agent "recon" was not loaded',
      'extension-error:ext:missing-ext referenced by agent "recon" but extension "missing-ext" is not loaded (check extensions:/exclude_extensions:)',
    ]);
  });

  it("admits child-session-hooks fff tools in recon when fff is hook-only, and blocks unadmitted hook tools in allowlisted agents", async () => {
    writeToolExtension(cwd, "agents-md", ["agents_md_lint"], "agents-md");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "docs-linter.md"),
      [
        "---",
        "description: lint context files only",
        "tools: read",
        "extensions: agents-md",
        "---",
        "Lint.",
      ].join("\n"),
    );
    registerAgents(loadCustomAgents(cwd));

    const hooks = ((globalThis as Record<symbol, unknown>)[HOOKS_KEY] = new Set()) as Set<unknown>;
    hooks.add({
      name: "fff",
      extensionFactory: (pi: ExtensionAPI) => {
        for (const name of ["fffind", "ffgrep"]) {
          pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: { type: "object", properties: {} } as any,
            async execute() {
              return { content: [{ type: "text", text: `${name}:hook-ok` }], details: {} };
            },
          });
        }
      },
    });
    hooks.add({
      name: "workspace",
      extensionFactory: (pi: ExtensionAPI) => {
        pi.registerTool({
          name: "workspace",
          label: "workspace",
          description: "workspace",
          parameters: { type: "object", properties: {} } as any,
          async execute() {
            return { content: [{ type: "text", text: "workspace:ok" }], details: {} };
          },
        });
      },
    });

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fffind", {})),
      fauxAssistantMessage(fauxText("recon hook-only done")),
      fauxAssistantMessage(fauxToolCall("agents_md_lint", {})),
      fauxAssistantMessage(fauxText("linter done")),
    ]);

    const { ctx, model } = makeCtx();
    let reconActiveTools: string[] = [];
    const reconRes = await runAgent(ctx, "recon", "Find files", {
      pi: makePi(),
      model,
      onSessionCreated: (session) => {
        openSessions.push(session);
        reconActiveTools = session.getActiveToolNames();
      },
    });
    expect(reconRes.failure).toBeUndefined();
    expect(reconActiveTools).toEqual(expect.arrayContaining(["fffind", "ffgrep"]));
    expect(reconActiveTools).not.toContain("workspace");

    let linterActiveTools: string[] = [];
    const linterRes = await runAgent(ctx, "docs-linter", "Lint", {
      pi: makePi(),
      model,
      onSessionCreated: (session) => {
        openSessions.push(session);
        linterActiveTools = session.getActiveToolNames();
      },
    });
    expect(linterRes.failure).toBeUndefined();
    expect(linterActiveTools).toEqual(["read", "agents_md_lint"]);
    const blockedFffCall = await linterRes.session.agent.beforeToolCall?.(
      { toolCall: { id: "tc-fff", name: "fffind", arguments: {} } } as any,
      undefined,
    );
    expect(blockedFffCall).toMatchObject({ block: true });
  });
});
