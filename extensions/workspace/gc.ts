import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveCanonicalPath, workspacesDir } from "./policy.ts";
import {
	inspectWorkspaceSafety,
	pruneProjectsIndex,
	readRegistry,
	setWorkspacePin,
	syncWorkspaces,
	writeRegistry,
	type WorkspaceSafetyReport,
} from "./registry.ts";

const execFileAsync = promisify(execFile);

export interface GcOptions {
	cwd: string;
	agentDir?: string;
	allProjects?: boolean;
	dryRun?: boolean;
	yes?: boolean;
	activeSessionIds?: ReadonlySet<string>;
	now?: number;
	checkPid?: boolean;
	confirmReview?: (report: WorkspaceSafetyReport) => Promise<"remove" | "pin" | "skip">;
}

export interface GcResult {
	removed: WorkspaceSafetyReport[];
	kept: WorkspaceSafetyReport[];
	pinned: WorkspaceSafetyReport[];
	prunedProjects: string[];
	dryRun: boolean;
}

/**
 * Garbage collection removes only an entry directly under `<cwd>/.pi/workspaces/` that is not a symbolic
 * link, so a symlinked, stale, or hand-edited registry path cannot redirect the removal elsewhere.
 */
function isRemovableWorkspacePath(projectCwd: string, entryPath: string): boolean {
	const wsRoot = resolveCanonicalPath(workspacesDir(projectCwd));
	return path.dirname(entryPath) === wsRoot && resolveCanonicalPath(entryPath) === entryPath;
}

async function removeWorkspaceDirectory(projectCwd: string, report: WorkspaceSafetyReport): Promise<void> {
	if (!isRemovableWorkspacePath(projectCwd, report.entry.path)) {
		throw new Error(
			`Refusing to remove "${report.entry.path}": it is not a workspace directory in ${workspacesDir(projectCwd)}.`,
		);
	}

	if (report.isWorktree && report.worktreeMainRepo) {
		try {
			await execFileAsync(
				"git",
				["-C", report.worktreeMainRepo, "worktree", "remove", "--force", report.entry.path],
				{ encoding: "utf8" },
			);
		} catch {
			// Fall back to recursive directory removal + git worktree prune below.
		}
		if (fs.existsSync(report.entry.path)) {
			await rm(report.entry.path, { recursive: true, force: true });
		}
		try {
			await execFileAsync("git", ["-C", report.worktreeMainRepo, "worktree", "prune"], {
				encoding: "utf8",
			});
		} catch {
			// Ignore prune errors if main repo is gone.
		}
		return;
	}

	await rm(report.entry.path, { recursive: true, force: true });
}

export async function runWorkspaceGc(options: GcOptions): Promise<GcResult> {
	const dryRun = options.dryRun === true;
	const removed: WorkspaceSafetyReport[] = [];
	const kept: WorkspaceSafetyReport[] = [];
	const pinned: WorkspaceSafetyReport[] = [];
	let prunedProjects: string[] = [];

	const projectCwds = new Set<string>([resolveCanonicalPath(options.cwd)]);
	if (options.allProjects) {
		const pruned = await pruneProjectsIndex(options.agentDir);
		prunedProjects = pruned.removed;
		for (const keptProject of pruned.kept) {
			projectCwds.add(resolveCanonicalPath(keptProject));
		}
	}

	for (const projectCwd of projectCwds) {
		if (!fs.existsSync(workspacesDir(projectCwd))) {
			continue;
		}
		const entries = await syncWorkspaces(
			projectCwd,
			options.now !== undefined ? new Date(options.now) : undefined,
			options.agentDir,
		);
		const removedNames = new Set<string>();

		for (const entry of entries) {
			const report = await inspectWorkspaceSafety(entry, {
				activeSessionIds: options.activeSessionIds,
				now: options.now,
				checkPid: options.checkPid,
			});

			// A path that removal refuses is never reported as removed or offered for removal.
			if (!isRemovableWorkspacePath(projectCwd, entry.path)) {
				kept.push(report);
				continue;
			}

			if (report.status === "SAFE") {
				if (!dryRun) {
					await removeWorkspaceDirectory(projectCwd, report);
					removedNames.add(entry.name);
				}
				removed.push(report);
				continue;
			}

			if (report.status === "REVIEW") {
				if (!dryRun && options.confirmReview) {
					const decision = await options.confirmReview(report);
					if (decision === "remove") {
						await removeWorkspaceDirectory(projectCwd, report);
						removedNames.add(entry.name);
						removed.push(report);
						continue;
					}
					if (decision === "pin") {
						const updatedEntry = await setWorkspacePin(projectCwd, entry.name, true, options.agentDir);
						const pinnedReport: WorkspaceSafetyReport = {
							...report,
							entry: updatedEntry ?? { ...entry, pinned: true },
							status: "PINNED",
							reasons: ["pinned"],
						};
						pinned.push(pinnedReport);
						kept.push(pinnedReport);
						continue;
					}
				}
				kept.push(report);
				continue;
			}

			// PINNED or ACTIVE
			kept.push(report);
		}

		if (!dryRun && removedNames.size > 0) {
			const current = await readRegistry(projectCwd);
			const remaining = current.filter((item) => !removedNames.has(item.name));
			await writeRegistry(projectCwd, remaining, options.agentDir);
		}
	}

	return {
		removed,
		kept,
		pinned,
		prunedProjects,
		dryRun,
	};
}
