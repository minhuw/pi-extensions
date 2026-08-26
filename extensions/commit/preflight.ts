import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, readlink, realpath, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_STATUS_TIMEOUT_MS = 120_000;
const SECRET_SCAN_TIMEOUT_MS = 30 * 60_000;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const SECRET_SCAN_CHUNK_BYTES = 64 * 1024;
const SECRET_SCAN_OVERLAP_CHARS = 4 * 1024;
const MAX_DIFF_PATH_CHARS = 64 * 1024;
const FILE_INSPECTION_CONCURRENCY = 16;
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
	headReference?: string;
	headOid?: string;
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

class StreamingSecretScanner {
	private pending = "";

	write(text: string): string | undefined {
		if (!text) return undefined;
		const combined = this.pending + text;
		const kind = secretKind(combined);
		if (kind) return kind;
		this.pending = combined.slice(-SECRET_SCAN_OVERLAP_CHARS);
		return undefined;
	}

	end(text = ""): string | undefined {
		const combined = this.pending + text;
		this.pending = "";
		return secretKind(combined);
	}
}

type DiffLineMode = "prefix" | "old-path" | "new-path" | "added" | "removed" | "ignored";

class UnifiedDiffSecretScanner {
	private readonly issues: PreflightIssue[] = [];
	private readonly issueKeys = new Set<string>();
	private oldPath = "tracked diff";
	private newPath = "tracked diff";
	private mode: DiffLineMode = "prefix";
	private prefix = "";
	private pathValue = "";
	private pathOverflow = false;
	private lineScanner: StreamingSecretScanner | undefined;

	write(text: string): void {
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf("\n", offset);
			const end = newline === -1 ? text.length : newline;
			this.writeLinePart(text.slice(offset, end));
			if (newline === -1) return;
			this.finishLine();
			offset = newline + 1;
		}
	}

	end(text = ""): PreflightIssue[] {
		this.write(text);
		if (this.mode !== "prefix" || this.prefix) this.finishLine();
		return this.issues;
	}

	private writeLinePart(text: string): void {
		if (!text) return;
		if (this.mode === "prefix") {
			const needed = 4 - this.prefix.length;
			this.prefix += text.slice(0, needed);
			const remainder = text.slice(needed);
			if (this.prefix.length === 4 || (this.prefix[0] !== "+" && this.prefix[0] !== "-")) this.classifyPrefix();
			if (remainder) this.writeLinePart(remainder);
			return;
		}
		if (this.mode === "old-path" || this.mode === "new-path") {
			if (!this.pathOverflow) {
				const available = MAX_DIFF_PATH_CHARS - this.pathValue.length;
				this.pathValue += text.slice(0, Math.max(0, available));
				if (text.length > available) this.pathOverflow = true;
			}
			return;
		}
		if ((this.mode === "added" || this.mode === "removed") && this.lineScanner) {
			const kind = this.lineScanner.write(text);
			if (kind) {
				this.addIssue(kind, this.mode === "added" ? this.newPath : this.oldPath);
				this.lineScanner = undefined;
			}
		}
	}

	private classifyPrefix(): void {
		if (this.prefix.startsWith("--- ")) {
			this.mode = "old-path";
			this.pathValue = this.prefix.slice(4);
			return;
		}
		if (this.prefix.startsWith("+++ ")) {
			this.mode = "new-path";
			this.pathValue = this.prefix.slice(4);
			return;
		}
		if (this.prefix.startsWith("+")) {
			this.mode = "added";
			this.lineScanner = new StreamingSecretScanner();
			this.writeLinePart(this.prefix.slice(1));
			return;
		}
		if (this.prefix.startsWith("-")) {
			this.mode = "removed";
			this.lineScanner = new StreamingSecretScanner();
			this.writeLinePart(this.prefix.slice(1));
			return;
		}
		this.mode = "ignored";
	}

	private finishLine(): void {
		if (this.mode === "prefix") this.classifyPrefix();
		if (this.mode === "old-path" || this.mode === "new-path") {
			const value = this.pathOverflow ? "tracked diff" : this.pathValue.replace(/\r$/, "");
			const normalized = value.startsWith(this.mode === "old-path" ? "a/" : "b/") ? value.slice(2) : value;
			if (this.mode === "old-path") this.oldPath = normalized;
			else this.newPath = normalized;
		} else if ((this.mode === "added" || this.mode === "removed") && this.lineScanner) {
			const kind = this.lineScanner.end();
			if (kind) this.addIssue(kind, this.mode === "added" ? this.newPath : this.oldPath);
		}
		this.mode = "prefix";
		this.prefix = "";
		this.pathValue = "";
		this.pathOverflow = false;
		this.lineScanner = undefined;
	}

	private addIssue(kind: string, issuePath: string): void {
		const key = `${kind}\0${issuePath}`;
		if (this.issueKeys.has(key)) return;
		this.issueKeys.add(key);
		this.issues.push({ kind, path: issuePath });
	}
}

export function resolveInsideRepository(repositoryRoot: string, candidate: string, base = repositoryRoot): string | undefined {
	const absolute = path.resolve(base, candidate);
	return absolute === repositoryRoot || absolute.startsWith(`${repositoryRoot}${path.sep}`) ? absolute : undefined;
}

function statFingerprint(stat: BigIntStats): string {
	return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.mode === right.mode
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

async function mapWithConcurrency<T, R>(
	values: readonly T[],
	limit: number,
	worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= values.length) return;
			results[index] = await worker(values[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
	let written = 0;
	while (written < buffer.length) {
		const result = await handle.write(buffer, written, buffer.length - written, null);
		if (result.bytesWritten <= 0) throw new Error("Git index snapshot write made no forward progress.");
		written += result.bytesWritten;
	}
}

async function fingerprintOptionalFile(filePath: string): Promise<string> {
	let handle;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	try {
		const openedStat = await handle.stat({ bigint: true });
		if (!openedStat.isFile()) throw new Error(`Git index must be a regular file: ${filePath}`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(SECRET_SCAN_CHUNK_BYTES);
		let position = 0;
		while (true) {
			const result = await handle.read(buffer, 0, buffer.length, position);
			if (result.bytesRead === 0) break;
			position += result.bytesRead;
			hash.update(buffer.subarray(0, result.bytesRead));
		}
		const finalStat = await handle.stat({ bigint: true });
		if (!sameFileState(openedStat, finalStat)) throw new Error(`Git index changed while being fingerprinted: ${filePath}`);
		return `file:${statFingerprint(finalStat)}:${hash.digest("hex")}`;
	} finally {
		await handle.close();
	}
}

async function copyIndexFile(sourcePath: string, targetPath: string): Promise<string> {
	const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	const target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		const openedStat = await source.stat({ bigint: true });
		if (!openedStat.isFile()) throw new Error(`Git index must be a regular file: ${sourcePath}`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(SECRET_SCAN_CHUNK_BYTES);
		let position = 0;
		while (true) {
			const result = await source.read(buffer, 0, buffer.length, position);
			if (result.bytesRead === 0) break;
			position += result.bytesRead;
			const chunk = buffer.subarray(0, result.bytesRead);
			hash.update(chunk);
			await writeAll(target, chunk);
		}
		await target.utimes(Number(openedStat.atimeNs) / 1_000_000_000, Number(openedStat.mtimeNs) / 1_000_000_000);
		const [finalSourceStat, targetStat] = await Promise.all([
			source.stat({ bigint: true }),
			target.stat({ bigint: true }),
		]);
		if (!sameFileState(openedStat, finalSourceStat)) throw new Error(`Git index changed while its snapshot was copied: ${sourcePath}`);
		if (!targetStat.isFile() || targetStat.size !== openedStat.size) throw new Error("Private Git index snapshot was not copied completely.");
		return `file:${statFingerprint(finalSourceStat)}:${hash.digest("hex")}`;
	} finally {
		await Promise.all([source.close(), target.close()]);
	}
}

async function execGuardedGitWithEnvironment(
	repositoryRoot: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	timeout: number,
	label: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", guardedGitArguments(repositoryRoot, args), {
			cwd: repositoryRoot,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, timeout);
		timer.unref();
		const abort = () => {
			killed = true;
			child.kill("SIGTERM");
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", (code, processSignal) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			const result = { stdout, stderr, code: code ?? 1, killed: killed || processSignal !== null };
			try {
				assertGitProcessCompleted(result, label);
				resolve(result);
			} catch (error) {
				reject(error);
			}
		});
	});
}

export interface PrivateGitIndexSnapshot {
	indexPath: string;
	environment: NodeJS.ProcessEnv;
	liveFingerprint: string;
}

export async function withPrivateGitIndex<T>(
	pi: Pick<ExtensionAPI, "exec">,
	repositoryRoot: string,
	callback: (snapshot: PrivateGitIndexSnapshot) => Promise<T>,
): Promise<T> {
	const indexResult = await execGuardedGit(
		pi,
		repositoryRoot,
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		GIT_STATUS_TIMEOUT_MS,
		"Git index-path inspection",
	);
	if (indexResult.code !== 0) throw gitFailure(indexResult.stderr, "Could not resolve the Git index path.");
	const liveIndexPath = parseGitPathOutput(indexResult.stdout, "Git index");
	const lockPath = `${liveIndexPath}.lock`;
	let lock;
	try {
		lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	} catch (error) {
		throw new Error(`Could not lock the Git index while creating a private snapshot: ${message(error)}`);
	}
	let temporaryDirectory: string | undefined;
	let privateIndexPath: string | undefined;
	let liveFingerprint: string | undefined;
	try {
		temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-index-"));
		privateIndexPath = path.join(temporaryDirectory, "index");
		try {
			liveFingerprint = await copyIndexFile(liveIndexPath, privateIndexPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			liveFingerprint = "missing";
			const environment: NodeJS.ProcessEnv = {
				...process.env,
				GIT_INDEX_FILE: privateIndexPath,
				GIT_NO_LAZY_FETCH: "1",
				GIT_OPTIONAL_LOCKS: "0",
			};
			const initialized = await execGuardedGitWithEnvironment(repositoryRoot, ["read-tree", "--empty"], environment, GIT_STATUS_TIMEOUT_MS, "Private Git index initialization");
			if (initialized.code !== 0) throw gitFailure(initialized.stderr, "Could not initialize an empty private Git index.");
			await chmod(privateIndexPath, 0o600);
		}
	} catch (error) {
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
		throw error;
	} finally {
		await lock.close();
		await unlink(lockPath).catch(() => {});
	}
	if (!temporaryDirectory || !privateIndexPath || liveFingerprint === undefined) throw new Error("Could not create a private Git index snapshot.");
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		GIT_INDEX_FILE: privateIndexPath,
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
	const privateFingerprint = await fingerprintOptionalFile(privateIndexPath);
	try {
		const result = await callback({ indexPath: privateIndexPath, environment, liveFingerprint });
		const [currentLiveFingerprint, currentPrivateFingerprint] = await Promise.all([
			fingerprintOptionalFile(liveIndexPath),
			fingerprintOptionalFile(privateIndexPath),
		]);
		if (currentLiveFingerprint !== liveFingerprint) throw new Error("The live Git index changed while its private snapshot was in use.");
		if (currentPrivateFingerprint !== privateFingerprint) throw new Error("The private Git index snapshot changed while it was in use.");
		return result;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function changedBlobPaths(rawDiff: string): Map<string, string[]> {
	const records = rawDiff.split("\0");
	const blobs = new Map<string, string[]>();
	for (let index = 0; index + 1 < records.length; index += 2) {
		const metadata = records[index]!;
		const filePath = records[index + 1]!;
		if (!metadata || !filePath || !metadata.startsWith(":")) continue;
		const fields = metadata.slice(1).split(" ");
		if (fields.length < 5) throw new Error("Git returned malformed raw tree-diff metadata.");
		const newMode = fields[1]!;
		const oldHash = fields[2]!;
		const newHash = fields[3]!;
		if (newMode === "000000" || newMode === "160000" || /^0+$/.test(newHash) || newHash === oldHash) continue;
		const paths = blobs.get(newHash) ?? [];
		paths.push(filePath);
		blobs.set(newHash, paths);
	}
	return blobs;
}

class AsyncByteReader {
	private readonly iterator: AsyncIterator<Buffer | string>;
	private buffer: Buffer = Buffer.alloc(0);
	private offset = 0;

	constructor(stream: Readable) {
		this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
	}

	private async ensureData(): Promise<boolean> {
		while (this.offset >= this.buffer.length) {
			const next = await this.iterator.next();
			if (next.done) return false;
			this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
			this.offset = 0;
			if (this.buffer.length > 0) return true;
		}
		return true;
	}

	async readLine(maxBytes = 4 * 1024): Promise<string> {
		const chunks: Buffer[] = [];
		let total = 0;
		while (await this.ensureData()) {
			const newline = this.buffer.indexOf(0x0a, this.offset);
			const end = newline === -1 ? this.buffer.length : newline;
			const chunk = this.buffer.subarray(this.offset, end);
			chunks.push(chunk);
			total += chunk.length;
			if (total > maxBytes) throw new Error("Canonical Git object batch returned an oversized header.");
			this.offset = newline === -1 ? this.buffer.length : newline + 1;
			if (newline !== -1) return Buffer.concat(chunks, total).toString("utf8");
		}
		throw new Error("Canonical Git object batch ended before its header newline.");
	}

	async consume(length: number, callback: (chunk: Buffer) => void): Promise<void> {
		let remaining = length;
		while (remaining > 0) {
			if (!(await this.ensureData())) throw new Error("Canonical Git object batch ended before its declared blob size.");
			const count = Math.min(remaining, this.buffer.length - this.offset);
			const chunk = this.buffer.subarray(this.offset, this.offset + count);
			callback(chunk);
			this.offset += count;
			remaining -= count;
		}
	}

	async readByte(): Promise<number> {
		if (!(await this.ensureData())) throw new Error("Canonical Git object batch ended before its blob separator.");
		return this.buffer[this.offset++]!;
	}

	async assertEnd(): Promise<void> {
		if (this.offset < this.buffer.length) throw new Error("Canonical Git object batch returned unexpected trailing bytes.");
		while (true) {
			const next = await this.iterator.next();
			if (next.done) return;
			if (Buffer.from(next.value).length > 0) throw new Error("Canonical Git object batch returned unexpected trailing output.");
		}
	}
}

async function scanCanonicalBlobs(
	repositoryRoot: string,
	hashes: string[],
	pathsByHash: Map<string, string[]>,
	signal?: AbortSignal,
): Promise<PreflightIssue[]> {
	const child = spawn("git", guardedGitArguments(repositoryRoot, ["cat-file", "--batch"]), {
		cwd: repositoryRoot,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let killed = false;
	let stdinError: Error | undefined;
	const timer = setTimeout(() => {
		killed = true;
		child.kill("SIGKILL");
	}, SECRET_SCAN_TIMEOUT_MS);
	timer.unref();
	const abort = () => {
		killed = true;
		child.kill("SIGTERM");
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	child.stdin.on("error", (error) => { stdinError = error; });
	const stderrTask = (async () => {
		let stderr = "";
		for await (const chunk of child.stderr) {
			if (Buffer.byteLength(stderr) < 1024 * 1024) stderr += String(chunk);
		}
		return stderr;
	})();
	const closeTask = new Promise<{ code: number; processSignal: NodeJS.Signals | null }>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, processSignal) => resolve({ code: code ?? 1, processSignal }));
	});
	let parseError: unknown;
	const issues: PreflightIssue[] = [];
	try {
		child.stdin.end(`${hashes.join("\n")}\n`);
		const reader = new AsyncByteReader(child.stdout);
		for (const expectedHash of hashes) {
			const header = await reader.readLine();
			const match = header.match(/^([0-9a-f]+) ([a-z]+) (\d+)$/);
			if (!match || match[1] !== expectedHash || match[2] !== "blob") throw new Error(`Git returned an invalid canonical blob header for ${expectedHash}.`);
			const size = Number(match[3]);
			if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Canonical blob ${expectedHash} is too large to scan safely.`);
			const decoder = new StringDecoder("utf8");
			const scanner = new StreamingSecretScanner();
			let kind: string | undefined;
			await reader.consume(size, (chunk) => {
				if (!kind) kind = scanner.write(decoder.write(chunk));
			});
			if (!kind) kind = scanner.end(decoder.end());
			if (await reader.readByte() !== 0x0a) throw new Error(`Canonical blob ${expectedHash} was not newline-terminated in the Git batch response.`);
			if (kind) {
				for (const filePath of pathsByHash.get(expectedHash) ?? ["canonical staged blob"]) issues.push({ kind, path: filePath });
			}
		}
		await reader.assertEnd();
	} catch (error) {
		parseError = error;
		child.kill("SIGTERM");
	}
	try {
		const [stderr, closed] = await Promise.all([stderrTask, closeTask]);
		if (parseError) throw parseError;
		assertGitProcessCompleted({ killed: killed || closed.processSignal !== null }, "Git canonical-blob inspection");
		if (stdinError) throw new Error(`Git canonical-blob input stream failed: ${stdinError.message}`);
		if (closed.code !== 0) throw gitFailure(stderr, "Could not read canonical staged blobs safely.");
		return issues;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

export async function assertSafeCanonicalTreeChanges(
	repositoryRoot: string,
	parentTree: string,
	treeHash: string,
	signal?: AbortSignal,
): Promise<void> {
	const raw = await execGuardedGitWithEnvironment(
		repositoryRoot,
		["diff-tree", "--raw", "-z", "--no-commit-id", "-r", "--no-renames", parentTree, treeHash],
		process.env,
		SECRET_SCAN_TIMEOUT_MS,
		"Git canonical-tree inspection",
		signal,
	);
	if (raw.code !== 0) throw gitFailure(raw.stderr, "Could not enumerate canonical staged blobs safely.");
	const blobs = changedBlobPaths(raw.stdout);
	if (blobs.size === 0) return;
	const issues = await scanCanonicalBlobs(repositoryRoot, [...blobs.keys()], blobs, signal);
	if (issues.length > 0) throw preflightError(issues);
}

async function scanTextHandleForSecret(handle: Awaited<ReturnType<typeof open>>): Promise<string | undefined> {
	const decoder = new StringDecoder("utf8");
	const scanner = new StreamingSecretScanner();
	const buffer = Buffer.allocUnsafe(SECRET_SCAN_CHUNK_BYTES);
	let position = 0;
	while (true) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		const kind = scanner.write(decoder.write(buffer.subarray(0, bytesRead)));
		if (kind) return kind;
	}
	return scanner.end(decoder.end());
}

export async function assertSafeTextFile(filePath: string, label: string): Promise<void> {
	const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const openedStat = await handle.stat({ bigint: true });
		if (!openedStat.isFile()) throw new Error(`${label} must be a regular file for streaming secret inspection.`);
		const kind = await scanTextHandleForSecret(handle);
		const finalStat = await handle.stat({ bigint: true });
		if (!sameFileState(openedStat, finalStat)) throw new Error(`${label} changed while it was being secret-scanned.`);
		if (kind) throw preflightError([{ kind, path: label }]);
	} finally {
		await handle.close();
	}
}

async function inspectWorktreeFile(
	repositoryRoot: string,
	relativePath: string,
	allowMissing: boolean,
	scanSecrets: boolean,
): Promise<FileInspection> {
	const absolute = resolveInsideRepository(repositoryRoot, relativePath);
	if (!absolute) return { issues: [{ kind: "path outside repository", path: relativePath }], fingerprint: "outside" };
	try {
		const initialStat = await lstat(absolute, { bigint: true });
		if (initialStat.isSymbolicLink()) {
			const target = await readlink(absolute);
			const finalStat = await lstat(absolute, { bigint: true });
			if (!sameFileState(initialStat, finalStat)) throw new Error("Symbolic link changed while being inspected");
			const kind = sensitivePathKind(target) ?? secretKind(target);
			return {
				issues: kind ? [{ kind, path: relativePath }] : [],
				fingerprint: `symlink:${statFingerprint(finalStat)}:${target.length}:${target}`,
			};
		}
		if (!initialStat.isFile()) {
			return {
				issues: [{ kind: "unsupported dirty file type", path: relativePath }],
				fingerprint: `type:${statFingerprint(initialStat)}`,
			};
		}

		const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const openedStat = await handle.stat({ bigint: true });
			if (!openedStat.isFile() || initialStat.dev !== openedStat.dev || initialStat.ino !== openedStat.ino) {
				throw new Error("Dirty file identity changed while being opened");
			}
			let kind: string | undefined;
			if (scanSecrets) {
				const sampleLength = openedStat.size < BigInt(BINARY_SAMPLE_BYTES) ? Number(openedStat.size) : BINARY_SAMPLE_BYTES;
				const sample = Buffer.alloc(sampleLength);
				if (sampleLength > 0) await handle.read(sample, 0, sampleLength, 0);
				if (!sample.includes(0)) kind = await scanTextHandleForSecret(handle);
			}
			const finalStat = await handle.stat({ bigint: true });
			if (!sameFileState(openedStat, finalStat)) throw new Error("Dirty file changed while being inspected");
			return {
				issues: kind ? [{ kind, path: relativePath }] : [],
				fingerprint: `file:${statFingerprint(finalStat)}`,
			};
		} finally {
			await handle.close();
		}
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
		"/commit stopped because the dirty worktree or canonical staged content may expose sensitive or unscannable data.",
		...lines,
		"No matching secret value was reproduced. Review these paths locally, then invoke or rerun /commit."
	].join("\n"));
}

async function assertSafeGitConfiguration(pi: Pick<ExtensionAPI, "exec">, repositoryRoot: string): Promise<void> {
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

async function headIdentity(pi: Pick<ExtensionAPI, "exec">, repositoryRoot: string): Promise<{ reference: string; oid?: string }> {
	const referenceResult = await execGuardedGit(pi, repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], GIT_STATUS_TIMEOUT_MS, "Git symbolic-HEAD inspection");
	if (referenceResult.code !== 0 || !referenceResult.stdout.trim()) throw new Error("/commit requires a symbolic branch HEAD; switch to a branch before retrying.");
	const oidResult = await execGuardedGit(pi, repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], GIT_STATUS_TIMEOUT_MS, "Git HEAD inspection");
	if (![0, 1].includes(oidResult.code)) throw gitFailure(oidResult.stderr, "Could not inspect the current HEAD commit.");
	return { reference: referenceResult.stdout.trim(), oid: oidResult.code === 0 ? oidResult.stdout.trim() : undefined };
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

async function scanUnifiedDiffFile(diffPath: string): Promise<PreflightIssue[]> {
	const decoder = new StringDecoder("utf8");
	const scanner = new UnifiedDiffSecretScanner();
	for await (const chunk of createReadStream(diffPath, { highWaterMark: SECRET_SCAN_CHUNK_BYTES })) {
		scanner.write(decoder.write(chunk));
	}
	return scanner.end(decoder.end());
}

async function scanGuardedGitDiff(
	pi: Pick<ExtensionAPI, "exec">,
	repositoryRoot: string,
	args: string[],
	label: string,
	fallback: string,
	environment?: NodeJS.ProcessEnv,
): Promise<PreflightIssue[]> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-diff-"));
	const diffPath = path.join(temporaryDirectory, "diff");
	try {
		const result = environment
			? await execGuardedGitWithEnvironment(repositoryRoot, [...args, `--output=${diffPath}`], environment, SECRET_SCAN_TIMEOUT_MS, label)
			: await execGuardedGit(
				pi,
				repositoryRoot,
				[...args, `--output=${diffPath}`],
				SECRET_SCAN_TIMEOUT_MS,
				label,
			);
		if (result.code !== 0) throw gitFailure(result.stderr, fallback);
		if (result.stdout) throw new Error(`${label} returned unexpected standard output instead of writing its guarded diff file.`);
		return await scanUnifiedDiffFile(diffPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function sortedListHasPrefix(sortedValues: readonly string[], prefix: string): boolean {
	let low = 0;
	let high = sortedValues.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (sortedValues[middle]! < prefix) low = middle + 1;
		else high = middle;
	}
	return low < sortedValues.length && sortedValues[low]!.startsWith(prefix);
}

export async function inspectDirtyWorktree(
	pi: Pick<ExtensionAPI, "exec">,
	repositoryRoot: string,
	knownStatusOutput?: string,
	options: { scanSecrets?: boolean; assumeIndexLocked?: boolean } = {},
): Promise<WorktreeInspection> {
	await assertSafeGitConfiguration(pi, repositoryRoot);
	await assertNoInProgressOperation(pi, repositoryRoot);
	const currentStatus = knownStatusOutput ?? await statusOutput(pi, repositoryRoot);
	const headBefore = await headIdentity(pi, repositoryRoot);
	if (!currentStatus) {
		const headAfter = await headIdentity(pi, repositoryRoot);
		if (headAfter.reference !== headBefore.reference || headAfter.oid !== headBefore.oid) {
			throw new Error("The symbolic HEAD or current commit changed while the clean worktree was being inspected.");
		}
		return {
			fingerprint: createHash("sha256")
				.update(`clean\0${repositoryRoot}\0${headBefore.reference}\0${headBefore.oid ?? "unborn"}`)
				.digest("hex"),
			dirtyPaths: [],
			statusOutput: "",
			headReference: headBefore.reference,
			headOid: headBefore.oid,
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
	const untrackedPaths = parseNullList(untrackedResult.stdout).sort();
	const dirtyPaths = [...new Set([...statusEntries.map((entry) => entry.path), ...untrackedPaths])]
		.filter((candidate) => !candidate.endsWith("/") || !sortedListHasPrefix(untrackedPaths, candidate))
		.sort();
	const pathIssues = dirtyPaths.flatMap((candidate) => {
		const kind = sensitivePathKind(candidate);
		return kind ? [{ kind, path: candidate }] : [];
	});
	if (pathIssues.length > 0) throw preflightError(pathIssues);

	const scanSecrets = options.scanSecrets ?? true;
	const diffArguments = ["--no-ext-diff", "--no-textconv", "--unified=0", "--no-color"];
	const inspectIndex = async (environment?: NodeJS.ProcessEnv) => {
		const indexArguments = ["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-ext-diff", "--no-textconv", ...(headBefore.oid ? [headBefore.oid] : [])];
		const indexStateResult = environment
			? await execGuardedGitWithEnvironment(repositoryRoot, indexArguments, environment, GIT_STATUS_TIMEOUT_MS, "Private Git index-state inspection")
			: await execGuardedGit(pi, repositoryRoot, indexArguments, GIT_STATUS_TIMEOUT_MS, "Locked Git index-state inspection");
		if (indexStateResult.code !== 0) throw gitFailure(indexStateResult.stderr, "Could not fingerprint the staged index safely.");
		const diffIssues = scanSecrets
			? await Promise.all([
				scanGuardedGitDiff(
					pi,
					repositoryRoot,
					["diff", ...diffArguments],
					"Git unstaged-diff inspection",
					"Could not scan unstaged changes safely.",
					environment,
				),
				scanGuardedGitDiff(
					pi,
					repositoryRoot,
					["diff", "--cached", ...diffArguments, ...(headBefore.oid ? [headBefore.oid] : [])],
					"Git staged-diff inspection",
					"Could not scan staged changes safely.",
					environment,
				),
			])
			: [[], []];
		return { indexStateOutput: indexStateResult.stdout, diffIssues };
	};
	const privateIndexInspection = options.assumeIndexLocked
		? await inspectIndex()
		: await withPrivateGitIndex(pi, repositoryRoot, async (snapshot) => inspectIndex(snapshot.environment));

	const issues = [...privateIndexInspection.diffIssues[0], ...privateIndexInspection.diffIssues[1]];
	const untracked = new Set(untrackedPaths);
	const inspectedFiles = await mapWithConcurrency(
		dirtyPaths,
		FILE_INSPECTION_CONCURRENCY,
		(relativePath) => inspectWorktreeFile(repositoryRoot, relativePath, !untracked.has(relativePath), scanSecrets),
	);
	const fileFingerprints = inspectedFiles.map((inspected, index) => {
		issues.push(...inspected.issues);
		return `${dirtyPaths[index]!}\0${inspected.fingerprint}`;
	});
	if (issues.length > 0) throw preflightError(issues);
	const headAfter = await headIdentity(pi, repositoryRoot);
	if (headAfter.reference !== headBefore.reference || headAfter.oid !== headBefore.oid) {
		throw new Error("The symbolic HEAD or current commit changed while the dirty worktree was being inspected.");
	}

	const fingerprint = createHash("sha256")
		.update(repositoryRoot).update("\0")
		.update(headBefore.reference).update("\0")
		.update(headBefore.oid ?? "unborn").update("\0")
		.update(currentStatus).update("\0")
		.update(untrackedResult.stdout).update("\0")
		.update(privateIndexInspection.indexStateOutput).update("\0")
		.update(fileFingerprints.join("\0"))
		.digest("hex");
	return { fingerprint, dirtyPaths, statusOutput: currentStatus, headReference: headBefore.reference, headOid: headBefore.oid };
}

export function assertSafeModelText(text: string, label: string): void {
	const kind = secretKind(text);
	if (kind) throw preflightError([{ kind, path: label }]);
}

function utf8PrefixWithinBytes(text: string, maxBytes: number): { text: string; bytes: number } {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let end = maxBytes;
	while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
	return { text: buffer.subarray(0, end).toString("utf8"), bytes: end };
}

export async function readRepositoryFileSafely(
	repositoryRoot: string,
	candidate: string,
	base: string,
	options: { offset?: number; limit?: number; maxBytes?: number } = {},
): Promise<{ path: string; text: string; lines: number; truncated: boolean }> {
	const lexical = resolveInsideRepository(repositoryRoot, candidate, base);
	if (!lexical) throw new Error("Path resolves outside the active /commit repository.");
	const candidateKind = sensitivePathKind(candidate);
	if (candidateKind) throw new Error(`Potentially sensitive path access is blocked (${candidateKind}: ${candidate}).`);
	const offset = options.offset ?? 1;
	const limit = options.limit ?? 2_000;
	const maxBytes = options.maxBytes ?? 48 * 1024;
	if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("Repository read offset, limit, and maxBytes must be positive safe integers.");
	}
	let handle;
	try {
		handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Could not safely open repository file ${candidate}: ${message(error)}`);
	}
	try {
		const openedStat = await handle.stat({ bigint: true });
		if (!openedStat.isFile()) throw new Error(`Content reads require a regular file: ${candidate}`);
		const canonical = await realpath(lexical);
		if (!resolveInsideRepository(repositoryRoot, canonical)) throw new Error("Opened file resolves outside the active /commit repository.");
		const relative = path.relative(repositoryRoot, canonical) || ".";
		const canonicalKind = sensitivePathKind(relative);
		if (canonicalKind) throw new Error(`Potentially sensitive path access is blocked (${canonicalKind}: ${relative}).`);
		const canonicalStat = await lstat(canonical, { bigint: true });
		if (!canonicalStat.isFile() || canonicalStat.dev !== openedStat.dev || canonicalStat.ino !== openedStat.ino) {
			throw new Error(`Repository file identity changed while opening: ${relative}`);
		}
		const sampleLength = openedStat.size < BigInt(BINARY_SAMPLE_BYTES) ? Number(openedStat.size) : BINARY_SAMPLE_BYTES;
		const sample = Buffer.alloc(sampleLength);
		if (sampleLength > 0) await handle.read(sample, 0, sampleLength, 0);
		if (sample.includes(0)) throw new Error(`Binary files are not exposed during /commit: ${relative}`);

		const decoder = new StringDecoder("utf8");
		const scanner = new StreamingSecretScanner();
		const buffer = Buffer.allocUnsafe(SECRET_SCAN_CHUNK_BYTES);
		const output: string[] = [];
		let outputBytes = 0;
		let outputTruncated = false;
		let currentLine = 1;
		let capturedLines = 0;
		let sawText = false;
		let endedWithNewline = false;
		let secret: string | undefined;
		let binary = false;
		const appendOutput = (text: string) => {
			if (!text || outputTruncated) return;
			const remaining = maxBytes - outputBytes;
			if (remaining <= 0) {
				outputTruncated = true;
				return;
			}
			const prefix = utf8PrefixWithinBytes(text, remaining);
			output.push(prefix.text);
			outputBytes += prefix.bytes;
			if (prefix.bytes < Buffer.byteLength(text)) outputTruncated = true;
		};
		const consumeText = (text: string) => {
			if (!text) return;
			sawText = true;
			endedWithNewline = text.endsWith("\n");
			let start = 0;
			while (start < text.length) {
				const newline = text.indexOf("\n", start);
				const end = newline === -1 ? text.length : newline + 1;
				if (currentLine >= offset && currentLine < offset + limit) appendOutput(text.slice(start, end));
				if (newline === -1) break;
				if (currentLine >= offset && currentLine < offset + limit) capturedLines += 1;
				currentLine += 1;
				start = end;
			}
		};
		let position = 0;
		while (!secret && !binary) {
			const result = await handle.read(buffer, 0, buffer.length, position);
			if (result.bytesRead === 0) break;
			position += result.bytesRead;
			const chunk = buffer.subarray(0, result.bytesRead);
			if (chunk.includes(0)) {
				binary = true;
				break;
			}
			const text = decoder.write(chunk);
			secret = scanner.write(text);
			consumeText(text);
		}
		if (!secret && !binary) {
			const tail = decoder.end();
			secret = scanner.write(tail) ?? scanner.end();
			consumeText(tail);
		}
		const finalStat = await handle.stat({ bigint: true });
		if (!sameFileState(openedStat, finalStat)) throw new Error(`Repository file changed while being read: ${relative}`);
		if (binary) throw new Error(`Binary files are not exposed during /commit: ${relative}`);
		if (secret) throw preflightError([{ kind: secret, path: relative }]);
		if (!endedWithNewline && (sawText || openedStat.size === 0n) && currentLine >= offset && currentLine < offset + limit) capturedLines += 1;
		return { path: relative, text: output.join(""), lines: capturedLines, truncated: outputTruncated };
	} finally {
		await handle.close();
	}
}

export async function fingerprintRepositoryPathState(repositoryRoot: string, paths: Iterable<string>): Promise<string> {
	const relativePaths = [...new Set(paths)].sort();
	const fingerprints = await mapWithConcurrency(relativePaths, FILE_INSPECTION_CONCURRENCY, async (relativePath) => {
		const absolute = resolveInsideRepository(repositoryRoot, relativePath);
		if (!absolute) throw new Error(`Path resolves outside repository: ${relativePath}`);
		try {
			const initialStat = await lstat(absolute, { bigint: true });
			if (!initialStat.isSymbolicLink()) return `${initialStat.isFile() ? "file" : "type"}:${statFingerprint(initialStat)}`;
			const target = await readlink(absolute);
			const finalStat = await lstat(absolute, { bigint: true });
			if (!sameFileState(initialStat, finalStat)) throw new Error(`Symbolic link changed while fingerprinting: ${relativePath}`);
			return `symlink:${statFingerprint(finalStat)}:${target.length}:${target}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
	});
	const hash = createHash("sha256");
	for (let index = 0; index < relativePaths.length; index += 1) {
		hash.update(relativePaths[index]!).update("\0").update(fingerprints[index]!).update("\0");
	}
	return hash.digest("hex");
}

export async function fingerprintRepositoryPaths(repositoryRoot: string, paths: Iterable<string>): Promise<string> {
	const relativePaths = [...new Set(paths)].sort();
	const fingerprints = await mapWithConcurrency(relativePaths, FILE_INSPECTION_CONCURRENCY, async (relativePath) => {
		const absolute = resolveInsideRepository(repositoryRoot, relativePath);
		if (!absolute) throw new Error(`Path resolves outside repository: ${relativePath}`);
		try {
			const initialStat = await lstat(absolute, { bigint: true });
			if (initialStat.isSymbolicLink()) {
				const target = await readlink(absolute);
				const finalStat = await lstat(absolute, { bigint: true });
				if (!sameFileState(initialStat, finalStat)) throw new Error(`Symbolic link changed while fingerprinting: ${relativePath}`);
				return `symlink:${statFingerprint(finalStat)}:${target.length}:${target}`;
			}
			if (!initialStat.isFile()) return `type:${statFingerprint(initialStat)}`;
			const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const openedStat = await handle.stat({ bigint: true });
				if (!openedStat.isFile() || initialStat.dev !== openedStat.dev || initialStat.ino !== openedStat.ino) {
					throw new Error(`File identity changed while fingerprinting: ${relativePath}`);
				}
				const contentHash = createHash("sha256");
				const buffer = Buffer.allocUnsafe(SECRET_SCAN_CHUNK_BYTES);
				let position = 0;
				while (true) {
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
					if (bytesRead === 0) break;
					position += bytesRead;
					contentHash.update(buffer.subarray(0, bytesRead));
				}
				const finalStat = await handle.stat({ bigint: true });
				if (!sameFileState(openedStat, finalStat)) throw new Error(`File changed while fingerprinting: ${relativePath}`);
				return `file:${statFingerprint(finalStat)}:${contentHash.digest("hex")}`;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
	});
	const hash = createHash("sha256");
	for (let index = 0; index < relativePaths.length; index += 1) {
		hash.update(relativePaths[index]!).update("\0").update(fingerprints[index]!).update("\0");
	}
	return hash.digest("hex");
}
