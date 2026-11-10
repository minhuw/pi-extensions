import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cut, headerField, type RelayRoom } from "./protocol.ts";

/**
 * Representatives: a room's representative talks to the user for its other members. Each session's model learns its
 * role in each room from a hidden `relay-role` message, sent when the role changes and again only once the model can no
 * longer see it (a compaction dropped it, or `/tree` left it off the branch). Nothing here touches pi or the network.
 */
export const ROLE_TYPE = "relay-role";

/** What the model was told of its role in one room. */
export type RoomRole = { role: "representative" } | { role: "member"; representative: string } | { role: "none" };
export interface RoleDetails { rooms: Record<string, RoomRole> }

const room = (name: string) => `#${headerField(name)}`;

export const representativeText = (name: string) => `You represent your user in ${room(name)}: its members report to you and do not talk to them. `
	+ "Pass their results, questions, and decisions on to your user, merged and without repeats, and send your user's answers back to the members concerned.";

export const memberText = (name: string, label: string) => `Your user does not read this session; ${label} represents them in ${room(name)}. `
	+ `Post what they need to know or decide in ${room(name)}, mentioning it, and end your turns with a one-line status. If your user writes here directly, answer them.`;

export const endedText = (name: string, was: RoomRole["role"]) => was === "representative"
	? `You no longer represent your user in ${room(name)}.`
	: `You no longer report to a representative in ${room(name)}: your user reads this session again.`;

/** The representative's member entry, if the room lists it. */
const representativeOf = (relayRoom: RelayRoom) => relayRoom.members.find((member) => member.sessionId === relayRoom.representative);

/** The representative's name for the footer: its name or title, else its id. Every field comes from another device. */
export function representativeName(relayRoom: RelayRoom): string {
	const member = representativeOf(relayRoom);
	return cut(headerField(member?.name) || headerField(member?.title), 32) || headerField(relayRoom.representative);
}

/** The representative as the model reads it: its id, which a mention needs, and its name. */
export function representativeLabel(relayRoom: RelayRoom): string {
	const member = representativeOf(relayRoom);
	const name = cut(headerField(member?.name) || headerField(member?.title), 40);
	return `pi session ${headerField(relayRoom.representative)}${name ? ` ("${name}")` : ""}`;
}

/** This session's role in each joined room that has a representative. */
export function rolesOf(rooms: Iterable<RelayRoom>, sessionId: string): Map<string, RoomRole> {
	const roles = new Map<string, RoomRole>();
	for (const relayRoom of rooms) {
		const representative = relayRoom.representative;
		if (typeof representative !== "string" || !representative) continue;
		roles.set(relayRoom.name, representative === sessionId ? { role: "representative" } : { role: "member", representative });
	}
	return roles;
}

/**
 * The entries of a branch the model sees, as pi builds its context: after the latest compaction, the entries before
 * its `firstKeptEntryId` are replaced by its summary.
 */
export function visibleEntries(branch: readonly SessionEntry[]): readonly SessionEntry[] {
	let at = -1;
	for (let index = branch.length - 1; index >= 0; index--) if (branch[index]!.type === "compaction") { at = index; break; }
	if (at < 0) return branch;
	const compaction = branch[at] as Extract<SessionEntry, { type: "compaction" }>;
	const first = branch.findIndex((entry, index) => index < at && entry.id === compaction.firstKeptEntryId);
	return [...(first >= 0 ? branch.slice(first, at) : []), ...branch.slice(at + 1)];
}

const isRole = (value: unknown): value is RoomRole => {
	const role = (value as { role?: unknown } | undefined)?.role;
	if (role === "member") return typeof (value as { representative?: unknown }).representative === "string";
	return role === "representative" || role === "none";
};

/** What the role messages the model can still see say of each room, the latest one per room. */
export function toldRoles(branch: readonly SessionEntry[]): Map<string, RoomRole> {
	const told = new Map<string, RoomRole>();
	for (const entry of visibleEntries(branch)) {
		if (entry.type !== "custom_message" || entry.customType !== ROLE_TYPE) continue;
		const rooms = (entry.details as Partial<RoleDetails> | undefined)?.rooms;
		if (!rooms || typeof rooms !== "object") continue;
		for (const [name, role] of Object.entries(rooms)) if (isRole(role)) told.set(name, role);
	}
	return told;
}

const same = (a: RoomRole | undefined, b: RoomRole) => a?.role === b.role
	&& (a.role !== "member" || a.representative === (b as Extract<RoomRole, { role: "member" }>).representative);

/**
 * The role message for the next run: one paragraph for each room whose role the model cannot see, and a "no longer"
 * line once for each role that ended. `rooms` are the joined rooms, undefined while unknown, which tells nothing.
 */
export function roleUpdate(rooms: ReadonlyMap<string, RelayRoom> | undefined, sessionId: string, branch: readonly SessionEntry[]): { content: string; details: RoleDetails } | undefined {
	if (!rooms) return undefined;
	const roles = rolesOf(rooms.values(), sessionId);
	const told = toldRoles(branch);
	const details: RoleDetails = { rooms: {} };
	const paragraphs: string[] = [];
	for (const [name, role] of roles) {
		if (same(told.get(name), role)) continue;
		details.rooms[name] = role;
		paragraphs.push(role.role === "representative" ? representativeText(name) : memberText(name, representativeLabel(rooms.get(name)!)));
	}
	for (const [name, role] of told) {
		if (role.role === "none" || roles.has(name)) continue;
		details.rooms[name] = { role: "none" };
		paragraphs.push(endedText(name, role.role));
	}
	return paragraphs.length ? { content: paragraphs.join("\n\n"), details } : undefined;
}

/** The footer's `representative` status: "📣 rep #room" where this session represents, "→ rep <name> #room" where another does. */
export function roleStatus(rooms: ReadonlyMap<string, RelayRoom> | undefined, sessionId: string | undefined): string | undefined {
	if (!rooms || !sessionId) return undefined;
	const mine: string[] = [];
	const others: string[] = [];
	for (const relayRoom of rooms.values()) {
		if (!relayRoom.representative) continue;
		if (relayRoom.representative === sessionId) mine.push(room(relayRoom.name));
		else others.push(`→ rep ${representativeName(relayRoom)} ${room(relayRoom.name)}`);
	}
	return [...(mine.length ? [`📣 rep ${mine.join(" ")}`] : []), ...others].join(" · ") || undefined;
}
