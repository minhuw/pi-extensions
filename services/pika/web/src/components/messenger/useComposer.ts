import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useApi } from "../../lib/api";
import { plural } from "../../lib/format";
import { MAX_TEXT_BYTES, RELAY_EVENTS_KEY, RELAY_ROOMS_KEY, relayRoomKey, utf8Length } from "../../lib/relay";
import type { RelayRoom } from "../../lib/types";
import { buildMentionCandidates, detectActiveMention, formatError } from "./helpers";
import type { DmThread, MentionCandidate, ReplyDraft, SendFeedback, ThreadSelection } from "./types";

export interface ComposerController {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	text: string;
	urgent: boolean;
	selectedMentions: ReadonlySet<string>;
	sending: boolean;
	sendFeedback: SendFeedback | null;
	activeMentionMatch: { query: string; atIndex: number } | null;
	mentionCandidates: MentionCandidate[];
	activeMentionIndex: number;
	bytes: number;
	tooLong: boolean;
	canSend: boolean;
	mentionHint: string;
	onTextChange: (value: string, cursor: number) => void;
	onCursorChange: (cursor: number) => void;
	onToggleUrgent: () => void;
	onToggleMention: (token: string) => void;
	onInsertMention: (candidate: MentionCandidate) => void;
	onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
	onSend: () => Promise<void>;
	focusInput: () => void;
}

export function useComposer({
	resolvedSelection,
	resolvedKey,
	resolvedKeyRef,
	activeRoom,
	activeDm,
	replyTo,
	onClearReply,
	onMessageSent,
}: {
	resolvedSelection: ThreadSelection | null;
	resolvedKey: string;
	resolvedKeyRef: RefObject<string>;
	activeRoom?: RelayRoom;
	activeDm?: DmThread;
	replyTo: ReplyDraft | null;
	onClearReply: () => void;
	onMessageSent: () => void;
}): ComposerController {
	const api = useApi();
	const queryClient = useQueryClient();
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const [text, setText] = useState("");
	const [cursorPos, setCursorPos] = useState(0);
	const [dismissedMentionAt, setDismissedMentionAt] = useState<number | null>(null);
	const [activeMentionIndex, setActiveMentionIndex] = useState(0);
	const [urgent, setUrgent] = useState(false);
	const [selectedMentions, setSelectedMentions] = useState<ReadonlySet<string>>(() => new Set());
	const [sending, setSending] = useState(false);
	const [sendFeedback, setSendFeedback] = useState<SendFeedback | null>(null);

	const [prevThreadKey, setPrevThreadKey] = useState(resolvedKey);
	if (prevThreadKey !== resolvedKey) {
		setPrevThreadKey(resolvedKey);
		setSelectedMentions(new Set());
		setSendFeedback(null);
		setDismissedMentionAt(null);
	}

	// Inline @mention detection at the cursor inside rooms
	const activeMentionMatch = useMemo(() => {
		if (resolvedSelection?.kind !== "room" || !activeRoom) return null;
		return detectActiveMention(text, cursorPos, dismissedMentionAt);
	}, [resolvedSelection, activeRoom, text, cursorPos, dismissedMentionAt]);

	const mentionCandidates = useMemo<MentionCandidate[]>(() => {
		if (!activeMentionMatch || !activeRoom) return [];
		return buildMentionCandidates(activeRoom, activeMentionMatch.query);
	}, [activeMentionMatch, activeRoom]);

	useEffect(() => {
		setActiveMentionIndex(0);
	}, [activeMentionMatch?.query, activeMentionMatch?.atIndex]);

	const insertMentionCandidate = (candidate: MentionCandidate) => {
		if (!activeMentionMatch) return;
		const before = text.slice(0, activeMentionMatch.atIndex);
		const after = text.slice(cursorPos);
		const inserted = `@${candidate.token} `;
		const nextText = `${before}${inserted}${after}`;
		const nextPos = before.length + inserted.length;
		setText(nextText);
		setCursorPos(nextPos);
		setDismissedMentionAt(null);
		requestAnimationFrame(() => {
			const node = inputRef.current;
			if (!node) return;
			node.focus();
			node.setSelectionRange(nextPos, nextPos);
		});
	};

	const toggleMention = (token: string) => {
		setSelectedMentions((current) => {
			const next = new Set(current);
			if (token === "all") {
				if (next.has("all")) next.delete("all");
				else {
					next.clear();
					next.add("all");
				}
				return next;
			}
			next.delete("all");
			if (!next.delete(token)) next.add(token);
			return next;
		});
	};

	const bytes = utf8Length(text);
	const tooLong = bytes > MAX_TEXT_BYTES;
	const canSend = Boolean(resolvedSelection && (activeRoom || activeDm)) && text.trim() !== "" && !tooLong && !sending;

	const mentionHint = selectedMentions.has("all")
		? "Wakes every member"
		: selectedMentions.size > 0
			? `Wakes ${plural(selectedMentions.size, "agent")}`
			: "History only unless @mentioned";

	const handleSend = async () => {
		if (!canSend || !resolvedSelection) return;
		const targetKey = resolvedKey;
		setSending(true);
		setSendFeedback(null);
		try {
			if (resolvedSelection.kind === "dm") {
				const sent = await api.sendRelayMessage({
					to: resolvedSelection.sessionId,
					text,
					urgent,
					...(replyTo ? { replyTo: replyTo.id } : {}),
				});
				if (resolvedKeyRef.current === targetKey) {
					onMessageSent();
					setText("");
					setCursorPos(0);
					setUrgent(false);
					onClearReply();
					setSendFeedback({
						tone: sent.status === "delivered" ? "ok" : "queued",
						message:
							sent.status === "delivered"
								? "Delivered"
								: "Queued: delivered when the session takes it, or dropped after 5 minutes",
					});
				}
				await queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY });
			} else {
				const mentions = [...selectedMentions];
				const sent = await api.sendRelayMessage({
					room: resolvedSelection.room,
					text,
					...(mentions.length > 0 ? { mentions } : {}),
					urgent,
					...(replyTo ? { replyTo: replyTo.id } : {}),
				});
				if (resolvedKeyRef.current === targetKey) {
					onMessageSent();
					setText("");
					setCursorPos(0);
					setUrgent(false);
					onClearReply();
					setSelectedMentions(new Set());
					const notified = sent.notified?.length ?? 0;
					const unmatched = sent.unmatched ?? [];
					setSendFeedback({
						tone: "ok",
						message:
							(notified > 0 ? `Posted and notified ${plural(notified, "agent")}` : "Posted to the room's history")
							+ (unmatched.length > 0
								? `. Not members: ${unmatched.map((token) => `@${token.replace(/^@/, "")}`).join(", ")}`
								: ""),
					});
				}
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
					queryClient.invalidateQueries({ queryKey: relayRoomKey(resolvedSelection.room) }),
					queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY }),
				]);
			}
		} catch (cause) {
			if (resolvedKeyRef.current === targetKey) {
				setSendFeedback({
					tone: "error",
					message: formatError(cause),
				});
			}
		} finally {
			setSending(false);
		}
	};

	const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSend();
			return;
		}
		if (activeMentionMatch && mentionCandidates.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveMentionIndex((idx) => (idx + 1) % mentionCandidates.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveMentionIndex((idx) => (idx - 1 + mentionCandidates.length) % mentionCandidates.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const chosen = mentionCandidates[activeMentionIndex] ?? mentionCandidates[0];
				if (chosen) insertMentionCandidate(chosen);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setDismissedMentionAt(activeMentionMatch.atIndex);
				return;
			}
		}
		if (e.key === "Escape" && replyTo) {
			e.preventDefault();
			onClearReply();
		}
	};

	return {
		inputRef,
		text,
		urgent,
		selectedMentions,
		sending,
		sendFeedback,
		activeMentionMatch,
		mentionCandidates,
		activeMentionIndex,
		bytes,
		tooLong,
		canSend,
		mentionHint,
		onTextChange: (value, cursor) => {
			setText(value);
			setCursorPos(cursor);
			setDismissedMentionAt(null);
		},
		onCursorChange: setCursorPos,
		onToggleUrgent: () => setUrgent((v) => !v),
		onToggleMention: toggleMention,
		onInsertMention: insertMentionCandidate,
		onKeyDown: onComposerKeyDown,
		onSend: handleSend,
		focusInput: () => inputRef.current?.focus(),
	};
}
