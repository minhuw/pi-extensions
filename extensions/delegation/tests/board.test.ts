// The swarm board in real Pi sessions on the faux provider, with real session files: a coordinator, its subagent children through the child-session hook, and the shared registry.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { registerBoard, type SwarmBoard, type SwarmBoards } from "../board.ts";

const BOARDS = Symbol.for("pi-extensions.swarm-boards");
const HOOKS = Symbol.for("pi-extensions.child-session-hooks");
const SESSION_LINK = "pi-extensions.session-link";
const GUIDANCE = "Read swarm_board before editing files another card may own; post progress with note, set blocked with the reason when you need the coordinator, and add todo cards for follow-up work you find instead of doing it.";

/** The registry as pika reads it, created by whoever reads it first. */
const registry = () => ((globalThis as Record<symbol, unknown>)[BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() }) as SwarmBoards;
const hooks = () => (globalThis as Record<symbol, unknown>)[HOOKS] as Set<{ name: string; extensionFactory: ExtensionFactory }> | undefined;
const boardHook = () => [...hooks() ?? []].find((hook) => hook.name === "swarm-board");

type Message = { role: string; content: unknown };
interface Captured { system: string; conversation: Message[] }

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-board-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
	delete (globalThis as Record<symbol, unknown>)[BOARDS];
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0).reverse()) await harness.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		delete (globalThis as Record<symbol, unknown>)[BOARDS];
		const hook = boardHook();
		if (hook) hooks()!.delete(hook);
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
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
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "board-test-api", provider: "board-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const requests: Captured[] = [];
	const on = options.on ?? { value: true };
	let api: ExtensionAPI | undefined;
	const hook = options.child ? boardHook() : undefined;
	if (options.child) expect(hook).toBeDefined();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [
					(pi) => { pi.registerProvider(faux.provider); api = pi; },
					...(!hook || options.delegation ? [(pi: ExtensionAPI) => registerBoard(pi, () => on.value)] : []),
					...(hook ? [hook.extensionFactory] : []),
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: cwd(), agentDir: agentDir(), sessionManager: options.sessionManager ?? SessionManager.create(cwd(), sessionDir()) });
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions(options.child ? {} : { mode: options.mode ?? "rpc", onError: (error) => { errors.push(error); } });
	runtime.setRebindSession(bind);
	await bind();
	const harness = {
		runtime, faux, requests, errors, on,
		get session() { return runtime.session; },
		get sessionId() { return runtime.session.sessionManager.getSessionId(); },
		get board() { return registry().boards.get(runtime.session.sessionManager.getSessionId()); },
		/** Emit Subagents telemetry on this session's event bus, as its Subagents extension does. */
		telemetry: (data: Record<string, unknown>) => api!.events.emit("subagents:telemetry", { status: "running", type: "worker", description: "", parentSessionId: runtime.session.sessionManager.getSessionId(), ...data }),
		tools: () => runtime.session.getAllTools().map((tool) => tool.name),
		/** Run one prompt answered with plain text. */
		async run(prompt = "go") {
			harness.faux.setResponses([respond(harness, () => fauxAssistantMessage("ok"))]);
			await runtime.session.prompt(prompt);
			return requests.at(-1)!;
		},
		/** Have the model call swarm_board once and return the tool's result. */
		async call(args: Record<string, string>) {
			harness.faux.setResponses([
				respond(harness, () => fauxAssistantMessage(fauxToolCall("swarm_board", args))),
				respond(harness, () => fauxAssistantMessage("ok")),
			]);
			await runtime.session.prompt(`call ${JSON.stringify(args)}`);
			const resultEntry = runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []).at(-1)!;
			const text = (resultEntry.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");
			return { text, isError: resultEntry.isError };
		},
		/** The board snapshots on the current branch. */
		snapshots: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "swarm-board" ? [entry.data as SwarmBoard] : []),
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}
type Harness = Awaited<ReturnType<typeof start>>;

const respond = (h: { requests: Captured[] }, reply: () => ReturnType<FauxResponseFactory>): FauxResponseFactory => ({ messages }) => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	h.requests.push({ system: getCurrentSystemPrompt(messages), conversation: copy.filter((message) => message.role !== "system") });
	return reply();
};

/** A subagent child of `parent`, linked as Subagents links one before binding the child's extensions. */
async function startChild(parent: Harness | string, link: Record<string, unknown> = {}, options: Pick<StartOptions, "delegation"> = {}) {
	const manager = SessionManager.create(cwd(), sessionDir());
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
		expect((await h.call({ action: "list" })).text).toBe("doing:\n- c2 Docs — draft\nblocked:\n- c1 [a1] Parser — needs API\ndropped:\n- c3 Old");
		const missing = await h.call({ action: "update", id: "c9", status: "done" });
		expect(missing).toEqual({ text: "No card c9 on the swarm board.", isError: true });
		const taken = await h.call({ action: "update", id: "c2", agentId: "a1" });
		expect(taken).toEqual({ text: "Agent a1 is already on card c1.", isError: true });
		expect(await h.call({ action: "note", note: "mine" })).toEqual({ text: "Unknown action note: use list, add, update, or drop.", isError: true });
		expect(h.snapshots().at(-1)!.cards).toEqual(h.board!.cards);
	});

	it("persists each change as a snapshot and restores the latest when the session is reopened", async () => {
		const h = await start();
		await h.call({ action: "add", title: "One" });
		await h.call({ action: "add", title: "Two" });
		expect(h.snapshots().map((board) => board.cards.length)).toEqual([1, 2]);
		const file = h.session.sessionFile!;
		const id = h.sessionId;
		await h.dispose();
		started.splice(started.indexOf(h), 1);
		expect(registry().boards.has(id)).toBe(false);
		const reopened = await start({ sessionManager: SessionManager.open(file, sessionDir()) });
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
	it("registers the child-session hook at load", async () => {
		await start();
		expect(boardHook()).toBeDefined();
	});

	it("gives a subagent child a board limited to its own card and todo cards, with a section at its first run", async () => {
		const coordinator = await start();
		coordinator.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		await coordinator.call({ action: "add", title: "Docs", status: "doing" });
		const child = await startChild(coordinator, { agentId: "a1", description: "Fix parser" });
		expect(child.tools()).toContain("swarm_board");

		const listed = await child.call({ action: "list" });
		expect(listed.text).toBe("Your card: c1.\ndoing:\n- c1 [worker a1] Fix parser\n- c2 Docs");
		const first = child.requests[0]!;
		expect(first.system).toContain(`<swarm-board>\nYou are one of several agents sharing a swarm board with your coordinator. Your card: c1.\nOpen cards:\ndoing:\n- c1 [worker a1] Fix parser\n- c2 Docs\n${GUIDANCE}\n</swarm-board>`);

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

	it("enforces the child's limits in code when Delegation's own wider tool serves the child", async () => {
		const coordinator = await start();
		coordinator.telemetry({ phase: "started", agentId: "a1", description: "Fix parser" });
		await coordinator.call({ action: "add", title: "Docs" });
		const child = await startChild(coordinator, { agentId: "a1" }, { delegation: true });
		expect(child.tools().filter((name) => name === "swarm_board")).toHaveLength(1);
		expect(await child.call({ action: "note", status: "done", note: "finished" })).toEqual({ text: "A subagent can set its own card only to doing or blocked; the coordinator settles cards.", isError: true });
		expect(await child.call({ action: "add", title: "Sneaky", status: "doing" })).toEqual({ text: "A subagent can add only todo cards.", isError: true });
		for (const action of ["drop", "update"]) {
			const refused = await child.call({ action, id: "c2", title: "Renamed" });
			expect(refused).toEqual({ text: `A subagent can only list, note on its own card, and add todo cards; ${action} is for the coordinator.`, isError: true });
		}
		expect((await child.call({ action: "note", note: "progress" })).isError).toBe(false);
		expect(cards(coordinator)!.map((card) => [card.title, card.status, card.updatedBy])).toEqual([["Fix parser", "doing", "a1"], ["Docs", "todo", "coordinator"]]);
		expect(child.requests[0]!.system).toContain("Your card: c1.");
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
		expect(child.requests[0]!.system).toContain("Your card: none yet (note creates it).");
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
		const herderManager = SessionManager.create(cwd(), sessionDir());
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
		expect(Object.keys(h.board!).sort()).toEqual(["cards", "sessionId", "updatedAt", "version"]);
		expect(h.board).toMatchObject({ version: 1, sessionId: h.sessionId });
		expect(card).toEqual({ id: "c1", title: "One", status: "doing", createdBy: "coordinator", updatedBy: "coordinator", createdAt: expect.any(Number), updatedAt: expect.any(Number) });
		expect(failure).toHaveBeenCalledWith("swarm board listener failed:", expect.any(Error));
	});
});
