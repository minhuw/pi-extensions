import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRelaySettings } from "../config.ts";
import { credentialsRegistry } from "../credentials.ts";
import type { RelayConnection } from "./connection.ts";
import {
	cut, headerField, type HelloSession, type MessageFrame, preview, type RelayRoom, type SentFrame, type SessionState, since, type Target, timing,
} from "./protocol.ts";
import { type Running, type SideAnswer, Transcript } from "./side.ts";

/** At most this many sent messages are remembered for relay_status, and this many shown. */
export const SENT_KEPT = 200;
export const SENT_SHOWN = 50;
/** The footer status keys, and the session mode a representative needs. */
export const ROLE_STATUS = "representative";
export const ROOMS_STATUS = "relay-rooms";
export const SWARM = "swarm";

/**
 * `failed`: the message never left this session; `unknown`: the server never answered (timeout,
 * dropped connection, or cancelled), so it may or may not have been accepted.
 */
export type SentStatus = "queued" | "delivered" | "expired" | "rejected" | "failed" | "unknown";
export interface SentRecord { id?: string; to: string; label: string; status: SentStatus; reason?: string; at: number; text: string }

/**
 * A delivered message the model has not read yet. `soon`: it reaches the model before its next model
 * call, not only after its turn; `told`: a send to its peer was refused once for it.
 */
export interface Unread { peer: string; label: string; soon: boolean; told: boolean }

export interface RelayMessageDetails { id: string; room?: string; mentions?: string[]; from: MessageFrame["from"]; text: string; urgent: boolean; replyTo?: string; hops: number; sentAt: string | number }
export interface RelayNoticeDetails { id: string; to: Target; status: "expired"; at: string | number }

export interface SendOptions { room?: string; mentions?: string[]; urgent?: boolean; replyTo?: string; hops: number; checkUnread?: boolean }
export type SendFn = (to: string, text: string, options: SendOptions, signal?: AbortSignal) => Promise<{ text: string; answer: SentFrame }>;

export interface RelayState {
	readonly self: object;
	ctx: ExtensionContext | undefined;
	sessionId: string | undefined;
	started: boolean;
	/** Whether the connect decision ran, after every `session_start` handler. */
	decided: boolean;
	fallback: ReturnType<typeof setTimeout> | undefined;
	child: boolean;
	/** `/relay off` ran in this session. */
	off: boolean;
	/**
	 * The session is being replaced (`session_before_switch` or `session_before_fork` ran): its
	 * connection is closed, so the server keeps its messages queued and expires them. A replacement
	 * that was cancelled or failed shows as no `session_shutdown` within `leaveTimeoutMs`, a user
	 * prompt, or `/relay`, which reconnect.
	 */
	leaving: boolean;
	leaveTimer: ReturnType<typeof setTimeout> | undefined;
	/** A compaction or tree summary started and its end event has not come yet. */
	summarizing: boolean;
	/** A message arrived while pi was summarizing; the connection restarts once it is done. */
	missed: boolean;
	settleTimer: ReturnType<typeof setTimeout> | undefined;
	busy: boolean;
	connection: RelayConnection | undefined;
	toolsRegistered: boolean;
	runHops: number;
	ttlSeconds: number;
	maxTextBytes: number;
	title: string | undefined;
	/** The repository name pika resolves for the session's cwd, once asked; undefined until then or without one. */
	project: { cwd: string; name?: string; pending: Promise<void> } | undefined;
	/** What the server last heard of this session's state, name, title, and model. */
	reported: Partial<Pick<HelloSession, "state" | "name" | "title" | "model">>;
	readonly seen: Set<string>;
	readonly notified: Set<string>;
	readonly sent: SentRecord[];
	/** When this session last sent to each peer (a session id or `#room`), or its model last read a message from it. */
	readonly exchanged: Map<string, number>;
	/** Delivered messages the model has not read yet, by id, in arrival order. */
	readonly unread: Map<string, Unread>;
	/** The turn's last model request and what followed it, which a side request repeats. */
	readonly transcript: Transcript;
	/** The turn's top-level tool calls that have not finished, by id, in start order. */
	readonly running: Map<string, Running>;
	turnStartedAt: number | undefined;
	/** `/relay side on|off` in this session; undefined follows `relay.sideAnswers` in pika.json. */
	sideOverride: boolean | undefined;
	/** What side requests answered since the session last settled. */
	readonly sideAnswers: SideAnswer[];
	/** Incremented on session start/shutdown, depart, and `agent_settled` to fence in-flight side sends. */
	sideGeneration: number;
	/** The rooms this session is a member of, by name, as the server last listed them; undefined until the first full list. */
	rooms: Map<string, RelayRoom> | undefined;
	/** Counts room lists, so an older answer never replaces a newer one. */
	roomsGeneration: number;
	/** The footer's room statuses as last set, cached independently. */
	roleShown: string | undefined;
	roomsShown: string | undefined;
	/** Swarm mode is off while this session represents a room: it stops representing once this fires. */
	unrepresentTimer: ReturnType<typeof setTimeout> | undefined;
}

export function createRelayState(): RelayState {
	return {
		self: {},
		ctx: undefined,
		sessionId: undefined,
		started: false,
		decided: false,
		fallback: undefined,
		child: false,
		off: false,
		leaving: false,
		leaveTimer: undefined,
		summarizing: false,
		missed: false,
		settleTimer: undefined,
		busy: false,
		connection: undefined,
		toolsRegistered: false,
		runHops: 0,
		ttlSeconds: 300,
		maxTextBytes: 32 * 1024,
		title: undefined,
		project: undefined,
		reported: {},
		seen: new Set(),
		notified: new Set(),
		sent: [],
		exchanged: new Map(),
		unread: new Map(),
		transcript: new Transcript(),
		running: new Map(),
		turnStartedAt: undefined,
		sideOverride: undefined,
		sideAnswers: [],
		sideGeneration: 0,
		rooms: undefined,
		roomsGeneration: 0,
		roleShown: undefined,
		roomsShown: undefined,
		unrepresentTimer: undefined,
	};
}

// Relay never throws into pi.
export const guard = (fn: () => void): void => { try { fn(); } catch { /* reported through /relay */ } };

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const roomKey = (name: string): string => name.trim().replace(/^#/, "").trim();
export const supportedMode = (context: ExtensionContext): boolean => context.mode === "tui" || context.mode === "rpc";
export const cwdOf = (context: ExtensionContext): string => context.sessionManager.getCwd() || context.cwd;

/** The conversation a message belongs to: `#room`, else the sending session's id; none for the web UI. */
export const peerOf = (frame: MessageFrame): string | undefined => frame.room ? `#${frame.room}` : frame.from.kind === "session" ? frame.from.sessionId : undefined;

export const talking = (state: RelayState, peer: string): boolean => {
	const at = state.exchanged.get(peer);
	return at !== undefined && Date.now() - at < timing.conversationMs;
};

/** A message of the peer waits for the end of the turn. */
export const waiting = (state: RelayState, peer: string): boolean =>
	[...state.unread.values()].some((entry) => entry.peer === peer && !entry.soon);

export const sideSettings = (state: RelayState): { on: boolean; afterMs: number } => {
	const settings = loadRelaySettings(getAgentDir());
	return { on: state.sideOverride ?? settings.sideAnswers, afterMs: settings.sideAnswerSeconds * 1000 };
};

export const isMember = (state: RelayState, room: RelayRoom): boolean =>
	Array.isArray(room?.members) && room.members.some((member) => member.sessionId === state.sessionId);

/** The rooms this session represents, as far as it knows. */
export const represented = (state: RelayState): string[] =>
	[...(state.rooms?.values() ?? [])].filter((room) => room.representative === state.sessionId).map((room) => room.name);

/** Another session represents the user in the room, so this one reports there and its user does not read it. */
export const reportsIn = (state: RelayState, name: string): boolean => {
	const representative = state.rooms?.get(roomKey(name))?.representative;
	return representative !== undefined && representative !== state.sessionId;
};

/** Why a send to a peer waits until the model read the peer's newer messages. */
export function unreadText(ids: string[], label: string, soon: boolean): string {
	const one = ids.length === 1;
	const which = `${one ? "message" : "messages"} ${ids.map(headerField).join(", ")} from ${label}`;
	const it = one ? "it" : "them";
	return soon
		? `Not sent: ${which} arrived while you were writing yours, and you have not read ${it} yet. ${one ? "It follows" : "They follow"} this result: read ${it}, then send again if your message still adds something.`
		: `Not sent: ${which} ${one ? "waits" : "wait"} for you until your current turn ends. End your turn now to read ${it}, then reply if your message still adds something.`;
}

export function firstPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
		if (text.trim()) return cut(text.replace(/\s+/g, " ").trim(), 120);
	}
	return undefined;
}

/**
 * Why this session must stay offline, before any connection state; undefined when it may connect.
 * `starting` skips the wait for the connect decision, for the child hook.
 */
export function blocked(state: RelayState, starting = false): string | undefined {
	if (process.env.PI_RELAY_DISABLED === "1") return "PI_RELAY_DISABLED=1 is set";
	if (!state.started || !state.ctx) return "the session has not started";
	if (state.child) return "this is a child session (a subagent or Herder step); relay connects only top-level sessions";
	if (!supportedMode(state.ctx)) return `relay connects only in the TUI and RPC modes, and this session runs in ${state.ctx.mode} mode`;
	if (!state.decided && !starting) return "the session is still starting";
	if (state.off) return "relay is off for this session (/relay off); /relay on reconnects it";
	const current = credentialsRegistry().current;
	if (!current) return "pika is not logged in or is disabled; run /pika login";
	const cwd = cwdOf(state.ctx);
	if (current.isExcluded(cwd)) return `${cwd} is excluded by pika's exclude list`;
	return undefined;
}

/** Why the session cannot send now; undefined when it is online. */
export function offlineReason(state: RelayState): string | undefined {
	const reason = blocked(state);
	if (reason) return reason;
	if (state.leaving) return "pi is replacing this session (/new, /resume, or a fork)";
	const connState = state.connection?.state;
	if (!connState || connState.kind === "closed") return "it is not connected";
	if (connState.kind === "connecting") return connState.reason ? `it is reconnecting after: ${connState.reason}` : "it is still connecting";
	if (connState.kind === "retrying") return `${connState.reason}; it retries in ${Math.max(0, Math.ceil((connState.at - Date.now()) / 1000))} s`;
	if (connState.kind === "stopped") return `${connState.reason}; /relay on retries`;
	return undefined;
}

export function describe(pi: ExtensionAPI, state: RelayState): Partial<HelloSession> & { state: SessionState } {
	const name = pi.getSessionName();
	if (!name && !state.title && state.ctx) state.title = firstPrompt(state.ctx);
	const model = state.ctx?.model;
	return {
		state: state.busy ? "busy" : "idle",
		...(name ? { name: cut(name, 200) } : {}),
		...(name || state.title ? { title: cut(name || state.title, 200) } : {}),
		...(model ? { model: cut(`${model.provider}/${model.id}`, 200) } : {}),
	};
}

export function statusLines(state: RelayState, id?: string): string {
	const records = [...state.sent].reverse().filter((record) => !id || record.id === id).slice(0, SENT_SHOWN);
	if (!records.length) return id ? `No message ${id} was sent from this session in this process.` : "This session has sent no relay messages in this process.";
	return records.map((record) => `${record.id ?? "(no id)"} to ${record.label}: ${record.status}${record.reason ? ` (${record.reason})` : ""}, sent ${since(record.at)} ago: "${preview(record.text)}"`).join("\n");
}
