import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	decodeAssistantResult,
	finalAssistantResult as sharedFinalAssistantResult,
	responseActivity,
} from "../../../adapters/assistant-message.ts";
import { finalAssistantResult as workerFinalAssistantResult } from "../../../adapters/worker-engine.ts";

const adapters = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../adapters");

function assistant(content: unknown, extras: Record<string, unknown> = {}) {
	return { role: "assistant", content, stopReason: "stop", ...extras };
}

test("shared decoder filters text blocks and preserves padded content", () => {
	const message = assistant([
		{ type: "thinking", text: "ignore" },
		{ type: "text", text: "  first  " },
		{ type: "image", data: "ignore" },
		{ type: "text", text: "second" },
	]);
	assert.equal(assistantText(message), "  first  \nsecond");
	assert.deepEqual(decodeAssistantResult([message]), { text: "  first  \nsecond", failed: false });
});

test("empty assistant content has no decoded text", () => {
	for (const content of [undefined, [], [{ type: "image", data: "x" }], [{ type: "text", text: "" }], [{ type: "text", text: "  \n  " }]]) {
		const result = decodeAssistantResult([assistant(content)]);
		assert.deepEqual(result, { failed: false });
		assert.equal(assistantText(assistant(content)), undefined);
	}
});

test("decoder selects the final assistant and reports provider failures", () => {
	assert.deepEqual(decodeAssistantResult([
		assistant([{ type: "text", text: "draft" }], { stopReason: "toolUse" }),
		{ role: "toolResult", content: [] },
		assistant([{ type: "text", text: "final" }], { stopReason: "aborted" }),
	]), { text: "final", failed: true });
	assert.deepEqual(decodeAssistantResult([
		assistant([{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: " provider failed " }),
	]), { text: "partial", error: "provider failed", failed: true });
	assert.equal(decodeAssistantResult([{ role: "user", content: "hello" }]), undefined);
});

test("activity uses the first nonblank line and caps it at 80 characters", () => {
	assert.equal(responseActivity("\n  first line  \nsecond"), "first line");
	assert.equal(responseActivity("x".repeat(81)), `${"x".repeat(79)}…`);
	assert.equal(responseActivity("   \n\t"), undefined);
});

test("worker compatibility adapter shares the core and keeps its no-result diagnostic", () => {
	const messages = [assistant([{ type: "text", text: "  padded  " }])];
	assert.deepEqual(workerFinalAssistantResult(messages), sharedFinalAssistantResult(messages));
	assert.deepEqual(workerFinalAssistantResult([]), {
		failed: true,
		error: "Pi worker returned no assistant result.",
	});
});

test("both callers import shared decoding and do not define local decoder wrappers", () => {
	for (const file of ["worker-engine.ts", "nested-agent-executor.ts"]) {
		const source = readFileSync(path.join(adapters, file), "utf8");
		assert.match(source, /\.\/assistant-message\.ts/);
		for (const symbol of ["assistantText", "responseActivity", "finalAssistantResult"]) {
			assert.doesNotMatch(source, new RegExp(`(?:function\\s+${symbol}|(?:const|let|var)\\s+${symbol}\\s*=)`));
		}
	}
	const workerSource = readFileSync(path.join(adapters, "worker-engine.ts"), "utf8");
	assert.match(workerSource, /import \{[^}]*finalAssistantResult[^}]*\} from "\.\/assistant-message\.ts"/s);
	assert.match(workerSource, /export \{ finalAssistantResult \};/);
});
