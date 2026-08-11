import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_STATUS_TIMEOUT_MS = 15_000;
const SECRET_SCAN_TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 2_000;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const GIT_REPOSITORY_ENVIRONMENT = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_QUARANTINE_PATH",
	"GIT_SHALLOW_FILE",
] as const;

export function assertSafeGitEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
	const active = GIT_REPOSITORY_ENVIRONMENT.filter((name) => environment[name]);
	if (active.length > 0) throw new Error(`/commit refuses ambient Git repository overrides: ${active.join(", ")}. Clear them before retrying.`);
}

export function guardedGitArguments(repositoryRoot: string, args: string[]): string[] {
	assertSafeGitEnvironment();
	return [
		"-C",
		repositoryRoot,
		"--no-pager",
		"-c",
		`core.hooksPath=${os.devNull}`,
		"-c",
		"core.fsmonitor=false",
		"-c",
		"maintenance.auto=false",
		"-c",
		"gc.auto=0",
		"-c",
		"log.showSignature=false",
		"--no-replace-objects",
		"--no-lazy-fetch",
		"--no-optional-locks",
		...args,
	];
}

export function assertGitProcessCompleted(result: { killed?: boolean }, label: string): void {
	if (result.killed) throw new Error(`${label} was interrupted or timed out; partial Git output was discarded.`);
}

async function execGuardedGit(
	pi: Pick<ExtensionAPI, "exec">,
	repositoryRoot: string,
	args: string[],
	timeout: number,
	label: string,
) {
	const result = await pi.exec("git", guardedGitArguments(repositoryRoot, args), { timeout });
	assertGitProcessCompleted(result, label);
	return result;
}

export function parseGitPathOutput(stdout: string, label: string): string {
	if (!stdout.endsWith("\n")) throw new Error(`Git returned an unterminated ${label} path.`);
	const value = stdout.slice(0, -1);
	if (!value) throw new Error(`Git returned an empty ${label} path.`);
	if (value.includes("\0")) throw new Error(`Git returned an invalid ${label} path.`);
	return value;
}

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
	{ kind: "private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
	{ kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
	{ kind: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
	{ kind: "live service secret", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
	{ kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ kind: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
];

interface PreflightIssue {
	kind: string;
	path: string;
}

interface StatusEntry {
	code: string;
	path: string;
}

interface FileInspection {
	issues: PreflightIssue[];
	fingerprint: string;
}

export interface WorktreeInspection {
	fingerprint: string;
	dirtyPaths: string[];
	statusOutput: string;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function gitFailure(stderr: string, fallback: string): Error {
	return new Error(stderr.trim() || fallback);
}

function parseNullList(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function parseStatusEntries(output: string): StatusEntry[] {
	const records = parseNullList(output);
	const entries: StatusEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		entries.push({ code, path: record.slice(3) });
		if (/[RC]/.test(code) && index + 1 < records.length) {
			entries.push({ code, path: records[index + 1]! });
			index += 1;
		}
	}
	return entries;
}

export function sensitivePathKind(relativePath: string): string | undefined {
	const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (/^\.env(?:\.|$)/.test(basename) && !/^\.env\.(?:example|sample|template|dist)$/.test(basename)) return "environment credential file";
	if ([".npmrc", ".netrc", "credentials.json", "kubeconfig"].includes(basename)) return "credential configuration file";
	if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(basename)) return "private key file";
	if (/\.(?:key|pem|p12|pfx)$/.test(basename)) return "private key or certificate bundle";
	if (/(?:^|\/)\.docker\/config\.json$/.test(normalized) || /(?:^|\/)\.aws\/credentials$/.test(normalized)) return "credential configuration file";
	if (/service[-_.]?account.*\.json$/.test(basename)) return "service account credential file";
	const embeddedSecret = secretKind(relativePath);
	return embeddedSecret ? `${embeddedSecret} in path name` : undefined;
}

function secretKind(text: string): string | undefined {
	return SECRET_PATTERNS.find((candidate) => candidate.pattern.test(text))?.kind;
}

function uniqueIssues(issues: PreflightIssue[]): PreflightIssue[] {
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.kind}\0${issue.path}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function scanUnifiedDiff(diff: string): PreflightIssue[] {
	const issues: PreflightIssue[] = [];
	let oldPath = "tracked diff";
	let newPath = "tracked diff";
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("--- ")) {
			const source = line.slice(4);
			oldPath = source.startsWith("a/") ? source.slice(2) : source;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const target = line.slice(4);
			newPath = target.startsWith("b/") ? target.slice(2) : target;
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			const kind = secretKind(line.slice(1));
			if (kind) issues.push({ kind, path: newPath });
			continue;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			const kind = secretKind(line.slice(1));
			if (kind) issues.push({ kind, path: oldPath });
		}
	}
	return issues;
}

export function resolveInsideRepository(repositoryRoot: string, candidate: string, base = repositoryRoot): string | undefined {
	const absolute = path.resolve(base, candidate);
	return absolute === repositoryRoot || absolute.startsWith(`${repositoryRoot}${path.sep}`) ? absolute : undefined;
}

async function hashFile(absolutePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(absolutePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function inspectWorktreeFile(
	repositoryRoot: string,
	relativePath: string,
	allowMissing: boolean,
): Promise<FileInspection> {
	const absolute = resolveInsideRepository(repositoryRoot, relativePath);
	if (!absolute) return { issues: [{ kind: "path outside repository", path: relativePath }], fingerprint: "outside" };
	try {
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) {
			const target = await readlink(absolute);
			const kind = sensitivePathKind(target) ?? secretKind(target);
			return {
				issues: kind ? [{ kind, path: relativePath }] : [],
				fingerprint: `symlink:${target}`,
			};
		}
		if (!stat.isFile()) return { issues: [{ kind: "unsupported dirty file type", path: relativePath }], fingerprint: `type:${stat.mode}` };

		const digest = await hashFile(absolute);
		const handle = await open(absolute, "r");
		let sample: Buffer;
		try {
			const length = Math.min(stat.size, BINARY_SAMPLE_BYTES);
			sample = Buffer.alloc(length);
			if (length > 0) await handle.read(sample, 0, length, 0);
		} finally {
			await handle.close();
		}
		if (sample.includes(0)) return { issues: [], fingerprint: `binary:${digest}` };
		if (stat.size > MAX_UNTRACKED_TEXT_BYTES) {
			return {
				issues: [{ kind: "dirty text file too large for safe secret scan", path: relativePath }],
				fingerprint: `large-text:${digest}`,
			};
		}
		const kind = secretKind(await readFile(absolute, "utf8"));
		return {
			issues: kind ? [{ kind, path: relativePath }] : [],
			fingerprint: `text:${digest}`,
		};
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return { issues: [], fingerprint: "missing" };
		return {
			issues: [{ kind: `could not safely inspect dirty path (${message(error)})`, path: relativePath }],
			fingerprint: "error",
		};
	}
}

function preflightError(issues: PreflightIssue[]): Error {
	const unique = uniqueIssues(issues);
	const bounded = unique.slice(0, 20);
	const lines = bounded.map((issue) => `- ${issue.kind}: ${issue.path}`);
	const extra = unique.length - bounded.length;
	if (extra > 0) lines.push(`- and ${extra} more path(s)`);
	return new Error([
		"/commit stopped before model dispatch because the dirty worktree may expose sensitive or unscannable content.",
		...lines,
		"No matching secret value was reproduced. Review these paths locally, then invoke /commit again.",
	].join("\n"));
}

async function assertSafeGitConfiguration(pi: Pick<ExtensionAPI, "exec">, repositoryRoot: string): Promise<void> {
	const filters = await execGuardedGit(pi, repositoryRoot, ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"], GIT_STATUS_TIMEOUT_MS, "Git filter configuration inspection");
	if (![0, 1].includes(filters.code)) throw gitFailure(filters.stderr, "Could not inspect configured Git filters.");
	if (filters.code === 0 && filters.stdout) throw new Error("/commit refuses repositories with command-valued Git clean/process filters.");
	const promisor = await execGuardedGit(
		pi,
		repositoryRoot,
		["config", "--null", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"],
		GIT_STATUS_TIMEOUT_MS,
		"Git partial-clone configuration inspection",
	);
	if (![0, 1].includes(promisor.code)) throw gitFailure(promisor.stderr, "Could not inspect partial-clone configuration.");
	if (promisor.code === 0 && promisor.stdout) throw new Error("/commit refuses partial-clone or promisor repositories because Git could demand-fetch missing objects.");
}

async function assertNoInProgressOperation(pi: Pick<ExtensionAPI, "exec">, repositoryRoot: string): Promise<void> {
	const unresolved = await execGuardedGit(pi, repositoryRoot, ["ls-files", "-u", "-z"], GIT_STATUS_TIMEOUT_MS, "Git unresolved-index inspection");
	if (unresolved.code !== 0) throw gitFailure(unresolved.stderr, "Could not inspect unresolved index entries.");
	if (unresolved.stdout) throw new Error("/commit refuses repositories with unresolved index entries.");
	const gitDirectory = await execGuardedGit(pi, repositoryRoot, ["rev-parse", "--absolute-git-dir"], GIT_STATUS_TIMEOUT_MS, "Git operation-directory inspection");
	if (gitDirectory.code !== 0) throw gitFailure(gitDirectory.stderr, "Could not resolve the Git operation directory.");
	const gitDirectoryPath = parseGitPathOutput(gitDirectory.stdout, "Git operation directory");
	const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];
	for (const marker of markers) {
		try {
			await lstat(path.join(gitDirectoryPath, marker));
			throw new Error(`/commit refuses an in-progress Git operation (${marker}). Finish or abort it explicitly first.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

async function statusOutput(pi: Pick<ExtensionAPI, "exec">, repositoryRoot: string): Promise<string> {
	const result = await execGuardedGit(
		pi,
		repositoryRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
		GIT_STATUS_TIMEOUT_MS,
		"Git status inspection",
	);
	if (result.code !== 0) throw gitFailure(result.stderr, "Could not inspect the Git worktree.");
	return result.stdout;
}

export async function inspectDirtyWorktree(
	pi: Pick<ExtensionAPI, "exec">,
	repositoryRoot: string,
	knownStatusOutput?: string,
): Promise<WorktreeInspection> {
	await assertSafeGitConfiguration(pi, repositoryRoot);
	await assertNoInProgressOperation(pi, repositoryRoot);
	const currentStatus = knownStatusOutput ?? await statusOutput(pi, repositoryRoot);
	if (!currentStatus) {
		return {
			fingerprint: createHash("sha256").update(`clean\0${repositoryRoot}`).digest("hex"),
			dirtyPaths: [],
			statusOutput: "",
		};
	}

	const statusEntries = parseStatusEntries(currentStatus);
	const untrackedResult = await execGuardedGit(
		pi,
		repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z"],
		SECRET_SCAN_TIMEOUT_MS,
		"Git untracked-path inspection",
	);
	if (untrackedResult.code !== 0) throw gitFailure(untrackedResult.stderr, "Could not enumerate untracked files safely.");
	const untrackedPaths = parseNullList(untrackedResult.stdout);
	if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
		throw preflightError([{ kind: `too many untracked files for bounded secret scan (${untrackedPaths.length})`, path: repositoryRoot }]);
	}

	const expandedUntracked = new Set(untrackedPaths);
	const dirtyPaths = [...new Set([...statusEntries.map((entry) => entry.path), ...untrackedPaths])]
		.filter((candidate) => !candidate.endsWith("/") || ![...expandedUntracked].some((untracked) => untracked.startsWith(candidate)))
		.sort();
	const pathIssues = dirtyPaths.flatMap((candidate) => {
		const kind = sensitivePathKind(candidate);
		return kind ? [{ kind, path: candidate }] : [];
	});
	if (pathIssues.length > 0) throw preflightError(pathIssues);

	const diffArguments = ["--no-ext-diff", "--no-textconv", "--unified=0", "--no-color"];
	const [unstagedDiff, stagedDiff] = await Promise.all([
		execGuardedGit(pi, repositoryRoot, ["diff", ...diffArguments], SECRET_SCAN_TIMEOUT_MS, "Git unstaged-diff inspection"),
		execGuardedGit(pi, repositoryRoot, ["diff", "--cached", ...diffArguments], SECRET_SCAN_TIMEOUT_MS, "Git staged-diff inspection"),
	]);
	if (unstagedDiff.code !== 0) throw gitFailure(unstagedDiff.stderr, "Could not scan unstaged changes safely.");
	if (stagedDiff.code !== 0) throw gitFailure(stagedDiff.stderr, "Could not scan staged changes safely.");
	if (Buffer.byteLength(unstagedDiff.stdout) > MAX_DIFF_BYTES) throw preflightError([{ kind: "unstaged diff too large for bounded secret scan", path: repositoryRoot }]);
	if (Buffer.byteLength(stagedDiff.stdout) > MAX_DIFF_BYTES) throw preflightError([{ kind: "staged diff too large for bounded secret scan", path: repositoryRoot }]);

	const issues = [...scanUnifiedDiff(unstagedDiff.stdout), ...scanUnifiedDiff(stagedDiff.stdout)];
	const untracked = new Set(untrackedPaths);
	const fileFingerprints: string[] = [];
	for (const relativePath of dirtyPaths) {
		const inspected = await inspectWorktreeFile(repositoryRoot, relativePath, !untracked.has(relativePath));
		issues.push(...inspected.issues);
		fileFingerprints.push(`${relativePath}\0${inspected.fingerprint}`);
	}
	if (issues.length > 0) throw preflightError(issues);

	const fingerprint = createHash("sha256")
		.update(repositoryRoot).update("\0")
		.update(currentStatus).update("\0")
		.update(untrackedResult.stdout).update("\0")
		.update(unstagedDiff.stdout).update("\0")
		.update(stagedDiff.stdout).update("\0")
		.update(fileFingerprints.join("\0"))
		.digest("hex");
	return { fingerprint, dirtyPaths, statusOutput: currentStatus };
}

export function assertSafeModelText(text: string, label: string): void {
	const kind = secretKind(text);
	if (kind) throw preflightError([{ kind, path: label }]);
}

export async function readRepositoryFileSafely(
	repositoryRoot: string,
	candidate: string,
	base: string,
): Promise<{ path: string; text: string }> {
	const lexical = resolveInsideRepository(repositoryRoot, candidate, base);
	if (!lexical) throw new Error("Path resolves outside the active /commit repository.");
	const candidateKind = sensitivePathKind(candidate);
	if (candidateKind) throw new Error(`Potentially sensitive path access is blocked (${candidateKind}: ${candidate}).`);
	let handle;
	try {
		handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Could not safely open repository file ${candidate}: ${message(error)}`);
	}
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw new Error(`Content reads require a regular file: ${candidate}`);
		const canonical = await realpath(lexical);
		if (!resolveInsideRepository(repositoryRoot, canonical)) throw new Error("Opened file resolves outside the active /commit repository.");
		const relative = path.relative(repositoryRoot, canonical) || ".";
		const canonicalKind = sensitivePathKind(relative);
		if (canonicalKind) throw new Error(`Potentially sensitive path access is blocked (${canonicalKind}: ${relative}).`);
		const canonicalStat = await lstat(canonical);
		if (!canonicalStat.isFile() || canonicalStat.dev !== openedStat.dev || canonicalStat.ino !== openedStat.ino) {
			throw new Error(`Repository file identity changed while opening: ${relative}`);
		}
		if (openedStat.size > MAX_UNTRACKED_TEXT_BYTES) throw preflightError([{ kind: "file too large for safe model read", path: relative }]);
		const buffer = await handle.readFile();
		const finalStat = await handle.stat();
		if (finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs || finalStat.ctimeMs !== openedStat.ctimeMs) {
			throw new Error(`Repository file changed while being read: ${relative}`);
		}
		if (buffer.includes(0)) throw new Error(`Binary files are not exposed during /commit: ${relative}`);
		const text = buffer.toString("utf8");
		assertSafeModelText(text, relative);
		return { path: relative, text };
	} finally {
		await handle.close();
	}
}

export async function fingerprintRepositoryPaths(repositoryRoot: string, paths: Iterable<string>): Promise<string> {
	const hash = createHash("sha256");
	for (const relativePath of [...new Set(paths)].sort()) {
		const absolute = resolveInsideRepository(repositoryRoot, relativePath);
		if (!absolute) throw new Error(`Path resolves outside repository: ${relativePath}`);
		hash.update(relativePath).update("\0");
		try {
			const stat = await lstat(absolute);
			if (stat.isSymbolicLink()) hash.update("symlink:").update(await readlink(absolute));
			else if (stat.isFile()) hash.update("file:").update(await hashFile(absolute));
			else hash.update(`type:${stat.mode}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update("missing");
			else throw error;
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}
