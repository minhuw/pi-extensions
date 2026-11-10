import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isContextFile, lintContextFile, MAX_BYTES, MAX_LINES, newFindings, repositoryContextFiles, type LintFinding } from "../lint.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

// Isolate fixtures from the developer's git configuration (global excludes, hooks, signing) and from any
// repository above the temporary directory.
beforeEach(() => {
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	vi.stubEnv("GIT_CEILING_DIRECTORIES", realpathSync(tmpdir()));
});
afterEach(() => vi.unstubAllEnvs());

function write(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

/** A temporary directory holding `files`, removed after `fn` (also when it throws). */
function withDirectory<T>(files: Record<string, string>, fn: (root: string) => T): T {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-md-lint-")));
	try {
		write(root, files);
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A temporary git repository with `files` committed, removed after `fn`. */
function withRepository<T>(files: Record<string, string>, fn: (root: string) => T): T {
	return withDirectory(files, (root) => {
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Lint Test", "-c", "user.email=lint@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" });
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", "fixture");
		return fn(root);
	});
}

/** Lints `text` as `<root>/<file>` (default the root AGENTS.md). */
function lint(root: string, text: string, file = "AGENTS.md"): LintFinding[] {
	return lintContextFile(text, { file: join(root, file), root });
}

const kinds = (findings: LintFinding[]) => findings.map((finding) => finding.kind);

const FIXTURE = {
	"package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc", "test:unit": "vitest run" } }),
	"src/app.ts": "export {};\n",
	"extensions/foo/tests/support/fixture.ts": "export {};\n",
	"extensions/foo/README.md": "# foo\n",
	"docs/guide.md": "# Guide\n",
	"web/package.json": JSON.stringify({ scripts: { serve: "vite" } }),
	"web/.gitignore": "dist/\n",
	".github/workflows/ci.yml": "on: push\n",
};

describe("isContextFile", () => {
	it("matches Pi's context-file names by base name only", () => {
		for (const path of ["AGENTS.md", "/repo/AGENTS.override.md", "docs/AGENTS.MD", "CLAUDE.md", "a/b/CLAUDE.MD"]) expect(isContextFile(path)).toBe(true);
		for (const path of ["agents.md", "AGENTS.md.bak", "README.md", "AGENTS.md/notes.txt", "MY-AGENTS.md"]) expect(isContextFile(path)).toBe(false);
	});
});

describe("budget", () => {
	it("reports a file over the line budget once, without a line", () => {
		const atLimit = Array.from({ length: MAX_LINES }, (_, index) => `- rule ${index}`).join("\n") + "\n";
		expect(withDirectory({}, (root) => lint(root, atLimit))).toEqual([]);
		const over = atLimit + "- one more\n";
		expect(withDirectory({}, (root) => lint(root, over))).toEqual([{ kind: "budget", message: `The file is longer than ${MAX_LINES} lines, and every session loads it in full.` }]);
	});

	it("reports a file over the byte budget", () => {
		const text = `${"x".repeat(MAX_BYTES)}\n`;
		expect(withDirectory({}, (root) => lint(root, text))).toEqual([{ kind: "budget", message: `The file is larger than ${MAX_BYTES} bytes, and every session loads it in full.` }]);
	});

	it("keeps the message stable while the file stays over budget", () => {
		const lines = (count: number) => Array.from({ length: count }, (_, index) => `- rule ${index}`).join("\n");
		withDirectory({}, (root) => expect(newFindings(lint(root, lines(230)), lint(root, lines(231)))).toEqual([]));
	});
});

describe("dead-path", () => {
	it("reports a backticked path that names nothing, on its line", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "# Rules\n\n- Code lives in `src/app.ts`.\n- See `extensions/gone/` and `src/missing.ts`.\n")).toEqual([
				{ kind: "dead-path", line: 4, message: "`extensions/gone/` names no file in the repository." },
				{ kind: "dead-path", line: 4, message: "`src/missing.ts` names no file in the repository." },
			]);
		});
	});

	it("resolves paths from the root, the file's directory, and by suffix of a listed path", () => {
		withRepository(FIXTURE, (root) => {
			const text = [
				"- `extensions/foo/` and `src/` exist from the root.",
				"- `tests/support/fixture.ts`, `support/fixture.ts`, and `tests/support/` end listed paths.",
				"- `fixture.ts` and `README.md` are bare file names of listed files.",
				"- `../src/app.ts` and `guide.md` resolve from the file's directory.",
				"- `./src/app.ts` and `src/app.ts:12` and `docs/guide.md#intro` are paths too.",
			].join("\n");
			expect(lint(root, text, "docs/AGENTS.md")).toEqual([]);
		});
	});

	it("matches suffixes on whole segments only", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "- `pport/fixture.ts` and `nothere.ts`\n")).toEqual([
				{ kind: "dead-path", line: 1, message: "`pport/fixture.ts` names no file in the repository." },
				{ kind: "dead-path", line: 1, message: "`nothere.ts` names no file in the repository." },
			]);
		});
	});

	it("counts an untracked file that git does not ignore, and its directories", () => {
		withRepository(FIXTURE, (root) => {
			write(root, { "packages/lib/fresh.ts": "export {};\n" });
			// Only the listing (`--others --exclude-standard`) knows `lib/fresh.ts`: it is not under the root or docs/.
			expect(lint(root, "- `lib/fresh.ts`, `fresh.ts`, and `packages/lib/` are new.\n", "docs/AGENTS.md")).toEqual([]);
		});
	});

	it("does not match suffixes against files git ignores", () => {
		withRepository({ ...FIXTURE, "pkg/.gitignore": "/local.ts\n" }, (root) => {
			write(root, { "pkg/local.ts": "export {};\n" });
			// `pkg/local.ts` exists from the root; the bare name would match only an ignored, unlisted file.
			expect(lint(root, "- `pkg/local.ts` and `local.ts`\n")).toEqual([{ kind: "dead-path", line: 1, message: "`local.ts` names no file in the repository." }]);
		});
	});

	it("counts a git-ignored build output that the checkout does not have", () => {
		withRepository(FIXTURE, (root) => {
			// `web/.gitignore` ignores `dist/`, which does not exist: a fresh clone mentions it all the same.
			expect(lint(root, "- `web/dist` and `web/dist/` are build outputs; `docs/dist/` is not.\n", "docs/AGENTS.md")).toEqual([
				{ kind: "dead-path", line: 1, message: "`docs/dist/` names no file in the repository." },
			]);
		});
	});

	it("skips placeholders, globs, URLs, absolute and ~ paths, flags, and non-path code", () => {
		withRepository(FIXTURE, (root) => {
			const tokens = [
				"src/<name>.ts", "<agentDir>/x.json", "src/*.ts", "**/*.md", "$HOME/.cache/x", "src/{a,b}.ts", "src/.../x.ts", "src/…/x.ts",
				"https://example.com/a.ts", "http://example.com/docs/", "github.com/owner/repo", "npm:pkg/x.ts", "node:fs/promises",
				"/usr/local/bin/tool.sh", "/commit", "~/notes/todo.md", "~/.config/x.json", "--config=x.json", "-p", "@scope/pkg",
				'Symbol.for("x")', "pi.extensions", "process.env", ".ts", ".test.ts", "x >= 1", "1/2", "test:unit",
				"cd src && make", "refs/herder/", "origin/main", ".pi/pika/project.json", ".git/info/exclude",
			];
			expect(lint(root, tokens.map((token) => `- \`${token}\``).join("\n"))).toEqual([]);
		});
	});

	it("still checks a dot directory or ref-like root that holds listed files", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "- `.github/workflows/ci.yml` runs; `.github/workflows/gone.yml` does not.\n")).toEqual([
				{ kind: "dead-path", line: 1, message: "`.github/workflows/gone.yml` names no file in the repository." },
			]);
		});
	});

	it("ignores paths inside fenced code blocks", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "```md\n- `nothere/x.ts`\n```\n~~~\n`also/gone.ts`\n~~~\n")).toEqual([]);
		});
	});

	it("falls back to the filesystem outside git", () => {
		withDirectory(FIXTURE, (root) => {
			expect(lint(root, "- `src/app.ts` exists; `support/fixture.ts` resolves only by suffix in git.\n")).toEqual([
				{ kind: "dead-path", line: 1, message: "`support/fixture.ts` names no file in the repository." },
			]);
		});
	});
});

describe("dead-script", () => {
	it("checks `npm run` in inline code and code blocks against the root package.json", () => {
		withRepository(FIXTURE, (root) => {
			const text = ["- Run `npm run build` and `npm run test:unit`, then `npm run deploy`.", "", "```sh", "npm ci", "npm run lint -- --fix", "```", "Prose npm run nothing is not code."].join("\n");
			expect(lint(root, text)).toEqual([
				{ kind: "dead-script", line: 1, message: "`npm run deploy` names no script in package.json." },
				{ kind: "dead-script", line: 5, message: "`npm run lint` names no script in package.json." },
			]);
		});
	});

	it("follows `cd` into a directory with its own package.json", () => {
		withRepository(FIXTURE, (root) => {
			const text = ["- `cd web && npm run serve` and `cd web && npm run build`.", "```sh", "cd web", "npm run serve", "cd ..", "npm run build", "```"].join("\n");
			expect(lint(root, text)).toEqual([{ kind: "dead-script", line: 1, message: "`npm run build` names no script in web/package.json." }]);
		});
	});

	it("skips placeholders, flags, unknown directories, and repositories without package.json", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "- `npm run <name>`, `npm run test:*`, `npm run -s nope`, `npm run`, `cd $DIR && npm run nope`, `cd docs && npm run nope`\n")).toEqual([]);
		});
		withDirectory({ "src/app.ts": "" }, (root) => expect(lint(root, "- `npm run anything`\n")).toEqual([]));
	});
});

describe("dead-link", () => {
	it("reports a relative link or image whose target does not exist", () => {
		withRepository(FIXTURE, (root) => {
			const text = [
				"See [the guide](docs/guide.md), [intro](docs/guide.md#intro), and [src](src/ \"title\").",
				"Broken: [old](docs/old.md#top) and ![shot](img/shot.png).",
				"Skipped: [web](https://example.com/x), [plain](http://x.test), [mail](mailto:a@example.test), [top](#rules).",
				"Code is not a link: `[x](nope.md)`.",
			].join("\n");
			expect(lint(root, text)).toEqual([
				{ kind: "dead-link", line: 2, message: "The link to `docs/old.md` names no file in the repository." },
				{ kind: "dead-link", line: 2, message: "The link to `img/shot.png` names no file in the repository." },
			]);
		});
	});

	it("resolves link targets from the file's directory", () => {
		withRepository(FIXTURE, (root) => {
			expect(lint(root, "[guide](guide.md) and [app](../src/app.ts) and [root](docs/guide.md)\n", "docs/AGENTS.md")).toEqual([
				{ kind: "dead-link", line: 1, message: "The link to `docs/guide.md` names no file in the repository." },
			]);
		});
	});
});

describe("duplicate", () => {
	it("reports a line that repeats an earlier one, ignoring list markers", () => {
		withDirectory({}, (root) => {
			const text = ["# Rules", "- Use tabs.", "* Use tabs.", "1. Run tests first.", "2) Run tests first.", "Use tabs."].join("\n");
			expect(lint(root, text)).toEqual([
				{ kind: "duplicate", line: 3, message: 'The line "Use tabs." repeats an earlier line.' },
				{ kind: "duplicate", line: 5, message: 'The line "Run tests first." repeats an earlier line.' },
				{ kind: "duplicate", line: 6, message: 'The line "Use tabs." repeats an earlier line.' },
			]);
		});
	});

	it("skips headings, table separators, rules, code fences and their contents, and bare HTML", () => {
		withDirectory({}, (root) => {
			const text = [
				"## Notes", "| a | b |", "| --- | --- |", "## Notes", "| c | d |", "| --- | --- |", "---", "---",
				"```sh", "npm test", "```", "```sh", "npm test", "```", "<details>", "</details>", "<details>", "</details>", "", "",
			].join("\n");
			expect(lint(root, text)).toEqual([]);
		});
	});
});

describe("newFindings", () => {
	const finding = (kind: LintFinding["kind"], message: string, line?: number): LintFinding => ({ kind, message, ...(line === undefined ? {} : { line }) });

	it("returns findings of after that before lacks, by kind and message, ignoring lines", () => {
		const before = [finding("dead-path", "`a/` names no file in the repository.", 3), finding("budget", "Too big.")];
		const after = [finding("dead-path", "`a/` names no file in the repository.", 9), finding("budget", "Too big."), finding("dead-path", "`b/` names no file in the repository.", 4)];
		expect(newFindings(before, after)).toEqual([finding("dead-path", "`b/` names no file in the repository.", 4)]);
		expect(newFindings(after, before)).toEqual([]);
		expect(newFindings([], after)).toEqual(after);
	});

	it("treats the same message of another kind as new, and counts repeated findings", () => {
		const before = [finding("dead-path", "same", 1)];
		expect(newFindings(before, [finding("dead-link", "same", 1)])).toEqual([finding("dead-link", "same", 1)]);
		expect(newFindings(before, [finding("dead-path", "same", 1), finding("dead-path", "same", 7)])).toEqual([finding("dead-path", "same", 7)]);
	});

	it("reports what an edit introduces", () => {
		withRepository(FIXTURE, (root) => {
			const before = lint(root, "- `src/gone.ts`\n- Use tabs.\n");
			const after = lint(root, "- Intro.\n- `src/gone.ts`\n- Use tabs.\n- Use tabs.\n- `npm run nope`\n");
			expect(newFindings(before, after).map((item) => [item.kind, item.line])).toEqual([["duplicate", 4], ["dead-script", 5]]);
		});
	});
});

describe("repositoryContextFiles", () => {
	it("lists the repository's tracked and unignored context files, root first", () => {
		withRepository({
			"AGENTS.md": "# root\n",
			"CLAUDE.md": "# root claude\n",
			"README.md": "# readme\n",
			"z/AGENTS.md": "# z\n",
			"docs/AGENTS.override.md": "# docs\n",
			"docs/deep/CLAUDE.md": "# deep\n",
			".gitignore": "ignored/\n",
		}, (root) => {
			write(root, { "pkg/AGENTS.md": "# new, not committed\n", "ignored/AGENTS.md": "# ignored\n", "notes/agents.md": "# not a context name\n" });
			const expected = ["AGENTS.md", "CLAUDE.md", "docs/AGENTS.override.md", "pkg/AGENTS.md", "z/AGENTS.md", "docs/deep/CLAUDE.md"].map((path) => join(root, path));
			expect(repositoryContextFiles(root)).toEqual({ root, files: expected });
			mkdirSync(join(root, "docs/deep/deeper"), { recursive: true });
			expect(repositoryContextFiles(join(root, "docs/deep/deeper"))).toEqual({ root, files: expected });
		});
	});

	it("skips tracked context files deleted from the checkout", () => {
		withRepository({ "AGENTS.md": "# root\n", "sub/AGENTS.md": "# sub\n" }, (root) => {
			rmSync(join(root, "sub/AGENTS.md"));
			expect(repositoryContextFiles(root).files).toEqual([join(root, "AGENTS.md")]);
		});
	});

	it("outside git, takes the first context file of cwd and each ancestor, root first", () => {
		withDirectory({
			"AGENTS.md": "# top\n",
			"a/CLAUDE.md": "# a claude\n",
			"a/AGENTS.md": "# a agents wins\n",
			"a/b/c/README.md": "# no context file here\n",
		}, (root) => {
			const cwd = join(root, "a/b/c");
			const result = repositoryContextFiles(cwd);
			expect(result.root).toBe(cwd);
			expect(result.files.filter((file) => file.startsWith(`${root}/`))).toEqual([join(root, "AGENTS.md"), join(root, "a/AGENTS.md")]);
		});
	});
});

describe("this repository", () => {
	it("lints its own context files with no findings", () => {
		vi.unstubAllEnvs();
		const { root, files } = repositoryContextFiles(repositoryRoot);
		expect(root).toBe(realpathSync(repositoryRoot));
		expect(files).toContain(join(root, "AGENTS.md"));
		for (const file of files) expect({ file, findings: lintContextFile(readFileSync(file, "utf8"), { file, root }) }).toEqual({ file, findings: [] });
	});
});

it("keeps every finding kind distinct", () => {
	withRepository(FIXTURE, (root) => {
		const text = `${"- filler\n".repeat(MAX_LINES)}- \`gone/x.ts\`\n- \`npm run nope\`\n- [x](gone.md)\n`;
		expect(new Set(kinds(lint(root, text)))).toEqual(new Set(["budget", "dead-path", "dead-script", "dead-link", "duplicate"]));
	});
});
