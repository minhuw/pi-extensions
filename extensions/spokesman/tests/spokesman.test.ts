import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildSpokesmanPrompt,
	createSpokesmanEntryRenderer,
	evaluateProseForSpokesman,
	formatSpokesmanSeparator,
	hasNerdFonts,
	HIDDEN_ORIGINAL_MARKER,
	isMainModelEnabled,
	matchesModelPattern,
	SPOKESMAN_REWRITE_ENTRY,
	SPOKESMAN_STATE_ENTRY,
	stripNonProse,
	type SpokesmanRewriteData,
	type TurnWorkItem,
} from "../index.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const SESSION_LINK = "pi-extensions.session-link";

const DENSE_SOL_DRAFT = [
	"Completed cross-subsystem canonicalization/reconciliation/dispatch across the distributed session-state hydration pipeline (cfg_84a -> blk_19 -> ctx_final) while verifying that runtime invariance held under multi-stage validation/normalization/serialization during concurrent asynchronous execution.",
	"Specifically, the pre-settlement boundary orchestration layer exhibited non-deterministic state-transition invalidation whenever concurrent toolResult payloads interacted with deferred context-window compaction heuristics across active branches, necessitating a unified idempotency-preservation transformation before final persistence.",
].join(" ");

const CLEAR_SPOKESMAN_REWRITE =
	"I fixed the session state hydration bug so tool results no longer corrupt state during context compaction.";

type Message = { role: string; content: unknown };
interface Captured {
	system: string;
	conversation: Message[];
}

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return {
		system: getCurrentSystemPrompt(messages),
		conversation: copy.filter((message) => message.role !== "system"),
	};
};

const textOf = ({ content }: Message): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

const plainTheme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

describe("filter.ts unit tests", () => {
	it("stripNonProse removes fenced code blocks, inline code, URLs, file paths, and markdown tables while keeping prose", () => {
		const raw = [
			"Updated `src/core/runner.ts` and ./scripts/deploy.sh:42 after checking [the API docs](https://example.com/docs/v1) and https://example.com/status.",
			"",
			"```ts",
			"const internalNominalizationOrchestration = true;",
			"```",
			"",
			"| Metric | Value |",
			"| --- | --- |",
			"| latency | 12ms |",
			"",
			"All tests in `extensions/spokesman/tests/spokesman.test.ts` and index.ts:108 now pass.",
		].join("\n");

		const prose = stripNonProse(raw);
		expect(prose).toContain("Updated");
		expect(prose).toContain("after checking the API docs and");
		expect(prose).toContain("All tests in");
		expect(prose).toContain("now pass.");
		expect(prose).not.toContain("internalNominalizationOrchestration");
		expect(prose).not.toContain("src/core/runner.ts");
		expect(prose).not.toContain("./scripts/deploy.sh:42");
		expect(prose).not.toContain("https://example.com");
		expect(prose).not.toContain("| Metric |");
		expect(prose).not.toContain("index.ts:108");
	});

	it("evaluateProseForSpokesman skips short and clear responses", () => {
		const shortClear = "Done. Updated `src/index.ts` and all 12 tests pass.";
		const result = evaluateProseForSpokesman(shortClear);
		expect(result.rewrite).toBe(false);
		expect(result.signals).toEqual([]);
	});

	it("evaluateProseForSpokesman flags dense gpt-6-sol-style prose with noun stacks, long sentences, abstract nominalizations, telegraphic compression, and private-context leakage", () => {
		const workItems: TurnWorkItem[] = [
			{ toolName: "read", summary: "src/session.ts", outputExcerpt: "export class Session {}" },
			{ toolName: "edit", summary: "src/session.ts", outputExcerpt: "Updated lines 10-45" },
			{ toolName: "bash", summary: "npm test", outputExcerpt: "14 passed" },
		];

		const evaluation = evaluateProseForSpokesman(DENSE_SOL_DRAFT, workItems);
		expect(evaluation.rewrite).toBe(true);
		expect(evaluation.score).toBeGreaterThanOrEqual(2);
		expect(evaluation.signals).toEqual(
			expect.arrayContaining([
				"long-sentences",
				"noun-stacks",
				"abstract-density",
				"telegraphic-compression",
				"private-context-leak",
			]),
		);
	});

	it("buildSpokesmanPrompt includes user request, work record, draft reply, original model name, and language instruction", () => {
		const prompt = buildSpokesmanPrompt({
			userRequest: "Why did the build fail and how did you fix it?",
			recentDialogue: "User: Check the build.\nAssistant: Investigating now.",
			workItems: [
				{
					toolName: "bash",
					summary: "npm run typecheck",
					outputExcerpt: "error TS2322 in src/index.ts",
					isError: true,
				},
				{
					toolName: "edit",
					summary: "src/index.ts",
					outputExcerpt: "Fixed return type annotation",
				},
			],
			draftReply: DENSE_SOL_DRAFT,
			originalModel: "gpt-6-sol",
			language: "Simplified Chinese",
		});

		expect(prompt.systemPrompt).toContain(
			"Write the prose in Simplified Chinese. Keep code, identifiers, commands, and file paths unchanged.",
		);
		expect(prompt.userPrompt).toContain("[User's latest request]\nWhy did the build fail and how did you fix it?");
		expect(prompt.userPrompt).toContain("[Recent conversation]\nUser: Check the build.");
		expect(prompt.userPrompt).toContain("[Work record]");
		expect(prompt.userPrompt).toContain("1. bash [error]: npm run typecheck");
		expect(prompt.userPrompt).toContain("Output: error TS2322 in src/index.ts");
		expect(prompt.userPrompt).toContain("2. edit: src/index.ts");
		expect(prompt.userPrompt).toContain(`[Draft response from gpt-6-sol]\n${DENSE_SOL_DRAFT}`);
	});
});

describe("main-model filter", () => {
	const sol = { id: "gpt-6-sol", provider: "openai" };

	it("matchesModelPattern matches ids, provider/id, and * globs case-insensitively", () => {
		expect(matchesModelPattern("gpt-6-sol", sol)).toBe(true);
		expect(matchesModelPattern("GPT-6-SOL", sol)).toBe(true);
		expect(matchesModelPattern("gpt-6-*", sol)).toBe(true);
		expect(matchesModelPattern("gpt-6", sol)).toBe(false);
		expect(matchesModelPattern("gpt-6.sol", sol)).toBe(false);
		expect(matchesModelPattern("openai/*", sol)).toBe(true);
		expect(matchesModelPattern("openai/gpt-6-sol", sol)).toBe(true);
		expect(matchesModelPattern("anthropic/gpt-6-sol", sol)).toBe(false);
		expect(matchesModelPattern("*/gpt-6-sol", { id: "gpt-6-sol" })).toBe(true);
		// Ids that contain a slash (e.g. OpenRouter) match a slash pattern against the bare id too.
		expect(
			matchesModelPattern("anthropic/claude-*", { id: "anthropic/claude-opus", provider: "openrouter" }),
		).toBe(true);
	});

	it("isMainModelEnabled allows every model without a list and requires a match with one", () => {
		expect(isMainModelEnabled(undefined, sol)).toBe(true);
		expect(isMainModelEnabled([], sol)).toBe(true);
		expect(isMainModelEnabled(["claude-*", "gpt-6-*"], sol)).toBe(true);
		expect(isMainModelEnabled(["claude-*"], sol)).toBe(false);
		expect(isMainModelEnabled(["claude-*"], undefined)).toBe(false);
	});
});

describe("ui.ts unit tests", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("formatSpokesmanSeparator includes spokesman model name, respects width bounds, and toggles Nerd Font icon", () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
		expect(hasNerdFonts()).toBe(true);
		const withIcon = formatSpokesmanSeparator(plainTheme, "gpt-5.4", hasNerdFonts(), 60);
		expect(withIcon).toContain("\u{F05CB} Spokesman");
		expect(withIcon).toContain("gpt-5.4");
		expect(visibleWidth(withIcon)).toBeLessThanOrEqual(60);

		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		expect(hasNerdFonts()).toBe(false);
		const withoutIcon = formatSpokesmanSeparator(plainTheme, "gpt-5.4", hasNerdFonts(), 60);
		expect(withoutIcon).not.toContain("\u{F05CB}");
		expect(withoutIcon).toContain("Spokesman · gpt-5.4");
		expect(visibleWidth(withoutIcon)).toBeLessThanOrEqual(60);

		for (const width of [12, 24, 40, 72, 120]) {
			const line = formatSpokesmanSeparator(plainTheme, "gpt-5.4", false, width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("createSpokesmanEntryRenderer folds original response by default, toggles on mouse click, and respects options.expanded", () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const renderer = createSpokesmanEntryRenderer(1);
		const entry: CustomEntry<SpokesmanRewriteData> = {
			type: "custom",
			id: "entry-rewrite-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: SPOKESMAN_REWRITE_ENTRY,
			data: {
				targetEntryId: "msg-1",
				originalText: "Cryptic original body from sol model.",
				rewrittenText: "Clear rewritten explanation from spokesman.",
				originalModel: "gpt-6-sol",
				spokesmanModel: "gpt-5.4",
				spokesmanProvider: "faux",
				mode: "auto",
				signals: ["noun-stacks"],
				timestamp: Date.now(),
			},
		};

		const component = renderer(entry, { expanded: false } as never, plainTheme)!;
		expect(component).toBeDefined();

		const collapsedText = component.render(80).join("\n");
		expect(collapsedText).toContain("▸ Original response (gpt-6-sol)...");
		expect(collapsedText).toContain("Spokesman · gpt-5.4");
		expect(collapsedText).toContain("Clear rewritten explanation from spokesman.");
		expect(collapsedText).not.toContain("Cryptic original body from sol model.");

		// Click the fold line (y: 0) to expand
		const clickEvent = {
			type: "click" as const,
			button: "left" as const,
			x: 2,
			y: 0,
			screenX: 2,
			screenY: 0,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
		const expandResult = component.handleMouse!(clickEvent);
		expect(expandResult?.handled).toBe(true);

		const expandedText = component.render(80).join("\n");
		expect(expandedText).toContain("▾ Original response (gpt-6-sol):");
		expect(expandedText).toContain("Cryptic original body from sol model.");
		expect(expandedText).toContain("Spokesman · gpt-5.4");
		expect(expandedText).toContain("Clear rewritten explanation from spokesman.");

		// Click again to collapse back
		const collapseResult = component.handleMouse!(clickEvent);
		expect(collapseResult?.handled).toBe(true);

		const recollapsedText = component.render(80).join("\n");
		expect(recollapsedText).toContain("▸ Original response (gpt-6-sol)...");
		expect(recollapsedText).not.toContain("Cryptic original body from sol model.");

		// Passing options.expanded = true expands by default
		const preExpanded = renderer(
			{ ...entry, id: "entry-rewrite-2" },
			{ expanded: true } as never,
			plainTheme,
		)!;
		const preExpandedText = preExpanded.render(80).join("\n");
		expect(preExpandedText).toContain("▾ Original response (gpt-6-sol):");
		expect(preExpandedText).toContain("Cryptic original body from sol model.");
	});
});

describe("spokesman extension in real Pi sessions", () => {
	let root: string;
	let previousAgentDir: string | undefined;
	const started: { dispose(): Promise<void> }[] = [];
	const agentDir = () => join(root, "agent");
	const sessionDir = () => join(root, "sessions");
	const cwd = () => join(root, "work");
	const configPath = () => join(agentDir(), "spokesman.json");
	const writeConfig = (value: unknown) =>
		writeFile(configPath(), typeof value === "string" ? value : JSON.stringify(value));
	const newManager = (options?: { parentSession?: string }) =>
		SessionManager.create(cwd(), sessionDir(), options);

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-spokesman-"));
		await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir();
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

	function recordingUi() {
		const notes: { message: string; type?: string }[] = [];
		const statuses = new Map<string, string | undefined>();
		const workingMessages: (string | undefined)[] = [];
		const noop = () => {};
		const context = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			onTerminalInput: () => noop,
			setWorkingMessage: (msg?: string) => {
				workingMessages.push(msg);
			},
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
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
		} as unknown as ExtensionUIContext;
		return { notes, statuses, workingMessages, context };
	}

	async function start(
		options: {
			sessionManager?: SessionManager;
			mode?: ExtensionContext["mode"];
			register?: (pi: ExtensionAPI) => void;
			bindAsChild?: boolean;
		} = {},
	) {
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			api: "spokesman-test-api",
			provider: "faux-openai",
			models: [{ id: "gpt-6-sol" }, { id: "gpt-5.4" }],
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false, keepRecentTokens: 1 },
		});
		const ui = recordingUi();

		const mainRequests: Captured[] = [];
		const spokesmanRequests: Captured[] = [];
		const mainQueue: (string | FauxResponseFactory)[] = [];
		const spokesmanQueue: (string | FauxResponseFactory)[] = [];

		const respond: FauxResponseFactory = (context, streamOptions, state, model) => {
			if (model.id === "gpt-5.4") {
				spokesmanRequests.push(capture(context.messages));
				const next = spokesmanQueue.shift();
				if (typeof next === "function") {
					return next(context, streamOptions, state, model);
				}
				return fauxAssistantMessage(next ?? CLEAR_SPOKESMAN_REWRITE);
			}
			mainRequests.push(capture(context.messages));
			const next = mainQueue.shift();
			if (typeof next === "function") {
				return next(context, streamOptions, state, model);
			}
			return fauxAssistantMessage(next ?? "Fixed the typo in README.md.");
		};
		faux.setResponses(Array.from({ length: 80 }, () => respond));

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
							options.register?.(pi);
						},
					],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel("gpt-6-sol"),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: cwd(),
			agentDir: agentDir(),
			sessionManager: options.sessionManager ?? newManager(),
		});
		const errors: unknown[] = [];
		const bind = () =>
			runtime.session.bindExtensions(
				options.bindAsChild
					? {}
					: {
							mode: options.mode ?? "rpc",
							uiContext: ui.context,
							onError: (error) => {
								errors.push(error);
							},
							commandContextActions: {
								waitForIdle: () => runtime.session.waitForIdle(),
								newSession: (newOptions) => runtime.newSession(newOptions),
								fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
								navigateTree: (targetId, treeOptions) =>
									runtime.session.navigateTree(targetId, treeOptions),
								switchSession: (sessionPath, switchOptions) =>
									runtime.switchSession(sessionPath, switchOptions),
								reload: () => runtime.session.reload(),
							},
						},
			);
		runtime.setRebindSession(bind);
		await bind();

		const harness = {
			runtime,
			faux,
			mainRequests,
			spokesmanRequests,
			mainQueue,
			spokesmanQueue,
			errors,
			...ui,
			get session() {
				return runtime.session;
			},
			get status() {
				return ui.statuses.get(SPOKESMAN_STATE_ENTRY);
			},
			get lastNote() {
				return ui.notes.at(-1);
			},
			command: (text: string) => runtime.session.prompt(text),
			stateEntries: () =>
				runtime.session.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === SPOKESMAN_STATE_ENTRY
							? [entry.data]
							: [],
					),
			rewriteEntries: () =>
				runtime.session.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === SPOKESMAN_REWRITE_ENTRY
							? [entry.data as SpokesmanRewriteData]
							: [],
					),
			assistantMessages: () =>
				runtime.session.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "assistant"
							? [entry.message]
							: [],
					),
			dispose: () => runtime.dispose(),
		};
		started.push(harness);
		return harness;
	}

	it("manages /spokesman commands, <agentDir>/spokesman.json config, and footer statuses", async () => {
		const h = await start();
		expect(h.status).toBeUndefined();

		// Configure default for new sessions
		await h.command("/spokesman default gpt-5.4");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
			default: "gpt-5.4",
			mode: "auto",
		});
		expect(h.status).toBe("gpt-5.4");

		// Switch session mode to always
		await h.command("/spokesman mode always");
		expect(h.status).toBe("gpt-5.4 · always");

		// Switch session mode back to auto
		await h.command("/spokesman mode auto");
		expect(h.status).toBe("gpt-5.4");

		// Switch session spokesman model with provider prefix
		await h.command("/spokesman faux-openai/gpt-5.4 always");
		expect(h.status).toBe("gpt-5.4 · always");

		// Disable spokesman for this session
		await h.command("/spokesman off");
		expect(h.status).toBeUndefined();

		// Reset returns to the session/configured default
		await h.command("/spokesman reset");
		expect(h.status).toBe("gpt-5.4");

		// Repeating reset when no switch is active reports no active switch
		await h.command("/spokesman reset");
		expect(h.lastNote).toEqual({
			message: "No spokesman switch is active.",
			type: "info",
		});

		// Status command reports active spokesman, mode, defaults, and session stats
		await h.command("/spokesman");
		expect(h.lastNote?.type).toBe("info");
		expect(h.lastNote?.message).toContain("Active spokesman: gpt-5.4");
		expect(h.lastNote?.message).toContain("Mode: auto");
		expect(h.lastNote?.message).toContain("Default for new sessions: gpt-5.4 (auto)");

		// Remove default for new sessions
		await h.command("/spokesman default off");
		await expect(access(configPath())).rejects.toThrow();
		expect(h.errors).toEqual([]);
	});

	it("auto mode skips short clear responses and rewrites complex gpt-6-sol responses", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "auto" });
		const h = await start();
		expect(h.status).toBe("gpt-5.4");

		// 1. Short clear response -> not rewritten
		h.mainQueue.push("Fixed the typo in README.md.");
		await h.session.prompt("Fix the typo in README.md");
		expect(h.mainRequests).toHaveLength(1);
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toEqual([]);
		expect(textOf(h.assistantMessages().at(-1) as Message)).toBe("Fixed the typo in README.md.");

		// 2. Dense abstract response -> rewritten by gpt-5.4
		h.mainQueue.push(DENSE_SOL_DRAFT);
		h.spokesmanQueue.push(CLEAR_SPOKESMAN_REWRITE);
		await h.session.prompt("Fix the session hydration bug");

		expect(h.mainRequests).toHaveLength(2);
		expect(h.spokesmanRequests).toHaveLength(1);
		expect(textOf(h.spokesmanRequests[0]!.conversation[0]!)).toContain(
			"Fix the session hydration bug",
		);
		expect(textOf(h.spokesmanRequests[0]!.conversation[0]!)).toContain(DENSE_SOL_DRAFT);

		const rewrites = h.rewriteEntries();
		expect(rewrites).toHaveLength(1);
		expect(rewrites[0]).toMatchObject({
			originalText: DENSE_SOL_DRAFT,
			rewrittenText: CLEAR_SPOKESMAN_REWRITE,
			originalModel: "gpt-6-sol",
			spokesmanModel: "gpt-5.4",
			mode: "auto",
		});
		expect(rewrites[0]!.usage).toBeDefined();
		expect(rewrites[0]!.signals.length).toBeGreaterThan(0);

		const latestAssistant = h.assistantMessages().at(-1) as Message;
		expect(textOf(latestAssistant)).toBe(`${HIDDEN_ORIGINAL_MARKER}${CLEAR_SPOKESMAN_REWRITE}`);
		expect(h.status).toBe("gpt-5.4");
		expect(h.errors).toEqual([]);
	});

	it("rewrites short responses when mode is always", async () => {
		const h = await start();
		await h.command("/spokesman gpt-5.4 always");
		expect(h.status).toBe("gpt-5.4 · always");

		h.mainQueue.push("Done.");
		h.spokesmanQueue.push("I completed the requested task.");
		await h.session.prompt("Run the check");

		expect(h.spokesmanRequests).toHaveLength(1);
		expect(h.rewriteEntries()).toHaveLength(1);
		expect(h.rewriteEntries()[0]).toMatchObject({
			originalText: "Done.",
			rewrittenText: "I completed the requested task.",
			mode: "always",
			signals: ["always"],
		});
		expect(textOf(h.assistantMessages().at(-1) as Message)).toBe(
			`${HIDDEN_ORIGINAL_MARKER}I completed the requested task.`,
		);
	});

	it("passes the rewritten text (without HIDDEN_ORIGINAL_MARKER) to the main model on subsequent turns (Option A)", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "auto" });
		const h = await start();

		// Turn 1: main model emits dense draft (after a tool call), spokesman rewrites it
		let mainCall = 0;
		h.mainQueue.push(
			() => {
				mainCall++;
				return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
					stopReason: "toolUse",
				});
			},
			() => {
				mainCall++;
				return fauxAssistantMessage(DENSE_SOL_DRAFT);
			},
		);
		h.spokesmanQueue.push(CLEAR_SPOKESMAN_REWRITE);

		await h.session.prompt("First turn question");
		expect(mainCall).toBe(2);
		expect(h.spokesmanRequests).toHaveLength(1);
		expect(textOf(h.spokesmanRequests[0]!.conversation[0]!)).toContain("[Work record]");
		expect(textOf(h.spokesmanRequests[0]!.conversation[0]!)).toContain("1. bash: true");

		// Turn 2: next user prompt -> inspect messages sent to gpt-6-sol
		h.mainQueue.push("Ack.");
		await h.session.prompt("Second turn follow-up");

		const turn2Request = h.mainRequests.at(-1)!;
		const assistantTextsInContext = turn2Request.conversation
			.filter((msg) => msg.role === "assistant")
			.map(textOf);

		expect(assistantTextsInContext).toContain(CLEAR_SPOKESMAN_REWRITE);
		for (const text of assistantTextsInContext) {
			expect(text).not.toContain(HIDDEN_ORIGINAL_MARKER.trim());
			expect(text).not.toContain(DENSE_SOL_DRAFT);
		}
		expect(h.errors).toEqual([]);
	});

	it("supports manual /spokesman rewrite on a response that auto mode skipped", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "auto" });
		const h = await start();

		h.mainQueue.push("Updated config.json.");
		await h.session.prompt("Update config.json");
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);

		h.spokesmanQueue.push("I updated `config.json` with the new settings.");
		await h.command("/spokesman rewrite");

		expect(h.spokesmanRequests).toHaveLength(1);
		expect(h.rewriteEntries()).toHaveLength(1);
		expect(h.rewriteEntries()[0]).toMatchObject({
			originalText: "Updated config.json.",
			rewrittenText: "I updated `config.json` with the new settings.",
			originalModel: "gpt-6-sol",
			spokesmanModel: "gpt-5.4",
		});
		expect(h.lastNote).toEqual({
			message: "Rewrote the latest response with gpt-5.4.",
			type: "info",
		});

		// Subsequent turn receives the manually rewritten response in context
		h.mainQueue.push("Done.");
		await h.session.prompt("What next?");
		const nextRequest = h.mainRequests.at(-1)!;
		const assistantTexts = nextRequest.conversation
			.filter((msg) => msg.role === "assistant")
			.map(textOf);
		expect(assistantTexts).toContain("I updated `config.json` with the new settings.");
		expect(assistantTexts).not.toContain("Updated config.json.");
	});

	it("updates context to the latest rewrite when /spokesman rewrite is run again on an already-rewritten response and isolates identical earlier replies", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "auto" });
		const h = await start();

		// Turn 1: short reply "Done." (skipped by auto)
		h.mainQueue.push("Done.");
		await h.session.prompt("Step 1");

		// Turn 2: another short reply "Done." (skipped by auto)
		h.mainQueue.push("Done.");
		await h.session.prompt("Step 2");

		// Manually rewrite only Turn 2
		h.spokesmanQueue.push("First manual rewrite of Step 2.");
		await h.command("/spokesman rewrite");

		// Re-rewrite Turn 2 again with a second manual rewrite
		h.spokesmanQueue.push("Second manual rewrite of Step 2.");
		await h.command("/spokesman rewrite");

		// Status count deduplicates rewrites per target turn (1/2 turns)
		await h.command("/spokesman status");
		expect(h.lastNote?.message).toContain("Session rewrites: 1/2 turns");

		// Turn 3: verify Turn 1 stays "Done." while Turn 2 gets the latest rewrite ("Second manual rewrite of Step 2.")
		h.mainQueue.push("Ack.");
		await h.session.prompt("Step 3");
		const step3AssistantTexts = h.mainRequests
			.at(-1)!
			.conversation.filter((msg) => msg.role === "assistant")
			.map(textOf);
		expect(step3AssistantTexts).toEqual(["Done.", "Second manual rewrite of Step 2."]);
	});

	it("disables spokesman in auto, always, manual rewrite, and footer status when the main model is the spokesman model", async () => {
		await writeConfig({ default: "gpt-6-sol", mode: "always" });
		const h = await start();

		// Footer status is hidden when main model (gpt-6-sol) == spokesman model (gpt-6-sol)
		expect(h.status).toBeUndefined();

		await h.command("/spokesman status");
		expect(h.lastNote?.message).toContain(
			"Active spokesman: gpt-6-sol (disabled: same as main model)",
		);

		// Even in always mode with dense draft, spokesman does not run when main model == spokesman model
		h.mainQueue.push(DENSE_SOL_DRAFT);
		await h.session.prompt("Explain the architecture");
		expect(h.mainRequests).toHaveLength(1);
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);
		expect(textOf(h.assistantMessages().at(-1) as Message)).toBe(DENSE_SOL_DRAFT);

		// Manual /spokesman rewrite is also disabled when main model == spokesman model
		await h.command("/spokesman rewrite");
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);
		expect(h.lastNote).toEqual({
			message: "Spokesman is disabled because the main model is already gpt-6-sol.",
			type: "info",
		});

		// Switching spokesman to a different model (gpt-5.4) re-enables status and rewriting
		await h.command("/spokesman gpt-5.4");
		expect(h.status).toBe("gpt-5.4 · always");
	});

	it("disables spokesman in auto, always, manual rewrite, and footer status when the main model is the spokesman model", async () => {
		await writeConfig({ default: "gpt-6-sol", mode: "always" });
		const h = await start();

		// Footer status is hidden when main model (gpt-6-sol) == spokesman model (gpt-6-sol)
		expect(h.status).toBeUndefined();

		await h.command("/spokesman status");
		expect(h.lastNote?.message).toContain(
			"Active spokesman: gpt-6-sol (disabled: same as main model)",
		);

		// Even in always mode with dense draft, spokesman does not run when main model == spokesman model
		h.mainQueue.push(DENSE_SOL_DRAFT);
		await h.session.prompt("Explain the architecture");
		expect(h.mainRequests).toHaveLength(1);
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);
		expect(textOf(h.assistantMessages().at(-1) as Message)).toBe(DENSE_SOL_DRAFT);

		// Manual /spokesman rewrite is also disabled when main model == spokesman model
		await h.command("/spokesman rewrite");
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);
		expect(h.lastNote).toEqual({
			message: "Spokesman is disabled because the main model is already gpt-6-sol.",
			type: "info",
		});

		// Switching spokesman to a different model (gpt-5.4) re-enables status and rewriting
		await h.command("/spokesman gpt-5.4");
		expect(h.status).toBe("gpt-5.4 · always");

		// Switching main model to gpt-5.4 via setModel fires model_select and disables spokesman again
		await h.session.setModel(h.faux.getModel("gpt-5.4")!);
		expect(h.status).toBeUndefined();

		// Switching main model back to gpt-6-sol restores the spokesman status
		await h.session.setModel(h.faux.getModel("gpt-6-sol")!);
		expect(h.status).toBe("gpt-5.4 · always");
	});

	it("runs only for main models in mainModels, managed by /spokesman for and kept by /spokesman default", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "always", mainModels: ["claude-*"] });
		const h = await start();

		// gpt-6-sol is not in the list: no footer badge and no rewrite, even in always mode
		expect(h.status).toBeUndefined();
		h.mainQueue.push(DENSE_SOL_DRAFT);
		await h.session.prompt("Explain the architecture");
		expect(h.spokesmanRequests).toHaveLength(0);
		expect(h.rewriteEntries()).toHaveLength(0);
		expect(textOf(h.assistantMessages().at(-1) as Message)).toBe(DENSE_SOL_DRAFT);

		await h.command("/spokesman status");
		expect(h.lastNote?.message).toContain(
			"Active spokesman: gpt-5.4 (inactive: main model gpt-6-sol is not in the main-model list)",
		);
		expect(h.lastNote?.message).toContain("Main models: claude-*");

		// An explicit manual rewrite still runs
		h.spokesmanQueue.push(CLEAR_SPOKESMAN_REWRITE);
		await h.command("/spokesman rewrite");
		expect(h.spokesmanRequests).toHaveLength(1);
		expect(h.rewriteEntries()).toHaveLength(1);

		// Invalid patterns are rejected without touching the config
		await h.command("/spokesman for gpt-6\u0007sol");
		expect(h.lastNote?.type).toBe("warning");
		expect(JSON.parse(await readFile(configPath(), "utf8")).mainModels).toEqual(["claude-*"]);

		// Adding the main model by provider glob enables it and keeps default and mode
		await h.command("/spokesman for claude-*, faux-openai/gpt-6-*");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
			default: "gpt-5.4",
			mode: "always",
			mainModels: ["claude-*", "faux-openai/gpt-6-*"],
		});
		expect(h.status).toBe("gpt-5.4 · always");
		await h.command("/spokesman for");
		expect(h.lastNote?.message).toBe(
			"Spokesman runs for main models: claude-*, faux-openai/gpt-6-*.",
		);

		h.mainQueue.push("Done.");
		h.spokesmanQueue.push("I completed the requested task.");
		await h.session.prompt("Run the check");
		expect(h.spokesmanRequests).toHaveLength(2);
		expect(h.rewriteEntries().at(-1)).toMatchObject({
			originalText: "Done.",
			rewrittenText: "I completed the requested task.",
		});

		// Removing the default spokesman keeps the main-model list
		await h.command("/spokesman default off");
		expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
			mainModels: ["claude-*", "faux-openai/gpt-6-*"],
		});

		// /spokesman for all clears the list, and with nothing else left the config file goes away
		await h.command("/spokesman for all");
		await expect(access(configPath())).rejects.toThrow();
		expect(h.lastNote?.message).toBe("Spokesman now runs for main models: all (all sessions).");
		expect(h.errors).toEqual([]);
	});

	it("asks for the session's pinned language after /tree moves to before the language pin", async () => {
		const h = await start();
		await h.command("/spokesman gpt-5.4 always");
		h.mainQueue.push("Done.");
		await h.session.prompt("one");
		const beforePin = h.assistantMessages().length;
		expect(beforePin).toBe(1);
		const beforePinEntry = h.session.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		// What the language extension writes at a session's first run: { base, fallback? }.
		h.session.sessionManager.appendCustomEntry("language", { base: null, fallback: "Simplified Chinese" });
		const rule = "Write the prose in Simplified Chinese.";

		h.mainQueue.push("Done.");
		await h.session.prompt("two");
		expect(h.spokesmanRequests.at(-1)!.system).toContain(rule);

		await h.session.navigateTree(beforePinEntry.id);
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "language")).toBe(false);
		h.mainQueue.push("Done.");
		await h.session.prompt("three");
		expect(h.spokesmanRequests).toHaveLength(3);
		expect(h.spokesmanRequests.at(-1)!.system).toContain(rule);

		// A switch on the branch wins; a reset returns to the session's pin.
		h.session.sessionManager.appendCustomEntry("language", { active: "Deutsch" });
		h.mainQueue.push("Done.");
		await h.session.prompt("four");
		expect(h.spokesmanRequests.at(-1)!.system).toContain("Write the prose in Deutsch.");
		h.session.sessionManager.appendCustomEntry("language", { active: null, reset: true });
		h.mainQueue.push("Done.");
		await h.session.prompt("five");
		expect(h.spokesmanRequests.at(-1)!.system).toContain(rule);
		expect(h.errors).toEqual([]);
	});

	it("ignores child sessions bound with bindAsChild or carrying pi-extensions.session-link", async () => {
		await writeConfig({ default: "gpt-5.4", mode: "always" });

		// 1. Child session bound via bindAsChild (print mode)
		const child = await start({ bindAsChild: true });
		expect(child.statuses.has(SPOKESMAN_STATE_ENTRY)).toBe(false);
		child.mainQueue.push(DENSE_SOL_DRAFT);
		await child.session.prompt("Run child task");
		expect(child.spokesmanRequests).toHaveLength(0);
		expect(child.rewriteEntries()).toEqual([]);
		expect(child.stateEntries()).toEqual([]);

		// 2. Session carrying pi-extensions.session-link
		const linkedManager = newManager();
		linkedManager.appendCustomEntry(SESSION_LINK, { kind: "subagent" });
		const linked = await start({ sessionManager: linkedManager });
		expect(linked.statuses.has(SPOKESMAN_STATE_ENTRY)).toBe(false);
		linked.mainQueue.push(DENSE_SOL_DRAFT);
		await linked.session.prompt("Run linked task");
		expect(linked.spokesmanRequests).toHaveLength(0);
		expect(linked.rewriteEntries()).toEqual([]);
		expect(linked.stateEntries()).toEqual([]);

		await linked.command("/spokesman gpt-5.4");
		expect(linked.lastNote?.type).toBe("warning");
		expect(linked.statuses.has(SPOKESMAN_STATE_ENTRY)).toBe(false);
	});

	it("is registered in package.json after language and before pika, wired into npm test, and documented", async () => {
		const manifest = JSON.parse(
			await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
		) as { pi: { extensions: string[] }; scripts: Record<string, string> };
		const { extensions } = manifest.pi;
		expect(extensions.indexOf("./extensions/spokesman/index.ts")).toBe(
			extensions.indexOf("./extensions/language/index.ts") + 1,
		);
		expect(extensions.at(-1)).toBe("./extensions/pika/index.ts");
		expect(manifest.scripts["test:spokesman"]).toBe("vitest run extensions/spokesman");
		expect(manifest.scripts.test).toContain("npm run test:language && npm run test:spokesman &&");
	});
});
