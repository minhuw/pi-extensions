// The Soul extension in real Pi sessions and child sessions on the faux provider, asserting on what the provider receives.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_SESSION_HOOKS,
	OFF_TEXT,
	ON_TEXT,
	SECTION_TEXT,
	SESSION_LINK_TYPE,
	SOUL_SHARED_KEY,
	type ChildSessionHook,
} from "../index.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const SECTION = `<soul>\n${SECTION_TEXT}\n</soul>`;

type Message = { role: string; content: unknown; customType?: string };
interface Captured {
	system: string;
	systems: number;
	conversation: Message[];
}

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return {
		system: getCurrentSystemPrompt(messages),
		systems: copy.filter((message) => message.role === "system").length,
		conversation: copy.filter((message) => message.role !== "system"),
	};
};

const textOf = ({ content }: Message) =>
	typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");

const soulMessages = (request: Captured) =>
	request.conversation.map(textOf).filter((text) => text === ON_TEXT || text === OFF_TEXT);

const expectUntouched = (request: Captured) => {
	expect(request.system).not.toContain("<soul>");
	expect(soulMessages(request)).toEqual([]);
};

/** The system prompt is unchanged, and `later` starts with every conversation message of `earlier`, byte for byte. */
const expectSamePrefix = (later: Captured, earlier: Captured) => {
	expect(later.system).toBe(earlier.system);
	expect(later.systems).toBeLessThanOrEqual(earlier.systems);
	expect(JSON.stringify(later.conversation.slice(0, earlier.conversation.length))).toBe(JSON.stringify(earlier.conversation));
};

const getRegisteredChildHooks = (): ChildSessionHook[] => {
	const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	return hooks instanceof Set ? [...(hooks as Set<ChildSessionHook>)] : [];
};

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");
const configPath = () => join(agentDir(), "soul.json");
const writeConfig = (value: unknown) => writeFile(configPath(), typeof value === "string" ? value : JSON.stringify(value));
const newManager = (options?: { parentSession?: string }) => SessionManager.create(cwd(), sessionDir(), options);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-soul-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
	delete (globalThis as Record<symbol, unknown>)[SOUL_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		delete (globalThis as Record<symbol, unknown>)[SOUL_SHARED_KEY];
		delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
		await rm(root, { recursive: true, force: true });
	}
});

function recordingUi() {
	const notes: { message: string; type?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const noop = () => {};
	const context = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		onTerminalInput: () => noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
		notify: (message: string, type?: string) => { notes.push({ message, type }); },
		setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
	} as unknown as ExtensionUIContext;
	return { notes, statuses, context };
}

async function start(options: {
	sessionManager?: SessionManager;
	mode?: ExtensionContext["mode"];
	extension?: boolean;
	useChildHooks?: boolean;
	register?: (pi: ExtensionAPI) => void;
	bindAsChild?: boolean;
	customPrompt?: string;
} = {}) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ api: "soul-test-api", provider: "soul-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});
	const ui = recordingUi();
	const requests: Captured[] = [];
	const respond: FauxResponseFactory = ({ messages }) => {
		requests.push(capture(messages));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => respond));

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const hookFactories = options.useChildHooks
			? getRegisteredChildHooks().map((hook) => ({ name: hook.name, factory: hook.extensionFactory }))
			: [];
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: options.extension === false ? [] : [extensionPath],
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						options.register?.(pi);
					},
					...hookFactories,
				],
				...(options.customPrompt !== undefined && {
					systemPromptOverride: () => options.customPrompt!,
					appendSystemPromptOverride: () => [],
				}),
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel("test"),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: cwd(),
		agentDir: agentDir(),
		sessionManager: options.sessionManager ?? newManager(),
	});
	const errors: unknown[] = [];
	const bind = () =>
		runtime.session.bindExtensions(
			options.bindAsChild
				? {}
				: {
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
					},
		);
	runtime.setRebindSession(bind);
	await bind();

	const harness = {
		runtime,
		faux,
		requests,
		errors,
		...ui,
		get session() { return runtime.session; },
		get sessionId() { return runtime.session.sessionManager.getSessionId(); },
		get lastNote() { return ui.notes.at(-1); },
		async run(prompt: string) {
			const before = requests.length;
			await runtime.session.prompt(prompt);
			expect(requests.length).toBe(before + 1);
			return requests.at(-1)!;
		},
		command: (text: string) => runtime.session.prompt(text),
		entries: () =>
			runtime.session.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === "soul" ? [entry.data] : [])),
		hiddenMessages: () =>
			runtime.session.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom_message" && entry.customType === "soul" ? [entry] : [])),
		visibleMessages: () =>
			runtime.session.sessionManager
				.buildSessionProjection()
				.messages.flatMap((message) =>
					message.role === "custom" && message.customType === "soul" ? [textOf(message as Message)] : [],
				),
		async compactAway() {
			await runtime.session.compact();
			expect(runtime.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
			expect(this.visibleMessages()).toEqual([]);
		},
		entryOf(text: string) {
			const found = runtime.session.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user" && textOf(entry.message as Message) === text);
			if (!found) throw new Error(`no user message ${text}`);
			return found;
		},
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

async function reopen(h: Harness, mode?: ExtensionContext["mode"]) {
	const file = h.session.sessionFile!;
	await h.dispose();
	started.splice(started.indexOf(h), 1);
	return start({ sessionManager: SessionManager.open(file, sessionDir()), mode });
}

describe("default-on and prompt cache", () => {
	it.each(["tui", "rpc", "print"] as const)("injects the <soul> section by default in fresh %s sessions without hidden messages", async (mode) => {
		const h = await start({ mode });
		const first = await h.run("one");
		expect(first.system).toContain(SECTION);
		expect(soulMessages(first)).toEqual([]);
		expect(h.statuses.has("soul")).toBe(false);

		const second = await h.run("two");
		expectSamePrefix(second, first);
		expect(soulMessages(second)).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("omits both section and hidden messages when turned off before the first prompt", async () => {
		const h = await start();
		await h.command("/soul off");
		expect(h.lastNote?.message).toContain("Soul principles off");

		const first = await h.run("one");
		expectUntouched(first);
		const second = await h.run("two");
		expectSamePrefix(second, first);
		expectUntouched(second);
	});

	it("switches off and back on mid-session via one-shot hidden messages without changing the system prompt", async () => {
		const h = await start();
		const r1 = await h.run("one");
		expect(r1.system).toContain(SECTION);
		expect(soulMessages(r1)).toEqual([]);

		await h.command("/soul off");
		const r2 = await h.run("two");
		expectSamePrefix(r2, r1);
		expect(soulMessages(r2)).toEqual([OFF_TEXT]);

		// Not duplicated on subsequent turns while still off.
		const r3 = await h.run("three");
		expectSamePrefix(r3, r2);
		expect(soulMessages(r3)).toEqual([OFF_TEXT]);

		// Toggle back on with bare `/soul`.
		await h.command("/soul");
		const r4 = await h.run("four");
		expectSamePrefix(r4, r3);
		expect(soulMessages(r4)).toEqual([OFF_TEXT, ON_TEXT]);

		const r5 = await h.run("five");
		expectSamePrefix(r5, r4);
		expect(soulMessages(r5)).toEqual([OFF_TEXT, ON_TEXT]);
	});

	it("re-sends a hidden override after compaction only when active state differs from the section", async () => {
		const h = await start();
		await h.run("one");

		await h.command("/soul off");
		await h.run("two");
		await h.compactAway();

		const afterOffCompact = await h.run("three");
		expect(afterOffCompact.system).toContain(SECTION);
		expect(soulMessages(afterOffCompact)).toEqual([OFF_TEXT]);

		await h.command("/soul reset");
		expect(h.lastNote?.message).toBe("Soul principles reset to on. Takes effect with the next prompt.");
		await h.run("four");
		await h.compactAway();

		// Now active (on) matches the section (on), so nothing needs to be re-sent after compaction.
		const afterResetCompact = await h.run("five");
		expect(afterResetCompact.system).toContain(SECTION);
		expect(soulMessages(afterResetCompact)).toEqual([]);
	});

	it("never adds a section to a session that predates the extension, sending ON_TEXT once instead", async () => {
		const pre = await start({ extension: false });
		const r0 = await pre.run("before extension");
		expectUntouched(r0);
		const file = pre.session.sessionFile!;
		await pre.dispose();
		started.splice(started.indexOf(pre), 1);

		const resumed = await start({ sessionManager: SessionManager.open(file, sessionDir()) });
		const r1 = await resumed.run("after extension");
		expectSamePrefix(r1, r0);
		expect(r1.system).not.toContain("<soul>");
		expect(soulMessages(r1)).toEqual([ON_TEXT]);

		const r2 = await resumed.run("still on");
		expectSamePrefix(r2, r1);
		expect(soulMessages(r2)).toEqual([ON_TEXT]);

		await resumed.command("/soul off");
		const r3 = await resumed.run("turned off");
		expectSamePrefix(r3, r2);
		expect(soulMessages(r3)).toEqual([ON_TEXT, OFF_TEXT]);
	});

	it("follows branch state across /tree, reopen, reload, and forks without changing the pinned section", async () => {
		const h = await start();
		await h.run("root");
		const rootId = h.entryOf("root").id;

		await h.command("/soul off");
		const offTurn = await h.run("on off-branch");
		expect(soulMessages(offTurn)).toEqual([OFF_TEXT]);

		await h.session.navigateTree(rootId);
		const backOnRoot = await h.run("branched from root");
		expect(backOnRoot.system).toContain(SECTION);
		expect(soulMessages(backOnRoot)).toEqual([]);

		await h.session.reload();
		const afterReload = await h.run("after reload");
		expectSamePrefix(afterReload, backOnRoot);

		const reopened = await reopen(h);
		const afterReopen = await reopened.run("after reopen");
		expectSamePrefix(afterReopen, afterReload);
	});
});

describe("/soul configuration and commands", () => {
	it("reads and updates <agentDir>/soul.json for new sessions without changing started sessions", async () => {
		const first = await start();
		await first.command("/soul status");
		expect(first.lastNote?.message).toContain("Active soul: on\nSession default: not pinned yet\nDefault for new sessions: on");

		await first.run("pin first");
		await first.command("/soul default off");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: false });

		// Started session keeps its pinned `on` state.
		const stillOn = await first.run("still on");
		expect(stillOn.system).toContain(SECTION);

		// New session picks up `default: false`.
		const second = await start();
		const offByDefault = await second.run("new session");
		expectUntouched(offByDefault);

		// Turning it on before first prompt puts `<soul>` in the section.
		const third = await start();
		await third.command("/soul on");
		const onInThird = await third.run("opted in");
		expect(onInThird.system).toContain(SECTION);
		expect(soulMessages(onInThird)).toEqual([]);

		await third.command("/soul default on");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: true });
	});

	it("warns on malformed soul.json and falls back to on", async () => {
		await writeConfig("{not-json");
		const h = await start();
		expect(h.notes.some((n) => n.type === "warning" && n.message.includes("Ignoring"))).toBe(true);
		const req = await h.run("one");
		expect(req.system).toContain(SECTION);
	});

	it("validates subcommands and blocks /soul in non-top-level sessions", async () => {
		const h = await start();
		await h.command("/soul bogus");
		expect(h.lastNote).toEqual({
			message: "Usage: /soul [on | off | reset | status | default [on | off]]",
			type: "warning",
		});

		await h.command("/soul default maybe");
		expect(h.lastNote).toEqual({
			message: "Usage: /soul default [on | off]",
			type: "warning",
		});

		await h.command("/soul on");
		expect(h.lastNote?.message).toBe("Soul principles are already on.");

		await h.command("/soul reset");
		expect(h.lastNote?.message).toBe("No soul override is active.");

		const childMgr = newManager({ parentSession: h.session.sessionFile });
		childMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			parentSessionId: h.sessionId,
			agentType: "worker",
		});
		const linkedChild = await start({ sessionManager: childMgr, mode: "rpc" });
		await linkedChild.command("/soul off");
		expect(linkedChild.lastNote).toEqual({
			message: "/soul works only in top-level TUI and RPC sessions.",
			type: "warning",
		});
	});
});

describe("subagent and child-session inheritance", () => {
	it("registers in CHILD_SESSION_HOOKS while open, deduplicates dual loading, and cleans up on shutdown", async () => {
		expect(getRegisteredChildHooks()).toEqual([]);
		const parent = await start();
		expect(getRegisteredChildHooks().map((hook) => hook.name)).toEqual(["soul"]);

		// Child loads BOTH by path (`extension: true`) and via `CHILD_SESSION_HOOKS` (`useChildHooks: true`).
		const childMgr = newManager({ parentSession: parent.session.sessionFile });
		childMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			parentSessionId: parent.sessionId,
			parentSessionFile: parent.session.sessionFile,
			agentType: "worker",
		});
		const child = await start({ sessionManager: childMgr, useChildHooks: true, bindAsChild: true });
		const childReq = await child.run("do task");
		expect(childReq.system).toContain(SECTION);
		expect(child.entries()).toHaveLength(1);

		await child.dispose();
		started.splice(started.indexOf(child), 1);
		expect(getRegisteredChildHooks().map((hook) => hook.name)).toEqual(["soul"]);

		await parent.dispose();
		started.splice(started.indexOf(parent), 1);
		expect(getRegisteredChildHooks()).toEqual([]);
	});

	it("propagates parent /soul on and /soul off to isolated subagents, nested subagents, Herder steps, and resumed children", async () => {
		const parent = await start();
		await parent.run("start parent");

		// 1. Default on -> isolated child (loaded only via CHILD_SESSION_HOOKS) inherits `<soul>`.
		const worker1Mgr = newManager({ parentSession: parent.session.sessionFile });
		worker1Mgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			parentSessionId: parent.sessionId,
			agentType: "worker",
		});
		const worker1 = await start({
			sessionManager: worker1Mgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
		});
		const w1Turn1 = await worker1.run("implement slice");
		expect(w1Turn1.system).toContain(SECTION);
		expect(soulMessages(w1Turn1)).toEqual([]);

		// 2. Parent turns `/soul off` -> newly spawned subagent, nested leaf subagent, and Herder step all inherit `off`.
		await parent.command("/soul off");

		const orchestratorMgr = newManager({ parentSession: parent.session.sessionFile });
		orchestratorMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			parentSessionId: parent.sessionId,
			agentType: "orchestrator",
		});
		const orchestrator = await start({
			sessionManager: orchestratorMgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
		});
		expectUntouched(await orchestrator.run("plan"));

		const nestedLeafMgr = newManager({ parentSession: orchestrator.session.sessionFile });
		nestedLeafMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			parentSessionId: orchestrator.sessionId,
			agentType: "recon",
		});
		const nestedLeaf = await start({
			sessionManager: nestedLeafMgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
		});
		expectUntouched(await nestedLeaf.run("inspect"));

		const herderMgr = newManager({ parentSession: parent.session.sessionFile });
		herderMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "herder-step",
			parentSessionId: parent.sessionId,
			agentType: "worker",
		});
		const herderStep = await start({
			sessionManager: herderMgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
		});
		expectUntouched(await herderStep.run("step T1"));

		// 3. Resuming `worker1` (which started with `<soul>` pinned) keeps its cached system prompt and appends OFF_TEXT once.
		const w1Turn2 = await worker1.run("continue slice");
		expectSamePrefix(w1Turn2, w1Turn1);
		expect(soulMessages(w1Turn2)).toEqual([OFF_TEXT]);
	});

	it("leaves memory-dream, @mention clone, and already-rendered <soul> custom prompts untouched", async () => {
		const parent = await start();
		await parent.run("start");

		const dreamMgr = newManager({ parentSession: parent.session.sessionFile });
		dreamMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			agentType: "memory-dream",
			parentSessionId: parent.sessionId,
			description: "memory dream",
		});
		const dream = await start({
			sessionManager: dreamMgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
			customPrompt: "DREAM PROMPT",
		});
		const dreamReq = await dream.run("consolidate");
		expectUntouched(dreamReq);
		expect(dream.entries()).toEqual([]);

		const cloneMgr = newManager({ parentSession: parent.session.sessionFile });
		cloneMgr.appendCustomEntry(SESSION_LINK_TYPE, {
			kind: "subagent",
			agentType: "recon",
			parentSessionId: parent.sessionId,
			description: "@mention clone",
		});
		const clone = await start({
			sessionManager: cloneMgr,
			extension: false,
			useChildHooks: true,
			bindAsChild: true,
			customPrompt: `Preamble\n\n${SECTION}`,
		});
		const cloneReq = await clone.run("@recon find");
		expect(cloneReq.system.match(/<soul>/g)).toHaveLength(1);
		expect(clone.entries()).toEqual([]);
	});
});
