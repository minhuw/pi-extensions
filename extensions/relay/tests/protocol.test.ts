import { expect, it } from "vitest";
import { headerField, messageContent, sanitize, targetLabel } from "../protocol.ts";

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
