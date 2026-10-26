import { join } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAssistant, SessionCapture } from "./capture.ts";
import { isExcluded, loadConfig, type ConfigResult } from "./config.ts";
import { acquireUploader, currentUploader, releaseUploader, type Uploader } from "./uploader.ts";

export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const SHUTDOWN_FLUSH_MS = 2_000;
export const SESSION_LINK_TYPE = "pi-extensions.session-link";

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

// Module copies loaded for other cwds share this state, so it lives on globalThis.
const SHARED = Symbol.for("pi-extensions.pika");
interface Shared {
	/** Enabled pika instances whose session has started and not shut down. */
	active: number;
	hook?: ChildSessionHook;
	/** One capture per session id, owned by the last pika instance that started in it. */
	captures: Map<string, SessionCapture>;
	/** Session ids and files of open excluded sessions; their children are excluded too. */
	excluded: Set<string>;
}
const global = globalThis as { [SHARED]?: Shared; [CHILD_SESSION_HOOKS]?: Set<ChildSessionHook> };
const shared = (): Shared => global[SHARED] ??= { active: 0, captures: new Map(), excluded: new Set() };
const hooks = (): Set<ChildSessionHook> => global[CHILD_SESSION_HOOKS] ??= new Set();

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function modelInfo(ctx: ExtensionContext) {
	const model = ctx.model;
	return model ? { provider: model.provider, api: model.api, model: model.id } : {};
}

/** pika: upload every session entry and model request to a self-hosted pika server. */
export default function pikaExtension(pi: ExtensionAPI): void {
	const self = {};
	let config: ConfigResult | undefined;
	let joined = false;
	let sessionId: string | undefined;
	let skipped: string | undefined;
	let excludedKeys: string[] = [];

	// Capture errors are recorded for /pika and never reach the turn.
	const guard = (fn: () => void) => {
		try { fn(); } catch (error) { currentUploader()?.noteError(`capture: ${errorText(error)}`); }
	};
	const owned = (ctx: ExtensionContext): SessionCapture | undefined => {
		if (!joined) return undefined;
		const capture = shared().captures.get(ctx.sessionManager.getSessionId());
		return capture?.owner === self ? capture : undefined;
	};

	const enabledConfig = () => config?.enabled ? config.config : undefined;

	function enroll(): Uploader {
		const state = shared();
		const { url, token } = enabledConfig()!;
		const uploader = acquireUploader({ url, token, dir: join(getAgentDir(), "pika"), piVersion: VERSION });
		if (!joined) {
			joined = true;
			state.active++;
			state.hook ??= { name: "pika", extensionFactory: (child) => pikaExtension(child) };
			hooks().add(state.hook);
		}
		return uploader;
	}

	async function leave(): Promise<void> {
		if (!joined) return;
		joined = false;
		const state = shared();
		state.active = Math.max(0, state.active - 1);
		if (state.active > 0) return;
		if (state.hook) hooks().delete(state.hook);
		const uploader = currentUploader();
		if (!uploader) return;
		await uploader.drain(SHUTDOWN_FLUSH_MS);
		if (shared().active === 0) await releaseUploader(uploader);
	}

	/** Why a session must not be captured, nor its children and Herder runs; checked before enrolling. */
	function exclusion(ctx: ExtensionContext): string | undefined {
		const manager = ctx.sessionManager;
		const cwd = manager.getCwd() || ctx.cwd;
		if (isExcluded(cwd, enabledConfig()?.exclude ?? [])) return `${cwd} is excluded`;
		const excluded = shared().excluded;
		const parent = manager.getHeader()?.parentSession;
		if (parent && excluded.has(parent)) return "its parent session is excluded";
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_LINK_TYPE) continue;
			const link = entry.data as { parentSessionId?: unknown; parentSessionFile?: unknown } | undefined;
			if (typeof link?.parentSessionId === "string" && excluded.has(link.parentSessionId)) return "its parent session is excluded";
			if (typeof link?.parentSessionFile === "string" && excluded.has(link.parentSessionFile)) return "its parent session is excluded";
		}
		return undefined;
	}

	function start(ctx: ExtensionContext, uploader: Uploader): void {
		const manager = ctx.sessionManager;
		const sessionId = manager.getSessionId();
		const file = manager.getSessionFile();
		const cwd = manager.getCwd() || ctx.cwd;
		if (!file) { skipped = "this session has no session file"; return; }
		const captures = shared().captures;
		const existing = captures.get(sessionId);
		if (existing) { existing.owner = self; return; }
		const key = `session:${sessionId}`;
		captures.set(sessionId, new SessionCapture(sessionId, key, currentUploader, self));
		const parentSession = manager.getHeader()?.parentSession;
		void uploader.openStream({ key, kind: "session", path: file, meta: { sessionId, cwd, ...(parentSession ? { parentSession } : {}) } });
	}

	pi.on("session_start", (_event, ctx) => {
		guard(() => {
			config = loadConfig(getAgentDir());
			if (!config.enabled) return;
			sessionId = ctx.sessionManager.getSessionId();
			skipped = exclusion(ctx);
			if (skipped) {
				const file = ctx.sessionManager.getSessionFile();
				excludedKeys = file ? [sessionId, file] : [sessionId];
				for (const key of excludedKeys) shared().excluded.add(key);
				return;
			}
			start(ctx, enroll());
		});
	});

	pi.on("context_with_system", (event, ctx) => {
		guard(() => owned(ctx)?.onContext(event.messages, modelInfo(ctx)));
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		guard(() => owned(ctx)?.onPayload(event.payload, modelInfo(ctx)));
		return undefined;
	});

	pi.on("message_end", (event, ctx) => {
		guard(() => {
			const capture = owned(ctx);
			if (!capture) return;
			if (isAssistant(event.message)) capture.onAssistant(event.message);
			currentUploader()?.poke();
		});
	});

	const poke = (_event: unknown, ctx: ExtensionContext) => { guard(() => { if (owned(ctx)) currentUploader()?.poke(); }); };
	pi.on("turn_end", poke);
	pi.on("agent_end", poke);
	pi.on("session_compact", poke);
	pi.on("session_tree", poke);
	pi.on("session_info_changed", poke);

	pi.on("session_shutdown", async (_event, ctx) => {
		guard(() => {
			for (const key of excludedKeys) shared().excluded.delete(key);
			excludedKeys = [];
			const capture = owned(ctx);
			if (!capture) return;
			shared().captures.delete(capture.sessionId);
			void currentUploader()?.closeStream(capture.key);
			capture.settle();
		});
		try {
			await leave();
		} catch (error) {
			currentUploader()?.noteError(`shutdown: ${errorText(error)}`);
		}
	});

	pi.events.on("herder:run", (payload) => {
		guard(() => {
			if (!joined) return;
			const runDir = (payload as { runDir?: unknown } | undefined)?.runDir;
			if (typeof runDir === "string" && isExcluded(runDir, enabledConfig()?.exclude ?? [])) return;
			currentUploader()?.herderRun(payload);
		});
	});

	pi.registerCommand("pika", {
		description: "Show pika upload status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusText(config ?? loadConfig(getAgentDir()), joined, sessionId, skipped), "info");
		},
	});
}

function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function statusText(config: ConfigResult, joined: boolean, sessionId: string | undefined, skipped: string | undefined): string {
	if (!config.enabled) return `pika is disabled: ${config.reason}.`;
	const uploader = currentUploader();
	const status = uploader?.status();
	const lines = [
		`pika is enabled${joined ? "" : " (not started in this session)"}.`,
		`Server: ${config.config.url}`,
		`This session: ${skipped ? `not captured, ${skipped}` : sessionId ? `captured as session:${sessionId}` : "not started"}`,
	];
	if (status) {
		lines.push(`Queued: ${status.queuedItems} item(s), ${bytes(status.queuedBytes)}`);
		lines.push(`Last successful upload: ${status.lastSuccess ?? "never"}`);
		lines.push(`Last error: ${status.lastError ?? "none"}`);
		if (status.halted) lines.push(`Stopped: ${status.halted}`);
		if (status.parked.items) lines.push(`Parked, too large for the server: ${status.parked.items} item(s), ${bytes(status.parked.bytes)} in ${status.parked.dir}`);
		for (const stream of status.stoppedStreams) lines.push(`Stream ${stream.key} stopped: ${stream.reason}`);
	}
	return lines.join("\n");
}
