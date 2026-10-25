import * as piAi from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentError, type ErrorClass } from "../types.ts";

// Order matters: a per-minute/second quota is a rate limit; any other quota exhaustion often arrives as a 429 and must not be retried.
const MESSAGE_RULES: [ErrorClass, RegExp][] = [
	["rate_limit", /quota.*\bper[ _-]?(?:minute|second)\b|\b(?:rpm|tpm|rps|qpm)\b/i],
	["usage_limit", /insufficient[_ ](?:quota|credits?|balance|funds)|exceeded your (?:current )?quota|quota (?:exceeded|exhausted)|usage[_ ]limit|credit balance is too low|out of (?:credits|budget)|billing|payment required|\b402\b/i],
	["rate_limit", /\b429\b|rate[_ -]?limit|too many requests|throttl/i],
	["auth", /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|invalid[_ ](?:api[_ ]?key|x-api-key|token|credentials?)|incorrect api key|(?:missing|no) api key|api key (?:is )?(?:missing|invalid|not (?:found|set|configured))|no (?:model )?credentials|not logged in|(?:oauth )?token (?:has )?expired/i],
	["transient", /\b(?:500|502|503|504|520|522|524|529)\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|econnreset|econnrefused|econnaborted|etimedout|epipe|eai_again|enotfound|socket hang up|fetch failed|network error|connection (?:reset|closed|refused|error|terminated)|premature close|stream (?:ended|closed|interrupted|disconnected)|ended without|timed out|timeout|\bterminated\b|other side closed|provider returned (?:an )?error|server[_ ]error|internal error/i],
];

// Absent from older pi-ai releases; a namespace read keeps the module loadable there.
const { isRetryableAssistantError } = piAi as Partial<Pick<typeof piAi, "isRetryableAssistantError">>;

function statusClass(status: number): ErrorClass | undefined {
	if (status === 429) return "rate_limit";
	if (status === 402) return "usage_limit";
	if (status === 401 || status === 403) return "auth";
	if (status === 408 || status >= 500) return "transient";
	return undefined;
}

/** Classifies a provider or runtime error message; after our rules, whatever pi-ai would retry is `transient`, the rest `fatal`. */
export function classifyMessage(message: string): ErrorClass {
	const matched = MESSAGE_RULES.find(([, pattern]) => pattern.test(message))?.[0];
	if (matched) return matched;
	return isRetryableAssistantError?.({ stopReason: "error", errorMessage: message } as AssistantMessage) ? "transient" : "fatal";
}

/** `AgentError` keeps its class; other errors are classified by HTTP status and message. */
export function classifyError(error: unknown): ErrorClass {
	if (error instanceof AgentError) return error.errorClass;
	const message = error instanceof Error ? error.message : String(error);
	const byMessage = classifyMessage(message);
	if (byMessage === "usage_limit") return byMessage;
	const record = typeof error === "object" && error !== null ? error as { status?: unknown; statusCode?: unknown } : {};
	const status = typeof record.status === "number" ? record.status : typeof record.statusCode === "number" ? record.statusCode : undefined;
	return (status === undefined ? undefined : statusClass(status)) ?? byMessage;
}

export function toAgentError(error: unknown): AgentError {
	if (error instanceof AgentError) return error;
	return new AgentError(classifyError(error), error instanceof Error ? error.message : String(error), { cause: error });
}
