import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatestSender } from "../transport.ts";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** A deliver function whose calls stay open until the test resolves them. */
function controllable() {
	const calls: Array<{ value: number; signal: AbortSignal; resolve: (result: string) => void }> = [];
	const deliver = vi.fn((value: number, signal: AbortSignal) => new Promise<string>(resolve => { calls.push({ value, signal, resolve }); }));
	return { calls, deliver };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("LatestSender", () => {
	it("keeps one delivery in flight and one pending value that newer values replace", async () => {
		const { calls, deliver } = controllable();
		const sender = new LatestSender(deliver, { timeoutMs: 1000, intervalMs: 100 });
		sender.post(1);
		sender.post(2);
		sender.post(3);
		await flush();
		expect(calls.map(call => call.value)).toEqual([1]);
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toHaveLength(1);
		calls[0]!.resolve("sent");
		await flush();
		expect(calls.map(call => call.value)).toEqual([1, 3]);
		expect(sender.lastResult).toBe("sent");
		await sender.close();
	});

	it("spaces attempts by the interval and always ends on the latest value", async () => {
		const sent: number[] = [];
		const sender = new LatestSender(async (value: number) => { sent.push(value); return "sent"; }, { timeoutMs: 1000, intervalMs: 100 });
		sender.post(1);
		await flush();
		for (let value = 2; value <= 10; value++) { sender.post(value); await vi.advanceTimersByTimeAsync(10); }
		expect(sent).toEqual([1]);
		await vi.advanceTimersByTimeAsync(10);
		expect(sent).toEqual([1, 10]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent).toEqual([1, 10]);
		await sender.close();
	});

	it("bounds each attempt by the timeout, aborts its signal, and moves on", async () => {
		const { calls, deliver } = controllable();
		const sender = new LatestSender(deliver, { timeoutMs: 1000, intervalMs: 100 });
		sender.post(1);
		await flush();
		sender.post(2);
		await vi.advanceTimersByTimeAsync(999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls[0]!.signal.aborted).toBe(true);
		expect(calls[0]!.signal.reason).toBe("timeout");
		expect(sender.lastResult).toBe("timeout");
		await flush();
		expect(calls.map(call => call.value)).toEqual([1, 2]);
		// A delivery that settles after its timeout changes nothing.
		calls[0]!.resolve("late");
		await flush();
		expect(sender.lastResult).toBe("timeout");
		calls[1]!.resolve("sent");
		await flush();
		await sender.close();
	});

	it("turns a rejected delivery into a result and never throws to the caller", async () => {
		const sender = new LatestSender(async () => { throw new Error("socket gone"); }, { timeoutMs: 1000, intervalMs: 0 });
		expect(() => sender.post(1)).not.toThrow();
		await flush();
		expect(sender.lastResult).toBe("socket gone");
		await sender.close();
	});

	it("close drops pending work, cancels the attempt in flight, and makes one bounded final attempt", async () => {
		const { calls, deliver } = controllable();
		const sender = new LatestSender(deliver, { timeoutMs: 1000, intervalMs: 100 });
		sender.post(1);
		await flush();
		sender.post(2);
		const closing = sender.close(99);
		expect(calls[0]!.signal.reason).toBe("cancelled");
		await flush();
		expect(calls.map(call => call.value)).toEqual([1, 99]);
		sender.post(3);
		await vi.advanceTimersByTimeAsync(1000);
		await closing;
		expect(sender.lastResult).toBe("timeout");
		expect(calls.map(call => call.value)).toEqual([1, 99]);
		expect(sender.close()).toBe(closing);
	});
});
