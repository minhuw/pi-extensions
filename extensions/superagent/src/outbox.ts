// Delivery of ticket reports to the main session; see DESIGN.md "Reports to the main session".
import type { NotifyKind } from "./dispatcher.ts";
import { reportMessage, type ReportDetails } from "./render.ts";
import type { React } from "./types.ts";

/** Reports that need the user (or the router) and so start a main-session turn. */
export const ATTENTION_KINDS: ReadonlySet<NotifyKind> = new Set(["question", "ready", "blocked", "failed", "waiting", "merge-handed", "merge-refused"]);
/** How long an idle session collects reports before one turn starts for them. */
export const HOLD_MS = 200;

type Message = ReturnType<typeof reportMessage>;
export interface SendOptions { triggerTurn: boolean; deliverAs?: "steer" | "followUp" }

export interface OutboxHost {
	send(message: Message, options: SendOptions): void;
	/** The main session is idle (no run streaming). */
	isIdle(): boolean;
	react(): React;
	holdMs?: number;
}

/**
 * Reports that need attention start a turn: while idle after a short hold (collecting what arrives meanwhile), while
 * busy at the next `turn_end`, as one `steer` message. Several reports are one message with `details.batch`. Other
 * reports (and every report with `react: "none"`) are shown at once without a turn.
 */
export class Outbox {
	private queue: ReportDetails[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(private readonly host: OutboxHost) {}

	get pending(): readonly ReportDetails[] { return this.queue; }

	push(details: ReportDetails): void {
		if (this.closed) return;
		if (this.host.react() === "none" || !ATTENTION_KINDS.has(details.kind)) {
			this.quiet(details);
			return;
		}
		this.queue.push(details);
		if (this.host.isIdle()) this.arm();
		// While busy the queue waits for `turnEnd`.
	}

	/** The main session finished a turn: deliver what waits, steering it into the run (or starting one when idle). */
	turnEnd(): void {
		if (this.closed || !this.queue.length) return;
		this.clear();
		this.flush();
	}

	/** The run ended: what is left goes out after the hold. */
	agentEnd(): void {
		if (this.closed || !this.queue.length) return;
		this.arm();
	}

	/** Accepts reports again after `dispose` (a new session of the same extension instance). */
	reset(): void {
		this.closed = false;
	}

	dispose(): void {
		this.closed = true;
		this.clear();
		this.queue = [];
	}

	private quiet(details: ReportDetails): void {
		const message = reportMessage([details]);
		try {
			if (this.host.isIdle()) this.host.send(message, { triggerTurn: false });
			else this.host.send(message, { triggerTurn: false, deliverAs: "followUp" });
		} catch {}
	}

	private arm(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			// A run started during the hold: the reports join it at its next turn end.
			if (this.host.isIdle()) this.flush();
		}, this.host.holdMs ?? HOLD_MS);
		this.timer.unref?.();
	}

	private clear(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private flush(): void {
		if (this.closed || !this.queue.length) return;
		const reports = this.queue;
		this.queue = [];
		const message = reportMessage(reports);
		try {
			if (this.host.isIdle()) this.host.send(message, { triggerTurn: true });
			else this.host.send(message, { triggerTurn: true, deliverAs: "steer" });
		} catch {}
	}
}
