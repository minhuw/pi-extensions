import {
	agentFetch, formatTransportError, formatUnexpectedHttpError, mapAuthHttpError, requireCredentials,
} from "../agent-client.ts";
import type { PikaCredentials } from "../credentials.ts";

/** Timeouts; tests shorten them. */
export const timing = { httpTimeoutMs: 15_000, healthTimeoutMs: 5_000, projectTimeoutMs: 2_000 };

/** The credentials to read with for a session in `cwd`; throws the text the tool's error shows. */
export function current(cwd: string): PikaCredentials {
	return requireCredentials(cwd, "recall");
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
export async function get<T>(cwd: string, path: string, options: { signal?: AbortSignal; missing: string }): Promise<T> {
	const credentials = current(cwd);
	const result = await agentFetch<T>(credentials, "GET", path, {
		signal: options.signal,
		timeoutMs: timing.httpTimeoutMs,
	});
	if (result.ok) return result.data;
	if (result.kind !== "http") throw new Error(formatTransportError(result, "recall"));
	const authError = mapAuthHttpError(result, { readAction: "read trajectories from" });
	if (authError) throw new Error(authError);
	if (result.status === 404) {
		if (await hasAgentApi(result.url)) throw new Error(options.missing);
		throw new Error(`the pika server at ${result.url} has no agent read API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`);
	}
	throw new Error(formatUnexpectedHttpError(result));
}
