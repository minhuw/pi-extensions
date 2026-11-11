import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { loadRoles } from "../../herder/src/agents/roles.ts";
import { createPiAgentRunner } from "../../herder/src/agents/session.ts";
import { cleanupRun } from "../../herder/src/deliver/deliver.ts";
import { baseRef, integrationRef, worktreePath } from "../../herder/src/run/paths.ts";
import { createRun } from "../../herder/src/run/store.ts";
import { createStepExecutor } from "../../herder/src/steps/executor.ts";
import { openVcs } from "../../herder/src/vcs/git.ts";
import { createGitFixture, type GitFixture } from "../../herder/tests/support/git-fixture.ts";
import { SHARED_BACKEND_KEY, SidecarFffBackend } from "../client.ts";
import { CHILD_SESSION_HOOKS, type ChildSessionHook, createFffExtension } from "../index.ts";

const tempDirs: string[] = [];
const fixtures: GitFixture[] = [];
const backends: SidecarFffBackend[] = [];
const trackedPids = new Set<number>();

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	return !isPidAlive(pid);
}

function createParentFffHost(options: {
	backend: SidecarFffBackend;
	agentDir: string;
	flags: Record<string, boolean | string>;
	cwd: string;
}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let activeTools = ["read", "bash", "grep", "find", "ls"];
	const flags = new Map<string, boolean | string>(Object.entries(options.flags));

	const ctx = {
		cwd: options.cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: { getEntries: () => [] },
		ui: {
			notify: () => {},
			setStatus: () => {},
			addAutocompleteProvider: () => {},
		},
	} as unknown as ExtensionContext;

	const pi = {
		on(event: string, handler: (ev: unknown, context: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool() {},
		registerCommand() {},
		registerFlag(name: string, spec: { default?: boolean | string }) {
			if (spec.default !== undefined && !flags.has(name)) {
				flags.set(name, spec.default);
			}
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;

	createFffExtension({ backend: options.backend, agentDir: options.agentDir })(pi);

	let started = false;
	return {
		async start() {
			for (const fn of handlers.get("session_start") ?? []) {
				await fn({ reason: "startup" }, ctx);
			}
			started = true;
		},
		async shutdown() {
			if (!started) return;
			started = false;
			for (const fn of handlers.get("session_shutdown") ?? []) {
				await fn({ reason: "quit" }, ctx);
			}
		},
	};
}

function userPromptText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
	const first = messages.find((m) => m.role === "user");
	if (!first) return "";
	if (typeof first.content === "string") return first.content;
	if (!Array.isArray(first.content)) return "";
	return first.content
		.map((part) =>
			part && typeof part === "object" && "text" in part && typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

function toolResultsById(
	messages: ReadonlyArray<{ role: string; toolCallId?: string; content?: unknown }>,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
		const text = Array.isArray(msg.content)
			? msg.content
					.map((part) =>
						part && typeof part === "object" && "text" in part && typeof part.text === "string"
							? part.text
							: "",
					)
					.join("")
			: "";
		out.set(msg.toolCallId, text);
	}
	return out;
}

function readStepSessionCwds(sessionsDir: string): Map<string, string> {
	const byStepId = new Map<string, string>();
	for (const file of readdirSync(sessionsDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const entries = readFileSync(join(sessionsDir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const header = entries.find((e) => e.type === "session");
		const link = entries.find(
			(e) => e.type === "custom" && e.customType === "pi-extensions.session-link",
		);
		const stepId = (
			link?.data as { herder?: { stepId?: unknown } } | undefined
		)?.herder?.stepId;
		if (typeof stepId === "string" && typeof header?.cwd === "string") {
			byStepId.set(stepId, realpathSync(header.cwd));
		}
	}
	return byStepId;
}

afterEach(async () => {
	for (const backend of backends.splice(0)) {
		const pid = backend.getPid();
		if (pid !== undefined) trackedPids.add(pid);
		await backend.dispose();
	}
	for (const pid of trackedPids) {
		if (isPidAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		expect(await waitForPidExit(pid)).toBe(true);
	}
	trackedPids.clear();

	for (const fixture of fixtures.splice(0)) {
		fixture.cleanup();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("wires fff into Herder explorer/worker worktrees via child-session-hooks, rescans rw-0 on HEAD changes, and prunes cleaned worktrees", async () => {
	const sandboxDir = realpathSync(mkdtempSync(join(tmpdir(), "fff-herder-e2e-")));
	tempDirs.push(sandboxDir);
	const agentDir = join(sandboxDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const frecencyDbPath = join(agentDir, "fff", "frecency");
	const historyDbPath = join(agentDir, "fff", "history");

	const fixture = createGitFixture({
		"src/alpha.ts": "export const SHARED_EXPLORER_VALUE = 'herder-ro-shared-777';\n",
		"src/beta.ts": "export const BETA_VALUE = 42;\n",
	});
	fixtures.push(fixture);

	const vcs = openVcs(fixture.dir);
	const commit1 = fixture.head();
	const store = createRun(vcs.commonDir(), {
		title: "fff-herder-worktree-e2e",
		base: commit1,
		repo: fixture.dir,
	});
	vcs.updateRef(baseRef(store.runId), commit1, null);
	vcs.updateRef(integrationRef(store.runId), commit1, null);

	const backend = new SidecarFffBackend();
	backends.push(backend);

	const globalStore = globalThis as unknown as Record<symbol, unknown>;
	const prevSharedBackend = globalStore[SHARED_BACKEND_KEY];
	const prevChildHooks = globalStore[CHILD_SESSION_HOOKS];
	globalStore[SHARED_BACKEND_KEY] = backend;
	delete globalStore[CHILD_SESSION_HOOKS];

	const parentHost = createParentFffHost({
		backend,
		agentDir,
		cwd: homedir(),
		flags: {
			"fff-enable-home-scan": false,
			"fff-warn-home-scan": false,
			"fff-frecency-db": frecencyDbPath,
			"fff-history-db": historyDbPath,
		},
	});

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: "fff-herder-faux-api",
		provider: "fff-herder-faux",
		models: [{ id: "main", reasoning: true }],
	});
	runtime.registerNativeProvider(faux.provider);

	let releaseExplorerBarrier = () => {};
	try {
		await parentHost.start();
		const registeredHooks = [
			...((globalStore[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined) ?? []),
		];
		expect(registeredHooks.map((h) => h.name)).toContain("fff");

		const roles = loadRoles({ overrideDir: join(agentDir, "herder", "agents") });
		const runner = createPiAgentRunner({
			modelRuntime: runtime,
			agentDir,
			inheritModel: () => faux.getModel("main"),
			inheritThinking: () => "low",
			settings: () =>
				SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			sessions: {
				dir: store.paths.sessions,
				runId: store.runId,
				repo: "fixture",
				parentSessionId: "parent-main",
			},
		});
		const executor = createStepExecutor({
			runId: store.runId,
			store,
			vcs,
			runner,
			roles,
			checks: [],
		});

		// Synchronize both concurrent explorers after their FFF tool calls complete so both
		// hold active leases on the same ro-<sha12> worktree simultaneously.
		let explorersReady = 0;
		let signalExplorersReady = () => {};
		const bothExplorersReady = new Promise<void>((resolve) => {
			signalExplorersReady = resolve;
		});
		const explorerBarrier = new Promise<void>((resolve) => {
			releaseExplorerBarrier = resolve;
		});

		const explorerToolsSeen: string[][] = [];
		const outputs: Record<string, string> = {};

		const scriptedStep: FauxResponseStep = async (context) => {
			const prompt = userPromptText(context.messages);
			const results = toolResultsById(
				context.messages as ReadonlyArray<{
					role: string;
					toolCallId?: string;
					content?: unknown;
				}>,
			);
			const activeTools = getCurrentTools(context.messages)
				.map((t) => t.name)
				.sort();

			if (prompt.includes("EXPLORER_STEP_FIND")) {
				if (!results.has("exp-find-call")) {
					explorerToolsSeen.push(activeTools);
					return fauxAssistantMessage([
						fauxToolCall("fffind", { pattern: "alpha.ts" }, { id: "exp-find-call" }),
					]);
				}
				outputs.explorerFind = results.get("exp-find-call") ?? "";
				explorersReady++;
				if (explorersReady === 2) signalExplorersReady();
				await explorerBarrier;
				return fauxAssistantMessage("explorer find ok");
			}

			if (prompt.includes("EXPLORER_STEP_GREP")) {
				if (!results.has("exp-grep-call")) {
					explorerToolsSeen.push(activeTools);
					return fauxAssistantMessage([
						fauxToolCall(
							"ffgrep",
							{ pattern: "herder-ro-shared-777" },
							{ id: "exp-grep-call" },
						),
					]);
				}
				outputs.explorerGrep = results.get("exp-grep-call") ?? "";
				explorersReady++;
				if (explorersReady === 2) signalExplorersReady();
				await explorerBarrier;
				return fauxAssistantMessage("explorer grep ok");
			}

			if (prompt.includes("WORKER_STEP_1")) {
				if (!results.has("w1-find-call")) {
					return fauxAssistantMessage([
						fauxToolCall("fffind", { pattern: "commit2-added.ts" }, { id: "w1-find-call" }),
						fauxToolCall(
							"write",
							{
								path: "src/step1-scratch.ts",
								content: "export const STEP1_SCRATCH = 1;\n",
							},
							{ id: "w1-write-call" },
						),
					]);
				}
				outputs.worker1Find = results.get("w1-find-call") ?? "";
				return fauxAssistantMessage("worker 1 complete");
			}

			if (prompt.includes("WORKER_STEP_2")) {
				if (!results.has("w2-find-added")) {
					return fauxAssistantMessage([
						fauxToolCall("fffind", { pattern: "commit2-added.ts" }, { id: "w2-find-added" }),
						fauxToolCall("fffind", { pattern: "step1-scratch.ts" }, { id: "w2-find-stale" }),
						fauxToolCall(
							"ffgrep",
							{ pattern: "head-rescan-discovered" },
							{ id: "w2-grep-added" },
						),
						fauxToolCall(
							"write",
							{
								path: "src/step2-output.ts",
								content: "export const STEP2_DONE = true;\n",
							},
							{ id: "w2-write-call" },
						),
					]);
				}
				outputs.worker2FindAdded = results.get("w2-find-added") ?? "";
				outputs.worker2FindStale = results.get("w2-find-stale") ?? "";
				outputs.worker2GrepAdded = results.get("w2-grep-added") ?? "";
				return fauxAssistantMessage("worker 2 complete");
			}

			throw new Error(`Unexpected prompt in faux provider: ${prompt}`);
		};

		faux.setResponses(Array.from({ length: 12 }, () => scriptedStep));

		// 1. Run 2 concurrent Herder `explorer` steps at commit 1.
		const explorerRun = Promise.all([
			executor.run("EXPLORER_STEP_FIND: locate alpha.ts", {
				id: "exp-1",
				role: "explorer",
			}),
			executor.run("EXPLORER_STEP_GREP: grep herder-ro-shared-777", {
				id: "exp-2",
				role: "explorer",
			}),
		]);

		await bothExplorersReady;
		const expectedRoSlot = `ro-${commit1.slice(0, 12)}`;
		const expectedRoPath = realpathSync(
			worktreePath(vcs.commonDir(), store.runId, expectedRoSlot),
		);
		expect(readdirSync(store.paths.worktrees)).toEqual([expectedRoSlot]);

		const roHealth = await backend.healthCheck(expectedRoPath);
		expect(roHealth.ok).toBe(true);
		if (!roHealth.ok) throw new Error(roHealth.error);
		expect(roHealth.value.sharedRoots).toBe(1);
		const sidecarPid = roHealth.value.pid;
		expect(typeof sidecarPid).toBe("number");
		trackedPids.add(sidecarPid!);

		releaseExplorerBarrier();
		const [exp1, exp2] = await explorerRun;
		expect([exp1.status, exp2.status]).toEqual(["ok", "ok"]);
		expect(explorerToolsSeen).toEqual([
			["bash", "fffind", "ffgrep", "find", "grep", "ls", "read"],
			["bash", "fffind", "ffgrep", "find", "grep", "ls", "read"],
		]);
		expect(outputs.explorerFind).toContain("src/alpha.ts");
		expect(outputs.explorerGrep).toContain("src/alpha.ts");
		expect(outputs.explorerGrep).toContain("herder-ro-shared-777");

		// 2. Run 2 sequential Herder `worker` steps reusing `rw-0` across advancing commits.
		const work1 = await executor.run("WORKER_STEP_1: check before commit 2 and write scratch", {
			id: "work-1",
			role: "worker",
		});
		expect(work1.status).toBe("ok");
		expect(work1.commit).toBeDefined();
		expect(outputs.worker1Find).toContain("No files found matching pattern");

		const expectedRw0Path = realpathSync(worktreePath(vcs.commonDir(), store.runId, "rw-0"));

		// Advance the run's integration commit to commit 2 adding `src/commit2-added.ts`
		// (without `src/step1-scratch.ts`), so reusing `rw-0` resets `<gitdir>/HEAD` to commit 2.
		const commit2 = fixture.commit("commit 2", {
			"src/commit2-added.ts":
				"export const COMMIT2_ADDED = 'head-rescan-discovered';\n",
		});
		vcs.updateRef(integrationRef(store.runId), commit2, commit1);

		const work2 = await executor.run("WORKER_STEP_2: verify commit 2 rescan in rw-0", {
			id: "work-2",
			role: "worker",
		});
		expect(work2.status).toBe("ok");
		expect(outputs.worker2FindAdded).toContain("src/commit2-added.ts");
		expect(outputs.worker2FindStale).toContain("No files found matching pattern");
		expect(outputs.worker2GrepAdded).toContain("src/commit2-added.ts");
		expect(outputs.worker2GrepAdded).toContain("head-rescan-discovered");

		const stepCwds = readStepSessionCwds(store.paths.sessions);
		expect(stepCwds.get("exp-1")).toBe(expectedRoPath);
		expect(stepCwds.get("exp-2")).toBe(expectedRoPath);
		expect(stepCwds.get("work-1")).toBe(expectedRw0Path);
		expect(stepCwds.get("work-2")).toBe(expectedRw0Path);
		expect(readdirSync(store.paths.worktrees).sort()).toEqual([expectedRoSlot, "rw-0"].sort());

		const preCleanupHealth = await backend.healthCheck(expectedRw0Path);
		expect(preCleanupHealth.ok).toBe(true);
		if (!preCleanupHealth.ok) throw new Error(preCleanupHealth.error);
		expect(preCleanupHealth.value.sharedRoots).toBe(2);
		expect(preCleanupHealth.value.pid).toBe(sidecarPid);

		// 3. `cleanupRun` removes Herder worktrees, and subsequent `ensureRoot` prunes them in sidecar.
		cleanupRun(vcs, vcs.commonDir(), store.runId);
		expect(existsSync(store.paths.worktrees)).toBe(false);
		expect(existsSync(expectedRoPath)).toBe(false);
		expect(existsSync(expectedRw0Path)).toBe(false);

		const mainEnsured = await backend.ensureRoot({
			basePath: fixture.dir,
			kind: "workspace",
			frecencyDbPath,
			historyDbPath,
		});
		const postCleanupHealth = await backend.healthCheck(mainEnsured.root);
		expect(postCleanupHealth.ok).toBe(true);
		if (!postCleanupHealth.ok) throw new Error(postCleanupHealth.error);
		expect(postCleanupHealth.value.sharedRoots).toBe(1);
		expect(postCleanupHealth.value.pid).toBe(sidecarPid);

		await parentHost.shutdown();
		const remainingHooks = [
			...((globalStore[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined) ?? []),
		];
		expect(remainingHooks.filter((h) => h.name === "fff")).toHaveLength(0);
	} finally {
		releaseExplorerBarrier();
		await parentHost.shutdown();
		if (prevSharedBackend === undefined) delete globalStore[SHARED_BACKEND_KEY];
		else globalStore[SHARED_BACKEND_KEY] = prevSharedBackend;
		if (prevChildHooks === undefined) delete globalStore[CHILD_SESSION_HOOKS];
		else globalStore[CHILD_SESSION_HOOKS] = prevChildHooks;
	}
});
