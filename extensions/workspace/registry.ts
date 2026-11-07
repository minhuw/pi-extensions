import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ensureWorkspacesClosure,
	isSubpath,
	readProjectPolicy,
	resolveCanonicalPath,
	workspacesDir,
} from "./policy.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceEntry {
	name: string;
	path: string;
	purpose?: string;
	sessionId?: string;
	sessionTitle?: string;
	pid?: number;
	createdAt: string;
	lastAccessedAt: string;
	closedAt?: string;
	releasedAt?: string;
	pinned: boolean;
	ttlMs: number;
}

export type WorkspaceSafetyStatus = "PINNED" | "ACTIVE" | "SAFE" | "REVIEW";

export interface WorkspaceSafetyReport {
	entry: WorkspaceEntry;
	status: WorkspaceSafetyStatus;
	reasons: string[];
	isGitRepo: boolean;
	isWorktree: boolean;
	worktreeMainRepo?: string;
	sizeBytes: number;
}

export interface CreateOrTouchWorkspaceInput {
	name: string;
	purpose?: string;
	sessionId?: string;
	sessionTitle?: string;
	pid?: number;
	ttlMs?: number;
	pinned?: boolean;
	now?: Date;
}

export interface InspectWorkspaceSafetyOptions {
	activeSessionIds?: ReadonlySet<string>;
	now?: number;
	checkPid?: boolean;
}

export function registryFilePath(cwd: string): string {
	return path.join(workspacesDir(cwd), ".registry.json");
}

export function projectsIndexFilePath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "workspaces-index.json");
}

export function validateWorkspaceName(name: string): string {
	const trimmed = name.trim();
	if (
		!trimmed ||
		trimmed.startsWith(".") ||
		trimmed === "policy.json" ||
		/[\\/]/.test(trimmed) ||
		trimmed.includes("..") ||
		/[\x00-\x1f\x7f]/.test(trimmed)
	) {
		throw new Error(
			`Invalid workspace name "${name}": must be a single non-hidden directory name without path separators or "..".`,
		);
	}
	return trimmed;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

export async function readProjectsIndex(agentDir?: string): Promise<string[]> {
	const indexFile = projectsIndexFilePath(agentDir);
	try {
		const raw = JSON.parse(await readFile(indexFile, "utf8")) as { projects?: unknown } | unknown[] | null;
		const list = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
		return [...new Set(list.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
	} catch {
		return [];
	}
}

export async function registerProjectInIndex(cwd: string, agentDir?: string): Promise<string[]> {
	const canonicalCwd = resolveCanonicalPath(cwd);
	const current = await readProjectsIndex(agentDir);
	const projects = [...new Set([...current, canonicalCwd])];
	await writeJsonAtomic(projectsIndexFilePath(agentDir), { projects });
	return projects;
}

export async function pruneProjectsIndex(agentDir?: string): Promise<{ kept: string[]; removed: string[] }> {
	const current = await readProjectsIndex(agentDir);
	const kept: string[] = [];
	const removed: string[] = [];

	for (const projectPath of current) {
		const wsDir = path.join(projectPath, ".pi", "workspaces");
		if (fs.existsSync(projectPath) && fs.existsSync(wsDir)) {
			kept.push(resolveCanonicalPath(projectPath));
		} else {
			removed.push(projectPath);
		}
	}

	const uniqueKept = [...new Set(kept)];
	await writeJsonAtomic(projectsIndexFilePath(agentDir), { projects: uniqueKept });
	return { kept: uniqueKept, removed };
}

export async function readRegistry(cwd: string): Promise<WorkspaceEntry[]> {
	const file = registryFilePath(cwd);
	try {
		const raw = JSON.parse(await readFile(file, "utf8")) as { workspaces?: unknown } | unknown[] | null;
		const list = Array.isArray(raw) ? raw : Array.isArray(raw?.workspaces) ? raw.workspaces : [];
		const entries: WorkspaceEntry[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			if (typeof record.name !== "string" || !record.name.trim()) continue;
			const name = record.name.trim();
			const entryPath = typeof record.path === "string" && record.path.trim()
				? resolveCanonicalPath(record.path, cwd)
				: path.join(workspacesDir(cwd), name);
			const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString();
			const lastAccessedAt = typeof record.lastAccessedAt === "string" ? record.lastAccessedAt : createdAt;
			entries.push({
				name,
				path: entryPath,
				...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
				...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
				...(typeof record.sessionTitle === "string" ? { sessionTitle: record.sessionTitle } : {}),
				...(typeof record.pid === "number" && Number.isInteger(record.pid) ? { pid: record.pid } : {}),
				createdAt,
				lastAccessedAt,
				...(typeof record.closedAt === "string" ? { closedAt: record.closedAt } : {}),
				...(typeof record.releasedAt === "string" ? { releasedAt: record.releasedAt } : {}),
				pinned: record.pinned === true,
				ttlMs: typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs >= 0 ? record.ttlMs : 0,
			});
		}
		return entries;
	} catch {
		return [];
	}
}

export async function writeRegistry(cwd: string, entries: WorkspaceEntry[], agentDir?: string): Promise<void> {
	await ensureWorkspacesClosure(cwd);
	await writeJsonAtomic(registryFilePath(cwd), { workspaces: entries });
	await registerProjectInIndex(cwd, agentDir);
}

export async function createOrTouchWorkspace(
	cwd: string,
	input: CreateOrTouchWorkspaceInput,
	agentDir?: string,
): Promise<WorkspaceEntry> {
	const name = validateWorkspaceName(input.name);
	const wsRoot = await ensureWorkspacesClosure(cwd);
	const wsPath = path.join(wsRoot, name);
	await mkdir(wsPath, { recursive: true });

	const entries = await readRegistry(cwd);
	const policy = await readProjectPolicy(cwd);
	const nowIso = (input.now ?? new Date()).toISOString();

	const existingIndex = entries.findIndex((entry) => entry.name === name);
	let updatedEntry: WorkspaceEntry;

	if (existingIndex >= 0) {
		const prev = entries[existingIndex]!;
		updatedEntry = {
			...prev,
			name,
			path: wsPath,
			...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
			...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
			...(input.sessionTitle !== undefined ? { sessionTitle: input.sessionTitle } : {}),
			...(input.pid !== undefined ? { pid: input.pid } : {}),
			lastAccessedAt: nowIso,
			pinned: input.pinned ?? prev.pinned,
			ttlMs: input.ttlMs ?? prev.ttlMs,
		};
		delete updatedEntry.closedAt;
		delete updatedEntry.releasedAt;
		entries[existingIndex] = updatedEntry;
	} else {
		updatedEntry = {
			name,
			path: wsPath,
			...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
			...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
			...(input.sessionTitle !== undefined ? { sessionTitle: input.sessionTitle } : {}),
			...(input.pid !== undefined ? { pid: input.pid } : {}),
			createdAt: nowIso,
			lastAccessedAt: nowIso,
			pinned: input.pinned ?? false,
			ttlMs: input.ttlMs ?? policy.defaultTtlMs ?? 0,
		};
		entries.push(updatedEntry);
	}

	await writeRegistry(cwd, entries, agentDir);
	return updatedEntry;
}

export async function syncWorkspaces(cwd: string, now?: Date, agentDir?: string): Promise<WorkspaceEntry[]> {
	const wsRoot = workspacesDir(cwd);
	if (!fs.existsSync(wsRoot)) {
		return [];
	}

	const existingEntries = await readRegistry(cwd);
	const policy = await readProjectPolicy(cwd);
	const byName = new Map<string, WorkspaceEntry>();
	for (const entry of existingEntries) {
		byName.set(entry.name, entry);
	}

	const dirEntries = await readdir(wsRoot, { withFileTypes: true });
	const onDiskNames = new Set<string>();
	const nowIso = (now ?? new Date()).toISOString();
	let changed = false;

	for (const dirent of dirEntries) {
		if (dirent.name.startsWith(".") || dirent.name === "policy.json") continue;
		const fullPath = path.join(wsRoot, dirent.name);
		let isDir = dirent.isDirectory();
		if (dirent.isSymbolicLink()) {
			try {
				isDir = fs.statSync(fullPath).isDirectory();
			} catch {
				isDir = false;
			}
		}
		if (!isDir) continue;
		onDiskNames.add(dirent.name);

		if (!byName.has(dirent.name)) {
			let createdIso = nowIso;
			try {
				const st = await lstat(fullPath);
				createdIso = st.birthtime.toISOString();
			} catch {
				// Use nowIso fallback.
			}
			byName.set(dirent.name, {
				name: dirent.name,
				path: resolveCanonicalPath(fullPath),
				createdAt: createdIso,
				lastAccessedAt: nowIso,
				pinned: false,
				ttlMs: policy.defaultTtlMs ?? 0,
			});
			changed = true;
		} else {
			const current = byName.get(dirent.name)!;
			const canonicalFull = resolveCanonicalPath(fullPath);
			if (current.path !== canonicalFull) {
				current.path = canonicalFull;
				changed = true;
			}
		}
	}

	const synced: WorkspaceEntry[] = [];
	for (const [name, entry] of byName.entries()) {
		if (onDiskNames.has(name) && fs.existsSync(entry.path)) {
			synced.push(entry);
		} else {
			changed = true;
		}
	}

	if (changed || (synced.length > 0 && !fs.existsSync(registryFilePath(cwd)))) {
		await writeRegistry(cwd, synced, agentDir);
	}

	return synced;
}

export async function releaseWorkspace(
	cwd: string,
	name: string,
	now?: Date,
	agentDir?: string,
): Promise<WorkspaceEntry | undefined> {
	const entries = await syncWorkspaces(cwd, now, agentDir);
	const target = entries.find((entry) => entry.name === name);
	if (!target) return undefined;

	const nowIso = (now ?? new Date()).toISOString();
	target.releasedAt = nowIso;
	target.closedAt = nowIso;
	delete target.pid;

	await writeRegistry(cwd, entries, agentDir);
	return target;
}

export async function setWorkspacePin(
	cwd: string,
	name: string,
	pinned: boolean,
	agentDir?: string,
): Promise<WorkspaceEntry | undefined> {
	const entries = await syncWorkspaces(cwd, undefined, agentDir);
	const target = entries.find((entry) => entry.name === name);
	if (!target) return undefined;

	target.pinned = pinned;
	target.lastAccessedAt = new Date().toISOString();
	await writeRegistry(cwd, entries, agentDir);
	return target;
}

export async function markSessionWorkspacesClosed(
	cwd: string,
	sessionId: string,
	now?: Date,
	agentDir?: string,
): Promise<void> {
	if (!fs.existsSync(registryFilePath(cwd))) return;
	const entries = await readRegistry(cwd);
	let changed = false;
	const nowIso = (now ?? new Date()).toISOString();
	for (const entry of entries) {
		if (entry.sessionId === sessionId && !entry.closedAt) {
			entry.closedAt = nowIso;
			delete entry.pid;
			changed = true;
		}
	}
	if (changed) {
		await writeRegistry(cwd, entries, agentDir);
	}
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function computeDirectorySizeBytes(dirPath: string): Promise<number> {
	let total = 0;
	let entries: fs.Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dirPath, entry.name);
		try {
			const st = await lstat(full);
			if (st.isSymbolicLink()) {
				continue;
			}
			if (st.isDirectory()) {
				total += await computeDirectorySizeBytes(full);
			} else if (st.isFile()) {
				total += st.size;
			}
		} catch {
			// Ignore transient / disappearing files.
		}
	}
	return total;
}

interface DetectedGitRoot {
	root: string;
	isWorktree: boolean;
	worktreeMainRepo?: string;
}

async function inspectGitMarker(dirPath: string): Promise<DetectedGitRoot | undefined> {
	const dotGit = path.join(dirPath, ".git");
	try {
		const st = await lstat(dotGit);
		if (st.isDirectory()) {
			return { root: resolveCanonicalPath(dirPath), isWorktree: false };
		}
		if (st.isFile()) {
			const text = await readFile(dotGit, "utf8");
			const match = /^gitdir:\s*(.+)$/m.exec(text);
			if (!match?.[1]) return undefined;
			const gitdirPath = resolveCanonicalPath(match[1].trim(), dirPath);
			let worktreeMainRepo: string | undefined;
			const commondirFile = path.join(gitdirPath, "commondir");
			if (fs.existsSync(commondirFile)) {
				const relCommon = (await readFile(commondirFile, "utf8")).trim();
				if (relCommon) {
					const commonGitDir = resolveCanonicalPath(relCommon, gitdirPath);
					worktreeMainRepo = path.dirname(commonGitDir);
				}
			}
			if (!worktreeMainRepo) {
				const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
				const markerIdx = gitdirPath.indexOf(marker);
				if (markerIdx > 0) {
					worktreeMainRepo = gitdirPath.slice(0, markerIdx);
				}
			}
			return {
				root: resolveCanonicalPath(dirPath),
				isWorktree: true,
				...(worktreeMainRepo ? { worktreeMainRepo } : {}),
			};
		}
	} catch {
		// No .git marker here.
	}
	return undefined;
}

async function findGitRoots(baseDir: string, maxDepth = 2, currentDepth = 0): Promise<DetectedGitRoot[]> {
	const marker = await inspectGitMarker(baseDir);
	if (marker) {
		return [marker];
	}
	if (currentDepth >= maxDepth) {
		return [];
	}
	let entries: fs.Dirent[];
	try {
		entries = await readdir(baseDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: DetectedGitRoot[] = [];
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (!entry.isDirectory()) continue;
		const subRoots = await findGitRoots(path.join(baseDir, entry.name), maxDepth, currentDepth + 1);
		found.push(...subRoots);
	}
	return found;
}

async function hasFilesOutsideGitRoots(dirPath: string, gitRoots: DetectedGitRoot[]): Promise<boolean> {
	const canonicalDir = resolveCanonicalPath(dirPath);
	if (gitRoots.some((g) => g.root === canonicalDir)) {
		return false;
	}
	let entries: fs.Dirent[];
	try {
		entries = await readdir(canonicalDir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const childPath = resolveCanonicalPath(path.join(canonicalDir, entry.name));
		if (gitRoots.some((g) => g.root === childPath)) {
			continue;
		}
		if (entry.isDirectory() && gitRoots.some((g) => isSubpath(childPath, g.root))) {
			if (await hasFilesOutsideGitRoots(childPath, gitRoots)) {
				return true;
			}
			continue;
		}
		return true;
	}
	return false;
}

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const err = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: typeof err.code === "number" ? err.code : 1,
			stdout: typeof err.stdout === "string" ? err.stdout : "",
			stderr: typeof err.stderr === "string" ? err.stderr : "",
		};
	}
}

export async function inspectWorkspaceSafety(
	entry: WorkspaceEntry,
	options?: InspectWorkspaceSafetyOptions,
): Promise<WorkspaceSafetyReport> {
	const exists = fs.existsSync(entry.path);
	const sizeBytes = exists ? await computeDirectorySizeBytes(entry.path) : 0;
	const gitRoots = exists ? await findGitRoots(entry.path, 2) : [];
	const isGitRepo = gitRoots.length > 0;
	const isWorktree = gitRoots.some((g) => g.isWorktree);
	const worktreeMainRepo = gitRoots.find((g) => g.worktreeMainRepo)?.worktreeMainRepo;

	const baseReport = {
		entry,
		isGitRepo,
		isWorktree,
		...(worktreeMainRepo ? { worktreeMainRepo } : {}),
		sizeBytes,
	};

	// Rule 1: Pinned workspaces are never removed automatically.
	if (entry.pinned) {
		return {
			...baseReport,
			status: "PINNED",
			reasons: ["pinned"],
		};
	}

	// Rule 2: Active workspaces (unless explicitly released).
	if (!entry.releasedAt) {
		if (entry.sessionId && options?.activeSessionIds?.has(entry.sessionId)) {
			return {
				...baseReport,
				status: "ACTIVE",
				reasons: ["used by an active session"],
			};
		}
		if (!entry.closedAt && entry.pid && options?.checkPid !== false && isPidAlive(entry.pid)) {
			return {
				...baseReport,
				status: "ACTIVE",
				reasons: [`owning process (pid ${entry.pid}) is still running`],
			};
		}
		const now = options?.now ?? Date.now();
		const refTime = Date.parse(entry.closedAt ?? entry.lastAccessedAt);
		if (entry.ttlMs > 0 && Number.isFinite(refTime) && now - refTime < entry.ttlMs) {
			return {
				...baseReport,
				status: "ACTIVE",
				reasons: ["within retention TTL"],
			};
		}
	}

	// Rule 3: Inspect filesystem & git state.
	if (!exists) {
		return {
			...baseReport,
			status: "SAFE",
			reasons: ["empty workspace directory"],
		};
	}

	let topEntries: fs.Dirent[] = [];
	try {
		topEntries = await readdir(entry.path, { withFileTypes: true });
	} catch {
		topEntries = [];
	}

	if (topEntries.length === 0) {
		return {
			...baseReport,
			status: "SAFE",
			reasons: ["empty workspace directory"],
		};
	}

	if (gitRoots.length === 0) {
		return {
			...baseReport,
			status: "REVIEW",
			reasons: ["contains non-git files"],
		};
	}

	const reviewReasons = new Set<string>();

	if (await hasFilesOutsideGitRoots(entry.path, gitRoots)) {
		reviewReasons.add("contains files outside git repositories");
	}

	for (const gitRoot of gitRoots) {
		const statusRes = await runGit(gitRoot.root, ["status", "--porcelain"]);
		if (statusRes.code !== 0 || statusRes.stdout.trim().length > 0) {
			reviewReasons.add("uncommitted or untracked changes");
		}

		const stashRes = await runGit(gitRoot.root, ["stash", "list"]);
		if (stashRes.stdout.trim().length > 0) {
			reviewReasons.add("git stash entries present");
		}

		if (gitRoot.isWorktree) {
			const headCheck = await runGit(gitRoot.root, ["rev-parse", "--verify", "HEAD"]);
			if (headCheck.code === 0) {
				const branchRes = await runGit(gitRoot.root, ["symbolic-ref", "-q", "--short", "HEAD"]);
				const currentBranch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
				const refsRes = await runGit(gitRoot.root, [
					"for-each-ref",
					"--format=%(refname)",
					"refs/heads",
					"refs/remotes",
					"refs/tags",
				]);
				const otherRefs = refsRes.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((ref) => ref.length > 0 && ref !== (currentBranch ? `refs/heads/${currentBranch}` : ""));

				if (otherRefs.length === 0) {
					reviewReasons.add("unmerged or unpushed commits in worktree");
				} else {
					const unmergedRes = await runGit(gitRoot.root, ["rev-list", "HEAD", "--not", ...otherRefs]);
					if (unmergedRes.code !== 0 || unmergedRes.stdout.trim().length > 0) {
						reviewReasons.add("unmerged or unpushed commits in worktree");
					}
				}
			}
		} else {
			const remoteRes = await runGit(gitRoot.root, ["remote"]);
			const remotes = remoteRes.stdout.trim();
			if (!remotes) {
				const headRes = await runGit(gitRoot.root, ["rev-parse", "--verify", "HEAD"]);
				if (headRes.code === 0) {
					reviewReasons.add("local git repository with no remote");
				}
			} else {
				const headRes = await runGit(gitRoot.root, ["rev-parse", "--verify", "HEAD"]);
				if (headRes.code === 0) {
					const unpushedRes = await runGit(gitRoot.root, ["rev-list", "--all", "--not", "--remotes"]);
					if (unpushedRes.code !== 0 || unpushedRes.stdout.trim().length > 0) {
						reviewReasons.add("unpushed local commits");
					}
				}
			}
		}
	}

	if (reviewReasons.size > 0) {
		return {
			...baseReport,
			status: "REVIEW",
			reasons: [...reviewReasons],
		};
	}

	return {
		...baseReport,
		status: "SAFE",
		reasons: ["clean git workspace with all commits backed up"],
	};
}
