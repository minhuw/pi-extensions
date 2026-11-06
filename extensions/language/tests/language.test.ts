// The Language extension in real Pi sessions on the faux provider, with real session files, asserting on what the provider receives.
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

// Load by path, as Pi does.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const SESSION_LINK = "pi-extensions.session-link";
const section = (base: string) => `<language>\nDefault response language: ${base}. A later language message overrides it. Keep code, identifiers, commands, and file paths unchanged.\n</language>`;
const switchMessage = (active: string) => `Respond in ${active}, whatever language the user writes in. This overrides the default language. Keep code, identifiers, commands, and file paths unchanged.`;
const resetMessage = (base: string) => `Ignore earlier language overrides. Respond in ${base}.`;
const RESET_TO_USER = "Ignore earlier language overrides. Respond in the user's language.";

type Message = { role: string; content: unknown };
interface Captured { system: string; systems: number; conversation: Message[] }

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return { system: getCurrentSystemPrompt(messages), systems: copy.filter((message) => message.role === "system").length, conversation: copy.filter((message) => message.role !== "system") };
};
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
/** What followed the run's starting message in a request: the language message of that run, if any. */
const afterPrompt = (request: Captured, prompt: string) => {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
};
const languageMessages = (request: Captured) => request.conversation.map(textOf).filter((text) => text.startsWith("Respond in ") || text.startsWith("Ignore earlier language overrides"));
const expectUntouched = (request: Captured) => {
	expect(request.system).not.toContain("<language>");
	expect(languageMessages(request)).toEqual([]);
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
const configPath = () => join(agentDir(), "language.json");
const writeConfig = (value: unknown) => writeFile(configPath(), typeof value === "string" ? value : JSON.stringify(value));
const newManager = (options?: { parentSession?: string }) => SessionManager.create(cwd(), sessionDir(), options);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-language-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
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
	const faux = fauxProvider({ api: "language-test-api", provider: "language-test", models: [{ id: "test" }] });
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
		get status() { return ui.statuses.get("language"); },
		get lastNote() { return ui.notes.at(-1); },
		/** Run one prompt and return the request it made. */
		async run(prompt: string) {
			const before = requests.length;
			await runtime.session.prompt(prompt);
			expect(requests.length).toBe(before + 1);
			return requests.at(-1)!;
		},
		command: (text: string) => runtime.session.prompt(text),
		/** The session's `language` entries on the current branch. */
		entries: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "language" ? [entry.data] : []),
		hiddenMessages: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "language" ? [entry] : []),
		entryOf(text: string) {
			const found = runtime.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" && textOf(entry.message as Message) === text);
			if (!found) throw new Error(`no user message ${text}`);
			return found;
		},
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}
type Harness = Awaited<ReturnType<typeof start>>;

/** Close the session and open its file again, as a new Pi process would. */
async function reopen(h: Harness, mode?: ExtensionContext["mode"]) {
	const file = h.session.sessionFile!;
	await h.dispose();
	started.splice(started.indexOf(h), 1);
	return start({ sessionManager: SessionManager.open(file, sessionDir()), mode });
}

describe("first runs", () => {
	it("AC-1 sends no section and no message without a default or /language", async () => {
		const h = await start();
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("one"));
		expectUntouched(await h.run("two"));
		expect(h.status).toBeUndefined();
		expect(h.errors).toEqual([]);
	});

	it.each(["tui", "rpc"] as const)("AC-2 puts the default in a section at the first run in %s mode", async (mode) => {
		await writeConfig({ default: "English" });
		const h = await start({ mode });
		expect(h.status).toBe("English");
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(h.entries()).toEqual([{ base: "English" }]);
		expectSamePrefix(await h.run("two"), first);
		expect(h.errors).toEqual([]);
	});

	it("AC-3 adds no message while the active language is the pinned default", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		expect(languageMessages(await h.run("one"))).toEqual([]);
		await h.command("/language ENGLISH");
		expect(languageMessages(await h.run("two"))).toEqual([]);
		expect(h.entries()).toEqual([{ base: "English" }]);
	});

	it("AC-3 adds no message when a switch before the first run names the default, ignoring case", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language english");
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
	});

	it("does not count a system entry or a language entry as conversation", async () => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		manager.appendMessage({ role: "system", content: "", sections: { preamble: "You help." }, timestamp: Date.now() } as never);
		const h = await start({ sessionManager: manager });
		await h.command("/language Deutsch");
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(afterPrompt(first, "one")).toEqual([switchMessage("Deutsch")]);
	});
});

describe("switching", () => {
	describe.each([["a pinned default", "English"], ["no default", undefined]])("with %s", (_name, base) => {
		it("AC-4 keeps the system prompt and earlier messages byte-identical across a switch", async () => {
			if (base) await writeConfig({ default: base });
			const h = await start();
			await h.run("one");
			const before = await h.run("two");
			await h.command("/language Deutsch");
			const after = await h.run("three");
			await h.command("/language Français");
			const later = await h.run("four");
			expectSamePrefix(after, before);
			expectSamePrefix(later, after);
			expect(afterPrompt(after, "three")).toEqual([switchMessage("Deutsch")]);
			expect(afterPrompt(later, "four")).toEqual([switchMessage("Français")]);
			if (base) expect(later.system).toContain(section(base));
			else expect(later.system).not.toContain("<language>");
		});
	});

	it("AC-5 adds one hidden message after the starting message of each run", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.run("one");
		await h.command("/language Deutsch");
		expect(h.status).toBe("Deutsch");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([switchMessage("Deutsch")]);
		const third = await h.run("three");
		expect(afterPrompt(third, "three")).toEqual([switchMessage("Deutsch")]);
		expect(languageMessages(third)).toEqual([switchMessage("Deutsch"), switchMessage("Deutsch")]);
		expect(h.hiddenMessages().map((entry) => entry.display)).toEqual([false, false]);
	});

	it("AC-5 adds the message to runs started by a custom message", async () => {
		const h = await start();
		await h.command("/language Deutsch");
		await h.session.sendCustomMessage({ customType: "other", content: "nudge", display: true }, { triggerTurn: true });
		await h.session.waitForIdle();
		expect(afterPrompt(h.requests.at(-1)!, "nudge")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-5 adds the message to the first run after a real compaction", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		const before = await h.run("one");
		await h.run("two");
		await h.session.compact();
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		const after = await h.run("three");
		expect(after.system).toBe(before.system);
		expect(after.system).toContain(section("English"));
		expect(afterPrompt(after, "three")).toEqual([switchMessage("Deutsch")]);
		expect(h.errors).toEqual([]);
	});

	it("AC-6 sends one reset message to the next run and none later", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		const before = await h.run("one");
		await h.command("/language reset");
		expect(h.status).toBe("English");
		const reset = await h.run("two");
		expect(afterPrompt(reset, "two")).toEqual([resetMessage("English")]);
		expect(reset.system).toBe(before.system);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
		expect(h.hiddenMessages().at(-1)?.display).toBe(false);
	});

	it("AC-6 treats the pinned default's name as a reset, ignoring case", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.command("/language eNgLiSh");
		expect(h.status).toBe("English");
		expect(h.entries().at(-1)).toEqual({ active: null, reset: true });
		expect(afterPrompt(await h.run("two"), "two")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
	});

	it("AC-6 tells a session with no pinned default to follow the user's language", async () => {
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.command("/language reset");
		expect(h.status).toBeUndefined();
		const reset = await h.run("two");
		expect(afterPrompt(reset, "two")).toEqual([RESET_TO_USER]);
		expect(reset.system).not.toContain("<language>");
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
	});

	it("AC-6 keeps a pending reset when the session is resumed before the next run", async () => {
		await writeConfig({ default: "English" });
		const first = await start();
		await first.command("/language Deutsch");
		await first.run("one");
		await first.command("/language reset");
		const resumed = await reopen(first);
		expect(resumed.status).toBe("English");
		expect(afterPrompt(await resumed.run("two"), "two")).toEqual([resetMessage("English")]);
		const again = await reopen(resumed);
		expect(afterPrompt(await again.run("three"), "three")).toEqual([]);
	});

	it("AC-6 keeps a pending reset across a compaction", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.run("two");
		await h.command("/language reset");
		await h.session.compact();
		expect(afterPrompt(await h.run("three"), "three")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
	});

	it("AC-6 records and sends no reset when no switch is active", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.run("one");
		await h.command("/language reset");
		await h.command("/language English");
		expect(h.entries()).toEqual([{ base: "English" }]);
		expect(afterPrompt(await h.run("two"), "two")).toEqual([]);
		expect(h.lastNote?.type).toBe("info");
	});

	it("AC-6 sends the reset message when a switch made before the first run is reset", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.command("/language reset");
		expect(h.status).toBe("English");
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(afterPrompt(first, "one")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("two"), "two")).toEqual([]);
	});

	it("keeps a pending reset when another extension's message follows it", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.command("/language reset");
		await h.session.sendCustomMessage({ customType: "other", content: "note", display: true });
		expect(afterPrompt(await h.run("two"), "two")).toEqual([resetMessage("English")]);
	});

	it("drops a pending reset when another switch follows it", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.command("/language reset");
		await h.command("/language Français");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([switchMessage("Français")]);
	});
});

describe("the default for new sessions", () => {
	it("AC-7 saves the default for sessions that have not had a first run and removes it", async () => {
		const h = await start();
		await h.command("/language default English");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
		expect(await readdir(agentDir())).toEqual(["language.json"]);
		expect(h.lastNote).toEqual({ message: "Default for new sessions: English. Sessions that have had a first run keep their language.", type: "info" });
		expect(h.status).toBe("English");
		expect((await h.run("one")).system).toContain(section("English"));

		await h.runtime.newSession();
		expect(h.status).toBe("English");
		await h.command("/language default off");
		await expect(access(configPath())).rejects.toThrow();
		expect(h.lastNote?.message).toContain("first run");
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("two"));
		expect(h.errors).toEqual([]);
	});

	it("AC-7 reads the file fresh, so a default saved by another session applies", async () => {
		const h = await start();
		await writeConfig({ default: "English" });
		expect((await h.run("one")).system).toContain(section("English"));
	});

	it("AC-7 replaces the file through a rename, so readers never see a partial write", async () => {
		await writeConfig({ default: "English" });
		const before = await stat(configPath());
		const h = await start();
		await h.command("/language default Italiano");
		expect((await stat(configPath())).ino).not.toBe(before.ino);
		expect(await readdir(agentDir())).toEqual(["language.json"]);
	});

	it("AC-7 creates a missing agent directory", async () => {
		const h = await start();
		await rm(agentDir(), { recursive: true });
		await h.command("/language default Simplified Chinese");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "Simplified Chinese" });
	});

	it.each([["a pinned default", "English"], ["no default", undefined]])("AC-8 leaves the system prompt of a session with %s unchanged", async (_name, base) => {
		if (base) await writeConfig({ default: base });
		const h = await start();
		const before = await h.run("one");
		const status = h.status;
		await h.command("/language default Italiano");
		expect(h.lastNote?.message).toContain("first run");
		expect(h.status).toBe(status);
		const changed = await h.run("two");
		await h.command("/language default off");
		const removed = await h.run("three");
		expectSamePrefix(changed, before);
		expectSamePrefix(removed, changed);
		expect(languageMessages(removed)).toEqual([]);
		if (base) expect(removed.system).toContain(section(base));
		else expect(removed.system).not.toContain("<language>");
	});

	it("AC-12 reports the active language, the pinned default, and the default for new sessions", async () => {
		const h = await start();
		await h.command("/language");
		expect(h.lastNote).toEqual({ message: "Active language: none\nSession default: not pinned yet\nDefault for new sessions: none", type: "info" });

		await writeConfig({ default: "English" });
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: English\nSession default: not pinned yet\nDefault for new sessions: English");

		await h.run("one");
		await h.command("/language Deutsch");
		await writeConfig({ default: "Italiano" });
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: Deutsch\nSession default: English\nDefault for new sessions: Italiano");
		await h.command("/language default");
		expect(h.lastNote).toEqual({ message: "Default for new sessions: Italiano.", type: "info" });
	});

	it("AC-12 reports a session that pinned no default", async () => {
		const h = await start();
		await h.run("one");
		await writeConfig({ default: "English" });
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: none\nSession default: none\nDefault for new sessions: English");
	});
});

describe("restoring a session", () => {
	/** A persisted session pinned to English, then switched to Deutsch. */
	async function switchedSession() {
		await writeConfig({ default: "English" });
		const h = await start();
		const first = await h.run("one");
		await h.command("/language Deutsch");
		await h.run("two");
		// Restoring must come from the branch, not from the current configuration.
		await writeConfig({ default: "Italiano" });
		return { h, first };
	}

	it("AC-9 restores after a reload", async () => {
		const { h, first } = await switchedSession();
		h.statuses.clear();
		await h.session.reload();
		expect(h.status).toBe("Deutsch");
		const run = await h.run("three");
		expect(run.system).toBe(first.system);
		expect(afterPrompt(run, "three")).toEqual([switchMessage("Deutsch")]);
		expect(h.errors).toEqual([]);
	});

	it("AC-9 restores after a resume within a process and in a new one", async () => {
		const { h, first } = await switchedSession();
		const file = h.session.sessionFile!;
		await h.runtime.newSession();
		expect(h.status).toBe("Italiano");
		await h.runtime.switchSession(file);
		expect(h.status).toBe("Deutsch");
		const run = await h.run("three");
		expect(run.system).toBe(first.system);
		expect(afterPrompt(run, "three")).toEqual([switchMessage("Deutsch")]);

		const resumed = await reopen(h);
		expect(resumed.status).toBe("Deutsch");
		const later = await resumed.run("four");
		expect(later.system).toBe(first.system);
		expect(afterPrompt(later, "four")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-9 follows the branch through /tree", async () => {
		const { h, first } = await switchedSession();
		const manager = () => h.session.sessionManager;
		const switchedLeaf = manager().getLeafId()!;
		const beforeSwitch = manager().getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;

		await h.session.navigateTree(beforeSwitch.id);
		expect(h.status).toBe("English");
		const other = await h.run("other branch");
		expect(other.system).toBe(first.system);
		expect(afterPrompt(other, "other branch")).toEqual([]);

		await h.session.navigateTree(switchedLeaf);
		expect(h.status).toBe("Deutsch");
		const back = await h.run("three");
		expect(back.system).toBe(first.system);
		expect(afterPrompt(back, "three")).toEqual([switchMessage("Deutsch")]);
		expect(h.errors).toEqual([]);
	});

	it("AC-9 uses a reset that is pending on the branch only", async () => {
		const { h } = await switchedSession();
		const switchedLeaf = h.session.sessionManager.getLeafId()!;
		await h.command("/language reset");
		await h.session.navigateTree(switchedLeaf);
		expect(h.status).toBe("Deutsch");
		expect(afterPrompt(await h.run("three"), "three")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-9 shows the session's pin when /tree moves before it, not the configured default", async () => {
		const { h, first } = await switchedSession();
		await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
		expect(h.status).toBe("English");
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: English\nSession default: English\nDefault for new sessions: Italiano");
		await h.command("/language english");
		expect(h.entries()).toEqual([]);
		const run = await h.run("other");
		expect(run.system).toBe(first.system);
		expect(afterPrompt(run, "other")).toEqual([]);
		expect(h.entries()).toEqual([{ base: "English" }]);
	});

	it("AC-8 keeps the section on a branch whose conversation comes before the pin", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		const first = await h.run("one");
		await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
		await h.session.executeBash("true");
		const run = await h.run("other");
		expect(run.system).toBe(first.system);
		expect(languageMessages(run)).toEqual([]);
	});

	// Pi names the source in a fork's header, as it does for a child, so these also show that the header does not decide eligibility.
	it("AC-9 keeps the pin in a fork taken before the switch", async () => {
		const { h, first } = await switchedSession();
		const source = h.session.sessionFile;
		h.statuses.clear();
		await h.runtime.fork(h.entryOf("one").id);
		expect(h.session.sessionManager.getHeader()?.parentSession).toBe(source);
		expect(h.status).toBe("English");
		const run = await h.run("forked");
		expect(run.system).toBe(first.system);
		expect(run.system).toContain(section("English"));
		expect(afterPrompt(run, "forked")).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("AC-9 keeps the active language in a fork taken after the switch", async () => {
		const { h, first } = await switchedSession();
		h.statuses.clear();
		await h.runtime.fork(h.entryOf("two").id);
		expect(h.status).toBe("Deutsch");
		const run = await h.run("forked");
		expect(run.system).toBe(first.system);
		expect(afterPrompt(run, "forked")).toEqual([switchMessage("Deutsch")]);

		await h.command("/language Français");
		expect(h.lastNote?.type).toBe("info");
		expect(h.status).toBe("Français");
		const resumed = await reopen(h);
		expect(resumed.status).toBe("Français");
		expect(afterPrompt(await resumed.run("later"), "later")).toEqual([switchMessage("Français")]);
	});

	it("AC-9 keeps a pending reset in a fork", async () => {
		const { h } = await switchedSession();
		await h.command("/language reset");
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		expect(h.status).toBe("English");
		expect(afterPrompt(await h.run("forked"), "forked")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("later"), "later")).toEqual([]);
	});

	it("keeps a fork eligible when /tree moves it before the pin", async () => {
		const { h } = await switchedSession();
		await h.runtime.fork(h.entryOf("one").id);
		const root = h.session.sessionManager.getBranch()[0]!;
		await h.session.navigateTree(root.id);
		expect(h.entries()).toEqual([]);
		await h.command("/language Français");
		expect(h.lastNote?.type).toBe("info");
		expect(h.entries()).toEqual([{ active: "Français" }]);
	});
});

describe("sessions that predate the extension", () => {
	it("AC-10 uses a hidden message for the default and adds no section", async () => {
		const old = await start({ extension: false });
		const before = await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		expect(h.status).toBe("English");
		const first = await h.run("one");
		expectSamePrefix(first, before);
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "one")).toEqual([switchMessage("English")]);
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
		const second = await h.run("two");
		expectSamePrefix(second, first);
		expect(afterPrompt(second, "two")).toEqual([switchMessage("English")]);
		expect(h.status).toBe("English");
	});

	it("adds nothing to such a session when no default is configured", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		const h = await reopen(old);
		expectUntouched(await h.run("one"));
		expect(h.entries()).toEqual([{ base: null }]);
	});

	it("keeps a language chosen with /language before such a session's first run", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.command("/language Deutsch");
		expect(afterPrompt(await h.run("one"), "one")).toEqual([switchMessage("Deutsch")]);
		expect(h.status).toBe("Deutsch");
	});

	it("keeps a reset used before such a session's first run", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		const h = await reopen(old);
		await h.command("/language Deutsch");
		await h.command("/language reset");
		expect(afterPrompt(await h.run("one"), "one")).toEqual([RESET_TO_USER]);
		expect(afterPrompt(await h.run("two"), "two")).toEqual([]);
	});

	it("AC-10 sends a reset before such a session's first run once, and the default after it", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.command("/language Deutsch");
		await h.command("/language reset");
		expect(afterPrompt(await h.run("one"), "one")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("two"), "two")).toEqual([switchMessage("English")]);
		expect(h.status).toBe("English");
	});

	it("AC-10 sends the default on a branch that leaves before such a session's pin", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.run("one");
		const answer = h.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		await h.session.navigateTree(answer.id);
		const run = await h.run("other");
		expect(run.system).not.toContain("<language>");
		expect(afterPrompt(run, "other")).toEqual([switchMessage("English")]);
	});

	it("AC-10 adds no section when such a session's first run starts before its conversation", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		const before = await old.run("older");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		const oldLeaf = h.session.sessionManager.getLeafId()!;
		await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
		const other = await h.run("other");
		expect(other.system).not.toContain("<language>");
		expect(afterPrompt(other, "other")).toEqual([switchMessage("English")]);
		await h.session.navigateTree(oldLeaf);
		const back = await h.run("back");
		expectSamePrefix(back, before);
		expect(back.system).not.toContain("<language>");
		expect(afterPrompt(back, "back")).toEqual([switchMessage("English")]);
	});

	it.each<[string, (manager: SessionManager) => void]>([
		["a custom message", (manager) => { manager.appendCustomMessageEntry("other", "note", true); }],
		["a compaction", (manager) => { manager.appendCompaction("summary", manager.getLeafId()!, 100); }],
		["a branch summary", (manager) => { manager.branchWithSummary(manager.getLeafId(), "summary"); }],
	])("AC-10 counts %s as conversation", async (_name, seed) => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		manager.appendCustomEntry("other");
		seed(manager);
		const h = await start({ sessionManager: manager });
		const first = await h.run("one");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "one")).toEqual([switchMessage("English")]);
	});

	it("AC-10 counts a bash message as conversation", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.session.executeBash("true");
		const first = await h.run("one");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "one")).toEqual([switchMessage("English")]);
	});
});

describe("a default sent as a message", () => {
	/** A session from before this extension, past its first run with English as its default. */
	const fallbackSession = async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.run("one");
		return h;
	};
	const beforePin = (h: Harness) => h.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
	/** Answer the next requests with `reply`, called while the request is in flight. */
	const script = (h: Harness, reply: (call: number) => ReturnType<FauxResponseFactory>) => {
		let call = 0;
		const step: FauxResponseFactory = ({ messages }) => {
			h.requests.push(capture(messages));
			return reply(++call);
		};
		h.faux.setResponses(Array.from({ length: 10 }, () => step));
	};
	/** The run gets exactly `sent` as its hidden message, and no section. */
	const expectSent = async (h: Harness, prompt: string, sent: string) => {
		const run = await h.run(prompt);
		expect(afterPrompt(run, prompt)).toEqual([sent]);
		expect(run.system).not.toContain("<language>");
		expect(h.status).toBe(sent === switchMessage("Deutsch") ? "Deutsch" : "English");
		return run;
	};

	it("AC-10 returns to the default after a reset once the first run has happened", async () => {
		const h = await fallbackSession();
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
		await h.command("/language Deutsch");
		const switched = await expectSent(h, "two", switchMessage("Deutsch"));
		await h.command("/language reset");
		expect(h.lastNote).toEqual({ message: "Language reset to English. Takes effect with the next prompt.", type: "info" });
		expect(h.status).toBe("English");
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }, { active: "Deutsch" }, { active: null, reset: true }]);
		const reset = await expectSent(h, "three", resetMessage("English"));
		expectSamePrefix(reset, switched);
		const after = await expectSent(h, "four", switchMessage("English"));
		expectSamePrefix(after, reset);
		await expectSent(h, "five", switchMessage("English"));
		expect(h.hiddenMessages().filter((entry) => entry.content === resetMessage("English")).length).toBe(1);
		expect(h.errors).toEqual([]);
	});

	it("AC-10 returns to the default of a session switched before its first run", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.command("/language Deutsch");
		await expectSent(h, "one", switchMessage("Deutsch"));
		await h.command("/language reset");
		await expectSent(h, "two", resetMessage("English"));
		await expectSent(h, "three", switchMessage("English"));
	});

	it("AC-10 reports no active switch for a reset straight after the first run and changes nothing", async () => {
		const h = await fallbackSession();
		const entries = h.entries();
		await h.command("/language reset");
		expect(h.lastNote).toEqual({ message: "No language switch is active.", type: "info" });
		expect(h.entries()).toEqual(entries);
		expect(h.status).toBe("English");
		await expectSent(h, "two", switchMessage("English"));
		await expectSent(h, "three", switchMessage("English"));
	});

	it("AC-6 keeps a pending reset when such a session is resumed before the next run", async () => {
		const first = await fallbackSession();
		await first.command("/language Deutsch");
		await first.run("two");
		await first.command("/language reset");
		await writeConfig({ default: "Italiano" });
		const resumed = await reopen(first);
		expect(resumed.status).toBe("English");
		await expectSent(resumed, "three", resetMessage("English"));
		const again = await reopen(resumed);
		expect(again.status).toBe("English");
		await expectSent(again, "four", switchMessage("English"));
	});

	it("AC-6 keeps a pending reset across a compaction in such a session", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.run("three");
		await h.command("/language reset");
		await h.session.compact();
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(h.status).toBe("English");
		await expectSent(h, "four", resetMessage("English"));
		await expectSent(h, "five", switchMessage("English"));
		expect(h.errors).toEqual([]);
	});

	it("AC-6 treats the default's name as a reset, ignoring case", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language eNgLiSh");
		expect(h.lastNote?.message).toBe("Language reset to English. Takes effect with the next prompt.");
		expect(h.status).toBe("English");
		expect(h.entries().at(-1)).toEqual({ active: null, reset: true });
		await expectSent(h, "three", resetMessage("English"));
		await expectSent(h, "four", switchMessage("English"));
	});

	it("AC-6 records nothing when the default is named while it is active", async () => {
		const h = await fallbackSession();
		const entries = h.entries();
		await h.command("/language english");
		expect(h.lastNote).toEqual({ message: "No language switch is active.", type: "info" });
		expect(h.entries()).toEqual(entries);
		await expectSent(h, "two", switchMessage("English"));
	});

	it("AC-12 reports the default as the session default", async () => {
		const h = await fallbackSession();
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: English\nSession default: English\nDefault for new sessions: English");
		await h.command("/language Deutsch");
		await writeConfig({ default: "Italiano" });
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: Deutsch\nSession default: English\nDefault for new sessions: Italiano");
	});

	it("AC-8 keeps the default when the configured default changes or goes away", async () => {
		const h = await fallbackSession();
		await h.command("/language default Italiano");
		expect(h.status).toBe("English");
		const changed = await expectSent(h, "two", switchMessage("English"));
		await h.command("/language default off");
		expect(h.status).toBe("English");
		const removed = await expectSent(h, "three", switchMessage("English"));
		expectSamePrefix(removed, changed);
		await h.command("/language Deutsch");
		await h.run("four");
		await h.command("/language reset");
		await expectSent(h, "five", resetMessage("English"));
		await expectSent(h, "six", switchMessage("English"));
		await h.session.reload();
		expect(h.status).toBe("English");
		await expectSent(h, "seven", switchMessage("English"));
	});

	it.each<[string, (h: Harness) => string]>([
		["conversation", (h) => beforePin(h).id],
		["no conversation", (h) => h.session.sessionManager.getBranch()[0]!.id],
	])("AC-9 keeps the default when /tree moves before the pin, to a branch with %s", async (_name, target) => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		await h.session.navigateTree(target(h));
		expect(h.entries()).toEqual([]);
		expect(h.status).toBe("English");
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: English\nSession default: English\nDefault for new sessions: Italiano");
		await expectSent(h, "other", switchMessage("English"));
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
		await expectSent(h, "later", switchMessage("English"));
	});

	it("AC-9 returns to the default after a switch and a reset on a branch that leaves before the pin", async () => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		await h.session.navigateTree(beforePin(h).id);
		await h.command("/language english");
		expect(h.lastNote).toEqual({ message: "No language switch is active.", type: "info" });
		await h.command("/language Deutsch");
		await expectSent(h, "other", switchMessage("Deutsch"));
		expect(h.entries()).toEqual([{ active: "Deutsch" }, { base: null, fallback: "English" }]);
		await h.command("/language reset");
		await expectSent(h, "later", resetMessage("English"));
		await expectSent(h, "last", switchMessage("English"));
	});

	it("AC-9 keeps the default in a fork", async () => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		h.statuses.clear();
		await h.runtime.fork(h.entryOf("one").id);
		expect(h.status).toBe("English");
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
		await expectSent(h, "forked", switchMessage("English"));
		await h.command("/language Deutsch");
		await h.run("switched");
		await h.command("/language reset");
		await expectSent(h, "reset", resetMessage("English"));
		await expectSent(h, "later", switchMessage("English"));
	});

	it("AC-9 keeps a pending reset in a fork", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		expect(h.status).toBe("English");
		await expectSent(h, "forked", resetMessage("English"));
		await expectSent(h, "later", switchMessage("English"));
	});

	it("AC-9 uses a reset that is pending on the branch only", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		const switchedLeaf = h.session.sessionManager.getLeafId()!;
		await h.command("/language reset");
		await h.session.navigateTree(switchedLeaf);
		expect(h.status).toBe("Deutsch");
		await expectSent(h, "three", switchMessage("Deutsch"));
	});

	it.each<[string, (h: Harness) => Promise<Harness>]>([
		["a reload", async (h) => { await h.session.reload(); return h; }],
		["a resume within a process", async (h) => {
			const file = h.session.sessionFile!;
			await h.runtime.newSession();
			await h.runtime.switchSession(file);
			return h;
		}],
		["a resume in a new process", (h) => reopen(h)],
	])("AC-4, AC-6, and AC-9 restore the default, a switch, and a pending reset after %s", async (_name, restore) => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		const defaulted = await restore(h);
		expect(defaulted.status).toBe("English");
		const kept = await expectSent(defaulted, "two", switchMessage("English"));
		await defaulted.command("/language Deutsch");
		const switched = await restore(defaulted);
		expect(switched.status).toBe("Deutsch");
		const run = await expectSent(switched, "three", switchMessage("Deutsch"));
		expectSamePrefix(run, kept);
		await switched.command("/language reset");
		const reset = await restore(switched);
		expect(reset.status).toBe("English");
		expectSamePrefix(await expectSent(reset, "four", resetMessage("English")), run);
		const later = await restore(reset);
		expect(later.status).toBe("English");
		await expectSent(later, "five", switchMessage("English"));
		expect(later.hiddenMessages().filter((entry) => entry.content === resetMessage("English")).length).toBe(1);
	});

	it.each([["the default", undefined, "English"], ["a switch", "Deutsch", "Deutsch"]])("AC-5 sends %s to the first run after a compaction", async (_name, name, sent) => {
		const h = await fallbackSession();
		if (name) await h.command(`/language ${name}`);
		await h.run("two");
		await h.run("three");
		await h.session.compact();
		await expectSent(h, "four", switchMessage(sent!));
		await expectSent(h, "five", switchMessage(sent!));
		expect(h.errors).toEqual([]);
	});

	it("AC-5 and AC-6 reach runs started by a custom message, the first run included", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		const nudge = async (content: string) => {
			await h.session.sendCustomMessage({ customType: "other", content, display: true }, { triggerTurn: true });
			await h.session.waitForIdle();
			return h.requests.at(-1)!;
		};
		const first = await nudge("first");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "first")).toEqual([switchMessage("English")]);
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		expect(afterPrompt(await nudge("second"), "second")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await nudge("third"), "third")).toEqual([switchMessage("English")]);
	});

	it("AC-6 sends one reset for a switch no run has seen, however often it is repeated", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.command("/language reset");
		await h.command("/language reset");
		expect(h.lastNote).toEqual({ message: "No language switch is active.", type: "info" });
		await h.command("/language ENGLISH");
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }, { active: "Deutsch" }, { active: null, reset: true }]);
		await expectSent(h, "two", resetMessage("English"));
		await expectSent(h, "three", switchMessage("English"));
	});

	it("AC-6 drops a pending reset when another switch follows it, and resets from that switch", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		await h.command("/language Français");
		expect(h.status).toBe("Français");
		expect(afterPrompt(await h.run("three"), "three")).toEqual([switchMessage("Français")]);
		await h.command("/language reset");
		await expectSent(h, "four", resetMessage("English"));
		await expectSent(h, "five", switchMessage("English"));
	});

	it("AC-6 keeps a pending reset when another extension's message follows it", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		await h.session.sendCustomMessage({ customType: "other", content: "note", display: true });
		await expectSent(h, "three", resetMessage("English"));
	});

	it("AC-6 sends the reset once to a run of several turns", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		const messages = h.hiddenMessages().length;
		script(h, (call) => call === 1
			? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("ok"));
		const before = h.requests.length;
		await h.session.prompt("three");
		expect(h.requests.length).toBe(before + 2);
		for (const request of h.requests.slice(before)) expect(languageMessages(request).at(-1)).toBe(resetMessage("English"));
		expect(h.hiddenMessages().length).toBe(messages + 1);
		await expectSent(h, "four", switchMessage("English"));
	});

	it("AC-6 sends the reset to the next run when it is used during a run that carries the switch", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		script(h, async (call) => {
			if (call === 1) await h.command("/language reset");
			return fauxAssistantMessage("ok");
		});
		expect(afterPrompt(await h.run("three"), "three")).toEqual([switchMessage("Deutsch")]);
		expect(h.status).toBe("English");
		await expectSent(h, "four", resetMessage("English"));
		await expectSent(h, "five", switchMessage("English"));
	});

	// The extension registered after Language runs its handler between Language's return and the hidden message reaching the branch.
	it("AC-6 keeps a reset used while such a session's first run is starting with a switch", async () => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		manager.appendCustomEntry("other");
		manager.appendCustomMessageEntry("other", "note", true);
		let whileStarting: (() => Promise<void>) | undefined;
		const h = await start({ sessionManager: manager, register: (pi) => { pi.on("before_agent_start", async () => { await whileStarting?.(); }); } });
		await h.command("/language Deutsch");
		whileStarting = async () => {
			whileStarting = undefined;
			await h.command("/language reset");
		};
		expect(afterPrompt(await h.run("one"), "one")).toEqual([switchMessage("Deutsch")]);
		expect(h.status).toBe("English");
		await expectSent(h, "two", resetMessage("English"));
		await expectSent(h, "three", switchMessage("English"));
	});

	it("AC-6 and AC-9 send the reset once on each branch that carries it", async () => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		const pending = h.session.sessionManager.getLeafId()!;
		await expectSent(h, "three", resetMessage("English"));
		const sent = h.session.sessionManager.getLeafId()!;
		await expectSent(h, "four", switchMessage("English"));
		await h.session.navigateTree(pending);
		expect(h.status).toBe("English");
		await expectSent(h, "other", resetMessage("English"));
		await expectSent(h, "other later", switchMessage("English"));
		await h.session.navigateTree(sent);
		expect(h.status).toBe("English");
		await expectSent(h, "back", switchMessage("English"));
	});

	it.each<[string, string, string, string]>([
		["before the switch", "one", "English", switchMessage("English")],
		["after the switch", "two", "Deutsch", switchMessage("Deutsch")],
		["at a pending reset", "three", "English", resetMessage("English")],
		["after the reset was sent", "four", "English", switchMessage("English")],
	])("AC-9 takes the language of a fork landing %s", async (_name, prompt, status, sent) => {
		const h = await fallbackSession();
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command("/language reset");
		await h.run("three");
		await h.run("four");
		await writeConfig({ default: "Italiano" });
		h.statuses.clear();
		await h.runtime.fork(h.entryOf(prompt).id);
		expect(h.status).toBe(status);
		await expectSent(h, "forked", sent);
		expect(h.entries()[0]).toEqual({ base: null, fallback: "English" });
	});

	it("AC-9 keeps the default of a branch pinned after the first run across a fork and a resume", async () => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		await h.session.navigateTree(beforePin(h).id);
		await expectSent(h, "other", switchMessage("English"));
		await h.runtime.fork(h.entryOf("other").id);
		await h.command("/language default off");
		const resumed = await reopen(h);
		expect(resumed.status).toBe("English");
		expect(resumed.entries()).toEqual([{ base: null, fallback: "English" }]);
		await expectSent(resumed, "forked", switchMessage("English"));
		await resumed.command("/language Deutsch");
		await resumed.run("switched");
		await resumed.command("/language reset");
		await expectSent(resumed, "reset", resetMessage("English"));
	});

	it.each<[string, string | undefined, string]>([
		["a pinned default", "English", resetMessage("English")],
		["no default", undefined, RESET_TO_USER],
	])("AC-6 sends the reset on a branch before its pin in a session with %s", async (_name, base, sent) => {
		if (base) await writeConfig({ default: base });
		const h = await start();
		await h.run("one");
		await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
		await h.session.executeBash("true");
		await h.command("/language Deutsch");
		await h.command("/language reset");
		expect(afterPrompt(await h.run("other"), "other")).toEqual([sent]);
		expect(afterPrompt(await h.run("later"), "later")).toEqual([]);
	});

	it("AC-6 sends the reset when a switch is reset on a branch before it repeats the pin", async () => {
		const h = await fallbackSession();
		await writeConfig({ default: "Italiano" });
		await h.session.navigateTree(beforePin(h).id);
		await h.command("/language Deutsch");
		expect(h.status).toBe("Deutsch");
		await h.command("/language reset");
		expect(h.lastNote?.message).toBe("Language reset to English. Takes effect with the next prompt.");
		expect(h.status).toBe("English");
		await expectSent(h, "other", resetMessage("English"));
		await expectSent(h, "later", switchMessage("English"));
	});

	it("AC-6 keeps that reset in a fork where the repeated pin is the first one", async () => {
		const h = await fallbackSession();
		await h.session.navigateTree(beforePin(h).id);
		await h.command("/language Deutsch");
		await h.command("/language reset");
		await h.run("other");
		await h.runtime.fork(h.entryOf("other").id);
		expect(h.entries()).toEqual([{ active: "Deutsch" }, { active: null, reset: true }, { base: null, fallback: "English" }]);
		await expectSent(h, "forked", resetMessage("English"));
		await expectSent(h, "later", switchMessage("English"));
	});

	it.each([
		["Français", "FRANÇAIS"], ["Simplified Chinese", "simplified chinese"], ["简体中文", "简体中文"], ["x".repeat(40), "X".repeat(40)],
	])("AC-6 and AC-10 carry %s as the default", async (name, named) => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: name });
		const h = await reopen(old);
		expect(afterPrompt(await h.run("one"), "one")).toEqual([switchMessage(name)]);
		await h.command("/language Deutsch");
		await h.run("two");
		await h.command(`/language ${named}`);
		expect(h.status).toBe(name);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([resetMessage(name)]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([switchMessage(name)]);
	});

	it.each<[string, unknown]>([
		["malformed", "not json"], ["an invalid name", { default: "reset" }], ["empty", { default: "" }], ["missing its name", {}], ["not a string", { default: 3 }],
	])("AC-10 writes no fallback when the configured default is %s", async (_name, config) => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig(config);
		const h = await reopen(old);
		expectUntouched(await h.run("one"));
		expect(h.entries()).toStrictEqual([{ base: null }]);
		expect(h.status).toBeUndefined();
		await writeConfig({ default: "English" });
		expectUntouched(await h.run("two"));
		expect(h.status).toBeUndefined();
	});
});

describe("a session that pinned no default", () => {
	it.each<[string, () => Promise<Harness>]>([
		["a new session", () => start()],
		["a session with conversation at its first run", async () => {
			const old = await start({ extension: false });
			await old.run("old");
			return reopen(old);
		}],
	])("AC-8 ignores a default configured later in %s", async (_name, open) => {
		const h = await open();
		const first = await h.run("one");
		expect(h.entries()).toEqual([{ base: null }]);
		await writeConfig({ default: "English" });
		const run = await h.run("two");
		expectSamePrefix(run, first);
		expect(afterPrompt(run, "two")).toEqual([]);
		expect(h.status).toBeUndefined();
		await h.command("/language");
		expect(h.lastNote?.message).toBe("Active language: none\nSession default: none\nDefault for new sessions: English");
		await h.command("/language reset");
		expect(h.lastNote).toEqual({ message: "No language switch is active.", type: "info" });
		await h.command("/language English");
		await h.run("three");
		await h.command("/language reset");
		expect(h.status).toBeUndefined();
		expect(afterPrompt(await h.run("four"), "four")).toEqual([RESET_TO_USER]);
		expect(afterPrompt(await h.run("five"), "five")).toEqual([]);
	});

	it("AC-8 ignores it on a branch that leaves before the pin and keeps conversation", async () => {
		const h = await start();
		const first = await h.run("one");
		await writeConfig({ default: "English" });
		await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
		await h.session.executeBash("true");
		const run = await h.run("other");
		expect(run.system).toBe(first.system);
		expect(languageMessages(run)).toEqual([]);
		expect(h.entries()).toEqual([{ base: null }]);
		expect(h.status).toBeUndefined();
	});
});

describe("sessions that are left alone", () => {
	it.each<[string, () => Promise<Harness>]>([
		// A child binds extensions with no mode, which Pi runs as print.
		["a child with a header parentSession", () => start({ sessionManager: newManager({ parentSession: "/parent.jsonl" }), mode: "print" })],
		["a child with a session-link entry", () => {
			const manager = newManager();
			manager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
			return start({ sessionManager: manager });
		}],
		["a child cloned from a parent's pinned entries", () => {
			const manager = newManager({ parentSession: "/parent.jsonl" });
			manager.appendCustomEntry("language", { base: "English" });
			manager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
			return start({ sessionManager: manager });
		}],
		["print mode", () => start({ mode: "print" })],
		["json mode", () => start({ mode: "json" })],
	])("AC-11 adds nothing to %s", async (_name, open) => {
		await writeConfig({ default: "English" });
		const h = await open();
		const entries = h.entries();
		expectUntouched(await h.run("one"));
		await h.command("/language Deutsch");
		expect(h.lastNote?.type).toBe("warning");
		await h.command("/language default Italiano");
		expect(h.lastNote?.type).toBe("warning");
		expectUntouched(await h.run("two"));
		expect(h.entries()).toEqual(entries);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.statuses.has("language")).toBe(false);
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
	});
});

describe("forks with no pin", () => {
	/** A session from before this extension, reopened with it and with a default configured. */
	const oldSession = async (...prompts: string[]) => {
		const old = await start({ extension: false });
		for (const prompt of prompts) await old.run(prompt);
		await writeConfig({ default: "English" });
		return reopen(old);
	};

	it("AC-2 puts the default in a section at the first run of a fork with no conversation", async () => {
		const h = await oldSession("old");
		h.statuses.clear();
		await h.runtime.fork(h.entryOf("old").id);
		expect(h.session.sessionManager.getHeader()?.parentSession).toBeTruthy();
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
		expect(h.entries()).toEqual([{ base: "English" }]);
		expectSamePrefix(await h.run("later"), first);
		expect(h.errors).toEqual([]);
	});

	it("AC-10 sends the default as a hidden message to a fork that keeps conversation", async () => {
		const h = await oldSession("old", "forked here");
		h.statuses.clear();
		await h.runtime.fork(h.entryOf("forked here").id);
		expect(h.session.sessionManager.getHeader()?.parentSession).toBeTruthy();
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "forked")).toEqual([switchMessage("English")]);
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
		expect(h.errors).toEqual([]);
	});

	it.each([["no conversation", ["old"]], ["conversation", ["old", "forked here"]]])("/language works in a fork with %s", async (_name, prompts) => {
		const h = await oldSession(...prompts);
		await h.runtime.fork(h.entryOf(prompts.at(-1)!).id);
		await h.command("/language Deutsch");
		expect(h.lastNote?.type).toBe("info");
		expect(h.status).toBe("Deutsch");
		expect(h.entries()).toEqual([{ active: "Deutsch" }]);
		expect(afterPrompt(await h.run("forked"), "forked")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-9 restores a switch in a clone taken before the session's next run", async () => {
		const h = await oldSession("old");
		await h.command("/language Deutsch");
		h.statuses.clear();
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		expect(h.entries()).toEqual([{ active: "Deutsch" }]);
		expect(h.status).toBe("Deutsch");
		const run = await h.run("cloned");
		expect(run.system).not.toContain("<language>");
		expect(afterPrompt(run, "cloned")).toEqual([switchMessage("Deutsch")]);
		expect(h.status).toBe("Deutsch");
	});
});

describe("invalid input", () => {
	const tooLong = "😀".repeat(41);

	it.each([
		["too long", tooLong], ["a control character", "Eng\u0007lish"], ["a line break", "Eng\nlish"],
		["a trailing line feed", "English\n"], ["a leading tab", "\tEnglish"], ["a trailing CRLF", "English\r\n"],
	])("AC-13 refuses a name with %s", async (_name, name) => {
		await writeConfig({ default: "English" });
		const h = await start();
		const before = await h.run("one");
		const entries = h.entries();
		await h.command(`/language ${name}`);
		expect(h.lastNote?.type).toBe("warning");
		await h.command(`/language default ${name}`);
		expect(h.lastNote?.type).toBe("warning");
		expect(h.status).toBe("English");
		expect(h.entries()).toEqual(entries);
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
		const after = await h.run("two");
		expectSamePrefix(after, before);
		expect(afterPrompt(after, "two")).toEqual([]);
	});

	it.each(["reset", "default", "RESET"])("refuses %s as a default: it is a subcommand", async (name) => {
		const h = await start();
		await h.command(`/language default ${name}`);
		expect(h.lastNote?.type).toBe("warning");
		await expect(access(configPath())).rejects.toThrow();
	});

	it("accepts a name of exactly 40 code points", async () => {
		const name = "😀".repeat(40);
		const h = await start();
		await h.command(`/language ${name}`);
		expect(h.status).toBe(name);
		expect(afterPrompt(await h.run("one"), "one")).toEqual([switchMessage(name)]);
	});

	it("trims names, in commands and in the configuration", async () => {
		await writeConfig({ default: "  中文  " });
		const h = await start();
		expect((await h.run("one")).system).toContain(section("中文"));
		await h.command("/language    Deutsch   ");
		expect(h.status).toBe("Deutsch");
	});

	it.each([["spaces", "/language default    English   "], ["a tab", "/language default\tEnglish"], ["a line break", "/language default\nEnglish"]])("takes %s between default and the name as a separator", async (_name, command) => {
		const h = await start();
		await h.command(command);
		expect(h.lastNote?.type).toBe("info");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
	});

	it("ignores whitespace around the subcommands", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language default   ");
		expect(h.lastNote).toEqual({ message: "Default for new sessions: English.", type: "info" });
		await h.command("/language Deutsch");
		await h.command("/language   reset\n");
		expect(h.status).toBe("English");
		await h.command("/language default   off  ");
		await expect(access(configPath())).rejects.toThrow();
	});

	it("treats the subcommands as case-insensitive and keeps off free as a language", async () => {
		const h = await start();
		await h.command("/language DEFAULT English");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
		await h.command("/language default OFF");
		await expect(access(configPath())).rejects.toThrow();
		await h.command("/language off");
		expect(h.status).toBe("off");
		await h.command("/language RESET");
		expect(h.status).toBeUndefined();
	});

	it.each([
		["invalid JSON", "not json"], ["an array", "[]"], ["null", "null"], ["no default", "{}"],
		["a number", { default: 5 }], ["an empty name", { default: "" }], ["a blank name", { default: "   " }],
		["a long name", { default: "x".repeat(41) }], ["a control character", { default: "Eng\u0001lish" }], ["a reserved name", { default: "reset" }],
		["a trailing line feed", { default: "English\n" }], ["a leading tab", { default: "\tEnglish" }], ["a trailing CRLF", { default: "English\r\n" }],
	])("AC-13 warns about language.json with %s and uses no default", async (_name, content) => {
		await writeConfig(content);
		const h = await start();
		expect(h.lastNote).toMatchObject({ message: expect.stringContaining(configPath()), type: "warning" });
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("one"));
		expect(h.entries()).toEqual([{ base: null }]);

		// Repairing the file must not touch a session that has had its first run.
		await writeConfig({ default: "English" });
		expectUntouched(await h.run("two"));
		expect(h.errors).toEqual([]);
	});

	it("AC-13 warns at the first run about a file that went bad after startup", async () => {
		const h = await start();
		await writeConfig("not json");
		expect(h.notes).toEqual([]);
		expectUntouched(await h.run("one"));
		expect(h.lastNote?.type).toBe("warning");
	});

	it("AC-13 still lets /language default replace a malformed file, without warning about it", async () => {
		await writeConfig("not json");
		const h = await start();
		h.notes.length = 0;
		await h.command("/language default English");
		expect(h.notes.map((note) => note.type)).toEqual(["info"]);
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "English" });
	});
});

describe("the footer status", () => {
	it("shows the pinned language after the first run", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		h.statuses.clear();
		await h.run("one");
		expect(h.status).toBe("English");
	});

	it("survives a stale context", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		h.control.failStatus = true;
		expect((await h.run("one")).system).toContain(section("English"));
		await h.command("/language Deutsch");
		expect(h.entries()).toEqual([{ base: "English" }, { active: "Deutsch" }]);
		expect(h.errors).toEqual([]);
	});
});

it("AC-16 is listed in the manifest with pika last and runs in npm test", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { pi: { extensions: string[] }; scripts: Record<string, string> };
	const { extensions } = manifest.pi;
	expect(extensions.indexOf("./extensions/language/index.ts")).toBe(extensions.indexOf("./extensions/molt/index.ts") + 1);
	expect(extensions.at(-1)).toBe("./extensions/pika/index.ts");
	expect(manifest.scripts["test:language"]).toBe("vitest run extensions/language");
	expect(manifest.scripts.test).toContain("npm run test:molt && npm run test:language &&");
});

describe("contract edges", () => {
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

	it("AC-2 pins and adds the section when a custom message starts the first run", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.session.sendCustomMessage({ customType: "other", content: "nudge", display: true }, { triggerTurn: true });
		await h.session.waitForIdle();
		expect(h.requests.at(-1)!.system).toContain(section("English"));
		expect(h.entries()).toEqual([{ base: "English" }]);
		expect(languageMessages(h.requests.at(-1)!)).toEqual([]);
	});

	it("AC-2 does not count session bookkeeping as conversation", async () => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		manager.appendSessionInfo("named");
		manager.appendCustomEntry("other", {});
		manager.appendLabelChange(manager.getLeafId()!, "label");
		const h = await start({ sessionManager: manager });
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
	});

	it("AC-1 and AC-12 write nothing for a report", async () => {
		const h = await start();
		await h.command("/language");
		await h.command("/language default");
		expect(h.entries()).toEqual([]);
		await expect(access(configPath())).rejects.toThrow();
		expectUntouched(await h.run("one"));
	});

	it("AC-3 adds no message when the default was chosen and reset before the first run", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language English");
		await h.command("/language reset");
		const first = await h.run("one");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
	});

	it("AC-6 returns to the new default when the chosen default was reset and the default then changed", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language English");
		await h.command("/language reset");
		expect(h.lastNote?.message).toContain("reset to English");
		await writeConfig({ default: "Italiano" });
		const first = await h.run("one");
		expect(first.system).toContain(section("Italiano"));
		expect(languageMessages(first)).toEqual([]);
	});

	it("AC-4 keeps the prefix byte-identical across a reload and a resume", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.run("one");
		await h.command("/language Deutsch");
		const switched = await h.run("two");
		await h.session.reload();
		const reloaded = await h.run("three");
		expectSamePrefix(reloaded, switched);
		const resumed = await reopen(h);
		expectSamePrefix(await resumed.run("four"), reloaded);
	});

	it("AC-4 and AC-5 apply a switch made during a run to the next run", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.run("one");
		duringNextRequest(h, "/language Deutsch");
		const during = await h.run("two");
		expect(afterPrompt(during, "two")).toEqual([]);
		expect(h.status).toBe("Deutsch");
		const next = await h.run("three");
		expectSamePrefix(next, during);
		expect(afterPrompt(next, "three")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-5 adds one message to a run of several turns", async () => {
		const h = await start();
		await h.command("/language Deutsch");
		script(h, (call) => call === 1
			? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("ok"));
		await h.session.prompt("one");
		expect(h.requests.map(languageMessages)).toEqual([[switchMessage("Deutsch")], [switchMessage("Deutsch")]]);
		expect(h.hiddenMessages().length).toBe(1);
	});

	it("AC-6 sends the reset once when it is used during a run that carries the switch", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		duringNextRequest(h, "/language reset");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([switchMessage("Deutsch")]);
		expect(afterPrompt(await h.run("three"), "three")).toEqual([resetMessage("English")]);
		expect(afterPrompt(await h.run("four"), "four")).toEqual([]);
	});

	// The extension registered after Language runs its handler between Language's return and the hidden message reaching the branch.
	it("AC-6 keeps a reset used while a run is starting", async () => {
		await writeConfig({ default: "English" });
		let whileStarting: (() => Promise<void>) | undefined;
		const h = await start({ register: (pi) => { pi.on("before_agent_start", async () => { await whileStarting?.(); }); } });
		await h.command("/language Deutsch");
		await h.run("one");
		whileStarting = async () => {
			whileStarting = undefined;
			await h.command("/language reset");
		};
		await h.run("two");
		expect(h.status).toBe("English");
		await h.run("three");
		const sent = languageMessages(await h.run("four"));
		expect(sent.filter((text) => text === resetMessage("English")).length).toBe(1);
		expect(sent.at(-1)).toBe(resetMessage("English"));
	});

	it("AC-6 keeps a pending reset across a reload", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		await h.command("/language reset");
		await h.session.reload();
		expect(h.status).toBe("English");
		expect(afterPrompt(await h.run("two"), "two")).toEqual([resetMessage("English")]);
		await h.session.reload();
		expect(afterPrompt(await h.run("three"), "three")).toEqual([]);
	});

	it("AC-7 accepts removing a default that does not exist", async () => {
		const h = await start();
		await h.command("/language default off");
		expect(h.lastNote?.type).toBe("info");
		expect(h.errors).toEqual([]);
		expect(await readdir(agentDir())).toEqual([]);
	});

	it("AC-7 leaves one complete default when saves race", async () => {
		const [a, b] = [await start(), await start()];
		const names = Array.from({ length: 12 }, (_value, index) => `Language ${index}`);
		await Promise.all(names.map((name, index) => (index % 2 ? a : b).command(`/language default ${name}`)));
		expect(names).toContain((JSON.parse(await readFile(configPath(), "utf8")) as { default: string }).default);
		expect(await readdir(agentDir())).toEqual(["language.json"]);
	});

	it("AC-7 leaves no temporary file behind when the rename fails", async () => {
		const h = await start();
		await mkdir(configPath());
		await h.command("/language default English");
		expect(await readdir(agentDir())).toEqual(["language.json"]);
	});

	describe.each([["a pinned default", "English"], ["no default", undefined]])("AC-8 with %s", (_name, base) => {
		it("keeps the prompt when /tree returns to the first user message", async () => {
			if (base) await writeConfig({ default: base });
			const h = await start();
			const first = await h.run("one");
			await h.command("/language default Italiano");
			await h.session.navigateTree(h.entryOf("one").id);
			expect((await h.run("again")).system).toBe(first.system);
		});

		it("keeps the prompt when /tree returns to before the first run", async () => {
			if (base) await writeConfig({ default: base });
			const h = await start();
			const first = await h.run("one");
			await h.command("/language default Italiano");
			await h.session.navigateTree(h.session.sessionManager.getBranch()[0]!.id);
			expect((await h.run("again")).system).toBe(first.system);
		});
	});

	it("AC-9 shows no language for a resumed session that pinned none, whatever the default", async () => {
		const first = await start();
		const before = await first.run("one");
		await writeConfig({ default: "English" });
		const resumed = await reopen(first);
		expect(resumed.status).toBeUndefined();
		const run = await resumed.run("two");
		expectSamePrefix(run, before);
		expect(afterPrompt(run, "two")).toEqual([]);
	});

	it("AC-10 sends the default when a reset before such a session's first run returns to it", async () => {
		const old = await start({ extension: false });
		await old.run("old");
		await writeConfig({ default: "English" });
		const h = await reopen(old);
		await h.command("/language Deutsch");
		await h.command("/language reset");
		expect(h.status).toBe("English");
		const first = await h.run("one");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "one").join("\n")).toContain("English");
	});

	it("AC-11 does not read the configuration in a child session", async () => {
		await writeConfig("not json");
		const h = await start({ sessionManager: newManager({ parentSession: "/parent.jsonl" }), mode: "print" });
		await h.run("one");
		expect(h.notes).toEqual([]);
	});

	it("AC-11 adds nothing to a switched session resumed in print mode", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.command("/language Deutsch");
		await h.run("one");
		const [entries, messages] = [h.entries(), h.hiddenMessages().length];
		const printed = await reopen(h, "print");
		expect(afterPrompt(await printed.run("two"), "two")).toEqual([]);
		expect(printed.entries()).toEqual(entries);
		expect(printed.hiddenMessages().length).toBe(messages);
		expect(printed.statuses.has("language")).toBe(false);
	});

	it.each([
		["a delete", "Eng\u007flish"], ["a C1 control", "Eng\u0085lish"], ["a trailing C1 control", "English\u0085"],
		["a tab", "Eng\tlish"], ["a NUL", "Eng\u0000lish"], ["41 characters", "x".repeat(41)],
		["a trailing line feed", "English\n"], ["a leading tab", "\tEnglish"], ["a trailing CRLF", "English\r\n"],
	])("AC-13 refuses %s before the first run, in commands and in the configuration", async (_name, name) => {
		const h = await start();
		await h.command(`/language ${name}`);
		expect(h.lastNote?.type).toBe("warning");
		await h.command(`/language default ${name}`);
		expect(h.lastNote?.type).toBe("warning");
		expect(h.entries()).toEqual([]);
		await expect(access(configPath())).rejects.toThrow();

		await writeConfig({ default: name });
		await h.command("/language");
		expect(h.notes.at(-2)?.type).toBe("warning");
		expect(h.lastNote?.message).toContain("Default for new sessions: none");
		expectUntouched(await h.run("one"));
	});

	it("accepts 40 characters surrounded by spaces, in the configuration too", async () => {
		const name = "x".repeat(40);
		await writeConfig({ default: `  ${name}  ` });
		const h = await start();
		expect(h.status).toBe(name);
		await h.command(`/language    ${name}y`);
		expect(h.lastNote?.type).toBe("warning");
		expect((await h.run("one")).system).toContain(section(name));
	});

	it("does not read the configuration on a pinned session's runs", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		const first = await h.run("one");
		await writeConfig("not json");
		h.notes.length = 0;
		expectSamePrefix(await h.run("two"), first);
		expect(h.notes).toEqual([]);
	});
});

describe("sessions that name a parent", () => {
	/** A session from before this extension, reopened with it in `mode`. A null `config` leaves the default unset. */
	const oldSession = async (prompts: string[], mode?: ExtensionContext["mode"], config: unknown = { default: "English" }) => {
		const old = await start({ extension: false });
		const requests: Captured[] = [];
		for (const prompt of prompts) requests.push(await old.run(prompt));
		if (config !== null) await writeConfig(config);
		return { h: await reopen(old, mode), before: requests[0]! };
	};
	const forkAt = (h: Harness, prompt: string) => h.runtime.fork(h.entryOf(prompt).id);
	/** An unsaved session with conversation from before this extension. */
	const unsavedSession = async () => {
		const manager = SessionManager.inMemory(cwd());
		for (const text of ["old", "kept"]) {
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("ok"));
		}
		await writeConfig({ default: "English" });
		return start({ sessionManager: manager });
	};

	it.each<[string, () => SessionManager]>([
		["a child with no parent in its header", () => newManager()],
		["a child with a parent in its header", () => newManager({ parentSession: "/parent.jsonl" })],
		["a child holding a copy of its parent's pin", () => {
			const manager = newManager({ parentSession: "/parent.jsonl" });
			manager.appendCustomEntry("language", { base: "English" });
			return manager;
		}],
	])("AC-11 adds nothing to %s bound as Subagents and Herder bind it", async (_name, manager) => {
		await writeConfig({ default: "English" });
		const modes: string[] = [];
		const h = await start({ sessionManager: manager(), bindAsChild: true, register: (pi) => { pi.on("session_start", (_event, ctx) => { modes.push(ctx.mode); }); } });
		expect(modes).toEqual(["print"]);
		const entries = h.entries();
		expectUntouched(await h.run("one"));
		await h.command("/language Deutsch");
		expectUntouched(await h.run("two"));
		expect(h.entries()).toEqual(entries);
		expect(h.hiddenMessages()).toEqual([]);
		expect(h.statuses.has("language")).toBe(false);
	});

	describe.each(["print", "json"] as const)("in %s mode", (mode) => {
		it.each([["no conversation", ["old"]], ["conversation", ["old", "kept"]]])("AC-11 adds nothing to a fork with %s", async (_name, prompts) => {
			const { h } = await oldSession(prompts, mode);
			await forkAt(h, prompts.at(-1)!);
			expect(h.session.sessionManager.getHeader()?.parentSession).toBeTruthy();
			expectUntouched(await h.run("forked"));
			expect(h.entries()).toEqual([]);
			expect(h.statuses.has("language")).toBe(false);
		});
	});

	it("AC-11 leaves alone a fork that copies a session link", async () => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		manager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
		const h = await start({ sessionManager: manager });
		await h.run("one");
		await h.run("two");
		await forkAt(h, "two");
		expect(h.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK)).toBe(true);
		expectUntouched(await h.run("forked"));
		expect(h.entries()).toEqual([]);
		expect(h.statuses.has("language")).toBe(false);
	});

	it("AC-11 leaves alone a session whose link is off the current branch", async () => {
		await writeConfig({ default: "English" });
		const manager = newManager();
		const root = manager.appendCustomEntry("other", {});
		manager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
		const h = await start({ sessionManager: manager });
		await h.session.navigateTree(root);
		expectUntouched(await h.run("one"));
		expect(h.entries()).toEqual([]);
		expect(h.statuses.has("language")).toBe(false);
	});

	it.each(["tui", "rpc"] as const)("AC-2 treats a session with only a parent in its header as top-level in %s mode", async (mode) => {
		await writeConfig({ default: "English" });
		const h = await start({ sessionManager: newManager({ parentSession: "/parent.jsonl" }), mode });
		expect(h.status).toBe("English");
		expect((await h.run("one")).system).toContain(section("English"));
		expect(h.entries()).toEqual([{ base: "English" }]);
	});

	it("AC-2 treats a new session that names a parent as top-level", async () => {
		await writeConfig({ default: "English" });
		const h = await start();
		await h.runtime.newSession({ parentSession: "/parent.jsonl" });
		expect(h.session.sessionManager.getHeader()?.parentSession).toBe("/parent.jsonl");
		expect((await h.run("one")).system).toContain(section("English"));
		expect(h.entries()).toEqual([{ base: "English" }]);
	});

	it("AC-2 puts the default in a section at the first run of an empty fork in tui mode", async () => {
		const { h } = await oldSession(["old"], "tui");
		h.statuses.clear();
		await forkAt(h, "old");
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it.each(["tui", "rpc"] as const)("AC-10 keeps a fork's prefix and sends the default as a hidden message in %s mode", async (mode) => {
		const { h, before } = await oldSession(["old", "kept"], mode);
		h.statuses.clear();
		await forkAt(h, "kept");
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expectSamePrefix(first, before);
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "forked")).toEqual([switchMessage("English")]);
		const second = await h.run("later");
		expectSamePrefix(second, first);
		expect(afterPrompt(second, "later")).toEqual([switchMessage("English")]);
		expect(h.errors).toEqual([]);
	});

	it("AC-2 puts the default in a section at the first run of an unsaved fork", async () => {
		const h = await unsavedSession();
		await forkAt(h, "old");
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expect(first.system).toContain(section("English"));
		expect(languageMessages(first)).toEqual([]);
		expect(h.entries()).toEqual([{ base: "English" }]);
	});

	it("AC-10 sends the default as a hidden message to an unsaved fork that keeps conversation", async () => {
		const h = await unsavedSession();
		await forkAt(h, "kept");
		expect(h.status).toBe("English");
		const first = await h.run("forked");
		expect(first.system).not.toContain("<language>");
		expect(afterPrompt(first, "forked")).toEqual([switchMessage("English")]);
		expect(h.entries()).toEqual([{ base: null, fallback: "English" }]);
	});

	it("AC-2 keeps the section when /language switches before an empty fork's first run", async () => {
		const { h } = await oldSession(["old"]);
		await forkAt(h, "old");
		await h.command("/language Deutsch");
		const first = await h.run("forked");
		expect(first.system).toContain(section("English"));
		expect(afterPrompt(first, "forked")).toEqual([switchMessage("Deutsch")]);
		expect(h.entries()).toEqual([{ active: "Deutsch" }, { base: "English" }]);
	});

	it.each([["no conversation", ["old"]], ["conversation", ["old", "kept"]]])("AC-1 adds no language to a fork with %s when no default is configured", async (_name, prompts) => {
		const { h } = await oldSession(prompts, undefined, null);
		await forkAt(h, prompts.at(-1)!);
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("forked"));
		expect(h.entries()).toEqual([{ base: null }]);
	});

	it("AC-13 warns about a malformed configuration in a fork and uses no default", async () => {
		const { h } = await oldSession(["old"], undefined, "not json");
		h.notes.length = 0;
		await forkAt(h, "old");
		expect(h.lastNote).toMatchObject({ message: expect.stringContaining(configPath()), type: "warning" });
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("forked"));
		expect(h.entries()).toEqual([{ base: null }]);
	});

	it("AC-9 restores a fork's section across a reload and a resume, whatever the default becomes", async () => {
		const { h } = await oldSession(["old"]);
		await forkAt(h, "old");
		const first = await h.run("forked");
		await writeConfig({ default: "Italiano" });
		await h.session.reload();
		expect(h.status).toBe("English");
		const reloaded = await h.run("reloaded");
		expectSamePrefix(reloaded, first);
		const resumed = await reopen(h);
		expect(resumed.status).toBe("English");
		expectSamePrefix(await resumed.run("resumed"), reloaded);
	});

	it("AC-9 restores a fork's hidden default across a reload and a resume, whatever the default becomes", async () => {
		const { h } = await oldSession(["old", "kept"]);
		await forkAt(h, "kept");
		await h.session.reload();
		expect(h.status).toBe("English");
		await h.run("forked");
		await writeConfig({ default: "Italiano" });
		const resumed = await reopen(h);
		expect(resumed.status).toBe("English");
		const run = await resumed.run("later");
		expect(run.system).not.toContain("<language>");
		expect(afterPrompt(run, "later")).toEqual([switchMessage("English")]);
	});

	it("AC-9 restores a clone's switch after a resume", async () => {
		const { h } = await oldSession(["old"]);
		await h.command("/language Deutsch");
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		const resumed = await reopen(h);
		expect(resumed.status).toBe("Deutsch");
		expect(afterPrompt(await resumed.run("later"), "later")).toEqual([switchMessage("Deutsch")]);
	});

	it.each<[string, unknown, string | undefined, string]>([
		["with a default", { default: "English" }, "English", resetMessage("English")],
		["with no default", null, undefined, RESET_TO_USER],
	])("AC-9 restores a reset in a clone taken before the next run, %s", async (_name, config, status, sent) => {
		const { h } = await oldSession(["old"], undefined, config);
		await h.command("/language Deutsch");
		await h.command("/language reset");
		h.statuses.clear();
		await h.runtime.fork(h.session.sessionManager.getLeafId()!, { position: "at" });
		expect(h.status).toBe(status);
		expect(afterPrompt(await h.run("cloned"), "cloned")).toEqual([sent]);
	});

	it("AC-9 follows /tree in a fork with no pin", async () => {
		const { h } = await oldSession(["old", "kept"]);
		await forkAt(h, "kept");
		const before = h.session.sessionManager.getLeafId()!;
		await h.command("/language Deutsch");
		const switched = h.session.sessionManager.getLeafId()!;
		await h.session.navigateTree(before);
		expect(h.status).toBe("English");
		await h.session.navigateTree(switched);
		expect(h.status).toBe("Deutsch");
		expect(afterPrompt(await h.run("forked"), "forked")).toEqual([switchMessage("Deutsch")]);
	});

	it("AC-9 restores a fork of a fork with no pin", async () => {
		const { h } = await oldSession(["old", "kept", "more"]);
		await forkAt(h, "more");
		await forkAt(h, "kept");
		expect(h.status).toBe("English");
		const run = await h.run("forked");
		expect(run.system).not.toContain("<language>");
		expect(afterPrompt(run, "forked")).toEqual([switchMessage("English")]);
	});
});

describe("control characters in a name", () => {
	const controls = [...Array.from({ length: 0x20 }, (_value, code) => code), ...Array.from({ length: 0x21 }, (_value, index) => 0x7f + index)].map((code) => String.fromCodePoint(code));
	const placements = (control: string) => [`${control}English`, `Eng${control}lish`, `English${control}`];

	it("AC-13 refuses all 65 control characters at either end of a name and inside it, in commands", async () => {
		expect(controls.length).toBe(65);
		await writeConfig({ default: "Italiano" });
		const h = await start();
		const first = await h.run("one");
		const entries = h.entries();
		for (const name of controls.flatMap(placements)) {
			h.notes.length = 0;
			await h.command(`/language ${name}`);
			await h.command(`/language default ${name}`);
			expect(h.notes.map((note) => note.type), JSON.stringify(name)).toEqual(["warning", "warning"]);
		}
		expect(h.entries()).toEqual(entries);
		expect(h.status).toBe("Italiano");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "Italiano" });
		const later = await h.run("two");
		expectSamePrefix(later, first);
		expect(afterPrompt(later, "two")).toEqual([]);
	});

	it("AC-13 refuses all 65 control characters at either end of a name and inside it, in the configuration", async () => {
		const h = await start();
		for (const name of controls.flatMap(placements)) {
			await writeConfig({ default: name });
			h.notes.length = 0;
			await h.command("/language");
			expect(h.notes[0]?.type, JSON.stringify(name)).toBe("warning");
			expect(h.lastNote?.message, JSON.stringify(name)).toContain("Default for new sessions: none");
		}
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("one"));
		expect(h.entries()).toEqual([{ base: null }]);
	});

	it.each([
		["spaces around a line feed", " English\n "], ["a line feed inside the spaces", "  \n  English"], ["only a line feed", "\n"], ["only tabs", "\t\t"],
		["a reserved name with a line feed", "reset\n"], ["40 characters with a line feed", `${"x".repeat(40)}\n`],
	])("AC-13 warns about language.json with %s and uses no default", async (_name, name) => {
		await writeConfig({ default: name });
		const h = await start();
		expect(h.lastNote).toMatchObject({ message: expect.stringContaining(configPath()), type: "warning" });
		expect(h.status).toBeUndefined();
		expectUntouched(await h.run("one"));
		expect(h.entries()).toEqual([{ base: null }]);
	});

	it.each([
		["/language    \tEnglish"], ["/language English\n   "], ["/language English\r\n   "], ["/language    English\t   "],
		["/language   default   \tEnglish"], ["/language default English\n   "], ["/language default \t English"], ["/language default\tEnglish\t"],
		[`/language ${"x".repeat(40)}\n`], [`/language default ${"x".repeat(40)}\n`], ["/language default reset\n"],
	])("AC-13 finds a control character behind spaces in %j", async (command) => {
		await writeConfig({ default: "Italiano" });
		const h = await start();
		h.notes.length = 0;
		await h.command(command);
		expect(h.notes.map((note) => note.type)).toEqual(["warning"]);
		expect(h.entries()).toEqual([]);
		expect(h.status).toBe("Italiano");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ default: "Italiano" });
	});
});

it("leaves the system prompt to Pi and imports no other extension", async () => {
	const source = await readFile(extensionPath, "utf8");
	expect(source).not.toMatch(/forceSystemPrompt|\bsystemPrompt\s*:/);
	expect([...source.matchAll(/from "([^"]+)"/g)].map(([, from]) => from).filter((from) => from!.startsWith("."))).toEqual([]);
});
