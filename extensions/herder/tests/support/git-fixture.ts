import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

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

export interface GitFixtureLifecycle {
	/** Creates a fresh repository fixture that will be removed in `afterEach`. */
	create(files?: Record<string, string>): GitFixture;
	/** Registers a teardown callback that runs before fixtures are removed in `afterEach`. */
	cleanup(fn: () => Promise<void> | void): void;
}

export interface GitFixtureLifecycleOptions {
	/** Runs before registered cleanups in `afterEach`. */
	beforeCleanup?: () => Promise<void> | void;
	/** Runs after fixtures are removed in `afterEach`. */
	afterCleanup?: () => Promise<void> | void;
}

/**
 * Registers an `afterEach` hook that runs registered cleanups (such as session shutdowns)
 * and then removes every git fixture created via `create()`.
 */
export function useGitFixtures(options?: GitFixtureLifecycleOptions): GitFixtureLifecycle {
	const created: GitFixture[] = [];
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		try {
			await options?.beforeCleanup?.();
			for (const fn of cleanups.splice(0)) await fn();
		} finally {
			for (const fixture of created.splice(0)) fixture.cleanup();
			await options?.afterCleanup?.();
		}
	});
	return {
		create(files) {
			const fixture = createGitFixture(files);
			created.push(fixture);
			return fixture;
		},
		cleanup(fn) {
			cleanups.push(fn);
		},
	};
}

export interface CheckoutSnapshot {
	status: string;
	head: string;
	branch: string;
	branches: string;
	index: string;
}

/** HEAD, branch, branch list, index bytes, and status of the user's checkout (invariant 1). */
export function checkout(fixture: GitFixture): CheckoutSnapshot {
	const status = fixture.status();
	return {
		status,
		head: fixture.head(),
		branch: fixture.git("symbolic-ref", "-q", "--short", "HEAD"),
		branches: fixture.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
		index: createHash("sha256").update(readFileSync(join(fixture.commonDir, "index"))).digest("hex"),
	};
}
