/**
 * Child-session hooks against the real pi loader and real child sessions on a
 * faux model: a hook registered on the process-global Set loads into every
 * child in every extension mode, every child is persisted while a hook is
 * registered, and each child's link entry names its spawner.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { AgentRecord } from "../src/types.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode, toolResultsNamed } from "../test/helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const HOOKS_KEY = Symbol.for("pi-extensions.child-session-hooks");
const LINK_TYPE = "pi-extensions.session-link";

interface ChildSighting {
  sessionId: string;
  sessionFile?: string;
  link?: Record<string, unknown>;
}

/** Registers a hook whose factory counts its runs and records each child at `session_start`. */
function registerHook(): { factoryRuns: number; children: ChildSighting[] } {
  const seen = { factoryRuns: 0, children: [] as ChildSighting[] };
  const globals = globalThis as Record<symbol, unknown>;
  const hooks = (globals[HOOKS_KEY] ??= new Set()) as Set<unknown>;
  hooks.add({
    name: "test-hook",
    extensionFactory: (pi: ExtensionAPI) => {
      seen.factoryRuns++;
      pi.on("session_start", (_event, ctx) => {
        const link = ctx.sessionManager.getEntries().find(
          (entry) => entry.type === "custom" && entry.customType === LINK_TYPE,
        );
        seen.children.push({
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile(),
          link: link?.type === "custom" ? (link.data as Record<string, unknown>) : undefined,
        });
      });
    },
  });
  return seen;
}

function readSessionFile(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function hasToolResult(context: Context, toolName: string): boolean {
  return context.messages.some((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === toolName);
}

function writeAgent(cwd: string, name: string, frontmatter: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${frontmatter}---\nDo the work.\n`);
}

function getRecord(run: PrintModeRun, id: unknown): AgentRecord | undefined {
  return typeof id === "string" ? (run.manager?.getRecord(id) as AgentRecord | undefined) : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("child-session hooks (real pi, faux model)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads the hook into children in every extension mode", async () => {
    const seen = registerHook();
    const cwd = tempDir("hooks-modes-");
    const modes = {
      "mode-all": "extensions: true\n",
      "mode-allowlist": "extensions: not-installed\n",
      "mode-none": "extensions: false\n",
      "mode-isolated": "isolated: true\n",
    };
    for (const [name, frontmatter] of Object.entries(modes)) writeAgent(cwd, name, frontmatter);

    run = await runPrintMode({
      prompt: "Spawn every mode.",
      cwd,
      live: false,
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
      respond: (context): FauxReply => {
        if (!getCurrentTools(context.messages).some((t) => t.name === "Agent")) return "child done";
        if (hasToolResult(context, "Agent")) return "parent done";
        return Object.keys(modes).map((name, i) =>
          agentCall({ subagent_type: name, description: name, prompt: `Run ${name}.` }, { id: `call-${i}` }));
      },
    });

    expect(seen.factoryRuns).toBe(4);
    expect(seen.children.map((child) => child.link?.agentType).sort()).toEqual(Object.keys(modes).sort());
  });

  it("persists top-level and nested persist_session: false children with parent headers and links", async () => {
    const seen = registerHook();
    const cwd = tempDir("hooks-nested-");
    writeAgent(cwd, "orchestrator", "extensions: false\npersist_session: false\nallowed_subagents: worker\n");
    writeAgent(cwd, "worker", "extensions: false\npersist_session: false\n");
    const parentManager = SessionManager.create(cwd, tempDir("hooks-parent-sessions-"));

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd,
      live: false,
      sessionManager: parentManager,
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
      respond: (context): FauxReply => {
        const text = firstUserText(context);
        if (text.includes("Do the leaf work")) return "leaf done";
        if (text.includes("Delegate this downward")) {
          if (hasToolResult(context, "Agent")) return "orchestrator done";
          return agentCall(
            { subagent_type: "worker", description: "leaf work", prompt: "Do the leaf work." },
            { id: "call-nested" },
          );
        }
        if (hasToolResult(context, "Agent")) return "parent done";
        return agentCall(
          { subagent_type: "orchestrator", description: "delegate", prompt: "Delegate this downward.", run_in_background: false },
          { id: "call-top" },
        );
      },
    });

    const orchestrator = seen.children.find((child) => child.link?.agentType === "orchestrator");
    const worker = seen.children.find((child) => child.link?.agentType === "worker");
    expect(orchestrator?.sessionFile).toBeDefined();
    expect(worker?.sessionFile).toBeDefined();

    const parentFile = parentManager.getSessionFile();
    const orchestratorEntries = readSessionFile(orchestrator!.sessionFile!);
    const workerEntries = readSessionFile(worker!.sessionFile!);
    expect(orchestratorEntries[0]).toMatchObject({ type: "session", id: orchestrator!.sessionId, parentSession: parentFile });
    expect(workerEntries[0]).toMatchObject({ type: "session", id: worker!.sessionId, parentSession: orchestrator!.sessionFile });

    const orchestratorId = orchestrator!.link!.agentId;
    expect(orchestrator!.link).toEqual({
      kind: "subagent",
      parentSessionId: parentManager.getSessionId(),
      parentSessionFile: parentFile,
      parentToolCallId: "call-top",
      agentId: expect.any(String),
      agentType: "orchestrator",
      description: "delegate",
    });
    expect(worker!.link).toEqual({
      kind: "subagent",
      parentSessionId: orchestrator!.sessionId,
      parentSessionFile: orchestrator!.sessionFile,
      parentToolCallId: "call-nested",
      agentId: expect.any(String),
      parentAgentId: orchestratorId,
      agentType: "worker",
      description: "leaf work",
    });
    // Written to disk too, ahead of the first prompt.
    for (const entries of [orchestratorEntries, workerEntries]) {
      const linkIndex = entries.findIndex((e) => e.type === "custom" && e.customType === LINK_TYPE);
      const promptIndex = entries.findIndex((e) => e.type === "message");
      expect(linkIndex).toBeGreaterThan(0);
      expect(linkIndex).toBeLessThan(promptIndex);
    }

    // Records cover top-level agents only; the nested worker's parentage lives in its link entry.
    const records = run.parentSession.sessionManager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === "subagents:record",
    );
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.type === "custom" ? record.data : undefined).not.toHaveProperty("parentAgentId");
    expect(record?.type === "custom" ? record.data : undefined).not.toHaveProperty("workflowId");
    const orchestratorRecord = getRecord(run, orchestratorId);
    expect(orchestratorRecord?.outputFile).toEqual(expect.any(String));
    expect(record?.type === "custom" ? record.data : undefined).toMatchObject({
      id: orchestratorId,
      type: "orchestrator",
      sessionId: orchestrator!.sessionId,
      sessionFile: orchestrator!.sessionFile,
      outputFile: orchestratorRecord!.outputFile,
      toolCallId: "call-top",
    });
  });

  it("links workflow children to the workflow call and run", async () => {
    const seen = registerHook();
    const cwd = tempDir("hooks-workflow-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true }));
    const script = [
      'export const meta = { name: "hooks-wf", description: "one agent" };',
      'return await agent("WF-TASK-MARKER", { label: "wf child" });',
    ].join("\n");

    run = await runPrintMode({
      prompt: "run the workflow",
      cwd,
      live: false,
      respond: (context) => {
        if (!getCurrentTools(context.messages).some((t) => t.name === "SubagentWorkflow")) return fauxText("child done");
        return hasToolResult(context, "SubagentWorkflow")
          ? fauxText("workflow launched")
          : fauxToolCall("SubagentWorkflow", { script }, { id: "wf-call-1" });
      },
    });

    expect(await waitFor(() => seen.children.length > 0)).toBe(true);
    await run.manager?.waitForAll();

    const taskId = /Task ID: (\S+)/.exec(toolResultsNamed(run.parentSession, "SubagentWorkflow")[0] ?? "")?.[1];
    expect(taskId).toBeDefined();
    const child = seen.children[0];
    expect(child.link).toEqual({
      kind: "subagent",
      parentSessionId: run.parentSession.sessionManager.getSessionId(),
      parentToolCallId: "wf-call-1",
      agentId: expect.any(String),
      workflowId: taskId,
      agentType: expect.any(String),
      description: "wf child",
    });
    expect(getRecord(run, child.link!.agentId)?.workflowId).toBe(taskId);
    expect(child.sessionFile).toBeDefined();
  });
});
