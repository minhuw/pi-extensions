import { afterEach, beforeEach, expect, it } from "vitest";
import { BoardSync, SWARM_BOARDS, swarmBoards, type SwarmBoard, type SwarmCard } from "../board.ts";
import { CREDENTIALS, publishCredentials } from "../credentials.ts";
import pikaExtension from "../index.ts";
import { currentUploader } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { startSession, waitFor, Workspace, type Harness } from "./support/runtime.ts";

const SYNC = Symbol.for("pi-extensions.pika.boards");
const slots = globalThis as Record<symbol, unknown>;

let workspace: Workspace;
let ingest: MockIngest;
let harness: Harness | undefined;
beforeEach(async () => {
	for (const key of [CREDENTIALS, SWARM_BOARDS, SYNC]) delete slots[key];
	workspace = await Workspace.create();
	ingest = await new MockIngest().start();
});
afterEach(async () => {
	await harness?.shutdown();
	harness = undefined;
	await ingest.stop();
	await workspace.cleanup();
});

/** Installs the process's board sync with short waits, as pika would with the defaults. */
function quickSync(intervalMs = 150): void {
	slots[SYNC] = new BoardSync({ noteError: (message) => currentUploader()?.noteError(message), intervalMs, retryMs: 100, retryMaxMs: 400 });
}

const card = (id: string, status: SwarmCard["status"], note?: string): SwarmCard => ({
	id, title: `task ${id}`, status, agentId: "a-1", agent: "worker", ...(note ? { note } : {}),
	createdBy: "coordinator", updatedBy: "a-1", createdAt: 1_000, updatedAt: 2_000,
});

/** Publishes a board as the delegation extension does: into the map, then to every listener. */
function publish(sessionId: string, updatedAt: number, cards: SwarmCard[]): SwarmBoard {
	const registry = swarmBoards() as ReturnType<typeof swarmBoards> & { members?: unknown };
	registry.members ??= new Map();
	const board: SwarmBoard & { extra?: string } = { version: 1, sessionId, updatedAt, cards, extra: "not uploaded" };
	registry.boards.set(sessionId, board);
	for (const listener of registry.listeners) listener(board);
	return board;
}

async function start(): Promise<string> {
	harness = await startSession({ workspace, extensions: [pikaExtension] });
	return harness.session.sessionManager.getSessionId();
}

const lastError = () => currentUploader()?.status().lastError;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("uploads this session's board with the device token, and nothing for other sessions", async () => {
	await workspace.enable(ingest.url);
	quickSync();
	const id = await start();
	publish("someone-else", 5, [card("x", "todo")]);
	publish(id, 10, [card("c1", "todo"), card("c2", "doing", "halfway")]);
	await waitFor(() => ingest.boardUploads.length === 1, 3_000, "the upload");
	expect(ingest.boardUploads[0]).toEqual({
		sessionId: id, authorization: `Bearer ${TOKEN}`, status: 200,
		body: { version: 1, sessionId: id, updatedAt: 10, cards: [card("c1", "todo"), card("c2", "doing", "halfway")] },
	});
	await sleep(300);
	expect(ingest.boardUploads.map((u) => u.sessionId)).toEqual([id]);
});

it("coalesces bursts to one upload per interval, always with the latest snapshot", async () => {
	await workspace.enable(ingest.url);
	quickSync(400);
	const id = await start();
	for (let i = 1; i <= 10; i++) publish(id, i, [card("c1", i < 10 ? "doing" : "done")]);
	await waitFor(() => ingest.boardUploads.length >= 1, 3_000, "the first upload");
	for (let i = 11; i <= 20; i++) { publish(id, i, [card("c1", "blocked", `step ${i}`)]); await sleep(10); }
	await waitFor(() => ingest.boardUploads.at(-1)?.body.updatedAt === 20, 3_000, "the latest snapshot");
	await sleep(500);
	const uploads = ingest.boardUploads.map((u) => u.body.updatedAt);
	expect(uploads[0]).toBe(10);
	expect(uploads.at(-1)).toBe(20);
	expect(uploads.length).toBeLessThanOrEqual(3);
});

it("uploads nothing while pika is disabled", async () => {
	await workspace.configure({ url: ingest.url, token: TOKEN, enabled: false });
	quickSync();
	const id = await start();
	publish(id, 1, [card("c1", "todo")]);
	await sleep(400);
	expect(ingest.boardUploads).toEqual([]);
});

it("notes a failure once for /pika and retries with backoff until the server takes it", async () => {
	await workspace.enable(ingest.url);
	quickSync();
	ingest.boardStatus = 503;
	const id = await start();
	publish(id, 1, [card("c1", "todo")]);
	await waitFor(() => ingest.boardUploads.length >= 3, 3_000, "retries");
	expect(lastError()).toContain(`board upload for session ${id}: HTTP 503 test`);
	const gaps = ingest.boardUploads.length;
	expect(gaps).toBeLessThan(6);
	ingest.boardStatus = 200;
	await waitFor(() => ingest.boardUploads.at(-1)?.status === 200, 3_000, "the retried upload");
	const count = ingest.boardUploads.length;
	await sleep(400);
	expect(ingest.boardUploads.length).toBe(count);
});

it("stops after a refusal until the login changes", async () => {
	await workspace.enable(ingest.url);
	quickSync();
	ingest.boardStatus = 403;
	const id = await start();
	publish(id, 1, [card("c1", "todo")]);
	await waitFor(() => ingest.boardUploads.length === 1, 3_000, "the refused upload");
	// The server counts the upload before it answers; the note follows the answer.
	await waitFor(() => lastError() !== undefined, 3_000, "the noted refusal");
	expect(lastError()).toContain("HTTP 403 test; not retried until the login changes");
	publish(id, 2, [card("c1", "done")]);
	await sleep(400);
	expect(ingest.boardUploads.length).toBe(1);

	ingest.boardStatus = 200;
	publishCredentials({ enabled: true, config: { url: ingest.url, token: TOKEN, exclude: ["/nowhere"] } } as never);
	await waitFor(() => ingest.boardUploads.length === 2, 3_000, "the upload after the login changed");
	expect(ingest.boardUploads[1]!.body.updatedAt).toBe(2);
});

it("sends the last snapshot when the session ends", async () => {
	await workspace.enable(ingest.url);
	quickSync(10_000);
	const id = await start();
	publish(id, 1, [card("c1", "todo")]);
	await waitFor(() => ingest.boardUploads.length === 1, 3_000, "the first upload");
	publish(id, 2, [card("c1", "done")]);
	await harness!.shutdown();
	expect(ingest.boardUploads.map((u) => u.body.updatedAt)).toEqual([1, 2]);
	// The ended session no longer listens.
	publish(id, 3, [card("c1", "failed")]);
	await sleep(200);
	expect(ingest.boardUploads.length).toBe(2);
	expect(swarmBoards().listeners.size).toBe(0);
});
