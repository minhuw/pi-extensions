import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sha256 } from "../blocks.ts";
import pikaExtension from "../index.ts";
import { acquireUploader, currentUploader } from "../uploader.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

it("uploads a Herder journal and its goal and plan, and re-uploads the goal when it changes", async () => {
	await workspace.enable(ingest.url);
	const runId = "20261025-200721-3af4";
	const runDir = join(workspace.root, "herder", runId);
	await mkdir(runDir, { recursive: true });
	const run = {
		runId, runDir, journalPath: join(runDir, "journal.jsonl"), goalPath: join(runDir, "goal.md"), planPath: join(runDir, "plan.md"),
		repo: "project", title: "Ship pika",
	};
	await writeFile(run.journalPath, `${JSON.stringify({ seq: 1, t: "run.started", sessionId: "parent" })}\n`);
	await writeFile(run.goalPath, "# Goal\n\nFirst version.\n");
	await writeFile(run.planPath, "# Plan\n");
	let api: ExtensionAPI | undefined;
	const h = await startSession({ workspace, extensions: [(pi) => { api = pi; }, pikaExtension] });
	try {
		const key = `herder:${runId}`;
		api!.events.emit("herder:run", run);
		await waitFor(async () => ingest.data(key) === await readText(run.journalPath) && ingest.documents.size === 2, 5_000, "journal and documents");
		expect(ingest.streams.get(key)).toMatchObject({ kind: "herder-journal", path: run.journalPath, meta: { runId, repo: "project", title: "Ship pika" } });
		expect(ingest.documents.get(`herder:${runId}:goal.md`)).toMatchObject({ kind: "herder-goal", runId, content: "# Goal\n\nFirst version.\n" });
		expect(ingest.documents.get(`herder:${runId}:plan.md`)).toMatchObject({ kind: "herder-plan", runId, content: "# Plan\n" });

		// A partial last line waits until it is complete; repeated events are harmless.
		await appendFile(run.journalPath, `${JSON.stringify({ seq: 2, t: "step.started", sessionId: "child", sessionFile: "/tmp/child.jsonl" })}\n{"seq":3,`);
		api!.events.emit("herder:run", run);
		api!.events.emit("herder:run", run);
		const complete = (await readText(run.journalPath)).slice(0, (await readText(run.journalPath)).lastIndexOf("\n") + 1);
		await waitFor(() => ingest.data(key) === complete, 5_000, "complete lines");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(ingest.data(key)).toBe(complete);

		await appendFile(run.journalPath, `"t":"run.completed"}\n`);
		await writeFile(run.goalPath, "# Goal\n\nSecond version.\n");
		api!.events.emit("herder:run", run);
		await waitFor(async () => ingest.data(key) === await readText(run.journalPath)
			&& ingest.documents.get(`herder:${runId}:goal.md`)?.content === "# Goal\n\nSecond version.\n", 5_000, "changed goal");
		const uploads = (name: string) => ingest.documentUploads.filter((document) => document.key === `herder:${runId}:${name}`).length;
		expect(uploads("goal.md")).toBe(2);
		expect(uploads("plan.md")).toBe(1);
		expect(ingest.conflicts).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("ignores Herder runs from an excluded session or with an excluded run directory", async () => {
	const secret = join(workspace.root, "secret");
	const runDir = join(secret, ".git", "herder", "run-1");
	await mkdir(runDir, { recursive: true });
	const other = join(workspace.root, "herder", "run-2");
	await mkdir(other, { recursive: true });
	await workspace.enable(ingest.url, { exclude: [secret] });
	const runFor = (dir: string, runId: string) => ({
		runId, runDir: dir, journalPath: join(dir, "journal.jsonl"), goalPath: join(dir, "goal.md"), planPath: join(dir, "plan.md"), repo: "secret", title: "Secret",
	});
	const excludedRun = runFor(runDir, "run-1");
	const otherRun = runFor(other, "run-2");
	for (const run of [excludedRun, otherRun]) {
		await writeFile(run.journalPath, `${JSON.stringify({ seq: 1, t: "run.started" })}\n`);
		await writeFile(run.goalPath, "# Goal\n");
		await writeFile(run.planPath, "# Plan\n");
	}
	let excludedApi: ExtensionAPI | undefined;
	let mainApi: ExtensionAPI | undefined;
	const excluded = await startSession({ workspace, cwd: secret, extensions: [(pi) => { excludedApi = pi; }, pikaExtension] });
	const main = await startSession({ workspace, faux: excluded.faux, extensions: [(pi) => { mainApi = pi; }, pikaExtension] });
	try {
		excludedApi!.events.emit("herder:run", otherRun);
		mainApi!.events.emit("herder:run", excludedRun);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect([...ingest.streams.keys()].filter((key) => key.startsWith("herder:"))).toEqual([]);
		expect(ingest.documents.size).toBe(0);
		expect(excluded.errors).toEqual([]);
		expect(main.errors).toEqual([]);
	} finally { await main.shutdown(); await excluded.shutdown(); }
}, 20_000);

/** A Herder run under the workspace, with a journal, goal, and plan. */
async function herderRun(runId: string) {
	const runDir = join(workspace.root, "herder", runId);
	await mkdir(runDir, { recursive: true });
	const run = { runId, runDir, journalPath: join(runDir, "journal.jsonl"), goalPath: join(runDir, "goal.md"), planPath: join(runDir, "plan.md"), repo: "project", title: "Again" };
	await writeFile(run.journalPath, `${JSON.stringify({ seq: 1, t: "run.started" })}\n`);
	await writeFile(run.goalPath, "# Goal\n");
	await writeFile(run.planPath, "# Plan\n");
	return run;
}

const streamFile = (key: string) => join(workspace.pikaDir, "streams", `${encodeURIComponent(key)}.json`);

it("does not upload an acknowledged goal and plan again from a fresh uploader or a new session for the same server", async () => {
	await workspace.enable(ingest.url);
	const run = await herderRun("20261026-130000-a11c");
	const key = `herder:${run.runId}`;
	let api: ExtensionAPI | undefined;
	const first = await startSession({ workspace, extensions: [(pi) => { api = pi; }, pikaExtension] });
	try {
		api!.events.emit("herder:run", run);
		await waitFor(async () => ingest.data(key) === await readText(run.journalPath) && ingest.documents.size === 2, 5_000, "the run");
		await waitFor(async () => Object.keys(JSON.parse(await readText(streamFile(key))).docs ?? {}).length === 2, 5_000, "the acknowledged documents on disk");
		expect(JSON.parse(await readText(streamFile(key))).docsUrl).toBe(ingest.url);

		// A login with the same server and token starts a fresh uploader.
		const fresh = acquireUploader(currentUploader()!.options, true);
		await fresh.ready;
		api!.events.emit("herder:run", run);
		await appendFile(run.journalPath, `${JSON.stringify({ seq: 2, t: "step.started" })}\n`);
		await waitFor(async () => ingest.data(key) === await readText(run.journalPath), 5_000, "the journal from the fresh uploader");
	} finally { await first.shutdown(); }

	const second = await startSession({ workspace, faux: first.faux, extensions: [(pi) => { api = pi; }, pikaExtension] });
	try {
		api!.events.emit("herder:run", run);
		await appendFile(run.journalPath, `${JSON.stringify({ seq: 3, t: "run.completed" })}\n`);
		await waitFor(async () => ingest.data(key) === await readText(run.journalPath), 5_000, "the journal from the new session");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(ingest.documentUploads.map((document) => document.key).sort()).toEqual([`${key}:goal.md`, `${key}:plan.md`]);
		expect(second.errors).toEqual([]);
	} finally { await second.shutdown(); }
}, 20_000);

it("counts documents acknowledged before docsUrl existed as the server's that recorded the acknowledged hashes", async () => {
	const other = "http://127.0.0.1:9/pika";
	const cases = [{ ackedBy: ingest.url, uploads: 0 }, { ackedBy: other, uploads: 2 }];
	for (const [index, { ackedBy, uploads }] of cases.entries()) {
		await workspace.enable(ingest.url);
		const run = await herderRun(`20261026-14000${index}-0ld${index}`);
		const key = `herder:${run.runId}`;
		// State as pika 0.1 wrote it: the documents' hashes with no server of their own.
		await mkdir(join(workspace.pikaDir, "streams"), { recursive: true });
		await writeFile(join(workspace.pikaDir, "acked.log"), `# ${ackedBy}\n`);
		await writeFile(streamFile(key), JSON.stringify({
			key, kind: "herder-journal", path: run.journalPath, length: 0, meta: { runId: run.runId, goalPath: run.goalPath, planPath: run.planPath },
			docs: { [`${key}:goal.md`]: sha256("# Goal\n"), [`${key}:plan.md`]: sha256("# Plan\n") }, updatedAt: new Date().toISOString(),
		}));
		const before = ingest.documentUploads.length;
		let api: ExtensionAPI | undefined;
		const h = await startSession({ workspace, extensions: [(pi) => { api = pi; }, pikaExtension] });
		try {
			api!.events.emit("herder:run", run);
			await waitFor(async () => ingest.data(key) === await readText(run.journalPath), 5_000, "the journal");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(ingest.documentUploads.length - before).toBe(uploads);
			// The upgraded state names the server that acknowledged its documents.
			expect(JSON.parse(await readText(streamFile(key))).docsUrl).toBe(ingest.url);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}
}, 20_000);
