import type { SessionTrace, TraceRecord } from "../lib/types";
import { parseToolName } from "../session/tools/registry";
import type { Interval } from "./axis";
import { childSpan, FAMILIES, recordDuration, recordFamily, recordSpan, toolName, type Family } from "./kinds";
import { childrenOf } from "./rows";

/**
 * How a breakdown counts subagents: `one` counts each subagent as one Subagent stop, for as long as the call that ran
 * it took; `split` counts the subagents' own model and tool calls in their kinds instead, all the way down.
 */
export type SubagentMode = "one" | "split";

/** One line of a kind: a model by its id, a tool by its name, or a subagent by its type. */
export interface BreakdownItem {
	key: string;
	family: Family;
	kind: "model" | "tool" | "agent";
	/** The model's id, the tool's name, or the agent's type as recorded; empty for a model call that names no model. */
	name: string;
	/** For display: an MCP tool as `server · tool`. */
	label: string;
	count: number;
	ms: number;
}

export interface BreakdownFamily {
	family: Family;
	count: number;
	ms: number;
	/** By time, longest first. */
	items: BreakdownItem[];
}

export interface Breakdown {
	/** The kinds with any record, in the legend's order. */
	families: BreakdownFamily[];
	/**
	 * Time inside the counted sessions' turns when none of their model or tool calls ran: pi's own work, a subagent
	 * starting, waiting, and model calls whose time was not recorded.
	 */
	between: number;
	/** Model calls without a known duration; their time is part of `between`. */
	untimed: number;
	/** The kinds' time and `between`. */
	ms: number;
	count: number;
	/** Sessions whose records are counted: this one, plus every subagent counted in `split`. */
	sessions: number;
}

export interface BreakdownInput {
	trace: SessionTrace;
	mode: SubagentMode;
	/** Descendants' traces by session id, for `split`. A subagent whose trace is missing counts as a Subagent stop. */
	traces?: ReadonlyMap<string, SessionTrace>;
	/** For a live session: when calls still running stop counting. Otherwise they count up to their session's last entry. */
	now?: number;
	/**
	 * The time range selected on the strip map, in epoch ms: only what ran inside it counts, and a call that crosses an
	 * edge counts only its part inside. These are the calls the ledger lists for the range, and also a call still
	 * running from before it, which the ledger places at its start.
	 */
	window?: Interval;
}

/** How much of `ms` from `start` lies inside `window`; undefined when none of it does. Touching an edge counts, at 0 ms. */
function within(start: number | undefined, ms: number, window: Interval | undefined): number | undefined {
	if (!window) return ms;
	if (start === undefined || start + ms < window.start || start > window.end) return undefined;
	return Math.max(0, Math.min(start + ms, window.end) - Math.max(start, window.start));
}

/**
 * A record's time. A tool call still running counts up to `now`, or up to its session's last entry; a model call
 * without a known duration counts nothing.
 */
export function recordTime(trace: Pick<SessionTrace, "lastAt">, record: TraceRecord, now?: number): number {
	const known = recordDuration(record);
	if (known !== undefined) return known;
	if (record.kind !== "tool") return 0;
	const { start } = recordSpan(record);
	const end = Math.max(trace.lastAt ?? Number.NEGATIVE_INFINITY, now ?? Number.NEGATIVE_INFINITY);
	return start !== undefined && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/**
 * Time inside a session's turns, and inside `window` when given, when none of its model or tool calls ran. Calls
 * running at the same time cover the time once; a subagent's call covers the subagent's whole run.
 */
export function betweenCalls(trace: SessionTrace, now?: number, window?: Interval): number {
	const calls: [number, number][] = [];
	for (const record of trace.records) {
		if (record.kind !== "llm" && record.kind !== "tool") continue;
		const { start } = recordSpan(record);
		const ms = recordTime(trace, record, now);
		if (start !== undefined && ms > 0) calls.push([start, start + ms]);
	}
	calls.sort((a, b) => a[0] - b[0]);
	const covered: [number, number][] = [];
	for (const [start, end] of calls) {
		const last = covered[covered.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else covered.push([start, end]);
	}
	let gap = 0;
	for (const turn of trace.turns) {
		if (turn.at === undefined || !(turn.durationMs > 0)) continue;
		const from = Math.max(turn.at, window?.start ?? Number.NEGATIVE_INFINITY);
		const to = Math.min(turn.at + turn.durationMs, window?.end ?? Number.POSITIVE_INFINITY);
		if (to <= from) continue;
		let busy = 0;
		for (const [start, end] of covered) busy += Math.max(0, Math.min(end, to) - Math.max(start, from));
		gap += to - from - busy;
	}
	return gap;
}

/**
 * Where a session's time went, by kind of record and within each kind by model, tool, or agent type. Records that ran
 * at the same time, such as parallel tool calls or subagents, each count in full, so the total can exceed the
 * session's length.
 */
export function buildBreakdown({ trace, mode, traces, now, window }: BreakdownInput): Breakdown {
	const items = new Map<string, BreakdownItem>();
	const counted = new Set<string>();
	const add = (family: Family, kind: BreakdownItem["kind"], name: string, ms: number) => {
		const key = `${family}:${kind}:${name}`;
		const item = items.get(key);
		if (item) {
			item.count++;
			item.ms += ms;
			return;
		}
		const parsed = kind === "tool" ? parseToolName(name) : undefined;
		const label = parsed?.server ? `${parsed.server} · ${parsed.base}` : name;
		items.set(key, { key, family, kind, name, label, count: 1, ms });
	};
	const loaded = (id: string) => (mode === "split" && !counted.has(id) ? traces?.get(id) : undefined);
	let between = 0;
	let untimed = 0;

	const visit = (session: SessionTrace) => {
		counted.add(session.sessionId);
		between += betweenCalls(session, now, window);
		// The subagents whose own records stand in for their time, and every subagent a call ran.
		const expand: SessionTrace[] = [];
		const ranByCall = new Set<string>();
		for (const record of session.records) {
			if (record.kind !== "llm" && record.kind !== "tool") continue;
			const children = record.kind === "tool" ? childrenOf(session, record) : [];
			for (const child of children) ranByCall.add(child.sessionId);
			const time = within(recordSpan(record).start, recordTime(session, record, now), window);
			if (time === undefined) continue;
			if (record.kind === "llm") {
				if (recordDuration(record) === undefined) untimed++;
				add("llm", "model", record.model ?? "", time);
				continue;
			}
			// A subagent runs within its call, so its own records are clipped to the window as the call would be.
			const childTraces = children.map((child) => loaded(child.sessionId));
			if (children.length && childTraces.every((child): child is SessionTrace => child !== undefined)) {
				expand.push(...childTraces);
				continue;
			}
			// A call that ran one subagent is named by the subagent's type, as the ledger names it; a workflow by its tool.
			const type = children.length === 1 ? children[0].agentType : undefined;
			if (type) add("agent", "agent", type, time);
			else add(children.length ? "agent" : recordFamily(record), "tool", toolName(record), time);
		}
		// Subagents no call ran, such as Herder steps launched in the background, count for as long as they ran.
		for (const child of session.children) {
			if (ranByCall.has(child.sessionId) || counted.has(child.sessionId)) continue;
			const { start, end } = childSpan(session, child);
			const time = within(start, start !== undefined && end !== undefined ? Math.max(0, end - start) : 0, window);
			if (time === undefined) continue;
			const own = loaded(child.sessionId);
			if (own) {
				expand.push(own);
				continue;
			}
			const name = child.kind === "herder-step" ? "Herder step" : child.agentType || "subagent";
			add("agent", "agent", name, time);
		}
		for (const child of expand) if (!counted.has(child.sessionId)) visit(child);
	};
	visit(trace);

	const families: BreakdownFamily[] = [];
	for (const family of FAMILIES) {
		const list = [...items.values()].filter((item) => item.family === family).sort((a, b) => b.ms - a.ms || b.count - a.count);
		if (!list.length) continue;
		families.push({ family, items: list, count: list.reduce((sum, item) => sum + item.count, 0), ms: list.reduce((sum, item) => sum + item.ms, 0) });
	}
	return {
		families,
		between,
		untimed,
		ms: families.reduce((sum, family) => sum + family.ms, between),
		count: families.reduce((sum, family) => sum + family.count, 0),
		sessions: counted.size,
	};
}
