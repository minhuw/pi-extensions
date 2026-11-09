import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { timing } from "../../recall/client.ts";
import { FakePika } from "./support/pika-server.ts";
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
	expect(pika.requests).toEqual([]);
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
