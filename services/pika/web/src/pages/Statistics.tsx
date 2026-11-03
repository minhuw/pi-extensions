import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ModelName, modelMaker, type ModelMaker } from "../components/ModelName";
import { BUTTON, cx, EmptyState, ErrorState, Page, PageTitle, Segmented, Skeleton } from "../components/ui";
import { cacheReadShare, completionShare, UsageBreakdowns } from "../components/UsageBreakdowns";
import { useApi } from "../lib/api";
import { bareModel } from "../lib/model";
import { formatCost, formatCount, plural, totalTokens } from "../lib/format";
import type { Tokens, UsageDay, UsageGroup, UsagePeriod, UsageReport, UsageRequestMetrics, UsageStatistics } from "../lib/types";

const RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]] as const;
type Range = (typeof RANGES)[number][0];

type Metric = "tokens" | "requests" | "cost";
const METRICS = [["tokens", "Tokens"], ["requests", "Requests"], ["cost", "Cost"]] as const;

const exact = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const percent = (share: number | undefined) => (share === undefined ? "—" : `${(share * 100).toFixed(1)}%`);
const utcDay = (date: string) => new Date(`${date}T00:00:00Z`);
const shortDate = (date: string) => utcDay(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const valueOf = (day: UsageDay, metric: Metric) => (metric === "tokens" ? totalTokens(day.tokens) : day[metric]);
const metricText = (n: number, metric: Metric) =>
	metric === "cost" ? formatCost(n) : `${formatCount(n)} ${metric === "tokens" ? "tokens" : n === 1 ? "request" : "requests"}`;
const exactText = (n: number, metric: Metric) => (metric === "cost" ? formatCost(n) : `${exact(n)} ${metric}`);

/** `Aug 6 – Nov 3, 2026`, naming the year once when both ends share it. */
export function formatDateRange(from: string, to: string): string {
	const a = utcDay(from), b = utcDay(to);
	if (from === to) return `${shortDate(to)}, ${b.getUTCFullYear()}`;
	return a.getUTCFullYear() === b.getUTCFullYear()
		? `${shortDate(from)} – ${shortDate(to)}, ${b.getUTCFullYear()}`
		: `${shortDate(from)}, ${a.getUTCFullYear()} – ${shortDate(to)}, ${b.getUTCFullYear()}`;
}

export interface Bucket { from: string; to: string; value: number }
/** Bound chart density: at most 90 bars, each covering the same number of UTC days. */
export function usageBuckets(daily: UsageDay[], metric: Metric): { buckets: Bucket[]; size: number } {
	const size = Math.max(1, Math.ceil(daily.length / 90));
	const buckets: Bucket[] = [];
	for (let i = 0; i < daily.length; i += size) {
		const days = daily.slice(i, i + size);
		buckets.push({ from: days[0].date, to: days[days.length - 1].date, value: days.reduce((sum, day) => sum + valueOf(day, metric), 0) });
	}
	return { buckets, size };
}

/** Gridlines on round steps (1, 2, 2.5, or 5 × 10ⁿ) from 0 past the peak; whole steps for counts. */
export function axisTicks(peak: number, whole = true): number[] {
	if (!(peak > 0)) return [0];
	const rough = peak / 3;
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	let step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
	if (whole) step = Math.max(1, Math.ceil(step));
	const count = Math.ceil(peak / step - 1e-9);
	return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/**
 * The date axis' labels: every day of a week or two, Mondays of a month, and the first of each month beyond that,
 * with the range's first day when the first label would sit far from the left edge.
 */
function dateTicks(buckets: Bucket[], days: number): { index: number; text: string }[] {
	const ticks: { index: number; text: string }[] = [];
	buckets.forEach((bucket, index) => {
		const from = utcDay(bucket.from), to = utcDay(bucket.to);
		if (days <= 14) ticks.push({ index, text: shortDate(bucket.from) });
		else if (days <= 45) {
			if (from.getUTCDay() === 1) ticks.push({ index, text: shortDate(bucket.from) });
		} else {
			for (const day = new Date(from); day <= to; day.setUTCDate(day.getUTCDate() + 1)) {
				if (day.getUTCDate() !== 1) continue;
				const month = day.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
				ticks.push({ index, text: day.getUTCMonth() === 0 ? `${month} ${day.getUTCFullYear()}` : month });
				break;
			}
		}
	});
	if (buckets.length && (ticks.length === 0 || ticks[0].index > buckets.length * 0.12)) ticks.unshift({ index: 0, text: shortDate(buckets[0].from) });
	return ticks;
}

/** Where a label hangs from a point `at` (0–100%) along the axis: centred, or flush toward the nearer end near an edge. */
function hang(at: number, edge: number): CSSProperties {
	const shift = at < edge ? "-6px" : at > 100 - edge ? "calc(-100% + 6px)" : "-50%";
	return { left: `${at}%`, transform: `translateX(${shift})` };
}

/** One layer of the chart's stacked bars: a model or project, the rest together, or usage without a name. */
export interface Series {
	id: string;
	label: string;
	model?: string;
	/** A CSS `background`. */
	fill: string;
}

export type Split = "total" | "model" | "project";
const SPLITS = [["total", "Total"], ["model", "By model"], ["project", "By project"]] as const;
export const OTHER = "\u0000other";
export const UNNAMED = "\u0000none";
/** Layers before the rest go together: models each have a colour of their own, projects share one ink scale. */
const LAYER_LIMIT = { model: 10, project: 6 } as const;
const INK = "var(--color-ink)";
const PAGE = "var(--color-page)";
/** Project layers, largest first, step from the black of the unsplit bar toward the page, so a split reads as the total divided. */
const SHADES = [100, 72, 52, 36, 24, 16];
const tint = (colour: string, percent: number) => (percent >= 100 ? colour : `color-mix(in srgb, ${colour} ${percent}%, ${PAGE})`);
const mix = (colour: string, percent: number, toward: string) => `color-mix(in oklab, ${colour} ${percent}%, ${toward})`;
/** A maker's colours for its models: its own, then alternately lighter and darker, so neighbouring layers differ. */
const MAKER_VARIANTS: ((colour: string) => string)[] = [
	(c) => c,
	(c) => mix(c, 66, PAGE),
	(c) => mix(c, 70, INK),
	(c) => mix(c, 42, PAGE),
	(c) => mix(c, 48, INK),
	(c) => mix(c, 24, PAGE),
];
/** Models of makers without a colour step through ink. */
const INK_VARIANTS = SHADES.map((percent) => (c: string) => tint(c, percent));
/** Makers pika colours in the chart without a mark of their own, by name as `modelMaker` reads it. */
type Family = ModelMaker | "qwen" | "minimax" | "mistral" | "zai";
/**
 * The colour each maker lends its models' layers: the colours of their names and marks, OpenAI's green, Kimi's blue,
 * and for the rest, Artificial Analysis's creator colours.
 */
const MAKER_COLOURS: Partial<Record<Family, string>> = {
	claude: "var(--color-model-claude)",
	gemini: "var(--color-model-gemini)",
	deepseek: "var(--color-model-deepseek)",
	openai: "var(--color-model-openai)",
	kimi: "var(--color-model-kimi)",
	grok: "var(--color-model-grok)",
	qwen: "var(--color-model-qwen)",
	minimax: "var(--color-model-minimax)",
	mistral: "var(--color-model-mistral)",
	zai: "var(--color-model-zai)",
};

/** A model's colour family: its maker as `modelMaker` knows it, else a maker the chart alone colours. */
export function modelFamily(model: string): Family | undefined {
	const known = modelMaker(model);
	if (known) return known;
	const name = bareModel(model).toLowerCase();
	if (/qwen|qwq/.test(name)) return "qwen";
	if (/minimax|^abab/.test(name)) return "minimax";
	if (/mistral|mixtral|pixtral|(code|dev|magi|mini)stral/.test(name)) return "mistral";
	if (/^(chat)?glm|zhipu/.test(name)) return "zai";
	return undefined;
}

/**
 * Every model in the order it first used tokens (failed calls alone do not count), by month, then by name: from an
 * all-time monthly `usage?by=model` report.
 * A new model joins the end, so the variants `splitSeries` gives earlier models never move.
 */
export function modelOrder(report: UsageReport): string[] {
	const seen = new Set<string>();
	for (const period of report.periods) {
		const fresh = (period.groups ?? []).flatMap((group) => (group.name !== null && !seen.has(group.name) && group.tokens > 0 ? [group.name] : []));
		for (const name of fresh.toSorted()) seen.add(name);
	}
	return [...seen];
}

/**
 * Each shown model's variant: its place among its maker's models in first-use `order` (models it lacks follow, by
 * name), cycling through the variants; a model whose variant a model shown before it took takes the next free one.
 */
function variantsOf(names: string[], family: string, order: string[], count: number): Map<string, number> {
	const ranked = order.filter((name) => familyOf(name) === family);
	const missing = names.filter((name) => !ranked.includes(name)).toSorted();
	const place = new Map([...ranked, ...missing].map((name, i) => [name, i]));
	const taken = new Set<number>();
	const chosen = new Map<string, number>();
	for (const name of names.toSorted((a, b) => place.get(a)! - place.get(b)!)) {
		let k = place.get(name)! % count;
		for (let step = 0; step < count && taken.has(k); step++) k = (k + 1) % count;
		taken.add(k);
		chosen.set(name, k);
	}
	return chosen;
}

/** The colour family a model's layer takes: its maker's, or ink. */
function familyOf(model: string): string {
	const maker = modelFamily(model);
	return maker && MAKER_COLOURS[maker] ? maker : "ink";
}
const HATCH = `repeating-linear-gradient(135deg, ${tint(INK, 42)} 0 1.5px, ${tint(INK, 8)} 1.5px 4.5px)`;

/**
 * The chart's layers, bottom to top: the ten models with the most tokens, each in its own variant of its maker's colour,
 * or the six projects with the most in shades of ink; the remaining ones together; then usage without a name, hatched:
 * no recorded model, or, by project, no project or (public) activity outside published projects.
 */
export function splitSeries(groups: UsageGroup[], by: "model" | "project", publicView = false, order: string[] = []): Series[] {
	const used = (group: UsageGroup) => group.tokens > 0 || group.requests > 0 || group.cost > 0;
	const named = groups.filter((group) => group.name !== null && used(group)).toSorted((a, b) => b.tokens - a.tokens);
	const limit = LAYER_LIMIT[by];
	const shown = named.slice(0, limit).map((group) => group.name!);
	let series: Series[];
	if (by === "project") series = shown.map((name, i) => ({ id: name, label: name, fill: tint(INK, SHADES[i]) }));
	else {
		// Grouped by maker, in the order of each maker's largest model; makers without a colour in ink.
		const families = new Map<string, string[]>();
		for (const name of shown) {
			const family = familyOf(name);
			families.set(family, [...(families.get(family) ?? []), name]);
		}
		series = [...families].flatMap(([family, names]) => {
			const variants = family === "ink" ? INK_VARIANTS : MAKER_VARIANTS;
			const chosen = variantsOf(names, family, order, variants.length);
			const colour = MAKER_COLOURS[family as Family] ?? INK;
			return names.map((name) => ({ id: name, label: name, model: name, fill: variants[chosen.get(name)!](colour) }));
		});
	}
	const rest = named.length - limit;
	if (rest > 0) series.push({ id: OTHER, label: `${rest} other ${by === "model" ? "model" : "project"}${rest === 1 ? "" : "s"}`, fill: tint(INK, 8) });
	if (groups.some((group) => group.name === null && used(group))) {
		const label = by === "model" ? "No model recorded" : publicView ? "Unpublished & hidden" : "No project";
		series.push({ id: UNNAMED, label, fill: HATCH });
	}
	return series;
}

/** A breakdown row's layer in the chart: its own, the remaining ones', or the unnamed layer. */
export function layerOf(series: Series[], name: string | null): Series | undefined {
	if (name === null) return series.find((s) => s.id === UNNAMED);
	return series.find((s) => s.id === name) ?? series.find((s) => s.id === OTHER);
}

const nextDay = (date: string) => new Date(utcDay(date).getTime() + 86_400_000).toISOString().slice(0, 10);

const NO_LAYERS: Series[] = [];

/** The Total chart's token layers, bottom to top: the session list's ink steps, darkest to lightest. */
export const TOKEN_SERIES: Series[] = [
	{ id: "output", label: "Output", fill: INK },
	{ id: "input", label: "Input", fill: tint(INK, 70) },
	{ id: "cacheWrite", label: "Cache write", fill: tint(INK, 45) },
	{ id: "cacheRead", label: "Cache read", fill: tint(INK, 20) },
];

/** Each bar's tokens by type, in `TOKEN_SERIES` order, from the daily totals. */
export function tokenParts(buckets: Bucket[], daily: UsageDay[]): number[][] {
	const days = new Map(daily.map((day) => [day.date, day]));
	return buckets.map((bucket) => {
		const parts = TOKEN_SERIES.map(() => 0);
		for (let date = bucket.from; date <= bucket.to; date = nextDay(date)) {
			const day = days.get(date);
			if (day) TOKEN_SERIES.forEach((layer, k) => (parts[k] += day.tokens[layer.id as keyof Tokens]));
		}
		return parts;
	});
}

/** Each bar's value per layer, in layer order; `undefined` for a bar the report does not cover. */
export function bucketParts(buckets: Bucket[], periods: UsagePeriod[], series: Series[], metric: Metric): (number[] | undefined)[] {
	const layer = new Map(series.map((s, i) => [s.id, i]));
	const days = new Map(periods.map((period) => [period.start, period]));
	return buckets.map((bucket) => {
		const parts = series.map(() => 0);
		for (let day = bucket.from; day <= bucket.to; day = nextDay(day)) {
			const period = days.get(day);
			if (!period) return undefined;
			for (const group of period.groups ?? []) {
				const index = group.name === null ? layer.get(UNNAMED) : (layer.get(group.name) ?? layer.get(OTHER));
				if (index !== undefined) parts[index] += group[metric];
			}
		}
		return parts;
	});
}

/** The edge on a layer's swatch that keeps the lightest shades visible on the page. */
const SWATCH = "size-2.5 shrink-0 [box-shadow:inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_16%,transparent)]";
const CARD_WIDTH = 288;

/**
 * Daily usage as black bars on round gridlines, or split into layers: models in their makers' colours, projects in
 * shades of the same black. The chosen
 * bar carries a pin with its date and total, like the session view's "you are here" pin, and when split the legend
 * gives its value per layer; hovering, clicking, or the arrow keys move it. While the pointer or focus is on a stacked
 * bar, a card beside the pin lists its layers, top first, with their share of the bar.
 */
function UsageChart({ daily, split, onSplit, report, series }: { daily: UsageDay[]; split: Split; onSplit: (split: Split) => void; report?: UsageReport; series: Series[] }) {
	const [metric, setMetric] = useState<Metric>("tokens");
	const { buckets } = useMemo(() => usageBuckets(daily, metric), [daily, metric]);
	// Total tokens stack by token type; a split stacks by its groups; requests and cost in Total stay one black column.
	const byType = split === "total" && metric === "tokens";
	const layers = byType ? TOKEN_SERIES : split === "total" ? NO_LAYERS : series;
	const parts = useMemo(
		() => (byType ? tokenParts(buckets, daily) : report && layers.length ? bucketParts(buckets, report.periods, layers, metric) : []),
		[byType, buckets, daily, report, layers, metric],
	);
	// The chosen bar is kept as its first day, so it survives a refresh or a new range; otherwise the latest with usage.
	const [chosen, setChosen] = useState<string | undefined>();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	let latest = buckets.length - 1;
	while (latest > 0 && buckets[latest].value === 0) latest--;
	const found = chosen === undefined ? -1 : buckets.findIndex((bucket) => bucket.from <= chosen && chosen <= bucket.to);
	const selected = found >= 0 ? found : latest;
	const choose = (i: number) => setChosen(buckets[i]?.from);
	const active = buckets[selected];
	const activeParts = parts[selected];
	const valueText = (value: number) => (metric === "cost" ? formatCost(value) : formatCount(value));
	// The card follows the pointer or keyboard focus on the bars; a click's lingering focus leaves with the pointer.
	const [inspecting, setInspecting] = useState(false);
	const cardId = useId();
	const activeSum = activeParts?.reduce((total, value) => total + value, 0) ?? 0;
	const cardRows = inspecting
		? layers.flatMap((layer, k) => {
				const value = activeParts?.[k] ?? 0;
				return value > 0 ? [{ layer, value }] : [];
			}).reverse()
		: [];
	const card = cardRows.length > 0;
	const peak = buckets.reduce((top, bucket) => Math.max(top, bucket.value), 0);
	const ticks = axisTicks(peak, metric !== "cost");
	const top = ticks[ticks.length - 1] || 1;
	const height = (value: number) => Math.min(100, (value / top) * 100);
	const at = (i: number) => ((i + 0.5) / buckets.length) * 100;
	const dates = useMemo(() => dateTicks(buckets, daily.length), [buckets, daily.length]);
	const label = (bucket: Bucket) => (bucket.from === bucket.to ? shortDate(bucket.from) : `${shortDate(bucket.from)} – ${shortDate(bucket.to)}`);
	const tickText = (value: number) => (metric === "cost" ? formatCost(value) : formatCount(value));
	const move = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
		const next = event.key === "ArrowRight" ? Math.min(buckets.length - 1, i + 1) : event.key === "ArrowLeft" ? Math.max(0, i - 1) : event.key === "Home" ? 0 : event.key === "End" ? buckets.length - 1 : undefined;
		if (next === undefined) return;
		event.preventDefault();
		choose(next);
		buttons.current[next]?.focus();
	};
	const gap = buckets.length > 60 ? "gap-px sm:gap-[2px]" : buckets.length > 20 ? "gap-[2px] sm:gap-1" : "gap-1.5 sm:gap-3";
	return (
		<section aria-labelledby="usage-chart-title" className="min-w-0" data-usage-chart="">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<h2 id="usage-chart-title" className="text-[16px] font-semibold">Usage over time</h2>
				<div className="flex flex-wrap items-center gap-2">
					<Segmented size="sm" label="Chart metric" value={metric} options={METRICS} onChange={setMetric} />
					<Segmented size="sm" label="Split" value={split} options={SPLITS} onChange={onSplit} />
				</div>
			</div>
			<div className="mt-11 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5">
				<div className="tnum relative w-11 text-right text-[11px] leading-none text-muted" aria-hidden="true">
					{ticks.map((tick) => (
						<span key={tick} className="absolute right-0 translate-y-1/2" style={{ bottom: `${height(tick)}%` }}>
							{tickText(tick)}
						</span>
					))}
				</div>
				<div className="relative h-44 border-b border-ink sm:h-52 lg:h-60">
					{ticks.slice(1).map((tick) => (
						<span key={tick} className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ bottom: `${height(tick)}%` }} aria-hidden="true" />
					))}
					{active && (
						<>
							<span className="pointer-events-none absolute -top-2 z-[2] w-px -translate-x-1/2 bg-ink" style={{ left: `${at(selected)}%`, bottom: `${height(active.value)}%` }} aria-hidden="true" />
							<span
								className="pointer-events-none absolute bottom-[calc(100%+8px)] z-[2] flex items-baseline gap-2 rounded-sm bg-ink px-2 py-1 text-[12px] leading-4 whitespace-nowrap text-page"
								style={hang(at(selected), 12)}
								aria-live="polite"
								aria-atomic="true"
								data-chart-selection=""
							>
								<span>{label(active)}</span>
								<span className="tnum font-semibold">{metricText(active.value, metric)}</span>
							</span>
						</>
					)}
					{card && (
						<div
							id={cardId}
							role="tooltip"
							className="pointer-events-none absolute top-2 z-[3] max-w-full rounded-sm border border-ink bg-page px-3 py-2 text-[12px] leading-[1.45] shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
							// Beside the pin, toward the wider side of the plot, and never past its edges.
							style={{
								width: CARD_WIDTH,
								left: `clamp(0px, calc(${at(selected)}% ${at(selected) <= 50 ? "+ 12px" : `- ${CARD_WIDTH + 12}px`}), calc(100% - ${CARD_WIDTH}px))`,
							}}
							data-chart-tooltip=""
						>
							<ul>
								{cardRows.map(({ layer, value }) => (
									<li key={layer.id} className="flex h-5 min-w-0 items-center gap-1.5" data-tooltip-layer={layer.label}>
										<span className={SWATCH} style={{ background: layer.fill }} aria-hidden="true" />
										{layer.model ? <ModelName model={layer.model} keepName className="mono flex-1" /> : <span className="min-w-0 flex-1 truncate">{layer.label}</span>}
										<span className="tnum shrink-0 pl-2 font-semibold">{valueText(value)}</span>
										<span className="tnum w-11 shrink-0 text-right text-muted">{percent(value / activeSum)}</span>
									</li>
								))}
							</ul>
						</div>
					)}
					<div
						className={cx("absolute inset-0 flex items-end", gap)}
						role="group"
						aria-label={`${METRICS.find(([key]) => key === metric)![1]} by UTC date`}
						onMouseLeave={() => setInspecting(false)}
						onFocus={() => setInspecting(true)}
						onBlur={(event) => setInspecting(event.currentTarget.contains(event.relatedTarget))}
					>
						{buckets.map((bucket, i) => (
							<button
								key={bucket.from}
								ref={(el) => {
									buttons.current[i] = el;
								}}
								type="button"
								tabIndex={i === selected ? 0 : -1}
								onClick={() => choose(i)}
								onFocus={() => choose(i)}
								onMouseEnter={() => {
									choose(i);
									setInspecting(true);
								}}
								onKeyDown={(event) => move(event, i)}
								aria-pressed={i === selected}
								aria-label={`${bucket.from}${bucket.from !== bucket.to ? ` to ${bucket.to}` : ""}: ${exactText(bucket.value, metric)}`}
								aria-describedby={card && i === selected ? cardId : undefined}
								className="group/bar relative z-[1] flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline-offset-1"
								data-usage-bar={bucket.from}
							>
								{(() => {
									const stack = parts[i];
									const sum = stack?.reduce((total, value) => total + value, 0) ?? 0;
									const barHeight = bucket.value > 0 ? `max(1px, ${height(bucket.value)}%)` : 0;
									// Unsplit, or without a breakdown (an older server, or still loading), the bar is one ink column.
									if (!stack || sum <= 0)
										return <span className="w-full max-w-10 bg-ink group-hover/bar:bg-ink/75" style={{ height: barHeight }} />;
									return (
										<span className="flex w-full max-w-10 flex-col-reverse overflow-hidden" style={{ height: barHeight }} data-usage-stack="">
											{stack.map((value, k) =>
												value > 0 ? <span key={layers[k].id} className="w-full shrink-0" style={{ height: `${(value / sum) * 100}%`, background: layers[k].fill }} data-usage-part={layers[k].label} /> : null,
											)}
										</span>
									);
								})()}
							</button>
						))}
					</div>
				</div>
				<span />
				<div className="relative h-6 text-[11px] text-muted" aria-hidden="true">
					{dates.map((tick, n) => (
						<span key={tick.index} className={cx("absolute top-0 flex flex-col", (dates.length - 1 - n) % 2 === 1 && dates.length > 5 && "max-sm:hidden")} style={hang(at(tick.index), 4)}>
							<span className={cx("h-1 w-px bg-ink", at(tick.index) < 4 ? "self-start ml-[6px]" : at(tick.index) > 96 ? "self-end mr-[6px]" : "self-center")} />
							<span className="mt-1 leading-none whitespace-nowrap">{tick.text}</span>
						</span>
					))}
				</div>
			</div>
			{layers.length > 0 && activeParts && (
				<ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]" aria-label={active ? `${label(active)} by ${byType ? "token type" : split}` : "Layers"} data-chart-legend="">
					{layers.map((s, k) => (
						<li key={s.id} className={cx("flex min-w-0 items-center gap-1.5 transition-opacity duration-150", activeParts && !activeParts[k] && "opacity-45")} data-legend={s.label}>
							<span className={SWATCH} style={{ background: s.fill }} aria-hidden="true" />
							{s.model ? <ModelName model={s.model} keepName className="mono" /> : <span className="text-muted">{s.label}</span>}
							<span className="tnum text-muted">{activeParts ? valueText(activeParts[k]) : "—"}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * One figure of the totals row, after the session header's: the number first, then what it counts, then a qualifier.
 * The label stays first in the markup, so each figure reads as a term and its value; the grid only places it.
 */
function Figure({ kpi, label, value, sub, detail, title }: { kpi: string; label: string; value: ReactNode; sub?: ReactNode; detail?: ReactNode; title?: string }) {
	return (
		<div className="grid min-w-0 content-start border-line px-4 py-4" data-kpi={kpi} title={title}>
			<dt className="row-start-2 mt-2 text-[12.5px] leading-none font-medium">{label}</dt>
			<dd className="row-start-1 flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1">
				<span className="tnum text-[24px] leading-none font-semibold tracking-[-0.02em]" data-kpi-value="">{value}</span>
				{sub && <span className="tnum text-[12px] leading-none whitespace-nowrap">{sub}</span>}
			</dd>
			<dd className="tnum row-start-3 mt-1.5 min-h-[1em] text-[12px] leading-none text-muted" aria-hidden={detail ? undefined : true}>{detail}</dd>
		</div>
	);
}

/** Hairlines between figures: a 2- or 4-up grid, each row starting flush left. */
const FIGURE_GRID =
	"grid-cols-2 lg:grid-cols-4 [&>*]:max-lg:odd:pl-0 [&>*]:max-lg:even:border-l [&>*]:max-lg:nth-[n+3]:border-t [&>*]:lg:first:pl-0 [&>*]:lg:not-first:border-l";

function Figures({ data }: { data: UsageStatistics }) {
	const { totals, daily } = data;
	const metrics: UsageRequestMetrics | undefined = data.requestMetrics;
	const tokens = totalTokens(totals.tokens);
	const cached = cacheReadShare(totals.tokens);
	const completed = metrics && completionShare(metrics);
	const estimated = totals.estimatedCost ?? 0;
	const unpriced = totals.unpricedRequests ?? 0;
	const costTitle = [
		"USD, as recorded with each call's usage",
		estimated > 0 ? `, except ${formatCost(estimated)} pika estimated from models.dev prices for calls that recorded no cost` : "",
		unpriced > 0 ? `. No price is known for ${plural(unpriced, "call")} that recorded no cost` : "",
	].join("");
	const costDetail = estimated > 0 ? `incl. ${formatCost(estimated)} estimated` : totals.activeDays > 0 && totals.cost > 0 ? `${formatCost(totals.cost / totals.activeDays)} / active day` : undefined;
	return (
		<dl className={cx("mt-7 grid border-y border-line", FIGURE_GRID)} data-usage-totals="">
			<Figure kpi="tokens" label="Tokens" value={formatCount(tokens)} detail={cached !== undefined && tokens > 0 ? `${Math.round(cached * 100)}% cache reads` : undefined} title={`${exact(tokens)} tokens: input, output, cache read, and cache write. Cache reads are a share of recorded prompt tokens.`} />
			<Figure kpi="cost" label={estimated > 0 ? "Cost" : "Recorded cost"} value={formatCost(totals.cost)} detail={costDetail} title={costTitle} />
			<Figure
				kpi="requests"
				label="Model requests"
				value={formatCount(totals.requests)}
				sub={metrics && metrics.failed > 0 ? <span className="text-red" data-kpi-errors="">{formatCount(metrics.failed)} failed</span> : undefined}
				detail={completed !== undefined ? `${percent(completed)} completed` : undefined}
				title={metrics ? `${exact(totals.requests)} recorded assistant calls: ${exact(metrics.completed)} completed, ${exact(metrics.failed)} failed, ${exact(metrics.aborted)} aborted, ${exact(metrics.unknown)} with an unknown outcome (left out of the percentage)` : `${exact(totals.requests)} recorded assistant calls, including failed calls`}
			/>
			<Figure kpi="trajectories" label="Trajectories" value={formatCount(totals.sessions)} detail={`${totals.activeDays} of ${plural(daily.length, "day")} active`} title={`${exact(totals.sessions)} trajectories with activity in the period; subagents count as their own trajectories`} />
		</dl>
	);
}

function StatisticsData({ data, split, onSplit, report, order, scope }: { data: UsageStatistics; split: Split; onSplit: (split: Split) => void; report?: UsageReport; order?: string[]; scope: ReactNode }) {
	const api = useApi();
	const { totals, daily } = data;
	const breakdowns = totals.sessions > 0 && data.projects !== undefined && data.models !== undefined;
	// The report is only used when it answers the current split; a stale one from the other split would mislabel layers.
	const current = split !== "total" && report?.by === split ? report : undefined;
	// Model layers wait for the first-use order, so their colours never change once shown.
	const series = useMemo(
		() => (current?.groups && (current.by !== "model" || order) ? splitSeries(current.groups, current.by!, api.publicView, order) : []),
		[current, order, api.publicView],
	);
	const dimension = split === "model" ? "models" : "projects";
	const empty = totals.sessions === 0;
	return (
		<>
			<Figures data={data} />
			<div className="mt-9 min-w-0" data-usage-overview="">
				<div className="min-w-0">
					{empty ? (
						<EmptyState title="No activity in this range">
							Try a longer range{data.excludeUnpublished ? " or include unpublished trajectories" : ""}. Usage will appear as trajectories are uploaded.
						</EmptyState>
					) : (
						<UsageChart daily={daily} split={split} onSplit={onSplit} report={current} series={series} />
					)}
					{scope}
				</div>
			</div>
			{!empty && (
				<>
					{breakdowns && (
						<UsageBreakdowns
							key={dimension}
							projects={data.projects!}
							models={data.models!}
							total={totalTokens(totals.tokens)}
							dimension={dimension}
							swatch={series.length ? (row) => layerOf(series, row.name)?.fill : undefined}
						/>
					)}
				</>
			)}
		</>
	);
}

function LoadingFigures() {
	return (
		<div className="mt-7" aria-busy="true" aria-label="Loading statistics">
			<Skeleton className="h-[74px] w-full" />
			<Skeleton className="mt-9 h-80 w-full" />
		</div>
	);
}

export function StatisticsPage() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const rawDays = params.get("days") ?? "30";
	const days: Range = RANGES.find(([value]) => value === rawDays)?.[0] ?? "30";
	const exclude = params.get("excludeUnpublished") === "true";
	const rawSplit = params.get("by");
	const split: Split = rawSplit === "model" || rawSplit === "project" ? rawSplit : "total";
	const statistics = useQuery({
		queryKey: ["statistics", api.publicView, days, exclude],
		queryFn: () => api.statistics(days === "all" ? "all" : Number(days), exclude),
		refetchInterval: 60_000,
		// A new range or scope keeps the current numbers, dimmed, until its own arrive, so the controls never vanish.
		placeholderData: keepPreviousData,
	});
	// The same range split for the chart's layers, only when asked for; an older server without it leaves the bars whole.
	const usage = useQuery({
		queryKey: ["usage", api.publicView, days, exclude, split],
		queryFn: () => api.usage({ days: days === "all" ? "all" : Number(days), by: split === "total" ? undefined : split, excludeUnpublished: exclude }),
		enabled: split !== "total",
		refetchInterval: 60_000,
	});
	// Every model in first-use order, so each keeps its colour in every range and scope (`modelOrder`). Only a new model
	// changes it, so it is fetched rarely; without it (an older server) layers take colours in name order.
	const order = useQuery({
		queryKey: ["model-order", api.publicView],
		queryFn: () => api.usage({ days: "all", by: "model", interval: "month", excludeUnpublished: false }),
		select: modelOrder,
		enabled: split === "model",
		staleTime: 10 * 60_000,
	});
	const change = (key: string, value: string | undefined) =>
		setParams((previous) => {
			const next = new URLSearchParams(previous);
			if (value) next.set(key, value);
			else next.delete(key);
			return next;
		}, { replace: true });
	const data = statistics.data;
	return (
		<Page className="pb-24">
			<div data-statistics-page="">
				<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
					<div className="min-w-0">
						<PageTitle>Statistics</PageTitle>
						<p className="tnum mt-1.5 text-[13px] text-muted" data-usage-range="">
							{data ? `${formatDateRange(data.from, data.to)} · ${plural(data.daily.length, "UTC day")}` : "Dates are UTC days"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<button type="button" disabled={statistics.isFetching} onClick={() => void statistics.refetch()} className={BUTTON.quiet} title="Statistics also refresh every minute">
							{statistics.isFetching && !statistics.isPending ? "Refreshing…" : "Refresh"}
						</button>
						<Segmented label="Usage period" value={days} options={RANGES} onChange={(value) => change("days", value)} />
					</div>
				</div>
				{statistics.isPending ? (
					<LoadingFigures />
				) : statistics.isError ? (
					<div className="mt-6">
						<ErrorState error={statistics.error} onRetry={() => void statistics.refetch()} />
					</div>
				) : (
					<div className={cx("transition-opacity duration-150", statistics.isPlaceholderData && "opacity-55")} aria-busy={statistics.isPlaceholderData || undefined}>
						<StatisticsData
							data={statistics.data}
							split={split}
							onSplit={(value) => change("by", value === "total" ? undefined : value)}
							report={usage.data}
							order={order.isError ? [] : order.data}
							scope={
								<div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[13px]" data-usage-scope="">
									<label className="flex cursor-pointer items-center gap-2 font-medium">
										<input type="checkbox" checked={exclude} onChange={(event) => change("excludeUnpublished", event.target.checked ? "true" : undefined)} className="size-3.5 accent-ink" />
										Exclude unpublished trajectories
									</label>
									<span className="text-[12.5px] text-muted">
										{exclude ? "Showing published, visible trajectories only." : "Includes unpublished and hidden trajectories. Only aggregate usage is public; their contents stay private."}
									</span>
								</div>
							}
						/>
					</div>
				)}
			</div>
		</Page>
	);
}
