import type { TraceLlmRecord } from "../lib/types";
import { formatPhase, middleTruncate } from "./format";
import { llmPhases } from "./kinds";

const WIDTH = 272;
const PI_X = 50;
const PROVIDER_X = 156;
const TOP = 30;
/** The time span's height; the gaps below keep labels apart, so the whole stays about 150 px. */
const SPAN = 100;
const MIN_GAP = 18;
/** How far an arrow drops on its way across, like a message in flight. */
const SLANT = 6;

interface Arrow {
	name: string;
	at: number;
	up: boolean;
	y: number;
}

function offset(ms: number): string {
	return ms <= 0 ? "+0" : `+${formatPhase(ms)}`;
}

/** Time down the page, proportional where there is room, and never closer than `MIN_GAP`. */
function place(arrows: Arrow[], request: number, end: number) {
	const length = Math.max(1, end - request);
	arrows.forEach((arrow) => (arrow.y = TOP + ((arrow.at - request) / length) * SPAN));
	for (let i = 1; i < arrows.length; i++) arrows[i].y = Math.max(arrows[i].y, arrows[i - 1].y + MIN_GAP);
	const last = arrows.length - 1;
	if (arrows[last].y > TOP + SPAN) {
		arrows[last].y = TOP + SPAN;
		for (let i = last - 1; i >= 0; i--) arrows[i].y = Math.min(arrows[i].y, arrows[i + 1].y - MIN_GAP);
	}
}

function Head({ x, y, left }: { x: number; y: number; left: boolean }) {
	// The arrow's direction, slanted down by SLANT across the gap between the lifelines.
	const angle = Math.atan2(SLANT, left ? -(PROVIDER_X - PI_X) : PROVIDER_X - PI_X);
	const at = (spread: number) => `${x - 6 * Math.cos(angle + spread)},${y - 6 * Math.sin(angle + spread)}`;
	return <polygon points={`${x},${y} ${at(0.45)} ${at(-0.45)}`} fill="currentColor" />;
}

/**
 * A timed model call as a network sequence diagram: pi and the provider as lifelines, time running down, the request
 * going over and the headers, first token, and last token coming back, each labelled with its offset from the request.
 */
export function Ladder({ record }: { record: TraceLlmRecord }) {
	const phases = llmPhases(record);
	if (!phases) return null;
	const { request, headers, firstToken, end, ttft, streaming } = phases;
	const arrows: Arrow[] = [
		{ name: "request", at: request, up: false, y: 0 },
		...(headers !== undefined ? [{ name: "headers", at: headers, up: true, y: 0 }] : []),
		{ name: "first token", at: firstToken, up: true, y: 0 },
		{ name: "done", at: end, up: true, y: 0 },
	];
	place(arrows, request, end);
	const first = arrows.find((arrow) => arrow.name === "first token")!;
	const done = arrows[arrows.length - 1];
	const height = done.y + SLANT + 8;
	const color = record.error ? "var(--color-k-error)" : "var(--color-k-llm)";
	const provider = record.provider ? middleTruncate(record.provider, 18) : "Provider";
	const rate = streaming > 0 && record.output > 0 ? record.output / (streaming / 1000) : undefined;
	const label = `Request sent; ${headers !== undefined ? `headers after ${formatPhase(headers - request)}; ` : ""}first token after ${formatPhase(
		ttft,
	)}; done after ${formatPhase(end - request)}.`;
	return (
		<div className="flex shrink-0 flex-wrap items-start gap-x-6 gap-y-2 px-5 pt-3" data-ladder="">
			<svg width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={label} className="shrink-0 text-ink">
				<g className="tnum" fontSize="11" textAnchor="middle">
					<text x={PI_X} y={12} fill="currentColor" fontWeight={600}>
						pi
					</text>
					<text x={PROVIDER_X} y={12} fill="currentColor" fontWeight={600}>
						{provider}
					</text>
				</g>
				<line x1={PI_X} x2={PI_X} y1={18} y2={height - 2} stroke="var(--color-muted)" strokeWidth={1} />
				<line x1={PROVIDER_X} x2={PROVIDER_X} y1={18} y2={height - 2} stroke="var(--color-muted)" strokeWidth={1} />
				{/* The provider working before the first token, pale as on the timeline; the streaming between the lifelines. */}
				<rect x={PROVIDER_X - 2.5} y={arrows[0].y + SLANT} width={5} height={Math.max(0, first.y - arrows[0].y - SLANT)} fill={color} opacity={0.3} />
				<polygon
					points={`${PROVIDER_X},${first.y} ${PI_X},${first.y + SLANT} ${PI_X},${done.y + SLANT} ${PROVIDER_X},${done.y}`}
					fill={color}
					opacity={0.14}
				/>
				<rect x={PI_X - 2.5} y={first.y + SLANT} width={5} height={Math.max(1, done.y - first.y)} fill={color} />
				{/* The time to first token, bracketed on pi's side. */}
				<g stroke="currentColor" strokeWidth={1}>
					<line x1={PI_X - 12} x2={PI_X - 12} y1={arrows[0].y} y2={first.y + SLANT} />
					<line x1={PI_X - 15} x2={PI_X - 9} y1={arrows[0].y} y2={arrows[0].y} />
					<line x1={PI_X - 15} x2={PI_X - 9} y1={first.y + SLANT} y2={first.y + SLANT} />
				</g>
				<text x={PI_X - 17} y={(arrows[0].y + first.y + SLANT) / 2 + 3.5} fontSize="10" fontWeight={600} textAnchor="end" fill="currentColor">
					TTFT
				</text>
				{arrows.map((arrow) => {
					const [x0, x1] = arrow.up ? [PROVIDER_X, PI_X] : [PI_X, PROVIDER_X];
					return (
						<g key={arrow.name} data-ladder-arrow={arrow.name}>
							<line x1={x0} y1={arrow.y} x2={x1} y2={arrow.y + SLANT} stroke="currentColor" strokeWidth={arrow.name === "first token" ? 1.5 : 1} />
							<Head x={x1} y={arrow.y + SLANT} left={arrow.up} />
							<text x={PROVIDER_X + 10} y={arrow.y + SLANT / 2 + 3.5} fontSize="10.5" fill="var(--color-muted)">
								{arrow.name}
							</text>
							<text
								x={WIDTH - 2}
								y={arrow.y + SLANT / 2 + 3.5}
								fontSize="10.5"
								textAnchor="end"
								fill="currentColor"
								fontWeight={arrow.name === "first token" ? 600 : 400}
								className="tnum"
							>
								{offset(arrow.at - request)}
							</text>
						</g>
					);
				})}
			</svg>
			<dl className="tnum grid grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1 pt-5 text-[12px]">
				<dt className="text-muted">TTFT</dt>
				<dd className="text-[15px] font-semibold" data-ladder-ttft="">
					{formatPhase(ttft)}
				</dd>
				<dt className="text-muted">Streamed</dt>
				<dd>{formatPhase(streaming)}</dd>
				{rate !== undefined && (
					<>
						<dt className="text-muted">Output</dt>
						<dd>{rate >= 100 ? Math.round(rate) : rate.toFixed(1)} tok/s</dd>
					</>
				)}
				{phases.kind && (
					<>
						<dt className="text-muted">First token</dt>
						<dd>{phases.kind === "toolCall" ? "tool call" : phases.kind}</dd>
					</>
				)}
			</dl>
		</div>
	);
}
