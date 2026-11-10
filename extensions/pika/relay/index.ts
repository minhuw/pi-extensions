import { hostname } from "node:os";
import { basename } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadRelaySettings } from "../config.ts";
import { credentialsRegistry } from "../credentials.ts";
import { type ConnectionState, RelayConnection, RequestError } from "./connection.ts";
import {
	cut, deviceLabel, expiredContent, headerField, type HelloSession, MAX_HOPS, MESSAGE_TYPE, type MessageFrame, messageContent, NOTICE_TYPE, type OnlineSession, RECEIVED_TYPE,
	type RelayRoom, type RelayRoomDetail, RELAY_VERSION, type RoomFrame, type RoomMember, type RoomMessage, sanitize, type SentFrame, type SessionState, since, type StatusFrame, type Target, targetLabel, timing,
	ttlText,
} from "./protocol.ts";
import { hasMode, sessionModes } from "./modes.ts";
import { representativeLabel, ROLE_TYPE, roleStatus, roleUpdate } from "./roles.ts";
import { join, leave, shared, syncHook } from "./shared.ts";
import {
	answerText, askSide, automatic, busyText, type Running, type SideAnswer, type SideDetails, type SideJob, sideNote, type SideOutcome, sideRequest,
	SideScheduler, SIDE_TYPE, Transcript,
} from "./side.ts";
import { logItems, peerLabel, type RelaySentData, senderLabel, SENT_TYPE, showRelayLog, size } from "./viewer.ts";

export { timing } from "./protocol.ts";

/** At most this many sent messages are remembered for relay_status, and this many shown. */
const SENT_KEPT = 200;
const SENT_SHOWN = 50;
const USAGE = "Usage: /relay [status|send <sessionId> <text>|rooms|join <room> [topic]|leave <room>|represent <room>|represent off [<room>]|log|side [on|off]|off|on]";
const SUBCOMMANDS = ["status", "send", "join", "leave", "represent", "rooms", "log", "side", "off", "on"];
/** The footer status key, and the session mode a representative needs. */
const ROLE_STATUS = "representative";
const ALWAYSON = "alwayson";

/**
 * `failed`: the message never left this session; `unknown`: the server never answered (timeout,
 * dropped connection, or cancelled), so it may or may not have been accepted.
 */
type SentStatus = "queued" | "delivered" | "expired" | "rejected" | "failed" | "unknown";
interface SentRecord { id?: string; to: string; label: string; status: SentStatus; reason?: string; at: number; text: string }
/**
 * A delivered message the model has not read yet. `soon`: it reaches the model before its next model
 * call, not only after its turn; `told`: a send to its peer was refused once for it.
 */
interface Unread { peer: string; label: string; soon: boolean; told: boolean }

export interface RelayMessageDetails { id: string; room?: string; mentions?: string[]; from: MessageFrame["from"]; text: string; urgent: boolean; replyTo?: string; hops: number; sentAt: string | number }
export interface RelayNoticeDetails { id: string; to: Target; status: "expired"; at: string | number }

const REJECTIONS: Record<string, string> = {
	invalid: "the message is invalid: empty text, a malformed session id, or bad hops",
	self: "that is this session's own id",
	too_large: "the text is too large",
	rate_limited: "this session sent too many messages in the last minute; wait before sending more",
	unknown_session: "no online or recorded pi session has that id; call relay_list for the online sessions",
	mailbox_full: "the target's mailbox is full; try again later",
	not_owner: "that session belongs to another device, so only that device may act for it in rooms",
	unknown_room: "no such chatroom; your user creates rooms with /relay join",
	not_member: "this session is not a member of that room; only your user can add it, with /relay join <room>",
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const roomKey = (name: string) => name.trim().replace(/^#/, "");
const supportedMode = (context: ExtensionContext) => context.mode === "tui" || context.mode === "rpc";
const preview = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 60 ? `${line.slice(0, 59)}…` : line; };

interface SendArgs { to?: string; room?: string; text?: string; urgent?: boolean; replyTo?: string }
type ToolResult = { content: readonly { type: string; text?: string }[]; details?: unknown };

const resultText = (result: ToolResult) => sanitize(result.content.map((part) => part.type === "text" ? part.text ?? "" : "").join(""));
const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? "";

/**
 * `✉ relay → target [urgent] [reply to id] · size`, and the text when expanded. Every argument is the
 * model's, and a send it repeats may carry another device's text.
 */
function sendCall(args: SendArgs, theme: Theme, expanded: boolean): Text {
	const room = headerField(args.room).replace(/^#/, "");
	const target = room ? `#${room}` : headerField(args.to) || "?";
	const replyTo = headerField(args.replyTo);
	const text = sanitize(args.text);
	const tags = [args.urgent ? theme.fg("warning", "urgent") : "", replyTo ? theme.fg("dim", `reply to ${replyTo}`) : ""].filter(Boolean);
	const head = `${theme.fg("accent", "✉ relay →")} ${theme.bold(target)}${tags.length ? ` ${tags.join(" ")}` : ""} ${theme.fg("dim", `· ${size(text)}`)}`;
	return new Text([head, ...(expanded ? text.split("\n").map((line) => `  ${line}`) : [])].join("\n"), 0, 0);
}

/** The whole result when expanded; else one line: an error's first line, or what became of the message. */
function resultLine(result: ToolResult, expanded: boolean, isError: boolean, theme: Theme, summary: () => string | undefined): Text {
	const text = resultText(result);
	if (isError) return new Text(theme.fg("error", expanded ? text : firstLine(text)), 0, 0);
	return new Text(expanded ? text : summary() ?? firstLine(text), 0, 0);
}

function sentSummary(frame: Partial<Extract<SentFrame, { id: string }>> | undefined, theme: Theme): string | undefined {
	if (!frame?.id || (frame.status !== "delivered" && frame.status !== "queued")) return undefined;
	const id = theme.fg("dim", `· ${headerField(frame.id)}`);
	if (frame.room) {
		const notified = (frame.notified ?? []).map((target) => headerField(target.name) || headerField(target.title) || headerField(target.sessionId));
		const unmatched = unmatchedOf(frame);
		return `${theme.fg("success", `posted to #${headerField(frame.room)}`)} · ${notified.length ? `notified ${notified.join(", ")}` : "no one notified"}`
			+ `${unmatched.length ? ` · ${theme.fg("warning", `not members: ${unmatched.join(", ")}`)}` : ""} ${id}`;
	}
	return frame.status === "delivered"
		? `${theme.fg("success", "delivered")} to ${peerLabel(frame.to)} ${id}`
		: `${theme.fg("warning", "queued")} for ${peerLabel(frame.to)}, not delivered yet ${id}`;
}

/** The mention tokens of a room post that matched no member, cleaned for display. */
const unmatchedOf = (frame: { unmatched?: unknown }): string[] => Array.isArray(frame.unmatched)
	? frame.unmatched.map((token) => cut(headerField(token), 64)!).filter(Boolean)
	: [];

/** The conversation a message belongs to: `#room`, else the sending session's id; none for the web UI. */
const peerOf = (frame: MessageFrame): string | undefined => frame.room ? `#${frame.room}` : frame.from.kind === "session" ? frame.from.sessionId : undefined;

/** Why a send to a peer waits until the model read the peer's newer messages. */
function unreadText(ids: string[], label: string, soon: boolean): string {
	const one = ids.length === 1;
	const which = `${one ? "message" : "messages"} ${ids.map(headerField).join(", ")} from ${label}`;
	const it = one ? "it" : "them";
	return soon
		? `Not sent: ${which} arrived while you were writing yours, and you have not read ${it} yet. ${one ? "It follows" : "They follow"} this result: read ${it}, then send again if your message still adds something.`
		: `Not sent: ${which} ${one ? "waits" : "wait"} for you until your current turn ends. End your turn now to read ${it}, then reply if your message still adds something.`;
}

function firstPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
		if (text.trim()) return cut(text.replace(/\s+/g, " ").trim(), 120);
	}
	return undefined;
}

/** relay: send text messages between running pi sessions through the pika server. */
export default function relayExtension(pi: ExtensionAPI): void {
	const self = {};
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let started = false;
	/** Whether the connect decision ran, after every `session_start` handler. */
	let decided = false;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	let child = false;
	/** `/relay off` ran in this session. */
	let off = false;
	/**
	 * The session is being replaced (`session_before_switch` or `session_before_fork` ran): its
	 * connection is closed, so the server keeps its messages queued and expires them. A replacement
	 * that was cancelled or failed shows as no `session_shutdown` within `leaveTimeoutMs`, a user
	 * prompt, or `/relay`, which reconnect.
	 */
	let leaving = false;
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	/** A compaction or tree summary started and its end event has not come yet. */
	let summarizing = false;
	/** A message arrived while pi was summarizing; the connection restarts once it is done. */
	let missed = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let busy = false;
	let connection: RelayConnection | undefined;
	let toolsRegistered = false;
	let runHops = 0;
	let ttlSeconds = 300;
	let maxTextBytes = 32 * 1024;
	let maxHops = MAX_HOPS;
	const rejection = (reason: string): string | undefined => reason === "hop_limit"
		? `the message would travel more than ${maxHops} hops between sessions without the user; stop relaying and wait for your user`
		: REJECTIONS[reason];
	let title: string | undefined;
	/** The repository name pika resolves for the session's cwd, once asked; undefined until then or without one. */
	let project: { cwd: string; name?: string; pending: Promise<void> } | undefined;
	/** What the server last heard of this session's state, name, title, and model. */
	let reported: Partial<Pick<HelloSession, "state" | "name" | "title" | "model">> = {};
	const seen = new Set<string>();
	const notified = new Set<string>();
	const sent: SentRecord[] = [];
	/** When this session last sent to each peer (a session id or `#room`), or its model last read a message from it. */
	const exchanged = new Map<string, number>();
	/** Delivered messages the model has not read yet, by id, in arrival order. */
	const unread = new Map<string, Unread>();
	const talking = (peer: string) => { const at = exchanged.get(peer); return at !== undefined && Date.now() - at < timing.conversationMs; };
	/** A message of the peer waits for the end of the turn. */
	const waiting = (peer: string) => [...unread.values()].some((entry) => entry.peer === peer && !entry.soon);

	/** The turn's last model request and what followed it, which a side request repeats. */
	const transcript = new Transcript();
	/** The turn's top-level tool calls that have not finished, by id, in start order. */
	const running = new Map<string, Running>();
	let turnStartedAt: number | undefined;
	/** `/relay side on|off` in this session; undefined follows `relay.sideAnswers` in pika.json. */
	let sideOverride: boolean | undefined;
	/** What side requests answered since the session last settled. */
	const sideAnswers: SideAnswer[] = [];
	const sideSettings = () => {
		const settings = loadRelaySettings(getAgentDir());
		return { on: sideOverride ?? settings.sideAnswers, afterMs: settings.sideAnswerSeconds * 1000 };
	};
	/** The rooms this session is a member of, by name, as the server last listed them; undefined until the first full list. */
	let rooms: Map<string, RelayRoom> | undefined;
	/** Counts room lists, so an older answer never replaces a newer one. */
	let roomsGeneration = 0;
	/** The footer's `representative` status as last set. */
	let roleShown: string | undefined;
	/** Always-on mode is off while this session represents a room: it stops representing once this fires. */
	let unrepresentTimer: ReturnType<typeof setTimeout> | undefined;
	const isMember = (room: RelayRoom) => Array.isArray(room?.members) && room.members.some((member) => member.sessionId === sessionId);
	/** The rooms this session represents, as far as it knows. */
	const represented = () => [...(rooms?.values() ?? [])].filter((room) => room.representative === sessionId).map((room) => room.name);
	/** Another session represents the user in the room, so this one reports there and its user does not read it. */
	const reportsIn = (name: string) => { const representative = rooms?.get(roomKey(name))?.representative; return representative !== undefined && representative !== sessionId; };
	const scheduler = new SideScheduler({
		waiting: (id) => unread.has(id) && started && !leaving && ctx?.isIdle() === false && sideSettings().on,
		run: (job, signal) => answerSide(job, signal),
	});

	// Relay never throws into pi.
	const guard = (fn: () => void) => { try { fn(); } catch { /* reported through /relay */ } };

	const cwdOf = (context: ExtensionContext) => context.sessionManager.getCwd() || context.cwd;

	/**
	 * Why this session must stay offline, before any connection state; undefined when it may connect.
	 * `starting` skips the wait for the connect decision, for the child hook.
	 */
	function blocked(starting = false): string | undefined {
		if (process.env.PI_RELAY_DISABLED === "1") return "PI_RELAY_DISABLED=1 is set";
		if (!started || !ctx) return "the session has not started";
		if (child) return "this is a child session (a subagent or Herder step); relay connects only top-level sessions";
		if (!supportedMode(ctx)) return `relay connects only in the TUI and RPC modes, and this session runs in ${ctx.mode} mode`;
		if (!decided && !starting) return "the session is still starting";
		if (off) return "relay is off for this session (/relay off); /relay on reconnects it";
		const current = credentialsRegistry().current;
		if (!current) return "pika is not logged in or is disabled; run /pika login";
		const cwd = cwdOf(ctx);
		if (current.isExcluded(cwd)) return `${cwd} is excluded by pika's exclude list`;
		return undefined;
	}

	/** Why the session cannot send now; undefined when it is online. */
	function offlineReason(): string | undefined {
		const reason = blocked();
		if (reason) return reason;
		if (leaving) return "pi is replacing this session (/new, /resume, or a fork)";
		const state = connection?.state;
		if (!state || state.kind === "closed") return "it is not connected";
		if (state.kind === "connecting") return state.reason ? `it is reconnecting after: ${state.reason}` : "it is still connecting";
		if (state.kind === "retrying") return `${state.reason}; it retries in ${Math.max(0, Math.ceil((state.at - Date.now()) / 1000))} s`;
		if (state.kind === "stopped") return `${state.reason}; /relay on retries`;
		return undefined;
	}

	function describe(): Partial<HelloSession> & { state: SessionState } {
		const name = pi.getSessionName();
		if (!name && !title && ctx) title = firstPrompt(ctx);
		const model = ctx?.model;
		return {
			state: busy ? "busy" : "idle",
			...(name ? { name: cut(name, 200) } : {}),
			...(name || title ? { title: cut(name || title, 200) } : {}),
			...(model ? { model: cut(`${model.provider}/${model.id}`, 200) } : {}),
		};
	}

	/** Asks pika's registry once per cwd for the repository name; without a resolver, the folder name stays. */
	function prepare(): Promise<void> {
		const cwd = ctx ? cwdOf(ctx) : undefined;
		if (cwd === undefined) return Promise.resolve();
		if (project?.cwd !== cwd) {
			const entry: NonNullable<typeof project> = { cwd, pending: Promise.resolve() };
			const resolver = credentialsRegistry().repository;
			if (resolver) {
				entry.pending = Promise.resolve().then(() => resolver(cwd)).then((info) => {
					const name = info?.project;
					if (typeof name === "string" && name.trim()) entry.name = name;
				}, () => undefined);
			}
			project = entry;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timing.projectTimeoutMs); timer.unref?.(); });
		return Promise.race([project.pending, timeout]).finally(() => clearTimeout(timer));
	}

	function hello(): HelloSession {
		const context = ctx!;
		for (const entry of context.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RECEIVED_TYPE) continue;
			const id = (entry.data as { id?: unknown } | undefined)?.id;
			if (typeof id === "string") seen.add(id);
		}
		const cwd = cwdOf(context);
		const info = describe();
		reported = info;
		return {
			id: sessionId!, ...info, cwd: cut(cwd, 1024)!, project: cut((project?.cwd === cwd ? project.name : undefined) || basename(cwd) || cwd, 255)!, host: cut(hostname(), 255)!,
			piVersion: VERSION, relayVersion: RELAY_VERSION,
		};
	}

	function pushState(): void {
		if (!connection?.online) return;
		const now = describe();
		const changes: Record<string, string> = {};
		for (const key of ["state", "name", "title", "model"] as const) {
			const value = now[key];
			if (value !== undefined && value !== reported[key]) changes[key] = value;
		}
		if (!Object.keys(changes).length) return;
		if (connection.send({ type: "state", ...changes })) reported = { ...reported, ...changes };
	}

	/** Whether pi is compacting the session or summarizing a branch; never once it is idle. */
	function isSummarizing(): boolean {
		if (summarizing && ctx?.isIdle()) summarizing = false;
		return summarizing;
	}

	/** Restarts the connection once pi stopped summarizing, so the server pushes the held-back messages again. */
	function settle(): void {
		if (settleTimer) return;
		settleTimer = setTimeout(() => guard(() => {
			settleTimer = undefined;
			if (!missed) return;
			if (isSummarizing()) { settle(); return; }
			missed = false;
			evaluate(true);
		}), timing.settlePollMs);
		settleTimer.unref?.();
	}

	/**
	 * Delivers a message, records its receipt, then acknowledges it. The receipt follows `sendMessage`
	 * so a delivery that throws leaves no receipt: it is not acknowledged, and the server's next push
	 * (after a reconnect or `/resume`) is delivered instead of being taken for a duplicate. Only a
	 * synchronous throw counts: pi reports a failure inside its own delivery as an extension error,
	 * after the message was recorded and acknowledged. A receipt that fails after a delivery still
	 * acknowledges it, since pi already holds the message.
	 */
	function receive(frame: MessageFrame): void {
		const current = connection;
		if (!current || !ctx) return;
		if (seen.has(frame.id)) { current.send({ type: "ack", id: frame.id }); return; }
		// pi starts a run for a custom message even during a compaction or tree summary, where it refuses
		// a user prompt. The message stays unacknowledged on the server, which pushes it again (unless it
		// expired) on the reconnect that follows.
		if (missed || isSummarizing()) { missed = true; settle(); return; }
		const hops = Number.isInteger(frame.hops) && frame.hops >= 0 ? frame.hops : 0;
		const urgent = frame.urgent === true;
		const peer = peerOf(frame);
		const idle = ctx.isIdle();
		// A busy session steers in the messages of a peer it is talking with, so that a reply it writes meanwhile
		// does not cross them. Only urgent ones overtake an earlier message of the peer that waits for the turn's end.
		const steer = !idle && (urgent || (peer !== undefined && talking(peer) && !waiting(peer)));
		const details: RelayMessageDetails = {
			id: frame.id, from: frame.from, text: frame.text, urgent, hops, sentAt: frame.sentAt,
			...(frame.room ? { room: frame.room } : {}),
			...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
			...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
		};
		const label = frame.room ? `room #${headerField(frame.room)}` : targetLabel(frame.from as Target);
		// The user may have added this session to the room in the web UI since the last list.
		if (frame.room && rooms && !rooms.has(roomKey(frame.room))) guard(refreshRooms);
		// Unless steered, the model reads it right after an answer the user has not replied to; but a member that
		// reports to a representative has no user reading it.
		const unanswered = !steer && !(frame.room && reportsIn(frame.room));
		// Before the delivery, whose turn may read it at once.
		if (peer !== undefined) unread.set(frame.id, { peer, label, soon: idle || steer, told: false });
		try {
			const options = idle ? { triggerTurn: true } : steer ? { deliverAs: "steer" as const, triggerTurn: true } : { deliverAs: "followUp" as const, triggerTurn: true };
			pi.sendMessage<RelayMessageDetails>({ customType: MESSAGE_TYPE, content: messageContent({ ...frame, urgent, hops }, unanswered), display: true, details }, options);
		} catch {
			// Threw synchronously, so pi does not hold it: not acknowledged, and pushed again after a reconnect.
			unread.delete(frame.id);
			return;
		}
		seen.add(frame.id);
		runHops = Math.max(runHops, hops);
		// The text stays in the transcript even if Esc or RPC clear_queue drops a queued delivery.
		guard(() => pi.appendEntry(RECEIVED_TYPE, { id: frame.id, ...(frame.room ? { room: frame.room } : {}), from: frame.from, text: frame.text, replyTo: frame.replyTo, hops, urgent, at: new Date().toISOString() }));
		current.send({ type: "ack", id: frame.id });
		// Another session's message that a busy turn leaves unread gets a side answer; a side answer or busy notice never does.
		if (idle || frame.from.kind !== "session" || automatic(frame.text)) return;
		const side = sideSettings();
		if (side.on) scheduler.schedule({ frame: { ...frame, urgent, hops }, label, soon: steer, at: Date.now() }, side.afterMs);
	}

	/**
	 * One side request for a message the turn has not read, then its answer or a busy notice to the sender, unless the
	 * model read the message meanwhile. The turn also gets the answer, before the message.
	 */
	async function answerSide(job: SideJob, signal: AbortSignal): Promise<void> {
		const context = ctx;
		const { frame } = job;
		if (!context || frame.from.kind !== "session") return;
		const messages = transcript.snapshot(running);
		let outcome: SideOutcome | undefined;
		if (messages) {
			messages.push({ role: "user", content: sideRequest(job, sideAnswers), timestamp: Date.now() });
			const limited = AbortSignal.any([signal, AbortSignal.timeout(timing.sideTimeoutMs)]);
			outcome = await askSide(context, pi.getThinkingLevel(), messages, limited).catch(() => undefined);
		}
		if (signal.aborted || !unread.has(frame.id)) return;
		outcome ??= { kind: "defer", reason: "" };
		if (outcome.kind === "none") return;
		const text = outcome.kind === "answer" ? answerText(outcome.text) : busyText(job, turnStartedAt, running.values().next().value, outcome.reason);
		const options = { replyTo: frame.id, hops: frame.hops + 1 };
		const { answer } = frame.room
			? await send("", text, { ...options, room: frame.room, mentions: [frame.from.sessionId] })
			: await send(frame.from.sessionId, text, options);
		if (outcome.kind !== "answer" || answer.status === "rejected") return;
		sideAnswers.push({ id: frame.id, label: job.label, text: outcome.text });
		// The note quotes the message, so a correction the model sends cannot cross it.
		const entry = unread.get(frame.id);
		if (entry) entry.told = true;
		const details: SideDetails = { id: frame.id, replyId: answer.id, label: job.label, question: frame.text, text: outcome.text };
		// An idle session read the message already, or is about to: the note waits for its next turn.
		pi.sendMessage<SideDetails>({ customType: SIDE_TYPE, content: sideNote(details), display: true, details }, context.isIdle() ? {} : { deliverAs: "steer", triggerTurn: true });
	}

	/** pi is replacing the session: go offline until `session_shutdown`, or reconnect if it never comes. */
	function depart(): void {
		if (!started) return;
		leaving = true;
		scheduler.clear();
		clearTimeout(leaveTimer);
		leaveTimer = setTimeout(() => guard(stay), timing.leaveTimeoutMs);
		leaveTimer.unref?.();
		evaluate();
	}

	/** The session was not replaced after all: reconnect, and the server pushes what has not expired. */
	function stay(): void {
		clearTimeout(leaveTimer);
		leaveTimer = undefined;
		if (!leaving) return;
		leaving = false;
		// After `session_shutdown`, `started` is false and this only keeps the session offline.
		evaluate();
	}

	function status(frame: StatusFrame): void {
		if (frame.status === "expired" && notified.has(frame.id)) return;
		const record = sent.find((item) => item.id === frame.id);
		if (record && frame.to) record.label = targetLabel(frame.to, record.to);
		if (frame.status === "delivered") {
			if (record) record.status = "delivered";
			return;
		}
		if (frame.status !== "expired") return;
		notified.add(frame.id);
		if (record) record.status = "expired";
		const label = record?.label ?? targetLabel(frame.to);
		pi.sendMessage<RelayNoticeDetails>(
			{ customType: NOTICE_TYPE, content: expiredContent(frame.id, label, ttlSeconds, ctx?.isIdle() === true), display: true, details: { id: frame.id, to: frame.to, status: "expired", at: frame.at } },
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function onChange(state: ConnectionState): void {
		if (state.kind !== "online") return;
		const limits = state.welcome.limits;
		if (Number.isFinite(limits?.ttlSeconds) && limits.ttlSeconds > 0) ttlSeconds = limits.ttlSeconds;
		if (Number.isFinite(limits?.maxTextBytes) && limits.maxTextBytes > 0) maxTextBytes = limits.maxTextBytes;
		if (Number.isFinite(limits?.maxHops) && limits.maxHops > 0) maxHops = limits.maxHops;
		// State may have changed between hello and welcome.
		pushState();
		refreshRooms();
	}

	function showRoles(): void {
		const text = roleStatus(rooms, sessionId);
		if (text === roleShown) return;
		roleShown = text;
		try { ctx?.ui.setStatus(ROLE_STATUS, text); } catch { /* a closed UI */ }
	}

	/** The rooms of a full list that this session is a member of. */
	function learnRooms(items: RelayRoom[]): void {
		roomsGeneration++;
		rooms = new Map(items.filter(isMember).map((room) => [room.name, room]));
		showRoles();
		checkRepresentation();
	}

	/** One room as a join, leave, or represent answered it; a full list follows. */
	function learnRoom(room: RelayRoom): void {
		if (!started) return;
		if (rooms) {
			if (isMember(room)) rooms.set(room.name, room);
			else rooms.delete(room.name);
			showRoles();
		}
		refreshRooms();
	}

	/** Lists the rooms again; only the latest list counts. */
	function refreshRooms(): void {
		const generation = ++roomsGeneration;
		const id = sessionId;
		relayRooms().then((items) => guard(() => { if (generation === roomsGeneration && started && sessionId === id) learnRooms(items); }), () => undefined);
	}

	/** A room's representative changed; the server tells every online member. */
	function roomChanged(frame: RoomFrame): void {
		const name = roomKey(frame.room);
		const known = rooms?.get(name);
		if (rooms && known) {
			const { representative: _previous, ...room } = known;
			rooms.set(name, typeof frame.representative === "string" && frame.representative ? { ...room, representative: frame.representative } : room);
			showRoles();
			checkRepresentation();
		}
		// For the representative's name, and for a room this session was added to unseen.
		refreshRooms();
	}

	/**
	 * A representative must keep always-on mode on: without it for `modesGraceMs`, this session stops representing.
	 * The wait lets a shutdown, which also takes the mode out of the registry, cancel it first.
	 */
	function checkRepresentation(): void {
		if (!started || leaving || hasMode(sessionId, ALWAYSON) || !represented().length) {
			clearTimeout(unrepresentTimer);
			unrepresentTimer = undefined;
			return;
		}
		if (unrepresentTimer) return;
		unrepresentTimer = setTimeout(() => guard(() => {
			unrepresentTimer = undefined;
			if (!started || leaving || hasMode(sessionId, ALWAYSON)) return;
			void stopRepresenting().then(({ done, failed }) => guard(() => {
				if (!ctx?.hasUI) return;
				if (done.length) ctx.ui.notify(`Always-on mode is off, so this session no longer represents you in ${done.join(", ")}.`, "info");
				if (failed.length) ctx.ui.notify(`Always-on mode is off, but this session could not stop representing you in ${failed.join("; ")}.`, "error");
			}));
		}), timing.modesGraceMs);
		unrepresentTimer.unref?.();
	}

	const onModes = (id: string) => { if (id === sessionId) guard(checkRepresentation); };

	/** Stops representing every room this session represents, all at once. */
	async function stopRepresenting(): Promise<{ done: string[]; failed: string[] }> {
		const names = represented();
		const results = await Promise.allSettled(names.map((name) => updateRoomMembership(name, "unrepresent")));
		const done: string[] = [];
		const failed: string[] = [];
		results.forEach((result, index) => {
			const name = `#${headerField(names[index])}`;
			if (result.status === "rejected") { failed.push(`${name}: ${errorText(result.reason)}`); return; }
			done.push(name);
			guard(() => learnRoom(result.value.room));
		});
		return { done, failed };
	}

	function onUnsupported(reason: string): void {
		const state = shared();
		if (state.unsupportedNotified || !ctx?.hasUI) return;
		state.unsupportedNotified = true;
		ctx.ui.notify(`relay: ${reason}. Sessions stay offline from relay; pika uploads are not affected.`, "warning");
	}

	function disconnect(): void {
		connection?.close();
		connection = undefined;
		// The next connection gets every unacknowledged message pushed again.
		missed = false;
		clearTimeout(settleTimer);
		settleTimer = undefined;
	}

	/**
	 * Connects, reconnects to new credentials, or disconnects, as the conditions say, and registers or
	 * removes the child hook to match. `restart` replaces a stopped or waiting connection.
	 */
	function evaluate(restart = false): void {
		try { connect(restart); } finally { syncHook(); }
	}

	function connect(restart: boolean): void {
		if (blocked() || leaving) { disconnect(); return; }
		const current = credentialsRegistry().current!;
		const same = connection && connection.credentials.url === current.url && connection.credentials.token === current.token;
		if (same && !restart) return;
		disconnect();
		connection = new RelayConnection({ url: current.url, token: current.token }, {
			prepare, hello, onMessage: (frame) => guard(() => receive(frame)), onStatus: (frame) => guard(() => status(frame)), onRoom: (frame) => guard(() => roomChanged(frame)),
			onChange: (state) => guard(() => onChange(state)), onUnsupported: (reason) => guard(() => onUnsupported(reason)),
		});
		connection.start();
	}

	const onCredentials = () => guard(() => evaluate());

	/** Runs once every `session_start` handler ran, so the child hook has recorded a child's id. */
	function decide(): void {
		if (!started || decided || !sessionId) return;
		decided = true;
		clearTimeout(fallback);
		if (shared().children.has(sessionId)) child = true;
		// Print and JSON sessions never get the tools: every Subagents and Herder child runs in one, even
		// when no child hook was registered to mark it.
		if (!child && ctx && supportedMode(ctx)) registerTools();
		evaluate();
	}

	pi.on("session_start", (_event, context) => {
		guard(() => {
			if (process.env.PI_RELAY_DISABLED === "1") return;
			ctx = context;
			sessionId = context.sessionManager.getSessionId();
			started = true;
			busy = !context.isIdle();
			exchanged.clear();
			unread.clear();
			scheduler.clear();
			transcript.clear();
			running.clear();
			sideAnswers.length = 0;
			rooms = undefined;
			roomsGeneration++;
			clearTimeout(unrepresentTimer);
			unrepresentTimer = undefined;
			sessionModes().listeners.add(onModes);
			join(self, sessionId, {
				markChild: () => guard(() => { child = true; withdrawTools(); evaluate(); }),
				status: () => offlineReason() ?? "online",
				canConnect: () => blocked(true) === undefined,
			});
			credentialsRegistry().listeners.add(onCredentials);
			// `resources_discover` follows the last `session_start` handler; the timer covers a host that skips it.
			fallback = setTimeout(() => guard(decide), timing.decideFallbackMs);
			fallback.unref?.();
		});
	});

	pi.on("resources_discover", () => { guard(decide); return undefined; });

	// pi aborts the outgoing session before `session_shutdown`; nothing may start a run on it meanwhile,
	// and a message the outgoing session acknowledged would never reach the next one.
	pi.on("session_before_switch", () => { guard(depart); return undefined; });
	pi.on("session_before_fork", () => { guard(depart); return undefined; });

	pi.on("session_before_compact", () => { summarizing = true; return undefined; });
	pi.on("session_compact", () => { summarizing = false; });
	pi.on("session_compact_failed", () => { summarizing = false; });
	pi.on("session_before_tree", () => { summarizing = true; return undefined; });
	pi.on("session_tree", () => { summarizing = false; });

	pi.on("before_agent_start", (event, context) => {
		// This session's role in its rooms, while the model cannot see it: once per change, and again after a
		// compaction drops it or /tree leaves it off the branch.
		let role: ReturnType<typeof roleUpdate>;
		try { role = sessionId ? roleUpdate(rooms, sessionId, context.sessionManager.getBranch()) : undefined; } catch { role = undefined; }
		const result = role ? { message: { customType: ROLE_TYPE, content: role.content, display: false, details: role.details } } : undefined;
		if (event.messageType !== "user") return result;
		runHops = 0;
		// The user prompted this session, so a replacement was cancelled or failed.
		guard(stay);
		// The prompt is not in the session yet when agent_start tells the server it is busy.
		if (!title && event.prompt.trim()) title = cut(event.prompt.replace(/\s+/g, " ").trim(), 120);
		return result;
	});
	// The previous run's request lacks this run's prompt: until this run's first request, there is nothing to repeat.
	pi.on("agent_start", () => { busy = true; turnStartedAt = Date.now(); transcript.clear(); guard(pushState); });
	pi.on("agent_end", () => { busy = false; turnStartedAt = undefined; running.clear(); guard(pushState); });
	// pika loads last and leaves the request as it is, so this is what the provider gets.
	pi.on("context_with_system", (event) => { transcript.onRequest(event.messages); return undefined; });
	pi.on("message_end", (event) => { guard(() => transcript.onMessageEnd(event.message)); return undefined; });
	pi.on("tool_execution_start", (event) => { if (!event.parentToolCallId) running.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() }); });
	pi.on("tool_execution_end", (event) => { running.delete(event.toolCallId); });
	// The model reads a relay message when pi adds it to the context: as a turn starts, after a tool call, or after the turn.
	pi.on("message_start", (event) => {
		guard(() => {
			const message = event.message as { role?: string; customType?: string; details?: { id?: unknown } };
			if (message.role !== "custom" || message.customType !== MESSAGE_TYPE || typeof message.details?.id !== "string") return;
			scheduler.read(message.details.id);
			const entry = unread.get(message.details.id);
			if (!entry) return;
			unread.delete(message.details.id);
			exchanged.set(entry.peer, Date.now());
		});
	});
	// What the model has not read once pi settled left its queues unread (Esc, RPC clear_queue).
	pi.on("agent_settled", () => { unread.clear(); scheduler.clear(); sideAnswers.length = 0; });
	pi.on("session_info_changed", () => { guard(pushState); });
	pi.on("model_select", () => { guard(pushState); });

	pi.on("session_shutdown", () => {
		guard(() => {
			// Always-on mode leaves the registry at every shutdown, /reload's too: that is no turning off, so the
			// session keeps its rooms. The full room list after the next connect checks the registry again.
			clearTimeout(unrepresentTimer);
			unrepresentTimer = undefined;
			sessionModes().listeners.delete(onModes);
			if (roleShown !== undefined) {
				roleShown = undefined;
				try { ctx?.ui.setStatus(ROLE_STATUS, undefined); } catch { /* a closed UI */ }
			}
			started = false;
			leaving = false;
			scheduler.clear();
			transcript.clear();
			clearTimeout(fallback);
			clearTimeout(leaveTimer);
			leaveTimer = undefined;
			disconnect();
			credentialsRegistry().listeners.delete(onCredentials);
			leave(self);
			ctx = undefined;
		});
	});

	async function relayFetch<T>(path: string, init?: RequestInit): Promise<T> {
		const current = credentialsRegistry().current;
		const reason = blocked();
		if (reason || !current) throw new Error(`relay is offline in this session: ${reason ?? "no credentials"}`);
		let response: Response;
		try {
			response = await fetch(`${current.url}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${current.token}`, ...(init?.headers ?? {}) },
				signal: AbortSignal.timeout(timing.httpTimeoutMs),
				redirect: "error",
			});
		} catch (error) {
			throw new Error(`could not reach ${current.url}: ${errorText(error)}`);
		}
		if (response.status !== 200) {
			let errBody: { error?: unknown } | undefined;
			try { errBody = await response.json() as { error?: unknown }; } catch { await response.body?.cancel().catch(() => {}); }
			if (response.status === 401) throw new Error("the server rejected this device's token (HTTP 401)");
			if (response.status === 404 && errBody?.error === "not_found") throw new Error("no such chatroom exists yet");
			if (response.status === 404) throw new Error(`the pika server at ${current.url} has no relay (HTTP 404)`);
			if (typeof errBody?.error === "string") throw new Error(`relay error (${errBody.error}): ${rejection(errBody.error) ?? errBody.error}`);
			throw new Error(`unexpected HTTP ${response.status} from ${current.url}`);
		}
		return await response.json() as T;
	}

	async function onlineSessions(): Promise<OnlineSession[]> {
		const body = await relayFetch<{ items?: unknown }>("/api/relay/v1/sessions");
		return Array.isArray(body.items) ? body.items as OnlineSession[] : [];
	}

	async function relayRooms(): Promise<RelayRoom[]> {
		const body = await relayFetch<{ items?: unknown }>("/api/relay/v1/rooms");
		return Array.isArray(body.items) ? body.items as RelayRoom[] : [];
	}

	async function roomDetail(room: string, limit = 50, after = 0): Promise<RelayRoomDetail> {
		const clean = room.trim().replace(/^#/, "");
		const params = new URLSearchParams({ limit: String(limit), ...(after > 0 ? { after: String(after) } : {}) });
		return relayFetch<RelayRoomDetail>(`/api/relay/v1/rooms/${encodeURIComponent(clean)}?${params}`);
	}

	async function updateRoomMembership(room: string, action: "join" | "leave" | "represent" | "unrepresent", topic?: string): Promise<RelayRoomDetail> {
		const clean = room.trim().replace(/^#/, "");
		return relayFetch<RelayRoomDetail>("/api/relay/v1/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ room: clean, sessionId: sessionId!, action, ...(topic ? { topic } : {}) }),
		});
	}

	/** One online session; every field comes from another device. */
	function sessionLine(session: OnlineSession): string {
		const name = headerField(session.name) || headerField(session.title);
		return [
			headerField(session.id), deviceLabel(session), `project ${headerField(session.project)}`, name ? `"${name}"` : "untitled", headerField(session.state),
			headerField(session.model) || "no model", `online ${since(session.connectedAt)}`,
		].join(" · ");
	}

	function memberLabel(member: RoomMember): string {
		const name = headerField(member.name) || headerField(member.title) || headerField(member.sessionId);
		const project = headerField(member.project);
		return `${name}${project ? ` (${project})` : ""} [${headerField(member.sessionId)}, ${headerField(member.state)}]`;
	}

	function roomLine(room: RelayRoom): string {
		const topic = headerField(room.topic);
		const members = room.members.map(memberLabel).join(", ") || "no members";
		return `#${headerField(room.name)}${topic ? ` — ${topic}` : ""} · ${room.messageCount} msg${room.messageCount === 1 ? "" : "s"} · members: ${members}`;
	}

	function roomMessageLine(msg: RoomMessage): string {
		const sender = msg.from.kind === "web"
			? "user (web)"
			: `${headerField(msg.from.name) || headerField(msg.from.title) || headerField(msg.from.sessionId)}${msg.from.project ? ` (${headerField(msg.from.project)})` : ""}`;
		const mentions = msg.mentions?.length ? ` [notified: ${msg.mentions.map(headerField).join(", ")}]` : "";
		return `[#${msg.seq} · ${headerField(msg.id)} · ${since(msg.at)} ago] ${sender}${mentions}: ${sanitize(msg.text)}`;
	}

	function sendResult(answer: SentFrame & { status: "delivered" | "queued" }, label: string): string {
		if (answer.room) {
			const notified = answer.notified ?? [];
			const who = notified.length
				? `notified ${notified.map((t) => targetLabel(t)).join(", ")}`
				: "recorded in room history (no @mentions notified)";
			const unmatched = unmatchedOf(answer);
			return `Posted message ${answer.id} to room #${headerField(answer.room)} (${who}).`
				+ `${unmatched.length ? ` Mentions that reached nobody (not members): ${unmatched.join(", ")}.` : ""}`;
		}
		if (answer.status === "delivered") return `Delivered message ${answer.id} to ${label}.`;
		return `Queued message ${answer.id} for ${label}: it has not been delivered yet. If it is not delivered within ${ttlText(ttlSeconds)} it is dropped and you will get a notice.`;
	}

	/** Sends one message (1:1 or chatroom) and records it; throws with the text an error result or notice shows. */
	async function send(
		to: string,
		text: string,
		options: { room?: string; mentions?: string[]; urgent?: boolean; replyTo?: string; hops: number; checkUnread?: boolean },
		signal?: AbortSignal,
	): Promise<{ text: string; answer: SentFrame }> {
		const current = connection;
		const reason = offlineReason();
		if (reason || !current) throw new Error(`This session is not connected to pika relay: ${reason ?? "it is not connected"}.`);
		const rawRoom = options.room ?? (to.startsWith("#") ? to.slice(1) : undefined);
		const room = rawRoom?.trim().replace(/^#/, "");
		const targetKey = room ? `#${room}` : to;
		// The model's send to a peer whose newer message it has not read would cross it: refused once per message.
		const missed = options.checkUnread ? [...unread].filter(([, entry]) => entry.peer === targetKey && !entry.told) : [];
		if (missed.length) {
			for (const [, entry] of missed) entry.told = true;
			exchanged.set(targetKey, Date.now());
			throw new Error(unreadText(missed.map(([id]) => id), missed[0]![1].label, missed.every(([, entry]) => entry.soon)));
		}
		const record: SentRecord = { to: targetKey, label: targetLabel(undefined, targetKey), status: "queued", at: Date.now(), text };
		const remember = () => { sent.push(record); if (sent.length > SENT_KEPT) sent.splice(0, sent.length - SENT_KEPT); };
		if (Buffer.byteLength(text, "utf8") > maxTextBytes) {
			record.status = "rejected"; record.reason = "too_large"; remember();
			throw new Error(`relay rejected the message (too_large): the text is ${Buffer.byteLength(text, "utf8")} bytes, and the limit is ${maxTextBytes}.`);
		}
		let answer: SentFrame;
		try {
			answer = await current.request({
				...(room !== undefined ? { room } : { to }),
				...(options.mentions?.length ? { mentions: options.mentions } : {}),
				text,
				hops: options.hops,
				...(options.urgent ? { urgent: true } : {}),
				...(options.replyTo ? { replyTo: options.replyTo } : {}),
			}, signal);
		} catch (error) {
			record.status = error instanceof RequestError && error.outcome === "unsent" ? "failed" : "unknown";
			record.reason = error instanceof RequestError ? error.code : errorText(error);
			remember();
			throw new Error(`relay_send failed: ${errorText(error)}.`);
		}
		if (answer.status === "rejected") {
			record.status = "rejected"; record.reason = answer.reason; remember();
			throw new Error(`relay rejected the message (${answer.reason}): ${rejection(answer.reason) ?? "see the reason"}.`);
		}
		const now = Date.now();
		exchanged.set(targetKey, now);
		// The user may have added this session to the room in the web UI since the last list.
		if (answer.room && rooms && !rooms.has(answer.room)) guard(refreshRooms);
		if (answer.room) exchanged.set(`#${answer.room}`, now);
		else if (answer.to?.sessionId) exchanged.set(answer.to.sessionId, now);
		record.id = answer.id;
		record.label = answer.room ? `room #${headerField(answer.room)}` : targetLabel(answer.to, to);
		// A status frame may already have reported it delivered.
		record.status = answer.status;
		remember();
		// The branch's record of what was sent, for /relay log and the footer's count; never in the model's context.
		guard(() => pi.appendEntry<RelaySentData>(SENT_TYPE, {
			id: answer.id,
			...(answer.room ? { room: answer.room } : { to: answer.to?.sessionId ?? to, label: peerLabel(answer.to ?? { sessionId: to }) }),
			...(options.mentions?.length ? { mentions: options.mentions } : {}),
			text,
			...(options.replyTo ? { replyTo: options.replyTo } : {}),
			urgent: options.urgent === true,
			status: answer.status,
			at: new Date(record.at).toISOString(),
		}));
		return { text: sendResult(answer, record.label), answer };
	}

	function statusLines(id?: string): string {
		const records = [...sent].reverse().filter((record) => !id || record.id === id).slice(0, SENT_SHOWN);
		if (!records.length) return id ? `No message ${id} was sent from this session in this process.` : "This session has sent no relay messages in this process.";
		return records.map((record) => `${record.id ?? "(no id)"} to ${record.label}: ${record.status}${record.reason ? ` (${record.reason})` : ""}, sent ${since(record.at)} ago: "${preview(record.text)}"`).join("\n");
	}

	const TOOLS = ["relay_list", "relay_send", "relay_status", "relay_room"] as const;
	// A real model kept sleeping and polling relay_status for an answer, which pi queues until its turn ends.
	const ANSWER_HINT = "Any answer arrives as a new [relay] message after your current turn ends, never during it: do not sleep or poll for it. "
		+ "End your turn now, telling your user what you are waiting for if that helps.";

	function registerTools(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;
		pi.registerTool({
			name: "relay_list", label: "Relay List",
			description: "List the other pi sessions that are online on pika relay right now, on this machine and on your user's other machines. "
				+ "Each line shows the session id (the address relay_send needs), the device, the project, the name or title, idle or busy, the model, and how long it has been online. "
				+ "Optional filters: device matches the device name or id and project the project, exactly but ignoring case; query matches the id, name, title, or working directory, ignoring case.",
			promptSnippet: "List other running pi sessions reachable through pika relay",
			parameters: Type.Object({
				device: Type.Optional(Type.String({ description: "Only sessions on this device (its name or id)" })),
				project: Type.Optional(Type.String({ description: "Only sessions in this project (the git repository's name, else the basename of the working directory)" })),
				query: Type.Optional(Type.String({ description: "Text to find in the session id, name, title, or working directory" })),
			}),
			async execute(_id, params) {
				const all = (await onlineSessions()).filter((session) => session.id !== sessionId);
				const lower = (value: string | undefined) => value?.toLowerCase() ?? "";
				const query = lower(params.query);
				const matches = all.filter((session) =>
					(!params.device || [session.deviceName, session.device].some((value) => lower(value) === lower(params.device)))
					&& (!params.project || lower(session.project) === lower(params.project))
					&& (!query || [session.id, session.name, session.title, session.cwd].some((value) => lower(value).includes(query))));
				const filtered = params.device || params.project || params.query;
				const text = matches.length
					? `${matches.length} online pi session${matches.length === 1 ? "" : "s"}${filtered ? " matching" : ""}:\n${matches.map(sessionLine).join("\n")}`
					: `No other pi session is online${filtered && all.length ? " that matches" : ""}.`;
				return { content: [{ type: "text", text }], details: { sessions: matches } };
			},
		});
		pi.registerTool({
			name: "relay_send", label: "Relay Send",
			description: "Send a text message to another running pi session or to an explicit multi-agent chatroom through pika relay. "
				+ "For a 1:1 message, pass `to` (a session id from relay_list). For a chatroom this session is a member of, pass `room` (or `to: \"#room\"`) and optional `mentions` (members' session ids or names, or 'all'). "
				+ "In a chatroom, only @mentioned members receive a live notification that starts/joins a turn; all agents can read room history on demand with relay_room. "
				+ "An answer arrives as a new [relay] message in this session only after your current turn ends, never during it, so do not sleep, poll relay_status, or call relay_list to wait for one: end your turn instead. "
				+ "A send to a session or room whose newer message you have not read yet is refused once, so that you read that message first. "
				+ "Messages that cannot be delivered within 5 minutes are dropped, and you get a notice.",
			promptSnippet: "Send a text message to another running pi session or a chatroom through pika relay",
			parameters: Type.Object({
				to: Type.Optional(Type.String({ description: "The target pi session id (or #roomName for a chatroom)" })),
				room: Type.Optional(Type.String({ description: "Chatroom name to post to (alternative to `to`); only @mentioned members are woken up" })),
				mentions: Type.Optional(Type.Array(Type.String(), { description: "In a chatroom, members' session ids or names (or 'all') to notify and wake up" })),
				text: Type.String({ description: "The message text (at most 32 KiB)" }),
				urgent: Type.Optional(Type.Boolean({ description: "Steer the message into the target's current turn even when it would otherwise wait until that turn ends" })),
				replyTo: Type.Optional(Type.String({ description: "The id of the relay message this answers" })),
			}),
			async execute(_id, params, signal) {
				if (!params.to && !params.room) throw new Error("relay_send requires either `to` (a session id) or `room` (a chatroom name).");
				const { text, answer } = await send(params.to ?? "", params.text, {
					room: params.room,
					mentions: params.mentions,
					urgent: params.urgent,
					replyTo: params.replyTo,
					hops: runHops + 1,
					checkUnread: true,
				}, signal);
				return { content: [{ type: "text", text: `${text} ${ANSWER_HINT}` }], details: answer };
			},
			renderCall: (args, theme, context) => sendCall(args, theme, context.expanded),
			renderResult: (result, { expanded }, theme, context) =>
				resultLine(result, expanded, context.isError, theme, () => sentSummary(result.details as Partial<Extract<SentFrame, { id: string }>> | undefined, theme)),
		});
		pi.registerTool({
			name: "relay_status", label: "Relay Status",
			description: "Show the delivery state (queued, delivered, expired, rejected, failed, or unknown) of the relay messages this session sent in this process, newest first, at most 50. Pass `id` for one message. "
				+ "failed means the message never left this session; unknown means the server never confirmed it (a timeout, a dropped connection, or a cancelled send), so it may or may not have been accepted. "
				+ "It never shows answers: those arrive as [relay] messages after your turn ends.",
			parameters: Type.Object({ id: Type.Optional(Type.String({ description: "A message id from relay_send" })) }),
			async execute(_id, params) {
				return { content: [{ type: "text", text: statusLines(params.id) }], details: { messages: sent.filter((record) => !params.id || record.id === params.id).slice(-SENT_SHOWN).reverse() } };
			},
		});
		pi.registerTool({
			name: "relay_room", label: "Relay Room",
			description: "List multi-agent chatrooms, read their history, or post to one. "
				+ "Only your user adds this session to rooms (/relay join <room>); if asked to join one, ask your user. "
				+ "`action: \"list\"` lists active rooms and their members. "
				+ "`action: \"history\"` reads recent messages in `room` (even those where this session was not @mentioned). "
				+ "`action: \"send\"` posts `text` to `room` and notifies only the `@mentioned` members (via `@name`/`@sessionId` in `text` or `mentions`); "
				+ "a send to a room this session is not a member of is refused.",
			promptSnippet: "List chatrooms, read room history, or post to a room this session is in",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("list"),
					Type.Literal("history"),
					Type.Literal("send"),
				], { description: "Operation: list, history, or send" }),
				room: Type.Optional(Type.String({ description: "Room name (e.g. 'auth-sync'); required for history and send" })),
				text: Type.Optional(Type.String({ description: "Message text when action is 'send'" })),
				mentions: Type.Optional(Type.Array(Type.String(), { description: "Members' session ids or names (or 'all') to notify when action is 'send'" })),
				urgent: Type.Optional(Type.Boolean({ description: "Steer into mentioned members' active turns when action is 'send', even when it would otherwise wait until those turns end" })),
				replyTo: Type.Optional(Type.String({ description: "Message id being answered when action is 'send'" })),
				limit: Type.Optional(Type.Integer({ description: "Max messages to read in 'history' (default 50, max 200)" })),
				after: Type.Optional(Type.Integer({ description: "Only return messages with seq > after in 'history'" })),
			}),
			async execute(_id, params, signal) {
				type RoomToolDetails = { rooms?: RelayRoom[]; detail?: RelayRoomDetail; sent?: SentFrame };
				if (params.action === "list") {
					const items = await relayRooms();
					guard(() => learnRooms(items));
					const text = items.length
						? `${items.length} active chatroom${items.length === 1 ? "" : "s"}:\n${items.map(roomLine).join("\n")}`
						: "No active chatrooms; your user creates them with /relay join.";
					return { content: [{ type: "text", text }], details: { rooms: items } as RoomToolDetails };
				}
				const room = params.room?.trim().replace(/^#/, "");
				if (!room) throw new Error(`relay_room (${params.action}) requires a \`room\` name.`);
				if (params.action === "history") {
					const detail = await roomDetail(room, params.limit ?? 50, params.after ?? 0);
					const header = roomLine(detail.room);
					const body = detail.messages.length
						? detail.messages.map(roomMessageLine).join("\n")
						: "No messages in this room yet.";
					return {
						content: [{ type: "text", text: `${header}\n\n${body}` }],
						details: { detail } as RoomToolDetails,
					};
				}
				if (!params.text) throw new Error("relay_room (send) requires `text`.");
				const { text, answer } = await send("", params.text, {
					room,
					mentions: params.mentions,
					urgent: params.urgent,
					replyTo: params.replyTo,
					hops: runHops + 1,
					checkUnread: true,
				}, signal);
				return { content: [{ type: "text", text: `${text} ${ANSWER_HINT}` }], details: { sent: answer } as RoomToolDetails };
			},
			renderCall: (args, theme, context) => {
				if (args.action === "send") return sendCall({ ...args, room: args.room || "?" }, theme, context.expanded);
				const room = headerField(args.room).replace(/^#/, "");
				return new Text(`${theme.fg("accent", "✉ relay room")} ${headerField(args.action)}${room ? ` ${theme.bold(`#${room}`)}` : ""}`, 0, 0);
			},
			renderResult: (result, { expanded }, theme, context) => resultLine(result, expanded, context.isError, theme, () => {
				const details = result.details as { detail?: Partial<RelayRoomDetail>; sent?: Extract<SentFrame, { id: string }> } | undefined;
				if (context.args.action === "send") return sentSummary(details?.sent, theme);
				const messages = details?.detail?.messages;
				if (context.args.action !== "history" || !Array.isArray(messages)) return undefined;
				const room = headerField(details?.detail?.room?.name) || headerField(context.args.room).replace(/^#/, "");
				return `${theme.fg("accent", `#${room}`)} · ${messages.length} message${messages.length === 1 ? "" : "s"}`;
			}),
		});
	}

	/** A session the child hook claimed late keeps no relay tools. */
	function withdrawTools(): void {
		if (!toolsRegistered) return;
		for (const name of TOOLS) {
			pi.registerTool({
				name, label: name, description: "Not available in child sessions.", parameters: Type.Object({}), exposure: "hidden",
				async execute() { throw new Error("relay is not available in child sessions"); },
			});
		}
	}

	// Every field of a message comes from another device: no terminal sequences reach the TUI. The model
	// reads the message; the transcript shows one line, and the text when expanded or in /relay log.
	pi.registerMessageRenderer<RelayMessageDetails>(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details?.from) return undefined;
		const roomTag = details.room ? theme.fg("accent", `#${headerField(details.room)}`) : "";
		const replyTo = headerField(details.replyTo);
		const tags = [roomTag, details.urgent ? theme.fg("warning", "urgent") : "", replyTo ? theme.fg("dim", `reply to ${replyTo}`) : ""].filter(Boolean);
		const text = sanitize(details.text);
		return new Text([
			`${theme.fg("accent", "✉ relay ←")} ${theme.bold(senderLabel(details.from))}${tags.length ? ` ${tags.join(" ")}` : ""} ${theme.fg("dim", `· ${size(text)}`)}`,
			...(expanded ? text.split("\n").map((line) => `  ${line}`) : []),
		].join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<SideDetails>(SIDE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const text = sanitize(details.text);
		return new Text([
			`${theme.fg("accent", "✉ relay side answer →")} ${theme.bold(headerField(details.label))} ${theme.fg("dim", `· ${size(text)}`)}`,
			...(expanded ? text.split("\n").map((line) => `  ${line}`) : []),
		].join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<RelayNoticeDetails>(NOTICE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		// The first line is the notice; what follows it is only for the model.
		return new Text(`${theme.fg("warning", "✉ relay")} ${sanitize(content).replace(/^\[relay\] /, "").split("\n", 1)[0]}`, 0, 0);
	});

	async function statusCommand(context: ExtensionCommandContext): Promise<void> {
		const current = credentialsRegistry().current;
		const reason = offlineReason();
		const state = connection?.state;
		const lines = [
			reason ? `Relay is offline: ${reason}.` : `Relay is online${state?.kind === "online" ? ` as device ${deviceLabel(state.welcome)}` : ""}.`,
			`Server: ${current ? current.url : "none (pika is not logged in)"}`,
			`This session: ${sessionId ?? context.sessionManager.getSessionId()}`,
		];
		if (!reason) {
			try { const items = await relayRooms(); guard(() => learnRooms(items)); } catch { /* the rooms it knows */ }
		}
		lines.push(...roleLines());
		if (!reason) {
			try {
				const others = (await onlineSessions()).filter((session) => session.id !== sessionId);
				lines.push(others.length ? `Online sessions:\n${others.map((session) => `  ${sessionLine(session)}`).join("\n")}` : "No other pi session is online.");
			} catch (error) {
				lines.push(`Online sessions: ${errorText(error)}`);
			}
		}
		context.ui.notify(lines.join("\n"), "info");
	}

	/** The rooms this session represents, and who represents the others it is in. */
	function roleLines(): string[] {
		if (!rooms) return [];
		const mine = represented().map((name) => `#${headerField(name)}`);
		return [
			...(mine.length ? [`This session represents you in ${mine.join(", ")}.`] : []),
			...[...rooms.values()].filter((room) => room.representative && room.representative !== sessionId)
				.map((room) => `#${headerField(room.name)} is represented by ${representativeLabel(room)}.`),
		];
	}

	async function representCommand(context: ExtensionCommandContext, rest: string[]): Promise<void> {
		const id = sessionId ?? context.sessionManager.getSessionId();
		try {
			if (rest[0] !== "off") {
				if (!hasMode(id, ALWAYSON)) { context.ui.notify("Turn on /alwayson first: a representative must stay responsive.", "warning"); return; }
				const detail = await updateRoomMembership(rest[0]!, "represent");
				learnRoom(detail.room);
				context.ui.notify(`This session now represents you in #${headerField(detail.room.name)}: the room's other members report to it.`, "info");
				return;
			}
			if (!rooms) { const items = await relayRooms(); learnRooms(items); }
			if (rest[1]) {
				const name = roomKey(rest[1]);
				const was = rooms?.get(name)?.representative === id;
				const detail = await updateRoomMembership(name, "unrepresent");
				learnRoom(detail.room);
				context.ui.notify(`This session ${was ? "no longer represents" : "does not represent"} you in #${headerField(detail.room.name)}.`, "info");
				return;
			}
			const { done, failed } = await stopRepresenting();
			if (!done.length && !failed.length) context.ui.notify("This session represents you in no room.", "info");
			if (done.length) context.ui.notify(`This session no longer represents you in ${done.join(", ")}.`, "info");
			if (failed.length) context.ui.notify(`This session could not stop representing you in ${failed.join("; ")}.`, "error");
		} catch (error) {
			context.ui.notify(errorText(error), "error");
		}
	}

	function sideLine(): string {
		const side = sideSettings();
		return side.on
			? `Side answers are on: while this session is busy, another session's message that stays unread for ${side.afterMs / 1000} s is answered beside the turn.`
			: "Side answers are off.";
	}

	async function logCommand(context: ExtensionCommandContext): Promise<void> {
		if (context.mode !== "tui" || !context.hasUI) { context.ui.notify("/relay log opens only in the interactive TUI.", "info"); return; }
		const items = logItems(context.sessionManager.getBranch(), (id) => sent.find((record) => record.id === id)?.status);
		if (!items.length) { context.ui.notify("No relay messages on this branch.", "info"); return; }
		await showRelayLog(context, items);
	}

	async function sendCommand(context: ExtensionCommandContext, args: string): Promise<void> {
		const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
		if (!match) { context.ui.notify("Usage: /relay send <sessionId> <text>", "error"); return; }
		try {
			const { text } = await send(match[1]!, match[2]!.trim(), { hops: 1 });
			context.ui.notify(text, "info");
		} catch (error) {
			context.ui.notify(errorText(error), "error");
		}
	}

	pi.registerCommand("relay", {
		description: "Show pika relay status, send a message to another pi session, join or represent you in chatrooms, browse this branch's relay messages, or turn side answers or relay off or on for this session",
		getArgumentCompletions: (prefix) => {
			// Nothing to offer for a subcommand typed in full: an open menu takes the Enter that should run it.
			const typed = prefix.trim();
			const items = SUBCOMMANDS.filter((name) => name.startsWith(typed) && name !== typed).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, context) => {
			// A command runs only in a live session, so a replacement that was about to happen did not.
			guard(stay);
			const trimmed = args.trim();
			const [command = "status", ...rest] = trimmed.split(/\s+/).filter(Boolean);
			if (command === "status" && !rest.length) await statusCommand(context);
			else if (command === "send") await sendCommand(context, trimmed.slice(4));
			else if (command === "log" && !rest.length) await logCommand(context);
			else if (command === "represent" && (rest.length === 1 || (rest.length === 2 && rest[0] === "off"))) await representCommand(context, rest);
			else if (command === "rooms" && !rest.length) {
				try {
					const items = await relayRooms();
					guard(() => learnRooms(items));
					context.ui.notify(items.length ? `Chatrooms:\n${items.map((r) => `  ${roomLine(r)}`).join("\n")}` : "No active chatrooms.", "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "join" && rest.length >= 1) {
				try {
					const topic = rest.slice(1).join(" ").trim() || undefined;
					const detail = await updateRoomMembership(rest[0]!, "join", topic);
					guard(() => learnRoom(detail.room));
					context.ui.notify(`Joined room #${headerField(detail.room.name)}.`, "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "leave" && rest.length === 1) {
				try {
					const detail = await updateRoomMembership(rest[0]!, "leave");
					guard(() => learnRoom(detail.room));
					context.ui.notify(`Left room #${headerField(detail.room.name)}.`, "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "side" && (!rest.length || (rest.length === 1 && (rest[0] === "on" || rest[0] === "off")))) {
				if (rest[0]) sideOverride = rest[0] === "on";
				if (sideOverride === false) scheduler.clear();
				context.ui.notify(`${sideLine()}${rest[0] ? " This holds for this session; relay.sideAnswers in pika.json sets the default." : ""}`, "info");
			} else if (command === "off" && !rest.length) {
				off = true;
				guard(() => evaluate());
				context.ui.notify("Relay is off for this session: it is offline and receives no messages. /relay on reconnects it.", "info");
			} else if (command === "on" && !rest.length) {
				off = false;
				const kind = connection?.state.kind;
				guard(() => evaluate(kind === "stopped" || kind === "retrying"));
				const reason = blocked();
				context.ui.notify(reason ? `Relay stays offline: ${reason}.` : "Relay is on for this session; /relay shows the connection.", reason ? "warning" : "info");
			} else context.ui.notify(USAGE, "error");
		},
	});
}
