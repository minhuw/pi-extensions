import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isKnownEvent, makeEvent } from "../../src/journal/events.ts";
import { Journal, journalFs, readJournal } from "../../src/journal/journal.ts";

const dirs: string[] = [];
const journalPath = () => {
	const dir = mkdtempSync(join(tmpdir(), "herder-journal-"));
	dirs.push(dir);
	return join(dir, "journal.jsonl");
};
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("journal", () => {
	it("round-trips appended events", () => {
		const journal = new Journal(journalPath());
		const started = journal.append({ t: "run.started", runId: "20260101-000000-abcd", title: "t", base: "b", runtime: "0.1.0", repo: "/r" });
		const decision = journal.append({ t: "decision.recorded", question: "line\nbreak?", answer: "yes" });
		expect(started).toMatchObject({ v: 1, t: "run.started", title: "t" });
		expect(Number.isNaN(Date.parse(started.at))).toBe(false);
		expect(journal.read()).toEqual([started, decision]);
		expect(readFileSync(journal.path, "utf8").split("\n")).toHaveLength(3);
	});

	it("reads a missing journal as empty", () => {
		expect(readJournal(journalPath())).toEqual([]);
	});

	it("fsyncs the written file on every append", () => {
		const journal = new Journal(journalPath());
		const log: Array<[string, number]> = [];
		const { writeSync, fsyncSync } = journalFs;
		vi.spyOn(journalFs, "writeSync").mockImplementation(((fd: number, ...rest: unknown[]) => {
			log.push(["write", fd]);
			return (writeSync as (...args: unknown[]) => number)(fd, ...rest);
		}) as typeof writeSync);
		vi.spyOn(journalFs, "fsyncSync").mockImplementation((fd) => {
			log.push(["fsync", fd]);
			fsyncSync(fd);
		});
		for (let index = 0; index < 3; index++) {
			log.length = 0;
			journal.append({ t: "plan.updated", sha256: String(index) });
			const written = log.findLastIndex(([call]) => call === "write");
			expect(written).toBeGreaterThanOrEqual(0);
			expect(log.slice(written + 1)).toContainEqual(["fsync", log[written]![1]]);
		}
		expect(journal.read()).toHaveLength(3);
	});

	it("ignores a torn final line without a newline", () => {
		const path = journalPath();
		const journal = new Journal(path);
		const first = journal.append({ t: "plan.updated", sha256: "a" });
		appendFileSync(path, '{"v":1,"t":"plan.updated","at":"x","sha2');
		expect(readJournal(path)).toEqual([first]);
	});

	it("ignores an unparsable final line even with a newline", () => {
		const path = journalPath();
		const first = new Journal(path).append({ t: "plan.updated", sha256: "a" });
		appendFileSync(path, "{not json\n");
		expect(readJournal(path)).toEqual([first]);
	});

	it("truncates a torn tail before appending instead of gluing onto it", () => {
		const path = journalPath();
		const first = new Journal(path).append({ t: "plan.updated", sha256: "a" });
		appendFileSync(path, '{"v":1,"t":"plan.upd');
		const second = new Journal(path).append({ t: "plan.updated", sha256: "b" });
		expect(readJournal(path)).toEqual([first, second]);
		expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

		appendFileSync(path, "garbage\n");
		const third = new Journal(path).append({ t: "plan.updated", sha256: "c" });
		expect(readJournal(path)).toEqual([first, second, third]);
	});

	it("fails closed on corruption before the final line", () => {
		const path = journalPath();
		const event = makeEvent({ t: "plan.updated", sha256: "a" });
		writeFileSync(path, `${JSON.stringify(event)}\n{oops\n${JSON.stringify(event)}\n`);
		expect(() => readJournal(path)).toThrow(/corrupt at line 2/);
		expect(() => new Journal(path).append({ t: "plan.updated", sha256: "b" })).toThrow(/corrupt at line 2/);
	});

	it("ignores unknown event types and keeps unknown fields", () => {
		const path = journalPath();
		const known = { ...makeEvent({ t: "plan.updated", sha256: "a" }), extra: { nested: true } };
		writeFileSync(path, [
			JSON.stringify({ v: 1, t: "future.event", at: "x", payload: 1 }),
			JSON.stringify([1, 2]),
			"",
			JSON.stringify(known),
			"",
		].join("\n"));
		expect(readJournal(path)).toEqual([known]);
		expect(isKnownEvent(known)).toBe(true);
		expect(isKnownEvent({ v: 1, t: "plan.updated" })).toBe(false);
	});

	it("fails closed on events from a newer schema version", () => {
		const path = journalPath();
		const event = makeEvent({ t: "plan.updated", sha256: "a" });
		for (const newer of [{ ...event, v: 2 }, { v: 2, t: "future.event", at: "x" }]) {
			writeFileSync(path, `${JSON.stringify(event)}\n${JSON.stringify(newer)}\n`);
			expect(() => readJournal(path)).toThrow(/journal .* line 2 was written by a newer Herder version \(schema 2; this version supports 1\)/);
			expect(() => new Journal(path).append({ t: "plan.updated", sha256: "b" })).toThrow(/newer Herder version/);
		}
	});
});
