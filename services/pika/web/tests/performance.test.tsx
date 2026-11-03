import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TraceLlmRecord } from "../src/lib/types";
import { KpiStrip } from "../src/trace/Header";
import { callPerformance, sessionPerformance } from "../src/trace/performance";
import { summary } from "./support/fixtures";
import { mockLayout, renderApp, renderWithApi } from "./support/render";
import { createFakeServer, traceOf } from "./support/server";
import { session } from "./support/trajectory";

const call = (override: Partial<TraceLlmRecord> = {}): TraceLlmRecord => ({ kind: "llm", seq: 2, start: 1000, sentAt: 1100, firstTokenAt: 1500, end: 2500,
	input: 20, output: 100, cacheRead: 200, cacheWrite: 0, cost: 0.01, stopReason: "stop", ...override });

describe("measured model performance", () => {
	it("uses request-to-first-token for TTFT and the following stream for output throughput", () => {
		expect(callPerformance(call())).toEqual({ ttftMs: 400, streamingMs: 1000, tokensPerSecond: 100 });
		expect(callPerformance(call({ sentAt: undefined }))).toMatchObject({ ttftMs: 500 });
	});
	it("weights throughput by streaming time and excludes old calls without first-token timing", () => {
		const result = sessionPerformance([call(), call({ firstTokenAt: 1300, end: 4300, output: 150 }), call({ firstTokenAt: undefined, output: 999999 })]);
		expect(result).toEqual({ ttftMs: 300, tokensPerSecond: 62.5, ttftCalls: 2, rateCalls: 2 });
	});
	it("leaves missing, invalid, failed and zero-length streams out of the throughput", () => {
		for (const record of [call({ firstTokenAt: undefined }), call({ firstTokenAt: Infinity }), call({ firstTokenAt: 1000 }), call({ end: 1400 })]) expect(callPerformance(record)).toEqual({});
		for (const record of [call({ end: 1500 }), call({ end: undefined }), call({ output: 0 }), call({ stopReason: "error" }), call({ stopReason: "aborted" }), call({ error: "failed" })]) expect(callPerformance(record).tokensPerSecond).toBeUndefined();
		expect(sessionPerformance([call({ firstTokenAt: undefined })])).toEqual({ ttftMs: undefined, tokensPerSecond: undefined, ttftCalls: 0, rateCalls: 0 });
	});
	it("shows session performance and measurement coverage in the existing KPI strip", () => {
		renderWithApi(<KpiStrip session={summary("s1")} trace={{ sessionId: "s1", turns: [], records: [call(), call({ firstTokenAt: undefined })], children: [] }} />, async () => Response.json({}));
		const metric = document.querySelector('[data-kpi="performance"]')!;
		expect(metric.textContent).toContain("100 tok/s");
		expect(metric.textContent).toContain("avg TTFT 400ms");
		expect(metric.textContent).toContain("1/2 timed");
		expect(metric.getAttribute("title")).toContain("tool and idle time are excluded");
	});
	it("shows the same per-call performance in the ledger without loading raw entries", async () => {
		const restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
		try {
			const source = session();
			const server = createFakeServer({ sessions: [source] });
			const trace = traceOf(source);
			const first = trace.records.find(record => record.kind === "llm")!;
			Object.assign(first, call({ seq: first.seq, turn: first.turn }));
			const fetchImpl: typeof fetch = (input, init) => String(input).endsWith("/trace") ? Promise.resolve(Response.json(trace)) : server.fetch(input, init);
			renderApp("/s/t1", fetchImpl);
			await waitFor(() => expect(document.querySelector('[data-call-performance]')?.textContent).toContain("400ms · 100/s"));
			expect(screen.getAllByText("Performance", { selector: "span" })).toHaveLength(2);
			expect(server.calls.some(path => path.includes("/entries"))).toBe(false);
		} finally { restore(); }
	});
});
