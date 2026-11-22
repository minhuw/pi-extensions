import {
	agentFetch, formatTransportError, formatUnexpectedHttpError, mapAuthHttpError, requireCredentials, withoutCredentials,
} from "../agent-client.ts";
import { credentialsRegistry, type PikaCredentials } from "../credentials.ts";

/** Timeouts; tests shorten them. `indexTimeoutMs` bounds the index fetch at a session's first run. */
export const timing = { httpTimeoutMs: 15_000, indexTimeoutMs: 1_500 };

/** A server answer other than 200 that the tools explain from its status and body. */
export class MemoryServerError extends Error {
	constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}

/** The credentials to use for a session in `cwd`; throws the text the tool's error shows. */
function current(cwd: string): PikaCredentials {
	return requireCredentials(cwd, "memory");
}

/**
 * Sends `{url}/api/agent/v1/<path>` with `body` as JSON and returns the 200 answer's JSON. Failures
 * to reach the server, 401, and 403 throw with the text the tool's error shows; other statuses throw
 * a `MemoryServerError` carrying the answer's body. No text repeats credentials of the server URL.
 */
export async function request<T>(cwd: string, method: "GET" | "POST", path: string, options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
	const credentials = current(cwd);
	const result = await agentFetch<T>(credentials, method, path, {
		...options,
		timeoutMs: options.timeoutMs ?? timing.httpTimeoutMs,
	});
	if (result.ok) return result.data;
	if (result.kind !== "http") throw new Error(formatTransportError(result, "memory"));
	const authError = mapAuthHttpError(result, { readAction: "use agent memory on" });
	if (authError) throw new Error(authError);
	throw new MemoryServerError(formatUnexpectedHttpError(result), result.status, result.body);
}

/** The text for a 404 from a server without the memory routes. */
export function noMemoryApi(): string {
	const configured = credentialsRegistry().current?.url;
	const url = configured === undefined ? "the pika server" : withoutCredentials(configured);
	return `the pika server at ${url} has no agent memory API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`;
}
