import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentDream } from "../../memory/dream/index.ts";
import { DREAM_TOOLS } from "../../memory/dream/tools.ts";
import { dream, fakeTimers, leaseRequests, releases, serveDreams, settle, until, useDreamEnv } from "./support/dream.ts";
import { PROJECT, REPOSITORY, setCredentials } from "./support/runtime.ts";

const INDEX = "# Project memory: my-project\n## project\n- Pitfall — run npm ci first [bbbbbbbbbbbb]\n";
const MINUTE = 60_000;

const env = useDreamEnv({ index: INDEX, spawner: true });

async function settings(memory: Record<string, unknown>): Promise<void> {
	await writeFile(join(env.workspace.agentDir, "pika.json"), JSON.stringify({ memory }));
}

describe("the idle trigger", () => {
	it("asks for one auto lease after dreamIdleMinutes idle and starts a dream, then waits for the next agent_settled", async () => {
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE - 1_000);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		await until(() => env.spawner.children[0]?.prompts.length === 1, "the dream's kickoff");
		const [request] = leaseRequests(env.pika);
		expect(request!.body).toEqual({ project: PROJECT, repository: REPOSITORY, sessionId: h.session.sessionId, mode: "auto" });
		expect(env.ui.status()).toBe("dreaming…");
		const kickoff = env.spawner.children[0]!.prompts[0]!;
		expect(kickoff).toContain("s-past-1 \"Fix the flaky upload test\": entries seq 3..41");
		expect(kickoff).toContain(INDEX.trim());
		expect(kickoff).toMatch(/1\. Orient[\s\S]*2\. Gather[\s\S]*recall_read[\s\S]*3\. Verify and consolidate[\s\S]*4\. Prune/);
		expect(kickoff).toContain("Budget: 40 turns, 300,000 budget tokens, 10 minutes");

		env.spawner.children[0]!.finish();
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["completed"]);
		expect(env.ui.status()).toBeUndefined();
		expect(env.ui.notes.at(-1)!.message).toMatch(/^pika memory: the dream finished: 0 batches committed, 0 notes changed\.$/);

		// No new request without a new settled run.
		await vi.advanceTimersByTimeAsync(60 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toHaveLength(1);
		await h.run("two");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 2, "the second lease request");
	});

	it("honours dreamIdleMinutes", async () => {
		await settings({ dreamIdleMinutes: 2 });
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 1, "the lease request");
	});

	it("ends quietly on dream_not_due and does not ask again until the next agent_settled", async () => {
		serveDreams(env.pika, { lease: { status: 409, body: { error: "dream_not_due", reason: "cooldown", retryAt: "2026-11-08T14:00:00Z" } } });
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 1, "the lease request");
		await settle();
		await vi.advanceTimersByTimeAsync(120 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toHaveLength(1);
		expect(env.spawner.children).toEqual([]);
		expect(env.ui.notes).toEqual([]);
		expect(env.ui.status()).toBeUndefined();
	});

	it("does not fire while a dialog is open, and waits again once it closes", async () => {
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await h.session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "pick" });
		await vi.advanceTimersByTimeAsync(40 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
		await h.session.extensionRunner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "pick" });
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 1, "the lease request");
	});

	it("does not fire with pending messages", async () => {
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		Object.defineProperty(h.session, "pendingMessageCount", { configurable: true, get: () => 1 });
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
		delete (h.session as unknown as Record<string, unknown>).pendingMessageCount;
	});

	it.each([
		["autoDream is false", async () => { await settings({ autoDream: false }); }],
		["pika is logged out", async () => { setCredentials(undefined); }],
		["the session is excluded", async () => { setCredentials(env.pika.url, { excluded: true }); }],
	])("does not fire when %s", async (_name, breakIt) => {
		const h = await env.start();
		await breakIt();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(60 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
		expect(env.spawner.children).toEqual([]);
	});

	it("never fires in a session with a session link, in a child bound without a mode, or in print mode", async () => {
		const linked = SessionManager.create(env.workspace.cwd, env.workspace.sessionDir);
		linked.appendCustomEntry("pi-extensions.session-link", { kind: "subagent", agentType: "memory-dream", parentSessionId: "parent" });
		const sessions = [await env.start({ sessionManager: linked }), await env.start({ bindAsChild: true }), await env.start({ mode: "print" })];
		fakeTimers();
		for (const h of sessions) await h.run("one");
		await vi.advanceTimersByTimeAsync(60 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
	});

	it("is cancelled by input before it fires", async () => {
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toEqual([]);
	});
});

describe("/memory", () => {
	it("dream requests a manual lease and starts a dream; status shows it; stop stops it", async () => {
		const h = await env.start();
		await h.session.prompt("/memory dream");
		expect(leaseRequests(env.pika).map((request) => (request.body as { mode: string }).mode)).toEqual(["manual"]);
		expect(env.ui.notes.at(-1)!.message).toBe(`pika memory: dreaming over 1 session of ${PROJECT} on memory-test/test.`);
		await until(() => env.spawner.children[0]?.prompts.length === 1, "the kickoff");
		expect(env.spawner.spawns[0]!.model.id).toBe("test");
		expect(env.spawner.spawns[0]!.parentSessionId).toBe(h.session.sessionId);

		await h.session.prompt("/memory status");
		const status = env.ui.notes.at(-1)!.message;
		expect(status).toContain("Dreams: automatic dreams on (memory.autoDream), after 20 idle minutes (memory.dreamIdleMinutes).");
		expect(status).toContain("Dream model: memory.dreamModel is not set; dreams use this session's model, memory-test/test.");
		expect(status).toMatch(/Dreaming of my-project \(manual\) since .*: 1 session, 0 of 43 turns, 0 of 300000 budget tokens, 0 changes staged\./);
		expect(status).toContain("Caps: stop past 43 turns, 300000 budget tokens (cache reads count a tenth), or 10 minutes; wrap up at 40 turns, 70% of the tokens or time, or a context past 120000 tokens.");

		await h.session.prompt("/memory stop");
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect(env.spawner.children[0]!.aborts).toBeGreaterThan(0);
		expect(env.ui.status()).toBeUndefined();
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: the dream stopped, stopped with /memory stop: 0 batches committed, 0 notes changed.");

		await h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toMatch(/Last dream of my-project \(manual\): aborted at .*, stopped with \/memory stop\./);
		await h.session.prompt("/memory stop");
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: no dream is running.");
	});

	it("uses memory.dreamModel when it is found, and says when it is not", async () => {
		await settings({ dreamModel: "memory-test/test", autoDream: false, dreamIdleMinutes: 5 });
		const h = await env.start();
		await h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("Dreams: automatic dreams off (memory.autoDream), after 5 idle minutes");
		expect(env.ui.notes.at(-1)!.message).toContain("Dream model: memory-test/test (memory.dreamModel).");
		await settings({ dreamModel: "nowhere/none" });
		await h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("Dream model: memory.dreamModel nowhere/none was not found; dreams use this session's model, memory-test/test.");
		await h.session.prompt("/memory dream");
		await until(() => env.spawner.spawns.length === 1, "the spawn");
		expect(`${env.spawner.spawns[0]!.model.provider}/${env.spawner.spawns[0]!.model.id}`).toBe("memory-test/test");
	});

	it("dream says why no dream starts", async () => {
		const h = await env.start();
		serveDreams(env.pika, { lease: { status: 409, body: { error: "dream_busy", expiresAt: "2026-11-08T10:15:00Z" } } });
		await h.session.prompt("/memory dream");
		expect(env.ui.notes.at(-1)).toEqual({ message: "pika memory: no dream: another dream holds this project's lease until 2026-11-08T10:15:00Z.", type: "warning" });
		setCredentials(undefined);
		await h.session.prompt("/memory dream");
		expect(env.ui.notes.at(-1)!.message).toBe("pika memory: no dream: pika is not logged in to a server; run /pika login.");
		await h.session.prompt("/memory status");
		expect(env.ui.notes.at(-1)!.message).toContain("This session cannot dream: pika is not logged in to a server; run /pika login.");
		// A login cannot help a disabled pika, so the answer names the setting instead.
		process.env.PIKA_DISABLED = "1";
		try {
			await h.session.prompt("/memory dream");
			expect(env.ui.notes.at(-1)!.message).toBe("pika memory: no dream: pika is disabled: PIKA_DISABLED=1 is set.");
		} finally { delete process.env.PIKA_DISABLED; }
		expect(env.spawner.children).toEqual([]);
	});

	it("rejects unknown subcommands", async () => {
		const h = await env.start();
		await h.session.prompt("/memory nap");
		expect(env.ui.notes.at(-1)).toEqual({ message: "Usage: /memory [status|dream|stop|log]", type: "error" });
	});
});

describe("preemption", () => {
	it("user input aborts the dream and releases it as aborted without waiting for the server", async () => {
		const h = await env.start();
		const child = await dream(env, { session: h });
		serveDreams(env.pika, { release: { delayMs: 3_000, body: {} } });
		const started = Date.now();
		await h.run("hello");
		expect(Date.now() - started).toBeLessThan(1_500);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted", reason: "the user sent a message" });
		expect(child.aborts).toBeGreaterThan(0);
		expect(env.ui.status()).toBeUndefined();
	});

	it("a run started by an extension aborts the dream at before_agent_start", async () => {
		let api!: ExtensionAPI;
		const h = await env.start({ extensions: [(pi) => { api = pi; }] });
		await dream(env, { session: h });
		h.faux.appendResponses([fauxAssistantMessage("ok")]);
		api.sendUserMessage("from an extension");
		await until(() => releases(env.pika).length === 1, "the release");
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "the session started a run" });
		await until(() => h.faux.getPendingResponseCount() === 0 && h.session.isIdle, "the extension's run");
	});

	it("shutting the session down aborts the dream and releases it without waiting for the server", async () => {
		const h = await env.start();
		const child = await dream(env, { session: h });
		serveDreams(env.pika, { release: { delayMs: 3_000, body: {} } });
		const started = Date.now();
		await h.shutdown();
		expect(Date.now() - started).toBeLessThan(2_500);
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "the session ended" });
		expect(child.shutdowns).toBe(1);
	});
});

it("top-level sessions have /memory but none of the dream tools", async () => {
	const h = await env.start();
	const names = h.session.getAllTools().map((tool) => tool.name);
	expect(names).toEqual(expect.arrayContaining(["memory_read", "memory_save", "memory_forget"]));
	for (const name of DREAM_TOOLS) expect(names).not.toContain(name);
});
