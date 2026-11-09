import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, type ExtensionFactory, type InlineExtension, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ensureIgnoredDir } from "../../project.ts";
import { DREAM_PROMPT } from "./prompt.ts";
import { type DreamChild, dreamLimits, type SpawnOptions } from "./run.ts";

export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const SESSION_LINK_TYPE = "pi-extensions.session-link";
export const DREAM_AGENT_TYPE = "memory-dream";
/** The built-in tools a dream gets: reading the code, never changing it. */
export const READ_TOOLS = ["read", "grep", "find", "ls"];

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
// No packages, extensions, or resource paths, which the loader would resolve and install.
const KEPT_SETTINGS: (keyof Settings)[] = ["transport", "retry", "compaction", "shellPath", "shellCommandPrefix", "images", "thinkingBudgets"];

/** pika's folder in the project: `<cwd>/.pi/pika/`, kept out of git by its own `.gitignore`. */
export const projectPikaDir = (cwd: string) => join(cwd, ".pi", "pika");
/** Where dream sessions are kept: in the project, away from the user's sessions, so `/resume` does not list them. */
export const dreamSessionDir = (cwd: string) => join(projectPikaDir(cwd), "dreams");

const within = (dir: string, path: string) => {
	const rest = relative(dir, path);
	return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};
const real = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };

/** Whether `path`, as `read`, `ls`, `grep`, and `find` take it in `cwd`, names `<cwd>/.pi/pika/` or something in it. */
export function inProjectPikaDir(cwd: string, path: string): boolean {
	const bare = path.trim().replace(/^@/, "");
	const expanded = bare === "~" ? homedir() : bare.startsWith("~/") ? join(homedir(), bare.slice(2)) : bare;
	const target = resolve(cwd, expanded || ".");
	const dir = projectPikaDir(cwd);
	return within(dir, target) || within(real(dir), real(target));
}

/** Keeps the dream's read tools out of `<cwd>/.pi/pika/`, which holds earlier dreams' own sessions; `grep` and `find` skip it by its `.gitignore`. */
const pikaDirGuard = (cwd: string): InlineExtension => ({
	name: "pika-dream-guard",
	factory: (pi) => {
		pi.on("tool_call", (event) => {
			if (!READ_TOOLS.includes(event.toolName)) return undefined;
			const path = (event.input as { path?: unknown }).path;
			if (typeof path !== "string" || !inProjectPikaDir(cwd, path)) return undefined;
			return { block: true, reason: ".pi/pika/ holds earlier dreams' own sessions, not the user's: a dream does not read it." };
		});
	},
});

/** The hooks registered in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]`; the Set may not exist. */
export function childSessionHooks(): InlineExtension[] {
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
 * tools, kept out of `<cwd>/.pi/pika/`, and `customTools`.
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
