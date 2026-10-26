import { join } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAssistant, SessionCapture } from "./capture.ts";
import { isExcluded, loadConfig, type ConfigResult } from "./config.ts";
import { isPlainRemote, login, type LoginControl, readConfigFile, writeConfigFile } from "./login.ts";
import { acquireUploader, currentUploader, releaseUploader, type Uploader, type UploaderOptions } from "./uploader.ts";

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
	/** Enabled pika instances whose session has started and not shut down, each with what stops its capture. */
	members: Map<object, () => void>;
	/** Members `/pika logout` stopped whose session is still open, each with what attaches it again after a login. */
	detached: Map<object, () => void>;
	hook?: ChildSessionHook;
	/** One capture per session id, owned by the last pika instance that started in it. */
	captures: Map<string, SessionCapture>;
	/** Session ids and files of open excluded sessions; their children are excluded too. */
	excluded: Set<string>;
	/** The process's one unfinished `/pika login`; a newer login, a logout, or the end of its session cancels it. */
	login?: LoginTicket;
	/** Counts logins, so a replaced one can tell it is no longer current. */
	logins: number;
}
interface LoginTicket extends LoginControl {
	generation: number;
	/** The pika instance whose session started it. */
	owner: object;
	cancel(reason: string): void;
}
const global = globalThis as { [SHARED]?: Shared; [CHILD_SESSION_HOOKS]?: Set<ChildSessionHook> };
const shared = (): Shared => global[SHARED] ??= { members: new Map(), detached: new Map(), captures: new Map(), excluded: new Set(), logins: 0 };
const hooks = (): Set<ChildSessionHook> => global[CHILD_SESSION_HOOKS] ??= new Set();

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const USAGE = "Usage: /pika [status|login [url]|logout]";
const SUBCOMMANDS = ["status", "login", "logout"];

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
	/** The context this instance last attached with; valid until its session shuts down. */
	let attachedCtx: ExtensionContext | undefined;
	/** The session shut down, so contexts from it must not be used. */
	let ended = false;

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

	const uploaderOptions = (): UploaderOptions => {
		const { url, token } = enabledConfig()!;
		return { url, token, dir: join(getAgentDir(), "pika"), piVersion: VERSION };
	};

	function enroll(): Uploader {
		const state = shared();
		const uploader = acquireUploader(uploaderOptions());
		if (!joined) {
			joined = true;
			state.members.set(self, detach);
			state.hook ??= { name: "pika", extensionFactory: (child) => pikaExtension(child) };
			hooks().add(state.hook);
		}
		return uploader;
	}

	async function leave(): Promise<void> {
		if (!joined) return;
		joined = false;
		const state = shared();
		state.members.delete(self);
		if (state.members.size > 0) return;
		if (state.hook) hooks().delete(state.hook);
		const uploader = currentUploader();
		if (!uploader) return;
		await uploader.drain(SHUTDOWN_FLUSH_MS);
		if (shared().members.size === 0) await releaseUploader(uploader);
	}

	/** Stops capturing without uploading anything more; `/pika logout` does this for every instance. */
	function detach(): void {
		joined = false;
		sessionId = undefined;
		skipped = undefined;
		const ctx = attachedCtx;
		if (ctx) shared().detached.set(self, () => { guard(() => attach(ctx)); });
	}

	/**
	 * Stops every capture and upload in this process at once. Held calls are released without their
	 * assistant message, and everything queued stays on disk for the next uploader.
	 */
	async function stopProcess(): Promise<void> {
		const state = shared();
		for (const stop of state.members.values()) stop();
		state.members.clear();
		for (const capture of state.captures.values()) capture.settle();
		state.captures.clear();
		if (state.hook) hooks().delete(state.hook);
		const uploader = currentUploader();
		if (uploader) await releaseUploader(uploader);
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

	/** Reads the configuration and, when enabled and not excluded, captures the session from its first line. */
	function attach(ctx: ExtensionContext): void {
		config = loadConfig(getAgentDir());
		if (!config.enabled) return;
		attachedCtx = ctx;
		shared().detached.delete(self);
		sessionId = ctx.sessionManager.getSessionId();
		skipped = exclusion(ctx);
		if (skipped) {
			const file = ctx.sessionManager.getSessionFile();
			excludedKeys = file ? [sessionId, file] : [sessionId];
			for (const key of excludedKeys) shared().excluded.add(key);
			return;
		}
		start(ctx, enroll());
	}

	pi.on("session_start", (_event, ctx) => { ended = false; guard(() => attach(ctx)); });

	pi.on("context_with_system", (event, ctx) => {
		guard(() => owned(ctx)?.onContext(event.messages, modelInfo(ctx)));
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		guard(() => owned(ctx)?.onPayload(event.payload, modelInfo(ctx)));
		return undefined;
	});

	pi.on("message_start", (event, ctx) => {
		guard(() => { if (isAssistant(event.message)) owned(ctx)?.onAssistantStart(event.message); });
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
		ended = true;
		const pending = shared().login;
		if (pending?.owner === self) pending.cancel("the session ended");
		guard(() => {
			for (const key of excludedKeys) shared().excluded.delete(key);
			excludedKeys = [];
			shared().detached.delete(self);
			attachedCtx = undefined;
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

	/** Cancels the process's unfinished login, if any; the line for the cancelling command's message. */
	function cancelLogin(reason: string): string | undefined {
		const pending = shared().login;
		if (!pending) return undefined;
		const waiting = pending.waiting;
		pending.cancel(reason);
		return waiting ? "Cancelled the earlier /pika login, which was waiting for its pairing code to be approved." : "Cancelled the earlier /pika login, which had not finished.";
	}

	/** Makes this login the process's current one, cancelling the one before. */
	function startLogin(ctx: ExtensionCommandContext): LoginTicket {
		const state = shared();
		const controller = new AbortController();
		const generation = ++state.logins;
		const ticket: LoginTicket = {
			generation, owner: self,
			signal: ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal,
			isCurrent: () => shared().login?.generation === generation && !ended,
			isOpen: () => !ended,
			cancel: (reason) => {
				if (shared().login === ticket) shared().login = undefined;
				controller.abort(reason);
			},
		};
		state.login = ticket;
		return ticket;
	}

	async function loginCommand(ctx: ExtensionCommandContext, arg: string | undefined): Promise<void> {
		const note = cancelLogin("a newer /pika login started");
		if (note) ctx.ui.notify(`pika: ${note}`, "info");
		const ticket = startLogin(ctx);
		const before = loadConfig(getAgentDir());
		let saved: Awaited<ReturnType<typeof login>>;
		try {
			saved = await login(ctx, before.file, arg, before.enabled ? before.config.url : before.url, VERSION, ticket);
		} finally {
			if (shared().login === ticket) shared().login = undefined;
		}
		if (!saved) return;
		// The token was just accepted, so the process starts a new uploader even with the same login,
		// one a 401 or a long backoff stopped included. A session that had not joined joins now, and so
		// do the other open sessions `/pika logout` stopped.
		guard(() => {
			config = loadConfig(getAgentDir());
			if (!config.enabled) return;
			if (currentUploader()) acquireUploader(uploaderOptions(), true);
			// A session that shut down while the file was written keeps its old context out of the process.
			if (!joined && !ended) attach(ctx);
			const detached = shared().detached;
			for (const [member, reattach] of [...detached]) {
				detached.delete(member);
				reattach();
			}
		});
		if (ended) return;
		const lines = [`Logged in to ${saved.url}${saved.device ? ` as ${saved.device}` : ""}; saved to ${saved.file}.${saved.reenabled ? ' Removed "enabled": false, so uploads are on again.' : ""}`];
		const warnings: string[] = [];
		if (isPlainRemote(saved.url)) warnings.push("The URL is plain http to another host, so the token travels unencrypted.");
		const overridden = ["PIKA_URL", "PIKA_TOKEN"].filter((name) => process.env[name]);
		if (overridden.length) warnings.push(`${overridden.join(" and ")} in the environment override${overridden.length === 1 ? "s" : ""} the saved value${overridden.length === 1 ? "" : "s"}.`);
		const current = config;
		if (process.env.PIKA_DISABLED === "1") warnings.push("The login is saved, but PIKA_DISABLED=1 keeps uploads off.");
		else if (joined && !skipped && current?.enabled) lines.push(`This session now uploads to ${current.config.url}.`);
		else if (skipped) lines.push(`This session is not captured: ${skipped}.`);
		else if (current && !current.enabled) lines.push(`Uploads stay off: ${current.reason}.`);
		lines.push("Other pi processes use it from their next session.");
		ctx.ui.notify([...lines, ...warnings].join("\n"), warnings.length ? "warning" : "info");
	}

	async function logoutCommand(ctx: ExtensionCommandContext): Promise<void> {
		const file = loadConfig(getAgentDir()).file;
		const env = ["PIKA_URL", "PIKA_TOKEN"].filter((name) => process.env[name]);
		const envWarning = env.length ? `${env.join(" and ")} ${env.length === 1 ? "is" : "are"} set in the environment, so new sessions still use ${env.length === 1 ? "it" : "them"}.` : undefined;
		const note = cancelLogin("/pika logout ran");
		try {
			const fields = await readConfigFile(file);
			if (!fields || (!("url" in fields) && !("token" in fields))) {
				ctx.ui.notify([`pika: nothing to log out; ${file} has no url or token.`, ...(note ? [note] : []), ...(envWarning ? [envWarning] : [])].join("\n"), "info");
				return;
			}
			const { url: _url, token: _token, ...rest } = fields;
			await writeConfigFile(file, rest);
		} catch (error) {
			ctx.ui.notify([`pika logout failed: ${errorText(error)}. Nothing changed.`, ...(note ? [note] : [])].join("\n"), "error");
			return;
		}
		await stopProcess();
		config = loadConfig(getAgentDir());
		const lines = [
			`Logged out of pika: removed the url and token from ${file}. This process stopped uploading.`,
			`Queued data stays in ${join(getAgentDir(), "pika")} and uploads after the next login.`,
		];
		ctx.ui.notify([...lines, ...(note ? [note] : []), ...(envWarning ? [envWarning] : [])].join("\n"), envWarning ? "warning" : "info");
	}

	pi.registerCommand("pika", {
		description: "Show pika upload status, or log in to or out of a pika server",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (command === "status" && !rest.length) ctx.ui.notify(statusText(config ?? loadConfig(getAgentDir()), joined, sessionId, skipped), "info");
			else if (command === "login" && rest.length <= 1) await loginCommand(ctx, rest[0]);
			else if (command === "logout" && !rest.length) await logoutCommand(ctx);
			else ctx.ui.notify(USAGE, "error");
		},
	});
}

function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function statusText(config: ConfigResult, joined: boolean, sessionId: string | undefined, skipped: string | undefined): string {
	if (!config.enabled) return `pika is disabled: ${config.reason}.${config.unconfigured ? " Run /pika login to set it up." : ""}`;
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
