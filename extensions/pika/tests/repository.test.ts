import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../credentials.ts";
import pikaExtension, { CHILD_SESSION_HOOKS, type ChildSessionHook } from "../index.ts";
import { normalizeRemoteUrl, pickRemoteUrl, projectFromCommonDir, resolveRepository, validProjectName } from "../repository.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

describe("normalizeRemoteUrl", () => {
	it.each([
		["git@github.com:minhuw/pi-extensions.git", "https://github.com/minhuw/pi-extensions"],
		["github.com:minhuw/pi-extensions", "https://github.com/minhuw/pi-extensions"],
		["git@github.com:/minhuw/pi-extensions.git/", "https://github.com/minhuw/pi-extensions"],
		["git@GitHub.COM:Team/Repo.git", "https://github.com/Team/Repo"],
		["ssh://git@gitlab.example.com:2222/team/proj.git", "https://gitlab.example.com/team/proj"],
		["ssh://gitlab.example.com/team/proj", "https://gitlab.example.com/team/proj"],
		["git+ssh://git@host.example/a/b.git", "https://host.example/a/b"],
		["ssh+git://git@host.example/a/b.git", "https://host.example/a/b"],
		["git://git.kernel.org:9418/pub/scm/git/git.git", "https://git.kernel.org/pub/scm/git/git"],
		["https://x-token:s3cret@github.com/a/b.git", "https://github.com/a/b"],
		["https://ghp_abcdef@github.com/a/b", "https://github.com/a/b"],
		["HTTPS://github.com/a/b.git", "https://github.com/a/b"],
		["https://git.example.com:8443/group/sub/proj.git?ref=x#frag", "https://git.example.com:8443/group/sub/proj"],
		["http://10.0.0.5/a/b/", "http://10.0.0.5/a/b"],
		["http://user@intranet:8080/repo.git/", "http://intranet:8080/repo"],
		["https://github.com/a/b.git.git", "https://github.com/a/b.git"],
	])("%s -> %s", (raw, expected) => {
		expect(normalizeRemoteUrl(raw)).toBe(expected);
	});

	it.each([
		["", "empty"],
		["/srv/git/foo.git", "local path"],
		["./foo", "relative path"],
		["../a:b/c", "relative path with a colon"],
		["C:\\repos\\foo", "Windows path"],
		["C:/repos/foo", "Windows path with slashes"],
		["file:///srv/git/foo.git", "file URL"],
		["ftp://host/a/b", "other scheme"],
		["https://github.com", "no path"],
		["https://github.com/", "empty path"],
		["https://github.com/.git", "only .git"],
		["git@github.com:", "scp-like without path"],
		["https://[::1]/a/b", "IPv6 host"],
		["ssh://git@[2001:db8::1]:22/a/b", "IPv6 host with port"],
		["git@[::1]:a/b", "scp-like IPv6 host"],
		["https://exa_mple.com/a", "underscore in host"],
		["https://-bad.com/a", "host starting with a hyphen"],
		["https://bad..com/a", "empty label"],
		["https://host:99999/a", "port out of range"],
		["https://host:ab/a", "non-numeric port"],
		["https://github.com/a b", "space"],
		[" https://github.com/a/b", "leading space"],
		["https://github.com/a/b\n", "trailing newline"],
		["https://github.com/a/\tb", "tab"],
		["https://github.com/a/\u0000b", "NUL"],
		["https://github.com/a/\u0085b", "C1 control"],
		["https://github.com/a/\u00a0b", "non-breaking space"],
		["https://user:pa/ss@github.com/a/b", "credentials containing a slash"],
		["user:secret@host:a/b", "scp-like with a password"],
		[`https://github.com/${"a".repeat(2048)}`, "longer than 2048 bytes"],
	])("rejects %j (%s)", (raw) => {
		expect(normalizeRemoteUrl(raw)).toBeUndefined();
	});

	it("accepts a URL just under the length cap", () => {
		const path = "a".repeat(2048 - "https://h.io/".length);
		expect(normalizeRemoteUrl(`https://h.io/${path}`)).toBe(`https://h.io/${path}`);
	});
});

// The cases Herder's repositoryName tests share (extensions/herder/tests/vcs/git.test.ts).
const PROJECT_NAMES = JSON.parse(readFileSync(new URL("../../../services/pika/docs/project-names.json", import.meta.url), "utf8")) as {
	cases: { commonDir: string; expected: string | null; case: string }[];
};

describe("repository names", () => {
	it.each(PROJECT_NAMES.cases)("$commonDir -> $expected ($case)", ({ commonDir, expected }) => {
		expect(projectFromCommonDir(commonDir)).toBe(expected ?? undefined);
	});

	it("rejects invalid names", () => {
		for (const name of ["", " ", "\u3000", ".", "..", "a/b", "a\\b", "a\u0001b", "a\u007fb", "a\u0085b", "é".repeat(128)]) expect(validProjectName(name)).toBeUndefined();
		expect(validProjectName("é".repeat(127))).toBe("é".repeat(127));
	});

	it("picks origin, else the only remote", () => {
		const record = (name: string, url: string) => `remote.${name}.url\n${url}\0`;
		expect(pickRemoteUrl(record("upstream", "u") + record("origin", "o"))).toBe("o");
		expect(pickRemoteUrl(record("fork.with.dots", "f"))).toBe("f");
		expect(pickRemoteUrl(record("a", "1") + record("b", "2"))).toBeUndefined();
		expect(pickRemoteUrl(record("origin", "first") + record("origin", "second"))).toBe("first");
		expect(pickRemoteUrl("")).toBeUndefined();
	});
});

/** git without the ambient GIT_* variables, which could point it elsewhere. */
function git(cwd: string, ...args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	return execFileSync("git", ["-C", cwd, "-c", "user.name=pika", "-c", "user.email=pika@example.com", "-c", "init.defaultBranch=main", ...args], { env, encoding: "utf8" });
}

const REMOTE = "https://x-token:s3cret-token@git.example.com/team/my-repo.git";
const NORMALIZED = "https://git.example.com/team/my-repo";

/** A repository `my-repo` with an origin carrying credentials, one commit, and a linked worktree `my-repo-feature`. */
async function makeRepo(root: string): Promise<{ repo: string; subdir: string; worktree: string }> {
	const repo = join(root, "my-repo");
	const subdir = join(repo, "src", "deep");
	await mkdir(subdir, { recursive: true });
	git(repo, "init", "-q");
	git(repo, "remote", "add", "origin", REMOTE);
	git(repo, "remote", "add", "upstream", "git@github.com:other/upstream.git");
	await writeFile(join(subdir, "file.txt"), "x\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	const worktree = join(root, "my-repo-feature");
	git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
	return { repo, subdir, worktree };
}

describe("resolveRepository", () => {
	it("names the main checkout from a subdirectory and a linked worktree, ignoring an ambient GIT_DIR", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
		try {
			const { repo, subdir, worktree } = await makeRepo(root);
			const ticket = join(repo, ".git", "superagent", "worktrees", "2-fix-fig-2-1-colours-to-current-fig-1-2");
			git(repo, "worktree", "add", "-q", "-b", "ticket", ticket);
			const other = join(root, "other");
			await mkdir(other);
			git(other, "init", "-q");
			process.env.GIT_DIR = join(other, ".git");
			process.env.GIT_WORK_TREE = other;
			expect(await resolveRepository(subdir)).toEqual({ project: "my-repo", repository: NORMALIZED });
			expect(await resolveRepository(join(worktree, "src"))).toEqual({ project: "my-repo", repository: NORMALIZED });
			expect(await resolveRepository(join(ticket, "src"))).toEqual({ project: "my-repo", repository: NORMALIZED });
			const plain = join(root, "plain");
			await mkdir(plain);
			expect(await resolveRepository(plain)).toEqual({});
			expect(await resolveRepository(join(root, "missing"))).toEqual({});
			// Cached per cwd.
			expect(resolveRepository(subdir)).toBe(resolveRepository(subdir));
			expect(credentialsRegistry().repository).toBe(resolveRepository);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("names a bare repository without .git and gives no URL for an ambiguous or local remote", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		try {
			const bare = join(root, "server.git");
			await mkdir(bare);
			git(bare, "init", "-q", "--bare");
			git(bare, "remote", "add", "a", "git@github.com:a/a.git");
			git(bare, "remote", "add", "b", "git@github.com:b/b.git");
			expect(await resolveRepository(bare)).toEqual({ project: "server" });
			const local = join(root, "local");
			await mkdir(local);
			git(local, "init", "-q");
			git(local, "remote", "add", "origin", bare);
			expect(await resolveRepository(local)).toEqual({ project: "local" });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it.skipIf(process.platform === "win32")("falls back to a relative --git-common-dir with git older than 2.31", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		const savedPath = process.env.PATH;
		try {
			const { repo, subdir, worktree } = await makeRepo(root);
			const bare = join(root, "server.git");
			await mkdir(bare);
			git(bare, "init", "-q", "--bare");
			// A git that, like git before 2.31, rejects --path-format and so prints the common dir as given (`.git`, `.`).
			const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
			const bin = join(root, "bin");
			const log = join(root, "rejected.log");
			await mkdir(bin);
			await writeFile(join(bin, "git"), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --path-format=*) echo rejected >> '${log}'; echo 'error: unknown option path-format=absolute' >&2; exit 129;; esac; done\nexec '${real}' "$@"\n`);
			await chmod(join(bin, "git"), 0o755);
			process.env.PATH = `${bin}:${savedPath ?? ""}`;
			expect(await resolveRepository(repo)).toEqual({ project: "my-repo", repository: NORMALIZED });
			expect(await resolveRepository(subdir)).toEqual({ project: "my-repo", repository: NORMALIZED });
			expect(await resolveRepository(worktree)).toEqual({ project: "my-repo", repository: NORMALIZED });
			expect(await resolveRepository(bare)).toEqual({ project: "server" });
			expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(4);
		} finally {
			process.env.PATH = savedPath;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("session meta", () => {
	let workspace: Workspace;
	let ingest: MockIngest;
	beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
	afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

	const registered = () => [...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? [])];
	/** Every batch item of a stream, in upload order. */
	const items = (key: string) => ingest.bodies.flatMap((body) => body.streams ?? []).filter((stream) => stream.key === key);

	it("uploads the repository name and credential-free URL from a subdirectory and, for a child, a linked worktree", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		try {
			const { subdir, worktree } = await makeRepo(root);
			await workspace.enable(ingest.url);
			const main = await startSession({ workspace, cwd: subdir, extensions: [pikaExtension] });
			try {
				main.faux.setResponses([fauxAssistantMessage("main")]);
				await main.session.prompt("hello");
				const key = `session:${main.session.sessionId}`;
				await waitFor(async () => ingest.data(key) === await readText(main.session.sessionFile!), 5_000, "main upload");
				const expected = { sessionId: main.session.sessionId, cwd: subdir, project: "my-repo", repository: NORMALIZED };
				// The first batch already carries the repository, and so does every later one.
				expect(items(key)[0]).toMatchObject({ offset: 0, meta: expected });
				for (const item of items(key)) expect(item.meta).toEqual(expected);
				expect(ingest.streams.get(key)!.meta).toEqual(expected);
				expect(JSON.stringify(ingest.bodies)).not.toContain("s3cret-token");

				// A worktree child, as Subagents' isolation or a Herder step runs it.
				const manager = SessionManager.create(worktree, workspace.sessionDir, { parentSession: main.session.sessionFile });
				const child = await startSession({ workspace, cwd: worktree, sessionManager: manager, faux: main.faux, extensions: registered().map((hook) => hook.extensionFactory) });
				try {
					main.faux.appendResponses([fauxAssistantMessage("child")]);
					await child.session.prompt("child prompt");
					const childKey = `session:${child.session.sessionId}`;
					await waitFor(async () => ingest.data(childKey) === await readText(child.session.sessionFile!), 5_000, "child upload");
					expect(items(childKey)[0]).toMatchObject({
						offset: 0,
						meta: { sessionId: child.session.sessionId, cwd: worktree, parentSession: main.session.sessionFile, project: "my-repo", repository: NORMALIZED },
					});
					expect(child.errors).toEqual([]);
				} finally { await child.shutdown(); }
				expect(main.errors).toEqual([]);
			} finally { await main.shutdown(); }
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 20_000);

	it("uploads neither field outside git", async () => {
		await workspace.enable(ingest.url);
		const h = await startSession({ workspace, extensions: [pikaExtension] });
		try {
			h.faux.setResponses([fauxAssistantMessage("answer")]);
			await h.session.prompt("hello");
			const key = `session:${h.session.sessionId}`;
			await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!), 5_000, "upload");
			for (const item of items(key)) expect(item.meta).toEqual({ sessionId: h.session.sessionId, cwd: workspace.cwd });
		} finally { await h.shutdown(); }
	}, 20_000);

	it("uploads a session that shuts down right after its only prompt, with its repository", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		try {
			const { repo } = await makeRepo(root);
			const cwd = join(repo, "src");
			await workspace.enable(ingest.url);
			const h = await startSession({ workspace, cwd, extensions: [pikaExtension] });
			h.faux.setResponses([fauxAssistantMessage("answer")]);
			await h.session.prompt("hello");
			await h.shutdown();
			const key = `session:${h.session.sessionId}`;
			await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!), 5_000, "upload");
			expect(items(key)[0]!.meta).toMatchObject({ project: "my-repo", repository: NORMALIZED });
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 20_000);
});
