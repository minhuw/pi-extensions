import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import pikaExtension from "../index.ts";
import { currentUploader, readLines, Uploader } from "../uploader.ts";
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
