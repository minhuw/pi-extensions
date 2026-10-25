import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import pikaExtension from "../index.ts";
import { currentUploader } from "../uploader.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().reserve(); });
afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

const spooled = async (dir: "requests" | "blobs") => (await readdir(join(workspace.pikaDir, "spool", dir)).catch(() => [])).filter((name) => !name.endsWith(".tmp"));
const cursor = async (key: string) => JSON.parse(await readFile(join(workspace.pikaDir, "streams", `${encodeURIComponent(key)}.json`), "utf8")) as { length: number };

function expectExactlyOnce(): void {
	expect(ingest.gaps).toEqual([]);
	expect(ingest.conflicts).toEqual([]);
	expect([...ingest.requestReceipts.values()].every((count) => count === 1)).toBe(true);
}

it("spools while the server is down and delivers everything exactly once when it comes up", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.prompt("first");
		await h.session.prompt("second");
		const key = `session:${h.session.sessionId}`;
		await waitFor(async () => (await spooled("requests")).length === 2, 3_000, "spooled requests");
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect((await cursor(key)).length).toBe(0);
		expect(currentUploader()!.status()).toMatchObject({ queuedItems: expect.any(Number), lastError: expect.stringMatching(/upload failed/) });
		expect(currentUploader()!.status().queuedItems).toBeGreaterThan(2);

		await ingest.start();
		await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!) && ingest.sessionRequests(h.session.sessionId).length === 2, 10_000, "delivery");
		expectExactlyOnce();
		await waitFor(async () => (await spooled("requests")).length === 0 && (await spooled("blobs")).length === 0, 2_000, "empty spool");
		expect((await cursor(key)).length).toBe(Buffer.byteLength(await readText(h.session.sessionFile!)));
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 30_000);

it("delivers what an earlier pi process left behind when pi starts again", async () => {
	await workspace.enable(ingest.url);
	const first = await startSession({ workspace, extensions: [pikaExtension] });
	let file: string;
	let id: string;
	try {
		first.faux.setResponses([fauxAssistantMessage("offline answer")]);
		await first.session.prompt("while offline");
		file = first.session.sessionFile!;
		id = first.session.sessionId;
	} finally { await first.shutdown(); }
	// The last session shut down, so the process-wide uploader is gone, as after a restart.
	expect(currentUploader()).toBeUndefined();
	expect(await spooled("requests")).toHaveLength(1);
	expect((await cursor(`session:${id}`)).length).toBe(0);

	await ingest.start();
	const second = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		await waitFor(async () => ingest.data(`session:${id}`) === await readText(file) && ingest.sessionRequests(id).length === 1, 10_000, "delivery after restart");
		expect(ingest.sessionRequests(id)[0]).toMatchObject({ fidelity: "context", assistant: { timestamp: expect.any(Number) } });
		expectExactlyOnce();
		await waitFor(async () => (await spooled("requests")).length === 0, 2_000, "empty spool");
	} finally { await second.shutdown(); }

	// A third start has nothing left to send.
	const sent = ingest.bodies.length;
	const third = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(ingest.bodies.length).toBe(sent);
	} finally { await third.shutdown(); }
}, 30_000);
