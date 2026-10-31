import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../components/ui";
import { COST_DIAMETERS, costStep, formatCost, formatCount, plural } from "../lib/format";
import type { SessionTrace } from "../lib/types";
import {
	axisTicks,
	centreWindow,
	clampWindow,
	foldGaps,
	hitTest,
	isFullWindow,
	layoutOverview,
	makeScale,
	MIN_WINDOW_MS,
	overviewLanes,
	panWindow,
	providerY,
	tickStep,
	traceIntervals,
	trunkY,
	windowAxis,
	zoomWindow,
	type Axis,
	type Interval,
	type LaneBox,
	type OverviewItem,
	type Scale,
} from "./axis";
import { formatClockTime, formatElapsed, formatGap, formatPhase, formatSpan, formatTick, plainLine } from "./format";
import { hasProviderTiming, recordDuration, recordKey, recordName, recordSpan, recordSummary, type Family } from "./kinds";
import { KindBadge, KindBullet } from "./parts";

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

type Palette = Record<keyof typeof FAMILY_VARS | "ink" | "muted" | "line" | "page" | "agentInk" | "compactionInk", string>;

function readPalette(): Palette {
	const style = getComputedStyle(document.documentElement);
	const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	const palette = {
		ink: read("--color-ink", "#0b0b0b"),
		muted: read("--color-muted", "#5e5e5e"),
		line: read("--color-line", "#e1e1e1"),
		page: read("--color-page", "#ffffff"),
		agentInk: read("--color-k-agent-ink", "#0b0b0b"),
		compactionInk: read("--color-k-compaction-ink", "#ffffff"),
	} as Palette;
	for (const [key, variable] of Object.entries(FAMILY_VARS)) palette[key as keyof typeof FAMILY_VARS] = read(variable, "#888888");
	return palette;
}

const CANVAS_FONT = `"Aileron", "Helvetica Neue", Helvetica, Arial, sans-serif`;

let measurer: CanvasRenderingContext2D | null | undefined;

/** The width of a clock-row label, measured on a canvas in the row's face; an estimate where there is no canvas (tests). */
function labelWidth(text: string, size: number, italic = false): number {
	if (measurer === undefined) measurer = typeof document === "undefined" ? null : (document.createElement("canvas").getContext("2d") ?? null);
	if (!measurer) return text.length * size * 0.6;
	measurer.font = `${italic ? "italic " : ""}400 ${size}px ${CANVAS_FONT}`;
	return measurer.measureText(text).width;
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

/** Follows `<html data-theme>` and the web font arriving, so the canvas repaints with both. */
function usePaintVersion(): number {
	const [version, setVersion] = useState(0);
	useEffect(() => {
		const observer = new MutationObserver(() => setVersion((v) => v + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		let alive = true;
		document.fonts?.ready.then(() => alive && setVersion((v) => v + 1)).catch(() => {});
		return () => {
			alive = false;
			observer.disconnect();
		};
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

/** A round bullet with its letter, the strip map's mark for compactions and branch lines. */
function bullet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, ink: string, letter: string, page: string) {
	ctx.beginPath();
	ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
	ctx.fillStyle = page;
	ctx.fill();
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.fillStyle = ink;
	ctx.font = `600 ${Math.round(r * 1.25)}px ${CANVAS_FONT}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(letter, x, y + 0.5);
	ctx.textAlign = "left";
}

/** A model call's bar thickness: its cost on the fixed four-step magnitude ramp, a pixel thinner in compact mode. */
function llmThickness(item: OverviewItem, compact: boolean): number {
	const step = item.record?.kind === "llm" ? costStep(item.record.cost, "record") : 0;
	return COST_DIAMETERS[step] - (compact ? 1 : 0);
}

/** A provider bar's thickness. */
function providerThickness(compact: boolean): number {
	return compact ? 5 : 6;
}

/** The rectangle a record, turn, or branch is painted in, for the hover and selection outlines. */
function drawnBox(item: OverviewItem, compact: boolean, lanes: LaneBox[]): { x0: number; x1: number; y0: number; y1: number } {
	const trunk = trunkY(lanes);
	if (item.lane === "provider") {
		const mid = providerY(lanes) ?? (item.y0 + item.y1) / 2;
		const half = providerThickness(compact) / 2;
		return { x0: item.x0, x1: item.x1, y0: mid - half, y1: mid + half };
	}
	if (item.record?.kind === "llm") {
		const half = llmThickness(item, compact) / 2;
		return { x0: item.x0, x1: item.x1, y0: trunk - half, y1: trunk + half };
	}
	if (item.lane === "agents") {
		const mid = (item.y0 + item.y1) / 2;
		return { x0: item.x0 - 6, x1: Math.max(item.x0 + 6, item.x1), y0: mid - 6, y1: mid + 6 };
	}
	return item;
}

/** The tool families in the order a dense column stacks them, from the bottom. */
const STACK: Family[] = ["shell", "read", "write", "other", "agent"];

/** A small red marker pointing down at a failed call's bar; the one error mark besides the bar's own colour. */
function errorMarker(ctx: CanvasRenderingContext2D, x: number, tip: number, color: string) {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(x - 3, tip - 4);
	ctx.lineTo(x + 3, tip - 4);
	ctx.lineTo(x, tip);
	ctx.closePath();
	ctx.fill();
}

/** An open arrowhead at the end of a line from (x0, y0) to (x1, y1). */
function arrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, size: number) {
	const angle = Math.atan2(y1 - y0, x1 - x0);
	ctx.beginPath();
	ctx.moveTo(x1 - size * Math.cos(angle - 0.5), y1 - size * Math.sin(angle - 0.5));
	ctx.lineTo(x1, y1);
	ctx.lineTo(x1 - size * Math.cos(angle + 0.5), y1 - size * Math.sin(angle + 0.5));
	ctx.stroke();
}

/** A call wide enough on the provider row for its sequence-diagram connectors. */
const CONNECTOR_MIN_PX = 14;

/**
 * The provider's side of each timed model call, opposite the model-call row as two lifelines of a sequence diagram:
 * a dashed lifeline, then each call as a hatched, pale bar while it waited for the first token and a solid one while it
 * streamed. Calls wide enough get the request going up at its start, the first token coming back down, and a tick
 * where the headers arrived; thin calls get only the bar, so dense sessions stay calm.
 */
function drawProvider(ctx: CanvasRenderingContext2D, items: OverviewItem[], lanes: LaneBox[], palette: Palette, scale: Scale, compact: boolean) {
	const mid = providerY(lanes);
	if (mid === undefined) return;
	const trunk = trunkY(lanes);
	const half = providerThickness(compact) / 2;
	const top = mid - half;
	const bottom = mid + half;
	const bars = items.filter((item) => item.lane === "provider" && item.phases).sort((a, b) => Number(a.error) - Number(b.error));
	const llmBars = new Map(items.filter((item) => item.lane === "llm" && item.phases).map((item) => [item.key, item]));
	// A phase's x, kept on its call's bar.
	const x = (t: number, item: OverviewItem) => Math.max(item.x0, Math.min(item.x1, scale.x(t)));

	ctx.strokeStyle = palette.muted;
	ctx.globalAlpha = 0.5;
	ctx.lineWidth = 1;
	ctx.setLineDash([2, 3]);
	ctx.beginPath();
	ctx.moveTo(0, Math.round(mid) + 0.5);
	ctx.lineTo(scale.width, Math.round(mid) + 0.5);
	ctx.stroke();
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;

	for (const item of bars) {
		const color = item.error ? palette.error : palette.llm;
		const first = x(item.phases!.firstToken, item);
		const waiting = first - item.x0;
		// Waiting: the page cut out under it so the lifeline does not run through, then a pale fill and a hatch.
		if (waiting > 0) {
			ctx.fillStyle = palette.page;
			ctx.fillRect(item.x0, top, waiting, bottom - top);
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.22;
			ctx.fillRect(item.x0, top, waiting, bottom - top);
			ctx.globalAlpha = 1;
			if (waiting >= 4) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(item.x0, top, waiting, bottom - top);
				ctx.clip();
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				ctx.beginPath();
				for (let hx = item.x0 - (bottom - top); hx < first; hx += 3.5) {
					ctx.moveTo(hx, bottom);
					ctx.lineTo(hx + (bottom - top), top);
				}
				ctx.stroke();
				ctx.restore();
			}
		}
		ctx.fillStyle = color;
		ctx.fillRect(first, top, Math.max(1, item.x1 - first), bottom - top);
	}

	ctx.strokeStyle = palette.ink;
	ctx.fillStyle = palette.ink;
	ctx.lineWidth = 1;
	const slant = compact ? 2 : 3;
	for (const item of bars) {
		if (item.x1 - item.x0 < CONNECTOR_MIN_PX) continue;
		const llm = llmBars.get(item.key);
		const below = trunk - (llm ? llmThickness(llm, compact) : 4) / 2;
		const { request, headers, firstToken } = item.phases!;
		const up = Math.min(item.x1 - slant, x(request, item));
		const down = Math.min(item.x1 - slant, x(firstToken, item));
		ctx.globalAlpha = 0.75;
		ctx.beginPath();
		ctx.moveTo(up, below);
		ctx.lineTo(up + slant, bottom + 0.5);
		ctx.moveTo(down, bottom + 0.5);
		ctx.lineTo(down + slant, below);
		ctx.stroke();
		if (!compact) {
			arrowHead(ctx, up, below, up + slant, bottom + 0.5, 3.5);
			arrowHead(ctx, down, bottom + 0.5, down + slant, below, 3.5);
		}
		ctx.globalAlpha = 1;
		if (headers !== undefined) {
			const hx = Math.round(x(headers, item));
			ctx.fillRect(hx - 0.5, top - (compact ? 2 : 3), 1, bottom - top + (compact ? 2 : 3));
		}
	}
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
	const lane = Object.fromEntries(lanes.map((l) => [l.lane, l])) as Record<OverviewItem["lane"], (typeof lanes)[number]>;
	const trunk = trunkY(lanes);
	const branchY = (lane.agents.y0 + lane.agents.y1) / 2;
	const children = new Map(trace.children.map((child) => [child.sessionId, child]));
	const turns = items.filter((item) => item.lane === "turns");
	const llms = items.filter((item) => item.lane === "llm" && item.record?.kind === "llm");
	const tools = items.filter((item) => item.lane === "tools");
	const marks = items.filter((item) => item.record?.kind === "compaction" || item.record?.kind === "branch-summary");

	// Stations: each turn opens a station, numbered where the number fits clear of the last one. Turns too close to
	// number join the station before them, so on a dense session a station stands for a run of turns.
	ctx.font = `600 ${compact ? 9 : 10.5}px ${CANVAS_FONT}`;
	ctx.textBaseline = "middle";
	const stations: { x0: number; x1: number; text: string; error: boolean; labelled: boolean; cut: boolean }[] = [];
	const windowStart = scale.axis.segments[0].start;
	let labelEnd = Number.NEGATIVE_INFINITY;
	for (const item of turns) {
		const text = String((item.turnIndex ?? 0) + 1);
		const w = compact ? 0 : ctx.measureText(text).width;
		const last = stations[stations.length - 1];
		const opens = !last || (compact ? item.x0 - last.x0 >= 10 : item.x0 + 3 > labelEnd + 6);
		if (!opens) {
			last.x1 = Math.max(last.x1, item.x1);
			continue;
		}
		const labelled = !compact && item.x0 + 3 + w <= scale.width;
		stations.push({ x0: item.x0, x1: item.x1, text, error: item.error, labelled, cut: item.start < windowStart });
		if (labelled) labelEnd = item.x0 + 3 + w;
	}

	// Every other station is tinted behind all the rows, so where one turn ends and the next begins reads at a glance.
	const bandBottom = lane.agents.y1 + 2;
	ctx.fillStyle = palette.ink;
	ctx.globalAlpha = 0.055;
	stations.forEach((station, i) => {
		if (i % 2 === 1) ctx.fillRect(station.x0, 0, Math.max(1, station.x1 - station.x0), bandBottom);
	});
	ctx.globalAlpha = 1;

	// Each turn's extent in the prompt colour, a pixel short of the next so adjacent turns stay apart.
	const barTop = compact ? lane.turns.y1 - 4 : lane.turns.y1 - 6;
	ctx.fillStyle = palette.user;
	for (const item of turns) {
		const w = item.x1 - item.x0;
		ctx.fillRect(item.x0, barTop, Math.max(1, w >= 4 ? w - 1 : w), lane.turns.y1 - barTop);
	}
	// A turn that began before a zoomed window has no station rule at its edge, only its number.
	ctx.fillStyle = palette.ink;
	for (const station of stations) if (!station.cut) ctx.fillRect(Math.round(station.x0) - 0.5, lane.turns.y0, 1.5, lane.turns.y1 - lane.turns.y0);

	// The trunk: a thin line through the model-call row, broken where idle time is folded. A break too narrow for its
	// "//" mark, or too close to the last one, is left unmarked; the clock row still names the gap.
	ctx.fillStyle = palette.ink;
	ctx.fillRect(0, trunk - 0.5, scale.width, 1);
	let lastBreak = Number.NEGATIVE_INFINITY;
	for (const { x0, x1 } of scale.breaks()) {
		if (x1 - x0 < 10 || x0 - lastBreak < 24) continue;
		lastBreak = x1;
		ctx.fillStyle = palette.page;
		ctx.fillRect(x0 + 1, 0, Math.max(0, x1 - x0 - 2), bandBottom);
		ctx.strokeStyle = palette.ink;
		ctx.lineWidth = 1.5;
		const mid = (x0 + x1) / 2;
		for (const dx of [-2.5, 2.5]) {
			ctx.beginPath();
			ctx.moveTo(mid + dx - 3, trunk + 6);
			ctx.lineTo(mid + dx + 3, trunk - 6);
			ctx.stroke();
		}
	}

	// Station numbers go on after the breaks, so a folded gap never cuts one.
	for (const station of stations) {
		if (!station.labelled) continue;
		ctx.fillStyle = station.error ? palette.error : palette.ink;
		ctx.fillText(station.text, station.x0 + 3, (lane.turns.y0 + barTop) / 2 + 0.5);
	}

	// Branch lines: each child leaves the trunk where it started and runs as long as it worked. Subagents are the
	// agent kind and take its line colour; Herder steps are not a record kind, so their branches are ink.
	const branches = items.filter((item) => item.lane === "agents").sort((a, b) => a.x0 - b.x0);
	const isStep = (item: OverviewItem) => (item.childId ? children.get(item.childId)?.kind === "herder-step" : false);
	ctx.lineWidth = compact ? 1.5 : 2;
	ctx.lineCap = "round";
	for (const item of branches) {
		const r = 4;
		ctx.strokeStyle = isStep(item) ? palette.ink : palette.agent;
		ctx.beginPath();
		ctx.moveTo(item.x0, trunk);
		ctx.lineTo(item.x0, branchY - r);
		ctx.quadraticCurveTo(item.x0, branchY, item.x0 + r, branchY);
		ctx.lineTo(Math.max(item.x0 + r, item.x1), branchY);
		ctx.stroke();
	}
	ctx.lineCap = "butt";

	// Model calls: bars along the trunk as long as they ran, as thick as they cost. Cheap ones first so the costly stay
	// on top, and failures last so their red is never covered.
	const byWeight = [...llms].sort((a, b) => Number(a.error) - Number(b.error) || llmThickness(a, compact) - llmThickness(b, compact));
	for (const item of byWeight) {
		const t = llmThickness(item, compact);
		ctx.fillStyle = item.error ? palette.error : palette.llm;
		ctx.fillRect(item.x0, trunk - t / 2, item.x1 - item.x0, t);
	}

	drawProvider(ctx, items, lanes, palette, scale, compact);

	// Tool calls: bars on their overlap rows, in their kind's colour. Where there are more calls than about one per two
	// pixels the rows would only show whichever call was drawn last, so the row becomes a column per two pixels, stacked
	// by each kind's share of the time there instead.
	const dense = tools.length > scale.width / 2;
	if (!dense) {
		for (const item of [...tools].sort((a, b) => Number(a.error) - Number(b.error))) {
			ctx.fillStyle = item.error ? palette.error : palette[item.family as Family];
			ctx.fillRect(item.x0, item.y0, item.x1 - item.x0, item.y1 - item.y0);
		}
	} else {
		const bucket = 2;
		const columns = new Map<number, Map<Family | "error", number>>();
		for (const item of tools) {
			const key = item.error ? "error" : (item.family as Family);
			for (let b = Math.floor(item.x0 / bucket); b * bucket < item.x1; b++) {
				const cover = Math.min(item.x1, (b + 1) * bucket) - Math.max(item.x0, b * bucket);
				const column = columns.get(b) ?? new Map<Family | "error", number>();
				column.set(key, (column.get(key) ?? 0) + Math.max(0.25, cover));
				columns.set(b, column);
			}
		}
		// A column with a failure in it is capped in red, whatever the failure's share of the time.
		const cap = 3;
		const top = lane.tools.y0;
		for (const [b, column] of columns) {
			const failed = column.has("error");
			const span = lane.tools.y1 - top - (failed ? cap : 0);
			let total = 0;
			for (const [family, weight] of column) if (family !== "error") total += weight;
			let y = lane.tools.y1;
			for (const family of STACK) {
				const weight = column.get(family);
				if (!weight) continue;
				const h = (weight / total) * span;
				ctx.fillStyle = palette[family];
				ctx.fillRect(b * bucket, y - h, bucket, h);
				y -= h;
			}
			if (failed) {
				ctx.fillStyle = palette.error;
				ctx.fillRect(b * bucket, top, bucket, total ? cap : lane.tools.y1 - top);
			}
		}
	}

	// Failures: the bar is red, and a small marker above it, one at most every few pixels. Dense tool columns carry
	// their red cap instead, so a session with hundreds of failures does not grow a row of markers.
	if (!compact) {
		let lastMark = Number.NEGATIVE_INFINITY;
		const failed = [...llms, ...(dense ? [] : tools)].filter((item) => item.error).sort((a, b) => a.x0 - b.x0);
		for (const item of failed) {
			const x = (item.x0 + Math.min(item.x1, item.x0 + 6)) / 2;
			if (x - lastMark < 6) continue;
			lastMark = x;
			errorMarker(ctx, x, item.lane === "tools" ? lane.tools.y0 - 1 : trunk - llmThickness(item, compact) / 2 - 1, palette.error);
		}
	}

	// Compactions sit on the trunk as their own bullet where there is room for one, and as a tall bar through the
	// model-call row where they crowd, cut out by a page-coloured edge so each still reads as its own mark.
	const cr = compact ? 5 : 6.5;
	const crowded = llms.length > scale.width / 4;
	let lastBullet = Number.NEGATIVE_INFINITY;
	for (const item of marks) {
		const x = item.x0 + 1;
		if (!crowded && x - lastBullet >= 24) {
			bullet(ctx, x, trunk, cr, palette.compaction, palette.compactionInk, "C", palette.page);
			lastBullet = x;
		} else {
			ctx.fillStyle = palette.page;
			ctx.fillRect(Math.round(x) - 2.5, lane.llm.y0, 5, lane.llm.y1 - lane.llm.y0);
			ctx.fillStyle = palette.compaction;
			ctx.fillRect(Math.round(x) - 1.5, lane.llm.y0 + 1, 3, lane.llm.y1 - lane.llm.y0 - 2);
		}
	}

	// Branch bullets and names, drawn last so the lines run under them.
	for (let i = 0; i < branches.length; i++) {
		const item = branches[i];
		const r = compact ? 5 : 6.5;
		const step = isStep(item);
		if (step) {
			// A Herder step stops at an open station ring.
			ctx.beginPath();
			ctx.arc(item.x0, branchY, r - 1, 0, Math.PI * 2);
			ctx.fillStyle = palette.page;
			ctx.fill();
			ctx.strokeStyle = palette.ink;
			ctx.lineWidth = 2;
			ctx.stroke();
		} else bullet(ctx, item.x0, branchY, r, palette.agent, palette.agentInk, "A", palette.page);
		if (compact || !item.childId) continue;
		const child = children.get(item.childId);
		const next = branches[i + 1];
		const room = (next ? next.x0 : scale.width) - item.x0 - r - 12;
		if (room < 36) continue;
		const type = step ? `${child?.agentType || "Herder"} step` : child?.agentType || "Subagent";
		const name = [type, child?.description].filter(Boolean).join(" · ");
		ctx.font = `500 11px ${CANVAS_FONT}`;
		// A label names at least the agent's type, whole; a cut that leaves no description to read keeps only the type.
		if (ctx.measureText(type).width > room) continue;
		let text = fitText(ctx, name, Math.min(room, 260));
		if (text !== name && text.length - type.length < 3 + 6) text = type;
		const tx = item.x0 + r + 5;
		const tw = ctx.measureText(text).width;
		ctx.fillStyle = palette.page;
		ctx.fillRect(tx - 2, branchY - 7, tw + 4, 14);
		ctx.fillStyle = palette.ink;
		ctx.fillText(text, tx, branchY + 0.5);
	}
}

/** The longest prefix of `text` that fits `width`, with an ellipsis when cut. */
function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
	if (ctx.measureText(text).width <= width) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
		else hi = mid - 1;
	}
	return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

/**
 * The "you are here" pin on the selection, and an outline on the hovered record. The pin stands in the turns row and
 * the selection is outlined, never filled, so no record is covered.
 */
function drawOverlay(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	palette: Palette,
	hovered: OverviewItem | undefined,
	selected: OverviewItem | undefined,
	compact: boolean,
	lanes: LaneBox[],
) {
	ctx.clearRect(0, 0, width, height);
	const turnsBottom = lanes[0].y1;
	const outline = (item: OverviewItem, pad: number, lineWidth: number) => {
		const box = drawnBox(item, compact, lanes);
		ctx.strokeStyle = palette.ink;
		ctx.lineWidth = lineWidth;
		ctx.strokeRect(box.x0 - pad, box.y0 - pad, Math.max(1, box.x1 - box.x0) + pad * 2, box.y1 - box.y0 + pad * 2);
		return box;
	};
	if (hovered && hovered !== selected) outline(hovered, 1.5, 1);
	if (selected) {
		const box = outline(selected, 2, 2);
		const x = Math.round(Math.max(box.x0, Math.min(box.x1, selected.x0 + 1)));
		const foot = selected.lane === "turns" ? box.y0 - 2 : turnsBottom;
		ctx.fillStyle = palette.ink;
		ctx.fillRect(x - 0.75, 0, 1.5, foot);
		ctx.beginPath();
		ctx.arc(x, 3, 3, 0, Math.PI * 2);
		ctx.fill();
	}
}

/** The navigator strip's height, shown under the clock row while zoomed. */
const NAVIGATOR_HEIGHT = 14;

/**
 * The whole session in miniature for the navigator: every other turn tinted, turns in a pale prompt colour along the
 * bottom, and model calls in a pale model colour that deepens where they crowd. Folded gaps stay page-coloured.
 */
function drawNavigator(ctx: CanvasRenderingContext2D, trace: SessionTrace, scale: Scale, height: number, palette: Palette) {
	ctx.clearRect(0, 0, scale.width, height);
	const timed = trace.turns.filter((turn): turn is typeof turn & { at: number } => turn.at !== undefined && Number.isFinite(turn.at));
	timed.forEach((turn, i) => {
		const next = timed[i + 1];
		const x0 = scale.x(turn.at);
		const x1 = Math.max(x0 + 1, Math.min(scale.x(turn.at + Math.max(0, turn.durationMs || 0)), next ? scale.x(next.at) : scale.width));
		if (i % 2 === 1) {
			ctx.fillStyle = palette.ink;
			ctx.globalAlpha = 0.05;
			ctx.fillRect(x0, 0, Math.max(1, (next ? scale.x(next.at) : x1) - x0), height);
		}
		ctx.fillStyle = palette.user;
		ctx.globalAlpha = 0.45;
		ctx.fillRect(x0, height - 3, Math.max(1, x1 - x0 >= 3 ? x1 - x0 - 1 : x1 - x0), 3);
	});
	ctx.fillStyle = palette.llm;
	ctx.globalAlpha = 0.3;
	for (const record of trace.records) {
		if (record.kind !== "llm") continue;
		const { start, end } = recordSpan(record);
		if (start === undefined) continue;
		const x0 = scale.x(start);
		ctx.fillRect(x0, 3, Math.max(1, scale.x(end ?? start) - x0), height - 8);
	}
	ctx.globalAlpha = 1;
	ctx.fillStyle = palette.page;
	for (const { x0, x1 } of scale.breaks()) if (x1 - x0 >= 3) ctx.fillRect(x0 + 1, 0, x1 - x0 - 2, height);
}

const ZOOM_BUTTON = cx(
	"inline-flex shrink-0 items-center justify-center rounded-sm border border-line text-muted transition-colors duration-150",
	"hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40",
);

function ZoomIcon({ kind }: { kind: "in" | "out" | "all" | "range" }) {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
			{kind === "out" && <path d="M2 5h6" />}
			{kind === "in" && <path d="M2 5h6M5 2v6" />}
			{kind === "all" && <path d="M1 2v6M9 2v6M3 5h4M4.3 3.6 3 5l1.3 1.4M5.7 3.6 7 5 5.7 6.4" />}
			{kind === "range" && <path d="M3.2 1.5H1.5v7h1.7M6.8 1.5h1.7v7H6.8M4 5h2" />}
		</svg>
	);
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
	const areaRef = useRef<HTMLDivElement>(null);
	const baseRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	const navigatorRef = useRef<HTMLCanvasElement>(null);
	const width = useWidth(plotRef);
	const theme = usePaintVersion();
	// The provider row only once some model call has its first token timed; older sessions keep the layout they had.
	const timed = useMemo(() => hasProviderTiming(trace), [trace]);
	const lanes = useMemo(() => overviewLanes(compact, timed), [compact, timed]);
	const height = lanes[lanes.length - 1].y1 + (compact ? 3 : 5);
	const clockHeight = compact ? 14 : 16;
	const axis = useMemo(() => foldGaps(traceIntervals(trace)), [trace]);
	// The zoom window, in active time, for this session only; none is the whole session.
	const [zoom, setZoom] = useState<{ sessionId: string; window: Interval } | undefined>();
	const stored = zoom?.sessionId === trace.sessionId ? zoom.window : undefined;
	const view = useMemo(() => (stored && !isFullWindow(axis, clampWindow(axis, stored)) ? clampWindow(axis, stored) : undefined), [axis, stored]);
	const zoomed = view !== undefined;
	// The whole session's scale maps replay positions, the playhead, and the navigator; `scale` is what is drawn.
	const fullScale = useMemo(() => makeScale(axis, Math.max(1, width)), [axis, width]);
	const scale = useMemo(() => (view ? makeScale(windowAxis(axis, view), Math.max(1, width)) : fullScale), [axis, view, width, fullScale]);
	const items = useMemo(() => layoutOverview(trace, scale, lanes), [trace, scale, lanes]);
	// A provider bar shares its model call's key; the key means the model-call bar.
	const byKey = useMemo(() => new Map(items.filter((item) => item.lane !== "provider").map((item) => [item.key, item])), [items]);
	const breaks = useMemo(() => scale.breaks(), [scale]);
	// Gap labels that fit, measured: each keeps clear of the previous one and inside the row.
	const gapLabels = useMemo(() => {
		const shown: ((typeof breaks)[number] & { center: number; half: number })[] = [];
		let end = Number.NEGATIVE_INFINITY;
		for (const item of breaks) {
			const center = (item.x0 + item.x1) / 2;
			const half = labelWidth(formatGap(item.gap.end - item.gap.start), 10, true) / 2 + 4;
			if (center - half < Math.max(0, end + 10) || center + half > width) continue;
			shown.push({ ...item, center, half });
			end = center + half;
		}
		return shown;
	}, [breaks, width]);
	// Clock ticks, measured: gap labels take precedence, and a tick that would touch one or leave the row is dropped.
	// Zoomed, ticks may be tenths of a second apart, and a longer label that would touch the one before it is dropped.
	const ticks = useMemo(() => {
		if (width <= 0) return [];
		const spacing = compact ? 90 : 72;
		const minStep = zoomed ? 100 : 1_000;
		const step = tickStep(scale, spacing, minStep);
		let right = Number.NEGATIVE_INFINITY;
		return axisTicks(scale, spacing, minStep).flatMap((tick, i) => {
			const text = formatTick(tick.elapsed, step);
			const w = labelWidth(text, 10.5);
			const left = i === 0 && tick.x <= 0 ? tick.x : tick.x - w / 2;
			if (left < 0 || left + w > width) return [];
			if (zoomed && left < right + 8) return [];
			const clear = gapLabels.every(({ center, half }) => left + w + 8 < center - half || left - 8 > center + half);
			if (!clear) return [];
			right = left + w;
			return [{ left, text }];
		});
	}, [scale, gapLabels, width, compact, zoomed]);
	const [hover, setHover] = useState<{ item: OverviewItem; x: number; y: number } | undefined>();
	const [brush, setBrush] = useState<{ x0: number; x1: number } | undefined>();
	const drag = useRef<{ x0: number; moved: boolean; scrub: boolean } | null>(null);

	useEffect(() => onScale?.(fullScale), [fullScale, onScale]);

	const setWindow = useCallback(
		(next: Interval | undefined) => {
			const window = next ? clampWindow(axis, next) : undefined;
			setZoom(window && !isFullWindow(axis, window) ? { sessionId: trace.sessionId, window } : undefined);
			// A hovered bar has moved; the next pointer move finds what is under it now.
			setHover(undefined);
		},
		[axis, trace.sessionId],
	);
	/** Zooms by `factor` keeping the instant at `x` where it is. */
	const zoomAt = useCallback(
		(factor: number, x: number) => {
			const anchor = fullScale.position(scale.time(x));
			setWindow(zoomWindow(axis, view ?? { start: 0, end: axis.activeMs }, factor, anchor, scale.width, x));
		},
		[axis, view, scale, fullScale, setWindow],
	);
	const latest = useRef({ axis, view, scale, zoomAt, setWindow });
	latest.current = { axis, view, scale, zoomAt, setWindow };

	// Wheel: ⌘/Ctrl (and a trackpad pinch, which arrives with ctrlKey) zooms around the pointer; while zoomed, Shift or a
	// sideways swipe pans. A plain vertical wheel is left to the page, and only handled events are prevented.
	useEffect(() => {
		const area = areaRef.current;
		if (!area) return;
		const onWheel = (event: WheelEvent) => {
			const { axis, view, scale, zoomAt, setWindow } = latest.current;
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scale.width : 1;
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				const rect = area.getBoundingClientRect();
				const x = Math.max(0, Math.min(scale.width, event.clientX - rect.left));
				zoomAt(Math.max(0.25, Math.min(4, 2 ** (-event.deltaY * unit * 0.01))), x);
				return;
			}
			if (!view) return;
			const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
			if (!event.shiftKey && !sideways) return;
			const delta = (sideways ? event.deltaX : event.deltaY) * unit;
			if (!delta) return;
			event.preventDefault();
			setWindow(panWindow(axis, view, delta / scale.pxPerMs));
		};
		area.addEventListener("wheel", onWheel, { passive: false });
		return () => area.removeEventListener("wheel", onWheel);
	}, []);

	// Follow: a selection outside the window brings the window to it, at the same zoom. Only a new selection moves the
	// window, so the reader can pan away from the one they have.
	const spans = useMemo(() => {
		const map = new Map<string, Interval>();
		for (const record of trace.records) {
			const { start, end } = recordSpan(record);
			if (start !== undefined) map.set(recordKey(trace.sessionId, record), { start, end: end ?? start });
		}
		for (const turn of trace.turns) if (turn.at !== undefined) map.set(`turn:${turn.index}`, { start: turn.at, end: turn.at + Math.max(0, turn.durationMs || 0) });
		return map;
	}, [trace]);
	const follow = useRef({ spans, fullScale });
	follow.current = { spans, fullScale };
	useEffect(() => {
		const { axis, view, setWindow } = latest.current;
		const span = selectedKey ? follow.current.spans.get(selectedKey) : undefined;
		if (!view || !span) return;
		const a = follow.current.fullScale.position(span.start);
		const b = follow.current.fullScale.position(span.end);
		if (b >= view.start && a <= view.end) return;
		const length = view.end - view.start;
		setWindow(b - a < length * 0.8 ? centreWindow(axis, view, (a + b) / 2) : { start: a - length * 0.1, end: a + length * 0.9 });
	}, [selectedKey]);
	// Replay: when the playhead leaves the window, the window turns a page so it is near the left edge again.
	useEffect(() => {
		const { view, setWindow } = latest.current;
		if (!view || playhead === undefined || (playhead >= view.start && playhead <= view.end)) return;
		const length = view.end - view.start;
		setWindow({ start: playhead - length * 0.1, end: playhead + length * 0.9 });
	}, [playhead]);

	useEffect(() => {
		const canvas = baseRef.current;
		const ctx = context2d(canvas);
		if (!canvas || !ctx || width <= 0) return;
		const dpr = sizeCanvas(canvas, width, height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawBase(ctx, items, trace, scale, lanes, readPalette(), height, compact);
	}, [items, trace, scale, lanes, height, width, theme, compact]);

	useEffect(() => {
		const canvas = navigatorRef.current;
		const ctx = context2d(canvas);
		if (!zoomed || !canvas || !ctx || width <= 0) return;
		const dpr = sizeCanvas(canvas, width, NAVIGATOR_HEIGHT);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawNavigator(ctx, trace, fullScale, NAVIGATOR_HEIGHT, readPalette());
	}, [zoomed, trace, fullScale, width, theme]);

	const hovered = hover?.item ?? (hoveredKey ? byKey.get(hoveredKey) : undefined);
	const selected = selectedKey ? byKey.get(selectedKey) : undefined;
	useEffect(() => {
		const canvas = overlayRef.current;
		const ctx = context2d(canvas);
		if (!canvas || !ctx || width <= 0) return;
		const dpr = sizeCanvas(canvas, width, height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawOverlay(ctx, width, height, readPalette(), hovered, selected, compact, lanes);
	}, [hovered, selected, width, height, theme, compact, lanes]);

	const point = (event: ReactPointerEvent<HTMLElement>) => {
		const rect = plotRef.current!.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};

	// The playhead only while it is inside the window.
	const playheadX =
		playhead !== undefined && (!view || (playhead >= view.start && playhead <= view.end)) ? scale.x(fullScale.timeAt(playhead)) : undefined;

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
				onScrub?.(fullScale.position(scale.time(Math.max(0, Math.min(width, x)))));
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

	const stepsOnly = trace.children.length > 0 && trace.children.every((child) => child.kind === "herder-step");
	// Marks for a time span, cut at the window's edges and left out beyond them.
	const shown = (span: Interval | undefined) =>
		span && span.end >= scale.axis.segments[0].start && span.start <= scale.axis.segments[scale.axis.segments.length - 1].end ? span : undefined;
	const rangeShown = shown(range);
	const rangeBox = rangeShown ? { x0: scale.x(rangeShown.start), x1: scale.x(rangeShown.end) } : undefined;
	const viewShown = compact ? undefined : shown(viewport);
	const viewBox = viewShown ? { x0: scale.x(viewShown.start), x1: Math.max(scale.x(viewShown.start) + 2, scale.x(viewShown.end)) } : undefined;

	const zoomToRange = () => {
		if (!range) return;
		const a = fullScale.position(range.start);
		const b = fullScale.position(range.end);
		const length = Math.max(MIN_WINDOW_MS, (b - a) * 1.1);
		setWindow({ start: (a + b) / 2 - length / 2, end: (a + b) / 2 + length / 2 });
	};
	const atMinimum = view !== undefined && view.end - view.start <= Math.min(MIN_WINDOW_MS, axis.activeMs) + 0.5;
	const button = cx(ZOOM_BUTTON, compact ? "h-[14px] w-[15px]" : "h-4 w-[15px]");

	return (
		<div className="flex select-none" data-overview="" data-compact={compact || undefined} data-zoomed={zoomed || undefined} role="group" aria-label={label}>
			<div className={cx("shrink-0", compact ? "w-[64px]" : "w-[76px]")}>
				{/* Row labels in a gutter left of the plot, so every height on it says what it holds. */}
				<div className="relative" style={{ height }} aria-hidden="true" data-overview-rows="">
					{lanes.map((row) => (
						<span
							key={row.lane}
							className={cx(
								"absolute left-0 -translate-y-1/2 leading-none whitespace-nowrap",
								compact ? "text-[9.5px]" : "text-[11px]",
								row.lane === "agents" && trace.children.length === 0 ? "text-muted/60" : "text-muted",
							)}
							style={{ top: (row.y0 + row.y1) / 2 }}
						>
							{row.lane === "agents" && stepsOnly ? "Herder steps" : row.label}
						</span>
					))}
				</div>
				{/* Zoom controls beside the clock row: the keyboard's way to zoom, and the mouse's without a modifier. */}
				<div className="flex items-center gap-[2px]" style={{ height: clockHeight }} role="group" aria-label="Timeline zoom" data-overview-zoom="">
					<button type="button" className={button} onClick={() => zoomAt(0.5, scale.width / 2)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (⌘/Ctrl + scroll)">
						<ZoomIcon kind="out" />
					</button>
					<button type="button" className={button} onClick={() => zoomAt(2, scale.width / 2)} disabled={atMinimum || axis.activeMs <= MIN_WINDOW_MS} aria-label="Zoom in" title="Zoom in (⌘/Ctrl + scroll)">
						<ZoomIcon kind="in" />
					</button>
					<button type="button" className={button} onClick={() => setWindow(undefined)} disabled={!zoomed} aria-label="Show the whole session" title="Show the whole session">
						<ZoomIcon kind="all" />
					</button>
					{range && (
						<button type="button" className={button} onClick={zoomToRange} aria-label="Zoom to the selected range" title="Zoom to the selected range" data-zoom-range="">
							<ZoomIcon kind="range" />
						</button>
					)}
				</div>
			</div>
			<div ref={plotRef} className="relative min-w-0 flex-1">
				<div
					ref={areaRef}
					className={cx("relative", onSelect && "cursor-pointer")}
					style={{ height }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerLeave={leave}
					data-overview-plot=""
				>
					<canvas ref={baseRef} className="absolute inset-0" aria-hidden="true" />
					<canvas ref={overlayRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
					{viewBox && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0"
							style={{ left: viewBox.x0, width: Math.max(3, viewBox.x1 - viewBox.x0) }}
							data-viewport=""
						>
							<div className="absolute inset-0 bg-ink/[0.04]" />
							<div className="absolute inset-x-0 bottom-0 h-[2px] bg-ink/45" />
						</div>
					)}
					{rangeBox && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 border-x border-ink bg-ink/[0.06]"
							style={{ left: rangeBox.x0, width: Math.max(2, rangeBox.x1 - rangeBox.x0) }}
							data-range=""
						/>
					)}
					{brush && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 border-x border-ink/70 bg-ink/[0.06]"
							style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0) }}
						/>
					)}
					{playheadX !== undefined && (
						<div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 bg-page/60" style={{ left: playheadX }} />
					)}
					{playheadX !== undefined && (
						<div className="pointer-events-none absolute top-0 bottom-0" style={{ left: playheadX }} data-playhead="">
							<div className="absolute top-0 bottom-0 -ml-px w-[2px] bg-ink" />
							<div className="absolute -top-[2px] -ml-[6px] size-[12px] rounded-full border-2 border-page bg-ink" />
						</div>
					)}
					{hover && <OverviewTooltip item={hover.item} x={hover.x} y={hover.y} width={width} origin={axis.origin} trace={trace} />}
				</div>
				{/* Elapsed time under the line, as a timetable's clock row; folded idle gaps say how long they were. */}
				<div className="relative overflow-hidden" style={{ height: clockHeight }} aria-hidden="true">
					{ticks.map((tick, i) => (
						<span key={i} className="tnum absolute top-[3px] text-[10.5px] leading-none whitespace-nowrap text-muted" style={{ left: tick.left }}>
							{tick.text}
						</span>
					))}
					{gapLabels.map(({ center, gap }) => (
						<span
							key={gap.start}
							className="tnum absolute top-[3px] -translate-x-1/2 bg-page px-1 text-[10px] leading-none whitespace-nowrap text-muted italic"
							style={{ left: center }}
							title={`Idle for ${formatGap(gap.end - gap.start)}, folded`}
							data-gap=""
						>
							{formatGap(gap.end - gap.start)}
						</span>
					))}
				</div>
				{view && <Navigator canvasRef={navigatorRef} axis={axis} scale={fullScale} view={view} onWindow={setWindow} />}
			</div>
		</div>
	);
}

/**
 * The whole session in miniature under the clock row while zoomed, with the window outlined on it. Dragging pans by
 * the active time the pointer passes over, so a folded gap is crossed, not jumped into; a click elsewhere centres the
 * window there.
 */
function Navigator({
	canvasRef,
	axis,
	scale,
	view,
	onWindow,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	axis: Axis;
	scale: Scale;
	view: Interval;
	onWindow: (window: Interval) => void;
}) {
	const drag = useRef<{ x0: number; window: Interval } | null>(null);
	const x0 = scale.x(scale.timeAt(view.start));
	const x1 = Math.max(x0 + 4, scale.x(scale.timeAt(view.end)));
	const at = (event: ReactPointerEvent<HTMLElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return Math.max(0, Math.min(scale.width, event.clientX - rect.left));
	};
	const position = (x: number) => scale.position(scale.time(x));
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		const x = at(event);
		let window = view;
		if (x < x0 - 2 || x > x1 + 2) {
			window = centreWindow(axis, view, position(x));
			onWindow(window);
		}
		drag.current = { x0: x, window };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current) return;
		onWindow(panWindow(axis, current.window, position(at(event)) - position(current.x0)));
	};
	const onPointerUp = () => {
		drag.current = null;
	};
	return (
		<div
			className="relative mt-px mb-0.5 cursor-grab active:cursor-grabbing"
			style={{ height: NAVIGATOR_HEIGHT }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			aria-hidden="true"
			data-overview-navigator=""
		>
			<canvas ref={canvasRef} className="absolute inset-0" />
			<div className="pointer-events-none absolute inset-y-[-1px] rounded-sm border border-ink bg-ink/[0.06]" style={{ left: x0, width: x1 - x0 }} data-navigator-window="" />
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
			className="pointer-events-none absolute z-20 w-[268px] rounded-sm border border-ink bg-page px-3 py-2 text-[12px] leading-[1.45] shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
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
					{item.phases && (
						<div className="tnum text-muted" data-tooltip-ttft="">
							TTFT {formatPhase(item.phases.ttft)} · streamed {formatPhase(item.phases.streaming)}
							{item.phases.kind === "thinking" && " · first token: thinking"}
						</div>
					)}
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
								{plural(turn.modelCalls, "model call")} · {plural(turn.toolCalls, "tool call")} · {formatCost(turn.cost)}
							</span>
						)}
					</div>
				</>
			) : (
				<>
					<div className="flex min-w-0 items-center gap-2">
						{child?.kind === "herder-step" ? (
							<span className="size-4 shrink-0 rounded-full border-2 border-ink" aria-hidden="true" />
						) : (
							<KindBullet family="agent" />
						)}
						<span className="shrink-0 font-medium">{child?.kind === "herder-step" ? "Herder step" : "Subagent"}</span>
						{child?.agentType && <span className="min-w-0 truncate text-muted">{child.agentType}</span>}
					</div>
					{child?.description && <div className="mt-1 line-clamp-2 text-muted">{child.description}</div>}
					<div className="tnum mt-1 text-muted">{formatSpan((item.end ?? item.start) - item.start)}</div>
				</>
			)}
		</div>
	);
}
