import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { releaseAndCollectWorkspace, runScheduledSweep } from "../gc.ts";
import {
	settleWorkspaceSweeps,
	TELEMETRY_TYPE,
	WORKSPACE_SHARED_KEY,
	type WorkspaceSharedState,
} from "../index.ts";
import { inspectBashCommand, resolveCanonicalPath, workspacesDir } from "../policy.ts";
import {
	assertWorkspaceQuota,
	createOrTouchWorkspace,
	hasLiveOtherOwner,
	inspectWorkspaceSafety,
	isPidAlive,
	markSessionWorkspacesClosed,
	readRegistry,
	readRegistryState,
	recordWorkspaceSweep,
	registryLockFilePath,
	setWorkspacePin,
	syncWorkspaces,
	touchWorkspace,
	validateWorkspaceName,
	withRegistryLock,
	WORKSPACE_LIMITS,
	WorkspaceOwnershipError,
	WorkspaceQuotaError,
} from "../registry.ts";
import {
	createWorkspaceSandbox,
	startWorkspaceSession,
	type WorkspaceSandbox,
} from "./support/session-harness.ts";

const registryModuleUrl = new URL("../registry.ts", import.meta.url).href;

let sandbox: WorkspaceSandbox;
let sandboxRoot: string;
let projectCwd: string;
let agentDir: string;
let sessionDir: string;

beforeEach(async () => {
	sandbox = await createWorkspaceSandbox({ prefix: "pi-workspace-lifecycle-", createOutsideDir: false });
	({ sandboxRoot, projectCwd, agentDir, sessionDir } = sandbox);
});

afterEach(async () => {
	await sandbox.cleanup();
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sharedState(): WorkspaceSharedState {
	return (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY] as WorkspaceSharedState;
}

/** A real Pi session on the faux provider; `child` binds with no mode, as Subagents binds live children. */
async function startSession(options?: { child?: boolean }) {
	const harness = await startWorkspaceSession({
		cwd: projectCwd,
		agentDir,
		sessionDir,
		binding: options?.child ? "child" : "ui",
		api: "workspace-lifecycle-api",
		provider: "workspace-lifecycle",
		settleSweeps: false,
	});
	const { session, faux } = harness;
	return {
		session,
		faux,
		notes: harness.ui.notes,
		errors: harness.errors,
		/** Runs one assistant turn per tool call, then a closing message. */
		runTools: async (calls: ReturnType<typeof fauxToolCall>[]) => {
			faux.setResponses([...calls.map((call) => fauxAssistantMessage([call])), fauxAssistantMessage("done")]);
			await session.prompt("work");
		},
		toolResults: harness.toolResults,
		telemetry: () =>
			session.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === TELEMETRY_TYPE ? [entry.data as Record<string, unknown>] : [],
				),
		dispose: harness.dispose,
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
			inspectBashCommand(
				"rm -rf .pi/workspaces/a; rmdir .pi/workspaces/b; rm -rf .pi/workspaces/c && mkdir .pi/workspaces/c; rm x > .pi/workspaces/d/log",
				projectCwd,
			).writeTargets,
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
		await recordWorkspaceSweep(projectCwd, new Date());
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

	it("keeps a clean pushed git workspace with gitignored files on release and sweep, while collecting a truly clean one", async () => {
		const bareRemote = path.join(sandboxRoot, "release-ignored-origin.git");
		git(sandboxRoot, ["init", "--bare", bareRemote]);
		const seedRepo = path.join(sandboxRoot, "release-ignored-seed");
		await mkdir(seedRepo, { recursive: true });
		git(seedRepo, ["init"]);
		git(seedRepo, ["config", "user.email", "test@example.com"]);
		git(seedRepo, ["config", "user.name", "Test User"]);
		await writeFile(path.join(seedRepo, ".gitignore"), ".env\n", "utf8");
		await writeFile(path.join(seedRepo, "README.md"), "seeded\n", "utf8");
		git(seedRepo, ["add", ".gitignore", "README.md"]);
		git(seedRepo, ["commit", "-m", "init"]);
		git(seedRepo, ["remote", "add", "origin", bareRemote]);
		git(seedRepo, ["push", "-u", "origin", "HEAD"]);

		const ignoredPath = path.join(workspacesDir(projectCwd), "with-env");
		const cleanPath = path.join(workspacesDir(projectCwd), "clean-clone");

		const h = await startSession();
		try {
			await h.runTools([
				fauxToolCall("bash", { command: `git clone ${bareRemote} ${ignoredPath}` }),
				fauxToolCall("write", { path: ".pi/workspaces/with-env/.env", content: "TOKEN=local-only\n" }),
				fauxToolCall("bash", { command: `git clone ${bareRemote} ${cleanPath}` }),
				fauxToolCall("workspace", { action: "release", name: "with-env" }),
				fauxToolCall("workspace", { action: "release", name: "clean-clone" }),
			]);

			const [, , , releasedIgnored, releasedClean] = h.toolResults();
			expect(releasedIgnored!.isError).toBe(false);
			expect(releasedIgnored!.text).toContain('Released workspace "with-env" but kept it');
			expect(releasedIgnored!.text).toContain("REVIEW — gitignored files present");
			expect(fs.existsSync(path.join(ignoredPath, ".env"))).toBe(true);

			expect(releasedClean!.isError).toBe(false);
			expect(releasedClean!.text).toContain('Released and removed workspace "clean-clone"');
			expect(fs.existsSync(cleanPath)).toBe(false);

			const releases = h.telemetry().filter((data) => data.event === "release");
			expect(releases).toHaveLength(2);
			expect(releases[0]).toMatchObject({
				name: "with-env",
				status: "REVIEW",
				removed: false,
				reasons: ["gitignored files present"],
			});
			expect(releases[1]).toMatchObject({
				name: "clean-clone",
				status: "SAFE",
				removed: true,
			});
		} finally {
			await h.dispose();
		}

		// Automatic sweep also preserves the released workspace with gitignored files and collects a clean clone.
		await settleWorkspaceSweeps();
		const sweepClean = await createOrTouchWorkspace(projectCwd, { name: "sweep-clean" }, agentDir);
		git(projectCwd, ["clone", bareRemote, sweepClean.path]);

		const sweep = await runScheduledSweep({
			cwd: projectCwd,
			intervalMs: WORKSPACE_LIMITS.sweepIntervalMs,
			agentDir,
			now: Date.now() + WORKSPACE_LIMITS.sweepIntervalMs + 1_000,
		});
		expect(sweep?.result.removed.map((report) => report.entry.name)).toEqual(["sweep-clean"]);
		expect(sweep?.result.kept.map((report) => report.entry.name)).toEqual(["with-env"]);
		expect(fs.existsSync(sweepClean.path)).toBe(false);
		expect(fs.existsSync(path.join(ignoredPath, ".env"))).toBe(true);

		// Once the gitignored file is removed, the workspace becomes SAFE and is collected on release.
		await rm(path.join(ignoredPath, ".env"));
		const afterCleanup = await releaseAndCollectWorkspace({
			cwd: projectCwd,
			name: "with-env",
			agentDir,
		});
		expect(afterCleanup?.report.status).toBe("SAFE");
		expect(afterCleanup?.removed).toBe(true);
		expect(fs.existsSync(ignoredPath)).toBe(false);
	});

	it("refuses to release another active session's SAFE workspace, allows owner release, and allows release once the owner ends", async () => {
		const parent = await startSession();
		const child = await startSession({ child: true });
		try {
			await parent.runTools([create("parent-keep"), create("parent-self")]);
			const keepPath = path.join(workspacesDir(projectCwd), "parent-keep");
			const selfPath = path.join(workspacesDir(projectCwd), "parent-self");
			expect(fs.existsSync(keepPath)).toBe(true);
			expect(fs.existsSync(selfPath)).toBe(true);

			// Non-owner cannot release or delete an active session's SAFE workspace.
			await child.runTools([fauxToolCall("workspace", { action: "release", name: "parent-keep" })]);
			const refused = child.toolResults().at(-1)!;
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain('Refusing to release workspace "parent-keep"');
			expect(refused.text).toContain("another active session");
			expect(fs.existsSync(keepPath)).toBe(true);
			const keepEntry = (await readRegistry(projectCwd)).find((entry) => entry.name === "parent-keep");
			expect(keepEntry).toMatchObject({
				name: "parent-keep",
				sessionId: parent.session.sessionId,
				pid: process.pid,
			});
			expect(keepEntry?.releasedAt).toBeUndefined();
			expect(keepEntry?.closedAt).toBeUndefined();
			expect(child.telemetry().filter((data) => data.event === "release")).toEqual([]);

			// Owning session can still release and remove its own SAFE workspace.
			await parent.runTools([fauxToolCall("workspace", { action: "release", name: "parent-self" })]);
			const selfReleased = parent.toolResults().at(-1)!;
			expect(selfReleased.isError).toBe(false);
			expect(selfReleased.text).toContain('Released and removed workspace "parent-self"');
			expect(fs.existsSync(selfPath)).toBe(false);
			expect((await readRegistry(projectCwd)).map((entry) => entry.name)).toEqual(["parent-keep"]);

			// Once the owning session is no longer active, another session can release and remove it.
			await parent.dispose();
			await child.runTools([fauxToolCall("workspace", { action: "release", name: "parent-keep" })]);
			const releasedAfterEnd = child.toolResults().at(-1)!;
			expect(releasedAfterEnd.isError).toBe(false);
			expect(releasedAfterEnd.text).toContain('Released and removed workspace "parent-keep"');
			expect(fs.existsSync(keepPath)).toBe(false);
			expect(await readRegistry(projectCwd)).toEqual([]);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	});

	it("refuses to release a workspace owned by another live process and allows release once that pid is dead", async () => {
		const liveForeign = await createOrTouchWorkspace(
			projectCwd,
			{ name: "foreign-live", sessionId: "remote-session", pid: process.ppid },
			agentDir,
		);
		const exited = spawnSync(process.execPath, ["-e", ""]);
		const deadPid = exited.pid!;
		expect(isPidAlive(deadPid)).toBe(false);
		const deadForeign = await createOrTouchWorkspace(
			projectCwd,
			{ name: "foreign-dead", sessionId: "dead-session", pid: deadPid },
			agentDir,
		);
		await recordWorkspaceSweep(projectCwd, new Date());

		const h = await startSession();
		try {
			await h.runTools([
				fauxToolCall("workspace", { action: "release", name: "foreign-live" }),
				fauxToolCall("workspace", { action: "release", name: "foreign-dead" }),
			]);
			const [liveRes, deadRes] = h.toolResults().slice(-2);

			expect(liveRes!.isError).toBe(true);
			expect(liveRes!.text).toContain('Refusing to release workspace "foreign-live"');
			expect(liveRes!.text).toContain(`pid ${process.ppid}`);
			expect(fs.existsSync(liveForeign.path)).toBe(true);
			const untouched = (await readRegistry(projectCwd)).find((entry) => entry.name === "foreign-live");
			expect(untouched).toMatchObject({
				name: "foreign-live",
				sessionId: "remote-session",
				pid: process.ppid,
			});
			expect(untouched?.releasedAt).toBeUndefined();
			expect(untouched?.closedAt).toBeUndefined();

			expect(deadRes!.isError).toBe(false);
			expect(deadRes!.text).toContain('Released and removed workspace "foreign-dead"');
			expect(fs.existsSync(deadForeign.path)).toBe(false);

			// Programmatic API refuses with WorkspaceOwnershipError when sessionId is passed,
			// and preserves backwards-compatible release when sessionId is omitted.
			await expect(
				releaseAndCollectWorkspace({
					cwd: projectCwd,
					name: "foreign-live",
					sessionId: h.session.sessionId,
					activeSessionIds: sharedState().activeSessionIds,
					agentDir,
				}),
			).rejects.toThrow(WorkspaceOwnershipError);
			expect(fs.existsSync(liveForeign.path)).toBe(true);

			const compat = await releaseAndCollectWorkspace({
				cwd: projectCwd,
				name: "foreign-live",
				agentDir,
			});
			expect(compat?.removed).toBe(true);
			expect(fs.existsSync(liveForeign.path)).toBe(false);
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

function runChildRegistryScript(script: string, args: string[]): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script, ...args], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stderr });
		});
	});
}

describe("registry concurrency and locking", () => {
	it("serializes concurrent in-process touch, pin, close, sync, sweep, and release updates without lost writes or leftover locks", async () => {
		for (let i = 0; i < 4; i += 1) {
			await createOrTouchWorkspace(
				projectCwd,
				{ name: `pin-target-${i}`, sessionId: `pin-sess-${i}`, pid: process.pid },
				agentDir,
			);
			await createOrTouchWorkspace(
				projectCwd,
				{ name: `close-target-${i}`, sessionId: `close-sess-${i}`, pid: process.pid },
				agentDir,
			);
		}
		await createOrTouchWorkspace(projectCwd, { name: "gc-release-target" }, agentDir);

		const closeTime = new Date(5_000_000);
		const sweepTime = new Date(6_000_000);

		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 12; i += 1) {
			ops.push(
				touchWorkspace(
					projectCwd,
					{ name: `concurrent-${i}`, sessionId: `touch-sess-${i}`, pid: process.pid },
					agentDir,
				),
			);
		}
		for (let i = 0; i < 4; i += 1) {
			ops.push(setWorkspacePin(projectCwd, `pin-target-${i}`, true, agentDir));
			ops.push(markSessionWorkspacesClosed(projectCwd, `close-sess-${i}`, closeTime, agentDir));
		}
		ops.push(syncWorkspaces(projectCwd, undefined, agentDir));
		ops.push(recordWorkspaceSweep(projectCwd, sweepTime));
		ops.push(releaseAndCollectWorkspace({ cwd: projectCwd, name: "gc-release-target", agentDir }));

		await Promise.all(ops);

		const state = await readRegistryState(projectCwd);
		const byName = new Map(state.entries.map((entry) => [entry.name, entry]));

		for (let i = 0; i < 12; i += 1) {
			expect(byName.get(`concurrent-${i}`), `concurrent-${i}`).toMatchObject({
				name: `concurrent-${i}`,
				sessionId: `touch-sess-${i}`,
			});
		}
		for (let i = 0; i < 4; i += 1) {
			expect(byName.get(`pin-target-${i}`)?.pinned, `pin-target-${i}`).toBe(true);
			const closed = byName.get(`close-target-${i}`);
			expect(closed?.closedAt, `close-target-${i}`).toBe(closeTime.toISOString());
			expect(closed?.pid, `close-target-${i}`).toBeUndefined();
		}
		expect(byName.has("gc-release-target")).toBe(false);
		expect(state.lastSweepAt).toBe(sweepTime.toISOString());

		const leftoverFiles = fs
			.readdirSync(workspacesDir(projectCwd))
			.filter((name) => name.includes(".registry.lock") || name.endsWith(".tmp"));
		expect(leftoverFiles).toEqual([]);
	});

	it("serializes concurrent cross-process registry mutations without lost writes or leftover locks", async () => {
		await createOrTouchWorkspace(projectCwd, { name: "shared-pin", sessionId: "owner-pin", pid: process.pid }, agentDir);
		await createOrTouchWorkspace(
			projectCwd,
			{ name: "shared-close", sessionId: "owner-close", pid: process.pid },
			agentDir,
		);

		const workerScript = `
			const [cwd, agentDir, workerIdx] = process.argv.slice(1);
			const mod = await import(${JSON.stringify(registryModuleUrl)});
			const idx = Number(workerIdx);
			await mod.touchWorkspace(cwd, { name: \`proc-\${idx}-a\`, sessionId: \`ps-\${idx}\`, pid: process.pid }, agentDir);
			await mod.touchWorkspace(cwd, { name: \`proc-\${idx}-b\`, sessionId: \`ps-\${idx}\`, pid: process.pid }, agentDir);
			if (idx === 0) {
				await mod.setWorkspacePin(cwd, "shared-pin", true, agentDir);
			}
			if (idx === 1) {
				await mod.markSessionWorkspacesClosed(cwd, "owner-close", new Date(7_000_000), agentDir);
			}
		`;

		const results = await Promise.all(
			Array.from({ length: 6 }, (_, idx) => runChildRegistryScript(workerScript, [projectCwd, agentDir, String(idx)])),
		);
		for (const res of results) {
			expect(res.code, res.stderr).toBe(0);
		}

		const entries = await readRegistry(projectCwd);
		const byName = new Map(entries.map((entry) => [entry.name, entry]));
		for (let idx = 0; idx < 6; idx += 1) {
			expect(byName.has(`proc-${idx}-a`), `proc-${idx}-a`).toBe(true);
			expect(byName.has(`proc-${idx}-b`), `proc-${idx}-b`).toBe(true);
		}
		expect(byName.get("shared-pin")?.pinned).toBe(true);
		expect(byName.get("shared-close")?.closedAt).toBe(new Date(7_000_000).toISOString());

		const leftoverFiles = fs
			.readdirSync(workspacesDir(projectCwd))
			.filter((name) => name.includes(".registry.lock") || name.endsWith(".tmp"));
		expect(leftoverFiles).toEqual([]);
	});

	it("recovers stale locks (dead PID and expired age), supports nested re-entry, and verifies ownership before unlinking", async () => {
		const lockPath = registryLockFilePath(projectCwd);
		await mkdir(workspacesDir(projectCwd), { recursive: true });

		// 1. Dead-PID stale lock recovery.
		const exited = spawnSync(process.execPath, ["-e", ""]);
		const deadPid = exited.pid!;
		expect(isPidAlive(deadPid)).toBe(false);
		await writeFile(lockPath, JSON.stringify({ pid: deadPid, token: "dead-owner", ts: Date.now() }), "utf8");

		await touchWorkspace(projectCwd, { name: "after-dead-lock", sessionId: "s-dead" }, agentDir);
		expect((await readRegistry(projectCwd)).some((entry) => entry.name === "after-dead-lock")).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);

		// 2. Expired-age stale lock recovery even with a live PID.
		await writeFile(
			lockPath,
			JSON.stringify({ pid: process.ppid, token: "aged-owner", ts: Date.now() - 60_000 }),
			"utf8",
		);
		const nestedResult = await withRegistryLock(
			projectCwd,
			async () => {
				// Nested call on the same project must re-enter without deadlocking.
				return withRegistryLock(projectCwd, async () => "re-entered");
			},
			{ staleMs: 1_000, timeoutMs: 2_000 },
		);
		expect(nestedResult).toBe("re-entered");
		expect(fs.existsSync(lockPath)).toBe(false);

		// 3. Owner-verified release refuses to unlink a lock replaced by another owner.
		const replacementPayload = JSON.stringify({ pid: process.ppid, token: "foreign-replacement", ts: Date.now() });
		await withRegistryLock(projectCwd, async () => {
			expect(fs.existsSync(lockPath)).toBe(true);
			await writeFile(lockPath, replacementPayload, "utf8");
		});
		expect(fs.existsSync(lockPath)).toBe(true);
		expect(fs.readFileSync(lockPath, "utf8")).toBe(replacementPayload);
		fs.unlinkSync(lockPath);

		const leftoverFiles = fs
			.readdirSync(workspacesDir(projectCwd))
			.filter((name) => name.includes(".registry.lock") || name.endsWith(".tmp"));
		expect(leftoverFiles).toEqual([]);
	});
});
