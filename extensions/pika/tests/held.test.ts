import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireUploader, currentUploader, processStart, releaseUploader, Uploader, type OwnerProcess, type RequestInput } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { exitedPid, waitFor, Workspace } from "./support/runtime.ts";

// Several pi processes share one spool; these uploaders stand in for them, each with its own owner process.
let workspace: Workspace;
let ingest: MockIngest;
const uploaders: Uploader[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => {
	for (const uploader of uploaders.splice(0)) await uploader.stop();
	const current = currentUploader();
	if (current) await releaseUploader(current);
	for (const child of children.splice(0)) child.kill();
	await ingest.stop();
	await workspace.cleanup();
});

const payload = { model: "m", messages: [{ role: "user", content: "hello" }] };
const input = (id: string, at = new Date()): RequestInput => ({ id, sessionId: "s1", seq: 1, at: at.toISOString(), fidelity: "payload", provider: "p", api: "a", model: "m" });
const spooled = async () => (await readdir(join(workspace.pikaDir, "spool", "requests"))).filter((name) => name.endsWith(".json")).sort();

function uploader(url: string, owner?: OwnerProcess): Uploader {
	const created = new Uploader({ url, token: TOKEN, dir: workspace.pikaDir, ...(owner ? { owner } : {}) });
	uploaders.push(created);
	return created;
}

/** Another running process, as an uploader in it records itself. */
async function liveProcess(): Promise<{ child: ChildProcess; owner: OwnerProcess }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	await once(child, "spawn");
	const started = await processStart(child.pid!);
	expect(started).toBeDefined();
	return { child, owner: { pid: child.pid!, host: hostname(), started } };
}

it("uploads the completed copy of a request another process held, completed, and could not upload before it exited", async () => {
	const { child, owner } = await liveProcess();
	const offline = await new MockIngest().reserve();
	const a = uploader(offline.url, owner);
	const id = randomUUID();
	await a.enqueueRequest(input(id), { value: payload }, { awaiting: true });

	const b = uploader(ingest.url);
	await b.ready;
	await b.flush();
	expect(ingest.requests.has(id)).toBe(false);

	await a.completeRequest(id, { assistant: { timestamp: 42, responseId: "resp_1" } });
	await a.stop();
	const exited = once(child, "exit");
	child.kill();
	await exited;

	await b.flush();
	await waitFor(() => ingest.requests.has(id), 5_000, "the request");
	expect(ingest.requests.get(id)!.assistant).toEqual({ timestamp: 42, responseId: "resp_1" });
	expect(ingest.payload(id)).toEqual(payload);
	expect(await spooled()).toEqual([]);
}, 20_000);

it("keeps a request held by a live process, and forgets it once that process uploaded it", async () => {
	const { owner } = await liveProcess();
	const a = uploader(ingest.url, owner);
	const id = randomUUID();
	await a.enqueueRequest(input(id), { value: payload }, { awaiting: true });

	const b = uploader(ingest.url);
	await b.ready;
	await b.flush();
	expect(ingest.requests.has(id)).toBe(false);
	expect(b.status().queuedItems).toBe(2);

	await a.completeRequest(id, { assistant: { timestamp: 42 } });
	await a.flush();
	expect(ingest.requests.get(id)!.assistant).toEqual({ timestamp: 42 });
	expect(await spooled()).toEqual([]);

	await b.flush();
	expect(b.status()).toMatchObject({ queuedItems: 0, queuedBytes: 0 });
	expect(ingest.requestReceipts.get(id)).toBe(1);
}, 20_000);

it("uploads a held request as it is once its process is gone, also when another process now has its pid", async () => {
	const { owner: live } = await liveProcess();
	const offline = await new MockIngest().reserve();
	const hold = async (owner: OwnerProcess, at?: Date) => {
		const id = randomUUID();
		const a = uploader(offline.url, owner);
		await a.enqueueRequest(input(id, at), { value: payload }, { awaiting: true });
		await a.stop();
		return id;
	};
	const exited = await hold({ ...live, pid: exitedPid() });
	const reused = await hold({ ...live, started: "Thu Jan  1 00:00:00 1970" });
	const held = await hold(live);
	const elsewhere = await hold({ ...live, host: "elsewhere.invalid" });
	const elsewhereLongAgo = await hold({ ...live, host: "elsewhere.invalid" }, new Date(Date.now() - 7 * 60 * 60 * 1000));

	const b = uploader(ingest.url);
	await b.ready;
	await b.flush();
	expect([...ingest.requests.keys()].sort()).toEqual([exited, reused, elsewhereLongAgo].sort());
	for (const request of ingest.requests.values()) {
		expect(request.assistant).toBeUndefined();
		expect(request).not.toHaveProperty("awaiting");
		expect(ingest.payload(request.id)).toEqual(payload);
	}
	expect(await spooled()).toEqual([`${held}.json`, `${elsewhere}.json`].sort());
}, 20_000);

it("holds a call that is still streaming when the uploader in its process is replaced, until it completes", async () => {
	const other = await new MockIngest().start();
	try {
		const dir = workspace.pikaDir;
		const first = acquireUploader({ url: ingest.url, token: TOKEN, dir });
		const id = randomUUID();
		const spooling = first.enqueueRequest(input(id), { value: payload }, { awaiting: true });
		// For example, pika.json changed before a child session started.
		const second = acquireUploader({ url: other.url, token: TOKEN, dir });
		expect(second).not.toBe(first);
		await spooling;
		await second.ready;
		await second.flush();
		expect(other.requests.has(id)).toBe(false);
		expect(ingest.requests.has(id)).toBe(false);

		await second.completeRequest(id, { assistant: { timestamp: 7 } });
		await second.flush();
		expect(other.requests.get(id)).toMatchObject({ assistant: { timestamp: 7 } });
		expect(other.payload(id)).toEqual(payload);
		expect(await spooled()).toEqual([]);
	} finally { await other.stop(); }
}, 20_000);
