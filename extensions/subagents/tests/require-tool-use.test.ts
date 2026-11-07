/**
 * `require_tool_use`: a tool-requiring agent (embedded recon/worker/reviewer)
 * whose run ends without calling any tool is settled as an error, not a
 * completion. Guards against a model route that drops the child's tool
 * definitions, where the child answers "I have no tools available" and would
 * otherwise be trusted as a finished run. Real pi sessions on a faux model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentDefinition, parseAgentFrontmatter } from "../src/agent-definitions.js";
import { serializeAgentFile } from "../src/agent-file-toggle.js";
import { noToolUseFailure } from "../src/agent-runner.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { COUNCIL_AGENT_NAMES } from "../src/types.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode, toolResultsNamed } from "../test/helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const NO_TOOLS_REPLY = "I have no tools available, so I cannot inspect the repository.";
const RESUME_REPLY = "It found nothing new since the first run.";

function isParent(context: Context): boolean {
  return getCurrentTools(context.messages).some((t) => t.name === "Agent");
}

function lastMessageIsToolResult(context: Context): boolean {
  return context.messages.at(-1)?.role === "toolResult";
}

function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((m) => m.role === "user");
  const content = user?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function parentToolResults(context: Context, toolName: string): string[] {
  return context.messages.flatMap((m) =>
    m.role === "toolResult" && (m as { toolName?: string }).toolName === toolName
      ? [((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("")]
      : []);
}

function records(run: PrintModeRun): Array<Record<string, unknown>> {
  return run.parentSession.sessionManager.getEntries().flatMap((entry) =>
    entry.type === "custom" && entry.customType === "subagents:record" ? [entry.data as Record<string, unknown>] : []);
}

function writeAgent(cwd: string, name: string, frontmatter: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\n${frontmatter}---\nDo the work.\n`);
}

describe("require_tool_use (real pi, faux model)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "require-tool-use-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Spawn one foreground child of `type`; the child replies with `child(context)`. */
  async function spawnForeground(type: string, child: (context: Context) => FauxReply, cwd = tempDir()) {
    run = await runPrintMode({
      prompt: "Delegate.",
      cwd,
      live: false,
      respond: (context): FauxReply => {
        if (!isParent(context)) return child(context);
        if (parentToolResults(context, "Agent").length > 0) return "parent done";
        return agentCall({ subagent_type: type, description: "check", prompt: "Inspect the repo." }, { id: "call-1" });
      },
    });
    return toolResultsNamed(run.parentSession, "Agent");
  }

  it("fails a worker that replies with text only, keeping its reply", async () => {
    const results = await spawnForeground("worker", () => NO_TOOLS_REPLY);

    expect(results).toHaveLength(1);
    expect(results[0]).toContain(`Agent failed: ${noToolUseFailure("worker")}`);
    expect(results[0]).toContain(NO_TOOLS_REPLY);
    expect(noToolUseFailure("worker")).toBe(
      "worker finished without calling any tool, though its role requires tools; the model may not have "
      + "received its tool definitions. Its reply is kept below. Retry, or check the model route.",
    );

    const [record] = records(run!);
    expect(record).toMatchObject({ type: "worker", status: "error", error: noToolUseFailure("worker"), result: NO_TOOLS_REPLY });
  });

  it("completes a worker that calls a tool", async () => {
    const results = await spawnForeground("worker", (context) =>
      lastMessageIsToolResult(context) ? "listed the repo" : fauxToolCall("ls", { path: "." }));

    expect(results[0]).toContain("Agent completed");
    expect(results[0]).toContain("1 tool uses");
    expect(results[0]).toContain("listed the repo");
    expect(records(run!)[0]).toMatchObject({ status: "completed", result: "listed the repo" });
    expect(records(run!)[0]?.error).toBeUndefined();
  });

  it("completes a custom agent with require_tool_use: false that replies with text only", async () => {
    const cwd = tempDir();
    writeAgent(cwd, "advisor", "tools: read, bash, grep, find, ls\nrequire_tool_use: false\n");
    const results = await spawnForeground("advisor", () => "Use the second design.", cwd);

    expect(results[0]).toContain("Agent completed");
    expect(results[0]).toContain("Use the second design.");
    expect(records(run!)[0]).toMatchObject({ type: "advisor", status: "completed" });
  });

  it("leaves a custom agent without the field unaffected", async () => {
    const cwd = tempDir();
    writeAgent(cwd, "helper", "tools: read\n");
    const results = await spawnForeground("helper", () => "answered from memory", cwd);

    expect(results[0]).toContain("Agent completed");
    expect(records(run!)[0]).toMatchObject({ type: "helper", status: "completed" });
  });

  it("does not apply when the agent starts with no active tools", async () => {
    const cwd = tempDir();
    writeAgent(cwd, "toolless", "tools: none\nextensions: false\nskills: false\nrequire_tool_use: true\n");
    const results = await spawnForeground("toolless", () => "nothing to call", cwd);

    expect(results[0]).toContain("Agent completed");
    expect(records(run!)[0]).toMatchObject({ type: "toolless", status: "completed" });
  });

  it("reports a background failure through the notification record and get_subagent_result", async () => {
    let agentId: string | undefined;
    run = await runPrintMode({
      prompt: "Delegate in the background.",
      cwd: tempDir(),
      live: false,
      hold: false,
      respond: (context): FauxReply => {
        if (!isParent(context)) return NO_TOOLS_REPLY;
        const spawned = parentToolResults(context, "Agent");
        if (spawned.length === 0) {
          return agentCall({ description: "bg check", prompt: "Inspect the repo.", run_in_background: true }, { id: "call-bg" });
        }
        if (parentToolResults(context, "get_subagent_result").length > 0) return "parent done";
        agentId = /Agent ID: (\S+)/.exec(spawned[0]!)?.[1];
        return fauxToolCall("get_subagent_result", { agent_id: agentId, wait: true }, { id: "call-get" });
      },
    });

    const [fetched] = toolResultsNamed(run.parentSession, "get_subagent_result");
    expect(agentId).toEqual(expect.any(String));
    expect(fetched).toContain("Status: error");
    expect(fetched).toContain(`Error: ${noToolUseFailure("worker")}`);
    expect(fetched).toContain(NO_TOOLS_REPLY);
    expect(records(run)[0]).toMatchObject({ id: agentId, status: "error", error: noToolUseFailure("worker") });
  });

  it.each([false, true])("completes a resume that answers in text after a first run that used tools (background=%s)", async (background) => {
    let agentId: string | undefined;
    run = await runPrintMode({
      prompt: "Delegate, then follow up.",
      cwd: tempDir(),
      live: false,
      hold: false,
      respond: (context): FauxReply => {
        if (!isParent(context)) {
          if (lastUserText(context).includes("FOLLOW-UP")) return RESUME_REPLY;
          return lastMessageIsToolResult(context) ? "first run listed the repo" : fauxToolCall("ls", { path: "." });
        }
        const spawned = parentToolResults(context, "Agent");
        const fetched = parentToolResults(context, "get_subagent_result");
        if (spawned.length === 0) {
          return agentCall({ description: "first", prompt: "FIRST: inspect the repo.", run_in_background: true }, { id: "call-first" });
        }
        agentId ??= /Agent ID: (\S+)/.exec(spawned[0]!)?.[1];
        // Wait for the first run: a resume needs its settled session.
        if (fetched.length === 0) return fauxToolCall("get_subagent_result", { agent_id: agentId, wait: true }, { id: "call-wait" });
        if (spawned.length === 1) {
          return fauxToolCall("Agent", {
            subagent_type: "worker", description: "follow up", prompt: "FOLLOW-UP: check again.",
            resume: agentId, run_in_background: background,
          }, { id: "call-resume" });
        }
        if (background && fetched.length === 1) {
          return fauxToolCall("get_subagent_result", { agent_id: agentId, wait: true }, { id: "call-wait-2" });
        }
        return "parent done";
      },
    });

    const spawned = toolResultsNamed(run.parentSession, "Agent");
    const fetched = toolResultsNamed(run.parentSession, "get_subagent_result");
    expect(agentId).toEqual(expect.any(String));
    expect(spawned).toHaveLength(2);
    expect(fetched[0]).toContain("Status: completed");
    expect(fetched[0]).toContain("first run listed the repo");
    const record = run.manager?.getRecord(agentId!) as { status?: string; error?: string; result?: string; toolUses?: number };
    // Only the spawn run must call a tool: a follow-up may be answered in words alone.
    expect(record).toMatchObject({ status: "completed", result: RESUME_REPLY, toolUses: 1 });
    expect(record.error).toBeUndefined();
    if (background) {
      expect(fetched[1]).toContain("Status: completed");
      expect(fetched[1]).toContain(RESUME_REPLY);
      // Background resumes settle through onComplete, which writes a second record.
      const recs = records(run).filter((r) => r.id === agentId);
      expect(recs.map((r) => r.status)).toEqual(["completed", "completed"]);
    } else {
      expect(spawned[1]).not.toContain("Agent failed");
      expect(spawned[1]).toContain(RESUME_REPLY);
    }
  });
});

describe("require_tool_use frontmatter", () => {
  const parseFile = (content: string) => {
    const { frontmatter: fm, body } = parseAgentFrontmatter<Record<string, unknown>>(content);
    return parseAgentDefinition(fm, body, { filename: "a", sourcePath: "/tmp/a.md", source: "project" })!;
  };
  const parse = (frontmatter: string) => parseFile(`---\n${frontmatter}---\nBody.\n`);

  it("parses true, false, and absent", () => {
    expect(parse("require_tool_use: true\n").requireToolUse).toBe(true);
    expect(parse("require_tool_use: false\n").requireToolUse).toBe(false);
    expect(parse("description: x\n").requireToolUse).toBeUndefined();
  });

  it("round-trips through the serializer, and ejected defaults keep the guard", () => {
    for (const value of [true, false]) {
      const ejected = serializeAgentFile(parse(`require_tool_use: ${value}\n`));
      expect(ejected).toContain(`require_tool_use: ${value}`);
      expect(parseFile(ejected).requireToolUse).toBe(value);
    }
    expect(serializeAgentFile(parse("description: x\n"))).not.toContain("require_tool_use");
    for (const name of ["recon", "worker", "reviewer"]) {
      expect(DEFAULT_AGENTS.get(name)?.requireToolUse).toBe(true);
      expect(serializeAgentFile(DEFAULT_AGENTS.get(name)!)).toContain("require_tool_use: true");
    }
    for (const name of COUNCIL_AGENT_NAMES) {
      expect(DEFAULT_AGENTS.get(name)?.requireToolUse).toBeUndefined();
    }
  });
});
