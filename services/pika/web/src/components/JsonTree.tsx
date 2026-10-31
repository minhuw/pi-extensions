import { useState } from "react";
import { cx } from "./ui";

const CHILD_PAGE = 100;
const STRING_PREVIEW = 300;

function preview(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).length}}`;
	return "";
}

function Scalar({ value }: { value: unknown }) {
	const [full, setFull] = useState(false);
	if (typeof value === "string") {
		const long = value.length > STRING_PREVIEW;
		return (
			<span className="text-ink [overflow-wrap:anywhere] whitespace-pre-wrap">
				“{long && !full ? `${value.slice(0, STRING_PREVIEW)}…` : value}”
				{long && (
					<button type="button" onClick={() => setFull(!full)} className="ml-1 rounded-sm px-1 font-sans text-[12px] text-muted hover:bg-hover">
						{full ? "less" : `${value.length.toLocaleString("en-US")} chars`}
					</button>
				)}
			</span>
		);
	}
	if (value === null || value === undefined) return <span className="text-muted">{String(value)}</span>;
	return <span className="font-semibold text-ink">{String(value)}</span>;
}

function Node({ name, value, depth, defaultOpen }: { name?: string; value: unknown; depth: number; defaultOpen: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const [shown, setShown] = useState(CHILD_PAGE);
	const isContainer = value !== null && typeof value === "object";
	const label = name !== undefined && <span className="text-muted">{name}: </span>;
	if (!isContainer) {
		return (
			<div className="pl-4" data-json-node="">
				{label}
				<Scalar value={value} />
			</div>
		);
	}
	const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value as object);
	return (
		<div data-json-node="">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1 rounded-sm pr-1 text-left hover:bg-hover"
			>
				<span aria-hidden="true" className="w-3 text-[10px] text-muted">
					{open ? "▾" : "▸"}
				</span>
				{label}
				<span className="text-muted">{preview(value)}</span>
			</button>
			{open && (
				<div className={cx("ml-1.5 border-l border-line", depth > 12 && "pl-1")}>
					{entries.slice(0, shown).map(([key, child]) => (
						<Node key={key} name={key} value={child} depth={depth + 1} defaultOpen={false} />
					))}
					{entries.length > shown && (
						<button
							type="button"
							onClick={() => setShown(shown + CHILD_PAGE)}
							className="ml-4 rounded-sm px-1 font-sans text-[12px] text-muted hover:bg-hover"
						>
							Show {Math.min(CHILD_PAGE, entries.length - shown)} more of {entries.length - shown}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** Collapsible JSON viewer; children render only when their parent is open. */
export function JsonTree({ value, className }: { value: unknown; className?: string }) {
	return (
		<div className={cx("mono overflow-x-auto rounded-sm border border-line bg-soft px-2 py-2", className)} data-json-tree="">
			<Node value={value} depth={0} defaultOpen />
		</div>
	);
}
