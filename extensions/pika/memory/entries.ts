import type { DreamMode, Outcome } from "./dream/run.ts";

/** The custom entry that pins a session's memory index at its first run. */
export const PIN_ENTRY = "pika-memory";

/** The pin: `index` is null when the fetch failed, timed out, or pika was logged out, so the session never gains a section. */
export interface MemoryPin { index: string | null; fetchedAt: string; project?: string; repository?: string; error?: string }

/** The custom entry that records, in the session that asked for a dream, how the dream ended. */
export const DREAM_ENTRY = "pika-memory-dream";

/**
 * How a dream ended. It is a custom entry, so it never reaches the model. pika uploads it with the session, and the
 * server's public and agent namespaces omit only `pika-memory` entries, so it holds no note's title, hook, or body.
 */
export interface DreamRecord {
	leaseId: string;
	mode: DreamMode;
	outcome: Outcome;
	reason: string;
	startedAt: string;
	endedAt: string;
	/** The label of the lease's scope: the project's name. */
	scope?: string;
	/** The sessions the lease gave the dream to review. */
	sessions: string[];
	/** The batches it committed. */
	batches: number;
	notesChanged: number;
	/** Staged changes thrown away by refused commits and at the end. */
	discarded: number;
	/** The changes of a commit whose outcome was still unknown at the end, which the server may have written. */
	uncertain: number;
	turns: number;
	/** Budget tokens (cache reads count a tenth). */
	tokens: number;
	/** The dream's child session, once it started. */
	childSessionId?: string;
	/** `<provider>/<model id>`. */
	model: string;
	/** Every note change its batches wrote, in order. */
	changes: { noteId: string; revision: number; action: "save" | "forget"; created: boolean }[];
}
