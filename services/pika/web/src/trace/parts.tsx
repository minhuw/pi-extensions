import type { ReactNode } from "react";
import { cx } from "../components/ui";
import { unifiedDiff } from "../lib/diff";
import { COST_DIAMETERS, costStep, formatCost, type CostScale } from "../lib/format";
import type { Entry, ToolCall, TraceRecord } from "../lib/types";
import { editPairs } from "../session/tools/files";
import { argString } from "../session/tools/shared";
import type { Interval } from "./axis";
import { extensionColor, FAMILY_CLASSES, FAMILY_LETTERS, FAMILY_LABELS, recordBadge, recordFamily, recordIsError, recordSpan, type Family } from "./kinds";

/** A family's round bullet with its letter, as on a subway route sign; red when the record failed. */
export function KindBullet({ family, error = false, size = 16, className }: { family: Family; error?: boolean; size?: number; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"inline-flex shrink-0 items-center justify-center rounded-full leading-none font-semibold",
				error ? "bg-k-error text-k-error-ink" : FAMILY_CLASSES[family].badge,
				className,
			)}
			style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
			data-bullet={family}
			title={FAMILY_LABELS[family]}
		>
			{FAMILY_LETTERS[family]}
		</span>
	);
}

/** The kind of a record: its family's bullet and a short type label such as `BASH`, `READ`, or `LLM`. */
export function KindBadge({
	record,
	family,
	label,
	error,
	className,
}: {
	record?: TraceRecord;
	family?: Family;
	label?: string;
	error?: boolean;
	className?: string;
}) {
	const kind = family ?? (record ? recordFamily(record) : "other");
	const text = label ?? (record ? recordBadge(record) : "");
	const failed = error ?? (record ? recordIsError(record) : false);
	return (
		<span className={cx("inline-flex w-[64px] shrink-0 items-center gap-1.5", className)}>
			<KindBullet family={kind} error={failed} />
			{/* The bullet names the kind; the text beside it is the stop's own name (the tool), so it is set as a quiet label. */}
			<span className={cx("mono min-w-0 truncate text-[11px] leading-none lowercase", failed ? "text-red" : "text-muted")} data-badge={kind}>
				{text}
			</span>
		</span>
	);
}

/** A file path with a small dot in its extension's color. */
export function PathChip({ path, className }: { path: string; className?: string }) {
	const color = extensionColor(path);
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const file = slash >= 0 ? path.slice(slash + 1) : path;
	return (
		<span className={cx("inline-flex min-w-0 items-center gap-1.5", className)} title={path}>
			<span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: color ?? "var(--color-muted)" }} />
			<span className="mono min-w-0 truncate text-[12px]">
				<span className="text-muted">{dir}</span>
				<span className="text-ink">{file}</span>
			</span>
		</span>
	);
}

export interface DiffStatValue {
	added: number;
	removed: number;
}

const diffCache = new WeakMap<object, DiffStatValue>();

/** Lines an edit or write call adds and removes, computed from its arguments. */
export function diffStatOf(call: ToolCall): DiffStatValue | undefined {
	const cached = diffCache.get(call);
	if (cached) return cached;
	const base = call.name.toLowerCase();
	let value: DiffStatValue | undefined;
	if (base === "write") {
		const content = argString(call, "content");
		if (content !== undefined) value = { added: content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0), removed: 0 };
	} else if (base === "edit" || base === "multiedit") {
		const pairs = editPairs(call);
		if (pairs.length) {
			value = { added: 0, removed: 0 };
			for (const pair of pairs) {
				for (const line of unifiedDiff(pair.oldText, pair.newText)) {
					if (line.kind === "add") value.added++;
					else if (line.kind === "del") value.removed++;
				}
			}
		}
	}
	if (value) diffCache.set(call, value);
	return value;
}

/** `+12 −3 ▮▮▮▯▯`, GitHub style. */
export function DiffStat({ value }: { value: DiffStatValue }) {
	const total = value.added + value.removed;
	const green = total ? Math.round((value.added / total) * 5) : 0;
	const red = total ? Math.min(5 - green, Math.round((value.removed / total) * 5)) : 0;
	return (
		<span className="mono tnum inline-flex items-center gap-1 text-[11px]" data-diffstat={`+${value.added} -${value.removed}`}>
			<span className="text-green">+{value.added}</span>
			<span className="text-red">−{value.removed}</span>
			<span aria-hidden="true" className="ml-0.5 inline-flex gap-px">
				{Array.from({ length: 5 }, (_, i) => (
					<span key={i} className={cx("size-[6px] rounded-[1px]", i < green ? "bg-green" : i < green + red ? "bg-red" : "bg-ink/15")} />
				))}
			</span>
		</span>
	);
}

export function Chip({ tone = "neutral", children, title }: { tone?: "neutral" | "red" | "green" | "accent" | "muted"; children: ReactNode; title?: string }) {
	return (
		<span
			title={title}
			className={cx(
				"mono tnum inline-flex h-[18px] items-center rounded-[3px] px-1.5 text-[11px] leading-none whitespace-nowrap",
				tone === "red" && "bg-red-soft text-red",
				tone === "green" && "bg-green-soft text-green",
				tone === "accent" && "bg-accent-soft text-accent",
				tone === "neutral" && "bg-hover text-ink",
				tone === "muted" && "text-muted",
			)}
		>
			{children}
		</span>
	);
}

/** A pulsing dot for work still in progress. */
export function RunningDot({ className }: { className?: string }) {
	return <span aria-hidden="true" className={cx("running-dot inline-block size-1.5 rounded-full bg-accent", className)} />;
}

/** A model call's phase as the timeline draws it: hatched and pale while waiting for the first token, solid while streaming. */
export function PhaseSwatch({ phase, className }: { phase: "waiting" | "streaming"; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cx("inline-block h-[8px] w-[14px]", phase === "streaming" && "bg-k-llm", className)}
			style={
				phase === "waiting"
					? {
							backgroundColor: "color-mix(in srgb, var(--color-k-llm) 22%, transparent)",
							backgroundImage: "repeating-linear-gradient(135deg, var(--color-k-llm) 0 1px, transparent 1px 3.5px)",
						}
					: undefined
			}
		/>
	);
}

/** The record's bar on its turn's time scale. */
export function WaterfallBar({ record, window, running }: { record: TraceRecord; window?: Interval; running?: boolean }) {
	const { start, end } = recordSpan(record);
	if (!window || start === undefined) return <span className="block h-full" />;
	const span = Math.max(1, window.end - window.start);
	const left = Math.max(0, Math.min(1, (start - window.start) / span));
	const stop = end ?? (running ? window.end : start);
	const width = Math.max(0, Math.min(1 - left, (stop - start) / span));
	const family = recordFamily(record);
	const error = recordIsError(record);
	return (
		<span className="relative block h-full" aria-hidden="true">
			<span className="absolute inset-x-0 top-1/2 h-px bg-line" />
			<span
				className={cx(
					"absolute top-1/2 h-[6px] min-w-[2px] -translate-y-1/2 rounded-[1.5px]",
					error ? "bg-k-error" : FAMILY_CLASSES[family].bar,
					running && end === undefined && "running-dot",
				)}
				style={{ left: `${left * 100}%`, width: `${width * 100}%`, opacity: error ? 0.9 : 0.75 }}
			/>
		</span>
	);
}

/** The tool call an assistant entry made, by id. */
export function callIn(entry: Entry | null | undefined, callId: string): ToolCall | undefined {
	const message = entry?.raw.message as { content?: unknown } | undefined;
	if (!message || !Array.isArray(message.content)) return undefined;
	return message.content.find((block): block is ToolCall => typeof block === "object" && block !== null && block.type === "toolCall" && block.id === callId);
}

/** A cost as a dot on the fixed four-step magnitude ramp, the same sizes on the strip map, the tree, and the lists. */
export function CostDot({ cost, scale, className }: { cost: number | null | undefined; scale: CostScale; className?: string }) {
	const step = costStep(cost, scale);
	const size = COST_DIAMETERS[step];
	return (
		<span className={cx("inline-flex size-[10px] shrink-0 items-center justify-center", className)} title={formatCost(cost)} aria-hidden="true" data-cost-step={step}>
			<span className={cx("rounded-full", cost ? "bg-ink" : "border border-ink/40")} style={{ width: size, height: size }} />
		</span>
	);
}
