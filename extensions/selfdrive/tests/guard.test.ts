// selfdrive's tool_call guard: the bash classifier as a table, the write/edit path rules on a real git repository with a
// nested linked worktree, and the hook in a real Pi session on the faux provider.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { grants, publishGrant, repositoryOf, standingRegistry, withdrawGrant, type StandingApproval } from "../grants.ts";
import { bashBlockReason, blockReason, guardRuntime, insideCheckout, reasons, registerGuard } from "../guard.ts";
import selfdriveExtension from "../index.ts";
import { scopeAgentDir, startGuardSession, stubKeepAwake, type GuardSessionHarness } from "./support/session-harness.ts";

let root: string;
let repo: string;
let outside: string;
let alias: string;
let grant: StandingApproval;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-selfdrive-guard-")));
	repo = join(root, "repo");
	outside = join(root, "outside");
	alias = join(root, "alias");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(outside);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	// A linked worktree checked out inside the checkout, as a worktree under .pi/workspaces/ or elsewhere would be.
	git(repo, "worktree", "add", "-q", "--detach", join(repo, "nested-wt"), "HEAD");
	mkdirSync(join(repo, ".pi", "workspaces", "side"), { recursive: true });
	mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
	mkdirSync(join(repo, ".git", "herder", "runs", "r1", "wt"), { recursive: true });
	mkdirSync(join(repo, ".git", "herder", "worktrees", "w1"), { recursive: true });
	// A nested repository (a `.git` directory) and a submodule-like `.git` file both stay part of the checkout.
	mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
	git(join(repo, "vendor", "lib"), "init", "-q");
	mkdirSync(join(repo, "vendor", "sub"), { recursive: true });
	writeFileSync(join(repo, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
	symlinkSync(outside, join(repo, "link-out"));
	symlinkSync(repo, alias);
	const repository = repositoryOf(repo)!;
	grant = { id: "granting-session", ...repository, text: "Self-driving mode, granted by the user.", since: new Date().toISOString() };
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const SESSION_MODES_KEY = Symbol.for("pi-extensions.session-modes");

afterEach(() => {
	standingRegistry().grants.clear();
	delete (globalThis as Record<symbol, unknown>)[SESSION_MODES_KEY];
});

describe("write and edit", () => {
	const judge = (toolName: string, path: string, cwd = repo) => blockReason(toolName, { path, content: "x" }, cwd, "some-session", [grant]);

	it("publishes realpaths through repositoryOf, which the guard compares against", () => {
		expect(grant.toplevel).toBe(repo);
		expect(grant.commonDir).toBe(join(repo, ".git"));
	});

	it.each([
		["a relative path", "src/a.ts"],
		["a new file", "src/new/deep.ts"],
		["an absolute path", "REPO/README.md"],
		["an @-prefixed path", "@src/a.ts"],
		["a file:// URL", "FILEURL"],
		["the path through a symlink to the checkout", "ALIAS/src/a.ts"],
		["a path that climbs back in", "../repo/src/a.ts"],
		["a nested repository", "vendor/lib/x.ts"],
		["a submodule", "vendor/sub/x.ts"],
		[".pi/settings.json inside checkout", ".pi/settings.json"],
		[".pi/agents inside checkout", ".pi/agents/foo.md"],
		[".pi/pika inside checkout", ".pi/pika/project.json"],
		["a sibling directory prefixed with workspaces", ".pi/workspaces-other/file.ts"],
		[".git/config inside checkout", ".git/config"],
		[".git/hooks/pre-commit inside checkout", ".git/hooks/pre-commit"],
		[".git/HEAD inside checkout", ".git/HEAD"],
		[".git/refs/heads/main inside checkout", ".git/refs/heads/main"],
		[".git/modules/sub/config inside checkout", ".git/modules/sub/config"],
		[".git/herder/note outside worktrees/runs", ".git/herder/note"],
		[".git/config via checkout symlink", "ALIAS/.git/config"],
		[".git/config climbed out of a Herder worktree", ".git/herder/worktrees/w1/../../../config"],
		[".git directory itself", ".git"],
	])("blocks %s inside the checkout", (_name, raw) => {
		const path = raw.replace("REPO", repo).replace("ALIAS", alias).replace("FILEURL", pathToFileURL(join(repo, "src", "a.ts")).href);
		for (const tool of ["write", "edit"]) {
			const reason = judge(tool, path);
			expect(reason).toContain("Blocked by self-driving mode:");
			expect(reason).toContain("would change your user's checkout");
			expect(reason).toContain("Make the change through a Herder run or in a worktree under .pi/workspaces/.");
		}
	});

	it.each([
		["the git dir, where Herder's worktrees live", ".git/herder/runs/r1/wt/src/a.ts"],
		["a Herder run artifact under .git/herder/runs/", ".git/herder/runs/r1/goal.md"],
		["a Herder worktree under .git/herder/worktrees/", ".git/herder/worktrees/w1/file.ts"],
		["a linked worktree gitdir under .git/worktrees/", ".git/worktrees/nested-wt/HEAD"],
		["a workspace under .pi/workspaces/", ".pi/workspaces/side/notes.md"],
		["a new workspace file under .pi/workspaces/", ".pi/workspaces/ws1/file.ts"],
		["a linked worktree inside the checkout", "nested-wt/src/a.ts"],
		["a symlink that leads out of the checkout", "link-out/x.txt"],
		["another directory", "OUTSIDE/x.txt"],
		["/tmp", "/tmp/selfdrive-guard-x.txt"],
	])("allows %s", (_name, raw) => {
		const path = raw.replace("OUTSIDE", outside);
		expect(judge("write", path)).toBeUndefined();
		expect(judge("edit", path)).toBeUndefined();
	});

	it("judges a relative path against the session's cwd", () => {
		expect(judge("write", "x.txt", outside)).toBeUndefined();
		expect(judge("write", "x.txt", join(repo, "src"))).toContain("would change your user's checkout");
		expect(judge("write", "x.txt", join(repo, "nested-wt"))).toBeUndefined();
	});

	it("matches the checkout whatever the case on a case-insensitive file system", () => {
		const upper = repo.toUpperCase();
		if (!existsSync(upper)) return;
		expect(judge("write", join(upper, "src", "a.ts"))).toContain("would change your user's checkout");
	});

	it("leaves other tools, blank paths, and other repositories alone", () => {
		expect(blockReason("read", { path: "src/a.ts" }, repo, "s", [grant])).toBeUndefined();
		expect(blockReason("write", { path: "  " }, repo, "s", [grant])).toBeUndefined();
		expect(blockReason("write", { path: "src/a.ts" }, repo, "s", [{ ...grant, toplevel: outside }])).toBeUndefined();
		expect(blockReason("write", { path: "src/a.ts" }, repo, "s", [])).toBeUndefined();
	});

	it("blocks write/edit targeting protected .git internals through separate git dirs and worktree gitdir pointers", () => {
		const sepRepo = join(root, "sep-repo");
		const sepGitDir = join(root, "sep-gitdir");
		const sepWorktree = join(root, "sep-worktree");
		mkdirSync(sepRepo, { recursive: true });
		git(sepRepo, "init", "-q", "--separate-git-dir", sepGitDir);
		git(sepRepo, "config", "user.email", "test@example.com");
		git(sepRepo, "config", "user.name", "Test");
		writeFileSync(join(sepRepo, "README.md"), "hi\n");
		git(sepRepo, "add", ".");
		git(sepRepo, "commit", "-q", "-m", "init");
		git(sepRepo, "worktree", "add", "-q", "--detach", sepWorktree, "HEAD");
		mkdirSync(join(sepGitDir, "herder", "worktrees", "w1"), { recursive: true });
		mkdirSync(join(sepGitDir, "herder", "runs", "r1"), { recursive: true });

		const sepGrant: StandingApproval = {
			id: "sep-session",
			...repositoryOf(sepRepo)!,
			text: "Self-driving mode, granted by the user.",
			since: new Date().toISOString(),
		};
		expect(sepGrant.toplevel).toBe(sepRepo);
		expect(sepGrant.commonDir).toBe(sepGitDir);

		const protectedTargets = [
			join(sepGitDir, "config"),
			join(sepGitDir, "hooks", "pre-commit"),
			join(sepGitDir, "HEAD"),
			join(sepRepo, ".git"),
		];
		for (const target of protectedTargets) {
			for (const tool of ["write", "edit"]) {
				expect(blockReason(tool, { path: target, content: "x" }, outside, "some-session", [sepGrant])).toContain("would change your user's checkout");
			}
			// Also resolved through `<toplevel>/.git` or `<worktree>/.git` gitdir + commondir pointers even without commonDirs.
			expect(insideCheckout(target, [sepRepo])).toBe(true);
		}
		for (const target of [join(sepGitDir, "config"), join(sepGitDir, "hooks", "pre-commit"), join(sepGitDir, "HEAD")]) {
			expect(insideCheckout(target, [sepWorktree])).toBe(true);
		}

		// A dangling symlink pointing to a protected hook is also blocked.
		const danglingLink = join(outside, "hook-link");
		symlinkSync(join(sepGitDir, "hooks", "pre-commit"), danglingLink);
		try {
			expect(blockReason("write", { path: danglingLink, content: "#!/bin/sh\n" }, outside, "some-session", [sepGrant])).toContain("would change your user's checkout");
		} finally {
			rmSync(danglingLink, { force: true });
		}

		// Exempt paths under `<commonDir>/herder/{worktrees,runs}` and `<commonDir>/worktrees` remain allowed.
		const allowedTargets = [
			join(sepGitDir, "herder", "worktrees", "w1", "file.ts"),
			join(sepGitDir, "herder", "runs", "r1", "goal.md"),
			join(sepGitDir, "worktrees", "sep-worktree", "HEAD"),
			join(sepWorktree, "README.md"),
		];
		for (const target of allowedTargets) {
			for (const tool of ["write", "edit"]) {
				expect(blockReason(tool, { path: target, content: "x" }, outside, "some-session", [sepGrant])).toBeUndefined();
			}
		}
	});

	it("blocks herder_deliver only in the granting session", () => {
		expect(blockReason("herder_deliver", {}, repo, "granting-session", [grant])).toBe(
			"Blocked by self-driving mode: delivery waits for your user; record the run as proposed (selfdrive_task with its Herder run id).",
		);
		expect(blockReason("herder_deliver", {}, repo, "child-session", [grant])).toBeUndefined();
		expect(blockReason("herder_deliver", {}, repo, undefined, [grant])).toBeUndefined();
	});
});

describe("bash", () => {
	type Verdict = "allow" | "checkout" | "remote" | "system";
	const verdict = (command: string, cwd: string): Verdict => {
		const reason = bashBlockReason(command, cwd, [repo]);
		if (reason === undefined) return "allow";
		expect(reason).toMatch(/^Blocked by self-driving mode: /);
		if (reason.includes("would change your user's checkout")) return "checkout";
		if (reason.includes("leaves this machine")) return "remote";
		if (reason.includes("needs privileges or another machine")) return "system";
		throw new Error(`unexpected reason: ${reason}`);
	};
	const expand = (text: string) => text.replaceAll("REPO", repo).replaceAll("ALIAS", alias).replaceAll("OUT", outside);

	// [command, where it runs ("repo" or "out"), verdict]
	const table: [string, "repo" | "out", Verdict][] = [
		// Pushing and publishing, anywhere.
		["git push origin HEAD", "out", "remote"],
		["git -C /somewhere push", "out", "remote"],
		["cd /tmp && git push --force", "out", "remote"],
		["bash -c 'git push'", "out", "remote"],
		["echo $(git push)", "out", "remote"],
		["eval \"git push\"", "out", "remote"],
		["cat <<'EOF' | sh\ngit push\nEOF", "out", "remote"],
		["git send-email --to x 0001.patch", "out", "remote"],
		["gh pr create --title x --body y", "out", "remote"],
		["gh pr merge 12 --squash", "out", "remote"],
		["gh pr comment 12 -b hi", "out", "remote"],
		["gh pr review 12 --approve", "out", "remote"],
		["gh pr ready 12", "out", "remote"],
		["gh issue create -t x", "out", "remote"],
		["gh issue close 3", "out", "remote"],
		["gh issue edit 3 --add-label bug", "out", "remote"],
		["gh -R o/r issue reopen 3", "out", "remote"],
		["gh release create v1", "out", "remote"],
		["gh release upload v1 a.tgz", "out", "remote"],
		["gh repo create foo --public", "out", "remote"],
		["gh repo delete o/r --yes", "out", "remote"],
		["gh repo edit --visibility public", "out", "remote"],
		["gh workflow run ci.yml", "out", "remote"],
		["gh api -X POST repos/o/r/issues", "out", "remote"],
		["gh api --method=PATCH repos/o/r", "out", "remote"],
		["gh api -XDELETE repos/o/r/git/refs/heads/x", "out", "remote"],
		["gh api repos/o/r/issues -f title=x", "out", "remote"],
		["gh api repos/o/r/labels -F name=x", "out", "remote"],
		["gh api repos/o/r/issues --input body.json", "out", "remote"],
		["gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'", "out", "remote"],
		["npm publish", "out", "remote"],
		["pnpm publish --access public", "out", "remote"],
		["yarn publish", "out", "remote"],
		["yarn npm publish", "out", "remote"],
		["cargo publish --dry-run", "out", "remote"],
		["docker push registry/img:1", "out", "remote"],
		["docker image push img", "out", "remote"],
		// Privileges, other machines, system settings, anywhere.
		["sudo ls", "out", "system"],
		["FOO=1 sudo -u nobody ls", "out", "system"],
		["env FOO=1 sudo ls", "out", "system"],
		["nohup sudo true", "out", "system"],
		["su - root", "out", "system"],
		["ssh host ls", "out", "system"],
		["timeout 5 ssh host true", "out", "system"],
		["scp a.txt host:/tmp/", "out", "system"],
		["sftp host", "out", "system"],
		["rsync -av dist/ host:/srv/", "out", "system"],
		["rsync -av -e ssh dist/ user@host:/srv/", "out", "system"],
		["systemctl restart nginx", "out", "system"],
		["launchctl load x.plist", "out", "system"],
		["shutdown -h now", "out", "system"],
		["reboot", "out", "system"],
		["pmset sleepnow", "out", "system"],
		["crontab -e", "out", "system"],
		["mount /dev/disk2 /mnt", "out", "system"],
		["sysctl -w kern.maxfiles=1", "out", "system"],
		["sysctl kern.maxfiles=1", "out", "system"],
		["wrmsr 0x1a0 0", "out", "system"],
		["/usr/bin/sudo true", "out", "system"],
		// Reading and outside work stay allowed.
		["gh pr view 12", "out", "allow"],
		["gh pr list --state open", "out", "allow"],
		["gh pr diff 12", "out", "allow"],
		["gh issue view 3 --comments", "out", "allow"],
		["gh release view v1", "out", "allow"],
		["gh release list", "out", "allow"],
		["gh repo view o/r", "out", "allow"],
		["gh run list", "out", "allow"],
		["gh api repos/o/r/pulls", "out", "allow"],
		["gh api -X GET search/issues -f q=repo:o/r", "out", "allow"],
		["gh api graphql -f query='query { viewer { login } }'", "out", "allow"],
		["docker build -t x .", "out", "allow"],
		["rsync -av /tmp/a/ /tmp/b/", "out", "allow"],
		["sysctl kern.ostype", "out", "allow"],
		["git commit -m x", "out", "allow"],
		["git -C REPO status", "out", "allow"],
		["npm install", "out", "allow"],
		["echo x > OUT/log.txt && rm -rf OUT/tmp", "out", "allow"],
		["(cd REPO && git log) && git commit -m x", "out", "allow"],
		// Reading in the checkout.
		["git status && git diff && git log --oneline -5", "repo", "allow"],
		["git fetch origin", "repo", "allow"],
		["git stash list", "repo", "allow"],
		["git tag", "repo", "allow"],
		["git tag -l 'v*'", "repo", "allow"],
		["git tag --contains HEAD", "repo", "allow"],
		["git branch -a -vv", "repo", "allow"],
		["git worktree list", "repo", "allow"],
		["git worktree add .pi/workspaces/side/wt HEAD", "repo", "allow"],
		["git apply --check fix.diff", "repo", "allow"],
		["git clean -n", "repo", "allow"],
		["git add -n .", "repo", "allow"],
		["npm test && npm run build && npx vitest run", "repo", "allow"],
		["npm i -g some-tool", "repo", "allow"],
		["npm --prefix /tmp/x install", "repo", "allow"],
		["sed -n 1,5p src/a.ts", "repo", "allow"],
		["sed -i s/a/b/ /tmp/x.txt", "repo", "allow"],
		["perl -ne 'print if /a/' src/a.ts", "repo", "allow"],
		["perl -Mstrict -e 1", "repo", "allow"],
		["ls -la > /tmp/listing.txt", "repo", "allow"],
		["echo x 2>&1 >/dev/null", "repo", "allow"],
		["cat src/a.ts | tee -a /tmp/x.txt", "repo", "allow"],
		["cp src/a.ts /tmp/", "repo", "allow"],
		["rm /tmp/x.txt", "repo", "allow"],
		["mkdir -p .pi/workspaces/side/out && ls > .pi/workspaces/side/out/list.txt", "repo", "allow"],
		["echo x > nested-wt/src/a.ts && cd nested-wt && git commit -am x", "repo", "allow"],
		["git -C REPO/nested-wt commit -m x", "out", "allow"],
		["git -C REPO/.git/herder/runs/r1/wt commit -m x", "out", "allow"],
		["git -C REPO/.git/herder/worktrees/w1 commit -m x", "out", "allow"],
		["GIT_DIR=REPO/.git/herder/worktrees/w1/.git GIT_WORK_TREE=REPO/.git/herder/worktrees/w1 git commit -m x", "out", "allow"],
		["GIT_DIR=REPO/.git/worktrees/nested-wt GIT_WORK_TREE=REPO/nested-wt git commit -m x", "out", "allow"],
		["GIT_DIR=REPO/.git git status", "out", "allow"],
		["(export GIT_DIR=REPO/.git && git status) && git commit -m x", "out", "allow"],
		["export GIT_DIR=REPO/.git && unset GIT_DIR && git commit -m x", "out", "allow"],
		["export GIT_DIR=REPO/.git && env -u GIT_DIR git commit -m x", "out", "allow"],
		["git config --get user.name", "repo", "allow"],
		["git config --get core.hooksPath", "repo", "allow"],
		["git config --list", "repo", "allow"],
		["git config -l", "out", "allow"],
		["git config get user.name", "out", "allow"],
		["git config list", "out", "allow"],
		["git config user.name Test", "out", "allow"],
		["git -c user.name=Test status", "out", "allow"],
		["cd .pi/workspaces/side && npm install", "repo", "allow"],
		["echo x > .pi/workspaces/ws1/file.ts", "repo", "allow"],
		["echo x > .git/herder/worktrees/w1/file.ts", "repo", "allow"],
		["echo x > .git/herder/runs/r1/note", "repo", "allow"],
		["echo x > .git/worktrees/nested-wt/note", "repo", "allow"],
		["chmod +x .git/herder/worktrees/w1/run.sh", "repo", "allow"],
		["chmod +x .git/herder/runs/r1/scripts/check.sh", "repo", "allow"],
		["chmod +x /tmp/run.sh", "repo", "allow"],
		["git config -f /tmp/cfg user.name Test", "repo", "allow"],
		["git -C REPO/nested-wt config --worktree user.name Test", "out", "allow"],
		["git symbolic-ref HEAD", "repo", "allow"],
		["git remote -v", "repo", "allow"],
		["echo x > link-out/file.txt", "repo", "allow"],
		["find . -name '*.ts' -exec grep -l x {} +", "repo", "allow"],
		["find /tmp -name x -delete", "repo", "allow"],
		["cat <<'EOF'\ngit commit -m x\nEOF", "repo", "allow"],
		["patch --dry-run -p1 < fix.diff", "repo", "allow"],
		// Mutating git in the checkout.
		...["commit -m x", "add .", "reset --hard", "checkout main", "checkout -- src/a.ts", "switch -c x", "restore src/a.ts", "stash",
			"stash pop", "cherry-pick abc", "rebase main", "merge x", "pull", "tag v1", "tag -d v1", "branch -D x", "branch -m a b",
			"branch -f main HEAD~1", "worktree remove nested-wt", "clean -fd", "rm src/a.ts", "mv src/a.ts src/b.ts",
			"update-ref refs/heads/x HEAD", "am 0001.patch", "apply fix.diff", "revert HEAD"]
			.map((sub): [string, "repo", Verdict] => [`git ${sub}`, "repo", "checkout"]),
		["git -C REPO commit -m x", "out", "checkout"],
		["git -C REPO/src checkout .", "out", "checkout"],
		["git --work-tree=REPO checkout .", "out", "checkout"],
		["GIT_DIR=REPO/.git git commit -m x", "out", "checkout"],
		["GIT_WORK_TREE=REPO git checkout -- .", "out", "checkout"],
		["git --git-dir=REPO/.git --work-tree=REPO reset --hard", "out", "checkout"],
		["git --git-dir REPO/.git --work-tree REPO reset --hard", "out", "checkout"],
		["env GIT_DIR=REPO/.git git commit -m x", "out", "checkout"],
		["env GIT_WORK_TREE=REPO git checkout -- .", "out", "checkout"],
		["export GIT_DIR=REPO/.git && git commit -m x", "out", "checkout"],
		["export GIT_WORK_TREE=REPO && git reset --hard", "out", "checkout"],
		["GIT_DIR=REPO/.git; export GIT_DIR; git commit -m x", "out", "checkout"],
		["GIT_DIR=REPO/.git bash -c 'git commit -m x'", "out", "checkout"],
		["GIT_DIR=ALIAS/.git git commit -m x", "out", "checkout"],
		["GIT_DIR=REPO/.git/modules/sub git commit -m x", "out", "checkout"],
		["git -C REPO/.git update-ref refs/heads/main HEAD", "out", "checkout"],
		["cd REPO && git commit -m x", "out", "checkout"],
		["cd ALIAS/src && git reset --hard", "out", "checkout"],
		["bash -c 'cd REPO && git stash'", "out", "checkout"],
		["bash <<'EOF'\ngit commit -m x\nEOF", "repo", "checkout"],
		// Dangerous git config and -c / --config-env overrides, anywhere.
		["git config alias.p '!sh -c id'", "out", "system"],
		["git config --global core.hooksPath /tmp/h", "out", "system"],
		["git config core.fsmonitor /tmp/evil", "out", "system"],
		["git config core.sshCommand 'evil'", "out", "system"],
		["git config include.path /tmp/cfg", "out", "system"],
		["git config includeIf.gitdir:/tmp/.path /tmp/cfg", "out", "system"],
		["git config INCLUDEIF.gitdir:/tmp/.path /tmp/cfg", "out", "system"],
		["git config --unset core.hooksPath", "out", "system"],
		["git config --unset-all alias.p", "out", "system"],
		["git config --add core.fsmonitor /tmp/evil", "out", "system"],
		["git config --replace-all include.path /tmp/cfg", "out", "system"],
		["git config -f /tmp/cfg core.hooksPath /tmp/h", "out", "system"],
		["git config -flocal core.hooksPath /tmp/x", "out", "system"],
		["git config -e set core.hooksPath /tmp/h", "out", "system"],
		["git config set core.hooksPath /tmp/h", "out", "system"],
		["git config unset alias.p", "out", "system"],
		["git config --remove-section alias", "out", "system"],
		["git config --rename-section core other", "out", "system"],
		["git -c core.sshCommand=evil fetch", "out", "system"],
		["git -c alias.x='!id' x", "out", "system"],
		["git -c CORE.hooksPath=/tmp/h status", "out", "system"],
		["git -c include.path=/tmp/cfg status", "out", "system"],
		["git -c includeIf.gitdir:/tmp/.path=/tmp/cfg status", "out", "system"],
		["git -ccore.editor=evil status", "out", "system"],
		["git --config-env=core.sshCommand=MY_SSH fetch", "out", "system"],
		["git --config-env core.hooksPath=MY_HOOKS status", "out", "system"],
		// Narrowed .pi/ exemption: only .pi/workspaces/ is exempt.
		["echo '{}' > .pi/settings.json", "repo", "checkout"],
		["rm -f .pi/agents/foo.md", "repo", "checkout"],
		["echo x > .pi/pika/project.json", "repo", "checkout"],
		// Protected .git/ internals (outside .git/herder/{worktrees,runs} and .git/worktrees).
		["echo x > .git/config", "repo", "checkout"],
		["echo x >> .git/config", "repo", "checkout"],
		["printf '#!/bin/sh\\n' > .git/hooks/pre-commit", "repo", "checkout"],
		["echo 'ref: refs/heads/evil' > .git/HEAD", "repo", "checkout"],
		["echo x > .git/herder/note", "repo", "checkout"],
		["echo x > REPO/.git/config", "out", "checkout"],
		["echo x > ALIAS/.git/hooks/post-checkout", "out", "checkout"],
		["echo x > .git/herder/worktrees/w1/../../../config", "repo", "checkout"],
		["cp /tmp/evil .git/hooks/pre-commit", "repo", "checkout"],
		["cp -t .git/hooks /tmp/evil", "repo", "checkout"],
		["mv /tmp/evil .git/config", "repo", "checkout"],
		["mv -t .git/hooks /tmp/evil", "repo", "checkout"],
		["mv --target-directory=.git/hooks /tmp/evil", "repo", "checkout"],
		["mv .git/config /tmp/bak", "repo", "checkout"],
		["rm -f .git/HEAD", "repo", "checkout"],
		["rm -rf .git/hooks", "repo", "checkout"],
		["echo x | tee .git/config", "repo", "checkout"],
		["echo x | tee -a .git/hooks/pre-commit", "repo", "checkout"],
		["touch .git/hooks/pre-commit", "repo", "checkout"],
		["truncate -s 0 .git/config", "repo", "checkout"],
		["chmod +x .git/hooks/pre-commit", "repo", "checkout"],
		["chmod 755 .git/hooks/pre-commit", "repo", "checkout"],
		["chmod -R +x .git/hooks", "repo", "checkout"],
		["chmod -x .git/hooks/pre-commit", "repo", "checkout"],
		["chmod --reference=/tmp/ref .git/hooks/pre-commit", "repo", "checkout"],
		["sed -i 's/a/b/' .git/config", "repo", "checkout"],
		["sed -i '' 's/a/b/' .git/config", "repo", "checkout"],
		["perl -pi -e 's/a/b/' .git/config", "repo", "checkout"],
		["ln -sf /tmp/evil .git/hooks/pre-commit", "repo", "checkout"],
		["install -m 755 /tmp/evil .git/hooks/pre-commit", "repo", "checkout"],
		["dd if=/tmp/evil of=.git/config", "repo", "checkout"],
		["find .git/hooks -delete", "repo", "checkout"],
		["find .git/hooks -exec chmod +x {} \\;", "repo", "checkout"],
		["patch -d .git -p0 < /tmp/p", "repo", "checkout"],
		["rsync -a /tmp/evil .git/config", "repo", "checkout"],
		["git config user.name Evil", "repo", "checkout"],
		["git -C REPO config user.name Evil", "out", "checkout"],
		["GIT_DIR=REPO/.git git config user.name Evil", "out", "checkout"],
		["git config -f REPO/.git/config user.name Evil", "out", "checkout"],
		["git config --file=REPO/.git/config user.name Evil", "out", "checkout"],
		["git config -flocal user.name Evil", "repo", "checkout"],
		["git config -e", "repo", "checkout"],
		["git config -le", "repo", "checkout"],
		["git config set -f REPO/.git/config user.name Evil", "out", "checkout"],
		["git config --unset user.name", "repo", "checkout"],
		["git -C REPO/nested-wt config user.name Evil", "out", "checkout"],
		["git symbolic-ref HEAD refs/heads/evil", "repo", "checkout"],
		["git remote set-url origin https://evil.example/repo.git", "repo", "checkout"],
		["git -C REPO/nested-wt remote set-url origin https://evil.example/repo.git", "out", "checkout"],
		// Package installs in the checkout.
		["npm install", "repo", "checkout"],
		["npm ci", "repo", "checkout"],
		["npm i -D vitest", "repo", "checkout"],
		["npm uninstall x", "repo", "checkout"],
		["npm update", "repo", "checkout"],
		["pnpm add x", "repo", "checkout"],
		["pnpm install", "repo", "checkout"],
		["yarn", "repo", "checkout"],
		["yarn add x", "repo", "checkout"],
		["npm --prefix REPO install", "out", "checkout"],
		["pnpm -C REPO install", "out", "checkout"],
		// File writes into the checkout.
		["sed -i s/a/b/ src/a.ts", "repo", "checkout"],
		["sed -i '' 's/a/b/' src/a.ts", "repo", "checkout"],
		["sed -i.bak -e s/a/b/ src/a.ts", "repo", "checkout"],
		["sed -Ei s/a/b/ src/a.ts", "repo", "checkout"],
		["sed --in-place s/a/b/ src/a.ts", "repo", "checkout"],
		["perl -pi -e s/a/b/ src/a.ts", "repo", "checkout"],
		["perl -i.bak -pe s/a/b/ src/a.ts", "repo", "checkout"],
		["find . -type f | xargs sed -i s/a/b/", "repo", "checkout"],
		["echo x > src/a.ts", "repo", "checkout"],
		["echo x >> README.md", "repo", "checkout"],
		["printf x &> out.log", "repo", "checkout"],
		["echo x > REPO/src/a.ts", "out", "checkout"],
		["{ echo a; } > src/b.ts", "repo", "checkout"],
		["cat src/a.ts | tee out.txt", "repo", "checkout"],
		["rm -rf dist", "repo", "checkout"],
		["rm -rf ALIAS/src", "out", "checkout"],
		["mv /tmp/a.ts src/", "repo", "checkout"],
		["mv src/a.ts /tmp/", "repo", "checkout"],
		["cp /tmp/a.ts src/", "repo", "checkout"],
		["cp -t src /tmp/a.ts", "repo", "checkout"],
		["truncate -s 0 log.txt", "repo", "checkout"],
		["touch src/new.ts", "repo", "checkout"],
		["mkdir build", "repo", "checkout"],
		["ln -s /tmp/x src/x", "repo", "checkout"],
		["dd if=/dev/zero of=img bs=1 count=1", "repo", "checkout"],
		["patch -p1 < fix.diff", "repo", "checkout"],
		["find . -name '*.orig' -delete", "repo", "checkout"],
		["find . -name '*.orig' -exec rm {} \\;", "repo", "checkout"],
		["rsync -a /tmp/a/ src/", "repo", "checkout"],
		["echo x > vendor/lib/file", "repo", "checkout"],
	];

	it.each(table)("%j in %s: %s", (command, where, expected) => {
		expect(verdict(expand(command), where === "repo" ? repo : outside)).toBe(expected);
	});

	it("names what it blocked and what to do instead", () => {
		expect(bashBlockReason("git push", outside, [repo])).toBe(
			"Blocked by self-driving mode: git push leaves this machine, and that waits for your user. Leave the work in a verified Herder run and record it as proposed.",
		);
		expect(bashBlockReason("rm -rf dist", repo, [repo])).toBe(
			`Blocked by self-driving mode: rm ${join(repo, "dist")} would change your user's checkout. Make the change through a Herder run or in a worktree under .pi/workspaces/.`,
		);
		expect(bashBlockReason("sudo true", outside, [repo])).toBe(
			"Blocked by self-driving mode: sudo needs privileges or another machine, or changes system settings. Record what is needed as a question for your user (selfdrive_task with needs).",
		);
	});

	it("expands ~ and $HOME in targets", () => {
		const home = realpathSync(homedir());
		expect(bashBlockReason("echo x > ~/selfdrive-guard-x", repo, [home])).toContain("would change your user's checkout");
		expect(bashBlockReason("rm -f \"$HOME/selfdrive-guard-x\"", repo, [home])).toContain("would change your user's checkout");
	});

	it("blocks GIT_DIR/GIT_WORK_TREE targeting the checkout even from a workspace or Herder worktree", () => {
		const workspaceCwd = join(repo, ".pi", "workspaces", "side");
		const herderCwd = join(repo, ".git", "herder", "worktrees", "w1");
		for (const cwd of [outside, workspaceCwd, herderCwd]) {
			expect(bashBlockReason(`GIT_DIR=${join(repo, ".git")} git commit -m x`, cwd, [repo])).toContain("would change your user's checkout");
			expect(bashBlockReason(`GIT_WORK_TREE=${repo} git checkout -- .`, cwd, [repo])).toContain("would change your user's checkout");
			expect(bashBlockReason(`git --git-dir=${join(repo, ".git")} --work-tree=${repo} reset --hard`, cwd, [repo])).toContain("would change your user's checkout");
			expect(bashBlockReason("git -c core.sshCommand=evil fetch", cwd, [repo])).toContain("Blocked by self-driving mode:");
			expect(bashBlockReason("git config alias.p '!sh -c id'", cwd, [repo])).toContain("Blocked by self-driving mode:");
		}
	});

	it("blocks mutating bash commands targeting separate git dirs or worktree gitdir pointers while allowing exempt paths", () => {
		const bashSepRepo = join(root, "bash-sep-repo");
		const bashSepGit = join(root, "bash-sep-gitdir");
		const bashSepWt = join(root, "bash-sep-wt");
		mkdirSync(bashSepRepo, { recursive: true });
		git(bashSepRepo, "init", "-q", "--separate-git-dir", bashSepGit);
		git(bashSepRepo, "config", "user.email", "test@example.com");
		git(bashSepRepo, "config", "user.name", "Test");
		writeFileSync(join(bashSepRepo, "a.txt"), "1\n");
		git(bashSepRepo, "add", ".");
		git(bashSepRepo, "commit", "-q", "-m", "init");
		git(bashSepRepo, "worktree", "add", "-q", "--detach", bashSepWt, "HEAD");
		mkdirSync(join(bashSepGit, "herder", "worktrees", "w1"), { recursive: true });
		mkdirSync(join(bashSepGit, "herder", "runs", "r1"), { recursive: true });

		for (const cmd of [
			`echo bad > "${join(bashSepGit, "config")}"`,
			`chmod +x "${join(bashSepGit, "hooks", "pre-commit")}"`,
			`rm -f "${join(bashSepGit, "HEAD")}"`,
			`sed -i 's/a/b/' "${join(bashSepGit, "config")}"`,
			`git config -f "${join(bashSepGit, "config")}" user.name Evil`,
		]) {
			// Resolved via commonDirs, via separate-git-dir `.git` pointer, and via worktree `.git` + commondir pointers.
			expect(bashBlockReason(cmd, outside, [bashSepRepo], [bashSepGit])).toContain("would change your user's checkout");
			expect(bashBlockReason(cmd, outside, [bashSepRepo])).toContain("would change your user's checkout");
			expect(bashBlockReason(cmd, outside, [bashSepWt])).toContain("would change your user's checkout");
		}

		for (const cmd of [
			`echo ok > "${join(bashSepGit, "herder", "worktrees", "w1", "file.ts")}"`,
			`echo ok > "${join(bashSepGit, "herder", "runs", "r1", "goal.md")}"`,
			`echo ok > "${join(bashSepGit, "worktrees", "bash-sep-wt", "HEAD")}"`,
		]) {
			expect(bashBlockReason(cmd, outside, [bashSepRepo], [bashSepGit])).toBeUndefined();
			expect(bashBlockReason(cmd, outside, [bashSepRepo])).toBeUndefined();
		}
	});

	it("fails closed on unparseable or malformed shell syntax", () => {
		for (const bad of ["echo \"unterminated", "if then fi )", "echo $(if then fi)", "bash -c 'echo \"unterminated'"]) {
			expect(bashBlockReason(bad, outside, [repo])).toBe(reasons.analysis);
		}
	});

	it("fails closed when command analysis throws unexpectedly", () => {
		const savedParse = guardRuntime.parse;
		guardRuntime.parse = () => {
			throw new Error("boom");
		};
		try {
			expect(bashBlockReason("echo ok", outside, [repo])).toBe(reasons.analysis);
		} finally {
			guardRuntime.parse = savedParse;
		}
	});

	it("fails closed when nested shell inspection exceeds depth 8", () => {
		const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		const nest = (inner: string, levels: number): string => {
			let cmd = inner;
			for (let i = 0; i < levels; i++) cmd = `bash -c ${sq(cmd)}`;
			return cmd;
		};
		expect(bashBlockReason(nest("echo ok", 8), outside, [repo])).toBeUndefined();
		expect(bashBlockReason(nest("git push", 8), outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason(nest("echo ok", 9), outside, [repo])).toBe(reasons.nesting);

		// Also fail closed when depth is exceeded via stdin redirection into a local shell.
		const nineWithStdin = nest("bash <<< 'echo ok'", 8);
		expect(bashBlockReason(nineWithStdin, outside, [repo])).toBe(reasons.nesting);

		// Also fail closed when depth is exceeded via env -S.
		const nineWithEnvSplit = nest("env -S 'echo ok'", 8);
		expect(bashBlockReason(nineWithEnvSplit, outside, [repo])).toBe(reasons.nesting);
	});

	it("parses env -S / --split-string with trailing arguments and fails closed on malformed syntax", () => {
		// Remote / system / checkout mutations across -S, attached -S, --split-string=, and --split-string.
		expect(bashBlockReason("env -S 'git' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'rm -rf' src/a.ts", repo, [repo])).toBe(reasons.checkout(`rm ${join(repo, "src", "a.ts")}`));
		expect(bashBlockReason("env --split-string='git push' origin main", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env --split-string 'git push' origin main", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S'git push' origin main", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -iS'git' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'git\\_push' origin main", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'git\\c ignored' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'git # comment' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S '' git push", outside, [repo])).toBe(reasons.remote("git push"));

		// Quoted arguments inside -S combined with trailing arguments, env options, and assignments.
		expect(bashBlockReason(`env -S 'git -C "${repo}"' commit -m x`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason("env -S \"rm -rf 'src/a.ts'\" /tmp/other", repo, [repo])).toBe(reasons.checkout(`rm ${join(repo, "src", "a.ts")}`));
		expect(bashBlockReason("env -S 'sed -i \"\" s/a/b/' src/a.ts", repo, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`env -S 'GIT_DIR=${repo}/.git git' commit -m x`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`env -S '-C "${repo}" rm -rf' src/a.ts`, outside, [repo])).toBe(reasons.checkout(`rm ${join(repo, "src", "a.ts")}`));
		expect(bashBlockReason("env -S 'sh -c' 'git push'", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'sh' <<< 'git push'", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("CMD=push env -S 'git ${CMD}'", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("CMD=push env -i -S 'git ${CMD}'", outside, [repo])).toBe(reasons.remote("git push"));

		// Protected .git internals and exemptions remain enforced through env -S.
		expect(bashBlockReason("env -S 'chmod +x' .git/hooks/pre-commit", repo, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason("env -S 'rm -rf' .git/herder/runs/r1/note", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("env -S 'rm -rf' .git/herder/worktrees/w1/file.ts", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("env -S 'rm -rf' .git/worktrees/nested-wt/note", repo, [repo])).toBeUndefined();

		// Safe env -S commands remain allowed.
		expect(bashBlockReason("env -S 'echo \"hello world\"' trailing", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("env -S 'git' status", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("env -S 'rm -rf' /tmp/safe-target", outside, [repo])).toBeUndefined();
		expect(bashBlockReason("export GIT_DIR=" + join(repo, ".git") + " && env -S '-u GIT_DIR git' commit -m x", outside, [repo])).toBeUndefined();

		// Malformed env -S syntax and missing/unknown options fail closed.
		for (const malformed of [
			"env -S 'echo \"unterminated' foo",
			"env -S \"echo 'unterminated\" foo",
			"env -S 'git\\' push",
			"env -S 'echo \\x' foo",
			"env -S 'echo \"a\\cb\"' foo",
			"env -S 'echo $HOME'",
			"env -S 'echo ${UNTERM'",
			"env -S 'echo ${}'",
			"env -S",
			"env --split-string",
			"env --unknown-flag echo ok",
		]) {
			expect(bashBlockReason(malformed, outside, [repo]), malformed).toBe(reasons.analysis);
		}
	});

	it("unwraps exec options including -a <argv0>, -c, -l, and -- and fails closed on malformed options", () => {
		expect(bashBlockReason("exec -a fake git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -a fake -- rm -rf src/a.ts", repo, [repo])).toBe(reasons.checkout(`rm ${join(repo, "src", "a.ts")}`));
		expect(bashBlockReason("exec -c -l -a fake git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -- git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -afake git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -cla fake git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -clafake git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -a '' git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -a -- git push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -a fake -l git push", outside, [repo])).toBe(reasons.remote("git push"));

		// Chained wrappers and stdin shells through exec -a.
		expect(bashBlockReason("exec -a fake env -S 'git' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("env -S 'exec -a fake git' push", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("exec -a fake sh <<< 'git push'", outside, [repo])).toBe(reasons.remote("git push"));
		expect(bashBlockReason("cat <<'EOF' | exec -a fake sh\ngit push\nEOF", outside, [repo])).toBe(reasons.remote("git push"));

		// Protected .git internals and exemptions remain enforced through exec -a.
		expect(bashBlockReason("exec -a fake chmod +x .git/hooks/pre-commit", repo, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason("exec -a fake rm -rf .git/herder/worktrees/w1/file.ts", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("exec -a fake rm -rf .git/herder/runs/r1/note", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("exec -a fake rm -rf .git/worktrees/nested-wt/note", repo, [repo])).toBeUndefined();

		// Safe exec commands remain allowed, and -c clears inherited env.
		expect(bashBlockReason("exec -a fake echo ok", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("exec -c -l -a fake -- echo ok", repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`export GIT_DIR=${repo}/.git && exec -c git commit -m x`, outside, [repo])).toBeUndefined();

		// Malformed exec options fail closed.
		for (const malformed of [
			"exec -a",
			"exec -cla",
			"exec -z echo ok",
			"exec --unknown echo ok",
		]) {
			expect(bashBlockReason(malformed, outside, [repo]), malformed).toBe(reasons.analysis);
		}
	});

	it("propagates effective cwd through env -C / --chdir into wrapped commands, nested shells, and heredocs", () => {
		const workspaceCwd = join(repo, ".pi", "workspaces", "side");
		const nestedWtCwd = join(repo, "nested-wt");
		const herderWtCwd = join(repo, ".git", "herder", "worktrees", "w1");

		// Blocked: env -C / --chdir into the protected checkout propagates into nested shells, heredocs, and commands.
		expect(bashBlockReason(`env -C "${repo}" sh -c 'echo x > src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env --chdir="${repo}" bash -c 'rm -f src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env --chdir "${repo}" sh -c 'git commit -m x'`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`env -C"${repo}" sh -c 'echo x > .git/config'`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, ".git", "config")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" sh <<'EOF'\necho x > src/a.ts\nEOF`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env --chdir="${repo}" bash <<< 'rm -f src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`cat <<'EOF' | env --chdir "${repo}" sh\necho x > src/a.ts\nEOF`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -S '-C "${repo}" sh -c' 'echo x > src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -S '--chdir=${repo} sh' <<< 'echo x > src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" env -C src sh -c 'rm -f a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${outside}" -C "${repo}" sh -c 'rm -f src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${alias}" sh -c 'echo x > src/a.ts'`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" sh -c 'echo x > src/a.ts' > safe.txt`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C .pi/workspaces/side sh -c 'echo x > notes.md' > src/a.ts`, repo, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C .pi/workspaces/side sh -c 'echo ok'; echo x > src/a.ts`, repo, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" find src -execdir rm a.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" find src -exec rm {} \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src")}`),
		);

		// Allowed: env -C / --chdir into exempt workspaces or read-only commands in the checkout.
		expect(bashBlockReason(`env -C "${workspaceCwd}" sh -c 'echo x > notes.md'`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`env --chdir="${workspaceCwd}" bash <<'EOF'\necho x > notes.md\nEOF`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`env --chdir "${herderWtCwd}" sh <<< 'rm -f file.ts'`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`cat <<'EOF' | env -C "${nestedWtCwd}" sh\necho x > src/a.ts\nEOF`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`env -C "${repo}" -C "${workspaceCwd}" sh -c 'rm -f notes.md'`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`env -C "${repo}" sh -c 'echo ok'; echo x > local.txt`, outside, [repo])).toBeUndefined();
		expect(bashBlockReason(`env -C "${repo}" sh -c 'git status'`, outside, [repo])).toBeUndefined();
	});

	it("propagates effective directory for find -execdir and -okdir into executed command checks", () => {
		// Blocked: -execdir / -okdir targeting the protected checkout or its ancestors.
		expect(bashBlockReason(`find "${repo}" -name '*.ts' -execdir sh -c 'echo x > a.ts' \\;`, outside, [repo])).toContain(
			"would change your user's checkout",
		);
		expect(bashBlockReason(`find "${repo}/src" -name '*.ts' -execdir rm a.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/src" -name '*.ts' -okdir rm a.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/src" -name '*.ts' -okdir sh -c 'echo x > a.ts' \\;`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/src" -execdir sh -c 'cat <<EOF > a.ts\nbad\nEOF' \\;`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/src" -execdir bash -c 'sh <<EOF\necho x > a.ts\nEOF' \\;`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}" -execdir git commit -m x \\;`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`find "${repo}" -execdir npm install \\;`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`find "${repo}/src" -execdir sed -i 's/a/b/' {} \\;`, outside, [repo])).toContain("would change your user's checkout");
		expect(bashBlockReason(`find "${repo}/src/a.ts" -execdir rm {} \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/src/a.ts" -execdir rm b.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "b.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}/.git/hooks" -execdir chmod +x pre-commit \\;`, outside, [repo])).toBe(
			reasons.checkout(`chmod ${join(repo, ".git", "hooks", "pre-commit")}`),
		);
		expect(bashBlockReason(`find "${alias}" -execdir sh -c 'echo x > src/a.ts' \\;`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${outside}" "${repo}/src" -execdir rm a.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find -L "${repo}/src" -execdir rm a.ts \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("find .. -name '*.ts' -execdir rm a.ts \\;", outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "a.ts")}`),
		);
		expect(bashBlockReason(`find "${repo}" -execdir sh -c 'echo x > ../a.ts' \\;`, outside, [repo])).toBe(
			reasons.checkout(`a redirection to ${join(repo, "a.ts")}`),
		);
		expect(bashBlockReason("find .pi/workspaces/side -execdir rm ../../../src/a.ts \\;", repo, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`find "${outside}" "${repo}/src" -exec rm {} \\;`, outside, [repo])).toBe(
			reasons.checkout(`rm ${join(repo, "src")}`),
		);
		expect(bashBlockReason(`find "${repo}" -exec cp {} {}.bak \\;`, outside, [repo])).toContain("would change your user's checkout");

		// Allowed: -execdir / -okdir in exempt workspaces, outside paths, or read-only commands.
		expect(bashBlockReason("find .pi/workspaces/side -execdir sh -c 'echo x > notes.md' \\;", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("find .pi/workspaces/side -okdir rm notes.md \\;", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("find nested-wt -execdir sed -i 's/a/b/' src/a.ts \\;", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("find .git/herder/worktrees/w1 -execdir rm file.ts \\;", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("find link-out -execdir sh -c 'echo x > a.ts' \\;", repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`find "${outside}" -execdir rm a.ts \\;`, repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`find "${repo}" -execdir grep -l a {} +`, outside, [repo])).toBeUndefined();
		expect(bashBlockReason("find .. -execdir grep -l a {} +", outside, [repo])).toBeUndefined();
	});

	it("parses sed -i --expression=/--file= options and distinguishes dot-prefixed paths from backup suffixes", () => {
		const workspaceCwd = join(repo, ".pi", "workspaces", "side");
		const nestedWtSrcCwd = join(repo, "nested-wt", "src");

		// Blocked: --expression=/--expression and --file=/--file must not drop positional targets.
		expect(bashBlockReason(`sed -i --expression='s/a/b/' "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed -i --expression 's/a/b/' "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed -i --file=/tmp/script.sed "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed -i --file /tmp/script.sed "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed -i --expression='s/a/b/' "${repo}/src/a.ts" /tmp/other.txt`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed -i --file=/tmp/script.sed "${repo}/src/a.ts" /tmp/other.txt`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed --in-place --expression='s/a/b/' "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`sed --in-place=.bak --file=/tmp/script.sed "${repo}/src/a.ts"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);

		// Blocked: dot-prefixed paths with path separators (and lone dotfiles) must not be swallowed as backup suffixes.
		expect(bashBlockReason("sed -e 's/a/b/' -i ../../src/a.ts", nestedWtSrcCwd, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed --expression='s/a/b/' -i ../../src/a.ts", nestedWtSrcCwd, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed --file=/tmp/script.sed -i ../../src/a.ts", nestedWtSrcCwd, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i ../../../src/a.ts", workspaceCwd, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i .git/config", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, ".git", "config")}`),
		);
		expect(bashBlockReason("sed --expression='s/a/b/' -i .git/config", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, ".git", "config")}`),
		);
		expect(bashBlockReason("sed --file=/tmp/script.sed -i .git/config", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, ".git", "config")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i ./src/a.ts", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i ../repo/src/a.ts", outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i .bak ../../src/a.ts", nestedWtSrcCwd, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason("sed -e 's/a/b/' -i .gitignore", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, ".gitignore")}`),
		);
		expect(bashBlockReason("sed -Ei '' 's/a/b/' src/a.ts", repo, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, "src", "a.ts")}`),
		);
		expect(bashBlockReason(`env -C "${repo}" sh -c "sed --expression='s/a/b/' -i .git/config"`, outside, [repo])).toBe(
			reasons.checkout(`sed -i ${join(repo, ".git", "config")}`),
		);

		// Allowed: exempt workspaces, outside targets, script files read from checkout, and BSD backup suffixes.
		expect(bashBlockReason("sed -i --expression='s/a/b/' .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -i --expression 's/a/b/' .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -i --file=/tmp/script.sed .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -i --file /tmp/script.sed .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason(`sed -i --file="${repo}/script.sed" /tmp/safe.txt`, outside, [repo])).toBeUndefined();
		expect(bashBlockReason(`sed -i --file "${repo}/script.sed" /tmp/safe.txt`, outside, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -e 's/a/b/' -i ./.pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -e 's/a/b/' -i .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -e 's/a/b/' -i ../outside/ok.txt", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -i .bak 's/a/b/' .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -e 's/a/b/' -i .bak .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -Ei '' 's/a/b/' .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -Ei .bak 's/a/b/' .pi/workspaces/side/notes.md", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("sed --expression='s/a/b/' -i ./notes.md", workspaceCwd, [repo])).toBeUndefined();
		expect(bashBlockReason("sed -e 's/a/b/' -i .gitignore", workspaceCwd, [repo])).toBeUndefined();
	});
});

describe("process_start", () => {
	const judge = (command: string, cwd: string, processCwd?: string) =>
		blockReason("process_start", { command, ...(processCwd === undefined ? {} : { cwd: processCwd }) }, cwd, "some-session", [grant]);

	it.each([
		["git push origin HEAD", "out"],
		["npm publish", "out"],
		["sudo ls", "out"],
		["ssh host ls", "out"],
		["echo x > src/a.ts", "repo"],
		["npm install", "repo"],
		["echo x > .git/config", "repo"],
		["chmod +x .git/hooks/pre-commit", "repo"],
		["cp /tmp/evil .git/hooks/pre-commit", "repo"],
		["rm -f .git/HEAD", "repo"],
		["sed -i 's/a/b/' .git/config", "repo"],
		["git config user.name Evil", "repo"],
	] as const)("blocks %j in %s with bash's reason", (command, where) => {
		const cwd = where === "repo" ? repo : outside;
		const reason = judge(command, cwd);
		expect(reason).toMatch(/^Blocked by self-driving mode: /);
		expect(reason).toBe(bashBlockReason(command, cwd, [repo], [join(repo, ".git")]));
	});

	it("blocks protected .git internals resolved through commonDirs and allows exempt git paths", () => {
		const externalCommonDir = join(root, "proc-common-git");
		mkdirSync(join(externalCommonDir, "herder", "worktrees", "w1"), { recursive: true });
		mkdirSync(join(externalCommonDir, "herder", "runs", "r1"), { recursive: true });
		mkdirSync(join(externalCommonDir, "worktrees", "wt1"), { recursive: true });
		const externalGrant: StandingApproval = { ...grant, commonDir: externalCommonDir };

		for (const command of [
			`echo bad > "${join(externalCommonDir, "config")}"`,
			`chmod +x "${join(externalCommonDir, "hooks", "pre-commit")}"`,
			`rm -f "${join(externalCommonDir, "HEAD")}"`,
		]) {
			expect(blockReason("process_start", { command }, outside, "some-session", [externalGrant])).toContain("would change your user's checkout");
		}
		for (const command of [
			`echo ok > "${join(externalCommonDir, "herder", "worktrees", "w1", "file.ts")}"`,
			`echo ok > "${join(externalCommonDir, "herder", "runs", "r1", "goal.md")}"`,
			`echo ok > "${join(externalCommonDir, "worktrees", "wt1", "HEAD")}"`,
		]) {
			expect(blockReason("process_start", { command }, outside, "some-session", [externalGrant])).toBeUndefined();
		}
	});

	it("judges the command in its cwd, relative to the session's", () => {
		expect(judge("echo x > log.txt", repo, "src")).toBe(bashBlockReason("echo x > log.txt", join(repo, "src"), [repo]));
		expect(judge("echo x > log.txt", repo, "src")).toContain(join(repo, "src", "log.txt"));
		expect(judge("npm install", repo, ".pi/workspaces/side")).toBeUndefined();
		expect(judge("npm install", repo, "nested-wt")).toBeUndefined();
	});

	it("allows what bash allows", () => {
		expect(judge("npm run dev", repo)).toBeUndefined();
		expect(judge("npm install", outside)).toBeUndefined();
	});

	it("blocks through the hook while a grant exists, and stands aside without one", () => {
		let hook: ((event: { toolName: string; input: unknown }, ctx: { cwd: string }) => unknown) | undefined;
		registerGuard({ on: (_event: string, handler: typeof hook) => void (hook = handler) } as unknown as ExtensionAPI);
		const commands = ["git push", "npm publish", "sudo ls", "ssh host ls", "echo x > src/a.ts"];
		const call = (command: string) => hook!({ toolName: "process_start", input: { command } }, { cwd: repo });

		publishGrant(grant);
		for (const command of commands) expect(call(command)).toEqual({ block: true, reason: bashBlockReason(command, repo, [repo]) });
		expect(call("npm run dev")).toBeUndefined();

		withdrawGrant(grant.id);
		for (const command of commands) expect(call(command)).toBeUndefined();
	});
});

describe("agent_browser and agent_desktop", () => {
	const judgeBrowser = (input: Record<string, unknown>, cwd = repo, active = [grant]) =>
		blockReason("agent_browser", input, cwd, "some-session", active);
	const judgeDesktop = (input: Record<string, unknown>, cwd = repo, active = [grant]) =>
		blockReason("agent_desktop", input, cwd, "some-session", active);

	it("blocks agent_browser writes into the protected checkout and .git internals", () => {
		const cases: Array<[string, Record<string, unknown>, string, string]> = [
			["screenshot relative path", { argv: ["screenshot", "src/shot.png"] }, repo, join(repo, "src", "shot.png")],
			["screenshot with selector value flag", { argv: ["screenshot", "--selector", ".hero", "src/hero.png"] }, repo, join(repo, "src", "hero.png")],
			["screenshot with --output", { argv: ["screenshot", "--output", "src/out.png"] }, repo, join(repo, "src", "out.png")],
			["screenshot with -o", { argv: ["screenshot", "-o", "src/out.png"] }, repo, join(repo, "src", "out.png")],
			["screenshot with --output=", { argv: ["screenshot", "--output=src/out.png"] }, repo, join(repo, "src", "out.png")],
			["screenshot after --", { argv: ["screenshot", "--", "-shot.png"] }, repo, join(repo, "-shot.png")],
			["pdf with global --session", { argv: ["--session", "s1", "pdf", "src/out.pdf"] }, repo, join(repo, "src", "out.pdf")],
			["state save", { argv: ["state", "save", "src/auth.json"] }, repo, join(repo, "src", "auth.json")],
			["trace start", { argv: ["trace", "start", "src/trace.zip"] }, repo, join(repo, "src", "trace.zip")],
			["trace stop", { argv: ["trace", "stop", "src/trace.zip"] }, repo, join(repo, "src", "trace.zip")],
			["record start", { argv: ["record", "start", "src/demo.webm"] }, repo, join(repo, "src", "demo.webm")],
			["record restart", { argv: ["record", "restart", "src/demo.webm"] }, repo, join(repo, "src", "demo.webm")],
			["download selector + path", { argv: ["download", "@e1", "src/file.zip"] }, repo, join(repo, "src", "file.zip")],
			["download single path", { argv: ["download", "src/file.zip"] }, repo, join(repo, "src", "file.zip")],
			["global --profile", { argv: ["--profile", "src/prof", "open", "https://example.com"] }, repo, join(repo, "src", "prof")],
			["global --profile=", { argv: ["--profile=src/prof", "open", "https://example.com"] }, repo, join(repo, "src", "prof")],
			["global --download-path", { argv: ["--download-path", "src/dl", "open", "https://example.com"] }, repo, join(repo, "src", "dl")],
			["global --download-path=", { argv: ["open", "https://example.com", "--download-path=src/dl"] }, repo, join(repo, "src", "dl")],
			["tool cwd inside checkout", { argv: ["screenshot", "shot.png"], cwd: "src" }, repo, join(repo, "src", "shot.png")],
			["tool cwd targeting repo from outside", { argv: ["pdf", "out.pdf"], cwd: repo }, outside, join(repo, "out.pdf")],
			["climbing out of exempt workspace", { argv: ["screenshot", "../../../src/shot.png"], cwd: ".pi/workspaces/side" }, repo, join(repo, "src", "shot.png")],
			["symlink alias to checkout", { argv: ["screenshot", join(alias, "src", "shot.png")] }, outside, join(repo, "src", "shot.png")],
			["protected .git internal", { argv: ["state", "save", ".git/config"] }, repo, join(repo, ".git", "config")],
		];

		for (const [_label, input, cwd, expectedTarget] of cases) {
			expect(judgeBrowser(input, cwd)).toBe(reasons.checkout(`agent_browser ${expectedTarget}`));
		}
	});

	it("allows agent_browser read-only commands and writes to exempt workspaces or /tmp", () => {
		const allowed: Array<[Record<string, unknown>, string]> = [
			[{ argv: ["open", "https://example.com"] }, repo],
			[{ argv: ["snapshot", "-i"] }, repo],
			[{ argv: ["click", "@e1"] }, repo],
			[{ argv: ["fill", "@e2", "hello"] }, repo],
			[{ argv: ["state", "load", "src/auth.json"] }, repo],
			[{ argv: ["record", "stop"] }, repo],
			[{ argv: ["close"] }, repo],
			[{ argv: ["screenshot"] }, repo],
			[{ argv: ["screenshot", "--full"] }, repo],
			[{ argv: ["screenshot", "--selector", ".hero"] }, repo],
			[{ argv: ["screenshot", "--help", "src/shot.png"] }, repo],
			[{ argv: ["screenshot", ".pi/workspaces/side/shot.png"] }, repo],
			[{ argv: ["screenshot", "nested-wt/shot.png"] }, repo],
			[{ argv: ["screenshot", ".git/herder/worktrees/w1/shot.png"] }, repo],
			[{ argv: ["screenshot", "link-out/shot.png"] }, repo],
			[{ argv: ["screenshot", "/tmp/agent-browser-shot.png"] }, repo],
			[{ argv: ["screenshot", "shot.png"], cwd: ".pi/workspaces/side" }, repo],
			[{ argv: ["pdf", "out.pdf"], cwd: outside }, repo],
			[{ argv: ["--profile", "/tmp/ab-profile", "open", "https://example.com"] }, repo],
			[{ argv: ["--download-path=.pi/workspaces/side/dl", "open", "https://example.com"] }, repo],
		];

		for (const [input, cwd] of allowed) {
			expect(judgeBrowser(input, cwd)).toBeUndefined();
		}
	});

	it("blocks agent_desktop writes into the protected checkout and .git internals", () => {
		const cases: Array<[string, Record<string, unknown>, string, string]> = [
			["screenshot positional before flags", { argv: ["screenshot", "src/notes.png", "--app", "Notes"] }, repo, join(repo, "src", "notes.png")],
			["screenshot positional after value flags", { argv: ["screenshot", "--app", "Notes", "--region", "0,0,100,100", "src/notes.png"] }, repo, join(repo, "src", "notes.png")],
			["screenshot --output", { argv: ["screenshot", "--output", "src/notes.png", "--app", "Notes"] }, repo, join(repo, "src", "notes.png")],
			["screenshot --output=", { argv: ["screenshot", "--output=src/notes.png"] }, repo, join(repo, "src", "notes.png")],
			["screenshot -o", { argv: ["screenshot", "-o", "src/notes.png"] }, repo, join(repo, "src", "notes.png")],
			["global --screenshot", { argv: ["--screenshot", "src/snap.png", "snapshot"] }, repo, join(repo, "src", "snap.png")],
			["global --screenshot=", { argv: ["--screenshot=src/snap.png", "snapshot"] }, repo, join(repo, "src", "snap.png")],
			["trailing --screenshot on click", { argv: ["click", "@s1:e1", "--screenshot", "src/after.png"] }, repo, join(repo, "src", "after.png")],
			["global --trace", { argv: ["--trace", "src/trace.jsonl", "click", "@s1:e1"] }, repo, join(repo, "src", "trace.jsonl")],
			["global --trace=", { argv: ["--trace=src/trace.jsonl", "click", "@s1:e1"] }, repo, join(repo, "src", "trace.jsonl")],
			["trace export default cwd in checkout", { argv: ["trace", "export"] }, repo, repo],
			["trace export --out", { argv: ["trace", "export", "--out", "src/trace.html"] }, repo, join(repo, "src", "trace.html")],
			["trace export --out=", { argv: ["trace", "export", "--out=src/trace.html"] }, repo, join(repo, "src", "trace.html")],
			["tool cwd relative to repo", { argv: ["screenshot", "shot.png"], cwd: "src" }, repo, join(repo, "src", "shot.png")],
			["tool @-prefixed cwd", { argv: ["screenshot", "shot.png"], cwd: "@src" }, repo, join(repo, "src", "shot.png")],
			["tool cwd=none falls back to session repo", { argv: ["screenshot", "shot.png"], cwd: "none" }, repo, join(repo, "shot.png")],
			["climbing out of exempt workspace", { argv: ["screenshot", "../../../src/shot.png"], cwd: ".pi/workspaces/side" }, repo, join(repo, "src", "shot.png")],
			["symlink alias to checkout", { argv: ["screenshot", join(alias, "src", "shot.png")] }, outside, join(repo, "src", "shot.png")],
			["protected .git internal", { argv: ["--trace", ".git/config", "snapshot"] }, repo, join(repo, ".git", "config")],
			["headed: true when also writing file into checkout", { argv: ["click", "@s1:e1", "--screenshot", "src/headed.png"], headed: true }, repo, join(repo, "src", "headed.png")],
		];

		for (const [_label, input, cwd, expectedTarget] of cases) {
			expect(judgeDesktop(input, cwd)).toBe(reasons.checkout(`agent_desktop ${expectedTarget}`));
		}
	});

	it("allows agent_desktop read-only calls, headed GUI mutations without checkout writes, and exempt writes", () => {
		const allowed: Array<[Record<string, unknown>, string]> = [
			[{ argv: ["status"] }, repo],
			[{ argv: ["snapshot", "-i", "--app", "Finder"] }, repo],
			[{ argv: ["list-windows"] }, repo],
			[{ argv: ["get", "@s1:e1"] }, repo],
			[{ argv: ["click", "@s1:e1"] }, repo],
			[{ argv: ["type", "@s1:e1", "hello"] }, repo],
			[{ argv: ["session", "end"] }, repo],
			[{ argv: ["screenshot"] }, repo],
			[{ argv: ["screenshot", "--app", "Notes"] }, repo],
			[{ argv: ["screenshot", "--help", "src/shot.png"] }, repo],
			[{ argv: ["trace", "export", "--help"] }, repo],
			// Non-file-writing headed GUI mutations are explicitly out of scope and allowed.
			[{ argv: ["hover", "@s1:e1"], headed: true }, repo],
			[{ argv: ["drag", "@s1:e1", "@s1:e2"], headed: true }, repo],
			[{ argv: ["mouse-click", "100", "200"], headed: true }, repo],
			// Exempt workspace and /tmp writes are allowed.
			[{ argv: ["screenshot", ".pi/workspaces/side/shot.png"] }, repo],
			[{ argv: ["screenshot", "nested-wt/shot.png"] }, repo],
			[{ argv: ["screenshot", ".git/herder/worktrees/w1/shot.png"] }, repo],
			[{ argv: ["screenshot", "link-out/shot.png"] }, repo],
			[{ argv: ["screenshot", "/tmp/agent-desktop-shot.png"] }, repo],
			[{ argv: ["screenshot", "shot.png"], cwd: ".pi/workspaces/side" }, repo],
			[{ argv: ["screenshot", "shot.png"], cwd: "@.pi/workspaces/side" }, repo],
			[{ argv: ["trace", "export", "--out", "/tmp/trace.html"] }, repo],
			[{ argv: ["trace", "export"], cwd: ".pi/workspaces/side" }, repo],
			[{ argv: ["trace", "export"], cwd: outside }, repo],
			[{ argv: ["--trace", "/tmp/trace.jsonl", "click", "@s1:e1"] }, repo],
		];

		for (const [input, cwd] of allowed) {
			expect(judgeDesktop(input, cwd)).toBeUndefined();
		}
	});

	it("blocks agent_browser and agent_desktop checkout writes through the tool_call hook while a grant exists", () => {
		let hook: ((event: { toolName: string; input: unknown }, ctx: { cwd: string }) => unknown) | undefined;
		registerGuard({ on: (_event: string, handler: typeof hook) => void (hook = handler) } as unknown as ExtensionAPI);

		publishGrant(grant);
		expect(hook!({ toolName: "agent_browser", input: { argv: ["screenshot", "src/a.png"] } }, { cwd: repo })).toEqual({
			block: true,
			reason: reasons.checkout(`agent_browser ${join(repo, "src", "a.png")}`),
		});
		expect(hook!({ toolName: "agent_desktop", input: { argv: ["screenshot", "src/b.png"] } }, { cwd: repo })).toEqual({
			block: true,
			reason: reasons.checkout(`agent_desktop ${join(repo, "src", "b.png")}`),
		});
		expect(hook!({ toolName: "agent_browser", input: { argv: ["snapshot", "-i"] } }, { cwd: repo })).toBeUndefined();
		expect(hook!({ toolName: "agent_desktop", input: { argv: ["hover", "@s1:e1"], headed: true } }, { cwd: repo })).toBeUndefined();

		withdrawGrant(grant.id);
		expect(hook!({ toolName: "agent_browser", input: { argv: ["screenshot", "src/a.png"] } }, { cwd: repo })).toBeUndefined();
		expect(hook!({ toolName: "agent_desktop", input: { argv: ["screenshot", "src/b.png"] } }, { cwd: repo })).toBeUndefined();
	});

	it("enforces remote and system guards with an empty repo list when selfdrive is active in session-modes without a git grant", () => {
		let hook: ((event: { toolName: string; input: unknown }, ctx: { cwd: string }) => unknown) | undefined;
		registerGuard({ on: (_event: string, handler: typeof hook) => void (hook = handler) } as unknown as ExtensionAPI);
		const shared = globalThis as Record<symbol, unknown>;

		// No grant and no session-modes registry: guard stands aside without creating the registry.
		expect(hook!({ toolName: "bash", input: { command: "git push" } }, { cwd: outside })).toBeUndefined();
		expect(SESSION_MODES_KEY in shared).toBe(false);

		// Another session mode alone (e.g. swarm) does not activate the selfdrive guard.
		const modes = new Map<string, Set<string>>([["swarm-only", new Set(["swarm"])]]);
		shared[SESSION_MODES_KEY] = { modes, listeners: new Set() };
		expect(hook!({ toolName: "bash", input: { command: "git push" } }, { cwd: outside })).toBeUndefined();
		expect(hook!({ toolName: "bash", input: { command: "sudo ls" } }, { cwd: outside })).toBeUndefined();

		// Active non-git selfdrive session (no standing grant): remote and system guards run with an empty repo list.
		modes.set("non-git-session", new Set(["selfdrive"]));
		expect(grants()).toEqual([]);
		for (const cmd of ["git push", "gh pr create", "npm publish"]) {
			expect(hook!({ toolName: "bash", input: { command: cmd } }, { cwd: outside }), cmd).toEqual({
				block: true,
				reason: expect.stringContaining("leaves this machine"),
			});
		}
		for (const cmd of ["sudo ls", "ssh host ls", "systemctl restart foo"]) {
			expect(hook!({ toolName: "bash", input: { command: cmd } }, { cwd: outside }), cmd).toEqual({
				block: true,
				reason: expect.stringContaining("needs privileges or another machine"),
			});
		}
		expect(hook!({ toolName: "process_start", input: { command: "git push", cwd: outside } }, { cwd: outside })).toEqual({
			block: true,
			reason: reasons.remote("git push"),
		});
		expect(hook!({ toolName: "process_start", input: { command: "sudo ls", cwd: outside } }, { cwd: outside })).toEqual({
			block: true,
			reason: reasons.system("sudo"),
		});
		// Empty repo list: local writes and non-remote/system commands are allowed.
		expect(hook!({ toolName: "write", input: { path: join(outside, "notes.txt"), content: "ok\n" } }, { cwd: outside })).toBeUndefined();
		expect(hook!({ toolName: "edit", input: { path: join(outside, "notes.txt") } }, { cwd: outside })).toBeUndefined();
		expect(hook!({ toolName: "bash", input: { command: "echo ok" } }, { cwd: outside })).toBeUndefined();

		// Once selfdrive leaves session-modes, the guard stands aside again.
		modes.delete("non-git-session");
		expect(hook!({ toolName: "bash", input: { command: "git push" } }, { cwd: outside })).toBeUndefined();
		expect(hook!({ toolName: "bash", input: { command: "sudo ls" } }, { cwd: outside })).toBeUndefined();
	});
});

describe("the hook in a Pi session", () => {
	it("blocks a write into the checkout while a grant exists, and stands aside without one", async () => {
		const restoreAgentDir = scopeAgentDir(join(root, "agent"));
		let h: GuardSessionHarness | undefined;
		try {
			h = await startGuardSession({
				cwd: repo,
				agentDir: join(root, "agent"),
				api: "selfdrive-guard-api",
				provider: "selfdrive-guard",
				extensionFactories: [registerGuard],
			});
			const target = join(repo, "src", "guarded.ts");

			publishGrant({ ...grant, id: h.session.sessionId });
			h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })]), fauxAssistantMessage("done")]);
			await h.session.prompt("write it");
			expect(existsSync(target)).toBe(false);
			expect(h.toolResults().at(-1)).toEqual({ isError: true, text: expect.stringContaining(`Blocked by self-driving mode: write ${target} would change your user's checkout.`) });

			withdrawGrant(h.session.sessionId);
			h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })]), fauxAssistantMessage("done")]);
			await h.session.prompt("write it again");
			expect(existsSync(target)).toBe(true);
			expect(h.toolResults().at(-1)?.isError).toBe(false);
		} finally {
			await h?.dispose();
			rmSync(join(repo, "src", "guarded.ts"), { force: true });
			restoreAgentDir();
		}
	});
});

describe("published standing grants", () => {
	it("attach checkCommand backed by selfdrive's bash guard", async () => {
		const keepAwake = stubKeepAwake();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			registerTool: () => {},
			registerMessageRenderer: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const sessionId = "selfdrive-grant-check-command";
		const ctx = {
			mode: "rpc",
			hasUI: true,
			cwd: repo,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getBranch: () => [],
				getEntries: () => [],
			},
		};
		try {
			selfdriveExtension(pi);
			await commands.get("selfdrive")!.handler("on test checks", ctx);
			const published = grants().find((item) => item.id === sessionId);
			expect(published).toBeDefined();
			expect(typeof published!.checkCommand).toBe("function");

			const worktreeCwd = join(repo, ".git", "herder", "worktrees", "run-1");
			expect(published!.checkCommand!("echo ok", worktreeCwd)).toBeUndefined();
			expect(published!.checkCommand!("npm ci && npm test", worktreeCwd)).toBeUndefined();

			for (const cmd of ["git push", "npm publish", "sudo ls", "ssh host ls", "gh pr create", `echo bad > "${join(repo, "src", "a.ts")}"`]) {
				expect(published!.checkCommand!(cmd, worktreeCwd)).toBe(bashBlockReason(cmd, worktreeCwd, [repo], [join(repo, ".git")]));
			}
		} finally {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
			keepAwake.restore();
		}
	});

	it("passes commonDir into published checkCommand so separate git dirs are protected", async () => {
		const keepAwake = stubKeepAwake();
		const savedGitDir = process.env.GIT_DIR;
		const savedGitWorkTree = process.env.GIT_WORK_TREE;

		// A bare/external git dir paired via GIT_DIR + GIT_WORK_TREE has no `.git` file inside toplevel,
		// so checkCommand protects `<commonDir>` internals only when publishGrant passes `[canonical(repo.commonDir)]`.
		const extWorkTree = join(root, "grant-ext-worktree");
		const extCommonDir = join(root, "grant-ext-gitdir");
		mkdirSync(extWorkTree, { recursive: true });
		mkdirSync(extCommonDir, { recursive: true });
		git(extCommonDir, "init", "--bare", "-q");
		mkdirSync(join(extCommonDir, "herder", "worktrees", "w1"), { recursive: true });
		mkdirSync(join(extCommonDir, "herder", "runs", "r1"), { recursive: true });
		mkdirSync(join(extCommonDir, "worktrees", "wt1"), { recursive: true });

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
			registerTool: () => {},
			registerMessageRenderer: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const sessionId = "selfdrive-grant-common-dir";
		const ctx = {
			mode: "rpc",
			hasUI: true,
			cwd: extWorkTree,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getBranch: () => [],
				getEntries: () => [],
			},
		};
		try {
			process.env.GIT_DIR = extCommonDir;
			process.env.GIT_WORK_TREE = extWorkTree;
			selfdriveExtension(pi);
			await commands.get("selfdrive")!.handler("on test commonDir", ctx);
			const published = grants().find((item) => item.id === sessionId);
			expect(published).toBeDefined();
			expect(published!.toplevel).toBe(extWorkTree);
			expect(published!.commonDir).toBe(extCommonDir);

			// Mutations against protected internals of extCommonDir must be blocked via commonDirs.
			for (const cmd of [
				`echo bad > "${join(extCommonDir, "config")}"`,
				`chmod +x "${join(extCommonDir, "hooks", "pre-commit")}"`,
				`rm -f "${join(extCommonDir, "HEAD")}"`,
				`GIT_DIR="${extCommonDir}" git commit -m x`,
			]) {
				expect(published!.checkCommand!(cmd, outside)).toContain("would change your user's checkout");
			}

			// Exempt paths under extCommonDir remain allowed.
			for (const cmd of [
				`echo ok > "${join(extCommonDir, "herder", "worktrees", "w1", "file.ts")}"`,
				`echo ok > "${join(extCommonDir, "herder", "runs", "r1", "goal.md")}"`,
				`echo ok > "${join(extCommonDir, "worktrees", "wt1", "HEAD")}"`,
			]) {
				expect(published!.checkCommand!(cmd, outside)).toBeUndefined();
			}
		} finally {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
			if (savedGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = savedGitDir;
			if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
			else process.env.GIT_WORK_TREE = savedGitWorkTree;
			keepAwake.restore();
		}
	});
});
