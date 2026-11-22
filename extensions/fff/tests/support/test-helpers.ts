import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
	intervalMs = 10,
): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await sleep(intervalMs);
	}
	return await predicate();
}

export async function waitForPidExit(
	pid: number,
	timeoutMs = 2_000,
	intervalMs = 10,
): Promise<boolean> {
	return waitForCondition(() => !isPidAlive(pid), timeoutMs, intervalMs);
}

export interface TempDirTracker {
	make(prefix?: string, options?: { realpath?: boolean }): string;
	track(dir: string): string;
	cleanup(): void;
}

export function createTempDirTracker(defaultPrefix = "pi-fff-test-"): TempDirTracker {
	const dirs: string[] = [];
	return {
		make(prefix = defaultPrefix, options?: { realpath?: boolean }): string {
			const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
			const dir = options?.realpath ? fs.realpathSync(created) : created;
			dirs.push(dir);
			return dir;
		},
		track(dir: string): string {
			dirs.push(dir);
			return dir;
		},
		cleanup(): void {
			for (const dir of dirs.splice(0)) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

export function hermeticGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...baseEnv,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "FFF Test",
		GIT_AUTHOR_EMAIL: "fff@test.local",
		GIT_COMMITTER_NAME: "FFF Test",
		GIT_COMMITTER_EMAIL: "fff@test.local",
	};
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: hermeticGitEnv(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function initGitRepo(
	dir: string,
	files: Record<string, string>,
	options?: { commitMessage?: string },
): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = path.join(dir, relPath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
	}
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", options?.commitMessage ?? "initial commit");
}
