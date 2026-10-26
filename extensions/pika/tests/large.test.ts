import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pikaExtension, { statusText } from "../index.ts";
import { loadConfig } from "../config.ts";
import { currentUploader, MAX_BATCH_BYTES } from "../uploader.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

const HUGE = 20 * 1024 * 1024;

const big = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "big", label: "big", description: "Returns 20 MiB", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "x".repeat(HUGE) }], details: {} }),
	});
};

const units = (body: MockIngest["bodies"][number]) => (body.streams ?? []).reduce((count, stream) => count + stream.lines.length, 0)
	+ (body.blobs?.length ?? 0) + (body.requests?.length ?? 0) + (body.documents?.length ?? 0);
const reconstructs = (id: string) => { try { ingest.payload(id); return true; } catch { return false; } };

async function run(): Promise<{ sessionId: string; file: string; shutdown: () => Promise<void> }> {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [big, pikaExtension], tools: ["big"] });
	h.faux.setResponses([fauxAssistantMessage([fauxToolCall("big", {})]), fauxAssistantMessage("read it"), fauxAssistantMessage("normal")]);
	await h.session.prompt("call big");
	await h.session.prompt("a normal question");
	expect(h.errors).toEqual([]);
	return { sessionId: h.session.sessionId, file: h.session.sessionFile!, shutdown: () => h.shutdown() };
}

it("keeps batches under the budget and sends a 20 MiB block and line alone, so later requests still upload", async () => {
	const h = await run();
	try {
		await waitFor(async () => ingest.data(`session:${h.sessionId}`) === await readText(h.file)
			&& ingest.sessionRequests(h.sessionId).length === 3 && ingest.sessionRequests(h.sessionId).every((request) => reconstructs(request.id)), 15_000, "everything");
		for (const [index, body] of ingest.bodies.entries()) {
			if (ingest.sizes[index]! > MAX_BATCH_BYTES) expect(units(body)).toBe(1);
		}
		expect(ingest.sizes.filter((size) => size > HUGE)).toHaveLength(2);
		// The later request references the same block and does not send it again.
		const sent = ingest.bodies.flatMap((body) => body.blobs ?? []).filter((blob) => blob.data.length > HUGE);
		expect(sent).toHaveLength(1);
		expect(ingest.responses).not.toContain(413);
	} finally { await h.shutdown(); }
}, 40_000);

it("parks a block and a line the server keeps refusing as too large, reports them, and uploads everything else", async () => {
	ingest.maxBody = 4 * 1024 * 1024;
	const h = await run();
	try {
		const key = `session:${h.sessionId}`;
		await waitFor(() => ingest.sessionRequests(h.sessionId).length === 3
			&& (currentUploader()?.status().stoppedStreams.some((stream) => stream.key === key) ?? false), 20_000, "parked items");
		const status = currentUploader()!.status();
		expect(status.parked.items).toBe(1);
		expect(status.parked.bytes).toBeGreaterThan(HUGE);
		expect(await readdir(join(workspace.pikaDir, "spool", "parked"))).toHaveLength(1);
		expect(status.stoppedStreams.find((stream) => stream.key === key)!.reason).toMatch(/413/);
		const text = statusText(loadConfig(workspace.agentDir), true, h.sessionId, undefined);
		expect(text).toMatch(/Parked, too large for the server: 1 item\(s\)/);
		expect(text).toMatch(new RegExp(`Stream ${key} stopped: .*413`));

		// The session uploads up to the refused line; every request arrives, all but the parked block intact.
		const file = await readText(h.file);
		const uploaded = ingest.data(key)!;
		expect(file.startsWith(uploaded)).toBe(true);
		expect(file.slice(uploaded.length).split("\n")[0]!.length).toBeGreaterThan(HUGE);
		const [first, ...later] = ingest.sessionRequests(h.sessionId);
		expect(reconstructs(first!.id)).toBe(true);
		for (const request of later) expect(request.blocks.filter((hash) => !ingest.blobs.has(hash))).toHaveLength(1);
		for (const size of ingest.sizes) expect(size).toBeLessThanOrEqual(MAX_BATCH_BYTES);

		// Nothing else is retried.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const sent = ingest.responses.length;
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(ingest.responses.length).toBe(sent);
		expect(ingest.responses.filter((code) => code === 413)).toHaveLength(6);
	} finally { await h.shutdown(); }
}, 40_000);
