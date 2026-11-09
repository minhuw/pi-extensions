import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { dreamSessionDir } from "../../memory/dream/child.ts";
import { currentDream, dreamLimits } from "../../memory/dream/index.ts";
import { WRAP_UP } from "../../memory/dream/run.ts";
import { FakePika } from "./support/pika-server.ts";
import { fakeSpawner, LEASE_ID, leaseRequests, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const MINUTE = 60_000;
const SOURCES = [{ sessionId: "s-past-1", seq: 7 }];
const SAVE = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: SOURCES };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
const open: Harness[] = [];

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
	currentDream()?.stop("aborted", "the test ended");
	await currentDream()?.done;
	for (const h of open.splice(0)) await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

async function start(options: Omit<Parameters<typeof startSession>[0], "workspace"> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ui: ui.context(), ...options });
	open.push(h);
	return h;
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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
const commits = () => pika.requestsTo(`memory/dream/${LEASE_ID}/commit`);

describe("one dream per process", () => {
	it("two idle top-level sessions in one process request one lease and start one dream", async () => {
		const spawner = fakeSpawner();
		const a = await start();
		const b = await start();
		fakeTimers();
		await a.run("one");
		await b.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => spawner.children[0]?.prompts.length === 1, "the dream's kickoff");
		await settle();
		expect(leaseRequests(pika)).toHaveLength(1);
		expect(spawner.children).toHaveLength(1);
	});

	it("input in another session does not preempt the dream; input in its parent does", async () => {
		const spawner = fakeSpawner();
		const parent = await start();
		const other = await start();
		await parent.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		await other.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await settle();
		expect(currentDream()!.ended).toBe(false);
		expect(releases(pika)).toEqual([]);
		await parent.session.extensionRunner.emitInput("hello", undefined, "interactive");
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted" });
		await until(() => releases(pika).length === 1, "the release");
		expect(releases(pika)).toEqual(["aborted"]);
	});
});

describe("preemption", () => {
	it("extension-generated input does not preempt the dream", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		await h.session.extensionRunner.emitInput("from an extension", undefined, "extension");
		await settle();
		expect(currentDream()!.ended).toBe(false);
		expect(releases(pika)).toEqual([]);
	});

	it("input while the lease request is in flight starts no dream and releases the granted lease as aborted", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		const granted = { lease: { id: LEASE_ID, scope: PROJECT_SCOPE, mode: "manual", deviceId: "laptop", sessionId: null, grantedAt: "2026-11-08T10:00:00Z", expiresAt: "2026-11-08T10:15:00Z", releasedAt: null, outcome: null }, sessions: [] };
		pika.routes.set("POST memory/dream/lease", { delayMs: 400, body: granted });
		const command = h.session.prompt("/memory dream");
		await until(() => leaseRequests(pika).length === 1, "the lease request");
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await command;
		await until(() => releases(pika).length === 1, "the release");
		await settle();
		expect(releases(pika)).toEqual(["aborted"]);
		expect(spawner.children).toEqual([]);
		expect(ui.status()).toBeUndefined();
	});

	it("input discards the staged changes without committing them", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		const child = spawner.children[0]!;
		await child.call("dream_save", SAVE);
		await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1 });
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await until(() => releases(pika).length === 1, "the release");
		await settle();
		expect(currentDream()).toMatchObject({ outcome: "aborted", staged: [], discarded: 2 });
		expect(commits()).toEqual([]);
		expect(releases(pika)).toEqual(["aborted"]);
	});
});

describe("the idle trigger ends quietly", () => {
	it.each([
		["dream_busy", { status: 409, body: { error: "dream_busy", expiresAt: "2026-11-08T10:15:00Z" } }],
		["a server error", { status: 500, body: { error: "internal" } }],
	])("on %s, and does not ask again until the next agent_settled", async (_name, answer) => {
		const spawner = fakeSpawner();
		serveDreams(pika, { lease: answer });
		const h = await start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(pika).length === 1, "the lease request");
		await settle();
		await vi.advanceTimersByTimeAsync(120 * MINUTE);
		await settle();
		expect(leaseRequests(pika)).toHaveLength(1);
		expect(spawner.children).toEqual([]);
		expect(ui.notes).toEqual([]);
		expect(ui.status()).toBeUndefined();
		await h.run("two");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(pika).length === 2, "the second lease request");
	});

	it("when the server is unreachable", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		await pika.stop();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await settle(undefined, 500);
		expect(spawner.children).toEqual([]);
		expect(ui.notes).toEqual([]);
		expect(ui.status()).toBeUndefined();
	});
});

describe("source limits", () => {
	it("dream_save and dream_forget refuse more than 20 sources and stage nothing", async () => {
		const spawner = fakeSpawner();
		const h = await start();
		await h.session.prompt("/memory dream");
		await until(() => spawner.children[0]?.prompts.length === 1, "the kickoff");
		const child = spawner.children[0]!;
		const many = Array.from({ length: 21 }, (_, seq) => ({ sessionId: "s-past-1", seq }));
		expect((await child.call("dream_save", { ...SAVE, sources: many })).isError).toBe(true);
		expect((await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1, sources: many })).isError).toBe(true);
		expect(currentDream()!.staged).toEqual([]);
		const twenty = many.slice(0, 20);
		expect((await child.call("dream_save", { ...SAVE, sources: twenty })).isError).toBe(false);
		expect(currentDream()!.staged).toHaveLength(1);
	});
});

interface Seen { userTexts: string[] }
function recorder(seen: Seen[], answer: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
	return (context) => {
		seen.push({
			userTexts: context.messages.filter((message) => message.role === "user")
				.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("")),
		});
		return answer();
	};
}

describe("a real dream child", () => {
	it("is steered to wrap up at the wrap-up turn and aborted at the abort turn", async () => {
		dreamLimits.wrapUpTurns = 2;
		dreamLimits.abortTurns = 5;
		const h = await start();
		const seen: Seen[] = [];
		const ls = () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
		h.faux.appendResponses([...Array.from({ length: 6 }, () => recorder(seen, ls)), recorder(seen, () => fauxAssistantMessage("done"))]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release");
		await currentDream()!.done;
		expect(releases(pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "reached its 5-turn limit", turns: 5 });
		// The wrap-up reaches the model after turn 2, before the abort.
		const steeredAt = seen.findIndex((request) => request.userTexts.some((text) => text.includes(WRAP_UP)));
		expect(steeredAt).toBeGreaterThanOrEqual(2);
		expect(steeredAt).toBeLessThan(5);
		expect(seen.length).toBeLessThanOrEqual(6);
	});

	it("counts input, output, and cache writes in full and cache reads at a tenth from the child's answers", async () => {
		const h = await start();
		const seen: Seen[] = [];
		h.faux.appendResponses([
			recorder(seen, () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
			recorder(seen, () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
			recorder(seen, () => fauxAssistantMessage("Nothing to keep.")),
		]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release");
		const run = currentDream()!;
		await run.done;
		expect(releases(pika)).toEqual(["completed"]);
		const dir = dreamSessionDir(workspace.cwd);
		const file = readdirSync(dir, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"))!;
		const usages = readFileSync(join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: { role: string; usage?: Record<string, number> } })
			.flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage ? [entry.message.usage] : []);
		expect(usages).toHaveLength(3);
		// The faux provider caches the prompt, so the later answers re-read the context.
		expect(usages.slice(1).every((usage) => (usage.cacheRead ?? 0) > 0)).toBe(true);
		const total = usages.reduce((sum, usage) => sum + (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0) + Math.ceil((usage.cacheRead ?? 0) / 10), 0);
		expect(total).toBeGreaterThan(0);
		expect(run.tokens).toBe(total);
		const sum = (key: string) => usages.reduce((all, usage) => all + (usage[key] ?? 0), 0);
		expect(run.usage).toEqual({ input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") });
		const last = usages.at(-1)!;
		expect(run.context).toBe((last.input ?? 0) + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0));
		expect(run.turns).toBe(3);
	});

	it("is aborted once its tokens pass the cap", async () => {
		dreamLimits.maxTokens = 1;
		const h = await start();
		h.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("/memory dream");
		await until(() => releases(pika).length === 1, "the release");
		await currentDream()!.done;
		expect(releases(pika)).toEqual(["aborted"]);
		expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "used more than 1 budget tokens" });
		expect(ui.status()).toBeUndefined();
	});
});

describe("documentation", () => {
	it("the pika README documents /memory, the memory settings, and dream behaviour", () => {
		const readme = readFileSync(join(ROOT, "extensions/pika/README.md"), "utf8");
		for (const text of ["/memory dream", "/memory stop", "/memory status", "autoDream", "dreamIdleMinutes", "dreamModel"]) expect(readme).toContain(text);
		expect(readme).toMatch(/lease/i);
		expect(readme).toMatch(/40 turns/);
		expect(readme).toMatch(/300,000 budget tokens/);
		expect(readme).toMatch(/10 minutes/);
		expect(readme).toMatch(/preempt/i);
		expect(readme).toMatch(/web UI/);
		expect(readme).toMatch(/revert|undo/i);
	});

	it("AGENTS.md's extensions/pika line mentions dreaming", () => {
		const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
		const line = agents.split("\n").find((text) => text.startsWith("- `extensions/pika/`"));
		expect(line).toMatch(/dream/i);
	});
});
