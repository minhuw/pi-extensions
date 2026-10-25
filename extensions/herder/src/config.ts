import { availableParallelism } from "node:os";
import type { Limits } from "./types.ts";

export const HERDER_VERSION = "0.1.0";
export const JOURNAL_SCHEMA_VERSION = 1;
export const STEP_KEY_VERSION = 1;
export const MIN_GIT_VERSION = "2.38.0"; // merge-tree --write-tree

/** §7 limits; enforced where calls happen. */
export const LIMITS: Readonly<Limits> = Object.freeze({
	concurrentAgents: Math.min(6, Math.max(1, availableParallelism() - 2)),
	concurrentWriters: 4,
	agentsPerLaunch: 100,
	agentsPerRun: 400,
	itemsPerCall: 1024,
	timeoutMs: 60 * 60_000,
	stallMs: 10 * 60_000,
	retryBackoffMs: Object.freeze([30_000, 2 * 60_000, 8 * 60_000]) as number[],
	stallRestarts: 2,
});

export const DEFAULT_ROLE = "worker";
export const BUILTIN_ROLES = ["worker", "reviewer", "verifier", "resolver", "curator", "explorer"] as const;
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
export const STRUCTURED_OUTPUT_REJECTIONS = 3;

export const LOCK_STALE_MS = 2 * 60_000;
export const LOCK_HEARTBEAT_MS = 30_000;

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
export const CHECK_TAIL_LINES = 40;
export const CHECK_ERROR_LINES = 20;

/** Step text above this many characters is stored in `outputs/` and journaled as `textRef`. */
export const INLINE_TEXT_LIMIT = 8_000;
/** Characters of a script's return value included in the completion follow-up. */
export const FOLLOWUP_RESULT_LIMIT = 4_000;

export const VERIFIER_DIFF_LINES = 200;
export const MAX_CLARIFYING_QUESTIONS = 5;
export const DEFAULT_FIX_ATTEMPTS = 3;

export const HERDER_DIR = "herder"; // under <git-common-dir>
export const REF_ROOT = "refs/herder";
export const TRAILER_STEP = "Herder-Step";
export const TRAILER_FINGERPRINT = "Herder-Fingerprint";

export const STATUS_KEY = "herder";
export const ACTIVITY_EVENT = "pi-extensions:activity";
export const ACTIVITY_REQUEST_EVENT = "pi-extensions:activity-request";
