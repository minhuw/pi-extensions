// The boom delegation coach in real Pi sessions on the faux provider, asserting on what the provider receives.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { getCurrentSystemPrompt, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { COACH, contextText, streakText } from "../coach.ts";

// Load by path, as Pi does.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const ON_MESSAGE = "Boom mode 💥 is on: the user wants maximum development speed and explicitly opts in to background agents and, when available, SubagentWorkflow. "
	+ "Work as an orchestrator: split each task into independent pieces and launch them together in one message, recon for any lookup beyond one known file and worker for implementation, tests, and verification. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Run agents in the background while you have other work, and keep your own context for planning, integration, and review. "
	+ "Use direct tools only for a known target or a short sequential edit. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_MESSAGE = "Boom mode is off. Ignore earlier boom mode instructions: the user no longer opts in to background agents or SubagentWorkflow, and the standard subagent guidance applies.";
const CONTEXT_WINDOW = 20_000;

type Message = { role: string; content: unknown };
interface Captured { system: string; conversation: Message[] }
type Step = string | AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return { system: getCurrentSystemPrompt(messages), conversation: copy.filter((message) => message.role !== "system") };
};
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
const isCoach = (text: string) => text.startsWith("Boom mode: ");
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
const lookups = (count: number) => Array.from({ length: count }, (_, index) => ["read", "grep", "find", "ls", "ffgrep", "fffind", "bash"][index % 7]!);

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-boom-coach-"));
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

/** Stub delegation tools, and `script`, a tool that makes nested lookups as a codemode script does. */
function stubTools(pi: ExtensionAPI): void {
	for (const name of ["Agent", "SubagentWorkflow", "herder_step", "herder_workflow"]) {
		pi.registerTool({
			name, label: name, description: `Stub ${name}`, parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "delegated" }], details: undefined }; },
		});
	}
	pi.registerTool({
		name: "script", label: "Script", description: "Makes nested lookups", parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			for (let index = 0; index < COACH.lookupStreak + 1; index++) await ctx.executeTool("read", { path: "notes.txt" });
			return { content: [{ type: "text", text: "looked" }], details: undefined };
		},
	});
}

async function start() {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "boom-coach-test-api", provider: "boom-coach-test", models: [{ id: "test", contextWindow: CONTEXT_WINDOW }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const requests: Captured[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); stubTools(pi); }],
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
		coachEntries: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "boom-coach" ? [entry] : []),
		boomMessages: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "boom" ? [entry.content] : []),
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}

describe("the lookup streak", () => {
	it("puts a hidden coach message into the request after five lookups in a row", async () => {
		const h = await start();
		await h.command("/boom on");
		const [first, second, ...rest] = await h.run("explore", calls(...lookups(COACH.lookupStreak)), "done");
		expect(rest).toEqual([]);
		expect(coachTexts(first)).toEqual([]);
		expect(coachTexts(second)).toEqual([streakText(5)]);
		expect(second.conversation.map(textOf).at(-1)).toBe(streakText(5));
		expect(second.system).toBe(first.system);
		expect(h.coachEntries().map(({ display }) => display)).toEqual([false]);
		expect(h.errors).toEqual([]);
	});

	it("counts across turns and runs, and starts again after it steers", async () => {
		const h = await start();
		await h.command("/boom on");
		const one = await h.run("one", calls("read", "grep"), calls("bash"), "done");
		expect(one.flatMap(coachTexts)).toEqual([]);
		const two = await h.run("two", calls("ls", "fffind"), calls(...lookups(4)), calls("read"), "done");
		expect(two.map((request) => coachTexts(request).length)).toEqual([0, 1, 1, 2]);
		expect(h.coachEntries()).toHaveLength(2);
	});

	it.each(["Agent", "SubagentWorkflow", "herder_step", "herder_workflow"])("is reset by %s", async (tool) => {
		const h = await start();
		await h.command("/boom on");
		const requests = await h.run("explore", calls(...lookups(4)), calls(tool), calls(...lookups(4)), calls("read"), "done");
		expect(requests.map((request) => coachTexts(request).length)).toEqual([0, 0, 0, 0, 1]);
	});

	it("neither counts nor resets on edits and other tools", async () => {
		const h = await start();
		await h.command("/boom on");
		const requests = await h.run("explore", calls("read", "read", "edit", "write", "unknown_tool", "read", "read"), calls("edit", "write", "edit", "write", "edit"), calls("read"), "done");
		expect(requests.map((request) => coachTexts(request).length)).toEqual([0, 0, 0, 1]);
	});

	it("ignores lookups that another tool makes", async () => {
		const h = await start();
		await h.command("/boom on");
		const requests = await h.run("explore", calls("script", "script"), "done");
		expect(requests.flatMap(coachTexts)).toEqual([]);
	});

	it("sends nothing while boom mode is off, in the section or switched", async () => {
		const h = await start();
		expect((await h.run("one", calls(...lookups(6)), "done")).flatMap(coachTexts)).toEqual([]);
		await h.command("/boom on");
		await h.run("two", "ok");
		await h.command("/boom off");
		expect((await h.run("three", calls(...lookups(6)), "done")).flatMap(coachTexts)).toEqual([]);
		expect(h.coachEntries()).toEqual([]);
	});

	it("is reset by /tree", async () => {
		const h = await start();
		await h.command("/boom on");
		await h.run("zero", "ok");
		const answer = h.session.sessionManager.getLeafId()!;
		await h.run("one", calls(...lookups(4)), "done");
		await h.session.navigateTree(answer);
		expect((await h.run("two", calls("read"), "done")).flatMap(coachTexts)).toEqual([]);
		expect(h.coachEntries()).toEqual([]);
	});
});

describe("the context nudge", () => {
	/** A prompt that alone fills `percent` of the context window, at the faux provider's four characters a token. */
	const filler = (percent: number) => "x".repeat(Math.ceil(CONTEXT_WINDOW * 4 * percent / 100));
	/** The coach messages each request of a run carries after its prompt. */
	const nudges = (requests: Captured[], prompt: string) => requests.map((request) => afterPrompt(request, prompt).filter(isCoach));

	it("steers once at the threshold and again only after a compaction", async () => {
		const h = await start();
		await h.command("/boom on");
		expect(nudges(await h.run("small", calls("edit"), "done"), "small")).toEqual([[], []]);
		expect(h.session.getContextUsage()!.percent!).toBeLessThan(COACH.contextShare);

		const big = filler(COACH.contextShare);
		const full = nudges(await h.run(big, calls("edit"), "done"), big);
		expect(full).toEqual([[], [expect.stringMatching(/^Boom mode: your context is \d+% full\./)]]);
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
		await h.command("/boom on");
		expect(await h.run(filler(COACH.contextShare + 5), "done")).toHaveLength(1);
		expect(h.coachEntries()).toEqual([]);
		expect(nudges(await h.run("next", calls("edit"), "done"), "next").map((texts) => texts.length)).toEqual([0, 1]);
	});

	it("sends nothing while boom mode is off", async () => {
		const h = await start();
		expect((await h.run(filler(COACH.contextShare + 5), calls("edit"), "done")).flatMap(coachTexts)).toEqual([]);
		expect(h.coachEntries()).toEqual([]);
	});
});

it("leaves boom's own messages unchanged", async () => {
	const h = await start();
	await h.run("one", "ok");
	await h.command("/boom on");
	const on = await h.run("two", calls(...lookups(5)), "done");
	expect(afterPrompt(on[0], "two")).toEqual([ON_MESSAGE]);
	expect(coachTexts(on[1])).toEqual([streakText(5)]);
	expect(afterPrompt((await h.run("three", "ok"))[0], "three")).toEqual([ON_MESSAGE]);
	await h.command("/boom off");
	expect(afterPrompt((await h.run("four", "ok"))[0], "four")).toEqual([OFF_MESSAGE]);
	expect(afterPrompt((await h.run("five", "ok"))[0], "five")).toEqual([]);
	expect(h.boomMessages()).toEqual([ON_MESSAGE, ON_MESSAGE, OFF_MESSAGE]);
	expect(COACH).toEqual({ lookupStreak: 5, contextShare: 50 });
});
