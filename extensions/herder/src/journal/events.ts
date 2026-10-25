import type { JournalEvent, JournalInput } from "../types.ts";

export function makeEvent(input: JournalInput, now?: Date): JournalEvent { throw new Error("not implemented"); }
/** True for an object with the envelope fields (`v`, `t`, `at`) of a known event type. */
export function isKnownEvent(value: unknown): value is JournalEvent { throw new Error("not implemented"); }
