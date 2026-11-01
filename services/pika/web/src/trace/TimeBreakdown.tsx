import { memo, useId, useMemo, useState } from "react";
import { ModelName } from "../components/ModelName";
import { cx } from "../components/ui";
import { plural } from "../lib/format";
import type { SessionTrace } from "../lib/types";
import type { Interval } from "./axis";
import { buildBreakdown, type Breakdown, type BreakdownFamily, type BreakdownItem, type SubagentMode } from "./breakdown";
import { MAX_DESCENDANTS, useDescendantTraces } from "./data";
import { formatSpan } from "./format";
import { FAMILY_CLASSES, FAMILY_LABELS, toolGlyph } from "./kinds";
import { KindBullet, RunningDot } from "./parts";

export const BREAKDOWN_MODE_KEY = "pika-breakdown-subagents";
export const BREAKDOWN_OPEN_KEY = "pika-breakdown-details";
/** Lines a kind lists in the details before the rest are summed up. */
const ITEMS_SHOWN = 8;

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

/** Each kind's models, tools, or agent types, longest first. */
function BreakdownDetails({ id, breakdown }: { id: string; breakdown: Breakdown }) {
	return (
		<div
			id={id}
			className="mt-2 grid max-h-[280px] grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-x-8 gap-y-3 overflow-y-auto pb-1"
			data-breakdown-details=""
		>
			{breakdown.families.map((family) => (
				<FamilyDetails key={family.family} family={family} total={breakdown.ms} />
			))}
		</div>
	);
}

function FamilyDetails({ family, total }: { family: BreakdownFamily; total: number }) {
	const shown = family.items.slice(0, ITEMS_SHOWN);
	const rest = family.items.slice(ITEMS_SHOWN);
	return (
		<section aria-label={FAMILY_LABELS[family.family]} data-breakdown-group={family.family}>
			<div className="flex h-6 items-center gap-1.5 border-b border-ink text-[12px] font-semibold">
				<KindBullet family={family.family} size={13} />
				<span className="min-w-0 truncate">{FAMILY_LABELS[family.family]}</span>
				<span className="tnum ml-auto">{formatSpan(family.ms)}</span>
				<span className="tnum w-9 text-right font-normal text-muted">{percent(share(family.ms, total))}</span>
			</div>
			<ul className="text-[12px]">
				{shown.map((item) => (
					<ItemRow key={item.key} item={item} total={total} />
				))}
				{rest.length > 0 && (
					<li className="tnum flex h-6 items-center gap-2 text-muted" data-breakdown-rest="">
						<span className="min-w-0 flex-1 truncate">{rest.length} more</span>
						<span>{formatSpan(rest.reduce((sum, item) => sum + item.ms, 0))}</span>
						<span className="w-9" />
					</li>
				)}
			</ul>
		</section>
	);
}

function ItemRow({ item, total }: { item: BreakdownItem; total: number }) {
	let name;
	if (item.kind === "model") name = item.name ? <ModelName model={item.name} keepName /> : <span className="min-w-0 truncate text-muted italic">Unknown model</span>;
	else if (item.kind === "tool") name = <span className="mono min-w-0 truncate text-[11.5px]">{item.label}</span>;
	else name = <span className="min-w-0 truncate">{item.label}</span>;
	return (
		<li className="flex h-6 min-w-0 items-center gap-2 border-b border-line" title={`${item.label || "Unknown model"}: ${plural(item.count, "call")}, ${formatSpan(item.ms)}`} data-breakdown-item={item.name}>
			{item.kind !== "model" && <KindBullet family={item.family} glyph={item.kind === "tool" ? toolGlyph(item.name) : undefined} size={13} />}
			{name}
			<span className="tnum ml-auto shrink-0 text-muted">{item.count}×</span>
			<span className="tnum w-[52px] shrink-0 text-right">{formatSpan(item.ms)}</span>
			<span className="tnum w-9 shrink-0 text-right text-muted">{percent(share(item.ms, total))}</span>
		</li>
	);
}
