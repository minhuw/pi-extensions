import { describe, expect, it } from "vitest";
import { AttachStream } from "../src/nodes/attach";

const snap = (outputSequence: number, data = "SCREEN") => ({ data, cols: 80, rows: 24, outputSequence });
const writes = (ops: ReturnType<AttachStream["output"]>) => ops.map((op) => (op.op === "write" ? op.data : op.op));

describe("attach and output sequence", () => {
	it("buffers output until the snapshot, then plays it past outputSequence", () => {
		const stream = new AttachStream();
		expect(stream.output(4, "d4")).toEqual([]);
		expect(stream.output(5, "d5")).toEqual([]);
		expect(stream.output(6, "d6")).toEqual([]);
		expect(writes(stream.snapshot(snap(4)))).toEqual(["reset", "SCREEN", "d5", "d6"]);
		expect(stream.attaching).toBe(false);
		expect(stream.applied).toBe(6);
		expect(writes(stream.output(7, "d7"))).toEqual(["d7"]);
	});

	it("drops chunks at or below the applied sequence", () => {
		const stream = new AttachStream();
		stream.snapshot(snap(10));
		expect(stream.output(9, "old")).toEqual([]);
		expect(stream.output(10, "old")).toEqual([]);
		expect(writes(stream.output(11, "new"))).toEqual(["new"]);
	});

	it("re-attaches on a gap while live, and buffers until the new snapshot", () => {
		const stream = new AttachStream();
		stream.snapshot(snap(3));
		expect(writes(stream.output(5, "d5"))).toEqual(["reattach"]);
		expect(stream.attaching).toBe(true);
		expect(stream.output(6, "d6")).toEqual([]);
		expect(writes(stream.snapshot(snap(5, "S2")))).toEqual(["reset", "S2", "d6"]);
	});

	it("re-attaches when the buffer has a gap past the snapshot", () => {
		const stream = new AttachStream();
		stream.output(8, "d8");
		expect(writes(stream.snapshot(snap(6)))).toEqual(["reset", "SCREEN", "reattach"]);
		expect(stream.attaching).toBe(true);
	});

	it("takes a term.snapshot resync while live", () => {
		const stream = new AttachStream();
		stream.snapshot(snap(1));
		stream.output(2, "d2");
		// The daemon dropped 3..19 for backpressure and resyncs at 19.
		expect(writes(stream.snapshot(snap(19, "RESYNC")))).toEqual(["reset", "RESYNC"]);
		expect(writes(stream.output(20, "d20"))).toEqual(["d20"]);
	});

	it("resets at the snapshot's size", () => {
		const stream = new AttachStream();
		expect(stream.snapshot({ data: "", cols: 132, rows: 50, outputSequence: 0 })[0]).toEqual({ op: "reset", cols: 132, rows: 50 });
	});

	it("begin() discards a stale buffer", () => {
		const stream = new AttachStream();
		stream.output(2, "stale");
		stream.begin();
		expect(writes(stream.snapshot(snap(1)))).toEqual(["reset", "SCREEN"]);
	});
});

describe("input frames", () => {
	it("splits input into frames within the byte limit, never inside a character", async () => {
		const { splitInput } = await import("../src/nodes/input");
		expect(splitInput("")).toEqual([]);
		expect(splitInput("ls\r")).toEqual(["ls\r"]);
		const paste = "a".repeat(5) + "é" + "😀".repeat(3);
		const chunks = splitInput(paste, 4);
		expect(chunks.join("")).toBe(paste);
		for (const chunk of chunks) expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(4);
		expect(chunks).toContain("😀");
	});

	it("claims the size for typing and pasting, not for focus or mouse reports", async () => {
		const { claimsSize } = await import("../src/nodes/input");
		for (const typed of ["a", "ls\r", "\x1b", "\x1b[A", "\x1bOA", "\x1b[200~paste\x1b[201~", "\x1b[I typed"]) expect(claimsSize(typed), JSON.stringify(typed)).toBe(true);
		for (const report of ["", "\x1b[I", "\x1b[O", "\x1b[O\x1b[I", "\x1b[<35;10;4M", "\x1b[<0;120;40m", "\x1b[32;10;4M", "\x1b[M#!!"]) {
			expect(claimsSize(report), JSON.stringify(report)).toBe(false);
		}
	});

	it("matches the focus reports a real xterm.js sends", async () => {
		const { claimsSize } = await import("../src/nodes/input");
		const { Terminal } = await import("@xterm/xterm");
		const host = document.createElement("div");
		document.body.append(host);
		const term = new Terminal({ cols: 20, rows: 4 });
		term.open(host);
		const sent: string[] = [];
		term.onData((data) => sent.push(data));
		await new Promise<void>((resolve) => term.write("\x1b[?1004h", resolve));
		term.textarea!.dispatchEvent(new FocusEvent("focus"));
		term.textarea!.dispatchEvent(new FocusEvent("blur"));
		// Turning focus reporting on reports the current focus at once: an attach whose snapshot restores 1004 sends one.
		expect(sent).toEqual(["\x1b[O", "\x1b[I", "\x1b[O"]);
		expect(sent.some(claimsSize)).toBe(false);
		term.dispose();
		host.remove();
	});
});
