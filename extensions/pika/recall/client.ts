import { credentialsRegistry, type PikaCredentials } from "../credentials.ts";

/** Timeouts; tests shorten them. */
export const timing = { httpTimeoutMs: 15_000, healthTimeoutMs: 5_000, projectTimeoutMs: 2_000 };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The credentials to read with; throws the text the tool's error shows. */
export function current(): PikaCredentials {
	const value = credentialsRegistry().current;
	if (!value) throw new Error("recall needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.");
	return value;
}

/** Whether the server's health lists the agent read API; false when it cannot be read. */
async function hasAgentApi(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timing.healthTimeoutMs), redirect: "error" });
		if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return false; }
		const body = await response.json() as { features?: unknown };
		return Array.isArray(body.features) && body.features.includes("agent");
	} catch {
		return false;
	}
}

/**
 * GETs `{url}/api/agent/v1/<path>` and returns its JSON. Every failure throws with the text the
 * tool's error shows; `missing` is that text for a 404 from a server that has the agent API.
 */
export async function get<T>(path: string, options: { signal?: AbortSignal; missing: string }): Promise<T> {
	const { url, token } = current();
	const timeout = AbortSignal.timeout(timing.httpTimeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(`${url}/api/agent/v1/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal, redirect: "error" });
	} catch (error) {
		if (options.signal?.aborted) throw new Error("recall was cancelled.");
		if (timeout.aborted) throw new Error(`could not reach the pika server at ${url}: no answer within ${timing.httpTimeoutMs / 1000} s.`);
		throw new Error(`could not reach the pika server at ${url}: ${errorText(error)}.`);
	}
	if (response.status === 200) {
		try {
			return await response.json() as T;
		} catch (error) {
			throw new Error(`the pika server at ${url} sent an unreadable answer: ${errorText(error)}.`);
		}
	}
	let code: unknown;
	try { code = (await response.json() as { error?: unknown }).error; } catch { /* not JSON */ }
	if (response.status === 401) {
		throw new Error(`the pika server at ${url} rejected this device's token (HTTP 401). Ask the user to run /pika login to pair this device again.`);
	}
	if (response.status === 403 && code === "read_access_denied") {
		throw new Error(`this device may not read trajectories from the pika server (HTTP 403 read_access_denied). Ask the user to grant it read access: `
			+ `turn on "Agents can read" for this device on ${url}/devices, or run \`pika token read-access <device> on\` on the server.`);
	}
	if (response.status === 404) {
		if (await hasAgentApi(url)) throw new Error(options.missing);
		throw new Error(`the pika server at ${url} has no agent read API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`);
	}
	throw new Error(`unexpected HTTP ${response.status}${typeof code === "string" ? ` (${code})` : ""} from the pika server at ${url}.`);
}
