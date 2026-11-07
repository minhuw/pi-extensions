import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
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
import { runWorkspaceGc } from "../gc.ts";
import workspaceExtension, {
	CHILD_SESSION_HOOKS,
	SESSION_LINK_TYPE,
	WORKSPACE_SHARED_KEY,
	type ChildSessionHook,
} from "../index.ts";
import {
	allowProjectPath,
	denyProjectPath,
	ensureWorkspacesClosure,
	evaluatePathAccess,
	extractBashExternalWriteTargets,
	isSubpath,
	readProjectPolicy,
	resolveCanonicalPath,
	workspacesDir,
} from "../policy.ts";
import {
	createOrTouchWorkspace,
	inspectWorkspaceSafety,
	markSessionWorkspacesClosed,
	pruneProjectsIndex,
	readProjectsIndex,
	readRegistry,
	registerProjectInIndex,
	releaseWorkspace,
	setWorkspacePin,
	syncWorkspaces,
} from "../registry.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initGitRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);
}

function commitFile(dir: string, relPath: string, content: string, message = `commit ${relPath}`): void {
	const full = path.join(dir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
	git(dir, ["add", relPath]);
	git(dir, ["commit", "-m", message]);
}

let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-test-"));
	projectCwd = path.join(sandboxRoot, "project");
	outsideDir = path.join(sandboxRoot, "outside");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(outsideDir, { recursive: true }),
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

describe("policy.ts — path canonicalization, access policy, and bash extraction", () => {
	it("creates <cwd>/.pi/workspaces/.gitignore with '*' without touching <cwd>/.gitignore", async () => {
		const wsDir = await ensureWorkspacesClosure(projectCwd);
		expect(wsDir).toBe(workspacesDir(projectCwd));
		const gitignore = await readFile(path.join(wsDir, ".gitignore"), "utf8");
		expect(gitignore).toBe("*\n");
		expect(fs.existsSync(path.join(projectCwd, ".gitignore"))).toBe(false);
	});

	it("expands ~ and $HOME and resolves symlinks (including broken symlinks) escaping <cwd>", async () => {
		expect(resolveCanonicalPath("~/some-test-dir")).toBe(
			path.join(resolveCanonicalPath(os.homedir()), "some-test-dir"),
		);
		expect(resolveCanonicalPath("$HOME/some-test-dir")).toBe(
			path.join(resolveCanonicalPath(os.homedir()), "some-test-dir"),
		);

		const symlinkPath = path.join(projectCwd, "escape-link");
		await symlink(outsideDir, symlinkPath);
		const resolvedViaSymlink = resolveCanonicalPath(path.join(symlinkPath, "nested", "file.txt"), projectCwd);
		expect(resolvedViaSymlink).toBe(path.join(resolveCanonicalPath(outsideDir), "nested", "file.txt"));
		expect(isSubpath(projectCwd, resolvedViaSymlink)).toBe(false);

		const brokenSymlink = path.join(projectCwd, "broken-escape");
		await symlink(path.join(outsideDir, "non-existent-target"), brokenSymlink);
		const resolvedBroken = resolveCanonicalPath(path.join(brokenSymlink, "file.txt"), projectCwd);
		expect(resolvedBroken).toBe(
			path.join(resolveCanonicalPath(outsideDir), "non-existent-target", "file.txt"),
		);
		expect(isSubpath(projectCwd, resolvedBroken)).toBe(false);
	});

	it("evaluates path access for <cwd>, .pi/workspaces, /tmp, symlinks, and allowed paths", async () => {
		expect(evaluatePathAccess({ targetPath: "src/index.ts", cwd: projectCwd }).allowed).toBe(true);
		expect(
			evaluatePathAccess({ targetPath: ".pi/workspaces/exp1/repo/file.ts", cwd: projectCwd }).allowed,
		).toBe(true);
		expect(evaluatePathAccess({ targetPath: "/tmp/ephemeral-artifact.json", cwd: projectCwd }).allowed).toBe(
			true,
		);

		const deniedSibling = evaluatePathAccess({
			targetPath: path.join(outsideDir, "secret.txt"),
			cwd: projectCwd,
		});
		expect(deniedSibling.allowed).toBe(false);
		expect(deniedSibling.reason).toContain("outside the project working directory");

		const deniedHome = evaluatePathAccess({
			targetPath: "~/projects/leaked-clone",
			cwd: projectCwd,
		});
		expect(deniedHome.allowed).toBe(false);

		const symlinkPath = path.join(projectCwd, "link-out");
		await symlink(outsideDir, symlinkPath);
		expect(
			evaluatePathAccess({
				targetPath: path.join(symlinkPath, "escape.txt"),
				cwd: projectCwd,
			}).allowed,
		).toBe(false);

		// Allow project path persists to policy.json and grants access
		const canonicalOutside = await allowProjectPath(projectCwd, outsideDir);
		const policy = await readProjectPolicy(projectCwd);
		expect(policy.allowedPaths).toContain(canonicalOutside);
		expect(
			evaluatePathAccess({
				targetPath: path.join(outsideDir, "secret.txt"),
				cwd: projectCwd,
				projectAllowed: policy.allowedPaths,
			}).allowed,
		).toBe(true);

		// Deny project path revokes access
		await denyProjectPath(projectCwd, outsideDir);
		const updatedPolicy = await readProjectPolicy(projectCwd);
		expect(updatedPolicy.allowedPaths).not.toContain(canonicalOutside);
	});

	it("extracts external write targets from bash commands while permitting internal and /tmp writes", () => {
		expect(extractBashExternalWriteTargets("mkdir -p ~/projects/new-repo", projectCwd)).toEqual([
			resolveCanonicalPath("~/projects/new-repo", projectCwd),
		]);

		expect(
			extractBashExternalWriteTargets(
				`git clone https://github.com/example/repo.git ${outsideDir}/repo`,
				projectCwd,
			),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "repo")]);

		expect(
			extractBashExternalWriteTargets("git worktree add ../wt-leak HEAD", projectCwd),
		).toEqual([path.join(resolveCanonicalPath(sandboxRoot), "wt-leak")]);

		expect(
			extractBashExternalWriteTargets(`cd ${outsideDir} && touch created.txt`, projectCwd),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "created.txt")]);

		expect(
			extractBashExternalWriteTargets(`echo "hello" > ${outsideDir}/out.log`, projectCwd),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "out.log")]);

		// Internal and /tmp writes produce no external targets
		expect(
			extractBashExternalWriteTargets(
				"mkdir -p .pi/workspaces/exp1 && git clone https://github.com/example/repo.git .pi/workspaces/exp1/repo",
				projectCwd,
			),
		).toEqual([]);
		expect(extractBashExternalWriteTargets("echo 'temp' > /tmp/pi-temp-test.txt", projectCwd)).toEqual([]);
		expect(extractBashExternalWriteTargets(`ls -la ${outsideDir} && git -C ${outsideDir} status`, projectCwd)).toEqual([]);
	});
});

describe("registry.ts & gc.ts — workspace lifecycle, safety classification, and garbage collection", () => {
	it("tracks workspaces, classifies PINNED / ACTIVE / SAFE / REVIEW accurately, and runs GC", async () => {
		// 1. Empty workspace -> SAFE
		const emptyEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "empty-ws", purpose: "empty scratch" },
			agentDir,
		);
		const emptyReport = await inspectWorkspaceSafety(emptyEntry);
		expect(emptyReport.status).toBe("SAFE");
		expect(emptyReport.reasons).toEqual(["empty workspace directory"]);

		// 2. Pinned workspace -> PINNED
		const pinnedEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "pinned-ws", pinned: true },
			agentDir,
		);
		await writeFile(path.join(pinnedEntry.path, "important.txt"), "keep me", "utf8");
		const pinnedReport = await inspectWorkspaceSafety(pinnedEntry);
		expect(pinnedReport.status).toBe("PINNED");
		expect(pinnedReport.reasons).toEqual(["pinned"]);

		// 3. Active workspace by sessionId, PID, and TTL -> ACTIVE
		const activeSessionEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "active-session-ws", sessionId: "sess-live" },
			agentDir,
		);
		expect(
			(await inspectWorkspaceSafety(activeSessionEntry, { activeSessionIds: new Set(["sess-live"]) })).status,
		).toBe("ACTIVE");

		const activePidEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "active-pid-ws", pid: process.pid },
			agentDir,
		);
		const pidReport = await inspectWorkspaceSafety(activePidEntry);
		expect(pidReport.status).toBe("ACTIVE");
		expect(pidReport.reasons[0]).toContain(`owning process (pid ${process.pid}) is still running`);

		const ttlEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "ttl-ws", ttlMs: 3600_000, now: new Date(1000) },
			agentDir,
		);
		const ttlReport = await inspectWorkspaceSafety(ttlEntry, { now: 2000 });
		expect(ttlReport.status).toBe("ACTIVE");
		expect(ttlReport.reasons).toEqual(["within retention TTL"]);

		// Releasing an active workspace makes it eligible for content inspection
		const released = await releaseWorkspace(projectCwd, "active-pid-ws", undefined, agentDir);
		expect(released?.releasedAt).toBeDefined();
		expect((await inspectWorkspaceSafety(released!)).status).toBe("SAFE");

		// 4. Non-git files -> REVIEW
		const nonGitEntry = await createOrTouchWorkspace(projectCwd, { name: "non-git-ws" }, agentDir);
		await writeFile(path.join(nonGitEntry.path, "notes.md"), "# draft\n", "utf8");
		const nonGitReport = await inspectWorkspaceSafety(nonGitEntry);
		expect(nonGitReport.status).toBe("REVIEW");
		expect(nonGitReport.reasons).toContain("contains non-git files");

		// 5. Local git repo with no remote -> REVIEW
		const localGitEntry = await createOrTouchWorkspace(projectCwd, { name: "local-git-ws" }, agentDir);
		initGitRepo(localGitEntry.path);
		commitFile(localGitEntry.path, "README.md", "local only\n");
		const localGitReport = await inspectWorkspaceSafety(localGitEntry);
		expect(localGitReport.status).toBe("REVIEW");
		expect(localGitReport.reasons).toContain("local git repository with no remote");

		// 6. Remote clone with all commits pushed -> SAFE, then dirty/stash/unpushed -> REVIEW
		const bareRemote = path.join(sandboxRoot, "remote-origin.git");
		git(sandboxRoot, ["init", "--bare", bareRemote]);
		const seedRepo = path.join(sandboxRoot, "seed-repo");
		initGitRepo(seedRepo);
		commitFile(seedRepo, "README.md", "seeded remote\n");
		git(seedRepo, ["remote", "add", "origin", bareRemote]);
		git(seedRepo, ["push", "-u", "origin", "HEAD"]);

		const cloneEntry = await createOrTouchWorkspace(projectCwd, { name: "clean-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, path.join(cloneEntry.path, "repo")]);

		const cleanCloneReport = await inspectWorkspaceSafety(cloneEntry);
		expect(cleanCloneReport.status).toBe("SAFE");
		expect(cleanCloneReport.reasons).toEqual(["clean git workspace with all commits backed up"]);

		// Dirty clone -> REVIEW
		const dirtyCloneEntry = await createOrTouchWorkspace(projectCwd, { name: "dirty-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, dirtyCloneEntry.path]);
		await writeFile(path.join(dirtyCloneEntry.path, "untracked.txt"), "dirty\n", "utf8");
		const dirtyCloneReport = await inspectWorkspaceSafety(dirtyCloneEntry);
		expect(dirtyCloneReport.status).toBe("REVIEW");
		expect(dirtyCloneReport.reasons).toContain("uncommitted or untracked changes");

		// Unpushed commit -> REVIEW
		const unpushedEntry = await createOrTouchWorkspace(projectCwd, { name: "unpushed-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, unpushedEntry.path]);
		git(unpushedEntry.path, ["config", "user.email", "test@example.com"]);
		git(unpushedEntry.path, ["config", "user.name", "Test User"]);
		commitFile(unpushedEntry.path, "new-feature.ts", "export const x = 1;\n");
		const unpushedReport = await inspectWorkspaceSafety(unpushedEntry);
		expect(unpushedReport.status).toBe("REVIEW");
		expect(unpushedReport.reasons).toContain("unpushed local commits");

		// Stash present -> REVIEW
		const stashEntry = await createOrTouchWorkspace(projectCwd, { name: "stash-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, stashEntry.path]);
		git(stashEntry.path, ["config", "user.email", "test@example.com"]);
		git(stashEntry.path, ["config", "user.name", "Test User"]);
		await writeFile(path.join(stashEntry.path, "README.md"), "modified for stash\n", "utf8");
		git(stashEntry.path, ["stash", "push", "-m", "wip"]);
		const stashReport = await inspectWorkspaceSafety(stashEntry);
		expect(stashReport.status).toBe("REVIEW");
		expect(stashReport.reasons).toContain("git stash entries present");

		// 7. Linked git worktrees: clean worktree -> SAFE, unmerged commit -> REVIEW
		initGitRepo(projectCwd);
		commitFile(projectCwd, "main.ts", "console.log('main');\n");

		const cleanWtPath = path.join(workspacesDir(projectCwd), "clean-wt");
		git(projectCwd, ["worktree", "add", "-b", "clean-wt-branch", cleanWtPath, "HEAD"]);
		const syncedAfterWt = await syncWorkspaces(projectCwd, undefined, agentDir);
		const cleanWtEntry = syncedAfterWt.find((e) => e.name === "clean-wt")!;
		expect(cleanWtEntry).toBeDefined();
		const cleanWtReport = await inspectWorkspaceSafety(cleanWtEntry);
		expect(cleanWtReport.isWorktree).toBe(true);
		expect(cleanWtReport.worktreeMainRepo).toBe(resolveCanonicalPath(projectCwd));
		expect(cleanWtReport.status).toBe("SAFE");

		const unmergedWtPath = path.join(workspacesDir(projectCwd), "unmerged-wt");
		git(projectCwd, ["worktree", "add", "-b", "unmerged-wt-branch", unmergedWtPath, "HEAD"]);
		git(unmergedWtPath, ["config", "user.email", "test@example.com"]);
		git(unmergedWtPath, ["config", "user.name", "Test User"]);
		commitFile(unmergedWtPath, "wt-only.ts", "export const wt = true;\n");
		const unmergedWtEntry = (await syncWorkspaces(projectCwd, undefined, agentDir)).find(
			(e) => e.name === "unmerged-wt",
		)!;
		const unmergedWtReport = await inspectWorkspaceSafety(unmergedWtEntry);
		expect(unmergedWtReport.status).toBe("REVIEW");
		expect(unmergedWtReport.reasons).toContain("unmerged or unpushed commits in worktree");

		// 8. Run GC dry-run first -> nothing deleted on disk
		const dryGc = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
			dryRun: true,
			activeSessionIds: new Set(["sess-live"]),
			now: 2000,
		});
		expect(dryGc.dryRun).toBe(true);
		expect(dryGc.removed.map((r) => r.entry.name).sort()).toEqual(
			["active-pid-ws", "clean-clone-ws", "clean-wt", "empty-ws"].sort(),
		);
		expect(fs.existsSync(emptyEntry.path)).toBe(true);
		expect(fs.existsSync(cleanWtPath)).toBe(true);

		// 9. Run real GC with confirmReview callback that pins "non-git-ws", removes "dirty-clone-ws", and skips others
		const realGc = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
			activeSessionIds: new Set(["sess-live"]),
			now: 2000,
			confirmReview: async (report) => {
				if (report.entry.name === "non-git-ws") return "pin";
				if (report.entry.name === "dirty-clone-ws") return "remove";
				return "skip";
			},
		});

		expect(realGc.removed.map((r) => r.entry.name).sort()).toEqual(
			["active-pid-ws", "clean-clone-ws", "clean-wt", "dirty-clone-ws", "empty-ws"].sort(),
		);
		expect(realGc.pinned.map((r) => r.entry.name)).toEqual(["non-git-ws"]);
		expect(fs.existsSync(emptyEntry.path)).toBe(false);
		expect(fs.existsSync(cleanWtPath)).toBe(false);
		expect(fs.existsSync(dirtyCloneEntry.path)).toBe(false);
		expect(fs.existsSync(nonGitEntry.path)).toBe(true);
		// Verify git worktree metadata was cleanly removed from main repo
		expect(git(projectCwd, ["worktree", "list"])).not.toContain("clean-wt");
	});

	it("prunes missing project closures from <agentDir>/workspaces-index.json", async () => {
		const ephemeralProject = path.join(sandboxRoot, "ephemeral-project");
		await createOrTouchWorkspace(ephemeralProject, { name: "temp-ws" }, agentDir);
		await createOrTouchWorkspace(projectCwd, { name: "keep-ws" }, agentDir);

		const beforeIndex = await readProjectsIndex(agentDir);
		expect(beforeIndex).toContain(resolveCanonicalPath(ephemeralProject));
		expect(beforeIndex).toContain(resolveCanonicalPath(projectCwd));

		await rm(ephemeralProject, { recursive: true, force: true });
		const pruned = await pruneProjectsIndex(agentDir);
		expect(pruned.removed).toEqual([resolveCanonicalPath(ephemeralProject)]);
		expect(pruned.kept).toEqual([resolveCanonicalPath(projectCwd)]);

		// Also verify markSessionWorkspacesClosed and setWorkspacePin
		await createOrTouchWorkspace(projectCwd, { name: "sess-ws", sessionId: "s-close" }, agentDir);
		await markSessionWorkspacesClosed(projectCwd, "s-close", new Date(5000), agentDir);
		const reg = await readRegistry(projectCwd);
		expect(reg.find((e) => e.name === "sess-ws")?.closedAt).toBe(new Date(5000).toISOString());

		const pinned = await setWorkspacePin(projectCwd, "keep-ws", true, agentDir);
		expect(pinned?.pinned).toBe(true);
		await registerProjectInIndex(projectCwd, agentDir);

		// Rejects invalid workspace names
		await expect(createOrTouchWorkspace(projectCwd, { name: "../escape" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(createOrTouchWorkspace(projectCwd, { name: "nested/name" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(createOrTouchWorkspace(projectCwd, { name: ".hidden" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);

		// Detects non-git files outside a nested git root at depth 1
		const mixedWs = await createOrTouchWorkspace(projectCwd, { name: "mixed-ws" }, agentDir);
		const bareOrigin = path.join(sandboxRoot, "mixed-origin.git");
		git(sandboxRoot, ["init", "--bare", bareOrigin]);
		const seed = path.join(sandboxRoot, "mixed-seed");
		initGitRepo(seed);
		commitFile(seed, "index.ts", "export default 1;\n");
		git(seed, ["remote", "add", "origin", bareOrigin]);
		git(seed, ["push", "-u", "origin", "HEAD"]);
		git(projectCwd, ["clone", bareOrigin, path.join(mixedWs.path, "repo")]);
		await writeFile(path.join(mixedWs.path, "stray.txt"), "outside git repo\n", "utf8");
		const mixedReport = await inspectWorkspaceSafety(mixedWs);
		expect(mixedReport.status).toBe("REVIEW");
		expect(mixedReport.reasons).toContain("contains files outside git repositories");
	});
});

describe("index.ts — Pi session integration, tool_call enforcement, child propagation, tool & /workspace command", () => {
	function createRecordingUi(selectHandler?: (title: string, options: string[]) => Promise<string | undefined>) {
		const notes: { message: string; type?: string }[] = [];
		const prompts: { title: string; options: string[] }[] = [];
		const noop = () => {};
		const context = {
			select: async (title: string, options: string[]) => {
				prompts.push({ title, options });
				return selectHandler ? selectHandler(title, options) : undefined;
			},
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
		return { notes, prompts, context };
	}

	async function startPiSession(options?: {
		cwd?: string;
		mode?: "tui" | "rpc" | "print" | "json";
		bindAsChild?: boolean;
		sessionManager?: SessionManager;
		selectHandler?: (title: string, opts: string[]) => Promise<string | undefined>;
		extraFactories?: ((pi: any) => void)[];
	}) {
		const sessionCwd = options?.cwd ?? projectCwd;
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			api: "workspace-test-api",
			provider: "workspace-test",
			models: [{ id: "test" }],
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false, keepRecentTokens: 1 },
		});
		const ui = createRecordingUi(options?.selectHandler);
		const capturedSystems: string[] = [];

		faux.setResponses([
			({ messages }) => {
				capturedSystems.push(getCurrentSystemPrompt(messages));
				return fauxAssistantMessage("ok");
			},
		]);

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
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.provider);
						},
						...(options?.extraFactories ?? []),
					],
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
			cwd: sessionCwd,
			agentDir,
			sessionManager: options?.sessionManager ?? SessionManager.create(sessionCwd, sessionDir),
		});

		const errors: unknown[] = [];
		const bind = () =>
			runtime.session.bindExtensions(
				options?.bindAsChild
					? {}
					: {
							mode: options?.mode ?? "rpc",
							uiContext: ui.context,
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

		return {
			runtime,
			session: runtime.session,
			faux,
			ui,
			errors,
			capturedSystems,
			dispose: () => runtime.dispose(),
		};
	}

	it("AC-1 initializes .pi/workspaces/.gitignore, injects the workspace system prompt section, and manages child-session hooks", async () => {
		const h = await startPiSession();
		try {
			// .pi/workspaces/.gitignore exists with *
			const gitignore = await readFile(path.join(workspacesDir(projectCwd), ".gitignore"), "utf8");
			expect(gitignore).toBe("*\n");

			// Child session hook is registered while session is open
			const hooks = [
				...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
			];
			expect(hooks.some((hook) => hook.name === "workspace" && typeof hook.extensionFactory === "function")).toBe(
				true,
			);

			await h.session.prompt("hello");
			expect(h.capturedSystems[0]).toContain("<workspace>");
			expect(h.capturedSystems[0]).toContain(".pi/workspaces/<name>");
			expect(h.capturedSystems[0]).toContain("/tmp");
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}

		// Hook is removed when the last session shuts down
		const remainingHooks = [
			...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
		];
		expect(remainingHooks.some((hook) => hook.name === "workspace")).toBe(false);
	});

	it("AC-2 blocks external writes in non-interactive/child sessions and prompts in interactive sessions with inheritance", async () => {
		let nextChoice: string | undefined = "Deny";
		const parent = await startPiSession({
			selectHandler: async () => nextChoice,
		});

		try {
			const extFile = path.join(outsideDir, "blocked.txt");

			// 1. Deny in interactive session blocks the write
			parent.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: extFile, content: "nope" })]),
				fauxAssistantMessage("blocked as expected"),
			]);
			await parent.session.prompt("try writing outside");
			expect(parent.ui.prompts.length).toBe(1);
			expect(fs.existsSync(extFile)).toBe(false);

			// 2. Allow for this session permits the write in parent AND in a child session
			nextChoice = "Allow for this session";
			const allowedFile = path.join(outsideDir, "session-allowed.txt");
			parent.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: allowedFile, content: "parent wrote this" })]),
				fauxAssistantMessage("wrote after session approval"),
			]);
			await parent.session.prompt("write with session allow");
			expect(fs.existsSync(allowedFile)).toBe(true);

			// Child session (loaded both by path and via CHILD_SESSION_HOOKS) inherits session allowlist for outsideDir
			// and blocks a different unapproved external directory without prompting
			const hooks = [
				...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
			];
			const childManager = SessionManager.create(projectCwd, sessionDir, {
				parentSession: parent.session.sessionFile,
			});
			childManager.appendCustomEntry(SESSION_LINK_TYPE, {
				kind: "subagent",
				parentSessionId: parent.session.sessionId,
				parentSessionFile: parent.session.sessionFile,
			});

			const child = await startPiSession({
				sessionManager: childManager,
				bindAsChild: true,
				extraFactories: hooks.map((h) => h.extensionFactory),
			});
			try {
				const childInheritedFile = path.join(outsideDir, "child-inherited.txt");
				const otherOutside = path.join(sandboxRoot, "unapproved-other", "blocked.txt");

				child.faux.setResponses([
					fauxAssistantMessage([
						fauxToolCall("write", { path: childInheritedFile, content: "child ok" }),
						fauxToolCall("write", { path: otherOutside, content: "child blocked" }),
					]),
					fauxAssistantMessage("done child"),
				]);
				await child.session.prompt("child test");
				expect(fs.existsSync(childInheritedFile)).toBe(true);
				expect(fs.existsSync(otherOutside)).toBe(false);
				expect(child.errors).toEqual([]);
			} finally {
				await child.dispose();
			}
		} finally {
			await parent.dispose();
		}
	});

	it("AC-3 & AC-4 supports the workspace tool and /workspace commands (list, allow, deny, pin, unpin, gc)", async () => {
		let gcChoice: string | undefined = "Keep for now";
		const h = await startPiSession({
			selectHandler: async () => gcChoice,
		});

		try {
			// Use the LLM `workspace` tool to create, pin, unpin, list, and release a workspace
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("workspace", {
						action: "create",
						name: "exp-alpha",
						purpose: "benchmarking",
						ttlHours: 0,
					}),
				]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "list" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "release", name: "exp-alpha" })]),
				fauxAssistantMessage("workspace lifecycle complete"),
			]);
			await h.session.prompt("create and release workspace");

			const entries = await readRegistry(projectCwd);
			expect(entries.some((e) => e.name === "exp-alpha")).toBe(true);

			// Create a dirty workspace that requires REVIEW
			const reviewEntry = await createOrTouchWorkspace(
				projectCwd,
				{ name: "exp-dirty", purpose: "has notes" },
				agentDir,
			);
			await writeFile(path.join(reviewEntry.path, "draft.txt"), "unfinished work\n", "utf8");

			// Test /workspace list
			await h.session.prompt("/workspace list");
			expect(h.ui.notes.at(-1)?.message).toContain("exp-alpha: SAFE");
			expect(h.ui.notes.at(-1)?.message).toContain("exp-dirty: REVIEW");

			// Test /workspace allow and /workspace deny
			await h.session.prompt(`/workspace allow ${outsideDir}`);
			expect(h.ui.notes.at(-1)?.message).toContain("Allowed external path:");
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toContain(resolveCanonicalPath(outsideDir));

			await h.session.prompt(`/workspace deny ${outsideDir}`);
			expect(h.ui.notes.at(-1)?.message).toContain("Denied external path:");
			expect((await readProjectPolicy(projectCwd)).allowedPaths).not.toContain(resolveCanonicalPath(outsideDir));

			// Test /workspace pin and /workspace unpin
			await h.session.prompt("/workspace pin exp-alpha");
			expect(h.ui.notes.at(-1)?.message).toContain('Pinned workspace "exp-alpha"');
			expect((await readRegistry(projectCwd)).find((e) => e.name === "exp-alpha")?.pinned).toBe(true);

			await h.session.prompt("/workspace unpin exp-alpha");
			expect(h.ui.notes.at(-1)?.message).toContain('Unpinned workspace "exp-alpha"');
			expect((await readRegistry(projectCwd)).find((e) => e.name === "exp-alpha")?.pinned).toBe(false);

			// Test /workspace gc --dry-run
			await h.session.prompt("/workspace gc --dry-run");
			expect(h.ui.notes.at(-1)?.message).toContain("[Dry run] Workspace GC complete");
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-alpha"))).toBe(true);

			// Test /workspace gc (interactive prompt pins exp-dirty and removes SAFE exp-alpha)
			gcChoice = "Pin permanently";
			await h.session.prompt("/workspace gc");
			expect(h.ui.notes.at(-1)?.message).toContain("Removed (1): exp-alpha");
			expect(h.ui.notes.at(-1)?.message).toContain("Newly pinned (1): exp-dirty");
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-alpha"))).toBe(false);
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-dirty"))).toBe(true);

			// Auto-records workspace in .registry.json when write or bash touches .pi/workspaces/<name>/...
			const autoFile = path.join(workspacesDir(projectCwd), "auto-tracked", "hello.txt");
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: autoFile, content: "auto tracked!" })]),
				fauxAssistantMessage("wrote to auto-tracked"),
			]);
			await h.session.prompt("write into .pi/workspaces/auto-tracked");
			expect(fs.existsSync(autoFile)).toBe(true);
			const regAfterAuto = await readRegistry(projectCwd);
			expect(regAfterAuto.some((e) => e.name === "auto-tracked")).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("deduplicates binding to the same pi instance via WeakSet", () => {
		let toolCount = 0;
		let commandCount = 0;
		const fakePi = {
			on: () => () => {},
			registerTool: () => {
				toolCount++;
			},
			registerCommand: () => {
				commandCount++;
			},
		} as any;
		workspaceExtension(fakePi);
		workspaceExtension(fakePi);
		expect(toolCount).toBe(1);
		expect(commandCount).toBe(1);
	});

	it("is registered in package.json before pika and wired into npm test", async () => {
		const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
		const manifest = JSON.parse(await readFile(pkgPath, "utf8")) as {
			scripts: Record<string, string>;
			pi: { extensions: string[] };
		};
		expect(manifest.scripts["test:workspace"]).toBe("vitest run extensions/workspace");
		expect(manifest.scripts.test).toContain("npm run test:molt && npm run test:language &&");
		expect(manifest.scripts.test).toContain("npm run test:workspace");
		const exts = manifest.pi.extensions;
		expect(exts).toContain("./extensions/workspace/index.ts");
		expect(exts.at(-1)).toBe("./extensions/pika/index.ts");
		expect(exts.indexOf("./extensions/workspace/index.ts")).toBe(exts.indexOf("./extensions/pika/index.ts") - 1);
	});
});
