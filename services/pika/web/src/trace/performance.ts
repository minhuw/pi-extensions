import type { TraceLlmRecord, TraceRecord } from "../lib/types";

export interface CallPerformance {
	ttftMs?: number;
	streamingMs?: number;
	tokensPerSecond?: number;
}
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/** Actual captured first-token timing only; wall-clock call duration is not a substitute for decoding time. */
export function callPerformance(record: TraceLlmRecord): CallPerformance {
	const first = record.firstTokenAt;
	if (!finite(first)) return {};
	const request = record.sentAt ?? record.start;
	const end = record.end;
	if ((finite(request) && first < request) || (finite(end) && end < first)) return {};
	const ttftMs = finite(request) ? first - request : undefined;
	const streamingMs = finite(end) && end > first && !record.error && record.stopReason !== "error" && record.stopReason !== "aborted" && Number.isFinite(record.output) && record.output > 0 ? end - first : undefined;
	return { ttftMs, streamingMs, tokensPerSecond: streamingMs !== undefined ? record.output * 1000 / streamingMs : undefined };
}

/** Arithmetic mean TTFT; throughput weighted by measured streaming time, not the mean of per-call rates. */
export function sessionPerformance(records: TraceRecord[]) {
	let ttft = 0, ttftCalls = 0, output = 0, streaming = 0, rateCalls = 0;
	for (const record of records) {
		if (record.kind !== "llm") continue;
		const timing = callPerformance(record);
		if (timing.ttftMs !== undefined) { ttft += timing.ttftMs; ttftCalls++; }
		if (timing.streamingMs !== undefined) { output += record.output; streaming += timing.streamingMs; rateCalls++; }
	}
	return { ttftMs: ttftCalls ? ttft / ttftCalls : undefined, tokensPerSecond: streaming ? output * 1000 / streaming : undefined, ttftCalls, rateCalls };
}

export function formatTokenRate(rate: number | undefined): string {
	return rate === undefined || !Number.isFinite(rate) ? "—" : rate >= 100 ? Math.round(rate).toLocaleString("en-US") : rate.toFixed(1);
}
