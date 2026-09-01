import fs from "node:fs";
import path from "node:path";
import { git, runCommand } from "../../src/daemon/git-driver.ts";

export interface FixtureRepoOptions {
	name: string;
	email: string;
	files: Record<string, string>;
}

export interface FixtureRepo {
	repo: string;
	originalHead: string;
}

export function initFixtureRepo(root: string, { name, email, files }: FixtureRepoOptions): FixtureRepo {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", name]);
	git(repo, ["config", "user.email", email]);
	for (const [relativePath, contents] of Object.entries(files)) {
		const filePath = path.join(repo, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, contents);
	}
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: create fixture"]);
	const originalHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	return { repo, originalHead };
}
