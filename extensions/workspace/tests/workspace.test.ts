import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { runWorkspaceGc } from "../gc.ts";
import workspaceExtension, {
	CHILD_SESSION_HOOKS,
	SESSION_LINK_TYPE,
	type ChildSessionHook,
} from "../index.ts";
import {
	agentBrowserExternalPaths,
	agentDesktopExternalPaths,
	bashExternalWritePaths,
	bashWritePaths,
} from "./support/policy-helpers.ts";
import {
	createWorkspaceSandbox,
	startWorkspaceSession,
	type WorkspaceSandbox,
} from "./support/session-harness.ts";
import {
	allowProjectPath,
	denyProjectPath,
	ensureWorkspacesClosure,
	evaluatePathAccess,
	extractAgentBrowserWriteTargets,
	extractAgentDesktopWriteTargets,
	inspectBashCommand,
	isSubpath,
	readProjectPolicy,
	resolveCanonicalPath,
	workspacesDir,
} from "../policy.ts";
import {
	inspectWorkspaceSafety,
	markSessionWorkspacesClosed,
	pruneProjectsIndex,
	readProjectsIndex,
	readRegistry,
	registerProjectInIndex,
	releaseWorkspace,
	setWorkspacePin,
	syncWorkspaces,
	touchWorkspace,
	WORKSPACE_LIMITS,
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

function commitFile(dir: string, relPath: string, content: string, message = `commit ${relPath}`): void {
	const full = path.join(dir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
	git(dir, ["add", relPath]);
	git(dir, ["commit", "-m", message]);
}

let sandbox: WorkspaceSandbox;
let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;

beforeEach(async () => {
	sandbox = await createWorkspaceSandbox("pi-workspace-test-");
	({ sandboxRoot, projectCwd, outsideDir, agentDir, sessionDir } = sandbox);
});

afterEach(async () => {
	await sandbox.cleanup();
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
		expect(bashExternalWritePaths("mkdir -p ~/projects/new-repo", projectCwd)).toEqual([
			resolveCanonicalPath("~/projects/new-repo", projectCwd),
		]);

		expect(
			bashExternalWritePaths(
				`git clone https://github.com/example/repo.git ${outsideDir}/repo`,
				projectCwd,
			),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "repo")]);

		expect(
			bashExternalWritePaths("git worktree add ../wt-leak HEAD", projectCwd),
		).toEqual([path.join(resolveCanonicalPath(sandboxRoot), "wt-leak")]);

		expect(
			bashExternalWritePaths(`cd ${outsideDir} && touch created.txt`, projectCwd),
		).toEqual([path.join(resolveCanonicalPath(outsideDir), "created.txt")]);

		expect(
			bashExternalWritePaths(`echo "hello" > ${outsideDir}/out.log`, projectCwd),
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
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual([target]);
		}
		// Reading an external archive or packing an external directory into the project is not a write outside
		expect(bashExternalWritePaths(`tar -xzf ${outsideDir}/in.tgz`, projectCwd)).toEqual([]);
		expect(bashExternalWritePaths(`tar -cf out.tar -C ${outsideDir} .`, projectCwd)).toEqual([]);
		expect(bashExternalWritePaths("dd if=/dev/zero of=/dev/null count=1", projectCwd)).toEqual([]);

		// Internal and /tmp writes produce no external targets
		expect(
			bashExternalWritePaths(
				"mkdir -p .pi/workspaces/exp1 && git clone https://github.com/example/repo.git .pi/workspaces/exp1/repo",
				projectCwd,
			),
		).toEqual([]);
		expect(bashExternalWritePaths("echo 'temp' > /tmp/pi-temp-test.txt", projectCwd)).toEqual([]);
		expect(bashExternalWritePaths(`ls -la ${outsideDir} && git -C ${outsideDir} status`, projectCwd)).toEqual([]);
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
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual([]);
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
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual([target]);
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
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual(expected);
		}
	});

	it("normalizes explicit command paths and extracts target-directory and -C flags without affecting read-only commands", () => {
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		const canonicalProject = resolveCanonicalPath(projectCwd);

		// Explicit paths for mutating verbs
		for (const [command, expected] of [
			[`/bin/rm -rf ${outsideDir}/old`, [path.join(canonicalOutside, "old")]],
			[`/bin/rmdir ${outsideDir}/empty`, [path.join(canonicalOutside, "empty")]],
			[`/bin/mv local.txt ${outsideDir}/moved.txt`, [path.join(canonicalOutside, "moved.txt")]],
			[`/usr/bin/git clone https://github.com/example/repo.git ${outsideDir}/repo`, [path.join(canonicalOutside, "repo")]],
			[`/usr/bin/git -C${outsideDir} init`, [canonicalOutside]],
			[`/usr/bin/cp local.txt ${outsideDir}/copied.txt`, [path.join(canonicalOutside, "copied.txt")]],
			[`/usr/bin/ln -s local.txt ${outsideDir}/link.txt`, [path.join(canonicalOutside, "link.txt")]],
			[`/usr/bin/install local.txt ${outsideDir}/bin/app`, [path.join(canonicalOutside, "bin", "app")]],
			[`/usr/bin/tee ${outsideDir}/out.log`, [path.join(canonicalOutside, "out.log")]],
			[`/bin/mkdir -p ${outsideDir}/dir`, [path.join(canonicalOutside, "dir")]],
			[`/usr/bin/touch ${outsideDir}/file.txt`, [path.join(canonicalOutside, "file.txt")]],
			[`/bin/dd if=/dev/zero of=${outsideDir}/disk.img`, [path.join(canonicalOutside, "disk.img")]],
			[`/usr/bin/tar -xzf archive.tgz -C${outsideDir}`, [canonicalOutside]],
			[`/usr/bin/unzip archive.zip -d${outsideDir}`, [canonicalOutside]],
			[`/usr/local/bin/cargo init ${outsideDir}/crate`, [path.join(canonicalOutside, "crate")]],
			[`/usr/local/bin/npm install --prefix ${outsideDir}`, [canonicalOutside]],
			[`sudo /bin/rm -rf ${outsideDir}/wrapped`, [path.join(canonicalOutside, "wrapped")]],
			[`env -u FOO /bin/mv -t${outsideDir} local.txt`, [canonicalOutside]],
			[`cd ${outsideDir} && /usr/bin/tar -xzf /tmp/in.tgz`, [canonicalOutside]],
		] as const) {
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual(expected);
		}

		// Explicit deleting verbs keep deletes: true tagging
		expect(inspectBashCommand("/bin/rm -rf .pi/workspaces/temp-ws", projectCwd).writeTargets).toEqual([
			{ path: path.join(canonicalProject, ".pi", "workspaces", "temp-ws"), deletes: true },
		]);
		expect(inspectBashCommand("/bin/rmdir .pi/workspaces/temp-ws", projectCwd).writeTargets).toEqual([
			{ path: path.join(canonicalProject, ".pi", "workspaces", "temp-ws"), deletes: true },
		]);

		// mv target-directory flags (all spellings)
		for (const [command, expected] of [
			[`mv --target-directory=${outsideDir} local.txt`, [canonicalOutside]],
			[`mv --target-directory ${outsideDir} local.txt`, [canonicalOutside]],
			[`mv -t ${outsideDir} local.txt`, [canonicalOutside]],
			[`mv -t${outsideDir} local.txt`, [canonicalOutside]],
			[`mv -ft${outsideDir} local.txt`, [canonicalOutside]],
			[`/bin/mv --target-directory=${outsideDir} local.txt`, [canonicalOutside]],
			[`mv --target-directory=./local ${outsideDir}/src.txt`, [path.join(canonicalOutside, "src.txt")]],
			[`mv -t${outsideDir}/dst ${outsideDir}/src.txt`, [path.join(canonicalOutside, "src.txt"), path.join(canonicalOutside, "dst")]],
			[`mv -t${outsideDir} -- -weird`, [canonicalOutside]],
		] as const) {
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual(expected);
		}
		expect(bashWritePaths("mv --target-directory=.pi/workspaces/ws1 local.txt", projectCwd)).toEqual([
			path.join(canonicalProject, "local.txt"),
			path.join(canonicalProject, ".pi", "workspaces", "ws1"),
		]);

		// cp / ln / install attached -t<dir> and existing forms
		for (const [command, expected] of [
			[`cp -t${outsideDir} local.txt`, [canonicalOutside]],
			[`cp -rt${outsideDir} src`, [canonicalOutside]],
			[`cp -t ${outsideDir} local.txt`, [canonicalOutside]],
			[`cp --target-directory=${outsideDir} local.txt`, [canonicalOutside]],
			[`cp --target-directory ${outsideDir} local.txt`, [canonicalOutside]],
			[`/usr/bin/cp -t${outsideDir} local.txt`, [canonicalOutside]],
			[`ln -s -t${outsideDir} local.txt`, [canonicalOutside]],
			[`ln -sft${outsideDir} local.txt`, [canonicalOutside]],
			[`/usr/bin/ln -s -t${outsideDir} local.txt`, [canonicalOutside]],
			[`install -t${outsideDir} local.txt`, [canonicalOutside]],
			[`install -D -m0755 -t${outsideDir} local.txt`, [canonicalOutside]],
			[`install -oroot -m0755 -t${outsideDir} local.txt`, [canonicalOutside]],
			[`/usr/bin/install -t${outsideDir} local.txt`, [canonicalOutside]],
		] as const) {
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual(expected);
		}

		// git and tar attached -C<dir> and existing forms
		for (const [command, expected] of [
			[`git -C${outsideDir} init`, [canonicalOutside]],
			[`git -C${outsideDir} clone https://github.com/example/repo.git`, [path.join(canonicalOutside, "repo")]],
			[`git -C${outsideDir} worktree add wt HEAD`, [path.join(canonicalOutside, "wt")]],
			[`git -C${outsideDir} -Csub init`, [path.join(canonicalOutside, "sub")]],
			[`tar -xzf archive.tgz -C${outsideDir}`, [canonicalOutside]],
			[`tar -C${outsideDir} -xzf archive.tgz`, [canonicalOutside]],
			[`tar -xC${outsideDir} -f archive.tgz`, [canonicalOutside]],
			[`tar -xzf archive.tgz -C../outside`, [canonicalOutside]],
			[`tar -xzf archive.tgz -C${outsideDir} -Csub`, [canonicalOutside, path.join(canonicalOutside, "sub")]],
			[`tar -czf${outsideDir}/out.tgz src`, [path.join(canonicalOutside, "out.tgz")]],
			[`tar xf archive.tar --directory ${outsideDir}`, [canonicalOutside]],
		] as const) {
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual(expected);
		}

		// Read-only commands and internal bare/flagged commands stay unaffected
		for (const command of [
			`/bin/ls -la ${outsideDir}`,
			`/bin/cat ${outsideDir}/notes.txt`,
			`/usr/bin/git -C${outsideDir} status`,
			`/usr/bin/git -C ${outsideDir} diff`,
			`git -C${outsideDir} log -1`,
			`/usr/bin/tar -xzf ${outsideDir}/in.tgz`,
			`/usr/bin/tar -cf out.tar -C${outsideDir} .`,
			`tar -tzf ${outsideDir}/in.tgz`,
			`cp -a ${outsideDir}/src ./local`,
			`cp -t./local ${outsideDir}/src`,
			`cp -S.txt local.txt ./dest`,
			`install -oroot -m0755 local.txt ./dest`,
			`mv local1.txt local2.txt`,
			`mv -t./local local1.txt`,
		]) {
			expect(bashExternalWritePaths(command, projectCwd), command).toEqual([]);
		}
	});
});

describe("registry.ts & gc.ts — workspace lifecycle, safety classification, and garbage collection", () => {
	it("tracks workspaces, classifies PINNED / ACTIVE / SAFE / REVIEW accurately, and runs GC", async () => {
		// 1. Empty workspace -> SAFE
		const { entry: emptyEntry } = await touchWorkspace(
			projectCwd,
			{ name: "empty-ws", purpose: "empty scratch" },
			agentDir,
		);
		const emptyReport = await inspectWorkspaceSafety(emptyEntry);
		expect(emptyReport.status).toBe("SAFE");
		expect(emptyReport.reasons).toEqual(["empty workspace directory"]);

		// 2. Pinned workspace -> PINNED
		const { entry: pinnedEntry } = await touchWorkspace(
			projectCwd,
			{ name: "pinned-ws", pinned: true },
			agentDir,
		);
		await writeFile(path.join(pinnedEntry.path, "important.txt"), "keep me", "utf8");
		const pinnedReport = await inspectWorkspaceSafety(pinnedEntry);
		expect(pinnedReport.status).toBe("PINNED");
		expect(pinnedReport.reasons).toEqual(["pinned"]);

		// 3. Active workspace by sessionId, PID, and TTL -> ACTIVE
		const { entry: activeSessionEntry } = await touchWorkspace(
			projectCwd,
			{ name: "active-session-ws", sessionId: "sess-live" },
			agentDir,
		);
		expect(
			(await inspectWorkspaceSafety(activeSessionEntry, { activeSessionIds: new Set(["sess-live"]) })).status,
		).toBe("ACTIVE");

		// Another live process (the test runner's parent) owns it.
		const { entry: activePidEntry } = await touchWorkspace(
			projectCwd,
			{ name: "active-pid-ws", pid: process.ppid },
			agentDir,
		);
		const pidReport = await inspectWorkspaceSafety(activePidEntry);
		expect(pidReport.status).toBe("ACTIVE");
		expect(pidReport.reasons[0]).toContain(`owning process (pid ${process.ppid}) is still running`);

		const { entry: ttlEntry } = await touchWorkspace(
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
		const { entry: nonGitEntry } = await touchWorkspace(projectCwd, { name: "non-git-ws" }, agentDir);
		await writeFile(path.join(nonGitEntry.path, "notes.md"), "# draft\n", "utf8");
		const nonGitReport = await inspectWorkspaceSafety(nonGitEntry);
		expect(nonGitReport.status).toBe("REVIEW");
		expect(nonGitReport.reasons).toContain("contains non-git files");

		// 5. Local git repo with no remote -> REVIEW
		const { entry: localGitEntry } = await touchWorkspace(projectCwd, { name: "local-git-ws" }, agentDir);
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

		const { entry: cloneEntry } = await touchWorkspace(projectCwd, { name: "clean-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, path.join(cloneEntry.path, "repo")]);

		const cleanCloneReport = await inspectWorkspaceSafety(cloneEntry);
		expect(cleanCloneReport.status).toBe("SAFE");
		expect(cleanCloneReport.reasons).toEqual(["clean git workspace with all commits backed up"]);

		// Dirty clone -> REVIEW
		const { entry: dirtyCloneEntry } = await touchWorkspace(projectCwd, { name: "dirty-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, dirtyCloneEntry.path]);
		await writeFile(path.join(dirtyCloneEntry.path, "untracked.txt"), "dirty\n", "utf8");
		const dirtyCloneReport = await inspectWorkspaceSafety(dirtyCloneEntry);
		expect(dirtyCloneReport.status).toBe("REVIEW");
		expect(dirtyCloneReport.reasons).toContain("uncommitted or untracked changes");

		// Unpushed commit -> REVIEW
		const { entry: unpushedEntry } = await touchWorkspace(projectCwd, { name: "unpushed-clone-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, unpushedEntry.path]);
		git(unpushedEntry.path, ["config", "user.email", "test@example.com"]);
		git(unpushedEntry.path, ["config", "user.name", "Test User"]);
		commitFile(unpushedEntry.path, "new-feature.ts", "export const x = 1;\n");
		const unpushedReport = await inspectWorkspaceSafety(unpushedEntry);
		expect(unpushedReport.status).toBe("REVIEW");
		expect(unpushedReport.reasons).toContain("unpushed local commits");

		// Stash present -> REVIEW
		const { entry: stashEntry } = await touchWorkspace(projectCwd, { name: "stash-clone-ws" }, agentDir);
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
		await touchWorkspace(ephemeralProject, { name: "temp-ws" }, agentDir);
		await touchWorkspace(projectCwd, { name: "keep-ws" }, agentDir);

		const beforeIndex = await readProjectsIndex(agentDir);
		expect(beforeIndex).toContain(resolveCanonicalPath(ephemeralProject));
		expect(beforeIndex).toContain(resolveCanonicalPath(projectCwd));

		await rm(ephemeralProject, { recursive: true, force: true });
		const pruned = await pruneProjectsIndex(agentDir);
		expect(pruned.removed).toEqual([resolveCanonicalPath(ephemeralProject)]);
		expect(pruned.kept).toEqual([resolveCanonicalPath(projectCwd)]);

		// Also verify markSessionWorkspacesClosed and setWorkspacePin
		await touchWorkspace(projectCwd, { name: "sess-ws", sessionId: "s-close" }, agentDir);
		await markSessionWorkspacesClosed(projectCwd, "s-close", new Date(5000), agentDir);
		const reg = await readRegistry(projectCwd);
		expect(reg.find((e) => e.name === "sess-ws")?.closedAt).toBe(new Date(5000).toISOString());

		const pinned = await setWorkspacePin(projectCwd, "keep-ws", true, agentDir);
		expect(pinned?.pinned).toBe(true);
		await registerProjectInIndex(projectCwd, agentDir);

		// Rejects invalid workspace names
		await expect(touchWorkspace(projectCwd, { name: "../escape" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(touchWorkspace(projectCwd, { name: "nested/name" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);
		await expect(touchWorkspace(projectCwd, { name: ".hidden" }, agentDir)).rejects.toThrow(
			/Invalid workspace name/,
		);

		// Detects non-git files outside a nested git root at depth 1
		const { entry: mixedWs } = await touchWorkspace(projectCwd, { name: "mixed-ws" }, agentDir);
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

	it("classifies git workspaces with untracked gitignored files as REVIEW and keeps clean pushed clones SAFE", async () => {
		const bareRemote = path.join(sandboxRoot, "ignored-origin.git");
		git(sandboxRoot, ["init", "--bare", bareRemote]);
		const seedRepo = path.join(sandboxRoot, "ignored-seed");
		initGitRepo(seedRepo);
		commitFile(seedRepo, ".gitignore", ".env\noutputs/\n");
		commitFile(seedRepo, "README.md", "tracked\n");
		git(seedRepo, ["remote", "add", "origin", bareRemote]);
		git(seedRepo, ["push", "-u", "origin", "HEAD"]);

		// 1. Clean, pushed clone with a gitignored file -> REVIEW ("gitignored files present")
		const { entry: ignoredFileWs } = await touchWorkspace(projectCwd, { name: "ignored-file-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, ignoredFileWs.path]);
		await writeFile(path.join(ignoredFileWs.path, ".env"), "API_KEY=secret\n", "utf8");
		const ignoredFileReport = await inspectWorkspaceSafety(ignoredFileWs);
		expect(ignoredFileReport.status).toBe("REVIEW");
		expect(ignoredFileReport.reasons).toEqual(["gitignored files present"]);

		// 2. Clean, pushed clone with a gitignored directory containing local output -> REVIEW
		const { entry: ignoredDirWs } = await touchWorkspace(projectCwd, { name: "ignored-dir-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, ignoredDirWs.path]);
		await mkdir(path.join(ignoredDirWs.path, "outputs"), { recursive: true });
		await writeFile(path.join(ignoredDirWs.path, "outputs", "result.json"), '{"ok":true}\n', "utf8");
		const ignoredDirReport = await inspectWorkspaceSafety(ignoredDirWs);
		expect(ignoredDirReport.status).toBe("REVIEW");
		expect(ignoredDirReport.reasons).toEqual(["gitignored files present"]);

		// 3. Clone with both a non-ignored untracked file and a gitignored file reports both reasons
		const { entry: bothWs } = await touchWorkspace(projectCwd, { name: "both-dirty-and-ignored-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, bothWs.path]);
		await writeFile(path.join(bothWs.path, ".env"), "API_KEY=secret\n", "utf8");
		await writeFile(path.join(bothWs.path, "scratch.txt"), "untracked\n", "utf8");
		const bothReport = await inspectWorkspaceSafety(bothWs);
		expect(bothReport.status).toBe("REVIEW");
		expect(bothReport.reasons).toContain("uncommitted or untracked changes");
		expect(bothReport.reasons).toContain("gitignored files present");

		// 4. Truly clean, pushed clone without ignored files -> SAFE
		const { entry: cleanWs } = await touchWorkspace(projectCwd, { name: "truly-clean-ws" }, agentDir);
		git(projectCwd, ["clone", bareRemote, cleanWs.path]);
		const cleanReport = await inspectWorkspaceSafety(cleanWs);
		expect(cleanReport.status).toBe("SAFE");
		expect(cleanReport.reasons).toEqual(["clean git workspace with all commits backed up"]);

		// Non-interactive GC (--yes) removes only the truly clean clone and preserves ignored-file workspaces
		const gcResult = await runWorkspaceGc({
			cwd: projectCwd,
			agentDir,
		});
		expect(gcResult.removed.map((r) => r.entry.name)).toEqual(["truly-clean-ws"]);
		expect(gcResult.kept.map((r) => r.entry.name).sort()).toEqual([
			"both-dirty-and-ignored-ws",
			"ignored-dir-ws",
			"ignored-file-ws",
		]);
		expect(fs.existsSync(cleanWs.path)).toBe(false);
		expect(fs.existsSync(path.join(ignoredFileWs.path, ".env"))).toBe(true);
		expect(fs.existsSync(path.join(ignoredDirWs.path, "outputs", "result.json"))).toBe(true);
	});
});

describe("index.ts — Pi session integration, tool_call enforcement, child propagation, tool & /workspace command", () => {
	function startPiSession(options?: {
		cwd?: string;
		mode?: "tui" | "rpc" | "print" | "json";
		bindAsChild?: boolean;
		sessionManager?: SessionManager;
		selectHandler?: (title: string, opts: string[]) => Promise<string | undefined>;
		extraFactories?: ExtensionFactory[];
	}) {
		return startWorkspaceSession({
			cwd: options?.cwd ?? projectCwd,
			agentDir,
			sessionDir,
			mode: options?.mode,
			bindAsChild: options?.bindAsChild,
			sessionManager: options?.sessionManager,
			selectHandler: options?.selectHandler,
			extraFactories: options?.extraFactories,
		});
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
			await touchWorkspace(
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
		// bash expands the `~` of the home target below, so the home directory is pinned inside the sandbox.
		const prevHome = process.env.HOME;
		process.env.HOME = path.join(sandboxRoot, "home");

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
					fauxToolCall("bash", { command: `mkdir -p ${homeTarget}` }),
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

			const errorTexts = parent.toolResults().filter((r) => r.isError).map((r) => r.text);
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

			// 3. Allow for this session permits the approved path for the session AND child sessions without writing policy.json; sibling files prompt again
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
			// Prompted for the first write and not for the edit of the same path; the bash and symlink writes to sibling files in outsideDir each prompted again and were denied
			expect(parent.ui.prompts.length).toBe(promptsBeforeSessionAllow + 3);
			expect(await readFile(sessionFile, "utf8")).toBe("v2\n");
			expect(fs.existsSync(sessionBashFile)).toBe(false);
			expect(fs.existsSync(path.join(outsideDir, "session-via-link.txt"))).toBe(false);
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);

			// 4. Child session via bindAsChild AND child session via pi-extensions.session-link entry (even with UI bound)
			// inherit the session allowlist entry for sessionFile and immediately block unapproved external write/edit/bash without prompting
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
				const childInheritedFile = sessionFile;
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
				expect(await readFile(childInheritedFile, "utf8")).toBe("child ok\n");
				expect(fs.existsSync(childBlockedWrite)).toBe(false);
				expect(await readFile(unapprovedExisting, "utf8")).toBe("keep\n");
				expect(fs.existsSync(childBlockedBash)).toBe(false);
				const child1Errors = child1.toolResults().filter((r) => r.isError);
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
				expect(child2.toolResults().find((r) => r.isError)?.text).toContain(workspacesDir(projectCwd));
			} finally {
				await child2.dispose();
			}

			// 5. Allow for this project persists the approved path to policy.json and allows it in a brand-new session without prompting; a sibling file prompts again
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
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([
				resolveCanonicalPath(projectAllowedFile),
			]);

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
				expect(laterSession.ui.prompts.map((prompt) => prompt.title)).toEqual([
					`Allow write outside workspace (${resolveCanonicalPath(laterBashFile)})?`,
				]);
				expect(await readFile(projectAllowedFile, "utf8")).toBe("project v2\n");
				expect(fs.existsSync(laterBashFile)).toBe(false);
			} finally {
				await laterSession.dispose();
			}
		} finally {
			await parent.dispose();
			if (prevHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = prevHome;
			}
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

			const toolOutputs = h.toolResults().map((r) => r.text);
			expect(toolOutputs.some((t) => t.includes('Workspace "exp-alpha" ready'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes('Pinned workspace "exp-alpha"'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes("- exp-alpha [PINNED] (pinned)"))).toBe(true);
			expect(toolOutputs.some((t) => t.includes('Unpinned workspace "exp-alpha"'))).toBe(true);
			// Releasing the empty, now-unpinned workspace removes it.
			expect(toolOutputs.some((t) => t.includes('Released and removed workspace "exp-alpha"'))).toBe(true);
			expect(toolOutputs.some((t) => t.includes("No workspaces in"))).toBe(true);
			expect((await readRegistry(projectCwd)).some((e) => e.name === "exp-alpha")).toBe(false);
			expect(fs.existsSync(path.join(workspacesDir(projectCwd), "exp-alpha"))).toBe(false);

			// An empty workspace no session owns: SAFE for the commands below.
			await touchWorkspace(projectCwd, { name: "exp-alpha" }, agentDir);

			// 2. Create two REVIEW workspaces ("exp-dirty-pin" and "exp-dirty-remove") and a linked git worktree ("exp-wt")
			initGitRepo(projectCwd);
			commitFile(projectCwd, "index.ts", "export const main = true;\n");
			const wtPath = path.join(workspacesDir(projectCwd), "exp-wt");
			git(projectCwd, ["worktree", "add", "-b", "exp-wt-branch", wtPath, "HEAD"]);

			const { entry: dirtyPinEntry } = await touchWorkspace(
				projectCwd,
				{ name: "exp-dirty-pin", purpose: "keep via pin" },
				agentDir,
			);
			await writeFile(path.join(dirtyPinEntry.path, "draft.txt"), "unfinished work\n", "utf8");

			const { entry: dirtyRemoveEntry } = await touchWorkspace(
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
			const { entry: otherSafe } = await touchWorkspace(otherProject, { name: "other-safe" }, agentDir);
			const deletedProject = path.join(sandboxRoot, "deleted-project");
			await touchWorkspace(deletedProject, { name: "gone-ws" }, agentDir);
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
		const vitestTargets = manifest.scripts.test.split(" && ").find((step) => step.startsWith("vitest run "))?.split(/\s+/) ?? [];
		expect(vitestTargets).toEqual(expect.arrayContaining(["extensions/molt", "extensions/language", "extensions/workspace"]));
		const exts = manifest.pi.extensions;
		expect(exts).toContain("./extensions/workspace/index.ts");
		expect(exts.at(-1)).toBe("./extensions/pika/index.ts");
		expect(exts.indexOf("./extensions/workspace/index.ts")).toBe(exts.indexOf("./extensions/processes/index.ts") - 1);
		expect(exts.indexOf("./extensions/processes/index.ts")).toBe(exts.indexOf("./extensions/pika/index.ts") - 1);

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

describe("AC-10: wrapper option flags, process_start, and agent_browser external-path guards", () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;

	function loadToolCallHandler(): ToolCallHandler {
		let toolCall: ToolCallHandler | undefined;
		workspaceExtension({
			on: (event: string, handler: ToolCallHandler) => {
				if (event === "tool_call") toolCall = handler;
			},
			registerTool: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		return toolCall!;
	}

	function makeCtx(options: {
		hasUI: boolean;
		child?: boolean;
		prompts: string[];
		choice?: string | ((title: string) => string);
	}): ExtensionContext {
		return {
			cwd: projectCwd,
			mode: options.hasUI ? "rpc" : "print",
			hasUI: options.hasUI,
			ui: {
				select: options.hasUI
					? async (title: string) => {
							options.prompts.push(title);
							if (typeof options.choice === "function") return options.choice(title);
							return options.choice ?? "Deny";
						}
					: undefined,
			},
			sessionManager: {
				getSessionId: () => "ac10-session",
				getEntries: () =>
					options.child ? [{ type: "custom", customType: SESSION_LINK_TYPE, data: {} }] : [],
			},
		} as unknown as ExtensionContext;
	}

	it("skips wrapper option flags for env, sudo, command, nohup, nice, and timeout and tracks env -C / sudo -D", () => {
		const canonicalOutside = resolveCanonicalPath(outsideDir);

		expect(bashExternalWritePaths(`env -u FOO cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`env -i -0 -u FOO cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`env --unset=FOO VAR=1 tee ${outsideDir}/f`, projectCwd)).toEqual([
			path.join(canonicalOutside, "f"),
		]);
		expect(bashExternalWritePaths(`env -- cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`env -S "VAR=1" cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`env -S "-C ${outsideDir}" touch x`, projectCwd)).toEqual([
			path.join(canonicalOutside, "x"),
		]);
		// env -C / --chdir shifts cwd only for the wrapped command, not later commands.
		expect(
			bashExternalWritePaths(`env -C ${outsideDir} touch x && touch local.txt`, projectCwd),
		).toEqual([path.join(canonicalOutside, "x")]);
		expect(bashExternalWritePaths(`env --chdir=${outsideDir} touch x`, projectCwd)).toEqual([
			path.join(canonicalOutside, "x"),
		]);

		expect(bashExternalWritePaths(`sudo -u root cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`sudo -u root tee ${outsideDir}/file`, projectCwd)).toEqual([
			path.join(canonicalOutside, "file"),
		]);
		expect(bashExternalWritePaths(`sudo -g wheel -E rm ${outsideDir}/f`, projectCwd)).toEqual([
			path.join(canonicalOutside, "f"),
		]);
		expect(bashExternalWritePaths(`sudo -H -n -u root -C 3 cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`sudo -D ${outsideDir} touch x`, projectCwd)).toEqual([
			path.join(canonicalOutside, "x"),
		]);
		expect(bashExternalWritePaths(`sudo --chdir=${outsideDir} cp /tmp/a b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);

		expect(bashExternalWritePaths(`command -p mv a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`command -- cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`command -v rm ${outsideDir}/f`, projectCwd)).toEqual([]);

		expect(bashExternalWritePaths(`nohup cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`nice -n 10 cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
		expect(bashExternalWritePaths(`timeout -s TERM 5 cp a ${outsideDir}/b`, projectCwd)).toEqual([
			path.join(canonicalOutside, "b"),
		]);
	});

	it("guards bash wrapper commands with option flags in tool_call", async () => {
		const toolCall = loadToolCallHandler();
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		const cases: [command: string, expectedPath: string][] = [
			[`env -u FOO cp a ${outsideDir}/b`, path.join(canonicalOutside, "b")],
			[`sudo -u root tee ${outsideDir}/file`, path.join(canonicalOutside, "file")],
			[`command -p mv a ${outsideDir}/b`, path.join(canonicalOutside, "b")],
			[`env -C ${outsideDir} touch created.txt`, path.join(canonicalOutside, "created.txt")],
			[`sudo -D ${outsideDir} touch created2.txt`, path.join(canonicalOutside, "created2.txt")],
		];

		for (const [command, expectedPath] of cases) {
			const headlessPrompts: string[] = [];
			const headlessRes = await toolCall(
				{ toolName: "bash", input: { command } },
				makeCtx({ hasUI: false, prompts: headlessPrompts }),
			);
			expect(headlessRes, command).toMatchObject({ block: true });
			expect(headlessRes?.reason, command).toContain(expectedPath);
			expect(headlessPrompts).toEqual([]);

			const uiPrompts: string[] = [];
			const uiRes = await toolCall(
				{ toolName: "bash", input: { command } },
				makeCtx({ hasUI: true, prompts: uiPrompts, choice: "Deny" }),
			);
			expect(uiRes, command).toMatchObject({ block: true });
			expect(uiPrompts).toEqual([`Allow write outside workspace (${expectedPath})?`]);
		}
	});

	it("guards process_start external write targets and external cwd while allowing in-project and /tmp writes", async () => {
		const toolCall = loadToolCallHandler();
		const canonicalOutside = resolveCanonicalPath(outsideDir);

		// Blocked / prompted external targets
		const externalCases: [input: { command: string; cwd?: string }, expectedPath: string][] = [
			[{ command: `echo hi > ${outsideDir}/a` }, path.join(canonicalOutside, "a")],
			[{ command: `env -u FOO tee ${outsideDir}/b` }, path.join(canonicalOutside, "b")],
			[{ command: "echo hi > rel.txt", cwd: outsideDir }, canonicalOutside],
			[{ command: "node server.js", cwd: outsideDir }, canonicalOutside],
		];

		for (const [input, expectedPath] of externalCases) {
			const headlessPrompts: string[] = [];
			const blocked = await toolCall(
				{ toolName: "process_start", input },
				makeCtx({ hasUI: false, prompts: headlessPrompts }),
			);
			expect(blocked, JSON.stringify(input)).toMatchObject({ block: true });
			expect(blocked?.reason, JSON.stringify(input)).toContain(expectedPath);
			expect(headlessPrompts).toEqual([]);

			const uiPrompts: string[] = [];
			const denied = await toolCall(
				{ toolName: "process_start", input },
				makeCtx({ hasUI: true, prompts: uiPrompts, choice: "Deny" }),
			);
			expect(denied, JSON.stringify(input)).toMatchObject({ block: true });
			expect(uiPrompts).toEqual([`Allow write outside workspace (${expectedPath})?`]);
		}

		// Approving for session allows a subsequent process_start write to the same external path
		const allowPrompts: string[] = [];
		const targetFile = path.join(outsideDir, "approved.log");
		const allowedFirst = await toolCall(
			{ toolName: "process_start", input: { command: `echo hi > ${targetFile}` } },
			makeCtx({ hasUI: true, prompts: allowPrompts, choice: "Allow for this session" }),
		);
		expect(allowedFirst).toBeUndefined();
		expect(allowPrompts).toEqual([`Allow write outside workspace (${resolveCanonicalPath(targetFile)})?`]);

		const secondPrompts: string[] = [];
		const allowedSecond = await toolCall(
			{ toolName: "process_start", input: { command: `echo hi >> ${targetFile}` } },
			makeCtx({ hasUI: true, prompts: secondPrompts, choice: "Deny" }),
		);
		expect(allowedSecond).toBeUndefined();
		expect(secondPrompts).toEqual([]);

		// In-project and /tmp writes stay allowed without prompting
		for (const input of [
			{ command: "echo hi > local-output.txt" },
			{ command: "echo hi > /tmp/process-start-ok.txt" },
			{ command: "echo hi > ok.txt", cwd: "/tmp" },
			{ command: "echo hi > sub.txt", cwd: "." },
		]) {
			const prompts: string[] = [];
			const res = await toolCall(
				{ toolName: "process_start", input },
				makeCtx({ hasUI: true, prompts, choice: "Deny" }),
			);
			expect(res, JSON.stringify(input)).toBeUndefined();
			expect(prompts, JSON.stringify(input)).toEqual([]);
		}
	});

	it("extracts and guards agent_browser external cwd and file-writing targets while allowing safe calls", async () => {
		const canonicalOutside = resolveCanonicalPath(outsideDir);

		const canonicalProject = resolveCanonicalPath(projectCwd);

		// Pure helper checks
		expect(extractAgentBrowserWriteTargets(["screenshot", `${outsideDir}/shot.png`], projectCwd)).toEqual([
			path.join(canonicalOutside, "shot.png"),
		]);
		expect(
			extractAgentBrowserWriteTargets(
				["--session", "s1", "--headed", "--json", "--profile", "p1", "pdf", `${outsideDir}/out.pdf`],
				projectCwd,
			),
		).toEqual([path.join(canonicalProject, "p1"), path.join(canonicalOutside, "out.pdf")]);
		expect(
			extractAgentBrowserWriteTargets(["--session=s1", "state", "save", `${outsideDir}/state.json`], projectCwd),
		).toEqual([path.join(canonicalOutside, "state.json")]);
		expect(
			extractAgentBrowserWriteTargets(["trace", "start", "--screenshots", `${outsideDir}/trace.zip`], projectCwd),
		).toEqual([path.join(canonicalOutside, "trace.zip")]);
		expect(extractAgentBrowserWriteTargets(["trace", "stop", `${outsideDir}/trace2.zip`], projectCwd)).toEqual([
			path.join(canonicalOutside, "trace2.zip"),
		]);
		expect(
			extractAgentBrowserWriteTargets(["download", "@e3", `${outsideDir}/report.csv`], projectCwd),
		).toEqual([path.join(canonicalOutside, "report.csv")]);
		expect(extractAgentBrowserWriteTargets(["download", `${outsideDir}/direct.csv`], projectCwd)).toEqual([
			path.join(canonicalOutside, "direct.csv"),
		]);
		expect(extractAgentBrowserWriteTargets(["screenshot"], projectCwd)).toEqual([]);
		expect(extractAgentBrowserWriteTargets(["screenshot", "--base64"], projectCwd)).toEqual([]);
		expect(extractAgentBrowserWriteTargets(["open", "https://example.com"], projectCwd)).toEqual([]);
		expect(extractAgentBrowserWriteTargets(["state", "load", `${outsideDir}/state.json`], projectCwd)).toEqual([]);
		expect(agentBrowserExternalPaths(["open", "https://example.com"], projectCwd, outsideDir)).toEqual([
			canonicalOutside,
		]);

		// tool_call guard checks
		const toolCall = loadToolCallHandler();
		const externalCases: [input: { argv: string[]; cwd?: string }, expectedPath: string][] = [
			[{ argv: ["open", "https://example.com"], cwd: outsideDir }, canonicalOutside],
			[{ argv: ["screenshot", `${outsideDir}/shot.png`] }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["--session", "s1", "pdf", `${outsideDir}/out.pdf`] }, path.join(canonicalOutside, "out.pdf")],
			[{ argv: ["state", "save", `${outsideDir}/state.json`] }, path.join(canonicalOutside, "state.json")],
			[{ argv: ["trace", "start", `${outsideDir}/trace.zip`] }, path.join(canonicalOutside, "trace.zip")],
			[{ argv: ["trace", "stop", `${outsideDir}/trace.zip`] }, path.join(canonicalOutside, "trace.zip")],
			[{ argv: ["download", "@e1", `${outsideDir}/dl.bin`] }, path.join(canonicalOutside, "dl.bin")],
			[{ argv: ["screenshot", "--selector", "#main", `${outsideDir}/sel.png`] }, path.join(canonicalOutside, "sel.png")],
		];

		for (const [input, expectedPath] of externalCases) {
			const headlessPrompts: string[] = [];
			const blocked = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: false, prompts: headlessPrompts }),
			);
			expect(blocked, JSON.stringify(input)).toMatchObject({ block: true });
			expect(blocked?.reason, JSON.stringify(input)).toContain(expectedPath);
			expect(headlessPrompts).toEqual([]);

			const uiPrompts: string[] = [];
			const denied = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: true, prompts: uiPrompts, choice: "Deny" }),
			);
			expect(denied, JSON.stringify(input)).toMatchObject({ block: true });
			expect(uiPrompts).toEqual([`Allow write outside workspace (${expectedPath})?`]);
		}

		// Safe agent_browser calls stay allowed without prompting
		for (const input of [
			{ argv: ["screenshot"] },
			{ argv: ["screenshot", "--base64"] },
			{ argv: ["open", "https://example.com"] },
			{ argv: ["screenshot", "/tmp/shot.png"] },
			{ argv: ["screenshot", "artifacts/shot.png"] },
			{ argv: ["--session", "s1", "pdf", "artifacts/out.pdf"] },
			{ argv: ["state", "load", `${outsideDir}/state.json`] },
			{ argv: ["open", "https://example.com"], cwd: "/tmp" },
		]) {
			const prompts: string[] = [];
			const res = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: true, prompts, choice: "Deny" }),
			);
			expect(res, JSON.stringify(input)).toBeUndefined();
			expect(prompts, JSON.stringify(input)).toEqual([]);
		}
	});

	it("extracts and guards agent_browser --profile and --download-path flags (separate and = forms)", async () => {
		const canonicalProject = resolveCanonicalPath(projectCwd);
		const canonicalOutside = resolveCanonicalPath(outsideDir);

		// Pure helper checks: before and after subcommand, separate and = forms
		expect(
			extractAgentBrowserWriteTargets(["--profile", `${outsideDir}/prof`, "open", "https://example.com"], projectCwd),
		).toEqual([path.join(canonicalOutside, "prof")]);
		expect(
			extractAgentBrowserWriteTargets([`--profile=${outsideDir}/prof`, "open", "https://example.com"], projectCwd),
		).toEqual([path.join(canonicalOutside, "prof")]);
		expect(
			extractAgentBrowserWriteTargets(["open", "https://example.com", "--profile", `${outsideDir}/prof`], projectCwd),
		).toEqual([path.join(canonicalOutside, "prof")]);
		expect(
			extractAgentBrowserWriteTargets(["open", "https://example.com", `--profile=${outsideDir}/prof`], projectCwd),
		).toEqual([path.join(canonicalOutside, "prof")]);
		expect(
			extractAgentBrowserWriteTargets(
				["--download-path", `${outsideDir}/dl`, "open", "https://example.com"],
				projectCwd,
			),
		).toEqual([path.join(canonicalOutside, "dl")]);
		expect(
			extractAgentBrowserWriteTargets(
				[`--download-path=${outsideDir}/dl`, "open", "https://example.com"],
				projectCwd,
			),
		).toEqual([path.join(canonicalOutside, "dl")]);
		expect(
			extractAgentBrowserWriteTargets(
				["open", "https://example.com", "--download-path", `${outsideDir}/dl`],
				projectCwd,
			),
		).toEqual([path.join(canonicalOutside, "dl")]);
		expect(
			extractAgentBrowserWriteTargets(
				["open", "https://example.com", `--download-path=${outsideDir}/dl`],
				projectCwd,
			),
		).toEqual([path.join(canonicalOutside, "dl")]);
		// Relative paths resolve against effective cwd
		expect(
			extractAgentBrowserWriteTargets(
				["--profile", "my-profile", "--download-path=my-dl", "open", "https://example.com"],
				projectCwd,
			),
		).toEqual([path.join(canonicalProject, "my-profile"), path.join(canonicalProject, "my-dl")]);
		expect(
			agentBrowserExternalPaths(
				["--profile", "my-profile", "open", "https://example.com"],
				projectCwd,
				outsideDir,
			),
		).toEqual([canonicalOutside, path.join(canonicalOutside, "my-profile")]);
		// Value of another global flag or tokens after `--` are not treated as write flags
		expect(
			extractAgentBrowserWriteTargets(["--session", "--profile", "open", "https://example.com"], projectCwd),
		).toEqual([]);
		expect(
			extractAgentBrowserWriteTargets(["open", "--", "--download-path", `${outsideDir}/dl`], projectCwd),
		).toEqual([]);
		expect(
			extractAgentBrowserWriteTargets(["--profile=", "--download-path=", "open", "https://example.com"], projectCwd),
		).toEqual([]);

		// tool_call guard: external --profile and --download-path are blocked / prompted
		const toolCall = loadToolCallHandler();
		const externalCases: [input: { argv: string[]; cwd?: string }, expectedPath: string][] = [
			[{ argv: ["--profile", `${outsideDir}/prof`, "open", "https://example.com"] }, path.join(canonicalOutside, "prof")],
			[{ argv: [`--profile=${outsideDir}/prof`, "open", "https://example.com"] }, path.join(canonicalOutside, "prof")],
			[{ argv: ["open", "https://example.com", "--profile", `${outsideDir}/prof`] }, path.join(canonicalOutside, "prof")],
			[{ argv: ["open", "https://example.com", `--profile=${outsideDir}/prof`] }, path.join(canonicalOutside, "prof")],
			[
				{ argv: ["--download-path", `${outsideDir}/dl`, "open", "https://example.com"] },
				path.join(canonicalOutside, "dl"),
			],
			[
				{ argv: [`--download-path=${outsideDir}/dl`, "open", "https://example.com"] },
				path.join(canonicalOutside, "dl"),
			],
			[
				{ argv: ["open", "https://example.com", "--download-path", `${outsideDir}/dl`] },
				path.join(canonicalOutside, "dl"),
			],
			[
				{ argv: ["open", "https://example.com", `--download-path=${outsideDir}/dl`] },
				path.join(canonicalOutside, "dl"),
			],
		];

		for (const [input, expectedPath] of externalCases) {
			const headlessPrompts: string[] = [];
			const blocked = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: false, prompts: headlessPrompts }),
			);
			expect(blocked, JSON.stringify(input)).toMatchObject({ block: true });
			expect(blocked?.reason, JSON.stringify(input)).toContain(expectedPath);
			expect(headlessPrompts).toEqual([]);

			const uiPrompts: string[] = [];
			const denied = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: true, prompts: uiPrompts, choice: "Deny" }),
			);
			expect(denied, JSON.stringify(input)).toMatchObject({ block: true });
			expect(uiPrompts).toEqual([`Allow write outside workspace (${expectedPath})?`]);
		}

		// Inside workspace or /tmp stays allowed without prompting
		for (const input of [
			{ argv: ["--profile", "profiles/p1", "open", "https://example.com"] },
			{ argv: ["--profile=profiles/p2", "open", "https://example.com"] },
			{ argv: ["--download-path", "artifacts/dl", "open", "https://example.com"] },
			{ argv: ["--download-path=artifacts/dl2", "open", "https://example.com"] },
			{ argv: ["--profile", "/tmp/ab-profile", "open", "https://example.com"] },
			{ argv: ["--download-path=/tmp/ab-dl", "open", "https://example.com"] },
		]) {
			const prompts: string[] = [];
			const res = await toolCall(
				{ toolName: "agent_browser", input },
				makeCtx({ hasUI: true, prompts, choice: "Deny" }),
			);
			expect(res, JSON.stringify(input)).toBeUndefined();
			expect(prompts, JSON.stringify(input)).toEqual([]);
		}

		// Workspace auto-registration & quota enforcement through --profile / --download-path
		const browserQuotaCtx = makeCtx({ hasUI: false, prompts: [] });
		for (let i = 0; i < WORKSPACE_LIMITS.maxHeldPerSession; i++) {
			const res = await toolCall(
				{
					toolName: "agent_browser",
					input: { argv: ["--profile", `.pi/workspaces/browser-prof-${i}/data`, "open", "https://example.com"] },
				},
				browserQuotaCtx,
			);
			expect(res).toBeUndefined();
		}
		const reg = await readRegistry(projectCwd);
		expect(reg.some((e) => e.name === "browser-prof-0")).toBe(true);

		const overQuotaBrowser = await toolCall(
			{
				toolName: "agent_browser",
				input: { argv: ["--download-path=.pi/workspaces/browser-over/dl", "open", "https://example.com"] },
			},
			browserQuotaCtx,
		);
		expect(overQuotaBrowser).toMatchObject({ block: true });
		expect(overQuotaBrowser?.reason).toContain("browser-over");
	});

	it("extracts and guards agent_desktop file-writing options while leaving read-only calls unaffected", async () => {
		const canonicalProject = resolveCanonicalPath(projectCwd);
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		const symlinkOut = path.join(projectCwd, "escape-link");
		await symlink(outsideDir, symlinkOut);

		// Pure helper checks: file-writing options
		expect(extractAgentDesktopWriteTargets(["screenshot", `${outsideDir}/shot.png`], projectCwd)).toEqual([
			path.join(canonicalOutside, "shot.png"),
		]);
		expect(
			extractAgentDesktopWriteTargets(["screenshot", "--app", "Finder", "shots/finder.png"], projectCwd),
		).toEqual([path.join(canonicalProject, "shots", "finder.png")]);
		expect(
			extractAgentDesktopWriteTargets(["screenshot", "shots/win.png", "--window-id", "42"], projectCwd),
		).toEqual([path.join(canonicalProject, "shots", "win.png")]);
		expect(
			extractAgentDesktopWriteTargets(["--screenshot", `${outsideDir}/debug.html`, "snapshot"], projectCwd),
		).toEqual([path.join(canonicalOutside, "debug.html")]);
		expect(
			extractAgentDesktopWriteTargets([`--screenshot=${outsideDir}/debug.html`, "click", "@s1:e1"], projectCwd),
		).toEqual([path.join(canonicalOutside, "debug.html")]);
		expect(
			extractAgentDesktopWriteTargets(["click", "@s1:e1", "--screenshot", `${outsideDir}/after.html`], projectCwd),
		).toEqual([path.join(canonicalOutside, "after.html")]);
		expect(
			extractAgentDesktopWriteTargets(["--trace", `${outsideDir}/trace.jsonl`, "snapshot"], projectCwd),
		).toEqual([path.join(canonicalOutside, "trace.jsonl")]);
		expect(
			extractAgentDesktopWriteTargets([`--trace=${outsideDir}/trace.jsonl`, "click", "@s1:e1"], projectCwd),
		).toEqual([path.join(canonicalOutside, "trace.jsonl")]);
		expect(
			extractAgentDesktopWriteTargets(["click", "@s1:e1", "--trace", `${outsideDir}/trace.jsonl`], projectCwd),
		).toEqual([path.join(canonicalOutside, "trace.jsonl")]);
		expect(
			extractAgentDesktopWriteTargets(["click", "@s1:e1", `--trace=${outsideDir}/trace.jsonl`], projectCwd),
		).toEqual([path.join(canonicalOutside, "trace.jsonl")]);
		expect(
			extractAgentDesktopWriteTargets(["trace", "export", "--out", `${outsideDir}/viewer.html`], projectCwd),
		).toEqual([path.join(canonicalOutside, "viewer.html")]);
		expect(
			agentDesktopExternalPaths(["trace", "export"], projectCwd, outsideDir),
		).toEqual([canonicalOutside]);

		// Relative write targets resolve against cwd (including @-prefixed cwd)
		expect(
			agentDesktopExternalPaths(["screenshot", "shot.png"], projectCwd, outsideDir),
		).toEqual([path.join(canonicalOutside, "shot.png")]);
		expect(
			agentDesktopExternalPaths(["screenshot", "shot.png"], projectCwd, `@${outsideDir}`),
		).toEqual([path.join(canonicalOutside, "shot.png")]);
		expect(
			agentDesktopExternalPaths(["--trace", "t.jsonl", "click", "@s1:e1"], projectCwd, outsideDir),
		).toEqual([path.join(canonicalOutside, "t.jsonl")]);
		expect(
			agentDesktopExternalPaths(["--screenshot=dbg.html", "snapshot"], projectCwd, outsideDir),
		).toEqual([path.join(canonicalOutside, "dbg.html")]);

		// Read-only calls & temp-only screenshot (without positional path) produce no write targets, even with external cwd
		for (const argv of [
			["snapshot", "-i", "--app", "Notes"],
			["list-windows"],
			["get", "text", "@s1:e1"],
			["status"],
			["click", "@s1:e1"],
			["screenshot"],
			["screenshot", "--app", "Notes", "--window-id", "42"],
			["trace", "show"],
			["trace", "export", "--help"],
			["--wait-for", "--trace", "click", "@s1:e1"],
			["type", "@s1:e1", "--", "--trace", `${outsideDir}/not-a-flag.jsonl`],
		]) {
			expect(extractAgentDesktopWriteTargets(argv, projectCwd), JSON.stringify(argv)).toEqual([]);
			expect(agentDesktopExternalPaths(argv, projectCwd, outsideDir), JSON.stringify(argv)).toEqual([]);
		}

		// tool_call guard: external write targets are blocked / prompted
		const toolCall = loadToolCallHandler();
		const externalCases: [input: { argv: string[]; cwd?: string }, expectedPath: string][] = [
			[{ argv: ["screenshot", `${outsideDir}/shot.png`] }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["screenshot", "shot.png"], cwd: outsideDir }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["screenshot", "shot.png"], cwd: `@${outsideDir}` }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["screenshot", "escape-link/shot.png"] }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["screenshot", "shot.png"], cwd: "escape-link" }, path.join(canonicalOutside, "shot.png")],
			[{ argv: ["--screenshot", `${outsideDir}/dbg.html`, "snapshot"] }, path.join(canonicalOutside, "dbg.html")],
			[{ argv: [`--screenshot=${outsideDir}/dbg.html`, "click", "@s1:e1"] }, path.join(canonicalOutside, "dbg.html")],
			[{ argv: ["click", "@s1:e1", "--screenshot", "dbg.html"], cwd: outsideDir }, path.join(canonicalOutside, "dbg.html")],
			[{ argv: ["--trace", `${outsideDir}/trace.jsonl`, "click", "@s1:e1"] }, path.join(canonicalOutside, "trace.jsonl")],
			[{ argv: [`--trace=${outsideDir}/trace.jsonl`, "snapshot"] }, path.join(canonicalOutside, "trace.jsonl")],
			[{ argv: ["snapshot", "--trace=trace.jsonl"], cwd: outsideDir }, path.join(canonicalOutside, "trace.jsonl")],
			[{ argv: ["trace", "export", "--out", `${outsideDir}/viewer.html`] }, path.join(canonicalOutside, "viewer.html")],
			[{ argv: ["trace", "export"], cwd: outsideDir }, canonicalOutside],
		];

		for (const [input, expectedPath] of externalCases) {
			const headlessPrompts: string[] = [];
			const blocked = await toolCall(
				{ toolName: "agent_desktop", input },
				makeCtx({ hasUI: false, prompts: headlessPrompts }),
			);
			expect(blocked, JSON.stringify(input)).toMatchObject({ block: true });
			expect(blocked?.reason, JSON.stringify(input)).toContain(expectedPath);
			expect(headlessPrompts).toEqual([]);

			const uiPrompts: string[] = [];
			const denied = await toolCall(
				{ toolName: "agent_desktop", input },
				makeCtx({ hasUI: true, prompts: uiPrompts, choice: "Deny" }),
			);
			expect(denied, JSON.stringify(input)).toMatchObject({ block: true });
			expect(uiPrompts).toEqual([`Allow write outside workspace (${expectedPath})?`]);
		}

		// Safe file-writing calls inside workspace / /tmp AND read-only calls (even with external cwd) stay allowed without prompting
		for (const input of [
			{ argv: ["screenshot", "artifacts/shot.png"] },
			{ argv: ["screenshot", "/tmp/desktop-shot.png"] },
			{ argv: ["screenshot", "shot.png"], cwd: "/tmp" },
			{ argv: ["screenshot", "/tmp/desktop-shot.png"], cwd: outsideDir },
			{ argv: ["--screenshot", "artifacts/dbg.html", "snapshot"] },
			{ argv: ["--screenshot=/tmp/dbg.html", "click", "@s1:e1"] },
			{ argv: ["--trace", "artifacts/trace.jsonl", "click", "@s1:e1"] },
			{ argv: ["--trace=/tmp/trace.jsonl", "snapshot"] },
			{ argv: ["screenshot", "artifacts/shot.png"], cwd: "none" },
			// Read-only calls without write flags (both default cwd and external cwd)
			{ argv: ["snapshot", "-i", "--app", "Notes"] },
			{ argv: ["snapshot", "-i"], cwd: outsideDir },
			{ argv: ["list-windows"], cwd: outsideDir },
			{ argv: ["get", "text", "@s1:e1"], cwd: outsideDir },
			{ argv: ["status"], cwd: outsideDir },
			{ argv: ["click", "@s1:e1"], cwd: outsideDir },
			{ argv: ["screenshot"], cwd: outsideDir },
			{ argv: ["screenshot", "--app", "Notes"], cwd: outsideDir },
			{ argv: ["trace", "show"], cwd: outsideDir },
		]) {
			const prompts: string[] = [];
			const res = await toolCall(
				{ toolName: "agent_desktop", input },
				makeCtx({ hasUI: true, prompts, choice: "Deny" }),
			);
			expect(res, JSON.stringify(input)).toBeUndefined();
			expect(prompts, JSON.stringify(input)).toEqual([]);
		}

		// Workspace auto-registration & per-session quota enforcement for agent_desktop
		const quotaCtx = makeCtx({ hasUI: false, prompts: [] });
		for (let i = 0; i < WORKSPACE_LIMITS.maxHeldPerSession; i++) {
			const res = await toolCall(
				{
					toolName: "agent_desktop",
					input: { argv: ["--trace", `.pi/workspaces/desktop-ws-${i}/trace.jsonl`, "snapshot"] },
				},
				quotaCtx,
			);
			expect(res).toBeUndefined();
		}
		const reg = await readRegistry(projectCwd);
		expect(reg.some((e) => e.name === "desktop-ws-0")).toBe(true);

		const overQuota = await toolCall(
			{
				toolName: "agent_desktop",
				input: { argv: ["screenshot", ".pi/workspaces/desktop-ws-over/shot.png"] },
			},
			quotaCtx,
		);
		expect(overQuota).toMatchObject({ block: true });
		expect(overQuota?.reason).toContain("desktop-ws-over");
	});

	it('prompts only once on "Allow once" when a relative ../ cwd matches a write target in process_start or agent_browser', async () => {
		const toolCall = loadToolCallHandler();
		const canonicalOutside = resolveCanonicalPath(outsideDir);
		const canonicalTmpdir = resolveCanonicalPath(os.tmpdir());

		const cases: [toolName: "process_start" | "agent_browser", input: Record<string, unknown>, expectedPath: string][] = [
			["process_start", { command: "touch .", cwd: "../outside" }, canonicalOutside],
			["process_start", { command: "touch .", cwd: "../.." }, canonicalTmpdir],
			["agent_browser", { argv: ["--profile", ".", "open", "https://example.com"], cwd: "../outside" }, canonicalOutside],
			["agent_browser", { argv: ["--profile", ".", "open", "https://example.com"], cwd: "../.." }, canonicalTmpdir],
		];

		for (const [toolName, input, expectedPath] of cases) {
			const prompts: string[] = [];
			const res = await toolCall(
				{ toolName, input },
				makeCtx({ hasUI: true, prompts, choice: "Allow once" }),
			);
			expect(res, `${toolName} ${JSON.stringify(input)}`).toBeUndefined();
			expect(prompts, `${toolName} ${JSON.stringify(input)}`).toEqual([
				`Allow write outside workspace (${expectedPath})?`,
			]);
		}
	});
});
