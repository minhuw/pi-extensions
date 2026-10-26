// Fixtures shaped like pi session JSONL lines (session-format.md, message-types.md).
import type { BrowserSession, Device, Entry, OnlineSession, RawEntry, RelayEvent, SessionDetail, Turn } from "../../src/lib/types";
import type { FakePairing } from "./server";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");

export function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

export function entry(seq: number, raw: RawEntry): Entry {
	return {
		seq,
		offset: seq * 200,
		id: raw.id ?? null,
		parentId: raw.parentId ?? null,
		type: raw.type,
		timestamp: raw.timestamp ?? null,
		raw,
	};
}

export function header(id: string, cwd = "/home/me/code/pika"): RawEntry {
	return { type: "session", version: 3, id, timestamp: iso(0), cwd };
}

let counter = 0;
function nextId(): string {
	counter += 1;
	return counter.toString(16).padStart(8, "0");
}

export const usage = {
	input: 1200,
	output: 340,
	cacheRead: 8000,
	cacheWrite: 0,
	totalTokens: 9540,
	cost: { input: 0.0036, output: 0.0051, cacheRead: 0.0024, cacheWrite: 0, total: 0.0111 },
};

export function userMessage(text: string, at = 1000): RawEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: iso(at),
		message: { role: "user", content: text, timestamp: T0 + at },
	};
}

/** An extension's message, such as relay's `relay-message`; a turn it starts carries its `customType`. */
export function customMessage(customType: string, content: string, at = 1000): RawEntry {
	return { type: "custom_message", id: nextId(), parentId: null, timestamp: iso(at), customType, content, display: true };
}

export function assistantMessage(content: unknown[], at = 2000, extra: Record<string, unknown> = {}): RawEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: iso(at),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: content.some((block) => (block as { type: string }).type === "toolCall") ? "toolUse" : "stop",
			timestamp: T0 + at,
			...extra,
		},
	};
}

export function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return { type: "toolCall", id, name, arguments: args };
}

export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	options: { isError?: boolean; details?: unknown; at?: number; images?: unknown[] } = {},
): RawEntry {
	const at = options.at ?? 3000;
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: iso(at),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }, ...(options.images ?? [])],
			details: options.details,
			isError: options.isError ?? false,
			timestamp: T0 + at,
		},
	};
}

export function summary(id: string, extra: Partial<SessionDetail> = {}): SessionDetail {
	return {
		id,
		device: "mini",
		project: "pika",
		cwd: "/home/me/code/pika",
		title: `Session ${id}`,
		startedAt: iso(0),
		lastAt: iso(600_000),
		durationMs: 600_000,
		entryCount: 10,
		models: ["claude-sonnet-4-5"],
		tokens: { input: 12000, output: 3400, cacheRead: 80000, cacheWrite: 1000 },
		cost: 0.31,
		childCount: 0,
		children: [],
		...extra,
	};
}

export function turn(index: number, startSeq: number, endSeq: number, extra: Partial<Turn> = {}): Turn {
	return {
		index,
		startSeq,
		endSeq,
		userText: `Prompt number ${index + 1}`,
		at: iso(index * 60_000),
		durationMs: 134_000,
		modelCalls: 8,
		toolCalls: 9,
		toolErrors: 0,
		cost: 0.31,
		tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 },
		finalText: `Final answer ${index + 1}`,
		...extra,
	};
}

export function device(name: string, extra: Partial<Device> = {}): Device {
	return { name, createdAt: iso(0), createdVia: "cli", lastSeenAt: iso(3_600_000), lastHost: `${name}.lan`, ...extra };
}

/** A pending pairing requested `agoMs` before now; it expires ten minutes after that. */
export function pairing(code: string, deviceName: string, agoMs = 30_000, extra: Partial<FakePairing> = {}): FakePairing {
	const requested = Date.now() - agoMs;
	return {
		code,
		device: deviceName,
		host: `${deviceName}.local`,
		ip: "192.168.1.20",
		pikaVersion: "0.2.0",
		requestedAt: new Date(requested).toISOString(),
		expiresAt: new Date(requested + 600_000).toISOString(),
		...extra,
	};
}

export const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
export const SAFARI_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

export function browserSession(id: string, extra: Partial<BrowserSession> = {}): BrowserSession {
	return {
		id,
		createdAt: iso(0),
		lastSeenAt: iso(60_000),
		expiresAt: iso(30 * 24 * 3_600_000),
		userAgent: FIREFOX_LINUX,
		ip: "192.168.1.10",
		current: false,
		...extra,
	};
}

/** A session online through relay, connected `onlineMs` before now and in its current state for the last `stateMs`. */
export function onlineSession(id: string, extra: Partial<OnlineSession> & { onlineMs?: number; stateMs?: number } = {}): OnlineSession {
	const { onlineMs = 3_900_000, stateMs = 180_000, ...rest } = extra;
	const now = Date.now();
	return {
		id,
		device: "mini",
		host: "mini.lan",
		name: `Session ${id}`,
		cwd: "/home/me/code/pika",
		project: "pika",
		model: "claude-sonnet-4-5",
		state: "idle",
		piVersion: "1.4.0",
		connectedAt: new Date(now - onlineMs).toISOString(),
		stateSince: new Date(now - stateMs).toISOString(),
		lastSeenAt: new Date(now - 5_000).toISOString(),
		recorded: true,
		...rest,
	};
}

/** A relay message accepted `agoMs` before now, from one session to another. */
export function relayEvent(id: string, agoMs = 60_000, extra: Partial<RelayEvent> = {}): RelayEvent {
	const at = new Date(Date.now() - agoMs).toISOString();
	return {
		id,
		at,
		from: { kind: "session", sessionId: "s-a", device: "mini", name: "Planner", project: "pika" },
		to: { sessionId: "s-b", device: "laptop", name: "Reviewer", project: "pika" },
		status: "delivered",
		deliveredAt: at,
		urgent: false,
		hops: 1,
		text: `Message ${id}`,
		...extra,
	};
}
