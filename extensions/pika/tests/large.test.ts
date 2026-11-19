import { appendFileSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pikaExtension, { statusText } from "../index.ts";
import { loadConfig } from "../config.ts";
import { BUDGET_RECOVERY_STEP, BUDGET_RECOVERY_STREAK, currentUploader, MAX_BATCH_BYTES, Uploader } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
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

		// Nothing else is retried. Only batch requests count: relay retries its health check, which this server answers with 404, on its own schedule.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const sent = ingest.batchRequests;
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(ingest.batchRequests).toBe(sent);
		expect(ingest.responses.filter((code) => code === 413)).toHaveLength(6);
	} finally { await h.shutdown(); }
}, 40_000);

it("additively restores the batch budget after accepted streaks and resets the streak on another 413", async () => {
	const MiB = 1024 * 1024;
	const halfMiBLine = `${"x".repeat(512 * 1024)}\n`;
	const key = "session:budget-recovery";
	const file = join(workspace.sessionDir, "budget-recovery.jsonl");
	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		await uploader.openStream({ key, kind: "session", path: file });
		await uploader.flush();

		const sendAndMeasure = async (content: string) => {
			const before = ingest.bodies.length;
			appendFileSync(file, content);
			await uploader.flush();
			await waitFor(() => ingest.data(key) === readFileSync(file, "utf8"), 5_000, "stream caught up");
			return ingest.bodies.slice(before).map((body) => body.streams?.reduce((count, stream) => count + stream.lines.length, 0) ?? 0);
		};
		const sendSmallBatches = async (count: number) => {
			for (let i = 0; i < count; i++) expect(await sendAndMeasure("ok\n")).toEqual([1]);
		};

		// A transient 413 on a multi-unit batch (~5 MiB) halves the budget (~3.97 MiB, fitting 7 half-MiB lines).
		ingest.maxBody = 4 * MiB;
		const afterFirst413 = await sendAndMeasure(halfMiBLine.repeat(10));
		expect(ingest.responses).toEqual([413, 200, 200]);
		expect(afterFirst413).toEqual([7, 3]);
		ingest.maxBody = Number.POSITIVE_INFINITY;

		// Before completing BUDGET_RECOVERY_STREAK accepted batches (currently at 2), budget stays halved.
		await sendSmallBatches(BUDGET_RECOVERY_STREAK - 3);
		// Batch #10 is built under the halved budget (7 lines), then its acceptance completes the streak
		// and raises the budget by one additive step (~4.97 MiB, fitting 9 half-MiB lines); batch #11 sends the 1 remaining line (streak = 1).
		expect(await sendAndMeasure(halfMiBLine.repeat(8))).toEqual([7, 1]);

		// Budget grew additively by one step (9 lines > 7), not straight back to MAX_BATCH_BYTES (12 lines still split).
		expect(await sendAndMeasure(halfMiBLine.repeat(12))).toEqual([9, 3]);

		// Advance to one batch short of the next recovery step (streak is 1 + 2 = 3), then trigger a single-unit 413.
		await sendSmallBatches(BUDGET_RECOVERY_STREAK - 4);
		ingest.maxBody = 100;
		const beforeSingle413 = ingest.responses.length;
		appendFileSync(file, "ok\n");
		await uploader.flush();
		expect(ingest.responses.slice(beforeSingle413)).toEqual([413]);
		ingest.maxBody = Number.POSITIVE_INFINITY;
		await uploader.drain(5_000);
		expect(ingest.responses.slice(beforeSingle413)).toEqual([413, 200]);
		// Because the 413 reset the streak to 0, budget stayed at step 1 (9 lines, not step 2's 11 lines).
		expect(await sendAndMeasure(halfMiBLine.repeat(12))).toEqual([9, 3]);

		// Advance again to one batch short of recovery (streak is 1 + 2 = 3), then trigger a multi-unit 413.
		// Budget halves from ~4.97 MiB to ~2.48 MiB (fitting 4 half-MiB lines) and the streak resets to 0.
		await sendSmallBatches(BUDGET_RECOVERY_STREAK - 4);
		ingest.maxBody = 3 * MiB;
		const beforeSecond413 = ingest.responses.length;
		expect(await sendAndMeasure(halfMiBLine.repeat(8))).toEqual([4, 4]);
		expect(ingest.responses.slice(beforeSecond413)).toEqual([413, 200, 200]);
		ingest.maxBody = Number.POSITIVE_INFINITY;
		// Had the streak not been reset, the first 200 above would have raised the budget to ~3.48 MiB (6 lines).
		expect(await sendAndMeasure(halfMiBLine.repeat(6))).toEqual([4, 2]);

		// Complete enough accepted streaks to restore the budget all the way to MAX_BATCH_BYTES, plus an extra streak to verify the cap.
		const halvedTwice = Math.floor((Math.floor(MAX_BATCH_BYTES / 2) + BUDGET_RECOVERY_STEP) / 2);
		const stepsToMax = Math.ceil((MAX_BATCH_BYTES - halvedTwice) / BUDGET_RECOVERY_STEP);
		const currentStreak = 4; // 2 from the split after 413 + 2 from the 6-line probe
		await sendSmallBatches((stepsToMax + 1) * BUDGET_RECOVERY_STREAK - currentStreak);

		// At MAX_BATCH_BYTES (~7.94 MiB), 15 half-MiB lines fit in one batch (more than 1 step below max = 14),
		// while 16 lines (~8 MiB) still split, proving recovery caps at MAX_BATCH_BYTES.
		expect(await sendAndMeasure(halfMiBLine.repeat(16))).toEqual([15, 1]);
	} finally {
		await uploader.stop();
	}
}, 40_000);
