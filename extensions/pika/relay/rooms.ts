import { credentialsRegistry } from "../credentials.ts";
import { relayHttpFetch } from "./connection.ts";
import { hasMode } from "./modes.ts";
import { headerField, type OnlineSession, type RelayRoom, type RelayRoomDetail, type RoomFrame, timing } from "./protocol.ts";
import { representativeLabel, roleStatus } from "./roles.ts";
import {
	blocked, errorText, guard, isMember, type RelayState, represented, ROLE_STATUS, roomKey, ROOMS_STATUS, SWARM,
} from "./state.ts";

export interface RoomManager {
	onlineSessions(): Promise<OnlineSession[]>;
	relayRooms(): Promise<RelayRoom[]>;
	roomDetail(room: string, limit?: number, after?: number): Promise<RelayRoomDetail>;
	updateRoomMembership(room: string, action: "join" | "leave" | "represent" | "unrepresent", topic?: string): Promise<RelayRoomDetail>;
	showRoomStatuses(): void;
	learnRooms(items: RelayRoom[]): void;
	learnRoom(room: RelayRoom): void;
	refreshRooms(): void;
	roomChanged(frame: RoomFrame): void;
	checkRepresentation(): void;
	onModes(id: string): void;
	stopRepresenting(): Promise<{ done: string[]; failed: string[] }>;
	roleLines(): string[];
}

export function createRoomManager(state: RelayState): RoomManager {
	async function relayFetch<T>(path: string, init?: RequestInit): Promise<T> {
		const current = credentialsRegistry().current;
		const reason = blocked(state);
		if (reason || !current) throw new Error(`relay is offline in this session: ${reason ?? "no credentials"}`);
		return relayHttpFetch<T>({ url: current.url, token: current.token, path, init });
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
			body: JSON.stringify({ room: clean, sessionId: state.sessionId!, action, ...(topic ? { topic } : {}) }),
		});
	}

	function showRoomStatuses(): void {
		const names = [...(state.rooms?.keys() ?? [])].map(headerField).sort();
		const joined = names.length ? names.map((name) => `#${name}`).join(" ") : undefined;
		if (joined !== state.roomsShown) {
			state.roomsShown = joined;
			try { state.ctx?.ui.setStatus(ROOMS_STATUS, joined); } catch { /* a closed UI */ }
		}
		const role = roleStatus(state.rooms, state.sessionId);
		if (role !== state.roleShown) {
			state.roleShown = role;
			try { state.ctx?.ui.setStatus(ROLE_STATUS, role); } catch { /* a closed UI */ }
		}
	}

	/** The rooms of a full list that this session is a member of. */
	function learnRooms(items: RelayRoom[]): void {
		state.roomsGeneration++;
		state.rooms = new Map(items.filter((room) => isMember(state, room)).map((room) => [room.name, room]));
		showRoomStatuses();
		checkRepresentation();
	}

	/** One room as a join, leave, or represent answered it; a full list follows. */
	function learnRoom(room: RelayRoom): void {
		if (!state.started) return;
		if (state.rooms) {
			if (isMember(state, room)) state.rooms.set(room.name, room);
			else state.rooms.delete(room.name);
			showRoomStatuses();
		}
		refreshRooms();
	}

	/** Lists the rooms again; only the latest list counts. */
	function refreshRooms(): void {
		const generation = ++state.roomsGeneration;
		const id = state.sessionId;
		relayRooms().then((items) => guard(() => { if (generation === state.roomsGeneration && state.started && state.sessionId === id) learnRooms(items); }), () => undefined);
	}

	/** A room's representative changed; the server tells every online member. */
	function roomChanged(frame: RoomFrame): void {
		const name = roomKey(frame.room);
		const known = state.rooms?.get(name);
		if (state.rooms && known) {
			const { representative: _previous, ...room } = known;
			state.rooms.set(name, typeof frame.representative === "string" && frame.representative ? { ...room, representative: frame.representative } : room);
			showRoomStatuses();
			checkRepresentation();
		}
		// For the representative's name, and for a room this session was added to unseen.
		refreshRooms();
	}

	/**
	 * A representative must keep swarm mode on: without it for `modesGraceMs`, this session stops representing.
	 * The wait lets a shutdown, which also takes the mode out of the registry, cancel it first.
	 */
	function checkRepresentation(): void {
		if (!state.started || state.leaving || hasMode(state.sessionId, SWARM) || !represented(state).length) {
			clearTimeout(state.unrepresentTimer);
			state.unrepresentTimer = undefined;
			return;
		}
		if (state.unrepresentTimer) return;
		state.unrepresentTimer = setTimeout(() => guard(() => {
			state.unrepresentTimer = undefined;
			if (!state.started || state.leaving || hasMode(state.sessionId, SWARM)) return;
			void stopRepresenting().then(({ done, failed }) => guard(() => {
				if (!state.ctx?.hasUI) return;
				if (done.length) state.ctx.ui.notify(`Swarm mode is off, so this session no longer represents you in ${done.join(", ")}.`, "info");
				if (failed.length) state.ctx.ui.notify(`Swarm mode is off, but this session could not stop representing you in ${failed.join("; ")}.`, "error");
			}));
		}), timing.modesGraceMs);
		state.unrepresentTimer.unref?.();
	}

	const onModes = (id: string) => { if (id === state.sessionId) guard(checkRepresentation); };

	/** Stops representing every room this session represents, all at once. */
	async function stopRepresenting(): Promise<{ done: string[]; failed: string[] }> {
		const names = represented(state);
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

	/** The rooms this session represents, and who represents the others it is in. */
	function roleLines(): string[] {
		if (!state.rooms) return [];
		const mine = represented(state).map((name) => `#${headerField(name)}`);
		return [
			...(mine.length ? [`This session represents you in ${mine.join(", ")}.`] : []),
			...[...state.rooms.values()].filter((room) => room.representative && room.representative !== state.sessionId)
				.map((room) => `#${headerField(room.name)} is represented by ${representativeLabel(room)}.`),
		];
	}

	return {
		onlineSessions,
		relayRooms,
		roomDetail,
		updateRoomMembership,
		showRoomStatuses,
		learnRooms,
		learnRoom,
		refreshRooms,
		roomChanged,
		checkRepresentation,
		onModes,
		stopRepresenting,
		roleLines,
	};
}
