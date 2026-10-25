import type { JournalEvent } from "../types.ts";

export interface RunState { runId?: string }

export function fold(events: readonly JournalEvent[]): RunState { throw new Error("not implemented"); }
