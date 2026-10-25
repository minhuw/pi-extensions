// Fixtures shaped like pi session JSONL lines (session-format.md, message-types.md).
import type { Entry, RawEntry, SessionDetail, Turn } from "../../src/lib/types";

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
