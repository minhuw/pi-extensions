// Fixtures and queries shared by the trajectory view's tests.
import { fireEvent } from "@testing-library/react";
import type { Entry, Turn } from "../../src/lib/types";
import { assistantMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./fixtures";
import type { FakeSession } from "./server";

/** One turn with a model call per family of tool, an error, and a captured request. */
export function session(): FakeSession {
	const entries: Entry[] = [
		entry(0, header("t1")),
		entry(1, userMessage("Fix the **flaky** test")),
		{
			...entry(
				2,
				assistantMessage([{ type: "thinking", thinking: "Run it." }, toolCall("c_bash", "bash", { command: "npm test\n--watch=false" })], 2000, {
					durationMs: 1500,
				}),
			),
			requestId: "r1",
		},
		entry(3, toolResultMessage("c_bash", "bash", "1 failed\n\nCommand exited with code 1", { isError: true, at: 6000 })),
		entry(4, assistantMessage([toolCall("c_read", "read", { path: "src/api.ts" }), toolCall("c_grep", "grep", { pattern: "retry", path: "src" })], 7000)),
		entry(5, toolResultMessage("c_read", "read", "export const base = '/';", { at: 7100 })),
		entry(6, toolResultMessage("c_grep", "grep", "src/api.ts:3", { at: 7200 })),
		entry(7, assistantMessage([toolCall("c_edit", "edit", { path: "src/api.ts", oldText: "a\nb", newText: "a\nc\nd" })], 8000)),
		entry(8, toolResultMessage("c_edit", "edit", "Successfully replaced 1 block(s).", { at: 8050 })),
		entry(9, assistantMessage([{ type: "text", text: "Fixed the retry count." }], 9000)),
		entry(10, userMessage("Thanks", 70_000)),
		entry(11, assistantMessage([{ type: "text", text: "You're welcome." }], 71_000)),
	];
	return {
		detail: summary("t1", { title: "Fix the flaky test", entryCount: entries.length }),
		entries,
		turns: [
			turn(0, 1, 9, { userText: "Fix the **flaky** test", at: iso(1000), durationMs: 8000, modelCalls: 4, toolCalls: 4, toolErrors: 1 }),
			turn(1, 10, 11, { userText: "Thanks", at: iso(70_000), durationMs: 1000, modelCalls: 1, toolCalls: 0 }),
		],
	};
}

/** `count` one-call turns ten seconds apart: more than 40, so only the last three start expanded. */
export function manyTurns(id: string, count = 45, extra: Partial<FakeSession["detail"]> = {}): FakeSession {
	const entries: Entry[] = [entry(0, header(id))];
	const turns: Turn[] = [];
	for (let i = 0; i < count; i++) {
		const seq = 1 + i * 2;
		entries.push(entry(seq, userMessage(`Question ${i}`, i * 10_000)), entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }], i * 10_000 + 2000)));
		turns.push(turn(i, seq, seq + 1, { userText: `Question ${i}`, at: iso(i * 10_000), durationMs: 2000 }));
	}
	return { detail: summary(id, { entryCount: entries.length, ...extra }), entries, turns };
}

export function rows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("[data-ledger-row]")];
}

export function row(selector: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(`[data-ledger-row]${selector}`);
	if (!node) throw new Error(`no ledger row ${selector}`);
	return node;
}

export function selected(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-ledger-row][aria-selected='true']");
}

export function slideOver(): HTMLElement | null {
	return document.querySelector<HTMLElement>("aside[aria-label='Inspector']");
}

export function inspector(): HTMLElement {
	return document.querySelector<HTMLElement>("[data-inspector]")!;
}

export function entryCalls(calls: string[]): string[] {
	return calls.filter((call) => call.includes("/entries"));
}

export const key = (name: string) => fireEvent.keyDown(window, { key: name });

