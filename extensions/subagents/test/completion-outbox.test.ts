import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionOutbox, NOTIFICATION_HOLD_MS, type OutboxItem } from "../src/completion-outbox.js";
import type { NotificationDetails } from "../src/types.js";

function details(id: string, others?: NotificationDetails[]): NotificationDetails {
  return {
    id, description: `task ${id}`, status: "completed", toolUses: 0, turnCount: 1,
    totalTokens: 0, durationMs: 1, resultPreview: "", ...(others ? { others } : {}),
  };
}

const message = (id: string) => ({ content: `<done ${id}>`, details: details(id) });
const item = (id: string): OutboxItem => ({ ids: [id], build: () => message(id) });

describe("CompletionOutbox", () => {
  let running: boolean;
  let send: ReturnType<typeof vi.fn>;
  let outbox: CompletionOutbox;

  beforeEach(() => {
    vi.useFakeTimers();
    running = false;
    send = vi.fn();
    outbox = new CompletionOutbox(send, () => running);
  });

  afterEach(() => {
    outbox.dispose();
    vi.useRealTimers();
  });

  describe("idle parent", () => {
    it("sends after the hold, triggering a turn", () => {
      outbox.add(item("a"));
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS - 1);
      expect(send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledExactlyOnceWith({ content: "<done a>", details: details("a") });
    });

    it("folds a completion inside the hold into the same message, without pushing the first back", () => {
      outbox.add(item("a"));
      vi.advanceTimersByTime(150);
      outbox.add(item("b"));
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS - 150);

      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0].content).toBe("2 background tasks finished.\n\n<done a>\n\n<done b>");
    });
  });

  describe("busy parent", () => {
    beforeEach(() => { running = true; });

    it("holds everything until the turn ends, then sends it as one message", () => {
      outbox.add(item("a"));
      outbox.add(item("b"));
      vi.advanceTimersByTime(60_000);
      expect(send).not.toHaveBeenCalled();

      outbox.onTurnEnd("toolUse");
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          details: expect.objectContaining({ id: "a", others: [details("b")] }),
        }),
      );
    });

    it("holds an aborted turn's completions until the run has ended, then sends them", () => {
      outbox.add(item("a"));
      outbox.onTurnEnd("aborted");
      expect(send).not.toHaveBeenCalled();

      outbox.onAgentEnd();
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
      expect(send).toHaveBeenCalledOnce();
    });

    it("keeps completions through a failed turn, which pi may retry", () => {
      outbox.add(item("a"));
      outbox.onTurnEnd("error");
      expect(send).not.toHaveBeenCalled();

      outbox.onTurnEnd("stop");
      expect(send).toHaveBeenCalledOnce();
    });

    it("sends what landed after the run's last turn once the run ends", () => {
      outbox.add(item("a"));
      outbox.onAgentEnd();
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
      expect(send).toHaveBeenCalledOnce();
    });
  });

  describe("cancel — the result was read before the send", () => {
    it("drops that agent's notification", () => {
      outbox.add(item("a"));
      outbox.add(item("b"));
      outbox.cancel("a");
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
      expect(send).toHaveBeenCalledExactlyOnceWith(message("b"));
    });

    it("builds a group's notification from the members still unread", () => {
      const build = vi.fn((ids: readonly string[]) => ({ content: ids.join(","), details: details(ids[0]) }));
      outbox.add({ ids: ["a", "b"], build });
      outbox.cancel("a");
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
      expect(build).toHaveBeenCalledExactlyOnceWith(["b"], [undefined]);
      expect(send).toHaveBeenCalledExactlyOnceWith({ content: "b", details: details("b") });
    });

    it("sends nothing once every member was read", () => {
      const build = vi.fn(() => message("a"));
      outbox.add({ ids: ["a", "b"], build });
      outbox.cancel("a");
      outbox.cancel("b");
      vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
      expect(build).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("replaces an agent's pending notification with its newer completion", () => {
    outbox.add(item("a"));
    outbox.add({ ids: ["a"], build: () => ({ content: "<done a again>", details: details("a") }) });
    vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
    expect(send).toHaveBeenCalledExactlyOnceWith({ content: "<done a again>", details: details("a") });
  });

  it("preserves execution IDs when the same completion is delivered again and grouped", () => {
    const completion = { content: "same", details: { ...details("a"), executionId: "run-a" } };
    const repeated = { ids: ["a"], build: () => completion };
    outbox.add(repeated);
    outbox.onTurnEnd("stop");
    outbox.add(repeated);
    outbox.add({ ids: ["b"], build: () => ({ content: "b", details: { ...details("b"), executionId: "run-b" } }) });
    outbox.onTurnEnd("stop");
    expect(send.mock.calls[0][0].details.executionId).toBe("run-a");
    expect(send.mock.calls[1][0].details.executionId).toBe("run-a");
    expect(send.mock.calls[1][0].details.others[0].executionId).toBe("run-b");
  });

  it("keeps distinct executions, deduplicates pending pairs, and cancels only the consumed execution", () => {
    const run = (executionId: string) => ({ ids: ["a"], executionIds: [executionId], build: () => ({ content: executionId, details: { ...details("a"), executionId } }) });
    outbox.add(run("one"));
    outbox.add(run("two"));
    outbox.add(run("one"));
    outbox.cancel("a", "two");
    outbox.onTurnEnd("stop");
    expect(send).toHaveBeenCalledExactlyOnceWith({ content: "one", details: { ...details("a"), executionId: "one" } });
    outbox.add(run("one")); // redelivery after a send is still permitted
    outbox.onTurnEnd("stop");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("replaces legacy entries by agent ID and cancels a legacy entry on consumption", () => {
    outbox.add(item("a"));
    outbox.add({ ids: ["a"], executionIds: ["new"], build: () => message("new") });
    outbox.add(item("a"));
    outbox.cancel("a", "new");
    outbox.onTurnEnd("stop");
    expect(send).not.toHaveBeenCalled();
  });

  it("flattens a group's agents into one list of details", () => {
    outbox.add({ ids: ["a", "b"], build: () => ({ content: "<group>", details: details("a", [details("b")]) }) });
    outbox.add(item("c"));
    vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
    expect(send.mock.calls[0][0].details).toEqual({ ...details("a"), others: [details("b"), details("c")] });
  });

  it("survives a send that throws on a stale context", () => {
    send.mockImplementation(() => { throw new Error("stale extension context"); });
    outbox.add(item("a"));
    expect(() => vi.advanceTimersByTime(NOTIFICATION_HOLD_MS)).not.toThrow();
  });

  it("dispose drops pending completions and their timer", () => {
    outbox.add(item("a"));
    outbox.dispose();
    vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
