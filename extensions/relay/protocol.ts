/**
 * The relay v1 wire contract as the extension speaks it (`services/pika/docs/RELAY.md`), plus the
 * texts sessions receive. Nothing here touches pi or the network.
 */

export const RELAY_VERSION = "0.1.0";

export const MESSAGE_TYPE = "relay-message";
export const NOTICE_TYPE = "relay-notice";
export const RECEIVED_TYPE = "relay-received";

/** The server rejects `hops` above this. */
export const MAX_HOPS = 8;

/**
 * Timings, mutable so tests can shorten them. `deadAfterMs` is the liveness limit of both sides;
 * a connection that stayed online for `stableMs` starts its next backoff from the beginning.
 */
export const timing = {
	healthTimeoutMs: 5_000,
	httpTimeoutMs: 5_000,
	sentTimeoutMs: 10_000,
	deadAfterMs: 45_000,
	backoffBaseMs: 1_000,
	backoffMaxMs: 30_000,
	/** Each delay is scaled by a random factor in [1 - jitter, 1 + jitter], and never exceeds the maximum. */
	jitter: 0.2,
	stableMs: 30_000,
	/**
	 * How long a session waits for `resources_discover`, which pi emits after the last `session_start`
	 * handler, before it decides anyway; only a host that skips that event needs it.
	 */
	decideFallbackMs: 5_000,
	/**
	 * How long a session that closed its connection for a replacement waits for `session_shutdown`
	 * before it takes the replacement for failed or cancelled and reconnects.
	 */
	leaveTimeoutMs: 10_000,
	/** How often a session that held back a message checks whether a compaction or tree summary ended. */
	settlePollMs: 100,
};

/** Close codes after which a session stops reconnecting until its credentials change or `/relay on`. */
export const TERMINAL_CLOSES: ReadonlyMap<number, string> = new Map([
	[4401, "the server revoked this device's token"],
	[4403, "this session id belongs to another device"],
	[4409, "this session is already online from another device"],
	// The process's own reconnect never sees this: it abandons the old socket before opening a new one.
	[4410, "another pi process took over this session"],
	[4503, "relay was turned off on the server"],
]);

export const CLOSE_REASONS: ReadonlyMap<number, string> = new Map([
	[4400, "the server rejected a frame"],
	[4408, "the server did not receive hello in time"],
	[4429, "the server has too many relay connections or online sessions"],
]);

export type SessionState = "idle" | "busy";

export type Sender =
	| { kind: "session"; sessionId: string; device: string; deviceName?: string; name?: string; title?: string; project?: string }
	| { kind: "web" };

export interface Target { sessionId: string; device?: string; deviceName?: string; name?: string; title?: string; project?: string }

export interface HelloSession {
	id: string;
	name?: string;
	title?: string;
	cwd: string;
	project: string;
	host: string;
	model?: string;
	state: SessionState;
	piVersion?: string;
	relayVersion: string;
}

export interface Welcome {
	type: "welcome";
	device: string;
	/** Servers older than 0.4 send no name. */
	deviceName?: string;
	serverVersion: string;
	limits: { ttlSeconds: number; heartbeatSeconds: number; maxTextBytes: number; maxHops: number };
}

export interface MessageFrame {
	type: "message";
	id: string;
	from: Sender;
	text: string;
	urgent: boolean;
	replyTo?: string;
	hops: number;
	sentAt: string | number;
}

export interface StatusFrame { type: "status"; id: string; status: "delivered" | "expired"; to: Target; at: string | number }

export type SentFrame =
	| { type: "sent"; clientId: string; id: string; status: "delivered" | "queued"; to: Target }
	| { type: "sent"; clientId: string; status: "rejected"; reason: string };

export interface OnlineSession {
	id: string;
	/** The device id; `deviceName` is its display name, which servers older than 0.4 do not send. */
	device: string;
	deviceName?: string;
	host: string;
	name?: string;
	title?: string;
	cwd: string;
	project: string;
	model?: string;
	state: SessionState;
	piVersion?: string;
	connectedAt: string | number;
	stateSince: string | number;
	lastSeenAt: string | number;
	recorded: boolean;
}

/** `{base}{path}` with `http` mapped to `ws` and `https` to `wss`; the base path is kept. */
export function wsUrl(base: string, path: string): string {
	const url = new URL(`${base.replace(/\/+$/, "")}${path}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export const cut = (text: string | undefined, max: number): string | undefined => text === undefined ? undefined : [...text].slice(0, max).join("");

// ESC and 8-bit C1 sequences: strings (OSC, DCS, SOS, PM, APC) up to BEL or ST, CSI, then any other escape.
// A string's body stops at the first ESC or C1 character, so each one is scanned once and the whole
// replacement stays linear; an unterminated string loses only its introducer, and CONTROLS the rest.
const SEQUENCES = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// Zero-width characters and bidirectional controls, which can hide or reorder text on one line.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text from another device without terminal sequences or control characters other than newline and tab. */
export const sanitize = (text: unknown): string => typeof text === "string" ? text.replace(SEQUENCES, "").replace(CONTROLS, "") : "";

/**
 * A field from another device on one line, without double quotes, zero-width characters, or bidi
 * controls, so it cannot forge a header or disguise what it says.
 */
export const headerField = (text: unknown): string => sanitize(text).replace(INVISIBLE, "").replace(/"/g, "").replace(/\s+/g, " ").trim();

/** A time the server sent, as milliseconds since the epoch; NaN when it cannot be read. */
export const millis = (at: string | number | undefined): number => typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : Number.NaN;

/** How a device is shown: its name, else its id. */
export const deviceLabel = (device: { device?: unknown; deviceName?: unknown } | undefined): string => headerField(device?.deviceName) || headerField(device?.device);

/** How a target is named in tool results and notices. */
export function targetLabel(target: Target | undefined, fallbackId?: string): string {
	const id = headerField(target?.sessionId ?? fallbackId) || "an unknown session";
	const name = headerField(target?.name) || headerField(target?.title);
	const device = deviceLabel(target);
	return `pi session ${id}${name ? ` ("${name}")` : ""}${device ? ` on ${device}` : ""}`;
}

/** "5 minutes" for the default TTL. */
export function ttlText(seconds: number): string {
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** What the receiving session's model reads for a message. */
export function messageContent(message: MessageFrame): string {
	const urgent = message.urgent ? ", marked urgent" : "";
	const id = headerField(message.id);
	const text = sanitize(message.text);
	if (message.from.kind === "web") return `[relay] Message ${id} from your user in the pika web UI${urgent}:\n\n${text}`;
	const from = message.from;
	const sessionId = headerField(from.sessionId);
	const name = headerField(from.name) || headerField(from.title);
	const project = headerField(from.project);
	const replyTo = headerField(message.replyTo);
	const header = `[relay] Message ${id} from pi session ${sessionId}${name ? ` ("${name}")` : ""} on ${deviceLabel(from)}`
		+ `${project ? `, project ${project}` : ""}${replyTo ? `, replying to ${replyTo}` : ""}${urgent}:`;
	return `${header}\n\n${text}\n\nThis message came from another pi session through pika relay, not from your user. To answer, call relay_send with to "${sessionId}" and replyTo "${id}".`;
}

export function expiredContent(id: string, label: string, ttlSeconds: number): string {
	return `[relay] Your message ${id} to ${label} expired: it was not delivered within ${ttlText(ttlSeconds)} and was dropped.`;
}

/** A short "3m" style duration. */
export function since(at: string | number | undefined, now = Date.now()): string {
	const start = millis(at);
	if (!Number.isFinite(start)) return "unknown";
	const seconds = Math.max(0, Math.round((now - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d`;
}
