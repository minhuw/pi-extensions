import { JOURNAL_SCHEMA_VERSION } from "../config.ts";
import type { JournalEvent, JournalEventType, JournalInput } from "../types.ts";

export const EVENT_TYPES: ReadonlySet<string> = new Set<JournalEventType>([
	"run.started", "goal.approved", "plan.updated", "script.launched", "script.settled",
	"step.started", "step.completed", "step.failed", "check.completed",
	"integrate.completed", "integrate.failed", "verify.completed",
	"decision.recorded", "delivery.completed", "run.finished",
]);

/** Adds the envelope: `v` and an informational ISO `at`. */
export function makeEvent<I extends JournalInput>(input: I, now = new Date()): Extract<JournalEvent, { t: I["t"] }> {
	const { t, ...fields } = input;
	return { v: JOURNAL_SCHEMA_VERSION, t, at: now.toISOString(), ...fields } as unknown as Extract<JournalEvent, { t: I["t"] }>;
}

/** True for an object with the envelope fields (`v`, `t`, `at`) of a known event type. */
export function isKnownEvent(value: unknown): value is JournalEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const event = value as Record<string, unknown>;
	return event.v === JOURNAL_SCHEMA_VERSION && typeof event.t === "string" && EVENT_TYPES.has(event.t) && typeof event.at === "string";
}
