// Config-isolated git and temporary-repository helpers shared by agents-md test suites.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ISOLATED_GIT_CONFIG = [
	"-c", "user.name=Agents MD Test",
	"-c", "user.email=agents-md-test@example.test",
	"-c", "commit.gpgsign=false",
	"-c", "core.hooksPath=/dev/null",
] as const;

/** Runs `git` in `cwd` isolated from global/system git configuration, hooks, and commit signing. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", [...ISOLATED_GIT_CONFIG, ...args], {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
			GIT_TERMINAL_PROMPT: "0",
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Writes each relative path in `files` under `dir`, creating parent directories as needed. */
export function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

/** Creates a resolved temporary directory with `prefix`; the caller removes it when done. */
export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Initializes a git repository at `dir`, writes `files`, and makes an initial commit. */
export function initGitRepo(dir: string, files: Record<string, string> = {}, message = "init"): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	writeFiles(dir, files);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", message);
	return dir;
}
