import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { runWorkspaceGc } from "../gc.ts";
import workspaceExtension, {
	CHILD_SESSION_HOOKS,
	SESSION_LINK_TYPE,
	WORKSPACE_SHARED_KEY,
	type ChildSessionHook,
} from "../index.ts";
import {
	allowProjectPath,
	denyProjectPath,
	ensureWorkspacesClosure,
	evaluatePathAccess,
	extractBashExternalWriteTargets,
	isSubpath,
	readProjectPolicy,
	resolveCanonicalPath,
	workspacesDir,
} from "../policy.ts";
import {
	createOrTouchWorkspace,
	inspectWorkspaceSafety,
	markSessionWorkspacesClosed,
	pruneProjectsIndex,
	readProjectsIndex,
	readRegistry,
	registerProjectInIndex,
	releaseWorkspace,
	setWorkspacePin,
	syncWorkspaces,
} from "../registry.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

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

function commitFile(dir: string, relPath: string, content: string, message = `commit ${relPath}`): void {
	const full = path.join(dir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
	git(dir, ["add", relPath]);
	git(dir, ["commit", "-m", message]);
}

let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-test-"));
	projectCwd = path.join(sandboxRoot, "project");
	outsideDir = path.join(sandboxRoot, "outside");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(outsideDir, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	await rm(sandboxRoot, { recursive: true, force: true });
});

describe("policy.ts — path canonicalization, access policy, and bash extraction", () => {
	it("creates <cwd>/.pi/workspaces/.gitignore with '*' without touching <cwd>/.gitignore", async () => {
		const wsDir = await ensureWorkspacesClosure(projectCwd);
		expect(wsDir).toBe(workspacesDir(projectCwd));
		const gitignore = await readFile(path.join(wsDir, ".gitignore"), "utf8");
		expect(gitignore).toBe("*\n");
		expect(fs.existsSync(path.join(projectCwd, ".gitignore"))).toBe(false);
	});

	it("expands ~ and $HOME and resolves symlinks (including broken symlinks) escaping <cwd>", async () => {
		expect(resolveCanonicalPath("~/some-test-dir")).toBe(
			path.join(resolveCanonicalPath(os.homedir()), "some-test-dir"),
		);
		expect(resolveCanonicalPath("$HOME/some-test-dir")).toBe(
			path.join(resolveCanonicalPath(os.homedir()), "some-test-dir"),
		);

		const symlinkPath = path.join(projectCwd, "escape-link");
		await symlink(outsideDir, symlinkPath);
		const resolvedViaSymlink = resolveCanonicalPath(path.join(symlinkPath, "nested", "file.txt"), projectCwd);
		expect(resolvedViaSymlink).toBe(path.join(resolveCanonicalPath(outsideDir), "nested", "file.txt"));
		expect(isSubpath(projectCwd, resolvedViaSymlink)).toBe(false);

		const brokenSymlink = path.join(projectCwd, "broken-escape");
		await symlink(path.join(outsideDir, "non-existent-target"), brokenSymlink);
		const resolvedBroken = resolveCanonicalPath(path.join(brokenSymlink, "file.txt"), projectCwd);
		expect(resolvedBroken).toBe(
			path.join(resolveCanonicalPath(outsideDir), "non-existent-target", "file.txt"),
		);
		expect(isSubpath(projectCwd, resolvedBroken)).toBe(false);
	});

	it("evaluates path access for <cwd>, .pi/workspaces, /tmp, symlinks, and allowed paths", async () => {
		expect(evaluatePathAccess({ targetPath: "src/index.ts", cwd: projectCwd }).allowed).toBe(true);
		expect(
			evaluatePathAccess({ targetPath: ".pi/workspaces/exp1/repo/file.ts", cwd: projectCwd }).allowed,
		).toBe(true);
		expect(evaluatePathAccess({ targetPath: "/tmp/ephemeral-artifact.json", cwd: projectCwd }).allowed).toBe(
			true,
		);

		const deniedSibling = evaluatePathAccess({
			targetPath: path.join(outsideDir, "secret.txt"),
			cwd: projectCwd,
		});
		expect(deniedSibling.allowed).toBe(false);
		expect(deniedSibling.reason).toContain("outside the project working directory");

		const deniedHome = evaluatePathAccess({
			targetPath: "~/projects/leaked-clone",
			cwd: projectCwd,
		});
		expect(deniedHome.allowed).toBe(false);

		const symlinkPath = path.join(projectCwd, "link-out");
		await symlink(outsideDir, symlinkPath);
		expect(
			evaluatePathAccess({
				targetPath: path.join(symlinkPath, "escape.txt"),
				cwd: projectCwd,
			}).allowed,
		).toBe(false);

		// Allow project path persists to policy.json and grants access
		const canonicalOutside = await allowProjectPath(projectCwd, outsideDir);
		const policy = await readProjectPolicy(projectCwd);
		expect(policy.allowedPaths).toContain(canonicalOutside);
		expect(
			evaluatePathAccess({
				targetPath: path.join(outsideDir, "secret.txt"),
				cwd: projectCwd,
				projectAllowed: policy.allowedPaths,
			}).allowed,
		).toBe(true);

		// Deny project path revokes access
		await denyProjectPath(projectCwd, outsideDir);
		const updatedPolicy = await readProjectPolicy(projectCwd);
		expect(updatedPolicy.allowedPaths).not.toContain(canonicalOutside);
	});

	it("extracts external write targets from bash commands while permitting internal and /tmp writes", () => {
		expect(extractBashExternalWriteTargets("mkdir -p ~/projects/new-repo", projectCwd)).toEqual([
			resolveCanonicalPath("~/projects/new-repo", projectCwd),
		]);

		expect(
			extractBashExternalWriteTargets(
				`git clone https://github.com/example/repo.git ${outsideDir}/repo`,
				projectCwd,
			),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "repo")]);

		expect(
			extractBashExternalWriteTargets("git worktree add ../wt-leak HEAD", projectCwd),
		).toEqual([path.join(resolveCanonicalPath(sandboxRoot), "wt-leak")]);

		expect(
			extractBashExternalWriteTargets(`cd ${outsideDir} && touch created.txt`, projectCwd),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "created.txt")]);

		expect(
			extractBashExternalWriteTargets(`echo "hello" > ${outsideDir}/out.log`, projectCwd),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "out.log")]);

		// dd, tar, unzip, and npm/pnpm/yarn explicit target options are inspected without a preceding cd
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		for (const [command, target] of [
			[`dd if=/dev/zero of=${outsideDir}/disk.img`, path.join(canonicalOutside, "disk.img")],
			[`tar -xzf archive.tgz -C ${outsideDir}`, canonicalOutside],
			[`tar xf archive.tar --directory=${outsideDir}`, canonicalOutside],
			[`tar -czf ${outsideDir}/out.tgz src`, path.join(canonicalOutside, "out.tgz")],
			[`tar cf ${outsideDir}/out.tar src`, path.join(canonicalOutside, "out.tar")],
			[`unzip archive.zip -d ${outsideDir}`, canonicalOutside],
			[`npm install --prefix ${outsideDir}`, canonicalOutside],
			[`pnpm -C ${outsideDir} install`, canonicalOutside],
			[`yarn --cwd ${outsideDir} add left-pad`, canonicalOutside],
		]) {
			expect(extractBashExternalWriteTargets(command, projectCwd), command).toEqual([target]);
		}
		// Reading an external archive or packing an external directory into the project is not a write outside
		expect(extractBashExternalWriteTargets(`tar -xzf ${outsideDir}/in.tgz`, projectCwd)).toEqual([]);
		expect(extractBashExternalWriteTargets(`tar -cf out.tar -C ${outsideDir} .`, projectCwd)).toEqual([]);
		expect(extractBashExternalWriteTargets("dd if=/dev/zero of=/dev/null count=1", projectCwd)).toEqual([]);

		// Internal and /tmp writes produce no external targets
		expect(
			extractBashExternalWriteTargets(
				"mkdir -p .pi/workspaces/exp1 && git clone https://github.com/example/repo.git .pi/workspaces/exp1/repo",
				projectCwd,
			),
		).toEqual([]);
		expect(extractBashExternalWriteTargets("echo 'temp' > /tmp/pi-temp-test.txt", projectCwd)).toEqual([]);
		expect(extractBashExternalWriteTargets(`ls -la ${outsideDir} && git -C ${outsideDir} status`, projectCwd)).toEqual([]);
	});

	it("treats ssh remote commands and heredoc bodies as data unless a local shell reads them", () => {
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		// Remote commands, remote heredoc scripts, script files written for later remote runs, and
		// quoted or escaped `>` are not local writes.
		for (const command of [
			`ssh host "mkdir -p ${outsideDir}/x"`,
			`ssh host echo hi \\> ${outsideDir}/motd`,
			`echo ">" ${outsideDir}/x "a>${outsideDir}/y"`,
			`ssh host <<'EOF'\nmkdir -p ${outsideDir}/x\ncd ${outsideDir}\ntouch built\nEOF`,
			`ssh -p 2222 user@host bash -s <<EOF\nrm -rf ${outsideDir}/old\nEOF`,
			`cat <<'EOF' | ssh host bash\necho done >> ${outsideDir}/log\nEOF`,
			`cat > lab.sh <<'EOS'\npython3 ~/n3/summary.py "$tag" >> ${outsideDir}/results.txt\nEOS\nscp lab.sh host:`,
			`python3 - <<-PY\n\topen("${outsideDir}/x", "w") > 0\n\tPY`,
			`ssh host bash <<< "touch ${outsideDir}/x"`,
		]) {
			expect(extractBashExternalWriteTargets(command, projectCwd), command).toEqual([]);
		}

		// Local writes around heredocs, local shells reading heredocs, and lines after arithmetic `<<` are still inspected.
		for (const [command, target] of [
			[`ssh host 'cat /etc/hosts' > ${outsideDir}/hosts`, path.join(canonicalOutside, "hosts")],
			[`cat > ${outsideDir}/conf <<EOF\nkey=1\nEOF`, path.join(canonicalOutside, "conf")],
			[`ssh host <<EOF\nls\nEOF\ntouch ${outsideDir}/after`, path.join(canonicalOutside, "after")],
			[`bash <<'EOF'\nmkdir -p ${outsideDir}/x\nEOF`, path.join(canonicalOutside, "x")],
			[`cat <<EOF | sudo sh\ntouch ${outsideDir}/y\nEOF`, path.join(canonicalOutside, "y")],
			[`echo $((1 << 2))\ntouch ${outsideDir}/z`, path.join(canonicalOutside, "z")],
			[`bash <<< "touch ${outsideDir}/s"`, path.join(canonicalOutside, "s")],
			[`cat <<EOF\n$(touch ${outsideDir}/e)\nEOF`, path.join(canonicalOutside, "e")],
		]) {
			expect(extractBashExternalWriteTargets(command, projectCwd), command).toEqual([target]);
		}
	});

	it("inspects compound commands, subshell cd scope, and redirect operators through the bash AST", () => {
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		for (const [command, expected] of [
			[`for a in x y; do touch ${outsideDir}/$a; done`, [path.join(canonicalOutside, "$a")]],
			[`if true; then mkdir ${outsideDir}/d; fi`, [path.join(canonicalOutside, "d")]],
			[`cd ${outsideDir}; for a in arm x86; do nohup make > build-$a.log 2>&1 < /dev/null & done`, [path.join(canonicalOutside, "build-$a.log")]],
			[`(cd ${outsideDir}; touch a); touch b`, [path.join(canonicalOutside, "a")]],
			[`{ cd ${outsideDir}; } > log; touch c`, [path.join(canonicalOutside, "c")]],
			[`echo hi >| ${outsideDir}/f; make &> ${outsideDir}/g; make >${outsideDir}/h 2>&1`, ["f", "g", "h"].map((name) => path.join(canonicalOutside, name))],
			// Descriptor duplication, bash pseudo-devices, and redirections inside quoted substitutions.
			["make 2>&1 >&2 >&- > /dev/stderr", []],
			["for p in 1 2; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo open; done", []],
			['n=$(for d in a b; do [ -n "$(git -C $d status 2>/dev/null)" ] && echo y; done | wc -l)', []],
		] as const) {
			expect(extractBashExternalWriteTargets(command, projectCwd), command).toEqual(expected);
		}
	});
});

describe("registry.ts & gc.ts — workspace lifecycle, safety classification, and garbage collection", () => {
	it("tracks workspaces, classifies PINNED / ACTIVE / SAFE / REVIEW accurately, and runs GC", async () => {
		// 1. Empty workspace -> SAFE
		const emptyEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "empty-ws", purpose: "empty scratch" },
			agentDir,
		);
		const emptyReport = await inspectWorkspaceSafety(emptyEntry);
		expect(emptyReport.status).toBe("SAFE");
		expect(emptyReport.reasons).toEqual(["empty workspace directory"]);

		// 2. Pinned workspace -> PINNED
		const pinnedEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "pinned-ws", pinned: true },
			agentDir,
		);
		await writeFile(path.join(pinnedEntry.path, "important.txt"), "keep me", "utf8");
		const pinnedReport = await inspectWorkspaceSafety(pinnedEntry);
		expect(pinnedReport.status).toBe("PINNED");
		expect(pinnedReport.reasons).toEqual(["pinned"]);

		// 3. Active workspace by sessionId, PID, and TTL -> ACTIVE
		const activeSessionEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "active-session-ws", sessionId: "sess-live" },
			agentDir,
		);
		expect(
			(await inspectWorkspaceSafety(activeSessionEntry, { activeSessionIds: new Set(["sess-live"]) })).status,
		).toBe("ACTIVE");

		const activePidEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "active-pid-ws", pid: process.pid },
			agentDir,
		);
		const pidReport = await inspectWorkspaceSafety(activePidEntry);
		expect(pidReport.status).toBe("ACTIVE");
		expect(pidReport.reasons[0]).toContain(`owning process (pid ${process.pid}) is still running`);

		const ttlEntry = await createOrTouchWorkspace(
			projectCwd,
			{ name: "ttl-ws", ttlMs: 3600_000, now: new Date(1000) },
			agentDir,
		);
		const ttlReport = await inspectWorkspaceSafety(ttlEntry, { now: 2000 });
		expect(ttlReport.status).toBe("ACTIVE");
		expect(ttlReport.reasons).toEqual(["within retention TTL"]);

		// Releasing an active workspace makes it eligible for content inspection
		const released = await releaseWorkspace(projectCwd, "active-pid-ws", undefined, agentDir);
		expect(released?.releasedAt).toBeDefined();
		expect((await inspectWorkspaceSafety(released!)).status).toBe("SAFE");

		// 4. Non-git files -> REVIEW
		const nonGitEntry = await createOrTouchWorkspace(projectCwd, { name: "non-git-ws" }, agentDir);
		await writeFile(path.join(nonGitEntry.path, "notes.md"), "# draft\n", "utf8");
		const nonGitReport = await inspectWorkspaceSafety(nonGitEntry);
		expect(nonGitReport.status).toBe("REVIEW");
		expect(nonGitReport.reasons).toContain("contains non-git files");

		// 5. Local git repo with no remote -> REVIEW
		const localGitEntry = await createOrTouchWorkspace(projectCwd, { name: "local-git-ws" }, agentDir);
		initGitRepo(localGitEntry.path);
		commitFile(localGitEntry.path, "README.md", "local only\n");
		const localGitReport = await inspectWorkspaceSafety(localGitEntry);
		expect(localGitReport.status).toBe("REVIEW");
		expect(localGitReport.reasons).toContain("local git repository with no remote");

		// 6. Remote clone with all commits pushed -> SAFE, then dirty/stash/unpushed -> REVIEW
		const bareRemote = path.join(sandboxRoot, "remote-origin.git");
		git(sandboxRoot, ["init", "--bare", bareRemote]);
		const seedRepo = path.join(sandboxRoot, "seed-repo");
		initGitRepo(seedRepo);
		commitFile(seedRepo, "README.md", "seeded remote\n");
		git(seedRepo, ["remote", "add", "origin", bareRemote]);
		git(seedRepo, ["push", "-u", "origin", "HEAD"]);

		const cloneEntry = await createOrTouchWorkspace(projectCwd, { name: "clean-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, path.join(cloneEntry.path, "repo")]);

		const cleanCloneReport = await inspectWorkspaceSafety(cloneEntry);
		expect(cleanCloneReport.status).toBe("SAFE");
		expect(cleanCloneReport.reasons).toEqual(["clean git workspace with all commits backed up"]);

		// Dirty clone -> REVIEW
		const dirtyCloneEntry = await createOrTouchWorkspace(projectCwd, { name: "dirty-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, dirtyCloneEntry.path]);
		await writeFile(path.join(dirtyCloneEntry.path, "untracked.txt"), "dirty\n", "utf8");
		const dirtyCloneReport = await inspectWorkspaceSafety(dirtyCloneEntry);
		expect(dirtyCloneReport.status).toBe("REVIEW");
		expect(dirtyCloneReport.reasons).toContain("uncommitted or untracked changes");

		// Unpushed commit -> REVIEW
		const unpushedEntry = await createOrTouchWorkspace(projectCwd, { name: "unpushed-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, unpushedEntry.path]);
		git(unpushedEntry.path, ["config", "user.email", "test@example.com"]);
		git(unpushedEntry.path, ["config", "user.name", "Test User"]);
		commitFile(unpushedEntry.path, "new-feature.ts", "export const x = 1;\n");
		const unpushedReport = await inspectWorkspaceSafety(unpushedEntry);
		expect(unpushedReport.status).toBe("REVIEW");
		expect(unpushedReport.reasons).toContain("unpushed local commits");

		// Stash present -> REVIEW
		const stashEntry = await createOrTouchWorkspace(projectCwd, { name: "stash-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, stashEntry.path]);
		git(stashEntry.path, ["config", "user.email", "test@example.com"]);
		git(stashEntry.path, ["config", "user.name", "Test User"]);
		await writeFile(path.join(stashEntry.path, "README.md"), "modified for stash\n", "utf8");
		git(stashEntry.path, ["stash", "push", "-m", "wip"]);
		const stashReport = await inspectWorkspaceSafety(stashEntry);
		expect(stashReport.status).toBe("REVIEW");
		expect(stashReport.reasons).toContain("git stash entries present");

		// 7. Linked git worktrees: clean worktree -> SAFE, unmerged commit -> REVIEW
		initGitRepo(projectCwd);
		commitFile(projectCwd, "main.ts", "console.log('main');\n");

		const cleanWtPath = path.join(workspacesDir(projectCwd), "clean-wt");
		git(projectCwd, ["worktree", "add", "-b", "clean-wt-branch", cleanWtPath, "HEAD"]);
		const syncedAfterWt = await syncWorkspaces(projectCwd, undefined, agentDir);
		const cleanWtEntry = syncedAfterWt.find((e) => e.name === "clean-wt")!;
		expect(cleanWtEntry).toBeDefined();
		const cleanWtReport = await inspectWorkspaceSafety(cleanWtEntry);
		expect(cleanWtReport.isWorktree).toBe(true);
		expect(cleanWtReport.worktreeMainRepo).toBe(resolveCanonicalPath(projectCwd));
		expect(cleanWtReport.status).toBe("SAFE");

		const unmergedWtPath = path.join(workspacesDir(projectCwd), "unmerged-wt");
		git(projectCwd, ["worktree", "add", "-b", "unmerged-wt-branch", unmergedWtPath, "HEAD"]);
		git(unmergedWtPath, ["config", "user.email", "test@example.com"]);
		git(unmergedWtPath, ["config", "user.name", "Test User"]);
		commitFile(unmergedWtPath, "wt-only.ts", "export const wt = true;\n");
		const unmergedWtEntry = (await syncWorkspaces(projectCwd, undefined, agentDir)).find(
			(e) => e.name === "unmerged-wt",
		)!;
		const unmergedWtReport = await inspectWorkspaceSafety(unmergedWtEntry);
		expect(unmergedWtReport.status).toBe("REVIEW");
		expect(unmergedWtReport.reasons).toContain("unmerged or unpushed commits in worktree");

		// 8. Run GC dry-run first -> nothing deleted on disk
		const dryGc = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
			dryRun: true,
			activeSessionIds: new Set(["sess-live"]),
			now: 2000,
		});
		expect(dryGc.dryRun).toBe(true);
		expect(dryGc.removed.map((r) => r.entry.name).sort()).toEqual(
			["active-pid-ws", "clean-clone-ws", "clean-wt", "empty-ws"].sort(),
		);
		expect(fs.existsSync(emptyEntry.path)).toBe(true);
		expect(fs.existsSync(cleanWtPath)).toBe(true);

		// 9. Run real GC with confirmReview callback that pins "non-git-ws", removes "dirty-clone-ws", and skips others
		const realGc = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
			activeSessionIds: new Set(["sess-live"]),
			now: 2000,
			confirmReview: async (report) => {
				if (report.entry.name === "non-git-ws") return "pin";
				if (report.entry.name === "dirty-clone-ws") return "remove";
				return "skip";
			},
		});

		expect(realGc.removed.map((r) => r.entry.name).sort()).toEqual(
			["active-pid-ws", "clean-clone-ws", "clean-wt", "dirty-clone-ws", "empty-ws"].sort(),
		);
		expect(realGc.pinned.map((r) => r.entry.name)).toEqual(["non-git-ws"]);
		expect(fs.existsSync(emptyEntry.path)).toBe(false);
		expect(fs.existsSync(cleanWtPath)).toBe(false);
		expect(fs.existsSync(dirtyCloneEntry.path)).toBe(false);
		expect(fs.existsSync(nonGitEntry.path)).toBe(true);
		// Verify git worktree metadata was cleanly removed from main repo
		expect(git(projectCwd, ["worktree", "list"])).not.toContain("clean-wt");
	});

	it("prunes missing project closures from <agentDir>/workspaces-index.json", async () => {
		const ephemeralProject = path.join(sandboxRoot, "ephemeral-project");
		await createOrTouchWorkspace(ephemeralProject, { name: "temp-ws" }, agentDir);
		await createOrTouchWorkspace(projectCwd, { name: "keep-ws" }, agentDir);

		const beforeIndex = await readProjectsIndex(agentDir);
		expect(beforeIndex).toContain(resolveCanonicalPath(ephemeralProject));
		expect(beforeIndex).toContain(resolveCanonicalPath(projectCwd));

		await rm(ephemeralProject, { recursive: true, force: true });
		const pruned = await pruneProjectsIndex(agentDir);
		expect(pruned.removed).toEqual([resolveCanonicalPath(ephemeralProject)]);
		expect(pruned.kept).toEqual([resolveCanonicalPath(projectCwd)]);

		// Also verify markSessionWorkspacesClosed and setWorkspacePin
		await createOrTouchWorkspace(projectCwd, { name: "sess-ws", sessionId: "s-close" }, agentDir);
		await markSessionWorkspacesClosed(projectCwd, "s-close", new Date(5000), agentDir);
		const reg = await readRegistry(projectCwd);
		expect(reg.find((e) => e.name === "sess-ws")?.closedAt).toBe(new Date(5000).toISOString());

		const pinned = await setWorkspacePin(projectCwd, "keep-ws", true, agentDir);
		expect(pinned?.pinned).toBe(true);
		await registerProjectInIndex(projectCwd, agentDir);

		// Rejects invalid workspace names
		await expect(createOrTouchWorkspace(projectCwd, { name: "../escape" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(createOrTouchWorkspace(projectCwd, { name: "nested/name" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(createOrTouchWorkspace(projectCwd, { name: ".hidden" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);

		// Detects non-git files outside a nested git root at depth 1
		const mixedWs = await createOrTouchWorkspace(projectCwd, { name: "mixed-ws" }, agentDir);
		const bareOrigin = path.join(sandboxRoot, "mixed-origin.git");
		git(sandboxRoot, ["init", "--bare", bareOrigin]);
		const seed = path.join(sandboxRoot, "mixed-seed");
		initGitRepo(seed);
		commitFile(seed, "index.ts", "export default 1;\n");
		git(seed, ["remote", "add", "origin", bareOrigin]);
		git(seed, ["push", "-u", "origin", "HEAD"]);
		git(projectCwd, ["clone", bareOrigin, path.join(mixedWs.path, "repo")]);
		await writeFile(path.join(mixedWs.path, "stray.txt"), "outside git repo\n", "utf8");
		const mixedReport = await inspectWorkspaceSafety(mixedWs);
		expect(mixedReport.status).toBe("REVIEW");
		expect(mixedReport.reasons).toContain("contains files outside git repositories");
	});
});

describe("index.ts — Pi session integration, tool_call enforcement, child propagation, tool & /workspace command", () => {
	function createRecordingUi(selectHandler?: (title: string, options: string[]) => Promise<string | undefined>) {
		const notes: { message: string; type?: string }[] = [];
		const prompts: { title: string; options: string[] }[] = [];
		const noop = () => {};
		const context = {
			select: async (title: string, options: string[]) => {
				prompts.push({ title, options });
				return selectHandler ? selectHandler(title, options) : undefined;
			},
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			onTerminalInput: () => noop,
			setWorkingMessage: noop,
			setWorkingVisible: noop,
			setWorkingIndicator: noop,
			setHiddenThinkingLabel: noop,
			setWidget: noop,
			setFooter: noop,
			setHeader: noop,
			setTitle: noop,
			pasteToEditor: noop,
			setEditorText: noop,
			getEditorText: () => "",
			addAutocompleteProvider: noop,
			setEditorComponent: noop,
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded: noop,
			notify: (message: string, type?: string) => {
				notes.push({ message, type });
			},
			setStatus: noop,
		} as unknown as ExtensionUIContext;
		return { notes, prompts, context };
	}

	async function startPiSession(options?: {
		cwd?: string;
		mode?: "tui" | "rpc" | "print" | "json";
		bindAsChild?: boolean;
		sessionManager?: SessionManager;
		selectHandler?: (title: string, opts: string[]) => Promise<string | undefined>;
		extraFactories?: ((pi: any) => void)[];
	}) {
		const sessionCwd = options?.cwd ?? projectCwd;
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			api: "workspace-test-api",
			provider: "workspace-test",
			models: [{ id: "test" }],
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false, keepRecentTokens: 1 },
		});
		const ui = createRecordingUi(options?.selectHandler);
		const capturedSystems: string[] = [];

		faux.setResponses([
			({ messages }) => {
				capturedSystems.push(getCurrentSystemPrompt(messages));
				return fauxAssistantMessage("ok");
			},
		]);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [extensionPath],
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.provider);
						},
						...(options?.extraFactories ?? []),
					],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel("test"),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionCwd,
			agentDir,
			sessionManager: options?.sessionManager ?? SessionManager.create(sessionCwd, sessionDir),
		});

		const errors: unknown[] = [];
		const bind = () =>
			runtime.session.bindExtensions(
				options?.bindAsChild
					? {}
					: {
							mode: options?.mode ?? "rpc",
							uiContext: ui.context,
							onError: (err) => {
								errors.push(err);
							},
							commandContextActions: {
								waitForIdle: () => runtime.session.waitForIdle(),
								newSession: (o) => runtime.newSession(o),
								fork: (id, o) => runtime.fork(id, o),
								navigateTree: (id, o) => runtime.session.navigateTree(id, o),
								switchSession: (p, o) => runtime.switchSession(p, o),
								reload: () => runtime.session.reload(),
							},
						},
			);
		runtime.setRebindSession(bind);
		await bind();

		return {
			runtime,
			session: runtime.session,
			faux,
			ui,
			errors,
			capturedSystems,
			toolResultTexts: () =>
				runtime.session.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "toolResult"
							? [
									{
										isError: Boolean((entry.message as { isError?: boolean }).isError),
										text: (
											(entry.message as { content?: { text?: string }[] }).content ?? []
										)
											.map((part) => part.text ?? "")
											.join(""),
									},
								]
							: [],
					),
			dispose: () => runtime.dispose(),
		};
	}

	it("AC-1 initializes .pi/workspaces/.gitignore, injects the workspace system prompt section, and manages child-session hooks across sessions", async () => {
		const h1 = await startPiSession({ mode: "rpc" });
		const h2 = await startPiSession({ mode: "tui" });
		try {
			// .pi/workspaces/.gitignore exists with * and <cwd>/.gitignore is untouched
			const gitignore = await readFile(path.join(workspacesDir(projectCwd), ".gitignore"), "utf8");
			expect(gitignore).toBe("*\n");
			expect(fs.existsSync(path.join(projectCwd, ".gitignore"))).toBe(false);

			// Child session hook is registered (and deduplicated) while sessions are open
			const hooks = [
				...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
			].filter((hook) => hook.name === "workspace");
			expect(hooks).toHaveLength(1);
			expect(typeof hooks[0]!.extensionFactory).toBe("function");

			await h1.session.prompt("hello rpc");
			await h2.session.prompt("hello tui");
			for (const sys of [h1.capturedSystems[0], h2.capturedSystems[0]]) {
				expect(sys).toContain("<workspace>");
				expect(sys).toContain(`${projectCwd}/.pi/workspaces/<name>`);
				expect(sys).toContain("/tmp");
			}
			expect(h1.errors).toEqual([]);
			expect(h2.errors).toEqual([]);

			// Touch a workspace owned by h1, then shut down h1 while h2 remains active
			await createOrTouchWorkspace(
				projectCwd,
				{ name: "s1-ws", sessionId: h1.session.sessionId },
				agentDir,
			);
			await h1.dispose();

			// Hook stays registered because h2 is still open, and s1-ws is marked closed
			const hooksAfterFirstClose = [
				...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
			];
			expect(hooksAfterFirstClose.some((hook) => hook.name === "workspace")).toBe(true);
			const regAfterFirstClose = await readRegistry(projectCwd);
			expect(regAfterFirstClose.find((e) => e.name === "s1-ws")?.closedAt).toBeDefined();
		} finally {
			await h1.dispose().catch(() => {});
			await h2.dispose().catch(() => {});
		}

		// Hook is removed when the last session shuts down
		const remainingHooks = [
			...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
		];
		expect(remainingHooks.some((hook) => hook.name === "workspace")).toBe(false);
	});

	it("AC-1 & AC-2 allows write, edit, and bash inside <cwd>, <cwd>/.pi/workspaces/<name>, and /tmp without prompting or touching <cwd>/.gitignore", async () => {
		const tmpScratchDir = await mkdtemp(path.join(resolveCanonicalPath("/tmp"), "pi-ws-allowed-tmp-"));
		const h = await startPiSession();
		try {
			// Remove .pi/workspaces/.gitignore before tool calls to verify touching .pi/workspaces/<name> recreates it
			await rm(path.join(workspacesDir(projectCwd), ".gitignore"), { force: true });

			const cwdFile = path.join(projectCwd, "src", "feature.ts");
			const wsFile = path.join(workspacesDir(projectCwd), "side-exp", "notes.txt");
			const wsBashDir = path.join(workspacesDir(projectCwd), "bash-exp");
			const tmpFile = path.join(tmpScratchDir, "ephemeral.txt");

			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: cwdFile, content: "export const v = 1;\n" }),
					fauxToolCall("write", { path: wsFile, content: "workspace draft v1\n" }),
					fauxToolCall("write", { path: tmpFile, content: "tmp draft v1\n" }),
				]),
				fauxAssistantMessage([
					fauxToolCall("edit", {
						path: cwdFile,
						edits: [{ oldText: "v = 1", newText: "v = 2" }],
					}),
					fauxToolCall("edit", {
						path: wsFile,
						edits: [{ oldText: "draft v1", newText: "draft v2" }],
					}),
					fauxToolCall("edit", {
						path: tmpFile,
						edits: [{ oldText: "tmp draft v1", newText: "tmp draft v2" }],
					}),
				]),
				fauxAssistantMessage([
					fauxToolCall("bash", {
						command: `mkdir -p "${wsBashDir}" && echo "bash-ws" > "${wsBashDir}/out.txt" && echo "// bash" >> "${cwdFile}" && echo "tmp-bash" >> "${tmpFile}"`,
					}),
				]),
				fauxAssistantMessage("all internal and tmp tool calls succeeded"),
			]);

			await h.session.prompt("run write, edit, and bash in cwd, .pi/workspaces, and /tmp");

			expect(h.ui.prompts).toEqual([]);
			expect(await readFile(cwdFile, "utf8")).toBe("export const v = 2;\n// bash\n");
			expect(await readFile(wsFile, "utf8")).toBe("workspace draft v2\n");
			expect(await readFile(path.join(wsBashDir, "out.txt"), "utf8")).toBe("bash-ws\n");
			expect(await readFile(tmpFile, "utf8")).toBe("tmp draft v2\ntmp-bash\n");

			// .pi/workspaces/.gitignore was recreated with * and <cwd>/.gitignore was never created
			expect(await readFile(path.join(workspacesDir(projectCwd), ".gitignore"), "utf8")).toBe("*\n");
			expect(fs.existsSync(path.join(projectCwd, ".gitignore"))).toBe(false);

			// Also verify an existing <cwd>/.gitignore is never modified when touching a workspace
			await writeFile(path.join(projectCwd, ".gitignore"), "dist/\n", "utf8");
			await rm(path.join(workspacesDir(projectCwd), ".gitignore"), { force: true });
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", {
						path: path.join(workspacesDir(projectCwd), "side-exp-2", "file.txt"),
						content: "ok\n",
					}),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("touch second workspace");
			expect(await readFile(path.join(workspacesDir(projectCwd), ".gitignore"), "utf8")).toBe("*\n");
			expect(await readFile(path.join(projectCwd, ".gitignore"), "utf8")).toBe("dist/\n");

			const reg = await readRegistry(projectCwd);
			expect(reg.map((e) => e.name).sort()).toEqual(["bash-exp", "side-exp", "side-exp-2"]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
			await rm(tmpScratchDir, { recursive: true, force: true });
		}
	});

	it("AC-2 enforces interactive approval choices (Deny, Allow once, Allow for this session, Allow for this project) and child/non-UI blocking across write, edit, bash, and symlinks", async () => {
		const choicesQueue: string[] = [];
		const parent = await startPiSession({
			selectHandler: async () => choicesQueue.shift() ?? "Deny",
		});

		try {
			const symlinkToOutside = path.join(projectCwd, "escape-symlink");
			await symlink(outsideDir, symlinkToOutside);

			const preExistingExternal = path.join(outsideDir, "existing.txt");
			await writeFile(preExistingExternal, "original line\n", "utf8");

			const homeTarget = `~/projects/pi-workspace-unapproved-${Date.now()}`;
			const resolvedHomeTarget = resolveCanonicalPath(homeTarget, projectCwd);

			// 1. Deny across write (sibling dir), edit (sibling dir), bash (~/projects/...), and symlink inside cwd pointing outside
			choicesQueue.push("Deny", "Deny", "Deny", "Deny");
			const deniedWriteFile = path.join(outsideDir, "denied-write.txt");
			const deniedSymlinkFile = path.join(symlinkToOutside, "denied-symlink.txt");

			parent.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: deniedWriteFile, content: "nope" }),
					fauxToolCall("edit", {
						path: preExistingExternal,
						edits: [{ oldText: "original line", newText: "mutated line" }],
					}),
					fauxToolCall("bash", { command: `mkdir -p "${homeTarget}"` }),
					fauxToolCall("write", { path: deniedSymlinkFile, content: "symlink escape" }),
				]),
				fauxAssistantMessage("all four denied"),
			]);
			await parent.session.prompt("try unapproved external writes");

			expect(parent.ui.prompts).toHaveLength(4);
			for (const prompt of parent.ui.prompts) {
				expect(prompt.options).toEqual([
					"Allow once",
					"Allow for this session",
					"Allow for this project",
					"Deny",
				]);
			}
			expect(fs.existsSync(deniedWriteFile)).toBe(false);
			expect(await readFile(preExistingExternal, "utf8")).toBe("original line\n");
			expect(fs.existsSync(resolvedHomeTarget)).toBe(false);
			expect(fs.existsSync(path.join(outsideDir, "denied-symlink.txt"))).toBe(false);

			const errorTexts = parent.toolResultTexts().filter((r) => r.isError).map((r) => r.text);
			expect(errorTexts.length).toBeGreaterThanOrEqual(4);
			for (const text of errorTexts) {
				expect(text).toContain("Blocked write outside project working directory");
				expect(text).toContain(`${workspacesDir(projectCwd)}/<name>`);
				expect(text).toContain("/tmp");
			}

			// 2. Allow once permits that single tool call, then prompts again on the next call to the same directory
			const onceDir = path.join(sandboxRoot, "once-outside");
			await mkdir(onceDir, { recursive: true });
			const onceFile = path.join(onceDir, "once.txt");
			choicesQueue.push("Allow once", "Deny");

			parent.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: onceFile, content: "allowed once\n" })]),
				fauxAssistantMessage([
					fauxToolCall("edit", {
						path: onceFile,
						edits: [{ oldText: "allowed once", newText: "second edit denied" }],
					}),
				]),
				fauxAssistantMessage("allow once verified"),
			]);
			const promptsBeforeOnce = parent.ui.prompts.length;
			await parent.session.prompt("test allow once");
			expect(parent.ui.prompts.length).toBe(promptsBeforeOnce + 2);
			expect(await readFile(onceFile, "utf8")).toBe("allowed once\n");

			// 3. Allow for this session permits write, edit, bash, and symlink writes for the session AND child sessions without writing policy.json
			choicesQueue.push("Allow for this session");
			const sessionFile = path.join(outsideDir, "session-allowed.txt");
			const sessionBashFile = path.join(outsideDir, "session-bash.txt");
			const sessionSymlinkFile = path.join(symlinkToOutside, "session-via-link.txt");
			const promptsBeforeSessionAllow = parent.ui.prompts.length;

			parent.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: sessionFile, content: "v1\n" })]),
				fauxAssistantMessage([
					fauxToolCall("edit", {
						path: sessionFile,
						edits: [{ oldText: "v1", newText: "v2" }],
					}),
					fauxToolCall("bash", { command: `echo "from bash" > "${sessionBashFile}"` }),
					fauxToolCall("write", { path: sessionSymlinkFile, content: "via symlink\n" }),
				]),
				fauxAssistantMessage("session allow verified"),
			]);
			await parent.session.prompt("write, edit, and bash with session allow");
			// Prompted only once for the first write; subsequent edit, bash, and symlink write in outsideDir did not prompt
			expect(parent.ui.prompts.length).toBe(promptsBeforeSessionAllow + 1);
			expect(await readFile(sessionFile, "utf8")).toBe("v2\n");
			expect(await readFile(sessionBashFile, "utf8")).toBe("from bash\n");
			expect(await readFile(path.join(outsideDir, "session-via-link.txt"), "utf8")).toBe("via symlink\n");
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);

			// 4. Child session via bindAsChild AND child session via pi-extensions.session-link entry (even with UI bound)
			// inherit session allowlist for outsideDir and immediately block unapproved external write/edit/bash without prompting
			const hooks = [
				...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? []),
			];
			const unapprovedChildDir = path.join(sandboxRoot, "unapproved-other");
			await mkdir(unapprovedChildDir, { recursive: true });
			const unapprovedExisting = path.join(unapprovedChildDir, "existing.txt");
			await writeFile(unapprovedExisting, "keep\n", "utf8");

			// 4a. Child session with bindAsChild: true
			const childManager1 = SessionManager.create(projectCwd, sessionDir, {
				parentSession: parent.session.sessionFile,
			});
			const child1 = await startPiSession({
				sessionManager: childManager1,
				bindAsChild: true,
				extraFactories: hooks.map((h) => h.extensionFactory),
			});
			try {
				const childInheritedFile = path.join(outsideDir, "child-inherited.txt");
				const childBlockedWrite = path.join(unapprovedChildDir, "blocked-write.txt");
				const childBlockedBash = path.join(unapprovedChildDir, "blocked-bash.txt");

				child1.faux.setResponses([
					fauxAssistantMessage([
						fauxToolCall("write", { path: childInheritedFile, content: "child ok\n" }),
						fauxToolCall("write", { path: childBlockedWrite, content: "child blocked" }),
						fauxToolCall("edit", {
							path: unapprovedExisting,
							edits: [{ oldText: "keep", newText: "mutated" }],
						}),
						fauxToolCall("bash", { command: `touch "${childBlockedBash}"` }),
					]),
					fauxAssistantMessage("done child 1"),
				]);
				await child1.session.prompt("child 1 test");
				expect(child1.ui.prompts).toEqual([]);
				expect(fs.existsSync(childInheritedFile)).toBe(true);
				expect(fs.existsSync(childBlockedWrite)).toBe(false);
				expect(await readFile(unapprovedExisting, "utf8")).toBe("keep\n");
				expect(fs.existsSync(childBlockedBash)).toBe(false);
				const child1Errors = child1.toolResultTexts().filter((r) => r.isError);
				expect(child1Errors).toHaveLength(3);
				for (const err of child1Errors) {
					expect(err.text).toContain(workspacesDir(projectCwd));
				}
			} finally {
				await child1.dispose();
			}

			// 4b. Child session identified by pi-extensions.session-link entry (even when bound with rpc UI context)
			const childManager2 = SessionManager.create(projectCwd, sessionDir, {
				parentSession: parent.session.sessionFile,
			});
			childManager2.appendCustomEntry(SESSION_LINK_TYPE, {
				kind: "subagent",
				parentSessionId: parent.session.sessionId,
				parentSessionFile: parent.session.sessionFile,
			});
			const child2 = await startPiSession({
				sessionManager: childManager2,
				mode: "rpc",
				selectHandler: async () => "Allow once",
				extraFactories: hooks.map((h) => h.extensionFactory),
			});
			try {
				const linkBlockedFile = path.join(unapprovedChildDir, "link-blocked.txt");
				child2.faux.setResponses([
					fauxAssistantMessage([fauxToolCall("write", { path: linkBlockedFile, content: "should block" })]),
					fauxAssistantMessage("done child 2"),
				]);
				await child2.session.prompt("child 2 session-link test");
				expect(child2.ui.prompts).toEqual([]);
				expect(fs.existsSync(linkBlockedFile)).toBe(false);
				expect(child2.toolResultTexts().find((r) => r.isError)?.text).toContain(workspacesDir(projectCwd));
			} finally {
				await child2.dispose();
			}

			// 5. Allow for this project persists to policy.json and allows writes in a brand-new session without prompting
			const projectAllowedDir = path.join(sandboxRoot, "project-allowed-ext");
			await mkdir(projectAllowedDir, { recursive: true });
			const projectAllowedFile = path.join(projectAllowedDir, "shared.txt");
			choicesQueue.push("Allow for this project");
			const promptsBeforeProjectAllow = parent.ui.prompts.length;

			parent.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: projectAllowedFile, content: "project v1\n" })]),
				fauxAssistantMessage("project allow saved"),
			]);
			await parent.session.prompt("allow for this project");
			expect(parent.ui.prompts.length).toBe(promptsBeforeProjectAllow + 1);
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toContain(
				resolveCanonicalPath(projectAllowedDir),
			);

			const laterSession = await startPiSession();
			try {
				const laterBashFile = path.join(projectAllowedDir, "later-bash.txt");
				laterSession.faux.setResponses([
					fauxAssistantMessage([
						fauxToolCall("edit", {
							path: projectAllowedFile,
							edits: [{ oldText: "project v1", newText: "project v2" }],
						}),
						fauxToolCall("bash", { command: `echo "later" > "${laterBashFile}"` }),
					]),
					fauxAssistantMessage("later session done"),
				]);
				await laterSession.session.prompt("write to project-allowed dir in new session");
				expect(laterSession.ui.prompts).toEqual([]);
				expect(await readFile(projectAllowedFile, "utf8")).toBe("project v2\n");
				expect(await readFile(laterBashFile, "utf8")).toBe("later\n");
			} finally {
				await laterSession.dispose();
			}
		} finally {
			await parent.dispose();
		}
	});

	it("AC-3 & AC-4 supports the workspace tool (create, list, pin, unpin, release) and /workspace commands (list, allow, deny, pin, unpin, gc, gc --dry-run, gc --all, and interactive REVIEW prompts)", async () => {
		const gcChoices: string[] = [];
		const h = await startPiSession({
			selectHandler: async () => gcChoices.shift() ?? "Keep for now",
		});

		try {
			// 1. Use the LLM `workspace` tool to exercise all 5 actions: create, pin, list, unpin, release
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("workspace", {
						action: "create",
						name: "exp-alpha",
						purpose: "benchmarking",
						ttlHours: 1,
					}),
				]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "pin", name: "exp-alpha" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "list" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "unpin", name: "exp-alpha" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "release", name: "exp-alpha" })]),
				fauxAssistantMessage([fauxToolCall("workspace", { action: "list" })]),
				fauxAssistantMessage("workspace tool lifecycle complete"),
			]);
			await h.session.prompt("exercise workspace tool actions");

			const toolOutputs = h.toolResultTexts().map((r) => r.text);
			expect(toolOutputs.some((t) => t.includes('Workspace "exp-alpha" ready'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes('Pinned workspace "exp-alpha"'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes("- exp-alpha [PINNED] (pinned)"))).toBe(true);
			expect(toolOutputs.some((t) => t.includes('Unpinned workspace "exp-alpha"'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes('Released workspace "exp-alpha"'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes("- exp-alpha [SAFE] (empty workspace directory)"))).toBe(true);

			const entries = await readRegistry(projectCwd);
			expect(entries.some((e) => e.name === "exp-alpha" && e.pinned === false && Boolean(e.releasedAt))).toBe(
				true,
			);

			// 2. Create two REVIEW workspaces ("exp-dirty-pin" and "exp-dirty-remove") and a linked git worktree ("exp-wt")
			initGitRepo(projectCwd);
			commitFile(projectCwd, "index.ts", "export const main = true;\n");
			const wtPath = path.join(workspacesDir(projectCwd), "exp-wt");
			git(projectCwd, ["worktree", "add", "-b", "exp-wt-branch", wtPath, "HEAD"]);

			const dirtyPinEntry = await createOrTouchWorkspace(
				projectCwd,
				{ name: "exp-dirty-pin", purpose: "keep via pin" },
				agentDir,
			);
			await writeFile(path.join(dirtyPinEntry.path, "draft.txt"), "unfinished work\n", "utf8");

			const dirtyRemoveEntry = await createOrTouchWorkspace(
				projectCwd,
				{ name: "exp-dirty-remove", purpose: "remove on review" },
				agentDir,
			);
			await writeFile(path.join(dirtyRemoveEntry.path, "scratch.txt"), "throwaway\n", "utf8");

			// 3. Test /workspace list
			await h.session.prompt("/workspace list");
			const listMsg = h.ui.notes.at(-1)?.message ?? "";
			expect(listMsg).toContain("exp-alpha: SAFE");
			expect(listMsg).toContain("exp-wt: SAFE");
			expect(listMsg).toContain("exp-dirty-pin: REVIEW");
			expect(listMsg).toContain("exp-dirty-remove: REVIEW");

			// 4. Test /workspace allow and /workspace deny
			await h.session.prompt(`/workspace allow ${outsideDir}`);
			expect(h.ui.notes.at(-1)?.message).toContain("Allowed external path:");
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toContain(resolveCanonicalPath(outsideDir));

			await h.session.prompt(`/workspace deny ${outsideDir}`);
			expect(h.ui.notes.at(-1)?.message).toContain("Denied external path:");
			expect((await readProjectPolicy(projectCwd)).allowedPaths).not.toContain(resolveCanonicalPath(outsideDir));

			// 5. Test /workspace pin and /workspace unpin
			await h.session.prompt("/workspace pin exp-alpha");
			expect(h.ui.notes.at(-1)?.message).toContain('Pinned workspace "exp-alpha"');
			expect((await readRegistry(projectCwd)).find((e) => e.name === "exp-alpha")?.pinned).toBe(true);

			await h.session.prompt("/workspace unpin exp-alpha");
			expect(h.ui.notes.at(-1)?.message).toContain('Unpinned workspace "exp-alpha"');
			expect((await readRegistry(projectCwd)).find((e) => e.name === "exp-alpha")?.pinned).toBe(false);

			// 6. Test /workspace gc --dry-run
			await h.session.prompt("/workspace gc --dry-run");
			expect(h.ui.notes.at(-1)?.message).toContain("[Dry run] Workspace GC complete");
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-alpha"))).toBe(true);
			expect(fs.existsSync(wtPath)).toBe(true);

			// 7. Test /workspace gc (interactive prompt pins exp-dirty-pin, removes exp-dirty-remove, and removes SAFE exp-alpha + exp-wt)
			gcChoices.push("Pin permanently", "Remove anyway");
			await h.session.prompt("/workspace gc");
			const gcMsg = h.ui.notes.at(-1)?.message ?? "";
			expect(gcMsg).toContain("exp-alpha");
			expect(gcMsg).toContain("exp-wt");
			expect(gcMsg).toContain("exp-dirty-remove");
			expect(gcMsg).toContain("Newly pinned (1): exp-dirty-pin");
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-alpha"))).toBe(false);
			expect(fs.existsSync(wtPath)).toBe(false);
			expect(fs.existsSync(dirtyRemoveEntry.path)).toBe(false);
			expect(fs.existsSync(dirtyPinEntry.path)).toBe(true);
			expect(git(projectCwd, ["worktree", "list"])).not.toContain("exp-wt");

			// 8. Test /workspace gc --all across a second project closure and a deleted project closure
			const otherProject = path.join(sandboxRoot, "other-project");
			const otherSafe = await createOrTouchWorkspace(otherProject, { name: "other-safe" }, agentDir);
			const deletedProject = path.join(sandboxRoot, "deleted-project");
			await createOrTouchWorkspace(deletedProject, { name: "gone-ws" }, agentDir);
			await rm(deletedProject, { recursive: true, force: true });

			await h.session.prompt("/workspace gc --all --yes");
			const gcAllMsg = h.ui.notes.at(-1)?.message ?? "";
			expect(gcAllMsg).toContain("other-safe");
			expect(gcAllMsg).toContain("Pruned missing projects (1)");
			expect(fs.existsSync(otherSafe.path)).toBe(false);

			// 9. Auto-records workspace in .registry.json when write or bash touches .pi/workspaces/<name>/...
			const autoFile = path.join(workspacesDir(projectCwd), "auto-tracked", "hello.txt");
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: autoFile, content: "auto tracked!" })]),
				fauxAssistantMessage("wrote to auto-tracked"),
			]);
			await h.session.prompt("write into .pi/workspaces/auto-tracked");
			expect(fs.existsSync(autoFile)).toBe(true);
			const regAfterAuto = await readRegistry(projectCwd);
			expect(regAfterAuto.some((e) => e.name === "auto-tracked")).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("deduplicates binding to the same pi instance via WeakSet", () => {
		let toolCount = 0;
		let commandCount = 0;
		const fakePi = {
			on: () => () => {},
			registerTool: () => {
				toolCount++;
			},
			registerCommand: () => {
				commandCount++;
			},
		} as any;
		workspaceExtension(fakePi);
		workspaceExtension(fakePi);
		expect(toolCount).toBe(1);
		expect(commandCount).toBe(1);
	});

	it("AC-5 is registered in package.json before pika, wired into npm test, and documented in README.md and AGENTS.md", async () => {
		const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
		const [pkgRaw, wsReadme, rootReadme, agentsMd] = await Promise.all([
			readFile(path.join(repoRoot, "package.json"), "utf8"),
			readFile(path.join(repoRoot, "extensions/workspace/README.md"), "utf8"),
			readFile(path.join(repoRoot, "README.md"), "utf8"),
			readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
		]);

		const manifest = JSON.parse(pkgRaw) as {
			scripts: Record<string, string>;
			pi: { extensions: string[] };
		};
		expect(manifest.scripts["test:workspace"]).toBe("vitest run extensions/workspace");
		expect(manifest.scripts.test).toContain("npm run test:molt && npm run test:language &&");
		expect(manifest.scripts.test).toContain("npm run test:workspace");
		const exts = manifest.pi.extensions;
		expect(exts).toContain("./extensions/workspace/index.ts");
		expect(exts.at(-1)).toBe("./extensions/pika/index.ts");
		expect(exts.indexOf("./extensions/workspace/index.ts")).toBe(exts.indexOf("./extensions/pika/index.ts") - 1);

		for (const expected of [
			".pi/workspaces/<name>",
			".pi/workspaces/.gitignore",
			"/tmp",
			"Allow once",
			"Allow for this session",
			"Allow for this project",
			"Deny",
			"workspace",
			"PINNED",
			"ACTIVE",
			"SAFE",
			"REVIEW",
			"/workspace list",
			"/workspace gc",
			"/workspace allow",
			"/workspace deny",
			"/workspace pin",
			"/workspace unpin",
		]) {
			expect(wsReadme).toContain(expected);
		}

		expect(rootReadme).toContain("[Workspace](extensions/workspace/README.md)");
		expect(agentsMd).toContain("`extensions/workspace/`");
		expect(agentsMd).toContain("`npm run test:workspace`");
	});
});
