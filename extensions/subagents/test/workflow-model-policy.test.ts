import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { journalKey } from "../src/workflow/journal.js";
import { runWorkflow } from "../src/workflow/runtime.js";

const wire = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));

// Inject an old/raw worker message, bypassing the script's option validator.
// The runtime must reject it even with a matching persisted journal entry.
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("message", {
        type: "call", callId: 1, method: "agent", payload: wire.payload,
      }));
    }
    postMessage(response: { ok: boolean; error?: string }) {
      queueMicrotask(() => this.emit("message", response.ok
        ? { type: "complete", resultJson: '"unexpected success"' }
        : { type: "error", message: response.error }));
    }
    async terminate() { return 0; }
  },
}));

describe("workflow runtime model boundary", () => {
  it.each(["unknown/no-such-model", "anthropic/very-expensive", undefined, null])(
    "rejects a legacy raw model request (%s) before replay or spawn", async model => {
      wire.payload = { prompt: "go", agentType: "worker", model };
      const spawnAgent = vi.fn(async () => ({ ok: true, text: "unexpected spawn" }));
      const append = vi.fn();
      const result = await runWorkflow({
        script: 'export const meta = { name: "legacy", description: "persisted script" }; return null;',
        host: { spawnAgent, abortAgent: vi.fn() },
        journal: {
          entries: [{ index: 0, key: journalKey(wire.payload as any), ok: true, text: "old cached answer" }],
          append,
        },
      });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Model overrides are unavailable");
      expect(result.error).toContain("agentType");
      expect(result.agentCount).toBe(0);
      expect(result.replayedCount).toBe(0);
      expect(result.progress).toEqual([]);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );
});
