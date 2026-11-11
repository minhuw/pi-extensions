// Always-on mode in real Pi sessions on the faux provider, with real session files, asserting on what the provider receives.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

// Load by path, as Pi does.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const SESSION_LINK = "pi-extensions.session-link";
const STATUS = "📡 alwayson";
const ON_MESSAGE = "Always-on mode 📡 is on: the user wants this session to stay responsive to them and to other pi sessions that message it through pika relay, which reach it only between turns, and explicitly opts in to background agents. "
	+ "Run every development task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in a background agent: Agent with run_in_background: true, worker for changes and verification, recon for research, "
	+ "with a self-contained prompt or inherit_context: true. Then end your turn at once, telling the user what is running; do not wait, sleep, or poll. An agent's completion notification starts a new turn. "
	+ "Between them, answer the user and relay messages yourself, and use steer_subagent to redirect a running agent and get_subagent_result for its details. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Keep direct tools for answers, short lookups, and small edits. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_MESSAGE = "Always-on mode is off. Ignore earlier always-on mode instructions: long tasks no longer have to run in background agents, and the standard subagent guidance applies unless another mode says otherwise.";
const SECTION = `<alwayson>\n${ON_MESSAGE} A later always-on mode message overrides this.\n</alwayson>`;
const ON_NOTE = "Always-on mode 📡 on: the model runs long tasks in background agents and ends its turns, so it answers you and relay messages meanwhile. Takes effect with the next prompt; usage may increase.";
const OFF_NOTE = "Always-on mode off. Takes effect with the next prompt.";
const USAGE = "Usage: /alwayson [on | off | status]";
const INELIGIBLE = "/alwayson works only in top-level TUI and RPC sessions.";
const SESSION_MODES = Symbol.for("pi-extensions.session-modes");

interface SessionModesRegistry { modes: Map<string, Set<string>>; listeners: Set<(sessionId: string) => void> }
/** The session modes registry as Relay reads it, created by whoever reads it first. */
const sessionModes = () => {
	const shared = globalThis as Record<symbol, unknown>;
	return (shared[SESSION_MODES] ??= { modes: new Map(), listeners: new Set() }) as SessionModesRegistry;
};
/** Record the session ids the registry's listeners are called with. */
const listen = () => {
	const calls: string[] = [];
	sessionModes().listeners.add((sessionId) => { calls.push(sessionId); });
	return calls;
};

type Message = { role: string; content: unknown };
interface Captured { system: string; systems: number; conversation: Message[] }

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return { system: getCurrentSystemPrompt(messages), systems: copy.filter((message) => message.role === "system").length, conversation: copy.filter((message) => message.role !== "system") };
};
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
/** What followed the run's starting message in a request: the always-on message of that run, if any. */
const afterPrompt = (request: Captured, prompt: string) => {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
};
const alwaysOnMessages = (request: Captured) => request.conversation.map(textOf).filter((text) => text.startsWith("Always-on mode"));
const expectUntouched = (request: Captured) => {
	expect(request.system).not.toContain("<alwayson>");
	expect(alwaysOnMessages(request)).toEqual([]);
};
/** The system prompt is unchanged, and `later` starts with every conversation message of `earlier`, byte for byte. */
const expectSamePrefix = (later: Captured, earlier: Captured) => {
	expect(later.system).toBe(earlier.system);
	expect(later.systems).toBeLessThanOrEqual(earlier.systems);
	expect(JSON.stringify(later.conversation.slice(0, earlier.conversation.length))).toBe(JSON.stringify(earlier.conversation));
};

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");
const newManager = (options?: { parentSession?: string }) => SessionManager.create(cwd(), sessionDir(), options);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-alwayson-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
	delete (globalThis as Record<symbol, unknown>)[SESSION_MODES];
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		delete (globalThis as Record<symbol, unknown>)[SESSION_MODES];
		await rm(root, { recursive: true, force: true });
	}
});

/** A UI context that records notifications and footer statuses. A plain object: Pi spreads it. */
function recordingUi() {
	const notes: { message: string; type?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const control = { failStatus: false };
	const noop = () => {};
	const context = {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
		setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
		addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop,
		notify: (message: string, type?: string) => { notes.push({ message, type }); },
		setStatus: (key: string, text: string | undefined) => {
			if (control.failStatus) throw new Error("stale context");
			statuses.set(key, text);
		},
	} as unknown as ExtensionUIContext;
	return { notes, statuses, control, context };
}

async function start(options: { sessionManager?: SessionManager; mode?: ExtensionContext["mode"]; extension?: boolean; register?: (pi: ExtensionAPI) => void; bindAsChild?: boolean } = {}) {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "alwayson-test-api", provider: "alwayson-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const ui = recordingUi();
	const requests: Captured[] = [];
	const respond: FauxResponseFactory = ({ messages }) => {
		requests.push(capture(messages));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => respond));
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: options.extension === false ? [] : [extensionPath],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); options.register?.(pi); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: cwd(), agentDir: agentDir(), sessionManager: options.sessionManager ?? newManager() });
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : {
		mode: options.mode ?? "rpc",
		uiContext: ui.context,
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
		runtime, faux, requests, errors, ...ui,
		get session() { return runtime.session; },
		get status() { return ui.statuses.get("alwayson"); },
		get sessionId() { return runtime.session.sessionManager.getSessionId(); },
		/** The modes the registry holds for the session. */
		get modes() { return [...sessionModes().modes.get(runtime.session.sessionManager.getSessionId()) ?? []]; },
		get lastNote() { return ui.notes.at(-1); },
		/** Run one prompt and return the request it made. */
		async run(prompt: string) {
			const before = requests.length;
			await runtime.session.prompt(prompt);
			expect(requests.length).toBe(before + 1);
			return requests.at(-1)!;
		},
		command: (text: string) => runtime.session.prompt(text),
		/** The session's `alwayson` entries on the current branch. */
		entries: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "alwayson" ? [entry.data] : []),
		hiddenMessages: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "alwayson" ? [entry] : []),
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}
type Harness = Awaited<ReturnType<typeof start>>;

/** Close the session, as quitting Pi does. */
async function close(h: Harness) {
	await h.dispose();
	started.splice(started.indexOf(h), 1);
}

/** Close the session and open its file again, as a new Pi process would. */
async function reopen(h: Harness, mode?: ExtensionContext["mode"]) {
	const file = h.session.sessionFile!;
	await close(h);
	return start({ sessionManager: SessionManager.open(file, sessionDir()), mode });
}

/** The latest user message on the branch. */
const lastPrompt = (h: Harness) => h.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1)!;

/** Take `buildSessionProjection` away from the extensions' `ctx.sessionManager`, as in Pi 1.3 and 1.4. Pi keeps its own reference. */
function withoutProjection(h: Harness) {
	const runner = h.session.extensionRunner as unknown as { sessionManager: SessionManager };
	runner.sessionManager = new Proxy(runner.sessionManager, {
		get: (target, property) => {
			if (property === "buildSessionProjection") return undefined;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		has: (target, property) => property !== "buildSessionProjection" && Reflect.has(target, property),
	});
}

/** Answer the next requests with `reply`, called while the request is in flight. */
const script = (h: Harness, reply: (call: number) => ReturnType<FauxResponseFactory>) => {
	let call = 0;
	const step: FauxResponseFactory = ({ messages }) => {
		h.requests.push(capture(messages));
		return reply(++call);
	};
	h.faux.setResponses(Array.from({ length: 10 }, () => step));
};
const duringNextRequest = (h: Harness, command: string) => script(h, async (call) => {
	if (call === 1) await h.command(command);
	return fauxAssistantMessage("ok");
});

describe("without /alwayson", () => {
	it("sends no section and no message, and shows no status", async () => {
		const h = await start();
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("one"));
		expectUntouched(await h.run("two"));
		expect(h.entries()).toEqual([{ base: false }]);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.status).toBeUndefined();
		expect(h.errors).toEqual([]);
	});
});

describe("from the session's start", () => {
	it.each(["tui", "rpc"] as const)("puts always-on mode in a section when /alwayson on comes before the first run in %s mode", async (mode) => {
		const h = await start({ mode });
		await h.command("/alwayson on");
		expect(h.lastNote).toEqual({ message: ON_NOTE, type: "info" });
		expect(h.status).toBe(STATUS);
		const first = await h.run("one");
		expect(first.system).toContain(SECTION);
		expect(alwaysOnMessages(first)).toEqual([]);
		expect(h.entries()).toEqual([{ active: true }, { base: true }]);
		const second = await h.run("two");
		expectSamePrefix(second, first);
		expect(alwaysOnMessages(second)).toEqual([]);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.status).toBe(STATUS);
		expect(h.errors).toEqual([]);
	});

	it("keeps the section when switched off, sends the off message once, and the on message once on return", async () => {
		const h = await start();
		await h.command("/alwayson on");
		const first = await h.run("one");
		await h.command("/alwayson off");
		expect(h.lastNote).toEqual({ message: OFF_NOTE, type: "info" });
		expect(h.status).toBeUndefined();
		const off = await h.run("two");
		expectSamePrefix(off, first);
		expect(afterPrompt(off, "two")).toEqual([OFF_MESSAGE]);
		const stillOff = await h.run("three");
		expectSamePrefix(stillOff, off);
		expect(afterPrompt(stillOff, "three")).toEqual([]);
		expect(alwaysOnMessages(stillOff)).toEqual([OFF_MESSAGE]);
		expect(stillOff.system).toContain(SECTION);

		await h.command("/alwayson on");
		expect(h.status).toBe(STATUS);
		const on = await h.run("four");
		expectSamePrefix(on, stillOff);
		expect(afterPrompt(on, "four")).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("five"), "five")).toEqual([]);
		expect(h.entries()).toEqual([{ active: true }, { base: true }, { active: false }, { active: true }]);
		expect(h.hiddenMessages().map((entry) => entry.content)).toEqual([OFF_MESSAGE, ON_MESSAGE]);
	});

	it("sends the off message again once after a real compaction drops it, and nothing for a return the section states", async () => {
		const h = await start();
		await h.command("/alwayson on");
		await h.run("one");
		await h.command("/alwayson off");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([OFF_MESSAGE]);
		await h.session.compact();
		const after = await h.run("three");
		expect(after.system).toContain(SECTION);
		expect(afterPrompt(after, "three")).toEqual([OFF_MESSAGE]);
		expect(alwaysOnMessages(after)).toEqual([OFF_MESSAGE]);
		const next = await h.run("four");
		expectSamePrefix(next, after);
		expect(afterPrompt(next, "four")).toEqual([]);

		// The compaction drops the off message, so the model sees only the section, which says always-on mode is on.
		await h.session.compact();
		await h.command("/alwayson on");
		const on = await h.run("five");
		expect(on.system).toContain(SECTION);
		expect(alwaysOnMessages(on)).toEqual([]);
		expect(alwaysOnMessages(await h.run("six"))).toEqual([]);
		expect(h.hiddenMessages().map((entry) => entry.content)).toEqual([OFF_MESSAGE, OFF_MESSAGE]);
		expect(h.errors).toEqual([]);
	});
});

describe("mid-session", () => {
	it("keeps the system prompt and sends a hidden on message once, after the prompt of the next run", async () => {
		const h = await start();
		const before = await h.run("one");
		await h.command("/alwayson on");
		expect(h.status).toBe(STATUS);
		const on = await h.run("two");
		expectSamePrefix(on, before);
		expect(on.system).not.toContain("<alwayson>");
		expect(afterPrompt(on, "two")).toEqual([ON_MESSAGE]);
		const again = await h.run("three");
		expectSamePrefix(again, on);
		expect(afterPrompt(again, "three")).toEqual([]);
		expect(alwaysOnMessages(again)).toEqual([ON_MESSAGE]);
		const later = await h.run("four");
		expectSamePrefix(later, again);
		expect(alwaysOnMessages(later)).toEqual([ON_MESSAGE]);
		expect(h.hiddenMessages().map((entry) => entry.display)).toEqual([false]);
		expect(h.entries()).toEqual([{ base: false }, { active: true }]);
	});

	it("sends one off message after a mid-session on, and none later", async () => {
		const h = await start();
		await h.run("one");
		await h.command("/alwayson on");
		const on = await h.run("two");
		await h.command("/alwayson off");
		expect(h.status).toBeUndefined();
		const off = await h.run("three");
		expectSamePrefix(off, on);
		expect(afterPrompt(off, "three")).toEqual([OFF_MESSAGE]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
		expect(afterPrompt(await h.run("five"), "five")).toEqual([]);
		expect(h.hiddenMessages().map((entry) => entry.display)).toEqual([false, false]);
	});

	it("adds the message to runs started by a custom message", async () => {
		const h = await start();
		await h.run("one");
		await h.command("/alwayson on");
		await h.session.sendCustomMessage({ customType: "other", content: "nudge", display: true }, { triggerTurn: true });
		await h.session.waitForIdle();
		expect(afterPrompt(h.requests.at(-1)!, "nudge")).toEqual([ON_MESSAGE]);
	});

	it("sends the message again once after a real compaction drops it", async () => {
		const h = await start();
		const before = await h.run("one");
		await h.command("/alwayson on");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
		await h.session.compact();
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		const after = await h.run("four");
		expect(after.system).toBe(before.system);
		expect(afterPrompt(after, "four")).toEqual([ON_MESSAGE]);
		expect(alwaysOnMessages(after)).toEqual([ON_MESSAGE]);
		const next = await h.run("five");
		expectSamePrefix(next, after);
		expect(afterPrompt(next, "five")).toEqual([]);
		expect(alwaysOnMessages(next)).toEqual([ON_MESSAGE]);
		expect(h.hiddenMessages()).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	// A compaction keeps the entries from its `firstKeptEntryId` on, so the message is gone only when they start after it.
	it.each([
		["sends nothing after a real compaction that keeps the message", 0, []],
		["sends the message again after a real compaction that keeps only the entries after it", 1, [ON_MESSAGE]],
	] as const)("%s", async (_name, offset, expected) => {
		const h = await start({
			register: (pi) => {
				pi.on("session_before_compact", (event) => {
					const message = event.branchEntries.findIndex((entry) => entry.type === "custom_message" && entry.customType === "alwayson");
					expect(message).toBeGreaterThanOrEqual(0);
					const firstKeptEntryId = event.branchEntries[message + offset]!.id;
					return { compaction: { summary: "summary", firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
				});
			},
		});
		await h.run("one");
		await h.command("/alwayson on");
		await h.run("two");
		await h.session.compact();
		const after = await h.run("three");
		expect(afterPrompt(after, "three")).toEqual(expected);
		expect(alwaysOnMessages(after)).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
		expect(h.errors).toEqual([]);
	});
});

describe("the command", () => {
	it("toggles with no argument", async () => {
		const h = await start();
		await h.command("/alwayson");
		expect(h.lastNote).toEqual({ message: ON_NOTE, type: "info" });
		expect(h.status).toBe(STATUS);
		await h.command("/alwayson");
		expect(h.lastNote).toEqual({ message: OFF_NOTE, type: "info" });
		expect(h.status).toBeUndefined();
		expect(h.entries()).toEqual([{ active: true }, { active: false }]);
	});

	it("writes nothing when the mode is already as asked", async () => {
		const h = await start();
		await h.command("/alwayson off");
		expect(h.lastNote).toEqual({ message: "Always-on mode is already off.", type: "info" });
		expect(h.entries()).toEqual([]);
		await h.command("/alwayson on");
		await h.command("/alwayson on");
		expect(h.lastNote).toEqual({ message: "Always-on mode 📡 is already on.", type: "info" });
		expect(h.status).toBe(STATUS);
		expect(h.entries()).toEqual([{ active: true }]);
	});

	it("reports the mode with status and writes nothing", async () => {
		const h = await start();
		await h.command("/alwayson status");
		expect(h.lastNote).toEqual({ message: "Always-on mode is off.", type: "info" });
		await h.command("/alwayson on");
		await h.command("/alwayson status");
		expect(h.lastNote).toEqual({ message: "Always-on mode 📡 is on.", type: "info" });
		expect(h.entries()).toEqual([{ active: true }]);
		expect(h.status).toBe(STATUS);
	});

	it("warns with the usage about an unknown argument and writes nothing", async () => {
		const h = await start();
		await h.command("/alwayson maybe");
		expect(h.lastNote).toEqual({ message: USAGE, type: "warning" });
		expect(h.entries()).toEqual([]);
		expect(h.status).toBeUndefined();
		await h.command("/alwayson   ON  ");
		expect(h.lastNote).toEqual({ message: ON_NOTE, type: "info" });
		await h.command("/alwayson on please");
		expect(h.lastNote).toEqual({ message: USAGE, type: "warning" });
		expect(h.entries()).toEqual([{ active: true }]);
		expect(h.status).toBe(STATUS);
	});
});

describe("switches during a run", () => {
	it("applies a switch made during a run to the next run", async () => {
		const h = await start();
		await h.run("one");
		duringNextRequest(h, "/alwayson on");
		const during = await h.run("two");
		expect(afterPrompt(during, "two")).toEqual([]);
		expect(h.status).toBe(STATUS);
		const next = await h.run("three");
		expectSamePrefix(next, during);
		expect(afterPrompt(next, "three")).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
	});

	it("sends the off message once when it is used during a run that carries the on message", async () => {
		const h = await start();
		await h.run("one");
		await h.command("/alwayson on");
		duringNextRequest(h, "/alwayson off");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([ON_MESSAGE]);
		expect(h.status).toBeUndefined();
		expect(afterPrompt(await h.run("three"), "three")).toEqual([OFF_MESSAGE]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
	});

	// The extension registered after Always-on runs its handler between Always-on's return and the hidden message reaching the branch.
	it("sends the off message when it is used while a run carrying the on message is starting", async () => {
		let whileStarting: (() => Promise<void>) | undefined;
		const h = await start({ register: (pi) => { pi.on("before_agent_start", async () => { await whileStarting?.(); }); } });
		await h.run("one");
		await h.command("/alwayson on");
		whileStarting = async () => {
			whileStarting = undefined;
			await h.command("/alwayson off");
		};
		expect(afterPrompt(await h.run("two"), "two")).toEqual([ON_MESSAGE]);
		expect(h.status).toBeUndefined();
		expect(afterPrompt(await h.run("three"), "three")).toEqual([OFF_MESSAGE]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
	});
});

describe("sessions that predate the extension", () => {
	it("sends the on message once and adds no section when /alwayson on comes before the first run with the extension", async () => {
		const old = await start({ extension: false });
		const before = await old.run("old");
		const h = await reopen(old);
		expect(h.status).toBeUndefined();
		await h.command("/alwayson on");
		expect(h.status).toBe(STATUS);
		const first = await h.run("one");
		expectSamePrefix(first, before);
		expect(first.system).not.toContain("<alwayson>");
		expect(afterPrompt(first, "one")).toEqual([ON_MESSAGE]);
		expect(h.entries()).toEqual([{ active: true }, { base: false }]);
		const second = await h.run("two");
		expectSamePrefix(second, first);
		expect(afterPrompt(second, "two")).toEqual([]);
		expect(alwaysOnMessages(second)).toEqual([ON_MESSAGE]);
	});
});

describe("in Pi 1.3 and 1.4, without a session projection", () => {
	it("repeats the on message with every run while the switch differs from the section, and sends one off message on return", async () => {
		const projections: string[] = [];
		const h = await start({ register: (pi) => { pi.on("before_agent_start", (_event, ctx) => { projections.push(typeof ctx.sessionManager.buildSessionProjection); }); } });
		withoutProjection(h);
		await h.run("one");
		await h.command("/alwayson on");
		const on = await h.run("two");
		expect(afterPrompt(on, "two")).toEqual([ON_MESSAGE]);
		const again = await h.run("three");
		expectSamePrefix(again, on);
		expect(afterPrompt(again, "three")).toEqual([ON_MESSAGE]);
		await h.session.compact();
		expect(afterPrompt(await h.run("four"), "four")).toEqual([ON_MESSAGE]);
		await h.command("/alwayson off");
		expect(afterPrompt(await h.run("five"), "five")).toEqual([OFF_MESSAGE]);
		expect(afterPrompt(await h.run("six"), "six")).toEqual([]);
		expect(projections).toEqual(Array(6).fill("undefined"));
		expect(h.errors).toEqual([]);
	});

	it("repeats the off message with every run in a session whose section carries always-on mode", async () => {
		const h = await start();
		withoutProjection(h);
		await h.command("/alwayson on");
		expect((await h.run("one")).system).toContain(SECTION);
		await h.command("/alwayson off");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([OFF_MESSAGE]);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([OFF_MESSAGE]);
		await h.command("/alwayson on");
		expect(afterPrompt(await h.run("four"), "four")).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("five"), "five")).toEqual([]);
		expect(h.errors).toEqual([]);
	});
});

describe("restoring a session", () => {
	it("restores the section and a mid-session switch after a resume in a new process", async () => {
		const pinned = await start();
		await pinned.command("/alwayson on");
		const pinnedFirst = await pinned.run("one");
		const pinnedAgain = await reopen(pinned);
		expect(pinnedAgain.status).toBe(STATUS);
		const pinnedNext = await pinnedAgain.run("two");
		expectSamePrefix(pinnedNext, pinnedFirst);
		expect(alwaysOnMessages(pinnedNext)).toEqual([]);

		const switched = await start();
		const switchedFirst = await switched.run("one");
		await switched.command("/alwayson on");
		await switched.run("two");
		const switchedAgain = await reopen(switched);
		expect(switchedAgain.status).toBe(STATUS);
		const switchedNext = await switchedAgain.run("three");
		expect(switchedNext.system).toBe(switchedFirst.system);
		expect(afterPrompt(switchedNext, "three")).toEqual([]);
		expect(alwaysOnMessages(switchedNext)).toEqual([ON_MESSAGE]);
	});

	it("follows the branch through /tree", async () => {
		const h = await start();
		const first = await h.run("one");
		const beforeSwitch = h.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		await h.command("/alwayson on");
		await h.run("two");
		const switchedLeaf = h.session.sessionManager.getLeafId()!;

		await h.session.navigateTree(beforeSwitch.id);
		expect(h.status).toBeUndefined();
		const other = await h.run("other branch");
		expect(other.system).toBe(first.system);
		expect(afterPrompt(other, "other branch")).toEqual([]);

		await h.session.navigateTree(switchedLeaf);
		expect(h.status).toBe(STATUS);
		const back = await h.run("three");
		expect(back.system).toBe(first.system);
		expect(afterPrompt(back, "three")).toEqual([]);
		expect(alwaysOnMessages(back)).toEqual([ON_MESSAGE]);
		expect(h.errors).toEqual([]);
	});

	// Editing prompt two from /tree continues from its parent, the switch, without the message that followed the prompt.
	it.each([false, true])("sends the message again after /tree to a branch that holds the switch but not the message (summarize: %s)", async (summarize) => {
		const h = await start();
		const first = await h.run("one");
		await h.command("/alwayson on");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([ON_MESSAGE]);
		await h.session.navigateTree(lastPrompt(h).id, { summarize });
		expect(h.status).toBe(STATUS);
		expect(h.entries()).toEqual([{ base: false }, { active: true }]);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "branch_summary")).toBe(summarize);
		const edited = await h.run("two, edited");
		expect(edited.system).toBe(first.system);
		expect(afterPrompt(edited, "two, edited")).toEqual([ON_MESSAGE]);
		expect(alwaysOnMessages(edited)).toEqual([ON_MESSAGE]);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("keeps the message the fork copies and sends no other", async () => {
		const h = await start();
		await h.run("one");
		await h.command("/alwayson on");
		await h.run("two");
		const result = await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		expect(result.cancelled).toBe(false);
		expect(h.status).toBe(STATUS);
		const forked = await h.run("three");
		expect(afterPrompt(forked, "three")).toEqual([]);
		expect(alwaysOnMessages(forked)).toEqual([ON_MESSAGE]);
		expect(h.errors).toEqual([]);
	});
});

describe("sessions that are left alone", () => {
	it.each<[string, () => Promise<Harness>]>([
		["a child with a session-link entry", () => {
			const manager = newManager();
			manager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
			return start({ sessionManager: manager });
		}],
		["print mode", () => start({ mode: "print" })],
		["json mode", () => start({ mode: "json" })],
	])("adds nothing to %s and warns about /alwayson", async (_name, open) => {
		const h = await open();
		const entries = h.entries();
		expectUntouched(await h.run("one"));
		await h.command("/alwayson on");
		expect(h.lastNote).toEqual({ message: INELIGIBLE, type: "warning" });
		expectUntouched(await h.run("two"));
		expect(h.entries()).toEqual(entries);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.statuses.has("alwayson")).toBe(false);
		expect(sessionModes().modes.has(h.sessionId)).toBe(false);
	});

	it("adds nothing to a child bound as Subagents and Herder bind it", async () => {
		const modes: string[] = [];
		const h = await start({ bindAsChild: true, register: (pi) => { pi.on("session_start", (_event, ctx) => { modes.push(ctx.mode); }); } });
		expect(modes).toEqual(["print"]);
		expectUntouched(await h.run("one"));
		await h.command("/alwayson on");
		expectUntouched(await h.run("two"));
		expect(h.entries()).toEqual([]);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.statuses.has("alwayson")).toBe(false);
		expect(sessionModes().modes.has(h.sessionId)).toBe(false);
	});
});

describe("the session modes registry", () => {
	it("holds alwayson for the session exactly while the mode is on, in the registry Relay created first", async () => {
		const registry = sessionModes();
		const calls = listen();
		const h = await start();
		expect(sessionModes()).toBe(registry);
		expect(registry.modes.has(h.sessionId)).toBe(false);
		await h.command("/alwayson on");
		expect(h.modes).toEqual(["alwayson"]);
		expect(calls).toEqual([h.sessionId]);
		await h.command("/alwayson on");
		await h.command("/alwayson status");
		await h.command("/alwayson maybe");
		await h.run("one");
		expect(calls).toEqual([h.sessionId]);
		await h.command("/alwayson off");
		expect(registry.modes.has(h.sessionId)).toBe(false);
		expect(calls).toEqual([h.sessionId, h.sessionId]);
		await h.command("/alwayson");
		expect(h.modes).toEqual(["alwayson"]);
		expect(calls).toHaveLength(3);
		expect(h.errors).toEqual([]);
	});

	it("creates the registry when it reads it first, and leaves another mode of the session alone", async () => {
		const h = await start();
		const registry = (globalThis as Record<symbol, unknown>)[SESSION_MODES] as SessionModesRegistry;
		expect(registry.modes).toBeInstanceOf(Map);
		expect(registry.listeners).toBeInstanceOf(Set);
		registry.modes.set(h.sessionId, new Set(["other"]));
		await h.command("/alwayson on");
		expect(h.modes).toEqual(["other", "alwayson"]);
		await h.command("/alwayson off");
		expect(h.modes).toEqual(["other"]);
	});

	it("follows the branch through /tree and the session through shutdown and a resume", async () => {
		const h = await start();
		await h.run("one");
		const beforeSwitch = h.session.sessionManager.getLeafId()!;
		await h.command("/alwayson on");
		await h.run("two");
		const switchedLeaf = h.session.sessionManager.getLeafId()!;
		const id = h.sessionId;
		const calls = listen();
		await h.session.navigateTree(beforeSwitch);
		expect(sessionModes().modes.has(id)).toBe(false);
		await h.session.navigateTree(switchedLeaf);
		expect(h.modes).toEqual(["alwayson"]);
		expect(calls).toEqual([id, id]);

		const again = await reopen(h);
		expect(again.sessionId).toBe(id);
		expect(again.modes).toEqual(["alwayson"]);
		expect(calls).toEqual([id, id, id, id]);
		await close(again);
		expect(sessionModes().modes.has(id)).toBe(false);
		expect(calls).toHaveLength(5);
	});

	it("moves to the new session of a fork and leaves a new session out", async () => {
		const h = await start();
		await h.run("one");
		await h.command("/alwayson on");
		await h.run("two");
		const original = h.sessionId;
		const calls = listen();
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		const forked = h.sessionId;
		expect(forked).not.toBe(original);
		expect(sessionModes().modes.has(original)).toBe(false);
		expect(h.modes).toEqual(["alwayson"]);
		expect(calls).toEqual([original, forked]);

		await h.runtime.newSession();
		expect(sessionModes().modes.has(forked)).toBe(false);
		expect(sessionModes().modes.has(h.sessionId)).toBe(false);
		expect(h.status).toBeUndefined();
		expect(calls).toEqual([original, forked, forked]);
	});

	it("catches the errors of its listeners and still calls the others", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", onUnhandled);
		try {
			sessionModes().listeners.add(() => { throw new Error("listener failed"); });
			sessionModes().listeners.add(async () => { throw new Error("async listener failed"); });
			const calls = listen();
			const h = await start();
			await h.command("/alwayson on");
			expect(h.lastNote).toEqual({ message: ON_NOTE, type: "info" });
			expect(h.modes).toEqual(["alwayson"]);
			await h.command("/alwayson off");
			expect(h.lastNote).toEqual({ message: OFF_NOTE, type: "info" });
			expect(calls).toEqual([h.sessionId, h.sessionId]);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("with boom mode", () => {
	it("switches independently of boom mode, each with its own section, status, and messages", async () => {
		const h = await start();
		await h.command("/boom on");
		await h.command("/alwayson on");
		const first = await h.run("one");
		expect(first.system).toContain(SECTION);
		expect(first.system).toContain("<boom>");
		expect(h.statuses.get("boom")).toBe("💥 boom");
		expect(h.status).toBe(STATUS);
		await h.command("/boom off");
		const off = await h.run("two");
		expect(afterPrompt(off, "two").map((text) => text.split(".")[0])).toEqual(["Boom mode is off"]);
		expect(h.status).toBe(STATUS);
		await h.command("/alwayson off");
		expect(afterPrompt(await h.run("three"), "three")).toEqual([OFF_MESSAGE]);
		expect(h.statuses.get("boom")).toBeUndefined();
		expect(h.status).toBeUndefined();
		expect(h.errors).toEqual([]);
	});
});

describe("the footer status", () => {
	it("survives a stale context", async () => {
		const h = await start();
		h.control.failStatus = true;
		await h.command("/alwayson on");
		expect(h.entries()).toEqual([{ active: true }]);
		expect((await h.run("one")).system).toContain(SECTION);
		await h.command("/alwayson off");
		expect(h.entries()).toEqual([{ active: true }, { base: true }, { active: false }]);
		expect(afterPrompt(await h.run("two"), "two")).toEqual([OFF_MESSAGE]);
		expect(h.errors).toEqual([]);
	});
});
