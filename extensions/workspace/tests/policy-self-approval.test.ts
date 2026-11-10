import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import workspaceExtension, { CHILD_SESSION_HOOKS, SESSION_LINK_TYPE, WORKSPACE_SHARED_KEY } from "../index.ts";
import {
	evaluatePathAccess,
	policyFilePath,
	readProjectPolicy,
	resolveCanonicalPath,
	workspacesDir,
} from "../policy.ts";
import { readRegistry, registryFilePath } from "../registry.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

const MANAGED_FILES = ["policy.json", ".registry.json"] as const;

let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-self-approval-"));
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

/** A real Pi session on the faux provider, bound with a UI whose `select` answers from `choices`, then "Deny". */
async function startUiSession(choices: string[] = []) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: "workspace-self-approval-api",
		provider: "workspace-self-approval",
		models: [{ id: "test" }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});

	const prompts: string[] = [];
	const notes: string[] = [];
	const noop = () => {};
	const uiContext = {
		select: async (title: string) => {
			prompts.push(title);
			return choices.shift() ?? "Deny";
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
		notify: (message: string) => {
			notes.push(message);
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
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
					},
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
		cwd: projectCwd,
		agentDir,
		sessionManager: SessionManager.create(projectCwd, sessionDir),
	});
	const errors: unknown[] = [];
	await runtime.session.bindExtensions({
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
	});

	return {
		session: runtime.session,
		faux,
		prompts,
		notes,
		errors,
		toolResults: () =>
			runtime.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
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
		dispose: () => runtime.dispose(),
	};
}

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

/** The extension's `tool_call` handler, for judging a call without running its tool. */
function loadToolCallHandler(): ToolCallHandler {
	let toolCall: ToolCallHandler | undefined;
	workspaceExtension({
		on: (event: string, handler: ToolCallHandler) => {
			if (event === "tool_call") toolCall = handler;
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	return toolCall!;
}

const SESSION_KINDS = ["ui", "headless", "child"] as const;

/** A UI session, a headless session, or a UI-bound child session; a prompt would be answered "Allow once". */
function handlerContext(kind: (typeof SESSION_KINDS)[number], prompts: string[]): ExtensionContext {
	const hasUI = kind !== "headless";
	return {
		cwd: projectCwd,
		mode: hasUI ? "rpc" : "print",
		hasUI,
		ui: {
			select: hasUI
				? async (title: string) => {
						prompts.push(title);
						return "Allow once";
					}
				: undefined,
		},
		sessionManager: {
			getSessionId: () => "self-approval-session",
			getEntries: () => (kind === "child" ? [{ type: "custom", customType: SESSION_LINK_TYPE, data: {} }] : []),
		},
	} as unknown as ExtensionContext;
}

function expectManagedFileBlock(result: ToolCallEventResult | undefined, file: string, label: string): void {
	expect(result, label).toMatchObject({ block: true });
	expect(result?.reason, label).toContain(`Blocked write to "${file}"`);
	expect(result?.reason, label).toContain("managed by the workspace extension");
	expect(result?.reason, label).toContain("/workspace allow <path>");
	expect(result?.reason, label).toContain("/workspace deny <path>");
}

describe("workspace write guard — the guard's own policy.json and .registry.json", () => {
	it.each(MANAGED_FILES)(
		"blocks write and edit to %s under every spelling, in every kind of session, without a prompt",
		async (name) => {
			const toolCall = loadToolCallHandler();
			const wsDir = workspacesDir(projectCwd);
			const file = path.join(wsDir, name);
			await mkdir(wsDir, { recursive: true });
			await symlink(file, path.join(projectCwd, "file-link"));
			await symlink(wsDir, path.join(projectCwd, "dir-link"));
			const spellings = [
				`.pi/workspaces/${name}`,
				file,
				path.join(projectCwd, ".pi", "workspaces", name),
				`src/../.pi/workspaces/${name}`,
				`.pi/workspaces/side/../${name}`,
				`@.pi/workspaces/${name}`,
				`file://${file}`,
				"file-link",
				`dir-link/${name}`,
				// macOS resolves another letter case to the same file.
				`.pi/workspaces/${name.toUpperCase()}`,
				`.PI/Workspaces/${name}`,
			];

			// Neither file exists until the extension first writes it, and a write would create it.
			for (const exists of [false, true]) {
				if (exists) await writeFile(file, "{}\n", "utf8");
				for (const spelling of spellings) {
					for (const toolName of ["write", "edit"]) {
						for (const kind of SESSION_KINDS) {
							const prompts: string[] = [];
							const result = await toolCall({ toolName, input: { path: spelling } }, handlerContext(kind, prompts));
							const label = `${toolName} ${spelling} (${kind} session, file ${exists ? "exists" : "absent"})`;
							expectManagedFileBlock(result, file, label);
							expect(prompts, label).toEqual([]);
						}
					}
				}
			}
			expect(await readFile(file, "utf8")).toBe("{}\n");
		},
	);

	it("blocks bash commands that write either file, and only those", async () => {
		const toolCall = loadToolCallHandler();
		const wsDir = workspacesDir(projectCwd);
		const policyFile = policyFilePath(projectCwd);
		const registryFile = registryFilePath(projectCwd);
		await mkdir(wsDir, { recursive: true });
		await symlink(wsDir, path.join(projectCwd, "dir-link"));
		const grant = `'${JSON.stringify({ allowedPaths: [outsideDir] })}'`;

		const blocked: [command: string, file: string][] = [
			[`echo ${grant} > .pi/workspaces/policy.json`, policyFile],
			[`echo ${grant} >> "${policyFile}"`, policyFile],
			[`echo ${grant} | tee .pi/workspaces/policy.json`, policyFile],
			["cp grant.json .pi/workspaces/policy.json", policyFile],
			["mv grant.json src/../.pi/workspaces/policy.json", policyFile],
			[`cd .pi/workspaces && echo ${grant} > policy.json`, policyFile],
			["ln -sf ../../grant.json .pi/workspaces/policy.json", policyFile],
			[`echo ${grant} > dir-link/policy.json`, policyFile],
			[`echo ${grant} > .pi/workspaces/POLICY.JSON`, policyFile],
			["rm -f .pi/workspaces/.registry.json", registryFile],
			[`echo '{"workspaces":[]}' >| "${registryFile}"`, registryFile],
			["mkdir -p .pi/workspaces/side && touch .pi/workspaces/side/f dir-link/.registry.json", registryFile],
			// An outside target in the same command does not turn the block into a prompt.
			[`mkdir -p "${outsideDir}/d" && echo ${grant} > .pi/workspaces/policy.json`, policyFile],
		];
		for (const [command, file] of blocked) {
			for (const kind of SESSION_KINDS) {
				const prompts: string[] = [];
				const result = await toolCall({ toolName: "bash", input: { command } }, handlerContext(kind, prompts));
				expectManagedFileBlock(result, file, `${command} (${kind} session)`);
				expect(prompts, command).toEqual([]);
			}
		}
		expect(fs.readdirSync(wsDir)).toEqual([]);

		// Reading the files, and writing a same-named file inside a workspace, is not a write to them.
		for (const command of [
			"cat .pi/workspaces/policy.json .pi/workspaces/.registry.json",
			"cat .pi/workspaces/policy.json > policy-copy.json",
			"mkdir -p .pi/workspaces/side && echo notes > .pi/workspaces/side/policy.json",
		]) {
			const prompts: string[] = [];
			expect(await toolCall({ toolName: "bash", input: { command } }, handlerContext("ui", prompts)), command).toBeUndefined();
			expect(prompts, command).toEqual([]);
		}
	});

	it("does not let a UI session approve its own outside write through policy.json", async () => {
		const h = await startUiSession();
		try {
			const policyFile = policyFilePath(projectCwd);
			await symlink(workspacesDir(projectCwd), path.join(projectCwd, "dir-link"));
			const grant = JSON.stringify({ allowedPaths: [outsideDir] });
			const escaped = path.join(outsideDir, "escaped.txt");

			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: ".pi/workspaces/policy.json", content: grant }),
					fauxToolCall("write", { path: policyFile, content: grant }),
					fauxToolCall("write", { path: "dir-link/policy.json", content: grant }),
					fauxToolCall("bash", { command: `echo '${grant}' > .pi/workspaces/policy.json` }),
				]),
				fauxAssistantMessage([fauxToolCall("write", { path: escaped, content: "escaped\n" })]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("allow the outside directory yourself, then write there");

			const results = h.toolResults();
			expect(results).toHaveLength(5);
			for (const result of results.slice(0, 4)) {
				expect(result.text).toContain(`Blocked write to "${policyFile}"`);
				expect(result.text).toContain("managed by the workspace extension");
				expect(result.isError).toBe(true);
			}
			expect(fs.existsSync(policyFile)).toBe(false);

			// The project allow list is still empty, so the outside write is put to the user, who denies it.
			const allowedPaths = (await readProjectPolicy(projectCwd)).allowedPaths;
			expect(allowedPaths).toEqual([]);
			expect(evaluatePathAccess({ targetPath: escaped, cwd: projectCwd, projectAllowed: allowedPaths }).allowed).toBe(false);
			expect(h.prompts).toEqual([`Allow write outside workspace (${resolveCanonicalPath(escaped)})?`]);
			expect(results[4]!.text).toContain("Blocked write outside project working directory");
			expect(fs.existsSync(escaped)).toBe(false);
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("keeps both files blocked and unchanged when the session and project allow lists name them", async () => {
		const h = await startUiSession();
		try {
			const policyFile = policyFilePath(projectCwd);
			const registryFile = registryFilePath(projectCwd);

			// `/workspace allow` adds each path to policy.json and to the session allow list.
			for (const target of [".pi/workspaces", ".pi/workspaces/policy.json", registryFile]) {
				await h.session.prompt(`/workspace allow ${target}`);
			}
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([
				workspacesDir(projectCwd),
				policyFile,
				registryFile,
			]);
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("workspace", { action: "create", name: "side" })]),
				fauxAssistantMessage("workspace ready"),
			]);
			await h.session.prompt("create a workspace");
			expect((await readRegistry(projectCwd)).map((entry) => entry.name)).toEqual(["side"]);
			const before = { policy: await readFile(policyFile, "utf8"), registry: await readFile(registryFile, "utf8") };

			const grant = JSON.stringify({ allowedPaths: [outsideDir] });
			const escaped = path.join(outsideDir, "escaped.txt");
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: ".pi/workspaces/policy.json", content: grant }),
					fauxToolCall("edit", {
						path: policyFile,
						edits: [{ oldText: '"allowedPaths": [', newText: `"allowedPaths": [${JSON.stringify(outsideDir)},` }],
					}),
					fauxToolCall("bash", { command: `echo '${grant}' > .pi/workspaces/policy.json` }),
					fauxToolCall("write", { path: registryFile, content: '{"workspaces":[]}\n' }),
					fauxToolCall("edit", {
						path: ".pi/workspaces/.registry.json",
						edits: [{ oldText: '"name": "side"', newText: '"name": "moved"' }],
					}),
					fauxToolCall("bash", { command: "rm -f .pi/workspaces/.registry.json" }),
				]),
				fauxAssistantMessage([fauxToolCall("write", { path: escaped, content: "escaped\n" })]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("rewrite the workspace state files, then write outside");

			const results = h.toolResults().slice(1);
			expect(results).toHaveLength(7);
			for (const [index, file] of [policyFile, policyFile, policyFile, registryFile, registryFile, registryFile].entries()) {
				expect(results[index]!.text, `call ${index}`).toContain(`Blocked write to "${file}"`);
				expect(results[index]!.text, `call ${index}`).toContain("managed by the workspace extension");
				expect(results[index]!.isError, `call ${index}`).toBe(true);
			}
			expect(await readFile(policyFile, "utf8")).toBe(before.policy);
			expect(await readFile(registryFile, "utf8")).toBe(before.registry);

			// Only the outside write reached the user.
			expect(h.prompts).toEqual([`Allow write outside workspace (${resolveCanonicalPath(escaped)})?`]);
			expect(results[6]!.text).toContain("Blocked write outside project working directory");
			expect(fs.existsSync(escaped)).toBe(false);
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("still updates both files through /workspace, the workspace tool, workspace writes, and the dialog", async () => {
		const h = await startUiSession(["Allow for this project"]);
		try {
			const policyFile = policyFilePath(projectCwd);
			const canonicalOutside = resolveCanonicalPath(outsideDir);
			const otherDir = path.join(sandboxRoot, "other");
			const canonicalOther = resolveCanonicalPath(otherDir);

			await h.session.prompt(`/workspace allow ${otherDir}`);
			expect(h.notes.at(-1)).toBe(`Allowed external path: ${canonicalOther}`);
			expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({ allowedPaths: [canonicalOther] });
			await h.session.prompt(`/workspace deny ${otherDir}`);
			expect(h.notes.at(-1)).toBe(`Denied external path: ${canonicalOther}`);
			expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({ allowedPaths: [] });

			const notes = path.join(workspacesDir(projectCwd), "side", "notes.txt");
			const approved = path.join(outsideDir, "approved.txt");
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("workspace", { action: "create", name: "tool-ws" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "pin", name: "tool-ws" })]),
				fauxAssistantMessage([fauxToolCall("write", { path: ".pi/workspaces/side/notes.txt", content: "notes\n" })]),
				fauxAssistantMessage([
					fauxToolCall("edit", { path: notes, edits: [{ oldText: "notes", newText: "edited" }] }),
				]),
				fauxAssistantMessage([
					fauxToolCall("bash", {
						command: "echo more >> .pi/workspaces/side/notes.txt && echo inner > .pi/workspaces/side/policy.json",
					}),
				]),
				fauxAssistantMessage([fauxToolCall("write", { path: approved, content: "approved\n" })]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("use workspaces, then write outside");

			expect(h.toolResults().filter((result) => result.isError)).toEqual([]);
			expect(await readFile(notes, "utf8")).toBe("edited\nmore\n");
			expect(await readFile(path.join(workspacesDir(projectCwd), "side", "policy.json"), "utf8")).toBe("inner\n");
			expect(
				(await readRegistry(projectCwd)).map((entry) => [entry.name, entry.pinned]).sort(),
			).toEqual([
				["side", false],
				["tool-ws", true],
			]);

			// The only prompt is for the outside write; "Allow for this project" records its directory.
			expect(h.prompts).toEqual([`Allow write outside workspace (${path.join(canonicalOutside, "approved.txt")})?`]);
			expect(await readFile(approved, "utf8")).toBe("approved\n");
			expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({ allowedPaths: [canonicalOutside] });
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});
});
