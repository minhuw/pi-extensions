import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.ts";
import { credentialsRegistry, type PikaCredentials } from "../credentials.ts";

/** Timeouts; tests shorten them. `indexTimeoutMs` bounds the index fetch at a session's first run. */
export const timing = { httpTimeoutMs: 15_000, indexTimeoutMs: 1_500 };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `text` with the user name and password taken out of every URL in it: fetch's errors repeat the URL they failed on. */
export const withoutCredentials = (text: string) => text.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#]*@/gi, "$1");

/** A server answer other than 200 that the tools explain from its status and body. */
export class MemoryServerError extends Error {
	constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}

/** Why pika published no credentials: its configuration disables it, else it is not logged in. */
function notLoggedIn(): string {
	try {
		const config = loadConfig(getAgentDir());
		if (!config.enabled && !config.unconfigured) {
			// A parser's message may quote the file, token included.
			const cause = config.unreadable ? `pika cannot read ${config.file}` : config.reason;
			return `memory is off because pika is disabled: ${withoutCredentials(cause)}. Tell the user; /pika shows why.`;
		}
	} catch { /* not logged in */ }
	return "memory needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.";
}

/** The credentials to use for a session in `cwd`; throws the text the tool's error shows. */
export function current(cwd: string): PikaCredentials {
	const value = credentialsRegistry().current;
	if (!value) throw new Error(notLoggedIn());
	if (value.isExcluded(cwd)) throw new Error(`pika's exclude list covers this session's working directory (${cwd}), so memory is off in this session.`);
	return value;
}

/**
 * Sends `{url}/api/agent/v1/<path>` with `body` as JSON and returns the 200 answer's JSON. Failures
 * to reach the server, 401, and 403 throw with the text the tool's error shows; other statuses throw
 * a `MemoryServerError` carrying the answer's body. No text repeats credentials of the server URL.
 */
export async function request<T>(cwd: string, method: "GET" | "POST", path: string, options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
	const { url: configured, token } = current(cwd);
	const url = withoutCredentials(configured);
	if (url !== configured) {
		throw new Error("pika's server URL contains a user name or password, which pika never sends, so memory is off. Ask the user to remove them from PIKA_URL or the url in pika.json.");
	}
	const timeoutMs = options.timeoutMs ?? timing.httpTimeoutMs;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const seconds = Math.round(timeoutMs / 100) / 10;
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(`${url}/api/agent/v1/${path}`, {
			method, headers, signal, redirect: "error", ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error("memory was cancelled.");
		if (timeout.aborted) throw new Error(`could not reach the pika server at ${url}: no answer within ${seconds} s.`);
		throw new Error(`could not reach the pika server at ${url}: ${withoutCredentials(errorText(error))}.`);
	}
	/** The error for an answer cut off by the caller's abort or the timeout, if it was. */
	const interrupted = () => options.signal?.aborted ? new Error("memory was cancelled.")
		: timeout.aborted ? new Error(`the pika server at ${url} did not finish its answer within ${seconds} s.`)
		: undefined;
	if (response.status === 200) {
		try {
			return await response.json() as T;
		} catch (error) {
			throw interrupted() ?? new Error(`the pika server at ${url} sent an unreadable answer: ${withoutCredentials(errorText(error))}.`);
		}
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed = await response.json() as unknown;
		if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
	} catch {
		// Not JSON, unless the answer was cut off.
		const stopped = interrupted();
		if (stopped) throw stopped;
	}
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
	const configured = credentialsRegistry().current?.url;
	const url = configured === undefined ? "the pika server" : withoutCredentials(configured);
	return `the pika server at ${url} has no agent memory API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`;
}
