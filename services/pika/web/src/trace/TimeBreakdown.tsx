import { memo, useId, useMemo, useState } from "react";
import { ModelMark } from "../components/ModelName";
import { cx } from "../components/ui";
import { plural } from "../lib/format";
import type { SessionTrace } from "../lib/types";
import type { Interval } from "./axis";
import { buildBreakdown, type Breakdown, type BreakdownFamily, type BreakdownItem, type SubagentMode } from "./breakdown";
import { MAX_DESCENDANTS, useDescendantTraces } from "./data";
import { formatSpan } from "./format";
import { FAMILY_CLASSES, FAMILY_LABELS, familyColor, toolGlyph } from "./kinds";
import { KindBullet, RunningDot } from "./parts";

export const BREAKDOWN_MODE_KEY = "pika-breakdown-subagents";
export const BREAKDOWN_OPEN_KEY = "pika-breakdown-details";
/** Stations a kind's line shows before a button offers the rest. */
const ITEMS_SHOWN = 12;

function stored<T extends string>(key: string, values: readonly T[], fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return values.find((candidate) => candidate === value) ?? fallback;
	} catch {
		return fallback;
	}
}

function remember(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Not remembered without storage.
	}
}

const share = (ms: number, total: number) => (total > 0 ? ms / total : 0);

/** Time between calls is no kind of record: hatched in the muted ink, as the provider row hatches waiting. */
const BETWEEN_STYLE = {
	backgroundColor: "color-mix(in srgb, var(--color-muted) 16%, transparent)",
	backgroundImage: "repeating-linear-gradient(135deg, var(--color-muted) 0 1px, transparent 1px 3.5px)",
};

function betweenTitle(breakdown: Breakdown): string {
	const base = "Time inside turns when no model or tool call ran: pi's own work, a subagent starting, and waiting";
	return breakdown.untimed ? `${base}. It includes ${plural(breakdown.untimed, "model call")} whose time was not recorded.` : base;
}
const percent = (fraction: number) => (fraction > 0 && fraction < 0.005 ? "<1%" : `${Math.round(fraction * 100)}%`);

const MODES: { mode: SubagentMode; label: string; title: string }[] = [
	{ mode: "one", label: "Grouped", title: "Count each subagent as one Subagent stop, for as long as it ran" },
	{ mode: "split", label: "Split", title: "Count the subagents' own model and tool calls in their kinds, all the way down" },
];

/**
 * Where the session's time went, under the strip map: a bar of the kinds in their line colours, each kind's time and
 * share, and on request the models, tools, and agent types within each kind. Subagents count as one kind, or split
 * into the kinds of their own calls once their traces load. With a time range selected on the strip map, it counts
 * only what ran inside the range, as the ledger lists only the records in it. Memoized: replay frames re-render the
 * trajectory, not it.
 */
export const TimeBreakdown = memo(function TimeBreakdown({
	trace,
	live,
	range,
	rangeLabel,
	onClearRange,
}: {
	trace: SessionTrace;
	live: boolean;
	range?: Interval;
	rangeLabel?: string;
	onClearRange?: () => void;
}) {
	const [mode, setModeState] = useState<SubagentMode>(() => stored(BREAKDOWN_MODE_KEY, ["one", "split"], "one"));
	const [open, setOpenState] = useState(() => stored(BREAKDOWN_OPEN_KEY, ["open", "closed"], "closed") === "open");
	const detailsId = useId();
	const hasSubagents = trace.children.length > 0 || trace.records.some((record) => record.kind === "tool" && record.childSessionId !== undefined);
	const split = mode === "split" && hasSubagents;
	const descendants = useDescendantTraces(trace, split);
	// A live session's running calls count up to now, as of its latest trace.
	const breakdown = useMemo(
		() => buildBreakdown({ trace, mode: split ? "split" : "one", traces: descendants.traces, now: live ? Date.now() : undefined, window: range }),
		[trace, split, descendants.traces, live, range],
	);
	const hasCalls = useMemo(() => trace.records.some((record) => record.kind === "llm" || record.kind === "tool"), [trace]);
	if (!hasCalls) return null;
	// A range can hold no calls at all, such as one between two turns; the strip stays, and says so.
	const empty = breakdown.count === 0 && breakdown.between === 0;

	const setMode = (next: SubagentMode) => {
		setModeState(next);
		remember(BREAKDOWN_MODE_KEY, next);
	};
	const toggle = () => {
		setOpenState(!open);
		remember(BREAKDOWN_OPEN_KEY, open ? "closed" : "open");
	};
	const pending = split ? descendants.wanted - descendants.traces.size - descendants.failed : 0;

	return (
		<div className="mt-2.5 border-t border-line pt-2" data-breakdown="" data-mode={split ? "split" : "one"} data-range={range ? "" : undefined}>
			{/* One line where it fits; on phones the controls wrap under the title and the bar takes a line of its own. */}
			<div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 whitespace-nowrap">
				<h3 className="text-[13px] font-semibold">Time by kind</h3>
				{range && (
					// The range it counts, as the ledger's toolbar shows it; clearing it here clears it everywhere.
					<button
						type="button"
						onClick={onClearRange}
						className="-mx-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-ink px-1.5 text-[12px] text-ink hover:bg-hover"
						title="Only the selected time range counts. Clear it (Esc)"
						data-breakdown-range=""
					>
						<span className="tnum">{rangeLabel}</span>
						<span aria-hidden="true">×</span>
						<span className="sr-only">Clear range</span>
					</button>
				)}
				<span
					className="tnum shrink-0 text-[12px] text-muted"
					title="Calls that ran at the same time, such as parallel tool calls or subagents, each count in full"
					data-breakdown-total=""
				>
					{formatSpan(breakdown.ms)} · {plural(breakdown.count, "call")}
					{split && breakdown.sessions > 1 && ` · ${plural(breakdown.sessions, "session")}`}
				</span>
				{empty ? (
					<span className="min-w-0 flex-1 text-[12px] text-muted italic" data-breakdown-empty="">
						Nothing ran in this range
					</span>
				) : (
					<BreakdownBar breakdown={breakdown} />
				)}
				{split && <SplitStatus pending={pending} wanted={descendants.wanted} failed={descendants.failed} capped={descendants.capped} />}
				<div className="ml-auto flex shrink-0 items-center gap-3">
					{hasSubagents && (
						<div className="flex items-center gap-1.5 text-[12px] text-muted">
							<span aria-hidden="true">Subagents</span>
							<div className="flex h-7 items-center gap-px rounded-sm border border-line p-0.5" role="group" aria-label="Subagents">
								{MODES.map((option) => (
									<button
										key={option.mode}
										type="button"
										onClick={() => setMode(option.mode)}
										aria-pressed={mode === option.mode}
										title={option.title}
										className={cx(
											"h-full rounded-sm px-2 text-[12px] font-medium transition-colors duration-150",
											mode === option.mode ? "bg-ink text-page" : "text-muted hover:bg-hover hover:text-ink",
										)}
										data-breakdown-mode={option.mode}
									>
										{option.label}
									</button>
								))}
							</div>
						</div>
					)}
					<button
						type="button"
						onClick={toggle}
						aria-expanded={open}
						aria-controls={detailsId}
						className="inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
						data-breakdown-details-toggle=""
					>
						<span aria-hidden="true" className="w-2.5 text-[10px]">
							{open ? "▾" : "▸"}
						</span>
						By model and tool
					</button>
				</div>
			</div>
			{!empty && (
				<ul className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" aria-label="Time by kind" data-breakdown-kinds="">
					{breakdown.families.map((family) => (
						<li key={family.family} className="flex shrink-0 items-center gap-1.5" data-breakdown-family={family.family} title={`${plural(family.count, "call")}`}>
							<KindBullet family={family.family} size={13} />
							<span>{FAMILY_LABELS[family.family]}</span>
							<span className="tnum font-medium" data-breakdown-time="">
								{formatSpan(family.ms)}
							</span>
							<span className="tnum text-muted">{percent(share(family.ms, breakdown.ms))}</span>
						</li>
					))}
					{breakdown.between > 0 && (
						<li className="flex shrink-0 items-center gap-1.5" title={betweenTitle(breakdown)} data-breakdown-family="between">
							<span aria-hidden="true" className="size-[13px] shrink-0 rounded-full" style={BETWEEN_STYLE} />
							<span>Between calls</span>
							<span className="tnum font-medium" data-breakdown-time="">
								{formatSpan(breakdown.between)}
							</span>
							<span className="tnum text-muted">{percent(share(breakdown.between, breakdown.ms))}</span>
						</li>
					)}
				</ul>
			)}
			{open && !empty && <BreakdownDetails id={detailsId} breakdown={breakdown} />}
		</div>
	);
});

/** The kinds' shares as one bar, in their line colours. */
function BreakdownBar({ breakdown }: { breakdown: Breakdown }) {
	return (
		<span className="flex h-[10px] min-w-[96px] flex-1 gap-[2px] max-md:order-last max-md:basis-full" aria-hidden="true" data-breakdown-bar="">
			{breakdown.families.map((family) =>
				family.ms > 0 ? (
					<span
						key={family.family}
						className={cx("h-full min-w-[2px] first:rounded-l-[2px] last:rounded-r-[2px]", FAMILY_CLASSES[family.family].bar)}
						style={{ flexGrow: family.ms, flexBasis: 0 }}
						title={`${FAMILY_LABELS[family.family]}: ${formatSpan(family.ms)}, ${percent(share(family.ms, breakdown.ms))}`}
						data-segment={family.family}
					/>
				) : null,
			)}
			{breakdown.between > 0 && (
				<span
					className="h-full min-w-[2px] first:rounded-l-[2px] last:rounded-r-[2px]"
					style={{ ...BETWEEN_STYLE, flexGrow: breakdown.between, flexBasis: 0 }}
					title={`Between calls: ${formatSpan(breakdown.between)}, ${percent(share(breakdown.between, breakdown.ms))}`}
					data-segment="between"
				/>
			)}
		</span>
	);
}

/** How far the subagents' traces have loaded; until they have, a subagent counts as one Subagent stop. */
function SplitStatus({ pending, wanted, failed, capped }: { pending: number; wanted: number; failed: number; capped: boolean }) {
	if (pending > 0) {
		return (
			<span className="tnum flex shrink-0 items-center gap-1.5 text-[12px] text-muted" role="status" data-breakdown-loading="">
				<RunningDot />
				Loading subagents {wanted - pending}/{wanted}
			</span>
		);
	}
	if (failed > 0) {
		return (
			<span className="shrink-0 text-[12px] text-red" title="They count as one Subagent stop each" data-breakdown-failed="">
				{plural(failed, "subagent")} didn’t load
			</span>
		);
	}
	if (capped) {
		return (
			<span className="shrink-0 text-[12px] text-muted" title={`Subagents past the first ${MAX_DESCENDANTS} count as one Subagent stop each`}>
				First {MAX_DESCENDANTS} subagents
			</span>
		);
	}
	return null;
}

/**
 * The kinds as lines of a subway map: each kind's line in its colour, with its models, tools, or agent types as
 * stations on it, longest first.
 */
function BreakdownDetails({ id, breakdown }: { id: string; breakdown: Breakdown }) {
	return (
		<div id={id} className="mt-3 flex max-h-[320px] flex-col gap-2.5 overflow-y-auto pr-1 pb-1" data-breakdown-details="">
			{breakdown.families.map((family) => (
				<FamilyLine key={family.family} family={family} total={breakdown.ms} />
			))}
		</div>
	);
}

/**
 * One kind: its name and time, then its line. The line runs through every row of stations, as the tags wrap, so a kind
 * with many tools still reads as one line.
 */
function FamilyLine({ family, total }: { family: BreakdownFamily; total: number }) {
	const [all, setAll] = useState(false);
	const shown = all ? family.items : family.items.slice(0, ITEMS_SHOWN);
	const hidden = family.items.slice(shown.length);
	const color = familyColor(family.family);
	return (
		<section aria-label={FAMILY_LABELS[family.family]} className="flex min-w-0 flex-col gap-1.5 md:flex-row md:gap-4" data-breakdown-group={family.family}>
			<div className="flex h-6 shrink-0 items-center gap-1.5 text-[12px] md:w-[224px]">
				<KindBullet family={family.family} size={16} />
				<span className="min-w-0 truncate font-semibold">{FAMILY_LABELS[family.family]}</span>
				<span className="tnum ml-auto font-medium">{formatSpan(family.ms)}</span>
				<span className="tnum w-9 text-right text-muted">{percent(share(family.ms, total))}</span>
			</div>
			{/* Rows of 24 px stations 8 px apart: the line is drawn through the middle of each row. */}
			<ul
				className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-2"
				style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 11px, ${color} 11px 13px, transparent 13px 32px)` }}
				aria-label={`${FAMILY_LABELS[family.family]} by ${family.family === "llm" ? "model" : family.family === "agent" ? "subagent" : "tool"}`}
			>
				{shown.map((item) => (
					<ItemTag key={item.key} item={item} familyMs={family.ms} total={total} />
				))}
				{hidden.length > 0 && (
					<li>
						<button
							type="button"
							onClick={() => setAll(true)}
							className="tnum flex h-6 items-center rounded-full border-[1.5px] border-dashed bg-page px-2.5 text-[12px] text-muted hover:text-ink"
							style={{ borderColor: color }}
							title={`${formatSpan(hidden.reduce((sum, item) => sum + item.ms, 0))} in all`}
						>
							{hidden.length} more
						</button>
					</li>
				)}
			</ul>
		</section>
	);
}

/**
 * A station: a capsule outlined in its kind's colour, filled from the left by its share of the kind's time, with the
 * model's maker's mark or the tool's glyph, its name, its time, and how many calls it made.
 */
function ItemTag({ item, familyMs, total }: { item: BreakdownItem; familyMs: number; total: number }) {
	const color = familyColor(item.family);
	const fill = Math.round(share(item.ms, familyMs) * 1000) / 10;
	let mark;
	if (item.kind === "model") mark = item.name ? <ModelMark model={item.name} size={13} /> : null;
	else mark = <KindBullet family={item.family} glyph={item.kind === "tool" ? toolGlyph(item.name) : undefined} size={16} />;
	const name = item.label || "Unknown model";
	return (
		<li
			className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border-[1.5px] pr-2.5 pl-[3px] text-[12px] leading-none"
			style={{
				borderColor: color,
				background: `linear-gradient(to right, color-mix(in srgb, ${color} 26%, var(--color-page)) ${fill}%, var(--color-page) ${fill}%)`,
			}}
			title={`${name}: ${formatSpan(item.ms)} in ${plural(item.count, "call")}, ${percent(share(item.ms, familyMs))} of ${FAMILY_LABELS[item.family]}, ${percent(share(item.ms, total))} of all`}
			data-breakdown-item={item.name}
			data-share={fill}
		>
			{/* Marks share the bullets' 16 px box, so names line up from station to station. */}
			<span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
				{mark ?? <KindBullet family="llm" size={16} />}
			</span>
			<span className={cx("min-w-0 truncate", item.kind === "tool" && "mono text-[11.5px]", !item.label && "text-muted italic")}>{name}</span>
			<span className="tnum shrink-0 font-semibold">{formatSpan(item.ms)}</span>
			<span className="tnum shrink-0 text-[11px] text-muted">
				<span aria-hidden="true">×</span>
				{item.count}
				<span className="sr-only"> {item.count === 1 ? "call" : "calls"}</span>
			</span>
		</li>
	);
}
