// src/outbox.ts: which reports start a turn, the idle hold, batching while busy, and `react: "none"`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyKind } from "../src/dispatcher.ts";
import { HOLD_MS, Outbox, type SendOptions } from "../src/outbox.ts";
import { reportContent, type ReportDetails } from "../src/render.ts";
import { REPORT_MESSAGE, type React } from "../src/types.ts";

const details = (ticketId: number, kind: NotifyKind): ReportDetails => ({
	ticketId, kind, state: kind === "merged" ? "merged" : kind === "dropped" ? "closed" : kind === "merge-handed" || kind === "merge-refused" ? "ready" : kind,
	title: `Ticket ${ticketId}`, branch: `pi/${ticketId}-t`, summary: `summary ${ticketId}`, at: 1,
});

function setup(react: React = "attention") {
	const sent: { message: { customType: string; content: string; display: boolean; details: unknown }; options: SendOptions }[] = [];
	const state = { idle: true, react };
	const outbox = new Outbox({ send: (message, options) => sent.push({ message, options }), isIdle: () => state.idle, react: () => state.react });
	return { outbox, sent, state };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("outbox", () => {
	it("starts a turn for an attention report after the idle hold, collecting what arrives meanwhile", () => {
		const { outbox, sent } = setup();
		outbox.push(details(1, "ready"));
		vi.advanceTimersByTime(HOLD_MS - 1);
		expect(sent).toEqual([]);
		outbox.push(details(2, "question"));
		vi.advanceTimersByTime(1);
		expect(HOLD_MS).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.options).toEqual({ triggerTurn: true });
		expect(sent[0]!.message).toEqual({
			customType: REPORT_MESSAGE, display: true,
			content: `${reportContent(details(1, "ready"))}\n\n${reportContent(details(2, "question"))}`,
			details: { batch: [details(1, "ready"), details(2, "question")] },
		});
		expect(sent[0]!.message.content.startsWith("#1 ready · Ticket 1")).toBe(true);
	});

	it("sends one report as plain details", () => {
		const { outbox, sent } = setup();
		outbox.push(details(3, "failed"));
		vi.advanceTimersByTime(HOLD_MS);
		expect(sent[0]!.message.details).toEqual(details(3, "failed"));
		expect(sent[0]!.message.content.split("\n")[0]).toBe("#3 failed · Ticket 3");
	});

	it("batches reports while busy until the next turn end and steers them in as one message", () => {
		const { outbox, sent, state } = setup();
		state.idle = false;
		outbox.push(details(1, "blocked"));
		outbox.push(details(2, "merge-refused"));
		vi.advanceTimersByTime(HOLD_MS * 5);
		expect(sent).toEqual([]);
		outbox.turnEnd();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect((sent[0]!.message.details as { batch: ReportDetails[] }).batch.map((item) => item.ticketId)).toEqual([1, 2]);
		outbox.turnEnd();
		expect(sent).toHaveLength(1);
	});

	it("delivers what is left after the run ends, after the hold", () => {
		const { outbox, sent, state } = setup();
		state.idle = false;
		outbox.push(details(1, "waiting"));
		state.idle = true;
		outbox.agentEnd();
		vi.advanceTimersByTime(HOLD_MS);
		expect(sent.map((item) => item.options)).toEqual([{ triggerTurn: true }]);
	});

	it("keeps held reports for the turn end when a run started during the hold", () => {
		const { outbox, sent, state } = setup();
		outbox.push(details(1, "ready"));
		state.idle = false;
		vi.advanceTimersByTime(HOLD_MS);
		expect(sent).toEqual([]);
		outbox.turnEnd();
		expect(sent.map((item) => item.options)).toEqual([{ triggerTurn: true, deliverAs: "steer" }]);
	});

	it("shows merged and dropped reports at once without a turn", () => {
		const { outbox, sent, state } = setup();
		outbox.push(details(1, "merged"));
		state.idle = false;
		outbox.push(details(2, "dropped"));
		expect(sent.map((item) => item.options)).toEqual([{ triggerTurn: false }, { triggerTurn: false, deliverAs: "followUp" }]);
		expect(outbox.pending).toEqual([]);
	});

	it("starts no turn with react none", () => {
		const { outbox, sent, state } = setup("none");
		for (const kind of ["question", "ready", "blocked", "failed", "waiting", "merge-handed", "merge-refused"] as const) outbox.push(details(1, kind));
		state.idle = false;
		outbox.push(details(2, "ready"));
		vi.advanceTimersByTime(HOLD_MS);
		outbox.turnEnd();
		expect(sent).toHaveLength(8);
		expect(sent.every((item) => item.options.triggerTurn === false)).toBe(true);
		expect(sent.at(-1)!.options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("drops everything on dispose and accepts reports again after reset", () => {
		const { outbox, sent } = setup();
		outbox.push(details(1, "ready"));
		outbox.dispose();
		vi.advanceTimersByTime(HOLD_MS);
		outbox.push(details(2, "ready"));
		expect(sent).toEqual([]);
		outbox.reset();
		outbox.push(details(3, "ready"));
		vi.advanceTimersByTime(HOLD_MS);
		expect(sent).toHaveLength(1);
	});
});
