// The ledger's rows: one per record, grouped under turn headers, with subagents expanded inline.
import type { SessionTrace, TraceChild, TraceRecord, TraceToolRecord, TraceTurn } from "../lib/types";
import type { Interval } from "./axis";
import {
	isSubagentTool,
	recordBadge,
	recordFamily,
	recordIsError,
	recordKey,
	recordName,
	recordSpan,
	recordSummary,
	toolName,
	type Family,
} from "./kinds";

/** Nesting stops here, as for inline sessions in the transcript. */
export const MAX_DEPTH = 8;
/** Sessions with more turns start with only the last few expanded. */
export const EXPAND_ALL_TURNS = 40;
export const EXPAND_LAST_TURNS = 3;

export interface LedgerFilter {
	text: string;
	/** Empty means every family. */
	families: Family[];
	errorsOnly: boolean;
}

export const NO_FILTER: LedgerFilter = { text: "", families: [], errorsOnly: false };

export function filterActive(filter: LedgerFilter | undefined): boolean {
	return Boolean(filter && (filter.text.trim() || filter.families.length || filter.errorsOnly));
}

export type LedgerRow =
	| { type: "turn"; key: string; turn: TraceTurn; expanded: boolean; records: number; window?: Interval }
	| {
			type: "record";
			key: string;
			record: TraceRecord;
			sessionId: string;
			depth: number;
			turnIndex?: number;
			/** The time range the mini waterfall bar is drawn against. */
			window?: Interval;
			/** Child sessions a subagent call spawned. */
			children: TraceChild[];
			expanded: boolean;
			/** For model calls: the tools they called, by name. */
			calls?: string[];
	  }
	| { type: "child"; key: string; child: TraceChild; parentSessionId: string; depth: number; expanded: boolean }
	| { type: "status"; key: string; depth: number; status: "loading" | "error" | "empty" | "deep"; sessionId: string; error?: unknown };

export interface ChildTraceState {
	data?: SessionTrace;
	status: "pending" | "error" | "success";
	error?: unknown;
}

export interface LedgerInput {
	trace: SessionTrace;
	/** Turn expansion the user chose; turns without one follow `defaultTurnExpanded`. */
	turnOverrides: ReadonlyMap<number, boolean>;
	/** Expanded subagent rows, by row key. */
	expanded: ReadonlySet<string>;
	childTrace: (sessionId: string) => ChildTraceState | undefined;
	filter?: LedgerFilter;
	range?: Interval;
	/** Sessions from the page's session down, to stop cycles. */
	ancestors?: string[];
}

export function defaultTurnExpanded(index: number, turnCount: number, lastIndex = turnCount - 1): boolean {
	return turnCount <= EXPAND_ALL_TURNS || index > lastIndex - EXPAND_LAST_TURNS;
}

export function turnExpanded(trace: SessionTrace, overrides: ReadonlyMap<number, boolean>, index: number): boolean {
	const override = overrides.get(index);
	if (override !== undefined) return override;
	const last = trace.turns[trace.turns.length - 1]?.index ?? 0;
	return defaultTurnExpanded(index, trace.turns.length, last);
}

/** Lowercased text a filter matches against. */
export function recordHaystack(record: TraceRecord): string {
	const parts = [recordBadge(record), recordName(record), recordSummary(record), record.kind];
	if (record.kind === "tool") parts.push(toolName(record));
	if (record.kind === "llm") parts.push(record.provider ?? "", record.stopReason ?? "");
	return parts.join(" ").toLowerCase();
}

export function matchesFilter(record: TraceRecord, filter: LedgerFilter | undefined, range?: Interval): boolean {
	if (range) {
		const { start, end } = recordSpan(record);
		if (start === undefined) return false;
		if ((end ?? start) < range.start || start > range.end) return false;
	}
	if (!filter) return true;
	if (filter.errorsOnly && !recordIsError(record)) return false;
	if (filter.families.length && !filter.families.includes(recordFamily(record))) return false;
	const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length) {
		const haystack = recordHaystack(record);
		if (!words.every((word) => haystack.includes(word))) return false;
	}
	return true;
}

/** Tool names by the seq of the model call that made them. */
function callNames(trace: SessionTrace): Map<number, string[]> {
	const map = new Map<number, string[]>();
	for (const record of trace.records) {
		if (record.kind !== "tool") continue;
		const name = toolName(record).replace(/^mcp__.+?__/, "");
		const list = map.get(record.seq);
		if (list) list.push(name);
		else map.set(record.seq, [name]);
	}
	return map;
}

/** The child sessions a tool call spawned: by the children's parent tool call, or the record's own link. */
export function childrenOf(trace: SessionTrace, record: TraceToolRecord): TraceChild[] {
	const children = trace.children.filter((child) => child.parentToolCallId === record.callId);
	if (record.childSessionId && !children.some((child) => child.sessionId === record.childSessionId)) {
		// Not listed yet: the call names it before the child has a summary. Its times stay unknown.
		children.unshift({
			sessionId: record.childSessionId,
			parentToolCallId: record.callId,
			kind: "subagent",
			entryCount: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
			title: "",
		});
	}
	// By start; children without one, just spawned, last.
	return children.sort((a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY));
}

/** A session's span for mini waterfall bars, if its start is known. */
function sessionWindow(trace: SessionTrace): Interval | undefined {
	if (trace.startedAt === undefined) return undefined;
	return { start: trace.startedAt, end: Math.max(trace.lastAt ?? trace.startedAt, trace.startedAt + 1) };
}

function turnWindow(turn: TraceTurn, records: TraceRecord[]): Interval | undefined {
	let start = turn.at ?? Number.POSITIVE_INFINITY;
	let end = turn.at !== undefined ? turn.at + Math.max(0, turn.durationMs || 0) : Number.NEGATIVE_INFINITY;
	for (const record of records) {
		const span = recordSpan(record);
		if (span.start !== undefined) start = Math.min(start, span.start);
		const last = span.end ?? span.start;
		if (last !== undefined) end = Math.max(end, last);
	}
	if (!Number.isFinite(start)) return undefined;
	return { start, end: Math.max(end, start + 1) };
}

function recordsByTurn(trace: SessionTrace): { loose: TraceRecord[]; byTurn: Map<number, TraceRecord[]> } {
	const byTurn = new Map<number, TraceRecord[]>();
	const loose: TraceRecord[] = [];
	const turnIndexes = new Set(trace.turns.map((turn) => turn.index));
	for (const record of trace.records) {
		const index = record.turn ?? trace.turns.find((turn) => turn.startSeq <= record.seq && record.seq <= turn.endSeq)?.index;
		if (index === undefined || !turnIndexes.has(index)) {
			loose.push(record);
			continue;
		}
		const list = byTurn.get(index);
		if (list) list.push(record);
		else byTurn.set(index, [record]);
	}
	return { loose, byTurn };
}

/** Builds the ledger's rows; pure, so selection, filtering, and expansion are cheap to test. */
export function buildLedger(input: LedgerInput): LedgerRow[] {
	const { trace, expanded } = input;
	const ancestors = input.ancestors ?? [trace.sessionId];
	const filtering = filterActive(input.filter) || input.range !== undefined;
	const rows: LedgerRow[] = [];
	const { loose, byTurn } = recordsByTurn(trace);

	const calls = callNames(trace);
	const pushRecords = (records: TraceRecord[], window: Interval | undefined, turnIndex: number | undefined) => {
		for (const record of records) {
			const key = recordKey(trace.sessionId, record);
			const children = isSubagentTool(record) ? childrenOf(trace, record) : [];
			const open = children.length > 0 && expanded.has(key);
			rows.push({ type: "record", key, record, sessionId: trace.sessionId, depth: 0, turnIndex, window, children, expanded: open, calls: record.kind === "llm" ? calls.get(record.seq) : undefined });
			if (open) pushChildren(rows, key, children, 1, input, ancestors);
		}
	};

	const looseShown = filtering ? loose.filter((record) => matchesFilter(record, input.filter, input.range)) : loose;
	if (looseShown.length) pushRecords(looseShown, sessionWindow(trace), undefined);

	for (const turn of trace.turns) {
		const all = byTurn.get(turn.index) ?? [];
		const shown = filtering ? all.filter((record) => matchesFilter(record, input.filter, input.range)) : all;
		if (filtering && shown.length === 0) continue;
		// A filter shows its matches even in collapsed turns.
		const open = filtering || turnExpanded(trace, input.turnOverrides, turn.index);
		const window = turnWindow(turn, all);
		rows.push({ type: "turn", key: `turn:${trace.sessionId}:${turn.index}`, turn, expanded: open, records: shown.length, window });
		if (open) pushRecords(shown, window, turn.index);
	}
	return rows;
}

function pushChildren(rows: LedgerRow[], parentKey: string, children: TraceChild[], depth: number, input: LedgerInput, ancestors: string[]) {
	if (children.length === 1) {
		pushChildRecords(rows, parentKey, children[0], depth, input, ancestors);
		return;
	}
	for (const child of children) {
		const key = `${parentKey}>${child.sessionId}`;
		const open = input.expanded.has(key);
		rows.push({ type: "child", key, child, parentSessionId: ancestors[ancestors.length - 1], depth, expanded: open });
		if (open) pushChildRecords(rows, key, child, depth + 1, input, ancestors);
	}
}

function pushChildRecords(rows: LedgerRow[], parentKey: string, child: TraceChild, depth: number, input: LedgerInput, ancestors: string[]) {
	const statusKey = `${parentKey}>status`;
	if (ancestors.includes(child.sessionId) || ancestors.length >= MAX_DEPTH) {
		rows.push({ type: "status", key: statusKey, depth, status: "deep", sessionId: child.sessionId });
		return;
	}
	const state = input.childTrace(child.sessionId);
	if (!state || state.status === "pending") {
		rows.push({ type: "status", key: statusKey, depth, status: "loading", sessionId: child.sessionId });
		return;
	}
	if (state.status === "error" || !state.data) {
		rows.push({ type: "status", key: statusKey, depth, status: "error", sessionId: child.sessionId, error: state.error });
		return;
	}
	const trace = state.data;
	if (trace.records.length === 0) {
		rows.push({ type: "status", key: statusKey, depth, status: "empty", sessionId: child.sessionId });
		return;
	}
	const window = sessionWindow(trace);
	const nested = [...ancestors, child.sessionId];
	const calls = callNames(trace);
	for (const record of trace.records) {
		const key = `${parentKey}>${recordKey(trace.sessionId, record)}`;
		const grandchildren = isSubagentTool(record) ? childrenOf(trace, record) : [];
		const open = grandchildren.length > 0 && input.expanded.has(key);
		rows.push({
			type: "record",
			key,
			record,
			sessionId: trace.sessionId,
			depth,
			window,
			children: grandchildren,
			expanded: open,
			turnIndex: record.turn,
			calls: record.kind === "llm" ? calls.get(record.seq) : undefined,
		});
		if (open) pushChildren(rows, key, grandchildren, depth + 1, input, nested);
	}
}

/** The row to select for a deep-linked seq: its model call, the tool whose result it is, or the nearest record before it. */
export function rowForSeq(rows: LedgerRow[], seq: number): number {
	let exact = -1;
	let result = -1;
	let nearest = -1;
	rows.forEach((row, index) => {
		if (row.type !== "record" || row.depth !== 0) return;
		const { record } = row;
		if (record.seq === seq && exact < 0) exact = index;
		if (record.kind === "tool" && record.resultSeq === seq && result < 0) result = index;
		if (record.seq <= seq) nearest = index;
	});
	if (exact >= 0) return exact;
	if (result >= 0) return result;
	// A prompt's seq selects its turn's header.
	const turn = rows.findIndex((row) => row.type === "turn" && row.turn.startSeq === seq);
	return turn >= 0 ? turn : nearest;
}

/** The turn holding `seq`, if any. */
export function turnForSeq(trace: SessionTrace, seq: number): TraceTurn | undefined {
	return trace.turns.find((turn) => turn.startSeq <= seq && seq <= turn.endSeq);
}

export function isSelectable(row: LedgerRow | undefined): boolean {
	return row?.type === "record" || row?.type === "child";
}
