import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as PiSDK from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? "");
export const configPaths = (root: string): string[] => ["config.json", "config.local.json"].map((name) => path.join(root, ".impeccable", name));

export async function optionalText(file: string, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	try { const text = await readFile(file, { encoding: "utf8", signal }); signal?.throwIfAborted(); return text; }
	catch (error) { signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Pi's native mutators use these resolveToCwd semantics; the helper is not publicly exported. */
export function resolveEditPath(supplied: string, cwd: string): string {
	let normalized = supplied.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (process.platform === "win32" && !normalized.startsWith("//") && !normalized.includes("\\")) {
		normalized = normalized.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_match, drive: string, suffix: string | undefined) => `${drive.toUpperCase()}:\\${(suffix ?? "").replaceAll("/", "\\")}`);
	}
	if (normalized === "~") normalized = os.homedir();
	else if (normalized.startsWith("~/") || process.platform === "win32" && normalized.startsWith("~\\")) normalized = path.join(os.homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	return path.resolve(cwd, normalized);
}

/** Match upstream context.rs normalization, including quoted/excluded workspace entries. */
function workspacePattern(raw: string): string {
	const pattern = raw.trim().replace(/^['"]|['"]$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
	return pattern.startsWith("!") ? `!${pattern.slice(1).replace(/^\.\//, "")}` : pattern;
}

const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];
const IGNORED_DISCOVERY = new Set(["node_modules", "dist", "build", "coverage", "vendor", "vendors"]);
const exists = async (file: string) => { try { await stat(file); return true; } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; } };
const outside = (relative: string): boolean => relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
async function jsonObject(file: string): Promise<ObjectValue> {
	try { const value: unknown = JSON.parse(await optionalText(file) ?? "{}"); return object(value) ? value : {}; }
	catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
}

/** Upstream context.rs read_project_pattern_groups, including its small pnpm YAML grammar. */
async function projectPatterns(root: string): Promise<string[][]> {
	const explicit: string[] = [];
	for (const file of configPaths(root)) explicit.push(...strings((await jsonObject(file)).projectRoots));
	const pkg = await jsonObject(path.join(root, "package.json"));
	const packagePatterns = strings(object(pkg.workspaces) ? pkg.workspaces.packages : pkg.workspaces);
	packagePatterns.push(...strings((await jsonObject(path.join(root, "lerna.json"))).packages));
	let inPackages = false;
	for (const line of (await optionalText(path.join(root, "pnpm-workspace.yaml")) ?? "").split(/\r?\n/)) {
		let quote = ""; let stripped = "";
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!;
			if ((ch === "'" || ch === '"') && line[i - 1] !== "\\") quote = quote === ch ? "" : quote || ch;
			if (ch === "#" && !quote) break;
			stripped += ch;
		}
		const trimmed = stripped.trim();
		if (!trimmed) continue;
		const flow = /^packages:\s*\[(.*)\]\s*$/.exec(trimmed);
		if (flow) { packagePatterns.push(...(flow[1]!.match(/(?:[^,'"]|'[^']*'|"[^"]*")+/g) ?? []).map((entry) => entry.trim())); inPackages = false; }
		else if (/^packages:\s*$/.test(trimmed)) inPackages = true;
		else if (inPackages && /^[A-Za-z0-9_-]+:\s*/.test(trimmed)) break;
		else if (inPackages && trimmed.startsWith("-")) packagePatterns.push(trimmed.slice(1).trim());
	}
	return [explicit, packagePatterns].map((group) => group.map(workspacePattern).filter(Boolean));
}

async function childDirectories(root: string): Promise<string[]> {
	try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DISCOVERY.has(entry.name)).map((entry) => path.join(root, entry.name)); }
	catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

/** Ancestors within one declaring root, deepest first; Git boundaries do not alter declarations. */
function projectCandidates(root: string, start: string): string[] {
	const candidates: string[] = [];
	let candidate = start;
	while (candidate !== root && !outside(path.relative(root, candidate))) { candidates.push(candidate); candidate = path.dirname(candidate); }
	return candidates;
}

/** Pinned context.rs:1187 segment_matches; only '*' has wildcard meaning. */
export function workspaceSegmentMatches(pattern: string, segment: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return pattern === segment;
	const expression = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
	return new RegExp(`^${expression}$`, "u").exec(segment)?.[0] === segment;
}

/** Pinned context.rs:925: prefix matching, with literal prefix before any exact '**'. */
export function workspacePatternMatchesRel(pattern: string, relative: readonly string[]): boolean {
	const segments = workspacePattern(pattern).split("/").filter(Boolean);
	if (!segments.length) return false;
	if (segments.includes("**")) {
		const prefix = segments.slice(0, segments.findIndex((segment) => segment.includes("*")));
		return relative.length > prefix.length && prefix.every((segment, index) => workspaceSegmentMatches(segment, relative[index]!));
	}
	return relative.length >= segments.length && segments.every((segment, index) => workspaceSegmentMatches(segment, relative[index]!));
}

function excludedProject(root: string, candidates: string[], patterns: string[]): boolean {
	return patterns.some((pattern) => pattern.startsWith("!") && candidates.some((entry) => workspacePatternMatchesRel(pattern.slice(1), path.relative(root, entry).split(path.sep))));
}

/** Shared upstream project-pattern boundary rule for discovery and actual source scope. */
function projectBoundary(root: string, start: string, candidates: string[], patterns: string[], packages: Set<string>): string | undefined {
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) continue;
		const segments = pattern.split("/").filter(Boolean);
		const relative = path.relative(root, start).split(path.sep);
		if (!workspacePatternMatchesRel(pattern, relative)) continue;
		if (!segments.includes("**")) {
			return path.join(root, ...relative.slice(0, segments.length));
		} else {
			// context.rs uses the literal prefix before the first glob, then
			// nearest_package_root_between, then one shallow app segment.
			const prefixLength = segments.findIndex((segment) => segment.includes("*"));
			return candidates.find((entry) => path.relative(root, entry).split(path.sep).length > prefixLength && packages.has(entry)) ?? path.join(root, ...relative.slice(0, prefixLength + 1));
		}
	}
	return undefined;
}

/** context.rs is_selectable_candidate: declarations apply before child Git isolation. */
async function selectableCandidate(root: string, candidate: string, groups: string[][]): Promise<boolean> {
	const candidates = projectCandidates(root, candidate);
	if (!candidates.length || excludedProject(root, candidates, groups[0]!)) return false;
	const packages = new Set((await Promise.all(candidates.map(async (entry) => await exists(path.join(entry, "package.json")) ? entry : undefined))).filter((entry) => entry !== undefined));
	const boundary = projectBoundary(root, candidate, candidates, groups[0]!, packages);
	if (boundary) return boundary === candidate;
	return !excludedProject(root, candidates, groups[1]!);
}

/** A cwd is a directory identity, never a missing source leaf or workspace selector. */
export async function resolveDirectory(cwd: string): Promise<string> {
	const absolute = path.resolve(cwd);
	try {
		const physical = await realpath(absolute);
		if (!(await stat(physical)).isDirectory()) throw new Error("not a directory");
		await access(physical, constants.R_OK | constants.X_OK);
		return physical;
	} catch (error) { throw new Error(`cwd must name an existing accessible directory: ${absolute}`, { cause: error }); }
}

/** Resolve selection BEFORE ancestor/app-boundary resolution. No missing directory fallback. */
export async function resolveTargetPath(cwd: string, target: string): Promise<string> {
	const base = await resolveDirectory(cwd);
	if (!target.trim()) throw new Error("--target requires a path value");
	const absolute = await physicalPath(path.resolve(cwd, target));
	if (await exists(absolute)) return absolute;
	const relative = path.relative(base, absolute);
	const bare = relative && !outside(relative) && relative.split(path.sep).length === 1;
	if (bare) {
		let root = base;
		for (;;) {
			const groups = await projectPatterns(root);
			const marker = (await Promise.all(MONOREPO_MARKERS.map((name) => exists(path.join(root, name))))).some(Boolean);
			if (groups.flat().some((pattern) => !pattern.startsWith("!")) || marker && (await Promise.all(["apps", "packages"].map((name) => childDirectories(path.join(root, name))))).flat().length) {
				const candidates = new Set<string>();
				let visited = 0;
				const expand = async (current: string, segments: string[]): Promise<string[]> => {
					if (++visited > 10_000) throw new Error("Workspace discovery exceeds safe bound; use an existing explicit path");
					if (!segments.length) return await exists(current) ? [current] : [];
					const [segment, ...rest] = segments;
					if (segment === "**") {
						const found: string[] = [];
						const walk = async (dir: string) => {
							if (++visited > 10_000) throw new Error("Workspace discovery exceeds safe bound; use an existing explicit path");
							for (const child of await childDirectories(dir)) {
								if ((await Promise.all(["package.json", "PRODUCT.md", "Product.md", "product.md", "DESIGN.md", "Design.md", "design.md", "src", "app", "pages", "public"].map((name) => exists(path.join(child, name))))).some(Boolean)) found.push(child);
								await walk(child);
							}
						};
						await walk(current);
						return found.length ? found : childDirectories(current);
					}
					if (!segment!.includes("*")) return expand(path.join(current, segment!), rest);
					return (await Promise.all((await childDirectories(current)).filter((child) => workspaceSegmentMatches(segment!, path.basename(child))).map((child) => expand(child, rest)))).flat();
				};
				for (const pattern of groups.flat()) {
					if (pattern.startsWith("!")) continue;
					const segments = pattern.split("/").filter(Boolean);
					const firstGlob = segments.findIndex((segment) => segment.includes("*"));
					// Upstream recursive discovery walks the literal prefix before
					// the first glob, then uses project markers or direct children.
					const roots = segments.includes("**") ? await expand(path.join(root, ...segments.slice(0, firstGlob)), ["**"]) : await expand(root, segments);
					for (const candidate of roots) candidates.add(candidate);
				}
				if (marker) for (const name of ["apps", "packages"]) for (const candidate of await childDirectories(path.join(root, name))) candidates.add(candidate);
				const matches: string[] = [];
				for (const candidate of candidates) {
					const rel = path.relative(root, candidate);
					if (!rel || outside(rel) || path.basename(candidate) !== relative) continue;
					if (await selectableCandidate(root, candidate, groups)) matches.push(candidate);
				}
				if (matches.length === 1) return matches[0]!;
				if (matches.length > 1) throw new Error(`Ambiguous target ${target}; use an existing explicit path`);
				break;
			}
			if (await exists(path.join(root, ".git")) || root === os.homedir() || path.dirname(root) === root) break;
			root = path.dirname(root);
		}
	}
	// A missing source leaf needs an existing explicit parent and must not
	// itself denote a new workspace boundary. Dots never authorize a bare name.
	const parent = path.dirname(absolute);
	if (!bare && path.extname(absolute) && await exists(parent) && (await stat(parent)).isDirectory()) {
		if (await projectForDirectory(base, parent) === await projectForDirectory(base, absolute)) return absolute;
	}
	throw new Error(`Unresolved target ${target}; use an existing app/parent path or unique workspace name`);
}

/** Strict upstream target_args.rs parsing: all forms, last supplied target wins. */
export function parseTargetArgs(argv: readonly string[]): { target?: string; withoutTarget: string[] } {
	let target: string | undefined;
	const withoutTarget: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--target" || arg === "-t") {
			const value = argv[++i];
			if (!value || value.startsWith("-")) throw new Error("--target requires a path value");
			target = value;
		} else if (arg.startsWith("--target=")) {
			target = arg.slice(9);
			if (!target) throw new Error("--target requires a path value");
		} else withoutTarget.push(arg);
	}
	return { target, withoutTarget };
}

/** Focused app boundary; never let a nested package borrow a sibling's configuration. */
export async function resolveProject(cwd: string, target?: string, options: { sourcePath?: boolean } = {}): Promise<string> {
	const base = await resolveDirectory(cwd);
	// Native edit/write capture already supplies an absolute source path, which
	// may be newly created and extensionless; it is not a management selector.
	let dir = target === undefined ? base : options.sourcePath ? await physicalPath(path.resolve(cwd, target)) : await resolveTargetPath(cwd, target);
	try { if (!(await stat(dir)).isDirectory()) dir = path.dirname(dir); }
	catch (error) {
		if (target === undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		dir = path.dirname(dir);
	}
	return projectForDirectory(base, dir);
}

async function projectForDirectory(base: string, dir: string): Promise<string> {
	const start = dir;
	const markers: string[] = [];
	const packages = new Set<string>();
	for (;;) {
		if (await exists(path.join(dir, "package.json"))) packages.add(dir);
		for (const marker of ["package.json", "PRODUCT.md", "DESIGN.md", ".impeccable", ".git"]) {
			try { await lstat(path.join(dir, marker)); if (!markers.includes(dir)) markers.push(dir); } catch { /* ascend */ }
		}
		// Honor explicit projectRoots before package-workspace boundaries, including
		// apps without package.json. Only inspect ancestors of this target.
		const groups = await projectPatterns(dir);
		const candidates = projectCandidates(dir, start);
		for (const patterns of groups) {
			if (excludedProject(dir, candidates, patterns)) return dir;
			const selected = projectBoundary(dir, start, candidates, patterns, packages);
			if (selected) return selected;
		}
		for (const marker of ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"]) {
			try {
				await lstat(path.join(dir, marker));
				const segments = path.relative(dir, start).split(path.sep);
				if (["apps", "packages"].includes(segments[0] ?? "") && segments.length >= 2) return path.join(dir, segments[0]!, segments[1]!);
			} catch { /* no fallback workspace marker */ }
		}
		try { await lstat(path.join(dir, ".git")); break; } catch { /* ascend */ }
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return markers[0] ?? (outside(path.relative(base, start)) ? start : base);
}

export interface ConfigFile { file: string; text: string | undefined; value: ObjectValue }
export async function readConfigs(root: string, signal?: AbortSignal): Promise<ConfigFile[]> {
	return Promise.all(configPaths(root).map(async (file) => {
		const text = await optionalText(file, signal);
		const value: unknown = text === undefined ? {} : JSON.parse(text);
		if (!object(value)) throw new Error(`${file}: expected a JSON object; left unchanged`);
		for (const key of ["hook", "detector"]) if (value[key] !== undefined && !object(value[key])) throw new Error(`${file}: ${key} must be an object; left unchanged`);
		if (text !== undefined) patchJson(text, value);
		return { file, text, value };
	}));
}

export async function hookStatus(root: string, signal?: AbortSignal) {
	const configs = await readConfigs(root, signal);
	const hook = Object.assign({}, ...configs.map((config) => config.value.hook ?? {})) as ObjectValue;
	const enabled = hook.enabled === true && (hook.consent === undefined || hook.consent === "accepted") && !truthy(process.env.IMPECCABLE_HOOK_DISABLED);
	return { root, enabled, hook, detectorSources: configs.map((config) => ({ file: config.file, detector: config.value.detector ?? {}, legacyHookIgnores: config.value.hook ?? {} })), envOverrides: { disabled: process.env.IMPECCABLE_HOOK_DISABLED, quiet: process.env.IMPECCABLE_HOOK_QUIET, log: process.env.IMPECCABLE_HOOK_LOG }, delivery: "Actionable Pi boundary events required; verified on SDK 1.4", configPaths: configs.map((config) => config.file), provider: "pi", adapter: "pi-lifecycle", optInRequired: true, upgrades: "Update the vendored distribution through this repository; runtime update/install/link is disabled." };
}

/** One queue shared by extension instances in this process, including nested sessions. */
const queues = new Map<string, Promise<unknown>>();
export async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(operation);
	queues.set(key, next);
	try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

/** Patch JSON value spans, retaining whitespace, key order and all untouched fields. Strict JSON only. */
export function patchJson(text: string, next: ObjectValue): string {
	const before: unknown = JSON.parse(text);
	if (!object(before)) throw new Error("Expected JSON object");
	let cursor = 0;
	const whitespace = () => { while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
	const stringEnd = () => { cursor++; while (cursor < text.length) { const ch = text[cursor++]; if (ch === "\\") cursor++; else if (ch === '"') return; } };
	type Node = { start: number; end: number; keyStart?: number; members?: Map<string, Node> };
	const parse = (): Node => {
		whitespace(); const start = cursor;
		let members: Map<string, Node> | undefined;
		if (text[cursor] === "{") {
			cursor++; members = new Map(); whitespace();
			while (text[cursor] !== "}") {
				whitespace(); const keyStart = cursor; stringEnd(); const key = JSON.parse(text.slice(keyStart, cursor)) as string;
				if (members.has(key)) throw new Error(`Duplicate JSON key ${key}; left unchanged`);
				whitespace(); cursor++; const child = parse(); child.keyStart = keyStart; members.set(key, child); whitespace(); if (text[cursor] !== ",") break; cursor++;
			}
			cursor++;
		} else if (text[cursor] === "[") {
			cursor++; whitespace(); while (text[cursor] !== "]") { parse(); whitespace(); if (text[cursor] !== ",") break; cursor++; } cursor++;
		} else if (text[cursor] === '"') stringEnd();
		else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
		return { start, end: cursor, members };
	};
	const tree = parse();
	const edits: Array<{ start: number; end: number; value: string }> = [];
	const walk = (node: Node, old: unknown, value: unknown) => {
		if (JSON.stringify(old) === JSON.stringify(value)) return;
		if (object(old) && object(value) && node.members) {
			const members = [...node.members];
			for (let index = 0; index < members.length; index++) {
				const [key, child] = members[index]!;
				if (Object.hasOwn(value, key)) { walk(child, old[key], value[key]); continue; }
				const first = index;
				while (index + 1 < members.length && !Object.hasOwn(value, members[index + 1]![0])) index++;
				const following = members[index + 1]?.[1];
				edits.push({ start: following || first === 0 ? child.keyStart! : members[first - 1]![1].end, end: following ? following.keyStart! : members[index]![1].end, value: "" });
			}
			const added = Object.keys(value).filter((key) => !Object.hasOwn(old, key));
			if (added.length) edits.push({ start: node.end - 1, end: node.end - 1, value: `${Object.keys(old).some((key) => Object.hasOwn(value, key)) ? "," : ""}${added.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(value[key])}`).join(",")}` });
		} else edits.push({ start: node.start, end: node.end, value: JSON.stringify(value) });
	};
	walk(tree, before, next);
	for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
	JSON.parse(text);
	return text;
}

/** Resolve missing files through their nearest existing physical ancestor too. */
export async function physicalPath(file: string): Promise<string> {
	try { return await realpath(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(file);
		if (parent === file) throw error;
		return path.join(await physicalPath(parent), path.basename(file));
	}
}

/** Complete ownership/read/check/commit transaction. Never nest for the same file.
 * Cross-process locks live outside the project, are never stolen, and time out.
 * Missing destinations must use the SDK's lexical queue key. An aliased
 * missing destination is refused: native callers through its physical path
 * would use a different key, so no complete transaction can be guaranteed.
 * Older peers without the public native queue refuse management writes safely.
 */
export async function withManagedFileMutation<T>(file: string, signal: AbortSignal | undefined, operation: (physicalFile: string) => Promise<T>): Promise<T> {
	if (typeof PiSDK.withFileMutationQueue !== "function") throw new Error("This Pi version lacks the shared file mutation queue; management writes are unavailable");
	const result = await serialized(file, async () => {
		signal?.throwIfAborted();
		const physical = await physicalPath(path.resolve(file));
		signal?.throwIfAborted();
		const base = path.join(os.tmpdir(), `pi-impeccable-locks-${process.getuid?.() ?? "user"}`);
		try { await mkdir(base, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const info = await lstat(base);
		if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error("Unsafe management lock directory");
		const lock = path.join(base, createHash("sha256").update(physical).digest("hex"));
		const deadline = performance.now() + 5000;
		for (;;) {
			signal?.throwIfAborted();
			try { await mkdir(lock, { mode: 0o700 }); break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			if (performance.now() >= deadline) throw new Error(`${file}: management lock busy; retry (no stale lock was removed)`);
			await delay(25, undefined, { signal });
		}
		const owner = await lstat(lock);
		try {
			signal?.throwIfAborted();
			return await PiSDK.withFileMutationQueue(file, async () => {
				signal?.throwIfAborted();
				const current = await physicalPath(path.resolve(file));
				if (current !== physical) throw new Error(`${file}: physical target changed concurrently; retry`);
				try { await realpath(file); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					if (physical !== path.resolve(file)) throw new Error(`${file}: missing destination through a path alias cannot share Pi's native queue; retry using the physical destination ${physical}`);
				}
				signal?.throwIfAborted();
				return operation(physical);
			});
		} finally {
			const current = await lstat(lock).catch(() => undefined);
			if (current?.ino === owner.ino && current?.dev === owner.dev) await rmdir(lock);
		}
	});
	signal?.throwIfAborted();
	return result;
}

const execFileAsync = promisify(execFile);

/** Own the exact Git exclude file for a complete read/modify/write or child hook.
 * The upstream hook maintains this file even with IMPECCABLE_CACHE_ROOT set.
 * Never nest a managed mutation for the returned file inside the callback.
 */
export async function withGitExcludeMutation<T>(root: string, signal: AbortSignal | undefined, operation: (file?: string, repository?: string) => Promise<T>): Promise<T> {
	signal?.throwIfAborted();
	let repository: string;
	try { repository = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 2000, maxBuffer: 64 * 1024, signal })).stdout.trim(); }
	catch (error) {
		signal?.throwIfAborted();
		if ((error as { stderr?: string }).stderr?.includes("not a git repository")) return operation();
		throw error;
	}
	signal?.throwIfAborted();
	const gitPath = (await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, timeout: 2000, maxBuffer: 64 * 1024, signal })).stdout.trim();
	signal?.throwIfAborted();
	return withManagedFileMutation(path.resolve(root, gitPath), signal, (file) => operation(file, repository));
}

export async function saveConfig(config: ConfigFile, next: ObjectValue, signal?: AbortSignal, committed?: string[]): Promise<void> {
	await withManagedFileMutation(config.file, signal, async (file) => {
		const fresh = await optionalText(file, signal);
		if (fresh !== config.text) throw new Error(`${config.file} changed concurrently; retry`);
		const text = patchJson(fresh ?? "{}\n", next);
		if (text === fresh) return;
		await atomicWrite(file, text, signal, () => committed?.push(config.file));
	});
}

/** Low-level commit only: caller holds withManagedFileMutation for managed files. */
export async function atomicWrite(file: string, text: string, signal?: AbortSignal, onCommitted?: () => void): Promise<void> {
	signal?.throwIfAborted();
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	let replaced = false;
	const owner = await handle.stat();
	try {
		signal?.throwIfAborted();
		await handle.writeFile(text, { encoding: "utf8", signal });
		await handle.close();
		signal?.throwIfAborted();
		await rename(temporary, file);
		replaced = true;
		onCommitted?.();
		signal?.throwIfAborted();
	} finally {
		await handle.close();
		// After rename this invocation no longer owns the staging pathname.
		if (!replaced) {
			const current = await lstat(temporary).catch(() => undefined);
			if (current?.dev === owner.dev && current?.ino === owner.ino) await unlink(temporary);
		}
	}
}
