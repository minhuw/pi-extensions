import { hostname } from "node:os";
import { basename } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ConnectionState, RelayConnection } from "./connection.ts";
import {
	cut, expiredContent, headerField, type HelloSession, MAX_HOPS, MESSAGE_TYPE, type MessageFrame, messageContent, NOTICE_TYPE, type OnlineSession, RECEIVED_TYPE,
	RELAY_VERSION, sanitize, type SentFrame, type SessionState, since, type StatusFrame, type Target, targetLabel, timing, ttlText,
} from "./protocol.ts";
import { credentials, join, leave, shared, syncHook } from "./shared.ts";

export { timing } from "./protocol.ts";

/** At most this many sent messages are remembered for relay_status, and this many shown. */
const SENT_KEPT = 200;
const SENT_SHOWN = 50;
const USAGE = "Usage: /relay [status|send <sessionId> <text>|off|on]";
const SUBCOMMANDS = ["status", "send", "off", "on"];

type SentStatus = "queued" | "delivered" | "expired" | "rejected";
interface SentRecord { id?: string; to: string; label: string; status: SentStatus; reason?: string; at: number; text: string }

export interface RelayMessageDetails { id: string; from: MessageFrame["from"]; text: string; urgent: boolean; replyTo?: string; hops: number; sentAt: string | number }
export interface RelayNoticeDetails { id: string; to: Target; status: "expired"; at: string | number }

const REJECTIONS: Record<string, string> = {
	invalid: "the message is invalid: empty text, a malformed session id, or bad hops",
	self: "that is this session's own id",
	too_large: "the text is too large",
	rate_limited: "this session sent too many messages in the last minute; wait before sending more",
	hop_limit: `the message would travel more than ${MAX_HOPS} hops between sessions without the user; stop relaying and wait for your user`,
	unknown_session: "no online or recorded pi session has that id; call relay_list for the online sessions",
	mailbox_full: "the target's mailbox is full; try again later",
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const supportedMode = (context: ExtensionContext) => context.mode === "tui" || context.mode === "rpc";
const preview = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 60 ? `${line.slice(0, 59)}…` : line; };

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
	let title: string | undefined;
	/** What the server last heard of this session's state, name, title, and model. */
	let reported: Partial<Pick<HelloSession, "state" | "name" | "title" | "model">> = {};
	const seen = new Set<string>();
	const notified = new Set<string>();
	const sent: SentRecord[] = [];

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
		const current = credentials().current;
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
			id: sessionId!, ...info, cwd: cut(cwd, 1024)!, project: cut(basename(cwd) || cwd, 255)!, host: cut(hostname(), 255)!,
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
		const details: RelayMessageDetails = {
			id: frame.id, from: frame.from, text: frame.text, urgent, hops, sentAt: frame.sentAt, ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
		};
		try {
			const options = ctx.isIdle() ? { triggerTurn: true } : urgent ? { deliverAs: "steer" as const, triggerTurn: true } : { deliverAs: "followUp" as const, triggerTurn: true };
			pi.sendMessage<RelayMessageDetails>({ customType: MESSAGE_TYPE, content: messageContent({ ...frame, urgent, hops }), display: true, details }, options);
		} catch {
			// Threw synchronously, so pi does not hold it: not acknowledged, and pushed again after a reconnect.
			return;
		}
		seen.add(frame.id);
		runHops = Math.max(runHops, hops);
		// The text stays in the transcript even if Esc or RPC clear_queue drops a queued delivery.
		guard(() => pi.appendEntry(RECEIVED_TYPE, { id: frame.id, from: frame.from, text: frame.text, replyTo: frame.replyTo, hops, urgent, at: new Date().toISOString() }));
		current.send({ type: "ack", id: frame.id });
	}

	/** pi is replacing the session: go offline until `session_shutdown`, or reconnect if it never comes. */
	function depart(): void {
		if (!started) return;
		leaving = true;
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
			{ customType: NOTICE_TYPE, content: expiredContent(frame.id, label, ttlSeconds), display: true, details: { id: frame.id, to: frame.to, status: "expired", at: frame.at } },
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function onChange(state: ConnectionState): void {
		if (state.kind !== "online") return;
		const limits = state.welcome.limits;
		if (Number.isFinite(limits?.ttlSeconds) && limits.ttlSeconds > 0) ttlSeconds = limits.ttlSeconds;
		if (Number.isFinite(limits?.maxTextBytes) && limits.maxTextBytes > 0) maxTextBytes = limits.maxTextBytes;
		// State may have changed between hello and welcome.
		pushState();
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
		const current = credentials().current!;
		const same = connection && connection.credentials.url === current.url && connection.credentials.token === current.token;
		if (same && !restart) return;
		disconnect();
		connection = new RelayConnection({ url: current.url, token: current.token }, {
			hello, onMessage: (frame) => guard(() => receive(frame)), onStatus: (frame) => guard(() => status(frame)),
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
			join(self, sessionId, {
				markChild: () => guard(() => { child = true; withdrawTools(); evaluate(); }),
				status: () => offlineReason() ?? "online",
				canConnect: () => blocked(true) === undefined,
			});
			credentials().listeners.add(onCredentials);
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

	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "user") return undefined;
		runHops = 0;
		// The user prompted this session, so a replacement was cancelled or failed.
		guard(stay);
		// The prompt is not in the session yet when agent_start tells the server it is busy.
		if (!title && event.prompt.trim()) title = cut(event.prompt.replace(/\s+/g, " ").trim(), 120);
		return undefined;
	});
	pi.on("agent_start", () => { busy = true; guard(pushState); });
	pi.on("agent_end", () => { busy = false; guard(pushState); });
	pi.on("session_info_changed", () => { guard(pushState); });
	pi.on("model_select", () => { guard(pushState); });

	pi.on("session_shutdown", () => {
		guard(() => {
			started = false;
			leaving = false;
			clearTimeout(fallback);
			clearTimeout(leaveTimer);
			leaveTimer = undefined;
			disconnect();
			credentials().listeners.delete(onCredentials);
			leave(self);
			ctx = undefined;
		});
	});

	async function onlineSessions(): Promise<OnlineSession[]> {
		const current = credentials().current;
		const reason = blocked();
		if (reason || !current) throw new Error(`relay is offline in this session: ${reason ?? "no credentials"}`);
		let response: Response;
		try {
			response = await fetch(`${current.url}/api/relay/v1/sessions`, {
				headers: { Authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(timing.httpTimeoutMs), redirect: "error",
			});
		} catch (error) {
			throw new Error(`could not reach ${current.url}: ${errorText(error)}`);
		}
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			if (response.status === 401) throw new Error("the server rejected this device's token (HTTP 401)");
			if (response.status === 404) throw new Error(`the pika server at ${current.url} has no relay (HTTP 404)`);
			throw new Error(`unexpected HTTP ${response.status} from ${current.url}`);
		}
		const body = await response.json() as { items?: unknown };
		return Array.isArray(body.items) ? body.items as OnlineSession[] : [];
	}

	/** One online session; every field comes from another device. */
	function sessionLine(session: OnlineSession): string {
		const name = headerField(session.name) || headerField(session.title);
		return [
			headerField(session.id), headerField(session.device), `project ${headerField(session.project)}`, name ? `"${name}"` : "untitled", headerField(session.state),
			headerField(session.model) || "no model", `online ${since(session.connectedAt)}`,
		].join(" · ");
	}

	function sendResult(answer: SentFrame & { status: "delivered" | "queued" }, label: string): string {
		if (answer.status === "delivered") return `Delivered message ${answer.id} to ${label}.`;
		return `Queued message ${answer.id} for ${label}: it has not been delivered yet. If it is not delivered within ${ttlText(ttlSeconds)} it is dropped and you will get a notice.`;
	}

	/** Sends one message and records it; throws with the text an error result or notice shows. */
	async function send(to: string, text: string, options: { urgent?: boolean; replyTo?: string; hops: number }): Promise<{ text: string; answer: SentFrame }> {
		const current = connection;
		const reason = offlineReason();
		if (reason || !current) throw new Error(`This session is not connected to pika relay: ${reason ?? "it is not connected"}.`);
		const record: SentRecord = { to, label: targetLabel(undefined, to), status: "queued", at: Date.now(), text };
		const remember = () => { sent.push(record); if (sent.length > SENT_KEPT) sent.splice(0, sent.length - SENT_KEPT); };
		if (Buffer.byteLength(text, "utf8") > maxTextBytes) {
			record.status = "rejected"; record.reason = "too_large"; remember();
			throw new Error(`relay rejected the message (too_large): the text is ${Buffer.byteLength(text, "utf8")} bytes, and the limit is ${maxTextBytes}.`);
		}
		let answer: SentFrame;
		try {
			answer = await current.request({ to, text, hops: options.hops, ...(options.urgent ? { urgent: true } : {}), ...(options.replyTo ? { replyTo: options.replyTo } : {}) });
		} catch (error) {
			throw new Error(`relay_send failed: ${errorText(error)}.`);
		}
		if (answer.status === "rejected") {
			record.status = "rejected"; record.reason = answer.reason; remember();
			throw new Error(`relay rejected the message (${answer.reason}): ${REJECTIONS[answer.reason] ?? "see the reason"}.`);
		}
		record.id = answer.id;
		record.label = targetLabel(answer.to, to);
		// A status frame may already have reported it delivered.
		record.status = answer.status;
		remember();
		return { text: sendResult(answer, record.label), answer };
	}

	function statusLines(id?: string): string {
		const records = [...sent].reverse().filter((record) => !id || record.id === id).slice(0, SENT_SHOWN);
		if (!records.length) return id ? `No message ${id} was sent from this session in this process.` : "This session has sent no relay messages in this process.";
		return records.map((record) => `${record.id ?? "(no id)"} to ${record.label}: ${record.status}${record.reason ? ` (${record.reason})` : ""}, sent ${since(record.at)} ago: "${preview(record.text)}"`).join("\n");
	}

	const TOOLS = ["relay_list", "relay_send", "relay_status"] as const;

	function registerTools(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;
		pi.registerTool({
			name: "relay_list", label: "Relay List",
			description: "List the other pi sessions that are online on pika relay right now, on this machine and on your user's other machines. "
				+ "Each line shows the session id (the address relay_send needs), the device, the project, the name or title, idle or busy, the model, and how long it has been online. "
				+ "Optional filters: device and project match exactly; query matches the id, name, title, or working directory, ignoring case.",
			promptSnippet: "List other running pi sessions reachable through pika relay",
			parameters: Type.Object({
				device: Type.Optional(Type.String({ description: "Only sessions on this device" })),
				project: Type.Optional(Type.String({ description: "Only sessions in this project (the basename of the working directory)" })),
				query: Type.Optional(Type.String({ description: "Text to find in the session id, name, title, or working directory" })),
			}),
			async execute(_id, params) {
				const all = (await onlineSessions()).filter((session) => session.id !== sessionId);
				const lower = (value: string | undefined) => value?.toLowerCase() ?? "";
				const query = lower(params.query);
				const matches = all.filter((session) =>
					(!params.device || lower(session.device) === lower(params.device))
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
			description: "Send a text message to another running pi session through pika relay. "
				+ "`to` is a session id from relay_list, or the sender of a [relay] message you are answering; when answering, set `replyTo` to that message's id. "
				+ "The message starts a turn in the target session, or joins the turn it is running; `urgent` steers it into that turn at once. "
				+ "Delivered means the target session received it, not that its model has read or answered it; answers arrive later as [relay] messages. "
				+ "Messages that cannot be delivered within 5 minutes are dropped, and you get a notice.",
			promptSnippet: "Send a text message to another running pi session through pika relay",
			parameters: Type.Object({
				to: Type.String({ description: "The target pi session id" }),
				text: Type.String({ description: "The message text (at most 32 KiB)" }),
				urgent: Type.Optional(Type.Boolean({ description: "Steer the message into the target's current turn instead of queueing it after that turn" })),
				replyTo: Type.Optional(Type.String({ description: "The id of the relay message this answers" })),
			}),
			async execute(_id, params) {
				const { text, answer } = await send(params.to, params.text, { urgent: params.urgent, replyTo: params.replyTo, hops: runHops + 1 });
				return { content: [{ type: "text", text }], details: answer };
			},
		});
		pi.registerTool({
			name: "relay_status", label: "Relay Status",
			description: "Show the delivery state (queued, delivered, expired, or rejected) of the relay messages this session sent in this process, newest first, at most 50. Pass `id` for one message.",
			parameters: Type.Object({ id: Type.Optional(Type.String({ description: "A message id from relay_send" })) }),
			async execute(_id, params) {
				return { content: [{ type: "text", text: statusLines(params.id) }], details: { messages: sent.filter((record) => !params.id || record.id === params.id).slice(-SENT_SHOWN).reverse() } };
			},
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

	// Every field of a message comes from another device: no terminal sequences reach the TUI.
	pi.registerMessageRenderer<RelayMessageDetails>(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details?.from) return undefined;
		const sender = details.from;
		const project = sender.kind === "web" ? "" : headerField(sender.project);
		const from = sender.kind === "web"
			? "your user, from the pika web UI"
			: `${headerField(sender.name) || headerField(sender.title) || headerField(sender.sessionId)} on ${headerField(sender.device)}${project ? ` · ${project}` : ""}`;
		const replyTo = headerField(details.replyTo);
		const tags = [details.urgent ? theme.fg("warning", "urgent") : "", replyTo ? theme.fg("dim", `reply to ${replyTo}`) : ""].filter(Boolean);
		const lines = sanitize(details.text).split("\n");
		const shown = expanded ? lines : lines.slice(0, 3);
		const more = lines.length - shown.length;
		return new Text([
			`${theme.fg("accent", "✉ relay")} ${theme.bold(from)}${tags.length ? ` ${tags.join(" ")}` : ""}`,
			...shown.map((line) => `  ${line}`),
			...(more > 0 ? [theme.fg("dim", `  … ${more} more line${more === 1 ? "" : "s"}`)] : []),
		].join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<RelayNoticeDetails>(NOTICE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${theme.fg("warning", "✉ relay")} ${sanitize(content).replace(/^\[relay\] /, "")}`, 0, 0);
	});

	async function statusCommand(context: ExtensionCommandContext): Promise<void> {
		const current = credentials().current;
		const reason = offlineReason();
		const state = connection?.state;
		const lines = [
			reason ? `Relay is offline: ${reason}.` : `Relay is online${state?.kind === "online" ? ` as device ${state.welcome.device}` : ""}.`,
			`Server: ${current ? current.url : "none (pika is not logged in)"}`,
			`This session: ${sessionId ?? context.sessionManager.getSessionId()}`,
		];
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
		description: "Show pika relay status, send a message to another pi session, or turn relay off or on for this session",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, context) => {
			// A command runs only in a live session, so a replacement that was about to happen did not.
			guard(stay);
			const trimmed = args.trim();
			const [command = "status", ...rest] = trimmed.split(/\s+/).filter(Boolean);
			if (command === "status" && !rest.length) await statusCommand(context);
			else if (command === "send") await sendCommand(context, trimmed.slice(4));
			else if (command === "off" && !rest.length) {
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
