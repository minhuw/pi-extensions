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
import {
	decideRepository, inspectRepository, listRemotes, normalizeRemoteUrl, parseProjectConfig, PROJECT_CONFIG, projectFromCommonDir, type RepositoryFacts,
	resolveRepository, validProjectName,
} from "../repository.ts";
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

	it("lists remotes in config order with their first URL, rewritten by insteadOf as git rewrites it", () => {
		const record = (key: string, value: string) => `${key}\n${value}\0`;
		const output = record("remote.zeta.url", "gh:me/zeta") + record("remote.fork.with.dots.url", "git@github.com:me/f.git")
			+ record("remote.zeta.url", "https://example.com/second") + record("remote.local.url", "/srv/git/x.git")
			+ record("url.https://github.com/.insteadof", "gh:") + record("url.https://gitlab.com/.insteadof", "gh:me/z") + record("url.ignored.insteadof", "");
		expect(listRemotes(output)).toEqual([
			// The longest matching prefix wins, also when another rule comes first.
			{ name: "zeta", url: "https://gitlab.com/eta" },
			{ name: "fork.with.dots", url: "https://github.com/me/f" },
			{ name: "local" },
		]);
		expect(listRemotes("")).toEqual([]);
	});
});

const PROJECT_CONFIGS = JSON.parse(readFileSync(new URL("../../../services/pika/docs/project-config.json", import.meta.url), "utf8")) as {
	cases: { text: string; project: string | null; case: string }[];
};

describe("project.json", () => {
	it.each(PROJECT_CONFIGS.cases)("$case", ({ text, project }) => {
		expect(parseProjectConfig(text)?.project).toBe(project ?? undefined);
	});

	it("keeps a remote name or null and drops anything else", () => {
		expect(parseProjectConfig('{"remote":"fork"}')).toEqual({ remote: "fork" });
		expect(parseProjectConfig('{"remote":null}')).toEqual({ remote: null });
		for (const remote of ['""', "5", '"a b"', "false"]) expect(parseProjectConfig(`{"remote":${remote}}`)).toEqual({});
		expect(parseProjectConfig("[]")).toBeUndefined();
	});
});

describe("decideRepository", () => {
	const facts = (...remotes: [string, string?][]): RepositoryFacts =>
		({ folder: "app", checkout: "/code/app", remotes: remotes.map(([name, url]) => url ? { name, url } : { name }) });
	const A = "https://github.com/me/a";
	const B = "https://github.com/me/b";

	it.each([
		{ case: "origin", facts: facts(["upstream", A], ["origin", B]), config: undefined, info: { project: "app", repository: B } },
		{ case: "the only remote", facts: facts(["fork", A]), config: undefined, info: { project: "app", repository: A } },
		{ case: "several remotes, none origin", facts: facts(["a", A], ["b", B]), config: undefined, info: { project: "app" }, question: "ambiguous" },
		{ case: "an origin without a web URL beside one with", facts: facts(["origin"], ["b", B]), config: undefined, info: { project: "app" }, question: "ambiguous" },
		{ case: "no remote", facts: facts(), config: undefined, info: { project: "app" }, question: "unnamed" },
		{ case: "only a local remote", facts: facts(["origin"]), config: undefined, info: { project: "app" }, question: "unnamed" },
		{ case: "a saved remote", facts: facts(["a", A], ["b", B]), config: { remote: "b" }, info: { project: "app", repository: B } },
		{ case: "a saved remote over origin", facts: facts(["origin", A], ["b", B]), config: { remote: "b" }, info: { project: "app", repository: B } },
		{ case: "a saved name pinned to no remote", facts: facts(["origin", A]), config: { remote: null, project: "tool" }, info: { project: "tool" } },
		{ case: "a saved name with the rule's remote", facts: facts(["origin", A]), config: { project: "tool" }, info: { project: "tool", repository: A } },
		{ case: "a saved name without remotes", facts: facts(), config: { project: "tool" }, info: { project: "tool" } },
		{ case: "a saved name, remote undecided", facts: facts(["a", A], ["b", B]), config: { project: "tool" }, info: { project: "tool" }, question: "ambiguous" },
		{ case: "a saved remote that is gone", facts: facts(["origin", A]), config: { remote: "b" }, info: { project: "app", repository: A }, question: "stale" },
		{ case: "a saved remote without a web URL", facts: facts(["b"]), config: { remote: "b" }, info: { project: "app", repository: undefined }, question: "stale" },
		{ case: "an empty project.json", facts: facts(), config: {}, info: { project: "app" }, question: "unnamed" },
	])("$case", ({ facts, config, info, question }) => {
		const decided = decideRepository(facts, config);
		expect(decided.info).toEqual(Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)));
		expect(decided.question).toBe(question);
	});

	it("never asks without a main checkout, and names nothing outside git", () => {
		expect(decideRepository({ folder: "lib", remotes: [{ name: "a", url: A }, { name: "b", url: B }] }, undefined)).toEqual({ info: { project: "lib" } });
		expect(decideRepository({ remotes: [] }, { project: "x" })).toEqual({ info: {} });
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
			// git's answer is kept per cwd: a later call does not run git, which cannot be found now.
			const path = process.env.PATH;
			process.env.PATH = "";
			try {
				expect(await resolveRepository(subdir)).toEqual({ project: "my-repo", repository: NORMALIZED });
			} finally { process.env.PATH = path; }
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

	it("reads the main checkout's project.json on every call, also from a linked worktree, and applies insteadOf", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pika-repo-")));
		try {
			const { repo, subdir, worktree } = await makeRepo(root);
			git(repo, "remote", "remove", "origin");
			git(repo, "remote", "add", "fork", "gh:me/fork.git");
			git(repo, "config", "url.https://github.com/.insteadOf", "gh:");
			// upstream and fork, none named origin: git leaves the identity open.
			const open = await inspectRepository(subdir);
			expect(open).toMatchObject({ folder: "my-repo", checkout: repo, info: { project: "my-repo" }, question: "ambiguous" });
			expect(open.remotes).toEqual([{ name: "upstream", url: "https://github.com/other/upstream" }, { name: "fork", url: "https://github.com/me/fork" }]);

			await mkdir(join(repo, ".pi", "pika"), { recursive: true });
			await writeFile(join(repo, PROJECT_CONFIG), JSON.stringify({ remote: "fork" }));
			expect(await resolveRepository(subdir)).toEqual({ project: "my-repo", repository: "https://github.com/me/fork" });
			expect(await resolveRepository(worktree)).toEqual({ project: "my-repo", repository: "https://github.com/me/fork" });
			await writeFile(join(repo, PROJECT_CONFIG), JSON.stringify({ remote: null, project: "renamed" }));
			expect(await resolveRepository(worktree)).toEqual({ project: "renamed" });
			expect((await inspectRepository(worktree)).question).toBeUndefined();
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
