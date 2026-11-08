import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, type ExtensionFactory, type InlineExtension, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
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

/** Where dream sessions are kept: away from the user's sessions, so `/resume` does not list them. */
export const dreamSessionDir = (agentDir: string) => join(agentDir, "pika", "dreams");

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
 * A persisted child session for a dream: the child-session hooks and nothing else of the user's extensions, skills,
 * prompts, or context files; the dream's system prompt; and exactly the read-only built-in tools and `customTools`.
 */
export async function spawnDreamChild(options: SpawnOptions): Promise<DreamChild> {
	const { cwd, agentDir } = options;
	const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings();
	const settingsManager = SettingsManager.inMemory(Object.fromEntries(KEPT_SETTINGS.filter((key) => global[key] !== undefined).map((key) => [key, global[key]])), { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: childSessionHooks(),
		systemPromptOverride: () => DREAM_PROMPT,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.create(cwd, dreamSessionDir(agentDir), options.parentSessionFile ? { parentSession: options.parentSessionFile } : undefined);
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
			if (event.type === "turn_end") listener({ type: "turn_end" });
			else if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = event.message.usage;
				const tokens = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
				listener({ type: "usage", tokens });
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
