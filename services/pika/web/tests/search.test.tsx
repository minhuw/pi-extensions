import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSnippet } from "../src/lib/snippet";
import type { Entry, SearchHit, Turn } from "../src/lib/types";
import { groupHits, Snippet } from "../src/pages/Search";
import { assistantMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function hit(sessionId: string, seq: number, kind: SearchHit["kind"], snippet: string, sessionTitle = `Session ${sessionId}`): SearchHit {
	return { sessionId, sessionTitle, seq, entryId: `e${seq}`, kind, snippet, at: iso(seq * 1000) };
}

function sessions(): FakeSession[] {
	const s1: FakeSession = {
		detail: summary("s1", { title: "Fix the base path" }),
		entries: [
			entry(0, header("s1")),
			entry(1, userMessage("Fix the base path")),
			entry(2, assistantMessage([toolCall("call_a", "bash", { command: "grep -rn base src" })])),
			entry(3, toolResultMessage("call_a", "bash", "src/api.ts: base = '/'")),
			entry(4, assistantMessage([{ type: "text", text: "The base path now ends without a slash." }], 5000)),
		],
		turns: [turn(0, 1, 4, { userText: "Fix the base path", modelCalls: 2, toolCalls: 1 })],
	};
	const s2: FakeSession = {
		detail: summary("s2", { title: "Rename the base div", device: "laptop", project: "site", cwd: "/home/me/site" }),
		entries: [entry(0, header("s2")), entry(1, userMessage("rename the base <div>"))],
		turns: [turn(0, 1, 1, { userText: "rename the base <div>" })],
	};
	return [s1, s2];
}

const HITS = [
	hit("s1", 4, "assistant", "The <mark>base</mark> path now ends without a slash.", "Fix the base path"),
	hit("s2", 1, "user", "rename the <mark>base</mark> &lt;div&gt;", "Rename the base div"),
	hit("s1", 3, "tool-result", "src/api.ts: <mark>base</mark> = &#39;/&#39;", "Fix the base path"),
];

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("search snippets", () => {
	it("parses marks and entities into text segments", () => {
		expect(parseSnippet("a &lt;b&gt; &amp; <mark>c&#39;s</mark> d")).toEqual([
			{ text: "a <b> & ", mark: false },
			{ text: "c's", mark: true },
			{ text: " d", mark: false },
		]);
	});

	it("never turns snippet markup other than <mark> into elements", () => {
		const snippet = '<img src=x onerror="alert(1)"><mark>hit</mark> &lt;script&gt;alert(2)&lt;/script&gt;<b>bold</b>';
		expect(parseSnippet(snippet)).toEqual([
			{ text: '<img src=x onerror="alert(1)">', mark: false },
			{ text: "hit", mark: true },
			{ text: " <script>alert(2)</script><b>bold</b>", mark: false },
		]);
		const { container } = render(<Snippet text={snippet} />);
		expect(container.querySelector("img, script, b")).toBeNull();
		expect(container.querySelectorAll("mark")).toHaveLength(1);
		expect(container.textContent).toBe('<img src=x onerror="alert(1)">hit <script>alert(2)</script><b>bold</b>');
	});

	it("groups hits by session in first-appearance order", () => {
		expect(groupHits(HITS).map((group) => [group.sessionId, group.hits.map((item) => item.seq)])).toEqual([
			["s1", [4, 3]],
			["s2", [1]],
		]);
	});
});

describe("search page", () => {
	it("shows results grouped by session with kind icons and safe snippets", async () => {
		renderApp("/search?q=base", createFakeServer({ sessions: sessions(), hits: HITS }).fetch);
		await screen.findAllByText("base", { selector: "mark" });
		const groups = [...document.querySelectorAll<HTMLElement>("[data-result-group]")];
		expect(groups.map((group) => group.getAttribute("data-result-group"))).toEqual(["s1", "s2"]);
		expect([...groups[0].querySelectorAll("[data-hit]")].map((node) => [node.getAttribute("data-kind"), node.getAttribute("href")])).toEqual([
			["assistant", "/s/s1?seq=4"],
			["tool-result", "/s/s1?seq=3"],
		]);
		expect(within(groups[0]).getByText("Tool result")).toBeTruthy();
		const s2 = groups[1].querySelector("[data-snippet]")!;
		expect(s2.textContent).toBe("rename the base <div>");
		expect(s2.querySelector("div")).toBeNull();
	});

	it("debounces typing into the query and focuses the input with /", async () => {
		const server = createFakeServer({ sessions: sessions(), hits: HITS });
		renderApp("/search", server.fetch);
		const input = await screen.findByRole("searchbox", { name: "Search" });
		fireEvent.change(input, { target: { value: "sla" } });
		fireEvent.change(input, { target: { value: "slash" } });
		expect(server.calls.some((call) => call.includes("/search?"))).toBe(false);
		await waitFor(() => expect(server.calls.filter((call) => call.includes("/search?"))).toEqual(["/api/v1/search?q=slash&limit=50"]));
		expect(await screen.findByText("slash.", { exact: false, selector: "[data-snippet] span" })).toBeTruthy();

		input.blur();
		expect(document.activeElement).not.toBe(input);
		fireEvent.keyDown(window, { key: "/" });
		expect(document.activeElement).toBe(input);
	});

	it("filters by device and project", async () => {
		const server = createFakeServer({ sessions: sessions(), hits: HITS });
		renderApp("/search?q=base", server.fetch);
		await screen.findAllByText("base", { selector: "mark" });
		fireEvent.click(screen.getByRole("button", { name: /Device/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "laptop" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&device=laptop&limit=50"));
		await waitFor(() => expect(document.querySelectorAll("[data-result-group]")).toHaveLength(1));
		expect(document.querySelector("[data-result-group]")?.getAttribute("data-result-group")).toBe("s2");

		fireEvent.click(screen.getByRole("button", { name: /Project/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "pika" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&device=laptop&project=pika&limit=50"));
		expect(await screen.findByText("No results")).toBeTruthy();
	});

	it("opens a result at its entry: expands the turn and highlights the entry", async () => {
		renderApp("/search?q=base", createFakeServer({ sessions: sessions(), hits: HITS }).fetch);
		const link = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-hit='3']");
			if (!node) throw new Error("no hit");
			return node;
		});
		fireEvent.click(link);
		expect(await screen.findByRole("heading", { name: "Fix the base path" })).toBeTruthy();
		// The tool result at seq 3 is shown with its call at seq 2.
		await waitFor(() => expect(document.querySelector("[data-entry-seq='2'][data-highlighted]")).toBeTruthy());
		expect(screen.getByRole("button", { name: /2 model calls/ }).getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelectorAll("[data-highlighted]")).toHaveLength(1);
	});

	it("loads more turns to reach a deep-linked entry", async () => {
		restore();
		restore = mockLayout({ viewport: 800, rowHeight: 80 });
		const entries: Entry[] = [entry(0, header("long"))];
		const turns: Turn[] = [];
		for (let i = 0; i < 150; i++) {
			const seq = 1 + i * 2;
			entries.push(entry(seq, userMessage(`Question ${i}`)));
			entries.push(entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }])));
			turns.push(turn(i, seq, seq + 1, { userText: `Question ${i}`, finalText: `Final ${i}` }));
		}
		const server = createFakeServer({ sessions: [{ detail: summary("long", { entryCount: entries.length }), entries, turns }] });
		const target = 1 + 120 * 2 + 1;
		renderApp(`/s/long?seq=${target}`, server.fetch);
		await waitFor(() => expect(document.querySelector(`[data-entry-seq='${target}'][data-highlighted]`)).toBeTruthy());
		expect(server.calls).toContain("/api/v1/sessions/long/turns?cursor=100&limit=100");
		expect(server.calls).toContain(`/api/v1/sessions/long/entries?from=${target - 1}&to=${target}&limit=200`);
		expect(screen.getByText(`Answer 120`)).toBeTruthy();
		expect(screen.queryByText("Question 0")).toBeNull();
	});
});
