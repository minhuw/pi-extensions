import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { relayHttpFetch } from "../../relay/connection.ts";
import {
	BASE_REJECTIONS, expiredContent, headerField, memberLabel, messageContent, preview, roomLine, roomMessageLine, sanitize, sendResult, sessionLine, targetLabel, unmatchedOf,
} from "../../relay/protocol.ts";

it.each([
	["CSI", "a\x1b[31mred\x1b[0mb", "aredb"],
	["private CSI", "a\x1b[?25lb\x1b[?1049hc", "abc"],
	["OSC ended by BEL", "a\x1b]0;title\x07b", "ab"],
	["OSC ended by ST", "a\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\b", "alinkb"],
	["DCS", "a\x1bPq#0;1\x1b\\b", "ab"],
	["APC", "a\x1b_payload\x1b\\b", "ab"],
	["PM", "a\x1b^private\x1b\\b", "ab"],
	["SOS", "a\x1bXstring\x1b\\b", "ab"],
	["8-bit C1", "a\x9b31mb\x9d0;t\x9cc\x900;x\x9cd\x9e1\x9ce\x9f2\x9cf\x983\x9cg", "abcdefg"],
	["lone ESC", "a\x1b", "a"],
	["doubled ESC", "a\x1b\x1b[31mb", "ab"],
	["SS3", "a\x1bOAb", "aAb"],
	["charset selection", "a\x1b(Bb\x1b)0c", "abc"],
	["carriage return", "a\rb\r\nc", "ab\nc"],
	["NEL", "a\x85b", "ab"],
	["an unterminated OSC", "a\x1b]0;never ends", "a0;never ends"],
	["an unterminated 8-bit OSC", "a\x9d0;never ends", "a0;never ends"],
	["an OSC cut short by another sequence", "a\x1b]0;t\x1b[31mred\x07", "a0;tred"],
])("sanitize strips %s", (_name, text, expected) => {
	expect(sanitize(text)).toBe(expected);
	expect(sanitize(text)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
});

/** The fastest of five runs, so a garbage collection or a busy machine does not count against one. */
function fastest(run: () => void): number {
	let best = Infinity;
	for (let i = 0; i < 5; i++) {
		const started = performance.now();
		run();
		best = Math.min(best, performance.now() - started);
	}
	return best;
}

it("sanitizes 32 KiB of unterminated string introducers in linear time", () => {
	sanitize("\x1b]x".repeat(100));
	for (const unit of ["\x1b]", "\x1bP", "\x1b_", "\x9d", "\x90", "\x1b[0", "\x1b "]) {
		const text = unit.repeat(Math.ceil(32 * 1024 / unit.length));
		// The old lazy pattern took over 200 ms on every run; a linear one takes about one.
		expect(fastest(() => sanitize(text)), JSON.stringify(unit)).toBeLessThan(50);
		expect(sanitize(text)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	}
	expect(sanitize(`\x1b]${"a".repeat(32 * 1024)}`)).toBe("a".repeat(32 * 1024));
	expect(fastest(() => sanitize(`\x1b]${"a".repeat(32 * 1024)}`))).toBeLessThan(50);
});

it("strips zero-width characters and bidi controls from header fields, and keeps them in message text", () => {
	const invisible = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
	expect(headerField(`Bu${invisible}ilder`)).toBe("Builder");
	expect(headerField("\u202egnp.exe")).toBe("gnp.exe");
	const content = messageContent({
		type: "message", id: "msg\u200b-1", text: `keep\u200bthis\u202e`, urgent: false, hops: 1, sentAt: "",
		from: { kind: "session", sessionId: "s\u2066-1", device: "desk\u200dtop", name: "Mal\u202elory", project: "a\u200fpi" },
	});
	expect(content.split("\n")[0]).toBe(`[relay] Message msg-1 from pi session s-1 ("Mallory") on desktop, project api:`);
	expect(content).toContain("\n\nkeep\u200bthis\u202e\n\n");
});

it("names a device by its name, else by its id, on one line", () => {
	const message = (from: Record<string, unknown>) => messageContent({ type: "message", id: "m-1", text: "hi", urgent: false, hops: 1, sentAt: "", from: { kind: "session", sessionId: "s-1", device: "7f9c2ba4-e88f-4a1b-9a3c-0d2f6e1b5c47", ...from } }).split("\n")[0];
	expect(message({ deviceName: "Minhu's MacBook Pro" })).toBe(`[relay] Message m-1 from pi session s-1 on Minhu's MacBook Pro:`);
	expect(message({ deviceName: "Work \"laptop\"\n\u202e2" })).toBe(`[relay] Message m-1 from pi session s-1 on Work laptop 2:`);
	expect(message({})).toBe(`[relay] Message m-1 from pi session s-1 on 7f9c2ba4-e88f-4a1b-9a3c-0d2f6e1b5c47:`);
	expect(message({ deviceName: " " })).toBe(`[relay] Message m-1 from pi session s-1 on 7f9c2ba4-e88f-4a1b-9a3c-0d2f6e1b5c47:`);
	expect(targetLabel({ sessionId: "s-2", device: "desktop", deviceName: "Desk top", name: "Docs" })).toBe(`pi session s-2 ("Docs") on Desk top`);
	expect(targetLabel({ sessionId: "s-2", device: "desktop" })).toBe("pi session s-2 on desktop");
});

it("closes what follows an unanswered answer by telling the model not to take it as read, except a message of the user", () => {
	const close = "\n\nYour user has not written since your last answer to them, so do not take that answer as read. If it still holds something they need (a question, a decision, a result), repeat that in full, not as a summary, in the answer that ends this turn, then say what changed since.";
	const frame = { type: "message" as const, id: "m-1", text: "hi", urgent: false, hops: 1, sentAt: "", from: { kind: "session" as const, sessionId: "s-1", device: "desktop" } };
	for (const message of [frame, { ...frame, room: "ops" }]) {
		expect(messageContent(message, true)).toBe(`${messageContent(message)}${close}`);
		expect(messageContent(message).endsWith("do not reply just to say so.")).toBe(true);
	}
	// The user wrote these in the web UI.
	for (const message of [{ ...frame, from: { kind: "web" as const } }, { ...frame, room: "ops", from: { kind: "web" as const } }]) expect(messageContent(message, true)).toBe(messageContent(message));
	expect(expiredContent("m-2", "pi session s-1", 300)).toBe("[relay] Your message m-2 to pi session s-1 expired: it was not delivered within 5 minutes and was dropped.");
	expect(expiredContent("m-2", "pi session s-1", 300, true)).toBe(`[relay] Your message m-2 to pi session s-1 expired: it was not delivered within 5 minutes and was dropped.${close}`);
});

it("formats previews, sessions, rooms, room messages, and send results with sanitized, bounded unmatched mentions", () => {
	expect(BASE_REJECTIONS.not_owner).toContain("belongs to another device");
	expect(preview("  hello\n\tworld  ")).toBe("hello world");
	const long = "a".repeat(65);
	expect(preview(long)).toBe(`${"a".repeat(59)}…`);

	const overlong = `  ${"x".repeat(70)}  `;
	expect(unmatchedOf({ unmatched: [overlong, "  ", "\x1b[31mghost\x1b[0m"] })).toEqual(["x".repeat(64), "ghost"]);
	expect(unmatchedOf({})).toEqual([]);

	const now = Date.now();
	expect(sessionLine({
		id: "s-1", device: "dev-1", deviceName: "MacBook", host: "mbp", name: "Builder", cwd: "/repo",
		project: "pika", model: "claude", state: "idle", connectedAt: now - 120_000, stateSince: now, lastSeenAt: now, recorded: true,
	})).toBe('s-1 · MacBook · project pika · "Builder" · idle · claude · online 2m');

	const member = { sessionId: "s-2", name: "Reviewer", project: "pika", state: "busy" as const, online: true, joinedAt: now };
	expect(memberLabel(member)).toBe("Reviewer (pika) [s-2, busy]");
	expect(roomLine({
		name: "ops", topic: "deploy", createdAt: now, updatedAt: now, messageCount: 1, members: [member],
	})).toBe("#ops — deploy · 1 msg · members: Reviewer (pika) [s-2, busy]");
	expect(roomMessageLine({
		id: "m-1", seq: 3, room: "ops", from: { kind: "web" }, text: "ship\x1b[31m it", mentions: ["s-2"], notified: [], urgent: false, hops: 1, at: now - 5_000,
	})).toBe("[#3 · m-1 · 5s ago] user (web) [notified: s-2]: ship it");

	expect(sendResult({ type: "sent", clientId: "c-1", id: "m-1", status: "delivered", to: { sessionId: "s-2" } }, "pi session s-2", 300))
		.toBe("Delivered message m-1 to pi session s-2.");
	expect(sendResult({ type: "sent", clientId: "c-2", id: "m-2", status: "queued", to: { sessionId: "s-2" } }, "pi session s-2", 300))
		.toBe("Queued message m-2 for pi session s-2: it has not been delivered yet. If it is not delivered within 5 minutes it is dropped and you will get a notice.");
	expect(sendResult({
		type: "sent", clientId: "c-3", id: "m-3", status: "delivered", to: { sessionId: "#ops" }, room: "ops",
		notified: [{ sessionId: "s-2", name: "Reviewer", device: "laptop" }],
		unmatched: [overlong, "ghost"],
	}, "room #ops", 300)).toBe(
		`Posted message m-3 to room #ops (notified pi session s-2 ("Reviewer") on laptop). Mentions that reached nobody (not members): ${"x".repeat(64)}, ghost.`,
	);
});

it("maps /api/relay/v1/* HTTP responses and errors in relayHttpFetch with optional overrides", async () => {
	let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	};
	const server = createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		// 200 OK sends Authorization header and parses JSON.
		let seenAuth = "";
		handler = (req, res) => {
			seenAuth = req.headers.authorization ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ items: [1, 2] }));
		};
		expect(await relayHttpFetch<{ items: number[] }>({ url, token: "tok-1", path: "/api/relay/v1/sessions" })).toEqual({ items: [1, 2] });
		expect(seenAuth).toBe("Bearer tok-1");

		// 401
		handler = (_req, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/sessions" })).rejects.toThrow("the server rejected this device's token (HTTP 401)");

		// 404 with error: "not_found" (default and override)
		handler = (_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not_found" })); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms/missing" })).rejects.toThrow("no such chatroom exists yet");
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms/missing", notFoundMessage: "custom missing room" })).rejects.toThrow("custom missing room");

		// 404 without not_found (server has no relay)
		handler = (_req, res) => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not Found"); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms" })).rejects.toThrow(`the pika server at ${url} has no relay (HTTP 404)`);

		// body.error mapped via default BASE_REJECTIONS, custom rejections, and unknown fallback
		handler = (_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not_owner" })); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms" })).rejects.toThrow(`relay error (not_owner): ${BASE_REJECTIONS.not_owner}`);

		handler = (_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not_member" })); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms", rejections: { not_member: "codex custom not_member" } }))
			.rejects.toThrow("relay error (not_member): codex custom not_member");

		handler = (_req, res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "mystery_code" })); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms" })).rejects.toThrow("relay error (mystery_code): mystery_code");

		// Unexpected HTTP status without JSON error field
		handler = (_req, res) => { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("Bad Gateway"); };
		await expect(relayHttpFetch({ url, token: "tok-1", path: "/api/relay/v1/rooms" })).rejects.toThrow(`unexpected HTTP 502 from ${url}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
