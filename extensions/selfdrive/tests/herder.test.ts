// selfdrive and Herder in one real Pi session on the faux provider, both loaded by path as Pi loads them (separate module
// instances that share only the process-global standing-approval registry), inside a temporary git repository.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { openRun } from "../../herder/src/run/store.ts";
import { createGitFixture, type GitFixture } from "../../herder/tests/support/git-fixture.ts";
import { grants } from "../grants.ts";
import { reasons } from "../guard.ts";

const SELFDRIVE = fileURLToPath(new URL("../index.ts", import.meta.url));
const HERDER = fileURLToPath(new URL("../../herder/index.ts", import.meta.url));

const GOAL = `# Goal: Fix the docs

## Intent
Readers want the README to match the code.

## Acceptance criteria
- AC-1: WHEN the README is read THE SYSTEM SHALL describe the fixture. verify: check:readme

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| readme | grep -q fixture README.md | 1m | yes |
`;
const PLAN = "# Plan\n\n- [ ] T1 (AC-1) Rewrite the README\n";

type Message = { role: string; content: unknown };
type ToolResult = { role: "toolResult"; toolName: string; isError: boolean; content: { type: string; text?: string }[]; details?: Record<string, unknown> };
const textOf = ({ content }: { content: unknown }) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
const calls = (...blocks: ToolCall[]) => fauxAssistantMessage(blocks, { stopReason: "toolUse" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await sleep(5);
	}
}
/** The artifact path the latest `herder_run start` result names, read from the provider's context like a model would. */
function artifactPath(context: Context, name: "goal.md" | "plan.md"): string {
	const result = [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "herder_run");
	const path = new RegExp(`^- ${name.replace(".", "\\.")}: (.+)$`, "m").exec(result ? textOf(result) : "")?.[1];
	if (!path) throw new Error(`no ${name} path in the last herder_run result`);
	return path;
}

let root: string;
let fixture: GitFixture;
let previousAgentDir: string | undefined;
let previousPath: string | undefined;
const started: { dispose(): Promise<void> }[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-selfdrive-herder-"));
	await Promise.all(["agent", "sessions", "bin"].map((name) => mkdir(join(root, name))));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	// The by-path module is not the one this file imports, so its keep-awake cannot be replaced: shadow caffeinate instead.
	writeFileSync(join(root, "bin", "caffeinate"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(root, "bin", "caffeinate"), 0o755);
	previousPath = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}${delimiter}${previousPath ?? ""}`;
	fixture = createGitFixture();
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		fixture.cleanup();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

/** A UI context that records notifications and confirms, whose answers the test chooses. A plain object: Pi spreads it. */
function recordingUi() {
	const notes: { message: string; type?: string }[] = [];
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
		notify: (message: string, type?: string) => { notes.push({ message, type }); }, setStatus: noop,
	} as unknown as ExtensionUIContext;
	return { notes, confirms, control, context };
}

async function start(script: FauxResponseStep[]) {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "selfdrive-herder-test-api", provider: "selfdrive-herder-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const ui = recordingUi();
	const requests: string[][] = [];
	const respond: FauxResponseFactory = (context, streamOptions, state, model) => {
		requests.push((context.messages as unknown as Message[]).filter((message) => message.role !== "system").map(textOf));
		const step = script.shift();
		return typeof step === "function" ? step(context, streamOptions, state, model) : step ?? fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [SELFDRIVE, HERDER],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: fixture.dir, agentDir: join(root, "agent"), sessionManager: SessionManager.create(fixture.dir, join(root, "sessions")) });
	const bind = () => runtime.session.bindExtensions({
		mode: "rpc",
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
		requests, ...ui,
		get session() { return runtime.session; },
		get id() { return runtime.session.sessionManager.getSessionId(); },
		get grant() { return grants().find((grant) => grant.id === runtime.session.sessionManager.getSessionId()); },
		command: (text: string) => runtime.session.prompt(text),
		/** Wait until the provider saw `count` requests and the session settled. */
		async settle(count: number) {
			await until(() => requests.length >= count);
			await runtime.session.waitForIdle();
			await sleep(10);
			expect(requests.length).toBe(count);
		},
		/** Tool results on the branch, in order. */
		results: () => branch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message as unknown as ToolResult] : []),
		modes: () => branch().flatMap((entry) => entry.type === "custom" && entry.customType === "selfdrive" ? [entry.data as Record<string, unknown>] : []),
		dispose: async () => { if (!disposed) { disposed = true; await runtime.dispose(); } },
	};
	started.push(harness);
	return harness;
}

describe("selfdrive with Herder", () => {
	it("approves goals under the grant, guards the checkout and delivery, and asks again once the user is back", { timeout: 60_000 }, async () => {
		const paths: { goal?: string; plan?: string } = {};
		const writeGoal: FauxResponseStep = (context) => {
			paths.goal = artifactPath(context, "goal.md");
			paths.plan = artifactPath(context, "plan.md");
			return calls(fauxToolCall("write", { path: paths.goal, content: GOAL }));
		};
		const readme = join(fixture.dir, "README.md");
		const h = await start([
			// The kickoff run: a Herder run under the grant, then what the guard refuses and allows.
			calls(fauxToolCall("herder_run", { action: "start", goal: "Fix the docs" })),
			writeGoal,
			calls(fauxToolCall("herder_run", { action: "approve_goal" })),
			calls(fauxToolCall("write", { path: readme, content: "# rewritten\n" })),
			calls(fauxToolCall("bash", { command: "git push origin main" })),
			() => calls(fauxToolCall("write", { path: paths.plan!, content: PLAN })),
			calls(fauxToolCall("herder_deliver", {})),
			calls(fauxToolCall("herder_run", { action: "abort" })),
			calls(fauxToolCall("selfdrive_next", { action: "wait", seconds: 60, reason: "test" })),
			fauxAssistantMessage("waiting"),
			// After the user is back: a fresh run, whose goal needs the user again.
			calls(fauxToolCall("herder_run", { action: "start", goal: "Fix the docs again" })),
			writeGoal,
			calls(fauxToolCall("herder_run", { action: "approve_goal" })),
			fauxAssistantMessage("approved"),
		]);

		// 1. Turning the mode on publishes a grant for the fixture repository.
		await h.command("/selfdrive on fix the docs");
		expect(h.confirms).toHaveLength(1);
		expect(h.confirms[0]!.title).toContain("self-driving");
		const grant = h.grant!;
		expect(grant).toMatchObject({ id: h.id, toplevel: fixture.dir, commonDir: fixture.commonDir });
		expect(grant.text).toContain("Focus: fix the docs.");
		await h.settle(10);

		const results = h.results();
		expect(results.map((result) => [result.toolName, result.isError])).toEqual([
			["herder_run", false], ["write", false], ["herder_run", false],
			["write", true], ["bash", true], ["write", false], ["herder_deliver", true], ["herder_run", false],
			["selfdrive_next", false],
		]);
		const [started1, goalWrite, approval, checkoutWrite, push, planWrite, delivery, abort] = results as [ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult];

		// 2. The goal is approved under the grant: no dialog, and the journal names the grant.
		const runId = started1.details!.runId as string;
		expect(textOf(started1)).toContain("A standing authorization from the user is in effect for this repository");
		expect(paths.goal!.startsWith(join(fixture.commonDir, "herder"))).toBe(true);
		expect(textOf(goalWrite)).not.toContain("Blocked");
		expect(approval.details).toMatchObject({ approved: true, approvedBy: "standing", grant: grant.id });
		expect(h.confirms).toHaveLength(1);
		const journal = openRun(fixture.commonDir, runId).journal.read();
		expect(journal.filter((event) => event.t === "goal.approved")).toEqual([
			expect.objectContaining({ approvedBy: "standing", authorization: grant.text, grant: grant.id }),
		]);

		// 3. The guard refuses the checkout write and the push, allows the run directory, and refuses delivery without a dialog.
		expect(textOf(checkoutWrite)).toBe(reasons.checkout(`write ${readme}`));
		expect(fixture.read("README.md")).toBe("# fixture\n");
		expect(textOf(push)).toBe(reasons.remote("git push"));
		expect(paths.plan!.startsWith(join(fixture.commonDir, "herder"))).toBe(true);
		expect(readFileSync(paths.plan!, "utf8")).toBe(PLAN);
		expect(readFileSync(paths.goal!, "utf8")).toBe(GOAL);
		expect(textOf(planWrite)).not.toContain("Blocked");
		expect(textOf(delivery)).toBe(reasons.deliver);
		// The run approved under the grant is abandoned unasked, so a fresh one can start.
		expect(abort.details).toMatchObject({ runId, aborted: true, grant: grant.id });
		expect(h.confirms).toHaveLength(1);
		expect(fixture.status()).toBe("");
		expect(h.grant).toBeDefined();

		// 4. The user's own input ends the mode and withdraws the grant; a fresh run's goal asks the user again.
		await h.session.prompt("I'm back: start another run", { source: "interactive" });
		expect(h.modes().at(-1)).toMatchObject({ active: false, reason: "returned" });
		expect(grants().some((value) => value.id === grant.id)).toBe(false);
		await h.settle(14);
		expect(h.requests[10]!.at(-1)).toBe("I'm back: start another run");
		const later = h.results().slice(results.length);
		expect(later.map((result) => [result.toolName, result.isError])).toEqual([["herder_run", false], ["write", false], ["herder_run", false]]);
		const runId2 = later[0]!.details!.runId as string;
		expect(runId2).not.toBe(runId);
		expect(textOf(later[0]!)).not.toContain("A standing authorization from the user is in effect");
		expect(h.confirms).toHaveLength(2);
		expect(h.confirms[1]!.title).toBe("Approve Herder goal: Fix the docs");
		expect(later[2]!.details).toMatchObject({ approved: true });
		expect(later[2]!.details).not.toHaveProperty("approvedBy");
		const approved = openRun(fixture.commonDir, runId2).journal.read().filter((event) => event.t === "goal.approved");
		expect(approved).toEqual([expect.objectContaining({ approvedBy: "user" })]);
		expect(approved[0]).not.toHaveProperty("grant");
	});
});
