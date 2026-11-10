import * as fs from "node:fs";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkspaceGc } from "./gc.ts";
import {
	allowProjectPath,
	denyProjectPath,
	ensureWorkspacesClosure,
	evaluatePathAccess,
	extractBashExternalWriteTargets,
	extractBashWriteTargets,
	extractWorkspaceNameFromPath,
	findBashNamedStateFile,
	isSubpath,
	normalizeFileToolPath,
	policyFilePath,
	readProjectPolicy,
	resolveCanonicalPath,
	resolveLiteralPath,
	workspacesDir,
} from "./policy.ts";
import {
	createOrTouchWorkspace,
	inspectWorkspaceSafety,
	markSessionWorkspacesClosed,
	registryFilePath,
	releaseWorkspace,
	setWorkspacePin,
	syncWorkspaces,
} from "./registry.ts";

export const WORKSPACE_SHARED_KEY = Symbol.for("pi-extensions.workspace");
export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const SESSION_LINK_TYPE = "pi-extensions.session-link";

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

export interface WorkspaceSharedState {
	activeSessionIds: Set<string>;
	sessionAllowedPaths: Map<string, Set<string>>;
	openInstances: Set<object>;
	sessionByFile: Map<string, string>;
	hook?: ChildSessionHook;
}

const boundApis = new WeakSet<ExtensionAPI>();

function getSharedState(): WorkspaceSharedState {
	const g = globalThis as Record<symbol, unknown>;
	let state = g[WORKSPACE_SHARED_KEY] as WorkspaceSharedState | undefined;
	if (!state) {
		state = {
			activeSessionIds: new Set<string>(),
			sessionAllowedPaths: new Map<string, Set<string>>(),
			openInstances: new Set<object>(),
			sessionByFile: new Map<string, string>(),
		};
		g[WORKSPACE_SHARED_KEY] = state;
	}
	return state;
}

function getChildHooksSet(): Set<ChildSessionHook> {
	const g = globalThis as Record<symbol, unknown>;
	let hooks = g[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
	if (!(hooks instanceof Set)) {
		hooks = new Set<ChildSessionHook>();
		g[CHILD_SESSION_HOOKS] = hooks;
	}
	return hooks;
}

function syncChildSessionHook(): void {
	const state = getSharedState();
	state.hook ??= { name: "workspace", extensionFactory: workspaceExtension };
	const hooks = getChildHooksSet();
	if (state.openInstances.size > 0) {
		for (const item of [...hooks]) {
			if (item.name === "workspace" && item !== state.hook) {
				hooks.delete(item);
			}
		}
		hooks.add(state.hook);
	} else {
		for (const item of [...hooks]) {
			if (item.name === "workspace") {
				hooks.delete(item);
			}
		}
	}
}

export function isChildSession(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return true;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	return entries.some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

function resolveParentSessionIds(ctx: ExtensionContext): string[] {
	const state = getSharedState();
	const parents = new Set<string>();
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_LINK_TYPE) continue;
		const data = entry.data as { parentSessionId?: unknown; parentSessionFile?: unknown } | undefined;
		if (typeof data?.parentSessionId === "string" && data.parentSessionId) {
			parents.add(data.parentSessionId);
		}
		if (typeof data?.parentSessionFile === "string" && data.parentSessionFile) {
			const mapped = state.sessionByFile.get(data.parentSessionFile);
			if (mapped) parents.add(mapped);
		}
	}
	const headerParent = ctx.sessionManager?.getHeader?.()?.parentSession;
	if (typeof headerParent === "string" && headerParent) {
		parents.add(headerParent);
		const mapped = state.sessionByFile.get(headerParent);
		if (mapped) parents.add(mapped);
	}
	return [...parents];
}

function getEffectiveSessionAllowedPaths(ctx: ExtensionContext): Set<string> {
	const state = getSharedState();
	const allowed = new Set<string>();
	const sessionId = ctx.sessionManager?.getSessionId?.();

	const visited = new Set<string>();
	const collectForSession = (id: string) => {
		if (visited.has(id)) return;
		visited.add(id);
		const set = state.sessionAllowedPaths.get(id);
		if (set) {
			for (const p of set) allowed.add(p);
		}
	};

	if (sessionId) {
		collectForSession(sessionId);
	}
	for (const parentId of resolveParentSessionIds(ctx)) {
		collectForSession(parentId);
	}
	if (isChildSession(ctx)) {
		for (const activeId of state.activeSessionIds) {
			collectForSession(activeId);
		}
	}

	return allowed;
}

function addSessionAllowedPath(ctx: ExtensionContext, targetPath: string): void {
	const state = getSharedState();
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "__default__";
	let set = state.sessionAllowedPaths.get(sessionId);
	if (!set) {
		set = new Set<string>();
		state.sessionAllowedPaths.set(sessionId, set);
	}
	set.add(resolveCanonicalPath(targetPath, ctx.cwd));
}

/** The guard's own state files: the project allowlist and the workspace registry. */
function managedStateFiles(cwd: string): string[] {
	return [policyFilePath(cwd), registryFilePath(cwd)];
}

/**
 * Returns `policy.json` or `.registry.json` when one of `targetPaths` resolves to it. Letter case is
 * ignored: macOS resolves `POLICY.JSON` to the same file. Each path is taken as written.
 */
function findManagedStateFile(targetPaths: string[], cwd: string): string | undefined {
	const resolvedTargets = targetPaths.map((targetPath) => resolveLiteralPath(targetPath, cwd).toLowerCase());
	return managedStateFiles(cwd).find((file) => resolvedTargets.includes(resolveCanonicalPath(file).toLowerCase()));
}

export function buildWorkspaceSystemPromptSection(cwd: string): string {
	return `Workspace rules: Keep file writes inside the current project (${cwd}). When you need a side checkout, clone, worktree, or isolated experiment, create it under ${cwd}/.pi/workspaces/<name> (which is git-ignored) or use the workspace tool. Ephemeral temporary files may use /tmp. Do not create or modify directories in ~/projects or other paths outside ${cwd} unless explicitly approved by the user.`;
}

export const WorkspaceToolParameters = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("release"),
		Type.Literal("pin"),
		Type.Literal("unpin"),
		Type.Literal("list"),
	]),
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	purpose: Type.Optional(Type.String({ maxLength: 500 })),
	ttlHours: Type.Optional(Type.Number({ minimum: 0 })),
});

export type WorkspaceToolInput = Static<typeof WorkspaceToolParameters>;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function workspaceExtension(pi: ExtensionAPI): void {
	if (boundApis.has(pi)) return;
	boundApis.add(pi);

	// Deduplicate if loaded both by path and via CHILD_SESSION_HOOKS in the same ResourceLoader pass.
	let inLoadPass = true;
	if (pi.events && typeof pi.events.emit === "function" && typeof pi.events.on === "function") {
		const probe = { alreadyLoaded: false };
		pi.events.emit("pi-extensions.workspace.load-probe", probe);
		if (probe.alreadyLoaded) return;
		pi.events.on("pi-extensions.workspace.load-probe", (data) => {
			if (inLoadPass && data && typeof data === "object") {
				(data as { alreadyLoaded: boolean }).alreadyLoaded = true;
			}
		});
	}

	const instanceToken = {};

	pi.on("session_start", async (_event, ctx) => {
		inLoadPass = false;
		const state = getSharedState();
		state.openInstances.add(instanceToken);
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) {
			state.activeSessionIds.add(sessionId);
			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			if (sessionFile) {
				state.sessionByFile.set(sessionFile, sessionId);
			}
		}
		syncChildSessionHook();
		try {
			if (ctx.cwd && fs.existsSync(ctx.cwd)) {
				await ensureWorkspacesClosure(ctx.cwd);
			}
		} catch {
			// Ignore read-only or missing cwd on startup.
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = getSharedState();
		state.openInstances.delete(instanceToken);
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) {
			state.activeSessionIds.delete(sessionId);
			try {
				await markSessionWorkspacesClosed(ctx.cwd, sessionId);
			} catch {
				// Ignore errors during shutdown.
			}
		}
		syncChildSessionHook();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = getSharedState();
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) {
			state.activeSessionIds.add(sessionId);
		}
		try {
			if (ctx.cwd && fs.existsSync(ctx.cwd)) {
				await ensureWorkspacesClosure(ctx.cwd);
			}
		} catch {
			// Ignore closure creation failure on read-only fs.
		}
		if (event?.systemPromptOptions) {
			event.systemPromptOptions.sections ??= {};
			event.systemPromptOptions.sections.workspace = buildWorkspaceSystemPromptSection(ctx.cwd);
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = getSharedState();
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId && state.openInstances.has(instanceToken)) {
			state.activeSessionIds.add(sessionId);
		}

		let targetPaths: string[] = [];
		let workspaceTouchPaths: string[] = [];
		let namedStateFile: string | undefined;
		const isFileTool = event.toolName === "write" || event.toolName === "edit";

		if (isFileTool) {
			const input = event.input as { path?: unknown; file_path?: unknown } | undefined;
			const rawPath = typeof input?.path === "string" ? input.path : typeof input?.file_path === "string" ? input.file_path : undefined;
			if (!rawPath) return undefined;
			// Judge the file Pi's tool will touch, not the raw argument (`@/x` and `file:///x` both mean `/x`).
			// Past this normalization Pi takes the path as written, so every check below reads it literally.
			let filePath: string;
			try {
				filePath = normalizeFileToolPath(rawPath);
			} catch (error) {
				return {
					block: true,
					reason: `Blocked write to "${rawPath}": ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			targetPaths = [filePath];
			workspaceTouchPaths = [filePath];
		} else if (event.toolName === "bash") {
			const input = event.input as { command?: unknown } | undefined;
			const command = typeof input?.command === "string" ? input.command : undefined;
			if (!command || !command.trim()) return undefined;
			// The extractors read each word the way bash does and resolve it, so every check below reads these paths literally too.
			targetPaths = extractBashExternalWriteTargets(command, ctx.cwd);
			workspaceTouchPaths = extractBashWriteTargets(command, ctx.cwd);
			// A command that names a state file counts whatever it is, not only the writes the extractor knows.
			namedStateFile = findBashNamedStateFile(command, ctx.cwd, managedStateFiles(ctx.cwd));
		} else {
			return undefined;
		}

		// The guard's own state is never a tool's to write: no prompt, and no allow list unblocks it.
		const managedFile = findManagedStateFile(workspaceTouchPaths, ctx.cwd) ?? namedStateFile;
		if (managedFile) {
			return {
				block: true,
				reason: `Blocked write to "${managedFile}": this file is managed by the workspace extension and tool calls cannot change it. The user changes it with "/workspace allow <path>" or "/workspace deny <path>".`,
			};
		}

		const policy = await readProjectPolicy(ctx.cwd);
		const sessionAllowed = getEffectiveSessionAllowedPaths(ctx);

		for (const rawTarget of targetPaths) {
			const check = evaluatePathAccess({
				targetPath: rawTarget,
				cwd: ctx.cwd,
				literal: true,
				sessionAllowed,
				projectAllowed: policy.allowedPaths,
			});

			if (check.allowed) continue;

			const resolvedPath = check.resolvedPath;
			const blockedReason = `Blocked write outside project working directory: "${resolvedPath}". Use "${workspacesDir(ctx.cwd)}/<name>" for side workspaces or "/tmp" for temporary files, or ask the user to run "/workspace allow ${resolvedPath}".`;

			if (!ctx.hasUI || isChildSession(ctx) || typeof ctx.ui?.select !== "function") {
				return {
					block: true,
					reason: blockedReason,
				};
			}

			const choice = await ctx.ui.select(
				`Allow write outside workspace (${resolvedPath})?`,
				["Allow once", "Allow for this session", "Allow for this project", "Deny"],
			);

			if (choice === "Allow once") {
				continue;
			}

			// Both lasting choices cover exactly the path the prompt shows, never its parent directory.
			if (choice === "Allow for this session" || choice === "Allow for session") {
				addSessionAllowedPath(ctx, resolvedPath);
				sessionAllowed.add(resolvedPath);
				continue;
			}

			if (choice === "Allow for this project" || choice === "Allow for project") {
				const saved = await allowProjectPath(ctx.cwd, resolvedPath);
				policy.allowedPaths.push(saved);
				addSessionAllowedPath(ctx, saved);
				sessionAllowed.add(saved);
				continue;
			}

			return {
				block: true,
				reason: blockedReason,
			};
		}

		// Auto-register any workspace touched under <cwd>/.pi/workspaces/<name>.
		for (const touchPath of workspaceTouchPaths) {
			const wsName = extractWorkspaceNameFromPath(touchPath, ctx.cwd, true);
			if (wsName) {
				try {
					await createOrTouchWorkspace(ctx.cwd, {
						name: wsName,
						sessionId,
						sessionTitle: typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined,
					});
				} catch {
					// Ignore invalid workspace names in arbitrary paths.
				}
			}
		}

		return undefined;
	});

	pi.registerTool({
		name: "workspace",
		label: "Workspace",
		description:
			"Create, list, pin, unpin, or release isolated project workspaces under <cwd>/.pi/workspaces/<name>. Use this for side git clones, worktrees, or scratch directories that belong to this project.",
		promptSnippet: "Manage isolated side workspaces under .pi/workspaces/<name> (create, list, pin, unpin, release).",
		parameters: WorkspaceToolParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const sessionTitle = typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;

			if (params.action === "create") {
				if (!params.name) {
					throw new Error('Workspace "name" is required for action "create".');
				}
				const ttlMs = typeof params.ttlHours === "number" ? Math.round(params.ttlHours * 3600_000) : undefined;
				const entry = await createOrTouchWorkspace(ctx.cwd, {
					name: params.name,
					purpose: params.purpose,
					sessionId,
					sessionTitle,
					ttlMs,
				});
				return {
					content: [
						{
							type: "text",
							text: `Workspace "${entry.name}" ready at ${entry.path}${entry.purpose ? ` (${entry.purpose})` : ""}.`,
						},
					],
					details: { action: "create", workspace: entry },
				};
			}

			if (params.action === "release") {
				if (!params.name) {
					throw new Error('Workspace "name" is required for action "release".');
				}
				const entry = await releaseWorkspace(ctx.cwd, params.name);
				if (!entry) {
					throw new Error(`Workspace "${params.name}" does not exist.`);
				}
				return {
					content: [
						{
							type: "text",
							text: `Released workspace "${entry.name}" (${entry.path}).`,
						},
					],
					details: { action: "release", workspace: entry },
				};
			}

			if (params.action === "pin" || params.action === "unpin") {
				if (!params.name) {
					throw new Error(`Workspace "name" is required for action "${params.action}".`);
				}
				const pinned = params.action === "pin";
				const entry = await setWorkspacePin(ctx.cwd, params.name, pinned);
				if (!entry) {
					throw new Error(`Workspace "${params.name}" does not exist.`);
				}
				return {
					content: [
						{
							type: "text",
							text: `${pinned ? "Pinned" : "Unpinned"} workspace "${entry.name}" (${entry.path}).`,
						},
					],
					details: { action: params.action, workspace: entry },
				};
			}

			// action === "list"
			const entries = await syncWorkspaces(ctx.cwd);
			const activeIds = getSharedState().activeSessionIds;
			const reports = await Promise.all(
				entries.map((entry) => inspectWorkspaceSafety(entry, { activeSessionIds: activeIds })),
			);
			if (reports.length === 0) {
				return {
					content: [{ type: "text", text: `No workspaces in ${workspacesDir(ctx.cwd)}.` }],
					details: { action: "list", workspaces: [] },
				};
			}
			const lines = reports.map(
				(r) =>
					`- ${r.entry.name} [${r.status}] (${r.reasons.join(", ")}) — ${r.entry.path}${r.entry.purpose ? ` (${r.entry.purpose})` : ""}`,
			);
			return {
				content: [{ type: "text", text: `Workspaces in ${workspacesDir(ctx.cwd)}:\n${lines.join("\n")}` }],
				details: { action: "list", workspaces: reports },
			};
		},
	});

	pi.registerCommand("workspace", {
		description:
			"Manage project workspaces and external path permissions: /workspace [list | gc [--dry-run] [--yes] [--all] | allow <path> | deny <path> | pin <name> | unpin <name>]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const tokens = trimmed ? trimmed.split(/\s+/) : [];
			const subcommand = (tokens[0] ?? "list").toLowerCase();
			const rest = tokens.slice(1);

			if (!trimmed || subcommand === "list") {
				const entries = await syncWorkspaces(ctx.cwd);
				const activeIds = getSharedState().activeSessionIds;
				const reports = await Promise.all(
					entries.map((entry) => inspectWorkspaceSafety(entry, { activeSessionIds: activeIds })),
				);
				const policy = await readProjectPolicy(ctx.cwd);
				const sessionAllowed = [...getEffectiveSessionAllowedPaths(ctx)];

				const lines: string[] = [];
				if (reports.length === 0) {
					lines.push(`No workspaces in ${workspacesDir(ctx.cwd)}.`);
				} else {
					lines.push(`Workspaces in ${workspacesDir(ctx.cwd)}:`);
					for (const report of reports) {
						const purposePart = report.entry.purpose ? ` — ${report.entry.purpose}` : "";
						lines.push(
							`  ${report.entry.name}: ${report.status} (${report.reasons.join(", ")}, ${formatBytes(report.sizeBytes)})${purposePart} [${report.entry.path}]`,
						);
					}
				}

				const allowedCombined = [...new Set([...policy.allowedPaths, ...sessionAllowed])];
				if (allowedCombined.length > 0) {
					lines.push(`Allowed external paths: ${allowedCombined.join(", ")}`);
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (subcommand === "allow") {
				const rawPath = trimmed.slice(tokens[0]!.length).trim();
				if (!rawPath) {
					ctx.ui.notify("Usage: /workspace allow <path>", "warning");
					return;
				}
				const canonical = await allowProjectPath(ctx.cwd, rawPath);
				addSessionAllowedPath(ctx, canonical);
				ctx.ui.notify(`Allowed external path: ${canonical}`, "info");
				return;
			}

			if (subcommand === "deny") {
				const rawPath = trimmed.slice(tokens[0]!.length).trim();
				if (!rawPath) {
					ctx.ui.notify("Usage: /workspace deny <path>", "warning");
					return;
				}
				const canonical = await denyProjectPath(ctx.cwd, rawPath);
				const state = getSharedState();
				for (const set of state.sessionAllowedPaths.values()) {
					for (const entry of [...set]) {
						if (entry === canonical || isSubpath(canonical, entry)) {
							set.delete(entry);
						}
					}
				}
				ctx.ui.notify(`Denied external path: ${canonical}`, "info");
				return;
			}

			if (subcommand === "pin" || subcommand === "unpin") {
				const name = rest[0];
				if (!name) {
					ctx.ui.notify(`Usage: /workspace ${subcommand} <name>`, "warning");
					return;
				}
				const pinned = subcommand === "pin";
				const updated = await setWorkspacePin(ctx.cwd, name, pinned);
				if (!updated) {
					ctx.ui.notify(`Workspace "${name}" not found.`, "warning");
					return;
				}
				ctx.ui.notify(`${pinned ? "Pinned" : "Unpinned"} workspace "${name}".`, "info");
				return;
			}

			if (subcommand === "gc") {
				const dryRun = rest.includes("--dry-run");
				const yes = rest.includes("--yes");
				const allProjects = rest.includes("--all");
				const activeIds = getSharedState().activeSessionIds;

				const result = await runWorkspaceGc({
					cwd: ctx.cwd,
					allProjects,
					dryRun,
					yes,
					activeSessionIds: activeIds,
					confirmReview:
						ctx.hasUI && !yes && !dryRun && typeof ctx.ui?.select === "function"
							? async (report) => {
									const choice = await ctx.ui.select(
										`Workspace "${report.entry.name}" needs review (${report.reasons.join(", ")}). Action?`,
										["Keep for now", "Pin permanently", "Remove anyway"],
									);
									if (choice === "Remove anyway") return "remove";
									if (choice === "Pin permanently") return "pin";
									return "skip";
								}
							: undefined,
				});

				const removedNames = result.removed.map((r) => r.entry.name).join(", ") || "none";
				const keptNames = result.kept.map((r) => `${r.entry.name} (${r.status})`).join(", ") || "none";
				const pinnedNames = result.pinned.map((r) => r.entry.name).join(", ");
				const parts = [
					`${dryRun ? "[Dry run] " : ""}Workspace GC complete:`,
					`Removed (${result.removed.length}): ${removedNames}`,
					`Kept (${result.kept.length}): ${keptNames}`,
				];
				if (result.pinned.length > 0) {
					parts.push(`Newly pinned (${result.pinned.length}): ${pinnedNames}`);
				}
				if (result.prunedProjects.length > 0) {
					parts.push(`Pruned missing projects (${result.prunedProjects.length}): ${result.prunedProjects.join(", ")}`);
				}
				ctx.ui.notify(parts.join("\n"), "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /workspace [list | gc [--dry-run] [--yes] [--all] | allow <path> | deny <path> | pin <name> | unpin <name>]",
				"warning",
			);
		},
	});
}
