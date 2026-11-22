import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { credentialsRegistry, type PikaCredentials } from "./credentials.ts";

/** A pika server base URL and bearer token for `/api/agent/v1/` requests. */
export interface AgentServer {
	url: string;
	token: string;
}

export interface AgentFetchOptions {
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs: number;
}

export type AgentFetchResult<T> =
	| { ok: true; data: T }
	| { ok: false; kind: "credentials_in_url"; url: string }
	| { ok: false; kind: "aborted"; url: string }
	| { ok: false; kind: "timeout"; phase: "connect" | "body"; url: string; seconds: number }
	| { ok: false; kind: "network"; url: string; reason: string }
	| { ok: false; kind: "unreadable"; url: string; reason: string }
	| { ok: false; kind: "http"; url: string; status: number; body: Record<string, unknown>; code?: string };

export type AgentTransportFailure = Exclude<AgentFetchResult<never>, { ok: true } | { ok: false; kind: "http" }>;
export type AgentHttpFailure = Extract<AgentFetchResult<never>, { ok: false; kind: "http" }>;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `text` with the user name and password taken out of every URL in it: fetch's errors repeat the URL they failed on. */
export const withoutCredentials = (text: string) => text.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#]*@/gi, "$1");

const credentialsInUrlMessage = (feature: string) =>
	`pika's server URL contains a user name or password, which pika never sends, so ${feature} is off. Ask the user to remove them from PIKA_URL or the url in pika.json.`;

/** Why pika's configuration disables it, when it does; undefined when pika is merely not logged in. */
export function disabledCause(): string | undefined {
	try {
		const config = loadConfig(getAgentDir());
		if (!config.enabled && !config.unconfigured) {
			// A parser's message may quote the file, token included.
			return withoutCredentials(config.unreadable ? `pika cannot read ${config.file}` : config.reason);
		}
	} catch { /* not logged in */ }
	return undefined;
}

export type CredentialsCheckResult =
	| { ok: true; credentials: PikaCredentials }
	| { ok: false; kind: "disabled"; cause: string }
	| { ok: false; kind: "unconfigured" | "excluded" | "credentials_in_url"; cause?: undefined };

/**
 * Checks whether pika has usable credentials for a session in `cwd`, returning either the
 * credentials or the structured reason they cannot be used.
 */
export function checkCredentials(cwd: string): CredentialsCheckResult {
	const value = credentialsRegistry().current;
	if (!value) {
		const cause = disabledCause();
		return cause ? { ok: false, kind: "disabled", cause } : { ok: false, kind: "unconfigured" };
	}
	if (value.isExcluded(cwd)) return { ok: false, kind: "excluded" };
	if (withoutCredentials(value.url) !== value.url) return { ok: false, kind: "credentials_in_url" };
	return { ok: true, credentials: value };
}

/**
 * The credentials to use for `feature` in a session in `cwd`. Throws the user-facing error text
 * when pika is disabled, not logged in, excludes `cwd`, or has credentials embedded in its URL.
 */
export function requireCredentials(cwd: string, feature: string): PikaCredentials {
	const check = checkCredentials(cwd);
	if (check.ok) return check.credentials;
	switch (check.kind) {
		case "disabled":
			throw new Error(`${feature} is off because pika is disabled: ${check.cause}. Tell the user; /pika shows why.`);
		case "unconfigured":
			throw new Error(`${feature} needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.`);
		case "excluded":
			throw new Error(`pika's exclude list covers this session's working directory (${cwd}), so ${feature} is off in this session.`);
		case "credentials_in_url":
			throw new Error(credentialsInUrlMessage(feature));
	}
}

/**
 * Sends `{url}/api/agent/v1/<path>` to `server` with `redirect: "error"`, timeout/abort handling,
 * URL credential scrubbing, and JSON response parsing, returning a structured outcome.
 */
export async function agentFetch<T>(
	server: AgentServer,
	method: "GET" | "POST",
	path: string,
	options: AgentFetchOptions,
): Promise<AgentFetchResult<T>> {
	const url = withoutCredentials(server.url);
	if (url !== server.url) return { ok: false, kind: "credentials_in_url", url };
	const timeoutMs = options.timeoutMs;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const seconds = Math.round(timeoutMs / 100) / 10;
	const headers: Record<string, string> = { Authorization: `Bearer ${server.token}`, Accept: "application/json" };
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(`${url}/api/agent/v1/${path}`, {
			method, headers, signal, redirect: "error", ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) return { ok: false, kind: "aborted", url };
		if (timeout.aborted) return { ok: false, kind: "timeout", phase: "connect", url, seconds };
		return { ok: false, kind: "network", url, reason: withoutCredentials(errorText(error)) };
	}
	/** The failure for an answer cut off by the caller's abort or the timeout, if it was. */
	const interrupted = (): AgentTransportFailure | undefined =>
		options.signal?.aborted ? { ok: false, kind: "aborted", url }
		: timeout.aborted ? { ok: false, kind: "timeout", phase: "body", url, seconds }
		: undefined;
	if (response.status === 200) {
		try {
			return { ok: true, data: await response.json() as T };
		} catch (error) {
			return interrupted() ?? { ok: false, kind: "unreadable", url, reason: withoutCredentials(errorText(error)) };
		}
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed = await response.json() as unknown;
		if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
	} catch {
		// Not JSON, unless the answer was cut off.
		const stopped = interrupted();
		if (stopped) return stopped;
	}
	const code = typeof body.error === "string" ? body.error : undefined;
	return { ok: false, kind: "http", url, status: response.status, body, ...(code !== undefined ? { code } : {}) };
}

/** Formats a non-HTTP failure from `agentFetch` for `feature`. */
export function formatTransportError(failure: AgentTransportFailure, feature: string): string {
	switch (failure.kind) {
		case "credentials_in_url":
			return credentialsInUrlMessage(feature);
		case "aborted":
			return `${feature} was cancelled.`;
		case "timeout":
			return failure.phase === "connect"
				? `could not reach the pika server at ${failure.url}: no answer within ${failure.seconds} s.`
				: `the pika server at ${failure.url} did not finish its answer within ${failure.seconds} s.`;
		case "network":
			return `could not reach the pika server at ${failure.url}: ${failure.reason}.`;
		case "unreadable":
			return `the pika server at ${failure.url} sent an unreadable answer: ${failure.reason}.`;
	}
}

export interface AuthErrorOptions {
	/** The action denied on HTTP 403 `read_access_denied`, e.g. `"use agent memory on"` or `"read trajectories from"`. */
	readAction: string;
	/** Include `/pika login` and read-access instructions for interactive tools; false for background dream requests. */
	includeAdvice?: boolean;
}

/**
 * Maps common HTTP 401 and HTTP 403 (`read_access_denied`) responses to user-facing error text;
 * returns `undefined` for all other HTTP statuses.
 */
export function mapAuthHttpError(failure: AgentHttpFailure, options: AuthErrorOptions): string | undefined {
	const advice = options.includeAdvice ?? true;
	if (failure.status === 401) {
		return advice
			? `the pika server at ${failure.url} rejected this device's token (HTTP 401). Ask the user to run /pika login to pair this device again.`
			: `the pika server at ${failure.url} rejected this device's token (HTTP 401).`;
	}
	if (failure.status === 403 && failure.code === "read_access_denied") {
		return advice
			? `this device may not ${options.readAction} the pika server (HTTP 403 read_access_denied). Ask the user to grant it read access: `
				+ `turn on "Agents can read" for this device on ${failure.url}/devices, or run \`pika token read-access <device> on\` on the server.`
			: `this device may not ${options.readAction} the pika server at ${failure.url} (HTTP 403 read_access_denied).`;
	}
	return undefined;
}

/** Formats an unexpected HTTP status from `agentFetch`. */
export function formatUnexpectedHttpError(failure: AgentHttpFailure): string {
	return `unexpected HTTP ${failure.status}${failure.code ? ` (${failure.code})` : ""} from the pika server at ${failure.url}.`;
}
