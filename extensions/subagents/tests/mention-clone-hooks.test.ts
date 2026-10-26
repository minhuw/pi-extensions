/**
 * The @mention conversation clone against real pi sessions on a faux model:
 * with a child-session hook registered it loads the hook and is persisted as a
 * valid child session (the parent's branch verbatim, a parent header, a link
 * entry before its prompt); without hooks it stays in memory.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../src/mention-clone.js";
import { fauxModelBackend } from "../test/helpers/faux-model-backend.js";
import { registerFauxProvider } from "../test/helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const HOOKS_KEY = Symbol.for("pi-extensions.child-session-hooks");
const LINK_TYPE = "pi-extensions.session-link";

interface HookSightings {
  factoryRuns: number;
  started: Array<{ sessionId: string; sessionFile?: string }>;
  modelCalls: number;
  shutdowns: number;
}

function registerHook(): HookSightings {
  const seen: HookSightings = { factoryRuns: 0, started: [], modelCalls: 0, shutdowns: 0 };
  const globals = globalThis as Record<symbol, unknown>;
  const hooks = (globals[HOOKS_KEY] ??= new Set()) as Set<unknown>;
  hooks.add({
    name: "test-hook",
    extensionFactory: (pi: ExtensionAPI) => {
      seen.factoryRuns++;
      pi.on("session_start", (_event, ctx) => {
        seen.started.push({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
      });
      // The faux provider exposes no payload, so `context` stands in for each model call.
      pi.on("context", () => { seen.modelCalls++; });
      pi.on("session_shutdown", () => { seen.shutdowns++; });
    },
  });
  return seen;
}

describe("mention clone and child-session hooks (real pi, faux model)", () => {
  let cwd: string;
  let sessionsDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  const savedSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-clone-hooks-"));
    sessionsDir = join(cwd, "child-sessions");
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
    if (savedSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A persisted parent with a named, branched history, and its main context. */
  function parentContext() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.create(cwd, join(cwd, "parent-sessions"));
    parent.appendSessionInfo("parent title");
    parent.appendMessage({ role: "user", content: "PARENT-HISTORY question", timestamp: 1 });
    const answer = parent.appendMessage(fauxAssistantMessage("PARENT-HISTORY answer"));
    parent.appendMessage({ role: "user", content: "abandoned branch", timestamp: 2 });
    parent.branch(answer);
    parent.appendCustomEntry("test.marker", { kept: true });
    parent.appendMessage({ role: "user", content: "PARENT-HISTORY follow-up", timestamp: 3 });
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT-PROMPT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parent,
      isProjectTrusted: () => true,
    };
    return { parent, ctx };
  }

  function agentTool() {
    return {
      name: "Agent",
      description: "Launch an agent.",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: undefined })),
    } as any;
  }

  function scriptSpawn(): { contexts: Context[] } {
    const seen = { contexts: [] as Context[] };
    faux.setResponses([
      (context: Context) => {
        seen.contexts.push(context);
        return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "recon", prompt: "go" }));
      },
      fauxAssistantMessage("done"),
    ]);
    return seen;
  }

  it("loads the hook and persists the clone as a linked child session", async () => {
    const hook = registerHook();
    const { parent, ctx } = parentContext();
    const { contexts } = scriptSpawn();

    const result = await runMentionClone({ ctx, type: "recon", message: "find the flaky test", agentTool: agentTool() });

    expect(result).toEqual({ spawned: true });
    expect(hook.factoryRuns).toBe(1);
    expect(hook.started).toHaveLength(1);
    expect(hook.modelCalls).toBeGreaterThanOrEqual(1);
    expect(hook.shutdowns).toBe(1);
    const cloneFile = hook.started[0].sessionFile!;
    expect(readdirSync(sessionsDir).map((name) => join(sessionsDir, name))).toEqual([cloneFile]);

    const lines = readFileSync(cloneFile, "utf-8").split("\n");
    expect(lines.pop()).toBe("");
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({
      type: "session",
      id: hook.started[0].sessionId,
      cwd,
      parentSession: parent.getSessionFile(),
    });
    // The parent's root-to-leaf path, byte for byte, the abandoned branch excluded.
    const branch = parent.getBranch();
    expect(lines.slice(1, 1 + branch.length)).toEqual(branch.map((entry) => JSON.stringify(entry)));
    expect(lines.join("\n")).not.toContain("abandoned branch");

    const rest = entries.slice(1 + branch.length);
    const linkIndex = rest.findIndex((e) => e.type === "custom" && e.customType === LINK_TYPE);
    const promptIndex = rest.findIndex((e) => e.type === "message" && e.message.role === "user");
    expect(linkIndex).toBe(0);
    expect(rest[0].parentId).toBe(branch.at(-1)!.id);
    expect(promptIndex).toBeGreaterThan(linkIndex);
    expect(rest[linkIndex].data).toEqual({
      kind: "subagent",
      parentSessionId: parent.getSessionId(),
      parentSessionFile: parent.getSessionFile(),
      agentType: "recon",
      description: "@mention clone",
    });

    // A valid pi session: it reopens on one unbroken chain from the root.
    const reopened = SessionManager.open(cloneFile);
    expect(reopened.getSessionId()).toBe(hook.started[0].sessionId);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual(entries.slice(1).map((entry) => entry.id));
    expect(reopened.getSessionName()).toBe("@recon mention clone");

    const sent = JSON.stringify(contexts[0].messages);
    expect(sent).toContain("PARENT-HISTORY question");
    expect(sent).toContain("PARENT-HISTORY follow-up");
    expect(sent).not.toContain("abandoned branch");
  });

  it("stays in memory and loads nothing without hooks", async () => {
    const { ctx } = parentContext();
    scriptSpawn();

    const result = await runMentionClone({ ctx, type: "recon", message: "find the flaky test", agentTool: agentTool() });

    expect(result).toEqual({ spawned: true });
    expect(() => readdirSync(sessionsDir)).toThrow();
  });
});
