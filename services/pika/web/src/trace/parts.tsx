import type { ReactNode } from "react";
import { cx } from "../components/ui";
import { unifiedDiff } from "../lib/diff";
import type { Entry, ToolCall, TraceRecord } from "../lib/types";
import { editPairs } from "../session/tools/files";
import { argString } from "../session/tools/shared";
import type { Interval } from "./axis";
import { extensionColor, FAMILY_CLASSES, recordBadge, recordFamily, recordIsError, recordSpan, type Family } from "./kinds";

export function KindBadge({ record, family, label, className }: { record?: TraceRecord; family?: Family; label?: string; className?: string }) {
	const kind = family ?? (record ? recordFamily(record) : "other");
	const text = label ?? (record ? recordBadge(record) : "");
	return (
		<span
			className={cx(
				"inline-flex h-[18px] w-[44px] shrink-0 items-center justify-center rounded-[3px] text-[10px] leading-none font-semibold tracking-[0.04em]",
				FAMILY_CLASSES[kind].badge,
				className,
			)}
			data-badge={kind}
		>
			{text}
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

/** A tiny ring showing a fraction, such as the cache-hit share of a prompt. */
export function Ring({ value, size = 12, title, className }: { value: number; size?: number; title?: string; className?: string }) {
	const r = size / 2 - 1.5;
	const c = 2 * Math.PI * r;
	const clamped = Math.max(0, Math.min(1, value));
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("shrink-0", className)} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
			{title && <title>{title}</title>}
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2.5} />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="currentColor"
				strokeWidth={2.5}
				strokeDasharray={`${clamped * c} ${c}`}
				transform={`rotate(-90 ${size / 2} ${size / 2})`}
			/>
		</svg>
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
