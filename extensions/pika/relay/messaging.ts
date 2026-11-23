import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RequestError } from "./connection.ts";
import {
	BASE_REJECTIONS, expiredContent, headerField, MESSAGE_TYPE, type MessageFrame, messageContent, NOTICE_TYPE, RECEIVED_TYPE, sendResult, type SentFrame, type StatusFrame, type Target, targetLabel, timing,
} from "./protocol.ts";
import {
	answerText, askSide, automatic, busyText, type SideDetails, type SideJob, sideNote, type SideOutcome, sideRequest, SideScheduler, SIDE_TYPE,
} from "./side.ts";
import {
	errorText, guard, offlineReason, peerOf, type RelayMessageDetails, type RelayNoticeDetails, type RelayState, reportsIn, roomKey, SENT_KEPT, type SendFn, type SendOptions, type SentRecord, sideSettings, talking, unreadText, waiting,
} from "./state.ts";
import { peerLabel, type RelaySentData, SENT_TYPE } from "./viewer.ts";

export interface MessagingDeps {
	refreshRooms(): void;
	evaluate(restart?: boolean): void;
}

export interface RelayMessaging {
	readonly scheduler: SideScheduler;
	receive(frame: MessageFrame): void;
	status(frame: StatusFrame): void;
	send: SendFn;
}

export function createMessaging(pi: ExtensionAPI, state: RelayState, deps: MessagingDeps): RelayMessaging {
	const scheduler = new SideScheduler({
		waiting: (id) => state.unread.has(id) && state.started && !state.leaving && state.ctx?.isIdle() === false && sideSettings(state).on,
		run: (job, signal) => answerSide(job, signal),
	});

	/** Whether pi is compacting the session or summarizing a branch; never once it is idle. */
	function isSummarizing(): boolean {
		if (state.summarizing && state.ctx?.isIdle()) state.summarizing = false;
		return state.summarizing;
	}

	/** Restarts the connection once pi stopped summarizing, so the server pushes the held-back messages again. */
	function settle(): void {
		if (state.settleTimer) return;
		state.settleTimer = setTimeout(() => guard(() => {
			state.settleTimer = undefined;
			if (!state.missed) return;
			if (isSummarizing()) { settle(); return; }
			state.missed = false;
			deps.evaluate(true);
		}), timing.settlePollMs);
		state.settleTimer.unref?.();
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
		const current = state.connection;
		if (!current || !state.ctx) return;
		if (state.seen.has(frame.id)) { current.send({ type: "ack", id: frame.id }); return; }
		// pi starts a run for a custom message even during a compaction or tree summary, where it refuses
		// a user prompt. The message stays unacknowledged on the server, which pushes it again (unless it
		// expired) on the reconnect that follows.
		if (state.missed || isSummarizing()) { state.missed = true; settle(); return; }
		const hops = Number.isInteger(frame.hops) && frame.hops >= 0 ? frame.hops : 0;
		const urgent = frame.urgent === true;
		const peer = peerOf(frame);
		const idle = state.ctx.isIdle();
		// A busy session steers in the messages of a peer it is talking with, so that a reply it writes meanwhile
		// does not cross them. Only urgent ones overtake an earlier message of the peer that waits for the turn's end.
		const steer = !idle && (urgent || (peer !== undefined && talking(state, peer) && !waiting(state, peer)));
		const details: RelayMessageDetails = {
			id: frame.id, from: frame.from, text: frame.text, urgent, hops, sentAt: frame.sentAt,
			...(frame.room ? { room: frame.room } : {}),
			...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
			...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
		};
		const label = frame.room ? `room #${headerField(frame.room)}` : targetLabel(frame.from as Target);
		// The user may have added this session to the room in the web UI since the last list.
		if (frame.room && state.rooms && !state.rooms.has(roomKey(frame.room))) guard(deps.refreshRooms);
		// Unless steered, the model reads it right after an answer the user has not replied to; but a member that
		// reports to a representative has no user reading it.
		const unanswered = !steer && !(frame.room && reportsIn(state, frame.room));
		// Before the delivery, whose turn may read it at once.
		if (peer !== undefined) state.unread.set(frame.id, { peer, label, soon: idle || steer, told: false });
		try {
			const options = idle ? { triggerTurn: true } : steer ? { deliverAs: "steer" as const, triggerTurn: true } : { deliverAs: "followUp" as const, triggerTurn: true };
			pi.sendMessage<RelayMessageDetails>({ customType: MESSAGE_TYPE, content: messageContent({ ...frame, urgent, hops }, unanswered), display: true, details }, options);
		} catch {
			// Threw synchronously, so pi does not hold it: not acknowledged, and pushed again after a reconnect.
			state.unread.delete(frame.id);
			return;
		}
		state.seen.add(frame.id);
		state.runHops = Math.max(state.runHops, hops);
		// The text stays in the transcript even if Esc or RPC clear_queue drops a queued delivery.
		guard(() => pi.appendEntry(RECEIVED_TYPE, { id: frame.id, ...(frame.room ? { room: frame.room } : {}), from: frame.from, text: frame.text, replyTo: frame.replyTo, hops, urgent, at: new Date().toISOString() }));
		current.send({ type: "ack", id: frame.id });
		// Another session's message that a busy turn leaves unread gets a side answer; a side answer or busy notice never does.
		if (idle || frame.from.kind !== "session" || automatic(frame.text)) return;
		const side = sideSettings(state);
		if (side.on) scheduler.schedule({ frame: { ...frame, urgent, hops }, label, soon: steer, at: Date.now() }, side.afterMs);
	}

	/**
	 * One side request for a message the turn has not read, then its answer or a busy notice to the sender, unless the
	 * model read the message meanwhile. The turn also gets the answer, before the message.
	 */
	async function answerSide(job: SideJob, signal: AbortSignal): Promise<void> {
		const context = state.ctx;
		const generation = state.sideGeneration;
		const { frame } = job;
		if (!context || !state.started || state.leaving || frame.from.kind !== "session") return;
		const messages = state.transcript.snapshot(state.running);
		let outcome: SideOutcome | undefined;
		if (messages) {
			messages.push({ role: "user", content: sideRequest(job, state.sideAnswers), timestamp: Date.now() });
			const limited = AbortSignal.any([signal, AbortSignal.timeout(timing.sideTimeoutMs)]);
			outcome = await askSide(context, pi.getThinkingLevel(), messages, limited).catch(() => undefined);
		}
		if (signal.aborted || !state.started || state.leaving || state.ctx !== context || generation !== state.sideGeneration || !state.unread.has(frame.id)) return;
		outcome ??= { kind: "defer", reason: "" };
		if (outcome.kind === "none") return;
		const text = outcome.kind === "answer" ? answerText(outcome.text) : busyText(job, state.turnStartedAt, state.running.values().next().value, outcome.reason);
		const options = { replyTo: frame.id, hops: frame.hops + 1 };
		const { answer } = frame.room
			? await send("", text, { ...options, room: frame.room, mentions: [frame.from.sessionId] })
			: await send(frame.from.sessionId, text, options);
		if (outcome.kind !== "answer" || answer.status === "rejected") return;
		// Re-check lifecycle and turn-settlement state after the async send completes so a session that shut down,
		// started leaving, switched, or settled while send() was in flight never mutates state or posts a stale note.
		if (!state.started || state.leaving || state.ctx !== context || generation !== state.sideGeneration || signal.aborted) return;
		state.sideAnswers.push({ id: frame.id, label: job.label, text: outcome.text });
		// The note quotes the message, so a correction the model sends cannot cross it.
		const entry = state.unread.get(frame.id);
		if (entry) entry.told = true;
		const details: SideDetails = { id: frame.id, replyId: answer.id, label: job.label, question: frame.text, text: outcome.text };
		// An idle session read the message already, or is about to: the note waits for its next turn.
		pi.sendMessage<SideDetails>({ customType: SIDE_TYPE, content: sideNote(details), display: true, details }, context.isIdle() ? {} : { deliverAs: "steer", triggerTurn: true });
	}

	function status(frame: StatusFrame): void {
		if (frame.status === "expired" && state.notified.has(frame.id)) return;
		const record = state.sent.find((item) => item.id === frame.id);
		if (record && frame.to) record.label = targetLabel(frame.to, record.to);
		if (frame.status === "delivered") {
			if (record) record.status = "delivered";
			return;
		}
		if (frame.status !== "expired") return;
		state.notified.add(frame.id);
		if (record) record.status = "expired";
		const label = record?.label ?? targetLabel(frame.to);
		pi.sendMessage<RelayNoticeDetails>(
			{ customType: NOTICE_TYPE, content: expiredContent(frame.id, label, state.ttlSeconds, state.ctx?.isIdle() === true), display: true, details: { id: frame.id, to: frame.to, status: "expired", at: frame.at } },
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	/** Sends one message (1:1 or chatroom) and records it; throws with the text an error result or notice shows. */
	async function send(
		to: string,
		text: string,
		options: SendOptions,
		signal?: AbortSignal,
	): Promise<{ text: string; answer: SentFrame }> {
		const current = state.connection;
		const reason = offlineReason(state);
		if (reason || !current) throw new Error(`This session is not connected to pika relay: ${reason ?? "it is not connected"}.`);
		const cleanTo = to.trim();
		const room = (options.room ? roomKey(options.room) : "") || (cleanTo.startsWith("#") ? roomKey(cleanTo) : "") || undefined;
		const targetTo = room ? "" : cleanTo;
		const targetKey = room ? `#${room}` : targetTo;
		const mentions = options.mentions?.map((item) => item.trim()).filter(Boolean);
		const replyTo = options.replyTo?.trim() || undefined;
		// The model's send to a peer whose newer message it has not read would cross it: refused once per message.
		const missed = options.checkUnread ? [...state.unread].filter(([, entry]) => entry.peer === targetKey && !entry.told) : [];
		if (missed.length) {
			for (const [, entry] of missed) entry.told = true;
			state.exchanged.set(targetKey, Date.now());
			throw new Error(unreadText(missed.map(([id]) => id), missed[0]![1].label, missed.every(([, entry]) => entry.soon)));
		}
		const record: SentRecord = { to: targetKey, label: targetLabel(undefined, targetKey), status: "queued", at: Date.now(), text };
		const remember = () => { state.sent.push(record); if (state.sent.length > SENT_KEPT) state.sent.splice(0, state.sent.length - SENT_KEPT); };
		if (Buffer.byteLength(text, "utf8") > state.maxTextBytes) {
			record.status = "rejected"; record.reason = "too_large"; remember();
			throw new Error(`relay rejected the message (too_large): the text is ${Buffer.byteLength(text, "utf8")} bytes, and the limit is ${state.maxTextBytes}.`);
		}
		let answer: SentFrame;
		try {
			answer = await current.request({
				...(room ? { room } : { to: targetTo }),
				...(mentions?.length ? { mentions } : {}),
				text,
				hops: options.hops,
				...(options.urgent ? { urgent: true } : {}),
				...(replyTo ? { replyTo } : {}),
			}, signal);
		} catch (error) {
			record.status = error instanceof RequestError && error.outcome === "unsent" ? "failed" : "unknown";
			record.reason = error instanceof RequestError ? error.code : errorText(error);
			remember();
			throw new Error(`relay_send failed: ${errorText(error)}.`);
		}
		if (answer.status === "rejected") {
			record.status = "rejected"; record.reason = answer.reason; remember();
			throw new Error(`relay rejected the message (${answer.reason}): ${BASE_REJECTIONS[answer.reason] ?? "see the reason"}.`);
		}
		const now = Date.now();
		state.exchanged.set(targetKey, now);
		// The user may have added this session to the room in the web UI since the last list.
		if (answer.room && state.rooms && !state.rooms.has(answer.room)) guard(deps.refreshRooms);
		if (answer.room) state.exchanged.set(`#${answer.room}`, now);
		else if (answer.to?.sessionId) state.exchanged.set(answer.to.sessionId, now);
		record.id = answer.id;
		record.label = answer.room ? `room #${headerField(answer.room)}` : targetLabel(answer.to, targetTo);
		// A status frame may already have reported it delivered.
		record.status = answer.status;
		remember();
		// The branch's record of what was sent, for /relay log and the footer's count; never in the model's context.
		guard(() => pi.appendEntry<RelaySentData>(SENT_TYPE, {
			id: answer.id,
			...(answer.room ? { room: answer.room } : { to: answer.to?.sessionId ?? targetTo, label: peerLabel(answer.to ?? { sessionId: targetTo }) }),
			...(mentions?.length ? { mentions } : {}),
			text,
			...(replyTo ? { replyTo } : {}),
			urgent: options.urgent === true,
			status: answer.status,
			at: new Date(record.at).toISOString(),
		}));
		return { text: sendResult(answer, record.label, state.ttlSeconds), answer };
	}

	return { scheduler, receive, status, send };
}
