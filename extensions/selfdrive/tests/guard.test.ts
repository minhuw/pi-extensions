// selfdrive's tool_call guard: the bash classifier as a table, the write/edit path rules on a real git repository with a
// nested linked worktree, and the hook in a real Pi session on the faux provider.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { publishGrant, repositoryOf, standingRegistry, withdrawGrant, type StandingApproval } from "../grants.ts";
import { bashBlockReason, blockReason, registerGuard } from "../guard.ts";

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
	mkdirSync(join(repo, ".git", "herder", "runs", "r1", "wt"), { recursive: true });
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

afterEach(() => {
	standingRegistry().grants.clear();
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
		["a workspace under .pi/", ".pi/workspaces/side/notes.md"],
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
		["cd .pi/workspaces/side && npm install", "repo", "allow"],
		["echo x > .git/herder/note", "repo", "allow"],
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
		["cd REPO && git commit -m x", "out", "checkout"],
		["cd ALIAS/src && git reset --hard", "out", "checkout"],
		["bash -c 'cd REPO && git stash'", "out", "checkout"],
		["bash <<'EOF'\ngit commit -m x\nEOF", "repo", "checkout"],
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

	it("survives commands that do not parse", () => {
		expect(bashBlockReason("echo \"unterminated", repo, [repo])).toBeUndefined();
		expect(bashBlockReason("if then fi )", repo, [repo])).toBeUndefined();
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
	] as const)("blocks %j in %s with bash's reason", (command, where) => {
		const cwd = where === "repo" ? repo : outside;
		const reason = judge(command, cwd);
		expect(reason).toMatch(/^Blocked by self-driving mode: /);
		expect(reason).toBe(bashBlockReason(command, cwd, [repo]));
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

describe("the hook in a Pi session", () => {
	it("blocks a write into the checkout while a grant exists, and stands aside without one", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const faux = fauxProvider({ api: "selfdrive-guard-api", provider: "selfdrive-guard", models: [{ id: "test" }] });
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const services = await createAgentSessionServices({
			cwd: repo,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => pi.registerProvider(faux.provider), registerGuard],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.inMemory(repo), model: faux.getModel("test"),
		});
		try {
			await session.bindExtensions({});
			const target = join(repo, "src", "guarded.ts");
			const results = () => session.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [{ isError: Boolean(entry.message.isError), text: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join("") }]
					: []);

			publishGrant({ ...grant, id: session.sessionId });
			faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })]), fauxAssistantMessage("done")]);
			await session.prompt("write it");
			expect(existsSync(target)).toBe(false);
			expect(results().at(-1)).toEqual({ isError: true, text: expect.stringContaining(`Blocked by self-driving mode: write ${target} would change your user's checkout.`) });

			withdrawGrant(session.sessionId);
			faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })]), fauxAssistantMessage("done")]);
			await session.prompt("write it again");
			expect(existsSync(target)).toBe(true);
			expect(results().at(-1)?.isError).toBe(false);
		} finally {
			session.dispose();
			rmSync(join(repo, "src", "guarded.ts"), { force: true });
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
