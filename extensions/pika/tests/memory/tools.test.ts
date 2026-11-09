import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { request, timing, withoutCredentials } from "../../memory/client.ts";
import { FakePika } from "./support/pika-server.ts";
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
		`The memory section pinned in this session's system prompt stays unchanged until a new session. The server's index is now (${INDEX.length} of 8192 bytes, 3 of 200 lines):`,
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

it("memory_save explains a full memory and passes a bad request's message", async () => {
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200 } });
	const full = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(full).toMatchObject({ isError: true });
	expect(full.text).toBe("memory_full: with this note the memory index of the user scope and this project's scope would be 8300 bytes and 150 lines, over its limit of 8192 bytes and 200 lines. "
		+ "Nothing was saved. Merge related notes into one, shorten titles and hooks, or memory_forget notes that are no longer useful, then save again.");
	// A user-scope save is budgeted against every project's index, so the server names the one that overflows.
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200, project: { key: "repo:https://example.com/other", kind: "project", label: "other" } } });
	const other = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(other.text).toMatch(/^memory_full: with this note the memory index of the user scope and project other's scope would be 8300 bytes/);
	pika.routes.set("POST memory/notes", { status: 422, body: { error: "memory_full", indexBytes: 8300, indexLines: 150, limitBytes: 8192, limitLines: 200, project: null } });
	const alone = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "h", body: "" });
	expect(alone.text).toMatch(/^memory_full: with this note the user scope's memory index would be 8300 bytes/);

	pika.routes.set("POST memory/notes", { status: 400, body: { error: "bad_request", message: "hook must be one line" } });
	const bad = await callTool(h, "memory_save", { expectedRevision: 0, scope: "user", category: "user", title: "t", hook: "a\nb", body: "" });
	expect(bad).toMatchObject({ isError: true, text: "the pika server refused the request (HTTP 400 bad_request): hook must be one line." });
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
