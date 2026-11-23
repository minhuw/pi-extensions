import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { splitPayload } from "../blocks.ts";
import pikaExtension from "../index.ts";
import { Store, type SpooledRequest } from "../store.ts";
import { currentUploader, readLines, Uploader, type RequestInput } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { vi.restoreAllMocks(); await ingest.stop(); await workspace.cleanup(); });

const within = <T>(promise: Promise<T>, ms: number) =>
	Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms).unref())]);

it("uploads every entry verbatim within 5 s, with offsets that rebuild the session file byte for byte", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const key = `session:${h.session.sessionId}`;
		const file = h.session.sessionFile!;
		await h.session.prompt("hello");
		const elapsed = await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "first upload");
		expect(elapsed).toBeLessThan(5_000);

		await h.session.prompt("again");
		await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "second upload");

		// Each batch's offset is the byte offset of its first line in the file.
		const text = await readText(file);
		for (const body of ingest.bodies) {
			for (const stream of body.streams ?? []) {
				const bytes = stream.lines.map((line) => `${line}\n`).join("");
				expect(Buffer.from(text).subarray(stream.offset, stream.offset + Buffer.byteLength(bytes)).toString()).toBe(bytes);
				expect(stream).toMatchObject({ kind: "session", path: file });
			}
			expect(body.client).toMatchObject({ pikaVersion: expect.any(String), host: expect.any(String) });
		}
		expect(ingest.headers.every((headers) => headers["content-encoding"] === "gzip")).toBe(true);
		expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({ type: "session", id: h.session.sessionId });
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("recovers from a 409 gap by resending from the server's length", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const key = `session:${h.session.sessionId}`;
		const file = h.session.sessionFile!;
		await h.session.prompt("one");
		await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "first upload");

		// The server loses everything after the header line.
		const stored = ingest.streams.get(key)!;
		stored.data = stored.data.subarray(0, stored.data.indexOf(0x0a) + 1);
		await h.session.prompt("two");
		await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "upload after the gap");
		expect(ingest.gaps).toContain(key);
		expect(ingest.responses).toContain(409);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("keeps the spool and the cursor when a 200 is not an ingest answer, and delivers once the server answers", async () => {
	await workspace.enable(ingest.url);
	ingest.mode = "page";
	const spooled = async () => (await readdir(join(workspace.pikaDir, "spool", "requests")).catch(() => [])).filter((name) => !name.endsWith(".tmp"));
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("one")]);
		const key = `session:${h.session.sessionId}`;
		await h.session.prompt("one");
		await waitFor(() => /answered 200 without an ingest result/.test(currentUploader()?.status().lastError ?? ""), 5_000, "upload error");
		await waitFor(async () => (await spooled()).length === 1, 3_000, "spooled request");
		// The request is in at least one refused batch before the server recovers.
		const sent = ingest.responses.length;
		await waitFor(() => ingest.responses.length > sent, 5_000, "another refused batch");
		expect(ingest.responses.every((status) => status === 200)).toBe(true);
		expect(await spooled()).toHaveLength(1);
		const cursor = JSON.parse(await readFile(join(workspace.pikaDir, "streams", `${encodeURIComponent(key)}.json`), "utf8")) as { length: number };
		expect(cursor.length).toBe(0);

		ingest.mode = "ok";
		await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!) && ingest.sessionRequests(h.session.sessionId).length === 1, 10_000, "delivery");
		await waitFor(async () => (await spooled()).length === 0, 2_000, "empty spool");
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 30_000);

it("stops a stream on a 409 conflict and reports it", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("one")]);
		const key = `session:${h.session.sessionId}`;
		ingest.streams.set(key, { kind: "session", data: Buffer.from(`${"x".repeat(5000)}\n`) });
		await h.session.prompt("one");
		await waitFor(() => ingest.conflicts.includes(key), 5_000, "conflict");
		await waitFor(() => currentUploader()?.status().stoppedStreams.some((stream) => stream.key === key) ?? false, 2_000, "stopped stream");
		expect(currentUploader()!.status().stoppedStreams[0]!.reason).toMatch(/conflict/);
	} finally { await h.shutdown(); }
}, 20_000);

it("leaves no state behind for a session that never wrote a file", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	const key = `session:${h.session.sessionId}`;
	await h.shutdown();
	expect(existsSync(h.session.sessionFile!)).toBe(false);
	expect(existsSync(join(workspace.pikaDir, "streams", `${encodeURIComponent(key)}.json`))).toBe(false);
	expect(ingest.bodies).toEqual([]);
}, 10_000);

it("uploads only sessions started or resumed while enabled", async () => {
	const disabled = await startSession({ workspace, extensions: [pikaExtension] });
	let oldFile: string;
	let oldId: string;
	try {
		disabled.faux.setResponses([fauxAssistantMessage("before")]);
		await disabled.session.prompt("before enabling");
		oldFile = disabled.session.sessionFile!;
		oldId = disabled.session.sessionId;
	} finally { await disabled.shutdown(); }

	await workspace.enable(ingest.url);
	const fresh = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		fresh.faux.setResponses([fauxAssistantMessage("after")]);
		await fresh.session.prompt("after enabling");
		const key = `session:${fresh.session.sessionId}`;
		await waitFor(async () => ingest.data(key) === await readText(fresh.session.sessionFile!), 5_000, "new session upload");
		expect(ingest.streams.has(`session:${oldId}`)).toBe(false);
	} finally { await fresh.shutdown(); }

	const resumed = await startSession({ workspace, extensions: [pikaExtension], sessionManager: SessionManager.open(oldFile, workspace.sessionDir) });
	try {
		expect(resumed.session.sessionId).toBe(oldId);
		await waitFor(async () => ingest.data(`session:${oldId}`) === await readText(oldFile), 5_000, "resumed session upload");
	} finally { await resumed.shutdown(); }
}, 30_000);

it.each([
	{ name: "a cwd prefix in the exclude list", setup: (w: Workspace, url: string) => w.enable(url, { exclude: [w.cwd] }) },
	{ name: "a glob in the exclude list", setup: (w: Workspace, url: string) => w.enable(url, { exclude: [`${w.root}/*`] }) },
	{ name: "PIKA_DISABLED=1", setup: async (w: Workspace, url: string) => { await w.enable(url); process.env.PIKA_DISABLED = "1"; } },
	{ name: "enabled: false", setup: (w: Workspace, url: string) => w.enable(url, { enabled: false }) },
])("uploads nothing with $name", async ({ setup }) => {
	await setup(workspace, ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("quiet")]);
		await h.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(ingest.bodies).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); delete process.env.PIKA_DISABLED; }
}, 20_000);

it("takes the server URL and token from the environment", async () => {
	process.env.PIKA_URL = ingest.url;
	process.env.PIKA_TOKEN = "test-token";
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("env")]);
		await h.session.prompt("hello");
		await waitFor(async () => ingest.data(`session:${h.session.sessionId}`) === await readText(h.session.sessionFile!), 5_000, "upload");
	} finally { await h.shutdown(); delete process.env.PIKA_URL; delete process.env.PIKA_TOKEN; }
}, 20_000);

it("reads no lines when the file ends before the expected end without a newline", async () => {
	// The file was truncated or replaced after its size was taken.
	const file = join(workspace.root, "short.jsonl");
	await writeFile(file, '{"type":"message"}\npartial');
	expect(await within(readLines(file, 0, 4096, 1024), 2_000)).toEqual(['{"type":"message"}']);
	expect(await within(readLines(file, 19, 4096, 1024), 2_000)).toEqual([]);
	expect(await within(readLines(file, 100, 4096, 1024), 2_000)).toEqual([]);
});

it("stops within a bounded time when a flush is stuck", async () => {
	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	await uploader.ready;
	const build = vi.spyOn(uploader as unknown as { build: () => Promise<unknown> }, "build").mockImplementation(() => new Promise(() => {}));
	void uploader.flush();
	await waitFor(() => build.mock.calls.length > 0, 2_000, "a stuck flush");
	const started = Date.now();
	expect(await within(uploader.stop(), 5_000)).toBeUndefined();
	expect(Date.now() - started).toBeLessThan(2_000);
}, 10_000);

const uploaderBlobs = (uploader: Uploader) =>
	(uploader as unknown as { blobs: Map<string, { size: number; refs: number; text?: string }> }).blobs;

const requestInput = (id: string, fidelity: RequestInput["fidelity"] = "payload"): RequestInput => ({
	id, sessionId: "s-reconcile", seq: 1, at: new Date().toISOString(), fidelity, provider: "p", api: "a", model: "m",
});

const spooledNames = async (subdir: "requests" | "blobs") =>
	(await readdir(join(workspace.pikaDir, "spool", subdir)).catch(() => [])).filter((name) => !name.endsWith(".tmp"));

it("snapshots requests before blobs in load() so a concurrently spooled request never loses its blocks", async () => {
	const payload = { model: "m", messages: [{ role: "user", content: "concurrent cross-process spool" }] };
	const split = splitPayload(payload);
	const [hash] = split.blocks as [string];
	const text = split.data.get(hash)!;
	const id = randomUUID();
	const record: SpooledRequest = { ...requestInput(id), skeleton: split.skeleton, blocks: split.blocks };

	const calls: string[] = [];
	const origLoadRequests = Store.prototype.loadRequests;
	const origListBlobs = Store.prototype.listBlobs;
	let injected = false;
	vi.spyOn(Store.prototype, "loadRequests").mockImplementation(async function (this: Store) {
		calls.push("loadRequests");
		if (!injected) {
			injected = true;
			// Simulate another process spooling blob -> request right as loadRequests runs.
			await this.saveBlob(hash, text);
			await this.saveRequest(record);
		}
		return origLoadRequests.call(this);
	});
	vi.spyOn(Store.prototype, "listBlobs").mockImplementation(async function (this: Store) {
		calls.push("listBlobs");
		return origListBlobs.call(this);
	});

	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		await uploader.ready;
		expect(calls.indexOf("loadRequests")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("listBlobs")).toBeGreaterThan(calls.indexOf("loadRequests"));
		expect(uploaderBlobs(uploader).get(hash)).toEqual({ size: Buffer.byteLength(text), refs: 1 });

		await uploader.flush();
		expect(ingest.payload(id)).toEqual(payload);
		expect(uploaderBlobs(uploader).size).toBe(0);
		expect(await spooledNames("requests")).toEqual([]);
		expect(await spooledNames("blobs")).toEqual([]);
		expect(uploader.status().lastError).toBeUndefined();
	} finally { await uploader.stop(); }
}, 10_000);

it("reconciles this.blobs in reload() when another process replaces a held request with different blocks", async () => {
	const offline = await new MockIngest().reserve();
	const otherOwner = { pid: 1, machine: "other-machine" };
	const writer = new Uploader({ url: offline.url, token: TOKEN, dir: workspace.pikaDir, owner: otherOwner });
	try {
		const id = randomUUID();
		const sharedId = randomUUID();
		const ctxMsg = { role: "user", content: "initial context block" };
		const sharedMsg = { role: "user", content: "shared payload block" };
		const uniqueMsg = { role: "assistant", content: "brand-new payload block" };
		const ctxPayload = { messages: [ctxMsg] };
		const sharedPayload = { model: "m", messages: [sharedMsg] };
		const payPayload = { model: "m", messages: [sharedMsg, uniqueMsg] };
		const [hCtx] = splitPayload(ctxPayload).blocks as [string];
		const [hShared, hUnique] = splitPayload(payPayload).blocks as [string, string];

		await writer.enqueueRequest(requestInput(id, "context"), { value: ctxPayload }, { awaiting: true });
		// A second held request in the same spool shares hShared so reload() must increment its refs,
		// while hUnique only appears on disk when the first request is replaced.
		await writer.enqueueRequest(requestInput(sharedId, "payload"), { value: sharedPayload }, { awaiting: true });

		const b = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
		try {
			await b.ready;
			await b.flush();
			expect(ingest.requests.size).toBe(0);
			expect(uploaderBlobs(b).get(hCtx)).toMatchObject({ refs: 1 });
			expect(uploaderBlobs(b).get(hShared)).toMatchObject({ refs: 1 });
			expect(uploaderBlobs(b).has(hUnique)).toBe(false);

			// Writer replaces context with payload (hCtx -> [hShared, hUnique]) and completes only the first request.
			await writer.enqueueRequest(requestInput(id, "payload"), { value: payPayload }, { awaiting: true });
			await writer.completeRequest(id, { assistant: { timestamp: 99 } });

			await b.flush();
			expect(ingest.requests.get(id)).toMatchObject({ fidelity: "payload", assistant: { timestamp: 99 } });
			expect(ingest.payload(id)).toEqual(payPayload);
			// hCtx was dropped on reload; hUnique was uploaded and cleaned up; hShared still has 1 ref for sharedId.
			expect(uploaderBlobs(b).has(hCtx)).toBe(false);
			expect(uploaderBlobs(b).has(hUnique)).toBe(false);
			expect(uploaderBlobs(b).get(hShared)).toMatchObject({ refs: 1 });
			expect(await spooledNames("blobs")).toEqual([hShared]);
			expect(b.status().lastError).toBeUndefined();

			// Completing the second request uploads cleanly and drains the remaining block.
			await writer.completeRequest(sharedId, { assistant: { timestamp: 100 } });
			await b.flush();
			expect(ingest.payload(sharedId)).toEqual(sharedPayload);
			expect(uploaderBlobs(b).size).toBe(0);
			expect(await spooledNames("requests")).toEqual([]);
			expect(await spooledNames("blobs")).toEqual([]);
			expect(b.status().lastError).toBeUndefined();
		} finally { await b.stop(); }
	} finally { await writer.stop(); }
}, 15_000);

it("reconciles this.blobs in reload() when a request's block appears on disk after load()", async () => {
	const store = new Store(workspace.pikaDir);
	await store.init();
	const payload = { model: "m", messages: [{ role: "user", content: "late-arriving blob" }] };
	const split = splitPayload(payload);
	const [hash] = split.blocks as [string];
	const text = split.data.get(hash)!;
	const id = randomUUID();
	const heldRecord: SpooledRequest = {
		...requestInput(id), skeleton: split.skeleton, blocks: split.blocks,
		awaiting: { pid: 1, owner: "remote", machine: "other-machine" },
	};
	// Only the request file exists when the uploader loads (e.g., another process had the block in memory).
	await store.saveRequest(heldRecord);

	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		await uploader.ready;
		await uploader.flush();
		expect(uploaderBlobs(uploader).has(hash)).toBe(false);
		expect(ingest.requests.has(id)).toBe(false);

		// Another process persists the block and releases the request.
		await store.saveBlob(hash, text);
		const { awaiting: _, ...released } = heldRecord;
		await store.saveRequest(released);

		await uploader.flush();
		expect(ingest.payload(id)).toEqual(payload);
		expect(uploaderBlobs(uploader).size).toBe(0);
		expect(await spooledNames("requests")).toEqual([]);
		expect(await spooledNames("blobs")).toEqual([]);
		expect(uploader.status().lastError).toBeUndefined();
	} finally { await uploader.stop(); }
}, 10_000);

it("reconciles this.blobs in accepted() when a missing block appears on disk before the response is handled", async () => {
	const store = new Store(workspace.pikaDir);
	await store.init();
	const payload = { model: "m", messages: [{ role: "user", content: "blob written before accepted" }] };
	const split = splitPayload(payload);
	const [hash] = split.blocks as [string];
	const text = split.data.get(hash)!;
	const id = randomUUID();
	await store.saveRequest({ ...requestInput(id), skeleton: split.skeleton, blocks: split.blocks });

	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		await uploader.ready;
		expect(uploaderBlobs(uploader).has(hash)).toBe(false);

		// Write the blob to disk after the first batch is posted (server returns missingBlobs) and before accepted() runs.
		const origPost = (uploader as unknown as { post: (body: Buffer) => Promise<{ status: number; text: string }> }).post.bind(uploader);
		let wrote = false;
		vi.spyOn(uploader as unknown as { post: (body: Buffer) => Promise<{ status: number; text: string }> }, "post").mockImplementation(async (body) => {
			const response = await origPost(body);
			if (!wrote) {
				wrote = true;
				await store.saveBlob(hash, text);
			}
			return response;
		});

		await uploader.flush();
		expect(ingest.requestReceipts.get(id)).toBe(2);
		expect(ingest.payload(id)).toEqual(payload);
		expect(uploaderBlobs(uploader).size).toBe(0);
		expect(await spooledNames("requests")).toEqual([]);
		expect(await spooledNames("blobs")).toEqual([]);
		expect(uploader.status().lastError).toBeUndefined();
	} finally { await uploader.stop(); }
}, 10_000);

it("does not drop a replaced request or corrupt blob refs when accepted() handles an earlier in-flight version", async () => {
	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		await uploader.ready;
		const id = randomUUID();
		const oldPayload = { model: "m", messages: [{ role: "user", content: "in-flight old payload" }] };
		const newPayload = { model: "m", messages: [{ role: "user", content: "replacement payload" }] };
		const [hNew] = splitPayload(newPayload).blocks as [string];

		const origPost = (uploader as unknown as { post: (body: Buffer) => Promise<{ status: number; text: string }> }).post.bind(uploader);
		let replaced = false;
		vi.spyOn(uploader as unknown as { post: (body: Buffer) => Promise<{ status: number; text: string }> }, "post").mockImplementation(async (body) => {
			const response = await origPost(body);
			if (!replaced) {
				replaced = true;
				await uploader.enqueueRequest(requestInput(id, "payload"), { value: newPayload });
			}
			return response;
		});

		await uploader.enqueueRequest(requestInput(id, "context"), { value: oldPayload });
		await uploader.flush();
		await waitFor(() => ingest.requestReceipts.get(id) === 2, 5_000, "replacement uploaded");
		await uploader.flush();
		expect(ingest.bodies.flatMap((body) => body.requests ?? []).map((request) => request.fidelity)).toEqual(["context", "payload"]);
		expect(ingest.blobs.has(hNew)).toBe(true);
		expect(uploaderBlobs(uploader).has(hNew)).toBe(false);
		expect(uploaderBlobs(uploader).size).toBe(0);
		expect(await spooledNames("requests")).toEqual([]);
		expect(await spooledNames("blobs")).toEqual([]);
		expect(uploader.status().lastError).toBeUndefined();
	} finally { await uploader.stop(); }
}, 10_000);
