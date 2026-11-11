import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { runScheduledSweep } from "../gc.ts";
import {
	CHILD_SESSION_HOOKS,
	settleWorkspaceSweeps,
	TELEMETRY_TYPE,
	WORKSPACE_SHARED_KEY,
	type WorkspaceSharedState,
} from "../index.ts";
import { extractTaggedBashWriteTargets, resolveCanonicalPath, workspacesDir } from "../policy.ts";
import {
	assertWorkspaceQuota,
	createOrTouchWorkspace,
	hasLiveOtherOwner,
	inspectWorkspaceSafety,
	readRegistry,
	readRegistryState,
	validateWorkspaceName,
	WORKSPACE_LIMITS,
	WorkspaceQuotaError,
} from "../registry.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

let sandboxRoot: string;
let projectCwd: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-lifecycle-"));
	projectCwd = path.join(sandboxRoot, "project");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	await rm(sandboxRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sharedState(): WorkspaceSharedState {
	return (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY] as WorkspaceSharedState;
}

/** A real Pi session on the faux provider; `child` binds with no mode, as Subagents binds live children. */
async function startSession(options?: { child?: boolean }) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ api: "workspace-lifecycle-api", provider: "workspace-lifecycle", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});
	const notes: { message: string; type?: string }[] = [];
	const noop = () => {};
	const uiContext = {
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
		notify: (message: string, type?: string) => {
			notes.push({ message, type });
		},
		setStatus: noop,
	} as unknown as ExtensionUIContext;

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
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
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
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
		cwd: projectCwd,
		agentDir,
		sessionManager: SessionManager.create(projectCwd, sessionDir),
	});
	const errors: unknown[] = [];
	const bind = () =>
		runtime.session.bindExtensions(
			options?.child
				? {}
				: {
						mode: "rpc",
						uiContext,
						onError: (err) => {
							errors.push(err);
						},
						commandContextActions: {
							waitForIdle: () => runtime.session.waitForIdle(),
							newSession: (o) => runtime.newSession(o),
							fork: (id, o) => runtime.fork(id, o),
							navigateTree: (id, o) => runtime.session.navigateTree(id, o),
							switchSession: (p, o) => runtime.switchSession(p, o),
							reload: () => runtime.session.reload(),
						},
					},
		);
	runtime.setRebindSession(bind);
	await bind();

	const session = runtime.session;
	return {
		session,
		faux,
		notes,
		errors,
		/** Runs one assistant turn per tool call, then a closing message. */
		runTools: async (calls: ReturnType<typeof fauxToolCall>[]) => {
			faux.setResponses([...calls.map((call) => fauxAssistantMessage([call])), fauxAssistantMessage("done")]);
			await session.prompt("work");
		},
		toolResults: () =>
			session.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [
							{
								isError: Boolean((entry.message as { isError?: boolean }).isError),
								text: ((entry.message as { content?: { text?: string }[] }).content ?? [])
									.map((part) => part.text ?? "")
									.join(""),
							},
						]
					: [],
			),
		telemetry: () =>
			session.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === TELEMETRY_TYPE ? [entry.data as Record<string, unknown>] : [],
				),
		dispose: () => runtime.dispose(),
	};
}

const create = (name: string) => fauxToolCall("workspace", { action: "create", name });

describe("workspace names", () => {
	it("rejects glob metacharacters so bash-parsed globs are never registered", () => {
		for (const name of ["processes-test-*", "a?", "[ab]", "x]", "{a,b}", "y}"]) {
			expect(() => validateWorkspaceName(name), name).toThrow(/glob characters/);
		}
		expect(validateWorkspaceName("exp-parser_2")).toBe("exp-parser_2");
	});
});

describe("pid lease", () => {
	it("treats a foreign live pid as ACTIVE and this process's pid without an active session as saying nothing", async () => {
		const foreign = await createOrTouchWorkspace(projectCwd, { name: "foreign", pid: process.ppid }, agentDir);
		const foreignReport = await inspectWorkspaceSafety(foreign);
		expect(foreignReport.status).toBe("ACTIVE");
		expect(foreignReport.reasons).toEqual([`owning process (pid ${process.ppid}) is still running`]);

		const own = await createOrTouchWorkspace(
			projectCwd,
			{ name: "own", sessionId: "ended", pid: process.pid },
			agentDir,
		);
		expect((await inspectWorkspaceSafety(own, { activeSessionIds: new Set() })).status).toBe("SAFE");
		expect((await inspectWorkspaceSafety(own, { activeSessionIds: new Set(["ended"]) })).status).toBe("ACTIVE");
	});

	it("records process.pid from the tool and the guard, and keeps a reloaded session's workspaces active and unclosed", async () => {
		const h = await startSession();
		try {
			await h.runTools([
				create("by-tool"),
				fauxToolCall("bash", { command: "mkdir -p .pi/workspaces/by-guard/sub" }),
			]);
			const entries = await readRegistry(projectCwd);
			for (const name of ["by-tool", "by-guard"]) {
				const entry = entries.find((item) => item.name === name);
				expect(entry?.pid, name).toBe(process.pid);
				expect(entry?.sessionId, name).toBe(h.session.sessionId);
			}

			await h.session.reload();
			await settleWorkspaceSweeps();
			expect(sharedState().activeSessionIds.has(h.session.sessionId)).toBe(true);
			const afterReload = await readRegistry(projectCwd);
			expect(afterReload.map((entry) => entry.name).sort()).toEqual(["by-guard", "by-tool"]);
			for (const entry of afterReload) {
				expect(entry.closedAt, entry.name).toBeUndefined();
				expect((await inspectWorkspaceSafety(entry, { activeSessionIds: sharedState().activeSessionIds })).status).toBe(
					"ACTIVE",
				);
			}
			const sessionEnd = h.telemetry().find((data) => data.event === "session_end");
			expect(sessionEnd).toEqual({ event: "session_end", reason: "reload", held: ["by-tool", "by-guard"] });
		} finally {
			await h.dispose();
		}
	});
});

describe("per-session quota", () => {
	it("counts only workspaces the session holds, and child sessions separately", async () => {
		const entries = [
			await createOrTouchWorkspace(projectCwd, { name: "a", sessionId: "s" }, agentDir),
			await createOrTouchWorkspace(projectCwd, { name: "b", sessionId: "s" }, agentDir),
			await createOrTouchWorkspace(projectCwd, { name: "pinned", sessionId: "s", pinned: true }, agentDir),
			await createOrTouchWorkspace(projectCwd, { name: "other", sessionId: "child" }, agentDir),
		];
		assertWorkspaceQuota(entries, "s", ["c"], 3);
		assertWorkspaceQuota(entries, "s", ["a", "b", "pinned"], 2);
		assertWorkspaceQuota(entries, "child", ["c", "d"], 3);
		expect(() => assertWorkspaceQuota(entries, "s", ["c", "d"], 3)).toThrow(WorkspaceQuotaError);
		// Taking over the workspace of a session that is gone starts holding it; a live owner keeps it.
		expect(() => assertWorkspaceQuota(entries, "s", ["other"], 2)).toThrow(WorkspaceQuotaError);
		assertWorkspaceQuota(entries, "s", ["other"], 2, { activeSessionIds: new Set(["child"]) });
	});

	it("tells a live other owner (open session or foreign live pid) from a gone one", async () => {
		const open = await createOrTouchWorkspace(projectCwd, { name: "open", sessionId: "p", pid: process.pid }, agentDir);
		expect(hasLiveOtherOwner(open, "c", new Set(["p"]))).toBe(true);
		expect(hasLiveOtherOwner(open, "c", new Set())).toBe(false);
		expect(hasLiveOtherOwner(open, "p", new Set(["p"]))).toBe(false);

		const foreign = await createOrTouchWorkspace(projectCwd, { name: "foreign", sessionId: "q", pid: process.ppid }, agentDir);
		expect(hasLiveOtherOwner(foreign, "c")).toBe(true);
		expect(hasLiveOtherOwner({ ...foreign, closedAt: new Date().toISOString() }, "c")).toBe(false);
		expect(hasLiveOtherOwner({ ...foreign, releasedAt: new Date().toISOString() }, "c")).toBe(false);
	});

	it("refuses a tool create past the limit, never counts a re-touch, and frees a slot on release", async () => {
		expect(WORKSPACE_LIMITS.maxHeldPerSession).toBe(3);
		const h = await startSession();
		try {
			await h.runTools([create("one"), create("two"), create("three"), create("one"), create("four")]);
			const results = h.toolResults();
			expect(results.slice(0, 4).map((result) => result.isError)).toEqual([false, false, false, false]);
			expect(results[4]!.isError).toBe(true);
			expect(results[4]!.text).toContain('cannot start holding "four"');
			expect(results[4]!.text).toContain("(one, two, three)");
			expect(results[4]!.text).toContain('workspace({action: "release", name})');
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "four"))).toBe(false);

			const telemetry = h.telemetry();
			expect(telemetry.filter((data) => data.event === "create")).toEqual([
				{ event: "create", name: "one", source: "tool", held: 1, projectTotal: 1 },
				{ event: "create", name: "two", source: "tool", held: 2, projectTotal: 2 },
				{ event: "create", name: "three", source: "tool", held: 3, projectTotal: 3 },
			]);
			expect(telemetry.filter((data) => data.event === "quota_refused")).toEqual([
				{ event: "quota_refused", name: "four", held: ["one", "two", "three"], limit: 3 },
			]);

			await h.runTools([fauxToolCall("workspace", { action: "release", name: "one" }), create("four")]);
			const [release, four] = h.toolResults().slice(-2);
			expect(release!.text).toContain('Released and removed workspace "one"');
			expect(four!.isError).toBe(false);
		} finally {
			await h.dispose();
		}
	});

	it("blocks a guarded write that would auto-register a new workspace past the limit, allows held ones, and lets a child hold its own", async () => {
		const h = await startSession();
		try {
			await h.runTools([create("one"), create("two"), create("three")]);
			await h.runTools([
				fauxToolCall("bash", { command: "mkdir -p .pi/workspaces/four/x .pi/workspaces/one/y" }),
				fauxToolCall("write", { path: ".pi/workspaces/two/f.txt", content: "x" }),
				fauxToolCall("bash", { command: "touch .pi/workspaces/processes-test-*" }),
			]);
			const [blocked, held, glob] = h.toolResults().slice(-3);
			expect(blocked!.isError).toBe(true);
			expect(blocked!.text).toContain('cannot start holding "four"');
			expect(blocked!.text).toContain('workspace({action: "release", name})');
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "four"))).toBe(false);
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "one", "y"))).toBe(false);
			expect(held!.isError).toBe(false);
			expect(glob!.isError).toBe(false);
			expect((await readRegistry(projectCwd)).map((entry) => entry.name).sort()).toEqual(["one", "three", "two"]);
			expect(h.telemetry().filter((data) => data.event === "quota_refused")).toEqual([
				{ event: "quota_refused", name: "four", held: ["one", "two", "three"], limit: 3 },
			]);

			const child = await startSession({ child: true });
			try {
				await child.runTools([fauxToolCall("bash", { command: "mkdir -p .pi/workspaces/child-ws" })]);
				expect(child.toolResults().at(-1)!.isError).toBe(false);
				const childEntry = (await readRegistry(projectCwd)).find((entry) => entry.name === "child-ws");
				expect(childEntry?.sessionId).toBe(child.session.sessionId);
				expect(child.telemetry().find((data) => data.event === "create")).toMatchObject({
					name: "child-ws",
					source: "guard",
					held: 1,
				});
			} finally {
				await child.dispose();
			}
		} finally {
			await h.dispose();
		}
	});
});

describe("removal is never a touch", () => {
	it("tags rm and rmdir targets as deletions unless the same command also writes them", () => {
		const ws = workspacesDir(projectCwd);
		expect(
			extractTaggedBashWriteTargets(
				"rm -rf .pi/workspaces/a; rmdir .pi/workspaces/b; rm -rf .pi/workspaces/c && mkdir .pi/workspaces/c; rm x > .pi/workspaces/d/log",
				projectCwd,
			),
		).toEqual([
			{ path: path.join(ws, "a"), deletes: true },
			{ path: path.join(ws, "b"), deletes: true },
			{ path: path.join(ws, "c"), deletes: false },
			// A command's redirections are visited before its words.
			{ path: path.join(ws, "d", "log"), deletes: false },
			{ path: path.join(resolveCanonicalPath(projectCwd), "x"), deletes: true },
		]);
	});

	it("lets a session at quota rm -rf any workspace without registering it, while the write guard still sees the targets", async () => {
		await createOrTouchWorkspace(projectCwd, { name: "unheld" }, agentDir);
		await mkdir(path.join(workspacesDir(projectCwd), "unregistered", "sub"), { recursive: true });
		const outside = path.join(sandboxRoot, "outside");
		await mkdir(outside);
		const h = await startSession();
		try {
			await h.runTools([create("one"), create("two"), create("three")]);
			await h.runTools([
				fauxToolCall("bash", { command: "rm -rf .pi/workspaces/unheld .pi/workspaces/unregistered" }),
				fauxToolCall("bash", { command: "rm -rf .pi/workspaces/one" }),
				fauxToolCall("bash", { command: "rmdir .pi/workspaces/two" }),
				fauxToolCall("bash", { command: "rm .pi/workspaces/.registry.json" }),
				fauxToolCall("bash", { command: `rm -rf ${outside}` }),
			]);
			const [unheld, one, two, stateFile, external] = h.toolResults().slice(-5);
			for (const result of [unheld, one, two]) expect(result!.isError, result!.text).toBe(false);
			for (const name of ["unheld", "unregistered", "one", "two"]) {
				expect(fs.existsSync(path.join(workspacesDir(projectCwd), name)), name).toBe(false);
			}
			expect(stateFile!.text).toContain("managed by the workspace extension");
			expect(external!.text).toContain("Blocked write outside project working directory");
			expect(fs.existsSync(outside)).toBe(true);

			const registry = await readRegistry(projectCwd);
			expect(registry.find((entry) => entry.name === "unheld")?.sessionId).toBeUndefined();
			expect(registry.some((entry) => entry.name === "unregistered")).toBe(false);
			expect(h.telemetry().filter((data) => data.event === "create").map((data) => data.name)).toEqual([
				"one",
				"two",
				"three",
			]);
			expect(h.telemetry().some((data) => data.event === "quota_refused")).toBe(false);
		} finally {
			await h.dispose();
		}
	});
});

describe("ownership", () => {
	it("keeps a live owner when a child touches its workspace, and transfers ownership once the owner ends", async () => {
		const parent = await startSession();
		const child = await startSession({ child: true });
		try {
			await parent.runTools([create("p-ws")]);
			await child.runTools([
				fauxToolCall("bash", { command: "touch .pi/workspaces/p-ws/f" }),
				create("p-ws"),
				create("c1"),
				create("c2"),
				create("c3"),
			]);
			expect(child.toolResults().map((result) => result.isError)).toEqual([false, false, false, false, false]);
			expect(child.toolResults()[1]!.text).toContain("Another active session owns it");
			const owned = (await readRegistry(projectCwd)).find((entry) => entry.name === "p-ws");
			expect(owned?.sessionId).toBe(parent.session.sessionId);
			expect(owned?.pid).toBe(process.pid);
			expect(child.telemetry().filter((data) => data.event === "create").map((data) => data.name)).toEqual([
				"c1",
				"c2",
				"c3",
			]);

			await parent.dispose();
			// The owner is gone: touching now takes the workspace over, which counts toward the child's quota.
			await child.runTools([fauxToolCall("bash", { command: "touch .pi/workspaces/p-ws/g" })]);
			expect(child.toolResults().at(-1)!.text).toContain('cannot start holding "p-ws"');
			await child.runTools([
				fauxToolCall("workspace", { action: "release", name: "c1" }),
				fauxToolCall("bash", { command: "touch .pi/workspaces/p-ws/g" }),
			]);
			expect(child.toolResults().at(-1)!.isError).toBe(false);
			const transferred = (await readRegistry(projectCwd)).find((entry) => entry.name === "p-ws");
			expect(transferred?.sessionId).toBe(child.session.sessionId);
			expect(transferred?.closedAt).toBeUndefined();
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	});
});

describe("release", () => {
	it("removes a SAFE workspace (including a clean linked worktree) and keeps a REVIEW one with its reasons", async () => {
		git(projectCwd, ["init"]);
		git(projectCwd, ["config", "user.email", "test@example.com"]);
		git(projectCwd, ["config", "user.name", "Test User"]);
		await writeFile(path.join(projectCwd, "a.txt"), "a\n", "utf8");
		git(projectCwd, ["add", "a.txt"]);
		git(projectCwd, ["commit", "-m", "init"]);

		const h = await startSession();
		try {
			const wtPath = path.join(workspacesDir(projectCwd), "wt");
			await h.runTools([
				fauxToolCall("bash", { command: `git worktree add -b wt-branch ${wtPath} HEAD` }),
				fauxToolCall("write", { path: ".pi/workspaces/scratch/notes.md", content: "draft\n" }),
				fauxToolCall("workspace", { action: "release", name: "wt" }),
				fauxToolCall("workspace", { action: "release", name: "scratch" }),
			]);
			const [, , releasedWt, releasedScratch] = h.toolResults();
			expect(releasedWt!.text).toContain('Released and removed workspace "wt"');
			expect(fs.existsSync(wtPath)).toBe(false);
			expect(git(projectCwd, ["worktree", "list"])).not.toContain("wt-branch");

			expect(releasedScratch!.isError).toBe(false);
			expect(releasedScratch!.text).toContain('Released workspace "scratch" but kept it');
			expect(releasedScratch!.text).toContain("REVIEW — contains non-git files");
			expect(releasedScratch!.text).toContain("release it again");
			const registry = await readRegistry(projectCwd);
			expect(registry.map((entry) => entry.name)).toEqual(["scratch"]);
			expect(registry[0]!.releasedAt).toBeDefined();

			const releases = h.telemetry().filter((data) => data.event === "release");
			expect(releases).toHaveLength(2);
			expect(releases[0]).toMatchObject({ name: "wt", status: "SAFE", removed: true });
			expect(releases[1]).toMatchObject({
				name: "scratch",
				status: "REVIEW",
				removed: false,
				reasons: ["contains non-git files"],
				sizeBytes: 6,
			});
			expect(typeof releases[1]!.ageMs).toBe("number");

			await rm(path.join(workspacesDir(projectCwd), "scratch", "notes.md"));
			await h.runTools([fauxToolCall("workspace", { action: "release", name: "scratch" })]);
			expect(h.toolResults().at(-1)!.text).toContain('Released and removed workspace "scratch"');
		} finally {
			await h.dispose();
		}
	});
});

describe("automatic sweep", () => {
	it("runs at most once per interval per project and stamps lastSweepAt only after it runs", async () => {
		const interval = WORKSPACE_LIMITS.sweepIntervalMs;
		await createOrTouchWorkspace(projectCwd, { name: "orphan-1" }, agentDir);
		const first = await runScheduledSweep({ cwd: projectCwd, intervalMs: interval, agentDir, now: 1_000_000 });
		expect(first?.result.removed.map((report) => report.entry.name)).toEqual(["orphan-1"]);
		expect((await readRegistryState(projectCwd)).lastSweepAt).toBe(new Date(1_000_000).toISOString());

		await createOrTouchWorkspace(projectCwd, { name: "orphan-2" }, agentDir);
		expect(
			await runScheduledSweep({ cwd: projectCwd, intervalMs: interval, agentDir, now: 1_000_000 + interval - 1 }),
		).toBeUndefined();
		expect(fs.existsSync(path.join(workspacesDir(projectCwd), "orphan-2"))).toBe(true);

		const later = await runScheduledSweep({ cwd: projectCwd, intervalMs: interval, agentDir, now: 1_000_000 + interval });
		expect(later?.result.removed.map((report) => report.entry.name)).toEqual(["orphan-2"]);
	});

	it("sweeps SAFE workspaces at a top-level session start, keeps REVIEW ones, records telemetry, and notifies past the review threshold", async () => {
		await createOrTouchWorkspace(projectCwd, { name: "orphan" }, agentDir);
		for (let i = 0; i < WORKSPACE_LIMITS.reviewNoticeThreshold; i += 1) {
			const entry = await createOrTouchWorkspace(projectCwd, { name: `draft-${i}` }, agentDir);
			await writeFile(path.join(entry.path, "notes.md"), "x", "utf8");
		}

		const child = await startSession({ child: true });
		try {
			await settleWorkspaceSweeps();
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "orphan"))).toBe(true);
			expect((await readRegistryState(projectCwd)).lastSweepAt).toBeUndefined();
		} finally {
			await child.dispose();
		}

		const h = await startSession();
		try {
			await settleWorkspaceSweeps();
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "orphan"))).toBe(false);
			expect((await readRegistry(projectCwd)).filter((entry) => entry.name.startsWith("draft-"))).toHaveLength(
				WORKSPACE_LIMITS.reviewNoticeThreshold,
			);
			const sweep = h.telemetry().find((data) => data.event === "sweep");
			expect(sweep).toMatchObject({
				trigger: "session_start",
				removed: ["orphan"],
				bytesFreed: 0,
				counts: { PINNED: 0, ACTIVE: 0, SAFE: 1, REVIEW: WORKSPACE_LIMITS.reviewNoticeThreshold },
			});
			expect(h.notes).toEqual([
				{
					message: `${WORKSPACE_LIMITS.reviewNoticeThreshold} workspaces in ${workspacesDir(projectCwd)} need review (${WORKSPACE_LIMITS.reviewNoticeThreshold} B); run /workspace gc to review them.`,
					type: "info",
				},
			]);
			expect(h.errors).toEqual([]);

			await h.session.prompt("/workspace gc --yes");
			expect(h.telemetry().filter((data) => data.event === "sweep").map((data) => data.trigger)).toEqual([
				"session_start",
				"manual",
			]);
		} finally {
			await h.dispose();
		}

		// A second top-level session within the interval does not sweep.
		await createOrTouchWorkspace(projectCwd, { name: "orphan-late" }, agentDir);
		const again = await startSession();
		try {
			await settleWorkspaceSweeps();
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "orphan-late"))).toBe(true);
			expect(again.telemetry().some((data) => data.event === "sweep")).toBe(false);
		} finally {
			await again.dispose();
		}
	});
});
