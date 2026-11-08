import { credentialsRegistry, type PikaCredentials } from "../credentials.ts";

/** Timeouts; tests shorten them. `indexTimeoutMs` bounds the index fetch at a session's first run. */
export const timing = { httpTimeoutMs: 15_000, indexTimeoutMs: 1_500 };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A server answer other than 200 that the tools explain from its status and body. */
export class MemoryServerError extends Error {
	constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}

/** The credentials to use for a session in `cwd`; throws the text the tool's error shows. */
export function current(cwd: string): PikaCredentials {
	const value = credentialsRegistry().current;
	if (!value) throw new Error("memory needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.");
	if (value.isExcluded(cwd)) throw new Error(`pika's exclude list covers this session's working directory (${cwd}), so memory is off in this session.`);
	return value;
}

/**
 * Sends `{url}/api/agent/v1/<path>` with `body` as JSON and returns the 200 answer's JSON. Failures
 * to reach the server, 401, and 403 throw with the text the tool's error shows; other statuses throw
 * a `MemoryServerError` carrying the answer's body.
 */
export async function request<T>(cwd: string, method: "GET" | "POST", path: string, options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
	const { url, token } = current(cwd);
	const timeoutMs = options.timeoutMs ?? timing.httpTimeoutMs;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(`${url}/api/agent/v1/${path}`, {
			method, headers, signal, redirect: "error", ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error("memory was cancelled.");
		if (timeout.aborted) throw new Error(`could not reach the pika server at ${url}: no answer within ${Math.round(timeoutMs / 100) / 10} s.`);
		throw new Error(`could not reach the pika server at ${url}: ${errorText(error)}.`);
	}
	if (response.status === 200) {
		try {
			return await response.json() as T;
		} catch (error) {
			throw new Error(`the pika server at ${url} sent an unreadable answer: ${errorText(error)}.`);
		}
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed = await response.json() as unknown;
		if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
	} catch { /* not JSON */ }
	const code = typeof body.error === "string" ? body.error : undefined;
	if (response.status === 401) {
		throw new Error(`the pika server at ${url} rejected this device's token (HTTP 401). Ask the user to run /pika login to pair this device again.`);
	}
	if (response.status === 403 && code === "read_access_denied") {
		throw new Error(`this device may not use agent memory on the pika server (HTTP 403 read_access_denied). Ask the user to grant it read access: `
			+ `turn on "Agents can read" for this device on ${url}/devices, or run \`pika token read-access <device> on\` on the server.`);
	}
	throw new MemoryServerError(`unexpected HTTP ${response.status}${code ? ` (${code})` : ""} from the pika server at ${url}.`, response.status, body);
}

/** The text for a 404 from a server without the memory routes. */
export function noMemoryApi(): string {
	const url = credentialsRegistry().current?.url ?? "the pika server";
	return `the pika server at ${url} has no agent memory API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`;
}
