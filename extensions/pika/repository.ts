import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath, win32 } from "node:path";

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

/** The repository of `cwd`; `final` is false when git did not answer in time, so the result may be incomplete. */
async function resolve(cwd: string): Promise<{ info: RepositoryInfo; final: boolean }> {
	try {
		const [common, remotes] = await Promise.all([
			commonDir(cwd),
			git(cwd, ["config", "-z", "--get-regexp", "^remote\\..*\\.url$"]),
		]);
		const { dir } = common;
		if (!dir) return { info: {}, final: common.answered };
		const project = projectFromCommonDir(await realpath(dir).catch(() => dir));
		if (!project) return { info: {}, final: true };
		const remote = remotes.stdout === undefined ? undefined : pickRemoteUrl(remotes.stdout);
		const repository = remote === undefined ? undefined : normalizeRemoteUrl(remote);
		return { info: { project, ...(repository ? { repository } : {}) }, final: remotes.answered };
	} catch {
		return { info: {}, final: false };
	}
}

const cache = new Map<string, Promise<RepositoryInfo>>();

/**
 * The repository of `cwd`, resolved with git once per cwd in this process; concurrent calls share one
 * resolution. It never rejects, and settles within about `GIT_TIMEOUT_MS`; an empty object means no
 * repository. A resolution that git did not answer in time, as when it stalls, is not kept: the next
 * call resolves again.
 */
export function resolveRepository(cwd: string): Promise<RepositoryInfo> {
	let pending = cache.get(cwd);
	if (!pending) {
		const resolving: Promise<RepositoryInfo> = resolve(cwd).then(({ info, final }) => {
			if (!final && cache.get(cwd) === resolving) cache.delete(cwd);
			return info;
		});
		pending = resolving;
		cache.set(cwd, pending);
	}
	return pending;
}
