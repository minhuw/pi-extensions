// An in-memory implementation of the read API for tests, served through a mocked fetch.
import { withBase } from "../../src/lib/base";
import { normalizePairingCode } from "../../src/lib/devices";
import { bareModel, bareModelOf } from "../../src/lib/model";
import type {
	AuthMode,
	BrowserSession,
	Device,
	DeviceRef,
	Entry,
	Facets,
	MemoryBatch,
	MemoryNote,
	MemoryRevision,
	MemoryScopeSummary,
	ModelRequest,
	OnlineSession,
	Pairing,
	RelayEvent,
	RelayRoom,
	RelayRoomMember,
	RelayRoomMessage,
	RelayTarget,
	RunDetail,
	SearchHit,
	SessionMatches,
	SessionDetail,
	ChildSession,
	SessionTrace,
	SessionTree,
	TraceRecord,
	TreeNode,
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

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function epoch(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const time = Date.parse(value);
		return Number.isNaN(time) ? undefined : time;
	}
	return undefined;
}

/** The contract's summary rules, written out again so the fake does not trust the code under test. */
function traceSummary(name: string, args: Json): string | undefined {
	const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const base = (/^mcp__.+?__(.+)$/.exec(name)?.[1] ?? name).toLowerCase();
	let summary: string | undefined;
	if (/^mcp__/.test(name)) summary = Object.values(args).find((value): value is string => typeof value === "string" && value.length <= 400);
	else if (["bash", "shell", "powershell"].includes(base)) summary = text("command")?.split("\n")[0];
	else if (base === "read") {
		const path = text("path") ?? text("file_path");
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		summary = path && (offset !== undefined || limit !== undefined) ? `${path}:${offset ?? 1}-${(offset ?? 1) + (limit ?? 1) - 1}` : path;
	} else if (base === "write" || base === "edit") summary = text("path") ?? text("file_path");
	else if (["grep", "find", "ls", "glob"].includes(base)) summary = [text("pattern"), text("path")].filter(Boolean).join(" in ") || undefined;
	else if (base === "web_search") summary = text("query");
	else if (base === "web_fetch") summary = text("url");
	else if (name === "Agent") summary = `${text("subagent_type") ?? "agent"}: ${text("description") ?? ""}`;
	else summary = Object.values(args).find((value): value is string => typeof value === "string" && value.length <= 400);
	if (summary === undefined) return undefined;
	return [...summary.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, 160).join("");
}

/** The server's ticket rule, written out again: `superagent.ticketId` an integer 1..1e9, string branch (≤255) and title (cut to 200). */
function ticketOfLink(link: unknown): { id: number; branch?: string; title?: string } | undefined {
	const data = isObject(link) && isObject(link.superagent) ? link.superagent : undefined;
	const id = data?.ticketId;
	if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 1_000_000_000) return undefined;
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : undefined);
	const branch = text(data?.branch);
	const title = text(data?.title);
	return { id, ...(branch && [...branch].length <= 255 ? { branch } : {}), ...(title ? { title: [...title].slice(0, 200).join("") } : {}) };
}

/** The server's report headers of a `superagent-report` turn: `#<id> <kind> · <title>` lines opening the text or a paragraph. */
function reportHeaders(text: string): { ticketId: number; kind: string; title: string }[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) => /^#(\d+) ([a-z-]+)(?: · (.*))?$/.exec(paragraph.trim().split("\n")[0].trim()))
		.filter((match): match is RegExpExecArray => match !== null && Number(match[1]) >= 1)
		.map((match) => ({ ticketId: Number(match[1]), kind: match[2], title: (match[3] ?? "").trim() }));
}

/** `GET sessions/:id/trace`, derived from a fake session's entries, turns, and children. */
export function traceOf(session: FakeSession): SessionTrace {
	const turnOf = (seq: number) => session.turns.find((turn) => turn.startSeq <= seq && seq <= turn.endSeq)?.index;
	const results = new Map<string, Entry>();
	for (const item of session.entries) {
		const message = item.raw.message;
		if (isObject(message) && message.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, item);
	}
	const children = session.detail.children;
	const records: TraceRecord[] = [];
	for (const item of session.entries) {
		const raw = item.raw;
		const turn = turnOf(item.seq);
		const at = epoch(item.timestamp);
		if (raw.type === "compaction") {
			records.push({ kind: "compaction", seq: item.seq, turn, ...(at !== undefined ? { at } : {}), ...(typeof raw.tokensBefore === "number" ? { tokensBefore: raw.tokensBefore } : {}) });
			continue;
		}
		if (raw.type === "branch_summary") {
			records.push({ kind: "branch-summary", seq: item.seq, turn, ...(at !== undefined ? { at } : {}) });
			continue;
		}
		const message = raw.message;
		if (raw.type !== "message" || !isObject(message) || message.role !== "assistant") continue;
		const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
		const usage = isObject(message.usage) ? message.usage : {};
		const cost = isObject(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
		const start = epoch(message.timestamp);
		const end = start !== undefined && typeof message.durationMs === "number" ? start + message.durationMs : at;
		const calls = content.filter((block) => block.type === "toolCall");
		const text = content.find((block) => block.type === "text" && typeof block.text === "string")?.text as string | undefined;
		records.push({
			kind: "llm",
			seq: item.seq,
			turn,
			...(start !== undefined ? { start } : {}),
			...(end !== undefined ? { end } : {}),
			// As the server derives it: the bare name, and no provider.
			model: bareModelOf(message.model),
			stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
			input: Number(usage.input ?? 0),
			output: Number(usage.output ?? 0),
			cacheRead: Number(usage.cacheRead ?? 0),
			cacheWrite: Number(usage.cacheWrite ?? 0),
			cost,
			...(item.requestId ? { requestId: item.requestId } : {}),
			...(text ? { text: text.slice(0, 160) } : {}),
			...(content.some((block) => block.type === "thinking") ? { thinking: true } : {}),
			toolCalls: calls.length,
		});
		for (const call of calls) {
			const callId = String(call.id);
			const name = String(call.name);
			const result = results.get(callId);
			const resultMessage = isObject(result?.raw.message) ? result.raw.message : undefined;
			const ended = resultMessage ? (epoch(resultMessage.timestamp) ?? epoch(result?.timestamp)) : undefined;
			const durationMs =
				typeof resultMessage?.durationMs === "number" ? resultMessage.durationMs : ended !== undefined && end !== undefined ? Math.max(0, ended - end) : undefined;
			const output = resultMessage && Array.isArray(resultMessage.content) ? resultMessage.content.filter(isObject) : [];
			const child = children.find((candidate) => (candidate.parentToolCallId ?? candidate.link?.parentToolCallId) === callId);
			const summary = traceSummary(name, isObject(call.arguments) ? call.arguments : {});
			records.push({
				kind: "tool",
				seq: item.seq,
				...(result ? { resultSeq: result.seq } : {}),
				turn,
				callId,
				name,
				...(end !== undefined ? { start: end } : {}),
				...(ended !== undefined ? { end: ended } : {}),
				...(durationMs !== undefined ? { durationMs } : {}),
				isError: resultMessage?.isError === true,
				...(summary !== undefined ? { summary } : {}),
				...(resultMessage ? { outputSize: output.reduce((n, block) => n + (typeof block.text === "string" ? block.text.length : 0), 0) } : {}),
				...(child && (name === "Agent" || name === "ticket_create") ? { childSessionId: child.id } : {}),
			});
		}
	}
	// As the server's `times`: a session without entries has no start or end, and nothing is invented.
	const times = (summary: { startedAt?: string; lastAt?: string; entryCount: number }) => {
		const started = epoch(summary.startedAt);
		const last = epoch(summary.lastAt);
		if (summary.entryCount <= 0 || (started === undefined && !last)) return {};
		return { ...((started ?? last) !== undefined ? { startedAt: started ?? last } : {}), ...(last !== undefined ? { lastAt: last } : {}) };
	};
	return {
		sessionId: session.detail.id,
		...times(session.detail),
		turns: session.turns.map((turn) => ({
			index: turn.index,
			startSeq: turn.startSeq,
			endSeq: turn.endSeq,
			...(epoch(turn.at) !== undefined ? { at: epoch(turn.at) } : {}),
			durationMs: turn.durationMs,
			userText: turn.userText.slice(0, 200),
			...(turn.customType ? { customType: turn.customType } : {}),
			...(turn.customType === "superagent-report" ? { reports: reportHeaders(turn.userText) } : {}),
			modelCalls: turn.modelCalls,
			toolCalls: turn.toolCalls,
			toolErrors: turn.toolErrors,
			cost: turn.cost,
			tokens: turn.tokens,
		})),
		records,
		children: children.map((child) => ({
			sessionId: child.id,
			...((child.parentToolCallId ?? child.link?.parentToolCallId) ? { parentToolCallId: child.parentToolCallId ?? child.link?.parentToolCallId } : {}),
			...(child.link?.agentType ? { agentType: child.link.agentType } : {}),
			...(child.link?.description ? { description: child.link.description } : {}),
			kind: child.link?.kind === "herder-step" ? "herder-step" : "subagent",
			...times(child),
			entryCount: child.entryCount,
			tokens: child.tokens,
			cost: child.cost,
			title: child.title,
			...(ticketOfLink(child.link) ? { ticket: ticketOfLink(child.link) } : {}),
		})),
	};
}

/** The contract's tree limits. */
const TREE_MAX_NODES = 2000;
const TREE_MAX_DEPTH = 32;

/**
 * `GET sessions/:id/tree`, simplified: the topmost recorded ancestor of `id`, then its descendants
 * depth-first in pre-order, siblings by start (timeless last) then id. A parent is a session's
 * `parentSessionId` or the session whose `children` list it; cycles are cut. Unlike the server, it
 * neither limits the walk up nor keeps the path to `id` past the node limit, and it filters nothing for
 * the public namespace; tests of those give their own trees, through `trees` or their own fetch.
 */
export function treeOf(sessions: readonly FakeSession[], id: string, limits = { nodes: TREE_MAX_NODES, depth: TREE_MAX_DEPTH }): SessionTree {
	const summaries = new Map<string, ChildSession>();
	const parents = new Map<string, string>();
	for (const session of sessions) {
		for (const child of session.detail.children) {
			if (!summaries.has(child.id)) summaries.set(child.id, child);
			if (!parents.has(child.id)) parents.set(child.id, session.detail.id);
		}
	}
	for (const session of sessions) {
		const { children: _children, ...summary } = session.detail;
		const listed = summaries.get(summary.id);
		summaries.set(summary.id, { ...summary, ...(listed?.parentToolCallId ? { parentToolCallId: listed.parentToolCallId } : {}) });
		if (summary.parentSessionId) parents.set(summary.id, summary.parentSessionId);
	}
	const children = new Map<string, string[]>();
	for (const [child, parent] of parents) {
		if (!summaries.has(parent)) continue;
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const startOf = (key: string) => {
		const time = Date.parse(summaries.get(key)?.startedAt ?? "");
		return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
	};
	for (const list of children.values()) list.sort((a, b) => startOf(a) - startOf(b) || (a < b ? -1 : a > b ? 1 : 0));
	let rootId = id;
	const walked = new Set([id]);
	for (let parent = parents.get(id); parent && summaries.has(parent) && !walked.has(parent); parent = parents.get(parent)) {
		walked.add(parent);
		rootId = parent;
	}
	const nodes: TreeNode[] = [];
	const seen = new Set<string>();
	let truncated = false;
	const visit = (key: string, depth: number) => {
		if (seen.has(key)) return;
		if (nodes.length >= limits.nodes || depth > limits.depth) {
			truncated = true;
			return;
		}
		seen.add(key);
		nodes.push({ ...summaries.get(key)!, depth });
		for (const child of children.get(key) ?? []) visit(child, depth + 1);
	};
	visit(rootId, 0);
	return { rootId, nodes, ...(truncated ? { truncated: true } : {}) };
}

/** Stored agent memory, as the owner routes read it. */
export interface FakeMemory {
	scopes: MemoryScopeSummary[];
	/** Notes of every scope, forgotten ones included, in index order. */
	notes: MemoryNote[];
	/** Each note's revisions, oldest first, by note id. */
	revisions: Record<string, MemoryRevision[]>;
	/** Dream batches of every scope; listed newest first. */
	batches?: MemoryBatch[];
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
	relayRooms = [],
	trace = true,
	traces,
	tree = true,
	trees,
	memory = { scopes: [], notes: [], revisions: {} },
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
	/** Active chatrooms, newest first. */
	relayRooms?: { room: RelayRoom; messages: RelayRoomMessage[] }[];
	/** Serves `sessions/:id/trace`; older servers answer 404. */
	trace?: boolean;
	/** Traces served as given instead of derived, by session id: malformed or partial ones. */
	traces?: Record<string, unknown>;
	/** Serves `sessions/:id/tree`; older servers answer 404. */
	tree?: boolean;
	/** Trees served as given instead of derived, by session id. */
	trees?: Record<string, unknown>;
	memory?: FakeMemory;
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
		// A revoked device keeps its read access, which a continued pairing restores.
		retiredDevices: [...retiredDevices] as (DeviceRef & { readAccess?: boolean })[],
		pairings: [...pairings],
		browserSessions: [...browserSessions],
		relay: relay ?? features?.includes("relay") === true,
		online: [...online],
		relayEvents: [...relayEvents],
		relayRooms: relayRooms.map((item) => ({ room: { ...item.room, members: [...item.room.members] }, messages: [...item.messages] })),
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
	// Copies, so reverts change neither the caller's fixtures nor another server's.
	const stored = {
		notes: memory.notes.map((note) => ({ ...note })),
		revisions: Object.fromEntries(Object.entries(memory.revisions).map(([id, list]) => [id, [...list]])),
		batches: (memory.batches ?? []).map((batch) => ({ ...batch })),
	};
	/** Restores the notes the batch touched, as the server does: 409 when one changed since, writing nothing. */
	const revertBatch = (batch: MemoryBatch): Response => {
		if (batch.revertedAt) return json(409, { error: "already_reverted" });
		const touched = new Map<string, { first: number; last: number; created: boolean }>();
		for (const change of batch.changes) {
			const seen = touched.get(change.noteId);
			touched.set(change.noteId, {
				first: Math.min(seen?.first ?? change.revision, change.revision),
				last: Math.max(seen?.last ?? change.revision, change.revision),
				created: (seen?.created ?? false) || change.created,
			});
		}
		const conflicts = [...touched].filter(([id, { last }]) => stored.notes.find((note) => note.id === id)?.revision !== last).map(([id]) => id);
		if (conflicts.length) return json(409, { error: "revert_conflict", notes: conflicts });
		const now = new Date().toISOString();
		for (const [id, { first, created }] of touched) {
			const note = stored.notes.find((item) => item.id === id)!;
			const history = (stored.revisions[id] ??= []);
			const before = created ? undefined : history.find((item) => item.revision === first - 1);
			const content = before ?? note;
			const live = !created && before?.action !== "forget";
			Object.assign(note, {
				category: content.category,
				title: content.title,
				hook: content.hook,
				body: content.body,
				provenance: "owner",
				sources: [],
				revision: note.revision + 1,
				updatedAt: now,
				deletedAt: live ? null : now,
				sessionId: null,
			});
			history.push({
				revision: note.revision,
				action: "revert",
				provenance: "owner",
				sources: [],
				batchId: batch.id,
				category: note.category,
				title: note.title,
				hook: note.hook,
				body: note.body,
				at: now,
				deviceId: null,
				sessionId: null,
				reason: null,
			});
		}
		batch.revertedAt = now;
		return json(200, { batch });
	};
	const findPairing = (code: string) => state.pairings.findIndex((item) => normalizePairingCode(item.code) === normalizePairingCode(code));
	const signOutBrowser = () => {
		state.authenticated = false;
		state.browserSessions = state.browserSessions.filter((item) => !item.current);
	};

	/** `ids` and every recorded descendant, as the server's deletion finds them; cycle-safe. */
	const descendants = (ids: string[]): string[] => {
		const found = new Set<string>();
		const stack = [...ids];
		while (stack.length) {
			const id = stack.pop()!;
			if (found.has(id)) continue;
			found.add(id);
			for (const s of sessions) if (s.detail.parentSessionId === id) stack.push(s.detail.id);
		}
		return [...found];
	};
	const remove = (ids: string[]) => {
		for (const id of ids) {
			byId.delete(id);
			const index = sessions.findIndex((s) => s.detail.id === id);
			if (index >= 0) sessions.splice(index, 1);
		}
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
				state.retiredDevices.push({ id: revoked.id, name: revoked.name, readAccess: revoked.readAccess });
				return noContent();
			}
			if (parts.length === 2 && method === "PATCH") {
				const request = (body ?? {}) as { name?: unknown; readAccess?: unknown };
				const { name, readAccess } = request;
				if ("name" in request && (typeof name !== "string" || !validName(name))) return json(400, { error: "invalid_name" });
				if ("readAccess" in request && typeof readAccess !== "boolean") return json(400, { error: "invalid_body" });
				if (!("name" in request) && !("readAccess" in request)) return json(400, { error: "invalid_name" });
				const listed = state.devices.find((item) => item.id === parts[1]);
				const target = listed ?? state.retiredDevices.find((item) => item.id === parts[1]);
				if (!target) return json(404, { error: "unknown_device" });
				if (typeof name === "string") target.name = name.trim();
				if (typeof readAccess === "boolean") target.readAccess = readAccess;
				return json(200, { id: target.id, name: target.name, readAccess: target.readAccess ?? true });
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
					// A new device starts with read access; a continued one, listed or revoked, keeps its own.
					readAccess: existing?.readAccess ?? true,
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
			const buildMember = (sid: string, joinedAt: string): RelayRoomMember => {
				const on = state.online.find((s) => s.id === sid);
				const rec = byId.get(sid)?.detail;
				return {
					sessionId: sid,
					device: on?.device ?? rec?.device,
					deviceName: on?.deviceName ?? rec?.deviceName,
					name: on?.name,
					title: on?.title ?? rec?.title,
					project: on?.project ?? rec?.project,
					model: on?.model,
					state: on ? on.state : "offline",
					online: Boolean(on),
					joinedAt,
				};
			};
			if (parts[1] === "rooms" && parts.length === 2 && method === "GET") {
				return json(200, { items: state.relayRooms.map((r) => r.room) });
			}
			if (parts[1] === "rooms" && parts.length === 2 && method === "POST") {
				const req = (body ?? {}) as { name?: string; topic?: string; members?: string[] };
				const clean = (req.name ?? "").trim().replace(/^#/, "");
				if (!/^[A-Za-z0-9._-]{1,64}$/.test(clean)) return json(400, { error: "invalid" });
				const now = new Date().toISOString();
				let entry = state.relayRooms.find((r) => r.room.name === clean);
				const members = (req.members ?? []).map((sid) => buildMember(sid, now));
				if (!entry) {
					entry = {
						room: {
							name: clean,
							...(req.topic ? { topic: req.topic } : {}),
							createdAt: now,
							updatedAt: now,
							messageCount: 0,
							members,
						},
						messages: [],
					};
					state.relayRooms.unshift(entry);
				} else {
					if (req.topic) entry.room.topic = req.topic;
					for (const m of members) {
						if (!entry.room.members.some((existing) => existing.sessionId === m.sessionId)) {
							entry.room.members.push(m);
						}
					}
					entry.room.updatedAt = now;
				}
				return json(200, entry);
			}
			if (parts[1] === "rooms" && parts.length === 3 && method === "GET") {
				const clean = parts[2].replace(/^#/, "");
				const entry = state.relayRooms.find((r) => r.room.name === clean);
				if (!entry) return json(404, { error: "not_found" });
				return json(200, entry);
			}
			if (parts[1] === "rooms" && parts.length === 3 && method === "DELETE") {
				const clean = parts[2].replace(/^#/, "");
				const idx = state.relayRooms.findIndex((r) => r.room.name === clean);
				if (idx === -1) return json(404, { error: "not_found" });
				state.relayRooms.splice(idx, 1);
				return noContent();
			}
			if (parts[1] === "rooms" && parts.length === 4 && parts[3] === "members" && method === "POST") {
				const clean = parts[2].replace(/^#/, "");
				const req = (body ?? {}) as { sessionId?: string; action?: "add" | "remove" };
				const sid = req.sessionId ?? "";
				const now = new Date().toISOString();
				let entry = state.relayRooms.find((r) => r.room.name === clean);
				if (req.action === "remove") {
					if (!entry) return json(400, { error: "invalid" });
					entry.room.members = entry.room.members.filter((m) => m.sessionId !== sid);
					// A representative that leaves the room stops being its representative.
					if (entry.room.representative === sid) delete entry.room.representative;
					entry.room.updatedAt = now;
				} else {
					if (!entry) {
						entry = {
							room: { name: clean, createdAt: now, updatedAt: now, messageCount: 0, members: [] },
							messages: [],
						};
						state.relayRooms.unshift(entry);
					}
					if (!entry.room.members.some((m) => m.sessionId === sid)) {
						entry.room.members.push(buildMember(sid, now));
					}
					entry.room.updatedAt = now;
				}
				return json(200, entry);
			}
			if (parts[1] === "messages" && method === "POST") {
				if (state.relayHold) await state.relayHold;
				const request = (body ?? {}) as { to?: string; room?: string; mentions?: string[]; text?: string; urgent?: boolean };
				if (typeof request.room === "string") {
					const cleanRoom = request.room.trim().replace(/^#/, "");
					const text = request.text ?? "";
					let reason: string | undefined;
					if (!text || !/^[A-Za-z0-9._-]{1,64}$/.test(cleanRoom)) reason = "invalid";
					else if (new TextEncoder().encode(text).length > RELAY_MAX_TEXT_BYTES) reason = "too_large";
					else if (state.relayFailure) reason = state.relayFailure;
					relaySent += 1;
					const id = `web-${relaySent}`;
					const at = new Date().toISOString();
					const roomTarget: RelayTarget = { sessionId: `#${cleanRoom}`, name: `#${cleanRoom}` };
					if (reason) {
						state.relayEvents.unshift({
							id,
							at,
							from: { kind: "web" },
							to: roomTarget,
							room: cleanRoom,
							status: "rejected",
							reason,
							urgent: request.urgent === true,
							hops: 0,
							text,
						});
						return json(reason === "rate_limited" || reason === "mailbox_full" ? 429 : 400, { error: reason });
					}
					let entry = state.relayRooms.find((r) => r.room.name === cleanRoom);
					if (!entry) {
						entry = {
							room: { name: cleanRoom, createdAt: at, updatedAt: at, messageCount: 0, members: [] },
							messages: [],
						};
						state.relayRooms.unshift(entry);
					}
					const tokens = [
						...(request.mentions ?? []).map((m) => m.replace(/^@/, "")),
						...[...text.matchAll(/(?:^|[\s([{"',:;])@([A-Za-z0-9._-]+)/g)].map((m) => m[1]!),
					];
					const mentionAll = tokens.some((t) => t.toLowerCase() === "all" || t === "*");
					const notifiedMembers = entry.room.members.filter(
						(m) =>
							mentionAll
							|| tokens.some(
								(tok) =>
									m.sessionId.toLowerCase() === tok.toLowerCase()
									|| m.name?.toLowerCase() === tok.toLowerCase()
									|| m.project?.toLowerCase() === tok.toLowerCase(),
							),
					);
					const notified: RelayTarget[] = notifiedMembers.map((m) => ({
						sessionId: m.sessionId,
						device: m.device,
						deviceName: m.deviceName,
						name: m.name,
						title: m.title,
						project: m.project,
					}));
					const roomMsg: RelayRoomMessage = {
						id,
						seq: entry.messages.length + 1,
						room: cleanRoom,
						from: { kind: "web" },
						text,
						mentions: notified.map((n) => n.sessionId),
						notified,
						urgent: request.urgent === true,
						hops: 0,
						at,
					};
					entry.messages.push(roomMsg);
					entry.room.messageCount = entry.messages.length;
					entry.room.lastMessage = roomMsg;
					entry.room.updatedAt = at;
					state.relayEvents.unshift({
						id,
						at,
						from: { kind: "web" },
						to: roomTarget,
						room: cleanRoom,
						mentions: roomMsg.mentions,
						status: "delivered",
						deliveredAt: at,
						urgent: request.urgent === true,
						hops: 0,
						text,
					});
					return json(200, { id, status: "delivered", room: cleanRoom, notified, to: roomTarget });
				}
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
			// Root sessions have no recorded parent: none at all, or one the server does not have.
			if (params.get("root") === "true") list = list.filter((s) => !s.parentSessionId || !sessions.some((p) => p.detail.id === s.parentSessionId));
			for (const key of ["device", "project"] as const) {
				const value = params.get(key);
				if (value) list = list.filter((s) => s[key] === value);
			}
			const model = params.get("model");
			if (model) list = list.filter((s) => s.models.includes(bareModel(model)));
			return json(200, page(list.map(withoutChildren), params, 50));
		}
		if (parts[0] === "projects" && parts.length >= 2) {
			const family = descendants(sessions.filter((s) => s.detail.project === parts[1]).map((s) => s.detail.id));
			if (family.length === 0) return json(404, { error: "not_found" });
			const counts = { deletedSessions: family.length, deletedHerderRuns: runs.filter((r) => r.run.repo === parts[1]).length };
			if (parts[2] === "deletion") return json(200, counts);
			if (method === "DELETE") {
				remove(family);
				return json(200, counts);
			}
			return json(405, { error: "method not allowed" });
		}
		if (parts[0] === "sessions") {
			const session = byId.get(parts[1]);
			if (!session) return json(404, { error: "not found" });
			if (parts[2] === "deletion") return json(200, { deletedSessions: descendants([session.detail.id]).length, deletedHerderRuns: 0 });
			if (parts.length === 2 && method === "DELETE") {
				const family = descendants([session.detail.id]);
				remove(family);
				return json(200, { deletedSessions: family.length, deletedHerderRuns: 0 });
			}
			if (parts.length === 2 && method === "PATCH") {
				const hidden = (body as { hidden?: unknown }).hidden;
				if (typeof hidden !== "boolean") return json(400, { error: "invalid_body" });
				session.detail = { ...session.detail, hidden, ...(hidden ? { hiddenBy: session.detail.id } : { hiddenBy: undefined }) };
				return json(200, withoutChildren(session.detail));
			}
			if (parts.length === 2) return json(200, session.detail);
			if (parts[2] === "turns") return json(200, page(session.turns, params, 100));
			if (parts[2] === "tree" && tree) return json(200, trees?.[session.detail.id] ?? treeOf(sessions, session.detail.id));
			if (parts[2] === "trace" && trace) return json(200, traces?.[session.detail.id] ?? traceOf(session));
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
		if (parts[0] === "memory" && method === "GET") {
			if (parts.length === 1) return json(200, { scopes: memory.scopes });
			if (parts[1] === "notes" && parts.length === 2) {
				const scope = params.get("scope");
				if (!scope) return json(400, { error: "bad_request", message: "scope is required" });
				if (!memory.scopes.some((item) => item.key === scope)) return json(404, { error: "not_found" });
				return json(200, { notes: stored.notes.filter((note) => note.scope.key === scope && note.deletedAt === null) });
			}
			if (parts[1] === "notes" && parts.length === 4 && parts[3] === "revisions") {
				if (!stored.notes.some((note) => note.id === parts[2])) return json(404, { error: "not_found" });
				return json(200, { revisions: stored.revisions[parts[2]] ?? [] });
			}
			if (parts[1] === "batches" && parts.length === 2) {
				const scope = params.get("scope");
				if (!scope) return json(400, { error: "bad_request", message: "scope is required" });
				if (!memory.scopes.some((item) => item.key === scope)) return json(404, { error: "not_found" });
				const batches = stored.batches.filter((batch) => batch.scope.key === scope).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
				return json(200, { batches });
			}
		}
		if (parts[0] === "memory" && parts[1] === "batches" && parts.length === 4 && parts[3] === "revert" && method === "POST") {
			const batch = stored.batches.find((item) => item.id === parts[2]);
			return batch ? revertBatch(batch) : json(404, { error: "not_found" });
		}
		if (parts[0] === "search") {
			const q = (params.get("q") ?? "").trim().toLowerCase();
			const device = params.get("device");
			const project = params.get("project");
			const matching = hits.filter((hit) => {
				const session = byId.get(hit.sessionId)?.detail;
				if (device && session?.device !== device) return false;
				if (project && session?.project !== project) return false;
				return hit.snippet.toLowerCase().includes(q);
			});
			if (params.get("group") === "session") {
				const groups = new Map<string, SessionMatches>();
				for (const hit of matching) {
					let group = groups.get(hit.sessionId);
					if (!group) {
						group = { sessionId: hit.sessionId, sessionTitle: hit.sessionTitle, matches: 0, hits: [] };
						groups.set(hit.sessionId, group);
					}
					group.matches += 1;
					if (group.hits.length < 3) group.hits.push(hit);
				}
				return json(200, { items: [...groups.values()].slice(0, Number(params.get("limit") ?? 20)), nextCursor: null });
			}
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
