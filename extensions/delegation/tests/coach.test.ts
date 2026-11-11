// The swarm coach in real Pi sessions on the faux provider, asserting on what the provider receives.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { COACH, contextText, registerCoach, stallText } from "../coach.ts";
import { registerSwarm } from "../swarm.ts";

// Load by path, as Pi does.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const CONTEXT_WINDOW = 20_000;

type Message = { role: string; content: unknown };
interface Captured { system: string; conversation: Message[] }
type Step = string | AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return { system: getCurrentSystemPrompt(messages), conversation: copy.filter((message) => message.role !== "system") };
};
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
const isCoach = (text: string) => text.startsWith("Swarm mode: ");
const coachTexts = (request: Captured) => request.conversation.map(textOf).filter(isCoach);
/** What followed the run's starting message in a request. */
const afterPrompt = (request: Captured, prompt: string) => {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
};

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

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-swarm-coach-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	await writeFile(join(cwd(), "notes.txt"), "a note\n");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

/** A UI context with no effects. A plain object: Pi spreads it. */
function quietUi() {
	const noop = () => {};
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
		setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
		addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop, notify: noop, setStatus: noop,
	} as unknown as ExtensionUIContext;
}

const SUBAGENTS_TELEMETRY = "subagents:telemetry";
const STALL_MS = 10 * 60_000;

/**
 * A session with the extension loaded by path, or, with `clock`, with swarm mode and a coach built here on a clock the
 * test moves, checking every few milliseconds. `emit` sends telemetry on the session's event bus as pi-subagents does.
 */
async function start(options: { clock?: { now: number } } = {}) {
	let events: ExtensionAPI["events"] | undefined;
	const { clock } = options;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "swarm-coach-test-api", provider: "swarm-coach-test", models: [{ id: "test", contextWindow: CONTEXT_WINDOW }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const requests: Captured[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: clock ? [] : [extensionPath],
				extensionFactories: [
					(pi) => { pi.registerProvider(faux.provider); events = pi.events; },
					...clock ? [(pi: ExtensionAPI) => { registerCoach(pi, registerSwarm(pi), { stallMs: STALL_MS, checkMs: 5, now: () => clock.now }); }] : [],
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: cwd(), agentDir: agentDir(), sessionManager: SessionManager.create(cwd(), sessionDir()) });
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions({
		mode: "rpc",
		uiContext: quietUi(),
		onError: (error) => { errors.push(error); },
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (newOptions) => runtime.newSession(newOptions),
			fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
			navigateTree: (targetId, treeOptions) => runtime.session.navigateTree(targetId, treeOptions),
			switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
			reload: () => runtime.session.reload(),
		},
	});
	runtime.setRebindSession(bind);
	await bind();
	const harness = {
		runtime, requests, errors,
		get session() { return runtime.session; },
		/** Answer the next requests with `steps`, then with "ok". */
		reply(...steps: Step[]) {
			const all = [...steps, ...Array.from({ length: 10 }, () => "ok")];
			faux.setResponses(all.map((step): FauxResponseFactory => async ({ messages }) => {
				requests.push(capture(messages));
				return typeof step === "string" ? fauxAssistantMessage(step) : typeof step === "function" ? step() : step;
			}));
		},
		/** Run one prompt answered by `steps` and return the requests it made. */
		async run(prompt: string, ...steps: Step[]) {
			harness.reply(...steps);
			const before = requests.length;
			await runtime.session.prompt(prompt);
			return requests.slice(before);
		},
		command: (text: string) => runtime.session.prompt(text),
		/** Telemetry for a top-level agent of this session, running with no active tool unless `fields` says otherwise. */
		emit(agentId: string, fields: Record<string, unknown> = {}) {
			events!.emit(SUBAGENTS_TELEMETRY, {
				phase: "updated", agentId, status: "running", displayName: "Worker", type: "worker", description: `task ${agentId}`,
				turnCount: 1, toolUses: 0, lifetimeTokens: 0, contextPercent: null, compactionCount: 0, activeTools: [], startedAt: 0,
				parentSessionId: runtime.session.sessionManager.getSessionId(), ...fields,
			});
		},
		coachEntries: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "swarm-coach" ? [entry] : []),
		swarmMessages: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "swarm" ? [entry.content] : []),
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}

describe("the context nudge", () => {
	/** A prompt that alone fills `percent` of the context window, at the faux provider's four characters a token. */
	const filler = (percent: number) => "x".repeat(Math.ceil(CONTEXT_WINDOW * 4 * percent / 100));
	/** The coach messages each request of a run carries after its prompt. */
	const nudges = (requests: Captured[], prompt: string) => requests.map((request) => afterPrompt(request, prompt).filter(isCoach));

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
		expect(text).toBe('Swarm mode: a background agent has run no tool and reported nothing for a while: a1 (worker, "task a1", idle 11 min). Check each with get_subagent_result, redirect it with steer_subagent, or stop and relaunch it.');
		expect(h.requests[1]!.conversation.map(textOf).at(-1)).toBe(text);
		expect(h.coachEntries().map(({ display }) => display)).toEqual([false]);

		clock.now += STALL_MS * 3;
		await settle();
		expect(h.requests).toHaveLength(2);
		expect(h.coachEntries()).toHaveLength(1);
		expect(h.errors).toEqual([]);
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
		started.splice(started.indexOf(h), 1);
		clock.now += STALL_MS * 2;
		await settle();
		expect(h.requests).toHaveLength(1);
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
	expect(COACH).toEqual({ contextShare: 50, stallMs: 10 * 60_000, checkMs: 60_000 });
});
