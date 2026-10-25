import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitFixture {
	/** Real path of the repository's top level. */
	readonly dir: string;
	/** Absolute `git rev-parse --git-common-dir`. */
	readonly commonDir: string;
	git(...args: string[]): string;
	write(path: string, content: string): void;
	read(path: string): string;
	/** Writes `files`, stages everything, commits, and returns the new HEAD. */
	commit(message: string, files?: Record<string, string>): string;
	head(): string;
	/** `git status --porcelain --ignored` of the checkout; empty when Herder left it untouched. */
	status(): string;
	cleanup(): void;
}

// Isolate fixtures from the developer's global git configuration (hooks, signing, templates).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export function createGitFixture(files: Record<string, string> = { "README.md": "# fixture\n" }): GitFixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "herder-git-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	};
	try {
		git("init", "-q", "-b", "main");
		for (const [key, value] of [["user.name", "Herder Test"], ["user.email", "herder@example.test"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git("config", key, value);
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	const fixture: GitFixture = {
		dir,
		commonDir: join(dir, ".git"),
		git,
		write,
		read: (path) => readFileSync(join(dir, path), "utf8"),
		commit(message, more = {}) {
			for (const [path, content] of Object.entries(more)) write(path, content);
			git("add", "-A");
			git("commit", "-q", "--allow-empty", "-m", message);
			return git("rev-parse", "HEAD");
		},
		head: () => git("rev-parse", "HEAD"),
		status: () => git("status", "--porcelain", "--ignored"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
	fixture.commit("initial", files);
	return fixture;
}

/** Runs `fn` with a fresh repository and always removes it. */
export async function withGitFixture<T>(fn: (fixture: GitFixture) => T | Promise<T>, files?: Record<string, string>): Promise<T> {
	const fixture = createGitFixture(files);
	try {
		return await fn(fixture);
	} finally {
		fixture.cleanup();
	}
}
