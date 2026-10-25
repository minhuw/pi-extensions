import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTimeline } from "../src/session/timeline";
import {
	assistantMessage,
	entry,
	header,
	iso,
	summary,
	toolCall,
	toolResultMessage,
	turn,
	userMessage,
} from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function sessionFixture(): FakeSession {
	const entries = [
		entry(0, header("s1")),
		entry(1, { type: "model_change", id: "m0", parentId: null, timestamp: iso(500), provider: "anthropic", modelId: "claude-sonnet-4-5" }),
		entry(2, userMessage("Fix the **failing** test in `api.ts`")),
		entry(
			3,
			assistantMessage([
				{ type: "thinking", thinking: "The test probably fails because of the base path." },
				{ type: "text", text: "Let me run the tests first." },
				toolCall("call_a", "bash", { command: "npm test" }),
			]),
		),
		entry(4, toolResultMessage("call_a", "bash", "1 failed\n\nCommand exited with code 1", { isError: true })),
		entry(5, { type: "custom", id: "c1", parentId: null, timestamp: iso(3500), customType: "pika-state", data: { n: 1 } }),
		entry(6, assistantMessage([toolCall("call_b", "read", { path: "src/api.ts" })], 4000)),
		entry(7, toolResultMessage("call_b", "read", "export const base = '/';", { at: 4500 })),
		entry(8, {
			type: "compaction",
			id: "k1",
			parentId: null,
			timestamp: iso(4800),
			summary: "Earlier the user asked about base paths.",
			firstKeptEntryId: "x",
			tokensBefore: 50000,
		}),
		entry(9, assistantMessage([{ type: "text", text: "Fixed: the base path now ends without a slash." }], 5000)),
	];
	const detail = summary("s1", {
		title: "Fix the failing test",
		parentSessionId: "parent-1",
		link: { kind: "subagent", agentType: "worker", description: "Fix tests" },
		children: [{ ...summary("child-9", { parentSessionId: "s1" }), parentToolCallId: "call_x" }],
		childCount: 1,
	});
	return {
		detail,
		entries,
		turns: [
			turn(0, 2, 9, {
				userText: "Fix the **failing** test in `api.ts`",
				modelCalls: 3,
				toolCalls: 2,
				toolErrors: 1,
				durationMs: 134_000,
				cost: 0.31,
				finalText: "Fixed: the base path now ends without a slash.",
			}),
		],
	};
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("session view", () => {
	it("shows the title, properties, and a prompt card", async () => {
		const server = createFakeServer({ sessions: [sessionFixture()] });
		renderApp("/s/s1", server.fetch);
		expect(await screen.findByRole("heading", { name: "Fix the failing test" })).toBeTruthy();
		for (const label of ["Device", "Project", "Directory", "Started", "Duration", "Tokens", "Cost", "Models", "Parent"]) {
			expect(screen.getByText(label, { selector: "dt span" })).toBeTruthy();
		}
		expect(screen.getByRole("link", { name: "Parent session" }).getAttribute("href")).toBe("/s/parent-1");
		expect(await screen.findByText("failing", { selector: "strong" })).toBeTruthy();
		const strip = document.querySelector<HTMLElement>("[data-work-strip='0']")!;
		expect(strip.textContent).toContain("3 model calls · 2 tools · 2m 14s · $0.31");
		expect(within(strip).getByText("1 error")).toBeTruthy();
		expect(screen.getByText("Fixed: the base path now ends without a slash.", { selector: "[data-final-answer] p" })).toBeTruthy();
	});

	it("expands a turn into a timeline loaded from that turn's entries", async () => {
		const server = createFakeServer({ sessions: [sessionFixture()] });
		renderApp("/s/s1", server.fetch);
		const strip = await screen.findByRole("button", { name: /3 model calls/ });
		expect(strip.getAttribute("aria-expanded")).toBe("false");
		expect(server.calls.some((call) => call.includes("/entries"))).toBe(false);

		fireEvent.click(strip);
		await screen.findByText("Let me run the tests first.");
		expect(server.calls).toContain("/api/v1/sessions/s1/entries?from=2&to=9&limit=200");

		// The prompt itself is not repeated in the timeline.
		expect(document.querySelector('[data-entry-seq="2"]')).toBeNull();
		// Thinking is a collapsed toggle.
		const thinking = screen.getByRole("button", { name: /Thinking/ });
		expect(thinking.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText(/fails because of the base path/)).toBeNull();
		fireEvent.click(thinking);
		expect(screen.getByText(/fails because of the base path/)).toBeTruthy();

		// Tool calls are paired with results.
		const bash = document.querySelector<HTMLElement>('[data-tool="bash"]')!;
		expect(within(bash).getByText("npm test", { selector: "code" })).toBeTruthy();
		expect(within(bash).getByRole("alert").textContent).toContain("Exited with code 1");
		const read = document.querySelector<HTMLElement>('[data-tool="read"]')!;
		expect(within(read).getByText("export const base = '/';")).toBeTruthy();
		expect(document.querySelectorAll('[data-entry-seq="4"]').length).toBe(0);

		// Compaction is a callout with a summary toggle; custom entries stay hidden.
		expect(screen.getByText("Context compacted")).toBeTruthy();
		expect(screen.getByText("50k tokens summarized")).toBeTruthy();
		expect(screen.queryByText(/pika-state/)).toBeNull();
		fireEvent.click(screen.getByLabelText(/Show hidden entries/));
		expect(await screen.findByText(/custom · pika-state/)).toBeTruthy();

		// Collapsing hides the timeline again.
		fireEvent.click(screen.getByRole("button", { name: /3 model calls/ }));
		await waitFor(() => expect(screen.queryByText("Let me run the tests first.")).toBeNull());
	});

	it("moves between prompt cards with j and k", async () => {
		const fixture = sessionFixture();
		fixture.turns = [fixture.turns[0], turn(1, 10, 10), turn(2, 11, 11)];
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/s1", server.fetch);
		await screen.findByText("Prompt number 3");
		fireEvent.keyDown(window, { key: "j" });
		await waitFor(() => expect(document.querySelector("[data-turn][data-active]")?.getAttribute("data-turn")).toBe("0"));
		fireEvent.keyDown(window, { key: "j" });
		await waitFor(() => expect(document.querySelector("[data-turn][data-active]")?.getAttribute("data-turn")).toBe("1"));
		fireEvent.keyDown(window, { key: "k" });
		await waitFor(() => expect(document.querySelector("[data-turn][data-active]")?.getAttribute("data-turn")).toBe("0"));
	});

	it("shows a 404 page for an unknown session", async () => {
		const server = createFakeServer({ sessions: [] });
		renderApp("/s/nope", server.fetch);
		expect(await screen.findByText("This session doesn’t exist")).toBeTruthy();
	});

	it("shows an error callout when the session fails to load", async () => {
		const failing = (async () => new Response(JSON.stringify({ error: "database is locked" }), { status: 500 })) as typeof fetch;
		renderApp("/s/s1", failing);
		expect(await screen.findByText("database is locked", {}, { timeout: 4000 })).toBeTruthy();
	});

	it("renders unknown routes as 404", async () => {
		renderApp("/nowhere", createFakeServer({}).fetch);
		expect(await screen.findByText("This page doesn’t exist")).toBeTruthy();
	});
});

describe("buildTimeline", () => {
	it("pairs results with calls, skips the prompt, and marks hidden entries", () => {
		const items = buildTimeline(sessionFixture().entries, 2);
		const kinds = items.map((item) => `${item.kind}${item.hidden ? "(hidden)" : ""}`);
		expect(kinds).toEqual([
			"note",
			"model-call",
			"thinking",
			"text",
			"tool",
			"raw(hidden)",
			"model-call",
			"tool",
			"compaction",
			"model-call",
			"text",
		]);
		const bash = items.find((item) => item.kind === "tool");
		expect(bash?.kind === "tool" && bash.result?.isError).toBe(true);
	});
});
