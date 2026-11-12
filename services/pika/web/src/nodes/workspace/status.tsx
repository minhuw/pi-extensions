import { cx } from "../../components/ui";
import type { TerminalInfo } from "../contract";

/** A pane's state as the agent list and tabs mark it. */
export type PaneMark = "waiting" | "working" | "done" | "error" | "idle" | "exited";

/**
 * A pane's mark. A nonzero exit code is an error; a signal is not (closing a pane hangs its shell up, and Kill sends
 * SIGTERM).
 */
export function paneMark(terminal: TerminalInfo | undefined): PaneMark {
	if (!terminal) return "idle";
	if (terminal.exited) return terminal.exited.code !== null && terminal.exited.code !== 0 ? "error" : "exited";
	const status = terminal.status;
	if (status?.state === "waiting") return "waiting";
	if (status?.state === "busy") return "working";
	if (status?.unread) return "done";
	return "idle";
}

/** The mark that says the most of several panes (a tab's): waiting, then error, working, done. */
export function strongestMark(marks: readonly PaneMark[]): PaneMark {
	for (const mark of ["waiting", "error", "working", "done", "idle"] as const) if (marks.includes(mark)) return mark;
	return marks[0] ?? "idle";
}

const MARK_LABELS: Record<PaneMark, string> = {
	waiting: "Needs input",
	working: "Working",
	done: "Done",
	error: "Exited with an error",
	idle: "Idle",
	exited: "Exited",
};

export const markLabel = (mark: PaneMark): string => MARK_LABELS[mark];

/** A small status glyph: a ring that turns while working, an exclamation mark when waiting, a dot when done, a cross on error. */
export function StatusGlyph({ mark, className }: { mark: PaneMark; className?: string }) {
	const label = MARK_LABELS[mark];
	return (
		<span className={cx("inline-flex size-3 shrink-0 items-center justify-center", className)} role="img" aria-label={label} title={label} data-pane-mark={mark}>
			{mark === "working" ? (
				<span className="size-2.5 animate-spin rounded-full border-[1.5px] border-muted border-t-ink motion-reduce:animate-none" />
			) : mark === "waiting" ? (
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<circle cx="6" cy="6" r="6" fill="currentColor" />
					<path d="M6 2.6v4.2" stroke="var(--color-page)" strokeWidth="1.6" strokeLinecap="round" />
					<circle cx="6" cy="9" r="0.95" fill="var(--color-page)" />
				</svg>
			) : mark === "done" ? (
				<span className="size-2 rounded-full bg-ink" />
			) : mark === "error" ? (
				<svg width="10" height="10" viewBox="0 0 10 10" className="text-red" aria-hidden="true">
					<path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" />
				</svg>
			) : mark === "exited" ? (
				<span className="size-2 rounded-full border border-muted" />
			) : (
				<span className="size-1.5 rounded-full bg-muted" />
			)}
		</span>
	);
}
