// Turns manager events into messages for the session that owns the process. Events within COALESCE_MS go out as one
// `process-event` message, steered into a running turn or starting one when idle. Other sessions' processes only
// raise a UI notification; they never start a turn here.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { duration, exitDescription, quoteTail } from "./format.ts";
import { sharedState } from "./state.ts";
import type { ProcessEvent, ProcessInfo } from "./types.ts";

export const MESSAGE_TYPE = "process-event";
export const COALESCE_MS = 250;

export interface EventSummary {
	type: ProcessEvent["type"];
	process: string;
	id: string;
	text: string;
}

export interface ProcessEventDetails {
	events: EventSummary[];
}

const label = (process: ProcessInfo) => `[process ${process.name}]`;

function ended(process: ProcessInfo): string {
	const after = process.endedAt !== undefined ? ` after ${duration(process.endedAt - process.startedAt)}` : "";
	const how = exitDescription(process);
	return `exited${how ? ` with ${how}` : ""}${after}`;
}

function withTail(head: string, lines: string[]): string {
	const quoted = quoteTail(lines);
	return quoted ? `${head}; last lines:\n${quoted}` : head;
}

/** The message line(s) for one event, or undefined for events that are not reported. */
export function describeEvent(event: ProcessEvent, now = Date.now()): string | undefined {
	const p = event.process;
	switch (event.type) {
		case "ready": {
			const urls = p.urls.length > 0 ? ` ${p.urls.join(" ")}` : "";
			return `${label(p)} ready (${event.via})${urls} after ${duration((p.readyAt ?? now) - p.startedAt)}`;
		}
		case "ready_timeout":
			return withTail(`${label(p)} not ready after ${duration(now - p.startedAt)}; still ${p.status}`, event.tail);
		case "error_output": {
			const suppressed = event.suppressed > 0 ? ` (${event.suppressed} more suppressed)` : "";
			return `${label(p)} error output${suppressed}:\n${quoteTail(event.lines)}`;
		}
		case "exit":
			return withTail(`${label(p)} ${ended(p)}`, event.tail);
		case "wait_done": {
			const head = `${label(p)} wait ${event.waitId} (${event.until})`;
			if (event.outcome === "timeout") return withTail(`${head} timed out; still ${p.status}`, event.tail);
			if (event.outcome === "exited") return withTail(`${head} unmet: ${ended(p)}`, event.tail);
			if (event.until === "match") return `${head} matched: ${event.line ?? ""}`;
			if (event.until === "exit") return withTail(`${head} done: ${ended(p)}`, event.tail);
			return `${head} done: ready${p.urls.length > 0 ? ` ${p.urls.join(" ")}` : ""}`;
		}
		case "changed":
			return undefined;
	}
}

interface Pending {
	summary: EventSummary;
	trigger: boolean;
	/** For "ready": the key process_start/process_restart record when their result already showed it. */
	readyKey?: string;
}

export const readyKey = (process: ProcessInfo) => `${process.id}:${process.readyAt}`;

export interface Notifier {
	handle(event: ProcessEvent): void;
	/** Drops anything pending; the session is going away. */
	dispose(): void;
}

/** Routes events for the session `sessionId` running in `ctx`. */
export function createNotifier(pi: Pick<ExtensionAPI, "sendMessage">, ctx: Pick<ExtensionContext, "hasUI" | "ui">, sessionId: string): Notifier {
	let pending: Pending[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		timer = undefined;
		const { reportedReady } = sharedState();
		const batch = pending.filter((item) => !(item.readyKey && reportedReady.delete(item.readyKey)));
		pending = [];
		if (batch.length === 0) return;
		pi.sendMessage<ProcessEventDetails>(
			{ customType: MESSAGE_TYPE, content: batch.map((item) => item.summary.text).join("\n\n"), display: true, details: { events: batch.map((item) => item.summary) } },
			{ deliverAs: "steer", triggerTurn: batch.some((item) => item.trigger) },
		);
	};
	const queue = (event: ProcessEvent, text: string, trigger: boolean) => {
		pending.push({ summary: { type: event.type, process: event.process.name, id: event.process.id, text }, trigger, ...(event.type === "ready" ? { readyKey: readyKey(event.process) } : {}) });
		timer ??= setTimeout(flush, COALESCE_MS);
	};

	return {
		handle(event) {
			// An attached run belongs to the bash call waiting for it, which reports it in its own result.
			if (event.type === "changed" || event.process.attached) return;
			const { requested, waits } = sharedState();
			if (event.type === "wait_done") {
				if (waits.get(event.waitId) !== sessionId) return;
				waits.delete(event.waitId);
				queue(event, describeEvent(event)!, true);
				return;
			}
			const text = describeEvent(event)!;
			if (event.process.owner !== sessionId) {
				if (event.type === "error_output" || (event.type === "exit" && event.requested)) return;
				if (ctx.hasUI) ctx.ui.notify(text, event.type === "ready" ? "info" : "warning");
				return;
			}
			if (event.type === "exit" && event.requested) {
				// The agent's own stops and restarts already returned their result; a stop the user chose in /ps is news,
				// but not worth a turn. Stops nobody here asked for (another session, shutdown) are not reported.
				const by = requested.get(event.process.id);
				if (by?.by === "user") queue(event, `${label(event.process)} stopped by the user${event.process.signal ? ` (${exitDescription(event.process)})` : ""}`, false);
				return;
			}
			queue(event, text, true);
		},
		dispose() {
			clearTimeout(timer);
			timer = undefined;
			pending = [];
		},
	};
}
