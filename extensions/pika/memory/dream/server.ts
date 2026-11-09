import { MemoryServerError, timing } from "../client.ts";

/**
 * The pika server and token a dream was granted its lease by. A dream sends every lease request (renew, commit,
 * release) with them, so they reach that server even after `/pika logout` or a login elsewhere; `memory/client.ts`
 * always uses the current credentials.
 */
export interface LeaseServer { url: string; token: string }

/** No answer came: the server could not be reached, did not answer in time, or sent an unreadable 200. */
export class NoAnswer extends Error {}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Sends `{url}/api/agent/v1/<path>` to `server` and returns the 200 answer's JSON. Any other status throws a
 * `MemoryServerError` with the answer's body; no answer throws `NoAnswer`.
 */
export async function send<T>(server: LeaseServer, method: "GET" | "POST", path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
	const timeoutMs = options.timeoutMs ?? timing.httpTimeoutMs;
	const headers: Record<string, string> = { Authorization: `Bearer ${server.token}`, Accept: "application/json" };
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(`${server.url}/api/agent/v1/${path}`, {
			method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error", ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
		});
	} catch (error) {
		const why = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 100) / 10} s` : errorText(error);
		throw new NoAnswer(`could not reach the pika server at ${server.url}: ${why}.`);
	}
	if (response.status === 200) {
		try {
			return await response.json() as T;
		} catch (error) {
			throw new NoAnswer(`the pika server at ${server.url} sent an unreadable answer: ${errorText(error)}.`);
		}
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed = await response.json() as unknown;
		if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
	} catch { /* not JSON */ }
	const code = typeof body.error === "string" ? body.error : undefined;
	const message = response.status === 401 ? `the pika server at ${server.url} rejected this device's token (HTTP 401).`
		: response.status === 403 && code === "read_access_denied" ? `this device may not use agent memory on the pika server at ${server.url} (HTTP 403 read_access_denied).`
		: `unexpected HTTP ${response.status}${code ? ` (${code})` : ""} from the pika server at ${server.url}.`;
	throw new MemoryServerError(message, response.status, body);
}

/** Whether a failed request may still have been applied: no answer, or a 5xx (from pika or a proxy in front of it). */
export const outcomeUnknown = (error: unknown): boolean => error instanceof NoAnswer || (error instanceof MemoryServerError && error.status >= 500);
