import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../credentials.ts";
import { hasMode } from "./modes.ts";
import { deviceLabel, headerField, roomLine, sessionLine } from "./protocol.ts";
import type { RoomManager } from "./rooms.ts";
import type { SideScheduler } from "./side.ts";
import {
	blocked, errorText, guard, offlineReason, type RelayState, roomKey, type SendFn, sideSettings, SWARM,
} from "./state.ts";
import { logItems, showRelayLog } from "./viewer.ts";

const USAGE = "Usage: /relay [status|send <sessionId> <text>|rooms|join <room> [topic]|leave <room>|represent <room>|represent off [<room>]|log|side [on|off]|off|on]";
const SUBCOMMANDS = ["status", "send", "join", "leave", "represent", "rooms", "log", "side", "off", "on"];

export interface CommandDeps {
	rooms: RoomManager;
	scheduler: SideScheduler;
	send: SendFn;
	stay(): void;
	evaluate(restart?: boolean): void;
}

export function registerRelayCommand(pi: ExtensionAPI, state: RelayState, deps: CommandDeps): void {
	async function statusCommand(context: ExtensionCommandContext): Promise<void> {
		const current = credentialsRegistry().current;
		const reason = offlineReason(state);
		const connState = state.connection?.state;
		const lines = [
			reason ? `Relay is offline: ${reason}.` : `Relay is online${connState?.kind === "online" ? ` as device ${deviceLabel(connState.welcome)}` : ""}.`,
			`Server: ${current ? current.url : "none (pika is not logged in)"}`,
			`This session: ${state.sessionId ?? context.sessionManager.getSessionId()}`,
		];
		if (!reason) {
			try { const items = await deps.rooms.relayRooms(); guard(() => deps.rooms.learnRooms(items)); } catch { /* the rooms it knows */ }
		}
		lines.push(...deps.rooms.roleLines());
		if (!reason) {
			try {
				const others = (await deps.rooms.onlineSessions()).filter((session) => session.id !== state.sessionId);
				lines.push(others.length ? `Online sessions:\n${others.map((session) => `  ${sessionLine(session)}`).join("\n")}` : "No other pi session is online.");
			} catch (error) {
				lines.push(`Online sessions: ${errorText(error)}`);
			}
		}
		context.ui.notify(lines.join("\n"), "info");
	}

	async function representCommand(context: ExtensionCommandContext, rest: string[]): Promise<void> {
		const id = state.sessionId ?? context.sessionManager.getSessionId();
		try {
			if (rest[0] !== "off") {
				if (!hasMode(id, SWARM)) { context.ui.notify("Turn on /swarm first: a representative must stay responsive.", "warning"); return; }
				const detail = await deps.rooms.updateRoomMembership(rest[0]!, "represent");
				deps.rooms.learnRoom(detail.room);
				context.ui.notify(`This session now represents you in #${headerField(detail.room.name)}: the room's other members report to it.`, "info");
				return;
			}
			if (!state.rooms) { const items = await deps.rooms.relayRooms(); deps.rooms.learnRooms(items); }
			if (rest[1]) {
				const name = roomKey(rest[1]);
				const was = state.rooms?.get(name)?.representative === id;
				const detail = await deps.rooms.updateRoomMembership(name, "unrepresent");
				deps.rooms.learnRoom(detail.room);
				context.ui.notify(`This session ${was ? "no longer represents" : "does not represent"} you in #${headerField(detail.room.name)}.`, "info");
				return;
			}
			const { done, failed } = await deps.rooms.stopRepresenting();
			if (!done.length && !failed.length) context.ui.notify("This session represents you in no room.", "info");
			if (done.length) context.ui.notify(`This session no longer represents you in ${done.join(", ")}.`, "info");
			if (failed.length) context.ui.notify(`This session could not stop representing you in ${failed.join("; ")}.`, "error");
		} catch (error) {
			context.ui.notify(errorText(error), "error");
		}
	}

	function sideLine(): string {
		const side = sideSettings(state);
		return side.on
			? `Side answers are on: while this session is busy, another session's message that stays unread for ${side.afterMs / 1000} s is answered beside the turn.`
			: "Side answers are off.";
	}

	async function logCommand(context: ExtensionCommandContext): Promise<void> {
		if (context.mode !== "tui" || !context.hasUI) { context.ui.notify("/relay log opens only in the interactive TUI.", "info"); return; }
		const items = logItems(context.sessionManager.getBranch(), (id) => state.sent.find((record) => record.id === id)?.status);
		if (!items.length) { context.ui.notify("No relay messages on this branch.", "info"); return; }
		await showRelayLog(context, items);
	}

	async function sendCommand(context: ExtensionCommandContext, args: string): Promise<void> {
		const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
		if (!match) { context.ui.notify("Usage: /relay send <sessionId> <text>", "error"); return; }
		try {
			const { text } = await deps.send(match[1]!, match[2]!.trim(), { hops: 1 });
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
			pi.appendEntry("pi-extensions.command", { command: "relay", kind: "extension", extension: "pika" });
			// A command runs only in a live session, so a replacement that was about to happen did not.
			guard(deps.stay);
			const trimmed = args.trim();
			const [command = "status", ...rest] = trimmed.split(/\s+/).filter(Boolean);
			if (command === "status" && !rest.length) await statusCommand(context);
			else if (command === "send") await sendCommand(context, trimmed.slice(4));
			else if (command === "log" && !rest.length) await logCommand(context);
			else if (command === "represent" && (rest.length === 1 || (rest.length === 2 && rest[0] === "off"))) await representCommand(context, rest);
			else if (command === "rooms" && !rest.length) {
				try {
					const items = await deps.rooms.relayRooms();
					guard(() => deps.rooms.learnRooms(items));
					context.ui.notify(items.length ? `Chatrooms:\n${items.map((r) => `  ${roomLine(r)}`).join("\n")}` : "No active chatrooms.", "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "join" && rest.length >= 1) {
				try {
					const topic = rest.slice(1).join(" ").trim() || undefined;
					const detail = await deps.rooms.updateRoomMembership(rest[0]!, "join", topic);
					guard(() => deps.rooms.learnRoom(detail.room));
					context.ui.notify(`Joined room #${headerField(detail.room.name)}.`, "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "leave" && rest.length === 1) {
				try {
					const detail = await deps.rooms.updateRoomMembership(rest[0]!, "leave");
					guard(() => deps.rooms.learnRoom(detail.room));
					context.ui.notify(`Left room #${headerField(detail.room.name)}.`, "info");
				} catch (error) {
					context.ui.notify(errorText(error), "error");
				}
			} else if (command === "side" && (!rest.length || (rest.length === 1 && (rest[0] === "on" || rest[0] === "off")))) {
				if (rest[0]) state.sideOverride = rest[0] === "on";
				if (state.sideOverride === false) deps.scheduler.clear();
				context.ui.notify(`${sideLine()}${rest[0] ? " This holds for this session; relay.sideAnswers in pika.json sets the default." : ""}`, "info");
			} else if (command === "off" && !rest.length) {
				state.off = true;
				guard(() => deps.evaluate());
				context.ui.notify("Relay is off for this session: it is offline and receives no messages. /relay on reconnects it.", "info");
			} else if (command === "on" && !rest.length) {
				state.off = false;
				const kind = state.connection?.state.kind;
				guard(() => deps.evaluate(kind === "stopped" || kind === "retrying"));
				const reason = blocked(state);
				context.ui.notify(reason ? `Relay stays offline: ${reason}.` : "Relay is on for this session; /relay shows the connection.", reason ? "warning" : "info");
			} else context.ui.notify(USAGE, "error");
		},
	});
}
