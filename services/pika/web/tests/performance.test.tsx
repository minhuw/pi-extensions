import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TraceLlmRecord } from "../src/lib/types";
import { KpiStrip } from "../src/trace/Header";
import { callPerformance, sessionPerformance } from "../src/trace/performance";
import { summary } from "./support/fixtures";
import { firstRender, mockLayout, renderApp, renderWithApi } from "./support/render";
import { createFakeServer, traceOf } from "./support/server";
import { session } from "./support/trajectory";

const call = (override: Partial<TraceLlmRecord> = {}): TraceLlmRecord => ({ kind: "llm", seq: 2, start: 1000, sentAt: 1100, firstTokenAt: 1500, end: 2500,
	input: 20, output: 100, cacheRead: 200, cacheWrite: 0, cost: 0.01, stopReason: "stop", ...override });

describe("measured model performance", () => {
	it("uses request-to-first-token for TTFT and the whole call for the output rate", () => {
		expect(callPerformance(call())).toEqual({ ttftMs: 400, elapsedMs: 1400, tokensPerSecond: 100 * 1000 / 1400 });
		expect(callPerformance(call({ sentAt: undefined }))).toEqual({ ttftMs: 500, elapsedMs: 1500, tokensPerSecond: 100 * 1000 / 1500 });
	});
	it("does not read a burst after a long wait, or hidden reasoning, as a fast stream", () => {
		// 1,440 tokens 4 ms after a first token that took 24 s: 60 tok/s, not the 360,000 the time after the first token gave.
		expect(callPerformance(call({ sentAt: 1000, firstTokenAt: 24_996, end: 25_000, output: 1440 })).tokensPerSecond).toBe(60);
		// 48 s of hidden reasoning counted in the output, then a one-second answer: 50 tok/s, not 2,450.
		expect(callPerformance(call({ sentAt: 1000, firstTokenAt: 49_000, end: 50_000, output: 2450, firstToken: "text" })).tokensPerSecond).toBe(50);
	});
	it("weights the rate by call time and keeps TTFT to calls with first-token timing", () => {
		const result = sessionPerformance([call(), call({ firstTokenAt: 1300, end: 4300, output: 150 }), call({ sentAt: undefined, firstTokenAt: undefined, end: 4300, output: 50 })]);
		expect(result).toEqual({ ttftMs: 300, tokensPerSecond: 300 * 1000 / 7900, ttftCalls: 2, rateCalls: 3 });
	});
	it("leaves invalid timing out of TTFT and failed, empty, or unordered calls out of the rate", () => {
		for (const record of [call({ firstTokenAt: undefined }), call({ firstTokenAt: Infinity }), call({ firstTokenAt: 1000 }), call({ end: 1400 })]) expect(callPerformance(record).ttftMs).toBeUndefined();
		for (const record of [call({ end: 1100 }), call({ end: undefined }), call({ output: 0 }), call({ stopReason: "error" }), call({ stopReason: "aborted" }), call({ error: "failed" }), call({ sentAt: undefined, start: undefined })]) expect(callPerformance(record).tokensPerSecond).toBeUndefined();
		expect(sessionPerformance([call({ firstTokenAt: undefined, end: undefined })])).toEqual({ ttftMs: undefined, tokensPerSecond: undefined, ttftCalls: 0, rateCalls: 0 });
	});
	it("shows session performance and measurement coverage in the existing KPI strip", () => {
		renderWithApi(<KpiStrip session={summary("s1")} trace={{ sessionId: "s1", turns: [], records: [call(), call({ firstTokenAt: undefined })], children: [] }} />, async () => Response.json({}));
		const metric = document.querySelector('[data-kpi="performance"]')!;
		expect(metric.textContent).toContain("71.4 tok/s");
		expect(metric.textContent).toContain("avg TTFT 400ms");
		expect(metric.textContent).toContain("1/2 timed");
		expect(metric.getAttribute("title")).toContain("from each request to its last token");
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
			await waitFor(() => expect(document.querySelector('[data-call-performance]')?.textContent).toContain("400ms · 71.4/s"), firstRender);
			expect(screen.getAllByText("Performance", { selector: "span" })).toHaveLength(2);
			expect(server.calls.some(path => path.includes("/entries"))).toBe(false);
		} finally { restore(); }
	});
});
