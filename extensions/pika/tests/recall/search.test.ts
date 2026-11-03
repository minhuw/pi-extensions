import { afterEach, beforeEach, expect, it } from "vitest";
import { PREAMBLE } from "../../recall/format.ts";
import { FakePika } from "./support/pika-server.ts";
import { callTool, type Harness, setCredentials, startSession, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let pika: FakePika;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); pika = await new FakePika().start(); setCredentials(pika.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await pika.stop();
	await workspace.cleanup();
});

async function session(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	return h;
}

const GROUPS = [
	{
		sessionId: "s-1", sessionTitle: "Fix the  parser\nbug", project: "pi-extensions", lastAt: "2026-10-30T09:15:00.000Z", matches: 12,
		hits: [
			{ sessionId: "s-1", sessionTitle: "Fix the parser bug", seq: 41, entryId: "e41", kind: "assistant", snippet: "we &lt;b&gt;<mark>refactor</mark> the <mark>parser</mark> &amp; tokenizer &quot;now&quot; &#39;ok&#39; &#x2713;", at: "2026-10-30T09:00:00.000Z" },
			{ sessionId: "s-1-child", sessionTitle: "Fix the parser bug", seq: 7, entryId: "e7", kind: "tool-result", snippet: "<mark>parser</mark>.ts:\n  12 lines", at: "2026-10-29T08:00:00.000Z" },
		],
	},
	{ sessionId: "s-2", sessionTitle: "", matches: 1, hits: [{ sessionId: "s-2", sessionTitle: "", seq: 0, entryId: "e0", kind: "user", snippet: "the <mark>parser</mark>", at: "2026-01-02T00:00:00.000Z" }] },
];

it("searches sessions with the device token, excluding the current session, and formats the hits", async () => {
	pika.routes.set("search", { body: { items: GROUPS, nextCursor: null } });
	const h = await session();
	const result = await callTool(h, "recall_search", { query: "parser \"refactor it\"" });
	expect(result.isError).toBe(false);
	const [request] = pika.requestsTo("search");
	expect(request!.authorization).toBe("Bearer recall-test-token");
	expect(Object.fromEntries(request!.query)).toEqual({ q: "parser \"refactor it\"", group: "session", sort: "relevance", limit: "8", exclude: h.session.sessionId });
	expect(result.text).toBe([
		PREAMBLE,
		"2 past sessions match \"parser \\\"refactor it\\\"\" in every project, best match first:",
		"",
		"1. \"Fix the parser bug\"",
		"   sessionId s-1 · project pi-extensions · last active 2026-10-30 · 12 matches",
		"   - assistant · seq 41 · 2026-10-30: we <b>«refactor» the «parser» & tokenizer \"now\" 'ok' ✓",
		"   - tool-result · seq 7 · in child session s-1-child · 2026-10-29: «parser».ts: 12 lines",
		"",
		"2. \"untitled\"",
		"   sessionId s-2 · project unknown · last active unknown · 1 match",
		"   - user · seq 0 · 2026-01-02: the «parser»",
		"",
		"Read a session with recall_read({ sessionId }) for its overview and turns, or recall_read({ sessionId, seq }) for the entries around a hit.",
	].join("\n"));
	expect(result.details).toEqual({ query: "parser \"refactor it\"", sort: "relevance", limit: 8, sessionIds: ["s-1", "s-2"] });
});

it("passes sort and limit, and says when nothing matches", async () => {
	pika.routes.set("search", { body: { items: [], nextCursor: null } });
	const h = await session();
	const result = await callTool(h, "recall_search", { query: "nothing", sort: "newest", limit: 20 });
	expect(Object.fromEntries(pika.requestsTo("search")[0]!.query)).toMatchObject({ sort: "newest", limit: "20" });
	expect(result).toMatchObject({ isError: false, text: `${PREAMBLE}\nNo past session matches "nothing" in every project.` });
});

it("rejects a limit outside 1 to 20", async () => {
	const h = await session();
	const result = await callTool(h, "recall_search", { query: "x", limit: 50 });
	expect(result.isError).toBe(true);
	expect(pika.requests).toEqual([]);
});

it("resolves scope project through pika's repository resolver, and an explicit project wins", async () => {
	pika.routes.set("search", { body: { items: [], nextCursor: null } });
	const asked: string[] = [];
	setCredentials(pika.url, { repository: async (cwd) => { asked.push(cwd); return { project: "the-repo", repository: "https://example.com/the-repo" }; } });
	const h = await session();
	const scoped = await callTool(h, "recall_search", { query: "x", scope: "project" });
	await callTool(h, "recall_search", { query: "x", scope: "project", project: "other" });
	await callTool(h, "recall_search", { query: "x", project: "named" });
	await callTool(h, "recall_search", { query: "x", scope: "all" });
	expect(asked).toEqual([workspace.cwd]);
	expect(pika.requestsTo("search").map((request) => request.query.get("project"))).toEqual(["the-repo", "other", "named", null]);
	expect(scoped.text).toContain("No past session matches \"x\" in project the-repo.");
	expect(scoped.details).toMatchObject({ project: "the-repo" });
});

it("falls back to the cwd's basename without a resolver, when it fails, or when it names no project", async () => {
	pika.routes.set("search", { body: { items: [], nextCursor: null } });
	const h = await session();
	await callTool(h, "recall_search", { query: "x", scope: "project" });
	setCredentials(pika.url, { repository: async () => { throw new Error("no git"); } });
	await callTool(h, "recall_search", { query: "x", scope: "project" });
	setCredentials(pika.url, { repository: async () => ({}) });
	await callTool(h, "recall_search", { query: "x", scope: "project" });
	expect(pika.requestsTo("search").map((request) => request.query.get("project"))).toEqual(["my-project", "my-project", "my-project"]);
});

it("registers both tools in every mode, with prompt guidance, whatever the credentials", async () => {
	setCredentials(undefined);
	const h = await session({ mode: "print" });
	expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["recall_search", "recall_read"]));
	expect(h.session.systemPrompt).toContain("recall_search");
	expect(h.session.systemPrompt).toContain("Use recall_search when the user refers to earlier work");
});
