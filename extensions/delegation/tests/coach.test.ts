// The swarm coach in real Pi sessions on the faux provider, asserting on what the provider receives.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { blockedText, COACH, contextText, stallText } from "../coach.ts";
import type { SwarmBoard, SwarmBoards, SwarmCard } from "../board.ts";
import {
	afterPrompt,
	captureRequest,
	createDelegationSandbox,
	createDelegationSession,
	SWARM_BOARDS,
	textOf,
	type CapturedRequest,
	type DelegationSandbox,
} from "./support/session-harness.ts";

const CONTEXT_WINDOW = 20_000;

type Step = string | AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

const isCoach = (text: string) => text.startsWith("Swarm mode: ");
const coachTexts = (request: CapturedRequest) => request.conversation.map(textOf).filter(isCoach);

/** One assistant message calling `tools` in order, each with arguments that suit it. */
const calls = (...tools: string[]) => fauxAssistantMessage(tools.map((tool) => fauxToolCall(tool, argumentsOf(tool))), { stopReason: "toolUse" });
const argumentsOf = (tool: string): Parameters<typeof fauxToolCall>[1] => {
	switch (tool) {
		case "read": return { path: "notes.txt" };
		case "bash": return { command: "true" };
		case "ls": case "find": return { path: "." };
		case "grep": case "ffgrep": return { pattern: "note" };
		case "write": return { path: "out.txt", content: "x" };
		case "edit": return { path: "notes.txt", edits: [{ oldText: "zzz-not-there", newText: "y" }] };
		default: return {};
	}
};

let sandbox: DelegationSandbox;

beforeEach(async () => {
	sandbox = await createDelegationSandbox("pi-swarm-coach-");
	await writeFile(join(sandbox.cwd, "notes.txt"), "a note\n");
});

afterEach(async () => {
	await sandbox.cleanup();
});

const SUBAGENTS_TELEMETRY = "subagents:telemetry";
const STALL_MS = 10 * 60_000;
const ACTIVE_TOOL_STALL_MS = 25 * 60_000;

function getBoardRegistry(): SwarmBoards {
	const global = globalThis as Record<symbol, SwarmBoards | undefined>;
	return (global[SWARM_BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() });
}

function publishBoard(sessionId: string, cards: SwarmCard[]): void {
	const registry = getBoardRegistry();
	const board: SwarmBoard = { version: 1, sessionId, updatedAt: Date.now(), cards };
	registry.boards.set(sessionId, board);
	for (const listener of registry.listeners) listener(board);
}

/**
 * A session with the extension loaded by path, or, with `clock`, with swarm mode and a coach built here on a clock the
 * test moves, checking every few milliseconds. `emit` sends telemetry on the session's event bus as pi-subagents does.
 */
async function start(options: { clock?: { now: number } } = {}) {
	const { clock } = options;
	const base = await createDelegationSession({
		sandbox,
		api: "swarm-coach-test-api",
		provider: "swarm-coach-test",
		contextWindow: CONTEXT_WINDOW,
		coachOptions: clock ? { stallMs: STALL_MS, checkMs: 5, now: () => clock.now } : undefined,
		ui: "quiet",
	});
	const harness = {
		runtime: base.runtime,
		requests: base.requests,
		errors: base.errors,
		get session() { return base.session; },
		/** Answer the next requests with `steps`, then with "ok". */
		reply(...steps: Step[]) {
			const all = [...steps, ...Array.from({ length: 10 }, () => "ok")];
			base.faux.setResponses(all.map((step): FauxResponseFactory => async ({ messages }) => {
				base.requests.push(captureRequest(messages));
				return typeof step === "string" ? fauxAssistantMessage(step) : typeof step === "function" ? step() : step;
			}));
		},
		/** Run one prompt answered by `steps` and return the requests it made. */
		async run(prompt: string, ...steps: Step[]) {
			harness.reply(...steps);
			const before = base.requests.length;
			await base.session.prompt(prompt);
			return base.requests.slice(before);
		},
		command: (text: string) => base.session.prompt(text),
		/** Telemetry for a top-level agent of this session, running with no active tool unless `fields` says otherwise. */
		emit(agentId: string, fields: Record<string, unknown> = {}) {
			base.events.emit(SUBAGENTS_TELEMETRY, {
				phase: "updated", agentId, status: "running", displayName: "Worker", type: "worker", description: `task ${agentId}`,
				turnCount: 1, toolUses: 0, lifetimeTokens: 0, contextPercent: null, compactionCount: 0, activeTools: [], startedAt: 0,
				parentSessionId: base.sessionId, ...fields,
			});
		},
		coachEntries: () => base.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "swarm-coach" ? [entry] : []),
		swarmMessages: () => base.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "swarm" ? [entry.content] : []),
		dispose: base.dispose,
	};
	return harness;
}

describe("the context nudge", () => {
	/** A prompt that alone fills `percent` of the context window, at the faux provider's four characters a token. */
	const filler = (percent: number) => "x".repeat(Math.ceil(CONTEXT_WINDOW * 4 * percent / 100));
	/** The coach messages each request of a run carries after its prompt. */
	const nudges = (requests: CapturedRequest[], prompt: string) => requests.map((request) => afterPrompt(request, prompt).filter(isCoach));

	it("steers once at the threshold and again only after a compaction", async () => {
		const h = await start();
		expect(nudges(await h.run("small", calls("edit"), "done"), "small")).toEqual([[], []]);
		expect(h.session.getContextUsage()!.percent!).toBeLessThan(COACH.contextShare);

		const big = filler(COACH.contextShare);
		const full = nudges(await h.run(big, calls("edit"), "done"), big);
		expect(full).toEqual([[], [expect.stringMatching(/^Swarm mode: your context is \d+% full\./)]]);
		const percent = Number(/(\d+)%/.exec(full[1][0])![1]);
		expect(percent).toBeGreaterThanOrEqual(COACH.contextShare);
		expect(percent).toBeLessThan(100);
		expect(full[1]).toEqual([contextText(percent)]);

		expect(nudges(await h.run("again", calls("edit"), calls("edit"), "done"), "again")).toEqual([[], [], []]);
		expect(h.coachEntries()).toHaveLength(1);

		h.reply("summary");
		await h.session.compact();
		const bigger = filler(COACH.contextShare + 5);
		expect(nudges(await h.run(bigger, calls("edit"), "done"), bigger).map((texts) => texts.length)).toEqual([0, 1]);
		expect(h.coachEntries()).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("waits for a turn that is followed by another rather than add a request", async () => {
		const h = await start();
		expect(await h.run(filler(COACH.contextShare + 5), "done")).toHaveLength(1);
		expect(h.coachEntries()).toEqual([]);
		expect(nudges(await h.run("next", calls("edit"), "done"), "next").map((texts) => texts.length)).toEqual([0, 1]);
	});

	it("sends nothing while swarm mode is off", async () => {
		const h = await start();
		await h.command("/swarm off");
		expect((await h.run(filler(COACH.contextShare + 5), calls("edit"), "done")).flatMap(coachTexts)).toEqual([]);
		expect(h.coachEntries()).toEqual([]);
	});

	it("re-arms the context nudge after navigating the session tree", async () => {
		const h = await start();
		await h.run("start", "ok");
		const startLeafId = h.session.sessionManager.getLeafId()!;

		const big = filler(COACH.contextShare);
		expect(nudges(await h.run(big, calls("edit"), "done"), big).map((texts) => texts.length)).toEqual([0, 1]);
		expect(h.coachEntries()).toHaveLength(1);

		await h.session.navigateTree(startLeafId, { summarize: false });
		expect(h.coachEntries()).toHaveLength(0);

		expect(nudges(await h.run(big, calls("edit"), "done"), big).map((texts) => texts.length)).toEqual([0, 1]);
		expect(h.coachEntries()).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});
});

describe("stall detection", () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
	async function waitFor(condition: () => boolean) {
		for (let tries = 0; tries < 200 && !condition(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(condition()).toBe(true);
	}
	/** A session idle after one run, with swarm mode on by default. */
	async function idle() {
		const clock = { now: 1_000 };
		const h = await start({ clock });
		await h.run("start", "ok");
		return { h, clock };
	}

	it("wakes an idle session once for a running agent with no active tool and no telemetry for the stall time", async () => {
		const { h, clock } = await idle();
		h.reply("checking");
		h.emit("a1", { phase: "started" });
		h.emit("a2", { activeTools: ["bash"] });
		clock.now += STALL_MS - 1;
		await settle();
		expect(h.coachEntries()).toEqual([]);
		clock.now += 60_001;
		await waitFor(() => h.requests.length === 2);
		await h.session.waitForIdle();
		const text = stallText([{ agentId: "a1", type: "worker", description: "task a1", idleMs: STALL_MS + 60_000 }]);
		expect(text).toBe('Swarm mode: a background agent has run no tool and reported nothing for a while: a1 (worker, "task a1", idle 11 min). Check each with get_subagent_result (pass verbose: true to inspect progress; do not pass wait: true), redirect it with steer_subagent, or drop its card on swarm_board to stop and relaunch it.');
		expect(h.requests[1]!.conversation.map(textOf).at(-1)).toBe(text);
		expect(h.coachEntries().map(({ display }) => display)).toEqual([false]);

		clock.now += STALL_MS;
		await settle();
		expect(h.requests).toHaveLength(2);
		expect(h.coachEntries()).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("wakes an idle session for an agent stuck in an active tool after activeToolStallMs", async () => {
		const { h, clock } = await idle();
		h.reply("checking");
		h.emit("a1", { activeTools: ["bash"] });
		clock.now += ACTIVE_TOOL_STALL_MS - 1;
		await settle();
		expect(h.coachEntries()).toEqual([]);
		clock.now += 1;
		await waitFor(() => h.requests.length === 2);
		await h.session.waitForIdle();
		const text = stallText([{ agentId: "a1", type: "worker", description: "task a1", idleMs: ACTIVE_TOOL_STALL_MS, activeTools: ["bash"] }]);
		expect(text).toContain("running bash for 25 min");
		expect(text).toContain("stuck in a tool call");
		expect(h.requests[1]!.conversation.map(textOf).at(-1)).toBe(text);

		clock.now += ACTIVE_TOOL_STALL_MS;
		await settle();
		expect(h.requests).toHaveLength(2);
		expect(h.coachEntries()).toHaveLength(1);
	});

	it("names every agent stalled at once in one message", async () => {
		const { h, clock } = await idle();
		h.reply("checking");
		h.emit("a1");
		h.emit("a2", { type: "recon", description: "survey" });
		clock.now += STALL_MS;
		await waitFor(() => h.coachEntries().length === 1);
		await h.session.waitForIdle();
		expect(h.coachEntries()[0]!.content).toBe(stallText([
			{ agentId: "a1", type: "worker", description: "task a1", idleMs: STALL_MS },
			{ agentId: "a2", type: "recon", description: "survey", idleMs: STALL_MS },
		]));
		expect(h.coachEntries()[0]!.content).toContain("2 background agents have");
	});

	it("re-arms for an agent only after new telemetry, and forgets a completed one", async () => {
		const { h, clock } = await idle();
		h.reply("checking", "checking again");
		h.emit("a1");
		clock.now += STALL_MS;
		await waitFor(() => h.coachEntries().length === 1);
		await h.session.waitForIdle();
		h.emit("a1", { turnCount: 2 });
		clock.now += STALL_MS - 1;
		await settle();
		expect(h.coachEntries()).toHaveLength(1);
		clock.now += 1;
		await waitFor(() => h.coachEntries().length === 2);
		await h.session.waitForIdle();
		expect(h.requests).toHaveLength(3);

		h.emit("a1");
		h.emit("a1", { phase: "completed", status: "completed", completedAt: clock.now });
		clock.now += STALL_MS * 2;
		await settle();
		expect(h.coachEntries()).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it.each([
		["has an active tool", { activeTools: ["bash"] }],
		["is queued", { status: "queued" }],
		["belongs to another session", { parentSessionId: "other-session" }],
		["has an owner", { owner: "workflow" }],
		["is nested in another agent", { parentAgentId: "a0" }],
	] as const)("ignores an agent that %s", async (_name, fields) => {
		const { h, clock } = await idle();
		h.emit("a1", fields);
		clock.now += STALL_MS * 2;
		await settle();
		expect(h.coachEntries()).toEqual([]);
		expect(h.requests).toHaveLength(1);
	});

	it("sends nothing while swarm mode is off", async () => {
		const { h, clock } = await idle();
		await h.command("/swarm off");
		h.emit("a1");
		clock.now += STALL_MS * 2;
		await settle();
		expect(h.coachEntries()).toEqual([]);
		expect(h.requests).toHaveLength(1);
	});

	it("steers a streaming run instead of starting another", async () => {
		const clock = { now: 1_000 };
		const h = await start({ clock });
		const made = await h.run("work", async () => {
			h.emit("a1");
			clock.now += STALL_MS;
			// The stall check runs while this request is in flight.
			await settle();
			return calls("edit");
		}, "done");
		expect(made).toHaveLength(2);
		expect(coachTexts(made[1]!)).toEqual([stallText([{ agentId: "a1", type: "worker", description: "task a1", idleMs: STALL_MS }])]);
		await settle();
		expect(h.coachEntries()).toHaveLength(1);
		expect(h.requests).toHaveLength(2);
	});

	it("stops checking at shutdown", async () => {
		const { h, clock } = await idle();
		h.emit("a1");
		await h.dispose();
		clock.now += STALL_MS * 2;
		await settle();
		expect(h.requests).toHaveLength(1);
	});
});

describe("blocked card alerts", () => {
	const card = (id: string, overrides: Partial<SwarmCard> = {}): SwarmCard => ({
		id, title: `task ${id}`, status: "blocked", agent: "worker", agentId: "a1", note: "need API key",
		createdBy: "coordinator", updatedBy: "a1", createdAt: 1, updatedAt: 2, ...overrides,
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
	async function waitFor(condition: () => boolean) {
		for (let tries = 0; tries < 200 && !condition(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(condition()).toBe(true);
	}

	it("wakes an idle session once when a subagent marks a card blocked, and re-alerts on note change or re-block", async () => {
		const h = await start();
		await h.run("start", "ok");
		const sessionId = h.session.sessionManager.getSessionId();

		h.reply("unblocking", "unblocking again", "unblocking third");
		publishBoard(sessionId, [card("c1")]);
		await waitFor(() => h.requests.length === 2);
		await h.session.waitForIdle();

		const expected = blockedText([{ id: "c1", title: "task c1", agent: "worker", agentId: "a1", note: "need API key" }]);
		expect(h.requests[1]!.conversation.map(textOf).at(-1)).toBe(expected);
		expect(h.coachEntries().map(({ display }) => display)).toEqual([false]);

		// Same card and note does not re-alert.
		publishBoard(sessionId, [card("c1")]);
		await settle();
		expect(h.requests).toHaveLength(2);

		// Updated note re-alerts.
		publishBoard(sessionId, [card("c1", { note: "still waiting on schema" })]);
		await waitFor(() => h.requests.length === 3);
		await h.session.waitForIdle();
		expect(h.requests[2]!.conversation.map(textOf).at(-1)).toBe(
			blockedText([{ id: "c1", title: "task c1", agent: "worker", agentId: "a1", note: "still waiting on schema" }]),
		);

		// Leaving blocked and returning to blocked with the same note re-alerts.
		publishBoard(sessionId, [card("c1", { status: "doing", note: "resumed" })]);
		await settle();
		publishBoard(sessionId, [card("c1", { note: "still waiting on schema" })]);
		await waitFor(() => h.requests.length === 4);
		await h.session.waitForIdle();
		expect(h.coachEntries()).toHaveLength(3);
		expect(h.errors).toEqual([]);
	});

	it("ignores coordinator-blocked cards, other sessions, and swarm-off sessions", async () => {
		const h = await start();
		await h.run("start", "ok");
		const sessionId = h.session.sessionManager.getSessionId();

		publishBoard(sessionId, [card("c1", { updatedBy: "coordinator" })]);
		publishBoard("other-session", [card("c2")]);
		await settle();
		expect(h.coachEntries()).toEqual([]);

		await h.command("/swarm off");
		publishBoard(sessionId, [card("c3")]);
		await settle();
		expect(h.coachEntries()).toEqual([]);
		expect(h.requests).toHaveLength(1);
	});

	it("seeds already-blocked cards on session_tree and removes its listener on shutdown", async () => {
		const h = await start({ clock: { now: 1_000 } });
		await h.run("start", "ok");
		const startLeafId = h.session.sessionManager.getLeafId()!;
		const sessionId = h.session.sessionManager.getSessionId();

		await h.command("/swarm off");
		publishBoard(sessionId, [card("c1")]);
		await settle();
		expect(h.coachEntries()).toEqual([]);

		// Navigating back to startLeafId re-enables swarm mode and seeds c1 as already known.
		await h.session.navigateTree(startLeafId, { summarize: false });
		publishBoard(sessionId, [card("c1")]);
		await settle();
		expect(h.coachEntries()).toEqual([]);

		const listenersBefore = getBoardRegistry().listeners.size;
		await h.dispose();
		expect(getBoardRegistry().listeners.size).toBeLessThan(listenersBefore);
	});
});

it("leaves swarm's own messages unchanged", async () => {
	const h = await start();
	await h.command("/swarm off");
	await h.run("one", "ok");
	expect(h.swarmMessages()).toEqual([]);
	await h.command("/swarm on");
	await h.run("two", "ok");
	await h.command("/swarm off");
	await h.run("three", "ok");
	expect(h.swarmMessages().map((text) => (text as string).split(/[:.]/)[0])).toEqual(["Swarm mode 🐝 is on", "Swarm mode is off"]);
	expect(h.coachEntries()).toEqual([]);
	expect(COACH).toEqual({ contextShare: 50, stallMs: 10 * 60_000, activeToolStallMs: 25 * 60_000, checkMs: 60_000 });
});
