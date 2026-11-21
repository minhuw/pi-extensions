import { agentFetch, formatTransportError, formatUnexpectedHttpError, mapAuthHttpError } from "../../agent-client.ts";
import { MemoryServerError, timing } from "../client.ts";

/**
 * The pika server and token a dream was granted its lease by. A dream sends every lease request (renew, commit,
 * release) with them, so they reach that server even after `/pika logout` or a login elsewhere; `memory/client.ts`
 * always uses the current credentials.
 */
export interface LeaseServer { url: string; token: string }

/** No answer came: the server could not be reached, did not answer in time, or sent an unreadable 200. */
export class NoAnswer extends Error {}

/**
 * Sends `{url}/api/agent/v1/<path>` to `server` and returns the 200 answer's JSON. Any other status throws a
 * `MemoryServerError` with the answer's body; no answer throws `NoAnswer`.
 */
export async function send<T>(server: LeaseServer, method: "GET" | "POST", path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
	const result = await agentFetch<T>(server, method, path, {
		...options,
		timeoutMs: options.timeoutMs ?? timing.httpTimeoutMs,
	});
	if (result.ok) return result.data;
	if (result.kind === "http") {
		const message = mapAuthHttpError(result, { readAction: "use agent memory on", includeAdvice: false })
			?? formatUnexpectedHttpError(result);
		throw new MemoryServerError(message, result.status, result.body);
	}
	if (result.kind === "credentials_in_url") {
		throw new Error(formatTransportError(result, "memory"));
	}
	throw new NoAnswer(formatTransportError(result, "dream"));
}

/** Whether a failed request may still have been applied: no answer, or a 5xx (from pika or a proxy in front of it). */
export const outcomeUnknown = (error: unknown): boolean => error instanceof NoAnswer || (error instanceof MemoryServerError && error.status >= 500);
