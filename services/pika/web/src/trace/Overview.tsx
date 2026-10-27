import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../components/ui";
import { formatCost, formatCount, plural } from "../lib/format";
import type { SessionTrace } from "../lib/types";
import {
	axisTicks,
	contextSeries,
	foldGaps,
	hitTest,
	layoutOverview,
	makeScale,
	overviewLanes,
	traceIntervals,
	type Interval,
	type OverviewItem,
	type Scale,
} from "./axis";
import { formatClock, formatClockTime, formatElapsed, formatGap, formatSpan, plainLine } from "./format";
import { recordDuration, recordName, recordSummary, type Family } from "./kinds";
import { KindBadge } from "./parts";

const FAMILY_VARS: Record<Family | "turn" | "error" | "thinking", string> = {
	user: "--color-k-user",
	turn: "--color-k-user",
	llm: "--color-k-llm",
	thinking: "--color-k-thinking",
	shell: "--color-k-shell",
	read: "--color-k-read",
	write: "--color-k-write",
	other: "--color-k-other",
	agent: "--color-k-agent",
	compaction: "--color-k-compaction",
	error: "--color-k-error",
};

type Palette = Record<keyof typeof FAMILY_VARS | "ink" | "muted" | "line" | "page" | "accent", string>;

function readPalette(): Palette {
	const style = getComputedStyle(document.documentElement);
	const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	const palette = {
		ink: read("--color-ink", "#37352f"),
		muted: read("--color-muted", "#787774"),
		line: read("--color-line", "rgba(55,53,47,0.09)"),
		page: read("--color-page", "#ffffff"),
		accent: read("--color-accent", "#2383e2"),
	} as Palette;
	for (const [key, variable] of Object.entries(FAMILY_VARS)) palette[key as keyof typeof FAMILY_VARS] = read(variable, "#888888");
	return palette;
}

/** jsdom has no canvas; drawing is skipped there and the DOM stays fully usable. */
function context2d(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
	if (!canvas || /jsdom/i.test(navigator.userAgent)) return null;
	try {
		return canvas.getContext("2d");
	} catch {
		return null;
	}
}

/** Follows `<html data-theme>`, so the canvas repaints with the theme. */
function useThemeVersion(): number {
	const [version, setVersion] = useState(0);
	useEffect(() => {
		const observer = new MutationObserver(() => setVersion((v) => v + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return version;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width) || element.clientWidth || 800);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): number {
	const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
	const w = Math.round(width * dpr);
	const h = Math.round(height * dpr);
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;
	return dpr;
}

function alpha(color: string, a: number): string {
	// Hex colors from the theme get an alpha; anything else is drawn with globalAlpha by the caller.
	const hex = /^#([0-9a-f]{6})$/i.exec(color);
	if (!hex) return color;
	return `${color}${Math.round(a * 255)
		.toString(16)
		.padStart(2, "0")}`;
}

function drawBase(
	ctx: CanvasRenderingContext2D,
	items: OverviewItem[],
	trace: SessionTrace,
	scale: Scale,
	lanes: ReturnType<typeof overviewLanes>,
	palette: Palette,
	height: number,
	compact: boolean,
) {
	ctx.clearRect(0, 0, scale.width, height);
	const lane = Object.fromEntries(lanes.map((l) => [l.lane, l]));

	// Lane baselines.
	ctx.fillStyle = palette.line;
	for (const l of lanes) ctx.fillRect(0, Math.round(l.y1) + 0.5, scale.width, 1);

	// Context size behind the LLM lane: a step area that grows with each call and drops at compactions.
	const series = contextSeries(trace, scale);
	const max = series.reduce((m, p) => Math.max(m, p.value), 0);
	if (max > 0 && series.length > 1) {
		const top = lane.llm.y0 + 1;
		const bottom = lane.llm.y1;
		const y = (value: number) => bottom - (value / max) * (bottom - top);
		ctx.beginPath();
		ctx.moveTo(series[0].x, bottom);
		let last = series[0].value;
		ctx.lineTo(series[0].x, y(last));
		for (const point of series.slice(1)) {
			ctx.lineTo(point.x, y(last));
			ctx.lineTo(point.x, y(point.value));
			last = point.value;
		}
		ctx.lineTo(scale.width, y(last));
		ctx.lineTo(scale.width, bottom);
		ctx.closePath();
		ctx.fillStyle = alpha(palette.llm, 0.09);
		ctx.fill();
		ctx.beginPath();
		ctx.moveTo(series[0].x, y(series[0].value));
		last = series[0].value;
		for (const point of series.slice(1)) {
			ctx.lineTo(point.x, y(last));
			ctx.lineTo(point.x, y(point.value));
			last = point.value;
		}
		ctx.lineTo(scale.width, y(last));
		ctx.strokeStyle = alpha(palette.llm, 0.32);
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	ctx.font = `${compact ? 9 : 10}px ui-sans-serif, -apple-system, "Segoe UI", sans-serif`;
	ctx.textBaseline = "middle";
	for (const item of items) {
		const w = Math.max(1, item.x1 - item.x0);
		const h = item.y1 - item.y0;
		if (item.lane === "turns") {
			const even = (item.turnIndex ?? 0) % 2 === 0;
			ctx.fillStyle = alpha(palette.user, even ? 0.16 : 0.09);
			ctx.fillRect(item.x0, item.y0, w, h);
			ctx.fillStyle = palette.user;
			ctx.fillRect(item.x0, item.y0, 1.5, h);
			if (w > 24 && !compact) {
				ctx.fillStyle = palette.user;
				const label = `#${(item.turnIndex ?? 0) + 1}`;
				ctx.save();
				ctx.beginPath();
				ctx.rect(item.x0, item.y0, w - 2, h);
				ctx.clip();
				ctx.fillText(label, item.x0 + 5, (item.y0 + item.y1) / 2 + 0.5);
				ctx.restore();
			}
			continue;
		}
		if (item.record?.kind === "compaction" || item.record?.kind === "branch-summary") {
			ctx.fillStyle = alpha(palette.compaction, 0.9);
			ctx.fillRect(Math.round(item.x0 + 1), item.y0, 1.5, h);
			ctx.beginPath();
			const cx = item.x0 + 1.75;
			ctx.moveTo(cx, item.y0 - 1);
			ctx.lineTo(cx + 3.5, item.y0 + 3);
			ctx.lineTo(cx, item.y0 + 7);
			ctx.lineTo(cx - 3.5, item.y0 + 3);
			ctx.closePath();
			ctx.fill();
			continue;
		}
		if (item.lane === "agents") {
			ctx.fillStyle = alpha(palette.agent, 0.28);
			ctx.fillRect(item.x0, item.y0, w, h);
			ctx.fillStyle = palette.agent;
			ctx.fillRect(item.x0, item.y0, Math.min(w, 2), h);
			continue;
		}
		const color = item.error ? palette.error : palette[item.family as Family];
		ctx.fillStyle = alpha(color, item.error ? 0.95 : item.lane === "llm" ? 0.62 : 0.85);
		ctx.fillRect(item.x0, item.y0, w, h);
		if (item.record?.kind === "llm" && item.record.thinking && w >= 6) {
			ctx.fillStyle = palette.thinking;
			ctx.fillRect(item.x0, item.y0, Math.min(4, w * 0.3), h);
		}
	}

	// Error ticks along the top edge.
	ctx.fillStyle = palette.error;
	for (const item of items) {
		if (!item.error || item.lane === "turns") continue;
		const x = (item.x0 + item.x1) / 2;
		ctx.beginPath();
		ctx.moveTo(x - 3, 0);
		ctx.lineTo(x + 3, 0);
		ctx.lineTo(x, 4);
		ctx.closePath();
		ctx.fill();
	}

	// Folded gaps: a blank break with two slanted strokes.
	for (const { x0, x1 } of scale.breaks()) {
		ctx.fillStyle = palette.page;
		ctx.fillRect(x0 + 1, 0, Math.max(0, x1 - x0 - 2), height);
		ctx.strokeStyle = palette.muted;
		ctx.globalAlpha = 0.55;
		ctx.lineWidth = 1;
		const mid = (x0 + x1) / 2;
		for (const dx of [-2.5, 2.5]) {
			ctx.beginPath();
			ctx.moveTo(mid + dx - 3, height - 2);
			ctx.lineTo(mid + dx + 3, 2);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	}
}

function drawOverlay(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	palette: Palette,
	hovered: OverviewItem | undefined,
	selected: OverviewItem | undefined,
) {
	ctx.clearRect(0, 0, width, height);
	const outline = (item: OverviewItem, color: string, lineWidth: number) => {
		ctx.strokeStyle = color;
		ctx.lineWidth = lineWidth;
		const pad = lineWidth;
		ctx.strokeRect(item.x0 - pad, item.y0 - pad, Math.max(1, item.x1 - item.x0) + pad * 2, item.y1 - item.y0 + pad * 2);
	};
	if (selected) {
		ctx.fillStyle = alpha(palette.accent, 0.08);
		ctx.fillRect(Math.min(selected.x0, selected.x1 - 1) - 0.5, 0, Math.max(1, selected.x1 - selected.x0) + 1, height);
		outline(selected, palette.accent, 1.5);
	}
	if (hovered && hovered !== selected) outline(hovered, palette.ink, 1);
}

export interface OverviewProps {
	trace: SessionTrace;
	compact?: boolean;
	selectedKey?: string;
	hoveredKey?: string;
	onHover?: (key: string | undefined) => void;
	onSelect?: (item: OverviewItem) => void;
	range?: Interval;
	onRange?: (range: Interval | undefined) => void;
	/** The time range the ledger shows right now. */
	viewport?: Interval;
	/** Replay playhead, in active ms, and a scrub handler. */
	playhead?: number;
	onScrub?: (position: number) => void;
	/** Called with the scale whenever it changes, so replay can map positions to time. */
	onScale?: (scale: Scale) => void;
}

const LANE_LABEL_WIDTH = 52;

export function Overview({
	trace,
	compact = false,
	selectedKey,
	hoveredKey,
	onHover,
	onSelect,
	range,
	onRange,
	viewport,
	playhead,
	onScrub,
	onScale,
}: OverviewProps) {
	const plotRef = useRef<HTMLDivElement>(null);
	const baseRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	const width = useWidth(plotRef);
	const theme = useThemeVersion();
	const lanes = useMemo(() => overviewLanes(compact), [compact]);
	const height = lanes[lanes.length - 1].y1 + (compact ? 3 : 5);
	const axis = useMemo(() => foldGaps(traceIntervals(trace)), [trace]);
	const scale = useMemo(() => makeScale(axis, Math.max(1, width)), [axis, width]);
	const items = useMemo(() => layoutOverview(trace, scale, lanes), [trace, scale, lanes]);
	const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
	const breaks = useMemo(() => scale.breaks(), [scale]);
	const ticks = useMemo(() => {
		if (width <= 0) return [];
		// Gap labels take precedence over ticks near them.
		const centers = breaks.map(({ x0, x1 }) => (x0 + x1) / 2);
		return axisTicks(scale, compact ? 90 : 72).filter((tick) => centers.every((center) => Math.abs(tick.x - center) > 34) && tick.x < width - 18);
	}, [scale, breaks, width, compact]);
	const [hover, setHover] = useState<{ item: OverviewItem; x: number; y: number } | undefined>();
	const [brush, setBrush] = useState<{ x0: number; x1: number } | undefined>();
	const drag = useRef<{ x0: number; moved: boolean; scrub: boolean } | null>(null);

	useEffect(() => onScale?.(scale), [scale, onScale]);

	useEffect(() => {
		const canvas = baseRef.current;
		const ctx = context2d(canvas);
		if (!canvas || !ctx || width <= 0) return;
		const dpr = sizeCanvas(canvas, width, height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawBase(ctx, items, trace, scale, lanes, readPalette(), height, compact);
	}, [items, trace, scale, lanes, height, width, theme, compact]);

	const hovered = hover?.item ?? (hoveredKey ? byKey.get(hoveredKey) : undefined);
	const selected = selectedKey ? byKey.get(selectedKey) : undefined;
	useEffect(() => {
		const canvas = overlayRef.current;
		const ctx = context2d(canvas);
		if (!canvas || !ctx || width <= 0) return;
		const dpr = sizeCanvas(canvas, width, height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawOverlay(ctx, width, height, readPalette(), hovered, selected);
	}, [hovered, selected, width, height, theme]);

	const point = (event: ReactPointerEvent<HTMLElement>) => {
		const rect = plotRef.current!.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};

	const playheadX = playhead !== undefined ? scale.x(scale.timeAt(playhead)) : undefined;

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		const { x } = point(event);
		const scrub = playheadX !== undefined && Math.abs(x - playheadX) <= 6 && onScrub !== undefined;
		drag.current = { x0: x, moved: false, scrub };
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const { x, y } = point(event);
		const current = drag.current;
		if (current) {
			if (Math.abs(x - current.x0) > 3) current.moved = true;
			if (current.scrub) {
				onScrub?.(scale.position(scale.time(Math.max(0, Math.min(width, x)))));
				return;
			}
			if (current.moved && onRange) setBrush({ x0: current.x0, x1: Math.max(0, Math.min(width, x)) });
			return;
		}
		const item = hitTest(items, x, y - 0);
		setHover(item ? { item, x, y } : undefined);
		if (item?.key !== hover?.item.key) onHover?.(item?.key);
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		drag.current = null;
		if (!current) return;
		const { x, y } = point(event);
		if (current.scrub) return;
		if (current.moved && onRange) {
			const a = Math.min(current.x0, x);
			const b = Math.max(current.x0, x);
			setBrush(undefined);
			onRange({ start: scale.time(a), end: scale.time(b) });
			return;
		}
		const item = hitTest(items, x, y);
		if (item) onSelect?.(item);
	};

	const leave = useCallback(() => {
		setHover(undefined);
		onHover?.(undefined);
	}, [onHover]);

	// The text alternative; computed per trace, not per replay frame.
	const label = useMemo(() => {
		let llmCount = 0;
		let toolCount = 0;
		for (const record of trace.records) {
			if (record.kind === "llm") llmCount++;
			else if (record.kind === "tool") toolCount++;
		}
		return `Session timeline: ${plural(trace.turns.length, "turn")}, ${plural(llmCount, "model call")}, ${plural(toolCount, "tool call")}, ${formatSpan(
			axis.activeMs,
		)} active${axis.gaps.length ? `, ${plural(axis.gaps.length, "idle gap")} folded` : ""}.`;
	}, [trace, axis]);

	const rangeBox = range ? { x0: scale.x(range.start), x1: scale.x(range.end) } : undefined;
	const viewBox = viewport && !compact ? { x0: scale.x(viewport.start), x1: Math.max(scale.x(viewport.start) + 2, scale.x(viewport.end)) } : undefined;

	return (
		<div className="flex select-none" data-overview="" data-compact={compact || undefined} role="group" aria-label={label}>
			<div className="relative shrink-0 text-[10.5px] text-muted" style={{ width: LANE_LABEL_WIDTH }} aria-hidden="true">
				<div style={{ height: compact ? 16 : 18 }} />
				<div className="relative" style={{ height }}>
					{lanes.map((lane) => (
						<div key={lane.lane} className="absolute right-3 leading-none" style={{ top: (lane.y0 + lane.y1) / 2 - 5 }}>
							{lane.label}
						</div>
					))}
				</div>
			</div>
			<div ref={plotRef} className="relative min-w-0 flex-1">
				<div className="relative overflow-hidden" style={{ height: compact ? 16 : 18 }} aria-hidden="true">
					{ticks.map((tick, i) => (
						<span
							key={i}
							className="mono tnum absolute top-0 text-[10.5px] leading-none text-muted"
							style={{ left: tick.x, transform: i === 0 ? undefined : "translateX(-50%)" }}
						>
							{formatClock(tick.elapsed)}
						</span>
					))}
					{breaks.map(({ x0, x1, gap }) => (
						<span
							key={gap.start}
							className="tnum absolute top-0 -translate-x-1/2 rounded-sm bg-page px-1 text-[10px] leading-none whitespace-nowrap text-muted italic"
							style={{ left: (x0 + x1) / 2 }}
							title={`Idle for ${formatGap(gap.end - gap.start)}, folded`}
							data-gap=""
						>
							{formatGap(gap.end - gap.start)}
						</span>
					))}
				</div>
				<div
					className={cx("relative", onSelect && "cursor-crosshair")}
					style={{ height }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerLeave={leave}
					data-overview-plot=""
				>
					{ticks.map((tick, i) => (
						<span key={i} aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-line" style={{ left: Math.round(tick.x) }} />
					))}
					<canvas ref={baseRef} className="absolute inset-0" aria-hidden="true" />
					<canvas ref={overlayRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
					{viewBox && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0"
							style={{ left: viewBox.x0, width: Math.max(3, viewBox.x1 - viewBox.x0) }}
							data-viewport=""
						>
							<div className="absolute inset-0 bg-ink/[0.025]" />
							<div className="absolute inset-x-0 -bottom-[5px] h-[3px] rounded-full bg-ink/30" />
						</div>
					)}
					{rangeBox && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 border-x border-accent bg-accent-soft"
							style={{ left: rangeBox.x0, width: Math.max(2, rangeBox.x1 - rangeBox.x0) }}
							data-range=""
						/>
					)}
					{brush && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 border-x border-accent/70 bg-accent-soft"
							style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0) }}
						/>
					)}
					{playheadX !== undefined && (
						<div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 bg-page/60" style={{ left: playheadX }} />
					)}
					{playheadX !== undefined && (
						<div className="pointer-events-none absolute -top-[18px] bottom-0" style={{ left: playheadX }} data-playhead="">
							<div className="absolute top-0 bottom-0 -ml-px w-[2px] bg-ink/80" />
							<div className="absolute top-[8px] -ml-[5px] size-[10px] rounded-full border-2 border-page bg-ink shadow-sm" />
						</div>
					)}
					{hover && <OverviewTooltip item={hover.item} x={hover.x} y={hover.y} width={width} origin={axis.origin} trace={trace} />}
				</div>
			</div>
		</div>
	);
}

function OverviewTooltip({ item, x, y, width, origin, trace }: { item: OverviewItem; x: number; y: number; width: number; origin: number; trace: SessionTrace }) {
	const left = Math.min(Math.max(0, x + 12), Math.max(0, width - 280));
	const record = item.record;
	const turn = item.turnIndex !== undefined ? trace.turns.find((candidate) => candidate.index === item.turnIndex) : undefined;
	const child = item.childId ? trace.children.find((candidate) => candidate.sessionId === item.childId) : undefined;
	return (
		<div
			role="tooltip"
			className="pointer-events-none absolute z-20 w-[268px] rounded-md border border-line bg-page px-3 py-2 text-[12px] leading-[1.45] shadow-[0_4px_16px_rgba(15,15,15,0.12)]"
			style={{ left, top: y + 14 }}
			data-overview-tooltip=""
		>
			{record ? (
				<>
					<div className="flex min-w-0 items-center gap-2">
						<KindBadge record={record} />
						<span className="min-w-0 truncate font-medium">{recordName(record)}</span>
					</div>
					{recordSummary(record) && <div className="mt-1 line-clamp-2 text-muted [overflow-wrap:anywhere]">{recordSummary(record)}</div>}
					<div className="tnum mt-1 flex flex-wrap gap-x-3 text-muted">
						<span>{formatClockTime(item.start)}</span>
						<span className="mono text-[11px]">{formatElapsed(item.start - origin)}</span>
						<span>{formatSpan(recordDuration(record))}</span>
						{record.kind === "llm" && (
							<span>
								{formatCount(record.input + record.cacheRead + record.cacheWrite)}→{formatCount(record.output)} · {formatCost(record.cost)}
							</span>
						)}
					</div>
				</>
			) : item.lane === "turns" ? (
				<>
					<div className="flex min-w-0 items-center gap-2">
						<KindBadge family="user" label={`#${(item.turnIndex ?? 0) + 1}`} />
						<span className="min-w-0 truncate font-medium">{turn ? plainLine(turn.userText) : "Turn"}</span>
					</div>
					<div className="tnum mt-1 flex flex-wrap gap-x-3 text-muted">
						<span>{formatClockTime(item.start)}</span>
						<span>{formatSpan((item.end ?? item.start) - item.start)}</span>
						{turn && (
							<span>
								{turn.modelCalls} LLM · {plural(turn.toolCalls, "tool")} · {formatCost(turn.cost)}
							</span>
						)}
					</div>
				</>
			) : (
				<>
					<div className="flex min-w-0 items-center gap-2">
						<KindBadge family="agent" label="AGENT" />
						<span className="min-w-0 truncate font-medium">{child?.agentType ?? "Subagent"}</span>
					</div>
					{child?.description && <div className="mt-1 line-clamp-2 text-muted">{child.description}</div>}
					<div className="tnum mt-1 text-muted">{formatSpan((item.end ?? item.start) - item.start)}</div>
				</>
			)}
		</div>
	);
}
