/**
 * The bridge-socket subset of `services/pika-node/src/protocol.ts` (NODE.md §5), copied so the extension imports
 * nothing outside the root package. `tests/protocol.test.ts` fails when the declarations drift from the daemon's.
 */

/** The end-to-end and inner protocol version (`hs1.v`, `welcome.protocolVersion`, bridge `hello`). */
export const PROTOCOL_VERSION = 1;

export const SOCKET_ENV = "PIKA_NODE_SOCKET";
export const PANE_ENV = "PIKA_NODE_PANE_ID";

export const LIMITS = {
	maxBridgeLineBytes: 1024 * 1024,
	maxActivities: 128,
	maxActivityCount: 1_024,
	maxPathBytes: 4_096,
} as const;

export interface Activity {
	source: string;
	id: string;
	label: string;
	kind?: "agent" | "workflow" | "step";
	state?: "running" | "waiting";
	startedAt?: number;
	model?: string;
	progress?: { completed: number; total: number };
}
export interface PaneSession { id: string; name?: string; cwd: string; file?: string }
export type PaneState = "idle" | "busy" | "waiting";
export interface BridgeStatus {
	state: PaneState;
	activities: Activity[];
	activityCount: number;
	session?: PaneSession;
	model?: string;
	updatedAt: number;
}

export type SocketHello =
	| { type: "hello"; role: "bridge"; paneId: string; pid: number; version: string; protocolVersion: number }
	| { type: "hello"; role: "client"; version: string; protocolVersion: number };
export type BridgeMessage =
	| SocketHello
	| { type: "status"; status: BridgeStatus }
	| { type: "open"; id: string; path: string; line?: number; column?: number }
	| { type: "diff"; id: string; path: string; staged?: boolean };
export type DaemonToBridge =
	| { type: "welcome"; version: string; protocolVersion: number }
	| { type: "reply"; id: string; result: { delivered: number }; error?: undefined }
	| { type: "reply"; id: string; error: { code: string; message?: string }; result?: undefined };

/** An own data property, never an accessor. */
export function data(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** A daemon line, or undefined when it is not one this bridge understands. */
export function parseDaemonToBridge(value: unknown): DaemonToBridge | undefined {
	const type = data(value, "type");
	if (type === "welcome") {
		const version = data(value, "version"), protocolVersion = data(value, "protocolVersion");
		if (typeof version !== "string" || !Number.isSafeInteger(protocolVersion)) return undefined;
		return { type, version, protocolVersion: protocolVersion as number };
	}
	if (type !== "reply") return undefined;
	const id = data(value, "id"), result = data(value, "result"), error = data(value, "error");
	if (typeof id !== "string" || (result === undefined) === (error === undefined)) return undefined;
	if (result !== undefined) {
		const delivered = data(result, "delivered");
		return Number.isSafeInteger(delivered) && (delivered as number) >= 0 ? { type, id, result: { delivered: delivered as number } } : undefined;
	}
	const code = data(error, "code"), message = data(error, "message");
	if (typeof code !== "string" || (message !== undefined && typeof message !== "string")) return undefined;
	return { type, id, error: { code, ...(message !== undefined ? { message } : {}) } };
}

/** UTF-8 length of a string without encoding it; lone surrogates count as U+FFFD (3 bytes). */
export function utf8Length(text: string): number {
	let length = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) length += 1;
		else if (code < 0x800) length += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { length += 4; i++; }
		else length += 3;
	}
	return length;
}

export class LineTooLong extends Error {}

/** Splits a UTF-8 text stream into lines; throws `LineTooLong` when a line passes `maxBytes`. */
export class LineDecoder {
	#pending = "";
	#maxBytes: number;
	constructor(maxBytes: number = LIMITS.maxBridgeLineBytes) { this.#maxBytes = maxBytes; }
	push(chunk: string): string[] {
		const parts = (this.#pending + chunk).split("\n");
		this.#pending = parts.pop()!;
		if (utf8Length(this.#pending) > this.#maxBytes) throw new LineTooLong(`line over ${this.#maxBytes} bytes`);
		for (const line of parts) if (utf8Length(line) > this.#maxBytes) throw new LineTooLong(`line over ${this.#maxBytes} bytes`);
		return parts.filter(line => line.trim().length > 0);
	}
}

/** One NDJSON line; JSON.stringify escapes every newline inside strings. */
export const encodeLine = (message: BridgeMessage): string => `${JSON.stringify(message)}\n`;
