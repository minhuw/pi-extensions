import { createContext, useContext } from "react";
import { withBase } from "./base";
import type {
	AuthMode,
	BrowserSession,
	Device,
	Entry,
	Facets,
	Health,
	Me,
	ModelRequest,
	Page,
	OnlineSession,
	Pairing,
	PairingApproval,
	RelayEvent,
	RelaySendResult,
	RunDetail,
	RunSummary,
	SearchHit,
	SessionDetail,
	SessionSummary,
	SessionTrace,
	SessionUpdates,
	Turn,
} from "./types";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body?: unknown,
		/** Seconds to wait, from a 429's `retryAfter` or its `Retry-After` header. */
		readonly retryAfter?: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/** The server's auth mode; servers older than 0.2 report only whether a password is required. */
export function authModeOf(me: Me | undefined): AuthMode | undefined {
	if (!me) return undefined;
	return me.authMode ?? (me.passwordRequired ? "password" : "none");
}

function retryAfterOf(body: unknown, header: string | null): number | undefined {
	const fromBody = body && typeof body === "object" && "retryAfter" in body ? (body as { retryAfter: unknown }).retryAfter : undefined;
	const value = Number(fromBody ?? header ?? Number.NaN);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Where the browser-session routes live. The contract's `GET sessions` is already the pi session
 * list, so they sit under `auth/`.
 */
const BROWSER_SESSIONS = "auth/sessions";

type Params = Record<string, string | number | boolean | null | undefined>;

export interface PublishingSettings {
	projects: { project: string; sessionCount: number; published: boolean }[];
}

export interface SessionFilters {
	device?: string;
	project?: string;
	model?: string;
	from?: string;
	to?: string;
	root?: boolean;
}

function query(params: Params): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

export class PikaApi {
	private readonly unauthorizedListeners = new Set<() => void>();

	constructor(
		readonly base: string,
		private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
		readonly publicView = false,
	) {}

	/** A separate client for anonymous browsing, retaining the configured base path and transport. */
	forPublic(): PikaApi {
		return new PikaApi(this.base, this.fetchImpl, true);
	}

	/** Called on every 401 except a failed login. Returns an unsubscribe function. */
	onUnauthorized(listener: () => void): () => void {
		this.unauthorizedListeners.add(listener);
		return () => this.unauthorizedListeners.delete(listener);
	}

	/** Absolute URL path of a read API route, e.g. `url("sessions")`. */
	url(path: string, params: Params = {}): string {
		return withBase(this.base, `${this.publicView ? "api/public/v1" : "api/v1"}/${path.replace(/^\/+/, "")}`) + query(params);
	}

	private request<T>(path: string, params: Params = {}, init?: RequestInit): Promise<T> {
		return this.fetchJson(this.url(path, params), path, init);
	}

	private async fetchJson<T>(url: string, path: string, init?: RequestInit): Promise<T> {
		const response = await this.fetchImpl(url, {
			credentials: this.publicView ? "omit" : "same-origin",
			...(this.publicView ? { cache: "no-store" as const } : {}),
			...init,
			headers: { Accept: "application/json", ...(init?.headers ?? {}) },
		});
		if (!response.ok) {
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			const detail =
				body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
			if (response.status === 401 && path !== "login") for (const listener of this.unauthorizedListeners) listener();
			const retryAfter = response.status === 429 ? retryAfterOf(body, response.headers.get("Retry-After")) : undefined;
			throw new ApiError(response.status, detail || `HTTP ${response.status}`, body, retryAfter);
		}
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** A state-changing call: DELETE, or POST or PATCH with a JSON body (the server rejects form posts). */
	private send<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
		if (method === "DELETE") return this.request(path, {}, { method });
		return this.request(path, {}, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
	}

	/** `{base}/api/health`, outside the read API; it is always open. */
	health(): Promise<Health> {
		return this.fetchJson(withBase(this.base, "api/health"), "health");
	}

	publishing(): Promise<PublishingSettings> {
		return this.request("settings/publishing");
	}

	setPublished(project: string, published: boolean): Promise<PublishingSettings> {
		return this.send("settings/publishing", "PATCH", { project, published });
	}

	facets(): Promise<Facets> {
		return this.request("facets");
	}

	sessions(filters: SessionFilters, cursor?: string, limit?: number): Promise<Page<SessionSummary>> {
		return this.request("sessions", { ...filters, root: filters.root ? true : undefined, cursor, limit });
	}

	session(id: string): Promise<SessionDetail> {
		return this.request(`sessions/${encodeURIComponent(id)}`);
	}

	turns(id: string, cursor?: string, limit?: number): Promise<Page<Turn>> {
		return this.request(`sessions/${encodeURIComponent(id)}/turns`, { cursor, limit });
	}

	entries(id: string, range: { from?: number; to?: number; limit?: number }): Promise<{ items: Entry[] }> {
		return this.request(`sessions/${encodeURIComponent(id)}/entries`, range);
	}

	/** The session's records for the trajectory view, without raw entries. */
	trace(id: string): Promise<SessionTrace> {
		return this.request(`sessions/${encodeURIComponent(id)}/trace`);
	}

	updates(id: string, since: number): Promise<SessionUpdates> {
		return this.request(`sessions/${encodeURIComponent(id)}/updates`, { since });
	}

	rawEntryUrl(id: string, seq: number): string {
		return this.url(`sessions/${encodeURIComponent(id)}/entries/${seq}/raw`);
	}

	exportUrl(id: string): string {
		return this.url(`sessions/${encodeURIComponent(id)}/export`);
	}

	modelRequest(id: string): Promise<ModelRequest> {
		return this.request(`requests/${encodeURIComponent(id)}`);
	}

	herderRuns(cursor?: string, limit?: number): Promise<Page<RunSummary>> {
		return this.request("herder/runs", { cursor, limit });
	}

	herderRun(id: string): Promise<RunDetail> {
		return this.request(`herder/runs/${encodeURIComponent(id)}`);
	}

	search(params: { q: string; device?: string; project?: string; cursor?: string; limit?: number }): Promise<Page<SearchHit>> {
		return this.request("search", params);
	}

	me(): Promise<Me> {
		return this.request("me");
	}

	login(password: string): Promise<unknown> {
		return this.send("login", "POST", { password });
	}

	logout(): Promise<unknown> {
		return this.send("logout", "POST");
	}

	browserSessions(): Promise<{ items: BrowserSession[] }> {
		return this.request(BROWSER_SESSIONS);
	}

	deleteBrowserSession(id: string): Promise<void> {
		return this.send(`${BROWSER_SESSIONS}/${encodeURIComponent(id)}`, "DELETE");
	}

	/** Signs out every browser, this one included. */
	revokeAllBrowserSessions(): Promise<unknown> {
		return this.send(`${BROWSER_SESSIONS}/revoke-all`, "POST");
	}

	devices(): Promise<{ items: Device[] }> {
		return this.request("devices");
	}

	/** Revokes a device's token, by id. */
	revokeDevice(id: string): Promise<void> {
		return this.send(`devices/${encodeURIComponent(id)}`, "DELETE");
	}

	renameDevice(id: string, name: string): Promise<{ id: string; name: string }> {
		return this.send(`devices/${encodeURIComponent(id)}`, "PATCH", { name });
	}

	pairings(): Promise<{ items: Pairing[] }> {
		return this.request("pairings");
	}

	/**
	 * Approves a pending pairing. `continues` is the id of the existing device the machine continues (its current token
	 * stops working), or `null` for a new device.
	 */
	approvePairing(code: string, body: { name: string; continues: string | null }): Promise<PairingApproval> {
		return this.send(`pairings/${encodeURIComponent(code)}/approve`, "POST", body);
	}

	denyPairing(code: string): Promise<void> {
		return this.send(`pairings/${encodeURIComponent(code)}/deny`, "POST");
	}

	relaySessions(): Promise<{ items: OnlineSession[] }> {
		return this.request("relay/sessions");
	}

	/** The relay's recent messages, newest first; the server keeps at most 500. */
	relayEvents(limit?: number): Promise<{ items: RelayEvent[] }> {
		return this.request("relay/events", { limit });
	}

	/** Sends a message from the user to a session; a refusal is an `ApiError` whose message is the reason. */
	sendRelayMessage(body: { to: string; text: string; urgent: boolean }): Promise<RelaySendResult> {
		return this.send("relay/messages", "POST", body);
	}
}

export const ApiContext = createContext<PikaApi | null>(null);

export function useApi(): PikaApi {
	const api = useContext(ApiContext);
	if (!api) throw new Error("useApi needs an ApiContext provider");
	return api;
}
