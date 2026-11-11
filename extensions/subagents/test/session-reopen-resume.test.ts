import { nextManager } from "./helpers/manager-probe.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { getAgentConversation, resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { getRecordConversation, getRecordMessages, openViewerSession } from "../src/session-transcript.js";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const HOST_KEY = Symbol.for("pi-subagents:host");

let tempDir: string;
let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-session-reopen-resume-"));
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  delete (globalThis as any)[HOST_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a real SessionManager JSONL file with user, assistant+toolCall, toolResult, and final assistant turns. */
function writeRealSessionFile(dir: string): { sessionFile: string; messages: any[] } {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({
    role: "user",
    content: "Inspect src/index.ts and summarize exports",
    timestamp: 1000,
  } as any);
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Reading the file first." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1001,
  } as any);
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "export default function subagentsExtension(pi) { /* ... */ }" }],
    isError: false,
    timestamp: 1002,
  } as any);
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "It exports the default subagents extension factory." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: { input: 20, output: 15, cacheRead: 0, cacheWrite: 0, totalTokens: 35, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1003,
  } as any);

  const sessionFile = sm.getSessionFile()!;
  const messages = sm.buildSessionContext().messages;
  return { sessionFile, messages };
}

describe("session-transcript on-demand reader", () => {
  it("reads and formats messages from a real SessionManager file identically to getAgentConversation", () => {
    const { sessionFile, messages } = writeRealSessionFile(tempDir);
    const liveFormatted = getAgentConversation({ messages } as any);

    const sessionlessRecord: Pick<AgentRecord, "session" | "sessionFile"> = {
      session: undefined,
      sessionFile,
    };

    expect(getRecordMessages(sessionlessRecord)).toEqual(messages);
    expect(getRecordConversation(sessionlessRecord)).toBe(liveFormatted);
    expect(liveFormatted).toContain("[User]: Inspect src/index.ts and summarize exports");
    expect(liveFormatted).toContain("[Assistant]: Reading the file first.");
    expect(liveFormatted).toContain("Tool: read");
    expect(liveFormatted).toContain("[Tool Result (read)]: export default function subagentsExtension");
    expect(liveFormatted).toContain("[Assistant]: It exports the default subagents extension factory.");
  });

  it("provides a read-only viewer session that renders in ConversationViewer and FleetList after session teardown", () => {
    const { sessionFile } = writeRealSessionFile(tempDir);
    const record: AgentRecord = {
      id: "done-1",
      type: "recon",
      description: "Summarize exports",
      status: "completed",
      toolUses: 1,
      turnCount: 2,
      responseText: "It exports the default subagents extension factory.",
      result: "It exports the default subagents extension factory.",
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      session: undefined,
      sessionFile,
      contextPercent: 42,
      messageCount: 4,
      activeTools: [],
      lifetimeUsage: { input: 30, output: 25, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
    };

    const viewerSession = openViewerSession(record);
    expect(viewerSession).toBeDefined();

    const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
    const fakeTui = { mode: "regular", terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() } as any;
    const viewer = new ConversationViewer(fakeTui, viewerSession!, record, undefined, plainTheme, vi.fn());
    const rendered = viewer.render(120).map(stripTerminalSequences).join("\n");
    expect(rendered).toContain("Inspect src/index.ts and summarize exports");
    expect(rendered).toContain("It exports the default subagents extension factory.");
    viewer.dispose();

    // FleetList lingers the completed sessionless record and opens ConversationViewer on Enter.
    let openedOverlay = false;
    let inputHandler: ((data: string) => any) | undefined;
    const fleetUi: FleetUICtx = {
      setWidget: vi.fn(),
      onTerminalInput: (h) => { inputHandler = h; return () => {}; },
      getEditorText: () => "",
      notify: vi.fn(),
      custom: ((factory: any) => {
        openedOverlay = true;
        factory(fakeTui, plainTheme, undefined, () => {});
        return new Promise<undefined>(() => {});
      }) as any,
    };
    const fakeManager = {
      listAgents: () => [record],
      abort: () => false,
      steer: () => false,
    } as any;
    const fleet = new FleetList(fakeManager, new Map());
    fleet.setEnabled(true);
    fleet.setUICtx(fleetUi);
    fleet.update();

    inputHandler?.("\x1b[B"); // Down: activate on main
    inputHandler?.("\x1b[B"); // Down: select lingering completed record
    inputHandler?.("\r");     // Enter: open ConversationViewer from disk
    expect(openedOverlay).toBe(true);
    fleet.dispose();
  });
});

describe("extension end-to-end wiring with immediate session teardown", () => {
  it("preserves verbose conversation, contextPercent, output-file anchoring, Agent({ resume }), @handle, and workflow resume", async () => {
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, outputTranscript: true, defaultJoinMode: "async" },
    });
    const { sessionFile, messages } = writeRealSessionFile(tempDir);

    const { pi, tools, lifecycle } = makePi();
    const getManager = nextManager();
    subagentsExtension(pi);
    booted = lifecycle;
    const manager = getManager()!;
    const context = ctx();

    const firstSession = {
      dispose: vi.fn(),
      steer: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      sessionId: "s-child-1",
      messages,
      sessionManager: { getSessionFile: () => sessionFile },
      getSessionStats: () => ({
        tokens: { input: 30, output: 25, cacheWrite: 0 },
        contextUsage: { percent: 33.6 },
      }),
      extensionRunner: {
        hasHandlers: vi.fn((ev: string) => ev === "session_shutdown"),
        emit: vi.fn(async () => {}),
      },
    } as any;

    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(firstSession);
      return {
        responseText: "It exports the default subagents extension factory.",
        session: firstSession,
        aborted: false,
        steered: false,
      };
    });

    // 1. Background spawn completes → session immediately torn down, contextPercent & messageCount snapshotted.
    const spawnRes = await tools.get("Agent").execute(
      "tc-1",
      { prompt: "Inspect src/index.ts", description: "Inspect exports", subagent_type: "recon", run_in_background: true },
      undefined,
      undefined,
      context,
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawnRes))![1];
    await flush();

    const record = manager.getRecord(id)!;
    expect(record.session).toBeUndefined();
    expect(record.contextPercent).toBe(33.6);
    expect(record.messageCount).toBe(4);
    await vi.waitFor(() => expect(firstSession.dispose).toHaveBeenCalledOnce());

    // 2. get_subagent_result({ verbose: true }) still shows Context: 34% and full conversation read from disk.
    const verboseRes = await tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id, verbose: true },
      undefined,
      undefined,
      context,
    );
    const verboseText = textOf(verboseRes);
    expect(verboseText).toContain("Context: 34%");
    expect(verboseText).toContain("--- Agent Conversation ---");
    expect(verboseText).toContain("[User]: Inspect src/index.ts and summarize exports");
    expect(verboseText).toContain("[Tool Result (read)]: export default function subagentsExtension");

    // 3. Foreground Agent({ resume }) reopens sessionFile under same id and tears down again.
    const secondSession = {
      ...firstSession,
      dispose: vi.fn(),
      getSessionStats: () => ({
        tokens: { input: 60, output: 40, cacheWrite: 0 },
        contextUsage: { percent: 51.2 },
      }),
    };
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(secondSession);
      return {
        responseText: "Follow-up answer from reopened session.",
        session: secondSession,
        aborted: false,
        steered: false,
      };
    });

    const fgResumeRes = await tools.get("Agent").execute(
      "tc-resume-fg",
      { prompt: "Check named exports too", description: "Follow up", subagent_type: "recon", resume: id, run_in_background: false },
      undefined,
      undefined,
      context,
    );
    expect(textOf(fgResumeRes)).toContain("Follow-up answer from reopened session.");
    expect(record.id).toBe(id);
    expect(record.session).toBeUndefined();
    expect(record.contextPercent).toBe(51.2);
    await vi.waitFor(() => expect(secondSession.dispose).toHaveBeenCalledOnce());

    // 4. @handle mention resumes the still-in-memory (but sessionless) record in background, streaming new turns to outputFile.
    const listeners: ((ev: any) => void)[] = [];
    const thirdMessages = [...messages];
    const thirdSession = {
      ...firstSession,
      dispose: vi.fn(),
      messages: thirdMessages,
      subscribe: vi.fn((fn: (ev: any) => void) => {
        listeners.push(fn);
        return () => {};
      }),
    };
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(thirdSession);
      const userMsg = { role: "user", content: "One more @handle question" };
      thirdMessages.push(userMsg);
      for (const fn of listeners) fn({ type: "message_end", message: userMsg });
      const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Handled via @recon!" }] };
      thirdMessages.push(assistantMsg);
      for (const fn of listeners) fn({ type: "message_end", message: assistantMsg });
      return {
        responseText: "Handled via @recon!",
        session: thirdSession,
        aborted: false,
        steered: false,
      };
    });

    const uiCtx = ctx();
    const mentionRes = await lifecycle.get("input")(
      { type: "input", text: "@recon One more @handle question", source: "interactive" },
      uiCtx,
    );
    expect(mentionRes).toEqual({ action: "handled" });
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Resuming @recon", "info");
    await record.promise;
    await vi.waitFor(() => expect(thirdSession.dispose).toHaveBeenCalledOnce());
    expect(record.session).toBeUndefined();

    const transcriptContent = readFileSync(record.outputFile!, "utf-8");
    expect(transcriptContent).toContain("One more @handle question");
    expect(transcriptContent).toContain("Handled via @recon!");
    // Prior messages before the anchor were NOT re-emitted into the .output stream.
    expect(transcriptContent).not.toContain("Inspect src/index.ts and summarize exports");

    // 5. Workflow host resumes an owned workflow child whose session was torn down while record is still in manager.
    const wfSession1 = { ...firstSession, dispose: vi.fn() };
    const wfSession2 = { ...firstSession, dispose: vi.fn() };
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated?.(wfSession1);
        return { responseText: "wf step 1", session: wfSession1, aborted: false, steered: false };
      })
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated?.(wfSession2);
        return { responseText: "wf step 2", session: wfSession2, aborted: false, steered: false };
      });

    const wfHost = createWorkflowHost({ pi, ctx: context, manager, workflowId: "wf_reopen" });
    const wfSpawn = await wfHost.spawnAgent({
      agentId: "step-1",
      index: 0,
      prompt: "do step 1",
      label: "worker",
      agentType: "worker",
    });
    expect(wfSpawn).toMatchObject({ ok: true, text: "wf step 1" });
    await vi.waitFor(() => expect(wfSession1.dispose).toHaveBeenCalledOnce());

    const wfResumed = await wfHost.resumeAgent?.("step-1", "do step 2");
    expect(wfResumed).toMatchObject({ ok: true, text: "wf step 2" });
    await vi.waitFor(() => expect(wfSession2.dispose).toHaveBeenCalledOnce());
  });
});
