import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogFile } from "../../src/core/logfile.ts";
import { displayLines, findLocalUrls, LineSplitter } from "../../src/core/text.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "processes-log-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);

describe("LogFile", () => {
	it("rotates into .1, keeps absolute cursors, and flags truncation", () => {
		const log = new LogFile(path.join(dir, "p.log"), 100);
		let expected = 0;
		for (const line of numbered(1, 10)) {
			log.append(Buffer.from(`${line}\n`));
			expected += line.length + 1;
		}
		const first = log.read({ cursor: 0 }, false);
		expect(first).toEqual({ lines: numbered(1, 10), nextCursor: expected, truncated: false, more: false });

		for (const line of numbered(11, 40)) {
			log.append(Buffer.from(`${line}\n`));
			expected += line.length + 1;
		}
		expect(log.bytes).toBe(expected);
		expect(fs.existsSync(path.join(dir, "p.log.1"))).toBe(true);
		expect(fs.statSync(path.join(dir, "p.log")).size).toBeLessThanOrEqual(100);

		const stale = log.read({ cursor: 0 }, false);
		expect(stale.truncated).toBe(true);
		expect(stale.lines.at(-1)).toBe("line 40");
		expect(stale.lines[0]).toMatch(/^line \d+$/);
		expect(stale.nextCursor).toBe(expected);

		// A cursor inside retained data reads across both generations without truncation.
		const recent = log.read({ cursor: expected - "line 38\nline 39\nline 40\n".length }, false);
		expect(recent).toEqual({ lines: ["line 38", "line 39", "line 40"], nextCursor: expected, truncated: false, more: false });
		log.close();
	});

	it("pages by maxBytes at line boundaries and holds back a partial line while live", () => {
		const log = new LogFile(path.join(dir, "p.log"), 1 << 20);
		log.append(Buffer.from("alpha\nbeta\ngamma\npart"));
		const page = log.read({ cursor: 0, maxBytes: 12 }, false);
		expect(page).toEqual({ lines: ["alpha", "beta"], nextCursor: 11, truncated: false, more: true });
		const rest = log.read({ cursor: page.nextCursor }, false);
		expect(rest).toEqual({ lines: ["gamma"], nextCursor: 17, truncated: false, more: false });
		expect(log.read({ cursor: rest.nextCursor }, true).lines).toEqual(["part"]);
		expect(() => log.read({ cursor: 999 }, false)).toThrow(/outside the log/);
		log.close();
	});

	it("reads the tail with a filter and rejects bad patterns", () => {
		const log = new LogFile(path.join(dir, "p.log"), 1 << 20);
		log.append(Buffer.from(`${numbered(1, 100).join("\n")}\n`));
		expect(log.read({ tail: 3 }, true).lines).toEqual(["line 98", "line 99", "line 100"]);
		expect(log.read({ tail: 2, filter: "7$" }, true).lines).toEqual(["line 87", "line 97"]);
		expect(() => log.read({ filter: "(" }, true)).toThrow(/not a valid regular expression/);
		expect(() => log.read({ filter: "a".repeat(501) }, true)).toThrow(/longer than 500/);
		log.close();
	});
});

describe("text", () => {
	it("splits partial lines across chunks and treats \\r as a break", () => {
		const splitter = new LineSplitter();
		expect(splitter.push(Buffer.from("hel"))).toEqual([]);
		expect(splitter.push(Buffer.from("lo\r\n\x1b[32mgreen\x1b[0m\n10%\r20%\r"))).toEqual(["hello", "green", "10%", "20%"]);
		expect(splitter.push(Buffer.from("tail"))).toEqual([]);
		expect(splitter.end()).toEqual(["tail"]);
	});

	it("caps one line at 16 KiB", () => {
		const splitter = new LineSplitter();
		const lines = splitter.push(Buffer.from(`${"x".repeat(20_000)}\nnext\n`));
		expect(lines.map((line) => line.length)).toEqual([16 * 1024, 4]);
	});

	it("shows the last \\r redraw in display lines and finds local URLs", () => {
		expect(displayLines(Buffer.from("10%\r20%\r\n\x1b[1mdone\x1b[0m"))).toEqual(["20%", "done"]);
		expect(findLocalUrls("Local: http://localhost:5173/, net: http://192.168.1.2:5173 and https://[::1]:8443.")).toEqual([
			"http://localhost:5173/",
			"https://[::1]:8443",
		]);
	});
});
