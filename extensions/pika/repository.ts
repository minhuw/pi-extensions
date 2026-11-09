import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, win32 } from "node:path";

/** What a session's cwd says about its git repository; both fields are absent outside git. */
export interface RepositoryInfo {
	/** The repository's name: the main checkout's folder, also from a subdirectory or a linked worktree. */
	project?: string;
	/** The repository's web page, derived from its remote URL without credentials. */
	repository?: string;
}

export const GIT_TIMEOUT_MS = 2_000;
const MAX_NAME_BYTES = 255;
const MAX_URL_BYTES = 2048;
// Whitespace, C0 and C1 controls, and DEL.
const UNSAFE = /[\s\u0000-\u001f\u007f-\u009f]/u;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** The environment for git: no prompts, and nothing that points it at another repository than the cwd's. */
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/** What git printed, if it succeeded; `answered` is false when it timed out or could not run, so a later try may answer. */
interface GitResult { stdout?: string; answered: boolean }

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
	return new Promise((resolve) => {
		try {
			execFile("git", ["-C", cwd, ...args], { env: gitEnv(), timeout, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8" },
				// An exit status is git's answer; a signal (the timeout's kill) or a spawn error is not.
				(error, stdout) => resolve(error ? { answered: typeof error.code === "number" } : { stdout, answered: true }));
		} catch {
			resolve({ answered: false });
		}
	});
}

/** A valid project name (not blank, `.` or `..`, without C0/C1 controls or path separators, at most 255 bytes), or undefined. */
export function validProjectName(name: string): string | undefined {
	if (!name.trim() || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(name)) return undefined;
	return Buffer.byteLength(name) <= MAX_NAME_BYTES ? name : undefined;
}

/**
 * The repository name for git's common dir: its parent's folder for a `.git` dir, else its own name without one
 * trailing `.git`. Both `/` and `\` separate folders on every platform, as in the server's worktree-path fallback.
 * Herder's `repositoryName` follows the same rule; `services/pika/docs/project-names.json` holds the shared cases.
 */
export function projectFromCommonDir(commonDir: string): string | undefined {
	const base = win32.basename(commonDir);
	const name = base === ".git" ? win32.basename(win32.dirname(commonDir)) : base.replace(/\.git$/, "");
	return validProjectName(name);
}

/**
 * The browsable http(s) URL for a git remote URL, without userinfo, query, fragment, trailing `/`,
 * or `.git`; scp-like, ssh, and git URLs become https without their port. Local paths, `file://`,
 * odd hosts, and anything with whitespace or control characters give undefined.
 */
export function normalizeRemoteUrl(raw: string): string | undefined {
	if (!raw || UNSAFE.test(raw) || Buffer.byteLength(raw) > MAX_URL_BYTES) return undefined;
	let scheme: string;
	let authority: string;
	let path: string;
	const separator = raw.indexOf("://");
	if (separator >= 0) {
		const given = raw.slice(0, separator).toLowerCase();
		if (given === "https" || given === "http") scheme = given;
		else if (["ssh", "git+ssh", "ssh+git", "git"].includes(given)) scheme = "https";
		else return undefined;
		const rest = raw.slice(separator + 3);
		const slash = rest.indexOf("/");
		if (slash < 0) return undefined;
		authority = rest.slice(0, slash);
		path = rest.slice(slash).replace(/[?#].*$/s, "");
		const at = authority.lastIndexOf("@");
		if (at >= 0) authority = authority.slice(at + 1);
		const colon = authority.indexOf(":");
		if (colon >= 0) {
			const port = authority.slice(colon + 1);
			if (!/^\d{0,5}$/.test(port) || Number(port) > 65_535) return undefined;
			authority = scheme === given && port ? authority : authority.slice(0, colon);
		}
	} else {
		const colon = raw.indexOf(":");
		if (colon <= 0) return undefined;
		const before = raw.slice(0, colon);
		if (before.includes("/")) return undefined;
		const after = raw.slice(colon + 1);
		// A Windows drive path such as C:\repo or C:/repo.
		if (/^[a-z]$/i.test(before) && /^[/\\]/.test(after)) return undefined;
		scheme = "https";
		authority = before.slice(before.lastIndexOf("@") + 1);
		path = `/${after.replace(/^\/+/, "")}`;
	}
	const [host, port] = authority.toLowerCase().split(":") as [string, string | undefined];
	if (!HOSTNAME.test(host)) return undefined;
	path = path.replace(/\/$/, "").replace(/\.git$/, "");
	// An `@` in the path may be the rest of credentials that contained a `/`.
	if (!path.split("/").some(Boolean) || path.includes("@")) return undefined;
	const url = `${scheme}://${host}${port ? `:${port}` : ""}${path}`;
	return Buffer.byteLength(url) <= MAX_URL_BYTES ? url : undefined;
}

/** A git remote; `url` is its browsable URL after git's `insteadOf` rewriting, absent for a local path or an odd URL. */
export interface Remote { name: string; url?: string }

/**
 * The remotes in git's config order, from `git config -z --get-regexp '^(remote\..*\.url|url\..*\.insteadof)$'` output.
 * Each remote's first URL counts, rewritten by the `url.<base>.insteadOf` with the longest matching prefix, as git does.
 */
export function listRemotes(output: string): Remote[] {
	const urls = new Map<string, string>();
	const rewrites: { prefix: string; base: string }[] = [];
	for (const record of output.split("\0")) {
		const newline = record.indexOf("\n");
		if (newline < 0) continue;
		const key = record.slice(0, newline);
		const value = record.slice(newline + 1);
		const remote = /^remote\.(.+)\.url$/i.exec(key);
		if (remote) {
			if (!urls.has(remote[1]!)) urls.set(remote[1]!, value);
			continue;
		}
		const rewrite = /^url\.(.+)\.insteadof$/i.exec(key);
		if (rewrite && value) rewrites.push({ prefix: value, base: rewrite[1]! });
	}
	const expand = (url: string) => {
		let best: { prefix: string; base: string } | undefined;
		for (const rule of rewrites) if (url.startsWith(rule.prefix) && rule.prefix.length > (best?.prefix.length ?? -1)) best = rule;
		return best ? best.base + url.slice(best.prefix.length) : url;
	};
	return [...urls].map(([name, raw]) => {
		const url = normalizeRemoteUrl(expand(raw));
		return url ? { name, url } : { name };
	});
}

/** Where a repository keeps its saved identity, relative to its main checkout; `/pika project` writes it. */
export const PROJECT_CONFIG = join(".pi", "pika", "project.json");

/**
 * A repository's saved identity. `remote` names the remote whose URL identifies it; null pins it to no remote, so it
 * stays `project` on this device whatever remotes come later; absent leaves the remote to the rule (`origin`, else the
 * only remote). `project` is the name pika files it under, instead of the main checkout's folder.
 */
export interface ProjectConfig { remote?: string | null; project?: string }

/**
 * The identity a `project.json` holds, or undefined when it is no JSON object; invalid fields are left out. Herder's
 * `projectNameFromConfig` reads `project` the same way; `services/pika/docs/project-config.json` holds the shared cases.
 */
export function parseProjectConfig(text: string): ProjectConfig | undefined {
	let value: unknown;
	try { value = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return undefined; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { remote, project } = value as { remote?: unknown; project?: unknown };
	const name = typeof project === "string" ? validProjectName(project) : undefined;
	return {
		...(remote === null ? { remote: null } : typeof remote === "string" && remote && !UNSAFE.test(remote) ? { remote } : {}),
		...(name ? { project: name } : {}),
	};
}

/** The main checkout's `project.json`, if it holds a JSON object. */
async function readProjectConfig(checkout: string): Promise<ProjectConfig | undefined> {
	try { return parseProjectConfig(await readFile(join(checkout, PROJECT_CONFIG), "utf8")); } catch { return undefined; }
}

/**
 * Why pika asks the user for a repository's identity: several remotes and none named `origin` (`ambiguous`), no remote
 * with a web URL (`unnamed`), or a saved remote that is gone or has none (`stale`).
 */
export type ProjectQuestion = "ambiguous" | "unnamed" | "stale";

/** What git says about a repository, before its saved identity applies. */
export interface RepositoryFacts {
	/** The name from git's common dir (`projectFromCommonDir`); absent outside git. */
	folder?: string;
	/** The main checkout, which holds `project.json`; absent for a bare repository or a submodule. */
	checkout?: string;
	remotes: Remote[];
}

/**
 * The repository's identity from git and its saved configuration. A saved `remote` gives its URL while it has one; a
 * saved null gives none; otherwise `origin` gives it, else the only remote. The saved `project` renames it. Only a
 * repository with a main checkout, which can hold `project.json`, has a question: a saved remote that is gone or has
 * no URL (`stale`), or, with no saved remote, no URL from the rule while some remote has one (`ambiguous`) or while
 * none has one and no name is saved (`unnamed`). Until it is answered, the rule's identity applies.
 */
export function decideRepository(facts: RepositoryFacts, config: ProjectConfig | undefined): { info: RepositoryInfo; question?: ProjectQuestion } {
	if (!facts.folder) return { info: {} };
	const saved = typeof config?.remote === "string" ? facts.remotes.find((remote) => remote.name === config.remote && remote.url) : undefined;
	const automatic = facts.remotes.find((remote) => remote.name === "origin") ?? (facts.remotes.length === 1 ? facts.remotes[0] : undefined);
	const url = config?.remote === null ? undefined : (saved ?? automatic)?.url;
	const info: RepositoryInfo = { project: config?.project ?? facts.folder, ...(url ? { repository: url } : {}) };
	if (!facts.checkout) return { info };
	let question: ProjectQuestion | undefined;
	if (typeof config?.remote === "string" && !saved) question = "stale";
	else if (config?.remote === undefined && !url) {
		if (facts.remotes.some((remote) => remote.url)) question = "ambiguous";
		else if (!config?.project) question = "unnamed";
	}
	return question ? { info, question } : { info };
}

/**
 * git's common dir for `cwd`, absolute. git before 2.31 lacks `--path-format` and may print it relative to the cwd
 * (`-C cwd`), so a failure is retried without it within what remains of `GIT_TIMEOUT_MS`.
 */
async function commonDir(cwd: string): Promise<{ dir?: string; answered: boolean }> {
	const started = Date.now();
	const absolute = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (absolute.stdout !== undefined) return { dir: absolute.stdout.replace(/\r?\n$/, "") || undefined, answered: true };
	const left = GIT_TIMEOUT_MS - (Date.now() - started);
	if (left <= 0) return { answered: false };
	const relative = await git(cwd, ["rev-parse", "--git-common-dir"], left);
	const dir = relative.stdout?.replace(/\r?\n$/, "");
	return { dir: dir ? resolvePath(cwd, dir) : undefined, answered: relative.answered };
}

/** What git says about `cwd`'s repository; `final` is false when git did not answer in time, so it may be incomplete. */
async function resolve(cwd: string): Promise<{ facts: RepositoryFacts; final: boolean }> {
	try {
		const [common, config] = await Promise.all([
			commonDir(cwd),
			git(cwd, ["config", "-z", "--get-regexp", "^(remote\\..*\\.url|url\\..*\\.insteadof)$"]),
		]);
		const { dir } = common;
		if (!dir) return { facts: { remotes: [] }, final: common.answered };
		const real = await realpath(dir).catch(() => dir);
		const folder = projectFromCommonDir(real);
		if (!folder) return { facts: { remotes: [] }, final: true };
		const checkout = win32.basename(real) === ".git" ? dirname(real) : undefined;
		const remotes = config.stdout === undefined ? [] : listRemotes(config.stdout);
		return { facts: { folder, ...(checkout ? { checkout } : {}), remotes }, final: config.answered };
	} catch {
		return { facts: { remotes: [] }, final: false };
	}
}

const cache = new Map<string, Promise<RepositoryFacts>>();

/** git's answer for `cwd`, asked once per cwd in this process; one that git did not give in time is asked again. */
function facts(cwd: string): Promise<RepositoryFacts> {
	let pending = cache.get(cwd);
	if (!pending) {
		const resolving: Promise<RepositoryFacts> = resolve(cwd).then(({ facts, final }) => {
			if (!final && cache.get(cwd) === resolving) cache.delete(cwd);
			return facts;
		});
		pending = resolving;
		cache.set(cwd, pending);
	}
	return pending;
}

/** `cwd`'s repository: git's facts, the saved identity, the identity they give, and the question it leaves open. */
export interface RepositoryState extends RepositoryFacts {
	info: RepositoryInfo;
	config?: ProjectConfig;
	question?: ProjectQuestion;
}

/** The repository of `cwd` with everything `/pika project` needs; never rejects. */
export async function inspectRepository(cwd: string): Promise<RepositoryState> {
	const known = await facts(cwd);
	const config = known.checkout ? await readProjectConfig(known.checkout) : undefined;
	return { ...known, ...(config ? { config } : {}), ...decideRepository(known, config) };
}

/**
 * The repository of `cwd`. git runs once per cwd in this process, and concurrent calls share it; the saved identity is
 * read on every call, so an answer given in any process applies at once. It never rejects, and settles within about
 * `GIT_TIMEOUT_MS`; an empty object means no repository. An answer git did not give in time, as when it stalls, is not
 * kept: the next call asks again.
 */
export async function resolveRepository(cwd: string): Promise<RepositoryInfo> {
	return (await inspectRepository(cwd)).info;
}
