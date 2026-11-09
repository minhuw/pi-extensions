import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { currentDream } from "../../memory/dream/index.ts";
import { FakePika, TOKEN } from "./support/pika-server.ts";
import { batch, fakeSpawner, lease, LEASE_ID, leaseRequests, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const MINUTE = 60_000;
const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: [{ sessionId: "s-past-1", seq: 7 }] };

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
const open: Harness[] = [];
const servers: FakePika[] = [];

beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika);
	setCredentials(pika.url);
	resetDreams();
	ui = new RecordingUI();
});
afterEach(async () => {
	vi.useRealTimers();
	currentDream()?.stop("stopped", "the test ended");
	await currentDream()?.done;
	for (const h of open.splice(0)) await h.shutdown();
	resetDreams();
	for (const server of [pika, ...servers.splice(0)]) await server.stop();
	await workspace.cleanup();
});

async function start(options: Omit<Parameters<typeof startSession>[0], "workspace"> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ui: ui.context(), ...options });
	open.push(h);
	return h;
}
async function settle(check?: () => boolean, ms = check ? 5_000 : 150): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (check?.()) return true;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return check?.() ?? true;
}
async function until(check: () => boolean, what: string): Promise<void> {
	if (!await settle(check)) throw new Error(`timed out waiting for ${what}`);
}
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
const commits = () => pika.requestsTo(`memory/dream/${LEASE_ID}/commit`);

describe("/memory stop", () => {
	it("cancels a dream whose lease is being requested, and releases the lease granted meanwhile", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		pika.routes.set("POST memory/dream/lease", { delayMs: 400, body: { lease: lease({ mode: "manual" }), sessions: [] } });
		const command = h.session.prompt("/memory dream");
		await until(() => leaseRequests(pika).length === 1, "the lease request");
		await h.session.prompt("/memory stop");
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream being requested will not start.");
		await command;
		expect(ui.notes.at(-1)!.message).toBe("pika memory: no dream: stopped with /memory stop.");
		await until(() => releases(pika).length === 1, "the release");
		await settle();
		expect(releases(pika)).toEqual(["aborted"]);
		expect(spawner.children).toEqual([]);
		expect(currentDream()).toBeUndefined();
	});
});

describe("pika's credentials", () => {
	it("logging out stops the dream as aborted, and its release still reaches the server that granted it", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		setCredentials(undefined);
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "pika logged out" });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
		expect(pika.requestsTo(`memory/dream/${LEASE_ID}/release`)[0]!.authorization).toBe(`Bearer ${TOKEN}`);
		expect(spawner.children[0]!.aborts).toBeGreaterThan(0);
		expect(ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, pika logged out: 0 batches committed, 0 notes changed.");
	});

	it("a login to another server stops the dream, and its release goes to the server and token that granted it", async () => {
		const other = await new FakePika().start();
		servers.push(other);
		serveDreams(other);
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		setCredentials(other.url, { token: "pika_other_token" });
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "pika's server or token changed" });
		await until(() => releases(pika).length === 1, "the release");
		expect(pika.requestsTo(`memory/dream/${LEASE_ID}/release`)[0]!.authorization).toBe(`Bearer ${TOKEN}`);
		await settle();
		expect(other.requests).toEqual([]);
	});

	it("a commit in flight when pika logs out still lands on the server that granted the lease and is recorded", async () => {
		serveDreams(pika, { commit: { delayMs: 300, body: { batch: batch(), index: "", indexBytes: 0, indexLines: 0 } } });
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		const child = spawner.children[0]!;
		await child.call("dream_save", SAVE);
		const committing = child.call("dream_commit", { sessions: ["s-past-1"] });
		await until(() => commits().length === 1, "the commit request");
		setCredentials(undefined);
		expect((await committing).text).toMatch(/^Committed batch batch-0001/);
		await until(() => releases(pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "pika logged out", discarded: 0 });
		expect(currentDream()!.batches).toHaveLength(1);
	});

	it("logging out while the lease is requested starts no dream and releases the lease", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		pika.routes.set("POST memory/dream/lease", { delayMs: 300, body: { lease: lease({ mode: "manual" }), sessions: [] } });
		const command = h.session.prompt("/memory dream");
		await until(() => leaseRequests(pika).length === 1, "the lease request");
		setCredentials(undefined);
		await command;
		expect(ui.notes.at(-1)!.message).toBe("pika memory: no dream: pika logged out.");
		await until(() => releases(pika).length === 1, "the release");
		expect(spawner.children).toEqual([]);
	});
});

describe("the next dream", () => {
	it("asked for right after one stopped, waits for that one's release instead of finding its lease busy", async () => {
		let held = false;
		pika.routes.set("POST memory/dream/lease", (request) => {
			if (held) return { status: 409, body: { error: "dream_busy", expiresAt: "2026-11-08T10:15:00Z" } };
			held = true;
			return { body: { lease: lease({ mode: (request.body as { mode: "auto" | "manual" }).mode }), sessions: [] } };
		});
		// The server frees the lease when it answers the release, a while after the request arrives.
		pika.routes.set(`POST memory/dream/${LEASE_ID}/release`, () => {
			setTimeout(() => { held = false; }, 290);
			return { delayMs: 300, body: {} };
		});
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the first kickoff");
		await h.session.prompt("/memory stop");
		await h.session.prompt("/memory dream");
		expect(ui.notes.at(-1)!.message).toBe("pika memory: dreaming over 0 sessions of my-project on memory-test/test.");
		await until(() => spawner.children[1]?.prompts.length === 1, "the second kickoff");
		expect(leaseRequests(pika)).toHaveLength(2);
	});
});

describe("sessions kept only in memory", () => {
	it("never dream by themselves, and a dream asked for keeps its child in memory too", async () => {
		const h = await start({ sessionManager: SessionManager.inMemory(workspace.cwd) });
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(60 * MINUTE);
		await settle();
		expect(leaseRequests(pika)).toEqual([]);
		vi.useRealTimers();

		h.faux.appendResponses([fauxAssistantMessage("Nothing to keep.")]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release");
		await currentDream()!.done;
		expect(releases(pika)).toEqual(["completed"]);
		expect(currentDream()!.child!.sessionFile).toBeUndefined();
		expect(existsSync(join(workspace.cwd, ".pi"))).toBe(false);
	});
});

describe("the idle wait", () => {
	it("starts over after a ! command", async () => {
		fakeSpawner();
		const h = await start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		await h.session.extensionRunner.emitUserBash({ type: "user_bash", command: "git status", excludeFromContext: false, cwd: workspace.cwd });
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await settle();
		expect(leaseRequests(pika)).toEqual([]);
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await until(() => leaseRequests(pika).length === 1, "the lease request");
	});
});
