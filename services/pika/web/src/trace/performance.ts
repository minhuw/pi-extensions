import type { TraceLlmRecord, TraceRecord } from "../lib/types";

export interface CallPerformance {
	ttftMs?: number;
	/** The whole call, from the request to the last token: the time the rate is measured over. */
	elapsedMs?: number;
	tokensPerSecond?: number;
}
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/**
 * TTFT from captured first-token timing only. The output rate spans the whole call, from the request (the captured
 * send time, else the call's start) to the last token: many responses arrive in one burst once the model has finished,
 * and hidden reasoning counts in `output` but streams nothing, so the time after the first token says nothing about
 * how fast the output was written.
 */
export function callPerformance(record: TraceLlmRecord): CallPerformance {
	const request = record.sentAt ?? record.start;
	const first = record.firstTokenAt;
	const end = record.end;
	const ttftMs = finite(first) && finite(request) && first >= request && !(finite(end) && end < first) ? first - request : undefined;
	const measurable = finite(request) && finite(end) && end > request && !record.error && record.stopReason !== "error" && record.stopReason !== "aborted" && Number.isFinite(record.output) && record.output > 0;
	if (!measurable) return { ttftMs };
	const elapsedMs = end - request;
	return { ttftMs, elapsedMs, tokensPerSecond: (record.output * 1000) / elapsedMs };
}

/** Arithmetic mean TTFT; the rate is total output over total call time, not the mean of per-call rates. */
export function sessionPerformance(records: TraceRecord[]) {
	let ttft = 0, ttftCalls = 0, output = 0, elapsed = 0, rateCalls = 0;
	for (const record of records) {
		if (record.kind !== "llm") continue;
		const timing = callPerformance(record);
		if (timing.ttftMs !== undefined) { ttft += timing.ttftMs; ttftCalls++; }
		if (timing.elapsedMs !== undefined) { output += record.output; elapsed += timing.elapsedMs; rateCalls++; }
	}
	return { ttftMs: ttftCalls ? ttft / ttftCalls : undefined, tokensPerSecond: elapsed ? output * 1000 / elapsed : undefined, ttftCalls, rateCalls };
}

export function formatTokenRate(rate: number | undefined): string {
	return rate === undefined || !Number.isFinite(rate) ? "—" : rate >= 100 ? Math.round(rate).toLocaleString("en-US") : rate.toFixed(1);
}
