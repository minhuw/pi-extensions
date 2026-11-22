// The swarm board in real Pi sessions on the faux provider, with real session files: a coordinator, its subagent children through the child-session hook, and the shared registry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { formatBoardCompact, MAX_BYTES, MAX_CARDS, MAX_NOTE_CHARS, MAX_TITLE_CHARS, pruneSettled, registerBoard, type SwarmBoard, type SwarmBoards } from "../board.ts";
import {
	captureRequest,
	CHILD_SESSION_HOOKS,
	createDelegationSandbox,
	createDelegationSession,
	SESSION_MODES,
	SWARM_BOARDS,
	type CapturedRequest,
	type DelegationSandbox,
	type SessionModesRegistry,
} from "./support/session-harness.ts";

const SESSION_LINK = "pi-extensions.session-link";
const CHILD_SECTION = 'You are one of several agents sharing a swarm board with your coordinator. Call swarm_board with action "list" before editing files another card may own; post progress with note, set blocked with the reason when you need the coordinator, and add todo cards for follow-up work you find instead of doing it.';

/** The registry as pika reads it, created by whoever reads it first. */
const registry = () => ((globalThis as Record<symbol, unknown>)[SWARM_BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() }) as SwarmBoards;
const hooks = () => (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS] as Set<{ name: string; extensionFactory: ExtensionFactory }> | undefined;
const boardHook = () => [...hooks() ?? []].find((hook) => hook.name === "swarm-board");
const modeRegistry = () => (globalThis as Record<symbol, unknown>)[SESSION_MODES] as SessionModesRegistry | undefined;

let sandbox: DelegationSandbox;

beforeEach(async () => {
	sandbox = await createDelegationSandbox("pi-board-");
});

afterEach(async () => {
	try {
		await sandbox.cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

interface StartOptions {
	sessionManager?: SessionManager;
	mode?: ExtensionContext["mode"];
	/** Load what the child-session hook loads and bind as Subagents binds a child, with no mode. */
	child?: boolean;
	/** In a child, also load Delegation itself, whose wider tool then serves the child. */
	delegation?: boolean;
	on?: { value: boolean };
}

async function start(options: StartOptions = {}) {
	const on = options.on ?? { value: true };
	const hook = options.child ? boardHook() : undefined;
	const base = await createDelegationSession({
		sandbox,
		sessionManager: options.sessionManager,
		api: "board-test-api",
		provider: "board-test",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		loadExtension: false,
		extensionFactories: [
			...(!options.child || options.delegation ? [(pi: ExtensionAPI) => registerBoard(pi, () => on.value)] : []),
			...(hook ? [hook.extensionFactory] : []),
		],
		mode: options.mode,
		bindAsChild: options.child,
		ui: "none",
		commandContextActions: false,
	});
	const harness = {
		runtime: base.runtime,
		faux: base.faux,
		requests: base.requests,
		errors: base.errors,
		on,
		get events() { return base.events; },
		get session() { return base.session; },
		get sessionId() { return base.sessionId; },
		get board() { return registry().boards.get(base.sessionId); },
		/** Emit Subagents telemetry on this session's event bus, as its Subagents extension does. */
		telemetry: (data: Record<string, unknown>) => base.events.emit("subagents:telemetry", { status: "running", type: "worker", description: "", parentSessionId: base.sessionId, ...data }),
		tools: () => base.session.getAllTools().map((tool) => tool.name),
		/** Run one prompt answered with plain text. */
		async run(prompt = "go") {
			harness.faux.setResponses([respond(harness, () => fauxAssistantMessage("ok"))]);
			await base.session.prompt(prompt);
			return base.requests.at(-1)!;
		},
		/** Have the model call swarm_board once and return the tool's result. */
		async call(args: Record<string, string | boolean>) {
			harness.faux.setResponses([
				respond(harness, () => fauxAssistantMessage(fauxToolCall("swarm_board", args))),
				respond(harness, () => fauxAssistantMessage("ok")),
			]);
			await base.session.prompt(`call ${JSON.stringify(args)}`);
			const resultEntry = base.session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []).at(-1)!;
			const text = (resultEntry.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");
			return { text, isError: resultEntry.isError };
		},
		/** The board snapshots on the current branch. */
		snapshots: () => base.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "swarm-board" ? [entry.data as SwarmBoard] : []),
		dispose: base.dispose,
	};
	return harness;
}
type Harness = Awaited<ReturnType<typeof start>>;

const respond = (h: { requests: CapturedRequest[] }, reply: () => ReturnType<FauxResponseFactory>): FauxResponseFactory => ({ messages }) => {
	h.requests.push(captureRequest(messages));
	return reply();
};

/** A subagent child of `parent`, linked as Subagents links one before binding the child's extensions. */
async function startChild(parent: Harness | string, link: Record<string, unknown> = {}, options: Pick<StartOptions, "delegation"> = {}) {
	const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
	manager.appendCustomEntry(SESSION_LINK, { kind: "subagent", parentSessionId: typeof parent === "string" ? parent : parent.sessionId, agentType: "worker", ...link });
	return start({ sessionManager: manager, child: true, ...options });
}

const cards = (h: Harness) => h.board?.cards.map(({ id, title, status, agentId, agent, note, createdBy, updatedBy }) => ({ id, title, status, agentId, agent, note, createdBy, updatedBy }));
const strip = <T extends object>(value: T) => JSON.parse(JSON.stringify(value)) as T;

describe("coordinator", () => {
	it("refuses while swarm mode is off and opens when it is on", async () => {
		const h = await start({ on: { value: false } });
		expect(h.tools()).toContain("swarm_board");
		const off = await h.call({ action: "list" });
		expect(off.isError).toBe(true);
		expect(off.text).toContain("Swarm mode is off");
		expect(h.board).toBeUndefined();
		h.on.value = true;
		const on = await h.call({ action: "list" });
		expect(on).toEqual({ text: "The swarm board has no cards.", isError: false });
		expect(h.errors).toEqual([]);
	});

	it("adds, updates, links, and drops cards and lists them grouped by status", async () => {
		const h = await start();
		expect((await h.call({ action: "add", title: "Parser" })).text).toContain("Added c1.");
		await h.call({ action: "add", title: "Docs", status: "doing", note: "draft" });
		await h.call({ action: "update", id: "c1", status: "blocked", note: "needs API", agentId: "a1" });
		await h.call({ action: "add", title: "Old" });
		await h.call({ action: "drop", id: "c3" });
		expect(cards(h)).toEqual(strip([
			{ id: "c1", title: "Parser", status: "blocked", agentId: "a1", note: "needs API", createdBy: "coordinator", updatedBy: "coordinator" },
			{ id: "c2", title: "Docs", status: "doing", note: "draft", createdBy: "coordinator", updatedBy: "coordinator" },
			{ id: "c3", title: "Old", status: "dropped", createdBy: "coordinator", updatedBy: "coordinator" },
		]));
		expect((await h.call({ action: "list" })).text).toBe("doing:\n- c2 Docs — draft\nblocked:\n- c1 [a1] Parser — needs API\nsettled: 1 dropped");
		expect((await h.call({ action: "list", includeSettled: true })).text).toBe("doing:\n- c2 Docs — draft\nblocked:\n- c1 [a1] Parser — needs API\ndropped:\n- c3 Old");
		const missing = await h.call({ action: "update", id: "c9", status: "done" });
		expect(missing).toEqual({ text: "No card c9 on the swarm board.", isError: true });
		const taken = await h.call({ action: "update", id: "c2", agentId: "a1" });
		expect(taken).toEqual({ text: "Agent a1 is already on card c1.", isError: true });
		const noteRefused = await h.call({ action: "note", note: "mine" });
		expect(noteRefused.isError).toBe(true);
		expect(noteRefused.text).toContain("Validation failed");
		expect(h.snapshots().at(-1)!.cards).toEqual(h.board!.cards);
	});

	it("absorbs an unmodified auto-created card when linking agentId on update or add, and normalizes blank optional args", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Planned task", agentId: "  " });
		h.telemetry({ phase: "started", agentId: "a1", type: "worker", description: "Auto title" });
		expect(h.board!.cards).toHaveLength(2);
		// Linking c1 to a1 absorbs the bare auto-created c2, copying agent and adopting doing status.
		const linked = await h.call({ action: "update", id: " c1 ", agentId: " a1 " });
		expect(linked.isError).toBe(false);
		expect(cards(h)).toEqual(strip([
			{ id: "c1", title: "Planned task", status: "doing", agentId: "a1", agent: "worker", createdBy: "coordinator", updatedBy: "coordinator" },
		]));

		// add with agentId also absorbs an unmodified auto-created card, while respecting explicit status.
		h.telemetry({ phase: "started", agentId: "a2", type: "recon", description: "Auto recon" });
		expect((await h.call({ action: "add", title: "Explicit recon", status: "blocked", agentId: "a2", note: "waiting" })).isError).toBe(false);
		expect(cards(h)!.find((c) => c.agentId === "a2")).toEqual(strip({
			id: "c4", title: "Explicit recon", status: "blocked", agentId: "a2", agent: "recon", note: "waiting", createdBy: "coordinator", updatedBy: "coordinator",
		}));
		// Clearing note with empty string still works; blank id is rejected.
		expect((await h.call({ action: "update", id: "c4", note: "" })).isError).toBe(false);
		expect(cards(h)!.find((c) => c.id === "c4")!.note).toBeUndefined();
		expect(await h.call({ action: "update", id: "   ", status: "done" })).toEqual({ text: "update needs a card id.", isError: true });

		// Does not absorb a card that is blocked, dropped, has a note, or was touched by an agent.
		expect(await h.call({ action: "add", title: "Clash blocked", agentId: "a2" })).toEqual({ text: "Agent a2 is already on card c4.", isError: true });
		await h.call({ action: "update", id: "c1", note: "has progress" });
		expect(await h.call({ action: "add", title: "Clash noted", agentId: "a1" })).toEqual({ text: "Agent a1 is already on card c1.", isError: true });
	});

	it("formats compactly by default and prunes settled cards without spurious mutations", async () => {
		const h = await start();
		expect(formatBoardCompact(undefined)).toBe("The swarm board has no cards.");
		await h.call({ action: "add", title: "Open", status: "doing" });
		await h.call({ action: "add", title: "Finished", status: "done" });
		await h.call({ action: "add", title: "Errored", status: "failed" });
		await h.call({ action: "add", title: "Skipped", status: "dropped" });
		expect((await h.call({ action: "list" })).text).toBe("doing:\n- c1 Open\nsettled: 1 done, 1 failed, 1 dropped");
		expect((await h.call({ action: "list", includeSettled: true })).text).toContain("done:\n- c2 Finished");

		const pruned = await h.call({ action: "prune" });
		expect(pruned.isError).toBe(false);
		expect(pruned.text).toBe("Pruned 3 settled card(s).\ndoing:\n- c1 Open");
		expect(h.board!.cards.map((c) => c.id)).toEqual(["c1"]);

		// Second prune is a no-op and does not publish a new board.
		const before = h.board!;
		const noop = await h.call({ action: "prune" });
		expect(noop.isError).toBe(false);
		expect(noop.text).toBe("No settled cards to prune.\ndoing:\n- c1 Open");
		expect(h.board).toBe(before);
		expect(pruneSettled(h.sessionId)).toEqual({ removed: 0, board: before });

		// Board with only settled cards shows "No open cards.\nsettled: ...".
		await h.call({ action: "update", id: "c1", status: "done" });
		expect((await h.call({ action: "list" })).text).toBe("No open cards.\nsettled: 1 done");
		expect((await h.call({ action: "prune" })).text).toBe("Pruned 1 settled card(s).\nThe swarm board has no cards.");
	});

	it("persists each change as a snapshot and restores the latest when the session is reopened", async () => {
		const h = await start();
		await h.call({ action: "add", title: "One" });
		await h.call({ action: "add", title: "Two" });
		expect(h.snapshots().map((board) => board.cards.length)).toEqual([1, 2]);
		const file = h.session.sessionFile!;
		const id = h.sessionId;
		await h.dispose();
		expect(registry().boards.has(id)).toBe(false);
		const reopened = await start({ sessionManager: SessionManager.open(file, sandbox.sessionDir) });
		expect(reopened.board?.cards.map((card) => card.title)).toEqual(["One", "Two"]);
		// Restoring writes nothing.
		expect(reopened.snapshots()).toHaveLength(2);
	});

	it("takes the board of the branch /tree lands on", async () => {
		const h = await start();
		await h.call({ action: "add", title: "One" });
		const afterOne = h.session.sessionManager.getLeafId()!;
		await h.call({ action: "add", title: "Two" });
		expect(h.board!.cards).toHaveLength(2);
		await h.session.navigateTree(afterOne);
		expect(h.board!.cards.map((card) => card.title)).toEqual(["One"]);
		await h.call({ action: "add", title: "Three" });
		expect(h.board!.cards.map((card) => card.id)).toEqual(["c1", "c2"]);
		expect(h.board!.cards[1]!.title).toBe("Three");
		const first = h.session.sessionManager.getEntries().find((entry) => entry.type === "message")!;
		await h.session.navigateTree(first.id);
		expect(h.board!.cards).toEqual([]);
	});

	it("gives a print-mode session no board", async () => {
		const h = await start({ mode: "print" });
		expect(await h.call({ action: "list" })).toEqual({ text: "This session has no swarm board.", isError: true });
	});

	it("opens an empty board at the run's start so children launched during it find one", async () => {
		const h = await start();
		expect(h.board).toBeUndefined();
		await h.run();
		expect(h.board?.cards).toEqual([]);
		expect(h.snapshots()).toEqual([]);
	});
});

describe("telemetry", () => {
	it("opens doing cards for the session's own agents and settles them", async () => {
		const h = await start();
		h.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		h.telemetry({ phase: "started", agentId: "a2", type: "recon", description: "Map callers" });
		h.telemetry({ phase: "started", agentId: "x9", description: "Elsewhere", parentSessionId: "another-session" });
		h.telemetry({ phase: "updated", agentId: "a3", description: "Not a start" });
		expect(cards(h)).toEqual(strip([
			{ id: "c1", title: "Fix parser", status: "doing", agentId: "a1", agent: "worker", createdBy: "coordinator", updatedBy: "coordinator" },
			{ id: "c2", title: "Map callers", status: "doing", agentId: "a2", agent: "recon", createdBy: "coordinator", updatedBy: "coordinator" },
		]));
		h.telemetry({ phase: "completed", agentId: "a1", status: "completed" });
		h.telemetry({ phase: "completed", agentId: "a2", status: "aborted" });
		expect(h.board!.cards.map((card) => card.status)).toEqual(["done", "failed"]);
		// Changes from outside the coordinator's own calls are persisted together, shortly after.
		await vi.waitFor(() => expect(h.snapshots().at(-1)?.cards.map((card) => card.status)).toEqual(["done", "failed"]));
		expect(h.snapshots()).toHaveLength(1);
	});

	it("logs a timed persistence failure and retries the unchanged board on a later tool call only once", async () => {
		const h = await start();
		const failure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = h.session.sessionManager;
		const append = manager.appendCustomEntry.bind(manager);
		const attempted: SwarmBoard[] = [];
		let full = true;
		vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
			if (type === "swarm-board") {
				attempted.push(data as SwarmBoard);
				if (full) throw failure;
			}
			return append(type, data);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			h.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
			await vi.advanceTimersByTimeAsync(100);
			expect(logged).toHaveBeenCalledExactlyOnceWith("swarm board: could not persist:", failure);
			expect(h.snapshots()).toEqual([]);
			// A failed flush stays dirty without starting an automatic retry loop.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(attempted).toEqual([h.board]);
		} finally {
			vi.useRealTimers();
		}

		const pending = h.board!;
		full = false;
		expect((await h.call({ action: "list" })).isError).toBe(false);
		expect(h.board).toBe(pending);
		expect(attempted).toHaveLength(2);
		expect(attempted[0]).toBe(pending);
		expect(attempted[1]).toBe(pending);
		expect(h.snapshots()).toEqual([pending]);
		await h.call({ action: "list" });
		await h.dispose();
		expect(attempted).toHaveLength(2);
		expect(h.snapshots()).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("retries on shutdown and cleans up even when persistence still fails", async () => {
		const h = await start();
		await h.run();
		const child = await startChild(h, { agentId: "a1" });
		expect(registry().members?.get(child.sessionId)).toBe(h.sessionId);
		const failure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = h.session.sessionManager;
		const append = manager.appendCustomEntry.bind(manager);
		const attempted: SwarmBoard[] = [];
		vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
			if (type === "swarm-board") {
				attempted.push(data as SwarmBoard);
				throw failure;
			}
			return append(type, data);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			h.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
			await vi.advanceTimersByTimeAsync(100);
		} finally {
			vi.useRealTimers();
		}
		const pending = h.board!;
		await expect(h.dispose()).resolves.toBeUndefined();
		expect(attempted).toHaveLength(2);
		expect(attempted[0]).toBe(pending);
		expect(attempted[1]).toBe(pending);
		expect(logged).toHaveBeenCalledTimes(2);
		expect(logged).toHaveBeenLastCalledWith("swarm board: could not persist:", failure);
		expect(h.snapshots()).toEqual([]);
		expect(registry().boards.has(h.sessionId)).toBe(false);
		expect(registry().members?.has(child.sessionId)).toBe(false);
		expect(registry().listeners.size).toBe(0);
		expect(h.errors).toEqual([]);
	});

	it("moves a linked todo card to doing, keeps a blocked card blocked on a normal end, and leaves dropped cards", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Planned" });
		await h.call({ action: "update", id: "c1", agentId: "a1" });
		await h.call({ action: "add", title: "Gone", status: "doing" });
		await h.call({ action: "update", id: "c2", agentId: "a2" });
		await h.call({ action: "drop", id: "c2" });
		h.telemetry({ phase: "started", agentId: "a1", description: "Ignored title" });
		h.telemetry({ phase: "started", agentId: "a2", description: "Ignored" });
		expect(h.board!.cards.map((card) => [card.title, card.status])).toEqual([["Planned", "doing"], ["Gone", "dropped"]]);
		await h.call({ action: "update", id: "c1", status: "blocked", note: "which API?" });
		h.telemetry({ phase: "completed", agentId: "a1", status: "steered" });
		expect(h.board!.cards[0]!.status).toBe("blocked");
		h.telemetry({ phase: "completed", agentId: "a1", status: "error" });
		expect(h.board!.cards[0]!.status).toBe("failed");
		h.telemetry({ phase: "completed", agentId: "a2", status: "completed" });
		expect(h.board!.cards[1]!.status).toBe("dropped");
	});

	it("tracks nothing while swarm mode is off", async () => {
		const h = await start({ on: { value: false } });
		h.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		expect(h.board).toBeUndefined();
	});
});

describe("children", () => {
	it("dynamically registers the child-session hook only while a coordinator is active or a board exists", async () => {
		expect(boardHook()).toBeUndefined();

		const off = await start({ on: { value: false } });
		expect(boardHook()).toBeUndefined();

		// Turning swarm on notifies session-modes listeners and installs the hook.
		off.on.value = true;
		for (const listener of modeRegistry()!.listeners) listener(off.sessionId);
		expect(boardHook()).toBeDefined();

		// Turning swarm back off with no board removes the hook.
		off.on.value = false;
		for (const listener of modeRegistry()!.listeners) listener(off.sessionId);
		expect(boardHook()).toBeUndefined();

		// Starting a second coordinator with swarm on installs the hook; disposing the first keeps it.
		const active = await start({ on: { value: true } });
		expect(boardHook()).toBeDefined();
		await off.dispose();
		expect(boardHook()).toBeDefined();

		// Disposing the last active coordinator removes the hook.
		await active.dispose();
		expect(boardHook()).toBeUndefined();
	});

	it("gives a subagent child a board limited to its own card and todo cards, with a static cache-safe section", async () => {
		const coordinator = await start();
		coordinator.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		await coordinator.call({ action: "add", title: "Docs", status: "doing" });
		const child = await startChild(coordinator, { agentId: "a1", description: "Fix parser" });
		expect(child.tools()).toContain("swarm_board");

		const listed = await child.call({ action: "list" });
		expect(listed.text).toBe("Your card: c1.\ndoing:\n- c1 [worker a1] Fix parser\n- c2 Docs");
		const first = child.requests[0]!;
		expect(first.system).toContain(`<swarm-board>\n${CHILD_SECTION}\n</swarm-board>`);
		expect(first.system).not.toContain("Your card: c1.");
		expect(first.system).not.toContain("Open cards:");

		expect((await child.call({ action: "note", note: "halfway" })).isError).toBe(false);
		expect((await child.call({ action: "note", status: "blocked", note: "need the schema" })).isError).toBe(false);
		// The child's schema leaves out what it may not do.
		for (const args of [{ action: "note", status: "done", note: "finished" }, { action: "drop", id: "c2" }, { action: "update", id: "c2", title: "Renamed" }] as Record<string, string>[]) {
			const refused = await child.call(args);
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain('Validation failed for tool "swarm_board"');
		}
		expect((await child.call({ action: "add", title: "Follow-up", note: "flaky test" })).text).toContain("Added c3.");
		expect(cards(coordinator)).toEqual(strip([
			{ id: "c1", title: "Fix parser", status: "blocked", agentId: "a1", agent: "worker", note: "need the schema", createdBy: "coordinator", updatedBy: "a1" },
			{ id: "c2", title: "Docs", status: "doing", createdBy: "coordinator", updatedBy: "coordinator" },
			{ id: "c3", title: "Follow-up", status: "todo", note: "flaky test", createdBy: "a1", updatedBy: "a1" },
		]));
		// The section stays fixed after the first run, though the board changed.
		const last = child.requests.at(-1)!;
		expect(last.system).toBe(first.system);
		// The coordinator's instance persists what its children changed.
		await vi.waitFor(() => expect(coordinator.snapshots().at(-1)?.cards).toEqual(coordinator.board!.cards));
	});

	it("gives a child loading Delegation the childTool schema (replacing coordinatorTool)", async () => {
		const coordinator = await start();
		coordinator.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		await coordinator.call({ action: "add", title: "Docs" });
		await coordinator.call({ action: "add", title: "Done work", status: "done" });
		const child = await startChild(coordinator, { agentId: "a1" }, { delegation: true });
		expect(child.tools().filter((name) => name === "swarm_board")).toHaveLength(1);
		for (const args of [
			{ action: "note", status: "done", note: "finished" },
			{ action: "drop", id: "c2" },
			{ action: "update", id: "c2", title: "Renamed" },
			{ action: "prune" },
		] as Record<string, string | boolean>[]) {
			const refused = await child.call(args);
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain("Validation failed");
		}
		expect((await child.call({ action: "list" })).text).toContain("settled: 1 done");
		expect((await child.call({ action: "list", includeSettled: true })).text).toContain("done:\n- c3 Done work");
		expect((await child.call({ action: "note", note: "progress" })).isError).toBe(false);
		expect((await child.call({ action: "add", title: "Follow-up" })).isError).toBe(false);
		expect(cards(coordinator)!.map((card) => [card.title, card.status, card.updatedBy])).toEqual([
			["Fix parser", "doing", "a1"],
			["Docs", "todo", "coordinator"],
			["Done work", "done", "coordinator"],
			["Follow-up", "todo", "a1"],
		]);
		expect(child.requests[0]!.system).toContain(CHILD_SECTION);
	});

	it("creates a child's own card on its first note when it has none, and refuses a dropped one", async () => {
		const coordinator = await start();
		await coordinator.run();
		const child = await startChild(coordinator, { agentId: "a7", description: "Write tests" });
		expect(child.requests).toEqual([]);
		await child.call({ action: "note", note: "started" });
		expect(cards(coordinator)).toEqual(strip([
			{ id: "c1", title: "Write tests", status: "doing", agentId: "a7", agent: "worker", note: "started", createdBy: "a7", updatedBy: "a7" },
		]));
		expect(child.requests[0]!.system).toContain(CHILD_SECTION);
		await coordinator.call({ action: "drop", id: "c1" });
		expect(await child.call({ action: "note", note: "more" })).toEqual({ text: "The coordinator dropped your card c1; stop and report back.", isError: true });
	});

	it("resolves a nested child to the root coordinator's board", async () => {
		const coordinator = await start();
		coordinator.telemetry({ phase: "started", agentId: "a1", description: "Lead" });
		const child = await startChild(coordinator, { agentId: "a1" });
		const nested = await startChild(child, { agentId: "n1", parentAgentId: "a1", description: "Sub-task" });
		expect(nested.tools()).toContain("swarm_board");
		await nested.call({ action: "note", note: "on it" });
		expect(registry().members?.get(nested.sessionId)).toBe(coordinator.sessionId);
		expect(cards(coordinator)!.map((card) => [card.id, card.agentId, card.createdBy])).toEqual([["c1", "a1", "coordinator"], ["c2", "n1", "n1"]]);
		// Nested agents' telemetry reaches the coordinator through its Subagents and lands on the same card.
		coordinator.telemetry({ phase: "completed", agentId: "n1", status: "completed", parentSessionId: child.sessionId });
		expect(coordinator.board!.cards[1]!.status).toBe("done");
	});

	it("gives no board to Herder steps, to children of a session without one, or to children without an agent id", async () => {
		const coordinator = await start({ on: { value: false } });
		const orphan = await startChild(coordinator, { agentId: "a1" });
		expect(orphan.tools()).not.toContain("swarm_board");
		coordinator.on.value = true;
		await coordinator.run();
		const herderManager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
		herderManager.appendCustomEntry(SESSION_LINK, { kind: "herder", parentSessionId: coordinator.sessionId, agentId: "h1" });
		const herder = await start({ sessionManager: herderManager, child: true });
		expect(herder.tools()).not.toContain("swarm_board");
		const anonymous = await startChild(coordinator);
		expect(anonymous.tools()).not.toContain("swarm_board");
		await herder.run();
		expect(herder.requests[0]!.system).not.toContain("<swarm-board>");
	});
});

describe("registry contract", () => {
	it("replaces the board object on every change and calls each listener with it, past a failing one", async () => {
		const failure = vi.spyOn(console, "error").mockImplementation(() => {});
		const seen: SwarmBoard[] = [];
		registry().listeners.add(() => { throw new Error("listener bug"); });
		registry().listeners.add((board) => { seen.push(board); });
		const h = await start();
		await h.call({ action: "add", title: "One" });
		const before = h.board!;
		await h.call({ action: "update", id: "c1", status: "doing" });
		expect(h.board).not.toBe(before);
		expect(before.cards[0]!.status).toBe("todo");
		expect(h.board!.updatedAt).toBeGreaterThan(before.updatedAt);
		expect(seen.at(-1)).toBe(h.board);
		expect(registry().version).toBe(1);
		const [card] = h.board!.cards;
		expect(Object.keys(h.board!).sort()).toEqual(["cards", "nextId", "sessionId", "updatedAt", "version"]);
		expect(h.board).toMatchObject({ version: 1, sessionId: h.sessionId, nextId: 2 });
		expect(card).toEqual({ id: "c1", title: "One", status: "doing", createdBy: "coordinator", updatedBy: "coordinator", createdAt: expect.any(Number), updatedAt: expect.any(Number) });
		expect(failure).toHaveBeenCalledWith("swarm board listener failed:", expect.any(Error));
	});
});

describe("drop stops linked agent", () => {
	it("emits subagents:rpc:stop for a linked agent and reports stopped vs already settled", async () => {
		const h = await start();
		h.telemetry({ phase: "started", agentId: "a1", description: "Long task" });
		h.telemetry({ phase: "started", agentId: "a2", description: "Settled task" });
		await h.call({ action: "add", title: "Unlinked task" });

		const stopCalls: { requestId: string; agentId: string }[] = [];
		// Mirror Subagents' async handleRpc (replies on microtask).
		h.events.on("subagents:rpc:stop", async (raw) => {
			const req = raw as { requestId: string; agentId: string };
			stopCalls.push(req);
			await Promise.resolve();
			if (req.agentId === "a1") h.events.emit(`subagents:rpc:stop:reply:${req.requestId}`, { success: true });
			else h.events.emit(`subagents:rpc:stop:reply:${req.requestId}`, { success: false, error: "Agent is not running" });
		});

		const droppedRunning = await h.call({ action: "drop", id: "c1" });
		expect(droppedRunning.isError).toBe(false);
		expect(droppedRunning.text).toContain("Dropped c1 (stopped agent a1).");
		expect(stopCalls.map((c) => c.agentId)).toEqual(["a1"]);

		const droppedSettled = await h.call({ action: "drop", id: "c2" });
		expect(droppedSettled.isError).toBe(false);
		expect(droppedSettled.text).toMatch(/^Dropped c2\.\n/);
		expect(stopCalls.map((c) => c.agentId)).toEqual(["a1", "a2"]);

		// Dropping a card with no agentId does not emit subagents:rpc:stop.
		const droppedUnlinked = await h.call({ action: "drop", id: "c3" });
		expect(droppedUnlinked.isError).toBe(false);
		expect(droppedUnlinked.text).toMatch(/^Dropped c3\.\n/);
		expect(stopCalls).toHaveLength(2);
	});

	it("does not emit subagents:rpc:stop when another open card shares the same agentId", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Primary", status: "doing", agentId: "a1" });
		// Seed a second open card sharing agentId "a1" directly in the registry.
		const now = h.board!.updatedAt + 1;
		registry().boards.set(h.sessionId, {
			...h.board!,
			updatedAt: now,
			nextId: 3,
			cards: [
				...h.board!.cards,
				{ id: "c2", title: "Secondary", status: "todo", agentId: "a1", createdBy: "coordinator", updatedBy: "coordinator", createdAt: now, updatedAt: now },
			],
		});

		const stopCalls: unknown[] = [];
		h.events.on("subagents:rpc:stop", (raw) => {
			stopCalls.push(raw);
			const req = raw as { requestId: string };
			h.events.emit(`subagents:rpc:stop:reply:${req.requestId}`, { success: true });
		});

		const droppedFirst = await h.call({ action: "drop", id: "c1" });
		expect(droppedFirst.isError).toBe(false);
		expect(droppedFirst.text).toMatch(/^Dropped c1\.\n/);
		expect(stopCalls).toEqual([]);

		// Once c2 is the last open card for a1, dropping c2 DOES stop a1.
		const droppedSecond = await h.call({ action: "drop", id: "c2" });
		expect(droppedSecond.isError).toBe(false);
		expect(droppedSecond.text).toContain("Dropped c2 (stopped agent a1).");
		expect(stopCalls).toHaveLength(1);
	});
});

describe("unblocking on steer and resume", () => {
	it("moves a blocked card to doing and clears blocker note on subagents:steered, then allows completion to settle it", async () => {
		const h = await start();
		h.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		const child = await startChild(h, { agentId: "a1" });
		await child.call({ action: "note", status: "blocked", note: "need schema decision" });
		expect(h.board!.cards[0]).toMatchObject({ id: "c1", status: "blocked", note: "need schema decision" });

		// Steering unblocks and clears the stale blocker note.
		h.events.emit("subagents:steered", { id: "a1", message: "use v2 schema" });
		expect(h.board!.cards[0]).toMatchObject({ id: "c1", status: "doing", updatedBy: "coordinator" });
		expect(h.board!.cards[0]!.note).toBeUndefined();

		// Normal completion now settles it to done without reviving the blocker note.
		h.telemetry({ phase: "completed", agentId: "a1", status: "completed" });
		expect(h.board!.cards[0]!.status).toBe("done");
		expect(h.board!.cards[0]!.note).toBeUndefined();
	});

	it("clears stale blocker note when a blocked card's agent restarts via telemetry started", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Blocked work", status: "blocked", agentId: "a1", note: "waiting on API" });
		expect(h.board!.cards[0]!.note).toBe("waiting on API");

		h.telemetry({ phase: "started", agentId: "a1", description: "Blocked work" });
		expect(h.board!.cards[0]).toMatchObject({ id: "c1", status: "doing", updatedBy: "coordinator" });
		expect(h.board!.cards[0]!.note).toBeUndefined();
	});

	it("ignores subagents:steered when swarm mode is off or the card is not blocked", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Active", status: "doing", agentId: "a1", note: "keep this note" });
		const before = h.board!;
		h.events.emit("subagents:steered", { id: "a1", message: "nudge" });
		expect(h.board).toBe(before);
		expect(h.board!.cards[0]!.note).toBe("keep this note");

		await h.call({ action: "update", id: "c1", status: "blocked", note: "stuck" });
		h.on.value = false;
		const beforeOff = h.board!;
		h.events.emit("subagents:steered", { id: "a1", message: "ignored while off" });
		expect(h.board).toBe(beforeOff);
		expect(h.board!.cards[0]!.status).toBe("blocked");
	});
});

describe("monotonic IDs", () => {
	it("never reuses card IDs after prune, linkAgent absorption, or session reopen", async () => {
		const h = await start();
		await h.call({ action: "add", title: "Keep", status: "doing" }); // c1
		await h.call({ action: "add", title: "Done 1", status: "done" }); // c2
		await h.call({ action: "add", title: "Done 2", status: "done" }); // c3
		await h.call({ action: "prune" });
		expect(h.board!.cards.map((c) => c.id)).toEqual(["c1"]);
		expect(h.board!.nextId).toBe(4);

		// Next add after prune gets c4, not c2.
		await h.call({ action: "add", title: "After prune" }); // c4
		expect(h.board!.cards.map((c) => c.id)).toEqual(["c1", "c4"]);

		// Auto-created c5 absorbed by linking c4 -> next telemetry gets c6, not c5.
		h.telemetry({ phase: "started", agentId: "a1", description: "Auto c5" }); // c5
		await h.call({ action: "update", id: "c4", agentId: "a1" }); // absorbs c5
		h.telemetry({ phase: "started", agentId: "a2", description: "Next agent" }); // c6
		expect(h.board!.cards.map((c) => c.id)).toEqual(["c1", "c4", "c6"]);

		// Prune and reopen: nextId survives persistence and restore.
		await h.call({ action: "update", id: "c6", status: "done" });
		await h.call({ action: "prune" });
		const file = h.session.sessionFile!;
		await h.dispose();

		const reopened = await start({ sessionManager: SessionManager.open(file, sandbox.sessionDir) });
		expect(reopened.board!.nextId).toBe(7);
		await reopened.call({ action: "add", title: "After reopen" });
		expect(reopened.board!.cards.map((c) => c.id)).toEqual(["c1", "c4", "c7"]);
	});
});

describe("bounds and truncation", () => {
	it("truncates long titles and notes with trailing ellipsis across coordinator, child, and telemetry paths", async () => {
		const h = await start();
		const longTitle = "T".repeat(MAX_TITLE_CHARS + 50);
		const longNote = "N".repeat(MAX_NOTE_CHARS + 50);

		await h.call({ action: "add", title: longTitle, note: longNote });
		expect(h.board!.cards[0]!.title).toBe(`${"T".repeat(MAX_TITLE_CHARS - 1)}…`);
		expect(h.board!.cards[0]!.note).toBe(`${"N".repeat(MAX_NOTE_CHARS - 1)}…`);

		await h.call({ action: "update", id: "c1", title: "U".repeat(MAX_TITLE_CHARS + 20), note: "M".repeat(MAX_NOTE_CHARS + 20) });
		expect(h.board!.cards[0]!.title).toBe(`${"U".repeat(MAX_TITLE_CHARS - 1)}…`);
		expect(h.board!.cards[0]!.note).toBe(`${"M".repeat(MAX_NOTE_CHARS - 1)}…`);

		h.telemetry({ phase: "started", agentId: "a1", description: "D".repeat(MAX_TITLE_CHARS + 30) });
		expect(h.board!.cards[1]!.title).toBe(`${"D".repeat(MAX_TITLE_CHARS - 1)}…`);

		const child = await startChild(h, { agentId: "a1" });
		await child.call({ action: "note", note: "C".repeat(MAX_NOTE_CHARS + 10) });
		expect(h.board!.cards[1]!.note).toBe(`${"C".repeat(MAX_NOTE_CHARS - 1)}…`);

		await child.call({ action: "add", title: "F".repeat(MAX_TITLE_CHARS + 10), note: "R".repeat(MAX_NOTE_CHARS + 10) });
		expect(h.board!.cards[2]!.title).toBe(`${"F".repeat(MAX_TITLE_CHARS - 1)}…`);
		expect(h.board!.cards[2]!.note).toBe(`${"R".repeat(MAX_NOTE_CHARS - 1)}…`);
	});

	it("evicts oldest settled cards when exceeding MAX_CARDS while preserving open cards", async () => {
		const h = await start();
		await h.run();
		const seeded: SwarmBoard["cards"] = [
			{ id: "c1", title: "Open oldest", status: "doing", createdBy: "coordinator", updatedBy: "coordinator", createdAt: 1, updatedAt: 1 },
			{ id: "c2", title: "Settled oldest tie A", status: "done", createdBy: "coordinator", updatedBy: "coordinator", createdAt: 2, updatedAt: 10 },
			{ id: "c3", title: "Settled oldest tie B", status: "failed", createdBy: "coordinator", updatedBy: "coordinator", createdAt: 3, updatedAt: 10 },
		];
		for (let i = 4; i <= MAX_CARDS; i++) {
			seeded.push({ id: `c${i}`, title: `Done ${i}`, status: "done", createdBy: "coordinator", updatedBy: "coordinator", createdAt: i, updatedAt: 100 + i });
		}
		registry().boards.set(h.sessionId, { version: 1, sessionId: h.sessionId, updatedAt: 1000, cards: seeded, nextId: MAX_CARDS + 1 });

		await h.call({ action: "add", title: "New open" });
		expect(h.board!.cards).toHaveLength(MAX_CARDS);
		// Tie broken by earliest index: c2 evicted, c1 (open) and c3 preserved.
		expect(h.board!.cards.some((c) => c.id === "c1")).toBe(true);
		expect(h.board!.cards.some((c) => c.id === "c2")).toBe(false);
		expect(h.board!.cards.some((c) => c.id === "c3")).toBe(true);
		expect(h.board!.cards.at(-1)!.id).toBe(`c${MAX_CARDS + 1}`);
	});

	it("evicts oldest settled cards when exceeding MAX_BYTES and never deletes open cards", async () => {
		const h = await start();
		await h.run();
		const bigTitle = "X".repeat(MAX_TITLE_CHARS);
		const bigNote = "Y".repeat(MAX_NOTE_CHARS);
		const seeded: SwarmBoard["cards"] = [];
		// 100 large cards (~90KB) with 5 open and 95 settled.
		for (let i = 1; i <= 100; i++) {
			seeded.push({
				id: `c${i}`,
				title: bigTitle,
				note: bigNote,
				status: i <= 5 ? "doing" : "done",
				createdBy: "coordinator",
				updatedBy: "coordinator",
				createdAt: i,
				updatedAt: i,
			});
		}
		registry().boards.set(h.sessionId, { version: 1, sessionId: h.sessionId, updatedAt: 1000, cards: seeded, nextId: 101 });

		await h.call({ action: "add", title: "Trigger trim" });
		const bytes = Buffer.byteLength(JSON.stringify({ version: 1, sessionId: h.sessionId, updatedAt: h.board!.updatedAt, cards: h.board!.cards }), "utf8");
		expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
		// All 5 original open cards + the new open card remain; oldest settled cards were evicted first.
		for (let i = 1; i <= 5; i++) expect(h.board!.cards.some((c) => c.id === `c${i}`)).toBe(true);
		expect(h.board!.cards.some((c) => c.id === "c6")).toBe(false);
		expect(h.board!.cards.some((c) => c.id === "c100")).toBe(true);

		// When only open cards exist and exceed MAX_BYTES, none are silently deleted.
		const openOnly: SwarmBoard["cards"] = [];
		for (let i = 1; i <= 90; i++) {
			openOnly.push({ id: `c${i}`, title: bigTitle, note: bigNote, status: "todo", createdBy: "coordinator", updatedBy: "coordinator", createdAt: i, updatedAt: i });
		}
		registry().boards.set(h.sessionId, { version: 1, sessionId: h.sessionId, updatedAt: 2000, cards: openOnly, nextId: 91 });
		await h.call({ action: "add", title: "Keep all open" });
		expect(h.board!.cards).toHaveLength(91);
	});
});
