/** Cancelling a wait must handle late child rejections and release the abort listener. */

import { describe, expect, it, vi } from "vitest";
import { abortable } from "../src/abortable.js";

/**
 * Collect unhandled rejections for the duration of a block.
 *
 * Vitest installs its own handler, so `process.on` alone would not observe them —
 * `removeAllListeners` is used and the originals restored afterwards.
 */
async function withUnhandledRejectionSpy(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const prior = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const capture = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", capture);
  try {
    await fn();
    // Unhandled rejections are reported on a later macrotask, not a microtask.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", capture);
    for (const l of prior) process.on("unhandledRejection", l as never);
  }
  return seen;
}

describe("abortable", () => {
  it("returns the original promise untouched when there is no signal", async () => {
    const promise = Promise.resolve("value");
    expect(abortable(promise)).toBe(promise);
    await expect(promise).resolves.toBe("value");
  });

  it("rejects immediately with the signal's reason when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone before we started"));
    await expect(abortable(new Promise(() => {}), controller.signal))
      .rejects.toThrow("gone before we started");
  });

  it("resolves normally when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
  });

  it("propagates a rejection from the wrapped promise", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.reject(new Error("work failed")), controller.signal))
      .rejects.toThrow("work failed");
  });

  it("rejects with the abort reason when the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort(new Error("user pressed Esc"));
    await expect(pending).rejects.toThrow("user pressed Esc");
  });

  it("absorbs a late REJECTION of the wrapped promise after an abort", async () => {
    // A child can fail after its caller has stopped waiting (#159).
    const unhandled = await withUnhandledRejectionSpy(async () => {
      const controller = new AbortController();
      let failChild: ((e: unknown) => void) | undefined;
      const childWork = new Promise((_resolve, reject) => { failChild = reject; });

      const pending = abortable(childWork, controller.signal);
      controller.abort(new Error("stopped waiting"));
      await expect(pending).rejects.toThrow("stopped waiting");

      failChild!(new Error("child died later"));
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(unhandled).toEqual([]);
  });

  it("absorbs a late RESOLUTION of the wrapped promise after an abort", async () => {
    const controller = new AbortController();
    let finishChild: ((v: string) => void) | undefined;
    const childWork = new Promise<string>((resolve) => { finishChild = resolve; });

    const pending = abortable(childWork, controller.signal);
    controller.abort(new Error("stopped waiting"));
    await expect(pending).rejects.toThrow("stopped waiting");

    finishChild!("child finished anyway");
    // The child's own result is still available to whoever holds it — abortable
    // cancelled the wait, not the work.
    await expect(childWork).resolves.toBe("child finished anyway");
  });

  it("removes its abort listener once the promise resolves", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await abortable(Promise.resolve("done"), controller.signal);

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes its abort listener once the promise rejects", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(abortable(Promise.reject(new Error("nope")), controller.signal)).rejects.toThrow();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
