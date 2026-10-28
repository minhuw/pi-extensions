import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PikaLink as Link } from "../components/PikaLink";
import { Icon } from "../components/icons";
import { cx, Skeleton } from "../components/ui";
import { formatCount, plural } from "../lib/format";
import type { TraceChild, TraceRecord, TraceTurn } from "../lib/types";
import type { Interval } from "./axis";
import { useLoadedEntry } from "./data";
import { LedgerHelp } from "./Help";
import { formatBytes, formatClockTime, formatElapsed, formatFineCost, formatInstant, formatSpan, plainLine, spanBetween } from "./format";
import {
	cacheHit,
	FAMILIES,
	FAMILY_CLASSES,
	FAMILY_LABELS,
	recordDuration,
	recordFamily,
	recordIcon,
	recordIsError,
	recordName,
	recordSpan,
	recordSummary,
	showsToolName,
	summaryIsPath,
	toolFamily,
	toolName,
	turnStart,
	urlHost,
	type Family,
} from "./kinds";
import { filterActive, type LedgerFilter, type LedgerRow } from "./rows";
import { callIn, Chip, diffStatOf, DiffStat, KindBadge, PathChip, Ring, RunningDot, WaterfallBar } from "./parts";

export const ROW_HEIGHT = 28;

/** A row's element id, for `aria-activedescendant`; keys hold `:` and `>`, which ids allow. */
export function ledgerRowId(key: string): string {
	return `ledger-${key}`;
}
export const TURN_ROW_HEIGHT = 34;
const COLUMN_HEADER = 28;
const INDENT = 14;

const FAMILY_SHORT: Record<Family, string> = {
	user: "Prompt",
	llm: "LLM",
	shell: "Shell",
	read: "Read",
	write: "Write",
	other: "Other",
	agent: "Agents",
	compaction: "Compaction",
};

interface Columns {
	template: string;
	waterfall: boolean;
	tokens: boolean;
	cost: boolean;
}

function columnsFor(width: number): Columns {
	const waterfall = width >= 620;
	const tokens = width >= 520;
	const cost = width >= 580;
	const parts = ["62px", "46px", "minmax(0,1fr)"];
	if (waterfall) parts.push(width >= 1000 ? "150px" : width >= 820 ? "108px" : "84px");
	// Room for a turn's `24m 59s`.
	parts.push("56px");
	if (tokens) parts.push("86px");
	if (cost) parts.push("50px");
	parts.push("74px");
	return { template: parts.join(" "), waterfall, tokens, cost };
}

function Num({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
	return (
		<span className={cx("mono tnum truncate text-right text-[11.5px]", className)} title={title}>
			{children}
		</span>
	);
}

function Chevron({ open, onClick, label }: { open: boolean; onClick?: () => void; label: string }) {
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={label}
			aria-expanded={open}
			// Not focusable, and clicking it leaves focus where it was, so the ledger's keys keep working.
			onMouseDown={(event) => event.preventDefault()}
			onClick={(event) => {
				event.stopPropagation();
				onClick?.();
			}}
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-ink"
		>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={cx("transition-transform duration-150", open && "rotate-90")}>
				<path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}

function SummaryText({ record, calls }: { record: TraceRecord; calls?: string[] }) {
	const text = recordSummary(record);
	if (!text) return null;
	if (record.kind === "tool") {
		const family = toolFamily(toolName(record));
		if (summaryIsPath(record)) return <PathChip path={text} className="min-w-0" />;
		if (family === "shell") {
			return (
				<span className="mono min-w-0 truncate text-[12px] text-ink/80" title={text}>
					<span className="text-muted select-none">$ </span>
					{text}
				</span>
			);
		}
		const host = urlHost(text);
		if (host) {
			const rest = text.replace(/^https?:\/\/[^/]+/, "");
			return (
				<span className="mono min-w-0 truncate text-[12px]" title={text}>
					<span className="text-ink/80">{host}</span>
					<span className="text-muted">{rest}</span>
				</span>
			);
		}
		if (family === "read") {
			return (
				<span className="mono min-w-0 truncate text-[12px] text-ink/80" title={text}>
					{text}
				</span>
			);
		}
	}
	if (record.kind === "llm" && !record.text && !record.error && calls?.length) {
		return (
			<span className="min-w-0 truncate text-muted" title={calls.join(", ")}>
				<span className="select-none">→ </span>
				<span className="mono text-[12px]">{calls.join(" · ")}</span>
			</span>
		);
	}
	if (record.kind === "llm" && record.error) {
		return (
			<span className="min-w-0 truncate text-red" title={text}>
				{text}
			</span>
		);
	}
	return (
		<span className={cx("min-w-0 truncate", record.kind === "llm" && record.text ? "text-ink/85" : "text-muted")} title={text}>
			{text}
		</span>
	);
}

function Status({ record, sessionId, running }: { record: TraceRecord; sessionId: string; running: boolean }) {
	const family = record.kind === "tool" ? toolFamily(toolName(record)) : undefined;
	const failed = record.kind === "tool" && record.isError;
	// Decorations from entries the inspector already loaded: an edit's diffstat, a failed command's exit code.
	const callEntry = useLoadedEntry(sessionId, family === "write" && !failed ? record.seq : undefined);
	const resultEntry = useLoadedEntry(sessionId, family === "shell" && failed && record.kind === "tool" ? record.resultSeq : undefined);
	if (record.kind === "llm") {
		// Only the unusual endings; a normal stop or tool use says nothing.
		if (record.stopReason === "aborted") return <Chip tone="red">aborted</Chip>;
		if (recordIsError(record)) return <Chip tone="red">error</Chip>;
		if (record.stopReason === "length") return <Chip tone="muted">length</Chip>;
		return null;
	}
	if (record.kind !== "tool") return null;
	if (record.resultSeq === undefined && record.end === undefined) {
		return running ? (
			<span className="inline-flex items-center gap-1.5 text-[11px] text-accent">
				<RunningDot />
				running
			</span>
		) : (
			<Chip tone="muted">no result</Chip>
		);
	}
	if (family === "write" && !record.isError) {
		const call = callIn(callEntry, record.callId);
		const stat = call ? diffStatOf(call) : undefined;
		if (stat) return <DiffStat value={stat} />;
	}
	if (family === "shell") {
		if (!record.isError) return <Chip tone="muted">exit 0</Chip>;
		const text = JSON.stringify(resultEntry?.raw.message ?? "");
		const code = /Command exited with code (-?\d+)/.exec(text)?.[1];
		return <Chip tone="red">{code !== undefined ? `exit ${code}` : "failed"}</Chip>;
	}
	if (record.isError) return <Chip tone="red">error</Chip>;
	return null;
}

function Rails({ depth }: { depth: number }) {
	if (depth <= 0) return null;
	return (
		<>
			{Array.from({ length: depth }, (_, i) => (
				<span key={i} aria-hidden="true" className="absolute top-0 bottom-0 w-[2px] rounded-full bg-k-agent/45" style={{ left: 3 + i * INDENT }} />
			))}
		</>
	);
}

/** A row's state, as primitives so that memoized rows re-render only when their own state changes. */
interface RowState {
	selected: boolean;
	hovered: boolean;
	highlighted: boolean;
	replaying: boolean;
	fresh: boolean;
}

const rowBase = "group relative grid h-full items-center gap-x-1.5 pr-3 text-[12.5px] leading-none";

function rowTone(state: RowState): string {
	if (state.highlighted) return "bg-yellow-soft";
	// The replay's current record looks selected without being the selection.
	if (state.selected || state.replaying) return "bg-accent-soft";
	if (state.hovered) return "bg-hover";
	return "hover:bg-hover";
}

const RecordRow = memo(function RecordRow({
	row,
	columns,
	live,
	primaryModel,
	onToggle,
	...state
}: RowState & {
	row: Extract<LedgerRow, { type: "record" }>;
	columns: Columns;
	live: boolean;
	primaryModel?: string;
	onToggle: (key: string) => void;
}) {
	const { record, depth, window } = row;
	const family = recordFamily(record);
	const error = recordIsError(record);
	const { start } = recordSpan(record);
	const running = live && record.kind === "tool" && record.resultSeq === undefined && record.end === undefined;
	const hit = cacheHit(record);
	const subagent = row.children.length > 0;
	const firstChild: TraceChild | undefined = row.children[0];
	return (
		<div
			className={cx(rowBase, rowTone(state), state.fresh && "row-in")}
			style={{ gridTemplateColumns: columns.template }}
			data-ledger-row=""
			data-kind={family}
			data-record={record.kind}
			data-seq={record.seq}
			data-entry-seq={record.seq}
			data-turn-index={row.turnIndex}
			data-depth={depth || undefined}
			data-error={error || undefined}
			data-selected={state.selected || undefined}
			data-highlighted={state.highlighted || undefined}
			data-replay-current={state.replaying || undefined}
			data-running={running || undefined}
			role="option"
			aria-selected={state.selected}
			id={ledgerRowId(row.key)}
		>
			{(state.selected || state.replaying) && <span aria-hidden="true" className={cx("absolute inset-y-0 left-0 w-[2px]", error ? "bg-k-error" : FAMILY_CLASSES[family].bar)} />}
			<Num className="pl-3 text-left text-muted">{window && start !== undefined ? formatElapsed(start - window.start) : ""}</Num>
			<KindBadge record={record} family={family} className={cx(error && "!bg-red-soft !text-red")} />
			<span className="relative flex h-full min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * INDENT }}>
				<Rails depth={depth} />
				{subagent ? (
					<Chevron open={row.expanded} onClick={() => onToggle(row.key)} label={row.expanded ? "Collapse subagent" : "Expand subagent"} />
				) : (
					<Icon name={recordIcon(record)} size={14} className={cx("shrink-0", error ? "text-red" : FAMILY_CLASSES[family].text)} />
				)}
				{subagent && record.kind === "tool" && record.summary?.includes(":") ? (
					<>
						<span className="shrink-0 font-medium">{record.summary.split(":")[0]}</span>
						<span className="min-w-0 truncate text-muted">{record.summary.slice(record.summary.indexOf(":") + 1).trim()}</span>
					</>
				) : (
					<>
						{showsToolName(record) && <span className="max-w-[40%] shrink-0 truncate font-medium">{recordName(record)}</span>}
						{record.kind === "llm" && record.thinking && (
							<span title="Thought before answering" className="-mx-0.5 shrink-0 text-[10.5px] text-k-llm/70 italic">
								thinking
							</span>
						)}
						<SummaryText record={record} calls={row.calls} />
						{record.kind === "llm" && record.model && record.model !== primaryModel && (
							<span className="mono ml-auto shrink-0 truncate pl-1 text-[11px] text-muted">{record.model}</span>
						)}
					</>
				)}
				{subagent && row.children.length > 1 && <Chip tone="muted">{row.children.length} agents</Chip>}
				{subagent && firstChild && row.children.length === 1 && (
					<Link
						to={`/s/${encodeURIComponent(firstChild.sessionId)}`}
						onClick={(event) => event.stopPropagation()}
						className="ml-auto hidden shrink-0 items-center gap-1 rounded-sm px-1 text-[11.5px] text-muted group-hover:flex hover:bg-hover hover:text-ink"
						title="Open the subagent's session as a page"
					>
						<Icon name="external" size={12} />
						Open as page
					</Link>
				)}
			</span>
			{columns.waterfall && (
				<span className="h-full px-1">
					<WaterfallBar record={record} window={window} running={running} />
				</span>
			)}
			<Num className={cx(running ? "text-accent" : "text-ink/80")}>{running ? "…" : formatSpan(recordDuration(record)).replace("—", "")}</Num>
			{columns.tokens && (
				<span className="flex min-w-0 items-center justify-end gap-1.5">
					{record.kind === "llm" ? (
						<>
							<Num className="text-ink/80" title={`${formatCount(record.input)} input · ${formatCount(record.cacheRead)} cache read · ${formatCount(record.cacheWrite)} cache write → ${formatCount(record.output)} output`}>
								{formatCount(record.input + record.cacheRead + record.cacheWrite)}
								<span className="text-muted">→</span>
								{formatCount(record.output)}
							</Num>
							{hit !== undefined && <Ring value={hit} className="text-k-read" title={`Cache hit ${Math.round(hit * 100)}%`} />}
						</>
					) : record.kind === "tool" && record.outputSize !== undefined ? (
						<Num className="text-muted">{formatBytes(record.outputSize)}</Num>
					) : null}
				</span>
			)}
			{columns.cost && <Num className="text-muted">{record.kind === "llm" ? formatFineCost(record.cost) : ""}</Num>}
			<span className="flex min-w-0 justify-end">
				<Status record={record} sessionId={row.sessionId} running={running} />
			</span>
		</div>
	);
});

const ChildRow = memo(function ChildRow({
	row,
	columns,
	onToggle,
	...state
}: RowState & {
	row: Extract<LedgerRow, { type: "child" }>;
	columns: Columns;
	onToggle: (key: string) => void;
}) {
	const { child, depth } = row;
	const tokens = child.tokens.input + child.tokens.output + child.tokens.cacheRead + child.tokens.cacheWrite;
	return (
		<div
			className={cx(rowBase, rowTone(state))}
			style={{ gridTemplateColumns: columns.template }}
			data-ledger-row=""
			data-kind="agent"
			data-record="child"
			data-child={child.sessionId}
			data-depth={depth}
			data-selected={state.selected || undefined}
			role="option"
			aria-selected={state.selected}
			id={ledgerRowId(row.key)}
		>
			{state.selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-k-agent" />}
			<Num className="pl-3 text-left text-muted" title={formatInstant(child.startedAt)}>
				{formatClockTime(child.startedAt, false)}
			</Num>
			<KindBadge family="agent" label={child.kind === "herder-step" ? "STEP" : "AGENT"} />
			<span className="relative flex h-full min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * INDENT }}>
				<Rails depth={depth} />
				<Chevron open={row.expanded} onClick={() => onToggle(row.key)} label={row.expanded ? "Collapse subagent" : "Expand subagent"} />
				<span className="shrink-0 font-medium">{child.agentType ?? (child.kind === "herder-step" ? "step" : "subagent")}</span>
				<span className="min-w-0 truncate text-muted">{child.description ?? child.title}</span>
				<Link
					to={`/s/${encodeURIComponent(child.sessionId)}`}
					onClick={(event) => event.stopPropagation()}
					className="ml-auto hidden shrink-0 items-center gap-1 rounded-sm px-1 text-[11.5px] text-muted group-hover:flex hover:bg-hover hover:text-ink"
				>
					<Icon name="external" size={12} />
					Open as page
				</Link>
			</span>
			{columns.waterfall && <span />}
			<Num className="text-ink/80">{formatSpan(spanBetween(child.startedAt, child.lastAt))}</Num>
			{columns.tokens && <Num className="text-ink/80">{tokens ? formatCount(tokens) : ""}</Num>}
			{columns.cost && <Num className="text-muted">{formatFineCost(child.cost)}</Num>}
			<span className="flex justify-end">
				<Chip tone="muted">{formatCount(child.entryCount)} entries</Chip>
			</span>
		</div>
	);
});

const TurnRow = memo(function TurnRow({
	row,
	columns,
	selected,
	onToggle,
}: {
	row: Extract<LedgerRow, { type: "turn" }>;
	columns: Columns;
	selected: boolean;
	onToggle: (turn: TraceTurn) => void;
}) {
	const { turn } = row;
	const start = turnStart(turn);
	const tokens = turn.tokens.input + turn.tokens.output + turn.tokens.cacheRead + turn.tokens.cacheWrite;
	const firstLine = plainLine(turn.userText);
	return (
		<div
			className={cx(
				"relative grid h-full cursor-default items-center gap-x-2 border-y border-line bg-sidebar pr-3 text-[12.5px] leading-none",
				selected && "bg-accent-soft",
			)}
			style={{ gridTemplateColumns: columns.template }}
			data-turn={turn.index}
			data-turn-head=""
			role="option"
			aria-selected={selected}
			aria-label={`Turn ${turn.index + 1}${row.expanded ? "" : ", collapsed"}: ${firstLine || "empty prompt"}`}
			id={ledgerRowId(row.key)}
		>
			<span className="flex items-center gap-1 pl-2">
				<Chevron open={row.expanded} onClick={() => onToggle(turn)} label={row.expanded ? `Collapse turn ${turn.index + 1}` : `Expand turn ${turn.index + 1}`} />
				<span className="mono tnum text-[11.5px] font-semibold text-k-user">#{turn.index + 1}</span>
			</span>
			<span className="mono tnum truncate text-[11px] text-muted" title={formatInstant(turn.at)}>
				{formatClockTime(turn.at, false)}
			</span>
			{/* The prompt takes the waterfall's column too; the overview's Turns lane shows each turn's shape. */}
			<span className="flex min-w-0 items-center gap-1.5" style={columns.waterfall ? { gridColumn: "span 2" } : undefined}>
				<span title={turn.customType ?? start.label} className="shrink-0 text-k-user" data-turn-start={turn.customType ?? "prompt"}>
					<Icon name={start.icon} size={13} />
				</span>
				<span className="min-w-0 flex-1 truncate font-medium" title={turn.userText}>
					{firstLine || <span className="text-muted italic">(empty prompt)</span>}
				</span>
				<span
					className="mono tnum ml-2 flex shrink-0 items-center gap-2 text-[11px] text-muted"
					title={`${plural(turn.modelCalls, "model call")} · ${plural(turn.toolCalls, "tool call")}`}
					data-turn-counts=""
				>
					<span className="flex items-center gap-0.5">
						<Icon name="sparkle" size={11} className="text-k-llm" />
						{turn.modelCalls}
					</span>
					<span className="flex items-center gap-0.5">
						<Icon name="tool" size={11} />
						{turn.toolCalls}
					</span>
				</span>
			</span>
			<Num className="font-medium text-ink/90">{formatSpan(turn.durationMs)}</Num>
			{columns.tokens && <Num className="text-ink/80">{tokens ? formatCount(tokens) : ""}</Num>}
			{columns.cost && <Num className="text-ink/80">{formatFineCost(turn.cost)}</Num>}
			<span className="flex justify-end">{turn.toolErrors > 0 && <Chip tone="red">{turn.toolErrors} err</Chip>}</span>
		</div>
	);
});

function StatusRow({ row, columns }: { row: Extract<LedgerRow, { type: "status" }>; columns: Columns }) {
	return (
		<div className={rowBase} style={{ gridTemplateColumns: columns.template }} data-ledger-status={row.status}>
			<span />
			<span />
			<span className="relative flex h-full min-w-0 items-center gap-2 text-[12px] text-muted" style={{ paddingLeft: row.depth * INDENT }}>
				<Rails depth={row.depth} />
				{row.status === "loading" ? (
					<span className="flex w-full items-center gap-2" aria-busy="true" aria-label="Loading subagent">
						<Skeleton className="h-2.5 w-1/3" />
						<Skeleton className="h-2.5 w-1/5" />
					</span>
				) : row.status === "error" ? (
					<span className="text-red">Could not load this subagent’s records</span>
				) : row.status === "empty" ? (
					<span className="italic">No records yet</span>
				) : (
					<span className="italic">Nested too deeply</span>
				)}
			</span>
		</div>
	);
}

export interface LedgerHandle {
	scrollToKey: (key: string, align?: "auto" | "center" | "start") => void;
	focus: () => void;
}

export interface LedgerProps {
	rows: LedgerRow[];
	live: boolean;
	/** The session's own record count: the ledger follows the tail only when live data makes it grow. */
	recordCount: number;
	/** Rows of records that just arrived, which fade in; rows revealed by expanding or filtering do not. */
	freshKeys?: ReadonlySet<string>;
	/** Open at the last row instead of the first, as live sessions do. */
	startAtTail?: boolean;
	selectedKey?: string;
	hoveredKey?: string;
	highlightKey?: string;
	replayKey?: string;
	onSelect: (key: string) => void;
	onHover: (key: string | undefined) => void;
	onToggleTurn: (turn: TraceTurn) => void;
	onToggleExpand: (key: string) => void;
	onViewport?: (range: Interval | undefined) => void;
	/** Records shown and total, for the filter bar. */
	counts: { shown: number; total: number };
	filter: LedgerFilter;
	onFilter: (filter: LedgerFilter) => void;
	range?: Interval;
	rangeLabel?: string;
	onClearRange: () => void;
	onCollapseAll: (collapse: boolean) => void;
	filterRef?: React.Ref<HTMLInputElement>;
	/** The session's usual model; model calls name theirs only when it differs. */
	primaryModel?: string;
}

function FamilyToggle({ family, active, compact, onClick }: { family: Family; active: boolean; compact: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			title={FAMILY_LABELS[family]}
			className={cx(
				"inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[12px] transition-colors duration-150",
				active ? "bg-hover text-ink" : "text-muted hover:bg-hover hover:text-ink",
			)}
			data-family-filter={family}
		>
			<span aria-hidden="true" className={cx("size-2 rounded-[2px]", FAMILY_CLASSES[family].dot, !active && "opacity-70")} />
			{compact ? <span className="sr-only">{FAMILY_LABELS[family]}</span> : FAMILY_SHORT[family]}
		</button>
	);
}

function FilterBar({
	filter,
	onFilter,
	counts,
	range,
	rangeLabel,
	onClearRange,
	onCollapseAll,
	filterRef,
	compact,
	anyExpanded,
}: Pick<LedgerProps, "filter" | "onFilter" | "counts" | "range" | "rangeLabel" | "onClearRange" | "onCollapseAll" | "filterRef"> & {
	compact: boolean;
	anyExpanded: boolean;
}) {
	const toggleFamily = (family: Family) =>
		onFilter({ ...filter, families: filter.families.includes(family) ? filter.families.filter((f) => f !== family) : [...filter.families, family] });
	const active = filterActive(filter) || range !== undefined;
	return (
		<div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2" data-ledger-filter="">
			<label className="flex h-7 w-[200px] shrink-0 items-center gap-1.5 rounded-sm border border-line px-2 text-muted focus-within:border-accent/60">
				<Icon name="search" size={13} />
				<input
					ref={filterRef}
					type="search"
					value={filter.text}
					onChange={(event) => onFilter({ ...filter, text: event.target.value })}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							if (filter.text) onFilter({ ...filter, text: "" });
							else (event.target as HTMLInputElement).blur();
						}
						if (event.key === "Enter" || event.key === "ArrowDown") (event.target as HTMLInputElement).blur();
					}}
					placeholder="Filter records"
					aria-label="Filter records"
					className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
				/>
				<kbd className="mono rounded-[3px] border border-line px-1 text-[10px] leading-4 text-muted">/</kbd>
			</label>
			<div className="ml-1 flex min-w-0 items-center gap-0.5 overflow-hidden">
				{FAMILIES.filter((family) => family !== "user" && family !== "compaction").map((family) => (
					<FamilyToggle key={family} family={family} active={filter.families.includes(family)} compact={compact} onClick={() => toggleFamily(family)} />
				))}
				<button
					type="button"
					onClick={() => onFilter({ ...filter, errorsOnly: !filter.errorsOnly })}
					aria-pressed={filter.errorsOnly}
					className={cx(
						"inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[12px] transition-colors duration-150",
						filter.errorsOnly ? "bg-red-soft text-red" : "text-muted hover:bg-hover hover:text-ink",
					)}
					data-errors-filter=""
				>
					<Icon name="alert" size={12} />
					{compact ? <span className="sr-only">Errors only</span> : "Errors"}
				</button>
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[12px] text-muted">
				{range && (
					<button
						type="button"
						onClick={onClearRange}
						className="inline-flex h-6 items-center gap-1 rounded-sm bg-accent-soft px-1.5 text-accent hover:opacity-80"
						title="Clear the time range (Esc)"
						data-clear-range=""
					>
						<span className="mono tnum text-[11px]">{rangeLabel}</span>
						<span aria-hidden="true">×</span>
						<span className="sr-only">Clear range</span>
					</button>
				)}
				<span className="tnum whitespace-nowrap" data-ledger-count="">
					{active ? `${formatCount(counts.shown)} of ${formatCount(counts.total)}` : `${formatCount(counts.total)} records`}
				</span>
				<button
					type="button"
					onClick={() => onCollapseAll(anyExpanded)}
					className="inline-flex h-6 items-center rounded-sm px-1.5 whitespace-nowrap hover:bg-hover hover:text-ink"
					data-collapse-all={anyExpanded ? "collapse" : "expand"}
				>
					{anyExpanded ? "Collapse all" : "Expand all"}
				</button>
				<LedgerHelp />
			</div>
		</div>
	);
}

function ColumnHeader({ columns }: { columns: Columns }) {
	const cell = "truncate text-[11px] font-medium text-muted";
	return (
		<div
			className="sticky top-0 z-[3] grid h-7 items-center gap-x-2 border-b border-line bg-page pr-3"
			style={{ gridTemplateColumns: columns.template }}
			aria-hidden="true"
		>
			<span className={cx(cell, "pl-3")}>Time</span>
			<span className={cell}>Type</span>
			<span className={cell}>Name</span>
			{columns.waterfall && <span className={cx(cell, "px-1")}>Waterfall</span>}
			<span className={cx(cell, "text-right")}>Dur</span>
			{columns.tokens && <span className={cx(cell, "text-right")}>Tokens</span>}
			{columns.cost && <span className={cx(cell, "text-right")}>Cost</span>}
			<span className={cx(cell, "text-right")}>Status</span>
		</div>
	);
}

function rowSize(row: LedgerRow | undefined): number {
	return row?.type === "turn" ? TURN_ROW_HEIGHT : ROW_HEIGHT;
}

export const Ledger = memo(forwardRef<LedgerHandle, LedgerProps>(function Ledger(props, ref) {
	const { rows, live, recordCount, freshKeys, startAtTail, selectedKey, hoveredKey, highlightKey, replayKey, onSelect, onHover, onToggleTurn, onToggleExpand, onViewport } = props;
	const [pane, setPane] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(900);
	useLayoutEffect(() => {
		if (!pane) return;
		const measure = () => setWidth(pane.clientWidth || pane.getBoundingClientRect().width || 900);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(pane);
		return () => observer.disconnect();
	}, [pane]);
	const columns = useMemo(() => columnsFor(width), [width]);

	const turnHeads = useMemo(() => rows.flatMap((row, index) => (row.type === "turn" ? [index] : [])), [rows]);
	const activeSticky = useRef(-1);
	const rangeExtractor = useCallback(
		(range: Range) => {
			let active = -1;
			for (const index of turnHeads) {
				if (index <= range.startIndex) active = index;
				else break;
			}
			activeSticky.current = active;
			const indexes = defaultRangeExtractor(range);
			if (active >= 0 && !indexes.includes(active)) indexes.unshift(active);
			return indexes;
		},
		[turnHeads],
	);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => pane,
		estimateSize: (index) => rowSize(rows[index]),
		overscan: 10,
		paddingStart: COLUMN_HEADER,
		scrollPaddingStart: COLUMN_HEADER + TURN_ROW_HEIGHT,
		getItemKey: (index) => rows[index]?.key ?? index,
		rangeExtractor,
	});
	const items = virtualizer.getVirtualItems();

	useImperativeHandle(
		ref,
		() => ({
			scrollToKey: (key, align = "auto") => {
				const index = rows.findIndex((row) => row.key === key);
				if (index >= 0) virtualizer.scrollToIndex(index, { align });
			},
			focus: () => pane?.focus(),
		}),
		[rows, virtualizer, pane],
	);

	// Live sessions open at the tail and follow it as records arrive, until the reader scrolls up.
	const atBottom = useRef(true);
	const measureBottom = useCallback(() => {
		if (pane) atBottom.current = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 48;
	}, [pane]);
	useEffect(() => {
		if (!pane) return;
		pane.addEventListener("scroll", measureBottom, { passive: true });
		return () => pane.removeEventListener("scroll", measureBottom);
	}, [pane, measureBottom]);
	const placed = useRef(false);
	useLayoutEffect(() => {
		if (placed.current || !pane || rows.length === 0) return;
		placed.current = true;
		if (!startAtTail) return measureBottom();
		// After the commit, still before the first paint; scrolling re-renders the virtual rows.
		const last = rows.length - 1;
		queueMicrotask(() => {
			virtualizer.scrollToIndex(last, { align: "end" });
			measureBottom();
		});
	}, [pane, rows.length, startAtTail, virtualizer, measureBottom]);
	const followed = useRef({ rows, live });
	followed.current = { rows, live };
	const previousCount = useRef(recordCount);
	useLayoutEffect(() => {
		// Rows that changed without new records (a turn expanded, a filter cleared) may have moved the tail out of view.
		if (recordCount === previousCount.current) measureBottom();
	}, [rows, recordCount, measureBottom]);
	useEffect(() => {
		const grew = recordCount > previousCount.current;
		previousCount.current = recordCount;
		const { rows, live } = followed.current;
		if (live && grew && atBottom.current && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
	}, [recordCount, virtualizer]);

	// Report the time range on screen, for the overview's viewport indicator.
	const visibleSignature = items.map((item) => item.key).join(",");
	useEffect(() => {
		if (!onViewport) return;
		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		const top = pane?.scrollTop ?? 0;
		const bottom = top + (pane?.clientHeight ?? 0);
		for (const item of virtualizer.getVirtualItems()) {
			if (item.end < top || item.start > bottom) continue;
			const row = rows[item.index];
			if (row?.type !== "record" || row.depth > 0) continue;
			const span = recordSpan(row.record);
			if (span.start === undefined) continue;
			start = Math.min(start, span.start);
			end = Math.max(end, span.end ?? span.start);
		}
		onViewport(Number.isFinite(start) ? { start, end } : undefined);
		// `visibleSignature` stands in for the virtual items, a new array every render.
	}, [visibleSignature, rows, onViewport]);

	const stateOf = (key: string): RowState => ({
		selected: key === selectedKey,
		hovered: key === hoveredKey,
		highlighted: key === highlightKey,
		replaying: key === replayKey,
		fresh: freshKeys?.has(key) ?? false,
	});
	// Only a rendered row can be the active descendant.
	const activeId = selectedKey && items.some((item) => rows[item.index]?.key === selectedKey) ? ledgerRowId(selectedKey) : undefined;

	const selectedTurn = useMemo(() => {
		const row = rows.find((candidate) => candidate.key === selectedKey);
		return row?.type === "turn" ? row.turn.index : undefined;
	}, [rows, selectedKey]);

	return (
		<div className="flex h-full min-h-0 flex-col" data-ledger="">
			<FilterBar
				filter={props.filter}
				onFilter={props.onFilter}
				counts={props.counts}
				range={props.range}
				rangeLabel={props.rangeLabel}
				onClearRange={props.onClearRange}
				onCollapseAll={props.onCollapseAll}
				filterRef={props.filterRef}
				compact={width < 860}
				anyExpanded={rows.some((row) => row.type === "turn" && row.expanded)}
			/>
			<div
				ref={setPane}
				className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable]"
				data-scroll-pane=""
				tabIndex={0}
				role="listbox"
				aria-label="Session records"
				aria-activedescendant={activeId}
				onMouseLeave={() => onHover(undefined)}
			>
				<ColumnHeader columns={columns} />
				{rows.length === 0 ? (
					<div className="px-4 py-10 text-center text-[13px] text-muted" data-ledger-empty="">
						No records match.
					</div>
				) : (
					<div className="relative" style={{ height: virtualizer.getTotalSize() - COLUMN_HEADER }} data-virtual-list="">
						{items.map((item) => {
							const row = rows[item.index];
							if (!row) return null;
							const sticky = row.type === "turn" && item.index === activeSticky.current;
							return (
								<div
									key={item.key}
									data-index={item.index}
									className={cx("left-0 w-full", sticky ? "sticky z-[2]" : "absolute top-0")}
									style={
										sticky
											? { top: COLUMN_HEADER, height: item.size }
											: { height: item.size, transform: `translateY(${item.start - COLUMN_HEADER}px)` }
									}
									onClick={() => {
										if (row.type === "turn") onToggleTurn(row.turn);
										else if (row.type === "record" || row.type === "child") onSelect(row.key);
									}}
									onMouseEnter={() => onHover(row.type === "record" ? row.key : undefined)}
								>
									{row.type === "turn" ? (
										<TurnRow
											row={row}
											columns={columns}
											selected={selectedTurn === row.turn.index}
											onToggle={onToggleTurn}
										/>
									) : row.type === "record" ? (
										<RecordRow row={row} columns={columns} {...stateOf(row.key)} live={live} primaryModel={props.primaryModel} onToggle={onToggleExpand} />
									) : row.type === "child" ? (
										<ChildRow row={row} columns={columns} {...stateOf(row.key)} onToggle={onToggleExpand} />
									) : (
										<StatusRow row={row} columns={columns} />
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}));
