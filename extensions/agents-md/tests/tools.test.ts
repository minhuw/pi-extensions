// agents_md_lint: registration, the report for every context file or one on real git repositories with the real lint,
// and its renderers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import agentsMdExtension, { formatReport, type LintDetails } from "../index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let repo: string;
let empty: string;

const initRepo = (dir: string, files: Record<string, string>) => {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	git(dir, "add", ".");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
};

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-agents-md-tools-")));
	repo = join(root, "repo");
	empty = join(root, "empty");
	initRepo(repo, {
		"package.json": JSON.stringify({ name: "fixture", scripts: { test: "true" } }),
		"src/a.ts": "export const a = 1;\n",
		"AGENTS.md": "# Rules\n\n- Run `npm test` before committing.\n- Keep `src/a.ts` small.\n",
		"sub/CLAUDE.md": "# Sub\n- Read `gone/x.ts` first.\n",
		"sub/notes.md": "- Not a context file: `gone/y.ts`.\n",
	});
	initRepo(empty, { "README.md": "# Empty\n" });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function load() {
	const tools: ToolDefinition[] = [];
	const events: string[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => void tools.push(tool),
		on: (event: string) => void events.push(event),
	} as unknown as ExtensionAPI;
	agentsMdExtension(pi);
	const tool = tools.find((candidate) => candidate.name === "agents_md_lint")!;
	const run = async (cwd: string, params: { path?: string } = {}) => {
		const result = await tool.execute("call-1", params as never, undefined, undefined, { cwd } as ExtensionToolContext);
		const first = result.content[0];
		return { text: first?.type === "text" ? first.text : "", details: result.details as LintDetails };
	};
	return { tools, events, tool, run };
}

describe("registration", () => {
	it("registers the review gate on tool_call and the agents_md_lint tool with its prompt lines", () => {
		const { tools, events, tool } = load();
		expect(events).toEqual(["tool_call"]);
		expect(tools.map((candidate) => candidate.name)).toEqual(["agents_md_lint"]);
		expect(tool.promptSnippet).toBe("Check the repository's AGENTS.md files for dead paths, scripts, links, duplicates, and size");
		expect(tool.promptGuidelines).toHaveLength(2);
		expect(tool.promptGuidelines![0]).toMatch(/^AGENTS\.md holds the standing rules every session in this repository must follow/);
		expect(tool.promptGuidelines![0]).toContain("add it to AGENTS.md with edit rather than to memory; the user reviews every change to an AGENTS.md file.");
		expect(tool.promptGuidelines![1]).toBe("Keep AGENTS.md small and true: one line per rule, nothing the code already shows, no task-specific decisions; run agents_md_lint after changing it and fix what it reports.");
	});
});

describe("agents_md_lint", () => {
	const { run } = load();

	it("lints every context file of the repository, root first, with line numbers", async () => {
		const { text, details } = await run(join(repo, "src"));
		expect(details.root).toBe(repo);
		expect(details.files.map((file) => file.path)).toEqual(["AGENTS.md", join("sub", "CLAUDE.md")]);
		const [first, ...rest] = text.split("\n");
		expect(first).toBe("AGENTS.md: no findings");
		expect(rest[0]).toBe(`${join("sub", "CLAUDE.md")}: 1 finding`);
		expect(rest[1]).toMatch(/^- line 2: .*`gone\/x\.ts`/);
		expect(rest).toHaveLength(2);
	});

	it("lints one file given relative to the working directory", async () => {
		const { text, details } = await run(join(repo, "sub"), { path: "CLAUDE.md" });
		expect(details.files.map((file) => file.path)).toEqual([join("sub", "CLAUDE.md")]);
		expect(text.split("\n")[0]).toBe(`${join("sub", "CLAUDE.md")}: 1 finding`);
		const clean = await run(repo, { path: "@AGENTS.md" });
		expect(clean.text).toBe("AGENTS.md: no findings");
	});

	it("refuses a path that is not a file", async () => {
		await expect(run(repo, { path: "missing/AGENTS.md" })).rejects.toThrow("missing/AGENTS.md is not a file.");
		await expect(run(repo, { path: "sub" })).rejects.toThrow("sub is not a file.");
	});

	it("says so when the repository has no context files", async () => {
		const { text, details } = await run(empty);
		expect(details.files).toEqual([]);
		expect(text).toBe(`No context files (AGENTS.md, CLAUDE.md, ...) in ${details.root}.`);
	});
});

describe("formatReport", () => {
	it("lists whole-file findings without a line, counts findings, and names unreadable files", () => {
		expect(formatReport({
			root: "/r",
			files: [
				{ path: "AGENTS.md", findings: [{ kind: "budget", message: "AGENTS.md has 240 lines; keep it under 200." }, { kind: "duplicate", line: 9, message: "Line 9 repeats line 3." }] },
				{ path: "a/CLAUDE.md", findings: [], error: "ENOENT" },
				{ path: "b/AGENTS.md", findings: [] },
			],
		})).toBe([
			"AGENTS.md: 2 findings",
			"- AGENTS.md has 240 lines; keep it under 200.",
			"- line 9: Line 9 repeats line 3.",
			"a/CLAUDE.md: could not be read (ENOENT)",
			"b/AGENTS.md: no findings",
		].join("\n"));
	});
});

describe("renderers", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
	const textOf = (component: unknown) => (component as { text: string }).text;
	const result = (details: LintDetails) => ({ content: [{ type: "text" as const, text: formatReport(details) }], details });
	const renderContext = (isError = false) => ({ isError }) as never;

	it("renders the call compactly", () => {
		const { tool } = load();
		expect(textOf(tool.renderCall!({}, theme, renderContext()))).toBe("agents_md_lint all context files");
		expect(textOf(tool.renderCall!({ path: "sub/CLAUDE.md" }, theme, renderContext()))).toBe("agents_md_lint sub/CLAUDE.md");
	});

	it("summarizes the result in one line and shows the report when expanded", () => {
		const { tool } = load();
		const clean: LintDetails = { root: "/r", files: [{ path: "AGENTS.md", findings: [] }, { path: "b/AGENTS.md", findings: [] }] };
		const dirty: LintDetails = { root: "/r", files: [{ path: "AGENTS.md", findings: [{ kind: "dead-path", line: 3, message: "`x/` names no file in the repository." }] }, { path: "b/AGENTS.md", findings: [] }] };
		const render = (details: LintDetails, expanded = false) => textOf(tool.renderResult!(result(details), { expanded, isPartial: false }, theme, renderContext()));
		expect(render(clean)).toBe("2 files, no findings");
		expect(render(dirty)).toBe("1 finding in 1 of 2 files");
		expect(render(dirty, true)).toBe("1 finding in 1 of 2 files\nAGENTS.md: 1 finding\n- line 3: `x/` names no file in the repository.\nb/AGENTS.md: no findings");
		expect(render({ root: "/r", files: [] })).toBe("no context files");
		expect(textOf(tool.renderResult!(result(clean), { expanded: false, isPartial: true }, theme, renderContext()))).toBe("linting…");
		expect(textOf(tool.renderResult!({ content: [{ type: "text", text: "sub is not a file." }], details: undefined }, { expanded: false, isPartial: false }, theme, renderContext(true)))).toBe("sub is not a file.");
	});
});
