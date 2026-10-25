import { describe, expect, it } from "vitest";
import { fold } from "../../src/journal/fold.ts";
import { renderProgress } from "../../src/journal/render.ts";
import { sampleJournal } from "./sample.ts";

describe("renderProgress", () => {
	it("is byte-stable for the same journal", () => {
		const tasks = [{ id: "T1", text: "first | piped" }, { id: "T5", text: "untouched" }];
		const first = renderProgress(fold(sampleJournal()), tasks);
		expect(renderProgress(fold(sampleJournal()), tasks)).toBe(first);
		expect(renderProgress(fold(JSON.parse(JSON.stringify(sampleJournal()))), tasks)).toBe(first);
	});

	it("renders the header, task table, and history", () => {
		const text = renderProgress(fold(sampleJournal()), [{ id: "T1", text: "first | piped" }, { id: "T5", text: "untouched" }]);
		expect(text).toContain("# Herder run 20260101-000000-abcd: Add | feature\n");
		expect(text).toContain("- Status: approved\n- Verdict: not_met at h1\n");
		expect(text).toContain("| T1 first \\| piped | integrated | impl1-0 | h1 |\n| T5 untouched | pending | — | — |\n| T2 | failed | impl2-0 | — |\n");
		expect(text).toContain("| T4 | running | rev-0 | — |");
		expect(text).toContain("1. 2026-01-01T00:00:05.000Z step `impl1-0` ok at c1; 1 check(s) passed\n");
		expect(text).toContain("step `impl2-0` gate_failed at c2; checks failed: unit");
		expect(text).toContain("integration of c2 for T3 failed: conflict (a.txt)");
		expect(text.endsWith("verification not_met at h1\n")).toBe(true);
	});

	it("renders an empty run", () => {
		expect(renderProgress(fold([]))).toBe("# Herder run —\n\n- Status: drafting\n- Verdict: not verified\n- Base: —\n- Integration head: —\n- Launches: 0\n\n## Tasks\n\nNo tasks yet.\n\n## History\n\nNothing has settled yet.\n");
	});
});
