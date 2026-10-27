// An in-memory implementation of the read API for tests, served through a mocked fetch.
import { withBase } from "../../src/lib/base";
import { normalizePairingCode } from "../../src/lib/devices";
import type {
	AuthMode,
	BrowserSession,
	Device,
	DeviceRef,
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

/** A pending pairing, `match` included as the server would have recognized it at start. */
export type FakePairing = Pairing;

/** The server's device name rule, written out again so the fake does not trust the code under test. */
function validName(name: string): boolean {
	const trimmed = name.trim();
	const length = [...trimmed].length;
	return length >= 1 && length <= 64 && !/[\p{Cc}\u2028\u2029]/u.test(trimmed);
}

/** Sorted like the server: by name case-insensitively, then id. */
function byName<T>(items: readonly T[], name: (item: T) => string, id: (item: T) => string): T[] {
	const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	return [...items].sort((a, b) => compare(name(a).toLowerCase(), name(b).toLowerCase()) || compare(id(a), id(b)));
}

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
	retiredDevices = [],
	pairings = [],
	browserSessions = [],
	loginRetryAfter = 840,
	legacyMe = false,
	features = ["relay"],
	revision,
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
	/** Devices with a token, as `GET devices` lists them. */
	devices?: Device[];
	/** Devices without a token (revoked): pairing can continue them and they can be renamed, but they are not listed. */
	retiredDevices?: DeviceRef[];
	pairings?: FakePairing[];
	browserSessions?: BrowserSession[];
	/** Seconds the login rate limit reports. */
	loginRetryAfter?: number;
	/** Answers `me` without `authMode`, as servers older than 0.2 do. */
	legacyMe?: boolean;
	/** Health's `features`; `null` leaves it out, as servers older than 0.3 do. */
	features?: string[] | null;
	/** Health's `revision`, the commit the server was built from; servers built without one leave it out. */
	revision?: string;
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
		retiredDevices: [...retiredDevices],
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
		/**
		 * While set, an approved device is listed only once its machine polls, as on the real server: approvals put it in
		 * `unpolled`, and `poll()` lists it.
		 */
		devicesOnPoll: false,
		unpolled: [] as Device[],
	};
	let relaySent = 0;
	let devicesCreated = 0;
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
			const health = { ok: true, version: features === null ? "0.2.0" : "0.3.0", basePath: base, ...(revision ? { revision } : {}) };
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
			if (parts.length === 1 && method === "GET") return json(200, { items: byName(state.devices, (d) => d.name, (d) => d.id) });
			if (parts.length === 2 && method === "DELETE") {
				const revoked = state.devices.find((item) => item.id === parts[1]);
				if (!revoked) return json(404, { error: "unknown_device" });
				state.devices = state.devices.filter((item) => item !== revoked);
				state.retiredDevices.push({ id: revoked.id, name: revoked.name });
				return noContent();
			}
			if (parts.length === 2 && method === "PATCH") {
				const name = (body as { name?: unknown } | undefined)?.name;
				if (typeof name !== "string" || !validName(name)) return json(400, { error: "invalid_name" });
				const target = state.devices.find((item) => item.id === parts[1]) ?? state.retiredDevices.find((item) => item.id === parts[1]);
				if (!target) return json(404, { error: "unknown_device" });
				target.name = name.trim();
				return json(200, { id: target.id, name: target.name });
			}
			return json(405, { error: "method not allowed" });
		}
		if (parts[0] === "pairings") {
			if (parts.length === 1 && method === "GET") {
				const now = Date.now();
				return json(200, { items: state.pairings.filter((item) => Date.parse(item.expiresAt) > now) });
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
				// The device then polls at once: the fake applies what that poll does on the real server.
				const request = (body ?? {}) as { name?: string; continues?: string | null };
				const continues = request.continues === undefined ? (pairing.match?.id ?? null) : request.continues;
				const existing =
					continues === null
						? undefined
						: (state.devices.find((d) => d.id === continues) ?? state.retiredDevices.find((d) => d.id === continues));
				if (continues !== null && !existing) return json(404, { error: "unknown_device" });
				const name = request.name ?? existing?.name ?? pairing.name;
				if (!validName(name)) return json(400, { error: "invalid_name" });
				devicesCreated += 1;
				const id = existing?.id ?? `00000000-0000-4000-8000-${String(devicesCreated).padStart(12, "0")}`;
				const previous = state.devices.find((d) => d.id === id);
				const created: Device = {
					id,
					name: name.trim(),
					createdAt: new Date().toISOString(),
					createdVia: "pairing",
					lastSeenAt: previous?.lastSeenAt ?? null,
					lastHost: previous?.lastHost ?? null,
					hasKey: true,
				};
				if (state.devicesOnPoll) state.unpolled.push(created);
				else {
					state.devices = state.devices.filter((d) => d.id !== id);
					state.retiredDevices = state.retiredDevices.filter((d) => d.id !== id);
					state.devices.push(created);
				}
				state.pairings.splice(index, 1);
				return json(200, { device: id, name: name.trim(), continued: existing !== undefined });
			}
		}

		if (parts[0] === "relay") {
			if (!state.relay) return json(404, { error: "relay_disabled" });
			if (parts[1] === "sessions" && method === "GET") {
				// By device name, then id, then the newest connection first.
				const newest = [...state.online].sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
				const items = byName(newest, (s) => s.deviceName ?? s.device, (s) => s.device);
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
					? {
							sessionId: to,
							device: onlineTarget.device,
							deviceName: onlineTarget.deviceName,
							name: onlineTarget.name,
							title: onlineTarget.title,
							project: onlineTarget.project,
						}
					: recorded
						? { sessionId: to, device: recorded.device, deviceName: recorded.deviceName, title: recorded.title, project: recorded.project }
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
					devices: byName(
						[...new Map(sessions.map((s) => [s.detail.device, { id: s.detail.device, name: s.detail.deviceName ?? s.detail.device }])).values()],
						(d) => d.name,
						(d) => d.id,
					),
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

	/** The machines of `unpolled` approvals poll: their devices are listed from now on. */
	const poll = () => {
		for (const created of state.unpolled.splice(0)) {
			state.devices = state.devices.filter((d) => d.id !== created.id);
			state.retiredDevices = state.retiredDevices.filter((d) => d.id !== created.id);
			state.devices.push(created);
		}
	};
	return { fetch: fetchImpl as typeof fetch, calls, mutations, state, poll };
}
