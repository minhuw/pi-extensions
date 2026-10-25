import { createContext, useContext } from "react";
import { withBase } from "./base";
import type {
	Entry,
	Facets,
	Me,
	ModelRequest,
	Page,
	RunDetail,
	RunSummary,
	SearchHit,
	SessionDetail,
	SessionSummary,
	Turn,
} from "./types";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}

type Params = Record<string, string | number | boolean | null | undefined>;

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
	constructor(
		readonly base: string,
		private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
	) {}

	/** Absolute URL path of a read API route, e.g. `url("sessions")`. */
	url(path: string, params: Params = {}): string {
		return withBase(this.base, `api/v1/${path.replace(/^\/+/, "")}`) + query(params);
	}

	private async request<T>(path: string, params: Params = {}, init?: RequestInit): Promise<T> {
		const response = await this.fetchImpl(this.url(path, params), {
			credentials: "same-origin",
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
			throw new ApiError(response.status, detail || `HTTP ${response.status}`, body);
		}
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
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
		return this.request("login", {}, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
	}

	logout(): Promise<unknown> {
		return this.request("logout", {}, { method: "POST" });
	}
}

export const ApiContext = createContext<PikaApi | null>(null);

export function useApi(): PikaApi {
	const api = useContext(ApiContext);
	if (!api) throw new Error("useApi needs an ApiContext provider");
	return api;
}
