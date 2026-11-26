import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withoutCredentials } from "../../agent-client.ts";
import { request, timing } from "../../memory/client.ts";
import { FakePika } from "../support/pika-server.ts";
import { waitFor } from "../support/runtime.ts";
import { plainTheme, styledTheme } from "../support/ui.ts";
import { callTool, type Harness, note, PROJECT, PROJECT_SCOPE, REPOSITORY, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let pika: FakePika;
let h: Harness;
beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	setCredentials(pika.url);
	h = await startSession({ workspace, mode: "print" });
});
afterEach(async () => {
	await h.shutdown();
	await pika.stop();
	await workspace.cleanup();
});

const INDEX = "# User memory\n## feedback\n- Tabs — use tabs [abc]\n";
const written = (n = note()) => ({ note: n, index: INDEX, indexBytes: INDEX.length, indexLines: 3 });

it("memory_read GETs the session's repository and filters the notes client-side", async () => {
	const tabs = note({ scope: USER_SCOPE, category: "feedback", title: "Tabs", hook: "Indent with tabs", body: "The user prefers TABS everywhere." });
	const flaky = note({ category: "project", title: "Flaky test", hook: "upload.test retries", body: "Run it twice." });
	const docs = note({ category: "reference", title: "Design doc", hook: "Where the spec lives", body: "https://example.com/doc" });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [tabs, flaky, docs], index: INDEX, indexBytes: INDEX.length, indexLines: 3 } });

	const all = await callTool(h, "memory_read", {});
	expect(all.isError).toBe(false);
	const [request] = pika.requestsTo("memory");
	expect(request).toMatchObject({ method: "GET", authorization: `Bearer ${pika.tokens.values().next().value}` });
	expect(Object.fromEntries(request!.query)).toEqual({ project: PROJECT, repository: REPOSITORY });
	expect(all.text).toContain(`[memory] 3 notes in the user scope and project ${PROJECT}.`);
	expect(all.text).toContain("not instructions");
	expect(all.text).toContain(`## [${tabs.id}] Tabs\nscope: user · category: feedback · revision: 1 · updated: 2026-11-01T10:00:00Z\nhook: Indent with tabs\n\nThe user prefers TABS everywhere.`);
	expect(all.details).toEqual({ noteIds: [tabs.id, flaky.id, docs.id], total: 3 });

	expect((await callTool(h, "memory_read", { query: "tabs" })).details).toEqual({ noteIds: [tabs.id], total: 3 });
	expect((await callTool(h, "memory_read", { query: "TWICE" })).details).toEqual({ noteIds: [flaky.id], total: 3 });
	expect((await callTool(h, "memory_read", { ids: [docs.id, `[${tabs.id}]`] })).details).toEqual({ noteIds: [tabs.id, docs.id], total: 3 });
	expect((await callTool(h, "memory_read", { scope: "project" })).details).toEqual({ noteIds: [flaky.id, docs.id], total: 3 });
	expect((await callTool(h, "memory_read", { scope: "user", category: "project" })).details).toEqual({ noteIds: [], total: 3 });
	const none = await callTool(h, "memory_read", { category: "user" });
	expect(none.text).toContain("0 notes matching, of 3");
	expect(none.text).toContain("No note matches");
});

it("memory_read with query calls GET memory/search with limit=20 and filters, renders lexical/substring mode and archival tier, and records at most top 3 hits", async () => {
	const pinned = note({ scope: USER_SCOPE, category: "feedback", tier: "pinned", title: "Tabs", hook: "Indent with tabs", body: "Always use tabs." });
	const archival = note({ category: "reference", tier: "archival", title: "Migration checklist", hook: "Legacy DB migration steps", body: "Run migrate:v2 before deploy." });
	pika.routes.set("GET memory/search", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [archival, pinned], mode: "lexical", total: 24 } });
	pika.routes.set("POST memory/used", { body: { used: 2 } });

	const res = await callTool(h, "memory_read", { query: "database migration", scope: "project", category: "reference", tier: "archival" });
	expect(res.isError).toBe(false);
	const [req] = pika.requestsTo("memory/search");
	expect(req).toMatchObject({ method: "GET" });
	expect(Object.fromEntries(req!.query)).toEqual({
		q: "database migration",
		limit: "20",
		project: PROJECT,
		repository: REPOSITORY,
		scope: "project",
		category: "reference",
		tier: "archival",
	});
	expect(pika.requestsTo("memory")).toEqual([]);
	expect(res.text).toContain(`[memory] 2 notes matching (lexical), of 24 in the user scope and project ${PROJECT}.`);
	expect(res.text).toContain(`## [${archival.id}] Migration checklist\nscope: project ${PROJECT} · tier: archival · category: reference · revision: 1`);
	expect(res.text).toContain(`## [${pinned.id}] Tabs\nscope: user · category: feedback · revision: 1`);
	expect(res.details).toEqual({ noteIds: [archival.id, pinned.id], total: 24 });
	await waitFor(() => used().length === 1, 10_000, "memory/used after search");
	expect(used()[0]!.body).toEqual({ ids: [archival.id, pinned.id], project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId });

	// Substring mode and bounded recordUse (at most top 3 hits for query searches).
	const many = Array.from({ length: 5 }, (_, i) => note({ title: `Hit ${i}`, hook: `H${i}`, body: "Short match." }));
	pika.routes.set("GET memory/search", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: many, mode: "substring", total: 5 } });
	const sub = await callTool(h, "memory_read", { query: "match" });
	expect(sub.text).toContain("5 notes matching (substring), of 5");
	await waitFor(() => used().length === 2, 10_000, "memory/used capped at 3");
	expect((used()[1]!.body as { ids: string[] }).ids).toEqual(many.slice(0, 3).map((n) => n.id));

	// Overflow list tags archival notes in brief format too.
	const bigArchival = Array.from({ length: 6 }, (_, i) => note({ tier: i === 5 ? "archival" : "pinned", title: `N${i}`, hook: `H${i}`, body: "x".repeat(8_000) }));
	pika.routes.set("GET memory/search", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: bigArchival, mode: "lexical", total: 6 } });
	const bounded = await callTool(h, "memory_read", { query: "x" });
	expect(bounded.text).toContain("6 notes matching (lexical), of 6");
	expect(bounded.text).toContain(`- [${bigArchival[5]!.id}] N5 — H5 (project ${PROJECT}, archival, project, revision 1)`);
});

it("memory_read falls back from 404 memory/search to GET memory + client-side filtering, and returns noMemoryApi if both 404", async () => {
	const legacy = note({ scope: USER_SCOPE, category: "feedback", title: "Legacy note", hook: "Missing tier field", body: "Needle inside legacy note." });
	const archival = note({ category: "reference", tier: "archival", title: "Archival needle", hook: "Cold ref", body: "Needle inside archival note." });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [legacy, archival], index: INDEX, indexBytes: INDEX.length, indexLines: 3 } });

	// `GET memory/search` is unset (returns 404): falls back cleanly to `GET memory` + client-side filtering including tier.
	const fallback = await callTool(h, "memory_read", { query: "needle", tier: "archival" });
	expect(fallback.isError).toBe(false);
	expect(pika.requestsTo("memory/search")).toHaveLength(1);
	expect(pika.requestsTo("memory")).toHaveLength(1);
	expect(fallback.details).toEqual({ noteIds: [archival.id], total: 2 });
	expect(fallback.text).toContain("1 note matching, of 2");
	expect(fallback.text).not.toContain("(lexical)");

	// Non-404 error on `GET memory/search` fails directly without silently falling back to `GET memory`.
	pika.routes.set("GET memory/search", { status: 500, body: { error: "internal" } });
	const err = await callTool(h, "memory_read", { query: "needle" });
	expect(err.isError).toBe(true);
	expect(pika.requestsTo("memory")).toHaveLength(1);

	// 404 on BOTH `GET memory/search` and `GET memory` returns `noMemoryApi()`.
	pika.routes.delete("GET memory/search");
	pika.routes.delete("GET memory");
	const none = await callTool(h, "memory_read", { query: "needle" });
	expect(none).toMatchObject({
		isError: true,
		text: `the pika server at ${pika.url} has no agent memory API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`,
	});
});

it("memory_read filters by tier without query (treating missing tier as pinned) and skips memory/search when ids are passed", async () => {
	const legacy = note({ title: "Legacy", hook: "No tier field", body: "Old server note" });
	const pinned = note({ tier: "pinned", title: "Pinned", hook: "Explicit pinned", body: "Always in prompt" });
	const archival = note({ tier: "archival", title: "Archival", hook: "Cold ref", body: "Retrieved on demand" });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [legacy, pinned, archival], index: INDEX, indexBytes: INDEX.length, indexLines: 3 } });
	pika.routes.set("GET memory/search", { status: 500, body: { error: "should not be called" } });
	pika.routes.set("POST memory/used", { body: { used: 1 } });

	const onlyArchival = await callTool(h, "memory_read", { tier: "archival" });
	expect(onlyArchival.isError).toBe(false);
	expect(onlyArchival.details).toEqual({ noteIds: [archival.id], total: 3 });
	expect(onlyArchival.text).toContain("1 note matching, of 3");
	expect(onlyArchival.text).toContain("tier: archival");

	const onlyPinned = await callTool(h, "memory_read", { tier: "pinned" });
	expect(onlyPinned.isError).toBe(false);
	expect(onlyPinned.details).toEqual({ noteIds: [legacy.id, pinned.id], total: 3 });

	// `ids` + `query` still uses `GET memory` (not `memory/search`).
	const byIds = await callTool(h, "memory_read", { ids: [archival.id, pinned.id], query: "demand" });
	expect(byIds.isError).toBe(false);
	expect(byIds.details).toEqual({ noteIds: [archival.id], total: 3 });
	expect(pika.requestsTo("memory/search")).toEqual([]);
	// `tier` alone never records use, while `ids` + `query` does.
	await waitFor(() => used().length === 1, 10_000, "memory/used for ids");
	expect(used()[0]!.body).toEqual({ ids: [archival.id], project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId });
});

it("memory_read bounds its output and lists the rest by title", async () => {
	const notes = Array.from({ length: 6 }, () => note({ body: "x".repeat(8_000) }));
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes, index: "", indexBytes: 0, indexLines: 0 } });
	const result = await callTool(h, "memory_read", {});
	expect(result.text.length).toBeLessThan(21_000);
	expect(result.text).toContain(`## [${notes[1]!.id}]`);
	expect(result.text).not.toContain(`## [${notes[2]!.id}]`);
	expect(result.text).toContain("4 more notes not shown in full; read them with memory_read({ ids: [...] }):");
	expect(result.text).toContain(`- [${notes[5]!.id}] ${notes[5]!.title} — ${notes[5]!.hook}`);
});

const used = () => pika.requestsTo("memory/used");

it("memory_read by ids or query tells the server which notes it showed in full; other reads tell it nothing", async () => {
	const notes = Array.from({ length: 6 }, (_, n) => note({ title: n === 4 ? "Needle" : `Big ${n}`, body: "x".repeat(8_000) }));
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes, index: "", indexBytes: 0, indexLines: 0 } });
	pika.routes.set("POST memory/used", (request) => ({ body: { used: (request.body as { ids: string[] }).ids.length } }));

	// An unfiltered listing, a category or scope filter, and ids that match nothing count as no use.
	await callTool(h, "memory_read", {});
	await callTool(h, "memory_read", { category: "project" });
	await callTool(h, "memory_read", { scope: "project", category: "project" });
	await callTool(h, "memory_read", { ids: ["000000000000"] });
	// Only the notes shown in full count, not those past the budget that are listed by title.
	const read = await callTool(h, "memory_read", { ids: notes.map((n) => `[${n.id}]`).reverse() });
	expect(read.text).toContain("4 more notes not shown in full");
	await waitFor(() => used().length === 1, 10_000, "memory/used");
	expect(used()).toHaveLength(1);
	expect(used()[0]).toMatchObject({ method: "POST", contentType: "application/json" });
	expect(used()[0]!.body).toEqual({ ids: [notes[0]!.id, notes[1]!.id], project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId });

	await callTool(h, "memory_read", { query: "needle" });
	await waitFor(() => used().length === 2, 10_000, "the second memory/used");
	expect(used()[1]!.body).toEqual({ ids: [notes[4]!.id], project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId });
	expect(pika.requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual(["memory/used", "memory/used"]);
});

it("memory_read names at most 50 notes as used for ids reads, and at most 3 for query fallback reads", async () => {
	const notes = Array.from({ length: 60 }, () => note({ title: "Short", hook: "h", body: "b" }));
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes, index: "" } });
	pika.routes.set("POST memory/used", { body: { used: 50 } });
	const byIds = await callTool(h, "memory_read", { ids: notes.map((n) => n.id) });
	expect(byIds.details).toEqual({ noteIds: notes.map((n) => n.id), total: 60 });
	await waitFor(() => used().length === 1, 10_000, "memory/used for ids");
	expect((used()[0]!.body as { ids: string[] }).ids).toEqual(notes.slice(0, 50).map((n) => n.id));

	// 404 fallback `query` search records at most top 3 hits.
	const byQuery = await callTool(h, "memory_read", { query: "short" });
	expect(byQuery.details).toEqual({ noteIds: notes.map((n) => n.id), total: 60 });
	await waitFor(() => used().length === 2, 10_000, "memory/used for query fallback");
	expect((used()[1]!.body as { ids: string[] }).ids).toEqual(notes.slice(0, 3).map((n) => n.id));
});

it("memory_read returns its notes whether memory/used is missing, fails, or hangs", async () => {
	const tabs = note({ title: "Tabs", body: "Use tabs." });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [tabs], index: INDEX } });
	const expected = (await callTool(h, "memory_read", {})).text;
	// An older server answers 404; others fail, or never answer while the read goes on.
	for (const answer of [undefined, { status: 500, body: { error: "internal" } }, { delayMs: 30_000, body: { used: 1 } }]) {
		if (answer) pika.routes.set("POST memory/used", answer);
		const before = used().length;
		const started = performance.now();
		const read = await callTool(h, "memory_read", { ids: [tabs.id] });
		expect(read).toMatchObject({ isError: false, details: { noteIds: [tabs.id], total: 1 } });
		expect(read.text.replace("1 note matching, of 1", "1 note")).toBe(expected);
		expect(performance.now() - started).toBeLessThan(10_000);
		await waitFor(() => used().length === before + 1, 10_000, "memory/used");
	}
});

it("memory_save creates and updates notes with the repository and session id", async () => {
	const created = note({ title: "Pitfall", hook: "Run npm ci first" });
	pika.routes.set("POST memory/notes", (request) => ({ body: written((request.body as { id?: string }).id ? { ...created, revision: 2 } : created) }));
	const result = await callTool(h, "memory_save", { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "Run npm ci first", body: "Tests need node_modules.", reason: "found it" });
	expect(result.isError).toBe(false);
	const [request] = pika.requestsTo("memory/notes");
	expect(request).toMatchObject({ method: "POST", contentType: "application/json" });
	expect(request!.body).toEqual({
		expectedRevision: 0, scope: "project", project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId,
		category: "project", title: "Pitfall", hook: "Run npm ci first", body: "Tests need node_modules.", reason: "found it",
	});
	expect(result.text).toBe([
		`Created note ${created.id} (now revision 1) in project ${PROJECT}: Pitfall — Run npm ci first`,
		`The memory section pinned in this session's system prompt stays unchanged until a new session. The server's index is now (${INDEX.length} bytes, 3 lines; limit 8192 bytes and 200 lines per scope):`,
		INDEX,
	].join("\n"));
	expect(result.details).toEqual({ note: created, index: INDEX });

	const updated = await callTool(h, "memory_save", { id: created.id, expectedRevision: 1, scope: "user", category: "feedback", title: "T", hook: "H", body: "" });
	expect(updated.text).toMatch(/^Updated note \w+ \(now revision 2\)/);
	expect(pika.requestsTo("memory/notes")[1]!.body).toEqual({
		id: created.id, expectedRevision: 1, scope: "user", project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId,
		category: "feedback", title: "T", hook: "H", body: "",
	});
});

it("memory_save returns the current note on a revision conflict", async () => {
	const stored = note({ revision: 3, title: "Stored title", body: "Stored body" });
	pika.routes.set("POST memory/notes", { status: 409, body: { error: "revision_conflict", note: stored } });
	const result = await callTool(h, "memory_save", { id: stored.id, expectedRevision: 2, scope: "project", category: "project", title: "Mine", hook: "h", body: "b" });
	expect(result.isError).toBe(true);
	expect(result.text).toContain(`revision_conflict: note ${stored.id} is at revision 3, not 2; it changed since you read it. Its current state:`);
	expect(result.text).toContain(`## [${stored.id}] Stored title\nscope: project ${PROJECT} · category: project · revision: 3`);
	expect(result.text).toContain("Stored body");
	expect(result.text).toContain("Merge your change into it and call memory_save again with expectedRevision 3.");
});

it("memory_save passes tier: archival after capability check, formats per-scope and archival output, and refuses v25 servers pre-mutation", async () => {
	const archival = note({ tier: "archival", title: "Migration notes", hook: "Legacy DB steps", body: "Run v2 script." });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: INDEX, tiers: true } });
	pika.routes.set("POST memory/notes", { body: { ...written(archival), scopeIndexBytes: 420, scopeIndexLines: 12 } });
	const args = {
		expectedRevision: 0, scope: "project", category: "reference", tier: "archival",
		title: "Migration notes", hook: "Legacy DB steps", body: "Run v2 script.",
	};
	const res = await callTool(h, "memory_save", args);
	expect(res.isError).toBe(false);
	expect(Object.fromEntries(pika.requestsTo("memory")[0]!.query)).toEqual({ view: "index", project: PROJECT, repository: REPOSITORY });
	expect(pika.requestsTo("memory/notes")[0]!.body).toMatchObject({ tier: "archival" });
	expect(res.text).toContain(`Created note ${archival.id} [archival] (now revision 1) in project ${PROJECT}: Migration notes — Legacy DB steps`);
	expect(res.text).toContain("Archival notes do not appear in <memory> and use no index budget; retrieve them with memory_read({ query }).");
	expect(res.text).toContain(`The server's index is now (project ${PROJECT} index: 420 of 8192 bytes, 12 of 200 lines):`);

	// Legacy v25 server (omits `tiers: true`): refuses archival save BEFORE calling POST memory/notes.
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: INDEX } });
	const legacyRefused = await callTool(h, "memory_save", args);
	expect(legacyRefused).toMatchObject({
		isError: true,
		text: "This pika server does not support tier \"archival\" (upgrade the server first). Nothing was saved.",
	});
	expect(pika.requestsTo("memory/notes")).toHaveLength(1);

	// Normal pinned / omitted-tier save incurs no pre-flight GET memory round trip.
	const beforeGet = pika.requestsTo("memory").length;
	const pinned = await callTool(h, "memory_save", { ...args, tier: "pinned" });
	expect(pinned.isError).toBe(false);
	expect(pika.requestsTo("memory")).toHaveLength(beforeGet);

	const renderCall = (name: string, callArgs: object) =>
		h.session.extensionRunner.getToolDefinition(name)!.renderCall!(callArgs as never, plainTheme, { args: callArgs, expanded: false, isError: false } as never)
			.render(500).map((line) => line.trimEnd()).join("\n");
	expect(renderCall("memory_save", args)).toBe("memory_save Migration notes · project · new · archival");
	expect(renderCall("memory_save", { ...args, tier: "pinned" })).toBe("memory_save Migration notes · project · new");
	expect(renderCall("memory_read", { query: "migration", tier: "archival" })).toBe('memory_read "migration" · archival tier');
});

it("memory_save explains a full memory (per-scope v26 vs combined legacy v25) and passes a bad request's message", async () => {
	// Legacy v25 server omits `budget`: reports combined index without claiming per-scope isolation or suggesting tier: archival.
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200 } });
	const full = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(full).toMatchObject({ isError: true });
	expect(full.text).toBe("memory_full: with this note the memory index would be 8300 bytes and 150 lines, over its limit of 8192 bytes and 200 lines. "
		+ "Nothing was saved. Merge related notes into one, shorten titles and hooks, or memory_forget notes that are no longer useful, then save again.");
	expect(full.text).not.toContain("archival");

	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200, project: { key: "repo:https://example.com/other", kind: "project", label: "other" } } });
	const legacyCombined = await callTool(h, "memory_save", { expectedRevision: 0, scope: "project", category: "project", title: "t", hook: "h", body: "" });
	expect(legacyCombined.text).toBe("memory_full: with this note the user and project other memory index would be 8300 bytes and 150 lines, over its limit of 8192 bytes and 200 lines. "
		+ "Nothing was saved. Merge related notes into one, shorten titles and hooks, or memory_forget notes that are no longer useful, then save again.");
	expect(legacyCombined.text).not.toContain("alone");
	expect(legacyCombined.text).not.toContain("archival");

	// v26 server sets `budget: "per_scope"`: reports that project's independent limit and suggests archival for reference/lookup notes.
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", budget: "per_scope", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200, project: { key: "repo:https://example.com/other", kind: "project", label: "other" } } });
	const other = await callTool(h, "memory_save", { expectedRevision: 0, scope: "project", category: "project", title: "t", hook: "h", body: "" });
	expect(other.text).toBe("memory_full: with this note project other's memory index alone would be 8300 bytes and 150 lines, over its independent limit of 8192 bytes and 200 lines. "
		+ "Nothing was saved. Merge related notes into one, shorten titles and hooks, or memory_forget notes that are no longer useful, then save again. "
		+ "Detailed reference or lookup notes can be saved with tier: \"archival\" (uses no index budget).");
	// v26 user scope overflow (`budget: "per_scope"`, `project: null`) warns against downgrading user-wide rules into project scope.
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", budget: "per_scope", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200, project: null } });
	const alone = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(alone.text).toBe("memory_full: with this note the user scope's memory index alone would be 8300 bytes and 150 lines, over its independent limit of 8192 bytes and 200 lines. "
		+ "Nothing was saved. Do not downgrade a user-wide rule into the project scope to work around a full user scope; either merge/shorten/forget user-scope notes, demote cold reference notes to tier: \"archival\", or tell the user. "
		+ "Detailed reference or lookup notes can be saved with tier: \"archival\" (uses no index budget).");

	pika.routes.set("POST memory/notes", { status: 400, body: { error: "bad_request", message: "hook must be one line" } });
	const bad = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "a\nb", body: "" });
	expect(bad).toMatchObject({ isError: true, text: "the pika server refused the request (HTTP 400 bad_request): hook must be one line." });
});

it("memory tools document independent per-scope budgets, pinned/archival tiers, full-text (FTS5) search, and forbid downgrading user rules into project scope", () => {
	const tools = new Map(h.session.getAllTools().map((tool) => [tool.name, tool]));
	const read = tools.get("memory_read")!;
	const save = tools.get("memory_save")!;
	expect(read.description).toContain("full-text (FTS5) search");
	expect(read.description).not.toContain("hybrid");
	expect(save.description).toContain("`tier: \"pinned\"`");
	expect(save.description).toContain("`tier: \"archival\"`");
	expect(save.description).toContain("full-text search");
	expect(save.description).not.toContain("hybrid");
	expect(save.description).toContain("the user scope and each project scope each have an independent 8 KiB and 200-line index limit");
	expect(save.description).toContain("Never downgrade a user-wide rule into `scope: \"project\"` if the user scope is full");
	const guidelines = (read.promptGuidelines ?? []).join("\n");
	expect(guidelines).toContain("The user scope and each project scope each have an independent 8 KiB and 200-line index limit");
	expect(guidelines).toContain("never downgrade a user-wide rule into scope \"project\" if the user scope is full");
	expect(guidelines).toContain("tier \"archival\"");
	expect(guidelines).toContain("memory_read({ query })");
	expect(guidelines).not.toContain("hybrid");
});

it("memory_save refuses a body over 600 characters before sending it, counting characters rather than bytes", async () => {
	const save = { expectedRevision: 0, scope: "user", category: "feedback", title: "t", hook: "h" };
	const long = await callTool(h, "memory_save", { ...save, body: "x".repeat(601) });
	expect(long.isError).toBe(true);
	expect(long.text.startsWith("body_too_long: the body is 601 characters, over the limit of 600. Nothing was saved.")).toBe(true);
	expect(pika.requests).toEqual([]);

	pika.routes.set("POST memory/notes", { body: written() });
	expect((await callTool(h, "memory_save", { ...save, body: "x".repeat(600) })).isError).toBe(false);
	// 600 two-byte characters are 1200 bytes, still within the limit.
	expect((await callTool(h, "memory_save", { ...save, body: "é".repeat(600) })).isError).toBe(false);
	expect(pika.requestsTo("memory/notes").map((request) => (request.body as { body: string }).body.length)).toEqual([600, 600]);
});

it("memory_save tells an unknown note from a server without memory", async () => {
	pika.routes.set("GET memory", { body: { scopes: [], notes: [], index: "" } });
	const unknown = await callTool(h, "memory_save", { id: "000000000000", expectedRevision: 1, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(unknown).toMatchObject({ isError: true });
	expect(unknown.text).toMatch(/^not_found: no live note 000000000000/);
	pika.routes.delete("GET memory");
	const old = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(old).toMatchObject({ isError: true, text: `the pika server at ${pika.url} has no agent memory API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.` });
	expect((await callTool(h, "memory_read", {})).text).toBe(old.text);
});

it("memory_forget posts the revision, repository, and session id", async () => {
	const gone = note({ revision: 2, deletedAt: "2026-11-08T10:00:00Z" });
	pika.routes.set(`POST memory/notes/${gone.id}/forget`, { body: written(gone) });
	const result = await callTool(h, "memory_forget", { id: gone.id, expectedRevision: 1, reason: "obsolete" });
	expect(result.isError).toBe(false);
	expect(result.text).toContain(`Forgot note ${gone.id} (now revision 2) in project ${PROJECT}`);
	expect(result.text).toContain("stays unchanged until a new session");
	const [request] = pika.requestsTo(`memory/notes/${gone.id}/forget`);
	expect(request).toMatchObject({ method: "POST", body: { expectedRevision: 1, project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId, reason: "obsolete" } });

	pika.routes.set(`POST memory/notes/${gone.id}/forget`, { status: 409, body: { error: "revision_conflict", note: { ...gone, revision: 5, deletedAt: null } } });
	const conflict = await callTool(h, "memory_forget", { id: gone.id, expectedRevision: 1 });
	expect(conflict).toMatchObject({ isError: true });
	expect(conflict.text).toContain("is at revision 5, not 1");
	expect(conflict.text).toContain("If it should still go, call memory_forget again with expectedRevision 5.");
});

it("collapses a successful save or forget to its action, revision, and scope, since the call line shows the title", async () => {
	const last = (name: string) => h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
	const render = (name: string, args: object, { expanded = false, isError = false, result = last(name) as unknown } = {}) =>
		h.session.extensionRunner.getToolDefinition(name)!.renderResult!(result as never, { expanded, isPartial: false }, plainTheme, { args, expanded, isError } as never)
			.render(500).map((line) => line.trimEnd());
	const created = note({ title: "Pitfall", hook: "Run npm ci first" });
	pika.routes.set("POST memory/notes", (request) => ({ body: written((request.body as { id?: string }).id ? { ...created, scope: USER_SCOPE, revision: 4 } : created) }));
	const save = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "Run npm ci first", body: "b" };
	const first = await callTool(h, "memory_save", save);
	expect(render("memory_save", save)).toEqual([`created · rev 1 · project ${PROJECT}`]);
	expect(render("memory_save", save, { expanded: true })).toEqual(first.text.split("\n"));
	const update = { ...save, id: `[${created.id}]`, expectedRevision: 3, scope: "user" };
	await callTool(h, "memory_save", update);
	expect(render("memory_save", update)).toEqual(["updated · rev 4 · user"]);

	const gone = note({ revision: 3, deletedAt: "2026-11-08T10:00:00Z" });
	pika.routes.set(`POST memory/notes/${gone.id}/forget`, { body: written(gone) });
	const forgot = await callTool(h, "memory_forget", { id: gone.id, expectedRevision: 2 });
	expect(render("memory_forget", { id: gone.id })).toEqual([`forgot · rev 3 · project ${PROJECT}`]);
	expect(render("memory_forget", { id: gone.id }, { expanded: true })).toEqual(forgot.text.split("\n"));
	// A result without the note in its details shows its first line.
	const bare = { content: [{ type: "text", text: "Forgot note x (now revision 3) in user: T — H\nmore" }], details: {} };
	expect(render("memory_forget", { id: "x" }, { result: bare })).toEqual(["Forgot note x (now revision 3) in user: T — H"]);
	expect(render("memory_save", save, { result: { ...bare, details: undefined } })).toEqual(["Forgot note x (now revision 3) in user: T — H"]);

	// Errors render as before: their first line, and the whole text expanded.
	pika.routes.set("POST memory/notes", { status: 409, body: { error: "revision_conflict", note: { ...created, revision: 5 } } });
	const refused = await callTool(h, "memory_save", update);
	expect(render("memory_save", update, { isError: true })).toEqual([refused.text.split("\n")[0]]);
	expect(render("memory_save", update, { isError: true, expanded: true })).toEqual(refused.text.split("\n"));
});

it("strips ANSI/OSC/CSI control sequences from rendered memory tool output while preserving raw result.content and theme styling", async () => {
	const OSC52 = "\x1b]52;c;SGVsbG8=\x07";
	const CSI_RED = "\x1b[31m";
	const CSI_RESET = "\x1b[0m";
	const CSI_CLEAR = "\x1b[2J";
	const DIRTY = `${OSC52}${CSI_RED}danger${CSI_RESET}${CSI_CLEAR}`;
	const last = (name: string) => h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
	const renderResult = (name: string, args: object, { expanded = false, isError = false, theme = plainTheme, result = last(name) as unknown } = {}) =>
		h.session.extensionRunner.getToolDefinition(name)!.renderResult!(result as never, { expanded, isPartial: false }, theme, { args, expanded, isError } as never)
			.render(500).map((line) => line.trimEnd()).join("\n");
	const renderCall = (name: string, args: object, theme = plainTheme) =>
		h.session.extensionRunner.getToolDefinition(name)!.renderCall!(args as never, theme, { args, expanded: false, isError: false } as never)
			.render(500).map((line) => line.trimEnd()).join("\n");

	const dirtyScope = { ...PROJECT_SCOPE, label: `proj-${DIRTY}` };
	const dirtyNote = note({ scope: dirtyScope, title: `Title ${DIRTY}`, hook: `Hook ${DIRTY}`, body: `Body ${DIRTY}` });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, dirtyScope], notes: [dirtyNote], index: INDEX, indexBytes: INDEX.length, indexLines: 3 } });
	pika.routes.set("POST memory/notes", { body: written(dirtyNote) });
	pika.routes.set(`POST memory/notes/${dirtyNote.id}/forget`, { body: written({ ...dirtyNote, revision: 2, deletedAt: "2026-11-08T10:00:00Z" }) });

	const readOut = await callTool(h, "memory_read", {});
	const saveArgs = { expectedRevision: 0, scope: "project", category: "project", title: dirtyNote.title, hook: dirtyNote.hook, body: dirtyNote.body };
	const saveOut = await callTool(h, "memory_save", saveArgs);
	const forgetOut = await callTool(h, "memory_forget", { id: dirtyNote.id, expectedRevision: 1 });

	for (const [name, args, out] of [
		["memory_read", {}, readOut],
		["memory_save", saveArgs, saveOut],
		["memory_forget", { id: dirtyNote.id, expectedRevision: 1 }, forgetOut],
	] as const) {
		expect(out.isError).toBe(false);
		expect(out.text).toContain(OSC52);
		expect(out.text).toContain(CSI_RED);
		expect(out.text).toContain(CSI_CLEAR);

		for (const expanded of [false, true]) {
			const rendered = renderResult(name, args, { expanded });
			expect(rendered).not.toContain("\x1b");
			expect(rendered).not.toContain("\x07");
			if (expanded) expect(rendered).toContain("danger");

			const styled = renderResult(name, args, { expanded, theme: styledTheme });
			expect(styled).not.toContain(OSC52);
			expect(styled).not.toContain(CSI_RED);
			expect(styled).not.toContain(CSI_CLEAR);
			expect(styled).not.toContain("\x07");
			if (!expanded || name === "memory_read") expect(styled).toContain("\x1b[32m");
		}

		// Error rendering (collapsed + expanded) strips control sequences without mutating content.
		const errRes = { content: [{ type: "text", text: `boom ${DIRTY}\nline 2 ${DIRTY}` }], details: {} };
		expect(renderResult(name, args, { isError: true, result: errRes })).not.toContain("\x1b");
		expect(renderResult(name, args, { isError: true, expanded: true, result: errRes })).not.toContain("\x1b");
		expect(errRes.content[0]!.text).toContain(OSC52);
	}

	expect(renderResult("memory_save", saveArgs)).toBe("created · rev 1 · project proj-danger");
	expect(renderResult("memory_forget", { id: dirtyNote.id })).toBe("forgot · rev 2 · project proj-danger");

	// renderCall strips control sequences from call arguments too.
	expect(renderCall("memory_read", { ids: [DIRTY], query: DIRTY })).toBe('memory_read ids danger · "danger"');
	expect(renderCall("memory_save", { id: DIRTY, scope: "project", title: DIRTY })).toBe("memory_save danger · project · update danger");
	expect(renderCall("memory_forget", { id: DIRTY })).toBe("memory_forget danger");
});

it("without a git repository, project saves fail and user saves still work", async () => {
	await h.shutdown();
	const bare = await Workspace.create({ git: false });
	try {
		setCredentials(pika.url);
		h = await startSession({ workspace: bare, mode: "print" });
		const project = await callTool(h, "memory_save", { expectedRevision: 0, scope: "project", category: "project", title: "t", hook: "h", body: "" });
		expect(project.isError).toBe(true);
		expect(project.text).toContain("is not in a git repository pika can name, so it has no project memory");
		expect(pika.requestsTo("memory/notes")).toEqual([]);
		pika.routes.set("POST memory/notes", { body: written(note({ scope: USER_SCOPE })) });
		expect((await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" })).isError).toBe(false);
		expect(pika.requestsTo("memory/notes")[0]!.body).toEqual({ expectedRevision: 0, scope: "user", sessionId: h.session.sessionId, category: "user", title: "t", hook: "h", body: "" });
		pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE], notes: [], index: "" } });
		const read = await callTool(h, "memory_read", {});
		expect(Object.fromEntries(pika.requestsTo("memory")[0]!.query)).toEqual({});
		expect(read.text).toContain("has no project scope");
	} finally {
		await h.shutdown();
		await bare.cleanup();
	}
});

it("logged out, excluded, rejected, or read-denied: every tool returns a tool error", async () => {
	const tools: [string, Parameters<typeof callTool>[2]][] = [
		["memory_read", {}],
		["memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" }],
		["memory_forget", { id: "abc", expectedRevision: 1 }],
	];
	setCredentials(undefined);
	for (const [name, args] of tools) {
		expect(await callTool(h, name, args)).toMatchObject({ isError: true, text: "memory needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login." });
	}
	setCredentials(pika.url, { excluded: true });
	for (const [name, args] of tools) {
		expect(await callTool(h, name, args)).toMatchObject({ isError: true, text: `pika's exclude list covers this session's working directory (${workspace.cwd}), so memory is off in this session.` });
	}
	expect(pika.requests).toEqual([]);

	setCredentials(pika.url, { token: "revoked" });
	for (const [name, args] of tools) {
		expect(await callTool(h, name, args)).toMatchObject({ isError: true, text: `the pika server at ${pika.url} rejected this device's token (HTTP 401). Ask the user to run /pika login to pair this device again.` });
	}
	setCredentials(pika.url);
	pika.readAccess = false;
	for (const [name, args] of tools) {
		const result = await callTool(h, name, args);
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/^this device may not use agent memory on the pika server \(HTTP 403 read_access_denied\)/);
	}
});

it("reports an unreachable server and one that does not answer in time", async () => {
	const url = pika.url;
	await pika.stop();
	const down = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(down.isError).toBe(true);
	expect(down.text).toMatch(new RegExp(`^could not reach the pika server at ${url.replace(/\./g, "\\.")}: .+\\.$`));

	pika = await new FakePika().start();
	setCredentials(pika.url);
	timing.httpTimeoutMs = 200;
	pika.routes.set("GET memory", { delayMs: 2_000, body: { notes: [] } });
	const slow = await callTool(h, "memory_read", {});
	expect(slow).toMatchObject({ isError: true, text: `could not reach the pika server at ${pika.url}: no answer within 0.2 s.` });
});

it("memory_save takes an id in brackets, as the index shows it", async () => {
	const stored = note({ revision: 2 });
	pika.routes.set("POST memory/notes", { body: written(stored) });
	const result = await callTool(h, "memory_save", { id: ` [${stored.id}] `, expectedRevision: 1, scope: "project", category: "project", title: "t", hook: "h", body: "" });
	expect(result.isError).toBe(false);
	expect(pika.requestsTo("memory/notes")[0]!.body).toMatchObject({ id: stored.id });
});

it("memory_save of a note in the other scope says which scope it is in, not that it was forgotten", async () => {
	const tabs = note({ scope: USER_SCOPE, category: "feedback", title: "Tabs" });
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [tabs], index: INDEX } });
	pika.routes.set("POST memory/notes", { status: 404, body: { error: "not_found" } });
	const result = await callTool(h, "memory_save", { id: tabs.id, expectedRevision: 1, scope: "project", category: "feedback", title: "Tabs", hook: "h", body: "" });
	expect(result.isError).toBe(true);
	expect(result.text).toBe(`note ${tabs.id} is in the user scope, not the project scope; a note never changes scope. Save it again with scope "user" to update it, `
		+ "or create a note in the project scope (no id, expectedRevision 0) and memory_forget this one if it should move.");
	// Listed in the scope the save named: the 404 raced a change, so it is no proof the note is gone.
	const same = await callTool(h, "memory_save", { id: `[${tabs.id}]`, expectedRevision: 1, scope: "user", category: "feedback", title: "Tabs", hook: "h", body: "" });
	expect(same.text).toBe(`the pika server did not find note ${tabs.id} (HTTP 404), though it lists the note as live; read it again with memory_read and retry.`);
});

it("a write's 404 that pika cannot check is not reported as a forgotten note", async () => {
	pika.routes.set("POST memory/notes", { status: 404, body: { error: "not_found" } });
	const args = { id: "000000000000", expectedRevision: 1, scope: "user", category: "user", title: "t", hook: "h", body: "" };
	pika.routes.set("GET memory", { status: 500, body: { error: "internal" } });
	const failed = await callTool(h, "memory_save", args);
	expect(failed.isError).toBe(true);
	expect(failed.text).toBe(`the pika server did not find note 000000000000 (HTTP 404), and pika could not check why: unexpected HTTP 500 (internal) from the pika server at ${pika.url}. `
		+ "Read the notes with memory_read before you retry.");
	timing.httpTimeoutMs = 200;
	pika.routes.set("GET memory", { delayMs: 2_000, body: { notes: [] } });
	const slow = await callTool(h, "memory_forget", { id: "000000000000", expectedRevision: 1 });
	expect(slow.text).toMatch(/^the pika server did not find note 000000000000 \(HTTP 404\), and pika could not check why: could not reach the pika server at .+: no answer within 0\.2 s\./);
	expect(slow.text).not.toContain("not_found");
});

it("names why pika is disabled instead of asking for /pika login", async () => {
	setCredentials(undefined);
	const read = () => callTool(h, "memory_read", {});
	try {
		process.env.PIKA_DISABLED = "1";
		expect(await read()).toMatchObject({ isError: true, text: "memory is off because pika is disabled: PIKA_DISABLED=1 is set. Tell the user; /pika shows why." });
	} finally { delete process.env.PIKA_DISABLED; }
	const file = join(workspace.agentDir, "pika.json");
	await writeFile(file, JSON.stringify({ url: pika.url, token: "pika_secret_token", enabled: false }));
	expect((await read()).text).toBe(`memory is off because pika is disabled: "enabled" is false in ${file}. Tell the user; /pika shows why.`);
	// A parser's message may quote the file; the tool never shows it.
	await writeFile(file, `{ token: "pika_secret_token" }`);
	expect((await read()).text).toBe(`memory is off because pika is disabled: pika cannot read ${file}. Tell the user; /pika shows why.`);
	await writeFile(file, JSON.stringify({ url: "https://alice:hunter2@pika.example", token: "pika_secret_token" }));
	const credentials = await read();
	expect(credentials.text).toBe(`memory is off because pika is disabled: invalid server url in ${file}: the server URL must not contain credentials. Tell the user; /pika shows why.`);
	await rm(file);
	expect((await read()).text).toBe("memory needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.");
	expect(pika.requests).toEqual([]);
});

it("never shows the user name or password of the server URL", async () => {
	setCredentials(pika.url.replace("http://", "http://alice:hunter2@"));
	for (const [name, args] of [["memory_read", {}], ["memory_save", { id: "abc", expectedRevision: 1, scope: "user", category: "user", title: "t", hook: "h", body: "" }]] as const) {
		const result = await callTool(h, name, args);
		expect(result).toMatchObject({ isError: true, text: "pika's server URL contains a user name or password, which pika never sends, so memory is off. Ask the user to remove them from PIKA_URL or the url in pika.json." });
	}
	expect(pika.requests).toEqual([]);
	expect(withoutCredentials("Request cannot be constructed from a URL that includes credentials: https://alice:hunter2@pika.example/api/agent/v1/memory?project=x"))
		.toBe("Request cannot be constructed from a URL that includes credentials: https://pika.example/api/agent/v1/memory?project=x");
	expect(withoutCredentials("at http://a@b:c@host:8080/x and ftp://u@h/ but not mail@example.com or https://host/a@b")).toBe("at http://host:8080/x and ftp://h/ but not mail@example.com or https://host/a@b");
});

it("reports a timeout or an abort while the answer arrives as such, not as an unreadable answer", async () => {
	// Sends the headers and the start of the body, then stalls.
	const stalling = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"notes":['); });
	await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(stalling.address() as AddressInfo).port}`;
	try {
		setCredentials(url);
		timing.httpTimeoutMs = 300;
		expect(await callTool(h, "memory_read", {})).toMatchObject({ isError: true, text: `the pika server at ${url} did not finish its answer within 0.3 s.` });
		timing.httpTimeoutMs = 15_000;
		const controller = new AbortController();
		const reading = request(workspace.cwd, "GET", "memory", { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);
		await expect(reading).rejects.toThrow(/^memory was cancelled\.$/);
	} finally {
		stalling.closeAllConnections();
		await new Promise((resolve) => stalling.close(resolve));
	}
});

it.skipIf(process.platform === "win32")("resolves the repository again after git stalled, instead of losing project memory for the process", async () => {
	const savedPath = process.env.PATH;
	const bin = join(workspace.root, "bin");
	const stall = join(workspace.root, "stall");
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	await mkdir(bin);
	await writeFile(join(bin, "git"), `#!/bin/sh\nif [ -e '${stall}' ]; then exec sleep 10; fi\nexec '${real}' "$@"\n`);
	await chmod(join(bin, "git"), 0o755);
	await writeFile(stall, "");
	pika.routes.set("POST memory/notes", { body: written() });
	const args = { expectedRevision: 0, scope: "project", category: "project", title: "t", hook: "h", body: "" };
	try {
		process.env.PATH = `${bin}:${savedPath ?? ""}`;
		const stalled = await callTool(h, "memory_save", args);
		expect(stalled.isError).toBe(true);
		expect(stalled.text).toContain("is not in a git repository pika can name");
		await rm(stall);
		expect((await callTool(h, "memory_save", args)).isError).toBe(false);
		expect(pika.requestsTo("memory/notes")[0]!.body).toMatchObject({ project: PROJECT, repository: REPOSITORY });
	} finally {
		process.env.PATH = savedPath;
	}
});
