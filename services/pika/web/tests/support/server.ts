// An in-memory implementation of the read API for tests, served through a mocked fetch.
import { withBase } from "../../src/lib/base";
import { normalizePairingCode } from "../../src/lib/devices";
import type {
	AuthMode,
	BrowserSession,
	Device,
	Entry,
	Facets,
	ModelRequest,
	OnlineSession,
	Pairing,
	RelayEvent,
	RelayTarget,
	RunDetail,
	SearchHit,
	SessionDetail,
	Turn,
} from "../../src/lib/types";

export interface FakeSession {
	detail: SessionDetail;
	turns: Turn[];
	entries: Entry[];
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function noContent(): Response {
	return new Response(null, { status: 204 });
}

/** A pending pairing; the fake derives `deviceExists` from its devices. */
export type FakePairing = Omit<Pairing, "deviceExists">;

/** A state-changing request as the fake received it. */
export interface Mutation {
	method: string;
	path: string;
	body?: unknown;
	/** Whether it was sent with `Content-Type: application/json`. */
	json: boolean;
}

/** Failed logins from one IP before the server answers 429 (contract section 3). */
const LOGIN_FAILURES = 5;

function page<T>(items: T[], params: URLSearchParams, defaultLimit: number) {
	const start = Number(params.get("cursor") ?? 0);
	const limit = Number(params.get("limit") ?? defaultLimit);
	const slice = items.slice(start, start + limit);
	const next = start + limit < items.length ? String(start + limit) : null;
	return { items: slice, nextCursor: next };
}

const UPDATES_TURN_LIMIT = 50;

/** Relay limits the fake enforces (docs/RELAY.md). */
const RELAY_MAX_TEXT_BYTES = 32 * 1024;
const RELAY_EVENTS_MAX = 500;

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
	authMode,
	authenticated = false,
	devices = [],
	pairings = [],
	browserSessions = [],
	loginRetryAfter = 840,
	legacyMe = false,
	features = ["relay"],
	relay,
	online = [],
	relayEvents = [],
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
	/** Defaults to `password` with a password and `none` without one. */
	authMode?: AuthMode;
	/** Starts signed in, in password mode. */
	authenticated?: boolean;
	devices?: Device[];
	pairings?: FakePairing[];
	browserSessions?: BrowserSession[];
	/** Seconds the login rate limit reports. */
	loginRetryAfter?: number;
	/** Answers `me` without `authMode`, as servers older than 0.2 do. */
	legacyMe?: boolean;
	/** Health's `features`; `null` leaves it out, as servers older than 0.3 do. */
	features?: string[] | null;
	/** Whether the relay routes answer; otherwise they say `relay_disabled`. Defaults to health listing relay. */
	relay?: boolean;
	/** Sessions online through relay. */
	online?: OnlineSession[];
	/** Relay events, newest first. */
	relayEvents?: RelayEvent[];
}) {
	const calls: string[] = [];
	const byId = new Map(sessions.map((session) => [session.detail.id, session]));
	const requestsById = new Map(requests.map((request) => [request.id, request]));
	const runsById = new Map(runs.map((run) => [run.run.runId, run]));
	const prefix = withBase(base, "api/v1/");
	const mode: AuthMode = authMode ?? (password !== undefined ? "password" : "none");
	const state = {
		authenticated,
		failedLogins: 0,
		devices: [...devices],
		pairings: [...pairings],
		browserSessions: [...browserSessions],
		relay: relay ?? features?.includes("relay") === true,
		online: [...online],
		relayEvents: [...relayEvents],
		/** The reason the next web sends are refused with, if any. */
		relayFailure: undefined as string | undefined,
		/** Whether online targets acknowledge in time, so sends report `delivered`; otherwise `queued`. */
		relayAck: true,
		/** How many of the next health requests fail with a 503. */
		healthFailures: 0,
		/** While set, web sends wait for it before they are answered. */
		relayHold: undefined as Promise<void> | undefined,
	};
	let relaySent = 0;
	const mutations: Mutation[] = [];
	const findPairing = (code: string) => state.pairings.findIndex((item) => normalizePairingCode(item.code) === normalizePairingCode(code));
	const signOutBrowser = () => {
		state.authenticated = false;
		state.browserSessions = state.browserSessions.filter((item) => !item.current);
	};

	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input), "http://localhost");
		calls.push(`${url.pathname}${url.search}`);
		if (url.pathname === withBase(base, "api/health")) {
			if (state.healthFailures > 0) {
				state.healthFailures -= 1;
				return json(503, { error: "unavailable" });
			}
			const health = { ok: true, version: features === null ? "0.2.0" : "0.3.0", basePath: base };
			return json(200, features === null ? health : { ...health, features });
		}
		if (!url.pathname.startsWith(prefix)) return json(404, { error: "not found" });
		const parts = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent);
		const params = url.searchParams;
		const method = init?.method ?? "GET";
		let body: unknown;
		if (method !== "GET") {
			const headers = new Headers(init?.headers);
			body = init?.body ? JSON.parse(String(init.body)) : undefined;
			mutations.push({ method, path: url.pathname, body, json: headers.get("Content-Type") === "application/json" });
		}

		if (parts[0] === "me") {
			const me = { authenticated: mode !== "password" || state.authenticated, passwordRequired: mode === "password" };
			return json(200, legacyMe ? me : { ...me, authMode: mode });
		}
		if (parts[0] === "login" && method === "POST") {
			if (state.failedLogins >= LOGIN_FAILURES) {
				return json(429, { error: "too_many_attempts", retryAfter: loginRetryAfter }, { "Retry-After": String(loginRetryAfter) });
			}
			if (password !== undefined && (body as { password?: string }).password !== password) {
				state.failedLogins += 1;
				return json(401, { error: "invalid_password" });
			}
			state.failedLogins = 0;
			state.authenticated = true;
			return noContent();
		}
		if (parts[0] === "logout") {
			signOutBrowser();
			return noContent();
		}
		if (mode === "password" && !state.authenticated) return json(401, { error: "unauthorized" });

		if (parts[0] === "auth" && parts[1] === "sessions") {
			if (parts.length === 2 && method === "GET") return json(200, { items: state.browserSessions });
			if (parts[2] === "revoke-all" && method === "POST") {
				state.browserSessions = [];
				state.authenticated = false;
				return json(200, {});
			}
			if (parts.length === 3 && method === "DELETE") {
				const session = state.browserSessions.find((item) => item.id === parts[2]);
				if (!session) return json(404, { error: "not found" });
				state.browserSessions = state.browserSessions.filter((item) => item !== session);
				if (session.current) state.authenticated = false;
				return noContent();
			}
			return json(405, { error: "method not allowed" });
		}
		if (parts[0] === "devices") {
			if (parts.length === 1 && method === "GET") return json(200, { items: [...state.devices].sort((a, b) => a.name.localeCompare(b.name)) });
			if (parts.length === 2 && method === "DELETE") {
				const before = state.devices.length;
				state.devices = state.devices.filter((item) => item.name !== parts[1]);
				return state.devices.length < before ? noContent() : json(404, { error: "not found" });
			}
			return json(405, { error: "method not allowed" });
		}
		if (parts[0] === "pairings") {
			if (parts.length === 1 && method === "GET") {
				const now = Date.now();
				const pending = state.pairings.filter((item) => Date.parse(item.expiresAt) > now);
				return json(200, {
					items: pending.map((item) => ({ ...item, deviceExists: state.devices.some((d) => d.name === item.device) })),
				});
			}
			if (parts.length !== 3 || method !== "POST") return json(405, { error: "method not allowed" });
			const index = findPairing(parts[1]);
			if (index < 0 || Date.parse(state.pairings[index].expiresAt) <= Date.now()) return json(404, { error: "unknown_pairing" });
			const pairing = state.pairings[index];
			if (parts[2] === "deny") {
				state.pairings.splice(index, 1);
				return noContent();
			}
			if (parts[2] === "approve") {
				const request = (body ?? {}) as { name?: string; replace?: boolean };
				const name = request.name ?? pairing.device;
				if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return json(400, { error: "invalid_device" });
				if (state.devices.some((d) => d.name === name) && request.replace !== true) return json(409, { error: "device_exists" });
				state.devices = state.devices.filter((d) => d.name !== name);
				state.devices.push({ name, createdAt: new Date().toISOString(), createdVia: "pairing", lastSeenAt: null, lastHost: null });
				state.pairings.splice(index, 1);
				return json(200, { device: name });
			}
		}

		if (parts[0] === "relay") {
			if (!state.relay) return json(404, { error: "relay_disabled" });
			if (parts[1] === "sessions" && method === "GET") {
				// By device, then the newest connection first.
				const items = [...state.online].sort(
					(a, b) => a.device.localeCompare(b.device) || Date.parse(b.connectedAt) - Date.parse(a.connectedAt),
				);
				return json(200, { items });
			}
			if (parts[1] === "events" && method === "GET") {
				const limit = Math.min(Number(params.get("limit") ?? 100), RELAY_EVENTS_MAX);
				return json(200, { items: state.relayEvents.slice(0, limit) });
			}
			if (parts[1] === "messages" && method === "POST") {
				if (state.relayHold) await state.relayHold;
				const request = (body ?? {}) as { to?: string; text?: string; urgent?: boolean };
				const to = request.to ?? "";
				const text = request.text ?? "";
				const onlineTarget = state.online.find((item) => item.id === to);
				const recorded = byId.get(to)?.detail;
				const target: RelayTarget = onlineTarget
					? { sessionId: to, device: onlineTarget.device, name: onlineTarget.name, title: onlineTarget.title, project: onlineTarget.project }
					: recorded
						? { sessionId: to, device: recorded.device, title: recorded.title, project: recorded.project }
						: { sessionId: to };
				let reason: string | undefined;
				if (!text || !/^[A-Za-z0-9._-]{1,128}$/.test(to)) reason = "invalid";
				else if (new TextEncoder().encode(text).length > RELAY_MAX_TEXT_BYTES) reason = "too_large";
				else if (state.relayFailure) reason = state.relayFailure;
				else if (!onlineTarget && !recorded) reason = "unknown_session";
				relaySent += 1;
				const id = `web-${relaySent}`;
				const at = new Date().toISOString();
				const status = reason ? "rejected" : onlineTarget && state.relayAck ? "delivered" : "queued";
				state.relayEvents.unshift({
					id,
					at,
					from: { kind: "web" },
					to: target,
					status,
					reason,
					deliveredAt: status === "delivered" ? at : undefined,
					urgent: request.urgent === true,
					hops: 0,
					text,
				});
				if (reason) return json(reason === "rate_limited" || reason === "mailbox_full" ? 429 : 400, { error: reason });
				return json(200, { id, status, to: target });
			}
			return json(405, { error: "method not allowed" });
		}
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

	return { fetch: fetchImpl as typeof fetch, calls, mutations, state };
}
