import type {
	RelayRejection,
	RelayRoom,
	RelaySender,
	RelayStatus,
	RelayTarget,
} from "../../lib/types";

export type ThreadSelection =
	| { kind: "dm"; sessionId: string }
	| { kind: "room"; room: string };

export type PeerState = "idle" | "busy" | "offline";
export type ThreadFilter = "all" | "rooms" | "direct";

export interface DmThread {
	kind: "dm";
	key: string;
	sessionId: string;
	label: string;
	named: boolean;
	device: string;
	project: string;
	model?: string;
	state: PeerState;
	recorded: boolean;
	/** When the last message to or from the session was sent; 0 without one. */
	lastAt: number;
	preview: string;
}

export interface RoomThread {
	kind: "room";
	key: string;
	room: RelayRoom;
	lastAt: number;
	preview: string;
}

export type ThreadItem = DmThread | RoomThread;

/** One message in a conversation: a direct relay event, or a post in a room's history. */
export interface ChatMessage {
	id: string;
	/** Room posts only: monotonic sequence number within the room. */
	seq?: number;
	at: string;
	from: RelaySender;
	/** Direct messages only: who it went to. */
	to?: RelayTarget;
	/** Room posts only: the members it woke. */
	notified?: RelayTarget[];
	status?: RelayStatus;
	reason?: RelayRejection;
	deliveredAt?: string;
	urgent: boolean;
	replyTo?: string;
	hops: number;
	text: string;
}

export interface MentionCandidate {
	token: string;
	label: string;
	detail: string;
	representative: boolean;
}

export interface ReplyDraft {
	id: string;
	sender: string;
	preview: string;
}

export interface SendFeedback {
	tone: "ok" | "queued" | "error";
	message: string;
}
