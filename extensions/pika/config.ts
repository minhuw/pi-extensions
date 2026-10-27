import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface PikaConfig {
	url: string;
	token: string;
	exclude: string[];
}

export type ConfigResult =
	| { enabled: true; config: PikaConfig; file: string }
	| { enabled: false; reason: string; file: string; url?: string; /** No server url or token is configured anywhere. */ unconfigured?: true };

/** Reads `<agentDir>/pika.json`; `PIKA_URL` and `PIKA_TOKEN` override it and `PIKA_DISABLED=1` always disables. */
export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const file = join(agentDir, "pika.json");
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
		else return { enabled: false, reason: `${file} is not a JSON object`, file };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { enabled: false, reason: `cannot read ${file}: ${(error as Error).message}`, file };
	}
	const url = (env.PIKA_URL || (typeof raw.url === "string" ? raw.url : "")).trim();
	const token = (env.PIKA_TOKEN || (typeof raw.token === "string" ? raw.token : "")).trim();
	if (env.PIKA_DISABLED === "1") return { enabled: false, reason: "PIKA_DISABLED=1 is set", file, url: url || undefined };
	if (raw.enabled === false) return { enabled: false, reason: `"enabled" is false in ${file}`, file, url: url || undefined };
	if (!url || !token) return { enabled: false, reason: `no server url and token configured (${file}, PIKA_URL, PIKA_TOKEN)`, file, url: url || undefined, unconfigured: true };
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
	} catch {
		return { enabled: false, reason: `invalid server url ${JSON.stringify(url)}`, file };
	}
	const exclude = Array.isArray(raw.exclude) ? raw.exclude.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
	return { enabled: true, config: { url: url.replace(/\/+$/, ""), token, exclude }, file };
}

function expandHome(pattern: string): string {
	return pattern === "~" ? homedir() : pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
}

function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === "*" && glob[i + 1] === "*") { source += ".*"; i++; }
		else if (char === "*") source += "[^/\\\\]*";
		else if (char === "?") source += "[^/\\\\]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/**
 * A cwd is excluded when a pattern is a prefix directory of it, or a glob matching it or one of its
 * ancestors. Relative patterns resolve against pi's start directory, except globs starting with `**`.
 */
export function isExcluded(cwd: string, patterns: readonly string[]): boolean {
	const target = resolve(cwd);
	for (const rawPattern of patterns) {
		const pattern = expandHome(rawPattern.trim());
		if (!pattern) continue;
		if (/[*?]/.test(pattern)) {
			const regexp = globToRegExp(pattern.startsWith("**") || isAbsolute(pattern) ? pattern : resolve(pattern));
			for (let dir = target; ; ) {
				if (regexp.test(dir)) return true;
				const parent = resolve(dir, "..");
				if (parent === dir) break;
				dir = parent;
			}
			continue;
		}
		const prefix = resolve(pattern);
		if (target === prefix || target.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)) return true;
	}
	return false;
}

/**
 * The server URL as pika stores it: http(s) only, without credentials, a query, or a fragment, and
 * with the server's base path kept but no trailing slash. Messages never repeat the input, which
 * may be a mistyped token.
 */
export function normalizeUrl(input: string): string {
	const text = input.trim();
	let url: URL;
	try { url = new URL(text); } catch { throw new Error("the server URL is not a valid URL"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the server URL must start with http:// or https://");
	if (url.username || url.password) throw new Error("the server URL must not contain credentials");
	if (url.search || url.hash || /[?#]/.test(text)) throw new Error("the server URL must not have a query or fragment");
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
