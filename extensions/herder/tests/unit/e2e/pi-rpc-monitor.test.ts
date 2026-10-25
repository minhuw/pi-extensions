import assert from "node:assert/strict";
import test from "node:test";
import { createPiRpcMonitor } from "../../e2e/support/pi-rpc-monitor.ts";

const notification = {
	type: "extension_ui_request", method: "notify", notifyType: "error",
	message: "Profile poorman cannot start because Pi has no available model matching: deepseek-v4-flash.",
};

test("RPC error notification fails even when the slash command response succeeds", () => {
	const monitor = createPiRpcMonitor();
	monitor.consume(Buffer.from(`${JSON.stringify(notification)}\n${JSON.stringify({
		type: "response", id: "herder-fire", command: "prompt", success: true, data: { disposition: "handled" },
	})}\n`));
	assert.throws(() => monitor.assertHealthy(), /Profile poorman cannot start.*deepseek-v4-flash/);
});

test("RPC monitor frames split UTF-8 and CRLF records only at LF", () => {
	const monitor = createPiRpcMonitor();
	const bytes = Buffer.from(`${JSON.stringify({ ...notification, message: "blocked 🔑\u2028detail" })}\r\n`);
	for (const byte of bytes.subarray(0, -1)) monitor.consume(Buffer.from([byte]));
	monitor.assertHealthy();
	monitor.consume(bytes.subarray(-1));
	assert.throws(() => monitor.assertHealthy(), /blocked 🔑\u2028detail/);
});

test("RPC command failures, extension failures and unattended dialogs stop the fixture", () => {
	for (const [record, expected] of [
		[{ type: "response", command: "prompt", success: false, error: "command rejected" }, /command rejected/],
		[{ type: "extension_error", extensionPath: "herder.ts", error: "startup failed" }, /herder.ts.*startup failed/],
		...["select", "confirm", "input", "editor"].map((method) => [
			{ type: "extension_ui_request", method, title: "User decision required" }, /interactive.*User decision required/,
		] as const),
	] as const) {
		const monitor = createPiRpcMonitor();
		monitor.consume(Buffer.from(`${JSON.stringify(record)}\n`));
		assert.throws(() => monitor.assertHealthy(), expected);
	}
});

test("RPC progress, successful commands and non-error notifications remain healthy", () => {
	const monitor = createPiRpcMonitor();
	for (const record of [
		{ type: "response", command: "prompt", success: true },
		{ type: "agent_start" },
		{ type: "extension_ui_request", method: "notify", notifyType: "info", message: "Herder started" },
		{ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "optional tool" },
		{ type: "extension_ui_request", method: "setStatus", statusText: "running" },
	]) monitor.consume(Buffer.from(`${JSON.stringify(record)}\n`));
	monitor.assertHealthy();
});

test("RPC invalid stdout produces a diagnostic without exposing its raw content", () => {
	const monitor = createPiRpcMonitor();
	monitor.consume(Buffer.from("PRIVATE_RAW_DIAGNOSTIC\n"));
	assert.throws(() => monitor.assertHealthy(), (error) => {
		assert.match(String(error), /invalid JSON.*pi.log/);
		assert.doesNotMatch(String(error), /PRIVATE_RAW_DIAGNOSTIC/);
		return true;
	});
});
