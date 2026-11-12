import type { AnimationEvent } from "react";
import { cx } from "../../components/ui";
import type { TerminalInfo } from "../contract";
import { rawSection, type Section } from "./inbox";

/** A pane's state as the agent rail and the tabs mark it. `stale` is a working agent with no news for 30 minutes. */
export type PaneMark = "waiting" | "working" | "stale" | "done" | "error" | "idle" | "exited";

const SECTION_MARKS: Record<Section, PaneMark> = { needs: "waiting", failed: "error", done: "done", working: "working", quiet: "idle" };

/**
 * A pane's mark, from the same rule as the rail's sections (`inbox.ts`): a nonzero exit code or pi's error is an
 * error; a signal is not (closing a pane hangs its shell up, and Kill sends SIGTERM).
 */
export function paneMark(terminal: TerminalInfo | undefined): PaneMark {
	if (!terminal) return "idle";
	const section = rawSection(terminal);
	if (section === "quiet" && terminal.exited) return "exited";
	return SECTION_MARKS[section];
}

/** The mark of a row in `section`, which the exit grace or a hold may have kept from its own status. */
export function sectionMark(section: Section, terminal: TerminalInfo, stale: boolean): PaneMark {
	if (section === "working") return stale ? "stale" : "working";
	if (section === "quiet" && terminal.exited) return "exited";
	return SECTION_MARKS[section];
}

/** The mark that says the most of several panes (a tab's): waiting, then error, working, done. */
export function strongestMark(marks: readonly PaneMark[]): PaneMark {
	for (const mark of ["waiting", "error", "working", "stale", "done", "idle"] as const) if (marks.includes(mark)) return mark;
	return marks[0] ?? "idle";
}

const MARK_LABELS: Record<PaneMark, string> = {
	waiting: "Needs input",
	working: "Working",
	stale: "Working, no update for a while",
	done: "Done",
	error: "Failed",
	idle: "Idle",
	exited: "Exited",
};

export const markLabel = (mark: PaneMark): string => MARK_LABELS[mark];

/** Starts every working ring at the same phase, so a column of them turns as one (Orca's `AgentWorkingSpinner`). */
function syncPhase(event: AnimationEvent<HTMLSpanElement>): void {
	if (event.animationName !== "wb-working-turn" || typeof event.currentTarget.getAnimations !== "function") return;
	for (const animation of event.currentTarget.getAnimations()) {
		if ("animationName" in animation && animation.animationName === "wb-working-turn") animation.startTime = 0;
	}
}

/**
 * A status glyph, one shape per state so colour is never the only cue (after Orca's `AgentStateDot`): a ring turning in
 * twelve steps while working (a dashed still ring when stale), a question bubble when it needs the user, a check when
 * done, a struck disc on failure, a hollow dot when idle, a dash when exited.
 */
export function StatusGlyph({ mark, className, size = 12 }: { mark: PaneMark; className?: string; size?: number }) {
	const label = MARK_LABELS[mark];
	return (
		<span
			className={cx("inline-flex shrink-0 items-center justify-center", className)}
			style={{ width: size, height: size }}
			role="img"
			aria-label={label}
			title={label}
			data-pane-mark={mark}
		>
			{mark === "working" ? (
				<span
					className="wb-working-ring block size-[9px] rounded-full border-[1.5px] border-wb-working border-t-transparent motion-reduce:border-t-wb-working/40"
					onAnimationStart={syncPhase}
				/>
			) : mark === "stale" ? (
				<svg width="10" height="10" viewBox="0 0 10 10" className="text-wb-ink-3" aria-hidden="true">
					<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.8" />
				</svg>
			) : mark === "waiting" ? (
				<svg width="12" height="12" viewBox="0 0 12 12" className="text-wb-needs" aria-hidden="true">
					<path d="M6 .8a5.2 5.2 0 0 0-4.6 7.6L.9 11.1l2.8-.6A5.2 5.2 0 1 0 6 .8z" fill="currentColor" />
					<path d="M4.6 4.6a1.45 1.45 0 1 1 2.1 1.3c-.45.24-.7.5-.7.95v.25" fill="none" stroke="var(--wb-ground)" strokeWidth="1.15" strokeLinecap="round" />
					<circle cx="6" cy="8.75" r=".7" fill="var(--wb-ground)" />
				</svg>
			) : mark === "done" ? (
				<svg width="12" height="12" viewBox="0 0 12 12" className="text-wb-done" aria-hidden="true">
					<circle cx="6" cy="6" r="5.4" fill="currentColor" />
					<path d="M3.6 6.2 5.3 7.8 8.5 4.4" fill="none" stroke="var(--wb-ground)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			) : mark === "error" ? (
				<svg width="12" height="12" viewBox="0 0 12 12" className="text-wb-failed" aria-hidden="true">
					<circle cx="6" cy="6" r="5.4" fill="currentColor" />
					<path d="M4.2 4.2l3.6 3.6M7.8 4.2 4.2 7.8" stroke="var(--wb-ground)" strokeWidth="1.4" strokeLinecap="round" />
				</svg>
			) : mark === "exited" ? (
				<span className="block h-[1.5px] w-2 rounded-full bg-wb-ink-3" />
			) : (
				<span className="block size-[7px] rounded-full border-[1.5px] border-wb-ink-3" />
			)}
		</span>
	);
}
