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
		toolResults: () => branch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []),
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
		expect(kickoff).toContain("the focus your user gave: fix the docs");
		expect(kickoff).toContain("Do not expand outside it");
		expect(kickoff).toContain("delegate the next useful step");
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
		expect((report.details.lines as string[])[0]).toBe("🚗 Self-driving report · 0m · 0 tasks · $0.00");
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
		expect(continuation.startsWith(CONTINUE)).toBe(true);
		expect(continuation).toContain("2 driver starts");
		expect(continuation).toContain("evidence-based candidates across the project");
		expect(continuation).toContain("T1 Run the suite (running)");
		expect(h.messages()[1]!.details).toEqual({ kind: "continue", run: 2, elapsed: "0m" });
		expect(h.status).toBe("🚗 selfdrive 0m · waiting 1m");
		await sleep(400);
		expect(h.requests).toHaveLength(4);
		await h.settle(6);
		expect(h.requests[4]!.texts.at(-1)).toContain("3 driver starts");
		expect(h.status).toBe("🚗 selfdrive 0m · done");
		expect(h.entries().at(-1)).toMatchObject({ done: "nothing left" });
		await sleep(200);
		expect(h.requests).toHaveLength(6);
		await h.command("/selfdrive status");
		expect(h.lastNote?.message).toMatch(/is on since .*: 3 driver starts; tasks: 1 done; done: nothing left\.$/);
		await h.command("/selfdrive report");
		expect(h.lastNote?.message.split("\n")).toEqual(["🚗 Self-driving report · 0m · 1 task · $0.00", "Stopped: nothing left", "Done:", "  T1 Run the suite · 0 failures"]);
		expect(h.grant === undefined || h.grant.id === h.session.sessionManager.getSessionId()).toBe(true);
	});

	it.each(["planned", "running"])("refuses done with %s tasks, then accepts their completed outcomes", async (status) => {
		const h = await start({ script: [
			calls(...Array.from({ length: 7 }, (_, i) => fauxToolCall("selfdrive_task", { title: `Check ${i + 1}`, status })), next("done")),
			fauxAssistantMessage("still open"),
			calls(...Array.from({ length: 7 }, (_, i) => fauxToolCall("selfdrive_task", { id: `T${i + 1}`, status: "done", result: "Verified" })), next("done", { reason: "Verification found no further actionable problems" })),
			fauxAssistantMessage("finished"),
		] });
		await h.command("/selfdrive");
		await h.settle(2);
		const refusal = h.toolResults().find((result) => result.toolName === "selfdrive_next")!;
		expect(refusal).toMatchObject({ isError: true, details: {} });
		const error = textOf(refusal);
		expect(error).toContain(`T1 (${status})`);
		expect(error).toContain(`T5 (${status})`);
		expect(error).not.toContain("T6");
		expect(error).toContain("+2 more");
		expect(error).toContain("actual outcomes");
		expect(error).not.toContain("dropped");
		expect(h.entries().some((entry) => "done" in entry)).toBe(false);
		await h.settle(4);
		expect(h.entries().at(-1)).toMatchObject({ done: "Verification found no further actionable problems" });
		expect(h.toolResults().at(-1)).toMatchObject({ isError: false, details: { action: "done" } });
	});

	it.each(["empty", "proposed-only"])("allows done with an %s ledger without a discovery gate", async (ledger) => {
		const h = await start({ script: [
			calls(...(ledger === "empty" ? [] : [fauxToolCall("selfdrive_task", { title: "Verified fix", status: "proposed", result: "Ready for review", herderRun: "20260101-000000-abcd", needs: "Deliver the verified run" })]), next("done", { reason: "No further actionable evidence within scope" })),
			fauxAssistantMessage("finished"),
		] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.entries().at(-1)).toMatchObject({ done: "No further actionable evidence within scope" });
		expect(h.toolResults().at(-1)).toMatchObject({ isError: false, details: { action: "done" } });
		expect(h.tasks()).toHaveLength(ledger === "empty" ? 0 : 1);
	});

	it("clears an earlier accepted done when a later done is refused, even if the tasks then finish", async () => {
		const h = await start({ script: [
			calls(next("done", { reason: "stale decision" })),
			calls(fauxToolCall("selfdrive_task", { title: "New evidence", status: "planned" }), next("done")),
			calls(fauxToolCall("selfdrive_task", { id: "T1", status: "done", result: "Checked the evidence" })),
			fauxAssistantMessage("updated the outcome"),
			calls(next("done", { reason: "No further actionable evidence after the check" })),
			fauxAssistantMessage("finished"),
		] });
		await h.command("/selfdrive");
		await h.settle(4);
		expect(h.toolResults().filter((result) => result.toolName === "selfdrive_next").map((result) => result.isError)).toEqual([false, true]);
		expect(h.entries().some((entry) => "done" in entry)).toBe(false);
		await h.settle(6);
		expect(h.entries().at(-1)).toMatchObject({ done: "No further actionable evidence after the check" });
	});

	it("rechecks an accepted done when a later call in the same turn creates an open task", async () => {
		const h = await start({ script: [
			calls(next("done", { reason: "before new evidence" }), fauxToolCall("selfdrive_task", { title: "Follow up new evidence", status: "planned" })),
			fauxAssistantMessage("new work remains"),
			calls(next("wait", { seconds: 60 })),
			fauxAssistantMessage("waiting"),
		] });
		await h.command("/selfdrive");
		await h.settle(2);
		expect(h.toolResults()[0]).toMatchObject({ toolName: "selfdrive_next", isError: false, details: { action: "done" } });
		expect(h.entries().some((entry) => "done" in entry)).toBe(false);
		await h.settle(4);
		expect(h.requests[2]!.texts.at(-1)).toContain("T1 Follow up new evidence (planned)");
		expect(h.status).toContain("waiting");
	});

	it("keeps refused done calls idle for the three-no-work protective stop", async () => {
		const h = await start({ script: [
			calls(fauxToolCall("selfdrive_task", { title: "Unfinished check", status: "planned" }), next("done")),
			fauxAssistantMessage("no work"),
			calls(next("done")), fauxAssistantMessage("no work"),
			calls(next("done")), fauxAssistantMessage("no work"),
		] });
		await h.command("/selfdrive");
		await h.settle(6);
		expect(h.toolResults().filter((result) => result.toolName === "selfdrive_next").map((result) => result.isError)).toEqual([true, true, true]);
		expect(h.tasks().at(-1)).toMatchObject({ status: "planned" });
		expect(h.entries().at(-1)).toMatchObject({ done: "three continuations in a row did nothing" });
	});

	it("summarizes bounded open tasks and latest terminal updates while retaining the focus", async () => {
		const h = await start({ script: [
			calls(
				fauxToolCall("selfdrive_task", { title: "Earliest task", status: "done", result: "Old result" }),
				fauxToolCall("selfdrive_task", { title: "Old finished task", status: "done", result: "Old finding" }),
				fauxToolCall("selfdrive_task", { title: "Verified fix", status: "proposed", result: "Fix ready", needs: "Review and deliver" }),
				fauxToolCall("selfdrive_task", { title: "Flaky check", status: "failed", result: "Reproduced timeout", needs: "Fixture access" }),
				fauxToolCall("selfdrive_task", { title: "Reopened check", status: "done", result: "Obsolete terminal outcome" }),
				...Array.from({ length: 7 }, (_, i) => fauxToolCall("selfdrive_task", { title: `Open ${i + 1} ${"x".repeat(300)}`, status: "planned", why: `Evidence ${i + 1} ${"y".repeat(300)}` })),
				fauxToolCall("selfdrive_task", { id: "T1", status: "done", result: "Intermediate result" }),
				fauxToolCall("selfdrive_task", { id: "T1", status: "done", result: `Latest finding ${"z".repeat(300)}`, needs: "Bounded verification" }),
				fauxToolCall("selfdrive_task", { id: "T5", status: "planned", why: "New evidence reopens the check" }),
				fauxToolCall("probe", {}),
			),
			fauxAssistantMessage("recorded"),
			calls(next("wait", { seconds: 60 })),
			fauxAssistantMessage("waiting"),
		] });
		await h.command("/selfdrive on test reliability");
		await h.settle(4);
		const continuation = h.requests[2]!.texts.at(-1)!;
		expect(continuation).toContain("Focus: test reliability");
		expect(continuation).toContain("Work only within this focus");
		expect(continuation).not.toContain(RULES_START);
		const open = continuation.split("Open tasks: ")[1]!.split("\n")[0]!;
		expect(open.match(/T\d+ /g)).toHaveLength(5);
		expect(open).toContain("T5 Reopened check (planned); why: New evidence reopens the check");
		expect(open).toContain("T9 Open 4");
		expect(open).toContain("why: Evidence 4");
		expect(open).toContain("+3 more");
		expect(open).not.toContain("T10");
		const outcomes = continuation.split("Latest outcomes: ")[1]!.split("\n")[0]!;
		expect(outcomes.match(/T\d+ /g)).toEqual(["T1 ", "T4 ", "T3 "]);
		expect(outcomes).toContain("result: Latest finding");
		expect(outcomes).toContain("needs: Bounded verification");
		expect(outcomes).toContain("result: Reproduced timeout");
		expect(outcomes).toContain("needs: Fixture access");
		expect(outcomes).toContain("result: Fix ready");
		expect(outcomes).toContain("needs: Review and deliver");
		expect(outcomes).toContain("1 proposed waiting for your user");
		expect(outcomes).toContain("do not block completion");
		expect(outcomes).not.toMatch(/Old finding|Old result|Intermediate result|Obsolete terminal outcome/);
		for (const char of ["x", "y", "z"]) expect(continuation).not.toContain(char.repeat(101));
		expect(continuation.length).toBeLessThan(3_000);
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
		expect(h.lastNote?.message.split("\n")).toEqual(["🚗 Self-driving report · 0m · 0 tasks · $0.00", "Stopped: three continuations in a row did nothing"]);
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
		expect(h.lastNote?.message).toBe("🚗 Self-driving report · 0m · 0 tasks · $1.00 (subagents $1.00)");
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
		expect(h.requests[2]!.texts.at(-1)).toContain("2 driver starts");
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
		expect(texts.at(-2)).toContain("🚗 Self-driving report · 0m · 0 tasks");
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
		await h.command("/selfdrive status");
		expect(h.lastNote?.message).toContain("1 driver start;");
		expect(h.lastNote?.message).not.toContain("driver starts");
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

describe("session modes registry", () => {
	it("publishes changes, preserves other modes, and keeps done published across reload", async () => {
		const symbol = Symbol.for("pi-extensions.session-modes");
		const shared = globalThis as Record<symbol, unknown>;
		const registry = (shared[symbol] ??= { modes: new Map(), listeners: new Set() }) as { modes: Map<string, Set<string>>; listeners: Set<(id: string) => void> };
		const h = await start({ script: [calls(next("done")), fauxAssistantMessage("finished")] });
		const id = h.session.sessionManager.getSessionId();
		registry.modes.set(id, new Set(["swarm"]));
		const changes: string[] = [];
		const listener = (changed: string) => { changes.push(`${changed}:${[...(registry.modes.get(changed) ?? [])].sort().join(",")}`); };
		const broken = () => { throw new Error("listener failure"); };
		registry.listeners.add(broken);
		registry.listeners.add(listener);
		try {
			await h.command("/selfdrive");
			await h.settle(2);
			expect(h.status).toContain("done");
			expect(registry.modes.get(id)).toEqual(new Set(["swarm", "selfdrive"]));
			await h.session.reload();
			expect(registry.modes.get(id)).toEqual(new Set(["swarm", "selfdrive"]));
			await h.command("/selfdrive off");
			expect(registry.modes.get(id)).toEqual(new Set(["swarm"]));
			expect(changes).toEqual([`${id}:selfdrive,swarm`, `${id}:swarm`, `${id}:selfdrive,swarm`, `${id}:swarm`]);
		} finally {
			registry.listeners.delete(listener);
			registry.listeners.delete(broken);
			registry.modes.delete(id);
		}
	});

	it("isolates sessions and removes only the departing session on fork, switch, and shutdown", async () => {
		const symbol = Symbol.for("pi-extensions.session-modes");
		const shared = globalThis as Record<symbol, unknown>;
		const registry = (shared[symbol] ??= { modes: new Map(), listeners: new Set() }) as { modes: Map<string, Set<string>>; listeners: Set<(id: string) => void> };
		const a = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		const b = await start({ script: [calls(next("wait", { seconds: 60 }))] });
		await a.command("/selfdrive");
		await a.settle(2);
		await b.command("/selfdrive");
		await b.settle(2);
		const aId = a.session.sessionManager.getSessionId();
		const bId = b.session.sessionManager.getSessionId();
		expect(registry.modes.get(aId)?.has("selfdrive")).toBe(true);
		expect(registry.modes.get(bId)?.has("selfdrive")).toBe(true);
		await a.runtime.fork(a.session.sessionManager.getLeafId()!, { position: "at" });
		expect(registry.modes.has(aId)).toBe(false);
		expect(registry.modes.get(bId)?.has("selfdrive")).toBe(true);
		const bFile = b.session.sessionManager.getSessionFile()!;
		await b.runtime.newSession();
		expect(registry.modes.has(bId)).toBe(false);
		await b.command("/selfdrive");
		const newId = b.session.sessionManager.getSessionId();
		expect(registry.modes.get(newId)?.has("selfdrive")).toBe(true);
		await b.runtime.switchSession(bFile);
		expect(registry.modes.has(newId)).toBe(false);
		expect(registry.modes.has(bId)).toBe(false);
		await a.command("/selfdrive");
		const forkId = a.session.sessionManager.getSessionId();
		expect(registry.modes.get(forkId)?.has("selfdrive")).toBe(true);
		await a.dispose();
		expect(registry.modes.has(forkId)).toBe(false);
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

	it.each(["compaction", "reload"])("derives focus, open tasks, and latest outcomes from the ledger after %s", async (recovery) => {
		const h = await start({
			register: (pi) => {
				pi.on("session_before_compact", ({ preparation, branchEntries }) => ({ compaction: {
					summary: "Earlier conversation.", firstKeptEntryId: branchEntries.at(-1)!.id, tokensBefore: preparation.tokensBefore,
				} }));
			},
			script: [
				calls(
					fauxToolCall("selfdrive_task", { title: "Audit", status: "done", result: "Original result" }),
					fauxToolCall("selfdrive_task", { title: "Check", status: "failed", result: "Timeout reproduced" }),
					fauxToolCall("selfdrive_task", { id: "T1", status: "done", result: "Latest audit finding", needs: "Check the fixture" }),
					fauxToolCall("selfdrive_task", { title: "Verify finding", status: "planned", why: "Audit found a race" }),
					next("wait", { seconds: 1 }),
				),
				fauxAssistantMessage("waiting"),
				calls(next("wait", { seconds: 60 })),
				fauxAssistantMessage("waiting"),
			],
		});
		await h.command("/selfdrive on fixture reliability");
		await h.settle(2);
		if (recovery === "compaction") {
			await h.session.compact();
			expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		} else await h.session.reload();
		await h.settle(4);
		const continuation = h.requests[2]!.texts.at(-1)!;
		expect(continuation).toContain("Focus: fixture reliability");
		expect(continuation).toContain("T3 Verify finding (planned); why: Audit found a race");
		const outcomes = continuation.split("Latest outcomes: ")[1]!.split("\n")[0]!;
		expect(outcomes.match(/T\d+ /g)).toEqual(["T1 ", "T2 "]);
		expect(outcomes).toContain("result: Latest audit finding; needs: Check the fixture");
		expect(outcomes).toContain("result: Timeout reproduced");
		expect(outcomes).not.toContain("Original result");
		if (recovery === "compaction") {
			expect(continuation).toContain(RULES_START);
			expect(h.requests[2]!.texts).not.toContain(h.requests[0]!.texts.at(-1));
		}
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
