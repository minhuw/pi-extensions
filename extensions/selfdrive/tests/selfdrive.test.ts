// Self-driving mode in real Pi sessions on the faux provider, with real session files, asserting on what the provider receives.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { InMemoryCredentialStore, type ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { grants } from "../grants.ts";
import selfdriveExtension, { runtime as selfdriveRuntime, timing } from "../index.ts";

const RULES_START = "Self-driving mode 🚗 is on. Your user is away";
const KICKOFF = "Start now: delegate a survey of the candidates, record them with selfdrive_task, and launch the first work.";
const BACK = "[selfdrive] Your user is back, so self-driving mode is off";
const CONTINUE = "[selfdrive] Continue self-driving";

type Message = { role: string; content: unknown };
interface Request { texts: string[] }
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
const calls = (...blocks: ToolCall[]) => fauxAssistantMessage(blocks, { stopReason: "toolUse" });
const next = (action: string, extra: Record<string, unknown> = {}) => fauxToolCall("selfdrive_next", { action, reason: "test", ...extra });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await sleep(5);
	}
}

const savedTiming = { ...timing };
const savedKeepAwake = selfdriveRuntime.keepAwake;
let root: string;
let previousAgentDir: string | undefined;
let awake: { started: number; killed: number };
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");

beforeAll(() => { Object.assign(timing, { continueMs: 30, busyRetryMs: 20, startMs: 3_000, statusMs: 60_000, minWaitSeconds: 1, maxWaitSeconds: 60 }); });
afterAll(() => { Object.assign(timing, savedTiming); selfdriveRuntime.keepAwake = savedKeepAwake; });

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-selfdrive-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
	awake = { started: 0, killed: 0 };
	selfdriveRuntime.keepAwake = () => { awake.started++; return { kill: () => { awake.killed++; } }; };
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

/** A UI context that records notifications, statuses, and confirms, whose answers the test chooses. A plain object: Pi spreads it. */
function recordingUi() {
	const notes: { message: string; type?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const confirms: { title: string; body: string }[] = [];
	const control = { confirm: (_title: string): Promise<boolean> => Promise.resolve(true) };
	const noop = () => {};
	const context = {
		select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		confirm: (title: string, body: string) => { confirms.push({ title, body }); return control.confirm(title); },
		onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
		setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
		addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop,
		notify: (message: string, type?: string) => { notes.push({ message, type }); },
		setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
	} as unknown as ExtensionUIContext;
	return { notes, statuses, confirms, control, context };
}

/** A tool that does nothing, so a run counts as work. */
function registerProbe(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe", label: "Probe", description: "Test tool.", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "probed" }], details: {} }; },
	});
}

async function start(options: { mode?: ExtensionContext["mode"]; bindAsChild?: boolean; script?: FauxResponseStep[]; register?: (pi: ExtensionAPI) => void } = {}) {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "selfdrive-test-api", provider: "selfdrive-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const ui = recordingUi();
	const requests: Request[] = [];
	let api: ExtensionAPI | undefined;
	const script = [...(options.script ?? [])];
	const respond: FauxResponseFactory = (context, streamOptions, state, model) => {
		const messages = context.messages as unknown as Message[];
		requests.push({ texts: messages.filter((message) => message.role !== "system").map(textOf) });
		const step = script.shift();
		return typeof step === "function" ? step(context, streamOptions, state, model) : step ?? fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); api = pi; registerProbe(pi); options.register?.(pi); }, selfdriveExtension],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: cwd(), agentDir: agentDir(), sessionManager: SessionManager.create(cwd(), sessionDir()) });
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : {
		mode: options.mode ?? "rpc",
		uiContext: ui.context,
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
	let disposed = false;
	const branch = () => runtime.session.sessionManager.getBranch();
	const harness = {
		runtime, requests, script, ...ui,
		get session() { return runtime.session; },
		get status() { return ui.statuses.get("selfdrive"); },
		activeTools: () => api!.getActiveTools(),
		get lastNote() { return ui.notes.at(-1); },
		get grant() { return grants().find((grant) => grant.id === runtime.session.sessionManager.getSessionId()); },
		command: (text: string) => runtime.session.prompt(text),
		/** Wait until the provider saw `count` requests and the session settled. */
		async settle(count: number) {
			await until(() => requests.length >= count);
			await runtime.session.waitForIdle();
			await sleep(10);
			expect(requests.length).toBe(count);
		},
		entries: () => branch().flatMap((entry) => entry.type === "custom" && entry.customType === "selfdrive" ? [entry.data as Record<string, unknown>] : []),
		tasks: () => branch().flatMap((entry) => entry.type === "custom" && entry.customType === "selfdrive-task" ? [entry.data as Record<string, unknown>] : []),
		messages: () => branch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "selfdrive" ? [{ content: entry.content as string, details: entry.details as Record<string, unknown> }] : []),
		dispose: async () => { if (!disposed) { disposed = true; await runtime.dispose(); } },
	};
	started.push(harness);
	return harness;
}

describe("activation", () => {
	it("does nothing when the confirm is declined", async () => {
		const h = await start();
		h.control.confirm = () => Promise.resolve(false);
		await h.command("/selfdrive fix the docs");
		expect(h.confirms).toHaveLength(1);
		expect(h.confirms[0]!.body).toContain("Focus: fix the docs");
		expect(h.entries()).toEqual([]);
		expect(h.grant).toBeUndefined();
		expect(h.status).toBeUndefined();
		expect(awake.started).toBe(0);
		await h.command("hello");
		await h.settle(1);
		expect(h.activeTools()).not.toContain("selfdrive_task");
		expect(h.requests[0]!.texts.some((text) => text.startsWith(RULES_START))).toBe(false);
	});

	it("starts with the kickoff, the grant, the status, the tools, and keep-awake; off ends it with the report", async () => {
		execFileSync("git", ["init", "-q"], { cwd: cwd() });
		const h = await start({ script: [calls(next("wait", { seconds: 60 })), fauxAssistantMessage("waiting")] });
		await h.command("/selfdrive on fix the docs");
		await h.settle(2);
		expect(h.confirms[0]!.title).toContain("self-driving");
		expect(h.confirms[0]!.body).toContain("Your next message, or Esc, turns it off and shows a report.");
		expect(h.entries()[0]).toMatchObject({ active: true, focus: "fix the docs" });
		const kickoff = h.requests[0]!.texts.at(-1)!;
		expect(kickoff.startsWith(RULES_START)).toBe(true);
		expect(kickoff).toContain("the focus your user gave: fix the docs;");
		expect(kickoff.endsWith(KICKOFF)).toBe(true);
		expect(h.messages()[0]!.details).toEqual({ kind: "start", focus: "fix the docs" });
		expect(h.activeTools()).toEqual(expect.arrayContaining(["selfdrive_task", "selfdrive_next"]));
		const top = realpathSync(cwd());
		expect(h.grant).toMatchObject({ toplevel: top, commonDir: join(top, ".git") });
		expect(h.grant!.text).toContain("Focus: fix the docs.");
		expect(h.status).toBe("🚗 selfdrive 0m · waiting 1m");
		expect(awake).toEqual({ started: 1, killed: 0 });
		await h.command("/selfdrive on");
		expect(h.lastNote?.message).toBe("Self-driving mode 🚗 is already on.");
		expect(h.confirms).toHaveLength(1);

		await h.command("/selfdrive off");
		expect(h.entries().at(-1)).toMatchObject({ active: false, reason: "off" });
		expect(h.grant).toBeUndefined();
		expect(h.status).toBeUndefined();
		expect(awake).toEqual({ started: 1, killed: 1 });
		const report = h.messages().at(-1)!;
		expect(report.details.kind).toBe("report");
		expect((report.details.lines as string[])[0]).toMatch(/^🚗 Self-driving report · 0m · 1 run · \$0\.00 · no tasks recorded$/);
		await expect(h.session.prompt("go")).resolves.toBeUndefined();
		await h.settle(3);
	});

	it("still turns on outside git, without a grant", async () => {
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.entries()[0]).toMatchObject({ active: true });
		expect(h.notes.some((note) => note.type === "warning" && note.message.includes("Herder runs are unavailable"))).toBe(true);
		expect(h.grant).toBeUndefined();
	});

	it("publishes the checkout as the top level when the git dir lives elsewhere", async () => {
		const gitDir = join(root, "elsewhere.git");
		execFileSync("git", ["init", "-q", `--separate-git-dir=${gitDir}`], { cwd: cwd() });
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.grant).toMatchObject({ toplevel: realpathSync(cwd()), commonDir: realpathSync(gitDir) });
	});

	it("refuses outside top-level TUI and RPC sessions", async () => {
		const print = await start({ mode: "print" });
		await print.command("/selfdrive");
		expect(print.lastNote).toEqual({ message: "/selfdrive works only in top-level TUI and RPC sessions.", type: "warning" });
		expect(print.confirms).toEqual([]);
		const child = await start({ bindAsChild: true });
		await child.command("/selfdrive");
		expect(child.confirms).toEqual([]);
		expect(child.entries()).toEqual([]);
		expect(child.grant).toBeUndefined();
	});
});

describe("driver", () => {
	it("continues after a run, waits, and finishes on done", async () => {
		const h = await start({ script: [
			calls(fauxToolCall("selfdrive_task", { title: "Run the suite", status: "running" }), fauxToolCall("probe", {})),
			fauxAssistantMessage("launched"),
			calls(next("wait", { seconds: 1 })),
			fauxAssistantMessage("waiting"),
			calls(fauxToolCall("selfdrive_task", { id: "T1", status: "done", result: "0 failures" }), next("done", { reason: "nothing left" })),
			fauxAssistantMessage("finished"),
		] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.tasks()).toEqual([{ id: "T1", title: "Run the suite", status: "running" }]);
		await h.settle(4);
		const continuation = h.requests[2]!.texts.at(-1)!;
		expect(continuation).toMatch(/^\[selfdrive\] Continue self-driving: run 2, 0m since it started; your user is still away\. Ledger: 1 running; open: T1 Run the suite \(running\)\./);
		expect(h.messages()[1]!.details).toEqual({ kind: "continue", run: 2, elapsed: "0m" });
		expect(h.status).toBe("🚗 selfdrive 0m · waiting 1m");
		await sleep(400);
		expect(h.requests).toHaveLength(4);
		await h.settle(6);
		expect(h.requests[4]!.texts.at(-1)).toContain("run 3");
		expect(h.status).toBe("🚗 selfdrive 0m · done");
		expect(h.entries().at(-1)).toMatchObject({ done: "nothing left" });
		await sleep(200);
		expect(h.requests).toHaveLength(6);
		await h.command("/selfdrive status");
		expect(h.lastNote?.message).toMatch(/is on since .*: 3 runs; tasks: 1 done; done: nothing left\.$/);
		await h.command("/selfdrive report");
		expect(h.lastNote?.message.split("\n")).toEqual(["🚗 Self-driving report · 0m · 3 runs · $0.00", "Done:", "  T1 Run the suite · 0 failures"]);
		expect(h.grant === undefined || h.grant.id === h.session.sessionManager.getSessionId()).toBe(true);
	});

	it("stops after three driver runs in a row that did nothing", async () => {
		const h = await start();
		await h.command("/selfdrive");
		await h.settle(3);
		expect(h.requests[1]!.texts.at(-1)!.startsWith(CONTINUE)).toBe(true);
		expect(h.entries().at(-1)).toMatchObject({ done: "three continuations in a row did nothing" });
		expect(h.status).toBe("🚗 selfdrive 0m · done");
		await sleep(200);
		expect(h.requests).toHaveLength(3);
		await h.command("/selfdrive report");
		expect(h.lastNote?.message).toBe("🚗 Self-driving report · 0m · 3 runs · $0.00 · nothing worth doing: three continuations in a row did nothing");
	});

	it("counts continuations that never start a run as failures", async () => {
		const h = await start({ script: [calls(fauxToolCall("probe", {}), next("wait", { seconds: 1 })), fauxAssistantMessage("waiting")] });
		await h.command("/selfdrive");
		await h.settle(2);
		// A failure before the first request (a compaction before the prompt, say): no run starts and nothing settles.
		(h.session as unknown as { _prepareRun(): Promise<never> })._prepareRun = async () => { throw new Error("cannot start"); };
		timing.startMs = 40;
		try {
			await until(() => h.entries().some((entry) => "done" in entry));
		} finally {
			timing.startMs = 3_000;
		}
		expect(h.entries().at(-1)).toMatchObject({ done: "three continuations in a row did not start" });
		expect(h.status).toBe("🚗 selfdrive 0m · done");
		await sleep(150);
		expect(h.requests).toHaveLength(2);
	});

	it("keeps terminal sequences and line breaks out of the ledger", async () => {
		const h = await start({ script: [calls(fauxToolCall("selfdrive_task", { title: "Fix \u001b[31mred\u001b[0m\nnow\u0007", why: "\u001b]0;title\u0007ok", status: "planned" }), next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.tasks()).toEqual([{ id: "T1", title: "Fix red now", why: "ok", status: "planned" }]);
	});

	it("reports only what the mode cost", async () => {
		let api!: ExtensionAPI;
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))], register: (pi) => { api = pi; } });
		const notify = (totalCost: number) => api.sendMessage({ customType: "subagent-notification", content: "finished", display: false, details: { totalCost } });
		await h.command("/selfdrive");
		await h.settle(2);
		notify(1);
		await h.command("/selfdrive off");
		notify(4);
		await h.command("/selfdrive report");
		expect(h.lastNote?.message).toBe("🚗 Self-driving report · 0m · 1 run · $1.00 (subagents $1.00) · no tasks recorded");
	});

	it("holds while an extension dialog is open", async () => {
		let answer!: (value: boolean) => void;
		const h = await start({
			script: [calls(next("wait", { seconds: 1 }))],
			register: (pi) => pi.registerCommand("ask", { handler: async (_args, ctx) => { await ctx.ui.confirm("Ask", "?"); } }),
		});
		h.control.confirm = (title) => title === "Ask" ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(true);
		await h.command("/selfdrive");
		await h.settle(2);
		const asking = h.command("/ask");
		await sleep(1_400);
		expect(h.requests).toHaveLength(2);
		answer(false);
		await asking;
		await h.settle(3);
		expect(h.requests[2]!.texts.at(-1)!.startsWith(`${CONTINUE}: run 2`)).toBe(true);
	});
});

describe("user return", () => {
	it("ends the mode when the user types, with the report before their message", async () => {
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		await h.session.prompt("I'm back", { source: "interactive" });
		await h.settle(3);
		const texts = h.requests[2]!.texts;
		expect(texts.at(-1)).toBe("I'm back");
		expect(texts.at(-2)!.startsWith(`${BACK}: start no new self-driving work`)).toBe(true);
		expect(texts.at(-2)).toContain("🚗 Self-driving report · 0m · 1 run");
		expect(h.entries().at(-1)).toMatchObject({ active: false, reason: "returned" });
		expect(h.messages().at(-1)!.details.kind).toBe("report");
		expect(h.status).toBeUndefined();
		expect(awake.killed).toBe(1);
	});

	it("steers the report into a running turn", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const h = await start({ script: [async () => { await gate; return fauxAssistantMessage("working"); }] });
		await h.command("/selfdrive");
		await until(() => h.requests.length === 1);
		await h.session.prompt("back now", { source: "interactive", streamingBehavior: "steer" });
		expect(h.entries().at(-1)).toMatchObject({ active: false, reason: "returned" });
		release();
		// Pi delivers one steering message per turn: the report first, then their message.
		await h.settle(3);
		expect(h.requests[1]!.texts.at(-1)!.startsWith(BACK)).toBe(true);
		const texts = h.requests[2]!.texts;
		expect(texts.at(-1)).toBe("back now");
		expect(texts.findIndex((text) => text.startsWith(BACK))).toBeGreaterThan(0);
		await sleep(100);
		expect(h.requests).toHaveLength(3);
	});

	it("ignores input from extensions", async () => {
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		await h.session.prompt("relay says hi", { source: "extension" });
		await h.settle(3);
		expect(h.entries()).toHaveLength(1);
		expect(h.status).toMatch(/^🚗 selfdrive/);
	});

	it("ends on Esc", async () => {
		const h = await start({ script: [(_context, options) => new Promise((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
		})] });
		await h.command("/selfdrive");
		await until(() => h.requests.length === 1);
		await h.session.abort();
		await until(() => h.entries().length === 2);
		expect(h.entries().at(-1)).toMatchObject({ active: false, reason: "esc" });
		expect(h.messages().at(-1)!.content.startsWith("[selfdrive] Your user pressed Esc")).toBe(true);
		expect(h.grant).toBeUndefined();
		await sleep(100);
		expect(h.requests).toHaveLength(1);
	});
});

describe("lifecycle", () => {
	it("withdraws the grant and stops keep-awake on shutdown", async () => {
		execFileSync("git", ["init", "-q"], { cwd: cwd() });
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.grant).toBeDefined();
		const id = h.session.sessionManager.getSessionId();
		await h.dispose();
		expect(grants().some((grant) => grant.id === id)).toBe(false);
		expect(awake).toEqual({ started: 1, killed: 1 });
	});

	it("resumes after a reload", async () => {
		execFileSync("git", ["init", "-q"], { cwd: cwd() });
		const h = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await h.command("/selfdrive");
		await h.settle(2);
		await h.session.reload();
		expect(h.entries()).toHaveLength(1);
		expect(h.grant).toBeDefined();
		expect(h.status).toMatch(/^🚗 selfdrive/);
		expect(awake).toEqual({ started: 2, killed: 1 });
	});

	it("throws from the tools while off", async () => {
		const h = await start({ script: [calls(next("wait", { seconds: 60 })), fauxAssistantMessage("ok"), calls(next("continue"))] });
		await h.command("/selfdrive");
		await h.settle(2);
		await h.command("/selfdrive off");
		await h.session.prompt("try it", { source: "interactive" });
		await h.settle(4);
		expect(h.requests[3]!.texts.at(-1)).toContain("self-driving mode is off");
	});
});
