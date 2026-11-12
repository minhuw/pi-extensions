/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Ported from @ff-labs/pi-fff@0.11.0 to run against a shared out-of-process
 * IPC sidecar backend across top-level sessions, /reload cycles, and subagents.
 */

import nodeOs from "node:os";
import nodePath from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	sliceByColumn,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	GrepCursor,
	GrepMode,
	GrepResult,
	MixedItem,
	SearchResult,
} from "@ff-labs/fff-node";
import { type Static, Type, type TSchema } from "typebox";
import {
	type FffBackend,
	getSharedFffBackend,
	SCAN_TIMEOUT_MS,
} from "./client.ts";
import { type FffMode, loadConfig, VALID_MODES } from "./config.ts";
import {
	canonicalRoot,
	isFsRoot,
	isHomeDir,
	piDataDir,
	resolveDbPaths,
} from "./paths.ts";
import { buildQuery, rootCovers, routePathConstraint } from "./query.ts";

export { SCAN_TIMEOUT_MS } from "./client.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME_DIR = nodePath.resolve(nodeOs.homedir());
const SESSION_LINK_TYPE = "pi-extensions.session-link";
export const CHILD_SESSION_HOOKS = Symbol.for(
	"pi-extensions.child-session-hooks",
);
const FFF_SHARED_SESSION_STATE_KEY = Symbol.for(
	"pi-extensions.fff.session-state",
);
const LOAD_PROBE_EVENT = "pi-extensions.fff.load-probe";

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

interface FffSharedSessionState {
	boundApis: WeakSet<object>;
	openInstances: Set<object>;
	hook?: ChildSessionHook;
}

function getSharedSessionState(): FffSharedSessionState {
	const store = globalThis as unknown as Record<symbol, unknown>;
	let state = store[FFF_SHARED_SESSION_STATE_KEY] as
		| FffSharedSessionState
		| undefined;
	if (!state) {
		state = {
			boundApis: new WeakSet<object>(),
			openInstances: new Set<object>(),
		};
		store[FFF_SHARED_SESSION_STATE_KEY] = state;
	}
	return state;
}

function getChildHooksSet(): Set<ChildSessionHook> {
	const store = globalThis as unknown as Record<symbol, unknown>;
	let hooks = store[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
	if (!(hooks instanceof Set)) {
		hooks = new Set<ChildSessionHook>();
		store[CHILD_SESSION_HOOKS] = hooks;
	}
	return hooks;
}

function syncChildSessionHook(nextHook?: ChildSessionHook): void {
	const state = getSharedSessionState();
	if (nextHook) {
		state.hook = nextHook;
	}
	const hooks = getChildHooksSet();
	for (const item of [...hooks]) {
		if (item.name === "fff" && item !== state.hook) {
			hooks.delete(item);
		}
	}
	if (state.openInstances.size > 0 && state.hook) {
		hooks.add(state.hook);
	} else if (state.hook) {
		hooks.delete(state.hook);
	}
}

function hasRegisteredFffTools(pi: ExtensionAPI): boolean {
	try {
		const allTools = (
			pi as { getAllTools?: () => Array<{ name?: unknown }> }
		).getAllTools?.();
		if (
			Array.isArray(allTools) &&
			allTools.some(
				(tool) =>
					tool?.name === FFF_TOOL_NAMES.find ||
					tool?.name === FFF_TOOL_NAMES.grep,
			)
		) {
			return true;
		}
	} catch {
		// Action methods throw during DefaultResourceLoader's load phase; expected.
	}
	return false;
}

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
// Per-file match cap. Must stay decoupled from pageSize: grep cursors advance by
// file offset, so clamping this to pageSize makes same-file overflow unreachable
// on later pages (#825). Matches the engine default.
const GREP_MAX_MATCHES_PER_FILE = 200;
const GREP_CONTEXT_MAX = 20;
const GREP_MAX_LINE_LENGTH = 500;
const MENTION_MAX_RESULTS = 20;

// If we exceed 10 seconds for indexed grep - something is definitely off
const GREP_TIME_BUDGET_MS = 10_000;

const HOME_SCAN_STATUS_KEY = "fff";
const HOME_SCAN_POLL_MS = 1_000;
const HOME_SCAN_DISABLE_HINT =
	'You can prevent home dir indexing with --fff-enable-home-scan=false, FFF_ENABLE_HOME_SCAN=0, or "enableHomeDirScanning": false in pi-fff.json. ' +
	'To keep indexing but silence this warning use --fff-warn-home-scan=false, FFF_WARN_HOME_SCAN=0, or "warnOnHomeDirScan": false in pi-fff.json.';

interface ToolNames {
	grep: string;
	find: string;
	multiGrep: string;
}

const FFF_TOOL_NAMES: ToolNames = {
	grep: "ffgrep",
	find: "fffind",
	multiGrep: "fff-multi-grep",
};
const OVERRIDE_TOOL_NAMES: ToolNames = {
	grep: "grep",
	find: "find",
	multiGrep: "multi_grep",
};

function resolveToolNames(mode: FffMode): ToolNames {
	return mode === "override" ? OVERRIDE_TOOL_NAMES : FFF_TOOL_NAMES;
}

function toolNameList(names: ToolNames): string[] {
	return [names.grep, names.find, names.multiGrep];
}

function isChildSession(
	ctx: Pick<ExtensionContext, "mode" | "sessionManager">,
): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return true;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	return entries.some(
		(entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE,
	);
}

// ---------------------------------------------------------------------------
// Cursor store — process-wide reload-safe FIFO cache for pagination cursors
// ---------------------------------------------------------------------------

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
	query: string;
	pattern: string;
	pageSize: number;
	nextPageIndex: number;
	auxRoot?: string;
}

interface CursorStore {
	grep: Map<string, GrepCursor>;
	find: Map<string, FindCursor>;
	seq: number;
}

const CURSOR_STORE_KEY = Symbol.for("pi-extensions.fff.cursors");
const CURSOR_CACHE_MAX = 1_000;

function getCursorStore(): CursorStore {
	const globalStore = globalThis as unknown as Record<symbol, unknown>;
	const existing = globalStore[CURSOR_STORE_KEY] as CursorStore | undefined;
	if (existing) {
		return existing;
	}
	const created: CursorStore = {
		grep: new Map<string, GrepCursor>(),
		find: new Map<string, FindCursor>(),
		seq: 0,
	};
	globalStore[CURSOR_STORE_KEY] = created;
	return created;
}

function setBoundedCursor<V>(map: Map<string, V>, id: string, value: V): void {
	if (map.has(id)) {
		map.delete(id);
	}
	map.set(id, value);
	while (map.size > CURSOR_CACHE_MAX) {
		const first = map.keys().next().value;
		if (first === undefined) break;
		map.delete(first);
	}
}

function storeCursor(cursor: GrepCursor): string {
	const store = getCursorStore();
	const id = `fff_c${++store.seq}`;
	setBoundedCursor(store.grep, id, cursor);
	return id;
}

function getCursor(id: string): GrepCursor | undefined {
	return getCursorStore().grep.get(id);
}

function storeFindCursor(cursor: FindCursor): string {
	const store = getCursorStore();
	const id = `${++store.seq}`;
	setBoundedCursor(store.find, id, cursor);
	return id;
}

function getFindCursor(id: string): FindCursor | undefined {
	return getCursorStore().find.get(id);
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// Clamp caller-supplied context to a non-negative bounded integer so a large
// value cannot multiply output size past the model window.
function clampContext(context: number | undefined): number {
	if (!context || context < 0) return 0;
	return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
export function fffFileAnnotation(item: {
	gitStatus?: string;
	totalFrecencyScore?: number;
	accessFrecencyScore?: number;
}): string {
	const git = item.gitStatus;
	if (git && git !== "clean" && git !== "unknown" && git !== "") {
		return `  [${git} in git]`;
	}

	const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
	if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
	if (frecency >= WARM_FRECENCY) return "  [often touched file]";

	return "";
}

// DO NOT ATTEMPT TO RESORT OUTPUT HERE IT ONLY CONFUSES MODELS
function formatGrepOutput(result: GrepResult): string {
	if (result.items.length === 0) return "No matches found";

	// Build file-grouped output in the order files first appear in the result.
	// This preserves native frecency ordering across files without re-sorting.
	const lines: string[] = [];
	let currentFile = "";

	for (const match of result.items) {
		if (match.relativePath !== currentFile) {
			if (lines.length > 0) lines.push("");
			currentFile = match.relativePath;
			lines.push(`${currentFile}${fffFileAnnotation(match)}`);
		}

		match.contextBefore?.forEach((line: string, i: number) => {
			const lineNum = match.lineNumber - match.contextBefore!.length + i;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});

		lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		match.contextAfter?.forEach((line: string, i: number) => {
			const lineNum = match.lineNumber + 1 + i;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});
	}

	return lines.join("\n");
}

// Weak-match threshold is derived from the query length, matching the
// scoring formula in crates/fff-core/src/score.rs: when the top score is weak,
// trim output to a small sample instead of dumping the full limit worth of
// noise into the agent's context.
const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
	const perfect = pattern.length * 12;
	return Math.floor((perfect * 50) / 100);
}

interface FormattedFind {
	output: string;
	weak: boolean;
	shownCount: number;
}

function formatFindOutput(
	result: SearchResult,
	limit: number,
	pattern: string,
): FormattedFind {
	if (result.items.length === 0) {
		return {
			output: "No files found matching pattern",
			weak: false,
			shownCount: 0,
		};
	}

	// NO CUSTOM SORTING — trust native frecency order from the engine.
	const reordered = result.items.map((item) => ({ item }));

	// Peek at the top native score to decide whether results are scattered
	// fuzzy noise (query length-scaled threshold from score.rs).
	const topScore = result.scores[0]?.total ?? 0;
	const weak = topScore < weakScoreThreshold(pattern);
	const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
	const shown = reordered.slice(0, effective);

	return {
		output: shown
			.map((p) => `${p.item.relativePath}${fffFileAnnotation(p.item)}`)
			.join("\n"),
		weak,
		shownCount: shown.length,
	};
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) return null;

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			return options.signal.aborted || items.length === 0
				? null
				: { items, prefix };
		},
		applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = _lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const newLine = before + item.value + after;
			const newCursorCol = cursorCol - prefix.length + item.value.length;
			return {
				lines: [
					..._lines.slice(0, cursorLine),
					newLine,
					..._lines.slice(cursorLine + 1),
				],
				cursorLine,
				cursorCol: newCursorCol,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export interface FffExtensionOptions {
	backend?: FffBackend;
	agentDir?: string;
}

export function createFffExtension(
	options?: FffExtensionOptions,
): (pi: ExtensionAPI) => void {
	const childHook: ChildSessionHook = {
		name: "fff",
		extensionFactory: (childPi: ExtensionAPI) => {
			activateFffExtension(childPi, true);
		},
	};

	function activateFffExtension(
		pi: ExtensionAPI,
		fromChildHook: boolean,
	): void {
		const sharedState = getSharedSessionState();
		if (sharedState.boundApis.has(pi)) return;
		if (fromChildHook && hasRegisteredFffTools(pi)) return;

		// Deduplicate when a child session loads `fff` both by discovered path and via `CHILD_SESSION_HOOKS`.
		let inLoadPass = true;
		const events = (
			pi as {
				events?: {
					emit?: (channel: string, data: unknown) => void;
					on?: (channel: string, handler: (data: unknown) => void) => unknown;
				};
			}
		).events;
		if (
			events &&
			typeof events.emit === "function" &&
			typeof events.on === "function"
		) {
			const probe = { alreadyLoaded: false };
			events.emit(LOAD_PROBE_EVENT, probe);
			if (probe.alreadyLoaded) return;
			events.on(LOAD_PROBE_EVENT, (data) => {
				if (inLoadPass && data && typeof data === "object") {
					(data as { alreadyLoaded: boolean }).alreadyLoaded = true;
				}
			});
		}

		sharedState.boundApis.add(pi);
		const instanceToken = {};

		const backend = options?.backend ?? getSharedFffBackend();
		const config = loadConfig(options?.agentDir ?? piDataDir());

		let activeCwd = process.cwd();
		let currentWorkspaceRoot: string | null = null;
		let childSession = fromChildHook;
		let startupConfigResolved = false;

		function hasAdmittedFffTool(): boolean {
			const getAllTools = (
				pi as { getAllTools?: () => Array<{ name?: unknown }> }
			).getAllTools;
			if (typeof getAllTools !== "function") return true;
			try {
				const admitted = new Set(
					getAllTools().map((t) => (typeof t?.name === "string" ? t.name : "")),
				);
				return toolNameList(toolNames).some((name) => admitted.has(name));
			} catch {
				return true;
			}
		}

		// All startup options use the same flag > env > file > fallback order.
		function getConfigValue<T>(
			flagName: string,
			envName: string,
			fileValue: T | undefined,
			fallback: T,
			parse: (value: unknown) => T | undefined = (value) => value as T,
		): T {
			const flagValue = pi.getFlag(flagName);
			if (flagValue !== undefined) {
				const value = parse(flagValue);
				if (value !== undefined) return value;
			}

			const envValue = process.env[envName];
			if (envValue !== undefined) {
				const value = parse(envValue);
				if (value !== undefined) return value;
			}

			return fileValue ?? fallback;
		}

		function parseBoolean(value: unknown): boolean | undefined {
			if (typeof value === "boolean") return value;
			if (value === "1" || value === "true") return true;
			if (value === "0" || value === "false") return false;
			return undefined;
		}

		function parseMode(value: unknown): FffMode | undefined {
			return typeof value === "string" &&
				VALID_MODES.includes(value as FffMode)
				? (value as FffMode)
				: undefined;
		}

		let currentMode: FffMode = "tools-and-ui";
		let toolNames = resolveToolNames(currentMode);
		let resolvedDbPaths = resolveDbPaths(
			{
				frecency: config.frecencyDbPath,
				history: config.historyDbPath,
			},
			options?.agentDir ?? piDataDir(),
		);
		let enableFsRootScanning = false;
		let enableHomeDirScanning = true;
		let warnOnHomeDirScan = true;
		let followSymlinks = true;

		function setMode(mode: FffMode): void {
			currentMode = mode;
			toolNames = resolveToolNames(mode);
		}

		function resolveStartupConfig(): void {
			setMode(
				fromChildHook
					? "tools-only"
					: getConfigValue(
							"fff-mode",
							"PI_FFF_MODE",
							config.mode,
							"tools-and-ui",
							parseMode,
						),
			);
			resolvedDbPaths = resolveDbPaths(
				{
					frecency: getConfigValue(
						"fff-frecency-db",
						"FFF_FRECENCY_DB",
						config.frecencyDbPath,
						undefined,
					),
					history: getConfigValue(
						"fff-history-db",
						"FFF_HISTORY_DB",
						config.historyDbPath,
						undefined,
					),
				},
				options?.agentDir ?? piDataDir(),
			);

			// Root scanning opt-in: FFF refuses to init at / unless this is set.
			enableFsRootScanning = getConfigValue(
				"fff-enable-root-scan",
				"FFF_ENABLE_ROOT_SCAN",
				config.enableFsRootScanning,
				false,
				parseBoolean,
			);
			// Home dir scanning is on by default (launching pi from $HOME is a normal
			// flow), but configurable so users with huge $HOME trees can opt out.
			enableHomeDirScanning = getConfigValue(
				"fff-enable-home-scan",
				"FFF_ENABLE_HOME_SCAN",
				config.enableHomeDirScanning,
				true,
				parseBoolean,
			);
			warnOnHomeDirScan = getConfigValue(
				"fff-warn-home-scan",
				"FFF_WARN_HOME_SCAN",
				config.warnOnHomeDirScan,
				true,
				parseBoolean,
			);
			// On by default: worktree and stow layouts reach their files through links,
			// and an agent silently missing them is worse than the extra walk.
			followSymlinks = getConfigValue(
				"fff-follow-symlinks",
				"FFF_FOLLOW_SYMLINKS",
				config.followSymlinks,
				true,
				parseBoolean,
			);
			startupConfigResolved = true;
		}

		function getMode(): FffMode {
			return currentMode;
		}

		function shouldEnableMentions(): boolean {
			return currentMode !== "tools-only";
		}

		// Set on session_start; the only handle to the UI outside an event handler.
		// setStatus is TUI/RPC-only, hence optional.
		let uiCtx: {
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => void;
				setStatus?: (key: string, text: string | undefined) => void;
			};
		} | null = null;
		let reportedDbFallback = false;
		const registeredAutocompleteUis = new WeakSet<object>();
		let homeScanTimer: ReturnType<typeof setInterval> | null = null;
		let homeScanGeneration = 0;
		let homeScanInFlight = false;

		function warnHomeDirScan(root: string): void {
			if (childSession || !warnOnHomeDirScan) return;
			uiCtx?.ui.notify(
				`(fff): Your cwd (${root}) is too large. Indexing will take additional time and resources.\n${HOME_SCAN_DISABLE_HINT}`,
				"warning",
			);
		}

		function notifyDbFallback(error: string): void {
			if (childSession || reportedDbFallback || !uiCtx) return;
			reportedDbFallback = true;
			uiCtx.ui.notify(
				`(fff): Failed to open frecency/history database (${error}). Continuing without frecency persistence.`,
				"error",
			);
		}

		// The native layer refuses a picker rooted at $HOME / the fs root unless the
		// matching opt-in is set (crates/fff-core/src/file_picker.rs). Detect that here
		// so the opt-out reads as "search off" instead of an init failure (issue #857).
		function scanOptOutReason(cwd: string): string | null {
			if (!enableHomeDirScanning && isHomeDir(cwd)) {
				return `(fff): cwd is $HOME and "enableHomeDirScanning" is false, so FFF search is disabled for this session. Start pi from a project directory, or set "enableHomeDirScanning": true / --fff-enable-home-scan=true to index $HOME.`;
			}
			if (!enableFsRootScanning && isFsRoot(cwd)) {
				return `(fff): cwd is the filesystem root and "enableFsRootScanning" is false, so FFF search is disabled for this session. Start pi from a project directory, or set "enableFsRootScanning": true / --fff-enable-root-scan=true to index it.`;
			}
			return null;
		}

		async function ensureWorkspaceRoot(
			cwd: string,
			signal?: AbortSignal,
		): Promise<string> {
			if (!startupConfigResolved) resolveStartupConfig();
			const optOut = scanOptOutReason(cwd);
			if (optOut) throw new Error(optOut);

			const res = await backend.ensureRoot(
				{
					basePath: cwd,
					kind: "workspace",
					frecencyDbPath: resolvedDbPaths.frecency,
					historyDbPath: resolvedDbPaths.history,
					enableHomeDirScanning,
					enableFsRootScanning,
					followSymlinks,
					waitTimeoutMs: SCAN_TIMEOUT_MS,
				},
				signal,
			);
			if (res.dbFallbackError && !childSession) {
				notifyDbFallback(res.dbFallbackError);
			}
			if (cwd === activeCwd) {
				currentWorkspaceRoot = res.root;
			}
			return res.root;
		}

		function stopHomeScanStatus(): void {
			homeScanGeneration++;
			homeScanInFlight = false;
			if (homeScanTimer) {
				clearInterval(homeScanTimer);
				homeScanTimer = null;
			}
			if (!childSession) {
				uiCtx?.ui.setStatus?.(HOME_SCAN_STATUS_KEY, undefined);
			}
		}

		// waitForScan() resolves on timeout too, so the scan can still be running.
		// Poll the live progress until it settles, then clear the footer.
		function trackHomeScanStatus(root: string): void {
			stopHomeScanStatus();
			if (childSession || !uiCtx?.ui.setStatus) return;

			const gen = homeScanGeneration;
			const tick = async () => {
				if (gen !== homeScanGeneration || homeScanInFlight) return;
				homeScanInFlight = true;
				try {
					const progress = await backend.getScanProgress(root);
					if (gen !== homeScanGeneration) return;
					if (!progress.ok || !progress.value.isScanning) {
						stopHomeScanStatus();
						return;
					}
					uiCtx?.ui.setStatus?.(
						HOME_SCAN_STATUS_KEY,
						`Agent is indexing $HOME (${progress.value.scannedFilesCount} files), this can lead to high CPU`,
					);
				} catch {
					if (gen === homeScanGeneration) {
						stopHomeScanStatus();
					}
				} finally {
					if (gen === homeScanGeneration) {
						homeScanInFlight = false;
					}
				}
			};

			homeScanTimer = setInterval(() => {
				void tick();
			}, HOME_SCAN_POLL_MS);
			// Must not hold the process open once pi is done.
			(homeScanTimer as { unref?: () => void }).unref?.();
			void tick();
		}

		async function resolveFinderForPath(
			pathParam: string | undefined,
			pattern: string,
			exclude: string | string[] | undefined,
			cwd: string,
			signal?: AbortSignal,
		): Promise<{ root: string; query: string } | null> {
			if (!startupConfigResolved) resolveStartupConfig();
			const route = routePathConstraint(pathParam, cwd);
			if (!route) return null;

			const canonRouteRoot = canonicalRoot(route.root);
			const aux = await backend.ensureRoot(
				{
					basePath: route.root,
					kind: "aux",
					frecencyDbPath: resolvedDbPaths.frecency,
					historyDbPath: resolvedDbPaths.history,
					enableHomeDirScanning,
					enableFsRootScanning,
					followSymlinks,
					waitTimeoutMs: SCAN_TIMEOUT_MS,
				},
				signal,
			);
			if (aux.dbFallbackError && !childSession) {
				notifyDbFallback(aux.dbFallbackError);
			}
			if (
				aux.created === true &&
				!childSession &&
				enableHomeDirScanning &&
				rootCovers(aux.root, canonicalRoot(HOME_DIR))
			) {
				warnHomeDirScan(aux.root);
			}

			// A broader covering picker may have been reused; rebase the suffix so the
			// constraint stays relative to the picker's actual root.
			const rebase = nodePath
				.relative(aux.root, canonRouteRoot)
				.replaceAll(nodePath.sep, "/");
			const suffix = [rebase, route.suffix].filter(Boolean).join("/");
			const query = buildQuery(suffix || undefined, pattern, exclude, aux.root);
			return { root: aux.root, query };
		}

		async function getMentionItems(
			query: string,
			signal: AbortSignal,
		): Promise<AutocompleteItem[]> {
			if (signal.aborted) return [];
			const root = await ensureWorkspaceRoot(activeCwd, signal);
			if (signal.aborted) return [];

			const result = await backend.mixedSearch(
				root,
				query,
				{ pageSize: MENTION_MAX_RESULTS },
				signal,
			);
			if (!result.ok) return [];

			return result.value.items
				.slice(0, MENTION_MAX_RESULTS)
				.map((mixed: MixedItem) => {
					if (mixed.type === "directory") {
						return {
							value: buildAtCompletionValue(mixed.item.relativePath),
							label: mixed.item.dirName,
							description: mixed.item.relativePath,
						};
					}
					return {
						value: buildAtCompletionValue(mixed.item.relativePath),
						label: mixed.item.fileName,
						description: mixed.item.relativePath,
					};
				});
		}

		function registerAutocompleteProvider(ctx: {
			ui: {
				addAutocompleteProvider?: (
					factory: (current: AutocompleteProvider) => AutocompleteProvider,
				) => void;
			};
		}) {
			// pi forks (e.g. omp) may not expose addAutocompleteProvider; skip UI wiring
			// and let tools continue to work instead of failing session_start.
			if (typeof ctx.ui.addAutocompleteProvider !== "function") return;
			if (registeredAutocompleteUis.has(ctx.ui)) return;
			registeredAutocompleteUis.add(ctx.ui);

			ctx.ui.addAutocompleteProvider((current) => {
				const mentionProvider = createFffMentionProvider(getMentionItems);

				return {
					async getSuggestions(lines, cursorLine, cursorCol, suggestOptions) {
						if (shouldEnableMentions()) {
							try {
								const mentionResult = await mentionProvider.getSuggestions(
									lines,
									cursorLine,
									cursorCol,
									suggestOptions,
								);
								if (mentionResult) return mentionResult;
							} catch {
								// Delegate when FFF lookup is unavailable.
							}
						}

						return current.getSuggestions(
							lines,
							cursorLine,
							cursorCol,
							suggestOptions,
						);
					},
					applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
						return current.applyCompletion(
							lines,
							cursorLine,
							cursorCol,
							item,
							prefix,
						);
					},
					shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
						return (
							current.shouldTriggerFileCompletion?.(
								lines,
								cursorLine,
								cursorCol,
							) ?? true
						);
					},
				};
			});
		}

		type ToolExecuteFn = ToolDefinition<TSchema, unknown, unknown>["execute"];
		type RenderCallContext<TState> = Parameters<
			NonNullable<ToolDefinition<TSchema, unknown, TState>["renderCall"]>
		>[2];

		type PendingToolDefinition<
			TParams extends TSchema,
			TDetails = unknown,
			TState = unknown,
		> = Omit<
			ToolDefinition<TSchema, TDetails, TState>,
			| "name"
			| "label"
			| "parameters"
			| "promptGuidelines"
			| "execute"
			| "renderCall"
			| "renderResult"
		> & {
			parameters: TParams;
			promptGuidelines?: (names: ToolNames) => string[];
			execute: (
				toolCallId: string,
				params: Static<TParams>,
				signal: AbortSignal | undefined,
				onUpdate: Parameters<
					ToolDefinition<TSchema, TDetails, TState>["execute"]
				>[3],
				ctx: Parameters<ToolExecuteFn>[4],
			) => Promise<AgentToolResult<TDetails>>;
			renderCall?: (
				args: Static<TParams>,
				theme: Theme,
				context: RenderCallContext<TState>,
			) => Component;
			renderResult?: (
				result: AgentToolResult<TDetails>,
				renderOptions: ToolRenderResultOptions,
				theme: Theme,
				context: RenderCallContext<TState>,
			) => Component;
		};

		const pendingTools: (() => string)[] = [];
		const registeredToolNames = new Set<string>();
		// A renderer is attached to a concrete registered name. Keep that name outside
		// row state so old ffgrep rows retain their title after mode changes to override.
		const renderToolNames = new WeakMap<object, string>();
		let toolsRegistered = false;

		function getRenderToolName(context: object, fallback: string): string {
			return renderToolNames.get(context) ?? fallback;
		}

		function registerTool<
			TParams extends TSchema,
			TDetails = unknown,
			TState = unknown,
		>(
			resolveName: () => string,
			definition: PendingToolDefinition<TParams, TDetails, TState>,
		): string {
			const resolvedName = resolveName();
			if (registeredToolNames.has(resolvedName)) return resolvedName;

			const {
				promptGuidelines,
				execute,
				renderCall,
				renderResult,
				...tool
			} = definition;
			pi.registerTool<TSchema, TDetails, TState>({
				...tool,
				name: resolvedName,
				label: resolvedName,
				promptGuidelines: promptGuidelines?.(toolNames),
				execute: (toolCallId, params, signal, onUpdate, ctx) =>
					execute(
						toolCallId,
						params as Static<TParams>,
						signal,
						onUpdate,
						ctx,
					),
				renderCall: renderCall
					? (args, theme, context) => {
							renderToolNames.set(context, resolvedName);
							return renderCall(args as Static<TParams>, theme, context);
						}
					: undefined,
				renderResult: renderResult
					? (result, renderOptions, theme, context) =>
							renderResult(result, renderOptions, theme, context)
					: undefined,
			});
			registeredToolNames.add(resolvedName);
			return resolvedName;
		}

		function queueTool<
			TParams extends TSchema,
			TDetails = unknown,
			TState = unknown,
		>(
			resolveName: () => string,
			definition: PendingToolDefinition<TParams, TDetails, TState>,
		): void {
			pendingTools.push(() => registerTool(resolveName, definition));

			// Pi restores historical tool rows before session_start. Register the
			// FFF-named tools now so their renderers resolve. Pi activates every
			// newly registered tool, so registerPendingTools prunes the names the
			// final mode did not select.
			registerTool(resolveName, definition);
		}

		// Pi carries the active tool list across /reload, so names activated under a
		// previously used mode stay active unless we drop them here (#855).
		function registerPendingTools(staleNames: readonly string[]): void {
			if (toolsRegistered) return;

			const registeredNames = new Set(
				pendingTools.map((register) => register()),
			);
			const stale = new Set(
				staleNames.filter((name) => !registeredNames.has(name)),
			);
			pi.setActiveTools([
				...new Set([
					...pi.getActiveTools().filter((name) => !stale.has(name)),
					...registeredNames,
				]),
			]);
			toolsRegistered = true;
		}

		// --- Flags / lifecycle ---

		pi.registerFlag("fff-mode", {
			description: "FFF mode: tools-and-ui | tools-only | override",
			type: "string",
		});

		pi.registerFlag("fff-frecency-db", {
			description:
				"Path to the frecency database (overrides FFF_FRECENCY_DB env)",
			type: "string",
		});

		pi.registerFlag("fff-history-db", {
			description:
				"Path to the query history database (overrides FFF_HISTORY_DB env)",
			type: "string",
		});

		pi.registerFlag("fff-enable-root-scan", {
			description:
				"Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
			type: "boolean",
		});

		pi.registerFlag("fff-enable-home-scan", {
			description:
				"Index the home dir when launched from $HOME (default true; disable with --fff-enable-home-scan=false or FFF_ENABLE_HOME_SCAN=0)",
			type: "boolean",
		});

		pi.registerFlag("fff-follow-symlinks", {
			description:
				"Index through directory symlinks, e.g. a git worktree or stow layout (default true; disable with --fff-follow-symlinks=false or FFF_FOLLOW_SYMLINKS=0)",
			type: "boolean",
		});

		pi.registerFlag("fff-warn-home-scan", {
			description:
				"Warn when indexing $HOME (default true; silence with --fff-warn-home-scan=false or FFF_WARN_HOME_SCAN=0)",
			type: "boolean",
		});

		function reportInitFailure(ctx: ExtensionContext, error: unknown): void {
			if (childSession) return;
			ctx.ui.notify(
				`FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}

		function prepareSession(ctx: ExtensionContext): void {
			activeCwd = ctx.cwd;
			childSession = fromChildHook || isChildSession(ctx);
			uiCtx = ctx;
			if (toolsRegistered) return;

			// Pi populates extension flag values after loading extensions.
			resolveStartupConfig();

			// FFF-named tools are ours alone, so they are always safe to drop. Override
			// names collide with pi's builtins and are only stale once this session ran
			// in override mode, which is the sole way we could have activated them.
			const staleNames = toolNameList(FFF_TOOL_NAMES);
			let usedOverride = currentMode === "override";

			// Restore persisted mode before registering tools so a saved override
			// can safely change their names after /reload or session resume.
			if (!fromChildHook) {
				const modes = sessionModes(ctx.sessionManager?.getEntries?.());
				if (modes.length > 0) {
					const restored = modes[modes.length - 1]!;
					if (restored !== currentMode) setMode(restored);
					usedOverride = usedOverride || modes.includes("override");
				}
			}

			// `override` replaces pi's built-in grep/find. With the cwd opted out of
			// indexing that would leave the session without any working workspace
			// search, so keep the FFF names and let the built-ins stand (issue #857).
			const keepBuiltins =
				currentMode === "override" && scanOptOutReason(activeCwd) !== null;
			if (keepBuiltins) toolNames = FFF_TOOL_NAMES;

			// Pruning the override names here would deactivate the built-ins #857 just
			// chose to keep, so only prune once FFF really takes those names over.
			if (usedOverride && !keepBuiltins) {
				staleNames.push(...toolNameList(OVERRIDE_TOOL_NAMES));
			}

			registerPendingTools(staleNames);
		}

		pi.on("session_start", async (_event, ctx) => {
			inLoadPass = false;
			const isChild = fromChildHook || isChildSession(ctx);
			sharedState.openInstances.add(instanceToken);
			syncChildSessionHook(
				!isChild || !sharedState.hook ? childHook : undefined,
			);
			currentWorkspaceRoot = null;
			stopHomeScanStatus();
			try {
				prepareSession(ctx);
				if (!childSession) {
					registerAutocompleteProvider(ctx);
				} else if (!hasAdmittedFffTool()) {
					return;
				}

				// The user opted out of indexing this cwd, so skip the picker entirely
				// instead of letting the native refusal surface as an error (issue #857).
				const optOut = scanOptOutReason(activeCwd);
				if (optOut) {
					if (!childSession) {
						ctx.ui.notify(optOut, "warning");
					}
					return;
				}

				const root = await ensureWorkspaceRoot(activeCwd);

				// Warn when launched from $HOME with home scanning on: indexing a large
				// home tree can run for a long time in the background (issue #743).
				const atHome =
					!childSession && enableHomeDirScanning && isHomeDir(activeCwd);
				if (atHome) {
					warnHomeDirScan(activeCwd);
					ctx.ui.setStatus?.(
						HOME_SCAN_STATUS_KEY,
						"Agent is indexing $HOME, this can lead to high CPU",
					);
					trackHomeScanStatus(root);
				}
			} catch (error: unknown) {
				reportInitFailure(ctx, error);
			}
		});

		// SDK callers can prompt without binding session_start. Prepare on the first
		// agent turn as a fallback so the tools still reach that turn's tool set.
		pi.on("before_agent_start", (_event, ctx) => {
			if (toolsRegistered) return;
			try {
				prepareSession(ctx);
			} catch (error: unknown) {
				reportInitFailure(ctx, error);
			}
		});

		pi.on("session_shutdown", async () => {
			stopHomeScanStatus();
			sharedState.openInstances.delete(instanceToken);
			syncChildSessionHook();
		});

		// --- Shared render helpers ---

		class CollapsedText implements Component {
			private readonly preview: string;
			private readonly suffix: string;
			private readonly marker: string;

			constructor(preview: string, suffix: string, marker: string) {
				this.preview = preview;
				this.suffix = suffix;
				this.marker = marker;
			}

			render(width: number): string[] {
				const availableWidth = Math.max(1, width);
				if (!this.suffix) {
					if (visibleWidth(this.preview) <= availableWidth) {
						return [this.preview];
					}
					const markerWidth = visibleWidth(this.marker);
					if (markerWidth >= availableWidth) {
						return [sliceByColumn(this.marker, 0, availableWidth, true)];
					}
					return [
						`${sliceByColumn(this.preview, 0, availableWidth - markerWidth, true)}${this.marker}`,
					];
				}

				const suffixWidth = visibleWidth(this.suffix);
				if (suffixWidth >= availableWidth) {
					return [sliceByColumn(this.suffix, 0, availableWidth, true)];
				}

				const previewWidth = availableWidth - suffixWidth - 1;
				if (visibleWidth(this.preview) <= previewWidth) {
					return [`${this.preview} ${this.suffix}`];
				}

				const markerWidth = visibleWidth(this.marker);
				return [
					`${sliceByColumn(this.preview, 0, Math.max(0, previewWidth - markerWidth), true)}${this.marker} ${this.suffix}`,
				];
			}

			invalidate(): void {}
		}

		// Pi wraps returned components in its own click-to-expand MouseRegion and passes
		// the toggled state via options.expanded, so no custom mouse handling is needed.
		const renderCompactTextResult = (
			result: { content?: { type: string; text?: string }[] },
			renderOptions: { expanded?: boolean },
			theme: Theme,
			context: { isError?: boolean },
		): Component => {
			const output =
				result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
			if (!output) return new Text(theme.fg("muted", "No output"), 0, 0);

			const lines = output.split("\n");
			const color = context.isError ? "error" : "toolOutput";
			if (renderOptions.expanded) {
				return new Text(
					lines.map((line) => theme.fg(color, line)).join("\n"),
					0,
					0,
				);
			}

			const suffix =
				lines.length > 1
					? theme.fg("muted", `... (${lines.length - 1} more lines)`)
					: "";
			return new CollapsedText(
				theme.fg(color, lines[0] ?? ""),
				suffix,
				theme.fg("muted", "..."),
			);
		};

		const renderPreviewResult = (
			result: { content?: { type: string; text?: string }[] },
			renderOptions: { expanded?: boolean },
			theme: Theme,
			context: { lastComponent?: Component },
			maxLines = 15,
		): Component => {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output =
				result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
			if (!output) {
				text.setText(theme.fg("muted", "No output"));
				return text;
			}

			const lines = output.split("\n");
			const displayLines = lines.slice(
				0,
				renderOptions.expanded ? lines.length : maxLines,
			);
			let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
			if (lines.length > displayLines.length) {
				content += theme.fg(
					"muted",
					`\n... (${lines.length - displayLines.length} more lines)`,
				);
			}
			text.setText(content);
			return text;
		};

		// --- grep tool ---

		const grepSchema = Type.Object({
			pattern: Type.String({
				description: "Search pattern (literal text or regex)",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
				}),
			),
			exclude: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description:
						"Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
				}),
			),
			caseSensitive: Type.Optional(
				Type.Boolean({
					description:
						"Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
				}),
			),
			context: Type.Optional(
				Type.Number({
					description: `Context lines before+after each match (0-${GREP_CONTEXT_MAX})`,
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
				}),
			),
			cursor: Type.Optional(
				Type.String({ description: "Pagination cursor from previous result" }),
			),
		});

		queueTool(() => toolNames.grep, {
			description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
			promptSnippet: "Grep contents",
			promptGuidelines: (names) => [
				`${names.grep}: prefer bare identifiers as patterns. Literal queries are most efficient.`,
				`${names.grep}: use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').`,
				`${names.grep}: caseSensitive: true when you need exact case (smart-case otherwise).`,
				`${names.grep}: after 1-2 greps, read the top match instead of more greps.`,
			],
			parameters: grepSchema,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (signal?.aborted) throw new Error("Operation aborted");

				const toolCwd = ctx?.cwd || activeCwd;
				const pattern = params.pattern;
				const aux = await resolveFinderForPath(
					params.path,
					pattern,
					params.exclude,
					toolCwd,
					signal,
				);

				const root = aux
					? aux.root
					: await ensureWorkspaceRoot(toolCwd, signal);
				const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
				// pageSize caps TOTAL matches across all files (soft cap: the current file
				// is always finished first). maxMatchesPerFile stays decoupled at the engine
				// default so same-file overflow remains reachable via cursor (#825).
				const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
				const context = clampContext(params.context);
				const query = aux
					? aux.query
					: buildQuery(params.path, pattern, params.exclude, toolCwd);

				// Auto-detect: regex if the pattern has regex metacharacters AND parses
				// as a valid regex, otherwise plain literal. The fuzzy fallback below
				// only kicks in for plain mode — regex queries are intentional.
				const hasRegexSyntax =
					pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

				let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
				if (mode === "regex") {
					try {
						new RegExp(pattern);
					} catch {
						mode = "plain";
					}
				}

				// Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
				// to try to read a whole file. That's not what grep is for — return a terse error
				// steering them to a real pattern, preventing dozens of wasted retries.
				const p = pattern.trim();
				const isWildcardOnly =
					hasRegexSyntax &&
					/^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
						p,
					);

				if (isWildcardOnly) {
					return {
						content: [
							{
								type: "text",
								text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
							},
						],
						details: { totalMatched: 0, totalFiles: 0 },
					};
				}

				// caseSensitive override flips smartCase off; omitting it keeps smart-case
				// (case-insensitive when pattern is all lowercase).
				const smartCase = params.caseSensitive !== true;

				const grepResult = await backend.grep(
					root,
					query,
					{
						mode,
						smartCase,
						maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
						pageSize,
						cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
						beforeContext: context,
						afterContext: context,
						classifyDefinitions: true,
						timeBudgetMs: GREP_TIME_BUDGET_MS,
					},
					signal,
				);

				if (!grepResult.ok) throw new Error(grepResult.error);

				let result = grepResult.value;
				let fuzzyNotice: string | null = null;

				// If we hit the timeout do not run the fuzzy fallback because it will only consume more time
				if (
					result.items.length === 0 &&
					!result.nextCursor &&
					!params.cursor &&
					mode !== "regex"
				) {
					// When the caller pinned a specific file (path has an extension), the
					// fuzzy fallback broadens across the whole picker — the file may just
					// be misnamed. For directory constraints (or no path), we keep the
					// constrained query so the fallback does not leak matches from
					// excluded / out-of-scope directories.
					const lastSeg = params.path?.split(/[\\/]/).pop() ?? "";
					const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSeg);
					const fuzzyQuery = pathTargetsFile ? pattern : query;
					const fuzzy = await backend.grep(
						root,
						fuzzyQuery,
						{
							mode: "fuzzy",
							smartCase,
							maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
							pageSize,
							cursor: null,
							beforeContext: 0,
							afterContext: 0,
							classifyDefinitions: true,
							timeBudgetMs: GREP_TIME_BUDGET_MS,
						},
						signal,
					);

					if (fuzzy.ok && fuzzy.value.items.length > 0) {
						fuzzyNotice = "0 exact matches. Maybe you meant this?";
						result = fuzzy.value;
					}
				}

				let output = formatGrepOutput(result);
				const notices: string[] = [];
				if (result.regexFallbackError) {
					notices.push(
						`Invalid regex: ${result.regexFallbackError}, used literal match`,
					);
				}
				if (result.nextCursor) {
					notices.push(
						`Continue with cursor="${storeCursor(result.nextCursor)}"`,
					);
				}

				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

				return {
					content: [{ type: "text", text: output }],
					details: {
						totalMatched: result.totalMatched,
						totalFiles: result.totalFiles,
					},
				};
			},

			renderCall(args, theme, context) {
				const pattern = args?.pattern ?? "";
				const path = args?.path ?? ".";
				let content =
					theme.fg(
						"toolTitle",
						theme.bold(getRenderToolName(context, toolNames.grep)),
					) +
					" " +
					theme.fg("accent", `/${pattern}/`) +
					theme.fg("toolOutput", ` in ${path}`);
				const callOptions: string[] = [];
				if (args?.limit !== undefined) callOptions.push(`limit ${args.limit}`);
				if (args?.context !== undefined) {
					callOptions.push(`context ${args.context}`);
				}
				if (callOptions.length > 0) {
					content += theme.fg("toolOutput", ` (${callOptions.join(", ")})`);
				}
				if (args?.cursor) content += theme.fg("muted", " (page)");
				return new CollapsedText(content, "", theme.fg("muted", "..."));
			},

			renderResult(result, renderOptions, theme, context) {
				return renderCompactTextResult(result, renderOptions, theme, context);
			},
		});

		// --- find tool ---

		const findSchema = Type.Object({
			pattern: Type.String({
				description:
					"Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
				}),
			),
			exclude: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description:
						"Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
				}),
			),
			cursor: Type.Optional(
				Type.String({ description: "Pagination cursor from previous result" }),
			),
		});

		queueTool(() => toolNames.find, {
			description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
			promptSnippet: "Find files by path or glob",
			promptGuidelines: (names) => [
				`${names.find}: matches the WHOLE path, not just the filename — \`profile\` hits \`chrome/browser/profiles/x.cc\` too.`,
				`${names.find}: keep queries to 1-2 terms; extra words narrow.`,
				`${names.find}: use for paths, not content. Use ${names.grep} for content.`,
				`${names.find}: for exact path matches use a glob in \`path\` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.`,
				`${names.find}: to list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.`,
				`${names.find}: use exclude: 'test/,*.min.js' to cut noise in large repos.`,
			],
			parameters: findSchema,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (signal?.aborted) throw new Error("Operation aborted");

				const toolCwd = ctx?.cwd || activeCwd;
				// If resumed, reuse the exact picker root from the previous page.
				const resumed = params.cursor ? getFindCursor(params.cursor) : undefined;
				let root: string;
				let query: string;
				let pattern: string;
				let effectiveLimit: number;
				let pageIndex: number;
				let auxRoot: string | undefined;

				if (resumed) {
					if (resumed.auxRoot) {
						if (!startupConfigResolved) resolveStartupConfig();
						const ensured = await backend.ensureRoot(
							{
								basePath: resumed.auxRoot,
								kind: "aux",
								exact: true,
								frecencyDbPath: resolvedDbPaths.frecency,
								historyDbPath: resolvedDbPaths.history,
								enableHomeDirScanning,
								enableFsRootScanning,
								followSymlinks,
								waitTimeoutMs: SCAN_TIMEOUT_MS,
							},
							signal,
						);
						if (ensured.dbFallbackError && !childSession) {
							notifyDbFallback(ensured.dbFallbackError);
						}
						root = ensured.root;
					} else {
						root = await ensureWorkspaceRoot(toolCwd, signal);
					}
					effectiveLimit = resumed.pageSize;
					query = resumed.query;
					pattern = resumed.pattern;
					pageIndex = resumed.nextPageIndex;
					auxRoot = resumed.auxRoot;
				} else {
					const aux = await resolveFinderForPath(
						params.path,
						params.pattern,
						params.exclude,
						toolCwd,
						signal,
					);
					root = aux ? aux.root : await ensureWorkspaceRoot(toolCwd, signal);
					effectiveLimit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
					query = aux
						? aux.query
						: buildQuery(
								params.path,
								params.pattern,
								params.exclude,
								toolCwd,
							);
					pattern = params.pattern;
					pageIndex = 0;
					auxRoot = aux?.root;
				}

				const searchResult = await backend.fileSearch(
					root,
					query,
					{
						pageIndex,
						pageSize: effectiveLimit,
					},
					signal,
				);
				if (!searchResult.ok) throw new Error(searchResult.error);

				const result = searchResult.value;
				const formatted = formatFindOutput(result, effectiveLimit, pattern);
				let output = formatted.output;

				// Infer hasMore: native fileSearch fills pageSize when more results
				// exist, so if we got a full page AND totalMatched exceeds what we've
				// shown so far there's another page to fetch.
				const shownSoFar = pageIndex * effectiveLimit + result.items.length;
				const hasMore =
					result.items.length >= effectiveLimit &&
					result.totalMatched > shownSoFar;

				const notices: string[] = [];
				if (formatted.weak && formatted.shownCount > 0) {
					notices.push(
						`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
					);
				}

				if (!formatted.weak && hasMore) {
					const remaining = result.totalMatched - shownSoFar;
					const cursorId = storeFindCursor({
						query,
						pattern,
						pageSize: effectiveLimit,
						nextPageIndex: pageIndex + 1,
						auxRoot,
					});
					notices.push(
						`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
					);
				}

				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				return {
					content: [{ type: "text", text: output }],
					details: {
						totalMatched: result.totalMatched,
						totalFiles: result.totalFiles,
						pageIndex,
						hasMore,
					},
				};
			},

			renderCall(args, theme, context) {
				const pattern = args?.pattern ?? "";
				const path = args?.path ?? ".";
				let content =
					theme.fg(
						"toolTitle",
						theme.bold(getRenderToolName(context, toolNames.find)),
					) +
					" " +
					theme.fg("accent", pattern) +
					theme.fg("toolOutput", ` in ${path}`);
				if (args?.limit !== undefined) {
					content += theme.fg("toolOutput", ` (limit ${args.limit})`);
				}
				if (args?.cursor) content += theme.fg("muted", " (page)");
				return new CollapsedText(content, "", theme.fg("muted", "..."));
			},

			renderResult(result, renderOptions, theme, context) {
				return renderCompactTextResult(result, renderOptions, theme, context);
			},
		});

		// --- multi_grep tool ---
		const enableMultiGrep = process.env.PI_FFF_MULTIGREP === "1";

		if (enableMultiGrep) {
			const multiGrepSchema = Type.Object({
				patterns: Type.Array(Type.String(), {
					description:
						"Literal patterns (OR). Include snake_case/camelCase/PascalCase variants.",
				}),
				constraints: Type.Optional(
					Type.String({
						description: "File filter, e.g. '*.{ts,tsx} !test/'",
					}),
				),
				context: Type.Optional(
					Type.Number({
						description: `Context lines before+after (0-${GREP_CONTEXT_MAX})`,
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
					}),
				),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			});

			queueTool(() => toolNames.multiGrep, {
				description:
					"Search file contents for ANY of multiple literal patterns (OR, SIMD Aho-Corasick). Faster than regex alternation.",
				promptSnippet: "Multi-pattern OR content search",
				promptGuidelines: (names) => [
					`${names.multiGrep}: use when searching for several identifiers at once.`,
					`${names.multiGrep}: include all naming-convention variants (snake/camel/Pascal).`,
					`${names.multiGrep}: patterns are literal. Use constraints for file filters.`,
				],
				parameters: multiGrepSchema,

				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					if (signal?.aborted) throw new Error("Operation aborted");
					if (!params.patterns?.length) {
						throw new Error("patterns array must have at least 1 element");
					}

					const toolCwd = ctx?.cwd || activeCwd;
					const root = await ensureWorkspaceRoot(toolCwd, signal);
					const effectiveLimit = Math.max(
						1,
						params.limit ?? DEFAULT_GREP_LIMIT,
					);
					const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
					const context = clampContext(params.context);

					const grepResult = await backend.multiGrep(
						root,
						{
							patterns: params.patterns,
							constraints: params.constraints,
							maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
							pageSize,
							smartCase: true,
							cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
							beforeContext: context,
							afterContext: context,
						},
						signal,
					);

					if (!grepResult.ok) throw new Error(grepResult.error);

					const result = grepResult.value;
					let output = formatGrepOutput(result);

					const notices: string[] = [];
					if (result.items.length >= effectiveLimit) {
						notices.push(`${effectiveLimit}+ matches (refine patterns)`);
					}
					if (result.nextCursor) {
						notices.push(
							`More available. cursor="${storeCursor(result.nextCursor)}" to continue`,
						);
					}

					if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

					return {
						content: [{ type: "text", text: output }],
						details: {
							totalMatched: result.totalMatched,
							totalFiles: result.totalFiles,
							patterns: params.patterns,
						},
					};
				},

				renderCall(args, theme, context) {
					const text =
						(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
					const patterns = args?.patterns ?? [];
					const constraints = args?.constraints;
					let content =
						theme.fg(
							"toolTitle",
							theme.bold(getRenderToolName(context, toolNames.multiGrep)),
						) +
						" " +
						theme.fg("accent", patterns.map((p: string) => `"${p}"`).join(", "));
					if (constraints) {
						content += theme.fg("toolOutput", ` (${constraints})`);
					}
					if (args?.cursor) content += theme.fg("muted", " (page)");
					text.setText(content);
					return text;
				},

				renderResult(result, renderOptions, theme, context) {
					return renderPreviewResult(
						result,
						renderOptions,
						theme,
						context,
						15,
					);
				},
			});
		}

		// --- commands ---

		pi.registerCommand("fff-mode", {
			description:
				"Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]",
			handler: async (args, ctx) => {
				pi.appendEntry("pi-extensions.command", { command: "fff-mode", kind: "extension", extension: "fff" });
				if (!toolsRegistered) {
					try {
						prepareSession(ctx);
					} catch (error: unknown) {
						ctx.ui.notify(
							`FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
				}

				const arg = (args || "").trim();

				// No args - show current mode
				if (!arg) {
					const mode = getMode();
					const flag = pi.getFlag("fff-mode") ?? "unset";
					ctx.ui.notify(`Current mode: '${mode}' (flag: ${flag})`, "info");
					return;
				}

				// Validate and set mode
				if (!VALID_MODES.includes(arg as FffMode)) {
					ctx.ui.notify(
						`Usage: /fff-mode [${VALID_MODES.join(" | ")}]`,
						"warning",
					);
					return;
				}

				const newMode = arg as FffMode;
				const oldMode = getMode();
				pi.appendEntry("fff-mode", { mode: newMode });

				if ((oldMode === "override") !== (newMode === "override")) {
					ctx.ui.notify(
						`Mode '${newMode}' saved. Run /reload to apply the tool name change.`,
						"info",
					);
					return;
				}

				setMode(newMode);
				ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'`, "info");
			},
		});

		pi.registerCommand("fff-health", {
			description: "Show FFF file finder health and status",
			handler: async (_args, ctx) => {
				pi.appendEntry("pi-extensions.command", { command: "fff-health", kind: "extension", extension: "fff" });
				if (!toolsRegistered) {
					try {
						prepareSession(ctx);
					} catch (error: unknown) {
						ctx.ui.notify(
							`FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
				}

				let root: string;
				try {
					root = currentWorkspaceRoot ?? (await ensureWorkspaceRoot(ctx.cwd));
				} catch (error: unknown) {
					ctx.ui.notify(
						`FFF not initialized: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}

				let health: Awaited<ReturnType<FffBackend["healthCheck"]>>;
				try {
					health = await backend.healthCheck(root);
				} catch (error: unknown) {
					ctx.ui.notify(
						`Health check failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				if (!health.ok) {
					ctx.ui.notify(`Health check failed: ${health.error}`, "error");
					return;
				}

				const lines = [
					`FFF v${health.value.version}`,
					`Mode: ${getMode()}`,
					`Sidecar PID: ${health.value.pid ?? "in-process"} (${health.value.sharedRoots ?? 1} shared root(s))`,
					`Git: ${health.value.git.repositoryFound ? `yes (${health.value.git.workdir ?? "unknown"})` : "no"}`,
					`Picker: ${health.value.filePicker.initialized ? `${health.value.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
					`Frecency: ${health.value.frecency.initialized ? "active" : "disabled"}`,
					`Query tracker: ${health.value.queryTracker.initialized ? "active" : "disabled"}`,
				];

				try {
					const progress = await backend.getScanProgress(root);
					if (progress.ok) {
						lines.push(
							`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
						);
					}
				} catch {
					// Best-effort scan progress snapshot.
				}

				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("fff-rescan", {
			description: "Trigger FFF to rescan files",
			handler: async (_args, ctx) => {
				pi.appendEntry("pi-extensions.command", { command: "fff-rescan", kind: "extension", extension: "fff" });
				if (!toolsRegistered) {
					try {
						prepareSession(ctx);
					} catch (error: unknown) {
						ctx.ui.notify(
							`FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
				}

				let root: string;
				try {
					root = currentWorkspaceRoot ?? (await ensureWorkspaceRoot(ctx.cwd));
				} catch (error: unknown) {
					ctx.ui.notify(
						`FFF not initialized: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}

				try {
					const result = await backend.scanFiles(root);
					if (!result.ok) {
						ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
						return;
					}

					ctx.ui.notify("FFF rescan triggered", "info");
				} catch (error: unknown) {
					ctx.ui.notify(
						`Rescan failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});
	}

	return function setupFffExtension(pi: ExtensionAPI): void {
		activateFffExtension(pi, false);
	};
}

export default function fffExtension(pi: ExtensionAPI): void {
	createFffExtension()(pi);
}

// Every mode this session selected via /fff-mode, oldest first.
function sessionModes(entries: unknown): FffMode[] {
	if (!Array.isArray(entries)) return [];

	const modes: FffMode[] = [];
	for (const entry of entries as {
		type?: string;
		customType?: string;
		data?: unknown;
	}[]) {
		if (entry?.type !== "custom" || entry.customType !== "fff-mode") continue;
		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (typeof mode === "string" && VALID_MODES.includes(mode as FffMode)) {
			modes.push(mode as FffMode);
		}
	}
	return modes;
}
