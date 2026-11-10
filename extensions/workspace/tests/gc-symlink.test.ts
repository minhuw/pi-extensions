import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkspaceGc } from "../gc.ts";
import { ensureWorkspacesClosure } from "../policy.ts";
import {
	createOrTouchWorkspace,
	inspectWorkspaceSafety,
	readRegistry,
	registerProjectInIndex,
	registryFilePath,
	type WorkspaceEntry,
	type WorkspaceSafetyReport,
} from "../registry.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initGitRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);
}

function commitFile(dir: string, relPath: string, content: string): void {
	fs.writeFileSync(path.join(dir, relPath), content, "utf8");
	git(dir, ["add", relPath]);
	git(dir, ["commit", "-m", `commit ${relPath}`]);
}

let sandboxRoot: string;
let projectCwd: string;
let otherProjectCwd: string;
let outsideDir: string;
let agentDir: string;
let wsRoot: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-gc-symlink-"));
	projectCwd = path.join(sandboxRoot, "project");
	otherProjectCwd = path.join(sandboxRoot, "other-project");
	outsideDir = path.join(sandboxRoot, "outside");
	agentDir = path.join(sandboxRoot, "agent");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(otherProjectCwd, { recursive: true }),
		mkdir(outsideDir, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
	]);
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	wsRoot = await ensureWorkspacesClosure(projectCwd);
});

afterEach(async () => {
	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	await rm(sandboxRoot, { recursive: true, force: true });
});

/** Clones a remote whose only commit is pushed into `dir`: it holds `README.md`, and a workspace like it is SAFE. */
function cloneCleanRepo(dir: string): void {
	const remote = path.join(sandboxRoot, "origin.git");
	if (!fs.existsSync(remote)) {
		git(sandboxRoot, ["init", "--bare", remote]);
		const seed = path.join(sandboxRoot, "seed");
		initGitRepo(seed);
		commitFile(seed, "README.md", "seeded remote\n");
		git(seed, ["remote", "add", "origin", remote]);
		git(seed, ["push", "-u", "origin", "HEAD"]);
	}
	git(sandboxRoot, ["clone", remote, dir]);
}

function entryAt(name: string, dir: string): WorkspaceEntry {
	const epoch = new Date(0).toISOString();
	return { name, path: dir, createdAt: epoch, lastAccessedAt: epoch, pinned: false, ttlMs: 0 };
}

/** The safety state a real workspace with the contents of `dir` is in. */
async function statusAsWorkspace(dir: string): Promise<string> {
	return (await inspectWorkspaceSafety(entryAt(path.basename(dir), dir))).status;
}

function paths(reports: WorkspaceSafetyReport[]): string[] {
	return reports.map((report) => report.entry.path).sort();
}

const GC_MODES = [
	{ flags: "--dry-run", dryRun: true, allProjects: false },
	{ flags: "(no flags)", dryRun: false, allProjects: false },
	{ flags: "--dry-run --all", dryRun: true, allProjects: true },
	{ flags: "--all", dryRun: false, allProjects: true },
];

/** `linkTo` is what the links point into: an absolute outside path, or `../..` (the project) as in `x -> ../../src`. */
const LINK_TARGETS = [
	{ where: "outside the project", linkTo: () => outsideDir },
	{ where: "inside the project but outside .pi/workspaces", linkTo: () => path.join("..", "..") },
];

describe("gc.ts & registry.ts — symlinked .pi/workspaces/<name> entries", () => {
	for (const { where, linkTo } of LINK_TARGETS) {
		it.each(GC_MODES)(
			`gc $flags keeps the targets of links to directories ${where}`,
			async ({ dryRun, allProjects }) => {
				// A clean clone holding a file and an empty directory: both SAFE if they were real workspaces.
				const repoDir = path.resolve(wsRoot, linkTo(), "src");
				const emptyDir = path.resolve(wsRoot, linkTo(), "empty");
				cloneCleanRepo(repoDir);
				await mkdir(emptyDir);
				expect(await statusAsWorkspace(repoDir)).toBe("SAFE");
				expect(await statusAsWorkspace(emptyDir)).toBe("SAFE");

				const repoLink = path.join(wsRoot, "repo-link");
				const emptyLink = path.join(wsRoot, "empty-link");
				await symlink(path.join(linkTo(), "src"), repoLink);
				await symlink(path.join(linkTo(), "empty"), emptyLink);

				// `--all` reaches the project through the projects index, from another project.
				await registerProjectInIndex(projectCwd, agentDir);
				const result = await runWorkspaceGc({
					cwd: allProjects ? otherProjectCwd : projectCwd,
					agentDir,
					dryRun,
					allProjects,
				});

				expect({
					removed: paths(result.removed),
					repoFile: fs.existsSync(path.join(repoDir, "README.md")),
					emptyDir: fs.existsSync(emptyDir),
				}).toEqual({ removed: [], repoFile: true, emptyDir: true });
				// The links are not workspaces: they stay where they are, unregistered.
				expect(paths(result.kept)).toEqual([]);
				expect(fs.lstatSync(repoLink).isSymbolicLink()).toBe(true);
				expect(fs.lstatSync(emptyLink).isSymbolicLink()).toBe(true);
				expect(await readRegistry(projectCwd)).toEqual([]);
			},
		);
	}

	it("keeps a clean linked git worktree behind a symlinked entry", async () => {
		const mainRepo = path.join(sandboxRoot, "main-repo");
		initGitRepo(mainRepo);
		commitFile(mainRepo, "main.ts", "console.log('main');\n");
		const worktreeDir = path.join(outsideDir, "wt");
		git(mainRepo, ["worktree", "add", "-b", "wt-branch", worktreeDir, "HEAD"]);
		expect(await statusAsWorkspace(worktreeDir)).toBe("SAFE");
		await symlink(worktreeDir, path.join(wsRoot, "wt-link"));

		for (const dryRun of [true, false]) {
			const result = await runWorkspaceGc({ cwd: projectCwd, agentDir, dryRun });
			expect({
				removed: paths(result.removed),
				worktreeFile: fs.existsSync(path.join(worktreeDir, "main.ts")),
			}).toEqual({ removed: [], worktreeFile: true });
		}
		expect(git(mainRepo, ["worktree", "list"])).toContain("wt-branch");
	});

	it("never offers a symlinked entry for review, so 'Remove anyway' cannot reach its target", async () => {
		const notes = path.join(outsideDir, "notes.md");
		await writeFile(notes, "# keep me\n", "utf8");
		expect(await statusAsWorkspace(outsideDir)).toBe("REVIEW");
		await symlink(outsideDir, path.join(wsRoot, "link"));

		const reviewed: string[] = [];
		const result = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
			confirmReview: async (report) => {
				reviewed.push(report.entry.path);
				return "remove";
			},
		});

		expect({ removed: paths(result.removed), reviewed, notes: fs.existsSync(notes) }).toEqual({
			removed: [],
			reviewed: [],
			notes: true,
		});
	});

	it("does not remove a pinned workspace through a link to it", async () => {
		const pinned = await createOrTouchWorkspace(projectCwd, { name: "pinned-ws", pinned: true }, agentDir);
		await symlink("pinned-ws", path.join(wsRoot, "alias"));

		const result = await runWorkspaceGc({ cwd: projectCwd, agentDir });

		expect({ removed: paths(result.removed), kept: paths(result.kept), pinnedDir: fs.existsSync(pinned.path) }).toEqual({
			removed: [],
			kept: [pinned.path],
			pinnedDir: true,
		});
	});

	it("does not follow a registry entry whose path was edited to point outside", async () => {
		const repoDir = path.join(outsideDir, "src");
		cloneCleanRepo(repoDir);
		const editedDir = path.join(wsRoot, "edited");
		await symlink(repoDir, path.join(wsRoot, "link"));

		for (const dryRun of [true, false]) {
			// "edited" is a real empty workspace, "ghost" has no directory, and "link" is a symlink to the path.
			await mkdir(editedDir, { recursive: true });
			await writeFile(
				registryFilePath(projectCwd),
				JSON.stringify({ workspaces: ["edited", "ghost", "link"].map((name) => entryAt(name, repoDir)) }),
				"utf8",
			);

			const result = await runWorkspaceGc({ cwd: projectCwd, agentDir, dryRun });

			expect({
				removed: paths(result.removed),
				repoFile: fs.existsSync(path.join(repoDir, "README.md")),
				editedDir: fs.existsSync(editedDir),
			}).toEqual({ removed: [editedDir], repoFile: true, editedDir: dryRun });
		}
		expect(await readRegistry(projectCwd)).toEqual([]);
	});

	it("refuses to remove a workspace that became a symlink while it was under review", async () => {
		// A plain directory and a linked git worktree, both REVIEW, each swapped for a link before "Remove anyway".
		const plain = await createOrTouchWorkspace(projectCwd, { name: "plain" }, agentDir);
		await writeFile(path.join(plain.path, "draft.md"), "draft\n", "utf8");
		const mainRepo = path.join(sandboxRoot, "main-repo");
		initGitRepo(mainRepo);
		commitFile(mainRepo, "main.ts", "console.log('main');\n");
		const worktree = path.join(wsRoot, "worktree");
		git(mainRepo, ["worktree", "add", "-b", "ws-branch", worktree, "HEAD"]);
		await writeFile(path.join(worktree, "untracked.txt"), "dirty\n", "utf8");

		const userWorktree = path.join(outsideDir, "wt");
		git(mainRepo, ["worktree", "add", "-b", "user-branch", userWorktree, "HEAD"]);
		const userFile = path.join(userWorktree, "wip.txt");
		await writeFile(userFile, "work in progress\n", "utf8");

		for (const swapped of [plain.path, worktree]) {
			await expect(
				runWorkspaceGc({
					cwd: projectCwd,
					agentDir,
					confirmReview: async (report) => {
						if (report.entry.path !== swapped) return "skip";
						await rm(swapped, { recursive: true, force: true });
						await symlink(userWorktree, swapped);
						return "remove";
					},
				}),
			).rejects.toThrow(/Refusing to remove/);
			expect(fs.existsSync(userFile)).toBe(true);
			expect(fs.lstatSync(swapped).isSymbolicLink()).toBe(true);
		}
		expect(git(mainRepo, ["worktree", "list"])).toContain("user-branch");
	});

	it("still removes real SAFE workspace directories next to a symlinked entry", async () => {
		const emptyWs = await createOrTouchWorkspace(projectCwd, { name: "real-empty" }, agentDir);
		const cloneWs = await createOrTouchWorkspace(projectCwd, { name: "real-clone" }, agentDir);
		cloneCleanRepo(cloneWs.path);
		await symlink(outsideDir, path.join(wsRoot, "link"));

		const dry = await runWorkspaceGc({ cwd: projectCwd, agentDir, dryRun: true });
		expect(paths(dry.removed)).toEqual([cloneWs.path, emptyWs.path]);
		expect(fs.existsSync(emptyWs.path)).toBe(true);
		expect(fs.existsSync(path.join(cloneWs.path, "README.md"))).toBe(true);

		const real = await runWorkspaceGc({ cwd: projectCwd, agentDir });
		expect(paths(real.removed)).toEqual([cloneWs.path, emptyWs.path]);
		expect(fs.existsSync(emptyWs.path)).toBe(false);
		expect(fs.existsSync(cloneWs.path)).toBe(false);
		expect(fs.existsSync(outsideDir)).toBe(true);
		expect(await readRegistry(projectCwd)).toEqual([]);
	});
});
