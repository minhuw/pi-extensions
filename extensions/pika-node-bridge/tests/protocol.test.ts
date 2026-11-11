/**
 * The bridge keeps its own copy of the bridge-socket subset of `services/pika-node/src/protocol.ts`. These tests
 * read the daemon's file by relative path (the runtime never does) and fail when the copy drifts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type * as Canonical from "../../../services/pika-node/src/protocol.ts";
import * as Copy from "../protocol.ts";

const CANONICAL_URL = new URL("../../../services/pika-node/src/protocol.ts", import.meta.url);
const COPY_URL = new URL("../protocol.ts", import.meta.url);

const DECLARATIONS = ["Activity", "PaneSession", "PaneState", "BridgeStatus", "SocketHello", "BridgeMessage", "DaemonToBridge"];

/** The text of `export interface|type <name>`, without comments, with whitespace collapsed. */
function declaration(source: string, name: string): string {
	const start = new RegExp(`^export (interface|type) ${name}\\b`, "m").exec(source);
	if (!start) throw new Error(`no declaration of ${name}`);
	const kind = start[1];
	let depth = 0;
	let end = start.index;
	for (; end < source.length; end++) {
		const char = source[end];
		if (char === "{" || char === "(") depth++;
		else if (char === "}" || char === ")") {
			depth--;
			if (depth === 0 && kind === "interface") { end++; break; }
		} else if (char === ";" && depth === 0 && kind === "type") { end++; break; }
	}
	return source.slice(start.index, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
}

// Compile-time: each side's types are assignable to the other's (`npm run typecheck` checks this file).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertSame = <T extends true>(): T => true as T;
assertSame<Same<Copy.Activity, Canonical.Activity>>();
assertSame<Same<Copy.PaneSession, Canonical.PaneSession>>();
assertSame<Same<Copy.PaneState, Canonical.PaneState>>();
assertSame<Same<Copy.BridgeStatus, Canonical.BridgeStatus>>();
assertSame<Same<Copy.SocketHello, Canonical.SocketHello>>();
assertSame<Same<Copy.BridgeMessage, Canonical.BridgeMessage>>();
assertSame<Same<Copy.DaemonToBridge, Canonical.DaemonToBridge>>();

describe("bridge-socket protocol copy", () => {
	const canonical = readFileSync(fileURLToPath(CANONICAL_URL), "utf8");
	const copy = readFileSync(fileURLToPath(COPY_URL), "utf8");

	it.each(DECLARATIONS)("declares %s exactly as the daemon does", name => {
		expect(declaration(copy, name)).toBe(declaration(canonical, name));
	});

	it("shares the constants and line framing", async () => {
		const daemon = await import(CANONICAL_URL.href) as typeof Canonical;
		expect(Copy.PROTOCOL_VERSION).toBe(daemon.PROTOCOL_VERSION);
		expect(Copy.SOCKET_ENV).toBe(daemon.SOCKET_ENV);
		expect(Copy.PANE_ENV).toBe(daemon.PANE_ENV);
		for (const key of ["maxBridgeLineBytes", "maxActivities", "maxActivityCount", "maxPathBytes"] as const) {
			expect(Copy.LIMITS[key], key).toBe(daemon.LIMITS[key]);
		}
		for (const text of ["", "plain", "é", "🙂", "\ud800", "a\ud83d\ude00b"]) expect(Copy.utf8Length(text)).toBe(daemon.utf8Length(text));
		const message: Copy.BridgeMessage = { type: "open", id: "open-1", path: "/a\nb", line: 2 };
		expect(Copy.encodeLine(message)).toBe(daemon.encodeLine(message));
		const decoder = new Copy.LineDecoder(8);
		expect(decoder.push("ab\ncd")).toEqual(["ab"]);
		expect(() => decoder.push("efghijk")).toThrow(Copy.LineTooLong);
	});

	it("parses what the daemon's own parser accepts, and refuses what it refuses", async () => {
		const daemon = await import(CANONICAL_URL.href) as typeof Canonical;
		const lines: unknown[] = [
			{ type: "welcome", version: "0.1.0", protocolVersion: 1 },
			{ type: "reply", id: "open-1", result: { delivered: 2 } },
			{ type: "reply", id: "hello", error: { code: "not_found" } },
			{ type: "reply", id: "diff-3", error: { code: "outside_roots", message: "/etc is outside the configured roots" } },
			{ type: "reply", id: "x", result: { delivered: 1 }, error: { code: "io" } },
			{ type: "reply", id: "x" },
			{ type: "welcome", version: "0.1.0" },
		];
		for (const line of lines) {
			const theirs = daemon.parseDaemonToBridge(line);
			const ours = Copy.parseDaemonToBridge(line);
			expect(ours !== undefined, JSON.stringify(line)).toBe(theirs.ok);
			if (theirs.ok) expect(ours).toEqual(theirs.message);
		}
	});
});
