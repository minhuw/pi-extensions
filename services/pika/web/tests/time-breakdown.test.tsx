import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionTrace, TraceRecord } from "../src/lib/types";
import { BREAKDOWN_OPEN_KEY, TimeBreakdown } from "../src/trace/TimeBreakdown";
import { renderWithApi } from "./support/render";

const T = 1_000_000;

/** A GPT call, then fourteen MCP tools of a tracker, each 100 ms shorter than the last. */
function trace(): SessionTrace {
	const records: TraceRecord[] = [{ kind: "llm", seq: 1, turn: 0, start: T, end: T + 4000, model: "gpt-6-astra", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }];
	for (let i = 0; i < 14; i++) {
		records.push({ kind: "tool", seq: 2 + i, turn: 0, callId: `c${i}`, name: `mcp__tracker__step_${i}`, start: T + 4000, end: T + 4000 + (14 - i) * 100, isError: false });
	}
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const turn = { index: 0, startSeq: 1, endSeq: 15, at: T, durationMs: 6000, userText: "", modelCalls: 1, toolCalls: 14, toolErrors: 0, cost: 0, tokens };
	return { sessionId: "s1", startedAt: T, lastAt: T + 6000, turns: [turn], records, children: [] };
}

describe("time breakdown details", () => {
	it("draws each kind as a line with its models and tools as stations, longest first, filled by their share", () => {
		localStorage.setItem(BREAKDOWN_OPEN_KEY, "open");
		renderWithApi(<TimeBreakdown trace={trace()} live={false} />, (async () => new Response("{}")) as typeof fetch);
		const stations = (region: HTMLElement) => [...region.querySelectorAll<HTMLElement>("[data-breakdown-item]")];

		const model = screen.getByRole("region", { name: "Model call" });
		const [gpt] = stations(model);
		expect(gpt.querySelector("[data-model-mark]")?.getAttribute("data-model-mark")).toBe("openai");
		expect(gpt.dataset.share).toBe("100");
		expect(within(model).getByRole("list", { name: "Model call by model" })).toBeTruthy();

		// Twelve stations, then a button for the rest. The tracker's tools take 10.5 s, the first 1.4 s of it; with the
		// GPT call's 4 s and 0.6 s between calls, the whole breakdown is 15.1 s.
		const tools = screen.getByRole("region", { name: "Other tool" });
		expect(stations(tools).map((station) => station.dataset.breakdownItem)).toEqual(Array.from({ length: 12 }, (_, i) => `mcp__tracker__step_${i}`));
		expect(stations(tools)[0].textContent).toContain("tracker · step_0");
		expect(stations(tools)[0].textContent).toContain("1.4s");
		expect(stations(tools)[0].dataset.share).toBe("13.3");
		expect(stations(tools)[0].getAttribute("title")).toBe("tracker · step_0: 1.4s in 1 call, 13% of Other tool, 9% of all");
		const more = within(tools).getByRole("button", { name: "2 more" });
		expect(more.getAttribute("title")).toBe("300ms in all");
		fireEvent.click(more);
		expect(stations(tools)).toHaveLength(14);
		expect(within(tools).queryByRole("button", { name: /more/ })).toBeNull();
	});
});
