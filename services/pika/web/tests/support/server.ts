// An in-memory implementation of the read API for tests, served through a mocked fetch.
import { withBase } from "../../src/lib/base";
import type { Entry, Facets, ModelRequest, RunDetail, SearchHit, SessionDetail, Turn } from "../../src/lib/types";

export interface FakeSession {
	detail: SessionDetail;
	turns: Turn[];
	entries: Entry[];
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function page<T>(items: T[], params: URLSearchParams, defaultLimit: number) {
	const start = Number(params.get("cursor") ?? 0);
	const limit = Number(params.get("limit") ?? defaultLimit);
	const slice = items.slice(start, start + limit);
	const next = start + limit < items.length ? String(start + limit) : null;
	return { items: slice, nextCursor: next };
}

const UPDATES_TURN_LIMIT = 50;

function withoutChildren({ children: _children, ...rest }: SessionDetail) {
	return rest;
}

export function createFakeServer({
	base = "/",
	sessions = [],
	facets,
	requests = [],
	runs = [],
	hits = [],
	password,
	updates = true,
}: {
	base?: string;
	sessions?: FakeSession[];
	facets?: Facets;
	requests?: ModelRequest[];
	runs?: RunDetail[];
	/** Search hits; the fake matches `q` against the snippet text and applies device/project via the sessions. */
	hits?: SearchHit[];
	/** Requires a login cookie for everything but `me` and `login`. */
	password?: string;
	/** Serves `sessions/:id/updates`; older servers answer 404. */
	updates?: boolean;
}) {
	const calls: string[] = [];
	const byId = new Map(sessions.map((session) => [session.detail.id, session]));
	const requestsById = new Map(requests.map((request) => [request.id, request]));
	const runsById = new Map(runs.map((run) => [run.run.runId, run]));
	const prefix = withBase(base, "api/v1/");
	const state = { authenticated: false };

	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input), "http://localhost");
		calls.push(`${url.pathname}${url.search}`);
		if (!url.pathname.startsWith(prefix)) return json(404, { error: "not found" });
		const parts = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent);
		const params = url.searchParams;

		if (parts[0] === "me") return json(200, { authenticated: password === undefined || state.authenticated, passwordRequired: password !== undefined });
		if (parts[0] === "login" && init?.method === "POST") {
			const body = JSON.parse(String(init.body ?? "{}")) as { password?: string };
			if (password !== undefined && body.password !== password) return json(401, { error: "unauthorized" });
			state.authenticated = true;
			return new Response(null, { status: 204 });
		}
		if (parts[0] === "logout") {
			state.authenticated = false;
			return new Response(null, { status: 204 });
		}
		if (password !== undefined && !state.authenticated) return json(401, { error: "unauthorized" });

		if (parts[0] === "facets") {
			return json(
				200,
				facets ?? {
					devices: [...new Set(sessions.map((s) => s.detail.device))],
					projects: [...new Set(sessions.map((s) => s.detail.project))],
					models: [...new Set(sessions.flatMap((s) => s.detail.models))],
				},
			);
		}
		if (parts[0] === "sessions" && parts.length === 1) {
			let list = sessions.map((s) => s.detail);
			if (params.get("root") === "true") list = list.filter((s) => !s.parentSessionId);
			for (const key of ["device", "project"] as const) {
				const value = params.get(key);
				if (value) list = list.filter((s) => s[key] === value);
			}
			const model = params.get("model");
			if (model) list = list.filter((s) => s.models.includes(model));
			return json(200, page(list.map(withoutChildren), params, 50));
		}
		if (parts[0] === "sessions") {
			const session = byId.get(parts[1]);
			if (!session) return json(404, { error: "not found" });
			if (parts.length === 2) return json(200, session.detail);
			if (parts[2] === "turns") return json(200, page(session.turns, params, 100));
			if (parts[2] === "updates" && updates) {
				const raw = params.get("since");
				const since = raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : -1;
				const lastSeq = session.entries.reduce((max, item) => Math.max(max, item.seq), -1);
				const lastAt = lastSeq >= 0 ? session.detail.lastAt : null;
				if (lastSeq <= since) return json(200, { lastSeq, lastAt });
				// The newest turns, as a descending scan of the turns index finds them.
				const grown = session.turns.filter((turn) => turn.endSeq > since).sort((a, b) => a.index - b.index);
				const body: Record<string, unknown> = { lastSeq, lastAt, session: withoutChildren(session.detail), turns: grown.slice(-UPDATES_TURN_LIMIT) };
				if (grown.length > UPDATES_TURN_LIMIT) body.truncated = true;
				return json(200, body);
			}
			if (parts[2] === "entries" && parts.length === 3) {
				const from = Number(params.get("from") ?? 0);
				const to = params.has("to") ? Number(params.get("to")) : Number.POSITIVE_INFINITY;
				const limit = Math.min(Number(params.get("limit") ?? 200), 1000);
				const items: Entry[] = [];
				for (const item of session.entries) {
					if (item.seq < from || item.seq > to) continue;
					items.push(item);
					if (items.length >= limit) break;
				}
				return json(200, { items });
			}
		}
		if (parts[0] === "requests") {
			const request = requestsById.get(parts[1]);
			return request ? json(200, request) : json(404, { error: "not found" });
		}
		if (parts[0] === "herder" && parts[1] === "runs") {
			if (parts.length === 2) return json(200, page(runs.map((run) => run.run), params, 50));
			const run = runsById.get(parts[2]);
			return run ? json(200, run) : json(404, { error: "not found" });
		}
		if (parts[0] === "search") {
			const q = (params.get("q") ?? "").toLowerCase();
			const device = params.get("device");
			const project = params.get("project");
			const matching = hits.filter((hit) => {
				const session = byId.get(hit.sessionId)?.detail;
				if (device && session?.device !== device) return false;
				if (project && session?.project !== project) return false;
				return hit.snippet.toLowerCase().includes(q);
			});
			return json(200, page(matching, params, 50));
		}
		return json(404, { error: "not found" });
	};

	return { fetch: fetchImpl as typeof fetch, calls, state };
}
