import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	RegisteredCommand,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FffBackend, SHARED_BACKEND_KEY, SidecarFffBackend } from "../client.ts";
import fffExtension, {
	CHILD_SESSION_HOOKS,
	type ChildSessionHook,
	createFffExtension,
} from "../index.ts";

const SESSION_LINK_TYPE = "pi-extensions.session-link";
type ExtensionMode = ExtensionContext["mode"];

const ENV_KEYS = [
	"PI_FFF_MODE",
	"FFF_FRECENCY_DB",
	"FFF_HISTORY_DB",
	"FFF_ENABLE_ROOT_SCAN",
	"FFF_ENABLE_HOME_SCAN",
	"FFF_WARN_HOME_SCAN",
	"FFF_FOLLOW_SYMLINKS",
	"PI_FFF_MULTIGREP",
	"PI_CODING_AGENT_DIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
] as const;

interface SessionEntryRecord {
	type: string;
	customType?: string;
	data?: unknown;
}

interface NotificationRecord {
	message: string;
	type?: "info" | "warning" | "error";
}

function stripAnsi(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape stripping for test assertions
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initGitRepo(dir: string, files: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "FFF Test");
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = path.join(dir, relPath);
		mkdirSync(path.dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content, "utf8");
	}
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "initial commit");
}

function createAnsiTheme(): Theme {
	return {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as unknown as Theme;
}

interface HarnessOptions {
	backend: FffBackend;
	agentDir: string;
	cwd: string;
	mode?: ExtensionMode;
	flags?: Record<string, boolean | string>;
	entries?: SessionEntryRecord[];
	initialActiveTools?: string[];
	extensionSetup?: ((pi: ExtensionAPI) => void) | false;
	events?: {
		emit: (channel: string, data: unknown) => void;
		on: (channel: string, handler: (data: unknown) => void) => () => void;
	};
}

function createSessionHarness(options: HarnessOptions) {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const registeredFlags = new Map<string, { type: "boolean" | "string"; description?: string }>();
	const flagValues = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
	const entries: SessionEntryRecord[] = [...(options.entries ?? [])];
	const notifications: NotificationRecord[] = [];
	const statuses = new Map<string, string | undefined>();
	const fallbackSuggestionsCalls: { lines: string[]; cursorLine: number; cursorCol: number }[] = [];
	let registerToolCalls = 0;

	const makeBuiltinTool = (name: string): ToolDefinition =>
		({
			name,
			label: name,
			description: `Built-in ${name}`,
			parameters: {} as never,
			async execute() {
				return {
					content: [{ type: "text", text: `builtin:${name}` }],
					details: { builtin: true },
				};
			},
		}) as ToolDefinition;

	for (const builtinName of ["read", "bash", "grep", "find"]) {
		tools.set(builtinName, makeBuiltinTool(builtinName));
	}

	let activeTools = options.initialActiveTools
		? [...options.initialActiveTools]
		: ["read", "bash", "grep", "find"];

	let autocompleteRegistrations = 0;
	let autocompleteProvider: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol) {
			fallbackSuggestionsCalls.push({ lines, cursorLine, cursorCol });
			return {
				items: [{ value: "@fallback-item", label: "fallback-item", description: "fallback" }],
				prefix: (lines[cursorLine] ?? "").slice(0, cursorCol),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = lines[cursorLine] ?? "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const updated = `${before}${item.value}${after}`;
			return {
				lines: [...lines.slice(0, cursorLine), updated, ...lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: before.length + item.value.length,
			};
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	};

	const mode: ExtensionMode = options.mode ?? "tui";
	const noop = () => {};

	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.set(key, text);
		},
		addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
			autocompleteRegistrations += 1;
			autocompleteProvider = factory(autocompleteProvider);
		},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined as never,
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
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: createAnsiTheme(),
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	} as unknown as ExtensionUIContext;

	const ctx = {
		ui,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: options.cwd,
		sessionManager: {
			getEntries: () => entries,
		},
		modelRegistry: {} as never,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: noop,
		hasPendingMessages: () => false,
		shutdown: noop,
		getContextUsage: () => undefined,
		compact: noop,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: options.cwd }),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as unknown as ExtensionCommandContext & ExtensionToolContext;

	const pi = {
		on(event: string, handler: (ev: unknown, context: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(definition: ToolDefinition) {
			registerToolCalls += 1;
			tools.set(definition.name, definition);
			if (!activeTools.includes(definition.name)) {
				activeTools.push(definition.name);
			}
		},
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, { ...(command as RegisteredCommand), name });
		},
		registerFlag(name: string, opts: { type: "boolean" | "string"; description?: string; default?: boolean | string }) {
			registeredFlags.set(name, opts);
			if (opts.default !== undefined && !flagValues.has(name)) {
				flagValues.set(name, opts.default);
			}
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		...(options.events ? { events: options.events } : {}),
	} as unknown as ExtensionAPI;

	if (options.extensionSetup !== false) {
		const setup =
			options.extensionSetup ??
			createFffExtension({
				backend: options.backend,
				agentDir: options.agentDir,
			});
		setup(pi);
	}

	async function emit(eventName: string, eventPayload: unknown = {}): Promise<void> {
		for (const handler of handlers.get(eventName) ?? []) {
			await handler(eventPayload, ctx);
		}
	}

	async function callTool<TParams extends Record<string, unknown>>(
		name: string,
		params: TParams,
		signal?: AbortSignal,
	): Promise<{ text: string; result: AgentToolResult<unknown> }> {
		const tool = tools.get(name);
		if (!tool) {
			throw new Error(`Tool "${name}" is not registered (have: ${[...tools.keys()].join(", ")})`);
		}
		const result = await tool.execute("call-test", params as never, signal, undefined, ctx);
		const text = result.content
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
		return { text, result };
	}

	async function runCommand(name: string, args = ""): Promise<void> {
		const command = commands.get(name);
		if (!command) {
			throw new Error(`Command "/${name}" is not registered`);
		}
		await command.handler(args, ctx);
	}

	return {
		pi,
		ctx,
		tools,
		commands,
		registeredFlags,
		entries,
		notifications,
		statuses,
		fallbackSuggestionsCalls,
		getActiveTools: () => [...activeTools],
		getRegisterToolCalls: () => registerToolCalls,
		getHandlerCount: (eventName: string) => handlers.get(eventName)?.length ?? 0,
		getAutocompleteRegistrations: () => autocompleteRegistrations,
		getAutocompleteProvider: () => autocompleteProvider,
		emit,
		callTool,
		runCommand,
	};
}

describe("pi-fff extension integration", () => {
	let sandboxDir: string;
	let agentDir: string;
	let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
	const backendsToDispose: SidecarFffBackend[] = [];

	function trackBackend(backend = new SidecarFffBackend()): SidecarFffBackend {
		backendsToDispose.push(backend);
		return backend;
	}

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}

		sandboxDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-fff-ext-test-")));
		agentDir = path.join(sandboxDir, "agent");
		const xdgCache = path.join(sandboxDir, "xdg-cache");
		const xdgData = path.join(sandboxDir, "xdg-data");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(xdgCache, { recursive: true });
		mkdirSync(xdgData, { recursive: true });

		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.XDG_CACHE_HOME = xdgCache;
		process.env.XDG_DATA_HOME = xdgData;
	});

	afterEach(async () => {
		while (backendsToDispose.length > 0) {
			const backend = backendsToDispose.pop();
			await backend?.dispose().catch(() => {});
		}
		for (const key of ENV_KEYS) {
			const previous = savedEnv[key];
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		}
		rmSync(sandboxDir, { recursive: true, force: true });
	});

	describe("1. Top-level + 25 in-process child sessions sharing one SidecarFffBackend", () => {
		it(
			"shares one sidecar across 1 top-level TUI session and 25 child sessions and survives all child shutdowns without respawning",
			async () => {
				const repoDir = path.join(sandboxDir, "shared-repo");
				initGitRepo(repoDir, {
					"src/engine.ts": [
						"export function runSharedSearchEngine(): string {",
						'  return "SHARED_SIDECAR_TOKEN_777";',
						"}",
					].join("\n"),
					"src/worker-pool.ts": "export const WORKER_POOL_SIZE = 25;\n",
					"docs/architecture.md": "# Shared Sidecar Architecture\nAll subagents reuse one FFF daemon.\n",
				});

				const backend = trackBackend();
				const extensionSetup = createFffExtension({ backend, agentDir });

				const topLevel = createSessionHarness({
					backend,
					agentDir,
					cwd: repoDir,
					mode: "tui",
					extensionSetup,
				});
				await topLevel.emit("session_start");

				expect(topLevel.getAutocompleteRegistrations()).toBe(1);
				expect(topLevel.notifications).toEqual([]);

				const initialPid = backend.getPid();
				expect(typeof initialPid).toBe("number");
				expect(initialPid).toBeGreaterThan(0);

				const childSessions = Array.from({ length: 25 }, (_, index) => {
					const useLinkedTui = index % 2 === 1;
					return createSessionHarness({
						backend,
						agentDir,
						cwd: repoDir,
						mode: useLinkedTui ? "tui" : "print",
						entries: useLinkedTui
							? [
									{
										type: "custom",
										customType: SESSION_LINK_TYPE,
										data: {
											kind: "subagent",
											parentSessionId: "top-level-session",
										},
									},
								]
							: [],
						extensionSetup,
					});
				});

				await Promise.all(childSessions.map((child) => child.emit("session_start")));

				for (const child of childSessions) {
					expect(child.getAutocompleteRegistrations()).toBe(0);
					expect(child.notifications).toEqual([]);
				}

				const childResults = await Promise.all(
					childSessions.map(async (child, idx) => {
						const findOut = await child.callTool("fffind", {
							pattern: idx % 2 === 0 ? "engine.ts" : "worker-pool.ts",
						});
						const grepOut = await child.callTool("ffgrep", {
							pattern: idx % 2 === 0 ? "SHARED_SIDECAR_TOKEN_777" : "WORKER_POOL_SIZE",
						});
						return { findText: findOut.text, grepText: grepOut.text };
					}),
				);

				childResults.forEach((res, idx) => {
					if (idx % 2 === 0) {
						expect(res.findText).toContain("src/engine.ts");
						expect(res.grepText).toContain("SHARED_SIDECAR_TOKEN_777");
					} else {
						expect(res.findText).toContain("src/worker-pool.ts");
						expect(res.grepText).toContain("WORKER_POOL_SIZE");
					}
				});

				for (const child of childSessions) {
					expect(child.notifications).toEqual([]);
				}

				// Shut down all 25 child sessions concurrently.
				await Promise.all(childSessions.map((child) => child.emit("session_shutdown")));

				// Shared sidecar process must stay alive with the exact same PID.
				expect(backend.getPid()).toBe(initialPid);

				// Top-level session tools and /fff-health continue working immediately.
				const topFind = await topLevel.callTool("fffind", { pattern: "architecture.md" });
				expect(topFind.text).toContain("docs/architecture.md");

				const topGrep = await topLevel.callTool("ffgrep", {
					pattern: "SHARED_SIDECAR_TOKEN_777",
				});
				expect(topGrep.text).toContain("src/engine.ts");
				expect(topGrep.text).toContain("SHARED_SIDECAR_TOKEN_777");

				await topLevel.runCommand("fff-health");
				expect(topLevel.notifications).toHaveLength(1);
				expect(topLevel.notifications[0]?.type).toBe("info");
				expect(topLevel.notifications[0]?.message).toContain(`Sidecar PID: ${initialPid}`);
				expect(topLevel.notifications[0]?.message).toContain("Git: yes");
				expect(backend.getPid()).toBe(initialPid);

				await topLevel.emit("session_shutdown");
			},
			30_000,
		);
	});

	describe("2. Modes, flags, /fff-mode persistence, and #857 opt-out fallback", () => {
		it("supports tools-and-ui, tools-only, and override modes with active tool pruning", async () => {
			const repoDir = path.join(sandboxDir, "modes-repo");
			initGitRepo(repoDir, {
				"src/search-target.ts": "export const MODE_SEARCH_VALUE = 123;\n",
			});
			const backend = trackBackend();

			// 1) tools-and-ui (default): registers fffind + ffgrep + @ autocomplete
			const uiSession = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await uiSession.emit("session_start");

			expect(uiSession.getActiveTools()).toEqual(
				expect.arrayContaining(["grep", "find", "ffgrep", "fffind"]),
			);
			expect((await uiSession.callTool("grep", {})).text).toBe("builtin:grep");
			expect((await uiSession.callTool("ffgrep", { pattern: "MODE_SEARCH_VALUE" })).text).toContain(
				"src/search-target.ts",
			);

			const uiSuggestions = await uiSession
				.getAutocompleteProvider()
				.getSuggestions(["@search-target"], 0, 14, { signal: new AbortController().signal });
			expect(uiSuggestions?.prefix).toBe("@search-target");
			expect(uiSuggestions?.items.map((item) => item.value)).toContain("@src/search-target.ts");
			expect(uiSession.fallbackSuggestionsCalls).toHaveLength(0);
			await uiSession.emit("session_shutdown");

			// 2) tools-only: registers fffind + ffgrep, skips FFF @ autocomplete (delegates to fallback)
			const toolsOnlySession = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
				flags: { "fff-mode": "tools-only" },
			});
			await toolsOnlySession.emit("session_start");

			expect(toolsOnlySession.getActiveTools()).toEqual(
				expect.arrayContaining(["ffgrep", "fffind"]),
			);
			expect(
				(await toolsOnlySession.callTool("fffind", { pattern: "search-target" })).text,
			).toContain("src/search-target.ts");

			const skippedMention = await toolsOnlySession
				.getAutocompleteProvider()
				.getSuggestions(["@search-target"], 0, 14, { signal: new AbortController().signal });
			expect(toolsOnlySession.fallbackSuggestionsCalls).toHaveLength(1);
			expect(skippedMention?.items[0]?.value).toBe("@fallback-item");
			await toolsOnlySession.emit("session_shutdown");

			// 3) override: registers find + grep (overriding built-ins) and prunes stale fffind/ffgrep
			const overrideSession = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
				flags: { "fff-mode": "override" },
				initialActiveTools: ["read", "bash", "grep", "find", "ffgrep", "fffind", "fff-multi-grep"],
			});
			await overrideSession.emit("session_start");

			expect(overrideSession.getActiveTools()).toContain("grep");
			expect(overrideSession.getActiveTools()).toContain("find");
			expect(overrideSession.getActiveTools()).not.toContain("ffgrep");
			expect(overrideSession.getActiveTools()).not.toContain("fffind");
			expect(overrideSession.getActiveTools()).not.toContain("fff-multi-grep");

			const overriddenGrep = await overrideSession.callTool("grep", {
				pattern: "MODE_SEARCH_VALUE",
			});
			expect(overriddenGrep.text).toContain("src/search-target.ts");
			const overriddenFind = await overrideSession.callTool("find", {
				pattern: "search-target",
			});
			expect(overriddenFind.text).toContain("src/search-target.ts");
			await overrideSession.emit("session_shutdown");
		});

		it("persists /fff-mode entries, prompts /reload when switching to/from override, and restores on reload", async () => {
			const repoDir = path.join(sandboxDir, "persist-repo");
			initGitRepo(repoDir, {
				"src/persisted.ts": "export const PERSISTED_MARKER = true;\n",
			});
			const backend = trackBackend();

			let session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			// Inspect initial mode
			await session.runCommand("fff-mode");
			expect(session.notifications.at(-1)?.message).toBe(
				"Current mode: 'tools-and-ui' (flag: unset)",
			);

			// Switch between non-override modes applies immediately and persists entry
			await session.runCommand("fff-mode", "tools-only");
			expect(session.notifications.at(-1)?.message).toBe(
				"Mode changed: 'tools-and-ui' → 'tools-only'",
			);
			expect(session.entries.at(-1)).toEqual({
				type: "custom",
				customType: "fff-mode",
				data: { mode: "tools-only" },
			});

			// Switching into override saves entry and prompts /reload without changing live tool names yet
			await session.runCommand("fff-mode", "override");
			expect(session.notifications.at(-1)?.message).toBe(
				"Mode 'override' saved. Run /reload to apply the tool name change.",
			);
			expect(session.entries.at(-1)).toEqual({
				type: "custom",
				customType: "fff-mode",
				data: { mode: "override" },
			});

			// Simulate /reload carrying session entries and activeTools forward
			await session.emit("session_shutdown");
			session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
				entries: session.entries,
				initialActiveTools: session.getActiveTools(),
			});
			await session.emit("session_start");

			await session.runCommand("fff-mode");
			expect(session.notifications.at(-1)?.message).toBe(
				"Current mode: 'override' (flag: unset)",
			);
			expect(session.getActiveTools()).toContain("grep");
			expect(session.getActiveTools()).toContain("find");
			expect(session.getActiveTools()).not.toContain("ffgrep");
			expect(session.getActiveTools()).not.toContain("fffind");
			expect((await session.callTool("grep", { pattern: "PERSISTED_MARKER" })).text).toContain(
				"src/persisted.ts",
			);

			// Switching out of override back to tools-and-ui also prompts /reload
			await session.runCommand("fff-mode", "tools-and-ui");
			expect(session.notifications.at(-1)?.message).toBe(
				"Mode 'tools-and-ui' saved. Run /reload to apply the tool name change.",
			);

			await session.emit("session_shutdown");
			session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
				entries: session.entries,
				initialActiveTools: session.getActiveTools(),
			});
			await session.emit("session_start");

			await session.runCommand("fff-mode");
			expect(session.notifications.at(-1)?.message).toBe(
				"Current mode: 'tools-and-ui' (flag: unset)",
			);
			expect(session.getActiveTools()).toContain("ffgrep");
			expect(session.getActiveTools()).toContain("fffind");
			expect((await session.callTool("ffgrep", { pattern: "PERSISTED_MARKER" })).text).toContain(
				"src/persisted.ts",
			);
			await session.emit("session_shutdown");
		});

		it("keeps built-in grep/find untouched in override mode and warns once when cwd is $HOME with home scanning disabled (#857)", async () => {
			const homeDir = os.homedir();
			const backend = trackBackend();

			// Case A: disabled via --fff-enable-home-scan=false CLI flag
			const flagOptOutSession = createSessionHarness({
				backend,
				agentDir,
				cwd: homeDir,
				mode: "tui",
				flags: {
					"fff-mode": "override",
					"fff-enable-home-scan": false,
				},
			});
			await flagOptOutSession.emit("session_start");

			// Sidecar is never spawned to scan $HOME
			expect(backend.getPid()).toBeUndefined();

			// Built-in grep and find remain intact and active; FFF falls back to ffgrep/fffind names
			expect(flagOptOutSession.getActiveTools()).toEqual(
				expect.arrayContaining(["grep", "find", "ffgrep", "fffind"]),
			);
			expect((await flagOptOutSession.callTool("grep", {})).text).toBe("builtin:grep");
			expect((await flagOptOutSession.callTool("find", {})).text).toBe("builtin:find");

			expect(flagOptOutSession.notifications).toHaveLength(1);
			expect(flagOptOutSession.notifications[0]?.type).toBe("warning");
			expect(flagOptOutSession.notifications[0]?.message).toContain(
				'cwd is $HOME and "enableHomeDirScanning" is false',
			);
			await flagOptOutSession.emit("session_shutdown");

			// Case B: disabled via enableHomeDirScanning: false in <agentDir>/pi-fff.json
			const configAgentDir = path.join(sandboxDir, "agent-config-optout");
			mkdirSync(configAgentDir, { recursive: true });
			writeFileSync(
				path.join(configAgentDir, "pi-fff.json"),
				JSON.stringify({ mode: "override", enableHomeDirScanning: false }),
				"utf8",
			);

			const configOptOutSession = createSessionHarness({
				backend,
				agentDir: configAgentDir,
				cwd: homeDir,
				mode: "tui",
			});
			await configOptOutSession.emit("session_start");

			expect(backend.getPid()).toBeUndefined();
			expect(configOptOutSession.getActiveTools()).toEqual(
				expect.arrayContaining(["grep", "find", "ffgrep", "fffind"]),
			);
			expect((await configOptOutSession.callTool("grep", {})).text).toBe("builtin:grep");
			expect((await configOptOutSession.callTool("find", {})).text).toBe("builtin:find");
			expect(configOptOutSession.notifications).toHaveLength(1);
			expect(configOptOutSession.notifications[0]?.type).toBe("warning");
			expect(configOptOutSession.notifications[0]?.message).toContain(
				'cwd is $HOME and "enableHomeDirScanning" is false',
			);
			await configOptOutSession.emit("session_shutdown");
		});
	});

	describe("3. Tool behavior (ffgrep, fffind, fff-multi-grep, @ mentions, renderers)", () => {
		it("handles ffgrep wildcard rejection, literal/regex with context clamping, fuzzy fallback, cursor pagination, and ../ aux routing", async () => {
			const repoDir = path.join(sandboxDir, "tools-repo");
			const siblingDir = path.join(sandboxDir, "other-dir");

			const numberedLines = Array.from({ length: 60 }, (_, idx) => {
				const lineNo = idx + 1;
				return lineNo === 30
					? `line-${lineNo}: CONTEXT_ANCHOR_TOKEN`
					: `line-${lineNo}: padding`;
			}).join("\n");

			const repoFiles: Record<string, string> = {
				"src/context.txt": `${numberedLines}\n`,
				"src/compute.rs": [
					"pub fn compute_checksum(input: &[u8]) -> u32 { input.len() as u32 }",
					"pub fn compute_digest(input: &[u8]) -> u64 { input.len() as u64 }",
				].join("\n"),
				"src/frecency.ts": "export function calculateFrecencyWeight(score: number) { return score * 2; }\n",
			};
			for (let i = 1; i <= 5; i++) {
				repoFiles[`src/paged/file-${i}.ts`] = `export const item${i} = "PAGINATED_GREP_ITEM";\n`;
			}
			initGitRepo(repoDir, repoFiles);

			mkdirSync(path.join(siblingDir, "nested"), { recursive: true });
			writeFileSync(
				path.join(siblingDir, "nested", "external.ts"),
				'export const auxLookup = "outside_aux_lookup_value";\n',
				"utf8",
			);

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			// 1) Rejects wildcard-only patterns with guidance
			for (const wildcard of [".*", ".+"]) {
				const rejected = await session.callTool("ffgrep", { pattern: wildcard });
				expect(rejected.text).toContain(`Pattern '${wildcard}' matches everything`);
				expect(rejected.text).toContain("grep needs a concrete substring or identifier");
			}

			// 2) Literal & regex search with context clamping [0, 20]
			const negativeCtx = await session.callTool("ffgrep", {
				pattern: "CONTEXT_ANCHOR_TOKEN",
				context: -10,
			});
			expect(negativeCtx.text).toContain("30: line-30: CONTEXT_ANCHOR_TOKEN");
			expect(negativeCtx.text).not.toContain("29- ");
			expect(negativeCtx.text).not.toContain("31- ");

			const clampedCtx = await session.callTool("ffgrep", {
				pattern: "CONTEXT_ANCHOR_TOKEN",
				context: 999,
			});
			expect(clampedCtx.text).toContain("30: line-30: CONTEXT_ANCHOR_TOKEN");
			// Clamped to max 20 lines before (line 10..29) and 20 lines after (line 31..50)
			expect(clampedCtx.text).toContain("10- line-10: padding");
			expect(clampedCtx.text).toContain("50- line-50: padding");
			expect(clampedCtx.text).not.toContain(" 9- line-9: padding");
			expect(clampedCtx.text).not.toContain("51- line-51: padding");

			const regexMatch = await session.callTool("ffgrep", {
				pattern: "fn\\s+compute_[a-z]+",
			});
			expect(regexMatch.text).toContain("src/compute.rs");
			expect(regexMatch.text).toContain("compute_checksum");
			expect(regexMatch.text).toContain("compute_digest");

			// 3) Near-miss literal query triggers fuzzy fallback notice
			const nearMiss = await session.callTool("ffgrep", {
				pattern: "calculatFrecencyWeight",
			});
			expect(nearMiss.text).toContain("[0 exact matches. Maybe you meant this?]");
			expect(nearMiss.text).toContain("src/frecency.ts");
			expect(nearMiss.text).toContain("calculateFrecencyWeight");

			// 4) Paginates via cursor="fff_c..."
			const grepPage1 = await session.callTool("ffgrep", {
				pattern: "PAGINATED_GREP_ITEM",
				limit: 2,
			});
			const cursorMatch = grepPage1.text.match(/cursor="(fff_c\d+)"/);
			expect(cursorMatch).not.toBeNull();
			const grepPage2 = await session.callTool("ffgrep", {
				pattern: "PAGINATED_GREP_ITEM",
				limit: 2,
				cursor: cursorMatch![1],
			});
			expect(grepPage2.text).toContain("PAGINATED_GREP_ITEM");
			const page1Files = grepPage1.text
				.split("\n")
				.filter((line) => line.startsWith("src/paged/"));
			const page2Files = grepPage2.text
				.split("\n")
				.filter((line) => line.startsWith("src/paged/"));
			expect(page1Files.length).toBe(2);
			expect(page2Files.length).toBe(2);
			expect(page2Files.some((f) => page1Files.includes(f))).toBe(false);

			// 5) Routes outside-workspace path (../other-dir) to aux root
			const auxMatch = await session.callTool("ffgrep", {
				pattern: "outside_aux_lookup_value",
				path: "../other-dir",
			});
			expect(auxMatch.text).toContain("nested/external.ts");
			expect(auxMatch.text).toContain("outside_aux_lookup_value");

			await session.emit("session_shutdown");
		});

		it("caps weak scattered fuzzy matches and paginates strong matches in fffind", async () => {
			const repoDir = path.join(sandboxDir, "find-repo");
			const files: Record<string, string> = {};
			for (let i = 1; i <= 8; i++) {
				files[`scattered${i}/alpha_0000000000000000_beta_0000000000000000_gamma_${i}.txt`] = `weak ${i}\n`;
			}
			for (let i = 1; i <= 5; i++) {
				files[`strong/feature-widget-${i}.ts`] = `export const widget = ${i};\n`;
			}
			initGitRepo(repoDir, files);

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			// Weak scattered fuzzy matches are capped at 5
			const weakFind = await session.callTool("fffind", {
				pattern: "abgxyz",
				limit: 20,
			});
			expect(weakFind.text).toContain(
				'Query "abgxyz" produced only weak scattered fuzzy matches. Output capped at 5/8.',
			);
			const weakFileLines = weakFind.text
				.split("\n")
				.filter((line) => line.startsWith("scattered"));
			expect(weakFileLines).toHaveLength(5);

			// Strong matches paginate cleanly via cursor="..."
			const strongPage1 = await session.callTool("fffind", {
				pattern: "feature-widget",
				limit: 2,
			});
			expect(strongPage1.text).not.toContain("weak scattered");
			expect(strongPage1.result.details).toMatchObject({
				totalMatched: 5,
				pageIndex: 0,
				hasMore: true,
			});
			const findCursorMatch1 = strongPage1.text.match(
				/3 more matches available\. cursor="([^"]+)" to continue/,
			);
			expect(findCursorMatch1).not.toBeNull();

			const strongPage2 = await session.callTool("fffind", {
				pattern: "feature-widget",
				limit: 2,
				cursor: findCursorMatch1![1],
			});
			expect(strongPage2.result.details).toMatchObject({
				totalMatched: 5,
				pageIndex: 1,
				hasMore: true,
			});
			const findCursorMatch2 = strongPage2.text.match(
				/1 more match available\. cursor="([^"]+)" to continue/,
			);
			expect(findCursorMatch2).not.toBeNull();

			const strongPage3 = await session.callTool("fffind", {
				pattern: "feature-widget",
				limit: 2,
				cursor: findCursorMatch2![1],
			});
			expect(strongPage3.result.details).toMatchObject({
				totalMatched: 5,
				pageIndex: 2,
				hasMore: false,
			});
			expect(strongPage3.text).not.toContain("cursor=");

			const page1Items = strongPage1.text
				.split("\n")
				.filter((line) => line.startsWith("strong/"));
			const page2Items = strongPage2.text
				.split("\n")
				.filter((line) => line.startsWith("strong/"));
			expect(page1Items).toHaveLength(2);
			expect(page2Items).toHaveLength(2);
			expect(page2Items).not.toEqual(page1Items);

			await session.emit("session_shutdown");
		});

		it("registers fff-multi-grep when PI_FFF_MULTIGREP=1 and searches multiple literal patterns", async () => {
			process.env.PI_FFF_MULTIGREP = "1";

			const repoDir = path.join(sandboxDir, "multigrep-repo");
			initGitRepo(repoDir, {
				"src/snake.py": "def fetch_user_profile():\n    return 1\n",
				"src/camel.ts": "export function fetchUserProfile() { return 2; }\n",
				"src/pascal.tsx": "export function FetchUserProfile() { return null; }\n",
				"test/ignored.test.ts": "fetchUserProfile();\n",
			});

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			expect(session.getActiveTools()).toContain("fff-multi-grep");

			const multiOut = await session.callTool("fff-multi-grep", {
				patterns: ["fetch_user_profile", "fetchUserProfile", "FetchUserProfile"],
				constraints: "!test/",
			});
			expect(multiOut.text).toContain("src/snake.py");
			expect(multiOut.text).toContain("src/camel.ts");
			expect(multiOut.text).toContain("src/pascal.tsx");
			expect(multiOut.text).not.toContain("test/ignored.test.ts");

			await expect(
				session.callTool("fff-multi-grep", { patterns: [] }),
			).rejects.toThrow(/at least 1 element/);

			await session.emit("session_shutdown");
		});

		it("extracts @query and @\"path with spaces\" prefixes, quotes spaced paths, and delegates to fallback when aborted or empty", async () => {
			const repoDir = path.join(sandboxDir, "mentions-repo");
			initGitRepo(repoDir, {
				"src/router.ts": "export const router = true;\n",
				"my docs/design notes.md": "# Design Notes\n",
			});

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			const provider = session.getAutocompleteProvider();

			// 1) @query prefix returns unquoted @path for paths without spaces
			const plainLine = "please inspect @router";
			const plainRes = await provider.getSuggestions(
				[plainLine],
				0,
				plainLine.length,
				{ signal: new AbortController().signal },
			);
			expect(plainRes?.prefix).toBe("@router");
			expect(plainRes?.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						value: "@src/router.ts",
						label: "router.ts",
						description: "src/router.ts",
					}),
				]),
			);

			// 2) @"path with spaces prefix extracts query without '@"' and quotes completion value
			const spacedLine = 'compare @"my docs/design';
			const spacedRes = await provider.getSuggestions(
				[spacedLine],
				0,
				spacedLine.length,
				{ signal: new AbortController().signal },
			);
			expect(spacedRes?.prefix).toBe('@"my docs/design');
			const spacedItem = spacedRes?.items.find((item) =>
				item.description === "my docs/design notes.md",
			);
			expect(spacedItem).toBeDefined();
			expect(spacedItem?.value).toBe('@"my docs/design notes.md"');

			const applied = provider.applyCompletion(
				[spacedLine],
				0,
				spacedLine.length,
				spacedItem!,
				spacedRes!.prefix,
			);
			expect(applied.lines[0]).toBe('compare @"my docs/design notes.md"');

			// 3) Delegates to fallback provider when signal is aborted
			const callsBeforeAbort = session.fallbackSuggestionsCalls.length;
			const abortedController = new AbortController();
			abortedController.abort();
			const abortedRes = await provider.getSuggestions(
				["@router"],
				0,
				7,
				{ signal: abortedController.signal },
			);
			expect(session.fallbackSuggestionsCalls.length).toBe(callsBeforeAbort + 1);
			expect(abortedRes?.items[0]?.value).toBe("@fallback-item");

			// 4) Delegates to fallback provider when FFF returns 0 matches
			const callsBeforeEmpty = session.fallbackSuggestionsCalls.length;
			const emptyRes = await provider.getSuggestions(
				["@zzzz_nonexistent_token_987654"],
				0,
				30,
				{ signal: new AbortController().signal },
			);
			expect(session.fallbackSuggestionsCalls.length).toBe(callsBeforeEmpty + 1);
			expect(emptyRes?.items[0]?.value).toBe("@fallback-item");

			await session.emit("session_shutdown");
		});

		it("renders compact and expanded call/result Components within narrow terminal widths", async () => {
			process.env.PI_FFF_MULTIGREP = "1";

			const repoDir = path.join(sandboxDir, "render-repo");
			initGitRepo(repoDir, {
				"src/index.ts": "export const renderMe = 1;\n",
			});

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");

			const theme = createAnsiTheme();
			const ffgrep = session.tools.get("ffgrep")!;
			const fffind = session.tools.get("fffind")!;
			const multiGrep = session.tools.get("fff-multi-grep")!;

			const grepRowCtx = { isError: false, lastComponent: undefined } as never;
			const callComponent = ffgrep.renderCall!(
				{
					pattern: "veryLongIdentifierPatternThatExceedsNarrowTerminalWidth",
					path: "src/deeply/nested/subtrees",
					limit: 10,
					context: 3,
					cursor: "fff_c1",
				},
				theme,
				grepRowCtx,
			);

			for (const width of [80, 28, 12, 4]) {
				const renderedCallLines = callComponent.render(width);
				expect(renderedCallLines.length).toBeGreaterThan(0);
				for (const line of renderedCallLines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
			expect(stripAnsi(callComponent.render(160).join("\n"))).toContain(
				"ffgrep /veryLongIdentifierPatternThatExceedsNarrowTerminalWidth/ in src/deeply/nested/subtrees (limit 10, context 3) (page)",
			);

			const findCallComponent = fffind.renderCall!(
				{ pattern: "component.tsx", path: "src", limit: 15, cursor: "1" },
				theme,
				{ isError: false } as never,
			);
			expect(stripAnsi(findCallComponent.render(100).join("\n"))).toContain(
				"fffind component.tsx in src (limit 15) (page)",
			);
			for (const line of findCallComponent.render(20)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(20);
			}

			const sampleLines = Array.from(
				{ length: 20 },
				(_, idx) => `src/very/long/path/module-${idx + 1}.ts: match content on line ${idx + 1}`,
			).join("\n");
			const sampleResult: AgentToolResult<unknown> = {
				content: [{ type: "text", text: sampleLines }],
				details: {},
			};

			// Compact result: 1 line with "... (19 more lines)" suffix, clipped cleanly to narrow widths
			const compactResult = ffgrep.renderResult!(
				sampleResult,
				{ expanded: false, isPartial: false },
				theme,
				grepRowCtx,
			);
			expect(stripAnsi(compactResult.render(120).join("\n"))).toContain("... (19 more lines)");
			for (const width of [40, 28, 16]) {
				const compactLines = compactResult.render(width);
				expect(compactLines).toHaveLength(1);
				expect(visibleWidth(compactLines[0]!)).toBeLessThanOrEqual(width);
			}

			// Expanded result: shows all 20 lines and wraps within narrow width
			const expandedResult = ffgrep.renderResult!(
				sampleResult,
				{ expanded: true, isPartial: false },
				theme,
				grepRowCtx,
			);
			const expandedWideText = stripAnsi(expandedResult.render(120).join("\n"));
			expect(expandedWideText).toContain("module-1.ts");
			expect(expandedWideText).toContain("module-20.ts");
			for (const line of expandedResult.render(24)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			}

			// Empty result renders "No output"
			const emptyRendered = fffind.renderResult!(
				{ content: [{ type: "text", text: "" }], details: {} },
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false } as never,
			);
			expect(stripAnsi(emptyRendered.render(40).join("\n")).trim()).toBe("No output");

			// fff-multi-grep preview renderer caps at 15 lines when collapsed and expands all lines
			const multiCall = multiGrep.renderCall!(
				{ patterns: ["alpha_one", "alphaOne"], constraints: "*.ts", cursor: "fff_c2" },
				theme,
				{ isError: false } as never,
			);
			expect(stripAnsi(multiCall.render(100).join("\n"))).toContain(
				'fff-multi-grep "alpha_one", "alphaOne" (*.ts) (page)',
			);

			const multiCollapsed = multiGrep.renderResult!(
				sampleResult,
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false } as never,
			);
			const multiCollapsedText = stripAnsi(multiCollapsed.render(120).join("\n"));
			expect(multiCollapsedText).toContain("module-15.ts");
			expect(multiCollapsedText).not.toContain("module-16.ts");
			expect(multiCollapsedText).toContain("... (5 more lines)");
			for (const line of multiCollapsed.render(24)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			}

			const multiExpanded = multiGrep.renderResult!(
				sampleResult,
				{ expanded: true, isPartial: false },
				theme,
				{ isError: false } as never,
			);
			expect(stripAnsi(multiExpanded.render(120).join("\n"))).toContain("module-20.ts");

			await session.emit("session_shutdown");
		});
	});

	describe("4. Audit finding regressions", () => {
		it("does not let a child session swallow dbFallbackError before a top-level TUI session, and TUI notifies only once", async () => {
			const repoDir = path.join(sandboxDir, "db-fallback-child-first");
			initGitRepo(repoDir, {
				"src/item.ts": "export const DB_FALLBACK_ITEM = 1;\n",
			});

			// Regular file at frecencyDbPath forces LMDB open failure and db-less fallback in sidecar.mjs.
			const brokenFrecencyDb = path.join(sandboxDir, "corrupt-frecency-file.lmdb");
			writeFileSync(brokenFrecencyDb, "not a directory", "utf8");

			const backend = trackBackend();
			const flags = {
				"fff-frecency-db": brokenFrecencyDb,
				"fff-history-db": path.join(sandboxDir, "history-db"),
			};

			// 1) Child session ensures first: must NOT notify and must NOT clear sidecar's dbFallbackError.
			const child = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "print",
				flags,
			});
			await child.emit("session_start");
			expect(child.notifications).toEqual([]);

			// 2) Subsequent top-level TUI session ensures the warm root: MUST receive and display dbFallbackError once.
			const topLevel = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
				flags,
			});
			await topLevel.emit("session_start");
			const errorNotifications = topLevel.notifications.filter((n) => n.type === "error");
			expect(errorNotifications).toHaveLength(1);
			expect(errorNotifications[0]?.message).toContain(
				"Failed to open frecency/history database",
			);

			// 3) Further tool calls on the same top-level session do not duplicate the DB fallback error.
			const grepOut = await topLevel.callTool("ffgrep", { pattern: "DB_FALLBACK_ITEM" });
			expect(grepOut.text).toContain("src/item.ts");
			expect(topLevel.notifications.filter((n) => n.type === "error")).toHaveLength(1);

			await child.emit("session_shutdown");
			await topLevel.emit("session_shutdown");
		});

		it("warns only once when creating a home-covering ~/ aux root, not on subsequent warm ~/ queries", async () => {
			const repoDir = path.join(sandboxDir, "warm-home-aux-repo");
			initGitRepo(repoDir, {
				"src/local.ts": "export const LOCAL = true;\n",
			});
			const canonicalHome = realpathSync(os.homedir());
			const ensured = new Set<string>();

			const stubBackend: FffBackend = {
				async ensureRoot(opts) {
					const canon = realpathSync(opts.basePath);
					const created = !ensured.has(canon);
					ensured.add(canon);
					return { root: canon, created };
				},
				async getScanProgress() {
					return {
						ok: true,
						value: {
							isScanning: false,
							scannedFilesCount: 1,
							isWatcherReady: true,
							isWarmupComplete: true,
						},
					};
				},
				async grep() {
					return {
						ok: true,
						value: {
							items: [],
							totalMatched: 0,
							totalFilesSearched: 1,
							totalFiles: 1,
							filteredFileCount: 1,
							nextCursor: null,
						},
					};
				},
				async multiGrep() {
					return {
						ok: true,
						value: {
							items: [],
							totalMatched: 0,
							totalFilesSearched: 1,
							totalFiles: 1,
							filteredFileCount: 1,
							nextCursor: null,
						},
					};
				},
				async fileSearch() {
					return {
						ok: true,
						value: { items: [], scores: [], totalMatched: 0, totalFiles: 1 },
					};
				},
				async mixedSearch() {
					return {
						ok: true,
						value: {
							items: [],
							scores: [],
							totalMatched: 0,
							totalFiles: 1,
							totalDirs: 0,
						},
					};
				},
				async healthCheck() {
					return { ok: false, error: "unused" };
				},
				async scanFiles() {
					return { ok: true, value: true };
				},
				getPid() {
					return 99999;
				},
				async dispose() {},
			};

			const session = createSessionHarness({
				backend: stubBackend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await session.emit("session_start");
			expect(session.notifications).toEqual([]);

			// Cold ~/ query creates the aux root (created: true) -> warns once.
			await session.callTool("fffind", {
				pattern: "probe",
				path: "~/__pi_fff_nonexistent_subdir_probe__",
			});
			expect(ensured.has(canonicalHome)).toBe(true);
			expect(session.notifications).toHaveLength(1);
			expect(session.notifications[0]?.type).toBe("warning");
			expect(session.notifications[0]?.message).toContain("is too large");

			// Subsequent warm ~/ queries reuse the aux root (created: false) -> no extra warnings.
			await session.callTool("fffind", {
				pattern: "probe",
				path: "~/__pi_fff_nonexistent_subdir_probe__",
			});
			await session.callTool("ffgrep", {
				pattern: "probe",
				path: "~/__pi_fff_nonexistent_subdir_probe__",
			});
			expect(session.notifications).toHaveLength(1);

			await session.emit("session_shutdown");
		});

		it("preserves grep and find pagination cursors across /reload (separate createFffExtension instances)", async () => {
			const repoDir = path.join(sandboxDir, "reload-cursor-repo");
			const files: Record<string, string> = {};
			for (let i = 1; i <= 5; i++) {
				files[`src/reload-target-${i}.ts`] = `export const RELOAD_CURSOR_TOKEN = ${i};\n`;
			}
			initGitRepo(repoDir, files);

			const backend = trackBackend();

			// Instance 1 (before /reload) produces page 1 cursors for ffgrep and fffind.
			const beforeReload = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await beforeReload.emit("session_start");

			const grepPage1 = await beforeReload.callTool("ffgrep", {
				pattern: "RELOAD_CURSOR_TOKEN",
				limit: 2,
			});
			const grepCursor = grepPage1.text.match(/cursor="(fff_c\d+)"/)?.[1];
			expect(grepCursor).toBeDefined();

			const findPage1 = await beforeReload.callTool("fffind", {
				pattern: "reload-target",
				limit: 2,
			});
			const findCursor = findPage1.text.match(/cursor="([^"]+)" to continue/)?.[1];
			expect(findCursor).toBeDefined();

			await beforeReload.emit("session_shutdown");

			// Instance 2 (after /reload: brand-new createFffExtension instance) consumes both cursors.
			const afterReload = createSessionHarness({
				backend,
				agentDir,
				cwd: repoDir,
				mode: "tui",
			});
			await afterReload.emit("session_start");

			const grepPage2 = await afterReload.callTool("ffgrep", {
				pattern: "RELOAD_CURSOR_TOKEN",
				limit: 2,
				cursor: grepCursor,
			});
			const grepPage1Files = grepPage1.text
				.split("\n")
				.filter((l) => l.startsWith("src/reload-target-"));
			const grepPage2Files = grepPage2.text
				.split("\n")
				.filter((l) => l.startsWith("src/reload-target-"));
			expect(grepPage2Files).toHaveLength(2);
			expect(grepPage2Files.some((f) => grepPage1Files.includes(f))).toBe(false);

			const findPage2 = await afterReload.callTool("fffind", {
				pattern: "reload-target",
				limit: 2,
				cursor: findCursor,
			});
			expect(findPage2.result.details).toMatchObject({
				totalMatched: 5,
				pageIndex: 1,
				hasMore: true,
			});

			await afterReload.emit("session_shutdown");
		});

		it("honors ctx.cwd in tool execute, deduplicates autocomplete registration, and resets currentWorkspaceRoot on session_start", async () => {
			process.env.PI_FFF_MULTIGREP = "1";

			const repoA = path.join(sandboxDir, "cwd-repo-a");
			const repoB = path.join(sandboxDir, "cwd-repo-b");
			initGitRepo(repoA, {
				"src/only-in-a.ts": "export const TOKEN_ONLY_A = 1;\n",
			});
			initGitRepo(repoB, {
				"pkg/only-in-b.ts": "export const TOKEN_ONLY_B = 2;\n",
			});

			const backend = trackBackend();
			const session = createSessionHarness({
				backend,
				agentDir,
				cwd: repoA,
				mode: "tui",
				flags: { "fff-enable-home-scan": false },
			});
			await session.emit("session_start");
			expect(session.getAutocompleteRegistrations()).toBe(1);

			// Repeated session_start on the same UI context does not stack autocomplete wrappers.
			await session.emit("session_start");
			expect(session.getAutocompleteRegistrations()).toBe(1);

			// Cross-cwd tool invocations use ctx.cwd (repoB) rather than activeCwd (repoA).
			const crossCtx = { ...session.ctx, cwd: repoB };
			const crossFind = await session.tools
				.get("fffind")!
				.execute("call-find-b", { pattern: "only-in-b" } as never, undefined, undefined, crossCtx);
			expect(
				crossFind.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
			).toContain("pkg/only-in-b.ts");

			const crossGrep = await session.tools
				.get("ffgrep")!
				.execute(
					"call-grep-b",
					{ pattern: "TOKEN_ONLY_B", path: "pkg" } as never,
					undefined,
					undefined,
					crossCtx,
				);
			expect(
				crossGrep.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
			).toContain("pkg/only-in-b.ts");

			const crossMulti = await session.tools
				.get("fff-multi-grep")!
				.execute(
					"call-multi-b",
					{ patterns: ["TOKEN_ONLY_B"] } as never,
					undefined,
					undefined,
					crossCtx,
				);
			expect(
				crossMulti.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
			).toContain("pkg/only-in-b.ts");

			// Switching session_start to opted-out $HOME resets currentWorkspaceRoot so /fff-health warns cleanly.
			(session.ctx as { cwd: string }).cwd = os.homedir();
			await session.emit("session_start");
			await session.runCommand("fff-health");
			expect(session.notifications.at(-1)?.type).toBe("warning");
			expect(session.notifications.at(-1)?.message).toContain("FFF not initialized:");

			await session.emit("session_shutdown");
		});
	});

	describe("5. child-session-hooks registration and deduplication", () => {
		it("exposes the 'fff' child-session hook, activates fffind/ffgrep on a noExtensions child session, and never double-registers", async () => {
			const parentRepo = path.join(sandboxDir, "hook-parent-repo");
			const stepWorktree = path.join(sandboxDir, "hook-herder-step");
			initGitRepo(parentRepo, {
				"src/parent-main.ts": "export const PARENT_HOOK_TOKEN = 'PARENT_HOOK_789';\n",
			});
			git(parentRepo, "worktree", "add", "-q", "--detach", stepWorktree, "HEAD");
			writeFileSync(
				path.join(stepWorktree, "src", "step-local.ts"),
				"export const STEP_HOOK_TOKEN = 'HERDER_STEP_SHARED_FFF';\n",
				"utf8",
			);

			const backend = trackBackend();
			const globalStore = globalThis as unknown as Record<symbol, unknown>;
			const prevSharedBackend = globalStore[SHARED_BACKEND_KEY];
			globalStore[SHARED_BACKEND_KEY] = backend;

			try {
				// 1) Activate default fffExtension on parent session, then simulate /reload -> single idempotent "fff" hook.
				const parent1 = createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "tui",
					extensionSetup: fffExtension,
				});
				await parent1.emit("session_start");

				const getFffHooks = (): ChildSessionHook[] => {
					const set = globalStore[CHILD_SESSION_HOOKS];
					expect(set).toBeInstanceOf(Set);
					return [...(set as Set<ChildSessionHook>)].filter((h) => h.name === "fff");
				};

				expect(getFffHooks()).toHaveLength(1);

				// Simulate /reload on parent: second fffExtension activation replaces rather than duplicating "fff".
				const parent2 = createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "tui",
					extensionSetup: fffExtension,
				});
				await parent2.emit("session_start");
				await parent1.emit("session_shutdown");

				const fffHooks = getFffHooks();
				expect(fffHooks).toHaveLength(1);
				const fffHook = fffHooks[0]!;
				expect(typeof fffHook.extensionFactory).toBe("function");

				const parentPid = backend.getPid();
				expect(typeof parentPid).toBe("number");

				// 2) Fresh `noExtensions: true` child ExtensionAPI (Herder step): ONLY child-session-hooks run.
				const herderChild = createSessionHarness({
					backend,
					agentDir,
					cwd: stepWorktree,
					mode: "print",
					entries: [
						{
							type: "custom",
							customType: SESSION_LINK_TYPE,
							data: { kind: "herder-step", parentSessionId: "parent-2" },
						},
					],
					extensionSetup: false,
				});
				expect(herderChild.tools.has("fffind")).toBe(false);
				expect(herderChild.tools.has("ffgrep")).toBe(false);

				fffHook.extensionFactory(herderChild.pi);
				await herderChild.emit("session_start");

				expect(herderChild.tools.has("fffind")).toBe(true);
				expect(herderChild.tools.has("ffgrep")).toBe(true);
				expect(herderChild.notifications).toEqual([]);
				expect(herderChild.getAutocompleteRegistrations()).toBe(0);

				const stepFind = await herderChild.callTool("fffind", { pattern: "step-local.ts" });
				expect(stepFind.text).toContain("src/step-local.ts");

				const stepGrep = await herderChild.callTool("ffgrep", {
					pattern: "HERDER_STEP_SHARED_FFF",
				});
				expect(stepGrep.text).toContain("src/step-local.ts");
				expect(backend.getPid()).toBe(parentPid);

				await herderChild.emit("session_shutdown");
				// Parent is still open, so "fff" hook stays registered.
				expect(getFffHooks()).toHaveLength(1);

				// 3a) Deduplication on the SAME ExtensionAPI when both normal loading and child-session-hooks run.
				const sameApiChild = createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "print",
					extensionSetup: fffExtension,
				});
				const callsAfterNormalLoad = sameApiChild.getRegisterToolCalls();
				const handlersAfterNormalLoad = sameApiChild.getHandlerCount("session_start");
				expect(callsAfterNormalLoad).toBeGreaterThanOrEqual(2);
				expect(handlersAfterNormalLoad).toBe(1);

				// Invoking child-session-hooks on the same ExtensionAPI must be a complete no-op!
				fffHook.extensionFactory(sameApiChild.pi);
				expect(sameApiChild.getRegisterToolCalls()).toBe(callsAfterNormalLoad);
				expect(sameApiChild.getHandlerCount("session_start")).toBe(1);
				await sameApiChild.emit("session_shutdown");

				// 3b) Deduplication across two ExtensionAPI wrappers sharing one DefaultResourceLoader eventBus (subagents `extensions: true`).
				const busListeners = new Map<string, Set<(data: unknown) => void>>();
				const sharedEvents = {
					emit(channel: string, data: unknown) {
						for (const fn of busListeners.get(channel) ?? []) {
							fn(data);
						}
					},
					on(channel: string, handler: (data: unknown) => void) {
						let set = busListeners.get(channel);
						if (!set) {
							set = new Set();
							busListeners.set(channel, set);
						}
						set.add(handler);
						return () => {
							set?.delete(handler);
						};
					},
				};

				const discoveredExtApi = createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "print",
					events: sharedEvents,
					extensionSetup: fffExtension,
				});
				const inlineHookExtApi = createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "print",
					events: sharedEvents,
					extensionSetup: false,
				});
				fffHook.extensionFactory(inlineHookExtApi.pi);

				expect(discoveredExtApi.getRegisterToolCalls()).toBeGreaterThanOrEqual(2);
				expect(inlineHookExtApi.getRegisterToolCalls()).toBe(0);
				expect(inlineHookExtApi.getHandlerCount("session_start")).toBe(0);

				// 4) Discarded discovered load (e.g. filtered out by subagent extensionsOverride before session_start)
				// must NOT leak an open instance or keep the hook registered after active sessions shut down.
				createSessionHarness({
					backend,
					agentDir,
					cwd: parentRepo,
					mode: "print",
					extensionSetup: fffExtension,
				});

				// 5) Child-hook invocation stays on fffind/ffgrep even when pi-fff.json sets mode="override",
				// and skips warming roots when pi.getAllTools() admitted no FFF tools.
				writeFileSync(
					path.join(agentDir, "pi-fff.json"),
					JSON.stringify({ mode: "override" }),
					"utf8",
				);
				const overrideHookChild = createSessionHarness({
					backend,
					agentDir,
					cwd: stepWorktree,
					mode: "print",
					entries: [
						{ type: "custom", customType: SESSION_LINK_TYPE, data: { kind: "herder-step" } },
						{ type: "custom", customType: "fff-mode", data: { mode: "override" } },
					],
					extensionSetup: false,
				});
				fffHook.extensionFactory(overrideHookChild.pi);
				await overrideHookChild.emit("session_start");
				expect(overrideHookChild.getActiveTools()).toContain("fffind");
				expect(overrideHookChild.getActiveTools()).toContain("ffgrep");
				expect((await overrideHookChild.callTool("grep", {})).text).toBe("builtin:grep");
				expect((await overrideHookChild.callTool("find", {})).text).toBe("builtin:find");
				await overrideHookChild.emit("session_shutdown");

				let ensureCalls = 0;
				const countingBackend: FffBackend = {
					ensureRoot: async (opts, sig) => {
						ensureCalls++;
						return backend.ensureRoot(opts, sig);
					},
					getScanProgress: (r, s) => backend.getScanProgress(r, s),
					grep: (r, q, o, s) => backend.grep(r, q, o, s),
					multiGrep: (r, o, s) => backend.multiGrep(r, o, s),
					fileSearch: (r, q, o, s) => backend.fileSearch(r, q, o, s),
					mixedSearch: (r, q, o, s) => backend.mixedSearch(r, q, o, s),
					healthCheck: (r, s) => backend.healthCheck(r, s),
					scanFiles: (r, s) => backend.scanFiles(r, s),
					getPid: () => backend.getPid(),
					dispose: () => backend.dispose(),
				};
				const gatedParent = createSessionHarness({
					backend: countingBackend,
					agentDir: path.join(sandboxDir, "gated-agent"),
					cwd: os.homedir(),
					mode: "tui",
					flags: { "fff-enable-home-scan": false, "fff-warn-home-scan": false },
				});
				await gatedParent.emit("session_start");
				const gatedHook = getFffHooks()[0]!;
				const verifierLikeChild = createSessionHarness({
					backend: countingBackend,
					agentDir: path.join(sandboxDir, "gated-agent"),
					cwd: stepWorktree,
					mode: "print",
					extensionSetup: false,
				});
				(verifierLikeChild.pi as unknown as { getAllTools: () => Array<{ name: string }> }).getAllTools =
					() => [{ name: "read" }, { name: "bash" }];
				gatedHook.extensionFactory(verifierLikeChild.pi);
				await verifierLikeChild.emit("session_start");
				expect(ensureCalls).toBe(0);
				await verifierLikeChild.emit("session_shutdown");
				await gatedParent.emit("session_shutdown");

				await discoveredExtApi.emit("session_shutdown");
				await parent2.emit("session_shutdown");
				expect(getFffHooks()).toHaveLength(0);
			} finally {
				if (prevSharedBackend === undefined) {
					delete globalStore[SHARED_BACKEND_KEY];
				} else {
					globalStore[SHARED_BACKEND_KEY] = prevSharedBackend;
				}
			}
		});
	});
});
