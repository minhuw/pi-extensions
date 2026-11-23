import type { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonLink, LatestSender } from "../transport.ts";
import { FakeDaemon, tempDir, until } from "./support.ts";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** A deliver function whose calls stay open until the test resolves them. */
function controllable() {
	const calls: Array<{ value: number; signal: AbortSignal; resolve: (result: string) => void }> = [];
	const deliver = vi.fn((value: number, signal: AbortSignal) => new Promise<string>(resolve => { calls.push({ value, signal, resolve }); }));
	return { calls, deliver };
}

describe("LatestSender", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
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

interface LinkInternals {
	socket: Socket | undefined;
	replies: Map<string, unknown>;
}

describe("DaemonLink request write lifecycle", () => {
	let dir: ReturnType<typeof tempDir>;
	let daemon: FakeDaemon;
	let link: DaemonLink | undefined;

	beforeEach(async () => {
		dir = tempDir();
		daemon = new FakeDaemon(join(dir.path, "daemon.sock"));
		await daemon.listen();
	});

	afterEach(async () => {
		link?.close();
		link = undefined;
		await daemon.close();
		dir.cleanup();
		vi.restoreAllMocks();
	});

	async function readyLink(): Promise<{ link: DaemonLink; internals: LinkInternals; socket: Socket }> {
		link = new DaemonLink({
			socket: daemon.path,
			pane: "pane-1",
			version: "test",
			onWelcome: () => {},
			backoff: { initialMs: 1000, maxMs: 1000 },
		});
		link.start();
		await until(() => link!.state === "ready", 5000, "link ready");
		const internals = link as unknown as LinkInternals;
		return { link, internals, socket: internals.socket! };
	}

	it("aborts a stalled socket write at the request deadline and cleans up replies and listeners", async () => {
		const { link, internals, socket } = await readyLink();
		const closeListenersBefore = socket.listenerCount("close");
		vi.spyOn(socket, "write").mockImplementation(() => false);

		const start = Date.now();
		const reply = await link.request({ type: "open", path: "/stalled" }, 80);
		const elapsed = Date.now() - start;

		expect(reply).toEqual({ error: { code: "timeout", message: "the pika-node daemon did not answer in time" } });
		expect(elapsed).toBeLessThan(1000);
		expect(socket.destroyed).toBe(true);
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(closeListenersBefore);
	});

	it("aborts a stalled backpressure drain wait at the request deadline", async () => {
		const { link, internals, socket } = await readyLink();
		const closeListenersBefore = socket.listenerCount("close");
		vi.spyOn(socket, "write").mockImplementation(((_chunk: unknown, cb?: unknown) => {
			if (typeof cb === "function") cb(null);
			return false;
		}) as typeof socket.write);

		const start = Date.now();
		const reply = await link.request({ type: "diff", path: "/backpressure" }, 80);
		const elapsed = Date.now() - start;

		expect(reply).toEqual({ error: { code: "timeout", message: "the pika-node daemon did not answer in time" } });
		expect(elapsed).toBeLessThan(1000);
		expect(socket.destroyed).toBe(true);
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(closeListenersBefore);
	});

	it("succeeds when backpressure drains before the request deadline", async () => {
		const { link, internals, socket } = await readyLink();
		const closeListenersBefore = socket.listenerCount("close");
		const realWrite = socket.write.bind(socket);
		vi.spyOn(socket, "write").mockImplementation(((chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => {
			realWrite(chunk, err => {
				cb?.(err);
				if (!err) setTimeout(() => socket.emit("drain"), 10);
			});
			return false;
		}) as typeof socket.write);

		const reply = await link.request({ type: "open", path: "/drained" }, 1000);

		expect(reply).toEqual({ delivered: 1 });
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(closeListenersBefore);
	});

	it("removes the settled entry from replies and leaks no listeners on async write failure", async () => {
		const { link, internals, socket } = await readyLink();
		const closeListenersBefore = socket.listenerCount("close");
		const writeSpy = vi.spyOn(socket, "write").mockImplementation(((_chunk: unknown, cb?: unknown) => {
			if (typeof cb === "function") queueMicrotask(() => cb(new Error("EPIPE")));
			return false;
		}) as typeof socket.write);

		const reply = await link.request({ type: "open", path: "/failed" }, 1000);

		expect(reply).toEqual({ error: { code: "unavailable", message: "write failed: EPIPE" } });
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(closeListenersBefore);

		// A subsequent request on the same healthy socket still succeeds with no leaked state.
		writeSpy.mockRestore();
		expect(await link.request({ type: "open", path: "/ok" }, 1000)).toEqual({ delivered: 1 });
		expect(internals.replies.size).toBe(0);
	});

	it("removes the settled entry from replies and cleans up listeners when socket.write throws synchronously", async () => {
		const { link, internals, socket } = await readyLink();
		const closeListenersBefore = socket.listenerCount("close");
		vi.spyOn(socket, "write").mockImplementation(() => { throw new Error("boom"); });

		const reply = await link.request({ type: "diff", path: "/throw" }, 1000);

		expect(reply).toEqual({ error: { code: "unavailable", message: "write failed: boom" } });
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(closeListenersBefore);
	});

	it("settles promptly without hanging when close() is called during a stalled write", async () => {
		const { link, internals, socket } = await readyLink();
		vi.spyOn(socket, "write").mockImplementation(() => false);

		const pending = link.request({ type: "open", path: "/closing" }, 5000);
		await flush();
		link.close();

		expect(await pending).toEqual({ error: { code: "closed", message: "the bridge shut down" } });
		expect(internals.replies.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
	});
});
