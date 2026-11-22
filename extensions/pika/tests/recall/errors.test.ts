import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { get, timing } from "../../recall/client.ts";
import { FakePika } from "../support/pika-server.ts";
import { callTool, type Harness, setCredentials, startSession, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let pika: FakePika;
let h: Harness;
beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	setCredentials(pika.url);
	h = await startSession({ workspace });
});
afterEach(async () => {
	await h.shutdown();
	await pika.stop();
	await workspace.cleanup();
});

it("without credentials, both tools fail and ask for /pika login", async () => {
	setCredentials(undefined);
	const message = "recall needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login.";
	expect(await callTool(h, "recall_search", { query: "x" })).toMatchObject({ isError: true, text: message });
	expect(await callTool(h, "recall_read", { sessionId: "s-1" })).toMatchObject({ isError: true, text: message });
	expect(await callTool(h, "recall_herder", {})).toMatchObject({ isError: true, text: message });
	expect(pika.requests).toEqual([]);
});

it("refuses recall_search, recall_read, and recall_herder when cwd matches pika's exclude list, with zero HTTP requests", async () => {
	const message = `pika's exclude list covers this session's working directory (${workspace.cwd}), so recall is off in this session.`;
	const calls: [string, Parameters<typeof callTool>[2]][] = [
		["recall_search", { query: "x" }],
		["recall_search", { query: "x", scope: "project" }],
		["recall_read", { sessionId: "s-1" }],
		["recall_read", { sessionId: "s-1", seq: 1 }],
		["recall_herder", {}],
		["recall_herder", { scope: "project" }],
		["recall_herder", { runId: "r-1" }],
	];
	for (const exclude of [[workspace.cwd], [`${workspace.root}/my-*`]]) {
		let resolved = 0;
		setCredentials(pika.url, { exclude, repository: async () => { resolved++; return { project: "p" }; } });
		for (const [name, args] of calls) {
			expect(await callTool(h, name, args)).toMatchObject({ isError: true, text: message });
		}
		expect(pika.requests).toEqual([]);
		expect(resolved).toBe(0);
	}

	// An exclude list that does not match cwd allows every recall tool through.
	setCredentials(pika.url, { exclude: [`${workspace.root}/other`] });
	pika.routes.set("search", { body: { items: [], nextCursor: null } });
	pika.routes.set("sessions/s-1", { body: { id: "s-1", children: [] } });
	pika.routes.set("sessions/s-1/trace", { body: { turns: [], records: [], children: [] } });
	pika.routes.set("sessions/s-1/turns", { body: { items: [], nextCursor: null } });
	pika.routes.set("herder/runs", { body: { items: [], nextCursor: null } });
	expect((await callTool(h, "recall_search", { query: "x" })).isError).toBe(false);
	expect((await callTool(h, "recall_read", { sessionId: "s-1" })).isError).toBe(false);
	expect((await callTool(h, "recall_herder", {})).isError).toBe(false);
});

it("maps a rejected token to /pika login", async () => {
	setCredentials(pika.url, { token: "revoked" });
	const result = await callTool(h, "recall_search", { query: "x" });
	expect(pika.requests[0]!.authorization).toBe("Bearer revoked");
	expect(result).toMatchObject({ isError: true, text: `the pika server at ${pika.url} rejected this device's token (HTTP 401). Ask the user to run /pika login to pair this device again.` });
});

it("maps a device without read access to how to grant it", async () => {
	pika.readAccess = false;
	const result = await callTool(h, "recall_read", { sessionId: "s-1" });
	expect(result).toMatchObject({
		isError: true,
		text: "this device may not read trajectories from the pika server (HTTP 403 read_access_denied). Ask the user to grant it read access: "
			+ `turn on "Agents can read" for this device on ${pika.url}/devices, or run \`pika token read-access <device> on\` on the server.`,
	});
});

it("tells a server without the agent API from an unknown session", async () => {
	pika.features = ["relay"];
	const old = `the pika server at ${pika.url} has no agent read API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.`;
	expect(await callTool(h, "recall_search", { query: "x" })).toMatchObject({ isError: true, text: old });
	expect(await callTool(h, "recall_read", { sessionId: "s-1", seq: 3 })).toMatchObject({ isError: true, text: old });
	pika.features = ["relay", "agent"];
	expect(await callTool(h, "recall_read", { sessionId: "nope" })).toMatchObject({ isError: true, text: "no recorded session has id nope; use the full sessionId or find it with recall_search." });
});

it("reports other HTTP failures with their status and code", async () => {
	pika.routes.set("search", { status: 400, body: { error: "bad_request" } });
	expect(await callTool(h, "recall_search", { query: "x" })).toMatchObject({ isError: true, text: `unexpected HTTP 400 (bad_request) from the pika server at ${pika.url}.` });
});

it("reports an unreachable server and a server that does not answer in time", async () => {
	const url = pika.url;
	await pika.stop();
	const down = await callTool(h, "recall_search", { query: "x" });
	expect(down.isError).toBe(true);
	expect(down.text).toMatch(new RegExp(`^could not reach the pika server at ${url.replace(/\./g, "\\.")}: .+\\.$`));

	pika = await new FakePika().start();
	setCredentials(pika.url);
	timing.httpTimeoutMs = 200;
	pika.routes.set("search", { delayMs: 2_000, body: { items: [] } });
	const started = Date.now();
	const slow = await callTool(h, "recall_search", { query: "x" });
	expect(Date.now() - started).toBeLessThan(1_500);
	expect(slow).toMatchObject({ isError: true, text: `could not reach the pika server at ${pika.url}: no answer within 0.2 s.` });
});

it("stops a request when the tool call is aborted", async () => {
	pika.routes.set("search", { delayMs: 5_000, body: { items: [] } });
	h.faux.appendResponses([fauxAssistantMessage([fauxToolCall("recall_search", { query: "x" })], { stopReason: "toolUse" })]);
	const started = Date.now();
	const run = h.session.prompt("search");
	while (!pika.requestsTo("search").length) await new Promise((resolve) => setTimeout(resolve, 10));
	await h.session.abort();
	await run;
	expect(Date.now() - started).toBeLessThan(3_000);
	const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "recall_search") as { isError: boolean; content: { text?: string }[] } | undefined;
	expect(result).toMatchObject({ isError: true, content: [{ text: "recall was cancelled." }] });
});

it("refuses a server URL containing credentials without sending HTTP requests or repeating them", async () => {
	setCredentials(pika.url.replace("http://", "http://alice:secret@"));
	const expected = "pika's server URL contains a user name or password, which pika never sends, so recall is off. Ask the user to remove them from PIKA_URL or the url in pika.json.";
	for (const [name, args] of [
		["recall_search", { query: "x" }],
		["recall_read", { sessionId: "s-1" }],
		["recall_herder", {}],
	] as const) {
		const result = await callTool(h, name, args);
		expect(result).toMatchObject({ isError: true, text: expected });
		expect(result.text).not.toContain("alice");
		expect(result.text).not.toContain("secret");
	}
	expect(pika.requests).toEqual([]);
});

it("scrubs URL credentials from transport errors", async () => {
	const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("failed to reach https://alice:topsecret@pika.example/api/agent/v1/search"));
	try {
		const result = await callTool(h, "recall_search", { query: "x" });
		expect(result).toMatchObject({
			isError: true,
			text: `could not reach the pika server at ${pika.url}: failed to reach https://pika.example/api/agent/v1/search.`,
		});
		expect(result.text).not.toContain("alice");
		expect(result.text).not.toContain("topsecret");
	} finally {
		spy.mockRestore();
	}
});

it("names why pika is disabled instead of asking for /pika login and scrubs credentials", async () => {
	setCredentials(undefined);
	const search = () => callTool(h, "recall_search", { query: "x" });
	const savedDisabled = process.env.PIKA_DISABLED;
	try {
		process.env.PIKA_DISABLED = "1";
		expect(await search()).toMatchObject({ isError: true, text: "recall is off because pika is disabled: PIKA_DISABLED=1 is set. Tell the user; /pika shows why." });
	} finally {
		if (savedDisabled === undefined) delete process.env.PIKA_DISABLED;
		else process.env.PIKA_DISABLED = savedDisabled;
	}
	const file = join(workspace.agentDir, "pika.json");
	await writeFile(file, JSON.stringify({ url: "https://alice:secret@pika.example", token: "pika_secret_token" }));
	const creds = await search();
	expect(creds).toMatchObject({ isError: true, text: `recall is off because pika is disabled: invalid server url in ${file}: the server URL must not contain credentials. Tell the user; /pika shows why.` });
	expect(creds.text).not.toContain("alice");
	expect(creds.text).not.toContain("secret");
	await rm(file);
	expect(await search()).toMatchObject({ isError: true, text: "recall needs the pika extension logged in to a pika server, and it is not. Ask the user to run /pika login." });
	expect(pika.requests).toEqual([]);
});

it("reports a timeout or an abort while the answer arrives as such, not as an unreadable answer", async () => {
	const stalling = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"items":['); });
	await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(stalling.address() as AddressInfo).port}`;
	try {
		setCredentials(url);
		timing.httpTimeoutMs = 300;
		expect(await callTool(h, "recall_search", { query: "x" })).toMatchObject({ isError: true, text: `the pika server at ${url} did not finish its answer within 0.3 s.` });
		timing.httpTimeoutMs = 15_000;
		const controller = new AbortController();
		const reading = get(workspace.cwd, "search?q=x", { signal: controller.signal, missing: "missing" });
		setTimeout(() => controller.abort(), 200);
		await expect(reading).rejects.toThrow(/^recall was cancelled\.$/);
	} finally {
		stalling.closeAllConnections();
		await new Promise((resolve) => stalling.close(resolve));
	}
});
