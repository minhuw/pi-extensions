import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession, DefaultResourceLoader, type ExtensionFactory, type InlineExtension, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ensureIgnoredDir } from "../../project.ts";
import { DREAM_PROMPT } from "./prompt.ts";
import { type DreamChild, dreamLimits, type SpawnOptions } from "./run.ts";

export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const SESSION_LINK_TYPE = "pi-extensions.session-link";
const DREAM_AGENT_TYPE = "memory-dream";
/** The built-in tools a dream gets: reading the code, never changing it. */
export const READ_TOOLS = ["read", "grep", "find", "ls"];

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
// No packages, extensions, or resource paths, which the loader would resolve and install.
const KEPT_SETTINGS: (keyof Settings)[] = ["transport", "retry", "compaction", "shellPath", "shellCommandPrefix", "images", "thinkingBudgets"];

/** pika's folder in the project: `<cwd>/.pi/pika/`, kept out of git by its own `.gitignore`. */
const projectPikaDir = (cwd: string) => join(cwd, ".pi", "pika");
/** Where dream sessions are kept: in the project, away from the user's sessions, so `/resume` does not list them. */
export const dreamSessionDir = (cwd: string) => join(projectPikaDir(cwd), "dreams");

const within = (dir: string, path: string) => {
	const rest = relative(dir, path);
	return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
/** `path` with its symlinks resolved, as far as it exists. */
const real = (path: string): string => {
	try { return realpathSync.native(path); } catch {
		const parent = dirname(path);
		return parent === path ? path : join(real(parent), basename(path));
	}
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const curly = (path: string) => path.replace(/'/g, "\u2019");

/**
 * The path `tool` (`read`, `ls`, `grep`, or `find`) opens for `path` in `cwd`, as Pi's `resolveToCwd` reads it, and for
 * `read` the spelling it falls back to when the path does not exist as given; undefined for a `file://` URL that names
 * no local path, which the tools refuse.
 */
function toolPath(cwd: string, path: string, tool?: string): string | undefined {
	let bare = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
	const windows = process.platform === "win32";
	// A Git Bash, MSYS, Cygwin, or WSL drive path.
	const drive = windows && !bare.startsWith("//") && !bare.includes("\\") ? /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(bare) : null;
	if (drive) bare = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	if (bare === "~") bare = homedir();
	else if (bare.startsWith("~/") || (windows && bare.startsWith("~\\"))) bare = join(homedir(), bare.slice(2));
	else if (/^file:\/\//.test(bare)) {
		try { bare = fileURLToPath(bare); } catch { return undefined; }
	}
	const target = resolve(cwd, bare);
	if (tool !== "read") return target;
	const nfd = target.normalize("NFD");
	return [target, target.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(target), curly(nfd)].find((spelling) => existsSync(spelling)) ?? target;
}

/** Whether `path`, as `read`, `ls`, `grep`, and `find` take it in `cwd`, names `<cwd>/.pi/pika/` or something in it. */
export function inProjectPikaDir(cwd: string, path: string, tool?: string): boolean {
	const target = toolPath(cwd, path, tool);
	if (target === undefined) return false;
	const dir = projectPikaDir(cwd);
	return within(dir, target) || within(real(dir), real(target));
}

/** Whether `path`, as `tool` takes it in `cwd`, leads out of `cwd`: by itself or through a symlink. Real paths are compared, so a `cwd` reached through a symlink holds its own files. */
export function outsideProject(cwd: string, path: string, tool?: string): boolean {
	const target = toolPath(cwd, path, tool);
	return target === undefined || !within(real(cwd), real(target));
}

const MAX_BRACE_BRANCHES = 256;
const CATCH_ALL_PROBES = ["", ".a", "b", "foo.bar", "0_9"];
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string) => s.replace(REGEX_SPECIAL, "\\$&");

/** Given `s[start] === "["`, returns the index of the closing `"]"`, or `start` if unclosed. */
function skipCharClass(s: string, start: number, escapes: boolean): number {
	let i = start + 1;
	if (i < s.length && (s[i] === "!" || s[i] === "^")) i++;
	if (i < s.length && s[i] === "]") i++;
	for (; i < s.length; i++) {
		if (escapes && s[i] === "\\") { i++; continue; }
		if (s[i] === "]") return i;
	}
	return start;
}

/** Given `s[start] === "{"`, returns its matching `"}"`, top-level alternatives, and whether the body contains `"/"`. */
function findBalancedBrace(s: string, start: number, escapes: boolean): { end: number; alts: string[]; hasSlash: boolean } | undefined {
	const alts: string[] = [];
	let depth = 1;
	let partStart = start + 1;
	let hasSlash = false;
	for (let j = start + 1; j < s.length; j++) {
		const c = s[j]!;
		if (escapes && c === "\\") { j++; continue; }
		if (c === "[") { j = skipCharClass(s, j, escapes); continue; }
		if (c === "{") { depth++; continue; }
		if (c === "}") {
			depth--;
			if (depth === 0) {
				alts.push(s.slice(partStart, j));
				return { end: j, alts, hasSlash };
			}
			continue;
		}
		if (c === "/") hasSlash = true;
		if (c === "," && depth === 1) {
			alts.push(s.slice(partStart, j));
			partStart = j + 1;
		}
	}
	return undefined;
}

/** Finds the first balanced `{...}` group in `s` whose body contains `"/"`. */
function findSlashBrace(s: string, escapes: boolean): { start: number; end: number; alts: string[] } | undefined {
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (escapes && ch === "\\") { i++; continue; }
		if (ch === "[") { i = skipCharClass(s, i, escapes); continue; }
		if (ch !== "{") continue;
		const group = findBalancedBrace(s, i, escapes);
		if (group?.hasSlash) return { start: i, end: group.end, alts: group.alts };
	}
	return undefined;
}

/**
 * Expands `{...}` groups containing `"/"` so each branch splits cleanly into path segments (intra-segment braces stay
 * intact for regex compilation). Returns `undefined` if expansion exceeds `MAX_BRACE_BRANCHES`.
 */
function expandSlashBraces(pattern: string, escapes: boolean): string[] | undefined {
	let branches = [pattern];
	for (;;) {
		let expanded = false;
		const next: string[] = [];
		for (const branch of branches) {
			const group = findSlashBrace(branch, escapes);
			if (!group) { next.push(branch); continue; }
			expanded = true;
			const prefix = branch.slice(0, group.start);
			const suffix = branch.slice(group.end + 1);
			for (const alt of group.alts) {
				next.push(`${prefix}${alt}${suffix}`);
				if (next.length > MAX_BRACE_BRANCHES) return undefined;
			}
		}
		branches = next;
		if (!expanded) return branches;
	}
}

function compileCharClass(inner: string, escapes: boolean): string {
	let out = "[";
	let i = 0;
	if (inner[0] === "!" || inner[0] === "^") { out += "^"; i = 1; }
	for (; i < inner.length; i++) {
		const ch = inner[i]!;
		if (escapes && ch === "\\" && i + 1 < inner.length) {
			const next = inner[++i]!;
			out += next === "\\" || next === "]" || next === "[" || next === "-" || next === "^" ? `\\${next}` : next;
			continue;
		}
		if (ch === "\\" || ch === "]" || ch === "[" || (ch === "^" && out === "[")) out += `\\${ch}`;
		else out += ch;
	}
	return `${out}]`;
}

function compileSegmentBody(s: string, escapes: boolean): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (escapes && ch === "\\" && i + 1 < s.length) { out += escapeRegex(s[++i]!); continue; }
		if (ch === "*") { while (s[i + 1] === "*") i++; out += "[^/]*"; continue; }
		if (ch === "?") { out += "[^/]"; continue; }
		if (ch === "[") {
			const end = skipCharClass(s, i, escapes);
			if (end > i) { out += compileCharClass(s.slice(i + 1, end), escapes); i = end; continue; }
			out += "\\[";
			continue;
		}
		if (ch === "{") {
			const group = findBalancedBrace(s, i, escapes);
			if (group) {
				out += `(?:${group.alts.map((alt) => compileSegmentBody(alt, escapes)).join("|")})`;
				i = group.end;
				continue;
			}
			out += "\\{";
			continue;
		}
		out += escapeRegex(ch);
	}
	return out;
}

interface CompiledSegment {
	isDoubleStar: boolean;
	isCatchAll: boolean;
	matches(name: string): boolean;
}

function compileSegment(raw: string, escapes: boolean): CompiledSegment {
	if (raw === "**") return { isDoubleStar: true, isCatchAll: true, matches: () => true };
	let re: RegExp;
	try {
		re = new RegExp(`^${compileSegmentBody(raw, escapes)}$`, process.platform === "win32" ? "i" : "");
	} catch {
		return { isDoubleStar: false, isCatchAll: false, matches: () => false };
	}
	const matches = (name: string) => re.test(name);
	return { isDoubleStar: false, isCatchAll: CATCH_ALL_PROBES.every(matches), matches };
}

function segmentsTargetPika(segments: CompiledSegment[], hasSlash: boolean, trailingSlash: boolean, target: string[]): boolean {
	const k = segments.length;
	const m = target.length;
	if (k === 0) return false;
	if (m === 0) return true;
	if (!hasSlash) {
		const seg = segments[0]!;
		return seg.isCatchAll || (m === 1 && seg.matches(target[0]!));
	}
	const allCatchAll = segments.every((seg) => seg.isCatchAll);
	const memo = new Map<number, boolean>();
	const canMatch = (si: number, ti: number, enteredTarget: boolean, matchedSpecificT: boolean): boolean => {
		if (si === k) {
			if (ti === m) return matchedSpecificT || (enteredTarget && allCatchAll);
			return ti > 0 && trailingSlash && matchedSpecificT;
		}
		const key = (((si * (m + 1) + ti) << 2) | (enteredTarget ? 2 : 0) | (matchedSpecificT ? 1 : 0));
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		const seg = segments[si]!;
		let result = false;
		if (seg.isDoubleStar) {
			result = canMatch(si + 1, ti, enteredTarget, matchedSpecificT)
				|| (ti < m ? canMatch(si, ti + 1, enteredTarget, matchedSpecificT) : canMatch(si + 1, m, true, matchedSpecificT));
		} else if (ti < m) {
			result = seg.matches(target[ti]!) && canMatch(si + 1, ti + 1, enteredTarget, matchedSpecificT || !seg.isCatchAll);
		} else {
			result = canMatch(si + 1, m, true, matchedSpecificT);
		}
		memo.set(key, result);
		return result;
	};
	return canMatch(0, 0, false, false);
}

/** Relative slash-separated path from `grep`'s resolved search root to `<cwd>/.pi/pika/`, or undefined when the root cannot reach it. */
function pikaRelativeToSearchRoot(cwd: string, searchPath?: string): string | undefined {
	const root = searchPath === undefined || searchPath === "" ? resolve(cwd) : toolPath(cwd, searchPath, "grep");
	if (root === undefined) return undefined;
	const dir = projectPikaDir(cwd);
	if (within(dir, root) || within(real(dir), real(root))) return "";
	const rel = within(root, dir) ? relative(root, dir) : within(real(root), real(dir)) ? relative(real(root), real(dir)) : undefined;
	return rel === undefined ? undefined : rel.split(sep).join("/");
}

/**
 * Whether a `grep` call rooted at `searchPath` (or `cwd` when omitted) can reach `<cwd>/.pi/pika/` and its `glob`
 * targets, negates, or overrides `.pi/pika/` (bypassing `.pi/pika/.gitignore`).
 */
export function grepGlobTargetsPikaDir(cwd: string, searchPath: string | undefined, glob: string): boolean {
	if (!glob) return false;
	const rel = pikaRelativeToSearchRoot(cwd, searchPath);
	if (rel === undefined) return false;
	const target = rel === "" ? [] : rel.split("/");
	const body = glob.replace(/^!+/, "");
	if (!body) return false;
	const candidates = body.includes("\\")
		? [{ pattern: body, escapes: true }, { pattern: body.replaceAll("\\", "/"), escapes: false }]
		: [{ pattern: body, escapes: true }];
	for (const candidate of candidates) {
		const branches = expandSlashBraces(candidate.pattern, candidate.escapes);
		if (branches === undefined) return true;
		for (const branch of branches) {
			// Match Pi's grep tool, which strips leading `./` before passing `--glob` to ripgrep.
			const trimmed = branch.replace(/^!+/, "").replace(/^(?:\.\/+)+/, "");
			const hasSlash = trimmed.includes("/");
			const trailingSlash = trimmed.endsWith("/");
			const rawSegments: string[] = [];
			for (const seg of trimmed.split("/")) {
				if (seg === "" || seg === ".") continue;
				if (seg === ".." && rawSegments.length > 0 && rawSegments.at(-1) !== "**" && rawSegments.at(-1) !== "..") {
					rawSegments.pop();
					continue;
				}
				if (seg === "**" && rawSegments.at(-1) === "**") continue;
				rawSegments.push(seg);
			}
			const compiled = rawSegments.map((seg) => compileSegment(seg, candidate.escapes));
			if (segmentsTargetPika(compiled, hasSlash, trailingSlash, target)) return true;
		}
	}
	return false;
}

/**
 * Keeps the dream's read tools inside `cwd`, so it reads the project and nothing else the user can, and out of
 * `<cwd>/.pi/pika/`, which holds earlier dreams' own sessions; `grep` and `find` skip it by its `.gitignore`,
 * and `grep` globs that target, negate, or override `.pi/pika/` are blocked too.
 */
const pikaDirGuard = (cwd: string): InlineExtension => ({
	name: "pika-dream-guard",
	factory: (pi) => {
		pi.on("tool_call", (event) => {
			if (!READ_TOOLS.includes(event.toolName)) return undefined;
			const input = event.input as { path?: unknown; glob?: unknown };
			const path = input.path;
			if (typeof path === "string") {
				if (outsideProject(cwd, path, event.toolName)) return { block: true, reason: "A dream reads only inside the project: this path leads outside its working directory." };
				if (inProjectPikaDir(cwd, path, event.toolName)) return { block: true, reason: ".pi/pika/ holds earlier dreams' own sessions, not the user's: a dream does not read it." };
			}
			if (event.toolName === "grep" && typeof input.glob === "string" && grepGlobTargetsPikaDir(cwd, typeof path === "string" ? path : undefined, input.glob)) {
				return { block: true, reason: ".pi/pika/ holds earlier dreams' own sessions, not the user's: a dream does not read it." };
			}
			return undefined;
		});
	},
});

/** The hooks registered in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]`; the Set may not exist. */
function childSessionHooks(): InlineExtension[] {
	const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (!(hooks instanceof Set)) return [];
	return [...hooks as Set<{ name?: unknown; extensionFactory?: unknown }>]
		.filter((hook): hook is { name: string; extensionFactory: ExtensionFactory } => typeof hook?.name === "string" && typeof hook.extensionFactory === "function")
		.map((hook) => ({ name: hook.name, factory: hook.extensionFactory }));
}

async function settle(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([promise.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
	clearTimeout(timer);
}

/**
 * A child session for a dream, persisted unless `persist` is false: the child-session hooks and nothing else of the
 * user's extensions, skills, prompts, or context files; the dream's system prompt; and exactly the read-only built-in
 * tools, kept inside `cwd` and out of `<cwd>/.pi/pika/`, and `customTools`.
 */
export async function spawnDreamChild(options: SpawnOptions): Promise<DreamChild> {
	const { cwd, agentDir } = options;
	const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings();
	const settingsManager = SettingsManager.inMemory(Object.fromEntries(KEPT_SETTINGS.filter((key) => global[key] !== undefined).map((key) => [key, global[key]])), { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [...childSessionHooks(), pikaDirGuard(cwd)],
		systemPromptOverride: () => DREAM_PROMPT,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();
	// A session kept only in memory (`--no-session`) gets a child that writes nothing either.
	if (options.persist) await ensureIgnoredDir(projectPikaDir(cwd));
	const parent = options.parentSessionFile ? { parentSession: options.parentSessionFile } : undefined;
	const sessionManager = options.persist ? SessionManager.create(cwd, dreamSessionDir(cwd), parent) : SessionManager.inMemory(cwd, parent);
	const { session } = await createAgentSession({
		cwd, agentDir, sessionManager, settingsManager, resourceLoader, model: options.model,
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		// An allowlist: the hooks' tools, if any, stay off.
		tools: [...READ_TOOLS, ...options.customTools.map((tool) => tool.name)],
		customTools: options.customTools,
	});
	session.sessionManager.appendCustomEntry(SESSION_LINK_TYPE, {
		kind: "subagent", agentType: DREAM_AGENT_TYPE, parentSessionId: options.parentSessionId,
		...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}), description: "memory dream",
	});
	// Hooked extensions, such as pika's capture, see `session_start` as in any session.
	await session.bindExtensions({});
	let closed: Promise<void> | undefined;
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		model: `${options.model.provider}/${options.model.id}`,
		subscribe: (listener) => session.subscribe((event) => {
			if (event.type === "turn_start") listener({ type: "turn_start" });
			else if (event.type === "turn_end") {
				const answer = event.message.role === "assistant" ? event.message : undefined;
				listener({
					type: "turn_end", toolCalls: Boolean(answer?.content.some((part) => part.type === "toolCall")),
					failed: answer?.stopReason === "error" || answer?.stopReason === "aborted",
				});
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = event.message.usage;
				listener({ type: "usage", usage: { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 } });
			}
		}),
		prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
		steer: async (text) => { await session.steer(text); },
		abort: () => session.abort(),
		lastStop: () => {
			const last = session.messages.findLast((message) => message.role === "assistant");
			return last?.role === "assistant" ? { stopReason: last.stopReason, ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}) } : {};
		},
		// Without `session_shutdown`, pika's capture in the child would never close its stream.
		shutdown: () => closed ??= (async () => {
			try {
				const runner = session.extensionRunner;
				if (runner.hasHandlers("session_shutdown")) await settle(runner.emit({ type: "session_shutdown", reason: "quit" }), dreamLimits.shutdownMs);
			} catch { /* disposed anyway */ }
			session.dispose();
		})(),
	};
}
