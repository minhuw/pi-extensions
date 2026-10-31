import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSnippet } from "../src/lib/snippet";
import type { Entry, SearchHit, Turn } from "../src/lib/types";
import { SEARCH_DEBOUNCE_MS, SESSION_LIMIT, Snippet } from "../src/pages/Search";
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
});

describe("search page", () => {
	it("shows results grouped by session with kind icons and safe snippets", async () => {
		renderApp("/search?q=base", createFakeServer({ sessions: sessions(), hits: HITS }).fetch);
		await screen.findAllByText("base", { selector: "mark" });
		const groups = [...document.querySelectorAll<HTMLElement>("[data-result-group]")];
		expect(groups.map((group) => group.getAttribute("data-result-group"))).toEqual(["s1", "s2"]);
		expect(within(groups[0]).getByText("Fix the base path", { selector: "span" })).toBeTruthy();
		expect([...groups[0].querySelectorAll("[data-hit]")].map((node) => [node.getAttribute("data-kind"), node.getAttribute("href")])).toEqual([
			["assistant", "/s/s1?seq=4"],
			["tool-result", "/s/s1?seq=3"],
		]);
		expect(within(groups[0]).getByText("Tool result")).toBeTruthy();
		const s2 = groups[1].querySelector("[data-snippet]")!;
		expect(s2.textContent).toBe("rename the base <div>");
		expect(s2.querySelector("div")).toBeNull();
	});

	it("shows each session's match count, keeps a trailing space, and says when sessions were left out", async () => {
		const many = Array.from({ length: SESSION_LIMIT + 1 }, (_, i) => hit(`m${i}`, 1, "user", `<mark>base</mark> ${i}`));
		const server = createFakeServer({ sessions: sessions(), hits: [...HITS, ...many] });
		renderApp("/search?q=base+", server.fetch);
		await screen.findAllByText("base", { selector: "mark" });
		expect(server.calls).toContain("/api/v1/search?q=base+&group=session&prefix=true&limit=20");
		const groups = [...document.querySelectorAll<HTMLElement>("[data-result-group]")];
		expect(groups).toHaveLength(SESSION_LIMIT);
		expect(groups.slice(0, 2).map((group) => group.querySelector("[data-matches]")?.textContent)).toEqual(["2 matches", "1 match"]);
		expect(screen.getByText(/Showing the 20 most recent sessions/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "More results" })).toBeNull();
	});

	it("labels the device filter by name and searches by id", async () => {
		const list = sessions();
		list[1].detail = { ...list[1].detail, device: "4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a", deviceName: "Studio Mac" };
		const server = createFakeServer({ sessions: list, hits: HITS });
		renderApp("/search?q=base", server.fetch);
		await screen.findAllByText("base", { selector: "mark" });
		fireEvent.click(screen.getByRole("button", { name: /^Device/ }));
		expect((await screen.findAllByRole("menuitemradio")).map((option) => option.textContent)).toEqual(["✓Any device", "mini", "Studio Mac"]);
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Studio Mac" }));
		expect(await screen.findByRole("button", { name: "Device: Studio Mac" })).toBeTruthy();
		await waitFor(() =>
			expect(server.calls).toContain("/api/v1/search?q=base&device=4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a&group=session&prefix=true&limit=20"),
		);
		await waitFor(() => expect([...document.querySelectorAll("[data-result-group]")].map((g) => g.getAttribute("data-result-group"))).toEqual(["s2"]));
	});

	it("debounces typing into the query and focuses the input with /", async () => {
		const server = createFakeServer({ sessions: sessions(), hits: HITS });
		renderApp("/search", server.fetch);
		const input = await screen.findByRole("searchbox", { name: "Search" });
		fireEvent.change(input, { target: { value: "sla" } });
		fireEvent.change(input, { target: { value: "slash" } });
		expect(server.calls.some((call) => call.includes("/search?"))).toBe(false);
		await waitFor(() => expect(server.calls.filter((call) => call.includes("/search?"))).toEqual(["/api/v1/search?q=slash&group=session&prefix=true&limit=20"]));
		expect(await screen.findByText("slash.", { exact: false, selector: "[data-snippet] span" })).toBeTruthy();

		input.blur();
		expect(document.activeElement).not.toBe(input);
		fireEvent.keyDown(window, { key: "/" });
		expect(document.activeElement).toBe(input);
	});

	it("focuses the input with / after opening search from the band, keeping the filters", async () => {
		const server = createFakeServer({ sessions: sessions(), hits: HITS });
		renderApp("/", server.fetch);
		await screen.findByText("Fix the base path");
		fireEvent.click(screen.getByRole("link", { name: "Search" }));
		const input = await screen.findByRole("searchbox", { name: "Search" });
		fireEvent.change(input, { target: { value: "base" } });
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&group=session&prefix=true&limit=20"));
		fireEvent.click(screen.getByRole("button", { name: /Device/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "laptop" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&device=laptop&group=session&prefix=true&limit=20"));
		const searches = () => server.calls.filter((call) => call.includes("/search?"));
		const before = searches().length;

		input.blur();
		fireEvent.keyDown(window, { key: "/" });
		expect(document.activeElement).toBe(input);
		await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS * 2));
		expect(searches()).toHaveLength(before);
		expect(screen.getByRole("button", { name: /Device/ }).textContent).toContain("laptop");
		expect(input).toHaveProperty("value", "base");

		// Opening search again from the band starts over instead of restoring the old query.
		fireEvent.click(screen.getByRole("link", { name: "Search" }));
		await waitFor(() => expect(input).toHaveProperty("value", ""));
		await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS * 2));
		expect(searches()).toHaveLength(before);
		expect(await screen.findByText("Search every session")).toBeTruthy();
	});

	it("filters by device and project", async () => {
		const server = createFakeServer({ sessions: sessions(), hits: HITS });
		renderApp("/search?q=base", server.fetch);
		await screen.findAllByText("base", { selector: "mark" });
		fireEvent.click(screen.getByRole("button", { name: /Device/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "laptop" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&device=laptop&group=session&prefix=true&limit=20"));
		await waitFor(() => expect(document.querySelectorAll("[data-result-group]")).toHaveLength(1));
		expect(document.querySelector("[data-result-group]")?.getAttribute("data-result-group")).toBe("s2");

		fireEvent.click(screen.getByRole("button", { name: /Project/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "pika" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/search?q=base&device=laptop&project=pika&group=session&prefix=true&limit=20"));
		expect(await screen.findByText("No results")).toBeTruthy();
	});

	it("opens a result at its record: selects, highlights, and inspects the tool call", async () => {
		renderApp("/search?q=base", createFakeServer({ sessions: sessions(), hits: HITS }).fetch);
		const link = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-hit='3']");
			if (!node) throw new Error("no hit");
			return node;
		});
		fireEvent.click(link);
		expect(await screen.findByRole("heading", { name: "Fix the base path" })).toBeTruthy();
		// The tool result at seq 3 belongs to the bash call made at seq 2.
		await waitFor(() => expect(document.querySelector("[data-ledger-row][data-seq='2'][data-kind='shell'][data-highlighted]")).toBeTruthy());
		expect(document.querySelectorAll("[data-highlighted]")).toHaveLength(1);
		const row = document.querySelector<HTMLElement>("[data-ledger-row][data-highlighted]")!;
		expect(row.getAttribute("aria-selected")).toBe("true");
		expect(row.textContent).toContain("grep -rn base src");
		expect(document.querySelector("[data-inspector]")?.textContent).toContain("grep -rn base src");
	});

	it("opens a result at its entry in the transcript: expands the turn and highlights the entry", async () => {
		localStorage.setItem("pika-session-view", "transcript");
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
		renderApp(`/s/long?view=transcript&seq=${target}`, server.fetch);
		await waitFor(() => expect(document.querySelector(`[data-entry-seq='${target}'][data-highlighted]`)).toBeTruthy());
		expect(server.calls).toContain("/api/v1/sessions/long/turns?cursor=100&limit=100");
		expect(server.calls).toContain(`/api/v1/sessions/long/entries?from=${target - 1}&to=${target}&limit=200`);
		expect(screen.getByText(`Answer 120`)).toBeTruthy();
		expect(screen.queryByText("Question 0")).toBeNull();
	});
});

describe("public search", () => {
	/** Only the public namespace reaches the fixture's data; anything else is recorded and refused. */
	function publicServer() {
		const source = createFakeServer({ sessions: sessions(), hits: HITS });
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push(url);
			if (url.startsWith("/api/public/v1/")) return source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
			if (url === "/api/health") return source.fetch(input, init);
			return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
		};
		return { fetch: fetchImpl, calls };
	}

	it("searches published trajectories anonymously and keeps their links public", async () => {
		const server = publicServer();
		renderApp("/public/search?q=base", server.fetch);
		await screen.findAllByText("base", { selector: "mark" });
		const groups = [...document.querySelectorAll<HTMLElement>("[data-result-group]")];
		expect(groups.map((group) => group.getAttribute("data-result-group"))).toEqual(["s1", "s2"]);
		expect(within(groups[0]).getAllByRole("link")[0].getAttribute("href")).toBe("/public/s/s1");
		expect([...groups[0].querySelectorAll("[data-hit]")].map((node) => node.getAttribute("href"))).toEqual(["/public/s/s1?seq=4", "/public/s/s1?seq=3"]);
		expect(server.calls).toContain("/api/public/v1/search?q=base&group=session&prefix=true&limit=20");
		expect(server.calls.some((call) => call.startsWith("/api/v1/"))).toBe(false);
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
	});

	it("is in the public band, with its shortcut, and says what it searches", async () => {
		renderApp("/public", publicServer().fetch);
		const band = await screen.findByRole("navigation", { name: "Public" });
		expect(within(band).getByRole("link", { name: /Search/ }).getAttribute("href")).toBe("/public/search");
		await screen.findByRole("heading", { name: "Published trajectories" });
		fireEvent.keyDown(window, { key: "/" });
		expect(await screen.findByText("Search published trajectories")).toBeTruthy();
		expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
	});

	it("is where the owner's guest view of search goes, with the query", async () => {
		renderApp("/search?q=base", createFakeServer({ sessions: sessions(), hits: HITS }).fetch);
		expect((await screen.findByRole("link", { name: "View as guest" })).getAttribute("href")).toBe("/public/search?q=base");
	});
});
