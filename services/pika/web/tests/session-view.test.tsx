import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTimeline } from "../src/session/timeline";
import {
	assistantMessage,
	customMessage,
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
	it("labels turns started by a relay message or another extension instead of calling them prompts", async () => {
		const relayText = "[relay] Message from Planner on mini: please rebase onto main.";
		const session: FakeSession = {
			detail: summary("s1", { title: "Mixed turns" }),
			entries: [
				entry(0, header("s1")),
				entry(1, userMessage("Fix the parser")),
				entry(2, customMessage("relay-message", relayText, 2000)),
				entry(3, customMessage("herder:prompt", "/herder: run started", 3000)),
			],
			turns: [
				turn(0, 1, 1, { userText: "Fix the parser" }),
				turn(1, 2, 2, { userText: relayText, customType: "relay-message" }),
				turn(2, 3, 3, { userText: "/herder: run started", customType: "herder:prompt" }),
			],
		};
		renderApp("/s/s1?view=transcript", createFakeServer({ sessions: [session] }).fetch);
		await screen.findByRole("heading", { name: "Mixed turns" });
		const head = (index: number) => document.querySelector<HTMLElement>(`[data-turn="${index}"]`)!;
		await waitFor(() => expect(head(2)).toBeTruthy());
		const label = (index: number) => head(index).querySelector<HTMLElement>("[data-turn-start]")!;
		expect(label(0).textContent).toBe("Prompt 1");
		expect(label(0).dataset.turnStart).toBe("prompt");
		expect(label(1).textContent).toBe("Relay message");
		expect(label(1).dataset.turnStart).toBe("relay-message");
		expect(label(2).textContent).toBe("Extension message");
		expect(label(2).getAttribute("title")).toBe("herder:prompt");
		// The text is unchanged.
		expect(within(head(1)).getByText(relayText)).toBeTruthy();
		// The icon is the message icon, not the person icon user prompts get.
		const icon = (index: number) => label(index).previousElementSibling?.outerHTML;
		expect(icon(1)).toBe(icon(2));
		expect(icon(1)).not.toBe(icon(0));
	});

	it("shows the title, chips, and key numbers instead of a property table", async () => {
		const server = createFakeServer({ sessions: [sessionFixture()] });
		renderApp("/s/s1", server.fetch);
		const heading = await screen.findByRole("heading", { name: "Fix the failing test", level: 1 });
		expect(heading.getAttribute("title")).toBe("Fix the failing test");
		expect(heading.classList).toContain("line-clamp-2");
		expect(document.querySelector("dl dt")).toBeNull();
		const chips = document.querySelector<HTMLElement>("[data-session-chips]")!;
		expect(chips.textContent).toContain("mini");
		expect(chips.textContent).toContain("pika");
		expect(chips.querySelector("[data-cwd]")?.getAttribute("title")).toBe("/home/me/code/pika");
		expect(chips.textContent).toContain("10m");
		expect(chips.textContent).toContain("claude-sonnet-4-5");
		expect(within(chips).getByRole("link", { name: /Parent session/ }).getAttribute("href")).toBe("/s/parent-1");
		const kpi = (name: string) => document.querySelector<HTMLElement>(`[data-kpi="${name}"] [data-kpi-value]`)?.textContent;
		await waitFor(() => expect(kpi("turns")).toBe("1"));
		expect(kpi("llm")).toBe("3");
		expect(kpi("tools")).toBe("2");
		expect(document.querySelector("[data-kpi='tools'] [data-kpi-errors]")?.textContent).toBe("1 error");
		expect(kpi("tokens")).toBe("96.4k");
		expect(kpi("cost")).toBe("$0.31");
		expect(kpi("subagents")).toBe("1");
		expect(kpi("context")).toBe("9.2k");
		expect(screen.getByRole("link", { name: "Export JSONL" }).getAttribute("href")).toBe("/api/v1/sessions/s1/export");
	});

	it("shows a prompt card with its work strip and final answer in the transcript", async () => {
		const server = createFakeServer({ sessions: [sessionFixture()] });
		renderApp("/s/s1?view=transcript", server.fetch);
		expect(await screen.findByText("failing", { selector: "strong" })).toBeTruthy();
		const strip = document.querySelector<HTMLElement>("[data-work-strip='0']")!;
		expect(strip.textContent).toContain("3 model calls · 2 tools · 2m 14s · $0.31");
		expect(within(strip).getByText("1 error")).toBeTruthy();
		expect(screen.getByText("Fixed: the base path now ends without a slash.", { selector: "[data-final-answer] p" })).toBeTruthy();
	});

	it("shows the device's name, else its id", async () => {
		const named = sessionFixture();
		named.detail = { ...named.detail, device: "4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a", deviceName: "Studio Mac" };
		const first = renderApp("/s/s1", createFakeServer({ sessions: [named] }).fetch);
		const device = () => document.querySelector<HTMLElement>("[data-device-chip]")!;
		await screen.findByRole("heading", { name: "Fix the failing test" });
		expect(device().textContent).toBe("Studio Mac");
		first.unmount();

		const unnamed = sessionFixture();
		unnamed.detail = { ...unnamed.detail, device: "mini", deviceName: undefined };
		renderApp("/s/s1", createFakeServer({ sessions: [unnamed] }).fetch);
		await screen.findByRole("heading", { name: "Fix the failing test" });
		expect(device().textContent).toBe("mini");
	});

	it("expands a turn into a timeline loaded from that turn's entries", async () => {
		const server = createFakeServer({ sessions: [sessionFixture()] });
		renderApp("/s/s1?view=transcript", server.fetch);
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

		// Tool calls are paired with results; they are one-line rows, and only failed ones start open.
		const bash = document.querySelector<HTMLElement>('[data-tool="bash"]')!;
		expect(within(bash).getByText("BASH")).toBeTruthy();
		// The command's code block; highlighting, which loads on demand, may split it into spans.
		expect([...bash.querySelectorAll("code")].some((code) => code.textContent?.includes("npm test"))).toBe(true);
		expect(within(bash).getByRole("alert").textContent).toContain("Exited with code 1");
		const read = document.querySelector<HTMLElement>('[data-tool="read"]')!;
		const row = within(read).getByRole("button", { expanded: false });
		expect(row.textContent).toContain("READ");
		expect(row.textContent).toContain("src/api.ts");
		expect(within(read).queryByText("export const base = '/';")).toBeNull();
		fireEvent.click(row);
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
		renderApp("/s/s1?view=transcript", server.fetch);
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

	it("skips a displayed extension message that is the turn's prompt", () => {
		const prompt = { type: "custom_message", id: "c1", parentId: null, timestamp: iso(1000), customType: "herder:prompt", content: "/herder: run started", display: true };
		const later = { ...prompt, id: "c2", content: "follow-up" };
		const items = buildTimeline([entry(1, prompt), entry(2, later)], 1);
		expect(items.map((item) => `${item.kind}:${item.seq}`)).toEqual(["custom-message:2"]);
	});
});
