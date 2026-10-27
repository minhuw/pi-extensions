import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildSession, SessionLink } from "../src/lib/types";
import { assistantMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function child(id: string, parent: string, toolCallId: string, link: Partial<SessionLink>, at = 0): ChildSession {
	return {
		...summary(id, { parentSessionId: parent, startedAt: iso(at), title: `Child ${id}` }),
		parentToolCallId: toolCallId,
		link: { kind: "subagent", parentSessionId: parent, parentToolCallId: toolCallId, ...link },
	};
}

/** A session with one prompt whose timeline spawns `calls`, plus the children it lists. */
function session(id: string, prompt: string, calls: ReturnType<typeof toolCall>[], children: ChildSession[]): FakeSession {
	const entries = [entry(0, header(id)), entry(1, userMessage(prompt))];
	let seq = 2;
	for (const call of calls) {
		entries.push(entry(seq++, assistantMessage([call])));
		entries.push(entry(seq++, toolResultMessage(call.id, call.name, `${call.name} finished`)));
	}
	entries.push(entry(seq, assistantMessage([{ type: "text", text: `${id} done` }])));
	return {
		detail: summary(id, { childCount: children.length, children }),
		entries,
		turns: [turn(0, 1, seq, { userText: prompt, modelCalls: calls.length + 1, toolCalls: calls.length, finalText: `${id} done` })],
	};
}

function fixture() {
	const worker = child("c1", "p1", "call_agent", { agentType: "worker", description: "Fix tests", agentId: "a1" }, 1000);
	const nested = child("c1n", "c1", "call_nested", { agentType: "recon", description: "Look around", parentAgentId: "a1" }, 2000);
	const reviewA = child("w1", "p1", "call_wf", { agentType: "reviewer", description: "Review A", workflowId: "wf-1" }, 3000);
	const reviewB = child("w2", "p1", "call_wf", { agentType: "reviewer", description: "Review B", workflowId: "wf-1" }, 4000);
	const parent = session(
		"p1",
		"Ship the feature",
		[
			toolCall("call_agent", "Agent", { subagent_type: "worker", description: "Fix tests", prompt: "Fix the tests." }),
			toolCall("call_wf", "SubagentWorkflow", { name: "review-fanout", script: "await Promise.all([agent('a'), agent('b')])" }),
		],
		[worker, reviewA, reviewB],
	);
	const c1 = session("c1", "Child prompt for c1", [toolCall("call_nested", "Agent", { subagent_type: "recon", description: "Look around" })], [nested]);
	c1.detail = { ...c1.detail, parentSessionId: "p1", link: worker.link };
	const c1n = session("c1n", "Nested prompt for c1n", [], []);
	const w1 = session("w1", "Review prompt A", [], []);
	const w2 = session("w2", "Review prompt B", [], []);
	return [parent, c1, c1n, w1, w2];
}

/** Transcript tool rows start collapsed; opens the first closed one of `id` under `root`. */
async function openTool(id: string, root: ParentNode = document) {
	const row = await waitFor(() => {
		const node = root.querySelector<HTMLElement>(`[data-tool="${id}"] > button[aria-expanded="false"]`);
		if (!node) throw new Error(`no closed ${id} tool`);
		return node;
	});
	fireEvent.click(row);
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("inline subagents", () => {
	it("lists the children in the Subagents tile", async () => {
		renderApp("/s/p1", createFakeServer({ sessions: fixture() }).fetch);
		const tile = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-kpi='subagents']");
			if (!node) throw new Error("no tile");
			return node;
		});
		expect(tile.querySelector("[data-kpi-value]")?.textContent).toBe("3");
		const list = tile.querySelector<HTMLElement>("[data-subagents]")!;
		expect([...list.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/s/c1"]);
		fireEvent.click(within(list).getByRole("button", { name: "+2" }));
		expect([...list.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/s/c1", "/s/c1", "/s/w1", "/s/w2"]);
		expect(within(list).getByText("Fix tests")).toBeTruthy();
		expect(within(list).getAllByText("reviewer")).toHaveLength(2);
	});

	it("expands an Agent call into its child session, lazily and recursively", async () => {
		const server = createFakeServer({ sessions: fixture() });
		renderApp("/s/p1?view=transcript", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: /3 model calls/ }));
		await openTool("agent");
		const card = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-agent-card]");
			if (!node) throw new Error("no agent card");
			return node;
		});
		expect(server.calls.some((call) => call.startsWith("/api/v1/sessions/c1"))).toBe(false);

		const toggle = within(card).getByRole("button", { name: /Subagent session/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		const inline = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-inline-session='c1']");
			if (!node) throw new Error("no inline session");
			return node;
		});
		expect(await within(inline).findByText("Child prompt for c1")).toBeTruthy();
		expect(within(inline).getByText("worker")).toBeTruthy();
		expect(within(inline).getAllByRole("link", { name: /Open as page/ })[0].getAttribute("href")).toBe("/s/c1");
		expect(server.calls).toContain("/api/v1/sessions/c1");
		expect(server.calls).toContain("/api/v1/sessions/c1/turns?limit=100");
		// The child's entries load only when its turn is expanded.
		expect(server.calls.some((call) => call.startsWith("/api/v1/sessions/c1/entries"))).toBe(false);

		fireEvent.click(within(inline).getByRole("button", { name: /2 model calls/ }));
		expect(await within(inline).findByText("c1 done", { selector: "[data-entry-seq] p" })).toBeTruthy();
		await openTool("agent", inline);
		const nestedCard = inline.querySelector<HTMLElement>("[data-agent-card]")!;
		expect(within(nestedCard).getByText("Look around")).toBeTruthy();
		fireEvent.click(within(nestedCard).getByRole("button", { name: /Subagent session/ }));
		const nested = await waitFor(() => {
			const node = inline.querySelector<HTMLElement>("[data-inline-session='c1n']");
			if (!node) throw new Error("no nested session");
			return node;
		});
		expect(await within(nested).findByText("Nested prompt for c1n")).toBeTruthy();
		expect(within(nested).getByText("recon")).toBeTruthy();
	});

	it("groups workflow children under their workflow call", async () => {
		renderApp("/s/p1?view=transcript", createFakeServer({ sessions: fixture() }).fetch);
		fireEvent.click(await screen.findByRole("button", { name: /3 model calls/ }));
		await openTool("workflow");
		const card = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-workflow-card]");
			if (!node) throw new Error("no workflow card");
			return node;
		});
		expect(within(card).getByText("review-fanout")).toBeTruthy();
		expect(within(card).getByText("2 agents")).toBeTruthy();
		const group = card.querySelector<HTMLElement>("[data-workflow-group='wf-1']")!;
		expect([...group.querySelectorAll("[data-inline-toggle]")].map((node) => node.getAttribute("data-inline-toggle"))).toEqual(["w1", "w2"]);

		fireEvent.click(within(group).getByRole("button", { name: /Review B/ }));
		const inline = await waitFor(() => {
			const node = group.querySelector<HTMLElement>("[data-inline-session='w2']");
			if (!node) throw new Error("no inline workflow child");
			return node;
		});
		expect(await within(inline).findByText("Review prompt B")).toBeTruthy();
		expect(group.querySelector("[data-inline-session='w1']")).toBeNull();
	});
});
