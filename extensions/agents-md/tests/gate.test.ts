// agents-md's review gate: the edit/diff helpers, the verdict for each kind of session and answer on a real git
// repository with the real lint, and the hook in a real Pi session on the faux provider. `hooks.throwLint` makes
// lintContextFile fail on purpose.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const hooks = vi.hoisted(() => ({ throwLint: false }));

vi.mock("../lint.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../lint.ts")>();
	return {
		...real,
		lintContextFile: (...args: Parameters<typeof real.lintContextFile>) => {
			if (hooks.throwLint) throw new Error("lint exploded");
			return real.lintContextFile(...args);
		},
	};
});

import agentsMdExtension from "../index.ts";
import {
	applyEdits, CHOICES, isChildSession, MAX_DIFF_LINES, reasons, reviewToolCall, STANDING_APPROVAL_KEY, truncateDiff, unifiedDiff, userAway,
} from "../gate.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const RULES = "# Rules\n\n- Use `old/gone.ts` for fixtures.\n- Run the tests.\n- Keep `src/a.ts` small.\n";

let root: string;
let repo: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-agents-md-gate-")));
	repo = join(root, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(repo, "docs"), { recursive: true });
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "true" } }));
	writeFileSync(join(repo, "AGENTS.md"), RULES);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	symlinkSync("AGENTS.md", join(repo, "RULES.md"));
	mkdirSync(join(repo, "linked"));
	symlinkSync(join("..", "docs", "guide.md"), join(repo, "linked", "AGENTS.md"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	writeFileSync(join(repo, "AGENTS.md"), RULES);
});

afterEach(() => {
	hooks.throwLint = false;
	delete (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY];
	rmSync(join(repo, "extensions"), { recursive: true, force: true });
});

describe("applyEdits", () => {
	const text = "alpha\nbeta\ngamma\ndelta\n";

	it("applies disjoint edits that each match exactly once, whatever their order", () => {
		expect(applyEdits(text, [{ oldText: "gamma", newText: "GAMMA" }, { oldText: "alpha\n", newText: "" }])).toEqual({ kind: "applied", text: "beta\nGAMMA\ndelta\n" });
	});

	it("matches oldText with CRLF line endings against the LF-normalized file, as the edit tool does", () => {
		expect(applyEdits(text, [{ oldText: "beta\r\ngamma", newText: "b\r\ng" }])).toEqual({ kind: "applied", text: "alpha\nb\ng\ndelta\n" });
	});

	it.each([
		["no edits", []],
		["a missing oldText", [{ oldText: "epsilon", newText: "x" }]],
		["a repeated oldText", [{ oldText: "a\n", newText: "x\n" }]],
		["an empty oldText", [{ oldText: "", newText: "x" }]],
		["overlapping edits", [{ oldText: "alpha\nbeta", newText: "x" }, { oldText: "beta\ngamma", newText: "y" }]],
		["a no-op", [{ oldText: "beta", newText: "beta" }]],
	])("leaves %s to the edit tool's own error", (_name, edits) => {
		expect(applyEdits(text, edits)).toEqual({ kind: "invalid" });
	});

	it("reports an oldText that matches only through the edit tool's fuzzy fallback", () => {
		const smart = "Don’t push — ask first.  \nnext\n";
		expect(applyEdits(smart, [{ oldText: "next", newText: "NEXT" }, { oldText: "Don't push - ask first.", newText: "x" }])).toEqual({ kind: "inexact", index: 1 });
		expect(applyEdits("tail   \nmore\n", [{ oldText: "tail\nmore", newText: "x" }])).toEqual({ kind: "inexact", index: 0 });
	});
});

describe("unifiedDiff", () => {
	it("shows a changed line with three lines of context and a hunk header", () => {
		expect(unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\n", "a\nb\nc\nd\nE\nf\ng\nh\ni\n")).toEqual([
			"@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h",
		]);
	});

	it("shows a new file as one added hunk", () => {
		expect(unifiedDiff("", "x\ny\n")).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y"]);
	});

	it("keeps distant changes in separate hunks and finds the common lines between them", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const after = before.replace("line 2", "LINE 2").replace("line 18", "line 18\ninserted");
		expect(unifiedDiff(before, after)).toEqual([
			"@@ -1,5 +1,5 @@", " line 1", "-line 2", "+LINE 2", " line 3", " line 4", " line 5",
			"@@ -16,5 +16,6 @@", " line 16", " line 17", " line 18", "+inserted", " line 19", " line 20",
		]);
	});

	it("is empty when only the final newline differs", () => {
		expect(unifiedDiff("a\nb", "a\nb\n")).toEqual([]);
	});

	it("truncates long diffs and counts what it leaves out", () => {
		const lines = ["@@ -0,0 +1,100 @@", ...Array.from({ length: 100 }, (_, i) => `+${i}`)];
		const shown = truncateDiff(lines);
		expect(shown).toHaveLength(MAX_DIFF_LINES + 1);
		expect(shown.at(-1)).toBe(`… ${101 - MAX_DIFF_LINES} more diff lines (${101 - MAX_DIFF_LINES} added, 0 removed) not shown`);
		expect(truncateDiff([`+${"x".repeat(1000)}`])[0]!.length).toBe(300);
	});
});

describe("sessions and the away state", () => {
	const entries = (...list: unknown[]) => ({ getEntries: () => list }) as unknown as ExtensionContext["sessionManager"];

	it("treats sessions without a TUI or RPC mode, and sessions with a session link, as children", () => {
		expect(isChildSession({ mode: "tui", sessionManager: entries() })).toBe(false);
		expect(isChildSession({ mode: "rpc", sessionManager: entries({ type: "custom", customType: "other" }) })).toBe(false);
		expect(isChildSession({ mode: "print", sessionManager: entries() })).toBe(true);
		expect(isChildSession({ mode: "tui", sessionManager: entries({ type: "custom", customType: "pi-extensions.session-link", data: { parentSessionId: "p" } }) })).toBe(true);
	});

	it("reads selfdrive's standing approvals without creating the registry", () => {
		const global = globalThis as Record<symbol, unknown>;
		expect(userAway()).toBe(false);
		expect(STANDING_APPROVAL_KEY in global).toBe(false);
		global[STANDING_APPROVAL_KEY] = { grants: new Map() };
		expect(userAway()).toBe(false);
		global[STANDING_APPROVAL_KEY] = { grants: new Map([["s", { id: "s" }]]) };
		expect(userAway()).toBe(true);
	});
});

describe("reviewToolCall", () => {
	type Dialog = { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
	const context = (options: { answer?: string | Error; note?: string; hasUI?: boolean; mode?: string; entries?: unknown[]; cwd?: string } = {}) => {
		const ui: Dialog = {
			select: vi.fn(async () => {
				if (options.answer instanceof Error) throw options.answer;
				return options.answer;
			}),
			input: vi.fn(async () => options.note),
		};
		const ctx = {
			cwd: options.cwd ?? repo,
			hasUI: options.hasUI ?? true,
			mode: options.mode ?? "tui",
			signal: undefined,
			sessionManager: { getEntries: () => options.entries ?? [] },
			ui,
		} as unknown as ExtensionContext;
		return { ctx, ui };
	};
	const edit = (oldText: string, newText: string, path = "AGENTS.md") => ({ path, edits: [{ oldText, newText }] });
	const shown = (ui: Dialog) => String(ui.select.mock.calls[0]?.[0]);
	const findingsOf = (ui: Dialog) => shown(ui).split("\n\n").at(-1)!;

	it("leaves other tools and other files alone", async () => {
		const { ctx, ui } = context({ answer: CHOICES.reject });
		expect(await reviewToolCall("bash", { command: "echo x >> AGENTS.md" }, ctx)).toBeUndefined();
		expect(await reviewToolCall("read", { path: "AGENTS.md" }, ctx)).toBeUndefined();
		expect(await reviewToolCall("write", { path: "src/a.ts", content: "x" }, ctx)).toBeUndefined();
		expect(await reviewToolCall("edit", edit("a = 1", "a = 2", "src/a.ts"), ctx)).toBeUndefined();
		expect(await reviewToolCall("write", { path: "  ", content: "x" }, ctx)).toBeUndefined();
		expect(ui.select).not.toHaveBeenCalled();
	});

	it.each([
		["a session without a UI", { hasUI: false }],
		["a live child (no mode)", { mode: "print" }],
		["a persisted child (session link)", { entries: [{ type: "custom", customType: "pi-extensions.session-link", data: {} }] }],
	])("allows %s without asking", async (_name, options) => {
		const { ctx, ui } = context({ answer: CHOICES.reject, ...options });
		expect(await reviewToolCall("edit", edit("Run the tests.", "Run the tests twice."), ctx)).toBeUndefined();
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("refuses the change without asking while the user is away", async () => {
		(globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY] = { grants: new Map([["s", { id: "s" }]]) };
		const { ctx, ui } = context({ answer: CHOICES.apply });
		expect(await reviewToolCall("write", { path: "AGENTS.md", content: "x\n" }, ctx)).toEqual({
			block: true,
			reason: "The user is away (self-driving mode), and changes to AGENTS.md wait for their review. Do not make this change now; describe it in your report instead.",
		});
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("applies on Apply after showing the diff and the three choices", async () => {
		const { ctx, ui } = context({ answer: CHOICES.apply });
		expect(await reviewToolCall("edit", edit("- Run the tests.", "- Run the tests with `npm test`."), ctx)).toBeUndefined();
		expect(ui.select).toHaveBeenCalledTimes(1);
		const [text, choices] = ui.select.mock.calls[0]!;
		expect(choices).toEqual(["Apply", "Reject", "Reject with a note"]);
		expect(text).toContain("Review this change to AGENTS.md: the agent's edit edits it.");
		expect(text).toContain("--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,5 +1,5 @@\n # Rules\n \n - Use `old/gone.ts` for fixtures.\n-- Run the tests.\n+- Run the tests with `npm test`.\n - Keep `src/a.ts` small.");
		expect(text).toContain("No new lint findings.");
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("blocks on Reject", async () => {
		const { ctx } = context({ answer: CHOICES.reject });
		expect(await reviewToolCall("edit", edit("Run the tests.", "Skip the tests."), ctx)).toEqual({
			block: true, reason: "The user rejected this change to AGENTS.md. Do not retry it unchanged.",
		});
	});

	it("asks for a note on Reject with a note and passes it on", async () => {
		const { ctx, ui } = context({ answer: CHOICES.note, note: "  the tests are mandatory.  " });
		expect(await reviewToolCall("edit", edit("Run the tests.", "Skip the tests."), ctx)).toEqual({
			block: true, reason: "The user rejected this change to AGENTS.md: the tests are mandatory. Do not retry it unchanged.",
		});
		expect(ui.input).toHaveBeenCalledWith("Why reject the change to AGENTS.md?", "a note for the agent", { signal: undefined });
	});

	it.each([
		["the dialog is dismissed", { answer: undefined }],
		["the dialog fails", { answer: new Error("no terminal") }],
		["the note is dismissed", { answer: CHOICES.note, note: undefined }],
		["the note is blank", { answer: CHOICES.note, note: "   " }],
	])("rejects without a note when %s", async (_name, options) => {
		const { ctx } = context(options);
		expect(await reviewToolCall("edit", edit("Run the tests.", "Skip the tests."), ctx)).toEqual({ block: true, reason: reasons.rejected("AGENTS.md") });
	});

	it("rejects when the run is aborted while the dialog is open", async () => {
		const controller = new AbortController();
		const { ctx, ui } = context();
		(ctx as { signal?: AbortSignal }).signal = controller.signal;
		ui.select.mockImplementation(async () => {
			controller.abort();
			return CHOICES.apply;
		});
		expect(await reviewToolCall("edit", edit("Run the tests.", "Skip the tests."), ctx)).toEqual({ block: true, reason: reasons.rejected("AGENTS.md") });
		expect(ui.select.mock.calls[0]![2]).toEqual({ signal: controller.signal });
	});

	it("lists only the lint findings the change adds", async () => {
		const { ctx, ui } = context({ answer: CHOICES.apply });
		await reviewToolCall("edit", edit("- Run the tests.", "- Read `docs/missing.md` first.\n- Read `docs/guide.md` too."), ctx);
		const findings = findingsOf(ui);
		expect(findings).toMatch(/^New lint findings \(1\):\n- line 4: .*`docs\/missing\.md`/);
		expect(findings).not.toContain("old/gone.ts");
		expect(findings).not.toContain("docs/guide.md");
	});

	it("still asks, saying so, when lint fails", async () => {
		hooks.throwLint = true;
		const { ctx, ui } = context({ answer: CHOICES.apply });
		expect(await reviewToolCall("edit", edit("Run the tests.", "Skip the tests."), ctx)).toBeUndefined();
		expect(findingsOf(ui)).toBe("Lint could not run: lint exploded");
	});

	it("lets edits that cannot apply exactly reach the edit tool without asking", async () => {
		const { ctx, ui } = context({ answer: CHOICES.reject });
		expect(await reviewToolCall("edit", edit("not in the file", "x"), ctx)).toBeUndefined();
		expect(await reviewToolCall("edit", edit("- ", "* "), ctx)).toBeUndefined();
		expect(await reviewToolCall("edit", edit("x", "y", "extensions/none/AGENTS.md"), ctx)).toBeUndefined();
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("refuses an edit that matches only through the edit tool's fuzzy fallback", async () => {
		const { ctx, ui } = context({ answer: CHOICES.apply });
		expect(await reviewToolCall("edit", edit("Use ‘old/gone.ts’", "x"), ctx)).toBeUndefined();
		expect(await reviewToolCall("edit", edit("- Run the tests.  \n- Keep", "- Keep"), ctx)).toEqual({ block: true, reason: reasons.inexact("AGENTS.md", 0) });
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("reviews a write that creates a context file in a new directory, by its path in the repository", async () => {
		const { ctx, ui } = context({ answer: CHOICES.apply, cwd: join(repo, "src") });
		expect(await reviewToolCall("write", { path: "../extensions/x/CLAUDE.md", content: "- One rule.\n" }, ctx)).toBeUndefined();
		const text = shown(ui);
		expect(text).toContain("Review this change to extensions/x/CLAUDE.md: the agent's write creates it.");
		expect(text).toContain("--- a/extensions/x/CLAUDE.md\n+++ b/extensions/x/CLAUDE.md\n@@ -0,0 +1,1 @@\n+- One rule.");
	});

	it("resolves paths as Pi's file tools do, through symlinks either way", async () => {
		const { ctx, ui } = context({ answer: CHOICES.reject });
		expect(await reviewToolCall("write", { path: "@RULES.md", content: "x\n" }, ctx)).toEqual({ block: true, reason: reasons.rejected("AGENTS.md") });
		expect(shown(ui)).toContain("the agent's write rewrites it.");
		expect(await reviewToolCall("write", { path: "linked/AGENTS.md", content: "x\n" }, ctx)).toEqual({ block: true, reason: reasons.rejected(join("docs", "guide.md")) });
		expect(await reviewToolCall("write", { path: "docs/guide.md", content: "x\n" }, ctx)).toBeUndefined();
		expect(ui.select).toHaveBeenCalledTimes(2);
	});

	it("allows a write that changes nothing", async () => {
		const { ctx, ui } = context({ answer: CHOICES.reject });
		expect(await reviewToolCall("write", { path: "AGENTS.md", content: RULES.replaceAll("\n", "\r\n") }, ctx)).toBeUndefined();
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("truncates the diff of a long rewrite", async () => {
		const { ctx, ui } = context({ answer: CHOICES.apply });
		const content = Array.from({ length: 120 }, (_, i) => `- Rule ${i}.`).join("\n");
		await reviewToolCall("write", { path: "AGENTS.md", content }, ctx);
		expect(shown(ui)).toMatch(/… \d+ more diff lines \(\d+ added, \d+ removed\) not shown/);
		expect(shown(ui).split("\n").length).toBeLessThan(60);
	});
});

describe("the gate in a Pi session", () => {
	it("blocks a rejected edit, applies an approved one, and stands aside for other files", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const faux = fauxProvider({ api: "agents-md-gate-api", provider: "agents-md-gate", models: [{ id: "test" }] });
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const services = await createAgentSessionServices({
			cwd: repo,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => pi.registerProvider(faux.provider), agentsMdExtension],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(repo), model: faux.getModel("test") });
		const answers = [CHOICES.reject, CHOICES.apply];
		const asked: string[] = [];
		const noop = () => {};
		const uiContext = {
			select: async (title: string) => {
				asked.push(title);
				return answers.shift();
			},
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			notify: noop,
			onTerminalInput: () => noop,
			setStatus: noop,
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
		} as unknown as ExtensionUIContext;
		try {
			await session.bindExtensions({ mode: "rpc", uiContext });
			const results = () => session.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [{ isError: Boolean(entry.message.isError), text: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join("") }]
					: []);
			const editCall = fauxToolCall("edit", { path: "AGENTS.md", edits: [{ oldText: "Run the tests.", newText: "Run the tests twice." }] });

			faux.setResponses([fauxAssistantMessage([editCall]), fauxAssistantMessage("done")]);
			await session.prompt("change the rules");
			expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(RULES);
			expect(results().at(-1)).toEqual({ isError: true, text: "The user rejected this change to AGENTS.md. Do not retry it unchanged." });

			faux.setResponses([fauxAssistantMessage([editCall]), fauxAssistantMessage("done")]);
			await session.prompt("change the rules again");
			expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(RULES.replace("Run the tests.", "Run the tests twice."));
			expect(results().at(-1)?.isError).toBe(false);

			faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "docs/notes.md", content: "x\n" })]), fauxAssistantMessage("done")]);
			await session.prompt("write notes");
			expect(readFileSync(join(repo, "docs", "notes.md"), "utf8")).toBe("x\n");
			expect(asked).toHaveLength(2);
			expect(asked[1]).toContain("+- Run the tests twice.");
		} finally {
			session.dispose();
			rmSync(join(repo, "docs", "notes.md"), { force: true });
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
