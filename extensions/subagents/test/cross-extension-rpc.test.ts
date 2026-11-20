import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type EventBus, PROTOCOL_VERSION, type RpcDeps, registerRpcHandlers, type SpawnCapable } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.js";
import { ctx as makeExtCtx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Simple in-process event bus for testing. */
function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("cross-extension RPC", () => {
  let events: EventBus;
  let manager: SpawnCapable;
  let ctx: object | undefined;
  let deps: RpcDeps;

  beforeEach(() => {
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      awaitStartup: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockReturnValue(true),
      getRecord: vi.fn().mockReturnValue({}),
      consumeResult: vi.fn().mockReturnValue(true),
      steer: vi.fn().mockReturnValue(true),
      send: vi.fn().mockResolvedValue("steered"),
      reopen: vi.fn().mockReturnValue("agent-43"),
      release: vi.fn().mockReturnValue(true),
    };
    ctx = { session: true };
    deps = { events, pi: { events }, getCtx: () => ctx, manager };
  });

  // --- ping ---

  describe("ping RPC", () => {
    it("replies with protocol version", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { version: PROTOCOL_VERSION } });
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-other", wrongReply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to pings", async () => {
      const { unsubPing } = registerRpcHandlers(deps);
      unsubPing();

      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- spawn ---

  describe("spawn RPC", () => {
    it("returns agent id on success", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s1", type: "worker", prompt: "do stuff",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "do stuff", {},
      );
    });

    it("passes options through to manager.spawn", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s2", type: "recon", prompt: "find it",
        options: { description: "search", isBackground: true },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "recon", "find it",
        { description: "search", isBackground: true },
      );
    });

    it("returns error when no active session", async () => {
      ctx = undefined;
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s3", type: "worker", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "No active session" });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("returns error when manager.spawn throws", async () => {
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("unknown agent type");
      });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s4", type: "bad-type", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "unknown agent type" });
    });

    it("returns error when the agent fails to start after spawn returns", async () => {
      // With isolation: "worktree" the agent is not running when spawn() hands
      // back an id — the repo copy is an awaited git call. A failure there has
      // to be an error envelope, not an id for an agent that never ran.
      (manager.awaitStartup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cannot run with isolation: "worktree"'),
      );
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s4b", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s4b", type: "worker", prompt: "x",
        options: { isolation: "worktree" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false, error: 'Cannot run with isolation: "worktree"',
      });
      expect(manager.awaitStartup).toHaveBeenCalledWith("agent-42");
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-other", wrongReply);
      events.on("subagents:rpc:spawn:reply:req-s5", rightReply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s5", type: "worker", prompt: "x",
      });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to spawns", async () => {
      const { unsubSpawn } = registerRpcHandlers(deps);
      unsubSpawn();

      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s6", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s6", type: "worker", prompt: "x",
      });

      // Give any potential async handler time to fire
      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- stop ---

  describe("stop RPC", () => {
    // The default double reports a record with neither owner field, i.e. one of
    // the session's own agents — the case the ownership guard must let through.
    it("returns success when agent is aborted", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st1", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.abort).toHaveBeenCalledWith("agent-42");
    });

    // `abort` returning false no longer means "no such agent" — the handler's
    // own lookup covers that, and the only case left is a record that is neither
    // running nor queued, i.e. one that has already finished.
    it("says so when the agent exists but has already finished", async () => {
      (manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st2", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st2", agentId: "settled" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not running" });
    });

    it("returns error when the agent is unknown to the manager", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st5", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st5", agentId: "nonexistent" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    // A nested child and a workflow's agent both have an owner that is waiting
    // on them, so an id that leaked to another extension must not let it abort
    // one out from under that owner.
    it("refuses to stop another agent's nested child", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ parentAgentId: "agent-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st6", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st6", agentId: "agent-child" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false,
        error: "Agent is owned by another agent or workflow",
      });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    it("refuses to stop a workflow's agent", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st7", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st7", agentId: "agent-wf" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false,
        error: "Agent is owned by another agent or workflow",
      });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-other", wrongReply);
      events.on("subagents:rpc:stop:reply:req-st3", rightReply);
      events.emit("subagents:rpc:stop", { requestId: "req-st3", agentId: "agent-42" });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to stop requests", async () => {
      const { unsubStop } = registerRpcHandlers(deps);
      unsubStop();

      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st4", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st4", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- consume ---

  describe("consume RPC", () => {
    it("returns success when the result is consumed", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c1", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.consumeResult).toHaveBeenCalledWith("agent-42");
    });

    it("returns an error when the agent is unknown or still running", async () => {
      (manager.consumeResult as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c2", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c2", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
    });

    it("unsub stops responding to consume requests", async () => {
      const { unsubConsume } = registerRpcHandlers(deps);
      unsubConsume();

      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c3", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c3", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
      expect(manager.consumeResult).not.toHaveBeenCalled();
    });
  });

  // --- release ---

  describe("release RPC", () => {
    it("releases a top-level agent and replies with success", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:release:reply:req-r1", reply);
      events.emit("subagents:rpc:release", { requestId: "req-r1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.release).toHaveBeenCalledWith("agent-42");
    });

    it("returns error when the agent is unknown", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:release:reply:req-r2", reply);
      events.emit("subagents:rpc:release", { requestId: "req-r2", agentId: "nonexistent" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.release).not.toHaveBeenCalled();
    });

    it("refuses to release a nested child or workflow-owned agent", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ parentAgentId: "parent-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:release:reply:req-r3", reply);
      events.emit("subagents:rpc:release", { requestId: "req-r3", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
      expect(manager.release).not.toHaveBeenCalled();

      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-1" });
      const replyWf = vi.fn();
      events.on("subagents:rpc:release:reply:req-r4", replyWf);
      events.emit("subagents:rpc:release", { requestId: "req-r4", agentId: "agent-42" });

      await vi.waitFor(() => expect(replyWf).toHaveBeenCalled());
      expect(replyWf).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
      expect(manager.release).not.toHaveBeenCalled();
    });

    it("unsub stops responding to release requests", async () => {
      const { unsubRelease } = registerRpcHandlers(deps);
      unsubRelease();

      const reply = vi.fn();
      events.on("subagents:rpc:release:reply:req-r5", reply);
      events.emit("subagents:rpc:release", { requestId: "req-r5", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
      expect(manager.release).not.toHaveBeenCalled();
    });
  });

  // --- steer ---

  describe("steer RPC", () => {
    it("delivers a message to a running top-level agent", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m1", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m1", agentId: "agent-42", message: "also failing: check_suite on 839ab295" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.steer).toHaveBeenCalledWith("agent-42", "also failing: check_suite on 839ab295");
    });

    it("returns error when the agent is unknown to the manager", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m2", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m2", agentId: "nonexistent", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    // Same ownership stance as stop: an agent another agent or a workflow is
    // waiting on is not this RPC's to redirect.
    it("refuses to steer another agent's nested child or a workflow's agent", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m3", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m3", agentId: "agent-42", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("says so when the agent has already finished", async () => {
      (manager.steer as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m4", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m4", agentId: "agent-42", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not running" });
    });

    it("rejects a whitespace-only message before touching the manager", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m5", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m5", agentId: "agent-42", message: "   " });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("rejects a non-string message before touching the manager", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m7", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m7", agentId: "agent-42", message: 42 });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("unsub stops responding to steer requests", async () => {
      const { unsubSteer } = registerRpcHandlers(deps);
      unsubSteer();

      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m6", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m6", agentId: "agent-42", message: "x" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- concurrent requests ---

  describe("concurrent requests", () => {
    it("handles multiple simultaneous spawn requests independently", async () => {
      let callCount = 0;
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => `agent-${++callCount}`);
      registerRpcHandlers(deps);

      const reply1 = vi.fn();
      const reply2 = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-a", reply1);
      events.on("subagents:rpc:spawn:reply:req-b", reply2);

      events.emit("subagents:rpc:spawn", { requestId: "req-a", type: "recon", prompt: "first" });
      events.emit("subagents:rpc:spawn", { requestId: "req-b", type: "reviewer", prompt: "second" });

      await vi.waitFor(() => {
        expect(reply1).toHaveBeenCalled();
        expect(reply2).toHaveBeenCalled();
      });

      expect(reply1).toHaveBeenCalledWith({ success: true, data: { id: "agent-1" } });
      expect(reply2).toHaveBeenCalledWith({ success: true, data: { id: "agent-2" } });
    });
  });

  // --- model override resolution (regression for cross-extension callers
  //     that forward a serializable string instead of a Model object) ---

  describe("spawn RPC model override", () => {
    const fakeModel = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
    const registry = {
      find: (provider: string, id: string) =>
        provider === fakeModel.provider && id === fakeModel.id ? fakeModel : null,
      getAll: () => [fakeModel],
      getAvailable: () => [fakeModel],
    };

    beforeEach(() => {
      ctx = { session: true, modelRegistry: registry };
      deps = { events, pi: { events }, getCtx: () => ctx, manager };
    });

    it("resolves a string model to a Model instance before manager.spawn", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m1", type: "worker", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "x",
        expect.objectContaining({ model: fakeModel, invocation: expect.objectContaining({ modelName: `${fakeModel.provider}/${fakeModel.id}` }) }),
      );
    });

    it("passes a Model object through unchanged", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m2", type: "worker", prompt: "x",
        options: expect.objectContaining({ model: fakeModel, invocation: expect.objectContaining({ modelName: `${fakeModel.provider}/${fakeModel.id}` }) }),
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "x",
        expect.objectContaining({ model: fakeModel, invocation: expect.objectContaining({ modelName: `${fakeModel.provider}/${fakeModel.id}` }) }),
      );
    });

    it("surfaces a clear error when the model string can't be resolved", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m3", type: "worker", prompt: "x",
        options: { model: "nope/does-not-exist" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not found/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("treats an explicit null model as no override at all", async () => {
      // A JSON-forwarding caller can serialize an unset field as null. The
      // runner reads `options.model ?? default`, so null means "inherit" —
      // it must not be resolved, scope-checked, or dereferenced.
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m5", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m5", type: "worker", prompt: "x",
        options: { model: null },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "x", { model: null },
      );
    });

    it("errors when ctx has no modelRegistry but a string model is given", async () => {
      ctx = { session: true }; // no modelRegistry
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m4", type: "worker", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/modelRegistry is unavailable/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });
  });
  // --- scopeModels on the RPC spawn path (#240): an override on the RPC
  //     payload is an orchestrator-level choice, so it gets the Agent tool's
  //     hard error rather than reaching the spawn on an out-of-scope model. ---

  describe("spawn RPC model scope", () => {
    const ALLOWED = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
    const BLOCKED = { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" };
    const MODELS = [ALLOWED, BLOCKED];
    const registry = {
      find: (provider: string, id: string) =>
        MODELS.find(m => m.provider === provider && m.id === id) ?? null,
      getAll: () => MODELS,
      getAvailable: () => MODELS,
    };

    let projectDir: string;
    let agentDir: string;
    let prevAgentDir: string | undefined;
    let prevEnabled: boolean;

    beforeEach(() => {
      // resolveEnabledModels memoizes on (patterns, mtime+size of both settings
      // files) — a fresh project dir per test keeps one case's allowlist from
      // being served to the next. Same harness as test/model-scope.test.ts.
      projectDir = mkdtempSync(join(tmpdir(), "pi-rpc-scope-project-"));
      agentDir = mkdtempSync(join(tmpdir(), "pi-rpc-scope-global-"));
      prevAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      prevEnabled = isScopeModelsEnabled();
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(
        join(projectDir, ".pi", "settings.json"),
        JSON.stringify({ enabledModels: ["openai-codex/gpt-5.5"] }),
      );
      setScopeModelsEnabled(true);
      ctx = { session: true, cwd: projectDir, modelRegistry: registry };
      deps = { events, pi: { events }, getCtx: () => ctx, manager };
    });

    afterEach(() => {
      setScopeModelsEnabled(prevEnabled); // module-global — restore for other suites
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });

    async function spawn(requestId: string, model: unknown) {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on(`subagents:rpc:spawn:reply:${requestId}`, reply);
      events.emit("subagents:rpc:spawn", {
        requestId, type: "worker", prompt: "x", options: { model },
      });
      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      return (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it("refuses an out-of-scope string override, listing what is allowed", async () => {
      // The reported case: a bare "sonnet" fuzzy-resolves across providers, so
      // only the RESOLVED model can be compared against enabledModels.
      const call = await spawn("req-sc1", "sonnet");
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not in scope/);
      expect(call.error).toContain('"sonnet"');
      expect(call.error).toContain("  openai-codex/gpt-5.5");
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("refuses an out-of-scope Model object override too", async () => {
      const call = await spawn("req-sc2", BLOCKED);
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not in scope/);
      expect(call.error).toContain('"anthropic/claude-sonnet-4"');
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("spawns normally when the override is in scope", async () => {
      const call = await spawn("req-sc3", "openai-codex/gpt-5.5");
      expect(call).toEqual({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "x", expect.objectContaining({ model: ALLOWED, invocation: expect.objectContaining({ modelName: `${ALLOWED.provider}/${ALLOWED.id}` }) }),
      );
    });

    it("does not check scope while the setting is off", async () => {
      setScopeModelsEnabled(false);
      const call = await spawn("req-sc4", "sonnet");
      expect(call).toEqual({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "worker", "x", expect.objectContaining({ model: BLOCKED, invocation: expect.objectContaining({ modelName: `${BLOCKED.provider}/${BLOCKED.id}` }) }),
      );
    });
  });

  describe("spawn RPC pinned council advisor enforcement (end-to-end extension)", () => {
    const parentModel = { id: "parent-model", provider: "anthropic", name: "Parent Model" };
    const melchiorModel = { id: "gpt-6.2-astra", provider: "magpie", name: "GPT 6.2 Astra" };
    const overrideModel = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };

    let hermetic: Hermetic | undefined;
    let lifecycle: Map<string, any> | undefined;
    let parentCtx: any;

    afterEach(async () => {
      await lifecycle?.get("session_shutdown")?.({}, parentCtx);
      lifecycle = undefined;
      parentCtx = undefined;
      delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
      delete (globalThis as any)[Symbol.for("pi-subagents:host")];
      hermetic?.restore();
      hermetic = undefined;
      vi.restoreAllMocks();
    });

    async function bootWithRegistry(modelRegistry: any) {
      hermetic = hermeticDir({
        settings: { outputTranscript: false, schedulingEnabled: false },
      });
      const booted = makePi();
      const bus = createEventBus();
      booted.pi.events = bus;
      subagentsExtension(booted.pi);
      lifecycle = booted.lifecycle;
      parentCtx = makeExtCtx({
        isProjectTrusted: () => true,
        model: parentModel,
        modelRegistry,
      });
      await booted.lifecycle.get("session_start")({}, parentCtx);

      const rpcSpawn = async (requestId: string, payload: Record<string, unknown>) => {
        const reply = vi.fn();
        bus.on(`subagents:rpc:spawn:reply:${requestId}`, reply);
        bus.emit("subagents:rpc:spawn", { requestId, ...payload });
        await vi.waitFor(() => expect(reply).toHaveBeenCalled());
        return (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      };

      return { rpcSpawn };
    }

    it("rejects council-melchior when magpie/gpt-6.2-astra is absent instead of falling back to ctx.model", async () => {
      const spawnSpy = vi.spyOn(AgentManager.prototype, "spawn");
      const { rpcSpawn } = await bootWithRegistry({
        find: (provider: string, id: string) =>
          provider === parentModel.provider && id === parentModel.id ? parentModel : undefined,
        getAll: () => [parentModel],
        getAvailable: () => [parentModel],
      });

      const reply = await rpcSpawn("req-cm-missing", {
        type: "council-melchior",
        prompt: "Review architecture",
      });

      expect(reply).toEqual({
        success: false,
        error: expect.stringMatching(/magpie\/gpt-6\.2-astra.*not (registered|available)/i),
      });
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("rejects council-melchior when magpie/gpt-6.2-astra is registered but unavailable", async () => {
      const spawnSpy = vi.spyOn(AgentManager.prototype, "spawn");
      const { rpcSpawn } = await bootWithRegistry({
        find: (provider: string, id: string) =>
          provider === melchiorModel.provider && id === melchiorModel.id ? melchiorModel : undefined,
        getAll: () => [melchiorModel, parentModel],
        getAvailable: () => [parentModel],
        hasConfiguredAuth: () => false,
      });

      const reply = await rpcSpawn("req-cm-unavail", {
        type: "council-melchior",
        prompt: "Review architecture",
      });

      expect(reply).toEqual({
        success: false,
        error: expect.stringMatching(/magpie\/gpt-6\.2-astra.*not (registered|available)/i),
      });
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("rejects council-melchior when options.model attempts to override its pinned model", async () => {
      const spawnSpy = vi.spyOn(AgentManager.prototype, "spawn");
      const models = [melchiorModel, overrideModel, parentModel];
      const { rpcSpawn } = await bootWithRegistry({
        find: (provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
      });

      const reply = await rpcSpawn("req-cm-override", {
        type: "council-melchior",
        prompt: "Review architecture",
        options: { model: "openai-codex/gpt-5.5" },
      });

      expect(reply).toEqual({
        success: false,
        error: 'Council advisor "council-melchior" has pinned model "magpie/gpt-6.2-astra" and cannot be overridden.',
      });
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("forwards the resolved pinned model to manager.spawn when magpie/gpt-6.2-astra is available", async () => {
      const spawnSpy = vi.spyOn(AgentManager.prototype, "spawn").mockReturnValueOnce("council-42");
      vi.spyOn(AgentManager.prototype, "awaitStartup").mockResolvedValueOnce(undefined);
      const models = [melchiorModel, parentModel];
      const { rpcSpawn } = await bootWithRegistry({
        find: (provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
      });

      const reply = await rpcSpawn("req-cm-ok", {
        type: "council-melchior",
        prompt: "Review architecture",
      });

      expect(reply).toEqual({ success: true, data: { id: "council-42" } });
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy).toHaveBeenCalledWith(
        expect.anything(),
        parentCtx,
        "council-melchior",
        "Review architecture",
        expect.objectContaining({ model: melchiorModel }),
      );
    });
  });
});
