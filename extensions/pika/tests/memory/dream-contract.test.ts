import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { dreamSessionDir } from "../../memory/dream/child.ts";
import { currentDream, dreamLimits } from "../../memory/dream/index.ts";
import { WRAP_UP } from "../../memory/dream/run.ts";
import { commits, dream, fakeSpawner, fakeTimers, LEASE_ID, leaseRequests, releases, SAVE, serveDreams, settle, until, useDreamEnv } from "./support/dream.ts";
import { PROJECT_SCOPE } from "./support/runtime.ts";

const MINUTE = 60_000;
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const env = useDreamEnv();

describe("one dream per process", () => {
	it("two idle top-level sessions in one process request one lease and start one dream", async () => {
		const spawner = fakeSpawner();
		const a = await env.start();
		const b = await env.start();
		fakeTimers();
		await a.run("one");
		await b.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => spawner.children[0]?.prompts.length === 1, "the dream's kickoff");
		await settle();
		expect(leaseRequests(env.pika)).toHaveLength(1);
		expect(spawner.children).toHaveLength(1);
	});

	it("input in another session does not preempt the dream; input in its parent does", async () => {
		const parent = await env.start();
		const other = await env.start();
		await dream(parent);
		await other.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await settle();
		expect(currentDream()!.ended).toBe(false);
		expect(releases(env.pika)).toEqual([]);
		await parent.session.extensionRunner.emitInput("hello", undefined, "interactive");
		expect(currentDream()).toMatchObject({ ended: true, outcome: "aborted" });
		await until(() => releases(env.pika).length === 1, "the release");
		expect(releases(env.pika)).toEqual(["aborted"]);
	});
});

describe("preemption", () => {
	it("extension-generated input does not preempt the dream", async () => {
		const h = await env.start();
		await dream(h);
		await h.session.extensionRunner.emitInput("from an extension", undefined, "extension");
		await settle();
		expect(currentDream()!.ended).toBe(false);
		expect(releases(env.pika)).toEqual([]);
	});

	it("input while the lease request is in flight starts no dream and releases the granted lease as aborted", async () => {
		const spawner = fakeSpawner();
		const h = await env.start();
		const granted = { lease: { id: LEASE_ID, scope: PROJECT_SCOPE, mode: "manual", deviceId: "laptop", sessionId: null, grantedAt: "2026-11-08T10:00:00Z", expiresAt: "2026-11-08T10:15:00Z", releasedAt: null, outcome: null }, sessions: [] };
		env.pika.routes.set("POST memory/dream/lease", { delayMs: 400, body: granted });
		const command = h.session.prompt("/memory dream");
		await until(() => leaseRequests(env.pika).length === 1, "the lease request");
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await command;
		await until(() => releases(env.pika).length === 1, "the release");
		await settle();
		expect(releases(env.pika)).toEqual(["aborted"]);
		expect(spawner.children).toEqual([]);
		expect(env.ui.status()).toBeUndefined();
	});

	it("input discards the staged changes without committing them", async () => {
		const h = await env.start();
		const child = await dream(h);
		await child.call("dream_save", SAVE);
		await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1 });
		await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
		await until(() => releases(env.pika).length === 1, "the release");
		await settle();
		expect(currentDream()).toMatchObject({ outcome: "aborted", staged: [], discarded: 2 });
		expect(commits(env.pika)).toEqual([]);
		expect(releases(env.pika)).toEqual(["aborted"]);
	});
});

describe("the idle trigger ends quietly", () => {
	it.each([
		["dream_busy", { status: 409, body: { error: "dream_busy", expiresAt: "2026-11-08T10:15:00Z" } }],
		["a server error", { status: 500, body: { error: "internal" } }],
	])("on %s, and does not ask again until the next agent_settled", async (_name, answer) => {
		const spawner = fakeSpawner();
		serveDreams(env.pika, { lease: answer });
		const h = await env.start();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 1, "the lease request");
		await settle();
		await vi.advanceTimersByTimeAsync(120 * MINUTE);
		await settle();
		expect(leaseRequests(env.pika)).toHaveLength(1);
		expect(spawner.children).toEqual([]);
		expect(env.ui.notes).toEqual([]);
		expect(env.ui.status()).toBeUndefined();
		await h.run("two");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await until(() => leaseRequests(env.pika).length === 2, "the second lease request");
	});

	it("when the server is unreachable", async () => {
		const spawner = fakeSpawner();
		const h = await env.start();
		await env.pika.stop();
		fakeTimers();
		await h.run("one");
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		await settle(undefined, 500);
		expect(spawner.children).toEqual([]);
		expect(env.ui.notes).toEqual([]);
		expect(env.ui.status()).toBeUndefined();
	});
});

describe("source limits", () => {
	it("dream_save and dream_forget refuse more than 20 sources and stage nothing", async () => {
		const h = await env.start();
		const child = await dream(h);
		const many = Array.from({ length: 21 }, (_, seq) => ({ sessionId: "s-past-1", seq }));
		expect((await child.call("dream_save", { ...SAVE, sources: many })).isError).toBe(true);
		expect((await child.call("dream_forget", { id: "cccccccccccc", expectedRevision: 1, sources: many })).isError).toBe(true);
		expect(currentDream()!.staged).toEqual([]);
		const twenty = many.slice(0, 20);
		expect((await child.call("dream_save", { ...SAVE, sources: twenty })).isError).toBe(false);
		expect(currentDream()!.staged).toHaveLength(1);
	});
});

describe("body limit", () => {
	it("dream_save refuses a body over 600 characters and stages nothing", async () => {
		const h = await env.start();
		const child = await dream(h);
		const long = await child.call("dream_save", { ...SAVE, body: "x".repeat(601) });
		expect(long.isError).toBe(true);
		expect(long.text).toMatch(/^body_too_long: the body is 601 characters, over the limit of 600\. Nothing was staged\./);
		expect(long.details).toMatchObject({ staged: 0 });
		expect(currentDream()!.staged).toEqual([]);
		expect((await child.call("dream_save", { ...SAVE, body: "x".repeat(600) })).isError).toBe(false);
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
	it("is steered to wrap up at the wrap-up turn and aborted at the abort turn, released as failed with nothing committed", async () => {
		dreamLimits.wrapUpTurns = 2;
		dreamLimits.abortTurns = 5;
		const h = await env.start();
		const seen: Seen[] = [];
		const ls = () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
		h.faux.appendResponses([...Array.from({ length: 6 }, () => recorder(seen, ls)), recorder(seen, () => fauxAssistantMessage("done"))]);
		await h.session.prompt("/memory dream");
		await until(() => releases(env.pika).length === 1, "the release");
		await currentDream()!.done;
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(currentDream()).toMatchObject({ outcome: "failed", reason: "reached its 5-turn limit", turns: 5 });
		// The wrap-up reaches the model after turn 2, before the abort.
		const steeredAt = seen.findIndex((request) => request.userTexts.some((text) => text.includes(WRAP_UP)));
		expect(steeredAt).toBeGreaterThanOrEqual(2);
		expect(steeredAt).toBeLessThan(5);
		expect(seen.length).toBeLessThanOrEqual(6);
	});

	it("counts input, output, and cache writes in full and cache reads at a tenth from the child's answers", async () => {
		const h = await env.start();
		const seen: Seen[] = [];
		h.faux.appendResponses([
			recorder(seen, () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
			recorder(seen, () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
			recorder(seen, () => fauxAssistantMessage("Nothing to keep.")),
		]);
		await h.session.prompt("/memory dream");
		await until(() => releases(env.pika).length === 1, "the release");
		const run = currentDream()!;
		await run.done;
		expect(releases(env.pika)).toEqual(["completed"]);
		const dir = dreamSessionDir(env.workspace.cwd);
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
		const h = await env.start();
		h.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("/memory dream");
		await until(() => releases(env.pika).length === 1, "the release");
		await currentDream()!.done;
		expect(releases(env.pika)).toEqual(["failed"]);
		expect(currentDream()).toMatchObject({ outcome: "failed", reason: "used more than 1 budget tokens" });
		expect(env.ui.status()).toBeUndefined();
	});
});

describe("documentation", () => {
	it("the pika README documents /memory, the memory settings, and dream behaviour", () => {
		const readme = readFileSync(join(ROOT, "extensions/pika/README.md"), "utf8");
		for (const text of ["/memory dream", "/memory stop", "/memory status", "autoDream", "dreamIdleMinutes", "dreamModel"]) expect(readme).toContain(text);
		expect(readme).toMatch(/lease/i);
		expect(readme).toMatch(/40 turns/);
		expect(readme).toMatch(/300,000 budget tokens/);
		expect(readme).toMatch(/commitId/);
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
