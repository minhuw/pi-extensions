// Regression tests for selfdrive's child-session guard hook (`Symbol.for("pi-extensions.child-session-hooks")`):
// Herder step sessions and `isolated: true` subagents run with `noExtensions: true` and load only child-session hooks.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
	type ExtensionFactory,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { publishGrant, repositoryOf, standingRegistry, withdrawGrant, type StandingApproval } from "../grants.ts";
import selfdriveExtension, { CHILD_SESSION_HOOKS, type ChildSessionHook } from "../index.ts";

let root: string;
let repo: string;
let worktree: string;
let grant: StandingApproval;
let previousAgentDir: string | undefined;
const disposables: { dispose(): Promise<void> | void }[] = [];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function registeredSelfdriveHooks(): ChildSessionHook[] {
	const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (!(hooks instanceof Set)) return [];
	return [...(hooks as Set<ChildSessionHook>)].filter((hook) => hook?.name === "selfdrive");
}

function childHookFactories(): InlineExtension[] {
	const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (!(hooks instanceof Set)) return [];
	return [...(hooks as Set<ChildSessionHook>)]
		.filter((hook) => typeof hook?.name === "string" && typeof hook.extensionFactory === "function")
		.map((hook) => ({ name: hook.name, factory: hook.extensionFactory }));
}

async function startParentSession(cwd = repo) {
	const faux = fauxProvider({ api: `selfdrive-parent-${Math.random()}`, provider: "selfdrive-parent", models: [{ id: "test" }] });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [(pi) => pi.registerProvider(faux.provider), selfdriveExtension],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: join(root, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
	});
	await runtime.session.bindExtensions({});
	let disposed = false;
	const handle = {
		runtime,
		session: runtime.session,
		dispose: async () => {
			if (!disposed) {
				disposed = true;
				await runtime.dispose();
			}
		},
	};
	disposables.push(handle);
	return handle;
}

async function startChildSession(options: { cwd: string; extraFactories?: (ExtensionFactory | InlineExtension)[]; linkParentId?: string }) {
	const faux = fauxProvider({ api: `selfdrive-child-${Math.random()}`, provider: "selfdrive-child", models: [{ id: "test" }] });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const sessionManager = SessionManager.inMemory(options.cwd);
	if (options.linkParentId) {
		sessionManager.appendCustomEntry("pi-extensions.session-link", {
			kind: "subagent",
			parentSessionId: options.linkParentId,
			agentType: "worker",
		});
	}
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: join(root, "agent"),
		settingsManager,
		modelRuntime,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => pi.registerProvider(faux.provider),
				...(options.extraFactories ?? []),
				...childHookFactories(),
			],
		},
	});
	const loaded = services.resourceLoader.getExtensions();
	expect(loaded.errors).toEqual([]);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: faux.getModel("test"),
	});
	await session.bindExtensions({});
	let disposed = false;
	const handle = {
		faux,
		session,
		extensions: loaded.extensions,
		toolResults: () => session.sessionManager.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [{
					isError: Boolean(entry.message.isError),
					text: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				}]
				: []),
		dispose: async () => {
			if (!disposed) {
				disposed = true;
				const runner = session.extensionRunner;
				if (runner.hasHandlers("session_shutdown")) {
					await runner.emit({ type: "session_shutdown", reason: "quit" });
				}
				session.dispose();
			}
		},
	};
	disposables.push(handle);
	return handle;
}

beforeAll(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-selfdrive-child-guard-")));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
	repo = join(root, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");

	// Real Herder-style worktree under `<git-common-dir>/herder/worktrees/...`.
	const repository = repositoryOf(repo)!;
	worktree = join(repository.commonDir, "herder", "worktrees", "run-1", "rw-0");
	mkdirSync(join(repository.commonDir, "herder", "worktrees", "run-1"), { recursive: true });
	git(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");

	grant = {
		id: "granting-session",
		...repository,
		text: "Self-driving mode, granted by the user.",
		since: new Date().toISOString(),
	};
});

afterEach(async () => {
	for (const item of disposables.splice(0).reverse()) {
		await item.dispose();
	}
	standingRegistry().grants.clear();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("selfdrive child-session guard hook", () => {
	it("enforces the guard in a noExtensions child session while allowing Herder worktree writes", async () => {
		expect(registeredSelfdriveHooks()).toEqual([]);

		const parent = await startParentSession();
		expect(registeredSelfdriveHooks()).toHaveLength(1);
		expect(registeredSelfdriveHooks()[0]!.name).toBe("selfdrive");

		const child = await startChildSession({ cwd: worktree, linkParentId: parent.session.sessionId });
		const checkoutFile = join(repo, "src", "a.ts");
		const worktreeFile = join(worktree, "src", "allowed.ts");

		publishGrant({ ...grant, id: parent.session.sessionId });

		// 1. Disallowed remote operation (`git push`) is blocked.
		child.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "git push origin HEAD" })]),
			fauxAssistantMessage("done"),
		]);
		await child.session.prompt("push changes");
		expect(child.toolResults().at(-1)).toEqual({
			isError: true,
			text: expect.stringContaining("Blocked by self-driving mode: git push leaves this machine"),
		});

		// 2. Editing a file in the user's checkout is blocked and leaves the file untouched.
		child.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: checkoutFile, oldText: "a = 1", newText: "a = 2" })]),
			fauxAssistantMessage("done"),
		]);
		await child.session.prompt("edit user checkout");
		expect(readFileSync(checkoutFile, "utf8")).toBe("export const a = 1;\n");
		expect(child.toolResults().at(-1)).toEqual({
			isError: true,
			text: expect.stringContaining(`Blocked by self-driving mode: edit ${checkoutFile} would change your user's checkout.`),
		});

		// 3. Writing inside `<git-common-dir>/herder/worktrees/...` (under `.git/`) is still allowed.
		child.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: worktreeFile, content: "export const ok = true;\n" })]),
			fauxAssistantMessage("done"),
		]);
		await child.session.prompt("write inside herder worktree");
		expect(existsSync(worktreeFile)).toBe(true);
		expect(readFileSync(worktreeFile, "utf8")).toBe("export const ok = true;\n");
		expect(child.toolResults().at(-1)?.isError).toBe(false);

		// 4. Hook is cleaned up when the registering parent session shuts down.
		await child.dispose();
		expect(registeredSelfdriveHooks()).toHaveLength(1);
		await parent.dispose();
		expect(registeredSelfdriveHooks()).toEqual([]);
	});

	it("ref-counts multiple parent sessions and cleans up on the last shutdown", async () => {
		const parentA = await startParentSession();
		const parentB = await startParentSession();
		expect(registeredSelfdriveHooks()).toHaveLength(1);

		await parentA.dispose();
		expect(registeredSelfdriveHooks()).toHaveLength(1);

		await parentB.dispose();
		expect(registeredSelfdriveHooks()).toEqual([]);
	});

	it("deduplicates when a child loads selfdrive both normally and via CHILD_SESSION_HOOKS", async () => {
		const parent = await startParentSession();
		const child = await startChildSession({
			cwd: repo,
			extraFactories: [selfdriveExtension],
			linkParentId: parent.session.sessionId,
		});

		// Both the normal extension and the child hook loaded in this pass, yet only one `tool_call` handler registered.
		expect(child.extensions).toHaveLength(3);
		const toolCallHandlerCount = child.extensions
			.reduce((total, ext) => total + (ext.handlers.get("tool_call")?.length ?? 0), 0);
		expect(toolCallHandlerCount).toBe(1);

		publishGrant({ ...grant, id: parent.session.sessionId });
		const checkoutFile = join(repo, "src", "a.ts");
		child.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: checkoutFile, oldText: "a = 1", newText: "a = 9" })]),
			fauxAssistantMessage("done"),
		]);
		await child.session.prompt("try edit");
		expect(readFileSync(checkoutFile, "utf8")).toBe("export const a = 1;\n");
		expect(child.toolResults().at(-1)).toEqual({
			isError: true,
			text: expect.stringContaining(`Blocked by self-driving mode: edit ${checkoutFile} would change your user's checkout.`),
		});

		withdrawGrant(parent.session.sessionId);
		await child.dispose();
		expect(registeredSelfdriveHooks()).toHaveLength(1);
		await parent.dispose();
		expect(registeredSelfdriveHooks()).toEqual([]);
	});
});
