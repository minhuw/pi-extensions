import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";

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

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile("git", ["-C", cwd, ...args], { env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8" },
				(error, stdout) => resolve(error ? undefined : stdout));
		} catch {
			resolve(undefined);
		}
	});
}

/** A valid project name, or undefined. */
export function validProjectName(name: string): string | undefined {
	if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(name)) return undefined;
	return Buffer.byteLength(name) <= MAX_NAME_BYTES ? name : undefined;
}

/** The repository name for git's common dir: its parent's folder for a `.git` dir, else its own name without `.git`. */
export function projectFromCommonDir(commonDir: string): string | undefined {
	const dir = commonDir.replace(/[/\\]+$/, "");
	const name = basename(dir) === ".git" ? basename(dirname(dir)) : basename(dir).replace(/\.git$/, "");
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

/** The URL of `origin`, else of the only remote, from `git config -z --get-regexp` output. */
export function pickRemoteUrl(output: string): string | undefined {
	const urls = new Map<string, string>();
	for (const record of output.split("\0")) {
		const newline = record.indexOf("\n");
		if (newline < 0) continue;
		const key = record.slice(0, newline);
		const match = /^remote\.(.+)\.url$/i.exec(key);
		if (match && !urls.has(match[1]!)) urls.set(match[1]!, record.slice(newline + 1));
	}
	if (urls.has("origin")) return urls.get("origin");
	return urls.size === 1 ? [...urls.values()][0] : undefined;
}

async function resolve(cwd: string): Promise<RepositoryInfo> {
	try {
		const [commonDir, remotes] = await Promise.all([
			git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			git(cwd, ["config", "-z", "--get-regexp", "^remote\\..*\\.url$"]),
		]);
		const dir = commonDir?.replace(/\r?\n$/, "");
		if (!dir) return {};
		const project = projectFromCommonDir(await realpath(dir).catch(() => dir));
		if (!project) return {};
		const remote = remotes === undefined ? undefined : pickRemoteUrl(remotes);
		const repository = remote === undefined ? undefined : normalizeRemoteUrl(remote);
		return { project, ...(repository ? { repository } : {}) };
	} catch {
		return {};
	}
}

const cache = new Map<string, Promise<RepositoryInfo>>();

/**
 * The repository of `cwd`, resolved with git once per cwd in this process. It never rejects, and
 * settles within about `GIT_TIMEOUT_MS`; an empty object means no repository.
 */
export function resolveRepository(cwd: string): Promise<RepositoryInfo> {
	let pending = cache.get(cwd);
	if (!pending) {
		pending = resolve(cwd);
		cache.set(cwd, pending);
	}
	return pending;
}
