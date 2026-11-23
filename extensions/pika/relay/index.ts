import { hostname } from "node:os";
import { basename } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../credentials.ts";
import { registerRelayCommand } from "./commands.ts";
import { type ConnectionState, RelayConnection } from "./connection.ts";
import { createMessaging } from "./messaging.ts";
import { sessionModes } from "./modes.ts";
import { cut, type HelloSession, MESSAGE_TYPE, RECEIVED_TYPE, RELAY_VERSION, timing } from "./protocol.ts";
import { registerRenderers } from "./render.ts";
import { ROLE_TYPE, roleUpdate } from "./roles.ts";
import { createRoomManager } from "./rooms.ts";
import { join, leave, shared, syncHook } from "./shared.ts";
import { blocked, createRelayState, cwdOf, describe, guard, offlineReason, supportedMode } from "./state.ts";
import { createTools } from "./tools.ts";

export type { RelayMessageDetails, RelayNoticeDetails } from "./state.ts";

/** relay: send text messages between running pi sessions through the pika server. */
export default function relayExtension(pi: ExtensionAPI): void {
	const state = createRelayState();
	const rooms = createRoomManager(state);
	const messaging = createMessaging(pi, state, { refreshRooms: rooms.refreshRooms, evaluate });
	const tools = createTools(pi, state, {
		onlineSessions: rooms.onlineSessions,
		relayRooms: rooms.relayRooms,
		roomDetail: rooms.roomDetail,
		learnRooms: rooms.learnRooms,
		send: messaging.send,
	});

	/** Asks pika's registry once per cwd for the repository name; without a resolver, the folder name stays. */
	function prepare(): Promise<void> {
		const cwd = state.ctx ? cwdOf(state.ctx) : undefined;
		if (cwd === undefined) return Promise.resolve();
		if (state.project?.cwd !== cwd) {
			const entry: NonNullable<typeof state.project> = { cwd, pending: Promise.resolve() };
			const resolver = credentialsRegistry().repository;
			if (resolver) {
				entry.pending = Promise.resolve().then(() => resolver(cwd)).then((info) => {
					const name = info?.project;
					if (typeof name === "string" && name.trim()) entry.name = name;
				}, () => undefined);
			}
			state.project = entry;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timing.projectTimeoutMs); timer.unref?.(); });
		return Promise.race([state.project.pending, timeout]).finally(() => clearTimeout(timer));
	}

	function hello(): HelloSession {
		const context = state.ctx!;
		for (const entry of context.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RECEIVED_TYPE) continue;
			const id = (entry.data as { id?: unknown } | undefined)?.id;
			if (typeof id === "string") state.seen.add(id);
		}
		const cwd = cwdOf(context);
		const info = describe(pi, state);
		state.reported = info;
		return {
			id: state.sessionId!, ...info, cwd: cut(cwd, 1024)!, project: cut((state.project?.cwd === cwd ? state.project.name : undefined) || basename(cwd) || cwd, 255)!, host: cut(hostname(), 255)!,
			piVersion: VERSION, relayVersion: RELAY_VERSION,
		};
	}

	function pushState(): void {
		if (!state.connection?.online) return;
		const now = describe(pi, state);
		const changes: Record<string, string> = {};
		for (const key of ["state", "name", "title", "model"] as const) {
			const value = now[key];
			if (value !== undefined && value !== state.reported[key]) changes[key] = value;
		}
		if (!Object.keys(changes).length) return;
		if (state.connection.send({ type: "state", ...changes })) state.reported = { ...state.reported, ...changes };
	}

	/** pi is replacing the session: go offline until `session_shutdown`, or reconnect if it never comes. */
	function depart(): void {
		if (!state.started) return;
		state.leaving = true;
		state.sideGeneration++;
		messaging.scheduler.clear();
		clearTimeout(state.leaveTimer);
		state.leaveTimer = setTimeout(() => guard(stay), timing.leaveTimeoutMs);
		state.leaveTimer.unref?.();
		evaluate();
	}

	/** The session was not replaced after all: reconnect, and the server pushes what has not expired. */
	function stay(): void {
		clearTimeout(state.leaveTimer);
		state.leaveTimer = undefined;
		if (!state.leaving) return;
		state.leaving = false;
		// After `session_shutdown`, `started` is false and this only keeps the session offline.
		evaluate();
	}

	function onChange(connState: ConnectionState): void {
		if (connState.kind !== "online") return;
		const limits = connState.welcome.limits;
		if (Number.isFinite(limits?.ttlSeconds) && limits.ttlSeconds > 0) state.ttlSeconds = limits.ttlSeconds;
		if (Number.isFinite(limits?.maxTextBytes) && limits.maxTextBytes > 0) state.maxTextBytes = limits.maxTextBytes;
		// State may have changed between hello and welcome.
		pushState();
		rooms.refreshRooms();
	}

	function onUnsupported(reason: string): void {
		const sharedState = shared();
		if (sharedState.unsupportedNotified || !state.ctx?.hasUI) return;
		sharedState.unsupportedNotified = true;
		state.ctx.ui.notify(`relay: ${reason}. Sessions stay offline from relay; pika uploads are not affected.`, "warning");
	}

	function disconnect(): void {
		state.connection?.close();
		state.connection = undefined;
		// The next connection gets every unacknowledged message pushed again.
		state.missed = false;
		clearTimeout(state.settleTimer);
		state.settleTimer = undefined;
	}

	/**
	 * Connects, reconnects to new credentials, or disconnects, as the conditions say, and registers or
	 * removes the child hook to match. `restart` replaces a stopped or waiting connection.
	 */
	function evaluate(restart = false): void {
		try { connect(restart); } finally { syncHook(); }
	}

	function connect(restart: boolean): void {
		if (blocked(state) || state.leaving) { disconnect(); return; }
		const current = credentialsRegistry().current!;
		const same = state.connection && state.connection.credentials.url === current.url && state.connection.credentials.token === current.token;
		if (same && !restart) return;
		disconnect();
		state.connection = new RelayConnection({ url: current.url, token: current.token }, {
			prepare, hello,
			onMessage: (frame) => guard(() => messaging.receive(frame)),
			onStatus: (frame) => guard(() => messaging.status(frame)),
			onRoom: (frame) => guard(() => rooms.roomChanged(frame)),
			onChange: (connState) => guard(() => onChange(connState)),
			onUnsupported: (reason) => guard(() => onUnsupported(reason)),
		});
		state.connection.start();
	}

	const onCredentials = () => guard(() => evaluate());

	/** Runs once every `session_start` handler ran, so the child hook has recorded a child's id. */
	function decide(): void {
		if (!state.started || state.decided || !state.sessionId) return;
		state.decided = true;
		clearTimeout(state.fallback);
		if (shared().children.has(state.sessionId)) state.child = true;
		// Print and JSON sessions never get the tools: every Subagents and Herder child runs in one, even
		// when no child hook was registered to mark it.
		if (!state.child && state.ctx && supportedMode(state.ctx)) tools.registerTools();
		evaluate();
	}

	pi.on("session_start", (_event, context) => {
		guard(() => {
			if (process.env.PI_RELAY_DISABLED === "1") return;
			state.ctx = context;
			state.sessionId = context.sessionManager.getSessionId();
			state.started = true;
			state.busy = !context.isIdle();
			state.exchanged.clear();
			state.unread.clear();
			state.sideGeneration++;
			messaging.scheduler.clear();
			state.transcript.clear();
			state.running.clear();
			state.sideAnswers.length = 0;
			state.rooms = undefined;
			state.roomsGeneration++;
			rooms.showRoomStatuses();
			clearTimeout(state.unrepresentTimer);
			state.unrepresentTimer = undefined;
			sessionModes().listeners.add(rooms.onModes);
			join(state.self, state.sessionId, {
				markChild: () => guard(() => { state.child = true; tools.withdrawTools(); evaluate(); }),
				status: () => offlineReason(state) ?? "online",
				canConnect: () => blocked(state, true) === undefined,
			});
			credentialsRegistry().listeners.add(onCredentials);
			// `resources_discover` follows the last `session_start` handler; the timer covers a host that skips it.
			state.fallback = setTimeout(() => guard(decide), timing.decideFallbackMs);
			state.fallback.unref?.();
		});
	});

	pi.on("resources_discover", () => { guard(decide); return undefined; });

	// pi aborts the outgoing session before `session_shutdown`; nothing may start a run on it meanwhile,
	// and a message the outgoing session acknowledged would never reach the next one.
	pi.on("session_before_switch", () => { guard(depart); return undefined; });
	pi.on("session_before_fork", () => { guard(depart); return undefined; });

	pi.on("session_before_compact", () => { state.summarizing = true; return undefined; });
	pi.on("session_compact", () => { state.summarizing = false; });
	pi.on("session_compact_failed", () => { state.summarizing = false; });
	pi.on("session_before_tree", () => { state.summarizing = true; return undefined; });
	pi.on("session_tree", () => { state.summarizing = false; });

	pi.on("before_agent_start", (event, context) => {
		// This session's role in its rooms, while the model cannot see it: once per change, and again after a
		// compaction drops it or /tree leaves it off the branch.
		let role: ReturnType<typeof roleUpdate>;
		try { role = state.sessionId ? roleUpdate(state.rooms, state.sessionId, context.sessionManager.getBranch()) : undefined; } catch { role = undefined; }
		const result = role ? { message: { customType: ROLE_TYPE, content: role.content, display: false, details: role.details } } : undefined;
		if (event.messageType !== "user") return result;
		state.runHops = 0;
		// The user prompted this session, so a replacement was cancelled or failed.
		guard(stay);
		// The prompt is not in the session yet when agent_start tells the server it is busy.
		if (!state.title && event.prompt.trim()) state.title = cut(event.prompt.replace(/\s+/g, " ").trim(), 120);
		return result;
	});
	// The previous run's request lacks this run's prompt: until this run's first request, there is nothing to repeat.
	pi.on("agent_start", () => { state.busy = true; state.turnStartedAt = Date.now(); state.transcript.clear(); guard(pushState); });
	pi.on("agent_end", () => { state.busy = false; state.turnStartedAt = undefined; state.running.clear(); guard(pushState); });
	// pika loads last and leaves the request as it is, so this is what the provider gets.
	pi.on("context_with_system", (event) => { state.transcript.onRequest(event.messages); return undefined; });
	pi.on("message_end", (event) => { guard(() => state.transcript.onMessageEnd(event.message)); return undefined; });
	pi.on("tool_execution_start", (event) => { if (!event.parentToolCallId) state.running.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() }); });
	pi.on("tool_execution_end", (event) => { state.running.delete(event.toolCallId); });
	// The model reads a relay message when pi adds it to the context: as a turn starts, after a tool call, or after the turn.
	pi.on("message_start", (event) => {
		guard(() => {
			const message = event.message as { role?: string; customType?: string; details?: { id?: unknown } };
			if (message.role !== "custom" || message.customType !== MESSAGE_TYPE || typeof message.details?.id !== "string") return;
			messaging.scheduler.read(message.details.id);
			const entry = state.unread.get(message.details.id);
			if (!entry) return;
			state.unread.delete(message.details.id);
			state.exchanged.set(entry.peer, Date.now());
		});
	});
	// What the model has not read once pi settled left its queues unread (Esc, RPC clear_queue).
	pi.on("agent_settled", () => {
		state.sideGeneration++;
		state.unread.clear();
		messaging.scheduler.clear();
		state.sideAnswers.length = 0;
	});
	pi.on("session_info_changed", () => { guard(pushState); });
	pi.on("model_select", () => { guard(pushState); });

	pi.on("session_shutdown", () => {
		guard(() => {
			// Swarm mode leaves the registry at every shutdown, /reload's too: that is no turning off, so the
			// session keeps its rooms. The full room list after the next connect checks the registry again.
			clearTimeout(state.unrepresentTimer);
			state.unrepresentTimer = undefined;
			sessionModes().listeners.delete(rooms.onModes);
			state.rooms = undefined;
			state.roomsGeneration++;
			rooms.showRoomStatuses();
			state.started = false;
			state.leaving = false;
			state.sideGeneration++;
			state.unread.clear();
			state.sideAnswers.length = 0;
			messaging.scheduler.clear();
			state.transcript.clear();
			clearTimeout(state.fallback);
			clearTimeout(state.leaveTimer);
			state.leaveTimer = undefined;
			disconnect();
			credentialsRegistry().listeners.delete(onCredentials);
			leave(state.self);
			state.ctx = undefined;
		});
	});

	registerRenderers(pi);
	registerRelayCommand(pi, state, { rooms, scheduler: messaging.scheduler, send: messaging.send, stay, evaluate });
}
