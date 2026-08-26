import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildCommitPrompt,
	COMMIT_GIT_TOOL,
	COMMIT_LIST_TOOL,
	COMMIT_READ_TOOL,
	COMMIT_RUN_MARKER,
	launchCommitWorkflow,
	registerCommitExtension,
	withExclusiveGitLock,
	withLockedSymbolicHead,
} from "../index.ts";
import { assertSafeGitEnvironment, guardedGitArguments, sensitivePathKind, withPrivateGitIndex } from "../preflight.ts";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

type EventHandler = (...args: any[]) => unknown;

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionEntry = path.join(extensionRoot, "index.ts");
const repositoryRoot = path.resolve(extensionRoot, "../..");
const fakeRepositoryPath = mkdtempSync(path.join(os.tmpdir(), "commit-fake-repository-"));
mkdirSync(path.join(fakeRepositoryPath, "subdir"));
const fakeRepositoryInit = spawnSync("git", ["-C", fakeRepositoryPath, "init", "-q"], { encoding: "utf8" });
assert.equal(fakeRepositoryInit.status, 0, fakeRepositoryInit.stderr);
const fakeRepositoryRoot = realpathSync(fakeRepositoryPath);
process.once("exit", () => { rmSync(fakeRepositoryPath, { recursive: true, force: true }); });

function context(options: {
	trusted?: boolean;
	idle?: boolean;
	cwd?: string;
	onWait?: () => void;
	onNotify?: (message: string, level: string) => void;
} = {}): ExtensionCommandContext {
	return {
		cwd: options.cwd ?? path.join(fakeRepositoryRoot, "subdir"),
		isProjectTrusted: () => options.trusted ?? true,
		waitForIdle: async () => { options.onWait?.(); },
		isIdle: () => options.idle ?? true,
		ui: { notify: (message: string, level: string) => { options.onNotify?.(message, level); } },
	} as unknown as ExtensionCommandContext;
}

function piFor(options: {
	exec?: (command: string, args: string[]) => Promise<ExecResult>;
	onUserMessage?: (message: string) => void;
	onCommand?: (name: string, command: RegisteredCommand) => void;
	onTool?: (tool: RegisteredTool) => void;
	onHandler?: (event: string, handler: EventHandler) => void;
	onActiveTools?: (tools: string[]) => void;
	toolSource?: (name: string, defaultPath: string) => string;
	initialTools?: string[];
} = {}): ExtensionAPI {
	const toolNames = new Set(options.initialTools ?? ["read", "grep", "find", "ls", "bash", "edit", "write"]);
	const toolSources = new Map([...toolNames].map((name) => [name, `<builtin:${name}>`]));
	let activeTools = [...toolNames];
	return {
		exec: async (command: string, args: string[]) => options.exec?.(command, args) ?? { stdout: "", stderr: "", code: 0 },
		sendUserMessage: (content: string | unknown[]) => { options.onUserMessage?.(String(content)); },
		registerCommand: (name: string, command: RegisteredCommand) => { options.onCommand?.(name, command); },
		registerTool: (tool: RegisteredTool) => {
			toolNames.add(tool.name);
			toolSources.set(tool.name, extensionEntry);
			activeTools.push(tool.name);
			options.onTool?.(tool);
		},
		on: (event: string, handler: EventHandler) => { options.onHandler?.(event, handler); },
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...toolNames].map((name) => ({
			name,
			description: "",
			parameters: {},
			promptGuidelines: [],
			sourceInfo: { path: options.toolSource?.(name, toolSources.get(name)!) ?? toolSources.get(name)!, source: "test", scope: "project", origin: "top-level" },
		})),
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
			options.onActiveTools?.([...tools]);
		},
	} as unknown as ExtensionAPI;
}

function localExec(command: string, args: string[]): Promise<ExecResult> {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) return Promise.reject(result.error);
	return Promise.resolve({ stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1, killed: false });
}

function git(repository: string, args: string[]): string {
	const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function fakeIdentityResult(args: string[], root = fakeRepositoryRoot): ExecResult | undefined {
	if (args.includes("--is-inside-work-tree")) return { stdout: "true\n", stderr: "", code: 0 };
	if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
	if (args.includes("--git-path") && args.includes("index")) return { stdout: `${path.join(root, ".git", "index")}\n`, stderr: "", code: 0 };
	if (args.includes("symbolic-ref") && args.includes("HEAD")) return { stdout: "refs/heads/master\n", stderr: "", code: 0 };
	if (args.includes("rev-parse") && args.includes("--verify") && args.includes("--quiet") && args.includes("HEAD")) return { stdout: "", stderr: "", code: 1 };
	if (args.includes("--absolute-git-dir")) return { stdout: `${path.join(root, ".git")}\n`, stderr: "", code: 0 };
	return undefined;
}

async function findSnapshotFile(cursor: string): Promise<string> {
	const snapshotId = cursor.slice(0, cursor.indexOf(":"));
	for (const entry of await readdir(os.tmpdir(), { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("pi-commit-output-")) continue;
		const candidate = path.join(os.tmpdir(), entry.name, `${snapshotId}.txt`);
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Continue searching active guarded runs.
		}
	}
	throw new Error(`Could not locate guarded snapshot for cursor ${cursor}`);
}

async function mockedGitOutput(args: string[], stdout: string): Promise<ExecResult> {
	const output = args.find((argument) => argument.startsWith("--output="));
	if (output) {
		await writeFile(output.slice("--output=".length), stdout);
		return { stdout: "", stderr: "", code: 0 };
	}
	return { stdout, stderr: "", code: 0 };
}

function safeDirtyExec(calls?: Array<{ command: string; args: string[] }>) {
	return async (command: string, args: string[]): Promise<ExecResult> => {
		calls?.push({ command, args });
		const identity = fakeIdentityResult(args);
		if (identity) return identity;
		if (args.includes("rev-parse")) return { stdout: `${fakeRepositoryRoot}\n`, stderr: "", code: 0 };
		if (args.includes("status")) return { stdout: " M src/index.ts\0", stderr: "", code: 0 };
		if (args.includes("ls-files")) return { stdout: "", stderr: "", code: 0 };
		if (args.includes("diff")) return mockedGitOutput(args, args.includes("--raw") ? "" : "+++ b/src/index.ts\n+export const value = 1;\n");
		return { stdout: "", stderr: "", code: 0 };
	};
}

function userMessage(runId: string, text = "workflow") {
	return {
		role: "user",
		content: [{ type: "text", text: `${COMMIT_RUN_MARKER}: ${runId}\n${text}` }],
	};
}

test("commit prompt injects the run marker, packaged workflow, and escaped scope", async () => {
	const prompt = await buildCommitPrompt("/repo/<dirty>&worktree", "only <docs> & tests", undefined, "run-123");
	assert.match(prompt, new RegExp(`^${COMMIT_RUN_MARKER}: run-123`));
	assert.match(prompt, /<commit-workflow location=".*COMMIT\.md">/);
	assert.match(prompt, /# Commit the Current Worktree/);
	assert.match(prompt, /commit_git/);
	assert.match(prompt, /Linux Commit Message Style/);
	assert.match(prompt, /https:\/\/docs\.kernel\.org\/process\/submitting-patches\.html/);
	assert.match(prompt, /REPOSITORY_ROOT: \/repo\/&lt;dirty&gt;&amp;worktree/);
	assert.match(prompt, /<user-commit-instructions>\nonly &lt;docs&gt; &amp; tests\n<\/user-commit-instructions>$/);
	assert.ok(prompt.indexOf("Before opening file content") < prompt.indexOf("After path screening passes"));
});

test("dirty trusted worktrees pass redacting preflight and dispatch through the user lifecycle", async () => {
	let waited = false;
	let submitted = "";
	let hiddenPrompt = "";
	const calls: Array<{ command: string; args: string[] }> = [];
	const pi = piFor({ exec: safeDirtyExec(calls), onUserMessage: (message) => { submitted = message; } });
	const result = await launchCommitWorkflow(pi, context({ onWait: () => { waited = true; } }), "commit parser changes", undefined, {
		beforeDispatch: (binding) => { hiddenPrompt = binding.prompt; },
	});

	assert.equal(result.submitted, true);
	assert.equal(result.repositoryRoot, fakeRepositoryRoot);
	assert.equal(typeof result.runId, "string");
	assert.equal(waited, true);
	const fakeSubdirectory = path.join(fakeRepositoryRoot, "subdir");
	assert.deepEqual(calls.slice(0, 8), [
		{ command: "git", args: guardedGitArguments(fakeSubdirectory, ["rev-parse", "--is-inside-work-tree"]) },
		{ command: "git", args: guardedGitArguments(fakeSubdirectory, ["rev-parse", "--show-toplevel"]) },
		{ command: "git", args: guardedGitArguments(fakeSubdirectory, ["rev-parse", "--absolute-git-dir"]) },
		{ command: "git", args: guardedGitArguments(fakeRepositoryRoot, ["rev-parse", "--absolute-git-dir"]) },
		{ command: "git", args: guardedGitArguments(fakeRepositoryRoot, ["config", "--null", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"]) },
		{ command: "git", args: guardedGitArguments(fakeRepositoryRoot, ["ls-files", "-u", "-z"]) },
		{ command: "git", args: guardedGitArguments(fakeRepositoryRoot, ["rev-parse", "--absolute-git-dir"]) },
		{ command: "git", args: guardedGitArguments(fakeRepositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"]) },
	]);
	assert.ok(calls.some((call) => call.args.includes("status") && call.args.includes("--porcelain=v1")));
	assert.equal(calls.filter((call) => call.args.includes("symbolic-ref") && call.args.includes("HEAD")).length, 2);
	assert.equal(calls.filter((call) => call.args.includes("rev-parse") && call.args.includes("--verify") && call.args.includes("HEAD")).length, 2);
	assert.ok(calls.some((call) => call.args.includes("ls-files") && call.args.includes("--others")));
	assert.ok(calls.some((call) => call.args.includes("--git-path") && call.args.includes("index")));
	assert.match(submitted, new RegExp(`${COMMIT_RUN_MARKER}: ${result.runId}`));
	assert.match(submitted, /Start the guarded \/commit workflow/);
	assert.doesNotMatch(submitted, /# Commit the Current Worktree/);
	assert.match(hiddenPrompt, /commit parser changes/);
});

test("clean worktrees do not spend a model turn", async () => {
	let submitted = false;
	const pi = piFor({
		exec: async (_command, args) => fakeIdentityResult(args) ?? { stdout: "", stderr: "", code: 0 },
		onUserMessage: () => { submitted = true; },
	});
	const result = await launchCommitWorkflow(pi, context());
	assert.deepEqual(result, { submitted: false, repositoryRoot: fakeRepositoryRoot });
	assert.equal(submitted, false);
});

test("killed preflight Git output is rejected instead of scanned partially", async () => {
	let submitted = false;
	const pi = piFor({
		exec: async (_command, args) => {
			const identity = fakeIdentityResult(args);
			if (identity) return { ...identity, killed: false };
			if (args.includes("config")) return { stdout: "", stderr: "", code: 1, killed: false };
			if (args.includes("ls-files")) return { stdout: "", stderr: "", code: 0, killed: false };
			if (args.includes("status")) return { stdout: " M only-partial.ts\0", stderr: "", code: 0, killed: true };
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		onUserMessage: () => { submitted = true; },
	});
	await assert.rejects(() => launchCommitWorkflow(pi, context()), /Git status inspection was interrupted or timed out/);
	assert.equal(submitted, false);
});

test("repository roots preserve legal trailing whitespace", async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "commit-root-path-"));
	const root = path.join(base, "repository ");
	try {
		await mkdir(root);
		git(root, ["init", "-q"]);
		await writeFile(path.join(root, "value.txt"), "dirty\n");
		let submitted = false;
		const result = await launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: root }));
		assert.equal(result.repositoryRoot, await realpath(root));
		assert.equal(result.submitted, true);
		assert.equal(submitted, true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("core.worktree cannot redirect a trusted project into another repository", async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "commit-worktree-redirect-"));
	const project = path.join(base, "project");
	const external = path.join(base, "external");
	try {
		await mkdir(project);
		await mkdir(external);
		git(project, ["init", "-q"]);
		git(external, ["init", "-q"]);
		git(project, ["config", "core.worktree", external]);
		await writeFile(path.join(external, "outside.txt"), "outside\n");
		let submitted = false;
		await assert.rejects(
			() => launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: project })),
			/requires a non-bare Git worktree|does not contain the trusted current directory|different Git repository/,
		);
		assert.equal(submitted, false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("sensitive paths stop before content or model inspection", async () => {
	assert.equal(sensitivePathKind(".aws/credentials"), "credential configuration file");
	assert.equal(sensitivePathKind(".docker/config.json"), "credential configuration file");
	assert.equal(sensitivePathKind("nested/.aws/credentials"), "credential configuration file");
	let submitted = false;
	const pi = piFor({
		exec: async (_command, args) => {
			const identity = fakeIdentityResult(args);
			if (identity) return identity;
			if (args.includes("config")) return { stdout: "", stderr: "", code: 1 };
			if (args.includes("status")) return { stdout: "?? .env.production\0", stderr: "", code: 0 };
			if (args.includes("ls-files") && args.includes("-u")) return { stdout: "", stderr: "", code: 0 };
			if (args.includes("ls-files")) return { stdout: ".env.production\0", stderr: "", code: 0 };
			throw new Error("content scan should not run for a sensitive path");
		},
		onUserMessage: () => { submitted = true; },
	});
	await assert.rejects(() => launchCommitWorkflow(pi, context()), /environment credential file: \.env\.production/);
	assert.equal(submitted, false);
});

test("root-level Docker credential files are rejected without token-shaped content", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-docker-credentials-"));
	try {
		git(root, ["init", "-q"]);
		await mkdir(path.join(root, ".docker"));
		await writeFile(path.join(root, ".docker", "config.json"), '{"auths":{"registry.example":{"auth":"YWxpY2U6aHVudGVyMg=="}}}\n');
		let submitted = false;
		await assert.rejects(
			() => launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: root })),
			/credential configuration file: \.docker\/config\.json/,
		);
		assert.equal(submitted, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("redacting scan catches secrets on removed diff lines without reproducing values", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-removed-secret-"));
	const secret = ["AKIA", "1234567890ABCDEF"].join("");
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await mkdir(path.join(root, "src"));
		await writeFile(path.join(root, "src", "config.ts"), `const key = "${secret}";\n`);
		git(root, ["add", "--", "src/config.ts"]);
		git(root, ["commit", "-q", "-m", "test: establish secret fixture"]);
		await rm(path.join(root, "src", "config.ts"));
		await assert.rejects(() => launchCommitWorkflow(piFor({ exec: localExec }), context({ cwd: root })), (error: unknown) => {
			assert.match(String(error), /AWS access key: src\/config\.ts/);
			assert.doesNotMatch(String(error), new RegExp(secret));
			return true;
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("redacting scan catches secrets in unchanged context of a dirty tracked file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-secret-context-"));
	const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "config.ts"), `const token = "${secret}";\nconst changed = false;\n`);
		git(root, ["add", "--", "config.ts"]);
		git(root, ["commit", "-q", "-m", "test: establish secret fixture"]);
		await writeFile(path.join(root, "config.ts"), `const token = "${secret}";\nconst changed = true;\n`);
		await assert.rejects(() => launchCommitWorkflow(piFor({ exec: localExec }), context({ cwd: root })), (error: unknown) => {
			assert.match(String(error), /GitHub token: config\.ts/);
			assert.doesNotMatch(String(error), new RegExp(secret));
			return true;
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("streaming scans catch overlong secrets across chunk boundaries", async () => {
	const currentRoot = await mkdtemp(path.join(os.tmpdir(), "commit-long-current-secret-"));
	const removedRoot = await mkdtemp(path.join(os.tmpdir(), "commit-long-removed-secret-"));
	const token = `ghp_${"a".repeat(70_000)}`;
	try {
		git(currentRoot, ["init", "-q"]);
		await writeFile(path.join(currentRoot, "large.txt"), `${token}\n`);
		await assert.rejects(() => launchCommitWorkflow(piFor({ exec: localExec }), context({ cwd: currentRoot })), (error: unknown) => {
			assert.match(String(error), /GitHub token: large\.txt/);
			assert.doesNotMatch(String(error), new RegExp(token.slice(0, 128)));
			return true;
		});

		git(removedRoot, ["init", "-q"]);
		git(removedRoot, ["config", "user.name", "Commit Test"]);
		git(removedRoot, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(removedRoot, "removed.txt"), `${token}\n`);
		git(removedRoot, ["add", "--", "removed.txt"]);
		git(removedRoot, ["commit", "-q", "-m", "test: establish secret fixture"]);
		await rm(path.join(removedRoot, "removed.txt"));
		await assert.rejects(() => launchCommitWorkflow(piFor({ exec: localExec }), context({ cwd: removedRoot })), (error: unknown) => {
			assert.match(String(error), /GitHub token: removed\.txt/);
			assert.doesNotMatch(String(error), new RegExp(token.slice(0, 128)));
			return true;
		});
	} finally {
		await rm(currentRoot, { recursive: true, force: true });
		await rm(removedRoot, { recursive: true, force: true });
	}
});

test("ambient Git repository overrides are rejected before command execution", () => {
	assert.throws(
		() => assertSafeGitEnvironment({ GIT_INDEX_FILE: "/tmp/foreign-index" }),
		/ambient Git repository overrides: GIT_INDEX_FILE/,
	);
	assert.doesNotThrow(() => assertSafeGitEnvironment({ GIT_AUTHOR_NAME: "Commit Test" }));
});

test("symbolic HEAD lock rejects a concurrent same-OID branch switch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-head-lock-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "baseline\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create branches sharing one baseline commit."]);
		git(root, ["branch", "other"]);
		const reference = git(root, ["symbolic-ref", "HEAD"]).trim();
		const gitDirectory = git(root, ["rev-parse", "--absolute-git-dir"]).slice(0, -1);
		await withLockedSymbolicHead(gitDirectory, reference, async () => {
			const switched = spawnSync("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/other"], { encoding: "utf8" });
			assert.notEqual(switched.status, 0);
			assert.match(switched.stderr, /HEAD\.lock/);
		});
		assert.equal(git(root, ["symbolic-ref", "HEAD"]).trim(), reference);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Git index lock rejects concurrent staging changes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-index-lock-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create an index-lock baseline."]);
		await writeFile(path.join(root, "value.txt"), "two\n");
		git(root, ["add", "--", "value.txt"]);
		const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).slice(0, -1);
		await withExclusiveGitLock(indexPath, "Git index", async () => {
			const unstaged = spawnSync("git", ["-C", root, "restore", "--staged", "--", "value.txt"], { encoding: "utf8" });
			assert.notEqual(unstaged.status, 0);
			assert.match(unstaged.stderr, /index\.lock/);
		});
		assert.equal(git(root, ["diff", "--cached", "--name-only"]), "value.txt\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("private index snapshots reject live index ABA changes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-index-aba-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline"]);
		const liveIndexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).slice(0, -1);
		await writeFile(path.join(root, "value.txt"), "two\n");
		git(root, ["add", "--", "value.txt"]);
		const indexA = await readFile(liveIndexPath);
		await writeFile(path.join(root, "value.txt"), "three\n");
		git(root, ["add", "--", "value.txt"]);
		const indexB = await readFile(liveIndexPath);
		await writeFile(liveIndexPath, indexA);
		await writeFile(path.join(root, "value.txt"), "two\n");
		let privateDiff = "";
		await assert.rejects(
			() => withPrivateGitIndex(piFor({ exec: localExec }), root, async (snapshot) => {
				await writeFile(liveIndexPath, indexB);
				const diff = spawnSync("git", ["-C", root, "--no-pager", "diff", "--cached", "--no-color"], {
					encoding: "utf8",
					env: snapshot.environment,
				});
				assert.equal(diff.status, 0, diff.stderr);
				privateDiff = diff.stdout;
				await writeFile(liveIndexPath, indexA);
			}),
			/live Git index changed while its private snapshot was in use/,
		);
		assert.match(privateDiff, /\+two/);
		assert.doesNotMatch(privateDiff, /\+three/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed commits reject same-OID branch switches", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-branch-switch-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline"]);
		const originalReference = git(root, ["symbolic-ref", "HEAD"]).trim();
		const baseline = git(root, ["rev-parse", "HEAD"]).trim();
		git(root, ["branch", "other"]);
		await writeFile(path.join(root, "value.txt"), "two\n");
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status", { operation: "status" }, undefined, undefined, ctx);
		await gitTool!.execute("summary", { operation: "diff", scope: "staged", format: "summary" }, undefined, undefined, ctx);
		git(root, ["symbolic-ref", "HEAD", "refs/heads/other"]);
		await assert.rejects(() => gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: reject branch redirection",
			body: "Keep reviewed commits bound to their original symbolic branch.",
		}, undefined, undefined, ctx), /Git state changed outside commit_git|branch reference or parent/);
		assert.equal(git(root, ["rev-parse", originalReference]).trim(), baseline);
		assert.equal(git(root, ["rev-parse", "refs/heads/other"]).trim(), baseline);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("untrusted projects fail before Git inspection", async () => {
	let executed = false;
	const pi = piFor({ exec: async () => {
		executed = true;
		return { stdout: "", stderr: "", code: 0 };
	} });
	await assert.rejects(() => launchCommitWorkflow(pi, context({ trusted: false })), /Trust this project/);
	assert.equal(executed, false);
});

test("real user dispatch activates policy, structured tools, freshness, and restoration", async () => {
	let registered: RegisteredCommand | undefined;
	let gitTool: RegisteredTool | undefined;
	let submitted = "";
	const handlers = new Map<string, EventHandler>();
	const activeSets: string[][] = [];
	const busyNotifications: Array<{ message: string; level: string }> = [];
	const pi = piFor({
		exec: safeDirtyExec(),
		onUserMessage: (message) => { submitted = message; },
		onCommand: (_name, command) => { registered = command; },
		onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
		onHandler: (event, handler) => { handlers.set(event, handler); },
		onActiveTools: (tools) => { activeSets.push(tools); },
	});
	registerCommitExtension(pi, { armTimeoutMs: 5 });
	handlers.get("session_start")!();
	await registered!.handler("", context());
	const runId = submitted.match(new RegExp(`${COMMIT_RUN_MARKER}: ([0-9a-f-]+)`))?.[1];
	assert.ok(runId);
	assert.deepEqual(activeSets.at(-1)?.sort(), [COMMIT_GIT_TOOL, COMMIT_LIST_TOOL, COMMIT_READ_TOOL].sort());

	const inputResult = handlers.get("input")!({ source: "extension", text: submitted });
	assert.deepEqual(inputResult, { action: "continue" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(activeSets.at(-1)?.sort(), [COMMIT_GIT_TOOL, COMMIT_LIST_TOOL, COMMIT_READ_TOOL].sort());
	const before = await handlers.get("before_agent_start")!({ systemPrompt: "PROJECT SYSTEM: push and edit", prompt: submitted });
	assert.match((before as { systemPrompt: string }).systemPrompt, /COMMIT_COMMAND_POLICY_V2/);
	assert.match((before as { systemPrompt: string }).systemPrompt, new RegExp(`RUN_ID: ${runId}`));
	assert.equal((before as { message: { customType: string; display: boolean } }).message.customType, "commit-workflow");
	assert.equal((before as { message: { customType: string; display: boolean } }).message.display, false);
	const foreignStart = await handlers.get("before_agent_start")!({
		systemPrompt: "base",
		prompt: `${COMMIT_RUN_MARKER}: 00000000-0000-4000-8000-000000000000\nlate dispatch`,
	});
	assert.equal(foreignStart, undefined);
	assert.deepEqual(activeSets.at(-1)?.sort(), [COMMIT_GIT_TOOL, COMMIT_LIST_TOOL, COMMIT_READ_TOOL].sort());

	await registered!.handler("", context({ idle: false, onNotify: (message, level) => { busyNotifications.push({ message, level }); } }));
	assert.match(busyNotifications.at(-1)!.message, /must settle before starting another/);
	assert.deepEqual(activeSets.at(-1)?.sort(), [COMMIT_GIT_TOOL, COMMIT_LIST_TOOL, COMMIT_READ_TOOL].sort());
	const bashBlock = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, context());
	assert.match(String((bashBlock as { reason: string }).reason), /bash is disabled/);
	const gitAllowed = await handlers.get("tool_call")!({ toolName: COMMIT_GIT_TOOL, input: { operation: "status" } }, context());
	assert.equal(gitAllowed, undefined);
	const status = await gitTool!.execute("status", { operation: "status" }, undefined, undefined, context());
	assert.match(status.content[0].text, /M src\/index\.ts/);
	await assert.rejects(
		() => gitTool!.execute("broad", { operation: "stage", paths: ["."] }, undefined, undefined, context()),
		/too broad/,
	);

	const currentPrompt = userMessage(runId!);
	const currentWorkflow = { role: "custom", customType: "commit-workflow", details: { runId } };
	const oldPrompt = userMessage("00000000-0000-4000-8000-000000000000");
	const ordinary = { role: "user", content: [{ type: "text", text: "hello" }] };
	const filtered = handlers.get("context")!({ messages: [oldPrompt, ordinary, currentPrompt, currentWorkflow] });
	assert.deepEqual((filtered as { messages: unknown[] }).messages, [ordinary, currentPrompt, currentWorkflow]);

	handlers.get("agent_settled")!();
	assert.deepEqual(activeSets.at(-1)?.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"].sort());
	const after = handlers.get("context")!({ messages: [ordinary, currentPrompt, currentWorkflow] });
	assert.deepEqual((after as { messages: unknown[] }).messages, [ordinary]);
});

test("status summaries ignore repository color configuration", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-colored-status-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "color.status", "always"]);
		await writeFile(path.join(root, "value.txt"), "dirty\n");
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const status = await gitTool!.execute("status", { operation: "status" }, undefined, undefined, ctx);
		assert.match(status.content[0].text, /staged paths: 0/);
		assert.match(status.content[0].text, /unstaged paths: 0/);
		assert.match(status.content[0].text, /untracked paths: 1/);
		assert.doesNotMatch(status.content[0].text, /\u001b\[/);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("extension-owned inventory and reads cannot traverse external symlinks", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-list-boundary-"));
	const external = await mkdtemp(path.join(os.tmpdir(), "commit-list-external-"));
	try {
		git(root, ["init", "-q"]);
		await mkdir(path.join(root, "~", ".ssh"), { recursive: true });
		await writeFile(path.join(root, "~", ".ssh", "decoy.txt"), "repository decoy\n");
		await writeFile(path.join(external, "OUTSIDE_DISCLOSED"), "outside\n");
		await writeFile(path.join(root, ".gitignore"), "ignored-link\nignored-secret.txt\n");
		await writeFile(path.join(root, "ignored-secret.txt"), "username=alice\npassword=hunter2\n");
		await symlink(external, path.join(root, "ignored-link"));
		let registered: RegisteredCommand | undefined;
		let listTool: RegisteredTool | undefined;
		let readTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => {
				if (tool.name === COMMIT_LIST_TOOL) listTool = tool;
				if (tool.name === COMMIT_READ_TOOL) readTool = tool;
			},
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const listed = await listTool!.execute("list", { path: "~/.ssh" }, undefined, undefined, ctx);
		assert.equal(listed.content[0].text, "~/.ssh/decoy.txt");
		const recursive = await listTool!.execute("recursive", { path: ".", recursive: true, maxDepth: 8 }, undefined, undefined, ctx);
		assert.doesNotMatch(recursive.content[0].text, /OUTSIDE_DISCLOSED|ignored-link/);
		await assert.rejects(
			() => readTool!.execute("metadata", { path: ".git/config" }, undefined, undefined, ctx),
			/Repository metadata is not readable/,
		);
		await assert.rejects(
			() => readTool!.execute("ignored", { path: "ignored-secret.txt" }, undefined, undefined, ctx),
			/only tracked or non-ignored untracked files/,
		);
		await assert.rejects(
			() => readTool!.execute("outside", { path: "ignored-link/OUTSIDE_DISCLOSED" }, undefined, undefined, ctx),
			/only tracked or non-ignored untracked files/,
		);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(external, { recursive: true, force: true });
	}
});

test("commit_read streams bounded ranges from large text files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-large-read-"));
	try {
		git(root, ["init", "-q"]);
		const lineCount = 150_000;
		const text = Array.from({ length: lineCount }, (_, index) => `line ${String(index + 1).padStart(6, "0")}\n`).join("");
		await writeFile(path.join(root, "large.txt"), text);
		await writeFile(path.join(root, "late-binary.dat"), Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0]), Buffer.from("tail")]));
		let registered: RegisteredCommand | undefined;
		let readTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_READ_TOOL) readTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const read = await readTool!.execute("large-read", { path: "large.txt", offset: 100_000, limit: 2 }, undefined, undefined, ctx);
		assert.equal(read.content[0].text, "line 100000\nline 100001\n");
		assert.deepEqual(read.details, { path: "large.txt", offset: 100_000, lines: 2, truncated: false });
		await assert.rejects(
			() => readTool!.execute("late-binary", { path: "late-binary.dat" }, undefined, undefined, ctx),
			/Binary files are not exposed/,
		);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tool provenance collisions stop before model dispatch", async () => {
	let submitted = false;
	const notifications: Array<{ message: string; level: string }> = [];
	let registered: RegisteredCommand | undefined;
	const pi = piFor({
		exec: safeDirtyExec(),
		onUserMessage: () => { submitted = true; },
		onCommand: (_name, command) => { registered = command; },
		toolSource: (name, defaultPath) => name === COMMIT_GIT_TOOL ? "/tmp/foreign-extension.ts" : defaultPath,
	});
	registerCommitExtension(pi);
	await registered!.handler("", context({ onNotify: (message, level) => { notifications.push({ message, level }); } }));
	assert.equal(submitted, false);
	assert.match(notifications.at(-1)!.message, /commit_git tool.*not owned/);
});

test("concurrent command handlers reserve preflight ownership synchronously", async () => {
	let registered: RegisteredCommand | undefined;
	let releaseWait!: () => void;
	const wait = new Promise<void>((resolve) => { releaseWait = resolve; });
	const notifications: Array<{ message: string; level: string }> = [];
	const handlers = new Map<string, EventHandler>();
	const activeSets: string[][] = [];
	const pi = piFor({
		exec: safeDirtyExec(),
		onCommand: (_name, command) => { registered = command; },
		onHandler: (event, handler) => { handlers.set(event, handler); },
		onActiveTools: (tools) => { activeSets.push(tools); },
	});
	registerCommitExtension(pi);
	handlers.get("session_start")!();
	const firstContext = context();
	firstContext.waitForIdle = async () => { await wait; };
	const first = registered!.handler("", firstContext);
	await registered!.handler("", context({ onNotify: (message, level) => { notifications.push({ message, level }); } }));
	assert.match(notifications.at(-1)!.message, /still resolving its guarded preflight/);
	releaseWait();
	await first;
	assert.deepEqual(activeSets.at(-1)?.sort(), [COMMIT_GIT_TOOL, COMMIT_LIST_TOOL, COMMIT_READ_TOOL].sort());
	handlers.get("session_shutdown")!();
});

test("marker-free transformed extension input is handled without starting a turn", async () => {
	let registered: RegisteredCommand | undefined;
	const handlers = new Map<string, EventHandler>();
	const notifications: Array<{ message: string; level: string }> = [];
	const activeSets: string[][] = [];
	const pi = piFor({
		exec: safeDirtyExec(),
		onCommand: (_name, command) => { registered = command; },
		onHandler: (event, handler) => { handlers.set(event, handler); },
		onActiveTools: (tools) => { activeSets.push(tools); },
	});
	registerCommitExtension(pi);
	handlers.get("session_start")!();
	await registered!.handler("", context());
	const result = handlers.get("input")!({ source: "extension", text: "marker removed" }, context({ onNotify: (message, level) => { notifications.push({ message, level }); } }));
	assert.deepEqual(result, { action: "handled" });
	assert.match(notifications[0]!.message, /transformed or replaced/);
	assert.deepEqual(activeSets.at(-1)?.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"].sort());
});

test("failed dispatch handshakes restore tools and tombstone late agent starts", async () => {
	let registered: RegisteredCommand | undefined;
	let dispatched = "";
	const handlers = new Map<string, EventHandler>();
	const activeSets: string[][] = [];
	const unresolvedNotifications: Array<{ message: string; level: string }> = [];
	const pi = piFor({
		exec: safeDirtyExec(),
		onUserMessage: (message) => { dispatched = message; },
		onCommand: (_name, command) => { registered = command; },
		onHandler: (event, handler) => { handlers.set(event, handler); },
		onActiveTools: (tools) => { activeSets.push(tools); },
	});
	registerCommitExtension(pi, { armTimeoutMs: 50, startTimeoutMs: 5 });
	handlers.get("session_start")!();
	await registered!.handler("", context());
	handlers.get("input")!({ source: "extension", text: dispatched }, context());
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(activeSets.at(-1)?.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"].sort());
	await registered!.handler("", context({ onNotify: (message, level) => { unresolvedNotifications.push({ message, level }); } }));
	assert.match(unresolvedNotifications.at(-1)!.message, /prior \/commit dispatch is still unresolved/);
	assert.deepEqual(activeSets.at(-1)?.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"].sort());

	const late = await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
	assert.match((late as { systemPrompt: string }).systemPrompt, /STATE_INVALID: The \/commit dispatch reached Pi input/);
	assert.deepEqual(activeSets.at(-1), []);
	const blocked = handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, context());
	assert.match(String((blocked as { reason: string }).reason), /no guarded agent run started/);
	handlers.get("agent_settled")!();
	assert.deepEqual(activeSets.at(-1)?.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"].sort());
});

test("structured commit_git operations honor trusted clean filters", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-git-tool-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create the baseline used by the structured commit tool test."]);
		git(root, ["config", "filter.canonical.clean", "sed 's/two/canonical/'"]);
		git(root, ["config", "filter.canonical.smudge", "cat"]);
		await writeFile(path.join(root, ".git", "info", "attributes"), "value.txt filter=canonical\n");
		const hookMarker = path.join(root, "hook-ran");
		const quotedMarker = `'${hookMarker.replaceAll("'", "'\\''")}'`;
		for (const hook of ["pre-commit", "prepare-commit-msg", "post-commit", "post-index-change", "reference-transaction"]) {
			const hookPath = path.join(root, ".git", "hooks", hook);
			await writeFile(hookPath, `#!/bin/sh\ntouch ${quotedMarker}\n`);
			await chmod(hookPath, 0o755);
		}
		await writeFile(path.join(root, "value.txt"), "two\n");

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let readTool: RegisteredTool | undefined;
		let dispatched = "";
		let quietRefChecks = 0;
		let attachmentRace: ReturnType<typeof spawnSync> | undefined;
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: async (command, args) => {
				if (args.includes("rev-parse") && args.includes("--verify") && args.includes("--quiet") && args.some((argument) => argument.startsWith("refs/heads/")) && ++quietRefChecks === 2) {
					attachmentRace = spawnSync("git", ["-C", root, "restore", "--staged", "--", "value.txt"], { encoding: "utf8" });
				}
				return localExec(command, args);
			},
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => {
				if (tool.name === COMMIT_GIT_TOOL) gitTool = tool;
				if (tool.name === COMMIT_READ_TOOL) readTool = tool;
			},
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });

		const read = await readTool!.execute("read", { path: "value.txt" }, undefined, undefined, ctx);
		assert.equal(read.content[0].text, "two\n");
		const diff = await gitTool!.execute("diff", { operation: "diff", scope: "unstaged" }, undefined, undefined, ctx);
		assert.match(diff.content[0].text, /-one/);
		assert.match(diff.content[0].text, /\+canonical/);
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		await gitTool!.execute("diff-staged", { operation: "diff", scope: "staged" }, undefined, undefined, ctx);
		await gitTool!.execute("check", { operation: "check" }, undefined, undefined, ctx);
		const committed = await gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: exercise structured git operations",
			body: "Exercise the structured commit path without generic shell access.",
		}, undefined, undefined, ctx);
		assert.match(committed.content[0].text, /Created [0-9a-f]{12}/);
		assert.notEqual(attachmentRace?.status, 0);
		assert.match(String(attachmentRace?.stderr ?? ""), /index\.lock/);
		const shown = await gitTool!.execute("show", { operation: "show" }, undefined, undefined, ctx);
		assert.match(shown.content[0].text, /commit: exercise structured git operations/);
		assert.equal(git(root, ["log", "-1", "--format=%B"]).trimEnd(), "commit: exercise structured git operations\n\nExercise the structured commit path without generic shell access.");
		assert.equal(git(root, ["show", "HEAD:value.txt"]), "canonical\n");
		await assert.rejects(() => access(hookMarker));
		assert.equal(git(root, ["-c", `core.hooksPath=${os.devNull}`, "status", "--porcelain"]), "");
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("structured tools support unstaging and committing an unborn branch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-unborn-branch-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "initial\n");
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("unstage", { operation: "unstage", paths: ["value.txt"] }, undefined, undefined, ctx);
		assert.match(git(root, ["-c", `core.hooksPath=${os.devNull}`, "status", "--porcelain"]), /\?\? value\.txt/);
		await gitTool!.execute("stage-again", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		await gitTool!.execute("diff-staged", { operation: "diff", scope: "staged" }, undefined, undefined, ctx);
		const committed = await gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: create initial repository state",
			body: "Create the first reviewed tree through the structured commit workflow.",
		}, undefined, undefined, ctx);
		assert.match(committed.content[0].text, /Created [0-9a-f]{12}/);
		assert.equal(git(root, ["rev-list", "--count", "HEAD"]).trim(), "1");
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed tree validation rejects a same-path index race before ref update", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-index-race-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for index-race validation."]);
		const baseline = git(root, ["rev-parse", "HEAD"]).trim();
		await writeFile(path.join(root, "value.txt"), "two\n");
		const injected = path.join(root, ".git", "injected-source");
		await writeFile(injected, "raced\n");
		let inject = false;

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: async (command, args) => {
				if (inject && args.includes("write-tree")) {
					inject = false;
					const blob = git(root, ["hash-object", "-w", "--", injected]).trim();
					git(root, ["update-index", "--cacheinfo", "100644", blob, "value.txt"]);
				}
				return localExec(command, args);
			},
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		await gitTool!.execute("diff-staged", { operation: "diff", scope: "staged" }, undefined, undefined, ctx);
		inject = true;
		await assert.rejects(() => gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: reject index races",
			body: "Ensure the immutable tree remains identical to the reviewed index state.",
		}, undefined, undefined, ctx), /exact staged tree has not received a complete/);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), baseline);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("staging rejects concurrent changes to other initially dirty files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-cross-file-race-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "a.txt"), "one\n");
		await writeFile(path.join(root, "b.txt"), "one\n");
		git(root, ["add", "--", "a.txt", "b.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for cross-file race validation."]);
		await writeFile(path.join(root, "a.txt"), "two\n");
		await writeFile(path.join(root, "b.txt"), "two\n");
		const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
		let mutateDuringStage = false;
		let writeTreeCalls = 0;
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: async (command, args) => {
				if (mutateDuringStage && args.includes("write-tree") && ++writeTreeCalls === 2) {
					await writeFile(path.join(root, "b.txt"), `external ${secret}\n`);
				}
				return localExec(command, args);
			},
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		mutateDuringStage = true;
		await assert.rejects(
			() => gitTool!.execute("stage-a", { operation: "stage", paths: ["a.txt"] }, undefined, undefined, ctx),
			(error: unknown) => {
				assert.match(String(error), /working-tree changes outside its guarded mutation/);
				assert.doesNotMatch(String(error), new RegExp(secret));
				return true;
			},
		);
		assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), `external ${secret}\n`);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cancelled pathspec staging handles early Git stdin closure", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-stage-cancel-"));
	try {
		git(root, ["init", "-q"]);
		const generated = path.join(root, "generated");
		await mkdir(generated);
		await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(
			path.join(generated, `cancel-${String(index).padStart(4, "0")}-${"x".repeat(100)}.txt`),
			"value\n",
		)));
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => gitTool!.execute("stage-cancelled", { operation: "stage", pathPrefixes: ["generated"] }, controller.signal, undefined, ctx),
			/interrupted or timed out|input stream failed/,
		);
		assert.ok(true, "the host process remained alive after the cancelled stdin write");
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("oversized staged patches can be authorized by an exact tree-bound summary", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-large-diff-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "baseline\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for bounded diff review."]);
		await writeFile(path.join(root, "value.txt"), `${"changed line\n".repeat(5_000)}`);

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		const patchPage = await gitTool!.execute("diff-staged", { operation: "diff", scope: "staged", format: "patch" }, undefined, undefined, ctx);
		assert.match(patchPage.content[0].text, /Continue with cursor/);
		assert.ok(patchPage.details.nextCursor);
		const patchSnapshot = await findSnapshotFile(patchPage.details.nextCursor);
		await writeFile(patchSnapshot, "tampered snapshot\n");
		await assert.rejects(() => gitTool!.execute("diff-staged-tampered", {
			operation: "diff",
			cursor: patchPage.details.nextCursor,
		}, undefined, undefined, ctx), /snapshot identity or size changed/);
		const summary = await gitTool!.execute("diff-summary", { operation: "diff", scope: "staged", format: "summary" }, undefined, undefined, ctx);
		await assert.rejects(() => access(patchSnapshot));
		assert.equal(summary.details.complete, true);
		assert.match(summary.content[0].text, /5000\s+1\s+value\.txt/);
		const committed = await gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: review large diffs incrementally",
			body: "Bind paginated review to the exact staged tree without a total diff limit.",
		}, undefined, undefined, ctx);
		assert.match(committed.content[0].text, /Created [0-9a-f]{12}/);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("encoded secrets are blocked before paginated patch disclosure and commit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-canonical-secret-"));
	const secret = `ghp_${"a".repeat(40)}`;
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, ".gitattributes"), "*.utf16 working-tree-encoding=UTF-16LE\n");
		const payloadPath = path.join(root, "payload.utf16");
		let prefixLength = 128;
		await writeFile(payloadPath, Buffer.from(`${" ".repeat(prefixLength)}${secret}\n`, "utf16le"));
		git(root, ["add", "--", ".gitattributes", "payload.utf16"]);
		let patch = git(root, ["diff", "--cached", "--no-color"]);
		const initialTokenOffset = Buffer.byteLength(patch.slice(0, patch.indexOf(secret)));
		const targetTokenOffset = 47_104 - 2 - Buffer.byteLength("## Staged patch\n");
		prefixLength += targetTokenOffset - initialTokenOffset;
		assert.ok(prefixLength > 0);
		await writeFile(payloadPath, Buffer.from(`${" ".repeat(prefixLength)}${secret}\n`, "utf16le"));
		git(root, ["add", "--", "payload.utf16"]);
		patch = git(root, ["diff", "--cached", "--no-color"]);
		assert.equal(Buffer.byteLength(patch.slice(0, patch.indexOf(secret))), targetTokenOffset);
		git(root, ["rm", "--cached", "--force", "--", ".gitattributes", "payload.utf16"]);
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: [".gitattributes", "payload.utf16"] }, undefined, undefined, ctx);
		await gitTool!.execute("status", { operation: "status" }, undefined, undefined, ctx);
		await assert.rejects(
			() => gitTool!.execute("patch", { operation: "diff", scope: "staged", format: "patch" }, undefined, undefined, ctx),
			/GitHub token: staged patch Git diff snapshot/,
		);
		await gitTool!.execute("summary", { operation: "diff", scope: "staged", format: "summary" }, undefined, undefined, ctx);
		await assert.rejects(() => gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: reject encoded credentials",
			body: "Scan canonical staged blobs after Git applies working-tree encoding.",
		}, undefined, undefined, ctx), (error: unknown) => {
			assert.match(String(error), /GitHub token: payload\.utf16/);
			assert.doesNotMatch(String(error), new RegExp(secret));
			return true;
		});
		assert.notEqual(spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"]).status, 0);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("large dirty inventories stage by prefix and review summaries across pages", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-large-inventory-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		const generated = path.join(root, "generated");
		await mkdir(generated);
		const fileCount = 2_001;
		for (let start = 0; start < fileCount; start += 100) {
			await Promise.all(Array.from({ length: Math.min(100, fileCount - start) }, (_, offset) => {
				const index = start + offset;
				return writeFile(path.join(generated, `generated-file-${String(index).padStart(5, "0")}-${"x".repeat(100)}.txt`), `value ${index}\n`);
			}));
		}

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		let freshnessStatusCalls = 0;
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: async (command, args) => {
				if (args.includes("status") && args.includes("--porcelain=v1") && args.includes("-z")) freshnessStatusCalls += 1;
				return localExec(command, args);
			},
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const staged = await gitTool!.execute("stage-generated", {
			operation: "stage",
			pathPrefixes: ["generated"],
		}, undefined, undefined, ctx);
		assert.equal(staged.details.pathCount, fileCount);
		const status = await gitTool!.execute("status-generated", { operation: "status" }, undefined, undefined, ctx);
		assert.match(status.content[0].text, /staged paths: 2,001/);
		assert.ok(status.details.nextCursor);
		const prefixSummary = await gitTool!.execute("summary-generated-prefix", {
			operation: "diff",
			scope: "staged",
			format: "summary",
			pathPrefixes: ["generated"],
		}, undefined, undefined, ctx);
		assert.equal(prefixSummary.details.selectedPathCount, fileCount);
		assert.ok(prefixSummary.details.nextCursor);
		const prefixSnapshot = await findSnapshotFile(prefixSummary.details.nextCursor);
		let summary = await gitTool!.execute("summary-generated", {
			operation: "diff",
			scope: "staged",
			format: "summary",
		}, undefined, undefined, ctx);
		assert.ok(summary.details.nextCursor);
		await assert.rejects(() => access(prefixSnapshot));
		const summarySnapshot = await findSnapshotFile(summary.details.nextCursor);
		await assert.rejects(() => gitTool!.execute("commit-too-early", {
			operation: "commit",
			subject: "commit: reject partial manifest review",
			body: "Require every page of the exact staged manifest before committing.",
		}, undefined, undefined, ctx), /has not received a complete commit_git diff review/);
		const freshnessBeforeIntermediatePage = freshnessStatusCalls;
		summary = await gitTool!.execute("summary-generated-page", {
			operation: "diff",
			cursor: summary.details.nextCursor,
		}, undefined, undefined, ctx);
		assert.ok(summary.details.nextCursor);
		assert.equal(freshnessStatusCalls, freshnessBeforeIntermediatePage);
		let pages = 2;
		while (summary.details.nextCursor) {
			summary = await gitTool!.execute("summary-generated-page", {
				operation: "diff",
				cursor: summary.details.nextCursor,
			}, undefined, undefined, ctx);
			pages += 1;
		}
		assert.ok(pages > 1);
		await assert.rejects(() => access(summarySnapshot));
		const committed = await gitTool!.execute("commit-generated", {
			operation: "commit",
			subject: "commit: add generated inventory",
			body: "Review a pageable manifest and stage the original generated path prefix.",
		}, undefined, undefined, ctx);
		assert.match(committed.content[0].text, /Created [0-9a-f]{12}/);
		assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n").length, fileCount);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("killed staged diff output cannot satisfy exact-tree review", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-killed-diff-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "a.txt"), "one\n");
		await writeFile(path.join(root, "b.txt"), "one\n");
		git(root, ["add", "--", "a.txt", "b.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for interrupted diff review."]);
		await writeFile(path.join(root, "a.txt"), "two\n");
		await writeFile(path.join(root, "b.txt"), "two\n");
		const baseline = git(root, ["rev-parse", "HEAD"]).trim();
		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["a.txt", "b.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => gitTool!.execute("diff-staged", { operation: "diff", scope: "staged" }, controller.signal, undefined, ctx),
			/git (?:write-tree|diff) was interrupted or timed out/,
		);
		await assert.rejects(() => gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: reject interrupted diff review",
			body: "Do not mark a staged tree reviewed from partial process output.",
		}, undefined, undefined, ctx), /has not received a complete commit_git diff review/);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), baseline);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("literal pathspec mode prevents magic filenames from staging siblings", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-literal-path-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "baseline.txt"), "baseline\n");
		git(root, ["add", "--", "baseline.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for literal pathspec staging."]);
		const magic = ":(glob)**";
		await writeFile(path.join(root, magic), "magic\n");
		await writeFile(path.join(root, "sibling.txt"), "sibling\n");

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: [magic] }, undefined, undefined, ctx);
		assert.equal(git(root, ["diff", "--cached", "--name-only"]), `${magic}\n`);
		assert.match(git(root, ["status", "--porcelain"]), /\?\? sibling\.txt/);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("in-progress Git operations are rejected before model dispatch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-operation-state-"));
	try {
		git(root, ["init", "-q"]);
		await writeFile(path.join(root, "value.txt"), "dirty\n");
		await writeFile(path.join(root, ".git", "MERGE_HEAD"), "0".repeat(40));
		let submitted = false;
		const pi = piFor({ exec: localExec, onUserMessage: () => { submitted = true; } });
		await assert.rejects(() => launchCommitWorkflow(pi, context({ cwd: root })), /in-progress Git operation \(MERGE_HEAD\)/);
		assert.equal(submitted, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("trusted command-valued Git filters are allowed before model dispatch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-filter-config-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		git(root, ["config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'"]);
		git(root, ["config", "filter.upper.smudge", "cat"]);
		await writeFile(path.join(root, ".gitattributes"), "value.txt filter=upper\n");
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", ".gitattributes", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish filtered baseline", "-m", "Create a baseline using the trusted clean filter."]);
		await writeFile(path.join(root, "value.txt"), "two\n");
		let submitted = false;
		const result = await launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: root }));
		assert.equal(result.submitted, true);
		assert.equal(submitted, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("configured fsmonitor commands are disabled for guarded Git inspection", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-fsmonitor-config-"));
	try {
		git(root, ["init", "-q"]);
		const marker = path.join(root, "fsmonitor-ran");
		const monitor = path.join(root, ".git", "fsmonitor.sh");
		await writeFile(monitor, `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`);
		await chmod(monitor, 0o755);
		git(root, ["config", "core.fsmonitor", monitor]);
		await writeFile(path.join(root, "value.txt"), "dirty\n");
		let submitted = false;
		const result = await launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: root }));
		assert.equal(result.submitted, true);
		assert.equal(submitted, true);
		await assert.rejects(() => access(marker));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repository signature verification programs are disabled for log inspection", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-signature-verifier-"));
	try {
		git(root, ["init", "-q"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		const tree = git(root, ["write-tree"]).trim();
		const commitText = [
			`tree ${tree}`,
			"author Commit Test <commit-test@example.invalid> 1700000000 +0000",
			"committer Commit Test <commit-test@example.invalid> 1700000000 +0000",
			"gpgsig -----BEGIN PGP SIGNATURE-----",
			" dummy",
			" -----END PGP SIGNATURE-----",
			"",
			"signed: establish baseline",
			"",
		].join("\n");
		const hashed = spawnSync("git", ["-C", root, "hash-object", "-t", "commit", "-w", "--stdin"], { encoding: "utf8", input: commitText });
		assert.equal(hashed.status, 0, hashed.stderr);
		git(root, ["update-ref", "refs/heads/master", hashed.stdout.trim()]);
		git(root, ["symbolic-ref", "HEAD", "refs/heads/master"]);
		const marker = path.join(root, "verifier-ran");
		const verifier = path.join(root, ".git", "gpg-verifier.sh");
		await writeFile(verifier, `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`);
		await chmod(verifier, 0o755);
		git(root, ["config", "gpg.program", verifier]);
		git(root, ["config", "log.showSignature", "true"]);
		await writeFile(path.join(root, "value.txt"), "two\n");

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		const log = await gitTool!.execute("log", { operation: "log" }, undefined, undefined, ctx);
		assert.match(log.content[0].text, /signed: establish baseline/);
		await assert.rejects(() => access(marker));
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("configured commit signing is refused without invoking a signer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-signing-policy-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "user.name", "Commit Test"]);
		git(root, ["config", "user.email", "commit-test@example.invalid"]);
		await writeFile(path.join(root, "value.txt"), "one\n");
		git(root, ["add", "--", "value.txt"]);
		git(root, ["commit", "-q", "-m", "test: establish baseline", "-m", "Create a baseline for signing-policy validation."]);
		git(root, ["config", "commit.gpgSign", "true"]);
		await writeFile(path.join(root, "value.txt"), "two\n");
		const baseline = git(root, ["rev-parse", "HEAD"]).trim();

		let registered: RegisteredCommand | undefined;
		let gitTool: RegisteredTool | undefined;
		let dispatched = "";
		const handlers = new Map<string, EventHandler>();
		const pi = piFor({
			exec: localExec,
			onUserMessage: (message) => { dispatched = message; },
			onCommand: (_name, command) => { registered = command; },
			onTool: (tool) => { if (tool.name === COMMIT_GIT_TOOL) gitTool = tool; },
			onHandler: (event, handler) => { handlers.set(event, handler); },
		});
		registerCommitExtension(pi);
		handlers.get("session_start")!();
		const ctx = context({ cwd: root });
		await registered!.handler("", ctx);
		handlers.get("input")!({ source: "extension", text: dispatched });
		await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
		await gitTool!.execute("stage", { operation: "stage", paths: ["value.txt"] }, undefined, undefined, ctx);
		await gitTool!.execute("status-staged", { operation: "status" }, undefined, undefined, ctx);
		await gitTool!.execute("diff-staged", { operation: "diff", scope: "staged" }, undefined, undefined, ctx);
		await assert.rejects(() => gitTool!.execute("commit", {
			operation: "commit",
			subject: "commit: reject external signing",
			body: "Keep signer programs outside the guarded commit tool boundary.",
		}, undefined, undefined, ctx), /refuses configured commit signing/);
		assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), baseline);
		handlers.get("agent_settled")!();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("promisor repositories are rejected before any demand fetch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "commit-promisor-config-"));
	try {
		git(root, ["init", "-q"]);
		git(root, ["config", "remote.origin.promisor", "true"]);
		await writeFile(path.join(root, "value.txt"), "dirty\n");
		let submitted = false;
		await assert.rejects(
			() => launchCommitWorkflow(piFor({ exec: localExec, onUserMessage: () => { submitted = true; } }), context({ cwd: root })),
			/partial-clone or promisor repositories/,
		);
		assert.equal(submitted, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("post-preflight Git races invalidate the run before tool execution", async () => {
	let registered: RegisteredCommand | undefined;
	const handlers = new Map<string, EventHandler>();
	let dispatched = "";
	let changed = false;
	const pi = piFor({
		exec: async (command, args) => {
			const identity = fakeIdentityResult(args);
			if (identity) return identity;
			if (args.includes("status")) return { stdout: changed ? " M src/other.ts\0" : " M src/index.ts\0", stderr: "", code: 0 };
			if (args.includes("ls-files")) return { stdout: "", stderr: "", code: 0 };
			if (args.includes("diff") && args.includes("--raw")) return mockedGitOutput(args, "");
			if (args.includes("diff")) return mockedGitOutput(args, changed ? "+++ b/src/other.ts\n+changed\n" : "+++ b/src/index.ts\n+changed\n");
			return { stdout: "", stderr: "", code: 0 };
		},
		onUserMessage: (message) => { dispatched = message; },
		onCommand: (_name, command) => { registered = command; },
		onHandler: (event, handler) => { handlers.set(event, handler); },
	});
	registerCommitExtension(pi);
	handlers.get("session_start")!();
	await registered!.handler("", context());
	handlers.get("input")!({ source: "extension", text: dispatched });
	changed = true;
	const before = await handlers.get("before_agent_start")!({ systemPrompt: "base", prompt: dispatched });
	assert.match((before as { systemPrompt: string }).systemPrompt, /STATE_INVALID: Git state changed/);
	const blocked = await handlers.get("tool_call")!({ toolName: COMMIT_GIT_TOOL, input: { operation: "status" } }, context());
	assert.match(String((blocked as { reason: string }).reason), /Git state changed/);
});

test("package manifest and documentation expose the guarded commit extension", async () => {
	const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	const rootReadme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
	const source = await readFile(path.join(extensionRoot, "index.ts"), "utf8");
	assert.ok(manifest.pi.extensions.includes("./extensions/commit/index.ts"));
	assert.match(rootReadme, /\[Commit\]\(extensions\/commit\/README\.md\)/);
	assert.match(source, /sendUserMessage/);
	assert.match(source, /before_agent_start/);
	assert.match(source, /registerTool/);
	assert.match(source, /setActiveTools/);
});

test("registered command reports clean and invalid repositories natively", async () => {
	let registeredName = "";
	let registered: RegisteredCommand | undefined;
	let mode: "clean" | "invalid" = "clean";
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = piFor({
		exec: async (_command, args) => {
			if (mode === "invalid" && args.includes("rev-parse")) return { stdout: "", stderr: "fatal: not a git repository", code: 128 };
			return fakeIdentityResult(args) ?? { stdout: "", stderr: "", code: 0 };
		},
		onCommand: (name, command) => {
			registeredName = name;
			registered = command;
		},
	});
	registerCommitExtension(pi);
	assert.equal(registeredName, "commit");
	assert.match(registered!.description, /Linux-style commits/);

	const ctx = context({ onNotify: (message, level) => { notifications.push({ message, level }); } });
	await registered!.handler("", ctx);
	assert.deepEqual(notifications.pop(), { message: "Working tree is clean; nothing to commit.", level: "info" });

	mode = "invalid";
	await registered!.handler("", ctx);
	assert.deepEqual(notifications.pop(), { message: "fatal: not a git repository", level: "error" });
});
