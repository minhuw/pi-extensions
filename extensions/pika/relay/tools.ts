import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { headerField, type OnlineSession, type RelayRoom, type RelayRoomDetail, roomLine, roomMessageLine, type SentFrame, sessionLine } from "./protocol.ts";
import { resultLine, sendCall, sentSummary } from "./render.ts";
import { guard, type RelayState, roomKey, SENT_SHOWN, type SendFn, statusLines } from "./state.ts";

const TOOLS = ["relay_list", "relay_send", "relay_status", "relay_room"] as const;
// A real model kept sleeping and polling relay_status for an answer, which pi queues until its turn ends.
const ANSWER_HINT = "Any answer arrives as a new [relay] message after your current turn ends, never during it: do not sleep or poll for it. "
	+ "End your turn now, telling your user what you are waiting for if that helps.";

export interface ToolDeps {
	onlineSessions(): Promise<OnlineSession[]>;
	relayRooms(): Promise<RelayRoom[]>;
	roomDetail(room: string, limit?: number, after?: number): Promise<RelayRoomDetail>;
	learnRooms(items: RelayRoom[]): void;
	send: SendFn;
}

export interface RelayTools {
	registerTools(): void;
	withdrawTools(): void;
}

export function createTools(pi: ExtensionAPI, state: RelayState, deps: ToolDeps): RelayTools {
	function registerTools(): void {
		if (state.toolsRegistered) return;
		state.toolsRegistered = true;
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
				const all = (await deps.onlineSessions()).filter((session) => session.id !== state.sessionId);
				const lower = (value: string | undefined) => value?.toLowerCase() ?? "";
				const device = params.device?.trim() || undefined;
				const project = params.project?.trim() || undefined;
				const query = lower(params.query?.trim());
				const matches = all.filter((session) =>
					(!device || [session.deviceName, session.device].some((value) => lower(value) === lower(device)))
					&& (!project || lower(session.project) === lower(project))
					&& (!query || [session.id, session.name, session.title, session.cwd].some((value) => lower(value).includes(query))));
				const filtered = device || project || query;
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
				const rawTo = params.to?.trim() ?? "";
				const room = (params.room ? roomKey(params.room) : "") || (rawTo.startsWith("#") ? roomKey(rawTo) : "") || undefined;
				const to = room || rawTo.startsWith("#") ? "" : rawTo;
				if (!to && !room) throw new Error("relay_send requires either `to` (a session id) or `room` (a chatroom name).");
				const { text, answer } = await deps.send(to, params.text, {
					room,
					mentions: params.mentions,
					urgent: params.urgent,
					replyTo: params.replyTo,
					hops: state.runHops + 1,
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
				const id = params.id?.trim() || undefined;
				return { content: [{ type: "text", text: statusLines(state, id) }], details: { messages: state.sent.filter((record) => !id || record.id === id).slice(-SENT_SHOWN).reverse() } };
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
				limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "Max messages to read in 'history' (default 50, max 200)" })),
				after: Type.Optional(Type.Integer({ minimum: 0, description: "Only return messages with seq > after in 'history'" })),
			}),
			async execute(_id, params, signal) {
				type RoomToolDetails = { rooms?: RelayRoom[]; detail?: RelayRoomDetail; sent?: SentFrame };
				if (params.action === "list") {
					const items = await deps.relayRooms();
					guard(() => deps.learnRooms(items));
					const text = items.length
						? `${items.length} active chatroom${items.length === 1 ? "" : "s"}:\n${items.map(roomLine).join("\n")}`
						: "No active chatrooms; your user creates them with /relay join.";
					return { content: [{ type: "text", text }], details: { rooms: items } as RoomToolDetails };
				}
				const room = params.room ? roomKey(params.room) : "";
				if (!room) throw new Error(`relay_room (${params.action}) requires a \`room\` name.`);
				if (params.action === "history") {
					const limit = params.limit && params.limit > 0 ? Math.min(200, params.limit) : 50;
					const after = params.after && params.after > 0 ? params.after : 0;
					const detail = await deps.roomDetail(room, limit, after);
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
				const { text, answer } = await deps.send("", params.text, {
					room,
					mentions: params.mentions,
					urgent: params.urgent,
					replyTo: params.replyTo,
					hops: state.runHops + 1,
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
		if (!state.toolsRegistered) return;
		for (const name of TOOLS) {
			pi.registerTool({
				name, label: name, description: "Not available in child sessions.", parameters: Type.Object({}), exposure: "hidden",
				async execute() { throw new Error("relay is not available in child sessions"); },
			});
		}
	}

	return { registerTools, withdrawTools };
}
